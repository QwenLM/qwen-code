# Managed Client Filesystem Registration (Client Files Relay)

[English](2026-11-10-managed-client-files-relay.md) | [简体中文](2026-11-10-managed-client-files-relay.zh-CN.md)

## Status

Implemented, 2026-11-11 (PR #16844). The relay, the harness-local MCP client,
the Web Shell bridge, and the three-process joint integration test are
delivered and qualified on a disposable MySQL. Investigation baseline: branch
`x5` at `488845a4a81`; the "current state" claims below were read from that
tree. The topology as delivered places the relay MCP client in the **harness**
(`HostedClientFilesSession`), not the worker — see open question 1, which the
worker's journal-grant gating rules out for an ephemeral registration.

## Problem

The local daemon lets a Web Shell user register a directory from their own
machine into a session ("Local files"): the browser holds a File System Access
grant, runs an in-browser MCP server, and the session's agent uses its tools
like any other MCP tools. Managed (Hosted) sessions have no equivalent. A
Managed user can only work on files that live in the Workspace storage; there
is no way to let the agent read or edit files on the user's own computer
without uploading them first.

The goal is parity with the daemon experience: an explicit, revocable,
session-scoped registration of a client directory, with the same tool
semantics, while preserving every Managed security boundary (tenant isolation,
actor grants, approval, durable-event hygiene, loopback-only Harness).

This is **not** a browser-automation or CDP feature. The daemon's client
filesystem bridge is MCP-over-WebSocket, not CDP; the Managed equivalent
proposed here is MCP-over-relay and needs no CDP and no WebSocket at all.

## Current state

### Daemon chain (the reference behavior)

1. Browser: `packages/web-shell/client/local-files/` implements the whole
   client side — directory pick (`pick-directory.ts`), handle persistence
   (`directory-handle-store.ts`), an in-browser MCP server
   (`mcp-server.ts`), and a bridge client (`bridge-client.ts`,
   `useLocalFilesBridge.ts`) that dials the daemon `/acp` WebSocket.
   The sidebar entry is `LocalFilesControl.tsx`.
2. Registration: the client sends `mcp_register { server, sessionId }`;
   the daemon answers `mcp_registered` after tool discovery. JSON-RPC traffic
   then flows as `mcp_message` frames in both directions; `mcp_unregister`
   and socket close tear the server down.
3. Daemon: `packages/cli/src/serve/acp-http/client-mcp-sender-registry.ts`
   keeps a process-scoped `serverName → WS sender` registry with
   ownership-scoped deletion (a disconnecting connection only removes an
   entry it still owns), and `createClientMcpServerProvider` adds an SDK-type
   runtime MCP server to the `qwen --acp` child. The child's
   `SdkControlClientTransport` round-trips each JSON-RPC message through the
   `client_mcp/message` ext-method back to the WS.
4. Gating: the `clientMcpOverWs` serve option
   (`QWEN_SERVE_CLIENT_MCP_OVER_WS=1`) and the advertised
   `client_mcp_over_ws` capability feature; the UI hides the entry without it.

### Managed gaps (verified)

| Layer                  | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted Harness         | `packages/cli/src/serve/hosted-harness-profile.ts` rejects `clientMcpOverWs` (and `cdpTunnelOverWs`, shells, channels, browser origins). Deliberate boundary; this design does not lift it.                                                                                                                                                                                                                                                                                                                                                                  |
| Java control plane     | No WebSocket anywhere in `packages/managed-agent-server`. Browser↔Java and Java↔Runtime are HTTP/SSE only.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Managed Web Shell      | `LocalFilesControl` is gated on the daemon capability `client_mcp_over_ws`, which the Managed provider does not advertise; no entry renders.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Managed MCP (reusable) | Hosted sessions already run MCP servers: `HostedMcpSession` (`hosted-mcp-session.ts`) drives durable `mcp_configuration` journal records and dispatches `mcp-configure` / `mcp-discover` / `mcp-invoke` / `mcp-release` through the Broker; the worker-side `ManagedMcpRuntime` (`managed-mcp-runtime.ts`) speaks `stdio`, `streamable-http`, and `sse`, with `url` + `headers` per definition. Definitions are installed per session from extension manifests (`managed-extension-manifests.ts`, `managed-context-worker.ts`, `installSessionDefinitions`). |
| Java event stream      | `ManagedEventStreamService` is a **durable, journal-backed** SSE replay stream (sequence ids, replay floor, `agent.session.resync_required`, periodic read-grant recheck). It is not an ephemeral push channel. `ManagedSideQueryController` shows the precedent for a separate ephemeral `SseEmitter` stream.                                                                                                                                                                                                                                               |
| Route admission        | Every mounted route needs an OpenAPI operation in `contracts/src/main/resources/openapi/managed-agent-public-api.openapi.json` plus a `SurfaceRegistry` entry (`ManagedAgentApiContractTest`, `SurfaceRegistryGateTest`). New configuration properties need `configuration-descriptions.json` entries.                                                                                                                                                                                                                                                       |

The relay's MCP client runs in the harness, not the worker, so the worker's
`ManagedMcpRuntime` (`managed-mcp-runtime.ts`) is not on this path. The
harness-side client adopts the same size and timeout bounds as that worker
runtime — `MAX_RESULT_BYTES = 60 KiB`, connect timeout `25 s`, per-request
timeout ceiling `600 s` — and the control plane separately bounds the queue
(`queue-depth`, `max-payload-bytes`, `request-ttl`, `binding-ttl`).

## Goals

- A Managed Web Shell user can register one client directory into one Session
  and use its file tools from the agent, with the same tool surface the
  daemon's `local-files` server exposes.
- Registration is explicit (user gesture + directory picker), revocable
  (disconnect button, tab close, grant revocation), and scoped to one
  Session and one actor.
- Write operations on client files go through the Hosted approval path.
- No new WebSocket infrastructure, no CDP, no change to the Hosted Harness
  profile prohibitions. Relay binding metadata and credentials never persist
  client file content; the bounded TTL queue holds the size-bounded JSON-RPC
  bodies (which may include file content) only until they settle or expire.
  Tool arguments and results follow the Session's normal durable tool-result
  policy (decision 6).

## Non-goals

- Driving the user's real browser (CDP tunnel, chrome-extension relay) —
  separate design space, explicitly out of scope.
- Desktop relay (`desktop-node-repl`) over the same channel.
- Background sync, upload/copy of client files into Workspace storage, or
  persistence of the registration across tab close.
- Multiple directories per registration, Firefox/Safari support (File System
  Access API availability is the same blocker the daemon already reports as
  `unsupported-browser`).
- Lifting the Hosted Harness WebSocket prohibition for any other feature.

## Proposed solution

A **Java-mediated MCP relay**. The runtime keeps speaking Streamable HTTP MCP
(already implemented); the browser keeps running the existing `local-files`
MCP server (transport-agnostic JSON-RPC handler); Java connects the two with
an ephemeral SSE downlink and a POST uplink.

```
Browser (Managed Web Shell)
  local-files MCP server (File System Access grant, unchanged)
    ▲ SSE: JSON-RPC requests          │ POST: JSON-RPC responses
Java control plane — Client Files Relay
  session-scoped binding, request queue, grant recheck, caps
    ▲ Streamable HTTP MCP (session relay token)
Hosted Harness — HostedClientFilesSession (harness-local)
  ephemeral session client: transport=streamable-http,
  url=relay internal endpoint, headers={relay token}
```

### Registration flow

1. User clicks "Connect local files" in the Managed Web Shell sidebar and
   picks a directory (existing picker and handle store).
2. The client calls a new WebShell route `client-files/register` with the
   Session id. Java checks the actor's execution grant on the Session's
   Workspace, creates a binding `(tenant, workspace, session, actor,
connection generation)`, and issues a short-lived session relay token.
3. Java instructs the Session's harness (internal, service-authenticated
   `client-files` route) to connect an **ephemeral** harness-local MCP client
   (`HostedClientFilesSession`): `transport: 'streamable-http'`, `url` = the
   relay's internal MCP endpoint, `headers` = the relay token. The harness
   runs the configure/discover handshake; `tools/list` travels through the
   relay to the browser and back. The worker is unchanged (open question 1).
4. Java acks the registration with the discovered tool count; the UI shows
   the connected state, mirroring `LocalFilesControl` phases.
5. Tool calls during a Turn flow harness-local invoke → relay → browser →
   relay → harness, subject to the caps below. Write tools require Hosted
   approval before the invoke is dispatched.

### Teardown and failure

- Disconnect button, tab close, or SSE drop → Java marks the binding closed,
  instructs the Runtime to drop the ephemeral definition and its catalog,
  and fails any queued request with a structured `client_files_offline`
  error. Tool calls never fall back to Workspace files.
- Harness restart or worker replacement loses the ephemeral definition by
  design; the UI surfaces "reconnect" and the user re-registers with a fresh
  gesture. No durable recovery is attempted for a server that cannot exist
  without the browser.
- Grant revocation stops delivery within the existing read-grant recheck
  interval; the relay re-applies the actor's execution authority when a
  request is delivered to the browser and when the browser's response
  settles it. The credential-authenticated enqueue itself carries no actor.

### Ephemeral, not durable

The existing `mcp_configuration` journal machinery assumes a reconnectable
server definition and drives recovery (`recovery_blocked`,
`HostedMcpRecoveryRequiredError`) when an operation cannot settle. A
browser-hosted server is not reconnectable server-side: the directory grant
is gesture-bound and dies with the tab. Persisting it as a durable
configuration would strand recovery states every time a user closes a tab.

Decision: client-files registrations are **ephemeral session state**. They
create no `mcp_configuration` rows, no extension records, and no public
events carrying file content. The harness keeps the definition and catalog in
memory only (`HostedClientFilesSession`); the control plane keeps binding
metadata (ids, generation, timestamps — never tokens in plaintext, never the
directory path) plus a bounded TTL queue whose rows carry the size-bounded
JSON-RPC bodies (which may include file content) only until they settle or
expire, after which the retention sweep deletes them. The in-memory catalog
contributes into `HostedWorkspaceToolTurn` beside `HostedMcpSession.tools()`
without widening the durable MCP path.

### Multi-node routing

The browser's SSE connection and the Runtime's MCP connection may land on
different control-plane instances. Binding metadata lives in SQL; pending
JSON-RPC requests live in a bounded, TTL'd SQL queue keyed by
`(tenant, session, generation)`; the instance holding the browser's SSE
subscription drains the queue, and response POSTs resolve the waiter on any
instance via the same row. This mirrors the existing DB-reconciliation style
of `SessionEventHub` rather than introducing sticky routing or a message
broker. Queue depth, payload size, and TTL are deployment configuration with
conservative defaults; overflow fails the request, never blocks the Turn
indefinitely.

Registration is a synchronous dispatch: `register` creates the binding,
then blocks while the Harness runs `initialize`/`tools/list` through the
queue. The browser therefore runs registration and draining concurrently —
fire `register`, poll `status` until the binding is active, open the SSE
downlink, then await `register`. Awaiting `register` before draining
deadlocks the loop; the stream route also refuses an unknown binding, and
SSE response headers only commit on the first event (an empty queue never
commits them). Confirmed by the three-process joint IT (slice 4).

### Route ownership classification

Per the repository's route-ownership rule:

- `client-files/*` WebShell routes: **selected-session, actor-scoped**
  (require the Session's Workspace execution grant; never tenant-global).
- The internal relay MCP endpoint and the runtime registration route:
  **live-session-owner scoped**, service-authenticated, Hosted-only,
  versioned, unavailable through browser/public routes. Unknown, draining,
  or removed Session states fail closed; they never fall back to a primary
  runtime.

## Design decisions and rationale

1. **Relay over WebSocket parity.** A WS relay would replicate the daemon
   wire (`mcp_*` frames) but requires net-new Java WS infrastructure, a
   Hosted Harness profile exemption, and WS upgrade support in the Kubernetes
   mTLS proxy. The HTTP/SSE relay reuses three existing authorities: the
   worker's Streamable HTTP MCP client, Java's `SseEmitter` precedent, and
   the browser's transport-agnostic MCP server. Choose WS parity only if a
   later design legitimately needs the same reverse channel for desktop
   relay or CDP; record that trigger explicitly if it happens.
2. **Separate ephemeral channel, not the durable event stream.**
   `ManagedEventStreamService` persists and replays every frame; pushing
   file-content requests through it would write client file bytes into the
   session journal and projections. The relay uses its own SSE route with no
   journal writes, following the `ManagedSideQueryController` precedent.
3. **Ephemeral registration, not extension installation.** MCP self-service
   (2026-11-07 design, PR #16500) installs durable, digest-pinned extension
   MCP servers. A client directory grant is none of those things; modeling it
   as an extension would persist a credential-bearing definition and imply
   recovery semantics that cannot hold.
4. **Fail-closed offline semantics.** The daemon registry already teaches
   ownership-scoped teardown; the Managed relay adds structured offline
   errors and prohibits any fallback to Workspace storage, so a stale tool
   call can never silently read or write the wrong filesystem.
5. **No server-side path validation is possible or claimed.** The trust
   boundary for client paths is the browser's File System Access grant; the
   server never sees a path outside it and cannot re-validate it. The design
   says so explicitly instead of implying a containment check it cannot
   perform. Server-side enforcement focuses on identity, grants, caps, and
   approval.
6. **Tool results follow the normal durable policy (2026-11-10, approved).**
   The hosted MCP execution path publishes tool arguments and results as
   durable resources with the Session's tenant isolation and read grants.
   Client-files tools use that same path. The original goal of keeping all
   file content out of durable storage was narrowed to relay state: a
   parallel "results never persisted" path would still leak, because the
   model's own answer text is journaled and may quote file content, and it
   would break recovery and replay. Approval needs no new wiring: MCP tool
   names are never pre-approved, so `hostedApprovalAsks` and the
   server/tool-name permission rules already govern every client-files call
   in non-yolo modes.

## Constraints

- All relay payloads are bounded: request and response bodies ≤ 60 KiB
  (aligning with `MAX_RESULT_BYTES`), per-session in-flight ≤ 32
  (`MAX_INFLIGHT`), queued-request TTL ≤ the worker connect/request timeouts,
  queue depth configurable with a conservative default. Oversize or expired
  requests fail with structured errors.
- The relay token is session-scoped, short-lived, rotated on re-registration,
  never written to the journal, public events, logs, or metrics; if binding
  metadata persists it, it persists encrypted under the existing credential
  encryption key.
- The internal relay endpoint is reachable only from the Runtime network
  position (loopback in the local profile; the private service network in
  pool deployments), never from browser-facing routes.
- Registration requires the actor's current execution grant on the Session's
  Workspace; read-only actors cannot register. Grant recheck cadence reuses
  `events.read-grant-recheck-interval` semantics.
- New configuration properties (queue depth, TTL, enable flag — default OFF)
  need `ManagedAgentProperties` binding, metadata, and
  `configuration-descriptions.json` descriptions.
- The Hosted Harness profile prohibitions, the OpenAPI single source, and the
  SurfaceRegistry gate are unchanged authorities; every new route is admitted
  through them.

## Risks

- **Latency amplification.** Each tool call adds harness→Java HTTP,
  Java→browser SSE, browser→Java POST hops. File operations tolerate this;
  the caps and timeouts keep a slow browser from stalling a Turn beyond the
  existing request timeout.
- **Queue buildup under a dead browser.** TTL + depth caps + structured
  offline errors bound it; fault tests must prove a Turn completes (with
  errors) when the browser vanishes mid-call.
- **Cross-node races.** Registration, teardown, and response delivery race
  across instances; the generation column fences stale connections, and
  ownership-scoped deletion follows the daemon registry's rule.
- **Approval bypass.** Resolved by decision 6: relay tool names are never
  pre-approved, so client-files invokes traverse the existing Hosted
  approval path (`hostedApprovalAsks` + `permissionDecision`) with no new
  wiring; a write tool still requires approval before it executes.
- **Scope creep toward a general reverse channel.** The relay is deliberately
  single-purpose (one MCP server per Session, file tools only). Generalizing
  it is a separate design.

## Validation plan

- TypeScript unit tests: relay transport adapter (request/response pairing,
  reconnect, offline errors), ephemeral definition install/drop in
  `HostedClientFilesSession`, catalog contribution and removal in the tool
  turn, fail-closed paths. Mutation-pin each guard: removing the offline error,
  the grant recheck, or the ownership fence must turn a named test red.
- Java tests: OpenAPI contract + SurfaceRegistry entries for every new
  route; admission tests (anonymous, cross-tenant, read-only actor, unknown
  session, draining session); queue TTL/overflow; token hygiene (no token or
  directory path in any persisted row or emitted event; queue bodies are
  TTL-bounded and deleted on settlement).
- Integration: extend the `Hosted*IT` family with a client-files relay
  fixture — browser fixture ↔ Java ↔ real harness — covering register →
  discover → read → approved write → disconnect → structured failure, plus
  harness-restart re-registration and grant-revocation mid-stream.
- E2E test plan under `.qwen/e2e-tests/` with a real browser (Chromium)
  driving the Managed Web Shell against a disposable control plane; dry-run
  the baseline first. Record unavailable joint gates honestly.
- Repository gates: `npm run build && npm run typecheck`, affected package
  tests, Java verification per `packages/managed-agent-server/AGENTS.md`,
  formatting and reference checks for this document pair.

## Acceptance criteria

1. A Managed Session with the feature enabled can register a client
   directory, discover its tools, read a file, and write a file after
   approval; the same Session without registration exposes no client file
   tools.
2. Closing the tab removes the tools and fails in-flight calls with
   `client_files_offline`; no call ever touches Workspace storage as a
   fallback.
3. Revoking the actor's grant stops request delivery within the recheck
   interval; a read-only actor cannot register.
4. Relay binding metadata and credentials persist no client file content; the
   bounded TTL queue holds the size-bounded JSON-RPC bodies (which may include
   file content) only until they settle or expire, then deletes them. No relay
   token or directory path appears in durable events, items, projections, logs,
   or metrics. Client-files tool arguments and results follow the Session's
   normal durable tool-result policy (decision 6), under the same tenant
   isolation and read grants as Workspace tool results.
5. Harness restart leaves no stranded recovery state; the UI offers
   reconnect and re-registration succeeds with a fresh gesture.
6. All new routes pass the OpenAPI contract and SurfaceRegistry gates; the
   feature flag defaults OFF and the disabled deployment is behaviorally
   identical to today. The one accepted wire delta: every session summary
   carries the `clientFiles` capability, present but `false` when disabled
   (no registration is admitted and no client-files tool is advertised).

## Delivery slices

1. **Java relay**: binding store, queue, WebShell routes, internal MCP
   endpoint, contract/admission tests. Independently verifiable with a
   scripted MCP client and a scripted browser peer.
2. **Runtime ephemeral registration**: definition install/drop, catalog
   contribution, approval wiring, worker fault tests.
3. **Web Shell**: managed relay transport, Managed local-files entry and
   phases, provider capability, session-summary capability gating, UI tests.
4. **Joint qualification**: integration fixtures, real-browser E2E, fault
   gates, bilingual documentation refresh.

Each slice lands with its own verification; earlier slices do not enable the
feature for users.

## Open questions

1. Exact in-memory catalog path into `HostedWorkspaceToolTurn` for ephemeral
   servers (runtime slice must name every consumer before implementing).
   Resolved 2026-11-10 (revised during implementation): the relay MCP client
   lives in the **harness**, not the worker. The worker's MCP control
   admission is journal-grant-gated (`parseOperationGrant`, domain and
   workspace-generation checks); an ephemeral registration has no journal
   rows and cannot issue those grants without breaking the invariant. The
   relay client is a pure Streamable HTTP client with no local process or
   Workspace file access, so it runs beside the Session authority in the
   harness as `HostedClientFilesSession`, and the tool turn merges its
   catalog beside `HostedMcpSession.tools()`. The worker is unchanged.
2. Whether hosted MCP invokes already traverse the approval path; if not,
   the minimal wiring that does not widen other MCP servers' behavior.
   Resolved 2026-11-10: they do. MCP names are never in the pre-approved
   lists, `hostedApprovalAsks` asks for them in every non-yolo mode, and
   `permissionDecision` matches them by server/tool name. No new wiring.
3. SQL queue vs. a sticky-routing alternative for multi-node deployments —
   the SQL queue is proposed; revisit only with measured evidence.
4. Whether read tools also require approval in the default policy, or follow
   the Session's approval mode like other read tools. Resolved 2026-11-10:
   they follow the Session's approval mode exactly like other MCP tools;
   reads are not pre-approved either.
5. File System Access permission persistence across page reloads
   (`needs-gesture` phase) — reuse the daemon's handle-store behavior
   unchanged, but confirm the Managed provider's storage partitioning.
6. How the Managed entry learns the deployment flag without a boot payload
   change. Resolved 2026-11-10: the session summary carries a `clientFiles`
   capability (`WebShellSessionCapabilities`), computed as the deployment
   flag AND harness support AND a visible ACTIVE Session (Workspace-bound
   Sessions also require current execution authority), following the
   side-query capability pattern. The Web Shell projects it into the
   summary mirror and gates the header entry on it; the provider keeps
   exposing the transport unconditionally. The boot payload is unchanged.
