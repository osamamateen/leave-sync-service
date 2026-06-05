import { Module } from '@nestjs/common';
import { RequestsService } from './requests.service';
import { RequestsController } from './requests.controller';
import { BalancesModule } from '../balances/balances.module';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [BalancesModule, HcmModule],
  controllers: [RequestsController],
  providers: [RequestsService],
})
export class RequestsModule {}
