import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Logger,
  Post,
  BadRequestException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiSessionsService } from './ai-sessions.service';
import { AiPlanRequestDto } from './dto/ai-plan-request.dto';
import { InputSanitizerPipe } from './pipes/input-sanitizer.pipe';
import { OrchestratorService } from './pipeline/orchestrator.service';
import { ProviderSearchService } from './pipeline/provider-search.service';
import { SchedulerService } from './pipeline/scheduler.service';
import { SemanticFilterService } from './pipeline/semantic-filter.service';
import type { SessionMessage } from './types/pipeline.types';
import type { RoutePlan } from './types/pipeline.types';
import { TripsService } from '../trips/trips.service';
import { PointsService } from '../points/points.service';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger('AI_PIPELINE');

  private readonly needCityMessage =
    'Недостаточно данных для построения маршрута. Укажите, пожалуйста, город.';

  constructor(
    private readonly aiSessionsService: AiSessionsService,
    private readonly tripsService: TripsService,
    private readonly pointsService: PointsService,
    private readonly orchestratorService: OrchestratorService,
    private readonly providerSearchService: ProviderSearchService,
    private readonly semanticFilterService: SemanticFilterService,
    private readonly schedulerService: SchedulerService,
  ) {}

  private isNeedCityError(error: unknown): boolean {
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

    let intent;
    try {
      intent = await this.orchestratorService.parseIntent(
        dto.user_query,
        llmContext,
      );
    } catch (error) {
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

    const providerStart = Date.now();
    const fallbacks: string[] = [];
    const rawPoi = await this.providerSearchService.fetchAndFilter(
      intent,
      fallbacks,
    );
    const providerDuration = Date.now() - providerStart;

    const semanticStart = Date.now();
    const filteredPoi = await this.semanticFilterService.select(
      rawPoi,
      intent,
      fallbacks,
    );
    const semanticDuration = Date.now() - semanticStart;

    const schedulerStart = Date.now();
    const routePlan = this.schedulerService.buildPlan(filteredPoi, intent);
    const schedulerDuration = Date.now() - schedulerStart;

    const newMessages: SessionMessage[] = [
      ...history,
      { role: 'user' as const, content: dto.user_query },
      { role: 'assistant' as const, content: JSON.stringify(routePlan) },
    ];

    await this.aiSessionsService.saveMessages(session.id, newMessages);

    if (!intent.city) {
      throw new UnprocessableEntityException({
        code: 'NEED_CITY',
        message: this.needCityMessage,
      });
    }

    return {
      session_id: session.id,
      route_plan: routePlan,
      meta: {
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
          after_semantic: filteredPoi.length,
        },
        fallbacks_triggered: fallbacks,
      },
    };
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
