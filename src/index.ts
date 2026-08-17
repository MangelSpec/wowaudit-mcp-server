import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { Server, type CallToolRequest } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { WowAuditApiError } from "./client.js";
import { err, ok } from "./toolResult.js";
import { findTool, TOOLS } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../.env") });

export function createServer(): Server {
  const server = new Server(
    { name: "wowaudit-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({ tools: TOOLS }));
  server.setRequestHandler("tools/call", handleToolCall);
  return server;
}

async function handleToolCall(request: CallToolRequest) {
  const descriptor = findTool(request.params.name);
  if (!descriptor) return err(`Unknown tool: ${request.params.name}`);

  const rawArgs = request.params.arguments ?? {};
  const args = rawArgs as Record<string, unknown>;
  try {
    return ok(await descriptor.execute(args));
  } catch (error) {
    if (error instanceof WowAuditApiError) {
      return err(error.message, {
        kind:
          error.status === 429
            ? "rate_limit"
            : error.status === null
              ? "network"
              : "upstream",
        status: error.status,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    return err(error instanceof Error ? error.message : String(error));
  }
}

function main(): void {
  serveStdio(createServer, {
    legacy: "serve",
    onerror: (error) => console.error("MCP server error:", error),
  });
  console.error(
    `wowaudit-mcp-server running on stdio (${TOOLS.length} tools; writes ${
      process.env.WOWAUDIT_ENABLE_WRITES === "true" ? "enabled" : "disabled"
    }; applications ${
      process.env.WOWAUDIT_ENABLE_APPLICATIONS === "true"
        ? "enabled"
        : "disabled"
    })`,
  );
}

try {
  main();
} catch (error) {
  console.error("Fatal error starting wowaudit-mcp-server:", error);
  process.exit(1);
}
