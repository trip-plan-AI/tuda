import { Module, forwardRef } from '@nestjs/common';
import { PointsController } from './points.controller';
import { PointsService } from './points.service';
import { TripsModule } from '../trips/trips.module';

@Module({
  imports: [forwardRef(() => TripsModule)],
  controllers: [PointsController],
  providers: [PointsService],
  exports: [PointsService],
})
export class PointsModule {}
