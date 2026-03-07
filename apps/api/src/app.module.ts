import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { TripsModule } from './trips/trips.module';
import { PointsModule } from './points/points.module';
import { UsersModule } from './users/users.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    DbModule,
    AuthModule,
    TripsModule,
    PointsModule,
    UsersModule,
    CollaborationModule,
    AiModule,
  ],
})
export class AppModule {}
