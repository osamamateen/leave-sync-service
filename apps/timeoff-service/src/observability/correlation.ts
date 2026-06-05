import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Per-request correlation id, propagated across the timeoff → HCM call chain so a
// single distributed operation is traceable. Held in AsyncLocalStorage so any
// code in the request's async tree (services, the HCM client, the logger) can
// read it without threading it through every signature.

export const CORRELATION_HEADER = 'x-correlation-id';

interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function newCorrelationId(): string {
  return randomUUID();
}
