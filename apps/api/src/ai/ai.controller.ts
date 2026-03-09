import {
  Body,
  Controller,
  Inject,
  Logger,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import { AiPlanRequestDto } from './dto/ai-plan-request.dto';
import { InputSanitizerPipe } from './pipes/input-sanitizer.pipe';
import { OrchestratorService } from './pipeline/orchestrator.service';
import { ProviderSearchService } from './pipeline/provider-search.service';
import { SchedulerService } from './pipeline/scheduler.service';
import { SemanticFilterService } from './pipeline/semantic-filter.service';
import type { SessionMessage } from './types/pipeline.types';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger('AI_PIPELINE');

  constructor(
    @Inject(DRIZZLE)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly orchestratorService: OrchestratorService,
    private readonly providerSearchService: ProviderSearchService,
    private readonly semanticFilterService: SemanticFilterService,
    private readonly schedulerService: SchedulerService,
  ) {}

  @Post('plan')
  async plan(
    @Body(InputSanitizerPipe) dto: AiPlanRequestDto,
    @CurrentUser() user: { id: string },
  ) {
    const session = await this.getOrCreateSession(dto.trip_id, user.id);
    const history = session.messages;
    const orchestratorStart = Date.now();
    const intent = await this.orchestratorService.parseIntent(
      dto.user_query,
      history,
    );
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
    ].slice(-10);

    await this.saveSession(session.id, newMessages);

    if (!intent.city) {
      throw new UnprocessableEntityException(
        'Could not parse city from request',
      );
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

  private async getOrCreateSession(tripId: string | undefined, userId: string) {
    const existing = await this.db.query.aiSessions.findFirst({
      where: tripId
        ? and(
            eq(schema.aiSessions.userId, userId),
            eq(schema.aiSessions.tripId, tripId),
          )
        : and(
            eq(schema.aiSessions.userId, userId),
            isNull(schema.aiSessions.tripId),
          ),
    });

    if (existing) {
      return {
        id: existing.id,
        messages: this.normalizeMessages(existing.messages),
      };
    }

    const [created] = await this.db
      .insert(schema.aiSessions)
      .values({
        userId,
        tripId: tripId ?? null,
        messages: [],
      })
      .returning();

    return {
      id: created.id,
      messages: [] as SessionMessage[],
    };
  }

  private async saveSession(sessionId: string, messages: SessionMessage[]) {
    await this.db
      .update(schema.aiSessions)
      .set({ messages })
      .where(eq(schema.aiSessions.id, sessionId));
  }

  private normalizeMessages(raw: unknown): SessionMessage[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(
        (item): item is SessionMessage =>
          !!item &&
          typeof item === 'object' &&
          'role' in item &&
          'content' in item &&
          ((item as { role?: unknown }).role === 'user' ||
            (item as { role?: unknown }).role === 'assistant') &&
          typeof (item as { content?: unknown }).content === 'string',
      )
      .slice(-10);
  }
}
