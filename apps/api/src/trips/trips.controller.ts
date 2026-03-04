import { Controller, Get, Post, Body } from '@nestjs/common';
import { TripsService } from './trips.service';
import type { NewTrip } from './trips.service';

@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Get()
  async findAll() {
    return await this.tripsService.findAll();
  }

  @Post()
  async create(@Body() createTripDto: NewTrip) {
    return await this.tripsService.create(createTripDto);
  }
}