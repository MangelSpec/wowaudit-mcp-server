import { AsyncLocalStorage } from "node:async_hooks";

import type { CacheOutcome } from "./responseCache.js";

export interface CacheTelemetry {
  source: "wowaudit";
  outcome: CacheOutcome;
  durationMs: number;
  decodedBytes: number;
  retainedBytes: number;
}

const storage = new AsyncLocalStorage<CacheTelemetry[]>();
const counters = new Map<CacheOutcome, number>();

export async function withCacheTelemetry<T>(
  callback: () => Promise<T>,
): Promise<{ value: T; telemetry: CacheTelemetry | undefined }> {
  const events: CacheTelemetry[] = [];
  const value = await storage.run(events, callback);
  return { value, telemetry: events.at(-1) };
}

export function recordCacheTelemetry(event: CacheTelemetry): void {
  counters.set(event.outcome, (counters.get(event.outcome) ?? 0) + 1);
  storage.getStore()?.push(event);
}

export function getCacheTelemetryCounters(): ReadonlyMap<CacheOutcome, number> {
  return new Map(counters);
}

export function resetCacheTelemetry(): void {
  counters.clear();
}
