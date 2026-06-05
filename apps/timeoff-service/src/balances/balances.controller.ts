import { Controller, Get, Param } from '@nestjs/common';
import { BalancesService, BalanceProjection } from './balances.service';

@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  // Local projected balance(s) for one employee (404 if none exist locally).
  @Get(':employeeId')
  getByEmployee(
    @Param('employeeId') employeeId: string,
  ): Promise<BalanceProjection[]> {
    return this.balances.getProjectedBalances(employeeId);
  }
}
