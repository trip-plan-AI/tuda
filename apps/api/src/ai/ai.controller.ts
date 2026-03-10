import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Logger,
  Post,
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

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger('AI_PIPELINE');

  constructor(
    private readonly aiSessionsService: AiSessionsService,
    private readonly orchestratorService: OrchestratorService,
    private readonly providerSearchService: ProviderSearchService,
    private readonly semanticFilterService: SemanticFilterService,
    private readonly schedulerService: SchedulerService,
  ) {}

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
    const intent = await this.orchestratorService.parseIntent(
      dto.user_query,
      llmContext,
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
    ];

    await this.aiSessionsService.saveMessages(session.id, newMessages);

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
}
