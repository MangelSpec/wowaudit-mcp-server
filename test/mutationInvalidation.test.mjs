import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { clearResponseCache, requestWowAudit } from "../dist/client.js";
import { findTool } from "../dist/tools.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  clearResponseCache();
});

for (const [label, mutationResponse] of [
  [
    "4xx",
    async () => new Response('{"message":"bad request"}', { status: 400 }),
  ],
  [
    "5xx",
    async () => new Response('{"message":"unavailable"}', { status: 503 }),
  ],
  ["malformed response", async () => new Response("{broken", { status: 200 })],
  [
    "transport uncertainty",
    async () => {
      throw new TypeError("connection reset");
    },
  ],
]) {
  test(`invalidates before dispatch for a mutation ending in ${label}`, async () => {
    process.env.WOWAUDIT_API_KEY = "test-key";
    process.env.WOWAUDIT_ENABLE_WRITES = "true";
    let calls = 0;
    globalThis.fetch = async (...args) => {
      calls += 1;
      if (calls === 1) return Response.json({ characters: ["old"] });
      if (calls === 2) return mutationResponse(...args);
      return Response.json({ characters: ["new"] });
    };

    await requestWowAudit("/v1/characters");
    await assert.rejects(
      requestWowAudit("/v1/characters/1", {
        method: "PUT",
        body: { role: "Tank" },
      }),
    );
    assert.deepEqual(await requestWowAudit("/v1/characters"), {
      characters: ["new"],
    });
    assert.equal(calls, 3);
  });
}

test("invalidates before dispatch when a mutation times out", async () => {
  process.env.WOWAUDIT_API_KEY = "test-key";
  process.env.WOWAUDIT_ENABLE_WRITES = "true";
  process.env.WOWAUDIT_REQUEST_TIMEOUT_MS = "5000";
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) return Response.json({ raids: ["old"] });
    if (calls === 2) {
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    }
    return Response.json({ raids: ["new"] });
  };
  await requestWowAudit("/v1/raids");
  await assert.rejects(
    requestWowAudit("/v1/raids/1", {
      method: "PUT",
      body: { status: "Locked" },
    }),
    /timed out/,
  );
  assert.deepEqual(await requestWowAudit("/v1/raids"), { raids: ["new"] });
  assert.equal(calls, 3);
});

test("a successful mutation invalidates affected completed reads", async () => {
  process.env.WOWAUDIT_API_KEY = "test-key";
  process.env.WOWAUDIT_ENABLE_WRITES = "true";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return Response.json({ characters: ["old"] });
    if (calls === 2) return Response.json({ updated: true });
    return Response.json({ characters: ["new"] });
  };
  await requestWowAudit("/v1/characters");
  await requestWowAudit("/v1/characters/1", {
    method: "PUT",
    body: { role: "Tank" },
  });
  assert.deepEqual(await requestWowAudit("/v1/characters"), {
    characters: ["new"],
  });
  assert.equal(calls, 3);
});

test("local validation rejection does not invalidate completed reads", async () => {
  process.env.WOWAUDIT_API_KEY = "test-key";
  process.env.WOWAUDIT_ENABLE_WRITES = "true";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ characters: ["cached"] });
  };
  await requestWowAudit("/v1/characters");
  const mutation = findTool("wowaudit_update_character");
  assert.ok(mutation);
  await assert.rejects(mutation.execute({ id: 1 }), /At least one field/);
  assert.deepEqual(await requestWowAudit("/v1/characters"), {
    characters: ["cached"],
  });
  assert.equal(calls, 1);
});
