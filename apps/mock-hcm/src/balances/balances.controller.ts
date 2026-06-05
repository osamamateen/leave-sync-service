import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { BalancesService, HcmBalanceDto } from './balances.service';
import { DeductBalanceDto } from './dto/deduct-balance.dto';
import { AdjustBalanceDto } from './dto/adjust-balance.dto';

@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  // NOTE: the static 'full-sync' route MUST be declared before the ':employeeId'
  // param route, otherwise Express would match 'full-sync' as an employee id.
  @Get('full-sync')
  fullSync(): Promise<HcmBalanceDto[]> {
    return this.balances.fullSync();
  }

  @Get(':employeeId')
  getByEmployee(
    @Param('employeeId') employeeId: string,
  ): Promise<HcmBalanceDto[]> {
    return this.balances.getByEmployee(employeeId);
  }

  @Post('deduct')
  @HttpCode(200)
  deduct(
    @Body() dto: DeductBalanceDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<HcmBalanceDto> {
    return this.balances.deduct(dto, idempotencyKey);
  }

  @Post('adjust')
  @HttpCode(200)
  adjust(@Body() dto: AdjustBalanceDto): Promise<HcmBalanceDto> {
    return this.balances.adjust(dto);
  }
}
