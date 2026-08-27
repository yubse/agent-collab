# Agent-collab

公司内部多用户 AI Studio：共享多 Agent 定义，同时隔离每个用户的对话、消息、任务、Memory 和 Codex Connector。保留本地 Claude Code / Codex Provider 作为开发兼容模式。

## 为什么做这个

在一个平台上把你所有的 agent 接在一起协作，UI 可视、易用。是一份Proof of Concept，非开袋即食！

跟 agent 对话时产生的想法可以直接建成 task，不让它流失在对话记录里。各种任务按照预设的模板自己流转，只在需要你拍板的时候通知你。

## 适合什么人

这不是一个专注自动化和高效开发的工具。它是我们为了适配自己的工作流做出来的，不一定适合所有人，主要是分享思路。

我个人从事创意类工作，除了写代码之外还需要 brainstorm、调研等不同类型的任务。这只是一个一人三 AI 的小作坊。

协作之外，每个 agent 的 context 和记忆管理同样重要。

总的来说，没有标准做法，找到适合自己的就好。

## 核心功能

### 任务系统

Issue tracker 范式，每个任务有类型和阶段流程。

- **阶段是积木**：你可以创建自己的阶段，每个阶段单独配置谁负责、能否拒绝、是否自动跳过。默认提供的阶段有草稿、评估、实施、Review、验收等
- **类型是拼装**：把阶段积木拼成不同的任务类型。开发任务一套阶段、轻量开发一套、调研另一套。创建新类型就是重新拼积木
- **活动流**：每个任务页面有一条时间线，展示所有发生过的事
- **自动通知**：任务推进到某个 agent 的阶段时，agent 的私聊窗口会收到系统提示

对话中让 AI 自己开任务单，建完自动走评估 → 实施 → review。提前设好哪些环节需要人拍板，到了那步会通知你。

<img width="1276" height="1227" alt="任务列表" src="https://github.com/user-attachments/assets/909b84ca-c2d5-4df4-8c00-2b033d3e0d41" />
<img width="1187" height="255" alt="工作流" src="https://github.com/user-attachments/assets/61f176aa-da6e-491a-a915-065470a9d7dc" />
<img width="938" height="926" alt="任务评论" src="https://github.com/user-attachments/assets/8529b439-f005-4218-afed-b7452c88c7f5" />

### 工作群和私聊

- **工作群**：所有 agent 看到同一个频道，按 @mention 路由响应
- **私聊**：每个 agent 一个独立 DM 窗口，一对一对话
- Web 和 iOS 双端同步

<img width="1282" height="1225" alt="首页" src="https://github.com/user-attachments/assets/5c29d856-5e3e-464f-9e81-7f7a4228ecf1" />

### 终端面板

<img width="1275" height="610" alt="iShot_2026-06-27_00 00 05" src="https://github.com/user-attachments/assets/47726b0b-e7f4-4470-885d-aac8ec5eefcd" />

从 web 端直接看每个 agent 在干什么，支持两种显示模式：

- **Transcript 视图**：结构化展示 agent 的对话记录（user / assistant / 工具调用 / 工具结果），claude provider 专用（要读 jsonl）
- **Tmux TUI**：直接看 agent 的 tmux 终端画面，可以交互式调试，tmux provider 专用

### 工位卡

<img width="1237" height="318" alt="工位卡" src="https://github.com/user-attachments/assets/a8bc0bab-eca1-4a34-8fb5-19b9c461ca56" />


每个 agent 一张卡，显示在线状态、当前模型、用量信息。可以手动控制上下班。

## 通讯方式

Server 和 agent 子进程之间有两种通讯方式，各有取舍：

| | stream-json | tmux |
|---|---|---|
| **机制** | server 直接 spawn 子进程，双向 NDJSON over stdio | server attach 已有的 tmux session，用 `send-keys` 输入、`capture-pane` 轮询输出 |
| **实时性** | 事件流实时收（token-level delta） | 5s 轮询屏幕快照，有间隔 |
| **数据形态** | NDJSON events（Anthropic 结构化事件） | 终端字节流（raw bytes，需 sanitize 防泄漏） |
| **agent 主体** | server 拥有进程，`--resume` 跨重启续 session | 操作员拥有 tmux session，server 只 attach 不创建 |
| **可视调试** | Headless，看不到终端 | 有 TUI，可以 `tmux attach` 进去人肉操作 |
| **transcript** | claude binary 写 jsonl，web 可看 | 同上（tmux 内跑 claude binary 时也有） |
| **适合** | 默认 / 新部署 / 完整功能 | 已有 tmux 工作流 / 需要交互式调试 / 想接非 stream 协议的 CLI |

Claude Code 和 Codex CLI 都走 stream-json。tmux provider 是给已经有 tmux 工作流的用户准备的，需要显式启用。

## 快速开始

Server 需要 [Bun](https://bun.sh) 1.0+。Remote Connector 模式下，Server 不需要安装或登录 Codex；Codex CLI 只安装在每位用户自己的电脑。

```bash
git clone https://github.com/yubse/agent-collab.git
cd agent-collab
bun install
export AICOLLAB_BOOTSTRAP_ADMIN_PASSWORD='至少十位的初始密码'
bun run dev
```

打开 `http://localhost:3998/`。Server 首次启动会幂等创建文一、Tina、刘婷三个普通用户；选择身份后，Server 创建随机 Session，并通过 HttpOnly、SameSite=Lax Cookie 维持登录。勾选“记住此设备”时 Cookie 保留 30 天，否则随浏览器会话结束。已有有效 Session 的页面刷新会直接进入对应用户空间。

### Trusted LAN 登录的安全边界

当前 Profile Selector 是 **Trusted LAN MVP**，不是正式身份认证：任何能访问登录页面的人，理论上都能选择文一、Tina 或刘婷。Profile ID 只用于兑换服务端 Session；Conversation、Message、Task、Memory 与 Connector API 始终以 Session 中经过认证的 `user_id` 查询，不接受前端传入的 `user_id` 覆盖身份。

因此该模式只应部署在可信局域网。下一阶段计划升级为 **Device-bound Passwordless Login**：首次选择身份并绑定设备，之后由设备自动识别，未绑定设备不能任意选择该用户。本阶段不包含设备身份锁定。

管理员密码登录与一次性 bootstrap API 仍保留用于运维。首次迁移后应移除 `AICOLLAB_BOOTSTRAP_ADMIN_PASSWORD`；数据库只保存 Argon2id hash。

默认四个 Agent 使用 `remote-codex`。共享人设保存在 Server，可用 `PRODUCT_PROMPT_PATH`、`CREATIVE_PROMPT_PATH`、`SOCIAL_PROMPT_PATH`、`GROWTH_PROMPT_PATH` 指向对应 `AGENTS.md`。开发时仍可显式使用 `PRODUCT_PROVIDER=codex` 或 `claude`。

开发模式可以直接运行 Helper：

```bash
cd connector
export AI_STUDIO_SERVER_URL="https://studio.example.com"
bun run start
```

正式使用时通过 `connector/scripts/install-helper.sh` 安装 standalone Helper 和 macOS LaunchAgent；之后不需要打开 Terminal。Web 先检测 `127.0.0.1:39481`，再通过 60 秒 Session-bound claim 一键绑定。绑定身份只来自 Server Session；Web 和 Helper 都不能提交用户身份，Web 也不会取得 device credential。Helper 不上传 Codex `auth.json`、access token 或 refresh token。

群晖 NAS 的 GHCR 拉取部署见 [docs/NAS_DEPLOYMENT.md](docs/NAS_DEPLOYMENT.md)。正式镜像由 GitHub Actions 在 tests、typecheck、Server build 全部通过后构建并推送；NAS 的 Compose 没有 `build:`，只拉取固定版本镜像并运行。

验证：

```bash
bun run check
bun test
bun run test:integration
```

日常本机流程是 `bun install` → `bun run dev` → `bun test` → commit → push，不要求本机 Docker。只有排查 Dockerfile 或 CI 构建问题时才运行：

```bash
docker build -t ai-studio:test .
```

push 到 `main` 会发布 GHCR 的 `latest` 与完整 commit SHA tag；push `v*` tag 会发布对应正式版本。NAS 应使用 `ghcr.io/<owner>/<repo>:vX.Y.Z`，不要永久追踪 `latest`。

## 架构

```
┌─────────────┐      ┌────────────────────────┐      ┌──────────────────┐
│ Web UI      │◀────▶│ AI Studio Server       │◀────▶│ User Connector   │
│ user session│ HTTP │ users + SQLite         │ WSS  │ local Codex     │
└─────────────┘      │ shared agents          │      │ local auth only │
                     │ private conversations  │      └─────────────────┘
                     └────────────────────────┘
```

Remote 模式下，Agent 的定义、Memory、Conversation 和 Workflow 全在 Server；Connector 只是用户隔离的 Codex Execution Node。Server 通过 `RemoteCodexProvider` 和经过 device token 认证的 WebSocket 派发任务。本地 Provider 仍实现同一 `AgentProvider` 接口。

## 当前 Agent

本分支预置四个独立角色：产品企划（`product`）、创意设计（`creative`）、社媒运营（`social`）和营销增长（`growth`）。每个角色使用自己的工作目录与 `AGENTS.md`，可在工作群中 @ 指定角色，也可建立独立工作群或直接私聊。

添加或调整 Agent 时，需要同步更新 `server.ts` 的 roster/runtime、前端身份映射和对应工作目录的人设文件，详见 [TECHNICAL.md](TECHNICAL.md)。

## 技术文档

Provider 协议细节、env 配置项、任务系统 API 等深入内容见 [TECHNICAL.md](TECHNICAL.md)。

## License

MIT
