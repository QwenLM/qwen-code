# Daemon Developer Documentation (English)

This is the developer-facing technical documentation set for **qwen-code daemon mode** — the `qwen serve` HTTP daemon, its supporting `acp-bridge` package, the workspace-scoped MCP transport pool, the multi-client permission mediator, the typed daemon event schema v1, the TypeScript SDK daemon client, and every adapter (CLI TUI, channel bots, VSCode IDE) that talks to it.

It complements rather than replaces the existing docs:

| Existing doc | Audience | Stays the source of truth for |
|---|---|---|
| [`../../users/qwen-serve.md`](../../users/qwen-serve.md) | Operators | Quickstart, flags, threat model |
| [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md) | Protocol implementers | HTTP route catalogue, request/response shapes, error codes |
| [`../examples/daemon-client-quickstart.md`](../examples/daemon-client-quickstart.md) | SDK users | End-to-end TS walkthrough |
| [`../daemon-client-adapters/`](../daemon-client-adapters/) | Adapter authors (draft) | Per-client adapter design notes |

If you want to **start a daemon and use it**, read `qwen-serve.md` first. If you want to **build a client against the wire format**, read `qwen-serve-protocol.md`. If you want to **understand how the daemon works internally, extend it, or debug it**, read this set.

## Reading order

Pick the path that matches your goal:

- **New contributor** — read in order: `01 → 02 → 03 → 08 → 09 → 10 → 11 → 12`. That covers the system, the runtime, the bridge, and the wire-side fundamentals.
- **Adding a new client adapter** — read `01 → 09 → 10 → 13 → (14 / 15 / 16)`. Architecture, event schema, SSE bus, SDK, then the adapter most similar to yours.
- **Working on the MCP pool / budget** — read `01 → 03 → 05 → 06`.
- **Working on permissions** — read `01 → 03 → 04 → 12`.
- **Debugging a production daemon** — read `17 → 19 → 18`.

## Document set

### Foundation

- [`01-architecture.md`](./01-architecture.md) — system architecture, process topology, package map, all six top-level sequence diagrams.

### Server core

- [`02-serve-runtime.md`](./02-serve-runtime.md) — `runQwenServe` bootstrap, Express app, middleware chain, graceful shutdown.
- [`03-acp-bridge.md`](./03-acp-bridge.md) — `@qwen-code/acp-bridge` package internals, session multiplexing, channel factory, ACP child spawn.
- [`04-permission-mediation.md`](./04-permission-mediation.md) — `MultiClientPermissionMediator`, four policies, N1 timeout invariant, cancel sentinel.
- [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) — `McpTransportPool` (F2), pool entries, reverse index, restart, drain.
- [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md) — `WorkspaceMcpBudget`, modes (off/warn/enforce), hysteresis, refused-batch coalescing.
- [`07-workspace-filesystem.md`](./07-workspace-filesystem.md) — `WorkspaceFileSystem` sandbox, path policy, audit, `BridgeFileSystem` contract.
- [`08-session-lifecycle.md`](./08-session-lifecycle.md) — create / attach / load / resume, `X-Qwen-Client-Id`, heartbeat, eviction, metadata.
- [`09-event-schema.md`](./09-event-schema.md) — typed event schema v1: all 28 known event types with payloads, reducers, forward-compat.
- [`10-event-bus.md`](./10-event-bus.md) — `EventBus`, monotonic IDs, ring replay, `Last-Event-ID`, slow-client backpressure, `client_evicted`.
- [`11-capabilities-versioning.md`](./11-capabilities-versioning.md) — capability registry, protocol version, schema version, conditional advertisement.
- [`12-auth-security.md`](./12-auth-security.md) — bearer middleware, host allowlist, CORS deny, mutation gate, `--require-auth`, `/health` exemption, device-flow.

### Clients

- [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md) — TypeScript SDK: `DaemonClient`, `DaemonSessionClient`, `DaemonAuthFlow`, SSE parser, event reducers.
- [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md) — CLI's Ink TUI talking to the daemon instead of an in-process agent.
- [`15-channel-adapters.md`](./15-channel-adapters.md) — `DaemonChannelBridge` shared base plus DingTalk, WeChat (Weixin), Telegram per-channel adapters.
- [`16-vscode-ide-adapter.md`](./16-vscode-ide-adapter.md) — `DaemonIdeConnection`, loopback-only enforcement, webview bridging.

### Reference appendices

- [`17-configuration.md`](./17-configuration.md) — env vars, CLI flags, `settings.json` keys that affect the daemon.
- [`18-error-taxonomy.md`](./18-error-taxonomy.md) — typed errors per layer with remediation.
- [`19-observability.md`](./19-observability.md) — `QWEN_SERVE_DEBUG`, debugging recipes, telemetry gaps.

## Glossary

- **ACP** — Agent Client Protocol. JSON-RPC over stdio spoken between the daemon's bridge and the ACP child process. Not to be confused with the HTTP protocol that clients use against the daemon.
- **ACP child** — the child process the daemon spawns (`qwen --acp`) to host the actual agent runtime. The daemon's bridge multiplexes one ACP child across many connected clients.
- **acp-bridge** — the `@qwen-code/acp-bridge` package (`packages/acp-bridge/`). Owns session multiplexing, the permission mediator, the event bus, the channel factory.
- **BridgeClient** — `packages/acp-bridge/src/bridgeClient.ts`. Wraps one ACP `ClientSideConnection`, handles `requestPermission` / `sendPrompt` / `cancelSession`.
- **Channel factory** — pluggable strategy for how the bridge spawns or attaches to the ACP child (default: `spawnChannel` runs `qwen --acp` as a subprocess; `inMemoryChannel` runs it in-process for tests).
- **DaemonClient** — `packages/sdk-typescript/src/daemon/DaemonClient.ts`. The TS SDK's HTTP-level facade over the daemon.
- **DaemonSessionClient** — `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`. Session-scoped wrapper that auto-tracks `lastSeenEventId` for SSE replay.
- **EventBus** — `packages/acp-bridge/src/eventBus.ts`. Per-session in-memory pub/sub with monotonic IDs, bounded ring, per-subscriber backpressure.
- **F1 / F2 / F3 / F4** — internal milestones inside [#4175](https://github.com/QwenLM/qwen-code/issues/4175). F1: bridge lift + `BridgeFileSystem`. F2: workspace-scoped MCP transport pool. F3: multi-client permission mediation. F4: protocol completion / `qwen --serve` co-host (in progress).
- **MCP** — Model Context Protocol. Servers expose tools / resources / prompts; the daemon's ACP child connects to them.
- **McpTransportPool** — `packages/core/src/tools/mcp-transport-pool.ts`. F2's workspace-scoped pool sharing one MCP transport per (server name + config fingerprint).
- **Mediator policy** — one of `first-responder`, `designated`, `consensus`, `local-only`. Decides how multi-client permission votes resolve.
- **Originator client id** — the `X-Qwen-Client-Id` of the client that initiated the prompt currently requesting permission. The `designated` policy only accepts votes from this id.
- **PoolEntry** — `packages/core/src/tools/mcp-pool-entry.ts`. One entry in `McpTransportPool`: one MCP transport, refcount of attached sessions, idle drain timer.
- **Session scope** — `single` (one ACP session shared by all clients) or `per-client` (one session per client). Default `single`.
- **SSE** — Server-Sent Events. The daemon's outbound event channel (`GET /session/:id/events`).
- **Workspace** — the directory the daemon was bound to at boot (`--workspace` or `cwd`). One daemon process = one workspace.

## What is intentionally out of scope

- **Java / Python SDK daemon clients** — only the TypeScript SDK ships a daemon client today. Doc 13 is TS-only.
- **Web UI (`packages/webui/`)** — a component library that renders ACP / JSONL messages provided by a host. It is not itself a daemon HTTP client and gets no dedicated chapter.
- **Zed extension (`packages/zed-extension/`)** — uses stdio ACP directly to launch a `qwen --acp` agent; it bypasses the daemon. No daemon chapter needed.
- **F4 (in progress)** — protocol completion plus `qwen --serve` co-host. Not stable enough at the time of writing for a dedicated doc; will be added when the surface lands.

## F4 prereqs landing on `daemon_mode_b_main` (heads-up)

This doc set is pinned to `worktree-enumerated-stirring-adleman` (HEAD `cb206da36`). The `daemon_mode_b_main` branch has three F4-prereq commits that aren't on this worktree yet — they shift wire shapes additively, so the doc set keeps working but adds the following surface when they merge:

| Commit | What it adds |
|---|---|
| `14637cd79` `feat(serve): stamp serverTimestamp / tool provenance / errorKind on daemon events` | Adds `_meta.serverTimestamp` on every SSE frame (stamped at `formatSseFrame` boundary, not `EventBus.publish`, so internal consumers don't see `_meta`). Adds `tool_call.provenance` (`'builtin' \| 'mcp' \| 'subagent'`) + `serverId?` on `ToolCallEmitter.emit{Start,Result,Error}`. Adds top-level `errorKind` envelope field. |
| `c1a2f0a78` `feat(serve+sdk): detect SSE ring eviction on resume, expose state_resync_required` | Adds a **29th** known event type — `state_resync_required` synthetic terminal frame fired in `EventBus.subscribe()`'s replay path when `lastEventId < ringHead`. Carries `{ reason: 'ring_evicted', lastDeliveredId, earliestAvailableId }`, has **no `id`** like the other synthetic terminals. Tells reconnecting consumers to do a full `loadSession` rather than keep applying deltas. |
| `74412919c` `fix(acp-bridge): preserve FsError structure over ACP wire` | Catches `FsError` thrown by the `BridgeFileSystem` adapter inside `BridgeClient.writeTextFile/readTextFile` and rethrows as ACP `RequestError(-32603, message, {errorKind, hint, status})` so the agent's RPC client sees the typed `errorKind` instead of a regex-on-message. |

Doc 07 already establishes the FsError contract; doc 09 already states the forward-compat rule (unknown event types fall through as `kind: 'unknown'`). The F4-prereq additions slot in without breaking either. Re-read this section when the docs get refreshed against a HEAD that has these commits.

---

# Daemon 开发者文档 (中文)

这是 **qwen-code daemon 模式**面向开发者的技术文档集 —— 涵盖 `qwen serve` HTTP daemon、底层的 `acp-bridge` 包、工作区粒度的 MCP transport 池、多客户端权限协调器、Typed Daemon Event Schema v1、TypeScript SDK daemon 客户端，以及所有上层适配器（CLI TUI、IM 渠道机器人、VSCode IDE 等）。

它是对现有文档的补充，而不是替代：

| 现有文档 | 受众 | 仍是该主题的事实来源 |
|---|---|---|
| [`../../users/qwen-serve.md`](../../users/qwen-serve.md) | 运维 / 使用者 | 启动方式、命令行参数、威胁模型 |
| [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md) | 协议实现者 | HTTP 路由清单、请求/响应结构、错误码 |
| [`../examples/daemon-client-quickstart.md`](../examples/daemon-client-quickstart.md) | SDK 使用者 | TS 端到端示例 |
| [`../daemon-client-adapters/`](../daemon-client-adapters/) | 适配器作者（草案） | 每种客户端的设计草案 |

如果你想 **启动一个 daemon 并使用它**，先看 `qwen-serve.md`；如果你想 **基于 wire 协议构建一个客户端**，先看 `qwen-serve-protocol.md`；如果你想 **理解 daemon 内部如何工作、扩展它或调试它**，就读这个文档集。

## 阅读顺序

按目标挑路径：

- **新贡献者** — 依次：`01 → 02 → 03 → 08 → 09 → 10 → 11 → 12`，覆盖系统、运行时、bridge、wire 侧基础。
- **新增客户端适配器** — `01 → 09 → 10 → 13 → (14 / 15 / 16)`：架构、事件模式、SSE bus、SDK，再看与你最接近的适配器。
- **修改 MCP 池 / 预算** — `01 → 03 → 05 → 06`。
- **修改权限相关代码** — `01 → 03 → 04 → 12`。
- **线上排查问题** — `17 → 19 → 18`。

## 文档清单

### 基础

- [`01-architecture.md`](./01-architecture.md) — 系统架构、进程拓扑、包关系、6 张顶层时序图。

### 服务端核心

- [`02-serve-runtime.md`](./02-serve-runtime.md) — `runQwenServe` 引导、Express 应用、中间件链、优雅退出。
- [`03-acp-bridge.md`](./03-acp-bridge.md) — `@qwen-code/acp-bridge` 包内部、会话多路复用、channel 工厂、ACP 子进程拉起。
- [`04-permission-mediation.md`](./04-permission-mediation.md) — `MultiClientPermissionMediator` 四种策略、N1 超时不变式、取消哨兵。
- [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) — F2 引入的 `McpTransportPool`、池条目、反向索引、重启、drain。
- [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md) — `WorkspaceMcpBudget`、模式（off/warn/enforce）、滞回阈值、批量拒绝合并。
- [`07-workspace-filesystem.md`](./07-workspace-filesystem.md) — `WorkspaceFileSystem` 沙箱、路径策略、审计、`BridgeFileSystem` 契约。
- [`08-session-lifecycle.md`](./08-session-lifecycle.md) — 创建 / 附加 / 载入 / 恢复、`X-Qwen-Client-Id`、心跳、剔除、元数据。
- [`09-event-schema.md`](./09-event-schema.md) — Typed Event Schema v1：28 种已知事件、payload、reducer、向前兼容。
- [`10-event-bus.md`](./10-event-bus.md) — `EventBus`、单调 ID、环形缓冲重放、`Last-Event-ID`、慢消费者反压、`client_evicted`。
- [`11-capabilities-versioning.md`](./11-capabilities-versioning.md) — 能力注册表、协议版本、Schema 版本、条件广播。
- [`12-auth-security.md`](./12-auth-security.md) — Bearer 中间件、Host 白名单、CORS 拒绝、Mutation Gate、`--require-auth`、`/health` 豁免、Device Flow。

### 客户端

- [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md) — TS SDK：`DaemonClient`、`DaemonSessionClient`、`DaemonAuthFlow`、SSE 解析器、事件 reducer。
- [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md) — CLI Ink TUI 转走 daemon、不再内嵌 agent。
- [`15-channel-adapters.md`](./15-channel-adapters.md) — `DaemonChannelBridge` 共享基座 + 钉钉、微信、Telegram 适配器。
- [`16-vscode-ide-adapter.md`](./16-vscode-ide-adapter.md) — `DaemonIdeConnection`、Loopback 强制、Webview 桥接。

### 参考附录

- [`17-configuration.md`](./17-configuration.md) — 影响 daemon 的环境变量、命令行参数、`settings.json` 键。
- [`18-error-taxonomy.md`](./18-error-taxonomy.md) — 各层的 typed error 与修复建议。
- [`19-observability.md`](./19-observability.md) — `QWEN_SERVE_DEBUG`、调试套路、Telemetry 现状缺口。

## 术语表

- **ACP** — Agent Client Protocol，daemon bridge 与 ACP 子进程之间通过 stdio 跑的 JSON-RPC；不要和客户端用来访问 daemon 的 HTTP 协议混淆。
- **ACP 子进程** — daemon 拉起的子进程（`qwen --acp`），里面跑真正的 agent 运行时；daemon 的 bridge 把一个 ACP 子进程多路复用给多个连进来的客户端。
- **acp-bridge** — `@qwen-code/acp-bridge` 包（`packages/acp-bridge/`），负责会话多路复用、权限协调器、事件总线、channel 工厂。
- **BridgeClient** — `packages/acp-bridge/src/bridgeClient.ts`，封装一条 ACP `ClientSideConnection`，处理 `requestPermission` / `sendPrompt` / `cancelSession`。
- **Channel 工厂** — 可插拔策略，决定 bridge 如何拉起 / 附加 ACP 子进程：默认 `spawnChannel` 把 `qwen --acp` 跑成子进程；`inMemoryChannel` 在进程内跑用于测试。
- **DaemonClient** — `packages/sdk-typescript/src/daemon/DaemonClient.ts`，TS SDK 对 daemon 的 HTTP 门面。
- **DaemonSessionClient** — `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`，会话级封装，自动跟踪 `lastSeenEventId` 用于 SSE 重放。
- **EventBus** — `packages/acp-bridge/src/eventBus.ts`，按会话维度的内存 pub/sub：单调 ID、环形缓冲、每订阅者反压。
- **F1 / F2 / F3 / F4** — [#4175](https://github.com/QwenLM/qwen-code/issues/4175) 的里程碑：F1 bridge 抽取 + `BridgeFileSystem`；F2 工作区共享 MCP transport 池；F3 多客户端权限协调；F4 协议补齐 + `qwen --serve` 同进程托管（进行中）。
- **MCP** — Model Context Protocol，MCP server 暴露 tool / resource / prompt，daemon 的 ACP 子进程连这些 server。
- **McpTransportPool** — `packages/core/src/tools/mcp-transport-pool.ts`，F2 的工作区共享池，按 (server 名 + 配置指纹) 复用一个 MCP transport。
- **Mediator policy** — `first-responder` / `designated` / `consensus` / `local-only` 之一，决定多客户端权限投票如何裁决。
- **Originator client id** — 触发当前权限请求的那次 prompt 所用的 `X-Qwen-Client-Id`，`designated` 策略只接受这个 id 的投票。
- **PoolEntry** — `packages/core/src/tools/mcp-pool-entry.ts`，`McpTransportPool` 里的一条记录：一条 MCP transport、引用此条目的会话引用计数、空闲 drain 定时器。
- **Session scope** — `single`（所有客户端共享一个 ACP 会话）或 `per-client`（每客户端一个会话），默认 `single`。
- **SSE** — Server-Sent Events，daemon 的出站事件通道（`GET /session/:id/events`）。
- **Workspace** — daemon 启动时绑定的目录（`--workspace` 或 `cwd`），一个 daemon 进程 = 一个 workspace。

## 本文档集**不**覆盖的内容

- **Java / Python SDK 的 daemon 客户端** — 目前只有 TS SDK 有 daemon 客户端，第 13 篇只覆盖 TS。
- **Web UI (`packages/webui/`)** — 这是一个组件库，渲染宿主（如 VSCode webview）传进来的 ACP / JSONL 消息，本身不是 daemon HTTP 客户端，不单独成章。
- **Zed extension (`packages/zed-extension/`)** — 直接用 stdio ACP 拉起 `qwen --acp`，不走 daemon，不需要 daemon 章节。
- **F4（进行中）** — 协议补齐和 `qwen --serve` 同进程托管。写文档时该 surface 还不稳定，等落地后再补章。

## `daemon_mode_b_main` 上即将到来的 F4 prereq（提醒）

本文档集锁定在 `worktree-enumerated-stirring-adleman`（HEAD `cb206da36`）。`daemon_mode_b_main` 已经有 3 个 F4-prereq commit 还没合到本 worktree —— 它们都是**纯加法**的 wire shape 变更，本文档集仍然适用，merge 后会多出以下 surface：

| Commit | 加了什么 |
|---|---|
| `14637cd79` `feat(serve): stamp serverTimestamp / tool provenance / errorKind on daemon events` | 给每帧 SSE 加 `_meta.serverTimestamp`（在 `formatSseFrame` 边界盖，而不是 `EventBus.publish`，内部消费方不会看到 `_meta`）。给 `ToolCallEmitter.emit{Start,Result,Error}` 加 `tool_call.provenance`（`'builtin' \| 'mcp' \| 'subagent'`）+ `serverId?`。加顶层 `errorKind` envelope 字段 |
| `c1a2f0a78` `feat(serve+sdk): detect SSE ring eviction on resume, expose state_resync_required` | 加 **第 29 种** 已知事件 —— `state_resync_required` 合成终态帧，在 `EventBus.subscribe()` 重放路径检测到 `lastEventId < ringHead` 时强推。携带 `{ reason: 'ring_evicted', lastDeliveredId, earliestAvailableId }`，与其它合成终态一致**无 `id`**。告诉重连消费方做完整 `loadSession` 而不是继续 apply delta |
| `74412919c` `fix(acp-bridge): preserve FsError structure over ACP wire` | 在 `BridgeClient.writeTextFile/readTextFile` 里捕获 `BridgeFileSystem` 适配器抛的 `FsError`，重抛为 ACP `RequestError(-32603, message, {errorKind, hint, status})`，agent 的 RPC client 拿到 typed `errorKind` 而不是去 regex-on-message |

第 07 篇已经讲清 FsError 契约；第 09 篇已经讲清向前兼容（未知 event type 自动 fallback 到 `kind: 'unknown'`）。F4 prereq 落进来时这两条都不破。文档对齐到包含这些 commit 的 HEAD 时再重读这一节即可。
