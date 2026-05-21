# ACP Bridge (English)

## Overview

`packages/acp-bridge/` is the package that owns the seam between the daemon's HTTP layer and the ACP child process. It is consumed by `packages/cli/src/serve/` (the `qwen serve` daemon) and was lifted in #4175 F1 step 3 so future consumers (`channels/base/AcpBridge.ts`, the VSCode IDE companion) can use the same bridge core without reaching into the cli package.

The bridge gives you: one `HttpAcpBridge` instance, one `AcpChannel` to the ACP child, multiplexed sessions over that channel, per-session `EventBus`es, a `MultiClientPermissionMediator`, a `BridgeFileSystem` adapter, and ACP-shaped helpers (`spawnOrAttach`, `loadSession`, `resumeSession`, `sendPrompt`, `cancelSession`, `respondToPermission`, plus extMethod RPCs for workspace status and MCP restart).

## Responsibilities

- Spawn or attach to the ACP child via a pluggable `ChannelFactory`. Default factory: `defaultSpawnChannelFactory` (subprocess `qwen --acp`). Tests inject `inMemoryChannel`.
- Maintain `aliveChannels` (channel registry) and `byId` (session registry).
- Multiplex N HTTP-side sessions onto one ACP child via `connection.newSession()`.
- Serialize per-session prompts through `promptQueue` (ACP enforces one active prompt per session).
- Per-session FIFO for `setSessionModel` calls so concurrent attaches with different models don't race the agent.
- Per-session `EventBus` that drives `GET /session/:id/events` (see [`10-event-bus.md`](./10-event-bus.md)).
- Permission flow: `BridgeClient.requestPermission` → `MultiClientPermissionMediator.request` → fan-out → vote collection → ACP response (see [`04-permission-mediation.md`](./04-permission-mediation.md)).
- File I/O: `BridgeFileSystem` adapter for ACP `readTextFile` / `writeTextFile` calls (see [`07-workspace-filesystem.md`](./07-workspace-filesystem.md)).
- extMethod RPCs for workspace-level status (`/workspace/mcp`, `/workspace/skills`, `/workspace/providers`) and MCP restart.
- Lifecycle: graceful `shutdown()` with `KILL_HARD_DEADLINE_MS` (10s) per channel; synchronous `killAllSync()` for second-signal force-exit.

## Architecture

**Public entry**: `createHttpAcpBridge(opts: BridgeOptions): HttpAcpBridge` in `packages/acp-bridge/src/bridge.ts:350+`.

**Key types**:

| Type | File | Role |
|---|---|---|
| `HttpAcpBridge` | `bridgeTypes.ts:30-180+` | Public interface: `spawnOrAttach`, `loadSession`, `resumeSession`, `sendPrompt`, `cancelSession`, `subscribeEvents`, `respondToPermission`, `getWorkspaceMcpStatus`, `restartMcpServer`, `shutdown`, `killAllSync`, … |
| `BridgeSession` | `bridgeTypes.ts:49+` | `{ sessionId, workspaceCwd, attached, clientId?, createdAt? }` returned to HTTP handlers. |
| `BridgeOptions` | `bridgeOptions.ts:88-323` | Construction-time config (see [Configuration](#configuration)). |
| `AcpChannel` | `channel.ts:21-50` | `{ stream, kill(), killSync(), exited }` — one ACP NDJSON channel. |
| `ChannelFactory` | `channel.ts:57-60` | `(workspaceCwd, childEnvOverrides?) => Promise<AcpChannel>`. |
| `BridgeClient` | `bridgeClient.ts:1-150+` | Wraps one ACP `ClientSideConnection`; implements ACP `Client` (`requestPermission`, `readTextFile`, `writeTextFile`, `sessionUpdate`, `extNotification`). |
| `EventBus` | `eventBus.ts` | Per-session in-memory pub/sub. See [`10-event-bus.md`](./10-event-bus.md). |
| `MultiClientPermissionMediator` | `permissionMediator.ts:1-1292` | Four-policy mediator. See [`04-permission-mediation.md`](./04-permission-mediation.md). |

**Internal state (closed over by `createHttpAcpBridge`)**:

| State | Shape | Purpose |
|---|---|---|
| `aliveChannels` | `Map<string, ChannelInfo>` | Channel registry keyed by channel id. Each `ChannelInfo` holds `channel`, `connection`, `client` (one `BridgeClient` per channel), `sessionIds: Set<string>`, `pendingRestoreIds`, `statusClosedReject?`, `isDying: boolean`. |
| `byId` | `Map<string, SessionEntry>` | Session registry keyed by sessionId. Each `SessionEntry` holds `channel`, `connection`, `events: EventBus`, `promptQueue: Promise<void>`, `modelChangeQueue: Promise<void>`, `pendingPermissionIds: Set<string>`, `clientIds: Map<string, count>`, `activePromptOriginatorClientId?`, `attachCount`, `spawnOwnerWantedKill`, `restoreState?`, `sessionLastSeenAt?`, `clientLastSeenAt: Map<string, ms>`. |
| `defaultEntry` | `SessionEntry \| null` | The "single" session used when `sessionScope: 'single'`. |
| `defaultPolicy` | `PermissionPolicy` | Configured via `BridgeOptions.permissionPolicy`. |
| `mediator` | `MultiClientPermissionMediator` | One per bridge instance. |
| Constants | — | `DEFAULT_INIT_TIMEOUT_MS = 10_000`, `MCP_RESTART_TIMEOUT_MS = 300_000`, `DEFAULT_MAX_SESSIONS = 20`, `MAX_EVENT_RING_SIZE = 1_000_000`, `DEFAULT_PERMISSION_TIMEOUT_MS = 5min`, `DEFAULT_MAX_PENDING_PER_SESSION = 64`. |

**`isDying` invariant**: any teardown path must set `ChannelInfo.isDying = true` synchronously **before** awaiting `channel.kill()`. `ensureChannel` treats a dying channel as absent and spawns a fresh one. Without this flag a concurrent `spawnOrAttach` arriving during the SIGTERM grace window (up to 10s) would attach to a transport about to close and the caller's sessionId would 404 on every follow-up. **Set sites** (must keep in sync): `ensureChannel` (initialize failure + late-shutdown re-check), `doSpawn` (newSession failure on empty channel), `killSession` (last session leaving), `shutdown` (bulk).

**`BkUyD invariant`**: do **not** clear `channelInfo` when setting `isDying = true`. `killAllSync` must still find the channel during the SIGTERM grace window to fire SIGKILL on `process.exit(1)`. `aliveChannels` holds the dying entry until `channel.exited` fires.

**BridgeClient bounded buffering**: ACP `extNotification` frames arriving on `BridgeClient` for a sessionId not yet in `byId` (because `connection.newSession`'s response hasn't returned, but MCP discovery inside `newSession` already fired budget events) are buffered into an early-events queue bounded by `MAX_EARLY_EVENT_SESSIONS = 64` × `MAX_EARLY_EVENTS_PER_SESSION = 32` × `EARLY_EVENT_TTL_MS = 60_000`. Worst case ~400 KB heap. Without buffering, the first SSE replay-ring slot for a new session would be missing events that fired during its creation.

## Workflow

### `spawnOrAttach` (the most-used entry)

```mermaid
sequenceDiagram
    autonumber
    participant R as Route handler
    participant B as createHttpAcpBridge closure
    participant CF as ChannelFactory
    participant CH as AcpChannel
    participant ACP as ACP child
    participant M as Mediator

    R->>B: spawnOrAttach({cwd?, sessionScope?, clientId?})
    B->>B: validate cwd vs boundWorkspace<br/>(WorkspaceMismatchError)
    alt sessionScope=single and defaultEntry exists
        B->>B: bump attachCount<br/>register clientId
        B-->>R: {sessionId, attached: true, restoreState?}
    else cold path
        B->>CF: factory(workspaceCwd, childEnvOverrides)
        CF->>ACP: spawn qwen --acp + pipes
        CF-->>B: AcpChannel
        B->>ACP: ACP initialize (timeout=DEFAULT_INIT_TIMEOUT_MS)
        ACP-->>B: initialize response
        B->>ACP: connection.newSession({cwd})
        ACP-->>B: {sessionId}
        B->>B: build SessionEntry<br/>register in byId / defaultEntry
        B-->>R: {sessionId, attached: false}
    end
```

`SessionLimitExceededError` is thrown when `byId.size >= maxSessions`. `InvalidClientIdError` is thrown if `X-Qwen-Client-Id` is outside `[A-Za-z0-9._:-]{1,128}`. The disconnect-reaper in `server.ts` tracks the spawn owner via `attachCount`/`spawnOwnerWantedKill` to avoid tearing down a session whose spawn owner disconnected but other clients already attached (review #3889 BQ9tV).

### Prompt serialization

```mermaid
sequenceDiagram
    autonumber
    participant R as Route
    participant E as SessionEntry
    participant Q as promptQueue (FIFO)
    participant BC as BridgeClient
    participant ACP as ACP child

    R->>E: sendPrompt(sessionId, body, clientId)
    E->>E: set activePromptOriginatorClientId = clientId
    E->>Q: chain off resolved tail
    Q->>BC: client.sendPrompt(sessionId, body)
    BC->>ACP: ACP prompt JSON-RPC
    ACP-->>BC: response (after potentially multiple requestPermission roundtrips)
    BC-->>E: result
    E->>E: clear activePromptOriginatorClientId
    E-->>R: result
```

Failures at the queue tail are **swallowed** so that a prior prompt's rejection doesn't poison subsequent prompts; the original caller still receives the rejection on its own returned promise. The `transportClosedReject` cached on the session races the prompt promise against `channel.exited` so a crashed child surfaces immediately rather than hanging.

### Permission flow (high-level)

```mermaid
sequenceDiagram
    autonumber
    participant ACP as ACP child (agent)
    participant BC as BridgeClient.requestPermission
    participant E as SessionEntry
    participant M as Mediator
    participant EB as EventBus

    ACP->>BC: requestPermission(requestId, options)
    BC->>E: record requestId in pendingPermissionIds
    BC->>M: request({requestId, sessionId, originatorClientId, allowedOptionIds}, timeoutMs)
    M->>EB: publish permission_request (fan-out to subscribers)
    Note over M: waits for vote / timeout / cancel
    M-->>BC: PermissionResolution
    BC-->>ACP: RequestPermissionResponse (selected or cancelled)
    BC->>E: clear requestId
```

`InvalidPermissionOptionError` is thrown pre-mediator when a wire vote tries to inject `CANCEL_VOTE_SENTINEL` via the normal `optionId` field — the sentinel is the bridge's only escape hatch to short-circuit a request as `cancelled / agent_cancelled` and must not be reachable from the wire by accident. See [`04-permission-mediation.md`](./04-permission-mediation.md).

### Shutdown

```mermaid
sequenceDiagram
    autonumber
    participant Op as runQwenServe
    participant B as Bridge
    participant CHs as Channels
    participant M as Mediator

    Op->>B: shutdown()
    B->>CHs: mark every ChannelInfo isDying = true (bulk)
    B->>M: forgetSession for every sessionId (pending → cancelled/session_closed)
    par per channel
        B->>CHs: channel.kill() (await up to KILL_HARD_DEADLINE_MS = 10s)
        CHs-->>B: exited
    end
    B-->>Op: done
    Note over Op,B: Second signal → killAllSync()<br/>(fire SIGKILL on every alive child synchronously)
```

## Channel factory

`AcpChannel` (`channel.ts:21-50`) is the bridge's transport abstraction. Production uses `defaultSpawnChannelFactory` in `spawnChannel.ts`, which runs `qwen --acp` as a subprocess with a stdio pipe pair. Tests inject `inMemoryChannel` to run the agent in-process. The bridge knows nothing about the underlying mechanism — it only needs `{ stream, kill, killSync, exited }`.

`ChannelFactory` accepts `childEnvOverrides` so each daemon handle can pass its own MCP-budget env vars (`QWEN_SERVE_MCP_CLIENT_BUDGET`, `QWEN_SERVE_MCP_BUDGET_MODE`) without mutating `process.env` (which would race when two embedded daemons run in the same Node process).

## State & Lifecycle

- Bridge construction is synchronous; the first `spawnOrAttach` cold-starts the ACP child.
- `defaultEntry` lives for the lifetime of the bridge under `sessionScope: 'single'`; the channel reaps when `sessionIds.size === 0` (after `killSession`) AND `isDying` flips true.
- `MAX_EVENT_RING_SIZE = 1_000_000` is a soft upper bound on `BridgeOptions.eventRingSize` to catch operator typos before ~500 MB per-session OOMs.
- `DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000` keeps a wedged permission request from blocking the per-session `promptQueue` forever.
- `DEFAULT_MAX_PENDING_PER_SESSION = 64` mirrors `DEFAULT_MAX_SUBSCRIBERS`; excess `requestPermission` calls resolve as cancelled with a stderr warning.

## Dependencies

| Upstream | Downstream |
|---|---|
| `@agentclientprotocol/sdk` — `ClientSideConnection`, `PROTOCOL_VERSION`, ACP types | `packages/cli/src/serve/` (the daemon) |
| `@qwen-code/qwen-code-core` — `ApprovalMode`, `TrustGateError`, `getCurrentGeminiMdFilename` | `packages/channels/base/` (planned, F4) |
| `node:crypto`, `node:fs`, `node:path` | `packages/vscode-ide-companion/` (planned, F4) |

## Configuration

`BridgeOptions` (`bridgeOptions.ts:88-323`):

| Key | Default | Purpose |
|---|---|---|
| `boundWorkspace` | (required) | Canonical workspace path the bridge enforces. |
| `sessionScope` | `'single'` | `'single'` shares one session across all clients; `'per-client'` mints one per client. |
| `channelFactory` | `defaultSpawnChannelFactory` | Pluggable ACP child factory. |
| `initializeTimeoutMs` | `DEFAULT_INIT_TIMEOUT_MS = 10_000` | ACP `initialize` handshake timeout. |
| `maxSessions` | `DEFAULT_MAX_SESSIONS = 20` | Cap on `byId.size`. `0` / `Infinity` = unlimited; NaN/negative throws. |
| `eventRingSize` | `DEFAULT_RING_SIZE` (from `eventBus.ts`) | Per-session event ring; soft-capped at `MAX_EVENT_RING_SIZE`. |
| `permissionResponseTimeoutMs` | `DEFAULT_PERMISSION_TIMEOUT_MS = 5 min` | Per-request wallclock for the mediator. |
| `maxPendingPermissionsPerSession` | `DEFAULT_MAX_PENDING_PER_SESSION = 64` | Backpressure on chatty agents. |
| `childEnvOverrides` | `{}` | Per-handle env additions / scrubs for the ACP child. |
| `persistApprovalMode`, `persistDisabledTools` | — | Settings-write hooks for the Wave-4 mutation routes. |
| `contextFilename` | from `settings.json`'s `context.fileName` | Overrides `getCurrentGeminiMdFilename`. |
| `statusProvider` | (none) | Daemon-host preflight cells (`DaemonStatusProvider`). |
| `fileSystem` | (none) | `BridgeFileSystem` adapter for ACP `readTextFile` / `writeTextFile`. |
| `permissionPolicy` | from `settings.json`'s `policy.permissionStrategy` | One of `first-responder` / `designated` / `consensus` / `local-only`. |
| `permissionConsensusQuorum` | from `settings.json` | N for consensus policy. |
| `permissionAudit` | `createNoOpPermissionAuditPublisher()` | Wire to `PermissionAuditRing` for the audit trail. |

## Caveats & Known Limits

- `MCP_RESTART_TIMEOUT_MS = 300_000` (5 min) — the bridge race deadline for `/workspace/mcp/:server/restart` is intentionally large because `McpClientManager.MAX_DISCOVERY_TIMEOUT_MS` can be up to 5 min for stdio servers. A shorter deadline would produce false timeouts while the ACP child kept reconnecting in the background.
- `BridgeOptions.eventRingSize > MAX_EVENT_RING_SIZE (1_000_000)` throws at construction.
- `connection.unstable_resumeSession` is exposed via the `unstable_session_resume` capability tag with the `unstable_` prefix; the ACP method may still change its shape. Clients must feature-detect.
- The bridge package is `@qwen-code/acp-bridge` and is consumed via re-export shims in `serve/eventBus.ts`, `serve/status.ts`, `serve/httpAcpBridge.ts` for back-compat with pre-F1 import paths. New code should import directly.

## References

- `packages/acp-bridge/src/bridge.ts` (esp. `createHttpAcpBridge` at line 350+)
- `packages/acp-bridge/src/bridgeClient.ts`
- `packages/acp-bridge/src/bridgeTypes.ts:30-180+`
- `packages/acp-bridge/src/bridgeOptions.ts:88-323`
- `packages/acp-bridge/src/channel.ts:1-60`
- `packages/acp-bridge/src/spawnChannel.ts`
- `packages/acp-bridge/src/bridgeErrors.ts`
- Issues: [#3803](https://github.com/QwenLM/qwen-code/issues/3803), [#4175](https://github.com/QwenLM/qwen-code/issues/4175).

---

# ACP Bridge (中文)

## 概览

`packages/acp-bridge/` 包是 daemon HTTP 层与 ACP 子进程之间的缝隙拥有者。它被 `packages/cli/src/serve/`（`qwen serve` daemon）消费；在 #4175 F1 step 3 中被抽取出来，让以后的消费方（`channels/base/AcpBridge.ts`、VSCode IDE companion）可以直接复用 bridge 内核而不必反向依赖 cli 包。

bridge 提供：一个 `HttpAcpBridge` 实例、一条 `AcpChannel` 连到 ACP 子进程、在这条 channel 上多路复用的 session、每个 session 的 `EventBus`、一个 `MultiClientPermissionMediator`、一个 `BridgeFileSystem` adapter，外加 ACP 形状的辅助方法（`spawnOrAttach`、`loadSession`、`resumeSession`、`sendPrompt`、`cancelSession`、`respondToPermission`，以及供 workspace 级状态与 MCP 重启用的 extMethod RPC）。

## 职责

- 用可插拔的 `ChannelFactory` spawn 或 attach 到 ACP 子进程。默认 `defaultSpawnChannelFactory`（子进程 `qwen --acp`），测试用 `inMemoryChannel`。
- 维护 `aliveChannels`（channel 注册表）和 `byId`（session 注册表）。
- 用 `connection.newSession()` 在一条 ACP child 上多路复用 N 个 HTTP-side session。
- 用 `promptQueue` 把同一 session 的 prompt 串行化（ACP 强制 「一个 session 同一时刻只能有一个 prompt 在跑」）。
- 用 `modelChangeQueue` 串行化 `setSessionModel`，防止并发 attach + 不同 model 把 agent 带进非确定状态。
- 每个 session 一个 `EventBus`，驱动 `GET /session/:id/events`（详见 [`10-event-bus.md`](./10-event-bus.md)）。
- 权限流：`BridgeClient.requestPermission` → `MultiClientPermissionMediator.request` → 扇出 → 收票 → 回 ACP（详见 [`04-permission-mediation.md`](./04-permission-mediation.md)）。
- 文件 IO：通过 `BridgeFileSystem` adapter 处理 ACP 的 `readTextFile` / `writeTextFile`（详见 [`07-workspace-filesystem.md`](./07-workspace-filesystem.md)）。
- workspace 级状态的 extMethod RPC（`/workspace/mcp`、`/workspace/skills`、`/workspace/providers`）和 MCP 重启。
- 生命周期：`shutdown()` 每个 channel 等 `KILL_HARD_DEADLINE_MS`（10s）；二次信号 `killAllSync()` 同步强杀。

## 架构

**公开入口**：`createHttpAcpBridge(opts: BridgeOptions): HttpAcpBridge`，文件 `packages/acp-bridge/src/bridge.ts:350+`。

**关键类型**：

| 类型 | 文件 | 作用 |
|---|---|---|
| `HttpAcpBridge` | `bridgeTypes.ts:30-180+` | 对外接口，全部方法都在这里 |
| `BridgeSession` | `bridgeTypes.ts:49+` | `{ sessionId, workspaceCwd, attached, clientId?, createdAt? }` |
| `BridgeOptions` | `bridgeOptions.ts:88-323` | 构造时配置（见 [配置](#配置)） |
| `AcpChannel` | `channel.ts:21-50` | `{ stream, kill(), killSync(), exited }` 一条 ACP NDJSON channel |
| `ChannelFactory` | `channel.ts:57-60` | `(workspaceCwd, childEnvOverrides?) => Promise<AcpChannel>` |
| `BridgeClient` | `bridgeClient.ts:1-150+` | 封装一条 ACP `ClientSideConnection`，实现 ACP `Client` |
| `EventBus` | `eventBus.ts` | 每 session 内存 pub/sub，见 [`10-event-bus.md`](./10-event-bus.md) |
| `MultiClientPermissionMediator` | `permissionMediator.ts:1-1292` | 四策略 mediator，见 [`04-permission-mediation.md`](./04-permission-mediation.md) |

**内部状态**（由 `createHttpAcpBridge` 闭包持有）：

| 状态 | 形态 | 用途 |
|---|---|---|
| `aliveChannels` | `Map<string, ChannelInfo>` | channel 注册表；每条 `ChannelInfo` 包括 `channel`、`connection`、`client`（每 channel 一个 `BridgeClient`）、`sessionIds: Set<string>`、`pendingRestoreIds`、`statusClosedReject?`、`isDying: boolean` |
| `byId` | `Map<string, SessionEntry>` | session 注册表；每个 `SessionEntry` 包括 `channel`、`connection`、`events: EventBus`、`promptQueue`、`modelChangeQueue`、`pendingPermissionIds: Set<string>`、`clientIds: Map<string, count>`、`activePromptOriginatorClientId?`、`attachCount`、`spawnOwnerWantedKill`、`restoreState?`、`sessionLastSeenAt?`、`clientLastSeenAt` |
| `defaultEntry` | `SessionEntry \| null` | `sessionScope: 'single'` 下共享的那个 session |
| `defaultPolicy` | `PermissionPolicy` | 由 `BridgeOptions.permissionPolicy` 决定 |
| `mediator` | `MultiClientPermissionMediator` | 每 bridge 一个 |
| 常量 | — | `DEFAULT_INIT_TIMEOUT_MS = 10_000`、`MCP_RESTART_TIMEOUT_MS = 300_000`、`DEFAULT_MAX_SESSIONS = 20`、`MAX_EVENT_RING_SIZE = 1_000_000`、`DEFAULT_PERMISSION_TIMEOUT_MS = 5min`、`DEFAULT_MAX_PENDING_PER_SESSION = 64` |

**`isDying` 不变式**：任何 teardown 路径在 await `channel.kill()` 之前必须**同步**置 `ChannelInfo.isDying = true`。`ensureChannel` 把 dying channel 视作不存在，会重新 spawn 一条。否则一个并发 `spawnOrAttach` 在 SIGTERM 宽限窗口（最长 10s）中到来时会 attach 到马上要关掉的 transport，调用方拿到的 sessionId 之后每次请求都 404。**设置位点**（必须同步保持）：`ensureChannel`（initialize 失败 + 晚到 shutdown 重检）、`doSpawn`（empty channel 上 newSession 失败）、`killSession`（最后一个 session 离开）、`shutdown`（批量）。

**`BkUyD` 不变式**：置 `isDying = true` 时**不要**清除 `channelInfo`。`killAllSync` 在 SIGTERM 宽限窗口仍需要找到 channel 触发 SIGKILL；`aliveChannels` 持有 dying 项直到 `channel.exited` 触发。

**BridgeClient 早到事件缓冲**：当 ACP `extNotification` 在 `connection.newSession` 响应返回之前（但其内部 MCP discovery 已经触发 budget 事件）到达 `BridgeClient`，事件按 `MAX_EARLY_EVENT_SESSIONS = 64` × `MAX_EARLY_EVENTS_PER_SESSION = 32` × `EARLY_EVENT_TTL_MS = 60_000` 三重上限缓冲，最坏 ~400 KB。否则新 session SSE 重放环的第一个 slot 会丢掉创建期发生的事件。

## 流程

### `spawnOrAttach`（最常用入口）

> 见英文版「`spawnOrAttach`」时序图。

要点：
- 校验 cwd vs `boundWorkspace`，不一致抛 `WorkspaceMismatchError`。
- `sessionScope='single'` 且 `defaultEntry` 已存在 → 只 bump `attachCount` 并登记 `clientId`，返回 `attached: true`。
- 冷路径 → 走 ChannelFactory 拉子进程 → ACP `initialize`（`DEFAULT_INIT_TIMEOUT_MS=10s`）→ `connection.newSession({cwd})` → 构造 `SessionEntry` 注册到 `byId` / `defaultEntry`。
- `byId.size >= maxSessions` 抛 `SessionLimitExceededError`。
- `X-Qwen-Client-Id` 不在 `[A-Za-z0-9._:-]{1,128}` 范围 → `InvalidClientIdError`。
- `server.ts` 的 disconnect-reaper 通过 `attachCount` / `spawnOwnerWantedKill` 跟踪 spawn 拥有者，避免在 spawn 拥有者掉线但其他客户端已经 attach 的情况下把 session 拆掉（review #3889 BQ9tV）。

### Prompt 串行化

> 见英文版「Prompt serialization」时序图。

要点：
- 队列尾部失败被**吞**掉，避免前一次失败毒害后续 prompt；调用方仍可在自己的 promise 上拿到 rejection。
- session 上缓存的 `transportClosedReject` 把 prompt promise 与 `channel.exited` race，子进程崩了立刻浮出来而不是 hang。

### 权限流（高层）

> 见英文版「Permission flow (high-level)」时序图。

要点：
- wire 端通过普通 `optionId` 偷塞 `CANCEL_VOTE_SENTINEL` → bridge 在到 mediator 之前抛 `InvalidPermissionOptionError`，这个哨兵只能由 bridge 内部使用来把请求短路成 `cancelled / agent_cancelled`。
- 详见 [`04-permission-mediation.md`](./04-permission-mediation.md)。

### 退出

> 见英文版「Shutdown」时序图。

## Channel 工厂

`AcpChannel`（`channel.ts:21-50`）是 bridge 的传输抽象。生产用 `defaultSpawnChannelFactory`（`spawnChannel.ts`），把 `qwen --acp` 跑成子进程加一对 stdio 管道；测试用 `inMemoryChannel`，agent 在进程内跑。bridge 不在乎下面是什么机制，只要给 `{ stream, kill, killSync, exited }` 就行。

`ChannelFactory` 接受 `childEnvOverrides`，每个 daemon handle 可以传自己那份 MCP-budget env（`QWEN_SERVE_MCP_CLIENT_BUDGET`、`QWEN_SERVE_MCP_BUDGET_MODE`），不去改 `process.env`（同进程两个 daemon 会 race）。

## 状态与生命周期

- bridge 构造同步完成；首次 `spawnOrAttach` 冷启动 ACP 子进程。
- `sessionScope: 'single'` 下 `defaultEntry` 与 bridge 同生命周期；channel 在 `sessionIds.size === 0` 且 `isDying = true` 后被回收。
- `MAX_EVENT_RING_SIZE = 1_000_000` 是 `BridgeOptions.eventRingSize` 的软上限，挡操作者打错值导致 ~500 MB 一个 session OOM。
- `DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000` 防止一个 wedged 权限请求把 session 的 `promptQueue` 永久 hang。
- `DEFAULT_MAX_PENDING_PER_SESSION = 64` 对话多的 agent 反压；超出的 `requestPermission` 直接解析为 cancelled 并打 stderr 警告。

## 依赖

| 上游 | 下游 |
|---|---|
| `@agentclientprotocol/sdk`：`ClientSideConnection`、`PROTOCOL_VERSION`、ACP 类型 | `packages/cli/src/serve/`（daemon） |
| `@qwen-code/qwen-code-core`：`ApprovalMode`、`TrustGateError`、`getCurrentGeminiMdFilename` | `packages/channels/base/`（规划中，F4） |
| `node:crypto`、`node:fs`、`node:path` | `packages/vscode-ide-companion/`（规划中，F4） |

## 配置

`BridgeOptions`（`bridgeOptions.ts:88-323`）：

| 键 | 默认 | 作用 |
|---|---|---|
| `boundWorkspace` | （必填） | bridge 强制的规范 workspace 路径 |
| `sessionScope` | `'single'` | `'single'` 所有客户端共享一个 session；`'per-client'` 每客户端一个 |
| `channelFactory` | `defaultSpawnChannelFactory` | 可插拔 ACP child 工厂 |
| `initializeTimeoutMs` | `10_000` | ACP `initialize` 握手超时 |
| `maxSessions` | `20` | `byId.size` 上限；`0`/`Infinity` = 不限；NaN/负值抛错 |
| `eventRingSize` | `DEFAULT_RING_SIZE` | 每 session 事件环；软上限 `1_000_000` |
| `permissionResponseTimeoutMs` | `5 min` | mediator 每请求 wallclock |
| `maxPendingPermissionsPerSession` | `64` | 反压 |
| `childEnvOverrides` | `{}` | 每 handle 给 ACP child 的 env 增量 / scrub |
| `persistApprovalMode`、`persistDisabledTools` | — | Wave 4 修改路由的 settings 写钩子 |
| `contextFilename` | 从 `settings.json` 的 `context.fileName` | 覆盖 `getCurrentGeminiMdFilename` |
| `statusProvider` | （无） | daemon-host preflight cells |
| `fileSystem` | （无） | `BridgeFileSystem` adapter |
| `permissionPolicy` | 从 `settings.json` 的 `policy.permissionStrategy` | 四策略之一 |
| `permissionConsensusQuorum` | 从 `settings.json` | consensus 策略的 N |
| `permissionAudit` | `createNoOpPermissionAuditPublisher()` | 接到 `PermissionAuditRing` |

## 注意 & 已知局限

- `MCP_RESTART_TIMEOUT_MS = 300_000`（5 min）—— bridge race deadline 故意设这么长，因为 `McpClientManager.MAX_DISCOVERY_TIMEOUT_MS` 对 stdio MCP 最长 5 min。设短了会在 ACP child 还在后台重连时假超时。
- `BridgeOptions.eventRingSize > 1_000_000` 构造时抛错。
- `connection.unstable_resumeSession` 通过 `unstable_session_resume` 能力 tag 暴露并保留 `unstable_` 前缀；ACP 方法形状还可能变，客户端必须 feature-detect。
- bridge 包是 `@qwen-code/acp-bridge`，通过 `serve/eventBus.ts`、`serve/status.ts`、`serve/httpAcpBridge.ts` 三个 re-export shim 兼容 F1 前的 import 路径。新代码应该直接 import 包。

## 参考

- `packages/acp-bridge/src/bridge.ts`（重点 `createHttpAcpBridge` line 350+）
- `packages/acp-bridge/src/bridgeClient.ts`
- `packages/acp-bridge/src/bridgeTypes.ts:30-180+`
- `packages/acp-bridge/src/bridgeOptions.ts:88-323`
- `packages/acp-bridge/src/channel.ts:1-60`
- `packages/acp-bridge/src/spawnChannel.ts`
- `packages/acp-bridge/src/bridgeErrors.ts`
- Issue：[#3803](https://github.com/QwenLM/qwen-code/issues/3803)、[#4175](https://github.com/QwenLM/qwen-code/issues/4175)。
