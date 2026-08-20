import { readFileSync } from "node:fs";

const DEFAULT_BASE_URL = "https://api.wowaudit.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_CACHE_MAX_ENTRIES = 64;
const DEFAULT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_API_KEY_FD = 1024;

let cachedFdApiKey: string | undefined;

export type WowAuditWritePolicy = "raidlens-create-update-v1" | undefined;

export interface WowAuditConfig {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  cacheMaxEntries: number;
  cacheMaxBytes: number;
  cacheMaxEntryBytes: number;
  wishlistMarkerValidation: boolean;
  writesEnabled: boolean;
  applicationsEnabled: boolean;
  writePolicy: WowAuditWritePolicy;
}

export interface WowAuditFeatureFlags {
  writesEnabled: boolean;
  applicationsEnabled: boolean;
  writePolicy: WowAuditWritePolicy;
}

export function getConfig(): WowAuditConfig {
  const apiKey = readConfiguredApiKey(
    process.env.WOWAUDIT_API_KEY,
    process.env.WOWAUDIT_API_KEY_FD,
  );

  return {
    apiKey,
    baseUrl: parseBaseUrl(process.env.WOWAUDIT_BASE_URL),
    requestTimeoutMs: parseBoundedInteger(
      "WOWAUDIT_REQUEST_TIMEOUT_MS",
      process.env.WOWAUDIT_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    ),
    maxResponseBytes: parseBoundedInteger(
      "WOWAUDIT_MAX_RESPONSE_BYTES",
      process.env.WOWAUDIT_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_MAX_RESPONSE_BYTES,
      MAX_MAX_RESPONSE_BYTES,
    ),
    cacheMaxEntries: parseBoundedInteger(
      "WOWAUDIT_CACHE_MAX_ENTRIES",
      process.env.WOWAUDIT_CACHE_MAX_ENTRIES,
      DEFAULT_CACHE_MAX_ENTRIES,
      1,
      1024,
    ),
    cacheMaxBytes: parseBoundedInteger(
      "WOWAUDIT_CACHE_MAX_BYTES",
      process.env.WOWAUDIT_CACHE_MAX_BYTES,
      DEFAULT_CACHE_MAX_BYTES,
      1,
      1024 * 1024 * 1024,
    ),
    cacheMaxEntryBytes: parseBoundedInteger(
      "WOWAUDIT_CACHE_MAX_ENTRY_BYTES",
      process.env.WOWAUDIT_CACHE_MAX_ENTRY_BYTES,
      DEFAULT_CACHE_MAX_ENTRY_BYTES,
      1,
      1024 * 1024 * 1024,
    ),
    wishlistMarkerValidation: parseBoolean(
      "WOWAUDIT_WISHLIST_MARKER_VALIDATION",
      process.env.WOWAUDIT_WISHLIST_MARKER_VALIDATION,
      false,
    ),
    ...getFeatureFlags(),
  };
}

function readConfiguredApiKey(
  value: string | undefined,
  fdValue: string | undefined,
): string {
  const hasValue = value !== undefined && value.length > 0;
  const hasFd = fdValue !== undefined && fdValue.length > 0;
  if (hasValue || !hasFd) return readApiKey(value, fdValue);

  cachedFdApiKey ??= readApiKey(undefined, fdValue);
  return cachedFdApiKey;
}

export function readApiKey(
  value: string | undefined,
  fdValue: string | undefined,
): string {
  const hasValue = value !== undefined && value.length > 0;
  const hasFd = fdValue !== undefined && fdValue.length > 0;
  if (hasValue && hasFd) {
    throw new Error(
      "Set exactly one of WOWAUDIT_API_KEY or WOWAUDIT_API_KEY_FD",
    );
  }
  if (hasValue) return value;
  if (!hasFd) {
    throw new Error(
      "Missing WOWAUDIT_API_KEY or WOWAUDIT_API_KEY_FD. Add the team API key from https://wowaudit.com/api.",
    );
  }

  if (!/^\d+$/.test(fdValue)) {
    throw new Error(
      "WOWAUDIT_API_KEY_FD must be an integer between 1 and 1024",
    );
  }
  const fd = Number(fdValue);
  if (!Number.isSafeInteger(fd) || fd < 1 || fd > MAX_API_KEY_FD) {
    throw new Error(
      "WOWAUDIT_API_KEY_FD must be an integer between 1 and 1024",
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(fd);
  } catch {
    throw new Error("Unable to read WOWAUDIT_API_KEY_FD");
  }
  if (bytes.length === 0) {
    throw new Error("WOWAUDIT_API_KEY_FD must not be empty");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error("WOWAUDIT_API_KEY_FD must contain valid UTF-8");
  }
}

export function getFeatureFlags(): WowAuditFeatureFlags {
  return {
    writesEnabled: parseBoolean(
      "WOWAUDIT_ENABLE_WRITES",
      process.env.WOWAUDIT_ENABLE_WRITES,
      false,
    ),
    applicationsEnabled: parseBoolean(
      "WOWAUDIT_ENABLE_APPLICATIONS",
      process.env.WOWAUDIT_ENABLE_APPLICATIONS,
      false,
    ),
    writePolicy: parseWritePolicy(process.env.WOWAUDIT_WRITE_POLICY),
  };
}

export function parseWritePolicy(
  value: string | undefined,
): WowAuditWritePolicy {
  if (value === undefined || value.trim() === "") return undefined;
  if (value === "raidlens-create-update-v1") return value;
  throw new Error(
    "WOWAUDIT_WRITE_POLICY must be raidlens-create-update-v1 when set",
  );
}

export function parseBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WOWAUDIT_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("WOWAUDIT_BASE_URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "WOWAUDIT_BASE_URL must not contain credentials, a query, or a fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function parseBoundedInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoolean(
  name: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
