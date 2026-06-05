import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { BalanceStore } from './balance-store';
import { BalancesService } from './balances.service';
import { BalancesController } from './balances.controller';

@Module({
  imports: [CommonModule],
  controllers: [BalancesController],
  providers: [BalanceStore, BalancesService],
  exports: [BalanceStore],
})
export class BalancesModule {}
