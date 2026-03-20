import { Module, forwardRef } from '@nestjs/common';
import { AiSessionsService } from './ai-sessions.service';
import { AiController } from './ai.controller';
import { PointsModule } from '../points/points.module';
import { TripsModule } from '../trips/trips.module';
import { GeosearchModule } from '../geosearch/geosearch.module';
import { KudagoClientService } from './pipeline/kudago-client.service';
import { LlmClientService } from './pipeline/llm-client.service';
import { OrchestratorService } from './pipeline/orchestrator.service';
import { OverpassClientService } from './pipeline/overpass-client.service';
import { PopularGeneratorService } from './pipeline/popular-generator.service';
import { ProviderSearchService } from './pipeline/provider-search.service';
import { SchedulerService } from './pipeline/scheduler.service';
import { SemanticFilterService } from './pipeline/semantic-filter.service';
import { IntentRouterService } from './pipeline/intent-router.service';
import { LogicalIdFilterService } from './pipeline/logical-id-filter.service';
import { PolicyService } from './pipeline/policy.service';
import { VectorPrefilterService } from './pipeline/vector-prefilter.service';
import { DeterministicPlannerService } from './pipeline/deterministic-planner.service';
import { LlmBatchRefinementService } from './pipeline/llm-batch-refinement.service';
import { LogicalIdSelectorService } from './pipeline/logical-id-selector.service';
import { MutationParserService } from './services/mutation-parser.service';
import { PointMutationService } from './services/point-mutation.service';
import { GeocodingFallbackService } from './services/geocoding-fallback.service';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { AiPipelineModule } from './pipeline/ai-pipeline.module';

import { LocationResolverService } from './pipeline/location-resolver.service';
import { PoiCacheWarmupService } from './pipeline/poi-cache-warmup.service';
import { TravelChatService } from './pipeline/travel-chat.service';

@Module({
  // TRI-104: AI контроллер теперь использует Trips/Points для сценариев
  // "применить план в маршрут" и "редактировать маршрут с AI".
  // MERGE-NOTE: при выносе сервисов в другие модули не забудьте обновить imports,
  // иначе DI упадёт на AiController.
  // TRI-108-6: Added GeosearchModule for food POI geocoding
  imports: [
    TripsModule,
    PointsModule,
    GeosearchModule,
    AiPipelineModule,
    forwardRef(() => CollaborationModule),
  ],
  controllers: [AiController],
  providers: [
    AiSessionsService,
    OrchestratorService,
    LlmClientService,
    ProviderSearchService,
    PopularGeneratorService,
    SemanticFilterService,
    SchedulerService,
    IntentRouterService,
    PolicyService,
    LogicalIdFilterService,
    VectorPrefilterService,
    DeterministicPlannerService,
    LlmBatchRefinementService,
    LogicalIdSelectorService,
    MutationParserService,
    PointMutationService,
    GeocodingFallbackService,
    LocationResolverService,
    PoiCacheWarmupService,
    TravelChatService,
  ],
  exports: [
    AiSessionsService,
    OrchestratorService,
    LlmClientService,
    ProviderSearchService,
    PopularGeneratorService,
    SemanticFilterService,
    SchedulerService,
    LocationResolverService,
  ],
})
export class AiModule {}
