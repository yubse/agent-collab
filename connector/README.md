# AI Studio Connector

AI Studio Helper is the headless Connector that runs continuously on each user's computer. It keeps Codex credentials local and only exchanges prompts/results with AI Studio Server.

Development requires Bun 1.0+. A production PKG contains both the standalone Helper and an approved Codex Runtime, so employees do not install Bun, Node, or Codex CLI. `USE_SYSTEM_CODEX=1` remains an explicit development fallback only.

```bash
cd connector
export AI_STUDIO_SERVER_URL="https://studio.example.com"
bun run start
```

Helper listens only on `127.0.0.1:39481`. `GET /status` and `GET /codex/status` report non-sensitive readiness. `POST /codex/login` starts the official app-server ChatGPT browser flow and opens the returned official URL locally; the URL and authentication material are not returned to AI Studio Web or NAS. `POST /codex/restart` restarts only the managed app-server process and cannot execute arbitrary commands.

Web uses its authenticated Session to create a 60-second, single-use claim and sends only `claim_token` to `POST /claim`. Helper exchanges it with Server, saves the resulting device credential under `~/Library/Application Support/AIStudio/credentials/device.json` with mode `0600`, and starts the existing authenticated WebSocket loop. Legacy `~/.ai-studio/connector.json` is read once for migration compatibility. A stable local `device_id` prevents duplicate device rows. Codex access tokens, refresh tokens, cookies, passwords, and auth files are never read by AI Studio code or sent to Server.

CORS uses one exact `AI_STUDIO_WEB_ORIGIN`; wildcard origins are never emitted. OPTIONS responses include standard CORS headers plus `Access-Control-Allow-Private-Network: true` for Chromium Private Network Access. Chrome and Edge use that preflight; Safari uses the same exact-Origin CORS response and safely ignores the Chromium-specific header.

CLI development mode can still inject a claim token directly:

```bash
bun run start -- --pair-token '<development-token>'
```

`AI_STUDIO_PAIRING_TOKEN`, `AI_STUDIO_DEVICE_NAME`, `CODEX_BINARY_PATH`, and `AI_STUDIO_CODEX_CWD` may also be supplied in development. Set `USE_SYSTEM_CODEX=1` to use that system binary. Formal mode instead copies `AI_STUDIO_BUNDLED_CODEX_PATH` into the user-managed Runtime location and uses a dedicated local `CODEX_HOME`. `AI_STUDIO_WEB_ORIGIN` controls the one allowed CORS Origin and defaults to the Server origin. `CONNECTOR_WS_URL` optionally overrides the WebSocket endpoint and supports `ws://` and `wss://`. The current Profile Selector is a Trusted LAN MVP: anyone able to select 文一、Tina or 刘婷 can initiate a claim for that Profile. Device-bound Passwordless Login is intentionally deferred.

### macOS development installation

```bash
connector/scripts/build-standalone.sh
AI_STUDIO_SERVER_URL='http://192.168.20.200:3998' \
AI_STUDIO_WEB_ORIGIN='http://192.168.20.200:3998' \
connector/scripts/install-helper.sh
```

The development installer uses the system-Codex fallback and copies the standalone executable to `~/Library/Application Support/AIStudio/helper/`. It writes `~/Library/LaunchAgents/com.aistudio.connector.plist`, enables `RunAtLoad`, restarts after abnormal exit, and applies a 10-second launchd throttle. Uninstall preserves credentials, managed Runtime, and Codex authentication data.

### macOS PKG

The PKG build requires an explicitly selected, approved Codex Runtime binary. A license file is required for a distributable build; `AI_STUDIO_ALLOW_DEV_RUNTIME=1` only permits an unsigned local development package.

```bash
AI_STUDIO_SERVER_URL='http://192.168.20.200:3998' \
AI_STUDIO_WEB_ORIGIN='http://192.168.20.200:3998' \
CODEX_RUNTIME_BINARY='/approved/path/to/codex' \
CODEX_RUNTIME_LICENSE_FILE='/approved/path/to/LICENSE' \
connector/scripts/build-pkg.sh
```

Output: `connector/dist/AI-Studio-Helper.pkg`. The package installs a system payload under `/Library/Application Support/AIStudio/`, registers `/Library/LaunchAgents/com.aistudio.connector.plist`, and opens the configured AI Studio URL. On first start, Helper copies the bundled Runtime into the current user's Application Support directory. Production distribution additionally requires `DEVELOPER_ID_APPLICATION`, `DEVELOPER_ID_INSTALLER`, and Apple notarization.

User-owned data is separated as follows:

- `~/Library/Application Support/AIStudio/runtime/` — managed Codex executable.
- `~/Library/Application Support/AIStudio/codex-home/` — Codex-owned local authentication/configuration.
- `~/Library/Application Support/AIStudio/credentials/` — AI Studio device credential.
- `~/Library/Application Support/AIStudio/state/` — per-user/per-conversation Codex thread ids.
- `~/Library/Application Support/AIStudio/logs/` — Helper logs.

Timeouts are independent and may be overridden with environment variables:

- `CONNECT_TIMEOUT_MS=15000` — Connector WebSocket connect/authentication deadline.
- `REQUEST_ACK_TIMEOUT_MS=10000` — Server deadline for the immediate `execution_ack` and Codex app-server RPC acknowledgements.
- `EXECUTION_TIMEOUT_MS=300000` — maximum duration of one Codex model turn on Connector.
- `SERVER_PENDING_TIMEOUT_MS=330000` — Server deadline for the final `execution_result` after dispatch.
- `AI_STUDIO_CODEX_WORKERS=4` — local Codex app-server pool size, clamped to 1–4 (default 4; lower values remain supported).

The Connector sends `execution_ack` before starting Codex, keeps heartbeat traffic independent from model execution, and never retries a model turn for the same `request_id`. Up to four independent `codex app-server --listen stdio://` workers execute same-round creative Agents concurrently. Agent-owned configuration selects Luna + low for A/B/C/D and Moderator, Terra + low for Market, and Terra + medium for Director; unconfigured requests retain the Codex default model. Creative discussions are pure-chat turns with web, shell, file, app, and environment tools disabled.

Reusable core modules live under `src/codex`, `src/connection`, `src/pairing`, `src/helper`, `src/execution`, `src/state`, and `src/config`.

Runtime state values:

- `SERVER_DISCONNECTED` / `SERVER_CONNECTED`
- `CODEX_RUNTIME_NOT_INSTALLED` / `CODEX_RUNTIME_INSTALLING` / `CODEX_RUNTIME_ERROR`
- `CODEX_NOT_LOGGED_IN` / `CODEX_AUTHENTICATING` / `CODEX_READY`
- `EXECUTION_IDLE` / `EXECUTION_RUNNING` / `EXECUTION_ERROR`

Execution logs include only request, conversation, agent and status identifiers. They never print the full prompt or local Codex credentials.
