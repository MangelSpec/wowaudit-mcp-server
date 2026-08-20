import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CACHE_TAGS,
  compareWishlistMarker,
  FreshnessState,
  tagsForMutation,
  tagsForRead,
} from "../dist/freshness.js";

test("maps every read category to its generation tag", () => {
  assert.deepEqual(tagsForRead("/v1/team"), ["team"]);
  assert.deepEqual(tagsForRead("/v1/period"), ["period"]);
  assert.deepEqual(tagsForRead("/v1/characters/1"), ["characters"]);
  assert.deepEqual(tagsForRead("/v1/historical_data/1"), ["historical"]);
  assert.deepEqual(tagsForRead("/v1/attendance"), ["attendance"]);
  assert.deepEqual(tagsForRead("/v1/wishlists/1"), ["wishlists"]);
  assert.deepEqual(tagsForRead("/v1/raids/1"), ["raids"]);
  assert.deepEqual(tagsForRead("/v1/loot_history/1"), ["loot"]);
});

test("accepts only equal wishlist markers for cache extension", () => {
  assert.equal(compareWishlistMarker(100, 100), "equal");
  assert.equal(compareWishlistMarker(100, 101), "larger");
  assert.equal(compareWishlistMarker(null, 100), "invalid");
  assert.equal(compareWishlistMarker(100, null), "invalid");
  assert.equal(compareWishlistMarker(100, 99), "invalid");
});

test("maps supported mutations and invalidates all for unknown writes", () => {
  const characterTags = [
    "characters",
    "historical",
    "attendance",
    "raids",
    "wishlists",
  ];
  assert.deepEqual(tagsForMutation("POST", "/v1/characters"), characterTags);
  assert.deepEqual(tagsForMutation("PUT", "/v1/characters/1"), characterTags);
  assert.deepEqual(tagsForMutation("POST", "/v1/raids"), ["raids"]);
  assert.deepEqual(tagsForMutation("PUT", "/v1/raids/1"), [
    "raids",
    "attendance",
  ]);
  assert.deepEqual(tagsForMutation("POST", "/v1/wishlists"), [
    "wishlists",
    "team",
  ]);
  assert.deepEqual(tagsForMutation("DELETE", "/v1/future/1"), CACHE_TAGS);
});

test("normalizes numeric wishlist markers and official team freshness fields", () => {
  const state = new FreshnessState();
  assert.deepEqual(
    state.updateTeam({
      wishlist_updated_at: 1_776_938_400,
      last_refreshed: {
        blizzard: "2026-04-23T10:01:00Z",
        percentiles: "2026-04-23T10:02:00Z",
        mythic_plus: "2026-04-23T10:03:00Z",
      },
    }),
    {
      wishlistUpdatedAt: 1_776_938_400,
      wishlistUpdatedAtMs: 1_776_938_400_000,
      lastRefreshed: {
        blizzard: "2026-04-23T10:01:00Z",
        percentiles: "2026-04-23T10:02:00Z",
        mythicPlus: "2026-04-23T10:03:00Z",
      },
    },
  );
  assert.equal(
    state.updateTeam({ wishlist_updated_at: 1_776_938_400_000 })
      .wishlistUpdatedAtMs,
    1_776_938_400_000,
  );
  assert.equal(
    state.updateTeam({ wishlist_updated_at: "2026-04-23T10:00:00Z" })
      .wishlistUpdatedAtMs,
    Date.parse("2026-04-23T10:00:00Z"),
  );
});

test("fails closed for malformed and decreasing wishlist markers", () => {
  const state = new FreshnessState();
  assert.deepEqual(state.updateTeam({ wishlist_updated_at: "invalid" }), {
    wishlistUpdatedAt: "invalid",
    wishlistUpdatedAtMs: null,
    lastRefreshed: {
      blizzard: null,
      percentiles: null,
      mythicPlus: null,
    },
  });
  assert.equal(
    state.updateTeam({ wishlist_updated_at: Number.POSITIVE_INFINITY })
      .wishlistUpdatedAtMs,
    null,
  );
  assert.equal(compareWishlistMarker(1_776_938_400_000, null), "invalid");
  assert.equal(
    compareWishlistMarker(1_776_938_400_000, 1_776_938_399_999),
    "invalid",
  );
});
