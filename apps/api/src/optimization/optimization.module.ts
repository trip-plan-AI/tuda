import { Module } from '@nestjs/common';
import { OptimizationService } from './optimization.service';
import { OptimizationController } from './optimization.controller';

@Module({
  controllers: [OptimizationController],
  providers: [OptimizationService],
})
export class OptimizationModule {}
