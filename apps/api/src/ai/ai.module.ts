import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { OrchestratorService } from './pipeline/orchestrator.service';
import { YandexFetchService } from './pipeline/yandex-fetch.service';
import { PopularGeneratorService } from './pipeline/popular-generator.service';
import { SemanticFilterService } from './pipeline/semantic-filter.service';
import { SchedulerService } from './pipeline/scheduler.service';

@Module({
  controllers: [AiController],
  providers: [
    OrchestratorService,
    YandexFetchService,
    PopularGeneratorService,
    SemanticFilterService,
    SchedulerService,
  ],
  exports: [
    OrchestratorService,
    YandexFetchService,
    PopularGeneratorService,
    SemanticFilterService,
    SchedulerService,
  ],
})
export class AiModule {}
