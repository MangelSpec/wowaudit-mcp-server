import assert from "node:assert/strict";
import { test } from "node:test";

import { FreshnessState } from "../dist/freshness.js";
import { ResponseCache } from "../dist/responseCache.js";

function createCache(overrides = {}) {
  let now = 1_000;
  const freshness = new FreshnessState();
  const cache = new ResponseCache({
    maxEntries: 2,
    maxBytes: 1_000,
    maxEntryBytes: 1_000,
    maxInflight: 2,
    now: () => now,
    freshness,
    ...overrides,
  });
  return {
    cache,
    freshness,
    advance(milliseconds) {
      now += milliseconds;
    },
    setNow(value) {
      now = value;
    },
  };
}

async function load(cache, key, value, options = {}) {
  return cache.getOrLoad(key, {
    ttlMs: options.ttlMs ?? 100,
    tags: options.tags ?? ["team"],
    refresh: options.refresh,
    signal: options.signal,
    validation: options.validation,
    load:
      options.loader ??
      (async () => ({ value: structuredClone(value), decodedBytes: 5 })),
  });
}

test("enforces entry count and true LRU recency", async () => {
  const { cache } = createCache();
  await load(cache, "a", { value: "a" });
  await load(cache, "b", { value: "b" });
  assert.equal((await load(cache, "a", null)).outcome, "hit");
  assert.equal((await load(cache, "c", { value: "c" })).outcome, "evicted");
  assert.equal((await load(cache, "a", null)).outcome, "hit");
  assert.equal((await load(cache, "b", { value: "new-b" })).outcome, "evicted");
});

test("counts key plus value bytes and accepts exact limits", async () => {
  const exactBytes = Buffer.byteLength("key") + Buffer.byteLength('{"x":"12"}');
  const { cache } = createCache({
    maxEntries: 3,
    maxBytes: exactBytes,
    maxEntryBytes: exactBytes,
  });
  const result = await load(cache, "key", { x: "12" });
  assert.equal(result.outcome, "miss");
  assert.equal(result.retainedBytes, exactBytes);
  assert.deepEqual(cache.stats, {
    entries: 1,
    retainedBytes: exactBytes,
    inflight: 0,
  });

  const oversized = await load(cache, "longer-key", { x: "12" });
  assert.equal(oversized.outcome, "skip_oversize");
  assert.equal(cache.stats.entries, 1);
});

test("expires at equality, replaces atomically, and does not extend on clock rollback", async () => {
  const { cache, advance, setNow } = createCache();
  await load(cache, "key", { version: 1 }, { ttlMs: 100 });
  advance(100);
  const replaced = await load(cache, "key", { version: 2 }, { ttlMs: 100 });
  assert.equal(replaced.outcome, "miss");
  assert.deepEqual(replaced.value, { version: 2 });
  setNow(900);
  assert.equal((await load(cache, "key", null)).outcome, "hit");
  setNow(1_200);
  assert.equal((await load(cache, "key", { version: 3 })).outcome, "miss");
});

test("an oversize replacement does not preserve an expired predecessor", async () => {
  const { cache, advance } = createCache({ maxEntryBytes: 20 });
  await load(cache, "key", { x: "ok" }, { ttlMs: 10 });
  advance(10);
  assert.equal(
    (await load(cache, "key", { x: "x".repeat(100) })).outcome,
    "skip_oversize",
  );
  assert.equal(cache.stats.entries, 0);
});

test("a value above the total byte limit does not evict unrelated entries", async () => {
  const { cache } = createCache({ maxBytes: 25, maxEntryBytes: 1_000 });
  await load(cache, "a", { x: "ok" });
  assert.equal(
    (await load(cache, "large", { x: "x".repeat(100) })).outcome,
    "skip_oversize",
  );
  assert.equal((await load(cache, "a", null)).outcome, "hit");
});

test("clones retained values for loader, hit, and coalesced callers", async () => {
  const { cache } = createCache();
  let resolve;
  const loader = () =>
    new Promise((done) => {
      resolve = done;
    });
  const first = load(cache, "key", null, { loader });
  const second = load(cache, "key", null, { loader });
  resolve({ value: { nested: { count: 1 } }, decodedBytes: 10 });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(right.outcome, "coalesced");
  assert.equal(right.decodedBytes, 0);
  assert.equal(right.durationMs, 0);
  left.value.nested.count = 9;
  assert.equal(right.value.nested.count, 1);
  const hit = await load(cache, "key", null);
  assert.equal(hit.value.nested.count, 1);
});

test("bounds distinct in-flight keys while identical keys still join", async () => {
  const { cache } = createCache({ maxInflight: 1 });
  let finish;
  const pending = load(cache, "a", null, {
    loader: () => new Promise((resolve) => (finish = resolve)),
  });
  const joined = load(cache, "a", null);
  const bypass = await load(cache, "b", { value: 2 });
  assert.equal(bypass.outcome, "bypass");
  assert.equal(cache.stats.entries, 0);
  finish({ value: { value: 1 }, decodedBytes: 1 });
  assert.equal((await joined).outcome, "coalesced");
  await pending;
});

test("caller abort detaches without cancelling the shared load", async () => {
  const { cache } = createCache();
  const caller = new AbortController();
  let finish;
  const first = load(cache, "key", null, {
    signal: caller.signal,
    loader: () => new Promise((resolve) => (finish = resolve)),
  });
  const joined = load(cache, "key", null);
  caller.abort();
  await assert.rejects(first, { name: "AbortError" });
  finish({ value: { ok: true }, decodedBytes: 1 });
  assert.deepEqual((await joined).value, { ok: true });
  assert.equal((await load(cache, "key", null)).outcome, "hit");
});

test("an already-aborted caller cannot receive a completed hit", async () => {
  const { cache } = createCache();
  await load(cache, "key", { ok: true });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(load(cache, "key", null, { signal: caller.signal }), {
    name: "AbortError",
  });
});

test("all waiters may abort while the load completes and populates", async () => {
  const { cache } = createCache();
  const left = new AbortController();
  const right = new AbortController();
  let finish;
  const first = load(cache, "key", null, {
    signal: left.signal,
    loader: () => new Promise((resolve) => (finish = resolve)),
  });
  const second = load(cache, "key", null, { signal: right.signal });
  left.abort();
  right.abort();
  await Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ]);
  finish({ value: { ok: true }, decodedBytes: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await load(cache, "key", null)).outcome, "hit");
});

test("loader errors are not cached", async () => {
  const { cache } = createCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    throw new Error("failed");
  };
  await assert.rejects(load(cache, "key", null, { loader }), /failed/);
  await assert.rejects(load(cache, "key", null, { loader }), /failed/);
  assert.equal(calls, 2);
  assert.equal(cache.stats.entries, 0);
});

test("shutdown aborts owned loads and prevents late insertion", async () => {
  const { cache } = createCache();
  let observedSignal;
  const pending = load(cache, "key", null, {
    loader: (signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("stopped"))),
      );
    },
  });
  cache.shutdown();
  assert.equal(observedSignal.aborted, true);
  await assert.rejects(pending, /stopped/);
  assert.equal(cache.stats.entries, 0);
  await assert.rejects(load(cache, "other", {}), { name: "AbortError" });
});

test("generation changes prevent a pre-mutation load from inserting", async () => {
  const { cache } = createCache();
  let finish;
  const pending = load(cache, "key", null, {
    tags: ["raids"],
    loader: () => new Promise((resolve) => (finish = resolve)),
  });
  cache.invalidate(["raids"]);
  finish({ value: { stale: true }, decodedBytes: 1 });
  await pending;
  assert.equal(cache.stats.entries, 0);
  assert.equal(
    (await load(cache, "key", { stale: false }, { tags: ["raids"] })).outcome,
    "miss",
  );
});

test("post-invalidation readers start a new load and stale cleanup is identity-safe", async () => {
  const { cache } = createCache();
  let finishA;
  let finishB;
  let calls = 0;
  const loader = () => {
    calls += 1;
    return new Promise((resolve) => {
      if (calls === 1) finishA = resolve;
      else finishB = resolve;
    });
  };

  const readA = load(cache, "key", null, { tags: ["raids"], loader });
  cache.invalidate(["raids"]);
  const readB = load(cache, "key", null, { tags: ["raids"], loader });
  assert.equal(calls, 2);

  finishA({ value: { version: "A" }, decodedBytes: 1 });
  assert.deepEqual((await readA).value, { version: "A" });
  assert.equal(cache.stats.entries, 0);

  const joinedB = load(cache, "key", null, { tags: ["raids"], loader });
  assert.equal(calls, 2);
  finishB({ value: { version: "B" }, decodedBytes: 1 });
  assert.deepEqual((await readB).value, { version: "B" });
  const joined = await joinedB;
  assert.equal(joined.outcome, "coalesced");
  assert.deepEqual(joined.value, { version: "B" });
  assert.deepEqual((await load(cache, "key", null)).value, { version: "B" });
});

test("refresh deletes completed data but joins an already active refresh", async () => {
  const { cache } = createCache();
  await load(cache, "key", { version: 1 });
  let finish;
  const first = load(cache, "key", null, {
    refresh: true,
    loader: () => new Promise((resolve) => (finish = resolve)),
  });
  const second = load(cache, "key", null, { refresh: true });
  const normal = load(cache, "key", null);
  finish({ value: { version: 2 }, decodedBytes: 1 });
  assert.equal((await first).outcome, "refresh");
  assert.equal((await second).outcome, "coalesced");
  assert.equal((await normal).outcome, "coalesced");
});

test("validation can extend an equal marker without exceeding retention", async () => {
  const { cache, advance } = createCache();
  let loads = 0;
  let probes = 0;
  const validation = {
    retainForMs: 300,
    validate: async () => {
      probes += 1;
      return { value: true, decodedBytes: 2 };
    },
  };
  const loader = async () => ({
    value: { version: ++loads },
    decodedBytes: 5,
  });
  await load(cache, "wishlist", null, {
    ttlMs: 60,
    validation,
    loader,
  });
  advance(60);
  assert.deepEqual(
    (await load(cache, "wishlist", null, { ttlMs: 60, validation, loader }))
      .value,
    { version: 1 },
  );
  assert.equal(probes, 1);
  advance(240);
  assert.deepEqual(
    (await load(cache, "wishlist", null, { ttlMs: 60, validation, loader }))
      .value,
    { version: 2 },
  );
});

test("larger or invalid markers refetch and probe failures return errors", async () => {
  const { cache, advance } = createCache();
  let loads = 0;
  const loader = async () => ({
    value: { version: ++loads },
    decodedBytes: 1,
  });
  const reload = {
    retainForMs: 300,
    validate: async () => ({ value: false, decodedBytes: 1 }),
  };
  await load(cache, "wishlist", null, {
    ttlMs: 60,
    validation: reload,
    loader,
  });
  advance(60);
  assert.deepEqual(
    (
      await load(cache, "wishlist", null, {
        ttlMs: 60,
        validation: reload,
        loader,
      })
    ).value,
    { version: 2 },
  );
  advance(60);
  await assert.rejects(
    load(cache, "wishlist", null, {
      ttlMs: 60,
      validation: {
        retainForMs: 300,
        validate: async () => {
          throw new Error("probe failed");
        },
      },
      loader,
    }),
    /probe failed/,
  );
  assert.equal(loads, 2);
});
