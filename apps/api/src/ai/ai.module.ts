import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { KudagoClientService } from './pipeline/kudago-client.service';
import { LlmClientService } from './pipeline/llm-client.service';
import { OrchestratorService } from './pipeline/orchestrator.service';
import { OverpassClientService } from './pipeline/overpass-client.service';
import { PopularGeneratorService } from './pipeline/popular-generator.service';
import { ProviderSearchService } from './pipeline/provider-search.service';
import { SchedulerService } from './pipeline/scheduler.service';
import { SemanticFilterService } from './pipeline/semantic-filter.service';
import { YandexFetchService } from './pipeline/yandex-fetch.service';

@Module({
  controllers: [AiController],
  providers: [
    OrchestratorService,
    LlmClientService,
    YandexFetchService,
    KudagoClientService,
    OverpassClientService,
    ProviderSearchService,
    PopularGeneratorService,
    SemanticFilterService,
    SchedulerService,
  ],
  exports: [
    OrchestratorService,
    LlmClientService,
    YandexFetchService,
    ProviderSearchService,
    PopularGeneratorService,
    SemanticFilterService,
    SchedulerService,
  ],
})
export class AiModule {}
