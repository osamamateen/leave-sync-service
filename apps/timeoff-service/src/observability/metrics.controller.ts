import { Controller, Get } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import type { MetricsSnapshot } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  // Current operational snapshot (request counters, HCM health, reconciliation).
  @Get()
  snapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }
}
