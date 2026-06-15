# Daemon Architecture

## Overview

A `qwen serve` process is **one daemon = one workspace**. It hosts a single Express HTTP server, owns an `@qwen-code/acp-bridge` instance, and spawns one ACP child process (`qwen --acp`) that runs the actual agent runtime. Multiple clients (CLI TUI, IDE companion, IM channel bots, web BFFs, custom scripts) connect over HTTP + SSE and either share one ACP session (`sessionScope: 'single'`, default) or split sessions by conversation thread (`sessionScope: 'thread'`).

Inside the ACP child, MCP servers are shared workspace-wide through `McpTransportPool` (F2): a single (server-name + config-fingerprint) tuple maps to one MCP transport, regardless of how many sessions discover it. The bridge's `MultiClientPermissionMediator` (F3) coordinates permission votes across all connected clients under one of four policies.

This doc gives the **system-level picture** that the rest of this documentation set builds on. Each critical flow is shown as a Mermaid sequence diagram; per-component implementation details live in the other 18 docs.

## Process topology

```mermaid
flowchart LR
    subgraph clients["Clients"]
        TUI["CLI TUI<br/>(packages/cli/src/ui/daemon)"]
        IDE["VS Code IDE<br/>(packages/vscode-ide-companion)"]
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

The daemon process and the ACP child are connected by an `AcpChannel` (default: a real subprocess stdio pipe pair; `inMemoryChannel` for tests). Everything the daemon does is shaped by this split: HTTP and SSE traffic terminate in the daemon, agent decisions and tool invocations happen in the child, and the bridge connects the two.

## Package map

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
    end

    subgraph adapters["Adapters"]
        TUIA["cli/src/ui/daemon/<br/>DaemonTuiAdapter.ts"]
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

    TUIA --> DSC
    CHB --> DSC
    DT --> CHB
    WX --> CHB
    TG --> CHB
    IDEA --> DSC

    DSC --> DC
    DC --> EVT
    DC --> SSE
    DC --> AUTHF
```

Three trust boundaries matter: the HTTP edge (`serve/auth.ts` middleware chain), the bridge-to-ACP-child boundary (NDJSON over stdio, no auth; the child trusts the bridge implicitly), and the agent-to-MCP-server boundary (the agent may invoke tools that touch the host).

## Workflow 1: HTTP request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (SDK)
    participant MW as Middleware<br/>(CORS→host→log→bearer→rate-limit→JSON→telemetry→mutationGate)
    participant R as Route handler
    participant BR as AcpBridge
    participant BC as BridgeClient
    participant CH as ACP child

    C->>MW: POST /session/:id/prompt<br/>Authorization: Bearer …<br/>X-Qwen-Client-Id: …
    MW->>MW: denyBrowserOriginCors
    MW->>MW: hostAllowlist (DNS rebinding guard)
    MW->>MW: access-log hook
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

Non-streaming routes (prompt, cancel, model switch, metadata, workspace CRUD) terminate as a single JSON reply. Streaming output is delivered out-of-band on the SSE channel, **not** as a chunked HTTP body on this connection. See workflow 2.

## Workflow 2: SSE event delivery and replay

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

The ring buffer is bounded (`eventRingSize`, default 8000). A reconnecting client whose `Last-Event-ID` is older than the ring's head receives a synthetic catch-up signal and must call `loadSession` / `resumeSession` to rebuild deeper state. Slow clients trigger `slow_client_warning` at 75% queue fill and `client_evicted` at the cap.

## Workflow 3: Multi-client permission mediation

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

Cross-policy escape hatch: any client may vote `CANCEL_VOTE_SENTINEL` to short-circuit the request as `cancelled / agent_cancelled`. The bridge guards against wire callers smuggling the sentinel via the normal `optionId` field (`InvalidPermissionOptionError`).

## Workflow 4: MCP transport pool acquire / release / restart

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
    Note over E: refs==0 → drain timer fires → close transport<br/>(MAX_IDLE_MS 5min hard cap survives attach/detach churn)

    Note over S,P: Operator restart flow…
    S->>P: restartByName(name, opts?)
    P->>E: drain + close
    P->>E: spawn replacement
    E->>SRV: reconnect
    P->>EB: publish mcp_server_restarted<br/>with stable entryIndex
    P-->>S: single result or {entries: RestartResult[]}
```

`releaseSession(sessionId)` uses the reverse `sessionToEntries` index to release every entry the session holds in O(refs). On daemon shutdown, `drainAll()` sets the `draining` flag (refusing new acquires) and waits for every entry to close under a configurable timeout.

## Workflow 5: Lifecycle — startup and graceful shutdown

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

The two-phase shutdown matters because in-flight HTTP requests, in-flight SSE subscribers, and the ACP child's in-flight tool calls all need bounded teardown windows. If anything blocks past those deadlines, the force-close path takes over so a stuck child cannot keep the daemon process alive.

## Critical files

| Concern              | File                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| Bootstrap            | `packages/cli/src/serve/runQwenServe.ts` (308-994)                   |
| Express app          | `packages/cli/src/serve/server.ts` (261-339)                         |
| Capability registry  | `packages/cli/src/serve/capabilities.ts` (37-215)                    |
| Auth middleware      | `packages/cli/src/serve/auth.ts` (1-60)                              |
| Bridge               | `packages/acp-bridge/src/bridge.ts`                                  |
| BridgeClient         | `packages/acp-bridge/src/bridgeClient.ts`                            |
| Permission mediator  | `packages/acp-bridge/src/permissionMediator.ts` (1-1198)             |
| EventBus             | `packages/acp-bridge/src/eventBus.ts`                                |
| MCP transport pool   | `packages/core/src/tools/mcp-transport-pool.ts` (104+)               |
| Workspace MCP budget | `packages/core/src/tools/mcp-workspace-budget.ts`                    |
| Workspace FS         | `packages/cli/src/serve/fs/`                                         |
| SDK DaemonClient     | `packages/sdk-typescript/src/daemon/DaemonClient.ts` (209-1506)      |
| SDK SessionClient    | `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts` (61-385) |
| Event schema         | `packages/sdk-typescript/src/daemon/events.ts` (13-63)               |

## References

- Design issues: [#3803](https://github.com/QwenLM/qwen-code/issues/3803) (daemon design), [#4175](https://github.com/QwenLM/qwen-code/issues/4175) (F-series milestones).
- User guide: [`../../users/qwen-serve.md`](../../users/qwen-serve.md).
- Wire protocol reference: [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md).
- F2 design notes: issue [#4175](https://github.com/QwenLM/qwen-code/issues/4175) commits 4-6.
