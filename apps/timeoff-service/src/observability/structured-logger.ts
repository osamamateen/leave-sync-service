import { LoggerService } from '@nestjs/common';
import { getCorrelationId } from './correlation';

// A LoggerService that every `new Logger(ctx)` in the app routes through once
// `app.useLogger` is set — so existing lifecycle / reconciliation / HCM-failure
// logs gain a consistent shape and the current request's correlationId with no
// per-call-site changes. Pretty single-line by default; set LOG_JSON=true for
// machine-parseable JSON.
type Level = 'info' | 'warn' | 'error' | 'debug';

export class StructuredLogger implements LoggerService {
  private readonly json = process.env.LOG_JSON === 'true';

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  // Nest instance loggers call error(message, stack, context); some call sites
  // pass error(message, context). Resolve both: context wins, else 2nd arg is it.
  error(message: unknown, stackOrContext?: string, context?: string): void {
    const ctx = context ?? stackOrContext;
    const stack = context ? stackOrContext : undefined;
    this.write('error', message, ctx, stack);
  }

  private write(
    level: Level,
    message: unknown,
    context?: string,
    stack?: string,
  ): void {
    const correlationId = getCorrelationId();
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    const stream = level === 'error' ? process.stderr : process.stdout;

    if (this.json) {
      stream.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          context,
          correlationId,
          message: text,
          ...(stack ? { stack } : {}),
        }) + '\n',
      );
      return;
    }

    const parts = [new Date().toISOString(), level.toUpperCase()];
    if (context) parts.push(`[${context}]`);
    if (correlationId) parts.push(`[${correlationId}]`);
    parts.push(text);
    stream.write(parts.join(' ') + (stack ? `\n${stack}` : '') + '\n');
  }
}
