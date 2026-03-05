import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { PointsService } from './points.service';
import { CreatePointDto } from './dto/create-point.dto';
import { UpdatePointDto } from './dto/update-point.dto';
import { ReorderPointsDto } from './dto/reorder-points.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { TripsService } from '../trips/trips.service';

@Controller('trips/:tripId/points')
@UseGuards(JwtAuthGuard)
export class PointsController {
  constructor(
    private readonly pointsService: PointsService,
    private readonly tripsService: TripsService,
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
    await this.tripsService.findByIdWithAccess(tripId, user.id);
    return this.pointsService.create(tripId, dto);
  }

  @Patch('reorder')
  async reorder(
    @Param('tripId') tripId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: ReorderPointsDto,
  ) {
    await this.tripsService.findByIdWithAccess(tripId, user.id);
    return this.pointsService.reorder(tripId, dto);
  }

  @Patch(':id')
  async update(
    @Param('tripId') tripId: string,
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpdatePointDto,
  ) {
    await this.tripsService.findByIdWithAccess(tripId, user.id);
    return this.pointsService.update(id, tripId, dto);
  }

  @Delete(':id')
  async remove(
    @Param('tripId') tripId: string,
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.tripsService.findByIdWithAccess(tripId, user.id);
    return this.pointsService.remove(id, tripId);
  }
}
