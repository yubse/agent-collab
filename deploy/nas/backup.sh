#!/bin/sh
set -eu

AI_STUDIO_ROOT=${AI_STUDIO_ROOT:-/volume1/AIStudio}
SERVER_DIR="$AI_STUDIO_ROOT/server"
STAMP=$(date '+%Y%m%d-%H%M%S')
DEST="$AI_STUDIO_ROOT/backups/$STAMP"

mkdir -p "$DEST"
cd "$SERVER_DIR"

# SQLite VACUUM INTO creates a consistent online snapshot, including committed WAL data.
docker compose exec -T \
  -e AI_STUDIO_BACKUP_DB="/backups/$STAMP/chat.db" \
  ai-studio-server bun -e '
    import { Database } from "bun:sqlite";
    const source = new Database(process.env.AICOLLAB_DATABASE_PATH);
    source.run("PRAGMA wal_checkpoint(FULL)");
    source.run("VACUUM INTO ?", [process.env.AI_STUDIO_BACKUP_DB]);
    source.close();
  '

tar -czf "$DEST/agents.tar.gz" -C "$AI_STUDIO_ROOT" agents
tar -czf "$DEST/knowledge.tar.gz" -C "$AI_STUDIO_ROOT" knowledge
tar \
  --exclude='runtime-data/cache' \
  --exclude='runtime-data/tmp' \
  --exclude='runtime-data/*.tmp' \
  --exclude='*/.codex' \
  --exclude='*/.codex/*' \
  --exclude='*/auth.json' \
  -czf "$DEST/runtime-data.tar.gz" -C "$AI_STUDIO_ROOT" runtime-data

printf '%s\n' "Backup created: $DEST"
