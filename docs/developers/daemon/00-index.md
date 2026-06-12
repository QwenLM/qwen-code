# Daemon 开发者文档

这是 **qwen-code daemon 模式**面向开发者的技术文档集 —— 涵盖 `qwen serve` HTTP daemon、底层的 `acp-bridge` 包、工作区粒度的 MCP transport 池、多客户端权限协调器、Typed Daemon Event Schema v1、TypeScript SDK daemon 客户端，以及所有上层适配器（CLI TUI、IM 渠道机器人、VSCode IDE 等）。

它是对现有文档的补充，而不是替代：

| 现有文档                                                                             | 受众               | 仍是该主题的事实来源                                                   |
| ------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------- |
| [`../../users/qwen-serve.md`](../../users/qwen-serve.md)                             | 运维 / 使用者      | 启动方式、命令行参数、威胁模型                                         |
| [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)                             | 协议实现者         | HTTP 路由清单、请求/响应结构、错误码                                   |
| [`../examples/daemon-client-quickstart.md`](../examples/daemon-client-quickstart.md) | SDK 使用者         | TS 端到端示例                                                          |
| [`../daemon-client-adapters/`](../daemon-client-adapters/)                           | 适配器作者（草案） | 每种客户端的设计草案                                                   |
| [`../../design/f2-mcp-transport-pool.md`](../../design/f2-mcp-transport-pool.md)     | F2 维护者          | 工作区共享 MCP transport 池设计 v2.2（32 条 review fold-in changelog） |

如果你想 **快速把 daemon 跑起来 + 验证它工作**，直接看 [`20-quickstart-operations.md`](./20-quickstart-operations.md)；如果你想 **基于 wire 协议构建一个客户端**，先看 `qwen-serve-protocol.md`；如果你想 **理解 daemon 内部如何工作、扩展它或调试它**，就读本文档集 01–19。

## 阅读顺序

按目标挑路径：

- **想先跑起来再看原理** — 直接 `20 → 17 → 19`（快速上手 + 配置 + 调试），有问题再回来看 01 + 02。
- **新贡献者** — 依次：`01 → 02 → 03 → 08 → 09 → 10 → 11 → 12`，覆盖系统、运行时、bridge、wire 侧基础。`20` 任意时候作为「跑起来怎么验」的副本。
- **新增客户端适配器** — `01 → 09 → 10 → 13 → (14 / 15 / 16)`：架构、事件模式、SSE bus、SDK，再看与你最接近的适配器。
- **修改 MCP 池 / 预算** — `01 → 03 → 05 → 06`。
- **修改权限相关代码** — `01 → 03 → 04 → 12`。
- **线上排查问题** — `19 → 18 → 17 → 20`。

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
- [`09-event-schema.md`](./09-event-schema.md) — Typed Event Schema v1：43 种已知事件、payload、reducer、向前兼容。
- [`10-event-bus.md`](./10-event-bus.md) — `EventBus`、单调 ID、环形缓冲重放、`Last-Event-ID`、慢消费者反压、`client_evicted`。
- [`11-capabilities-versioning.md`](./11-capabilities-versioning.md) — 能力注册表、协议版本、Schema 版本、条件广播。
- [`12-auth-security.md`](./12-auth-security.md) — Bearer 中间件、Host 白名单、CORS 拒绝、Mutation Gate、`--require-auth`、`/health` 豁免、Device Flow。

### 客户端

- [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md) — TS SDK：`DaemonClient`、`DaemonSessionClient`、`DaemonAuthFlow`、SSE 解析器、事件 reducer，以及新的 `ui/*` 子包。
- [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md) — **共享 UI Transcript 层**（SDK `ui/*`）。原 `DaemonTuiAdapter.ts` 仍是 CLI 侧 legacy 实验适配器；本篇覆盖新的 transcript 归一 / reduce / selector 原语与 webui `DaemonSessionProvider` 消费方。
- [`15-channel-adapters.md`](./15-channel-adapters.md) — `DaemonChannelBridge` 共享基座 + 钉钉、微信、Telegram 适配器。
- [`16-vscode-ide-adapter.md`](./16-vscode-ide-adapter.md) — `DaemonIdeConnection`、Loopback 强制、Webview 桥接。

### 参考附录

- [`17-configuration.md`](./17-configuration.md) — 影响 daemon 的环境变量、命令行参数、`settings.json` 键。
- [`18-error-taxonomy.md`](./18-error-taxonomy.md) — 各层的 typed error 与修复建议。
- [`19-observability.md`](./19-observability.md) — `QWEN_SERVE_DEBUG`、调试套路、Telemetry 现状缺口。

### 快速上手 / 运维向

- [`20-quickstart-operations.md`](./20-quickstart-operations.md) — 9 种启动姿势、全部 CLI 参数 / env / `settings.json` 速查表、boot 拒启动场景、`curl` 验证清单、`/demo` 用法、`qwen serve` → listening server 的完整调用链、嵌入式调用示例、优雅退出 vs 强退。**想先跑起来再看原理的话从这篇开始。**

## 术语表

- **ACP** — Agent Client Protocol，daemon bridge 与 ACP 子进程之间通过 stdio 跑的 JSON-RPC；不要和客户端用来访问 daemon 的 HTTP 协议混淆。
- **ACP 子进程** — daemon 拉起的子进程（`qwen --acp`），里面跑真正的 agent 运行时；daemon 的 bridge 把一个 ACP 子进程多路复用给多个连进来的客户端。
- **acp-bridge** — `@qwen-code/acp-bridge` 包（`packages/acp-bridge/`），负责会话多路复用、权限协调器、事件总线、channel 工厂。
- **BridgeClient** — `packages/acp-bridge/src/bridgeClient.ts`，封装一条 ACP `ClientSideConnection`，处理 `requestPermission` / `sendPrompt` / `cancelSession`。
- **Channel 工厂** — 可插拔策略，决定 bridge 如何拉起 / 附加 ACP 子进程：默认 `spawnChannel` 把 `qwen --acp` 跑成子进程；`inMemoryChannel` 在进程内跑用于测试。
- **DaemonClient** — `packages/sdk-typescript/src/daemon/DaemonClient.ts`，TS SDK 对 daemon 的 HTTP 门面。
- **DaemonSessionClient** — `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`，会话级封装，自动跟踪 `lastSeenEventId` 用于 SSE 重放。
- **EventBus** — `packages/acp-bridge/src/eventBus.ts`，按会话维度的内存 pub/sub：单调 ID、环形缓冲、每订阅者反压。
- **F1 / F2 / F3 / F4** — [#4175](https://github.com/QwenLM/qwen-code/issues/4175) 的里程碑：F1 bridge 抽取 + `BridgeFileSystem`；F2 工作区共享 MCP transport 池；F3 多客户端权限协调；F4 协议补齐。
- **MCP** — Model Context Protocol，MCP server 暴露 tool / resource / prompt，daemon 的 ACP 子进程连这些 server。
- **McpTransportPool** — `packages/core/src/tools/mcp-transport-pool.ts`，F2 的工作区共享池，按 (server 名 + 配置指纹) 复用一个 MCP transport。
- **Mediator policy** — `first-responder` / `designated` / `consensus` / `local-only` 之一，决定多客户端权限投票如何裁决。
- **Originator client id** — 触发当前权限请求的那次 prompt 所用的 `X-Qwen-Client-Id`，`designated` 策略只接受这个 id 的投票。
- **PoolEntry** — `packages/core/src/tools/mcp-pool-entry.ts`，`McpTransportPool` 里的一条记录：一条 MCP transport、引用此条目的会话引用计数、空闲 drain 定时器。
- **Session scope** — `single`（所有客户端共享一个 ACP 会话）或 `thread`（每客户端一个会话），默认 `single`。
- **SSE** — Server-Sent Events，daemon 的出站事件通道（`GET /session/:id/events`）。
- **Workspace** — daemon 启动时绑定的目录（`--workspace` 或 `cwd`），一个 daemon 进程 = 一个 workspace。

## 本文档集**不**覆盖的内容

- **Java / Python SDK 的 daemon 客户端** — 目前只有 TS SDK 有 daemon 客户端，第 13 篇只覆盖 TS。
- **Web UI 详细产品形态** — 自 [#4328](https://github.com/QwenLM/qwen-code/pull/4328) 起 `packages/webui/src/daemon/` 已经是真正的 daemon 前端（React `DaemonSessionProvider` + transcriptAdapter，消费 SDK `ui/*` 子包）。架构走法和 selectors 在 [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md) 一并讲；webui 自身的产品形态（设计、布局、复用到哪里）参考 [`../daemon-client-adapters/web-ui.md`](../daemon-client-adapters/web-ui.md) 与 [`../daemon-ui/README.md`](../daemon-ui/README.md)。
- **Zed extension (`packages/zed-extension/`)** — 直接用 stdio ACP 拉起 `qwen --acp`，不走 daemon，不需要 daemon 章节。
- **未落地或实验性的进程内托管形态** — 本文档集聚焦当前 `main` 已落地的 `qwen serve` HTTP bridge surface；不把未稳定暴露的内部托管形态当作事实源。

## 当前 daemon mode 覆盖的功能

下表列出本文档集覆盖的所有功能 surface，按域归类。每条都是 daemon mode 完整产品的一部分，不是「增量」或「PR 合入清单」。

### 服务端核心

| Surface                                                                                                                                                                                           | 实现位置                                                                                                                             | 文档落点                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `qwen serve` 引导与 Express 装配                                                                                                                                                                  | `packages/cli/src/serve/runQwenServe.ts`、`server.ts`                                                                                | [`02-serve-runtime.md`](./02-serve-runtime.md)                 |
| ACP bridge 与会话多路复用                                                                                                                                                                         | `packages/acp-bridge/src/bridge.ts` 等                                                                                               | [`03-acp-bridge.md`](./03-acp-bridge.md)                       |
| 多客户端权限协调（four-policy mediator + N1 timeout invariant + cancel sentinel）                                                                                                                 | `packages/acp-bridge/src/permissionMediator.ts`                                                                                      | [`04-permission-mediation.md`](./04-permission-mediation.md)   |
| 工作区共享 MCP transport 池（含 fingerprint / OAuth 凭证隔离、子进程 descendant 清理、IDE-close drain、`/mcp refresh` pool gate、reconnect 期 `MCPCallInterruptedError`、`MAX_IDLE_MS` 孤儿回收） | `packages/core/src/tools/mcp-transport-pool.ts`、`mcp-pool-entry.ts`、`mcp-pool-key.ts`、`pid-descendants.ts`、`session-mcp-view.ts` | [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md)       |
| MCP workspace budget guardrails                                                                                                                                                                   | `packages/core/src/tools/mcp-workspace-budget.ts`                                                                                    | [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md) |
| Workspace FS 沙箱、TOCTOU / symlink / trust gate / atomic write / FsError-over-ACP-wire                                                                                                           | `packages/cli/src/serve/fs/`、`packages/acp-bridge/src/bridgeClient.ts`                                                              | [`07-workspace-filesystem.md`](./07-workspace-filesystem.md)   |
| Session 生命周期：create / attach / load / resume / heartbeat / eviction / `X-Qwen-Client-Id` 身份                                                                                                | `packages/acp-bridge/src/bridge.ts`、`bridgeTypes.ts`                                                                                | [`08-session-lifecycle.md`](./08-session-lifecycle.md)         |

### Wire 协议

| Surface                                                                                                                                                          | 实现位置                                                                                                                       | 文档落点                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Typed event schema v1（43 种已知 event type，含 `state_resync_required` 同步恢复帧、SDK reducer `awaitingResync` 状态机、`RESYNC_PASSTHROUGH_TYPES` 终态白名单） | `packages/sdk-typescript/src/daemon/events.ts`                                                                                 | [`09-event-schema.md`](./09-event-schema.md)                       |
| Envelope 级元数据：每帧 `_meta.serverTimestamp`（多客户端时钟一致性）、`tool_call.provenance` + `serverId`（在 `data._meta`）                                    | `packages/cli/src/serve/server.ts` 的 `formatSseFrame`、`packages/cli/src/acp-integration/session/emitters/ToolCallEmitter.ts` | [`09-event-schema.md`](./09-event-schema.md)                       |
| SSE event bus：单调 ID、环形缓冲重放、`Last-Event-ID`、慢消费者反压、环驱逐 → `state_resync_required` 恢复路径                                                   | `packages/acp-bridge/src/eventBus.ts`                                                                                          | [`10-event-bus.md`](./10-event-bus.md)                             |
| 能力协商：注册表、协议版本、条件广播                                                                                                                             | `packages/cli/src/serve/capabilities.ts`                                                                                       | [`11-capabilities-versioning.md`](./11-capabilities-versioning.md) |
| 认证与安全模型：bearer + host allowlist + CORS deny + mutation gate + `--require-auth` + `/health` 豁免 + device-flow OAuth                                      | `packages/cli/src/serve/auth.ts`、`packages/cli/src/serve/auth/deviceFlow.ts`                                                  | [`12-auth-security.md`](./12-auth-security.md)                     |

### 客户端 / SDK

| Surface                                                                                                                                                        | 实现位置                                                                                                                     | 文档落点                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| TS SDK daemon client（HTTP/SSE 门面、session 封装、SSE replay、device-flow helper、330s `MCP_RESTART_DEFAULT_TIMEOUT_MS`）                                     | `packages/sdk-typescript/src/daemon/{DaemonClient,DaemonSessionClient,DaemonAuthFlow,sse,events,types}.ts`                   | [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md)          |
| 共享 UI Transcript 层（`DaemonUiEventType` 36 种 UI 友好事件、reducer + selectors、HTML / terminal / tool preview / conformance 渲染原语，给任何 UI 宿主复用） | `packages/sdk-typescript/src/daemon/ui/{types,normalizer,transcript,store,render,terminal,toolPreview,conformance,utils}.ts` | [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md)              |
| Web UI daemon 前端（React `DaemonSessionProvider` + transcriptAdapter，第一个共享 UI 层消费方）                                                                | `packages/webui/src/daemon/`                                                                                                 | [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md) 「消费方」段 |
| IM channel 适配器（钉钉 / 微信 / Telegram，共享 `DaemonChannelBridge` 基座）                                                                                   | `packages/channels/`                                                                                                         | [`15-channel-adapters.md`](./15-channel-adapters.md)            |
| VSCode IDE daemon 适配器（loopback 强制、webview postMessage 桥接）                                                                                            | `packages/vscode-ide-companion/src/services/daemonIdeConnection.ts`                                                          | [`16-vscode-ide-adapter.md`](./16-vscode-ide-adapter.md)        |

### 参考与运维

| Surface                                          | 文档落点                                                       |
| ------------------------------------------------ | -------------------------------------------------------------- |
| 全部 env / CLI 参数 / `settings.json` 速查       | [`17-configuration.md`](./17-configuration.md)                 |
| 各层 typed error 与修复建议                      | [`18-error-taxonomy.md`](./18-error-taxonomy.md)               |
| `QWEN_SERVE_DEBUG`、调试套路、telemetry 现状缺口 | [`19-observability.md`](./19-observability.md)                 |
| 启动姿势、`curl` 验证清单、`/demo`、调用链       | [`20-quickstart-operations.md`](./20-quickstart-operations.md) |

### 历史 / 已弃用 surface

- **`packages/cli/src/ui/daemon/DaemonTuiAdapter.ts`** 仍存在，是 CLI 侧 legacy 实验适配器；共享 UI Transcript 层（第 14 篇）是 SDK 侧复用方向。CLI TUI、channel base、VSCode IDE 三条产品路径会陆续迁过去，迁移指南见 [`../daemon-ui/MIGRATION.md`](../daemon-ui/MIGRATION.md)。
- **`docs/developers/daemon-client-adapters/tui.md`** 草案已过时（描述的是早期 `DaemonTuiAdapter` spike），请参考 [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md)。新的 [`../daemon-client-adapters/web-ui.md`](../daemon-client-adapters/web-ui.md) 是 web UI 适配器的设计草案。

### 向前兼容

- Event schema 是加法协议：未知 type 由 `asKnownDaemonEvent` 返回 `undefined`，计入 `unrecognizedKnownEventCount`，SDK 消费方不会因为新增 event type 而崩。
- `mcp_server_restart_refused.reason` 是封闭枚举（`MCP_RESTART_REFUSED_REASONS.has` 闸），新加的枚举值在老 SDK 上会被静默丢弃 —— 新 reason 必须配新 SDK 一起发。
- envelope 上的 `_meta` 走宽松 spread merge，未来加新元数据字段不会破老解析器。

### 版本溯源

这套文档对齐到 `daemon_mode_b_main` 当前 HEAD。覆盖到的源 PR 时间线见 [`#4175`](https://github.com/QwenLM/qwen-code/issues/4175) 的 F 系列里程碑（F1 acp-bridge 抽取 / F2 MCP transport 池 / F3 多客户端权限协调 / F4 协议补齐）。如果要追某条具体功能的提交历史，从对应专题文档底部「参考」节的 PR # 进去比较快。
