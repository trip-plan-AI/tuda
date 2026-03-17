import { Module, forwardRef } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { CollaboratorsController } from './collaborators.controller';
import { CollaboratorsService } from './collaborators.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { TripImageService } from './trip-image.service';
import { CityExtractionService } from './city-extraction.service';
import { CityExtractionModule } from './city-extraction.module';

@Module({
  imports: [forwardRef(() => CollaborationModule), CityExtractionModule],
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
    CityExtractionService,
  ],
  exports: [TripsService, TripImageService, CityExtractionService],
})
export class TripsModule {}
