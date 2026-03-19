import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PointsModule } from '../points/points.module';
import { TripsModule } from '../trips/trips.module';
import { CollaborationGateway } from './collaboration.gateway';
import { CollaborationService } from './collaboration.service';
import { CollaborationEventsService } from './collaboration-events.service';

@Module({
  imports: [
    AuthModule,
    forwardRef(() => PointsModule),
    forwardRef(() => TripsModule),
  ],
  providers: [
    CollaborationGateway,
    CollaborationService,
    CollaborationEventsService,
  ],
  exports: [
    CollaborationService,
    CollaborationGateway,
    CollaborationEventsService,
  ],
})
export class CollaborationModule {}
