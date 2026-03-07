import { Module } from '@nestjs/common';
import { GeosearchController } from './geosearch.controller';
import { GeosearchService } from './geosearch.service';

@Module({
  controllers: [GeosearchController],
  providers: [GeosearchService],
})
export class GeosearchModule {}
