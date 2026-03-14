import { Module, forwardRef } from '@nestjs/common';
import { PointsController } from './points.controller';
import { PointsService } from './points.service';
import { TripsModule } from '../trips/trips.module';
import { CollaborationModule } from '../collaboration/collaboration.module';

@Module({
  imports: [
    forwardRef(() => TripsModule),
    forwardRef(() => CollaborationModule),
  ],
  controllers: [PointsController],
  providers: [PointsService],
  exports: [PointsService],
})
export class PointsModule {}
