import { Module } from '@nestjs/common';
import { GeosearchController } from './geosearch.controller';
import { GeosearchService } from './geosearch.service';
import { PopularDestinationsService } from './popular-destinations.service';

@Module({
  controllers: [GeosearchController],
  providers: [GeosearchService, PopularDestinationsService],
})
export class GeosearchModule {}
