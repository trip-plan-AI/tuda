import { Module } from '@nestjs/common';
import { CityExtractionService } from './city-extraction.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [CityExtractionService],
  exports: [CityExtractionService],
})
export class CityExtractionModule {}
