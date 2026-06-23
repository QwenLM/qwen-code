# Daemon Developer Documentation

This is the developer-facing technical documentation for **qwen-code daemon mode**: the `qwen serve` HTTP daemon, the `@qwen-code/acp-bridge` package, the workspace-scoped MCP transport pool, multi-client permission mediation, typed daemon event schema v1, the TypeScript SDK daemon client, and the adapters that connect to the daemon.

It complements, rather than replaces, these existing docs:

| Existing doc                                                                         | Audience              | Source of truth for                                      |
| ------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------- |
| [`../../users/qwen-serve.md`](../../users/qwen-serve.md)                             | Operators             | User quickstart, flags, threat model                     |
| [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)                             | Protocol implementers | HTTP route catalog, request/response shapes, error codes |
| [`../examples/daemon-client-quickstart.md`](../examples/daemon-client-quickstart.md) | SDK users             | End-to-end TypeScript walkthrough                        |
| [`../daemon-client-adapters/`](../daemon-client-adapters/)                           | Adapter authors       | Legacy client adapter design docs                        |
| [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md)                                   | Adapter authors       | Client adapter design notes                              |
| [`../../design/f2-mcp-transport-pool.md`](../../design/f2-mcp-transport-pool.md)     | F2 maintainers        | Workspace MCP transport pool design v2.2                 |

If you want to **start a daemon and use it**, read `qwen-serve.md` first. If you want to **build a client against the wire format**, read `qwen-serve-protocol.md`. If you want to **understand, extend, or debug the daemon internals**, read this set.

## Reading order

Pick the path that matches your goal:

- **Start and verify a daemon first**: `20 -> 17 -> 19`.
- **New contributor**: `01 -> 02 -> 03 -> 08 -> 09 -> 10 -> 11 -> 12`.
- **Adding a new client adapter**: `01 -> 09 -> 10 -> 13 -> (14 / 15 / 16)`.
- **Working on the MCP pool or budget**: `01 -> 03 -> 05 -> 06`.
- **Working on permissions**: `01 -> 03 -> 04 -> 12`.
- **Debugging a production daemon**: `19 -> 18 -> 17 -> 20`.

## Document set

### Foundation

- [`01-architecture.md`](./01-architecture.md) - system architecture, process topology, package map, and all seven top-level sequence diagrams.

### Server core

- [`02-serve-runtime.md`](./02-serve-runtime.md) - `runQwenServe` bootstrap, Express app, middleware chain, graceful shutdown.
- [`03-acp-bridge.md`](./03-acp-bridge.md) - `@qwen-code/acp-bridge` package internals, session multiplexing, channel factory, ACP child spawn.
- [`04-permission-mediation.md`](./04-permission-mediation.md) - `MultiClientPermissionMediator`, four policies, N1 timeout invariant, cancel sentinel.
- [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) - `McpTransportPool` (F2), pool entries, reverse index, restart, drain.
- [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md) - `WorkspaceMcpBudget`, modes (`off`/`warn`/`enforce`), hysteresis, refused-batch coalescing.
- [`07-workspace-filesystem.md`](./07-workspace-filesystem.md) - `WorkspaceFileSystem` sandbox, path policy, audit, `BridgeFileSystem` contract.
- [`08-session-lifecycle.md`](./08-session-lifecycle.md) - create / attach / load / resume, `X-Qwen-Client-Id`, heartbeat, eviction, metadata.
- [`09-event-schema.md`](./09-event-schema.md) - typed event schema v1: all 43 known event types with payloads, reducers, forward compatibility.
- [`10-event-bus.md`](./10-event-bus.md) - `EventBus`, monotonic IDs, ring replay, `Last-Event-ID`, slow-client backpressure, `client_evicted`.
- [`11-capabilities-versioning.md`](./11-capabilities-versioning.md) - capability registry, protocol version, schema version, conditional advertisement.
- [`12-auth-security.md`](./12-auth-security.md) - bearer middleware, host allowlist, CORS deny, mutation gate, `--require-auth`, `/health` exemption, device flow.

### Clients

- [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md) - TypeScript SDK: `DaemonClient`, `DaemonSessionClient`, `DaemonAuthFlow`, SSE parser, event reducers, `ui/*` transcript layer.
- [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md) - shared UI transcript layer and the legacy CLI TUI daemon adapter relationship.
- [`15-channel-adapters.md`](./15-channel-adapters.md) - `DaemonChannelBridge` shared base plus DingTalk, WeChat (Weixin), Telegram, Feishu per-channel adapters.
- [`16-vscode-ide-adapter.md`](./16-vscode-ide-adapter.md) - `DaemonIdeConnection`, loopback-only enforcement, webview bridging.

### Reference appendices

- [`17-configuration.md`](./17-configuration.md) - env vars, CLI flags, `settings.json` keys that affect the daemon.
- [`18-error-taxonomy.md`](./18-error-taxonomy.md) - typed errors per layer with remediation.
- [`19-observability.md`](./19-observability.md) - `QWEN_SERVE_DEBUG`, debugging recipes, telemetry gaps.
- [`20-quickstart-operations.md`](./20-quickstart-operations.md) - shortest startup path, curl checks, route map, and embedded invocation recipes.

## Glossary

- **ACP** - Agent Client Protocol. JSON-RPC over stdio spoken between the daemon bridge and the ACP child process. This is not the HTTP protocol that clients use against the daemon.
- **ACP child** - the child process the daemon spawns (`qwen --acp`) to host the actual agent runtime. The bridge multiplexes one ACP child across many connected clients.
- **acp-bridge** - the `@qwen-code/acp-bridge` package (`packages/acp-bridge/`). Owns session multiplexing, the permission mediator, the event bus, and the channel factory.
- **BridgeClient** - `packages/acp-bridge/src/bridgeClient.ts`. Wraps one ACP `ClientSideConnection`, and handles `requestPermission`, `sendPrompt`, and `cancelSession`.
- **Channel factory** - pluggable strategy for spawning or attaching to an ACP child. The default `spawnChannel` runs `qwen --acp` as a subprocess; `inMemoryChannel` runs it in-process for tests.
- **DaemonClient** - `packages/sdk-typescript/src/daemon/DaemonClient.ts`. The TypeScript SDK HTTP-level facade over the daemon.
- **DaemonSessionClient** - `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`. Session-scoped wrapper that tracks `lastSeenEventId` for SSE replay.
- **EventBus** - `packages/acp-bridge/src/eventBus.ts`. Per-session in-memory pub/sub with monotonic IDs, a bounded ring, and per-subscriber backpressure.
- **F1 / F2 / F3 / F4** - internal milestones tracked in [#4175](https://github.com/QwenLM/qwen-code/issues/4175). F1: bridge extraction and `BridgeFileSystem`. F2: workspace-scoped MCP transport pool. F3: multi-client permission mediation. F4: protocol completion and daemon client surfaces.
- **MCP** - Model Context Protocol. Servers expose tools, resources, and prompts; the daemon ACP child connects to them.
- **McpTransportPool** - `packages/core/src/tools/mcp-transport-pool.ts`. F2 workspace-scoped pool sharing one MCP transport per server name and config fingerprint.
- **Mediator policy** - one of `first-responder`, `designated`, `consensus`, or `local-only`. Decides how multi-client permission votes resolve.
- **Originator client id** - the `X-Qwen-Client-Id` of the client that initiated the prompt currently requesting permission. The `designated` policy only accepts votes from this id.
- **PoolEntry** - `packages/core/src/tools/mcp-pool-entry.ts`. One entry in `McpTransportPool`: one MCP transport, a refcount of attached sessions, and an idle drain timer.
- **Session scope** - `single` (one ACP session shared by all clients) or `thread` (one session per conversation thread). The default is `single`.
- **SSE** - Server-Sent Events. The daemon outbound event channel (`GET /session/:id/events`).
- **Workspace** - the directory the daemon was bound to at boot (`--workspace` or `cwd`). One daemon process equals one workspace.

## Implementation source anchors

Use these anchors when moving from the docs into the latest `main` code:

| Surface                             | Implementation anchors                                                                                                                                                                                                                                    | Primary docs                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Bootstrap and HTTP assembly         | `packages/cli/src/serve/run-qwen-serve.ts`, `server.ts`, `/demo`                                                                                                                                                                                          | [`02`](./02-serve-runtime.md), [`20`](./20-quickstart-operations.md)                                                   |
| ACP bridge and session multiplexing | `packages/acp-bridge/src/bridge.ts`, `packages/acp-bridge/src/bridgeTypes.ts`, `@qwen-code/acp-bridge`                                                                                                                                                    | [`03`](./03-acp-bridge.md), [`08`](./08-session-lifecycle.md)                                                          |
| Permission mediation                | `packages/acp-bridge/src/permissionMediator.ts`, `fromLoopback: boolean`, `policy.*`                                                                                                                                                                      | [`04`](./04-permission-mediation.md), [`12`](./12-auth-security.md)                                                    |
| MCP transport pool                  | `packages/core/src/tools/mcp-transport-pool.ts`, `mcp-pool-key.ts`, `pid-descendants.ts`, `session-mcp-view.ts`, `/mcp refresh`, `MCPCallInterruptedError`                                                                                                | [`05`](./05-mcp-transport-pool.md), [`06`](./06-mcp-budget-guardrails.md)                                              |
| MCP budget guardrails               | `packages/core/src/tools/mcp-workspace-budget.ts`, `ServeMcpBudgetStatusCell.scope`, `budgets[]`                                                                                                                                                          | [`06`](./06-mcp-budget-guardrails.md)                                                                                  |
| Workspace filesystem                | `packages/cli/src/serve/fs/`, `assertTrustedForIntent(trusted, intent)`, `meta.matchedIgnore`, `includeIgnored`                                                                                                                                           | [`07`](./07-workspace-filesystem.md)                                                                                   |
| Event schema and SSE writer         | `packages/sdk-typescript/src/daemon/events.ts`, `packages/cli/src/serve/server.ts`, `formatSseFrame`, `packages/cli/src/acp-integration/session/emitters/ToolCallEmitter.ts`, `ToolCallEmitter.resolveToolProvenance`, `tool_call.provenance`, `serverId` | [`09`](./09-event-schema.md), [`10`](./10-event-bus.md)                                                                |
| Event resync                        | `state_resync_required`, `awaitingResync`, `RESYNC_PASSTHROUGH_TYPES`, `asKnownDaemonEvent`, `unrecognizedKnownEventCount`                                                                                                                                | [`09`](./09-event-schema.md), [`10`](./10-event-bus.md)                                                                |
| Capabilities                        | `packages/cli/src/serve/capabilities.ts`, `mcp_server_restart_refused.reason`, `MCP_RESTART_REFUSED_REASONS.has`                                                                                                                                          | [`11`](./11-capabilities-versioning.md)                                                                                |
| Auth and device flow                | `packages/cli/src/serve/auth.ts`, `packages/cli/src/serve/auth/device-flow.ts`                                                                                                                                                                            | [`12`](./12-auth-security.md)                                                                                          |
| TypeScript SDK daemon client        | `packages/sdk-typescript/src/daemon/{DaemonClient,DaemonSessionClient,DaemonAuthFlow,sse,events,types}.ts`, `MCP_RESTART_DEFAULT_TIMEOUT_MS`                                                                                                              | [`13`](./13-sdk-daemon-client.md)                                                                                      |
| Shared UI transcript layer          | `DaemonUiEventType`, `DaemonSessionProvider`, `packages/webui/src/daemon/`                                                                                                                                                                                | [`13`](./13-sdk-daemon-client.md), [`14`](./14-cli-tui-adapter.md), [`../daemon-ui/README.md`](../daemon-ui/README.md) |
| Channels and IDE adapters           | `packages/channels/`, `packages/vscode-ide-companion/src/services/daemonIdeConnection.ts`                                                                                                                                                                 | [`15`](./15-channel-adapters.md), [`16`](./16-vscode-ide-adapter.md)                                                   |

## What is intentionally out of scope

- **Java / Python SDK daemon clients** - only the TypeScript SDK ships a daemon client today. Doc 13 is TypeScript-only.
- **Web UI product details** - the shared transcript layer and web UI daemon entry points are covered here, but product UI layout is tracked in `docs/developers/daemon-ui/` and adapter design notes.
- **Zed extension (`packages/zed-extension/`)** - it launches `qwen --acp` over stdio directly and bypasses the daemon.
- **Experimental in-process hosting** - `--no-http-bridge` still falls back to http-bridge today; a stable in-process serve mode would need new docs when it lands.

## Current daemon mode coverage

### Server core coverage

| Area                      | Current state                                                                                                                                                                    | Primary docs                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Bootstrap / listen path   | `qwen serve` lazy-loads `runQwenServe`, validates auth/workspace/budget/settings, builds an Express app, then calls `app.listen` and blocks forever until signal.                | [`02`](./02-serve-runtime.md), [`20`](./20-quickstart-operations.md)      |
| Auth / network guardrails | Loopback defaults to no bearer; non-loopback requires bearer; `--require-auth` extends bearer to loopback and `/health`; Host allowlist and default CORS deny are active.        | [`12`](./12-auth-security.md), [`17`](./17-configuration.md)              |
| Session lifecycle         | `POST /session`, `load`, `resume`, metadata patch, heartbeat, eviction, idle reaping, prompt pending limits, and graceful close are documented.                                  | [`08`](./08-session-lifecycle.md), [`10`](./10-event-bus.md)              |
| ACP bridge                | Single ACP child multiplexed by default; `sessionScope` supports `single` and `thread`; `BridgeFileSystem`, context filename, env overrides, and channel idle timeout are wired. | [`03`](./03-acp-bridge.md), [`07`](./07-workspace-filesystem.md)          |
| MCP pool / budget         | Workspace MCP pool is on by default unless `QWEN_SERVE_NO_MCP_POOL=1`; guardrail events and restart semantics are documented.                                                    | [`05`](./05-mcp-transport-pool.md), [`06`](./06-mcp-budget-guardrails.md) |
| Permissions               | F3 mediator supports `first-responder`, `designated`, `consensus`, and `local-only`; invalid settings fail explicitly.                                                           | [`04`](./04-permission-mediation.md), [`12`](./12-auth-security.md)       |

### Wire protocol

| Area          | Current state                                                                                                                                       | Primary docs                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| HTTP routes   | The route catalog lives in `qwen-serve-protocol.md`; this daemon set only references it and explains implementation ownership.                      | [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md), [`20`](./20-quickstart-operations.md)               |
| Event schema  | `EVENT_SCHEMA_VERSION = 1`; 43 known event types; id-less subscriber synthetic frames; `_meta.serverTimestamp` stamped at SSE write boundary.       | [`09`](./09-event-schema.md), [`10`](./10-event-bus.md)                                                       |
| Capabilities  | `SERVE_PROTOCOL_VERSION = 'v1'`; 66 registered tags; 10 conditional tags.                                                                           | [`11`](./11-capabilities-versioning.md)                                                                       |
| Session shell | `POST /session/:id/shell` exists behind `--enable-session-shell`, bearer auth, and session-bound `X-Qwen-Client-Id`; capability tag is conditional. | [`11`](./11-capabilities-versioning.md), [`17`](./17-configuration.md), [`20`](./20-quickstart-operations.md) |
| Rate limiting | Optional per-tier HTTP rate limit is exposed by CLI flags/env and conditional capability tag.                                                       | [`11`](./11-capabilities-versioning.md), [`17`](./17-configuration.md)                                        |

### Clients / SDK

| Area                         | Current state                                                                                                                                                | Primary docs                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript SDK daemon client | `DaemonClient`, `DaemonSessionClient`, `DaemonAuthFlow`, SSE parser, event reducers, feature preflight, and UI transcript exports are documented.            | [`13`](./13-sdk-daemon-client.md)                                                                                                             |
| Shared UI transcript layer   | SDK `daemon/ui/*` normalizes daemon events into 37 UI semantic event types, reduces them into transcript blocks, and provides renderers/conformance helpers. | [`14`](./14-cli-tui-adapter.md), [`../daemon-ui/README.md`](../daemon-ui/README.md), [`../daemon-ui/MIGRATION.md`](../daemon-ui/MIGRATION.md) |
| Web UI daemon consumer       | `packages/webui/src/daemon/` consumes the SDK transcript store through React providers and adapters.                                                         | [`14`](./14-cli-tui-adapter.md), [`../daemon-client-adapters/web-ui.md`](../daemon-client-adapters/web-ui.md)                                 |
| CLI TUI / channels / VS Code | Legacy paths still exist; migration to shared transcript primitives is documented as follow-up work, not completed behavior.                                 | [`14`](./14-cli-tui-adapter.md), [`15`](./15-channel-adapters.md), [`16`](./16-vscode-ide-adapter.md)                                         |

### Reference and operations

| Area                    | Current state                                                                                                                                             | Primary docs                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Configuration           | Full `qwen serve` flags, env vars, `settings.json`, `ServeOptions`, `BridgeOptions`, and important constants are collected in one page.                   | [`17`](./17-configuration.md)         |
| Quickstart / operations | Shortest startup path, launch recipes, curl checks, demo page auth behavior, route split, shutdown behavior, and embedded invocation recipes are covered. | [`20`](./20-quickstart-operations.md) |
| Errors                  | Boot-time explicit failures, route errors, bridge errors, EventBus errors, filesystem errors, and mediator errors are summarized with remediation.        | [`18`](./18-error-taxonomy.md)        |
| Observability           | `QWEN_SERVE_DEBUG`, curl recipes, useful events, telemetry gaps, and investigation checklists are documented.                                             | [`19`](./19-observability.md)         |

### Historical or deprecated surfaces

| Surface                                            | Status                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `docs/developers/daemon-client-adapters/tui.md`    | Historical draft for the old `DaemonTuiAdapter` spike; current shared UI transcript architecture is in doc 14. |
| `packages/cli/src/ui/daemon/daemon-tui-adapter.ts` | Legacy experimental adapter still in-tree. New shared UI work should prefer SDK `daemon/ui/*`.                 |
| `--no-http-bridge`                                 | Accepted for compatibility but falls back to http-bridge and prints stderr.                                    |

### Forward compatibility

- Event schema v1 is additive. New known event types must be appended to `DAEMON_KNOWN_EVENT_TYPE_VALUES`; old SDKs must treat unknown types as forward-compatible.
- Capability tags are behavior contracts. New behavior needs a new tag, especially if clients might preflight it before calling a route.
- `sessionScope: 'thread'` is the current per-conversation-thread split; avoid reintroducing older client-scoped wording.
- Envelope `_meta` and ACP payload `data._meta` are distinct. Tool-call provenance lives under the ACP payload; server emit timestamps live on the SSE envelope.

## Version provenance

This doc set reflects the daemon mode surface currently merged into `main`, including the follow-up work from [#4412](https://github.com/QwenLM/qwen-code/pull/4412). It intentionally describes current behavior instead of earlier F-series planning snapshots.
