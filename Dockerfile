FROM oven/bun:1.4.0-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY server.ts TECHNICAL.md README.md ./
COPY src ./src
COPY web ./web
COPY agents ./agents

RUN mkdir -p /data /runtime-data /app/knowledge /backups \
  && chown -R bun:bun /app /data /runtime-data /backups

USER bun

ENV NODE_ENV=production \
    AICOLLAB_HOST=0.0.0.0 \
    AICOLLAB_PORT=3998 \
    AICOLLAB_DATA_DIR=/runtime-data \
    AICOLLAB_DATABASE_PATH=/data/chat.db

EXPOSE 3998

CMD ["bun", "server.ts"]
