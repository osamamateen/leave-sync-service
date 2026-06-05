import { Request, Response, NextFunction } from 'express';
import {
  CORRELATION_HEADER,
  newCorrelationId,
  runWithCorrelationId,
} from './correlation';

// Adopts an inbound `x-correlation-id` (so a caller — or an upstream service —
// can set the trace id) or mints one, echoes it on the response, and runs the
// rest of the request inside that correlation context.
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
