import { Module } from '@nestjs/common';
import { GeosearchController } from './geosearch.controller';
import { GeosearchService } from './geosearch.service';
import { PopularDestinationsService } from './popular-destinations.service';

@Module({
  controllers: [GeosearchController],
  providers: [GeosearchService, PopularDestinationsService],
  // TRI-108-6: Export GeosearchService for use in other modules (e.g., AI Pipeline)
  exports: [GeosearchService],
})
export class GeosearchModule {}
