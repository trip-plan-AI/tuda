import { Module, forwardRef } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { CollaboratorsController } from './collaborators.controller';
import { CollaboratorsService } from './collaborators.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { GeosearchModule } from '../geosearch/geosearch.module';
import { TripImageService } from './trip-image.service';

@Module({
  imports: [forwardRef(() => CollaborationModule), GeosearchModule],
  controllers: [
    TripsController,
    CollaboratorsController,
    InvitationsController,
  ],
  providers: [
    TripsService,
    CollaboratorsService,
    InvitationsService,
    TripImageService,
  ],
  exports: [TripsService, TripImageService],
})
export class TripsModule {}
