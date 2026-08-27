# AI Studio Connector

Connector runs on each user's own macOS or Windows computer. It keeps Codex credentials local and only exchanges prompts/results with AI Studio Server.

Requirements: Bun 1.0+, Codex CLI, and an existing local `codex login` session. Startup checks `codex --version` and `codex login status`; an unauthenticated machine exits with `Codex 尚未登录，请先完成本机 Codex 登录。`.

```bash
cd connector
export AI_STUDIO_SERVER_URL="https://studio.example.com"
bun run start
```

On first start, create a pairing code in **Settings → Devices → Add Device** and enter the six digits. The returned device token is stored only in `~/.ai-studio-connector/device.json` with owner-only permissions. Codex `auth.json`, access tokens and refresh tokens are never sent to Server.

For unattended setup, `AI_STUDIO_PAIRING_CODE`, `AI_STUDIO_DEVICE_NAME`, `CODEX_BINARY_PATH`, and `AI_STUDIO_CODEX_CWD` can be supplied as environment variables. `CONNECTOR_WS_URL` optionally overrides the WebSocket endpoint and supports both `ws://` and `wss://`; otherwise it is derived from `AI_STUDIO_SERVER_URL` or the pairing response.

Timeouts are independent and may be overridden with environment variables:

- `CONNECT_TIMEOUT_MS=15000` — Connector WebSocket connect/authentication deadline.
- `REQUEST_ACK_TIMEOUT_MS=10000` — Server deadline for the immediate `execution_ack` and Codex app-server RPC acknowledgements.
- `EXECUTION_TIMEOUT_MS=300000` — maximum duration of one Codex model turn on Connector.
- `SERVER_PENDING_TIMEOUT_MS=330000` — Server deadline for the final `execution_result` after dispatch.

The Connector sends `execution_ack` before starting Codex, keeps heartbeat traffic independent from model execution, and never retries a model turn for the same `request_id`.

Reusable core modules live under `src/codex`, `src/connection`, `src/pairing`, `src/execution`, `src/state`, and `src/config`. The CLI entry point is only `src/main.ts`, so a future Tauri shell can subscribe to the same state store and call the same services.

Runtime state values:

- `SERVER_DISCONNECTED` / `SERVER_CONNECTED`
- `CODEX_NOT_FOUND` / `CODEX_NOT_LOGGED_IN` / `CODEX_READY`
- `EXECUTION_IDLE` / `EXECUTION_RUNNING` / `EXECUTION_ERROR`

Execution logs include only request, conversation, agent and status identifiers. They never print the full prompt or local Codex credentials.
