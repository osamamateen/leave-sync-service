// Small delay helper used to emulate network/processing latency and timeouts.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
