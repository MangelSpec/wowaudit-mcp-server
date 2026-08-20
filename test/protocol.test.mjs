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
  "wowaudit_find_wishlisted_item",
  "wowaudit_get_attendance",
  "wowaudit_get_character_history",
  "wowaudit_get_character_wishlist",
  "wowaudit_get_loot_history",
  "wowaudit_get_period",
  "wowaudit_get_raid",
  "wowaudit_get_team",
  "wowaudit_get_weekly_roster_summary",
  "wowaudit_list_characters",
  "wowaudit_list_historical_data",
  "wowaudit_list_raids",
  "wowaudit_list_wishlist_items",
  "wowaudit_list_wishlists",
];
const expectedTools = [
  "wowaudit_create_raid",
  "wowaudit_delete_application",
  "wowaudit_delete_raid",
  "wowaudit_delete_wishlist",
  "wowaudit_find_wishlisted_item",
  "wowaudit_get_application",
  "wowaudit_get_attendance",
  "wowaudit_get_character_history",
  "wowaudit_get_character_wishlist",
  "wowaudit_get_loot_history",
  "wowaudit_get_period",
  "wowaudit_get_raid",
  "wowaudit_get_team",
  "wowaudit_get_weekly_roster_summary",
  "wowaudit_list_applications",
  "wowaudit_list_characters",
  "wowaudit_list_historical_data",
  "wowaudit_list_raids",
  "wowaudit_list_wishlist_items",
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

async function connect(mode, env = {}, fdKeyPath, onStderr) {
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
  const transport = new StdioClientTransport({
    args: fdKeyPath ? [fdLauncherEntry, serverEntry] : [serverEntry],
    command: process.execPath,
    env: childEnv,
    stderr: "pipe",
  });
  if (onStderr) transport.stderr.on("data", onStderr);
  await client.connect(transport, { timeout: 10_000 });
  return client;
}

for (const mode of ["auto", "legacy"]) {
  test(`lists only read-only tools for ${mode} clients by default`, async () => {
    const client = await connect(mode);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 14);
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
      const team = tools.find((tool) => tool.name === "wowaudit_get_team");
      assert.equal(roster?.annotations?.readOnlyHint, true);
      assert.equal(roster?.inputSchema.properties.limit.maximum, 500);
      assert.deepEqual(team?.outputSchema.properties.data.required, [
        "teamId",
        "teamDisplayName",
      ]);
      assert.equal(
        team?.outputSchema.properties.data.properties.teamId.maxLength,
        128,
      );
      assert.equal(
        team?.outputSchema.properties.data.properties.teamDisplayName.maxLength,
        200,
      );
      assert.equal(
        team?.outputSchema.properties.data.additionalProperties,
        false,
      );
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
    assert.equal(tools.length, 26);
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

test("reuses inherited FD 3 for multiple authenticated requests without logging it", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "wowaudit-protocol-key-"));
  const keyPath = path.join(directory, "key");
  const apiKey = "fd-protocol-key";
  writeFileSync(keyPath, Buffer.from(apiKey, "utf8"));

  const requests = [];
  const upstream = createHttpServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/v1/team"
          ? { name: "RaidLens Team", id: 42, private: "not-canonical" }
          : { current_period: 123 },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  let stderr = "";
  const client = await connect(
    "auto",
    { WOWAUDIT_BASE_URL: `http://127.0.0.1:${address.port}` },
    keyPath,
    (chunk) => {
      stderr += chunk.toString();
    },
  );
  try {
    const teamResult = await client.callTool({
      name: "wowaudit_get_team",
      arguments: {},
    });
    const periodResult = await client.callTool({
      name: "wowaudit_get_period",
      arguments: {},
    });
    assert.equal(teamResult.isError, undefined);
    assert.deepEqual(teamResult.structuredContent, {
      data: { teamId: "42", teamDisplayName: "RaidLens Team" },
      meta: { endpoint: "/v1/team", method: "GET" },
    });
    assert.deepEqual(
      JSON.parse(teamResult.content[0].text),
      teamResult.structuredContent,
    );
    assert.equal(periodResult.isError, undefined);
    assert.deepEqual(
      requests,
      ["/v1/team", "/v1/period"].map((url) => ({
        authorization: `Bearer ${apiKey}`,
        url,
      })),
    );
    assert.doesNotMatch(stderr, new RegExp(apiKey));
  } finally {
    await client.close();
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returns compact guild-wide wishlist and weekly roster projections", async () => {
  const requests = [];
  const upstream = createHttpServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/period") {
      response.end(JSON.stringify({ current_period: 1077 }));
      return;
    }
    if (request.url === "/v1/historical_data?period=1077") {
      response.end(
        JSON.stringify({
          characters: [
            {
              id: 1,
              name: "Anna",
              realm: "Example",
              data: {
                dungeons_done: [{ level: 12, dungeon: 1 }],
                world_quests_done: 7,
                vault_options: { dungeons: { option_1: 324 } },
              },
            },
          ],
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        characters: [
          {
            id: 1,
            name: "Anna",
            realm: "Example",
            wishlists: [
              {
                name: "Raid",
                instances: [
                  {
                    name: "Test Raid",
                    difficulties: [
                      {
                        difficulty: "mythic",
                        wishlist: {
                          wishlist: {
                            encounters: [
                              {
                                name: "Test Boss",
                                items: [
                                  {
                                    id: 100,
                                    name: "Heart of Tests",
                                    slot: "trinket",
                                    wishes: [
                                      {
                                        specialization: "Holy",
                                        weight: 1,
                                        percentage: 1.25,
                                        absolute: null,
                                        upgrade: null,
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const client = await connect("auto", {
    WOWAUDIT_API_KEY: "test-key",
    WOWAUDIT_BASE_URL: `http://127.0.0.1:${address.port}`,
  });
  try {
    const wishlist = await client.callTool({
      name: "wowaudit_find_wishlisted_item",
      arguments: { itemName: "Heart of Tests" },
    });
    assert.equal(wishlist.isError, undefined);
    assert.deepEqual(wishlist.structuredContent.data.matches, [
      {
        characterId: 1,
        characterName: "Anna",
        realm: "Example",
        configuration: "Raid",
        instance: "Test Raid",
        difficulty: "mythic",
        encounter: "Test Boss",
        itemId: 100,
        itemName: "Heart of Tests",
        slot: "trinket",
        specialization: "Holy",
        weight: 1,
        percentage: 1.25,
        absolute: null,
        upgrade: null,
      },
    ]);

    const weekly = await client.callTool({
      name: "wowaudit_get_weekly_roster_summary",
      arguments: {},
    });
    assert.equal(weekly.isError, undefined);
    assert.equal(weekly.structuredContent.data.period, 1077);
    assert.equal(
      weekly.structuredContent.data.characters[0].highestDungeonLevel,
      12,
    );
    assert.equal(
      weekly.structuredContent.data.characters[0].vault.dungeons.unlockedCount,
      1,
    );
    assert.deepEqual(requests, [
      "/v1/wishlists",
      "/v1/period",
      "/v1/historical_data?period=1077",
    ]);
  } finally {
    await client.close();
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const [label, payload, message] of [
  [
    "an unsafe numeric id",
    { id: Number.MAX_SAFE_INTEGER + 1, name: "RaidLens Team" },
    /team response id must be a positive integer/,
  ],
  [
    "an overlong display name",
    { id: 42, name: "x".repeat(201) },
    /team response name must be between 1 and 200 characters/,
  ],
]) {
  test(`rejects a WoWAudit team response with ${label}`, async () => {
    const upstream = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address === "object");

    const client = await connect("auto", {
      WOWAUDIT_API_KEY: "test-key",
      WOWAUDIT_BASE_URL: `http://127.0.0.1:${address.port}`,
    });
    try {
      const result = await client.callTool({
        name: "wowaudit_get_team",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.match(result.structuredContent.error, message);
    } finally {
      await client.close();
      await new Promise((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

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
