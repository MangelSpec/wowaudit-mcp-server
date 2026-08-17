import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (!process.env.WOWAUDIT_API_KEY) {
  console.error("Set WOWAUDIT_API_KEY before running the live smoke test.");
  process.exit(1);
}

const client = new Client(
  { name: "wowaudit-live-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);

await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/index.js")],
    env: { ...process.env },
    stderr: "pipe",
  }),
  { timeout: 10_000 },
);

try {
  const { tools } = await client.listTools();
  console.log(
    `Connected using ${client.getProtocolEra()} MCP; ${tools.length} tools.`,
  );

  for (const name of [
    "wowaudit_get_team",
    "wowaudit_get_period",
    "wowaudit_list_characters",
    "wowaudit_list_raids",
  ]) {
    const result = await client.callTool({
      name,
      arguments: name.startsWith("wowaudit_list_") ? { limit: 3 } : {},
    });
    if (result.isError) {
      throw new Error(`${name}: ${result.content[0]?.text ?? "unknown error"}`);
    }
    console.log(`${name}: ok`);
  }
} finally {
  await client.close();
}
