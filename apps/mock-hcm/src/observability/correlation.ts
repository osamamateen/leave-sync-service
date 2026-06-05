import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Per-request correlation id. The time-off service forwards its trace id as an
// `x-correlation-id` header, so adopting it here makes a single distributed
// operation show the same id in both services' logs.

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
