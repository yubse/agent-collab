# AI Studio Connector

AI Studio Helper is the headless Connector that runs continuously on each user's computer. It keeps Codex credentials local and only exchanges prompts/results with AI Studio Server.

Requirements for development are Bun 1.0+ and Codex CLI. The standalone build does not require Bun or Node on the user's computer. Helper stays online when Codex is missing or logged out and reports `CODEX_NOT_INSTALLED`, `CODEX_NOT_LOGGED_IN`, or `CODEX_READY` through its non-sensitive status API.

```bash
cd connector
export AI_STUDIO_SERVER_URL="https://studio.example.com"
bun run start
```

Helper listens only on `127.0.0.1:39481`. `GET /status` reports Helper/device/Codex readiness without credentials. Web uses its authenticated Session to create a 60-second, single-use claim and sends only `claim_token` to `POST /claim`. Helper exchanges it with Server, saves the resulting device credential to `~/.ai-studio/connector.json` with mode `0600`, and starts the existing authenticated WebSocket loop. A stable local `device_id` prevents duplicate device rows. Codex `auth.json`, access tokens and refresh tokens are never read or sent to Server.

CORS uses one exact `AI_STUDIO_WEB_ORIGIN`; wildcard origins are never emitted. OPTIONS responses include standard CORS headers plus `Access-Control-Allow-Private-Network: true` for Chromium Private Network Access. Chrome and Edge use that preflight; Safari uses the same exact-Origin CORS response and safely ignores the Chromium-specific header.

CLI development mode can still inject a claim token directly:

```bash
bun run start -- --pair-token '<development-token>'
```

`AI_STUDIO_PAIRING_TOKEN`, `AI_STUDIO_DEVICE_NAME`, `CODEX_BINARY_PATH`, and `AI_STUDIO_CODEX_CWD` may also be supplied in development. `AI_STUDIO_WEB_ORIGIN` controls the one allowed CORS Origin and defaults to the Server origin. `CONNECTOR_WS_URL` optionally overrides the WebSocket endpoint and supports `ws://` and `wss://`. The current Profile Selector is a Trusted LAN MVP: anyone able to select 文一、Tina or 刘婷 can initiate a claim for that Profile. Device-bound Passwordless Login is intentionally deferred.

### macOS background installation

```bash
connector/scripts/build-standalone.sh
AI_STUDIO_SERVER_URL='http://192.168.20.200:3998' \
AI_STUDIO_WEB_ORIGIN='http://192.168.20.200:3998' \
connector/scripts/install-helper.sh
```

The installer copies the standalone executable to `~/.ai-studio/bin/`, writes `~/Library/LaunchAgents/com.aistudio.connector.plist`, and enables `RunAtLoad` plus `KeepAlive`. Uninstall with `connector/scripts/uninstall-helper.sh`; it preserves `~/.ai-studio/connector.json` and all Codex authentication data.

Timeouts are independent and may be overridden with environment variables:

- `CONNECT_TIMEOUT_MS=15000` — Connector WebSocket connect/authentication deadline.
- `REQUEST_ACK_TIMEOUT_MS=10000` — Server deadline for the immediate `execution_ack` and Codex app-server RPC acknowledgements.
- `EXECUTION_TIMEOUT_MS=300000` — maximum duration of one Codex model turn on Connector.
- `SERVER_PENDING_TIMEOUT_MS=330000` — Server deadline for the final `execution_result` after dispatch.

The Connector sends `execution_ack` before starting Codex, keeps heartbeat traffic independent from model execution, and never retries a model turn for the same `request_id`. One long-lived `codex app-server --listen stdio://` process is shared by serialized turns; each conversation/Agent retains its own Codex thread. A crash is warmed up again automatically or restarted by the next request.

Reusable core modules live under `src/codex`, `src/connection`, `src/pairing`, `src/helper`, `src/execution`, `src/state`, and `src/config`.

Runtime state values:

- `SERVER_DISCONNECTED` / `SERVER_CONNECTED`
- `CODEX_NOT_FOUND` / `CODEX_NOT_LOGGED_IN` / `CODEX_READY`
- `EXECUTION_IDLE` / `EXECUTION_RUNNING` / `EXECUTION_ERROR`

Execution logs include only request, conversation, agent and status identifiers. They never print the full prompt or local Codex credentials.
