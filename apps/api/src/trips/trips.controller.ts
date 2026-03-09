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
import { TripsService } from './trips.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('trips')
@UseGuards(JwtAuthGuard)
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  // ВАЖНО: predefined ВЫШЕ :id — иначе NestJS парсит 'predefined' как UUID!
  @Get('predefined')
  getPredefined() {
    return this.tripsService.findPredefined();
  }

  @Get()
  getAll(@CurrentUser() user: { id: string }) {
    return this.tripsService.findByOwner(user.id);
  }

  @Post()
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateTripDto) {
    return this.tripsService.create(user.id, dto);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.tripsService.findByIdWithAccess(id, user.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateTripDto,
  ) {
    return this.tripsService.update(id, user.id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.tripsService.remove(id, user.id);
  }
}
