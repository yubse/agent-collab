FROM oven/bun:1.4.0-slim

WORKDIR /app

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY --chown=bun:bun server.ts ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun web ./web

RUN mkdir -p /data /runtime-data /app/agents /app/knowledge /app/images /logs /backups \
  && chown -R bun:bun /app /data /runtime-data /logs /backups

USER bun

ENV NODE_ENV=production \
    AICOLLAB_HOST=0.0.0.0 \
    AICOLLAB_PORT=3998 \
    AICOLLAB_DATA_DIR=/runtime-data \
    AICOLLAB_DATABASE_PATH=/data/chat.db

EXPOSE 3998

CMD ["bun", "server.ts"]
