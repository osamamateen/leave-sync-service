import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ReconciliationService,
  ReconcileSummary,
  ReconciliationLogResponse,
} from './reconciliation.service';

@Controller('reconcile')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  // Trigger a whole-corpus reconciliation pass on demand (the cron runs it too).
  @Post()
  @HttpCode(200)
  run(): Promise<ReconcileSummary> {
    return this.reconciliation.reconcile();
  }

  // Recent reconciliation_logs entries (newest first), capped at 200.
  @Get('logs')
  logs(@Query('take') take?: string): Promise<ReconciliationLogResponse[]> {
    const n = Math.min(Number(take) || 50, 200);
    return this.reconciliation.recentLogs(n);
  }

  // Realtime refresh of one employee from HCM (404 if HCM doesn't know them) —
  // declared after the static 'logs' route so 'logs' isn't matched as an id.
  @Post(':employeeId')
  @HttpCode(200)
  runForEmployee(
    @Param('employeeId') employeeId: string,
  ): Promise<ReconcileSummary> {
    return this.reconciliation.reconcileEmployee(employeeId);
  }
}
