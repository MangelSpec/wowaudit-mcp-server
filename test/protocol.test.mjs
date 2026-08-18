import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverEntry = path.resolve("dist/index.js");
const fdLauncherEntry = path.resolve("scripts/test-fd-launcher.mjs");
const expectedReadTools = [
  "wowaudit_get_attendance",
  "wowaudit_get_character_history",
  "wowaudit_get_character_wishlist",
  "wowaudit_get_loot_history",
  "wowaudit_get_period",
  "wowaudit_get_raid",
  "wowaudit_get_team",
  "wowaudit_list_characters",
  "wowaudit_list_historical_data",
  "wowaudit_list_raids",
  "wowaudit_list_wishlists",
];
const expectedTools = [
  "wowaudit_create_raid",
  "wowaudit_delete_application",
  "wowaudit_delete_raid",
  "wowaudit_delete_wishlist",
  "wowaudit_get_application",
  "wowaudit_get_attendance",
  "wowaudit_get_character_history",
  "wowaudit_get_character_wishlist",
  "wowaudit_get_loot_history",
  "wowaudit_get_period",
  "wowaudit_get_raid",
  "wowaudit_get_team",
  "wowaudit_list_applications",
  "wowaudit_list_characters",
  "wowaudit_list_historical_data",
  "wowaudit_list_raids",
  "wowaudit_list_wishlists",
  "wowaudit_track_character",
  "wowaudit_untrack_character",
  "wowaudit_update_application",
  "wowaudit_update_character",
  "wowaudit_update_raid",
  "wowaudit_upload_wishlist",
];
const expectedRaidLensMutations = [
  "wowaudit_create_raid",
  "wowaudit_track_character",
  "wowaudit_update_character",
  "wowaudit_update_raid",
  "wowaudit_upload_wishlist",
];
const expectedRaidLensTools = [
  ...expectedReadTools,
  ...expectedRaidLensMutations,
].sort();
const deniedRaidLensTools = expectedTools.filter(
  (name) => !expectedRaidLensTools.includes(name),
);
const dispatchedRaidLensMutations = [
  ["wowaudit_create_raid", {}],
  ["wowaudit_track_character", {}],
  ["wowaudit_update_character", {}],
  ["wowaudit_update_raid", {}],
  ["wowaudit_upload_wishlist", {}],
];

async function connect(mode, env = {}, fdKeyPath) {
  const client = new Client(
    { name: `wowaudit-test-${mode}`, version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  const childEnv = {
    ...process.env,
    WOWAUDIT_API_KEY: "",
    WOWAUDIT_API_KEY_FD: "",
    WOWAUDIT_ENABLE_APPLICATIONS: "false",
    WOWAUDIT_ENABLE_WRITES: "false",
    WOWAUDIT_WRITE_POLICY: "",
    ...env,
  };
  if (fdKeyPath) {
    delete childEnv.WOWAUDIT_API_KEY;
    childEnv.WOWAUDIT_API_KEY_FD = "3";
    childEnv.WOWAUDIT_TEST_API_KEY_PATH = fdKeyPath;
  }
  await client.connect(
    new StdioClientTransport({
      args: fdKeyPath ? [fdLauncherEntry, serverEntry] : [serverEntry],
      command: process.execPath,
      env: childEnv,
      stderr: "pipe",
    }),
    { timeout: 10_000 },
  );
  return client;
}

for (const mode of ["auto", "legacy"]) {
  test(`lists only read-only tools for ${mode} clients by default`, async () => {
    const client = await connect(mode);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 11);
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        expectedReadTools,
      );
      assert.ok(tools.every((tool) => tool.outputSchema?.type === "object"));
      assert.ok(tools.every((tool) => tool.name.startsWith("wowaudit_")));
      assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));

      const roster = tools.find(
        (tool) => tool.name === "wowaudit_list_characters",
      );
      assert.equal(roster?.annotations?.readOnlyHint, true);
      assert.equal(roster?.inputSchema.properties.limit.maximum, 500);
      assert.equal(
        client.getProtocolEra(),
        mode === "auto" ? "modern" : "legacy",
      );
    } finally {
      await client.close();
    }
  });
}

test("registers the complete surface only when both feature gates are enabled", async () => {
  const client = await connect("auto", {
    WOWAUDIT_API_KEY: "test-key",
    WOWAUDIT_ENABLE_APPLICATIONS: "true",
    WOWAUDIT_ENABLE_WRITES: "true",
  });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 23);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedTools);

    const deleteRaid = tools.find(
      (tool) => tool.name === "wowaudit_delete_raid",
    );
    assert.equal(deleteRaid?.annotations?.destructiveHint, true);
    assert.equal(deleteRaid?.inputSchema.properties.confirm.const, true);
    assert.deepEqual(deleteRaid?.inputSchema.required, ["id", "confirm"]);
  } finally {
    await client.close();
  }
});

test("RaidLens policy exposes its complete fixed tool surface", async () => {
  const client = await connect("auto", {
    WOWAUDIT_API_KEY: "test-key",
    WOWAUDIT_ENABLE_APPLICATIONS: "true",
    WOWAUDIT_ENABLE_WRITES: "true",
    WOWAUDIT_WRITE_POLICY: "raidlens-create-update-v1",
  });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      expectedRaidLensTools,
    );
    assert.equal(
      tools.some((tool) => tool.name.includes("application")),
      false,
    );
  } finally {
    await client.close();
  }
});

test("RaidLens policy preserves read-only mode when writes are disabled", async () => {
  const client = await connect("auto", {
    WOWAUDIT_API_KEY: "test-key",
    WOWAUDIT_ENABLE_WRITES: "false",
    WOWAUDIT_WRITE_POLICY: "raidlens-create-update-v1",
  });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedReadTools);
  } finally {
    await client.close();
  }
});

test("RaidLens policy dispatches each permitted mutation", async () => {
  const client = await connect("auto", {
    WOWAUDIT_API_KEY: "test-key",
    WOWAUDIT_ENABLE_WRITES: "true",
    WOWAUDIT_WRITE_POLICY: "raidlens-create-update-v1",
  });
  try {
    for (const [name, args] of dispatchedRaidLensMutations) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.doesNotMatch(result.structuredContent.error, /Unknown tool/, name);
      assert.match(result.structuredContent.error, /^(Argument|Either) /, name);
    }
  } finally {
    await client.close();
  }
});

test("RaidLens policy rejects direct dispatch outside its complete surface", async () => {
  const client = await connect("auto", {
    WOWAUDIT_API_KEY: "test-key",
    WOWAUDIT_ENABLE_APPLICATIONS: "true",
    WOWAUDIT_ENABLE_WRITES: "true",
    WOWAUDIT_WRITE_POLICY: "raidlens-create-update-v1",
  });
  try {
    for (const name of deniedRaidLensTools) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
      assert.match(result.structuredContent.error, /Unknown tool/, name);
    }
  } finally {
    await client.close();
  }
});

test("uses inherited FD 3 and preserves the canonical team envelope", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "wowaudit-protocol-key-"));
  const keyPath = path.join(directory, "key");
  writeFileSync(keyPath, Buffer.from("fd-protocol-key", "utf8"));

  let authorization;
  const upstream = createHttpServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "RaidLens Team", id: 42 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const client = await connect(
    "auto",
    { WOWAUDIT_BASE_URL: `http://127.0.0.1:${address.port}` },
    keyPath,
  );
  try {
    const result = await client.callTool({
      name: "wowaudit_get_team",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      data: { name: "RaidLens Team", id: 42 },
      meta: { endpoint: "/v1/team", method: "GET" },
    });
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );
    assert.equal(authorization, "Bearer fd-protocol-key");
  } finally {
    await client.close();
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returns structured configuration errors with a text fallback", async () => {
  const client = await connect("auto");
  try {
    const result = await client.callTool({
      name: "wowaudit_get_team",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /Missing WOWAUDIT_API_KEY/);
    assert.match(result.content[0]?.text ?? "", /^Error:/);
  } finally {
    await client.close();
  }
});

test("does not advertise or dispatch writes unless explicitly enabled", async () => {
  const client = await connect("auto", { WOWAUDIT_API_KEY: "test-key" });
  try {
    const { tools } = await client.listTools();
    assert.equal(
      tools.some((tool) => tool.name === "wowaudit_track_character"),
      false,
    );
    const result = await client.callTool({
      name: "wowaudit_track_character",
      arguments: { name: "Example", realm: "Stormrage" },
    });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /Unknown tool/);
  } finally {
    await client.close();
  }
});

test("does not advertise or dispatch applications unless explicitly enabled", async () => {
  const client = await connect("auto", { WOWAUDIT_API_KEY: "test-key" });
  try {
    const { tools } = await client.listTools();
    assert.equal(
      tools.some((tool) => tool.name === "wowaudit_list_applications"),
      false,
    );
    const result = await client.callTool({
      name: "wowaudit_list_applications",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /Unknown tool/);
  } finally {
    await client.close();
  }
});
