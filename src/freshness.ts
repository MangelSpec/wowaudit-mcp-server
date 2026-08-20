export const CACHE_TAGS = [
  "team",
  "period",
  "characters",
  "historical",
  "attendance",
  "wishlists",
  "raids",
  "loot",
] as const;

export type CacheTag = (typeof CACHE_TAGS)[number];

export interface TeamLastRefreshed {
  blizzard: string | null;
  percentiles: string | null;
  mythicPlus: string | null;
}

export interface TeamFreshness {
  wishlistUpdatedAt: string | number | null;
  wishlistUpdatedAtMs: number | null;
  lastRefreshed: TeamLastRefreshed;
}

export type WishlistMarkerResult = "equal" | "larger" | "invalid";

export function compareWishlistMarker(
  previous: number | null,
  current: number | null,
): WishlistMarkerResult {
  if (previous === null || current === null || current < previous) {
    return "invalid";
  }
  return current === previous ? "equal" : "larger";
}

export class FreshnessState {
  readonly #generations = new Map<CacheTag, number>(
    CACHE_TAGS.map((tag) => [tag, 0]),
  );
  #team: TeamFreshness = {
    wishlistUpdatedAt: null,
    wishlistUpdatedAtMs: null,
    lastRefreshed: emptyLastRefreshed(),
  };

  capture(tags: readonly CacheTag[]): Map<CacheTag, number> {
    return new Map(tags.map((tag) => [tag, this.#generations.get(tag) ?? 0]));
  }

  matches(snapshot: ReadonlyMap<CacheTag, number>): boolean {
    for (const [tag, generation] of snapshot) {
      if (this.#generations.get(tag) !== generation) return false;
    }
    return true;
  }

  invalidate(tags: readonly CacheTag[]): void {
    for (const tag of tags) {
      this.#generations.set(tag, (this.#generations.get(tag) ?? 0) + 1);
    }
  }

  updateTeam(value: unknown): TeamFreshness {
    if (!isRecord(value)) return this.team;
    const wishlistUpdatedAt = parseRawTimestamp(value.wishlist_updated_at);
    this.#team = {
      wishlistUpdatedAt,
      wishlistUpdatedAtMs: parseTimestamp(wishlistUpdatedAt),
      lastRefreshed: parseLastRefreshed(value.last_refreshed),
    };
    return this.team;
  }

  get team(): TeamFreshness {
    return {
      ...this.#team,
      lastRefreshed: { ...this.#team.lastRefreshed },
    };
  }

  reset(): void {
    for (const tag of CACHE_TAGS) this.#generations.set(tag, 0);
    this.#team = {
      wishlistUpdatedAt: null,
      wishlistUpdatedAtMs: null,
      lastRefreshed: emptyLastRefreshed(),
    };
  }
}

export function tagsForRead(pathname: string): CacheTag[] {
  if (pathname === "/v1/team") return ["team"];
  if (pathname === "/v1/period") return ["period"];
  if (matchesCollection(pathname, "/v1/characters")) return ["characters"];
  if (matchesCollection(pathname, "/v1/historical_data")) return ["historical"];
  if (matchesCollection(pathname, "/v1/attendance")) return ["attendance"];
  if (matchesCollection(pathname, "/v1/wishlists")) return ["wishlists"];
  if (matchesCollection(pathname, "/v1/raids")) return ["raids"];
  if (matchesCollection(pathname, "/v1/loot_history")) return ["loot"];
  return [];
}

export function tagsForMutation(method: string, pathname: string): CacheTag[] {
  if (method === "POST" && pathname === "/v1/characters") {
    return ["characters", "historical", "attendance", "raids", "wishlists"];
  }
  if (method === "PUT" && /^\/v1\/characters\/\d+$/.test(pathname)) {
    return ["characters", "historical", "attendance", "raids", "wishlists"];
  }
  if (method === "POST" && pathname === "/v1/raids") return ["raids"];
  if (method === "PUT" && /^\/v1\/raids\/\d+$/.test(pathname)) {
    return ["raids", "attendance"];
  }
  if (method === "POST" && pathname === "/v1/wishlists") {
    return ["wishlists", "team"];
  }
  return [...CACHE_TAGS];
}

function parseRawString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseRawTimestamp(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return parseRawString(value);
}

function parseTimestamp(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") {
    const milliseconds =
      Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return milliseconds;
}

function parseLastRefreshed(value: unknown): TeamLastRefreshed {
  if (!isRecord(value)) return emptyLastRefreshed();
  return {
    blizzard: parseRawString(value.blizzard),
    percentiles: parseRawString(value.percentiles),
    mythicPlus: parseRawString(value.mythic_plus),
  };
}

function emptyLastRefreshed(): TeamLastRefreshed {
  return { blizzard: null, percentiles: null, mythicPlus: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesCollection(pathname: string, collection: string): boolean {
  return pathname === collection || pathname.startsWith(`${collection}/`);
}
