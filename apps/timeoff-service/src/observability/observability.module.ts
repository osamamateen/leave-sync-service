import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

// Global so MetricsService can be (optionally) injected anywhere without import
// churn. The correlation middleware and structured logger are wired separately
// (in AppModule.configure and main.ts) since they are not DI providers.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
