import { Module, forwardRef } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { CollaboratorsController } from './collaborators.controller';
import { CollaboratorsService } from './collaborators.service';
import { CollaborationModule } from '../collaboration/collaboration.module';

@Module({
  imports: [forwardRef(() => CollaborationModule)],
  controllers: [TripsController, CollaboratorsController],
  providers: [TripsService, CollaboratorsService],
  exports: [TripsService],
})
export class TripsModule {}
