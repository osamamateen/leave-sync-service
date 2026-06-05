import { Module } from '@nestjs/common';
import { FailureSimulatorService } from './failure-simulator.service';
import { FailureConfigController } from './failure-config.controller';

// Shared infrastructure: the failure simulator (a singleton holding mutable
// config) plus the admin endpoint that tunes it.
@Module({
  controllers: [FailureConfigController],
  providers: [FailureSimulatorService],
  exports: [FailureSimulatorService],
})
export class CommonModule {}
