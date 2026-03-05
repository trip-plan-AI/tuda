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
import type { SessionMessage } from './types/pipeline.types';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly orchestratorService: OrchestratorService) {}

  @Post('plan')
  async plan(
    @Body(InputSanitizerPipe) dto: AiPlanRequestDto,
    @CurrentUser() _user: { id: string },
  ) {
    const history: SessionMessage[] = [];
    const intent = await this.orchestratorService.parseIntent(
      dto.user_query,
      history,
    );

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
          orchestrator: 0,
          total: 0,
        },
        poi_counts: {
          yandex_raw: 0,
          after_semantic: 0,
        },
        fallbacks_triggered: [],
      },
    };
  }
}
