import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { HcmModule } from './hcm/hcm.module';
import { BalancesModule } from './balances/balances.module';
import { RequestsModule } from './requests/requests.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ObservabilityModule } from './observability/observability.module';
import { correlationMiddleware } from './observability/correlation.middleware';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObservabilityModule,
    PrismaModule,
    HcmModule,
    BalancesModule,
    RequestsModule,
    ReconciliationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  // Tag every request with a correlation id (also active under e2e, which boots
  // AppModule directly without main.ts).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
