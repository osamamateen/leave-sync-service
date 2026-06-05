import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationController } from './reconciliation.controller';
import { HcmModule } from '../hcm/hcm.module';
import { BalancesModule } from '../balances/balances.module';

@Module({
  imports: [HcmModule, BalancesModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
})
export class ReconciliationModule {}
