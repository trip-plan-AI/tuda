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
import { Throttle } from '@nestjs/throttler';
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
import { LlmBatchRefinementService } from './pipeline/llm-batch-refinement.service';
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
import { PoiResolverService } from './services/poi-resolver.service';
import { RouteMutatorService } from './services/route-mutator.service';
import { CollaborationEventsService } from '../collaboration/collaboration-events.service';
import { GeocodingFallbackService } from './services/geocoding-fallback.service';
import { CityAnalyzerService } from './pipeline/city-analyzer.service';
import { LlmExplainerService } from './pipeline/llm-explainer.service';
import { TravelChatService } from './pipeline/travel-chat.service';
import { PoiCacheWarmupService } from './pipeline/poi-cache-warmup.service';

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
    private readonly llmBatchRefinementService: LlmBatchRefinementService,
    private readonly logicalIdSelectorService: LogicalIdSelectorService,
    private readonly mutationParser: MutationParserService,
    private readonly pointMutationService: PointMutationService,
    private readonly eventsService: CollaborationEventsService,
    private readonly geocodingFallbackService: GeocodingFallbackService,
    private readonly analyzer: CityAnalyzerService,
    private readonly explainer: LlmExplainerService,
    private readonly cacheWarmup: PoiCacheWarmupService,
    private readonly travelChatService: TravelChatService,
    private readonly poiResolverService: PoiResolverService,
    private readonly routeMutatorService: RouteMutatorService,
  ) {}

  private isLocationError(error: unknown): boolean {
    if (!(error instanceof UnprocessableEntityException)) return false;

    const response = error.getResponse();
    if (typeof response === 'string') return false;

    return (
      !!response &&
      typeof response === 'object' &&
      'code' in response &&
      ((response as { code?: unknown }).code === 'NEED_CITY' ||
        (response as { code?: unknown }).code === 'NEED_CITY_IN_COUNTRY' ||
        (response as { code?: unknown }).code === 'LOCATION_NOT_FOUND')
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
    this.logger.debug(
      `Extracting POIs from history of ${history.length} messages`,
    );
    const latestRoutePlanMessage = history
      .slice()
      .reverse()
      .find((message) => {
        const p = this.tryParseRoutePlan(message);
        if (p)
          this.logger.debug(
            `Found route plan in message: ${message.content.slice(0, 50)}...`,
          );
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
    let coords = poi.coordinates;

    const isInvalid =
      !coords ||
      coords.lat === undefined ||
      coords.lon === undefined ||
      !Number.isFinite(coords.lat) ||
      !Number.isFinite(coords.lon) ||
      (Math.abs(coords.lat) < 0.001 && Math.abs(coords.lon) < 0.001);

    if (isInvalid) {
      this.logger.warn(
        `[toFilteredPoi] Invalid coords for "${poi.name}": ${JSON.stringify(coords)}. Attempting URI recovery...`,
      );
      const uri = (poi as any).uri || (poi as any).source_uri;
      if (typeof uri === 'string') {
        const match = uri.match(/ll=([^&]+)/);
        if (match) {
          try {
            const raw = decodeURIComponent(match[1]);
            const [lon, lat] = raw.split(',').map(Number);
            if (
              Number.isFinite(lat) &&
              Number.isFinite(lon) &&
              (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001)
            ) {
              coords = { lat, lon };
              this.logger.log(
                `[toFilteredPoi] ✅ Recovered coords for "${poi.name}" from URI: (${lat}, ${lon})`,
              );
            }
          } catch (e) {
            this.logger.error(
              `[toFilteredPoi] Failed to parse URI for "${poi.name}": ${e}`,
            );
          }
        }
      }
    }

    return {
      ...poi,
      coordinates: coords,
      description: (
        descriptionFallback || `Интересное место: ${poi.name}.`
      ).trim(),
    };
  }

  private buildRoutePlanFromPoints(city: string, points: any[]): RoutePlan {
    const daysMap = new Map<string, any[]>();
    points.forEach((p) => {
      // Извлекаем только дату для группировки
      const rawKey = p.visitDate || 'default';
      const dateKey = rawKey.includes('T') ? rawKey.split('T')[0] : rawKey;
      if (!daysMap.has(dateKey)) daysMap.set(dateKey, []);

      // Извлекаем реальное время прибытия из visitDate
      let arrivalTime = '10:00';
      if (p.visitDate && p.visitDate.includes('T')) {
        const timePart = p.visitDate.split('T')[1];
        if (timePart) {
          if (p.visitDate.includes('Z') || p.visitDate.includes('+')) {
            const d = new Date(p.visitDate);
            if (!isNaN(d.getTime())) {
              arrivalTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            }
          } else {
            arrivalTime = timePart.slice(0, 5);
          }
        }
      }
      const [ah, am] = arrivalTime.split(':').map(Number);
      const depMin = (ah ?? 10) * 60 + (am ?? 0) + 60;
      const departureTime = `${String(Math.floor(depMin / 60) % 24).padStart(2, '0')}:${String(depMin % 60).padStart(2, '0')}`;

      daysMap.get(dateKey)!.push({
        poi_id: p.id,
        order: p.order,
        estimated_cost: Number(p.budget) || 0,
        arrival_time: arrivalTime,
        departure_time: departureTime,
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

  private removeDuplicatePoi(items: FilteredPoi[]): FilteredPoi[] {
    const seenNames = new Set<string>();
    const uniqueItems: FilteredPoi[] = [];

    for (const item of items) {
      // Use a normalized version of the name and city for comparison to be more robust
      const normalizedName = item.name
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      if (!seenNames.has(normalizedName)) {
        seenNames.add(normalizedName);
        uniqueItems.push(item);
      }
    }

    return uniqueItems;
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
    await this.aiSessionsService.renameSession(
      sessionId,
      user.id,
      title.trim(),
    );
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
    const session = await this.aiSessionsService.getByIdForUser(
      sessionId,
      user.id,
    );
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (body.keep_last_plan) {
      const messages = session.messages || [];
      // Ищем последнее сообщение ассистента с планом
      const lastPlanIdx = [...messages]
        .reverse()
        .findIndex(
          (m) =>
            m.role === 'assistant' &&
            (m.route_plan || m.content.includes('"days":')),
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
    @Body() dto: { trip_id?: string; title?: string },
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
      title: dto.title,
    });

    return {
      session_id: session.id,
      trip_id: session.tripId,
      created_at: session.createdAt,
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
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

    // Guard Layer: Deduplication
    const lastUserMessage = [...history]
      .reverse()
      .find((m) => m.role === 'user');
    if (
      lastUserMessage &&
      lastUserMessage.content.trim() === dto.user_query.trim()
    ) {
      this.logger.warn(
        `Duplicate message detected for session ${session.id}: "${dto.user_query}"`,
      );
      // Optionally, we could just return the last plan. Here we throw to avoid re-running the heavy pipeline.
      throw new UnprocessableEntityException({
        code: 'DUPLICATE_MESSAGE',
        message: 'Похоже, вы только что отправили этот же запрос.',
        session_id: session.id,
      });
    }

    const llmContext = history.slice(-10);
    const orchestratorStart = Date.now();
    const existingRoutePlan = this.extractCurrentRoutePlan(history);
    const mutationMeta: {
      mutation_applied?: boolean;
      mutation_type?: IntentRouterActionType;
      mutation_fallback_reason?: string;
    } = {
      mutation_applied: false,
    };

    // Derive context from existingRoutePlan (authoritative DB state — never guess)
    const currentRoutePois = existingRoutePlan
      ? existingRoutePlan.days.flatMap((day) =>
          day.points.map((point) => ({
            poi_id: point.poi_id,
            title: point.poi?.name ?? null,
          })),
        )
      : [];
    const hasRoute =
      !!existingRoutePlan &&
      existingRoutePlan.days.some((d) => d.points?.length > 0);

    const intentRouterCtx = {
      has_existing_route: hasRoute,
      current_poi_count: currentRoutePois.length,
      current_city: existingRoutePlan?.city ?? null,
      current_pois: currentRoutePois,
    };
    this.logger.log(
      `IntentRouter context: hasRoute=${hasRoute}, pois=${currentRoutePois.length}, city=${intentRouterCtx.current_city}`,
    );

    let intentRouterDecision: IntentRouterDecision =
      await this.intentRouterService.route(
        dto.user_query,
        llmContext,
        intentRouterCtx,
      );
    this.logger.log(
      `Intent router decision: ${JSON.stringify(intentRouterDecision)}`,
    );

    // 🛡️ GUARDRAIL A: route exists but LLM returned NEW_ROUTE
    if (hasRoute && intentRouterDecision.action_type === 'NEW_ROUTE') {
      const isExplicitReset =
        /заново|с нуля|сбрось|перестрой полностью|начни заново/i.test(
          dto.user_query,
        );
      if (!isExplicitReset) {
        this.logger.warn(
          `[GUARDRAIL] NEW_ROUTE overridden → ADD_POI (route exists, query="${dto.user_query}")`,
        );
        intentRouterDecision = {
          ...intentRouterDecision,
          action_type: 'ADD_POI',
          route_mode: 'targeted_mutation',
        };
      }
    }

    // 🛡️ GUARDRAIL B: no route but LLM returned targeted_mutation
    if (!hasRoute && intentRouterDecision.route_mode === 'targeted_mutation') {
      this.logger.warn(
        `[GUARDRAIL] targeted_mutation overridden → NEW_ROUTE (no route exists, query="${dto.user_query}")`,
      );
      intentRouterDecision = {
        ...intentRouterDecision,
        action_type: 'NEW_ROUTE',
        route_mode: 'full_rebuild',
      };
    }

    // Guard Layer: Anti-Spam
    if (intentRouterDecision.fallback_reason === 'SPAM_BLOCKED') {
      throw new UnprocessableEntityException({
        code: 'SPAM_BLOCKED',
        message: 'Сообщение заблокировано системой безопасности.',
        session_id: session.id,
      });
    }

    // ── Smart reclassification: last-resort override for actionable requests ──
    // Intent router already applies overrideTravelChatIfActionable(), but this is
    // an extra safety net in the controller. If a request is clearly actionable
    // (add/remove/replace/budget) and somehow still reached TRAVEL_CHAT, redirect
    // it to the mutation pipeline.
    if (intentRouterDecision.action_type === 'TRAVEL_CHAT') {
      const hasRoute = existingRoutePlan?.days?.some(
        (d) => d.points?.length > 0,
      );
      if (hasRoute) {
        const q = dto.user_query.toLowerCase();
        const isAdd = /добав[ьи]|включи|добавить/.test(q);
        const isCheaper = /дешевле|снизь.*бюджет|бюджет.*сниз/.test(q);
        const isBoring = /(удали|убери)\s*(скучн|неинтересн)/.test(q);
        const isAddCategory =
          /больше\s+(музе|рестора|кафе|парк|бар|театр|галере)/.test(q);
        if (isAddCategory) {
          intentRouterDecision = {
            ...intentRouterDecision,
            action_type: 'ADD_CATEGORY',
            route_mode: 'targeted_mutation',
          };
        } else if (isAdd) {
          intentRouterDecision = {
            ...intentRouterDecision,
            action_type: 'ADD_POI',
            route_mode: 'targeted_mutation',
          };
        } else if (isCheaper) {
          intentRouterDecision = {
            ...intentRouterDecision,
            action_type: 'REDUCE_BUDGET',
            route_mode: 'targeted_mutation',
          };
        } else if (isBoring) {
          intentRouterDecision = {
            ...intentRouterDecision,
            action_type: 'REMOVE_BORING',
            route_mode: 'targeted_mutation',
          };
        }
      }
    }

    // Guard Layer: Conversational travel mode (TRAVEL_CHAT)
    if (intentRouterDecision.action_type === 'TRAVEL_CHAT') {
      this.eventsService.emitAiThinking(
        session.tripId,
        session.id,
        'chat',
        user.id,
      );

      // Route restoration: undo to previous state when user asks to restore / undo.
      // Works both when route is empty (full deletion) AND when route has points (partial undo).
      const restorePattern =
        /верни|восстанови|откат|отмени|назад|вернуть|отменить|undo/i;
      if (restorePattern.test(dto.user_query)) {
        const hasNoCurrentRoute =
          !existingRoutePlan ||
          !existingRoutePlan.days?.some((d) => d.points?.length > 0);

        // Collect all non-empty route plans from history (newest first)
        const allPlans = [...history]
          .reverse()
          .map((msg) => this.tryParseRoutePlan(msg))
          .filter(
            (plan): plan is RoutePlan =>
              !!plan && plan.days?.some((d) => d.points?.length > 0),
          );

        // If route is empty → restore the most recent plan.
        // If route exists → skip the current plan (allPlans[0]) and restore the PREVIOUS one.
        const previousPlan = hasNoCurrentRoute ? allPlans[0] : allPlans[1];

        if (previousPlan) {
          const restoredMessages: SessionMessage[] = [
            ...history,
            { role: 'user' as const, content: dto.user_query },
            {
              role: 'assistant' as const,
              content: 'Готово, вернул предыдущую версию маршрута.',
              route_plan: previousPlan,
            },
          ];
          await this.aiSessionsService.saveMessages(
            session.id,
            restoredMessages,
          );
          if (session.tripId) {
            this.eventsService.emitTripRefresh(session.tripId);
            this.eventsService.emitAiUpdate(session.tripId, session.id);
          }
          return {
            session_id: session.id,
            route_plan: previousPlan,
            meta: {
              parsed_intent: null,
              steps_duration_ms: {
                orchestrator: 0,
                yandex_fetch: 0,
                semantic_filter: 0,
                scheduler: 0,
                total: 0,
              },
              poi_counts: {
                yandex_raw: 0,
                after_logical_selector: 0,
                after_semantic: 0,
              },
              fallbacks_triggered: [],
              mutation_type: 'TRAVEL_CHAT',
              mutation_applied: true,
            },
          };
        }
      }

      // If there's an existing route, try to interpret the request as a free-form route edit.
      // This handles cases like "сделай поспортивнее", "убери скучное", "поставь музей первым" etc.
      if (
        existingRoutePlan &&
        existingRoutePlan.days?.some((d) => d.points?.length > 0)
      ) {
        const modifyResult = await this.travelChatService.modifyRoute(
          dto.user_query,
          existingRoutePlan,
        );

        if (modifyResult.type === 'modify') {
          const modifiedPlan = this.travelChatService.reconstructPlan(
            existingRoutePlan,
            modifyResult.days,
          );

          const newMessages: SessionMessage[] = [
            ...history,
            { role: 'user' as const, content: dto.user_query },
            {
              role: 'assistant' as const,
              content: modifyResult.message,
              route_plan: modifiedPlan,
            },
          ];

          await this.aiSessionsService.saveMessages(session.id, newMessages);

          if (session.tripId) {
            this.eventsService.emitTripRefresh(session.tripId);
            this.eventsService.emitAiUpdate(session.tripId, session.id);
          }

          return {
            session_id: session.id,
            route_plan: modifiedPlan,
            meta: {
              parsed_intent: null,
              steps_duration_ms: {
                orchestrator: 0,
                yandex_fetch: 0,
                semantic_filter: 0,
                scheduler: 0,
                total: 0,
              },
              poi_counts: {
                yandex_raw: 0,
                after_logical_selector: 0,
                after_semantic: 0,
              },
              fallbacks_triggered: [],
              mutation_type: 'TRAVEL_CHAT',
              mutation_applied: true,
            },
          };
        }

        // LLM said 'chat' — modifyRoute can't handle this request → text response
        const travelChatMessages: SessionMessage[] = [
          ...history,
          { role: 'user' as const, content: dto.user_query },
          { role: 'assistant' as const, content: modifyResult.message },
        ];
        await this.aiSessionsService.saveMessages(
          session.id,
          travelChatMessages,
        );
        throw new UnprocessableEntityException({
          code: 'TRAVEL_CHAT',
          message: modifyResult.message,
          session_id: session.id,
        });
      }

      // No existing route — pure conversation to gather route parameters
      const routeContext = existingRoutePlan
        ? {
            city: existingRoutePlan.city,
            days: existingRoutePlan.days?.length,
            pointCount: existingRoutePlan.days?.reduce(
              (s, d) => s + (d.points?.length ?? 0),
              0,
            ),
          }
        : undefined;

      const chatResponse = await this.travelChatService.generateResponse(
        dto.user_query,
        history,
        routeContext,
      );

      const travelChatMessages: SessionMessage[] = [
        ...history,
        { role: 'user' as const, content: dto.user_query },
        { role: 'assistant' as const, content: chatResponse },
      ];

      await this.aiSessionsService.saveMessages(session.id, travelChatMessages);

      throw new UnprocessableEntityException({
        code: 'TRAVEL_CHAT',
        message: chatResponse,
        session_id: session.id,
      });
    }

    // Guard Layer: Off-topic / Small talk / Spam
    if (
      intentRouterDecision.action_type === 'OFF_TOPIC' ||
      intentRouterDecision.action_type === 'SMALL_TALK'
    ) {
      // Generate contextual message based on fallback reason and action type
      let fallbackMsg: string;

      // @ts-ignore - fallback_reason includes SEMANTIC_SPAM_BLOCKED but TS has type checking issues
      const fbReason = intentRouterDecision.fallback_reason;

      if (fbReason === 'SEMANTIC_SPAM_BLOCKED') {
        fallbackMsg =
          'Похоже, ты отправил очень похожий запрос несколько раз. Дай мне новый вопрос о маршруте! 😊';
      } else if (fbReason === 'SPAM_BLOCKED') {
        fallbackMsg =
          'Твой запрос похож на спам. Напиши нормальный вопрос о путешествии или маршруте. 🙂';
      } else if (intentRouterDecision.action_type === 'SMALL_TALK') {
        fallbackMsg =
          'Я помощник для планирования маршрутов и путешествий. Давай спланируем твоё путешествие! Например, спроси про маршрут на 3 дня в Казани или найди кафе в городе. 🙂';
      } else {
        fallbackMsg =
          'Я помогаю с планированием маршрутов и поездок. Можешь уточнить, в каком городе ты хочешь маршрут или какие места найти? 🙂';
      }

      const clarificationMessages: SessionMessage[] = [
        ...history,
        { role: 'user' as const, content: dto.user_query },
        {
          role: 'assistant' as const,
          content: fallbackMsg,
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
        code: 'OFF_TOPIC',
        message: fallbackMsg,
        is_out_of_scope: true,
        fallback_reason: intentRouterDecision.fallback_reason || 'UNKNOWN',
        session_id: session.id,
      });
    }

    let intent: ParsedIntent = null as any;
    try {
      intent = await this.orchestratorService.parseIntent(
        dto.user_query,
        llmContext,
      );
    } catch (error) {
      if (!this.isLocationError(error)) {
        throw error;
      }

      // Если есть существующий маршрут — берём город из него и повторяем парсинг.
      // Это позволяет "добавь ещё три точки" / "удали скучное" работать без указания города.
      const existingCity = existingRoutePlan?.city;
      if (existingCity) {
        this.logger.log(
          `NEED_CITY fallback: retrying with city="${existingCity}" from existing route`,
        );
        try {
          intent = await this.orchestratorService.parseIntent(
            `${dto.user_query} (город: ${existingCity})`,
            llmContext,
          );
        } catch {
          // Если и с городом не распарсилось — падаем ниже в стандартную ошибку
          intent = null as any;
        }
        if (intent?.city) {
          // Успешно распарсили с подсказкой города — продолжаем
        } else {
          intent = null as any;
        }
      }

      if (!intent?.city) {
        const errorResponse = (
          error as UnprocessableEntityException
        ).getResponse() as any;
        const clarificationMsg = errorResponse.message || this.needCityMessage;

        const clarificationMessages: SessionMessage[] = [
          ...history,
          { role: 'user' as const, content: dto.user_query },
          { role: 'assistant' as const, content: clarificationMsg },
        ];

        await this.aiSessionsService.saveMessages(
          session.id,
          clarificationMessages,
        );

        if (session.tripId) {
          this.eventsService.emitTripRefresh(session.tripId);
        }

        throw new UnprocessableEntityException({
          code: errorResponse.code || 'NEED_CITY',
          message: clarificationMsg,
          session_id: session.id,
        });
      }
    }

    if (!intent.city) {
      // TRI-106 / MERGE-GUARD
      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message: this.needCityMessage,
      });
    }

    const hasMultipleCitiesInArray = intent.cities && intent.cities.length > 1;
    const hasDifferentFromAndTo =
      intent.city_from && intent.city_to && intent.city_from !== intent.city_to;

    if (hasMultipleCitiesInArray || hasDifferentFromAndTo) {
      const multiCityMessage =
        'Я могу построить маршрут по местам в рамках одного города. Пожалуйста, укажите его название.';
      const clarificationMessages: SessionMessage[] = [
        ...history,
        { role: 'user' as const, content: dto.user_query },
        {
          role: 'assistant' as const,
          content: multiCityMessage,
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
        code: 'MULTI_CITY_NOT_SUPPORTED',
        message: multiCityMessage,
        session_id: session.id,
      });
    }

    const orchestratorDuration = Date.now() - orchestratorStart;
    const plannerVersion: PlannerVersion = 'v2';
    const policySnapshot: PolicySnapshot =
      this.policyService.calculatePolicySnapshot(intent, llmContext, 'v2');

    const providerStart = Date.now();
    const fallbacks: string[] = [];

    // Если нужно просто удалить точку, нам не нужно искать новые (Kudago, Overpass, Yandex).
    const skipSearch = intentRouterDecision.action_type === 'REMOVE_POI';

    const rawPoi: any[] = [];
    let providerDuration = 0;
    let massCollectionShadowMeta: MassCollectionShadowMeta | null = null;
    const vectorPrefilterShadowMeta: VectorPrefilterShadowMeta | null = null;
    const logicalIdShadowMeta: LogicalIdShadowMeta | null = null;
    let semanticDuration = 0;
    let selectedForScheduler: any[] = [];
    let yandexBatchRefinementDiagnostics: YandexBatchRefinementDiagnostics | null =
      null;
    const logicalSelectorResult: any = { selected_ids: [] };
    const logicalSelectedPool: any[] = [];
    const selected: any[] = [];
    const yandexPersonaSummary: string =
      policySnapshot.user_persona_summary ?? dto.user_query;

    if (!skipSearch) {
      /*
      const citiesToSearch =
        intent.cities && intent.cities.length > 0
          ? intent.cities
          : intent.city_to
            ? [intent.city_from || intent.city, intent.city_to]
            : [intent.city];
      */
      const citiesToSearch = [intent.city];

      const allStats: any[] = [];
      let totalBeforeDedup = 0;
      const allSuccessfullyGeocoded: FilteredPoi[] = [];

      // Progress: Stage 1 — searching all sources
      if (session.id) {
        this.eventsService.emitAiThinking(
          session.tripId,
          session.id,
          'collecting',
          user.id,
        );
      }

      const cityPromises = citiesToSearch.map(async (cityName) => {
        this.logger.log(`[PIPELINE] Starting city task: ${cityName}`);
        // Распределяем дни для поиска (для мульти-сити берем пропорционально)
        // const cityDays = Math.ceil(intent.days / citiesToSearch.length);
        const cityDays = intent.days;
        const cityIntent = { ...intent, city: cityName, days: cityDays };

        // 1. Provider Search
        const providerResult = await this.providerSearchService.fetchAndFilter(
          cityIntent,
          fallbacks,
        );
        const cityRawPois = providerResult.pois.map((p) => ({
          ...p,
          city_name: cityName,
        }));

        // 2. Vector Prefilter (Shadow)
        const personaSummary =
          policySnapshot.user_persona_summary ?? dto.user_query;
        await this.vectorPrefilterService.runShadowPrefilter(
          personaSummary,
          cityRawPois,
          this.resolveVectorTopK(),
        );

        // Progress: Stage 1.5 — diving into local data
        if (session.id) {
          this.eventsService.emitAiThinking(
            session.tripId,
            session.id,
            'hidden_gems',
            user.id,
          );
        }

        // 3. Logical Selection
        const reserveFactor = 3;
        const baseTarget = cityDays * 4;
        const logicalTarget = Math.min(
          Math.max(baseTarget * reserveFactor, 15),
          cityRawPois.length,
        );

        const logicalSelectorResult =
          await this.logicalIdSelectorService.selectIds({
            candidates: cityRawPois.map((poi) => ({
              id: poi.id,
              name: poi.name,
              category: poi.category,
            })),
            required_capacity: logicalTarget,
            food_policy: policySnapshot.food_policy,
          });
        const selectedIdSet = new Set(logicalSelectorResult.selected_ids);
        const logicalSelectedPool = cityRawPois.filter((poi) =>
          selectedIdSet.has(poi.id),
        );

        // Progress: Stage 2 — AI choosing top N
        if (session.id) {
          this.eventsService.emitAiThinking(
            session.tripId,
            session.id,
            'selecting',
            user.id,
          );
        }

        // 4. Semantic Selection
        const citySelected = await this.semanticFilterService.select(
          logicalSelectedPool,
          cityIntent,
          fallbacks,
        );

        // Progress: Stage 2.5 — validating coordinates
        if (session.id) {
          this.eventsService.emitAiThinking(
            session.tripId,
            session.id,
            'geocoding',
            user.id,
          );
        }

        // 5. Geocoding
        const geocodedResult =
          await this.geocodingFallbackService.geocodePointsWithFallback(
            citySelected.map((point) => ({
              id: point.id,
              name: point.name,
              coordinates: point.coordinates,
              city_name: cityName,
              isProtected: (point as any).isProtected,
            })),
            cityName,
          );

        const geocodedPois: FilteredPoi[] = [];
        for (const point of citySelected) {
          if (geocodedResult.coords.has(point.id)) {
            const coords = geocodedResult.coords.get(point.id)!;
            const geocodedPoi: FilteredPoi & { _geocodeConfirmed?: boolean } = {
              ...point,
              city_name: cityName,
              coordinates: {
                ...point.coordinates,
                lat: coords.lat,
                lon: coords.lon,
              },
            };
            if (geocodedResult.geocodedIds.has(point.id)) {
              geocodedPoi._geocodeConfirmed = true;
            }
            geocodedPois.push(geocodedPoi);
          }
        }

        return {
          cityName,
          rawPois: cityRawPois,
          geocodedPois,
          stats: providerResult.shadowDiagnostics,
        };
      });

      let cityResults;
      try {
        cityResults = await Promise.all(cityPromises);
      } catch (error) {
        if (!this.isLocationError(error)) {
          throw error;
        }

        const errorResponse = (
          error as UnprocessableEntityException
        ).getResponse() as any;
        const clarificationMsg = errorResponse.message || this.needCityMessage;

        const clarificationMessages: SessionMessage[] = [
          ...history,
          { role: 'user' as const, content: dto.user_query },
          {
            role: 'assistant' as const,
            content: clarificationMsg,
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
          code: errorResponse.code || 'NEED_CITY',
          message: clarificationMsg,
          session_id: session.id,
        });
      }

      for (const res of cityResults) {
        rawPoi.push(...res.rawPois);
        allSuccessfullyGeocoded.push(...res.geocodedPois);
        if (res.stats) {
          allStats.push(...res.stats.provider_stats);
          totalBeforeDedup += res.stats.totals.before_dedup;
        }
      }

      massCollectionShadowMeta = {
        provider_stats: allStats,
        totals: {
          before_dedup: totalBeforeDedup,
          after_dedup: rawPoi.length,
          returned: rawPoi.length,
        },
      };
      providerDuration = Date.now() - providerStart;

      const semanticStart = Date.now();
      // Dedup before refinement to avoid 3x same POI in batches
      const dedupedForRefinement = this.removeDuplicatePoi(
        allSuccessfullyGeocoded,
      );
      selectedForScheduler = dedupedForRefinement;

      // Progress: Stage 3 — enriching with YandexGPT scoring
      if (session.id) {
        this.eventsService.emitAiThinking(
          session.tripId,
          session.id,
          'enrichment',
          user.id,
        );
      }

      try {
        const refinementResult =
          await this.llmBatchRefinementService.refineSelectedInBatches(
            dedupedForRefinement,
            yandexPersonaSummary,
            { intent },
          );
        selectedForScheduler = refinementResult.refined;

        // Final coordinate safety check
        const initialCount = selectedForScheduler.length;
        const droppedPoiNames: string[] = [];

        const validPoints = selectedForScheduler.filter((point) => {
          const isValid =
            point.coordinates &&
            point.coordinates.lat !== undefined &&
            point.coordinates.lon !== undefined &&
            (Math.abs(point.coordinates.lat) > 0.001 ||
              Math.abs(point.coordinates.lon) > 0.001) &&
            !(point.coordinates.lat === 0 && point.coordinates.lon === 0);

          if (!isValid) {
            // Protected points (cross-source confirmed or OSM heritage tag) survive
            // zero-coord filtering — they are proven landmarks, not hallucinations.
            // Coordinates will be resolved by geocoding fallback downstream.
            if (point.isProtected) {
              this.logger.warn(
                `Protected point "${point.name}" has zero coords — keeping (will re-geocode)`,
              );
              return true;
            }
            if (point._geocodeConfirmed) {
              this.logger.warn(
                `Geocode-confirmed point "${point.name}" has zero/invalid coords — keeping`,
              );
              return true;
            }
            droppedPoiNames.push(point.name);
          }
          return isValid;
        });

        if (validPoints.length !== initialCount) {
          this.logger.log(
            `Filtered out ${initialCount - validPoints.length} points with invalid coordinates after refinement. Valid points: ${validPoints.length}. Dropped: ${droppedPoiNames.join(', ')}`,
          );
        }

        // Store dropped names in mutationMeta for the final assistant response (only for mutations)
        if (droppedPoiNames.length > 0) {
          (mutationMeta as any).dropped_poi_names = droppedPoiNames;
        }

        // Remove duplicates after refinement
        selectedForScheduler = this.removeDuplicatePoi(validPoints);

        this.logger.log(
          `Final POIs for Scheduler: ${selectedForScheduler.length}. Coords: ${selectedForScheduler.map((p) => `${p.name}(${p.coordinates?.lat},${p.coordinates?.lon})`).join(', ')}`,
        );

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

      semanticDuration = Date.now() - semanticStart;
    }

    const schedulerStart = Date.now();

    const finalCities =
      intent.cities && intent.cities.length > 0
        ? intent.cities
        : intent.city_to &&
            intent.city_from &&
            intent.city_from !== intent.city_to
          ? [intent.city_from, intent.city_to]
          : [intent.city || 'unknown'];

    const buildRoutePlanFromDays = (
      city: string,
      days: RoutePlan['days'],
    ): RoutePlan => ({
      city,
      cities: finalCities,
      route_type: intent.route_type,
      days,
      total_budget_estimated: days.reduce(
        (sum, day) => sum + (day.day_budget_estimated ?? 0),
        0,
      ),
    });

    let routePlan: RoutePlan;

    // Check for explicit "new route" keywords even if route exists
    const newRouteKeywords = [
      'новый маршрут',
      'перестроить',
      'заново',
      'с нуля',
      'весь маршрут',
      'полностью переделай',
    ];
    const queryLowerForNewRoute = dto.user_query.toLowerCase();
    const hasNewRouteKeywords = newRouteKeywords.some((kw) =>
      queryLowerForNewRoute.includes(kw),
    );

    // Check if route plan has become empty (all days/points deleted)
    const hasPointsInRoutePlan =
      existingRoutePlan &&
      existingRoutePlan.days.some((day) => day.points && day.points.length > 0);

    const isNewRouteRequested =
      intentRouterDecision.action_type === 'NEW_ROUTE' ||
      !hasPointsInRoutePlan ||
      hasNewRouteKeywords;

    if (isNewRouteRequested) {
      if (session.id) {
        this.eventsService.emitAiThinking(
          session.tripId,
          session.id,
          'scheduling',
          user.id,
        );
      }
      routePlan = this.schedulerService.buildPlan(
        selectedForScheduler,
        intent,
        session.id
          ? (day) =>
              this.eventsService.emitAiDayReady(
                session.tripId,
                session.id,
                day,
                user.id,
              )
          : undefined,
      );

      // TRI-115: Storytelling - анализируем город и генерируем объяснение
      try {
        const cityProfile = this.analyzer.analyze(rawPoi);
        const storytelling = await this.explainer.explainRoute(
          intent.cities && intent.cities.length > 1
            ? intent.cities.join(' - ')
            : intent.city,
          routePlan.days,
          cityProfile,
        );
        (mutationMeta as any).storytelling = storytelling;
      } catch (err) {
        this.logger.warn(`Storytelling failed: ${err}`);
      }
    } else {
      // Сохраняем старые точки для всех остальных типов действий (ADD_POI, REPLACE_POI, APPLY_GLOBAL_FILTER и т.д.)
      const oldPois = existingRoutePlan.days.flatMap((d) =>
        d.points.map((p) =>
          this.toFilteredPoi(p.poi, (p.poi as any).description),
        ),
      );

      const combinePool = (newPois: FilteredPoi[]): FilteredPoi[] => {
        // TRI-115-COORDS-PROTECTION: Фильтруем точки с некорректными координатами (напр. 0,0)
        // из любых источников (старый план из истории, новые точки).
        const filterInvalidCoords = (p: FilteredPoi) => {
          const lat = p.coordinates?.lat;
          const lon = p.coordinates?.lon;
          return (
            lat !== undefined &&
            lon !== undefined &&
            Number.isFinite(lat) &&
            Number.isFinite(lon) &&
            (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001)
          );
        };

        const combined = [...oldPois, ...newPois].filter(filterInvalidCoords);
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
            // Build context string for mutation parser (helps LLM identify which points to remove)
            const addTripContext = existingRoutePlan.days
              .map(
                (d) =>
                  `День ${d.day_number}:\n${d.points.map((p) => `  - "${p.poi?.name ?? ''}" (id: ${p.poi_id})`).join('\n')}`,
              )
              .join('\n\n');

            const addMutations = await this.mutationParser.parseMutations(
              dto.user_query,
              addTripContext,
            );
            const addPoiLimit = intent.poi_count_requested ?? 1;

            routePlan = await this.routeMutatorService.applyMutations(
              existingRoutePlan,
              addMutations,
              intent,
              selectedForScheduler.slice(0, addPoiLimit),
            );
            mutationMeta.mutation_applied = true;
            break;
          }

          case 'REMOVE_POSITIONAL': {
            // Deterministic positional delete — no LLM involved in counting
            const allPoiIds = existingRoutePlan.days.flatMap((d) =>
              d.points.map((p) => p.poi_id),
            );
            const total = allPoiIds.length;
            const n = Math.min(
              intentRouterDecision.positional_count ?? 1,
              total - 1, // always keep at least 1
            );
            const dir = intentRouterDecision.positional_direction ?? 'end';

            let keepIds: string[];
            if (dir === 'end') {
              keepIds = allPoiIds.slice(0, total - n);
            } else if (dir === 'start') {
              keepIds = allPoiIds.slice(n);
            } else if (dir === 'keep_start') {
              keepIds = allPoiIds.slice(0, n);
            } else {
              // keep_end
              keepIds = allPoiIds.slice(total - n);
            }

            const keepSet = new Set(keepIds);
            const filteredDays = existingRoutePlan.days
              .map((day) => ({
                day_number: day.day_number,
                poi_ids: day.points
                  .filter((p) => keepSet.has(p.poi_id))
                  .map((p) => p.poi_id),
              }))
              .filter((d) => d.poi_ids.length > 0);

            routePlan = this.travelChatService.reconstructPlan(
              existingRoutePlan,
              filteredDays,
            );
            mutationMeta.mutation_applied = true;
            mutationMeta.mutation_type = 'REMOVE_POSITIONAL';
            this.logger.log(
              `[REMOVE_POSITIONAL] dir=${dir} n=${n} total=${total} → kept ${keepIds.length}`,
            );
            break;
          }

          case 'REMOVE_POI': {
            // ── Clear-all detection ──────────────────────────────────────────
            // IMPORTANT: regex must require "маршрут/точки/места" after "все/всё" —
            // otherwise "убери все кафе" matches as clear-all and deletes the entire route.
            const clearAllKeywords =
              /удали\s+(весь\s+маршрут|все\s+(точки|места|маршрут)|всё)|убери\s+(весь\s+маршрут|все\s+(точки|места|маршрут)|всё)|очисти\s+(маршрут|всё)|сотри\s+(маршрут|всё)/i;
            // Safety: "удали все кафе/рестораны/музеи" is NOT clear-all — it's category removal.
            // If query mentions a category after "все/всё", it's NOT a full route deletion.
            const hasCategoryAfterAll =
              /все\s+(кафе|рестора|музе|памятник|парк|бар|театр|галере|церк|храм|собор|монумент|достопримечательн)/i.test(
                dto.user_query,
              );
            const isRemoveAll =
              !hasCategoryAfterAll &&
              (intentRouterDecision.target_poi_id === 'ALL' ||
                clearAllKeywords.test(dto.user_query));

            if (isRemoveAll) {
              routePlan = {
                ...existingRoutePlan,
                days: [],
                total_budget_estimated: 0,
              };
              mutationMeta.mutation_applied = true;
              mutationMeta.mutation_type = 'REMOVE_POI';
              break;
            }

            // Build context string for mutation parser
            const removeTripContext = existingRoutePlan.days
              .map(
                (d) =>
                  `День ${d.day_number}:\n${d.points.map((p) => `  - "${p.poi?.name ?? ''}" (id: ${p.poi_id})`).join('\n')}`,
              )
              .join('\n\n');

            const removeMutations = await this.mutationParser.parseMutations(
              dto.user_query,
              removeTripContext,
            );

            routePlan = await this.routeMutatorService.applyMutations(
              existingRoutePlan,
              removeMutations,
              intent,
              [], // no add candidates for pure remove
            );
            mutationMeta.mutation_applied = true;
            break;
          }

          case 'ADD_DAYS': {
            // intent.days может быть как дельтой ("добавь 2 дня" → 2),
            // так и итогом ("сделай 5 дней" → 5 при existingDays=3).
            // Если intent.days <= existingDays — это дельта, берём как есть.
            // Если intent.days > existingDays — считаем разницу.
            const existingDaysCount = existingRoutePlan.days.length;
            const rawDays = Math.max(1, intent.days);
            const daysToAdd =
              rawDays <= existingDaysCount
                ? rawDays
                : rawDays - existingDaysCount;
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
              await this.llmBatchRefinementService.chooseReplacementAlternative(
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

          case 'REDUCE_BUDGET': {
            // Replace expensive points with cheaper alternatives (same count of activities).
            // Priority: most expensive first, food venues (restaurant/cafe) prioritized.
            // Never delete points — only swap to cheaper same-or-similar category.

            const priceTier = (seg: string | undefined): number => {
              if (seg === 'free') return 0;
              if (seg === 'budget') return 1;
              if (seg === 'mid') return 2;
              if (seg === 'premium') return 3;
              return 1;
            };

            const isFoodCategory = (cat: string | undefined) =>
              cat === 'restaurant' || cat === 'cafe';

            const usedIdsForBudget = new Set(
              existingRoutePlan.days.flatMap((d) =>
                d.points.map((p) => p.poi_id),
              ),
            );

            // Collect paid points sorted: food first, then by cost desc
            const paidPoints = existingRoutePlan.days
              .flatMap((day, dayIdx) =>
                day.points.map((point, pointIdx) => ({
                  ...point,
                  dayIdx,
                  pointIdx,
                })),
              )
              .filter((p) => (p.estimated_cost ?? 0) > 0)
              .sort((a, b) => {
                const aFood = isFoodCategory((a.poi as any)?.category) ? 1 : 0;
                const bFood = isFoodCategory((b.poi as any)?.category) ? 1 : 0;
                if (bFood !== aFood) return bFood - aFood; // food first
                return (b.estimated_cost ?? 0) - (a.estimated_cost ?? 0); // then by cost desc
              });

            // Pool of cheaper alternatives not already in route
            const alternativePool = selectedForScheduler.filter(
              (poi) => !usedIdsForBudget.has(poi.id),
            );

            // Build replacements: for each paid point find a cheaper alternative
            const replacementMap = new Map<string, FilteredPoi>(); // poi_id → replacement FilteredPoi
            const assignedAltIds = new Set<string>();

            for (const point of paidPoints) {
              const currentPoi = point.poi as any;
              const currentTier = priceTier(currentPoi?.price_segment);
              const currentCategory = currentPoi?.category as
                | string
                | undefined;

              // 1st preference: same category, strictly cheaper tier
              // 2nd preference: any category, strictly cheaper tier
              const findCandidate = (sameCategoryOnly: boolean) =>
                alternativePool.find(
                  (poi) =>
                    !assignedAltIds.has(poi.id) &&
                    priceTier(poi.price_segment) < currentTier &&
                    (!sameCategoryOnly || poi.category === currentCategory),
                );

              const candidate = findCandidate(true) ?? findCandidate(false);

              if (candidate) {
                replacementMap.set(point.poi_id, candidate);
                assignedAltIds.add(candidate.id);
                usedIdsForBudget.add(candidate.id);
              }
            }

            if (replacementMap.size === 0) {
              // No cheaper alternatives found at all
              mutationMeta.mutation_fallback_reason = 'CANNOT_REDUCE_BUDGET';
              routePlan = existingRoutePlan;
              break;
            }

            // Apply replacements keeping time slots intact
            const rebuiltDays = existingRoutePlan.days.map((day) => {
              const newPoints = day.points.map((point) => {
                const alt = replacementMap.get(point.poi_id);
                if (!alt) return point;
                return {
                  ...point,
                  poi_id: alt.id,
                  poi: alt,
                  estimated_cost: 0, // free replacement
                };
              });

              return {
                ...day,
                points: newPoints,
                day_budget_estimated: newPoints.reduce(
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

          case 'ADD_CATEGORY': {
            // Extract category from query (e.g. "добавь больше музеев" → "museum")
            const queryLower = dto.user_query.toLowerCase();
            const categoryKeywords: Record<string, string> = {
              музе: 'museum',
              музей: 'museum',
              ресторан: 'restaurant',
              кафе: 'cafe',
              парк: 'park',
              магазин: 'shopping',
              развлечен: 'entertainment',
              аттракцион: 'attraction',
            };

            // Keywords to match in POI name/description for strict category validation
            const categoryNamePatterns: Record<string, RegExp> = {
              museum: /музе[йя]|выставка|галерея|экспозиция/i,
              restaurant: /ресторан|кухня|горячее|блюдо/i,
              cafe: /кафе|кофей|пирожное|булка/i,
              park: /парк|сквер|сад|аллея|роща/i,
              shopping: /магазин|лавка|бутик|торговля/i,
              entertainment: /развлечен|кино|театр|цирк|концерт/i,
              attraction: /аттракцион|качель|горка|каток/i,
            };

            let targetCategory = 'museum'; // Default fallback
            for (const [keyword, category] of Object.entries(
              categoryKeywords,
            )) {
              if (queryLower.includes(keyword)) {
                targetCategory = category as any;
                break;
              }
            }

            const usedPoiIds = new Set(
              existingRoutePlan.days.flatMap((day) =>
                day.points.map((point) => point.poi_id),
              ),
            );

            const namePattern = categoryNamePatterns[targetCategory];
            const candidatesToAdd = selectedForScheduler
              .filter(
                (poi) =>
                  !usedPoiIds.has(poi.id) &&
                  poi.category === targetCategory &&
                  // Strict name/description validation: must match category keywords
                  (namePattern.test(poi.name) ||
                    (poi.description && namePattern.test(poi.description))),
              )
              .slice(0, 3); // Add up to 3 new POIs

            if (candidatesToAdd.length === 0) {
              mutationMeta.mutation_fallback_reason = 'NO_CANDIDATES';
              fallbacks.push('ADD_CATEGORY_FALLBACK:NO_CANDIDATES');
              routePlan = existingRoutePlan;
              break;
            }

            // Inject new POIs into the existing plan
            routePlan = this.schedulerService.injectPoints(
              existingRoutePlan,
              candidatesToAdd,
              {
                ...intent,
                days: Math.max(intent.days, existingRoutePlan.days.length),
              },
            );
            mutationMeta.mutation_applied = true;
            break;
          }

          case 'REMOVE_BORING': {
            // Remove lowest-rated POIs from the route
            // Collect all points with their ratings
            const allDayPoints = existingRoutePlan.days.flatMap((day, dayIdx) =>
              day.points.map((point) => ({
                ...point,
                dayIdx,
                rating: (point.poi as any)?.rating ?? 0,
              })),
            );

            // Sort by rating ascending (lowest first)
            const pointsByRating = [...allDayPoints].sort(
              (a, b) => a.rating - b.rating,
            );

            // Remove bottom 30% lowest-rated points
            const removeCount = Math.max(
              1,
              Math.ceil(allDayPoints.length * 0.3),
            );
            const removePoiIds = new Set(
              pointsByRating.slice(0, removeCount).map((p) => p.poi_id),
            );

            const rebuiltDays = existingRoutePlan.days.map((day) => {
              const filteredPoints = day.points.filter(
                (point) => !removePoiIds.has(point.poi_id),
              );

              if (filteredPoints.length === 0) {
                return { ...day, points: [] };
              }

              // Reschedule remaining points
              let currentTime = this.schedulerService.timeToMinutes(
                day.day_start_time,
              );
              const rescheduledPoints = filteredPoints.map((point) => {
                const durationMinutes =
                  this.schedulerService.timeToMinutes(point.departure_time) -
                  this.schedulerService.timeToMinutes(point.arrival_time);
                const arrival =
                  this.schedulerService.minutesToTime(currentTime);
                const departure = this.schedulerService.minutesToTime(
                  currentTime + durationMinutes,
                );
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
              rebuiltDays.filter((d) => d.points.length > 0),
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

    // ── Fallback to TRAVEL_CHAT if mutation failed ────────────────────────────
    // Если стандартная мутация не смогла выполниться (точка не найдена, нет кандидатов и т.д.)
    // → передаём запрос в TRAVEL_CHAT для свободной обработки вместо показа ошибки.
    if (
      !mutationMeta.mutation_applied &&
      mutationMeta.mutation_fallback_reason &&
      existingRoutePlan &&
      existingRoutePlan.days?.some((d) => d.points?.length > 0)
    ) {
      this.logger.log(
        `Mutation failed (${mutationMeta.mutation_fallback_reason}), falling back to TRAVEL_CHAT`,
      );
      this.eventsService.emitAiThinking(
        session.tripId,
        session.id,
        'chat',
        user.id,
      );
      try {
        const modifyResult = await this.travelChatService.modifyRoute(
          dto.user_query,
          existingRoutePlan,
        );
        if (modifyResult.type === 'modify' && modifyResult.days.length > 0) {
          const modifiedPlan = this.travelChatService.reconstructPlan(
            existingRoutePlan,
            modifyResult.days,
          );
          const fallbackMessages: SessionMessage[] = [
            ...history,
            { role: 'user' as const, content: dto.user_query },
            {
              role: 'assistant' as const,
              content: modifyResult.message,
              route_plan: modifiedPlan,
            },
          ];
          await this.aiSessionsService.saveMessages(
            session.id,
            fallbackMessages,
          );
          if (session.tripId) {
            this.eventsService.emitTripRefresh(session.tripId);
            this.eventsService.emitAiUpdate(session.tripId, session.id);
          }
          return {
            session_id: session.id,
            route_plan: modifiedPlan,
            meta: {
              parsed_intent: null,
              steps_duration_ms: {
                orchestrator: 0,
                yandex_fetch: 0,
                semantic_filter: 0,
                scheduler: 0,
                total: 0,
              },
              poi_counts: {
                yandex_raw: 0,
                after_logical_selector: 0,
                after_semantic: 0,
              },
              fallbacks_triggered: [
                ...fallbacks,
                `MUTATION_FALLBACK_TO_TRAVEL_CHAT:${mutationMeta.mutation_fallback_reason}`,
              ],
              mutation_type: 'TRAVEL_CHAT',
              mutation_applied: true,
            },
          };
        }
        // type === 'chat' OR empty days → LLM не смог применить, покажем текстовый ответ
        const chatFallbackMessages: SessionMessage[] = [
          ...history,
          { role: 'user' as const, content: dto.user_query },
          { role: 'assistant' as const, content: modifyResult.message },
        ];
        await this.aiSessionsService.saveMessages(
          session.id,
          chatFallbackMessages,
        );
        throw new UnprocessableEntityException({
          code: 'TRAVEL_CHAT',
          message: modifyResult.message,
          session_id: session.id,
        });
      } catch (fallbackError) {
        if (fallbackError instanceof UnprocessableEntityException)
          throw fallbackError;
        this.logger.warn(
          `TRAVEL_CHAT fallback failed: ${String(fallbackError)}`,
        );
        // Продолжаем к стандартной обработке ошибки
      }
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

    if (mutationMeta.mutation_fallback_reason === 'CANNOT_REDUCE_BUDGET') {
      assistantMessages.push({
        role: 'assistant' as const,
        content:
          'Сделать маршрут дешевле не получится — среди доступных мест не нашлось более бюджетных вариантов той же категории. Попробуйте указать конкретные точки, которые хотите заменить.',
      });
    }

    const droppedPoiNames = (mutationMeta as any).dropped_poi_names as
      | string[]
      | undefined;
    const isSpecificMutation =
      intentRouterDecision.action_type === 'ADD_POI' ||
      intentRouterDecision.action_type === 'REPLACE_POI';

    if (isSpecificMutation && droppedPoiNames && droppedPoiNames.length > 0) {
      const warningText = `⚠️ К сожалению, мне не удалось найти точные координаты для: ${droppedPoiNames.join(', ')}. Эти точки не были добавлены.`;

      assistantMessages.push({
        role: 'assistant' as const,
        content: warningText,
      });
    }

    const statsSummary = massCollectionShadowMeta?.provider_stats
      .filter((s) => s.attempted)
      .map((s) => `${s.provider}: ${s.raw_count}`)
      .join(', ');

    const totalPointsGenerated = routePlan.days.flatMap((d) => d.points).length;
    let warningPrefix = '';
    if (
      totalPointsGenerated > 0 &&
      totalPointsGenerated < intent.days * 2 &&
      isNewRouteRequested
    ) {
      warningPrefix = `⚠️ В городе ${intent.city} мало известных мест, нашел только ${totalPointsGenerated}. Маршрут может быть короче.\n\n`;
    }

    const assistantContent =
      totalPointsGenerated === 0 && mutationMeta.mutation_applied
        ? 'Маршрут удален.'
        : statsSummary
          ? `${warningPrefix}Маршрут готов (Источники: ${statsSummary})`
          : `${warningPrefix}Маршрут готов`;

    assistantMessages.push({
      role: 'assistant' as const,
      content: assistantContent,
      route_plan: routePlan,
    });

    const newMessages: SessionMessage[] = [...history, ...assistantMessages];

    await this.aiSessionsService.saveMessages(session.id, newMessages);

    this.logger.log(
      `Final plan for ${intent.city}: ${routePlan.days.flatMap((d) => d.points).length} points.`,
    );
    routePlan.days.forEach((d) => {
      this.logger.log(
        `  === День ${d.day_number} (${d.date || 'без даты'}) ===`,
      );
      d.points.forEach((p) => {
        this.logger.log(
          `    [POINT] ${p.poi.name}: ${p.poi.coordinates?.lat}, ${p.poi.coordinates?.lon}`,
        );
      });
    });

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
          arrivalTime: string;
        }
      >
    >();
    if (points.length === 0) {
      dateMap.set(new Date().toISOString().split('T')[0], []);
    } else {
      points.forEach((point) => {
        // Извлекаем только дату (без времени) для группировки по дням
        const rawDate =
          point.visitDate || new Date().toISOString().split('T')[0];
        const date = rawDate.includes('T') ? rawDate.split('T')[0] : rawDate;
        const bucket = dateMap.get(date) ?? [];
        const description =
          enriched.find((item) => item.title === point.title)?.description ??
          `Интересное место: ${point.title}.`;

        // Извлекаем время прибытия из visitDate (формат "2026-03-20T10:00:00" или "2026-03-20T07:00:00.000Z")
        let arrivalTime = '10:00';
        if (point.visitDate && point.visitDate.includes('T')) {
          const timePart = point.visitDate.split('T')[1];
          if (timePart) {
            // Если строка содержит Z (UTC) — парсим через Date для получения локального времени
            if (
              point.visitDate.includes('Z') ||
              point.visitDate.includes('+')
            ) {
              const d = new Date(point.visitDate);
              if (!isNaN(d.getTime())) {
                arrivalTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
              }
            } else {
              // Локальное время без таймзоны — берём как есть
              arrivalTime = timePart.slice(0, 5);
            }
          }
        }

        bucket.push({
          id: point.id,
          title: point.title,
          address: point.address,
          description,
          order: point.order,
          budget: typeof point.budget === 'number' ? point.budget : 0,
          lat: point.lat,
          lon: point.lon,
          arrivalTime,
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
          .map((point) => {
            // Вычисляем departure_time: arrival + 90 мин
            const [ah, am] = (point.arrivalTime ?? '10:00')
              .split(':')
              .map(Number);
            const depMin = (ah ?? 10) * 60 + (am ?? 0) + 90;
            const depTime = `${String(Math.floor(depMin / 60) % 24).padStart(2, '0')}:${String(depMin % 60).padStart(2, '0')}`;
            return {
              poi_id: point.id,
              order: point.order,
              arrival_time: point.arrivalTime ?? '10:00',
              departure_time: depTime,
              visit_duration_min: 90,
              estimated_cost: point.budget || 0,
              poi: {
                id: point.id,
                name: point.title,
                address: point.address ?? 'Адрес не указан',
                description: point.description,
                coordinates: { lat: point.lat ?? 0, lon: point.lon ?? 0 },
                category: 'attraction' as const,
                score: 0.5,
              },
            };
          }),
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

    const currentTitles = new Set(
      points.map((p) => p.title.toLowerCase().trim()),
    );
    const lastTitles = new Set(
      (lastRoutePlan?.days ?? [])
        .flatMap((d) => d.points)
        .map((p) => (p.poi?.name ?? '').toLowerCase().trim()),
    );
    const routeChanged =
      currentTitles.size !== lastTitles.size ||
      [...currentTitles].some((t) => !lastTitles.has(t));

    // TRI-104: синхронизируем сессию с конструктором ТОЛЬКО если маршрут реально изменился.
    // Если маршрут не менялся — не трогаем сессию, чтобы сохранить оригинальные AI-сгенерированные времена.
    if (routeChanged) {
      await this.aiSessionsService.replaceMessagesWithRoutePlan(
        session.id,
        routePlan,
      );
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
        error:
          'No POI found for query. For foreign cities, check Overpass API status.',
        city: intent.city || 'unknown',
        query,
        input_poi_count: 0,
      };
    }

    const comparison = await this.semanticFilterService.compareProviders(
      pois,
      intent,
    );

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
  async testLlmOnly(@Body() body: { query: string }) {
    const { query } = body;
    const intent = await this.orchestratorService.parseIntent(query, []);

    const t0 = Date.now();
    const pois =
      await this.semanticFilterService.generatePoiFromScratch(intent);
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
  async testProviderOnly(@Body() body: { query: string }) {
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
  async testHybrid(@Body() body: { query: string }) {
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
      const llmPois = await this.semanticFilterService.select(
        pois,
        intent,
        fallbacks,
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

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('mutations/parse')
  async parseMutations(@Body() body: { query: string; tripContext?: string }) {
    return this.mutationParser.parseMutations(body.query, body.tripContext);
  }

  @Throttle({ default: { limit: 20, ttl: 60000 } })
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
      const session = await this.aiSessionsService.getByIdForUser(
        body.sessionId,
        user.id,
      );
      const lastRoutePlan = session
        ? this.extractCurrentRoutePlan(session.messages)
        : null;

      if (lastRoutePlan) {
        this.logger.log(
          `[MUTATION] chat-only: routing through RouteMutatorService (${body.mutations.map((m: any) => m.type).join(', ')})`,
        );

        // Single pipeline call — replaces 150 lines of manual parsing
        const updatedRoutePlan = await this.routeMutatorService.applyMutations(
          lastRoutePlan,
          body.mutations,
          { city: lastRoutePlan.city } as any, // minimal intent — city is enough for POI lookup
          [], // no pre-fetched candidates in this context
        );

        const isEmpty =
          updatedRoutePlan.days.length === 0 ||
          updatedRoutePlan.days.every((d) => d.points.length === 0);
        const messageContent = isEmpty ? 'Маршрут удален.' : 'Я обновил маршрут.';

        if (isEmpty) {
          const messagesWithoutRoutePlan = (session?.messages ?? []).map(
            (msg) => ({ ...msg, route_plan: undefined }),
          );
          await this.aiSessionsService.saveMessages(
            body.sessionId,
            messagesWithoutRoutePlan,
          );
          await this.aiSessionsService.appendMessages(body.sessionId, [
            { role: 'assistant', content: messageContent },
          ]);
          return { success: true, route_plan: undefined, points: [], version: 0 };
        }

        await this.aiSessionsService.appendMessages(body.sessionId, [
          { role: 'assistant', content: messageContent, route_plan: updatedRoutePlan },
        ]);

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
      const messageContent =
        result.points.length === 0 ? 'Маршрут удален.' : 'Я обновил маршрут.';

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
      // Берём city из последнего route_plan сессии, иначе fallback на trip.title
      let planCity = (trip as any)?.title || 'Маршрут';
      if (body.sessionId) {
        const session = await this.aiSessionsService.getByIdForUser(
          body.sessionId,
          user.id,
        );
        const existingPlan = session
          ? this.extractCurrentRoutePlan(session.messages)
          : null;
        if (existingPlan?.city) planCity = existingPlan.city;
      }
      const routePlan = this.buildRoutePlanFromPoints(planCity, result.points);

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

  /**
   * Admin: invalidate POI pool cache for a specific city and immediately re-warm it.
   * Use via Swagger or curl when a city's data becomes stale.
   * Example: POST /ai/cache/flush  { "city": "Сочи" }
   */
  @Post('cache/flush')
  async flushCityCache(@Body('city') city: string) {
    if (!city || typeof city !== 'string' || !city.trim()) {
      throw new BadRequestException('city is required');
    }
    return this.cacheWarmup.flushCity(city.trim());
  }
}
