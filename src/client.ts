import { recordCacheTelemetry } from "./cacheTelemetry.js";
import { getConfig, type WowAuditConfig } from "./config.js";
import {
  compareWishlistMarker,
  FreshnessState,
  tagsForMutation,
  tagsForRead,
} from "./freshness.js";
import {
  ResponseCache,
  type CacheLoad,
  type CacheValidation,
} from "./responseCache.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type QueryPrimitive = string | number | boolean;

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<
    string,
    QueryPrimitive | readonly QueryPrimitive[] | undefined
  >;
  body?: Record<string, unknown>;
  refresh?: boolean;
  signal?: AbortSignal;
}

export class WowAuditApiError extends Error {
  #telemetryClaimed = false;

  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryAfterSeconds: number | null = null,
    public durationMs = 0,
    public decodedBytes = 0,
  ) {
    super(message);
    this.name = "WowAuditApiError";
  }

  setLoadMetrics(durationMs: number, decodedBytes: number): void {
    this.durationMs = durationMs;
    this.decodedBytes = decodedBytes;
  }

  claimTelemetry(): boolean {
    if (this.#telemetryClaimed) return false;
    this.#telemetryClaimed = true;
    return true;
  }
}

const MAX_RETRY_AFTER_SECONDS = 60 * 60;
const ERROR_DETAIL_LENGTH = 300;
const WISHLIST_VALIDATION_TTL_MS = 60_000;
const WISHLIST_RETENTION_MS = 30 * 60_000;
const freshness = new FreshnessState();
let responseCache: ResponseCache | undefined;

export async function requestWowAudit<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const config = getConfig();
  const method = options.method ?? "GET";
  if (method !== "GET" && !config.writesEnabled) {
    throw new Error(
      "WoWAudit write tools are disabled. Set WOWAUDIT_ENABLE_WRITES=true only in a trusted deployment that requires mutations.",
    );
  }

  const url = buildUrl(config.baseUrl, path, options.query);
  if (method !== "GET") {
    const serializedBody = options.body
      ? JSON.stringify(options.body)
      : undefined;
    cache(config).invalidate(tagsForMutation(method, url.pathname));
    const loaded = await loadResponse(config, url, method, serializedBody);
    return loaded.value as T;
  }

  const key = buildCacheKey(url.pathname, url.searchParams);
  const ttlMs = getResponseTtlMs(url.pathname);
  const validation = wishlistValidation(config, url.pathname);
  let result;
  try {
    result = await cache(config).getOrLoad<T>(key, {
      ttlMs: validation ? WISHLIST_VALIDATION_TTL_MS : ttlMs,
      tags: tagsForRead(url.pathname),
      refresh: options.refresh === true,
      signal: options.signal,
      validation,
      load: (signal) => loadResponse(config, url, method, undefined, signal),
    });
  } catch (error) {
    if (error instanceof WowAuditApiError && error.claimTelemetry()) {
      recordCacheTelemetry({
        source: "wowaudit",
        outcome: "load_error",
        durationMs: error.durationMs,
        decodedBytes: error.decodedBytes,
        retainedBytes: 0,
      });
    }
    throw error;
  }
  recordCacheTelemetry({
    source: "wowaudit",
    outcome: result.outcome,
    durationMs: result.durationMs,
    decodedBytes: result.decodedBytes,
    retainedBytes: result.retainedBytes,
  });
  return result.value;
}

export function clearResponseCache(): void {
  responseCache?.shutdown();
  responseCache = undefined;
  freshness.reset();
}

export function shutdownResponseCache(): void {
  responseCache?.shutdown();
}

export function buildCacheKey(
  pathname: string,
  searchParams: URLSearchParams,
): string {
  const entries = [...searchParams.entries()]
    .filter(
      ([name, value]) =>
        !((name === "include_past" || name === "refresh") && value === "false"),
    )
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? compareCodeUnits(leftValue, rightValue)
        : compareCodeUnits(leftName, rightName),
    );
  const query = new URLSearchParams(entries).toString();
  return `GET ${pathname}${query ? `?${query}` : ""}`;
}

export function getResponseTtlMs(pathname: string): number {
  if (pathname === "/v1/team") return 10 * 60_000;
  if (pathname === "/v1/period") return 5 * 60_000;
  if (matchesCollection(pathname, "/v1/characters")) return 5 * 60_000;
  if (matchesCollection(pathname, "/v1/historical_data")) return 2 * 60_000;
  if (matchesCollection(pathname, "/v1/attendance")) return 2 * 60_000;
  if (matchesCollection(pathname, "/v1/wishlists")) return 5 * 60_000;
  if (pathname === "/v1/raids") return 30_000;
  if (pathname.startsWith("/v1/raids/")) return 15_000;
  if (matchesCollection(pathname, "/v1/loot_history")) return 2 * 60_000;
  return 30_000;
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp) || timestamp <= now) return null;
  return Math.min(Math.ceil((timestamp - now) / 1000), MAX_RETRY_AFTER_SECONDS);
}

function cache(config: WowAuditConfig): ResponseCache {
  responseCache ??= new ResponseCache({
    maxEntries: config.cacheMaxEntries,
    maxBytes: config.cacheMaxBytes,
    maxEntryBytes: config.cacheMaxEntryBytes,
    maxInflight: 16,
    freshness,
  });
  return responseCache;
}

function wishlistValidation(
  config: WowAuditConfig,
  pathname: string,
): CacheValidation | undefined {
  if (
    !config.wishlistMarkerValidation ||
    !pathname.startsWith("/v1/wishlists")
  ) {
    return undefined;
  }
  return {
    retainForMs: WISHLIST_RETENTION_MS,
    async validate(signal) {
      const previous = freshness.team.wishlistUpdatedAtMs;
      const teamUrl = buildUrl(config.baseUrl, "/v1/team", undefined);
      const loaded = await loadResponse(
        config,
        teamUrl,
        "GET",
        undefined,
        signal,
      );
      const current = freshness.team.wishlistUpdatedAtMs;
      return {
        value: compareWishlistMarker(previous, current) === "equal",
        decodedBytes: loaded.decodedBytes,
      };
    },
  };
}

async function loadResponse<T>(
  config: WowAuditConfig,
  url: URL,
  method: HttpMethod,
  serializedBody?: string,
  parentSignal?: AbortSignal,
): Promise<CacheLoad<T>> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAt = performance.now();
  let decodedBytes = 0;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          ...(serializedBody ? { "Content-Type": "application/json" } : {}),
        },
        body: serializedBody,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new WowAuditApiError(
          `WoWAudit request timed out after ${config.requestTimeoutMs}ms`,
          null,
        );
      }
      throw new WowAuditApiError(
        `WoWAudit request failed: ${redactApiKey(
          error instanceof Error ? error.message : String(error),
          config.apiKey,
        )}`,
        null,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > config.maxResponseBytes
    ) {
      await response.body?.cancel();
      throw oversized(config, response.status);
    }

    let body;
    try {
      body = await readBody(
        response,
        config.maxResponseBytes,
        controller.signal,
      );
    } catch (error) {
      if (error instanceof WowAuditApiError) throw error;
      throw new WowAuditApiError(
        `WoWAudit response failed: ${redactApiKey(
          error instanceof Error ? error.message : String(error),
          config.apiKey,
        )}`,
        response.status,
      );
    }
    const { text } = body;
    decodedBytes = body.decodedBytes;
    let data: unknown = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new WowAuditApiError(
            `WoWAudit returned invalid JSON (HTTP ${response.status})`,
            response.status,
          );
        }
        data = null;
      }
    }

    if (!response.ok) {
      throw new WowAuditApiError(
        buildApiErrorMessage(
          response.status,
          response.statusText,
          data,
          text,
          config.apiKey,
        ),
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (url.pathname === "/v1/team") freshness.updateTeam(data);
    return { value: data as T, decodedBytes };
  } catch (error) {
    if (error instanceof WowAuditApiError) {
      error.setLoadMetrics(
        Math.max(0, performance.now() - startedAt),
        Math.max(decodedBytes, error.decodedBytes),
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", relayAbort);
  }
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; decodedBytes: number }> {
  if (!response.body) return { text: "", decodedBytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let decodedBytes = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) throw timeoutError(decodedBytes);
        throw error;
      }
      if (result.done) break;
      decodedBytes += result.value.byteLength;
      if (decodedBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WowAuditApiError(
          `WoWAudit response exceeded WOWAUDIT_MAX_RESPONSE_BYTES (${maxBytes})`,
          response.status,
          null,
          0,
          decodedBytes,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(decodedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), decodedBytes };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: RequestOptions["query"],
): URL {
  if (!path.startsWith("/v1/")) {
    throw new Error("WoWAudit API paths must start with /v1/");
  }
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, rawValue] of Object.entries(query ?? {})) {
    if (rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) url.searchParams.append(key, String(value));
  }
  const normalized = buildCacheKey(url.pathname, url.searchParams);
  const queryIndex = normalized.indexOf("?");
  url.search = queryIndex === -1 ? "" : normalized.slice(queryIndex);
  return url;
}

function buildApiErrorMessage(
  status: number,
  statusText: string,
  data: unknown,
  text: string,
  apiKey: string,
): string {
  let candidate = "";
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const value = record.description ?? record.message ?? record.error;
    if (typeof value === "string") candidate = value;
  } else if (text.trim()) {
    candidate = text;
  }
  const detail = candidate.trim()
    ? `: ${redactApiKey(candidate, apiKey)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, ERROR_DETAIL_LENGTH)}`
    : "";
  return `WoWAudit API error ${status} ${statusText}${detail}`;
}

function oversized(config: WowAuditConfig, status: number): WowAuditApiError {
  return new WowAuditApiError(
    `WoWAudit response exceeded WOWAUDIT_MAX_RESPONSE_BYTES (${config.maxResponseBytes})`,
    status,
  );
}

function timeoutError(decodedBytes = 0): WowAuditApiError {
  return new WowAuditApiError(
    "WoWAudit response body timed out",
    null,
    null,
    0,
    decodedBytes,
  );
}

function redactApiKey(value: string, apiKey: string): string {
  return value.split(apiKey).join("[redacted]");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesCollection(pathname: string, collection: string): boolean {
  return pathname === collection || pathname.startsWith(`${collection}/`);
}
