import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Patch,
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
import { SetMetadata } from '@nestjs/common';
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
import type { RoutePlan, PlanDay } from './types/pipeline.types';
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

import { MutationParserService } from './services/mutation-parser.service';
import { PointMutationService } from './services/point-mutation.service';
import { PointMutation } from './types/mutations';
import { CollaborationEventsService } from '../collaboration/collaboration-events.service';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger('AI_PIPELINE');

  // TRI-106 / MERGE-GUARD  // 1) Ветка: fix/TRI-106-ai-session-isolation-need-city
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
    private readonly mutationParser: MutationParserService,
    private readonly pointMutationService: PointMutationService,
    private readonly eventsService: CollaborationEventsService,
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

    // 1. Check structured route_plan field from DB/Store
    if (message.route_plan && typeof message.route_plan === 'object') {
      return message.route_plan;
    }

    // 2. Legacy fallback: try to parse content
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
    this.logger.debug(`Extracting POIs from history of ${history.length} messages`);
    const latestRoutePlanMessage = history
      .slice()
      .reverse()
      .find((message) => {
        const p = this.tryParseRoutePlan(message);
        if (p) this.logger.debug(`Found route plan in message: ${message.content.slice(0, 50)}...`);
        return !!p;
      });

    if (!latestRoutePlanMessage) {
      this.logger.debug('No route plan found in history');
      return [];
    }

    const parsed = this.tryParseRoutePlan(latestRoutePlanMessage);
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

  private buildRoutePlanFromPoints(city: string, points: any[]): RoutePlan {
    const daysMap = new Map<string, any[]>();
    points.forEach((p) => {
      const dateKey = p.visitDate || 'default';
      if (!daysMap.has(dateKey)) daysMap.set(dateKey, []);
      daysMap.get(dateKey)!.push({
        poi_id: p.id,
        order: p.order,
        estimated_cost: Number(p.budget) || 0,
        arrival_time: '10:00',
        departure_time: '11:00',
        visit_duration_min: 60,
        poi: {
          id: p.id,
          name: p.title,
          address: p.address,
          coordinates: { lat: p.lat, lon: p.lon },
          image_url: p.imageUrl,
        },
      });
    });

    const days: PlanDay[] = Array.from(daysMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, dayPoints], idx) => {
        const dayBudget = dayPoints.reduce(
          (sum, p) => sum + (p.estimated_cost || 0),
          0,
        );
        return {
          day_number: idx + 1,
          date:
            date === 'default' ? new Date().toISOString().split('T')[0] : date,
          day_budget_estimated: dayBudget,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: dayPoints.sort((a, b) => a.order - b.order),
        };
      });

    return {
      city,
      total_budget_estimated: days.reduce(
        (acc, d) => acc + d.day_budget_estimated,
        0,
      ),
      days,
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

  @Patch('sessions/:id')
  @UseGuards(JwtAuthGuard)
  async renameSession(
    @Param('id') sessionId: string,
    @Body('title') title: string,
    @CurrentUser() user: { id: string },
  ) {
    if (!title || !title.trim()) {
      throw new BadRequestException('title is required');
    }
    await this.aiSessionsService.renameSession(sessionId, user.id, title.trim());
    return { success: true };
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

  @Post('sessions/:id/clear')
  @UseGuards(JwtAuthGuard)
  async clearSessionMessages(
    @Param('id') sessionId: string,
    @CurrentUser() user: { id: string },
    @Body() body: { keep_last_plan?: boolean } = {},
  ) {
    const session = await this.aiSessionsService.getByIdForUser(sessionId, user.id);
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (body.keep_last_plan) {
      const messages = session.messages || [];
      // Ищем последнее сообщение ассистента с планом
      const lastPlanIdx = [...messages].reverse().findIndex(
        m => m.role === 'assistant' && (m.route_plan || m.content.includes('"days":'))
      );
      
      if (lastPlanIdx !== -1) {
        const lastPlanMessage = [...messages].reverse()[lastPlanIdx];
        await this.aiSessionsService.saveMessages(sessionId, [lastPlanMessage]);
        return { success: true, kept: true };
      }
    }

    // Очищаем все сообщения
    await this.aiSessionsService.saveMessages(sessionId, []);
    return { success: true, kept: false };
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
    this.logger.log(`Current route POIs for router: ${JSON.stringify(currentRoutePois)}`);
    const intentRouterDecision: IntentRouterDecision =
      await this.intentRouterService.route(
        dto.user_query,
        llmContext,
        currentRoutePois,
      );
    this.logger.log(`Intent router decision: ${JSON.stringify(intentRouterDecision)}`);

    let intent: ParsedIntent;
    try {
      intent = await this.orchestratorService.parseIntent(
        dto.user_query,
        llmContext,
      );
    } catch (error) {
      // TRI-106 / MERGE-GUARD
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

      if (session.tripId) {
        this.eventsService.emitTripRefresh(session.tripId);
      }

      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message: this.needCityMessage,
        session_id: session.id,
      });
    }

    if (!intent.city) {
      // TRI-106 / MERGE-GUARD
      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message: this.needCityMessage,
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

    let routePlan: RoutePlan;

    // Решаем, нужно ли сохранять старые точки
    const isNewRouteRequested =
      intentRouterDecision.action_type === 'NEW_ROUTE' || !existingRoutePlan;

    if (isNewRouteRequested) {
      routePlan = this.schedulerService.buildPlan(selectedForScheduler, intent);
    } else {
      // Сохраняем старые точки для всех остальных типов действий (ADD_POI, REPLACE_POI, APPLY_GLOBAL_FILTER и т.д.)
      const oldPois = existingRoutePlan.days.flatMap((d) =>
        d.points.map((p) =>
          this.toFilteredPoi(p.poi, (p.poi as any).description),
        ),
      );

      const combinePool = (newPois: FilteredPoi[]): FilteredPoi[] => {
        const combined = [...oldPois, ...newPois];
        const seen = new Set<string>();
        return combined.filter((p) => {
          const k = p.name.toLowerCase().trim();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      };

      if (intentRouterDecision.route_mode === 'targeted_mutation') {
        mutationMeta.mutation_type = intentRouterDecision.action_type;

        switch (intentRouterDecision.action_type) {
          case 'ADD_POI': {
            routePlan = this.schedulerService.buildPlan(
              combinePool(selectedForScheduler),
              {
                ...intent,
                days: Math.max(intent.days, existingRoutePlan.days.length),
              },
            );
            mutationMeta.mutation_applied = true;
            break;
          }

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

            // Fallback: пробуем найти лучшее совпадение через нечёткий поиск
            const allPoints = existingRoutePlan.days.flatMap(day => day.points);
            const userQuery = dto.user_query.toLowerCase();

            // Находим точку с наибольшим совпадением по названию
            let bestMatch: typeof allPoints[0] | null = null;
            let bestScore = 0;

            for (const point of allPoints) {
              const poiName = (point.poi?.name ?? '').toLowerCase();
              // Простой подсчёт совпадений символов
              const matches = userQuery.split(' ').filter(word => poiName.includes(word)).length;
              if (matches > bestScore) {
                bestScore = matches;
                bestMatch = point;
              }
            }

            if (bestMatch && bestScore > 0 && existingRoutePlan) {
              // Удаляем точку и пересчитываем времена остальных (без пересортировки)
              const targetPoiId = bestMatch.poi_id;
              const rebuiltDays = existingRoutePlan.days.map((day) => {
                const filteredPoints = day.points.filter((point) => point.poi_id !== targetPoiId);

                // Пересчитываем времена оставшихся точек чтобы не было дыр
                let currentTime = this.schedulerService.timeToMinutes(day.day_start_time);
                const rescheduledPoints = filteredPoints.map((point) => {
                  const durationMinutes = this.schedulerService.timeToMinutes(point.departure_time) -
                                          this.schedulerService.timeToMinutes(point.arrival_time);
                  const arrival = this.schedulerService.minutesToTime(currentTime);
                  const departure = this.schedulerService.minutesToTime(currentTime + durationMinutes);
                  currentTime += durationMinutes;

                  return {
                    ...point,
                    arrival_time: arrival,
                    departure_time: departure,
                  };
                });

                return {
                  ...day,
                  points: rescheduledPoints,
                  day_budget_estimated: rescheduledPoints.reduce(
                    (sum, p) => sum + (p.estimated_cost ?? 0),
                    0,
                  ),
                };
              });
              routePlan = buildRoutePlanFromDays(
                existingRoutePlan.city,
                rebuiltDays,
              );
              mutationMeta.mutation_applied = true;
              break;
            }

            // Если нечёткий поиск не помог, показываем ошибку
            mutationMeta.mutation_fallback_reason = 'POINT_NOT_FOUND_IN_ROUTE';
            routePlan = existingRoutePlan!;
            break;
          }

          const rebuiltDays = existingRoutePlan!.days.map((day) => {
            // Удаляем точку и пересчитываем времена оставшихся (без пересортировки)
            const filteredPoints = day.points.filter((point) => point.poi_id !== targetPoiId);

            // Пересчитываем времена оставшихся точек чтобы не было дыр
            let currentTime = this.schedulerService.timeToMinutes(day.day_start_time);
            const rescheduledPoints = filteredPoints.map((point) => {
              const durationMinutes = this.schedulerService.timeToMinutes(point.departure_time) -
                                      this.schedulerService.timeToMinutes(point.arrival_time);
              const arrival = this.schedulerService.minutesToTime(currentTime);
              const departure = this.schedulerService.minutesToTime(currentTime + durationMinutes);
              currentTime += durationMinutes;

              return {
                ...point,
                arrival_time: arrival,
                departure_time: departure,
              };
            });

            return {
              ...day,
              points: rescheduledPoints,
              day_budget_estimated: rescheduledPoints.reduce(
                (sum, p) => sum + (p.estimated_cost ?? 0),
                0,
              ),
            };
          });

          routePlan = buildRoutePlanFromDays(
            existingRoutePlan!.city,
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
            routePlan = this.schedulerService.buildPlan(
              combinePool(selectedForScheduler),
              {
                ...intent,
                days: Math.max(intent.days, existingRoutePlan.days.length),
              },
            );
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
            routePlan = this.schedulerService.buildPlan(
              combinePool(selectedForScheduler),
              {
                ...intent,
                days: Math.max(intent.days, existingRoutePlan.days.length),
              },
            );
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
            routePlan = this.schedulerService.buildPlan(
              combinePool(selectedForScheduler),
              {
                ...intent,
                days: Math.max(intent.days, existingRoutePlan.days.length),
              },
            );
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
          routePlan = this.schedulerService.buildPlan(
            combinePool(selectedForScheduler),
            {
              ...intent,
              days: Math.max(intent.days, existingRoutePlan.days.length),
            },
          );
          break;
      }
    } else {
      // Режим full_rebuild для глобальных мутаций (APPLY_GLOBAL_FILTER, ADD_DAYS и т.д.)
      // Сохраняем старые точки и добавляем новые (если есть)
      routePlan = this.schedulerService.buildPlan(
        combinePool(selectedForScheduler),
        {
          ...intent,
          days: Math.max(intent.days, existingRoutePlan.days.length),
        },
      );
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

    // Если точка не найдена, добавляем сообщение об ошибке
    const assistantMessages: SessionMessage[] = [
      { role: 'user' as const, content: dto.user_query },
    ];

    if (mutationMeta.mutation_fallback_reason === 'POINT_NOT_FOUND_IN_ROUTE') {
      assistantMessages.push({
        role: 'assistant' as const,
        content: '⚠️ Такая точка в маршруте не найдена. Вот текущий маршрут:',
      });
    }

    assistantMessages.push({
      role: 'assistant' as const,
      content: 'Маршрут готов',
      route_plan: routePlan,
    });

    const newMessages: SessionMessage[] = [
      ...history,
      ...assistantMessages,
    ];

    await this.aiSessionsService.saveMessages(session.id, newMessages);

    if (session.tripId) {
      this.eventsService.emitTripRefresh(session.tripId);
      this.eventsService.emitAiUpdate(session.tripId, session.id);
    }

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

    this.eventsService.emitTripRefresh(result.tripId);

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

    const points = await this.pointsService.findByTrip(tripId);
    const enriched = await this.enrichDescriptions(
      points.map((point) => ({ title: point.title, address: point.address })),
    );

    const dateMap = new Map<
      string,
      Array<
        (typeof enriched)[number] & {
          id: string;
          order: number;
          budget: number;
          lat?: number | null;
          lon?: number | null;
        }
      >
    >();
    if (points.length === 0) {
      dateMap.set(new Date().toISOString().split('T')[0], []);
    } else {
      points.forEach((point) => {
        const date = point.visitDate || new Date().toISOString().split('T')[0];
        const bucket = dateMap.get(date) ?? [];
        const description =
          enriched.find((item) => item.title === point.title)?.description ??
          `Интересное место: ${point.title}.`;

        bucket.push({
          id: point.id,
          title: point.title,
          address: point.address,
          description,
          order: point.order,
          budget: typeof point.budget === 'number' ? point.budget : 0,
          lat: point.lat,
          lon: point.lon,
        });
        dateMap.set(date, bucket);
      });
    }

    const days = Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, dayPoints], index) => ({
        day_number: index + 1,
        date,
        day_budget_estimated: dayPoints.reduce(
          (sum, point) => sum + (point.budget || 0),
          0,
        ),
        day_start_time: '10:00',
        day_end_time: '20:00',
        points: dayPoints
          .sort((a, b) => a.order - b.order)
          .map((point) => ({
            poi_id: point.id,
            order: point.order,
            arrival_time: '10:00',
            departure_time: '12:00',
            visit_duration_min: 90,
            estimated_cost: point.budget || 0,
            poi: {
              id: point.id,
              name: point.title,
              address: point.address ?? 'Адрес не указан',
              description: point.description,
              coordinates: { lat: point.lat ?? 0, lon: point.lon ?? 0 },
              category: 'attraction' as const,
            },
          })),
      }));

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
    const lastRoutePlanMessage = session.messages
      .slice()
      .reverse()
      .find((message) => this.tryParseRoutePlan(message));
    const lastRoutePlan = lastRoutePlanMessage
      ? this.tryParseRoutePlan(lastRoutePlanMessage)
      : null;

    const currentTitles = new Set(points.map((p) => p.title.toLowerCase().trim()));
    const lastTitles = new Set(
      (lastRoutePlan?.days ?? [])
        .flatMap((d) => d.points)
        .map((p) => (p.poi?.name ?? '').toLowerCase().trim()),
    );
    const routeChanged =
      currentTitles.size !== lastTitles.size ||
      [...currentTitles].some((t) => !lastTitles.has(t));

    if (!lastRoutePlan) {
      await this.aiSessionsService.appendMessages(session.id, [
        {
          role: 'assistant',
          content:
            `Привет! 👋 Я AI-помощник по путешествиям. Я проанализировал маршрут «${trip.title}». ` +
            'Напиши, что хочешь изменить.',
        },
        {
          role: 'assistant',
          content: 'Маршрут готов',
          route_plan: routePlan,
        },
      ]);
    } else if (routeChanged) {
      await this.aiSessionsService.appendMessages(session.id, [
        {
          role: 'assistant',
          content: `Маршрут обновлён в Planner. Актуальный состав точек:`,
          route_plan: routePlan,
        },
      ]);
    }

    this.eventsService.emitTripRefresh(tripId);
    this.eventsService.emitAiUpdate(tripId, session.id);

    return { session_id: session.id, trip_id: tripId };
  }

  @Post('test/compare-providers')
  @SetMetadata('isPublic', true)
  async compareProviders(
    @Body()
    body: {
      query: string;
    },
  ) {
    const { query } = body;

    const fallbacks: string[] = [];
    const intent = await this.orchestratorService.parseIntent(query, []);

    const { pois: poisRaw } = await this.providerSearchService.fetchAndFilter(
      intent,
      fallbacks,
    );

    const pois = poisRaw.slice(0, 20);

    if (pois.length === 0) {
      return {
        error: 'No POI found for query. For foreign cities, check Overpass API status.',
        city: intent.city || 'unknown',
        query,
        input_poi_count: 0,
      };
    }

    const comparison = await this.semanticFilterService.compareProviders(pois, intent);

    return {
      city: intent.city || 'unknown',
      query,
      input_poi_count: pois.length,
      fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
      yandex: {
        count: comparison.yandex.pois.length,
        duration_ms: comparison.yandex.duration_ms,
        error: comparison.yandex.error,
        pois: comparison.yandex.pois.map((p) => ({
          name: p.name,
          category: p.category,
          rating: p.rating,
          description: p.description,
        })),
      },
      openrouter: {
        count: comparison.openrouter.pois.length,
        duration_ms: comparison.openrouter.duration_ms,
        error: comparison.openrouter.error,
        pois: comparison.openrouter.pois.map((p) => ({
          name: p.name,
          category: p.category,
          rating: p.rating,
          description: p.description,
        })),
      },
    };
  }

  @Post('test/strategy/llm-only')
  @SetMetadata('isPublic', true)
  async testLlmOnly(
    @Body() body: { query: string },
  ) {
    const { query } = body;
    const intent = await this.orchestratorService.parseIntent(query, []);

    const t0 = Date.now();
    const pois = await this.semanticFilterService.generatePoiFromScratch(intent);
    const duration = Date.now() - t0;

    return {
      strategy: 'llm-only',
      city: intent.city || 'unknown',
      query,
      poi_count: pois.length,
      duration_ms: duration,
      pois: pois.map((p) => ({
        name: p.name,
        category: p.category,
        rating: p.rating,
        description: p.description,
      })),
    };
  }

  @Post('test/strategy/provider-only')
  @SetMetadata('isPublic', true)
  async testProviderOnly(
    @Body() body: { query: string },
  ) {
    const { query } = body;
    const fallbacks: string[] = [];
    const intent = await this.orchestratorService.parseIntent(query, []);

    const t0 = Date.now();
    const { pois: poisRaw } = await this.providerSearchService.fetchAndFilter(
      intent,
      fallbacks,
    );
    const duration = Date.now() - t0;

    const pois = poisRaw.slice(0, 20);

    return {
      strategy: 'provider-only',
      city: intent.city || 'unknown',
      query,
      poi_count: pois.length,
      duration_ms: duration,
      fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
      pois: pois.map((p) => ({
        name: p.name,
        category: p.category,
        rating: p.rating,
      })),
    };
  }

  @Post('test/strategy/hybrid')
  @SetMetadata('isPublic', true)
  async testHybrid(
    @Body() body: { query: string },
  ) {
    const { query } = body;
    const fallbacks: string[] = [];
    const intent = await this.orchestratorService.parseIntent(query, []);

    // Step 1: Try provider search first
    const t0 = Date.now();
    const { pois: poisRaw } = await this.providerSearchService.fetchAndFilter(
      intent,
      fallbacks,
    );
    const providerDuration = Date.now() - t0;

    let pois = poisRaw.slice(0, 20);

    // Step 2: If provider returned too few POI, supplement with LLM
    if (pois.length < 10) {
      const t1 = Date.now();
      const llmPois = await this.semanticFilterService.selectWithOpenRouter(
        pois,
        intent,
      );
      const llmDuration = Date.now() - t1;
      pois = llmPois;

      return {
        strategy: 'hybrid',
        city: intent.city || 'unknown',
        query,
        poi_count: pois.length,
        provider_duration_ms: providerDuration,
        llm_supplement_duration_ms: llmDuration,
        total_duration_ms: providerDuration + llmDuration,
        fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
        used_llm_supplement: true,
        pois: (pois as FilteredPoi[]).map((p) => ({
          name: p.name,
          category: p.category,
          rating: p.rating,
          description: p.description,
        })),
      };
    }

    return {
      strategy: 'hybrid',
      city: intent.city || 'unknown',
      query,
      poi_count: pois.length,
      provider_duration_ms: providerDuration,
      llm_supplement_duration_ms: 0,
      total_duration_ms: providerDuration,
      fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
      used_llm_supplement: false,
      pois: pois.map((p) => ({
        name: p.name,
        category: p.category,
        rating: p.rating,
      })),
    };
  }

  @Post('mutations/parse')
  async parseMutations(
    @Body() body: { query: string; tripContext?: string },
  ) {
    return this.mutationParser.parseMutations(body.query, body.tripContext);
  }

  @Post('mutations/:tripId/apply')
  async applyMutations(
    @Param('tripId') tripId: string,
    @CurrentUser() user: { id: string },
    @Body() body: { mutations: any[]; ifMatch: number; sessionId?: string },
  ) {
    const trip = await this.tripsService.findByIdWithAccess(tripId, user.id);
    const dbPointsCount = (trip as any)?.points?.length ?? 0;

    // Chat-only режим: точки ещё не сохранены в DB (только в route_plan сессии)
    if (dbPointsCount === 0 && body.sessionId) {
      const session = await this.aiSessionsService.getByIdForUser(body.sessionId, user.id);
      const lastRoutePlan = session ? this.extractCurrentRoutePlan(session.messages) : null;

      this.logger.debug(
        `applyMutations chat-only START: sessionId=${body.sessionId}, ` +
        `messages.length=${session?.messages.length ?? 0}, mutations=${JSON.stringify(body.mutations.map((m: any) => m.type))}`
      );

      if (lastRoutePlan) {
        // Работаем напрямую с route_plan в чате (без конвертации в DB points)
        // Применяем мутации к структуре route_plan, сохраняя времена и порядок

        // Парсим mutations (они могут быть REMOVE_BY_QUERY или REMOVE_BY_ID)
        const removeQueries = body.mutations
          .filter((m: any) => m.type === 'REMOVE_BY_QUERY')
          .map((m: any) => m.query.toLowerCase());

        this.logger.log(
          `[MUTATION] Mutations to apply: ${JSON.stringify(body.mutations)}`
        );
        this.logger.log(
          `[MUTATION] Parsed removeQueries: [${removeQueries.map(q => `"${q}"`).join(', ')}]`
        );
        this.logger.log(
          `[MUTATION] Current points: ${JSON.stringify(
            lastRoutePlan.days.map((d, idx) => ({
              day: idx,
              points: d.points.map(p => ({ name: p.poi?.name, lower: (p.poi?.name ?? '').toLowerCase() }))
            }))
          )}`
        );

        // Удаляем точки по названию
        const updatedDays = lastRoutePlan.days.map((day, dayIdx) => {
          const filteredPoints = day.points.filter((point) => {
            const poiName = (point.poi?.name ?? '').toLowerCase();
            const shouldKeep = !removeQueries.some((q) => {
              if (typeof q !== 'string') return false;
              const matches = poiName.includes(q) || q.includes(poiName.split(' ')[0]);
              if (matches) {
                this.logger.debug(
                  `FILTER[${dayIdx}]: poi="${point.poi?.name}" (lower="${poiName}") ` +
                  `matches query="${q}" → REMOVE`
                );
              }
              return matches;
            });
            if (!shouldKeep) {
              this.logger.debug(`  → Removed: "${point.poi?.name}"`);
            }
            return shouldKeep;
          });

          this.logger.debug(`Day ${dayIdx}: kept ${filteredPoints.length}/${day.points.length} points`);

          // Пересчитываем времена оставшихся точек
          let currentTime = this.schedulerService.timeToMinutes(day.day_start_time);
          const rescheduledPoints = filteredPoints.map((point) => {
            const durationMinutes = this.schedulerService.timeToMinutes(point.departure_time) -
                                    this.schedulerService.timeToMinutes(point.arrival_time);
            const arrival = this.schedulerService.minutesToTime(currentTime);
            const departure = this.schedulerService.minutesToTime(currentTime + durationMinutes);
            currentTime += durationMinutes;

            return {
              ...point,
              arrival_time: arrival,
              departure_time: departure,
            };
          });

          return {
            ...day,
            points: rescheduledPoints,
            day_budget_estimated: rescheduledPoints.reduce((sum, p) => sum + (p.estimated_cost ?? 0), 0),
          };
        }).filter(day => day.points.length > 0);

        const messageContent = updatedDays.length === 0 || updatedDays.every(d => d.points.length === 0)
          ? 'Маршрут очищен.'
          : 'Я обновил маршрут.';

        if (updatedDays.length === 0 || updatedDays.every(d => d.points.length === 0)) {
          // Маршрут очищен — просто отправляем текстовое сообщение без карточки
          await this.aiSessionsService.appendMessages(body.sessionId, [
            { role: 'assistant', content: messageContent },
          ]);
          return { success: true, route_plan: undefined, points: [], version: 0 };
        }

        const updatedRoutePlan: RoutePlan = {
          ...lastRoutePlan,
          days: updatedDays,
          total_budget_estimated: updatedDays.reduce((sum, d) => sum + (d.day_budget_estimated ?? 0), 0),
        };

        const finalPointsList = updatedRoutePlan.days.flatMap(d => d.points.map(p => p.poi?.name)).join(', ');
        this.logger.log(
          `[MUTATION] Final updatedRoutePlan points: [${finalPointsList}]`
        );

        await this.aiSessionsService.appendMessages(body.sessionId, [
          { role: 'assistant', content: messageContent, route_plan: updatedRoutePlan },
        ]);

        this.logger.log(`[MUTATION] ✓ appendMessages completed for session ${body.sessionId}`);

        this.eventsService.emitTripRefresh(tripId);
        this.eventsService.emitAiUpdate(tripId, body.sessionId);

        return { success: true, route_plan: updatedRoutePlan, points: [], version: 0 };
      }
    }

    // DB-backed режим (стандартный)
    const result = await this.pointMutationService.applyMutations(
      tripId,
      user.id,
      body.mutations,
      body.ifMatch,
    );

    if (result.success) {
      this.eventsService.emitTripRefresh(tripId);
      const messageContent = result.points.length === 0
        ? 'Маршрут очищен.'
        : 'Я обновил маршрут.';

      if (result.points.length === 0) {
        // Маршрут очищен — только текстовое сообщение без карточки
        if (body.sessionId) {
          await this.aiSessionsService.appendMessages(body.sessionId, [
            { role: 'assistant', content: messageContent },
          ]);
        }
        return { ...result, route_plan: undefined };
      }

      // Есть точки — отправляем с обновлённым маршрутом
      const routePlan = this.buildRoutePlanFromPoints(
        trip?.title || 'Маршрут',
        result.points,
      );

      if (body.sessionId) {
        await this.aiSessionsService.appendMessages(body.sessionId, [
          { role: 'assistant', content: messageContent, route_plan: routePlan },
        ]);
        this.eventsService.emitAiUpdate(tripId, body.sessionId);
      }

      return { ...result, route_plan: routePlan };
    }

    return result;
  }
}
