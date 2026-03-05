import {
  Body,
  Controller,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiPlanRequestDto } from './dto/ai-plan-request.dto';
import { InputSanitizerPipe } from './pipes/input-sanitizer.pipe';
import { OrchestratorService } from './pipeline/orchestrator.service';
import { SemanticFilterService } from './pipeline/semantic-filter.service';
import { YandexFetchService } from './pipeline/yandex-fetch.service';
import type { SessionMessage } from './types/pipeline.types';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly yandexFetchService: YandexFetchService,
    private readonly semanticFilterService: SemanticFilterService,
  ) {}

  @Post('plan')
  async plan(
    @Body(InputSanitizerPipe) dto: AiPlanRequestDto,
    @CurrentUser() _user: { id: string },
  ) {
    const history: SessionMessage[] = [];
    const orchestratorStart = Date.now();
    const intent = await this.orchestratorService.parseIntent(
      dto.user_query,
      history,
    );
    const orchestratorDuration = Date.now() - orchestratorStart;

    const yandexStart = Date.now();
    const rawPoi = await this.yandexFetchService.fetchAndFilter(intent);
    const yandexDuration = Date.now() - yandexStart;

    const fallbacks: string[] = [];
    const semanticStart = Date.now();
    const filteredPoi = await this.semanticFilterService.select(
      rawPoi,
      intent,
      fallbacks,
    );
    const semanticDuration = Date.now() - semanticStart;

    if (!intent.city) {
      throw new UnprocessableEntityException(
        'Could not parse city from request',
      );
    }

    return {
      session_id: dto.trip_id ?? null,
      route_plan: null,
      meta: {
        parsed_intent: intent,
        steps_duration_ms: {
          orchestrator: orchestratorDuration,
          yandex_fetch: yandexDuration,
          semantic_filter: semanticDuration,
          total: orchestratorDuration + yandexDuration + semanticDuration,
        },
        poi_counts: {
          yandex_raw: rawPoi.length,
          after_semantic: filteredPoi.length,
        },
        fallbacks_triggered: fallbacks,
      },
    };
  }
}
