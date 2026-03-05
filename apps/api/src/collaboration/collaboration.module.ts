import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PointsModule } from '../points/points.module';
import { CollaborationGateway } from './collaboration.gateway';
import { CollaborationService } from './collaboration.service';

@Module({
  imports: [AuthModule, PointsModule],
  providers: [CollaborationGateway, CollaborationService],
  exports: [CollaborationService],
})
export class CollaborationModule {}
