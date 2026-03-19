import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { TripsModule } from './trips/trips.module';
import { PointsModule } from './points/points.module';
import { UsersModule } from './users/users.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { AiModule } from './ai/ai.module';
import { GeosearchModule } from './geosearch/geosearch.module';
import { OptimizationModule } from './optimization/optimization.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    ThrottlerModule.forRoot([
      {
        name: 'ai_plan',
        ttl: 60000, // 1 minute
        limit: 10, // 10 requests per minute per user
      },
      {
        name: 'ai_mutation',
        ttl: 60000,
        limit: 20, // 20 mutation requests per minute
      },
    ]),
    RedisModule,
    DbModule,
    AuthModule,
    TripsModule,
    PointsModule,
    UsersModule,
    CollaborationModule,
    AiModule,
    GeosearchModule,
    OptimizationModule,
  ],
})
export class AppModule {}
