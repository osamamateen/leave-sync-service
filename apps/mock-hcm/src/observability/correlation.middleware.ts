import { Request, Response, NextFunction } from 'express';
import {
  CORRELATION_HEADER,
  newCorrelationId,
  runWithCorrelationId,
} from './correlation';

// Adopts the inbound `x-correlation-id` (forwarded by the time-off service) or
// mints one, echoes it on the response, and runs the request in that context.
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers[CORRELATION_HEADER];
  const correlationId =
    (typeof inbound === 'string' && inbound.trim()) || newCorrelationId();
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithCorrelationId(correlationId, () => next());
}
