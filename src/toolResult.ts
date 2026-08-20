import type { CallToolResult } from "@modelcontextprotocol/server";

import type { CacheTelemetry } from "./cacheTelemetry.js";

export function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function err(
  message: string,
  details?: Record<string, unknown>,
): CallToolResult {
  const structuredContent = { error: message, ...details };
  return {
    content: [
      {
        type: "text",
        text: details
          ? JSON.stringify(structuredContent, null, 2)
          : `Error: ${message}`,
      },
    ],
    isError: true,
    structuredContent,
  };
}

export function attachCacheTelemetry(
  result: CallToolResult,
  telemetry: CacheTelemetry | undefined,
): CallToolResult {
  return telemetry
    ? { ...result, _meta: { ...result._meta, "raidlens/cache": telemetry } }
    : result;
}
