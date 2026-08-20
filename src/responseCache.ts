import type { CacheTag, FreshnessState } from "./freshness.js";

export type CacheOutcome =
  | "hit"
  | "miss"
  | "coalesced"
  | "refresh"
  | "bypass"
  | "skip_oversize"
  | "load_error"
  | "evicted";

export interface CacheLoad<T> {
  value: T;
  decodedBytes: number;
}

export interface CacheResult<T> extends CacheLoad<T> {
  outcome: CacheOutcome;
  durationMs: number;
  retainedBytes: number;
}

export interface CacheValidation {
  retainForMs: number;
  validate(signal: AbortSignal): Promise<CacheLoad<boolean>>;
}

export interface ResponseCacheOptions {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  maxInflight?: number;
  now?: () => number;
  freshness: FreshnessState;
}

interface CompletedEntry {
  value: unknown;
  retainedBytes: number;
  expiresAt: number;
  retainUntil: number;
  tags: readonly CacheTag[];
}

interface InflightEntry<T> {
  controller: AbortController;
  generations: ReadonlyMap<CacheTag, number>;
  promise: Promise<CacheResult<T>>;
}

export class ResponseCache {
  readonly #completed = new Map<string, CompletedEntry>();
  readonly #inflight = new Map<string, InflightEntry<unknown>>();
  readonly #maxInflight: number;
  readonly #now: () => number;
  #retainedBytes = 0;
  #shutdown = false;

  constructor(readonly options: ResponseCacheOptions) {
    this.#maxInflight = options.maxInflight ?? 16;
    this.#now = options.now ?? Date.now;
  }

  async getOrLoad<T>(
    key: string,
    request: {
      ttlMs: number;
      tags: readonly CacheTag[];
      refresh?: boolean;
      signal?: AbortSignal;
      validation?: CacheValidation;
      load(signal: AbortSignal): Promise<CacheLoad<T>>;
    },
  ): Promise<CacheResult<T>> {
    if (this.#shutdown) throw abortError();
    if (request.signal?.aborted) throw abortError();

    const now = this.#now();
    let existing = this.#completed.get(key);
    if (request.refresh) {
      this.#delete(key);
      existing = undefined;
    } else if (existing && now < existing.expiresAt) {
      this.#touch(key, existing);
      return {
        value: clone(existing.value) as T,
        decodedBytes: 0,
        outcome: "hit",
        durationMs: 0,
        retainedBytes: existing.retainedBytes,
      };
    }

    const generations = this.options.freshness.capture(request.tags);
    const active = this.#inflight.get(key) as InflightEntry<T> | undefined;
    if (active && this.options.freshness.matches(active.generations)) {
      return this.#waitFor(active.promise, request.signal, "coalesced");
    }

    const retainedCandidate =
      !request.refresh &&
      existing &&
      request.validation &&
      now < existing.retainUntil
        ? existing
        : undefined;
    if (existing && !retainedCandidate) this.#delete(key);

    if (this.#inflight.size >= this.#maxInflight) {
      const startedAt = this.#now();
      try {
        const loaded = await request.load(detachedSignal(request.signal));
        return {
          ...cloneLoad(loaded),
          outcome: "bypass",
          durationMs: elapsed(startedAt, this.#now()),
          retainedBytes: 0,
        };
      } catch (error) {
        throw error;
      }
    }

    const controller = new AbortController();
    const startedAt = this.#now();
    const promise = (async (): Promise<CacheResult<T>> => {
      let decodedBytes = 0;
      try {
        if (retainedCandidate && request.validation) {
          const validation = await request.validation.validate(
            controller.signal,
          );
          decodedBytes += validation.decodedBytes;
          if (
            validation.value &&
            !this.#shutdown &&
            this.options.freshness.matches(generations) &&
            this.#completed.get(key) === retainedCandidate
          ) {
            retainedCandidate.expiresAt = Math.min(
              this.#now() + request.ttlMs,
              retainedCandidate.retainUntil,
            );
            this.#touch(key, retainedCandidate);
            return {
              value: clone(retainedCandidate.value) as T,
              decodedBytes,
              outcome: request.refresh ? "refresh" : "miss",
              durationMs: elapsed(startedAt, this.#now()),
              retainedBytes: retainedCandidate.retainedBytes,
            };
          }
          this.#delete(key);
        }

        const loaded = await request.load(controller.signal);
        decodedBytes += loaded.decodedBytes;
        const insertion = this.#insert(
          key,
          loaded.value,
          request.ttlMs,
          request.validation?.retainForMs ?? request.ttlMs,
          request.tags,
          generations,
        );
        return {
          value: clone(loaded.value),
          decodedBytes,
          outcome: request.refresh ? "refresh" : insertion.outcome,
          durationMs: elapsed(startedAt, this.#now()),
          retainedBytes: insertion.retainedBytes,
        };
      } catch (error) {
        throw error;
      }
    })();
    const inflight = { controller, generations, promise };
    this.#inflight.set(key, inflight);
    void promise
      .finally(() => {
        if (this.#inflight.get(key) === inflight) this.#inflight.delete(key);
      })
      .catch(() => {});
    return this.#waitFor(promise, request.signal);
  }

  invalidate(tags: readonly CacheTag[]): void {
    this.options.freshness.invalidate(tags);
    const invalidated = new Set(tags);
    for (const [key, entry] of this.#completed) {
      if (entry.tags.some((tag) => invalidated.has(tag))) this.#delete(key);
    }
    for (const [key, entry] of this.#inflight) {
      if (!this.options.freshness.matches(entry.generations)) {
        this.#inflight.delete(key);
      }
    }
  }

  clear(): void {
    this.#completed.clear();
    this.#retainedBytes = 0;
  }

  shutdown(): void {
    this.#shutdown = true;
    this.clear();
    for (const entry of this.#inflight.values()) entry.controller.abort();
    this.#inflight.clear();
  }

  get stats(): { entries: number; retainedBytes: number; inflight: number } {
    return {
      entries: this.#completed.size,
      retainedBytes: this.#retainedBytes,
      inflight: this.#inflight.size,
    };
  }

  #insert(
    key: string,
    value: unknown,
    ttlMs: number,
    retainForMs: number,
    tags: readonly CacheTag[],
    generations: ReadonlyMap<CacheTag, number>,
  ): { outcome: CacheOutcome; retainedBytes: number } {
    if (this.#shutdown || !this.options.freshness.matches(generations)) {
      return { outcome: "miss", retainedBytes: 0 };
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return { outcome: "bypass", retainedBytes: 0 };
    }
    if (serialized === undefined)
      return { outcome: "bypass", retainedBytes: 0 };
    const retainedBytes =
      Buffer.byteLength(key) + Buffer.byteLength(serialized);
    if (retainedBytes > this.options.maxEntryBytes) {
      return { outcome: "skip_oversize", retainedBytes: 0 };
    }
    if (retainedBytes > this.options.maxBytes) {
      return { outcome: "skip_oversize", retainedBytes: 0 };
    }

    let evicted = false;
    while (
      this.#completed.size >= this.options.maxEntries ||
      this.#retainedBytes + retainedBytes > this.options.maxBytes
    ) {
      const oldest = this.#completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#delete(oldest);
      evicted = true;
    }
    const now = this.#now();
    this.#completed.set(key, {
      value: clone(value),
      retainedBytes,
      expiresAt: now + ttlMs,
      retainUntil: now + retainForMs,
      tags: [...tags],
    });
    this.#retainedBytes += retainedBytes;
    return { outcome: evicted ? "evicted" : "miss", retainedBytes };
  }

  #delete(key: string): void {
    const entry = this.#completed.get(key);
    if (!entry) return;
    this.#completed.delete(key);
    this.#retainedBytes -= entry.retainedBytes;
  }

  #touch(key: string, entry: CompletedEntry): void {
    this.#completed.delete(key);
    this.#completed.set(key, entry);
  }

  async #waitFor<T>(
    promise: Promise<CacheResult<T>>,
    signal?: AbortSignal,
    outcome?: CacheOutcome,
  ): Promise<CacheResult<T>> {
    if (!signal) {
      const result = await promise;
      return outcome
        ? {
            ...result,
            outcome,
            value: clone(result.value),
            durationMs: 0,
            decodedBytes: 0,
          }
        : result;
    }
    if (signal.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      const aborted = () => reject(abortError());
      signal.addEventListener("abort", aborted, { once: true });
      promise.then(
        (result) => {
          signal.removeEventListener("abort", aborted);
          resolve({
            ...result,
            outcome: outcome ?? result.outcome,
            value: clone(result.value),
            ...(outcome ? { durationMs: 0, decodedBytes: 0 } : {}),
          });
        },
        (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneLoad<T>(loaded: CacheLoad<T>): CacheLoad<T> {
  return { value: clone(loaded.value), decodedBytes: loaded.decodedBytes };
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function detachedSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? new AbortController().signal;
}
