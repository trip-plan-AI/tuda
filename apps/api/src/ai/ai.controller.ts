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
import { LogicalIdSelectorService } from './pipeline/logical-id-selector.service';
import type { SessionMessage } from './types/pipeline.types';
import type { RoutePlan } from './types/pipeline.types';
import type { ParsedIntent } from './types/pipeline.types';
import type {
  IntentRouterActionType,
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
import type { FilteredPoi, PoiItem } from './types/poi.types';
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

  private resolveVectorTopK(): number {
    const fallbackTopK = 200;
    const rawValue = Number.parseInt(process.env.AI_VECTOR_TOPK ?? '', 10);

    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      return fallbackTopK;
    }

    return rawValue;
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
    private readonly logicalIdSelectorService: LogicalIdSelectorService,
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

  private extractCurrentRoutePois(
    history: SessionMessage[],
  ): Array<{ poi_id: string; title?: string | null }> {
    const latestRoutePlan = history
      .slice()
      .reverse()
      .find((message) => this.tryParseRoutePlan(message));

    if (!latestRoutePlan) {
      return [];
    }

    const parsed = this.tryParseRoutePlan(latestRoutePlan);
    if (!parsed) {
      return [];
    }

    return parsed.days.flatMap((day) =>
      day.points
        .filter(
          (point) => typeof point.poi_id === 'string' && point.poi_id.trim(),
        )
        .map((point) => ({
          poi_id: point.poi_id,
          title: point.poi?.name ?? null,
        })),
    );
  }

  private extractCurrentRoutePlan(history: SessionMessage[]): RoutePlan | null {
    const latestRoutePlanMessage = history
      .slice()
      .reverse()
      .find((message) => this.tryParseRoutePlan(message));

    if (!latestRoutePlanMessage) return null;
    return this.tryParseRoutePlan(latestRoutePlanMessage);
  }

  private toFilteredPoi(poi: PoiItem, descriptionFallback = ''): FilteredPoi {
    return {
      ...poi,
      description: (
        descriptionFallback || `Интересное место: ${poi.name}.`
      ).trim(),
    };
  }

  private addDaysToIsoDate(baseDate: string, offsetDays: number): string {
    const parsed = new Date(baseDate);
    if (Number.isNaN(parsed.getTime())) return baseDate;
    parsed.setDate(parsed.getDate() + offsetDays);
    return parsed.toISOString().slice(0, 10);
  }

  private parseTimeToMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private isWorkingHoursAllowed(
    workingHours: string | undefined,
    time: string,
  ): boolean {
    if (!workingHours || typeof workingHours !== 'string') return true;

    const normalized = workingHours.toLowerCase();
    if (normalized.includes('круглосуточно') || normalized.includes('24/7')) {
      return true;
    }

    const rangeMatch = normalized.match(
      /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/,
    );
    if (!rangeMatch) return true;

    const current = this.parseTimeToMinutes(time);
    const start = this.parseTimeToMinutes(rangeMatch[1]);
    const end = this.parseTimeToMinutes(rangeMatch[2]);

    if (end >= start) {
      return current >= start && current <= end;
    }

    return current >= start || current <= end;
  }

  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    const currentRoutePois = this.extractCurrentRoutePois(history);
    const intentRouterDecision: IntentRouterDecision =
      await this.intentRouterService.route(
        dto.user_query,
        llmContext,
        currentRoutePois,
      );

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
    const plannerVersion: PlannerVersion = 'v2';
    const policySnapshot: PolicySnapshot =
      this.policyService.calculatePolicySnapshot(intent, llmContext, 'v2');

    const providerStart = Date.now();
    const fallbacks: string[] = [];
    const providerResult = await this.providerSearchService.fetchAndFilter(
      intent,
      fallbacks,
    );
    const rawPoi = providerResult.pois;
    const massCollectionShadowMeta: MassCollectionShadowMeta =
      providerResult.shadowDiagnostics ?? {
        provider_stats: [],
        totals: {
          before_dedup: rawPoi.length,
          after_dedup: rawPoi.length,
          returned: rawPoi.length,
        },
      };
    const providerDuration = Date.now() - providerStart;

    const personaSummary =
      policySnapshot.user_persona_summary ?? dto.user_query;
    const vectorPrefilterShadowMeta: VectorPrefilterShadowMeta =
      await this.vectorPrefilterService.runShadowPrefilter(
        personaSummary,
        rawPoi,
        this.resolveVectorTopK(),
      );

    const logicalSelectorResult = await this.logicalIdSelectorService.selectIds(
      {
        candidates: rawPoi.map((poi) => ({
          id: poi.id,
          name: poi.name,
          category: poi.category,
        })),
        required_capacity: policySnapshot.required_capacity,
        food_policy: policySnapshot.food_policy,
      },
    );
    const selectedIdSet = new Set(logicalSelectorResult.selected_ids);
    const logicalSelectedPool = rawPoi.filter((poi) =>
      selectedIdSet.has(poi.id),
    );

    const enrichedWithLogicalIds = this.logicalIdFilterService.attachLogicalIds(
      rawPoi,
      intent.city,
    );
    const duplicateGroups =
      this.logicalIdFilterService.analyzeDuplicatesByLogicalId(
        enrichedWithLogicalIds,
      );

    const logicalIdShadowMeta: LogicalIdShadowMeta = {
      total_candidates: enrichedWithLogicalIds.length,
      duplicates_groups: duplicateGroups.length,
      duplicates_total: duplicateGroups.reduce(
        (sum, group) => sum + group.count,
        0,
      ),
    };

    const semanticStart = Date.now();
    const selected = await this.semanticFilterService.select(
      logicalSelectedPool,
      intent,
      fallbacks,
    );

    const yandexPersonaSummary =
      policySnapshot.user_persona_summary ?? dto.user_query;
    let selectedForScheduler = selected;
    let yandexBatchRefinementDiagnostics: YandexBatchRefinementDiagnostics | null =
      null;

    try {
      const refinementResult =
        await this.yandexBatchRefinementService.refineSelectedInBatches(
          selected,
          yandexPersonaSummary,
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

    const semanticDuration = Date.now() - semanticStart;

    const schedulerStart = Date.now();
    const existingRoutePlan = this.extractCurrentRoutePlan(history);
    const mutationMeta: {
      mutation_applied?: boolean;
      mutation_type?: IntentRouterActionType;
      mutation_fallback_reason?: string;
    } = {
      mutation_applied: false,
    };

    const buildRoutePlanFromDays = (
      city: string,
      days: RoutePlan['days'],
    ): RoutePlan => ({
      city,
      days,
      total_budget_estimated: days.reduce(
        (sum, day) => sum + (day.day_budget_estimated ?? 0),
        0,
      ),
    });

    const buildFullRebuild = (): RoutePlan =>
      this.schedulerService.buildPlan(selectedForScheduler, intent);

    let routePlan: RoutePlan;

    if (intentRouterDecision.route_mode !== 'targeted_mutation') {
      routePlan = buildFullRebuild();
    } else if (!existingRoutePlan) {
      mutationMeta.mutation_type = intentRouterDecision.action_type;
      mutationMeta.mutation_fallback_reason = 'NO_CURRENT_ROUTE_PLAN';
      fallbacks.push('TARGETED_MUTATION_FALLBACK:NO_CURRENT_ROUTE_PLAN');
      routePlan = buildFullRebuild();
    } else {
      mutationMeta.mutation_type = intentRouterDecision.action_type;

      switch (intentRouterDecision.action_type) {
        case 'REMOVE_POI': {
          const targetPoiId = intentRouterDecision.target_poi_id;
          const targetExists =
            !!targetPoiId &&
            existingRoutePlan.days.some((day) =>
              day.points.some((point) => point.poi_id === targetPoiId),
            );

          if (!targetPoiId || !targetExists) {
            mutationMeta.mutation_fallback_reason = 'TARGET_NOT_FOUND';
            fallbacks.push(
              'TARGETED_MUTATION_REMOVE_FALLBACK:TARGET_NOT_FOUND',
            );
            routePlan = buildFullRebuild();
            break;
          }

          const rebuiltDays = existingRoutePlan.days.map((day) => {
            const dayPois = day.points
              .filter((point) => point.poi_id !== targetPoiId)
              .map((point) =>
                this.toFilteredPoi(
                  point.poi,
                  (point.poi as FilteredPoi).description,
                ),
              );

            return this.schedulerService.rebuildSingleDayPlan(dayPois, intent, {
              day_number: day.day_number,
              date: day.date,
            });
          });

          routePlan = buildRoutePlanFromDays(
            existingRoutePlan.city,
            rebuiltDays,
          );
          mutationMeta.mutation_applied = true;
          break;
        }

        case 'ADD_DAYS': {
          const daysToAdd = Math.max(0, intent.days);
          const usedPoiIds = new Set(
            existingRoutePlan.days.flatMap((day) =>
              day.points.map((point) => point.poi_id),
            ),
          );

          const additionalCandidates = selectedForScheduler.filter(
            (poi) => !usedPoiIds.has(poi.id),
          );
          const addDaysIntent: ParsedIntent = {
            ...intent,
            days: daysToAdd,
          };
          const newDaysPlan =
            daysToAdd > 0
              ? this.schedulerService.buildPlan(
                  additionalCandidates,
                  addDaysIntent,
                )
              : {
                  city: existingRoutePlan.city,
                  total_budget_estimated: 0,
                  days: [],
                };

          const lastExistingDate =
            existingRoutePlan.days[existingRoutePlan.days.length - 1]?.date ??
            new Date().toISOString().slice(0, 10);
          const normalizedNewDays = newDaysPlan.days.map((day, index) => ({
            ...day,
            day_number: existingRoutePlan.days.length + index + 1,
            date: this.addDaysToIsoDate(lastExistingDate, index + 1),
          }));

          routePlan = buildRoutePlanFromDays(existingRoutePlan.city, [
            ...existingRoutePlan.days,
            ...normalizedNewDays,
          ]);
          mutationMeta.mutation_applied = true;
          break;
        }

        case 'REPLACE_POI': {
          const targetPoiId = intentRouterDecision.target_poi_id;
          const dayIndex = existingRoutePlan.days.findIndex((day) =>
            day.points.some((point) => point.poi_id === targetPoiId),
          );

          if (!targetPoiId || dayIndex === -1) {
            mutationMeta.mutation_fallback_reason = 'TARGET_NOT_FOUND';
            fallbacks.push(
              'TARGETED_MUTATION_REPLACE_FALLBACK:TARGET_NOT_FOUND',
            );
            routePlan = buildFullRebuild();
            break;
          }

          const targetDay = existingRoutePlan.days[dayIndex];
          const pointIndex = targetDay.points.findIndex(
            (point) => point.poi_id === targetPoiId,
          );
          const targetPoint = targetDay.points[pointIndex];
          const usedPoiIds = new Set(
            existingRoutePlan.days.flatMap((day) =>
              day.points.map((point) => point.poi_id),
            ),
          );

          const poolFromRaw = rawPoi.map((poi) => this.toFilteredPoi(poi));
          const candidatePool =
            selectedForScheduler.length > 0
              ? selectedForScheduler
              : poolFromRaw;
          const nearestSameCategory = candidatePool
            .filter(
              (poi) =>
                poi.id !== targetPoiId &&
                !usedPoiIds.has(poi.id) &&
                poi.category === targetPoint.poi.category,
            )
            .map((poi) => ({
              poi,
              distance: this.haversineKm(
                targetPoint.poi.coordinates.lat,
                targetPoint.poi.coordinates.lon,
                poi.coordinates.lat,
                poi.coordinates.lon,
              ),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 5)
            .map((entry) => entry.poi)
            .filter((poi) =>
              this.isWorkingHoursAllowed(
                poi.working_hours,
                targetPoint.arrival_time,
              ),
            );

          if (nearestSameCategory.length === 0) {
            mutationMeta.mutation_fallback_reason = 'NO_ALTERNATIVES';
            fallbacks.push(
              'TARGETED_MUTATION_REPLACE_FALLBACK:NO_ALTERNATIVES',
            );
            routePlan = buildFullRebuild();
            break;
          }

          const replacement =
            await this.yandexBatchRefinementService.chooseReplacementAlternative(
              nearestSameCategory,
              yandexPersonaSummary,
              {
                city: intent.city,
                targetName: targetPoint.poi.name,
              },
            );

          if (!replacement) {
            mutationMeta.mutation_fallback_reason =
              'REPLACEMENT_SELECTION_FAILED';
            fallbacks.push(
              'TARGETED_MUTATION_REPLACE_FALLBACK:REPLACEMENT_SELECTION_FAILED',
            );
            routePlan = buildFullRebuild();
            break;
          }

          const replacedDayPois = targetDay.points.map((point, index) =>
            index === pointIndex
              ? replacement
              : this.toFilteredPoi(
                  point.poi,
                  (point.poi as FilteredPoi).description,
                ),
          );
          const rebuiltTargetDay = this.schedulerService.rebuildSingleDayPlan(
            replacedDayPois,
            intent,
            {
              day_number: targetDay.day_number,
              date: targetDay.date,
            },
          );

          const mergedDays = existingRoutePlan.days.map((day, index) =>
            index === dayIndex ? rebuiltTargetDay : day,
          );
          routePlan = buildRoutePlanFromDays(
            existingRoutePlan.city,
            mergedDays,
          );
          mutationMeta.mutation_applied = true;
          break;
        }

        default:
          routePlan = buildFullRebuild();
          break;
      }
    }

    const schedulerDuration = Date.now() - schedulerStart;

    let deterministicPlannerShadowMeta: DeterministicPlannerShadowMeta;

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
        after_logical_selector: logicalSelectedPool.length,
        after_semantic: selected.length,
      },
      fallbacks_triggered: fallbacks,
      ...mutationMeta,
    };

    const contractMeta: PlanResponseContractMeta = {
      planner_version: plannerVersion,
      pipeline_status: this.buildPipelineStatus(fallbacks),
    };

    const policyMeta = { policy_snapshot: policySnapshot };

    const intentRouterMeta = { intent_router: intentRouterDecision };

    const logicalIdMeta = { logical_id_shadow: logicalIdShadowMeta };

    const logicalSelectorMeta = {
      logical_selector: {
        target: logicalSelectorResult.target,
        selected_count: logicalSelectorResult.selected_count,
        ...(logicalSelectorResult.fallback_reason
          ? { fallback_reason: logicalSelectorResult.fallback_reason }
          : {}),
      },
    };

    const vectorPrefilterMeta = {
      vector_prefilter_shadow: vectorPrefilterShadowMeta,
    };

    const deterministicPlannerMeta = {
      deterministic_planner_shadow: deterministicPlannerShadowMeta,
    };

    const massCollectionMeta = {
      mass_collection_shadow: massCollectionShadowMeta,
    };

    const yandexBatchRefinementMeta = yandexBatchRefinementDiagnostics
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
        ...logicalSelectorMeta,
        ...vectorPrefilterMeta,
        ...deterministicPlannerMeta,
        ...massCollectionMeta,
        ...yandexBatchRefinementMeta,
      },
    };
  }

  @Sse('plan/stream')
  planStream(@Req() req: Request): Observable<MessageEvent> {
    req.socket?.setKeepAlive?.(true);
    req.socket?.setTimeout?.(0);

    const requestId = randomUUID();
    const plannerVersion: PlannerVersion = 'v2';
    const heartbeatIntervalMs = 3_000;

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

      const emitHeartbeat = () => {
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
      };

      // Отправляем первый heartbeat сразу, чтобы соединение не выглядело "зависшим"
      // для клиентов/прокси с агрессивными idle/read timeout.
      emitHeartbeat();

      const intervalId = setInterval(emitHeartbeat, heartbeatIntervalMs);

      const handleClose = () => {
        clearInterval(intervalId);
        subscriber.complete();
      };

      req.on('close', handleClose);
      req.on('aborted', handleClose);

      return () => {
        clearInterval(intervalId);
        req.off('close', handleClose);
        req.off('aborted', handleClose);
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
