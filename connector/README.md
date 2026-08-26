# AI Studio Connector

Connector runs on each user's own macOS or Windows computer. It keeps Codex credentials local and only exchanges prompts/results with AI Studio Server.

Requirements: Bun 1.0+, Codex CLI, and an existing local `codex login` session.

```bash
cd connector
export AI_STUDIO_SERVER_URL="https://studio.example.com"
bun run start
```

On first start, create a pairing code in **Settings → Devices → Add Device** and enter the six digits. The returned device token is stored only in `~/.ai-studio-connector/device.json` with owner-only permissions. Codex `auth.json`, access tokens and refresh tokens are never sent to Server.

For unattended setup, `AI_STUDIO_PAIRING_CODE`, `AI_STUDIO_DEVICE_NAME`, `CODEX_BINARY_PATH`, and `AI_STUDIO_CODEX_CWD` can be supplied as environment variables.

