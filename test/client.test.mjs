import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildCacheKey,
  clearResponseCache,
  getResponseTtlMs,
  parseRetryAfter,
  requestWowAudit,
} from "../dist/client.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  clearResponseCache();
});

test("sends the team key only in the authorization header", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_BASE_URL = "https://api.example.test";
  let observed;
  globalThis.fetch = async (input, init) => {
    observed = { input: String(input), init };
    return new Response(JSON.stringify({ current_period: 123 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await requestWowAudit("/v1/period");
  assert.deepEqual(result, { current_period: 123 });
  assert.equal(observed.input, "https://api.example.test/v1/period");
  assert.equal(observed.init.headers.Authorization, "Bearer test-team-key");
  assert.doesNotMatch(observed.input, /test-team-key/);
});

test("blocks mutations before issuing a network request", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_ENABLE_WRITES = "false";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not run");
  };

  await assert.rejects(
    requestWowAudit("/v1/characters", {
      method: "POST",
      body: { name: "Example", realm: "Stormrage" },
    }),
    /write tools are disabled/,
  );
  assert.equal(called, false);
});

test("rejects oversized responses", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_MAX_RESPONSE_BYTES = "65536";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ value: "x".repeat(70_000) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    requestWowAudit("/v1/team"),
    /exceeded WOWAUDIT_MAX_RESPONSE_BYTES/,
  );
});

test("redacts the API key if an upstream error reflects it", async () => {
  process.env.WOWAUDIT_API_KEY = "sensitive-test-key";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ message: "Rejected sensitive-test-key credential" }),
      {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      },
    );

  await assert.rejects(requestWowAudit("/v1/team"), (error) => {
    assert.doesNotMatch(error.message, /sensitive-test-key/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("redacts the API key if the HTTP runtime rejects its exact value", async () => {
  process.env.WOWAUDIT_API_KEY = "key-with-\0-nul";
  globalThis.fetch = async () => {
    throw new TypeError("Invalid header value: Bearer key-with-\0-nul");
  };

  await assert.rejects(requestWowAudit("/v1/team"), (error) => {
    assert.doesNotMatch(error.message, /key-with-/);
    assert.match(error.message, /Bearer \[redacted\]/);
    return true;
  });
});

test("coalesces concurrent GETs and clones every returned value", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  let calls = 0;
  let resolveFetch;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => (resolveFetch = resolve));
    return Response.json({ nested: { value: 1 } });
  };

  const first = requestWowAudit("/v1/characters");
  const second = requestWowAudit("/v1/characters");
  resolveFetch();
  const [left, right] = await Promise.all([first, second]);
  left.nested.value = 9;
  assert.equal(right.nested.value, 1);
  assert.equal((await requestWowAudit("/v1/characters")).nested.value, 1);
  assert.equal(calls, 1);
});

test("omitted refresh and refresh false share the same completed key", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ version: calls });
  };
  assert.deepEqual(await requestWowAudit("/v1/period"), { version: 1 });
  assert.deepEqual(await requestWowAudit("/v1/period", { refresh: false }), {
    version: 1,
  });
  assert.deepEqual(await requestWowAudit("/v1/period", { refresh: true }), {
    version: 2,
  });
  assert.equal(calls, 2);
});

test("sorts query names and repeated values and omits known false defaults", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_BASE_URL = "https://api.example.test";
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ ok: true });
  };

  await requestWowAudit("/v1/raids", {
    query: { z: ["2", "1"], include_past: false, a: "3" },
  });
  await requestWowAudit("/v1/raids", {
    query: { a: "3", z: ["1", "2"] },
  });
  assert.deepEqual(urls, ["https://api.example.test/v1/raids?a=3&z=1&z=2"]);
  assert.equal(
    buildCacheKey(
      "/v1/example",
      new URLSearchParams("b=2&a=3&b=1&refresh=false"),
    ),
    "GET /v1/example?a=3&b=1&b=2",
  );
});

test("uses the required TTL for every endpoint category", () => {
  assert.deepEqual(
    [
      "/v1/team",
      "/v1/period",
      "/v1/characters",
      "/v1/characters/1",
      "/v1/historical_data",
      "/v1/historical_data/1",
      "/v1/attendance",
      "/v1/wishlists",
      "/v1/wishlists/1",
      "/v1/raids",
      "/v1/raids/1",
      "/v1/loot_history/1",
      "/v1/unknown",
    ].map(getResponseTtlMs),
    [
      600_000, 300_000, 300_000, 300_000, 120_000, 120_000, 120_000, 300_000,
      300_000, 30_000, 15_000, 120_000, 30_000,
    ],
  );
});

test("returns allowed responses above the cache entry limit uncached", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_CACHE_MAX_ENTRY_BYTES = "100";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ value: "x".repeat(1_000) });
  };
  await requestWowAudit("/v1/team");
  await requestWowAudit("/v1/team");
  assert.equal(calls, 2);
});

test("cancels a chunked response as soon as decoded bytes exceed the limit", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_MAX_RESPONSE_BYTES = "65536";
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(40_000));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );

  await assert.rejects(
    requestWowAudit("/v1/team"),
    /exceeded WOWAUDIT_MAX_RESPONSE_BYTES/,
  );
  assert.equal(cancelled, true);
});

test("preserves bounded plain text for non-JSON upstream errors", async () => {
  process.env.WOWAUDIT_API_KEY = "secret-key";
  globalThis.fetch = async () =>
    new Response(`Denied secret-key ${"detail ".repeat(100)}`, {
      status: 503,
      statusText: "Unavailable",
    });
  await assert.rejects(requestWowAudit("/v1/team"), (error) => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /secret-key/);
    assert.match(error.message, /Denied \[redacted\]/);
    assert.ok(error.message.length < 360);
    return true;
  });
});

test("classifies malformed successful JSON as an upstream protocol error", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  globalThis.fetch = async () => new Response("{broken", { status: 200 });
  await assert.rejects(requestWowAudit("/v1/team"), (error) => {
    assert.equal(error.status, 200);
    assert.match(error.message, /returned invalid JSON/);
    return true;
  });
});

test("parses and caps delta and HTTP-date Retry-After values", () => {
  const now = Date.parse("2026-08-20T10:00:00Z");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("1.2", now), 2);
  assert.equal(parseRetryAfter("7200", now), 3600);
  assert.equal(parseRetryAfter("Thu, 20 Aug 2026 10:00:01 GMT", now), 1);
  assert.equal(parseRetryAfter("Thu, 20 Aug 2026 12:00:00 GMT", now), 3600);
  assert.equal(parseRetryAfter("Thu, 20 Aug 2026 09:59:59 GMT", now), null);
  assert.equal(parseRetryAfter("invalid", now), null);
});

test("one request deadline covers waiting for response headers", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_REQUEST_TIMEOUT_MS = "5000";
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      ),
    );
  await assert.rejects(requestWowAudit("/v1/team"), /timed out after 5000ms/);
});

test("the same request deadline remains active during a stalled body", async () => {
  process.env.WOWAUDIT_API_KEY = "test-team-key";
  process.env.WOWAUDIT_REQUEST_TIMEOUT_MS = "5000";
  globalThis.fetch = async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":'));
          init.signal.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      }),
      { status: 200 },
    );
  await assert.rejects(requestWowAudit("/v1/team"), /body timed out/);
});
