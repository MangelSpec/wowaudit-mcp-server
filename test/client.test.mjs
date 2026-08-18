import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { clearResponseCache, requestWowAudit } from "../dist/client.js";

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
