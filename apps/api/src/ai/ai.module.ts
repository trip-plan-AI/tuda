import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { OrchestratorService } from './pipeline/orchestrator.service';

@Module({
  controllers: [AiController],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class AiModule {}
