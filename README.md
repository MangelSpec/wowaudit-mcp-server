# wowaudit-mcp-server

MCP server for the documented [WoWAudit API](https://wowaudit.com/api). It exposes guild roster, raid planning, attendance, weekly activity, wishlists, loot history, and applications as structured tools for Raid Lens and other MCP clients.

The server uses stdio and `@modelcontextprotocol/server` 2.x. It serves the current MCP protocol and retains the SDK's legacy 2025-era initialize handshake for older clients. Every result includes native `structuredContent` plus the same JSON as a text block for clients that do not consume structured results.

## Requirements

- Node.js 20 or newer.
- A WoWAudit team API key. An administrator can retrieve it from <https://wowaudit.com/api>.

## Setup

```bash
npm install
```

Create `.env` from `.env.example`, then set:

```dotenv
WOWAUDIT_API_KEY=your-team-api-key
```

Build the server:

```bash
npm run build
```

The API key is loaded lazily, so the MCP process can start and list tools without a configured key. API calls return a structured configuration error until the key is available.

## MCP client configuration

Use the compiled entry point from an MCP client:

```json
{
  "mcpServers": {
    "wowaudit": {
      "command": "node",
      "args": [
        "C:\\programming\\typescript\\wowaudit-mcp-server\\dist\\index.js"
      ]
    }
  }
}
```

The server resolves `.env` relative to its installed location, not the MCP client's working directory. Credentials may instead be supplied through the client's `env` configuration.

## Security model

A WoWAudit team API key can access the team's entire environment. The server applies these safeguards:

- The key is sent only as an `Authorization: Bearer` header. It is never put in a URL, result, or error.
- Only documented `/v1/` routes are available. There is no arbitrary HTTP tool.
- Writes are disabled unless `WOWAUDIT_ENABLE_WRITES=true`.
- Destructive delete tools additionally require `confirm: true` on each call.
- Application tools are disabled unless `WOWAUDIT_ENABLE_APPLICATIONS=true` because applications may contain identities, questionnaire answers, and uploaded-file URLs.
- Tool annotations identify read-only, idempotent, and destructive operations to modern MCP clients.
- Responses are limited to 2 MiB by default. Adjust `WOWAUDIT_MAX_RESPONSE_BYTES` only when necessary.
- GET responses are cached in process for 30 seconds. Successful writes clear the cache.

Enabling application tools does not provide channel authorization. A Discord integration must enforce officer-only access before exposing those tools. Similarly, a multi-guild bot must bind its trusted Discord guild ID to the correct WoWAudit credential outside model-controlled tool arguments.

## Configuration

| Variable                       |                    Default | Purpose                                 |
| ------------------------------ | -------------------------: | --------------------------------------- |
| `WOWAUDIT_API_KEY`             |     required for API calls | Team API key                            |
| `WOWAUDIT_BASE_URL`            | `https://api.wowaudit.com` | API origin                              |
| `WOWAUDIT_REQUEST_TIMEOUT_MS`  |                    `30000` | Request timeout, 5,000 to 120,000 ms    |
| `WOWAUDIT_MAX_RESPONSE_BYTES`  |                  `2097152` | Maximum JSON response, 64 KiB to 10 MiB |
| `WOWAUDIT_ENABLE_WRITES`       |                    `false` | Permit POST, PUT, and DELETE tools      |
| `WOWAUDIT_ENABLE_APPLICATIONS` |                    `false` | Permit sensitive application tools      |

## Tools

### Team and roster

| Tool                         | API operation                |
| ---------------------------- | ---------------------------- |
| `wowaudit_get_team`          | `GET /v1/team`               |
| `wowaudit_get_period`        | `GET /v1/period`             |
| `wowaudit_list_characters`   | `GET /v1/characters`         |
| `wowaudit_track_character`   | `POST /v1/characters`        |
| `wowaudit_update_character`  | `PUT /v1/characters/{id}`    |
| `wowaudit_untrack_character` | `DELETE /v1/characters/{id}` |

### Activity and attendance

| Tool                             | API operation                  |
| -------------------------------- | ------------------------------ |
| `wowaudit_list_historical_data`  | `GET /v1/historical_data`      |
| `wowaudit_get_character_history` | `GET /v1/historical_data/{id}` |
| `wowaudit_get_attendance`        | `GET /v1/attendance`           |

### Raids and signups

| Tool                   | API operation           |
| ---------------------- | ----------------------- |
| `wowaudit_list_raids`  | `GET /v1/raids`         |
| `wowaudit_get_raid`    | `GET /v1/raids/{id}`    |
| `wowaudit_create_raid` | `POST /v1/raids`        |
| `wowaudit_update_raid` | `PUT /v1/raids/{id}`    |
| `wowaudit_delete_raid` | `DELETE /v1/raids/{id}` |

`wowaudit_update_raid` supports status and schedule changes, encounter enable/disable lists, signup statuses, comments, role/class overrides, selected status, and encounter-specific selections.

### Wishlists and loot

| Tool                              | API operation                     |
| --------------------------------- | --------------------------------- |
| `wowaudit_list_wishlists`         | `GET /v1/wishlists`               |
| `wowaudit_get_character_wishlist` | `GET /v1/wishlists/{id}`          |
| `wowaudit_upload_wishlist`        | `POST /v1/wishlists`              |
| `wowaudit_delete_wishlist`        | `DELETE /v1/wishlists/{id}`       |
| `wowaudit_get_loot_history`       | `GET /v1/loot_history/{seasonId}` |

The all-character wishlist and loot endpoints can be large. Prefer character-specific calls and use `limit` on collection tools where possible.

### Applications

| Tool                          | API operation                  |
| ----------------------------- | ------------------------------ |
| `wowaudit_list_applications`  | `GET /v1/applications`         |
| `wowaudit_get_application`    | `GET /v1/applications/{id}`    |
| `wowaudit_update_application` | `PUT /v1/applications/{id}`    |
| `wowaudit_delete_application` | `DELETE /v1/applications/{id}` |

Applications are separately gated by `WOWAUDIT_ENABLE_APPLICATIONS=true`. Mutating them also requires `WOWAUDIT_ENABLE_WRITES=true`.

## Result envelope

Successful tools return:

```json
{
  "data": {},
  "meta": {
    "endpoint": "/v1/team",
    "method": "GET"
  }
}
```

Collection tools accepting `limit` additionally report `totalItems`, `returnedItems`, and `truncated`. The limit is applied after WoWAudit responds because the public API does not document server-side pagination.

Errors return `isError: true`, structured `{ "error": "..." }`, and a text fallback. Upstream errors also include `kind`, HTTP `status`, and `retryAfterSeconds` when available.

## Development

```bash
npm run dev
npm test
```

Tests compile the server, verify both modern and legacy protocol negotiation, inspect all tool schemas and annotations, exercise security gates, and test the HTTP client without using a real API key.

For a small live read-only check:

```bash
npm run test:live
```

The live smoke test calls team, period, roster, and raid-list endpoints. It never invokes application or write tools.

## WoWAudit API caveats

- The public documentation defines no pagination or rate-limit contract.
- The documentation primarily supplies response examples rather than strict reusable schemas, so payload fields may evolve.
- The embedded documentation contains a development-looking server URL. This project uses the confirmed production origin `https://api.wowaudit.com` by default.
- WoWAudit accepts an API key in a query parameter, but this server deliberately uses only the authorization header to reduce credential leakage.

## License

[MIT](LICENSE), copyright WoWAudit MCP Server contributors.
