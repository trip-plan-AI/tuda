import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { CollaboratorsService } from './collaborators.service';
import { TripsService } from './trips.service';
import { AddCollaboratorDto } from './dto/add-collaborator.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';

@Controller('trips/:tripId/collaborators')
@UseGuards(JwtAuthGuard)
export class CollaboratorsController {
  constructor(
    private collaboratorsService: CollaboratorsService,
    private tripsService: TripsService,
    private collabGateway: CollaborationGateway,
  ) {}

  @Get()
  getAll(@Param('tripId') tripId: string) {
    return this.collaboratorsService.getAll(tripId);
  }

  @Post()
  async add(
    @Param('tripId') tripId: string,
    @Body() dto: AddCollaboratorDto,
    @Req() req: any,
  ) {
    const trip = await this.tripsService.findById(tripId);
    if (trip.ownerId !== req.user.id) {
      throw new ForbiddenException('Only trip owner can invite collaborators');
    }
    const result = await this.collaboratorsService.add(
      tripId,
      dto.userId,
      dto.role ?? 'editor',
    );
    // Push the trip to the invited user's profile in real-time
    this.collabGateway.notifyTripShared(dto.userId, trip);
    return result;
  }

  @Delete(':userId')
  async remove(
    @Param('tripId') tripId: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    const trip = await this.tripsService.findById(tripId);
    if (trip.ownerId !== req.user.id) {
      throw new ForbiddenException('Only trip owner can remove collaborators');
    }
    const result = await this.collaboratorsService.remove(tripId, userId);
    // Broadcast removal to everyone in the trip room
    this.collabGateway.notifyCollaboratorRemoved(tripId, userId);
    return result;
  }
}
