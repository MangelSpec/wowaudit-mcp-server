import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverEntry = path.resolve("dist/index.js");
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

async function connect(mode, env = {}) {
  const client = new Client(
    { name: `wowaudit-test-${mode}`, version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StdioClientTransport({
      args: [serverEntry],
      command: process.execPath,
      env: {
        ...process.env,
        WOWAUDIT_API_KEY: "",
        WOWAUDIT_ENABLE_APPLICATIONS: "false",
        WOWAUDIT_ENABLE_WRITES: "false",
        ...env,
      },
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
