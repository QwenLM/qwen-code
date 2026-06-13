# Daemon 架构

## 概览

一个 `qwen serve` 进程坚持 **一 daemon = 一 workspace** 的不变式。它内嵌一个 Express HTTP 服务、持有一个 `acp-bridge` 实例、拉起一个 ACP 子进程（`qwen --acp`）来跑真正的 agent 运行时。多个客户端（CLI TUI、IDE companion、IM channel 机器人、Web BFF、自定义脚本）通过 HTTP + SSE 连进来，要么共享同一个 ACP session（`sessionScope: 'single'`，默认），要么每个客户端各拿一个（`'thread'`）。

在 ACP 子进程内部，MCP server 通过 `McpTransportPool`（F2）实现工作区内共享：一对 (server name + 配置指纹) 对应一条 MCP transport，不管被几个 session 发现都只起一份。Bridge 的 `MultiClientPermissionMediator`（F3）在四种策略之一下协调多客户端的权限投票。

本文给出 **系统级全景**，本文档集其余 18 篇文档都挂在它下面。每条主干流程都给一张 Mermaid 时序图，单个组件的实现细节请看对应的专题文档。

## 进程拓扑

```mermaid
flowchart LR
    subgraph clients["Clients"]
        WUI["Web UI<br/>(packages/webui/src/daemon)"]
        TUI["CLI TUI<br/>(待迁移到 SDK ui/*)"]
        IDE["VSCode IDE<br/>(packages/vscode-ide-companion)"]
        CH["Channel bots<br/>(DingTalk / WeChat / Telegram)"]
        SDK["Any SDK consumer<br/>(packages/sdk-typescript/src/daemon)"]
    end

    subgraph daemon["qwen serve process (one workspace)"]
        EXP["Express app<br/>(packages/cli/src/serve/server.ts)"]
        BR["AcpBridge<br/>(packages/acp-bridge/src/bridge.ts)"]
        MED["MultiClientPermissionMediator<br/>(F3)"]
        EB["EventBus per session<br/>(eventBus.ts)"]
        FS["WorkspaceFileSystem<br/>(cli/src/serve/fs/)"]
    end

    subgraph child["ACP child process (qwen --acp)"]
        AGT["QwenAgent runtime"]
        POOL["McpTransportPool<br/>(F2, core/src/tools)"]
        BDG["WorkspaceMcpBudget"]
    end

    subgraph external["External"]
        MCP1["MCP server A<br/>(stdio)"]
        MCP2["MCP server B<br/>(websocket)"]
    end

    WUI -- "HTTP+SSE" --> EXP
    TUI -- "HTTP+SSE" --> EXP
    IDE -- "HTTP+SSE (loopback)" --> EXP
    CH -- "HTTP+SSE" --> EXP
    SDK -- "HTTP+SSE" --> EXP

    EXP --> BR
    BR --> MED
    BR --> EB
    EXP --> FS

    BR -- "ACP NDJSON over stdio" --> AGT
    AGT --> POOL
    POOL --> BDG
    POOL -- "shared transport" --> MCP1
    POOL -- "shared transport" --> MCP2
```

要点：

- daemon 进程与 ACP 子进程通过 `AcpChannel` 连接，默认是真实的子进程 + 一对管道；`inMemoryChannel` 用于测试。
- 所有架构都被这条「daemon ↔ child」缝隙塑造：HTTP / SSE 在 daemon 终止，agent 决策与工具调用在子进程发生，bridge 是中转。

## 包关系

```mermaid
flowchart TB
    subgraph serve["packages/cli/src/serve"]
        RQS["runQwenServe.ts<br/>(bootstrap)"]
        SRV["server.ts (Express)"]
        CAP["capabilities.ts"]
        AUTH["auth.ts"]
        FSM["fs/ (sandbox)"]
        DSP["daemonStatusProvider.ts"]
    end

    subgraph br["packages/acp-bridge"]
        BR2["bridge.ts"]
        BC2["bridgeClient.ts"]
        EB2["eventBus.ts"]
        MED2["permissionMediator.ts"]
        ST2["status.ts"]
        CH2["channel.ts / spawnChannel.ts"]
    end

    subgraph core["packages/core/src/tools"]
        POOL2["mcp-transport-pool.ts"]
        ENT["mcp-pool-entry.ts"]
        WBG["mcp-workspace-budget.ts"]
        SMV["session-mcp-view.ts"]
    end

    subgraph sdk["packages/sdk-typescript/src/daemon"]
        DC["DaemonClient.ts"]
        DSC["DaemonSessionClient.ts"]
        EVT["events.ts"]
        SSE["sse.ts"]
        AUTHF["DaemonAuthFlow.ts"]
        UI["ui/* (#4328 + #4353)<br/>normalizer / transcript / store / render"]
    end

    subgraph adapters["Adapters"]
        WUIP["webui/src/daemon/<br/>DaemonSessionProvider.tsx"]
        CHB["channels/base/<br/>DaemonChannelBridge.ts"]
        DT["channels/dingtalk"]
        WX["channels/weixin"]
        TG["channels/telegram"]
        IDEA["vscode-ide-companion/<br/>daemonIdeConnection.ts"]
    end

    RQS --> SRV
    RQS --> CAP
    RQS --> AUTH
    RQS --> FSM
    RQS --> BR2

    BR2 --> BC2
    BR2 --> EB2
    BR2 --> MED2
    BR2 --> CH2

    BR2 -.spawns.-> core
    POOL2 --> ENT
    POOL2 --> WBG
    POOL2 --> SMV

    WUIP --> DSC
    WUIP --> UI
    CHB --> DSC
    DT --> CHB
    WX --> CHB
    TG --> CHB
    IDEA --> DSC

    DSC --> DC
    DC --> EVT
    DC --> SSE
    DC --> AUTHF
    UI --> EVT
```

箭头方向表示编译期依赖：`serve/` 启动层依赖 `@qwen-code/acp-bridge`，bridge 包本身不反向 import `serve/`。HTTP、auth、filesystem adapter 留在 CLI 包里，ACP session 生命周期和权限协调留在 bridge 包里。

记住三条信任边界：

1. HTTP 入口边界：`serve/auth.ts` 中间件链。
2. bridge ↔ ACP 子进程边界：stdio 上的 NDJSON，没有认证 —— 子进程默认信任 bridge。
3. agent ↔ MCP server 边界：agent 可能触发涉及宿主资源的工具调用。

## 流程 1：HTTP 请求生命周期

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (SDK)
    participant MW as Middleware<br/>(CORS→host→log→bearer→rate-limit→JSON→telemetry)
    participant R as Route handler
    participant BR as AcpBridge
    participant BC as BridgeClient
    participant CH as ACP child

    C->>MW: POST /session/:id/prompt<br/>Authorization: Bearer …<br/>X-Qwen-Client-Id: …
    MW->>MW: deny/allow Origin CORS
    MW->>MW: hostAllowlist (DNS rebinding guard)
    MW->>MW: access-log hook (if daemonLog enabled)
    MW->>MW: bearerAuth (constant-time compare)
    MW->>MW: rateLimit (when enabled)
    MW->>MW: express.json body parser
    MW->>MW: daemonTelemetryMiddleware
    MW->>MW: mutationGate (strict on mutating routes)
    MW->>R: req validated
    R->>BR: bridge.sendPrompt(sessionId, body, clientId)
    BR->>BC: client.sendPrompt(sessionId, …)
    BC->>CH: ACP JSON-RPC over stdin
    CH-->>BC: ACP response / notifications
    BC-->>BR: result
    BR-->>R: result
    R-->>C: 200 JSON
```

非流式路由（prompt、cancel、model 切换、metadata、workspace CRUD）以一次 JSON 响应结束。流式输出**不是**在该 HTTP 连接上以分块方式返回，而是走 SSE 通道；见流程 2。

## 流程 2：SSE 事件投递与重放

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant SR as GET /session/:id/events
    participant EB as EventBus<br/>(per session)
    participant BC as BridgeClient
    participant CH as ACP child

    C->>SR: GET …/events<br/>Last-Event-ID: 42 (optional)
    SR->>EB: subscribe(lastSeenId=42, maxQueued=N)
    EB-->>SR: replay frames 43..currentTail<br/>(from ring buffer)
    SR-->>C: NDJSON: id=43, type=session_update, …
    CH-->>BC: ACP notification (e.g. agent_message_chunk)
    BC->>EB: publish({type, data})
    EB-->>SR: enqueue id=N
    SR-->>C: id=N, type=…, data=…
    Note over EB,SR: If subscriber queue >= maxQueued,<br/>EventBus emits client_evicted terminal frame<br/>and closes subscriber.
```

要点：

- 环形缓冲有上限（`eventRingSize`，默认 8000）。
- 重连客户端如果 `Last-Event-ID` 已经落出环外，会收到合成 catch-up 信号，必须用 `loadSession` / `resumeSession` 重建更深层状态。
- 慢消费者在队列 75% 触发 `slow_client_warning`，达到上限时收到 `client_evicted`（终态）后被关掉。

## 流程 3：多客户端权限协调

```mermaid
sequenceDiagram
    autonumber
    participant CH as ACP child (agent)
    participant BC as BridgeClient.requestPermission
    participant MED as Mediator (policy)
    participant EB as EventBus
    participant C1 as Client A<br/>(originator)
    participant C2 as Client B

    CH->>BC: ACP requestPermission(requestId, options)
    BC->>MED: request({requestId, sessionId, originatorClientId, allowedOptionIds}, timeoutMs)
    MED->>EB: publish permission_request<br/>(broadcast to subscribers)
    EB-->>C1: SSE permission_request
    EB-->>C2: SSE permission_request

    alt first-responder
        C2->>MED: POST /permission/:requestId optionId=allow
        MED-->>BC: resolved
        BC-->>CH: ACP response
        MED->>EB: permission_resolved
        C1->>MED: POST /permission/:requestId (late vote)
        MED-->>C1: 409 permission_already_resolved
    else designated
        C2->>MED: vote (clientId != originatorClientId)
        MED-->>C2: 403 permission_forbidden
        C1->>MED: vote (matches originator)
        MED-->>BC: resolved
    else consensus (N-of-M)
        C1->>MED: vote
        MED->>EB: permission_partial_vote (1/N)
        C2->>MED: vote
        MED->>EB: permission_partial_vote (2/N)
        Note over MED: when tally reaches quorum on one option, resolve
    else local-only
        C2->>MED: vote (remote)
        MED-->>C2: 403 permission_forbidden (remote_not_allowed)
        Note over MED,CH: blocks until a loopback voter resolves it
    end
```

跨策略「逃生口」：任何客户端都可以投 `CANCEL_VOTE_SENTINEL` 把请求短路成 `cancelled / agent_cancelled`。bridge 防止 wire 端通过普通 `optionId` 字段偷偷塞这个哨兵（`InvalidPermissionOptionError`）。

四种策略一句话：

- `first-responder` — 第一个有效投票获胜（默认，保留 live 协作 UX）。
- `designated` — 只有 `originatorClientId` 能投，其他客户端收 `permission_forbidden`。
- `consensus` — N-of-M 法定人数，过程中发 `permission_partial_vote` 让 UI 渲染进度。
- `local-only` — 拒绝任何 HTTP 投票，只接受 loopback。

## 流程 4：MCP transport 池的 acquire / release / restart

```mermaid
sequenceDiagram
    autonumber
    participant S as Session in ACP child
    participant P as McpTransportPool
    participant SIF as spawnInFlight (dedup)
    participant E as PoolEntry
    participant BDG as WorkspaceMcpBudget
    participant SRV as MCP server

    S->>P: acquire(name, cfg, sessionId)
    P->>SIF: check inflight for (name+fingerprint)
    alt cached inflight
        SIF-->>P: existing promise
    else cold start
        P->>BDG: tryReserve(name)
        BDG-->>P: ok / refused
        alt refused
            P-->>S: BudgetExhaustedError
        else ok
            P->>E: new PoolEntry(...)
            E->>SRV: connect transport
            SRV-->>E: ready
            E-->>P: connected
        end
    end
    P->>P: sessionToEntries.add(sessionId, id)
    P-->>S: PooledConnection

    Note over S,P: Session uses entry, then…

    S->>P: release(id, sessionId)
    P->>E: detach session
    E->>E: arm drain timer (default 30s)
    Note over E: refs==0 → drain timer fires → close transport<br/>(MAX_IDLE_MS 5min hard cap survives flap)

    Note over S,P: Operator restart flow…
    S->>P: restartByName(name, opts?)
    P->>E: drain + close
    P->>E: spawn replacement
    E->>SRV: reconnect
    P->>EB: publish mcp_server_restarted
```

要点：

- `releaseSession(sessionId)` 借助 `sessionToEntries` 反向索引，以 O(refs) 释放该 session 持有的所有条目。
- daemon 关停时 `drainAll()` 置 `draining` 标志（拒绝新的 acquire），并以可配置超时等待所有条目关闭。
- `restartByName` 可以接 `entryIndex` 来精确重启某条；池里同名多条目时返回 `{entries: RestartResult[]}` 形状。

## 流程 5：生命周期 —— 启动与优雅退出

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator (signal)
    participant RQS as runQwenServe
    participant APP as Express app
    participant BR as AcpBridge
    participant CH as ACP child

    Op->>RQS: qwen serve --workspace … --token …
    RQS->>RQS: validate flags + canonicalize workspace
    RQS->>RQS: allocate PermissionAuditRing
    RQS->>BR: createHttpAcpBridge(options)
    RQS->>APP: createServeApp(bridge, …)
    RQS->>APP: listen(host, port)
    RQS->>RQS: arm SIGINT / SIGTERM handlers

    Op->>RQS: SIGTERM
    RQS->>BR: dispose device-flow registry
    RQS->>BR: bridge.shutdown()
    BR->>CH: send graceful close (10s deadline)
    CH-->>BR: exit
    RQS->>APP: server.close() (5s force-close timer)
    APP->>APP: closeAllConnections() (+2s secondary)
    Note over Op,RQS: Second SIGTERM during shutdown →<br/>bridge.killAllSync() + process.exit(1) (orphan prevention)
```

为什么要分两阶段：

- 还在飞的 HTTP 请求、还连着的 SSE 订阅者、子进程里还在跑的工具调用都需要有上限的退出窗口。
- 任何一条卡过窗口，force-close 路径会接管，避免子进程把 daemon 进程拖住。
- 第二次 SIGTERM 直接走 `bridge.killAllSync()` + `process.exit(1)`，防孤儿。

## 关键文件

| 关注点             | 文件                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| Bootstrap          | `packages/cli/src/serve/runQwenServe.ts`                             |
| Express 应用       | `packages/cli/src/serve/server.ts`                                   |
| 能力注册表         | `packages/cli/src/serve/capabilities.ts`                             |
| Auth 中间件        | `packages/cli/src/serve/auth.ts`                                     |
| Bridge             | `packages/acp-bridge/src/bridge.ts`                                  |
| BridgeClient       | `packages/acp-bridge/src/bridgeClient.ts`                            |
| 权限协调器         | `packages/acp-bridge/src/permissionMediator.ts`                      |
| EventBus           | `packages/acp-bridge/src/eventBus.ts`                                |
| MCP transport 池   | `packages/core/src/tools/mcp-transport-pool.ts`                      |
| Workspace MCP 预算 | `packages/core/src/tools/mcp-workspace-budget.ts`                    |
| Workspace 文件系统 | `packages/cli/src/serve/fs/`                                         |
| SDK DaemonClient   | `packages/sdk-typescript/src/daemon/DaemonClient.ts`                 |
| SDK SessionClient  | `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts` (61-385) |
| 事件 schema        | `packages/sdk-typescript/src/daemon/events.ts` (14-112)              |

## 参考

- 设计 issue：[#3803](https://github.com/QwenLM/qwen-code/issues/3803)（daemon 总体设计）、[#4175](https://github.com/QwenLM/qwen-code/issues/4175)（F 系列里程碑）。
- 用户使用文档：[`../../users/qwen-serve.md`](../../users/qwen-serve.md)。
- Wire 协议参考：[`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)。
- F2 设计文档（v2.2，含 32 条 review fold-in）：[`../../design/f2-mcp-transport-pool.md`](../../design/f2-mcp-transport-pool.md)。
- F2 设计笔记：issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) commit 4-6。
