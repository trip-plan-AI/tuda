import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  MessageEvent,
  NotFoundException,
  Param,
  Logger,
  Post,
  BadRequestException,
  Req,
  Sse,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiSessionsService } from './ai-sessions.service';
import { AiPlanRequestDto } from './dto/ai-plan-request.dto';
import { InputSanitizerPipe } from './pipes/input-sanitizer.pipe';
import { OrchestratorService } from './pipeline/orchestrator.service';
import { ProviderSearchService } from './pipeline/provider-search.service';
import { SchedulerService } from './pipeline/scheduler.service';
import { SemanticFilterService } from './pipeline/semantic-filter.service';
import { IntentRouterService } from './pipeline/intent-router.service';
import { PolicyService } from './pipeline/policy.service';
import { LogicalIdFilterService } from './pipeline/logical-id-filter.service';
import { VectorPrefilterService } from './pipeline/vector-prefilter.service';
import { DeterministicPlannerService } from './pipeline/deterministic-planner.service';
import { YandexBatchRefinementService } from './pipeline/yandex-batch-refinement.service';
import type { SessionMessage } from './types/pipeline.types';
import type { RoutePlan } from './types/pipeline.types';
import type { ParsedIntent } from './types/pipeline.types';
import type {
  DeterministicPlannerShadowMeta,
  IntentRouterDecision,
  LogicalIdShadowMeta,
  MassCollectionShadowMeta,
  PipelineStatus,
  PlannerVersion,
  PlanResponseContractMeta,
  PolicySnapshot,
  VectorPrefilterShadowMeta,
  YandexBatchRefinementDiagnostics,
} from './types/pipeline.types';
import type {
  HeartbeatSseEvent,
  PlanStartedSseEvent,
  PlannerSseEvent,
} from './types/ai-stream-event.types';
import { TripsService } from '../trips/trips.service';
import { PointsService } from '../points/points.service';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger('AI_PIPELINE');

  // TRI-106 / MERGE-GUARD
  // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
  // 2) Потребность: единый текст NEED_CITY для детерминированной UX-обработки на frontend
  //    и для устойчивых проверок в тестах/логах.
  // 3) Если убрать: фронт может получать разные формулировки и не показывать корректный сценарий уточнения города.
  // 4) Возможен конфликт с ветками, где меняют контракт ошибок 422 (code/message/session_id)
  //    в ai-пайплайне и клиентском error parser.
  private readonly needCityMessage =
    'Недостаточно данных для построения маршрута. Укажите, пожалуйста, город.';

  private parseBooleanEnv(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }

  private isPlannerContractFieldsEnabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_PLANNER_V2_CONTRACT_FIELDS);
  }

  private isIntentRouterV2Enabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_INTENT_ROUTER_V2);
  }

  private isPolicyCalcV2Enabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_POLICY_CALC_V2);
  }

  private isLogicalIdFilterV2Enabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_LOGICAL_ID_FILTER_V2);
  }

  private isVectorPrefilterRedisEnabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_VECTOR_PREFILTER_REDIS);
  }

  private isDeterministicPlannerV2Enabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_DETERMINISTIC_PLANNER_V2);
  }

  private isMassCollectionV2Enabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_MASS_COLLECTION_V2);
  }

  private isPlannerSseEnabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_PLANNER_SSE_ENABLED);
  }

  private isYandexBatchRefinementEnabled(): boolean {
    return this.parseBooleanEnv(process.env.FF_YANDEX_BATCH_REFINEMENT);
  }

  private resolveVectorTopK(): number {
    const fallbackTopK = 200;
    const rawValue = Number.parseInt(process.env.AI_VECTOR_TOPK ?? '', 10);

    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      return fallbackTopK;
    }

    return rawValue;
  }

  private resolvePlannerVersion(): PlannerVersion {
    const plannerV2Enabled = this.parseBooleanEnv(
      process.env.FF_PLANNER_V2_ENABLED,
    );
    return plannerV2Enabled ? 'v2' : 'v2-shadow';
  }

  private buildPipelineStatus(fallbacks: string[]): PipelineStatus {
    const hasFallbacks = fallbacks.length > 0;

    return {
      intent: 'ok',
      provider: hasFallbacks ? 'fallback' : 'ok',
      semantic: hasFallbacks ? 'fallback' : 'ok',
      scheduler: 'ok',
    };
  }

  constructor(
    private readonly aiSessionsService: AiSessionsService,
    private readonly tripsService: TripsService,
    private readonly pointsService: PointsService,
    private readonly orchestratorService: OrchestratorService,
    private readonly providerSearchService: ProviderSearchService,
    private readonly semanticFilterService: SemanticFilterService,
    private readonly schedulerService: SchedulerService,
    private readonly intentRouterService: IntentRouterService,
    private readonly policyService: PolicyService,
    private readonly logicalIdFilterService: LogicalIdFilterService,
    private readonly vectorPrefilterService: VectorPrefilterService,
    private readonly deterministicPlannerService: DeterministicPlannerService,
    private readonly yandexBatchRefinementService: YandexBatchRefinementService,
  ) {}

  private isNeedCityError(error: unknown): boolean {
    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: отделить доменную ошибку NEED_CITY от остальных 422, чтобы
    //    сохранять контекст сессии и отдавать клиенту предсказуемый payload.
    // 3) Если убрать: контроллер не перехватит NEED_CITY из orchestrator, сессия не сохранит
    //    clarify-диалог, а UI потеряет continuity между сообщениями.
    // 4) В этом блоке ранее не было веточного комментария; прямого конфликта со старым комментарием нет.
    if (!(error instanceof UnprocessableEntityException)) return false;

    const response = error.getResponse();
    if (typeof response === 'string') return false;

    return (
      !!response &&
      typeof response === 'object' &&
      'code' in response &&
      (response as { code?: unknown }).code === 'NEED_CITY'
    );
  }

  private tryParseRoutePlan(message: SessionMessage): RoutePlan | null {
    // TRI-104: безопасный парсинг assistant-message в RoutePlan.
    // MERGE-NOTE: если меняется JSON-структура route plan на клиенте/в scheduler,
    // поддержите валидацию здесь, иначе apply/from-trip начнут отбрасывать валидные сообщения.
    if (message.role !== 'assistant') return null;

    try {
      const parsed = JSON.parse(message.content) as Partial<RoutePlan>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.city !== 'string') return null;
      if (!Array.isArray(parsed.days)) return null;
      return parsed as RoutePlan;
    } catch {
      return null;
    }
  }

  private async enrichDescriptions(
    points: Array<{ title: string; address?: string | null }>,
  ) {
    // TRI-104: генерация описаний точек только на backend (backend-only external API policy).
    // MERGE-NOTE: любые переносы в frontend запрещены политикой; интеграции внешних LLM только через Nest.
    const apiKey = process.env.YANDEX_GPT_API_KEY?.trim();
    const folderId = process.env.YANDEX_FOLDER_ID?.trim();

    if (!apiKey || !folderId || points.length === 0) {
      return points.map((point) => ({
        ...point,
        description: `Интересное место: ${point.title}.`,
      }));
    }

    const prompt = `
Сгенерируй короткие дружелюбные описания туристических точек.
Верни только JSON в формате:
{"items":[{"title":"...","description":"..."}]}
Описание 1-2 предложения, без markdown.

Точки:
${JSON.stringify(points)}
`.trim();

    try {
      const response = await fetch(
        'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
        {
          method: 'POST',
          headers: {
            Authorization: `Api-Key ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            modelUri: `gpt://${folderId}/yandexgpt-lite`,
            completionOptions: {
              stream: false,
              temperature: 0.3,
              maxTokens: 1500,
            },
            messages: [{ role: 'user', text: prompt }],
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`YandexGPT HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        result?: { alternatives?: Array<{ message?: { text?: string } }> };
      };
      const rawText = payload.result?.alternatives?.[0]?.message?.text ?? '{}';
      const parsedText = rawText.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(parsedText) as {
        items?: Array<{ title?: string; description?: string }>;
      };

      const byTitle = new Map(
        (parsed.items ?? [])
          .filter(
            (item) =>
              typeof item.title === 'string' &&
              typeof item.description === 'string',
          )
          .map((item) => [item.title as string, item.description as string]),
      );

      return points.map((point) => ({
        ...point,
        description:
          byTitle.get(point.title) ??
          `Интересное место: ${point.title}. Рекомендуем включить в маршрут.`,
      }));
    } catch (error) {
      this.logger.warn(
        `Yandex description generation failed: ${String(error)}`,
      );
      return points.map((point) => ({
        ...point,
        description: `Интересное место: ${point.title}. Рекомендуем включить в маршрут.`,
      }));
    }
  }

  @Get('sessions')
  async listSessions(@CurrentUser() user: { id: string }) {
    return this.aiSessionsService.listByUser(user.id);
  }

  @Get('sessions/:id')
  async getSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: { id: string },
  ) {
    const session = await this.aiSessionsService.getByIdForUser(
      sessionId,
      user.id,
    );
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    return {
      id: session.id,
      trip_id: session.tripId,
      created_at: session.createdAt,
      messages: session.messages,
    };
  }

  @Delete('sessions/:id')
  async deleteSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: { id: string },
  ) {
    const deleted = await this.aiSessionsService.deleteByIdForUser(
      sessionId,
      user.id,
    );

    if (!deleted) {
      throw new NotFoundException('Session not found');
    }

    return { ok: true };
  }

  @Post('sessions')
  async createSession(
    @Body() dto: { trip_id?: string },
    @CurrentUser() user: { id: string },
  ) {
    // TRI-106 / MERGE-GUARD
    // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
    // 2) Потребность: позволить frontend создать серверную AI-сессию ДО первого /ai/plan,
    //    чтобы однословные/уточняющие запросы не теряли chat identity.
    // 3) Если убрать: первый запрос снова может идти с session_id=null и "прилипать" к чужому контексту.
    // 4) Возможен конфликт с ветками, где создание сессии происходит неявно только внутри /ai/plan.
    const session = await this.aiSessionsService.getOrCreateForPlan({
      tripId: dto.trip_id,
      userId: user.id,
      sessionId: undefined,
    });

    return {
      session_id: session.id,
      trip_id: session.tripId,
      created_at: session.createdAt,
    };
  }

  @Post('plan')
  async plan(
    @Body(InputSanitizerPipe) dto: AiPlanRequestDto,
    @CurrentUser() user: { id: string },
  ) {
    const session = await this.aiSessionsService.getOrCreateForPlan({
      tripId: dto.trip_id,
      userId: user.id,
      sessionId: dto.session_id,
    });
    const history = session.messages;
    const llmContext = history.slice(-10);
    const orchestratorStart = Date.now();
    const intentRouterEnabled = this.isIntentRouterV2Enabled();

    let intentRouterDecision: IntentRouterDecision | null = null;
    if (intentRouterEnabled) {
      intentRouterDecision = this.intentRouterService.route(
        dto.user_query,
        llmContext,
      );
    }

    let intent: ParsedIntent;
    try {
      intent = await this.orchestratorService.parseIntent(
        dto.user_query,
        llmContext,
      );
    } catch (error) {
      // TRI-106 / MERGE-GUARD
      // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
      // 2) Потребность: при NEED_CITY сохранять user+assistant clarify-сообщения в ту же сессию,
      //    чтобы follow-up пользователя продолжал диалог, а не стартовал новый маршрут.
      // 3) Если убрать: история чата будет рваться, и повторный запрос может снова привести к неверному городу.
      // 4) Возможен конфликт с ветками, где 422 обрабатывается глобально без локального saveMessages.
      if (!this.isNeedCityError(error)) {
        throw error;
      }

      const clarificationMessages: SessionMessage[] = [
        ...history,
        { role: 'user' as const, content: dto.user_query },
        {
          role: 'assistant' as const,
          content: this.needCityMessage,
        },
      ];

      await this.aiSessionsService.saveMessages(
        session.id,
        clarificationMessages,
      );

      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message: this.needCityMessage,
        session_id: session.id,
      });
    }

    const orchestratorDuration = Date.now() - orchestratorStart;
    const policyCalcEnabled = this.isPolicyCalcV2Enabled();
    const plannerVersion = this.resolvePlannerVersion();
    const policySnapshot: PolicySnapshot | null = policyCalcEnabled
      ? this.policyService.calculatePolicySnapshot(
          intent,
          llmContext,
          plannerVersion,
        )
      : null;

    const providerStart = Date.now();
    const fallbacks: string[] = [];
    const providerResult = await this.providerSearchService.fetchAndFilter(
      intent,
      fallbacks,
    );
    const rawPoi = providerResult.pois;
    const massCollectionShadowMeta: MassCollectionShadowMeta | null =
      providerResult.shadowDiagnostics ?? null;
    const providerDuration = Date.now() - providerStart;

    const vectorPrefilterRedisEnabled = this.isVectorPrefilterRedisEnabled();
    let vectorPrefilterShadowMeta: VectorPrefilterShadowMeta | null = null;

    if (vectorPrefilterRedisEnabled) {
      const personaSummary =
        policySnapshot?.user_persona_summary ?? dto.user_query;
      vectorPrefilterShadowMeta =
        await this.vectorPrefilterService.runShadowPrefilter(
          personaSummary,
          rawPoi,
          this.resolveVectorTopK(),
        );
    }

    const logicalIdFilterEnabled = this.isLogicalIdFilterV2Enabled();
    let logicalIdShadowMeta: LogicalIdShadowMeta | null = null;

    if (logicalIdFilterEnabled) {
      const enrichedWithLogicalIds =
        this.logicalIdFilterService.attachLogicalIds(rawPoi, intent.city);
      const duplicateGroups =
        this.logicalIdFilterService.analyzeDuplicatesByLogicalId(
          enrichedWithLogicalIds,
        );

      logicalIdShadowMeta = {
        total_candidates: enrichedWithLogicalIds.length,
        duplicates_groups: duplicateGroups.length,
        duplicates_total: duplicateGroups.reduce(
          (sum, group) => sum + group.count,
          0,
        ),
      };
    }

    const semanticStart = Date.now();
    const selected = await this.semanticFilterService.select(
      rawPoi,
      intent,
      fallbacks,
    );

    const yandexBatchRefinementEnabled = this.isYandexBatchRefinementEnabled();
    const personaSummary =
      policySnapshot?.user_persona_summary ?? dto.user_query;
    let selectedForScheduler = selected;
    let yandexBatchRefinementDiagnostics: YandexBatchRefinementDiagnostics | null =
      null;

    if (yandexBatchRefinementEnabled) {
      try {
        const refinementResult =
          await this.yandexBatchRefinementService.refineSelectedInBatches(
            selected,
            personaSummary,
            { intent },
          );
        selectedForScheduler = refinementResult.refined;
        yandexBatchRefinementDiagnostics = refinementResult.diagnostics;
      } catch (error) {
        const reason =
          error instanceof Error && typeof error.message === 'string'
            ? error.message
            : 'UNKNOWN';
        fallbacks.push(`YANDEX_BATCH_REFINEMENT_FAILED:${reason}`);
        yandexBatchRefinementDiagnostics = {
          batch_count: 0,
          failed_batches: 1,
          fallback_reasons: [`service_error:${reason}`],
        };
      }
    }

    const semanticDuration = Date.now() - semanticStart;

    const schedulerStart = Date.now();
    const routePlan = this.schedulerService.buildPlan(
      selectedForScheduler,
      intent,
    );
    const schedulerDuration = Date.now() - schedulerStart;

    const deterministicPlannerEnabled = this.isDeterministicPlannerV2Enabled();
    let deterministicPlannerShadowMeta: DeterministicPlannerShadowMeta | null =
      null;

    if (deterministicPlannerEnabled) {
      try {
        deterministicPlannerShadowMeta = {
          status: 'ok',
          input_hash: this.deterministicPlannerService.buildInputHash(
            intent,
            selectedForScheduler,
          ),
          decision_summary:
            this.deterministicPlannerService.buildDecisionLogSummary(routePlan),
          deterministic_mode: 'shadow',
        };
      } catch {
        deterministicPlannerShadowMeta = {
          status: 'fallback',
          input_hash: null,
          decision_summary: null,
          deterministic_mode: 'shadow',
        };
      }
    }

    const newMessages: SessionMessage[] = [
      ...history,
      { role: 'user' as const, content: dto.user_query },
      { role: 'assistant' as const, content: JSON.stringify(routePlan) },
    ];

    await this.aiSessionsService.saveMessages(session.id, newMessages);

    if (!intent.city) {
      // TRI-106 / MERGE-GUARD
      // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
      // 2) Потребность: унифицировать контракт ошибки "нет города" (code=NEED_CITY),
      //    чтобы frontend не зависел от строкового текста исключения.
      // 3) Если убрать: клиентские ветки обработки снова перейдут к generic-ошибке 422 без уточняющего UX.
      // 4) Возможен конфликт с ветками, где ожидается старый текст "Could not parse city from request".
      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message: this.needCityMessage,
      });
    }

    const baseMeta = {
      parsed_intent: intent,
      steps_duration_ms: {
        orchestrator: orchestratorDuration,
        yandex_fetch: providerDuration, // Для обратной совместимости клиента оставляем ключ
        semantic_filter: semanticDuration,
        scheduler: schedulerDuration,
        total:
          orchestratorDuration +
          providerDuration +
          semanticDuration +
          schedulerDuration,
      },
      poi_counts: {
        yandex_raw: rawPoi.length, // Оставляем старый ключ
        after_semantic: selected.length,
      },
      fallbacks_triggered: fallbacks,
    };

    const contractMeta: PlanResponseContractMeta | Record<string, never> =
      this.isPlannerContractFieldsEnabled()
        ? {
            planner_version: plannerVersion,
            pipeline_status: this.buildPipelineStatus(fallbacks),
          }
        : {};

    const policyMeta =
      this.isPlannerContractFieldsEnabled() && policySnapshot
        ? { policy_snapshot: policySnapshot }
        : {};

    const intentRouterMeta =
      this.isPlannerContractFieldsEnabled() && intentRouterDecision
        ? { intent_router: intentRouterDecision }
        : {};

    const logicalIdMeta =
      this.isPlannerContractFieldsEnabled() &&
      logicalIdFilterEnabled &&
      logicalIdShadowMeta
        ? { logical_id_shadow: logicalIdShadowMeta }
        : {};

    const vectorPrefilterMeta =
      this.isPlannerContractFieldsEnabled() &&
      vectorPrefilterRedisEnabled &&
      vectorPrefilterShadowMeta
        ? { vector_prefilter_shadow: vectorPrefilterShadowMeta }
        : {};

    const deterministicPlannerMeta =
      this.isPlannerContractFieldsEnabled() &&
      deterministicPlannerEnabled &&
      deterministicPlannerShadowMeta
        ? { deterministic_planner_shadow: deterministicPlannerShadowMeta }
        : {};

    const massCollectionMeta =
      this.isPlannerContractFieldsEnabled() &&
      this.isMassCollectionV2Enabled() &&
      massCollectionShadowMeta
        ? { mass_collection_shadow: massCollectionShadowMeta }
        : {};

    const yandexBatchRefinementMeta =
      this.isPlannerContractFieldsEnabled() &&
      yandexBatchRefinementEnabled &&
      yandexBatchRefinementDiagnostics
        ? {
            yandex_batch_refinement: {
              status:
                yandexBatchRefinementDiagnostics.failed_batches > 0
                  ? 'fallback'
                  : 'ok',
              ...yandexBatchRefinementDiagnostics,
            },
          }
        : {};

    return {
      session_id: session.id,
      route_plan: routePlan,
      meta: {
        ...baseMeta,
        ...contractMeta,
        ...intentRouterMeta,
        ...policyMeta,
        ...logicalIdMeta,
        ...vectorPrefilterMeta,
        ...deterministicPlannerMeta,
        ...massCollectionMeta,
        ...yandexBatchRefinementMeta,
      },
    };
  }

  @Sse('plan/stream')
  planStream(@Req() req: Request): Observable<MessageEvent> {
    if (!this.isPlannerSseEnabled()) {
      throw new NotFoundException('Not Found');
    }

    const requestId = randomUUID();
    const plannerVersion = this.resolvePlannerVersion();
    const heartbeatIntervalMs = 10_000;

    return new Observable<MessageEvent>((subscriber) => {
      const startedEvent: PlanStartedSseEvent = {
        event: 'plan_started',
        data: {
          request_id: requestId,
          planner_version: plannerVersion,
        },
      };

      subscriber.next({
        type: startedEvent.event,
        data: startedEvent.data,
      } satisfies PlannerSseEvent);

      const intervalId = setInterval(() => {
        const heartbeatEvent: HeartbeatSseEvent = {
          event: 'heartbeat',
          data: {
            request_id: requestId,
            timestamp: new Date().toISOString(),
          },
        };

        subscriber.next({
          type: heartbeatEvent.event,
          data: heartbeatEvent.data,
        } satisfies PlannerSseEvent);
      }, heartbeatIntervalMs);

      const handleClose = () => {
        clearInterval(intervalId);
        subscriber.complete();
      };

      req.on('close', handleClose);

      return () => {
        clearInterval(intervalId);
        req.off('close', handleClose);
      };
    });
  }

  @Post('sessions/:id/apply')
  async applySessionPlan(
    @Param('id') sessionId: string,
    @Body() dto: { message_id?: string; route_plan?: RoutePlan },
    @CurrentUser() user: { id: string },
  ) {
    // TRI-104: применяет AI-план к trip (создание при первом применении, обновление при следующих).
    // MERGE-NOTE: frontend кнопка apply/update опирается на этот контракт { trip_id, mode }.
    const session = await this.aiSessionsService.getByIdForUser(
      sessionId,
      user.id,
    );
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const sourceMessage = session.messages
      .slice()
      .reverse()
      .find((item) => item.role === 'assistant' && item.content);

    const routePlan =
      dto.route_plan ||
      (sourceMessage ? this.tryParseRoutePlan(sourceMessage) : null);

    if (!routePlan) {
      throw new BadRequestException('Route plan message not found in session');
    }

    const result = await this.aiSessionsService.applyRoutePlanToTrip({
      sessionId,
      userId: user.id,
      routePlan,
    });

    return {
      trip_id: result.tripId,
      mode: result.created ? 'created' : 'updated',
    };
  }

  @Post('sessions/from-trip/:tripId')
  async createSessionFromTrip(
    @Param('tripId') tripId: string,
    @CurrentUser() user: { id: string },
  ) {
    // TRI-104: сценарий "Редактировать с AI" из Planner.
    // Назначение: найти/создать чат по tripId, добавить приветствие и маршрут как стартовый контекст.
    // MERGE-NOTE: если меняете format стартовых сообщений, синхронизируйте mapStoredMessagesToChatMessages в web-store.
    const trip = await this.tripsService.findByIdWithAccess(tripId, user.id);
    if (trip.ownerId !== user.id) {
      throw new ForbiddenException('Only owner can edit this trip with AI');
    }

    const points = await this.pointsService.findByTrip(tripId);
    const enriched = await this.enrichDescriptions(
      points.map((point) => ({ title: point.title, address: point.address })),
    );

    const dateMap = new Map<
      string,
      Array<
        (typeof enriched)[number] & {
          budget: number;
        }
      >
    >();
    if (points.length === 0) {
      dateMap.set(new Date().toISOString(), []);
    } else {
      points.forEach((point) => {
        const date = point.visitDate || new Date().toISOString();
        const bucket = dateMap.get(date) ?? [];
        const description =
          enriched.find((item) => item.title === point.title)?.description ??
          `Интересное место: ${point.title}.`;

        bucket.push({
          title: point.title,
          address: point.address,
          description,
          budget: typeof point.budget === 'number' ? point.budget : 0,
        });
        dateMap.set(date, bucket);
      });
    }

    const days = Array.from(dateMap.entries()).map(
      ([date, dayPoints], index) => ({
        day_number: index + 1,
        date,
        day_budget_estimated: dayPoints.reduce(
          (sum, point) => sum + (point.budget || 0),
          0,
        ),
        day_start_time: '10:00',
        day_end_time: '20:00',
        points: dayPoints.map((point, pointIndex) => ({
          poi_id: `${index + 1}-${pointIndex + 1}`,
          order: pointIndex,
          arrival_time: '10:00',
          departure_time: '12:00',
          visit_duration_min: 90,
          estimated_cost: point.budget || 0,
          poi: {
            id: `${index + 1}-${pointIndex + 1}`,
            name: point.title,
            address: point.address ?? 'Адрес не указан',
            description: point.description,
            coordinates: { lat: 0, lon: 0 },
            category: 'attraction' as const,
          },
        })),
      }),
    );

    const routePlan: RoutePlan = {
      city: trip.title,
      total_budget_estimated:
        trip.budget ??
        days.reduce((sum, day) => sum + (day.day_budget_estimated || 0), 0),
      days,
      notes: `Бюджет: ${trip.budget ?? 'неограничен'}`,
    };

    const session = await this.aiSessionsService.getOrCreateByTrip(
      user.id,
      tripId,
    );
    const existingHasRoute = session.messages.some((message) =>
      this.tryParseRoutePlan(message),
    );

    if (!existingHasRoute) {
      await this.aiSessionsService.appendMessages(session.id, [
        {
          role: 'assistant',
          content:
            `Привет! 👋 Я AI-помощник по путешествиям. Я проанализировал маршрут «${trip.title}». ` +
            'Напиши, что хочешь изменить.',
        },
        {
          role: 'assistant',
          content: JSON.stringify(routePlan),
        },
      ]);
    }

    return { session_id: session.id, trip_id: tripId };
  }
}
