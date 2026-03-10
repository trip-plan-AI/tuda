import { Controller, Post, Param, Body, UseGuards } from '@nestjs/common';
import { OptimizationService } from './optimization.service';
import { OptimizeTripDto } from './dto/optimize-trip.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('trips')
@UseGuards(JwtAuthGuard)
export class OptimizationController {
  constructor(private readonly optimizationService: OptimizationService) {}

  @Post(':id/optimize')
  optimizeTrip(
    @Param('id') id: string,
    @Body() dto: OptimizeTripDto,
    @CurrentUser() user: any,
  ) {
    return this.optimizationService.optimizeTrip(id, dto, user.id);
  }
}
