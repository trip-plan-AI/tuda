import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { PointsService } from './points.service';
import { CreatePointDto } from './dto/create-point.dto';
import { UpdatePointDto } from './dto/update-point.dto';
import { ReorderPointsDto } from './dto/reorder-points.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { TripsService } from '../trips/trips.service';
import { CollaborationEventsService } from '../collaboration/collaboration-events.service';

@Controller('trips/:tripId/points')
@UseGuards(JwtAuthGuard)
export class PointsController {
  constructor(
    private readonly pointsService: PointsService,
    private readonly tripsService: TripsService,
    private readonly eventsService: CollaborationEventsService,
  ) {}

  @Get()
  async getAll(
    @Param('tripId') tripId: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.tripsService.findByIdWithAccess(tripId, user.id);
    return this.pointsService.findByTrip(tripId);
  }

  @Post()
  async create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreatePointDto,
  ) {
    const trip = await this.tripsService.findByIdWithAccess(tripId, user.id);
    if (trip.ownerId !== user.id && !trip.ownerIsActive) {
      throw new ForbiddenException('Route editing is disabled by the owner');
    }
    const result = await this.pointsService.create(tripId, dto);
    this.eventsService.emitTripRefresh(tripId);
    return result;
  }

  @Patch('reorder')
  async reorder(
    @Param('tripId') tripId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: ReorderPointsDto,
  ) {
    const trip = await this.tripsService.findByIdWithAccess(tripId, user.id);
    if (trip.ownerId !== user.id && !trip.ownerIsActive) {
      throw new ForbiddenException('Route editing is disabled by the owner');
    }
    const result = await this.pointsService.reorder(tripId, dto);
    this.eventsService.emitTripRefresh(tripId);
    return result;
  }

  @Patch(':id')
  async update(
    @Param('tripId') tripId: string,
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpdatePointDto,
  ) {
    const trip = await this.tripsService.findByIdWithAccess(tripId, user.id);
    if (trip.ownerId !== user.id && !trip.ownerIsActive) {
      throw new ForbiddenException('Route editing is disabled by the owner');
    }
    const result = await this.pointsService.update(id, tripId, dto);
    this.eventsService.emitTripRefresh(tripId);
    return result;
  }

  @Delete(':id')
  async remove(
    @Param('tripId') tripId: string,
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    const trip = await this.tripsService.findByIdWithAccess(tripId, user.id);
    if (trip.ownerId !== user.id && !trip.ownerIsActive) {
      throw new ForbiddenException('Route editing is disabled by the owner');
    }
    const result = await this.pointsService.remove(id, tripId);
    this.eventsService.emitTripRefresh(tripId);
    return result;
  }
}
