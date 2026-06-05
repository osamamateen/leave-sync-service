import { Body, Controller, Get, Put } from '@nestjs/common';
import { FailureSimulatorService } from './failure-simulator.service';
import type { FailureConfig } from './failure-simulator.service';
import { UpdateFailureConfigDto } from './dto/update-failure-config.dto';

// Lets tests and demos flip the mock's flakiness at runtime, e.g.
//   PUT /admin/failure-config { "timeoutRate": 0.2, "errorRate": 0.1 }
@Controller('admin/failure-config')
export class FailureConfigController {
  constructor(private readonly simulator: FailureSimulatorService) {}

  @Get()
  get(): FailureConfig {
    return this.simulator.getConfig();
  }

  @Put()
  update(@Body() dto: UpdateFailureConfigDto): FailureConfig {
    return this.simulator.setConfig(dto);
  }
}
