import { getConfig } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
}

export class WowAuditApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "WowAuditApiError";
  }
}

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;
const responseCache = new Map<string, { expiresAt: number; data: unknown }>();

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
  const cacheKey = url.toString();
  if (method === "GET") {
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data as T;
    if (cached) responseCache.delete(cacheKey);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
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
  } finally {
    clearTimeout(timeout);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > config.maxResponseBytes
  ) {
    throw new WowAuditApiError(
      `WoWAudit response exceeded WOWAUDIT_MAX_RESPONSE_BYTES (${config.maxResponseBytes})`,
      response.status,
    );
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > config.maxResponseBytes) {
    throw new WowAuditApiError(
      `WoWAudit response exceeded WOWAUDIT_MAX_RESPONSE_BYTES (${config.maxResponseBytes})`,
      response.status,
    );
  }

  let data: unknown = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new WowAuditApiError(
        `WoWAudit returned invalid JSON (HTTP ${response.status})`,
        response.status,
      );
    }
  }

  if (!response.ok) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    throw new WowAuditApiError(
      buildApiErrorMessage(
        response.status,
        response.statusText,
        data,
        config.apiKey,
      ),
      response.status,
      retryAfter,
    );
  }

  if (method === "GET") {
    if (responseCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = responseCache.keys().next().value as string | undefined;
      if (oldest) responseCache.delete(oldest);
    }
    responseCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      data,
    });
  } else {
    responseCache.clear();
  }

  return data as T;
}

export function clearResponseCache(): void {
  responseCache.clear();
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
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function buildApiErrorMessage(
  status: number,
  statusText: string,
  data: unknown,
  apiKey: string,
): string {
  let detail = "";
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const candidate = record.description ?? record.message ?? record.error;
    if (typeof candidate === "string" && candidate.trim()) {
      const sanitized = redactApiKey(candidate, apiKey);
      detail = `: ${sanitized.replace(/\s+/g, " ").trim().slice(0, 300)}`;
    }
  }
  return `WoWAudit API error ${status} ${statusText}${detail}`;
}

function redactApiKey(value: string, apiKey: string): string {
  return value.split(apiKey).join("[redacted]");
}
