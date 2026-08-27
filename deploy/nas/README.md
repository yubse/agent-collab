# Synology NAS deployment preparation

The NAS runs only AI Studio Server. Codex CLI, Codex login files, and model network traffic remain on each user's Connector computer.

## Persistent layout

```text
/volume1/AIStudio/
├── server/        # repository checkout + Dockerfile/compose
├── data/          # SQLite database
├── agents/        # shared AGENTS.md files
├── knowledge/     # shared company knowledge (reserved)
├── runtime-data/  # uploads, Connector/Server runtime state
└── backups/       # operator-managed database backups
```

Before first start, create the directories in DSM/File Station or SSH, copy this repository to `/volume1/AIStudio/server`, and copy the repository's `agents/` contents into `/volume1/AIStudio/agents/`. Ensure the container user (UID/GID 1000 in the Bun image) can read `agents`/`knowledge` and write `data`/`runtime-data`/`backups`.

```bash
cd /volume1/AIStudio/server
cp .env.example .env
# Edit .env before continuing.
docker compose build
docker compose up -d
docker compose ps
```

Configure Synology Reverse Proxy to send the LAN hostname to `http://127.0.0.1:3998`. Enable WebSocket upgrade and forward `Host` plus `X-Forwarded-Proto`. Do not create a router port-forward or public firewall rule for port 3998.

## Persistence verification

After creating a test user and message, record the message ID, then recreate only the container:

```bash
docker compose up -d --force-recreate
docker compose exec ai-studio-server bun -e "import{Database}from'bun:sqlite';const d=new Database('/data/chat.db',{readonly:true});console.log(d.query('select count(*) as n from group_messages').get())"
```

Do not use `docker compose down -v`. This deployment uses bind mounts, but deleting the NAS folders still deletes the application data.
