import { Module } from '@nestjs/common';
import { HcmService } from './hcm.service';

@Module({
  providers: [HcmService],
  exports: [HcmService],
})
export class HcmModule {}
