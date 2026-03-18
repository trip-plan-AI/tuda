import { Module } from '@nestjs/common';
import { AiDiscoveryService } from './ai-discovery.service';
import { CityIngestionService } from './city-ingestion.service';
import { CityAnalyzerService } from './city-analyzer.service';
import { ClusteringService } from './clustering.service';
import { FuzzyMatcherService } from './fuzzy-matcher.service';
import { ItineraryBuilderService } from './itinerary-builder.service';
import { LlmClientService } from './llm-client.service';
import { LlmExplainerService } from './llm-explainer.service';
import { OverpassFetchService } from './overpass-fetch.service';
import { PipelineController } from './pipeline.controller';
import { PoiScoringService } from './poi-scoring.service';
import { RouteGraphService } from './route-graph.service';
import { WikidataEnrichmentService } from './wikidata-enrichment.service';
import { GeosearchModule } from '../../geosearch/geosearch.module';
import { RedisModule } from '../../redis/redis.module';
import { BulkIngestionService } from './bulk-ingestion.service';
import { OsmFetchService } from './osm-fetch.service';
import { KudagoClientService } from './kudago-client.service';
import { OverpassClientService } from './overpass-client.service';

@Module({
  imports: [GeosearchModule, RedisModule],
  controllers: [PipelineController],
  providers: [
    AiDiscoveryService,
    CityIngestionService,
    CityAnalyzerService,
    ClusteringService,
    FuzzyMatcherService,
    ItineraryBuilderService,
    LlmClientService,
    LlmExplainerService,
    OverpassFetchService,
    PoiScoringService,
    RouteGraphService,
    WikidataEnrichmentService,
    BulkIngestionService,
    OsmFetchService,
    KudagoClientService,
    OverpassClientService,
  ],
  exports: [
    CityIngestionService,
    CityAnalyzerService,
    ClusteringService,
    ItineraryBuilderService,
    BulkIngestionService,
    OsmFetchService,
    KudagoClientService,
    OverpassClientService,
    LlmExplainerService,
    AiDiscoveryService,
    FuzzyMatcherService,
  ],
})
export class AiPipelineModule {}
