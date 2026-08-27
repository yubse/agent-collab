# 群晖 NAS + GHCR 部署

正式发布链路如下：

```text
Developer Mac → git push → GitHub Actions
  → tests + typecheck + Server build
  → Docker Buildx → GHCR
  → Synology docker compose pull/up
```

NAS 只拉取并运行 Server 镜像，不在 NAS 构建镜像。Codex CLI、Codex 登录和 OpenAI 请求始终留在用户电脑的 Connector 中；NAS 不安装 Codex、不挂载用户主目录、不保存 Codex auth/token。

运行时网络仍为：

```text
Browser ──HTTP(S)──> NAS Nginx ──HTTP──> AI Studio Server
Connector ──WS(S)──> NAS Nginx ──WebSocket──> AI Studio Server
Connector ──local process──> Codex CLI ──> OpenAI
```

## 1. GitHub Actions 发布规则

`.github/workflows/docker.yml` 只在以下事件运行：

- push 到 `main`：先执行 `bun test`、TypeScript typecheck、Server build；全部成功后构建并推送多架构镜像。
- push `v*` tag（如 `v1.0.0`）：执行同一套质量门禁，成功后发布正式版本镜像。

镜像名来自 GitHub 仓库自身：`ghcr.io/<owner>/<repo>`。Tag 规则：

- main：`:latest` 和 `:<完整-git-sha>`。
- `v1.2.3`：`:v1.2.3`，并额外生成 `:1.2`、`:1`。

NAS 应固定 `:v1.2.3`，不要长期使用 `:latest`。workflow 使用仓库自带的 `GITHUB_TOKEN`，仓库 Actions 权限必须允许：

```yaml
permissions:
  contents: read
  packages: write
```

如果 tests、typecheck 或 Server build 任一步失败，`publish` job 不会开始，因此不会登录 GHCR、不会构建或推送正式镜像。

GitHub 仓库还需要：启用 Actions；在 Settings → Actions → General 中允许 workflow 使用读写 `GITHUB_TOKEN`（组织策略不能禁止 `packages: write`）。首次发布会创建/关联 GHCR Package；若同名 Package 已经存在但没有继承仓库权限，在 Package Settings → Manage Actions access 中添加本仓库并授予 Write。无需创建额外的 CI PAT，也不要在 Secrets 中手工复制 `GITHUB_TOKEN`。

## 2. 创建 NAS 目录

```bash
sudo mkdir -p \
  /volume1/AIStudio/server \
  /volume1/AIStudio/data \
  /volume1/AIStudio/agents \
  /volume1/AIStudio/knowledge \
  /volume1/AIStudio/runtime-data \
  /volume1/AIStudio/logs \
  /volume1/AIStudio/backups

sudo chown -R 1000:1000 \
  /volume1/AIStudio/data \
  /volume1/AIStudio/agents \
  /volume1/AIStudio/knowledge \
  /volume1/AIStudio/runtime-data \
  /volume1/AIStudio/logs \
  /volume1/AIStudio/backups
```

容器以非 root UID/GID `1000:1000` 运行。不要把 `~/.codex`、`auth.json`、PEM 密钥或 GitHub token 放入这些目录。

## 3. 准备部署文件与外部 Agent

把下列部署文件复制到 `/volume1/AIStudio/server`：

```text
docker-compose.yml
.env.example
scripts/nas-update.sh
deploy/nas/backup.sh
deploy/nas/nginx/ai-studio.conf.example
```

可以用 Git clone 获取这些文件，但 NAS 不运行 `docker build`。把 `agents/` 的内容单独复制到 `/volume1/AIStudio/agents/`：

```text
/volume1/AIStudio/agents/product/AGENTS.md
/volume1/AIStudio/agents/creative/AGENTS.md
/volume1/AIStudio/agents/social/AGENTS.md
/volume1/AIStudio/agents/growth/AGENTS.md
```

Agent prompt、Agent skills 和公司知识都来自外部 Volume。修改 `/volume1/AIStudio/agents` 或 `/volume1/AIStudio/knowledge` 后不需要重建 Server 镜像；如需让正在执行的上下文立即采用新内容，重启容器即可。

## 4. Private GHCR 首次登录

公开 GHCR Package 可匿名 pull。私有仓库/Package 需要 NAS 使用专门的低权限 GitHub 账号，并创建 Personal Access Token (classic)：

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)。
2. 只选择 `read:packages`；该 GitHub 账号本身还必须拥有 Package 的 Read 权限。
3. 如果组织启用了 SSO，单独授权此 token 访问组织。
4. 在 NAS 上交互式读取 token，不把 token 写入脚本、`.env` 或仓库：

```bash
read -s GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
unset GHCR_TOKEN
chmod 600 ~/.docker/config.json
```

Docker 登录凭证保存在执行部署的 NAS 用户自己的 `~/.docker/config.json`。不要提交这个文件；不要把 PAT 写进 `docker-compose.yml`。token 只需拉取权限，不授予 `write:packages`、`delete:packages` 或仓库管理权限。

## 5. 创建 `.env`

```bash
cd /volume1/AIStudio/server
cp .env.example .env
chmod 600 .env
```

至少修改镜像版本、公开地址和两个初始 secret：

```dotenv
AI_STUDIO_IMAGE=ghcr.io/yubse/agent-collab:v1.0.0
AI_STUDIO_ROOT=/volume1/AIStudio
AI_STUDIO_BIND_ADDRESS=127.0.0.1
AI_STUDIO_INTERNAL_PORT=3998
AI_STUDIO_PUBLIC_URL=http://ai-studio-nas.local
CONNECTOR_WS_URL=ws://ai-studio-nas.local/connector
SERVER_PENDING_TIMEOUT_MS=330000
AICOLLAB_BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-long-random-password
AICOLLAB_AUTH_TOKEN=replace-with-an-independent-random-secret
AICOLLAB_ALLOW_QUERY_TOKEN_AUTH=0
AICOLLAB_ALLOW_REMOTE_CONTROL=0
```

`AI_STUDIO_IMAGE` 必须是已经由 CI 发布的明确版本。可以用 `openssl rand -hex 32` 生成独立 secret。首次 admin 初始化完成后，从 `.env` 移除 `AICOLLAB_BOOTSTRAP_ADMIN_PASSWORD` 并重新 `up -d`；不要提交真实 `.env`。

## 6. 首次拉取并启动

```bash
cd /volume1/AIStudio/server
docker compose pull
docker compose up -d
docker compose ps
```

NAS 生产 `docker-compose.yml` 只有 `image:`，没有 `build:`。以下数据全部位于镜像外：

| NAS | 容器 | 持久化内容 |
|---|---|---|
| `data/` | `/data` | SQLite：users、conversations、messages、tasks、Agent memory、Connector devices |
| `runtime-data/` | `/runtime-data` | 上传、生成文件和 Server runtime state |
| `agents/` | `/app/agents` | AGENTS.md、Prompt、Agent skills |
| `knowledge/` | `/app/knowledge` | 公司知识文件 |
| `logs/` | `/logs` | 运维预留；实时 stdout/stderr 由 Docker 收集 |
| `backups/` | `/backups` | SQLite 和外部内容备份 |

替换、升级或回滚容器不会替换这些目录。不要执行 `docker compose down -v`，不要删除 `/volume1/AIStudio/data`。

## 7. Health 与日志

```bash
docker compose logs -f --tail=200 ai-studio-server
curl -fsS http://127.0.0.1:3998/health
docker inspect --format '{{.State.Health.Status}}' ai-studio-server
```

正常响应至少包含：

```json
{"status":"ok","server":"ok","database":"ok","connector":"ok"}
```

旧 `/healthz` 暂时保留兼容。日志不应包含完整 prompt、Codex auth 或 token；Connector 执行日志在用户电脑，不在 NAS。

## 8. Nginx / Synology Reverse Proxy

完整配置位于 `deploy/nas/nginx/ai-studio.conf.example`。它为 `/connector` 启用 WebSocket Upgrade，并设置 3600 秒读写 timeout，足以覆盖 2–5 分钟 Codex execution。

在 DSM「登录门户 → 高级 → 反向代理服务器」中配置：

- 来源：局域网 HTTP 80；未来可换 HTTPS 443。
- 目的地：`http://127.0.0.1:3998`。
- 传递 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`，启用 WebSocket。
- Connector WebSocket read/send timeout 至少 3600 秒。
- 不在路由器或公网防火墙转发内部 3998 端口。

验证：

```bash
curl -fsS http://ai-studio-nas.local/health
```

## 9. Connector 连接 NAS

用户电脑安装 Bun、Codex CLI 并完成 `codex login`。网页生成一次性配对码后，在用户电脑运行：

```bash
cd /path/to/agent-collab
export AI_STUDIO_SERVER_URL='http://ai-studio-nas.local'
export CONNECTOR_WS_URL='ws://ai-studio-nas.local/connector'
export CONNECT_TIMEOUT_MS=15000
export REQUEST_ACK_TIMEOUT_MS=10000
export EXECUTION_TIMEOUT_MS=300000
bun run connector
```

设备 token 只保存在用户电脑 `~/.ai-studio-connector/device.json`。启用 TLS 时改为 `https://` / `wss://`。不要把 Connector 加入 NAS Compose。

## 10. 更新固定版本

先备份，然后在 `.env` 把 `AI_STUDIO_IMAGE` 改为新的明确版本，例如 `v1.0.1`：

```bash
cd /volume1/AIStudio/server
AI_STUDIO_ROOT=/volume1/AIStudio sh deploy/nas/backup.sh
sed -n 's/^AI_STUDIO_IMAGE=//p' .env
AI_STUDIO_SERVER_DIR=/volume1/AIStudio/server sh scripts/nas-update.sh
```

`scripts/nas-update.sh` 依次执行 `docker compose pull`、`docker compose up -d`，检查容器 running/healthy，并从容器内实际请求 `GET /health`。失败时输出容器状态和最近日志并返回非零；不会自动删除旧镜像。

## 11. 回滚程序版本

假设 `v1.0.1` 有问题，把 `.env` 中：

```dotenv
AI_STUDIO_IMAGE=ghcr.io/yubse/agent-collab:v1.0.1
```

改回：

```dotenv
AI_STUDIO_IMAGE=ghcr.io/yubse/agent-collab:v1.0.0
```

然后运行：

```bash
AI_STUDIO_SERVER_DIR=/volume1/AIStudio/server sh /volume1/AIStudio/server/scripts/nas-update.sh
```

这只回滚程序镜像。SQLite 和所有 Volume 不跟随程序版本回滚，也不能删除。若新版本已经执行不可逆数据库迁移，应先阅读版本说明并使用升级前备份制定数据库恢复方案，不能盲目把数据库文件降级。

## 12. 备份与恢复

备份：

```bash
cd /volume1/AIStudio/server
chmod 750 deploy/nas/backup.sh scripts/nas-update.sh
AI_STUDIO_ROOT=/volume1/AIStudio sh deploy/nas/backup.sh
ls -lah /volume1/AIStudio/backups
```

脚本通过 SQLite `VACUUM INTO` 生成一致性 `chat.db`，并备份 `agents`、`knowledge` 和必要 `runtime-data`；排除 cache、tmp、`.codex`、`auth.json` 和 Docker logs。

恢复前停止服务并保存当前数据库：

```bash
cd /volume1/AIStudio/server
docker compose down
mv /volume1/AIStudio/data/chat.db /volume1/AIStudio/data/chat.db.before-restore
cp /volume1/AIStudio/backups/<timestamp>/chat.db /volume1/AIStudio/data/chat.db
tar -xzf /volume1/AIStudio/backups/<timestamp>/agents.tar.gz -C /volume1/AIStudio
tar -xzf /volume1/AIStudio/backups/<timestamp>/knowledge.tar.gz -C /volume1/AIStudio
tar -xzf /volume1/AIStudio/backups/<timestamp>/runtime-data.tar.gz -C /volume1/AIStudio
chown -R 1000:1000 /volume1/AIStudio/{data,agents,knowledge,runtime-data,logs,backups}
docker compose up -d
curl -fsS http://127.0.0.1:3998/health
```

恢复后确认 User、Conversation、Message、Task、Agent memory 和 Connector device 均存在。Codex auth 从未进入 NAS 或备份。

## 本机开发流程

日常开发不要求 Docker：

```bash
bun install
bun run dev
bun test
git add <files>
git commit
git push
```

本机 Docker 仅用于 Dockerfile/CI 故障排查：

```bash
docker build -t ai-studio:test .
```

需要重新构建镜像：Server 代码、`web/`、运行依赖、`package.json`/`bun.lock`、Dockerfile 发生变化。无需重新构建镜像：NAS `.env`、Compose 固定版本、Nginx、`agents/`、Agent skills、Prompt、`knowledge/`、数据库和 runtime-data；这些由配置或 Volume 管理。
