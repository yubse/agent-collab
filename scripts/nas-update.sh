#!/bin/sh
set -eu

SERVER_DIR=${AI_STUDIO_SERVER_DIR:-/volume1/AIStudio/server}
SERVICE=ai-studio-server

if [ ! -f "$SERVER_DIR/docker-compose.yml" ] || [ ! -f "$SERVER_DIR/.env" ]; then
  printf '%s\n' "ERROR: docker-compose.yml or .env is missing in $SERVER_DIR" >&2
  exit 1
fi

cd "$SERVER_DIR"
docker compose pull
docker compose up -d

container_id=$(docker compose ps -q "$SERVICE")
if [ -z "$container_id" ]; then
  printf '%s\n' "ERROR: $SERVICE container was not created" >&2
  exit 1
fi

attempt=0
while [ "$attempt" -lt 60 ]; do
  running=$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)
  if [ "$running" = true ] && [ "$health" = healthy ]; then
    if docker compose exec -T "$SERVICE" bun -e '
      const response = await fetch("http://127.0.0.1:3998/health");
      const body = await response.json();
      if (!response.ok || body.status !== "ok" || body.database !== "ok" || body.connector !== "ok") process.exit(1);
    '; then
      docker compose ps "$SERVICE"
      printf '%s\n' "NAS update complete: image pulled, container running, /health ok"
      exit 0
    fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done

printf '%s\n' "ERROR: $SERVICE failed to become healthy or GET /health failed" >&2
docker compose ps "$SERVICE" >&2 || true
docker compose logs --tail=100 "$SERVICE" >&2 || true
exit 1
