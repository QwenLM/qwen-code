# Daemon ACP-over-HTTP → Official ACP Streamable HTTP Transport

> Targets `daemon_mode_b_main`. Branch: `feat/daemon-acp-http-streamable`.
> Author: arnoo.gao. Date: 2026-05-24. Status: **Design v1 → implementation**.
> Design-first per repo workflow: this doc lands before/with the implementation PR so the wire contract is reviewable.

---

## 0. TL;DR

The daemon (`qwen serve`) today speaks a **bespoke REST + SSE** dialect to web/SDK
clients, while speaking **real ACP JSON-RPC over stdio** to the spawned `qwen --acp`
child. This proposal adds a **second northbound transport** that implements the
**official ACP Streamable HTTP transport** (RFD #721) at a single `/acp` endpoint,
so any ACP-native client (Zed, Goose, future SDKs) can drive the daemon directly
over the standard protocol — no qwen-specific REST knowledge required.

**Decision: dual-transport, additive.** The new `/acp` endpoint is mounted
alongside the existing REST surface, reusing the same `HttpAcpBridge` +
`EventBus` underneath. The REST API is _not_ removed. Rationale in §6.

**Decision: extension namespace = `_qwen/…`** (single-underscore prefix, the
ACP-spec-reserved form for custom methods) for daemon features that have no
standard ACP method (model switch, workspace introspection, heartbeat,
multi-client permission policy, SSE backpressure tuning). Rationale in §5.

A complete, locally-runnable reference implementation ships in this PR
(`packages/cli/src/serve/acp-http/`) plus a verification harness
(`scripts/acp-http-smoke.mjs`).

---

## 1. Background — what "ACP over HTTP" means today

Three tiers (verified at commit `0c0430939`):

```
┌──────────────┐  bespoke REST + SSE (HTTP/1.1)   ┌────────────┐  ACP JSON-RPC   ┌──────────────┐
│ web / SDK    │ ───────────────────────────────► │  qwen      │  (stdio NDJSON) │ qwen --acp   │
│ client       │ ◄─── GET /session/:id/events ──── │  serve     │ ◄─────────────► │ child (Agent)│
│ (ACP client) │       (text/event-stream)        │  (daemon)  │  ndJsonStream   │              │
└──────────────┘                                   └────────────┘                 └──────────────┘
        northbound: NOT ACP wire                       bridge          southbound: real ACP
```

### 1.1 Northbound (client ↔ daemon) — bespoke, today

- Express 5 app in `packages/cli/src/serve/server.ts` (~30 routes).
- Discrete REST verbs, **not** JSON-RPC:
  - `POST /session` (create), `POST /session/:id/prompt`, `POST /session/:id/cancel`,
    `POST /session/:id/load|resume`, `POST /session/:id/model`,
    `POST /session/:id/permission/:requestId`, `POST /session/:id/heartbeat`,
    `DELETE /session/:id`, plus `/workspace/*`, `/capabilities`, `/health`.
- Server→client streaming: `GET /session/:id/events` → `text/event-stream`.
  - Frames: `id: <n>\nevent: <type>\ndata: <json>\n\n` (`server.ts:formatSseFrame`, ~2626).
  - Per-session **monotonic `id`** + `Last-Event-ID` resume backed by a
    ring-buffer `EventBus` (`acp-bridge/src/eventBus.ts`).
  - Event `type`s: `session_update`, `client_evicted`, `slow_client_warning`,
    `state_resync_required`, `stream_error`, …
- Auth: `Authorization: Bearer <token>` (`serve/auth.ts`), CORS deny + host allowlist.
- Backpressure: per-connection serialized write chain + 15 s heartbeat comments.

### 1.2 Southbound (daemon ↔ child) — already ACP

- `acp-bridge/src/spawnChannel.ts` spawns `qwen --acp`, wraps stdin/stdout with
  `ndJsonStream` from `@agentclientprotocol/sdk` (`^0.14.1`).
- `acp-bridge/src/bridge.ts:729` `new ClientSideConnection(() => client, channel.stream)`
  — the daemon is the ACP **client**, the child is the ACP **agent**.
- Extension methods already in use on this leg: `unstable_setSessionModel`,
  `unstable_resumeSession`, `unstable_listSessions` (`acp-integration/acpAgent.ts`).

### 1.3 Why migrate the northbound

- Every client (webui, TS SDK, Java SDK, Python SDK, VSCode companion) re-implements
  the bespoke REST mapping. An ACP-standard endpoint lets ACP-native editors attach
  with zero qwen-specific glue.
- Aligns the daemon's remote surface with the protocol it already speaks internally.

---

## 2. Target: ACP Streamable HTTP (RFD #721)

Merged **Draft** RFD (`agentclientprotocol/agent-client-protocol#721`, merged 2026-04-22).
Not yet normative; not yet in any SDK. We implement against the RFD wire design.

### 2.1 Endpoint & verbs (single `/acp`)

| Verb          | Behavior                                                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /acp`   | Send JSON-RPC. `initialize` → **`200`** + JSON body (capabilities) and sets `Acp-Connection-Id`. All other requests/notifications → **`202 Accepted`**, empty body; the _response_ (if any) is delivered on the matching long-lived SSE stream. |
| `GET /acp`    | Open a long-lived **SSE** stream. (`Upgrade: websocket` → WebSocket; **deferred**, see §7.)                                                                                                                                                     |
| `DELETE /acp` | Terminate the connection → `202`.                                                                                                                                                                                                               |

### 2.2 Two-tier long-lived streams

- **Connection-scoped stream**: `GET /acp` with header `Acp-Connection-Id`, no session
  header. Carries connection-level responses (`session/new`, `session/load`,
  `authenticate`) and connection-level notifications.
- **Session-scoped stream**: `GET /acp` with `Acp-Connection-Id` **and** `Acp-Session-Id`.
  Carries `session/update` notifications, **agent→client requests**
  (`session/request_permission`, `fs/read_text_file`, …), and responses to
  session POSTs (`session/prompt`, `session/cancel`).

### 2.3 Identity (3 layers)

- `Acp-Connection-Id` (HTTP header) — transport binding, minted at `initialize`.
- `Acp-Session-Id` (HTTP header) — required on session-scoped GET + session POSTs.
- `sessionId` (JSON-RPC param) — inside method params (must match the header).

### 2.4 Divergences from MCP StreamableHTTP

ACP uses **long-lived** streams (not per-request SSE), **two** ID headers (connection
vs session), `202`-for-non-initialize, HTTP/2-required, WebSocket-required-client. We
borrow the single-endpoint + POST/GET-SSE + session-header skeleton but adapt to the
long-lived dual-ID model. We do **not** reuse `@modelcontextprotocol/sdk`'s
`StreamableHTTPServerTransport` (its per-request stream model and single
`Mcp-Session-Id` don't fit).

### 2.5 Standard methods (confirmed from current schema)

- Client→Agent requests: `initialize`, `authenticate`, `session/new`, `session/load`,
  `session/prompt`, `session/resume`, `session/close`, `session/list`,
  `session/set_mode`, `session/set_config_option`, `logout`.
- Client→Agent notification: `session/cancel`.
- Agent→Client requests: `fs/read_text_file`, `fs/write_text_file`,
  `session/request_permission`, `terminal/create|output|wait_for_exit|kill|release`.
- Agent→Client notification: `session/update`.

---

## 3. Architecture of the new transport

The daemon must present an **ACP Agent surface over HTTP** northbound, while it
remains an ACP **client** to the child southbound. The `/acp` layer is therefore a
**JSON-RPC router** that terminates the HTTP transport and bridges into the existing
`HttpAcpBridge`.

```
            POST /acp (JSON-RPC requests/responses/notifs)
client  ──────────────────────────────────────────────►  ┌───────────────────────────┐
(editor)                                                  │  AcpHttpTransport         │
        ◄── GET /acp  (connection-scoped SSE) ──────────  │  - connection registry    │
        ◄── GET /acp  (session-scoped SSE) ─────────────  │  - JSON-RPC id correlation│
                                                          │  - method dispatch        │
                                                          └────────────┬──────────────┘
                                                                       │ reuses
                                                          ┌────────────▼──────────────┐
                                                          │  HttpAcpBridge + EventBus  │  (unchanged)
                                                          └────────────┬──────────────┘
                                                                       │ ACP stdio (unchanged)
                                                                 qwen --acp child
```

### 3.1 New module layout (`packages/cli/src/serve/acp-http/`)

| File                     | Responsibility                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`               | `mountAcpHttp(app, bridge, opts)` — registers `/acp` routes on the existing Express app.                                                                                                    |
| `connection-registry.ts` | `Acp-Connection-Id` → `AcpConnection` (connection SSE writer, `Map<sessionId, SessionStream>`, pending agent→client requests by JSON-RPC id, monotonic id allocator). TTL + DELETE cleanup. |
| `json-rpc.ts`            | JSON-RPC 2.0 parse/validate/serialize helpers; error codes (`-32600` etc.); `_qwen/` namespace guard.                                                                                       |
| `dispatch.ts`            | Maps inbound JSON-RPC methods → `HttpAcpBridge` calls. Maps `BridgeEvent`s → outbound JSON-RPC frames. The translation table (§4).                                                          |
| `sse-stream.ts`          | Long-lived SSE writer (reuses the backpressure/heartbeat pattern from `server.ts`). Distinct from REST `/events` (different framing: full JSON-RPC objects, not qwen event envelopes).      |

No change to `bridge.ts` / `eventBus.ts` (additive consumer only).

### 3.2 Connection & session lifecycle

1. `POST /acp {initialize}` → mint `connectionId`, create `AcpConnection`, reply `200`
   with `{protocolVersion, agentCapabilities, _meta:{qwen:{…}}}` + `Acp-Connection-Id` header.
2. Client opens `GET /acp` (connection-scoped) carrying `Acp-Connection-Id`.
3. `POST /acp {session/new}` → `202`; daemon calls `bridge.createSession(...)`; pushes
   the JSON-RPC response (with `sessionId`) down the **connection** stream.
4. Client opens `GET /acp` (session-scoped) with `Acp-Connection-Id`+`Acp-Session-Id`;
   daemon `bridge.subscribeEvents(sessionId)` and pipes translated frames.
5. `POST /acp {session/prompt}` → `202`; `bridge.sendPrompt(...)`; `session/update`
   notifications stream live on the session stream; the final prompt **response**
   (`{id, result:{stopReason}}`) is pushed on the session stream when it settles.
6. Agent→client request (e.g. `session/request_permission`) is emitted as a JSON-RPC
   **request** on the session stream with a daemon-allocated id; the client answers via
   `POST /acp {id, result}`; `dispatch` resolves it through the bridge's permission API.
7. `DELETE /acp` (or connection-stream close + TTL) tears down sessions/subscriptions.

---

## 4. Translation table (bridge ⇄ ACP/HTTP)

### 4.1 Inbound (client POST → bridge)

| ACP method                                  | Bridge call                                           | Response routed to                     |
| ------------------------------------------- | ----------------------------------------------------- | -------------------------------------- | ----------------- |
| `initialize`                                | (none; capabilities from `capabilities.ts`)           | inline `200`                           |
| `authenticate`                              | existing auth provider (`serve/auth/*`)               | connection stream                      |
| `session/new`                               | `bridge.createSession`                                | connection stream                      |
| `session/load` / `session/resume`           | `bridge.restoreSession('load'                         | 'resume')`                             | connection stream |
| `session/prompt`                            | `bridge.sendPrompt`                                   | session stream (deferred until settle) |
| `session/cancel` (notif)                    | `bridge.cancel`                                       | —                                      |
| `session/list`                              | `bridge.listSessions` (`unstable_listSessions`)       | connection stream                      |
| `session/set_mode`                          | approval-mode route logic                             | session stream                         |
| JSON-RPC **response** (to agent→client req) | resolve pending (`§4.3`)                              | —                                      |
| `_qwen/session/set_model`                   | `bridge.setSessionModel` (`unstable_setSessionModel`) | session stream                         |
| `_qwen/workspace/list` etc.                 | workspace introspection routes                        | connection stream                      |
| `_qwen/session/heartbeat`                   | `bridge.heartbeat`                                    | connection stream                      |

### 4.2 Outbound (BridgeEvent → JSON-RPC on session stream)

| BridgeEvent.type                                                   | Emitted as                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `session_update`                                                   | `{method:"session/update", params:<data>}` notification             |
| permission request                                                 | `{id:<n>, method:"session/request_permission", params}` request     |
| `client_evicted` / `slow_client_warning` / `state_resync_required` | `{method:"_qwen/notify", params:{kind,…}}` notification             |
| `stream_error`                                                     | JSON-RPC error response on the active prompt id (or `_qwen/notify`) |
| prompt settle                                                      | `{id:<promptId>, result:{stopReason}}`                              |

### 4.3 Pending agent→client requests

`AcpConnection` keeps `Map<jsonRpcId, {sessionId, kind, bridgeRequestId, resolve}>`.
When the client POSTs a JSON-RPC response object, `dispatch` matches `id`, then calls the
bridge resolution path (e.g. permission `POST /session/:id/permission/:requestId`
internal equivalent).

> **v1 status:** only the `session/request_permission` agent→client round-trip is
> implemented. `fs/*` and `terminal/*` agent→client forwarding is **deferred** (§7) — the
> daemon does not yet advertise `fs`/`terminal` client-capability negotiation on `/acp`,
> so ACP clients should not assume filesystem/terminal semantics over this transport in
> v1. The intended end state (forward `fs/*` to the client; fall back to the daemon's
> workspace FS when the client lacks the `fs` capability) is the follow-up described in §7.

---

## 5. Extension strategy (requirement #2)

ACP reserves any method starting with `_` for custom extensions and provides `_meta`
on every type. The codebase's southbound leg already uses `unstable_*` method names.

**Northbound choice:** vendor-namespaced **`_qwen/<area>/<verb>`** method names
(spec-compliant `_` prefix). Capabilities advertised under
`agentCapabilities._meta.qwen` at `initialize` so clients feature-detect before use.

| Need                                                  | No standard ACP method? | Extension                                               |
| ----------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Model switch                                          | yes                     | `_qwen/session/set_model`                               |
| Workspace MCP/skills/providers/env introspection      | yes                     | `_qwen/workspace/list`, `_qwen/workspace/<area>`        |
| Heartbeat / last-seen                                 | yes                     | `_qwen/session/heartbeat`                               |
| Multi-client permission policy (consensus/designated) | partial                 | `session/request_permission` + `_meta.qwen.policy`      |
| SSE backpressure tuning (`maxQueued`)                 | yes                     | `Acp-Qwen-Max-Queued` header on session GET             |
| Resume cursor (ring `Last-Event-ID`)                  | RFD Phase 4             | `Last-Event-ID` header + `_meta.qwen.eventId` on frames |

Standard methods are **never** renamed; extensions are strictly additive and ignorable.

---

## 6. Dual-transport vs. replace (requirement #4)

**Decision: dual-transport (additive).**

- The official transport is a **Draft** RFD, not normative, and absent from every SDK —
  hard-replacing would couple us to an unratified design and break webui + 3 SDKs +
  VSCode companion at once.
- The REST surface carries features with no clean ACP mapping yet (workspace
  introspection, multi-client permission mediation, ring-buffer resume, capability
  registry). Those degrade to `_qwen/*` extensions on `/acp` but the REST surface stays
  authoritative until the RFD ratifies.
- Both transports share **one** `HttpAcpBridge` + `EventBus` instance, so there is no
  state duplication — `/acp` and `/session/*` can even drive the same live session
  concurrently (multi-client is already supported by the bridge).
- Toggle (v1, shipped): on by default; **`QWEN_SERVE_ACP_HTTP=0`** disables the mount. A
  `--no-acp-http` CLI flag and an `acp_http` tag in `/capabilities` for client feature-
  detection are **deferred** to a follow-up (not in v1) — until then clients detect the
  transport by probing `POST /acp {initialize}`.

Migration path: once the RFD ratifies and SDKs ship, REST routes can be reframed as a
thin compat shim over `/acp` (separate, later PR).

---

## 7. Scope of the implementation PR

**In scope (runnable + verified locally):**

- `POST /acp` dispatch for `initialize`, `session/new`, `session/prompt`,
  `session/cancel`, `session/load`, JSON-RPC response handling.
- Connection-scoped + session-scoped `GET /acp` SSE streams with JSON-RPC framing.
- `session/update` streaming + final prompt response correlation.
- `session/request_permission` agent→client round-trip.
- `_qwen/session/set_model` extension as the worked example of #2.
- Bearer-auth + host allowlist reuse (same middleware as REST).
- Unit tests (`acp-http/*.test.ts`) + a black-box smoke script driving a real daemon.

**Deferred (documented, not built now):**

- WebSocket upgrade path (RFD-required client cap; SSE suffices for local verify).
- HTTP/2 multiplexing (we run HTTP/1.1; POST and long-lived GET use separate sockets,
  which works for CLI/Node clients and ≤6-connection browsers). Documented divergence.
- Full `fs/*` + `terminal/*` agent→client forwarding (permission path proves the
  mechanism; rest is mechanical follow-up).
- SSE resumability hardening parity with the ring buffer (Phase 4 in RFD).

---

## 8. Local verification plan

1. `npm run build` (or workspace build of `cli` + `acp-bridge`).
2. Start daemon: `qwen serve --listen 127.0.0.1:0 --token <t>` (or env token).
3. Run `node scripts/acp-http-smoke.mjs`:
   - `POST /acp {initialize}` → assert `200` + `Acp-Connection-Id`.
   - Open connection SSE; `POST {session/new}` → assert response on stream.
   - Open session SSE; `POST {session/prompt:"say hi"}` → assert ≥1 `session/update`
     then a final `{result:{stopReason}}`.
   - Trigger a tool needing permission → assert `session/request_permission` request,
     POST a grant response → assert prompt completes.
   - `POST {_qwen/session/set_model}` → assert model switch + `session/update`.
4. Vitest: `acp-http/*.test.ts` green.

---

## 9. Risks

| Risk                                 | Mitigation                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------- |
| RFD changes before ratification      | Behind capability tag + `_qwen` namespace; isolated module; easy to revise. |
| HTTP/1.1 vs required HTTP/2          | Localhost/CLI clients unaffected; documented; h2 is a transport swap later. |
| Two transports on one bridge race    | Bridge already supports multi-client; reuse its locking.                    |
| `fs/*` forwarding vs daemon-local FS | Capability-gated: forward when client declares `fs`, else local.            |

---

## 10. Implementation & verification log (v1)

Implemented in `packages/cli/src/serve/acp-http/` (`json-rpc.ts`, `sse-stream.ts`,
`connection-registry.ts`, `dispatch.ts`, `index.ts`), mounted from `server.ts`
via `mountAcpHttp(app, bridge, { boundWorkspace })`.

### Automated (`packages/cli/src/serve/acp-http/*.test.ts`)

`transport.test.ts` boots a real Express server + the real `mountAcpHttp` over
a controllable fake bridge and drives it with `fetch` + manual SSE parsing.
15 tests green, covering: `initialize` 200 + `Acp-Connection-Id`; unknown-conn
400; `session/new` reply on the connection stream; prompt → `session/update`
stream + final result correlation; `session/request_permission` agent→client→
agent round-trip; `_qwen/session/set_model`; method-not-found; `DELETE` teardown.

### Live daemon (real model)

Booted `qwen serve --port 8767 --token … --workspace …` (bundle entry so the
spawned `qwen --acp` child is self-contained) and ran `scripts/acp-http-smoke.mjs`:

```
✓ initialize: connectionId=… protocolVersion=1
✓ session/new: sessionId=…
→ prompt: "Reply with the single word: pong"
pong
✓ prompt complete: 10 session/update frames, stopReason=end_turn
✓ DELETE /acp — connection closed
ALL CHECKS PASSED ✅
```

Error-path was also confirmed live: when the child failed to start, the bridge
timeout surfaced to the client as a JSON-RPC error frame on the connection
stream (`{"id":2,"error":{"code":-32603,…}}`), proving id-correlation + the
202/SSE split under failure.

### Review fold-in — bridge-issued clientId (found in live verify)

First live run failed `session/prompt` with _"client id … is not registered for
session"_. Root cause: `spawnOrAttach`/`loadSession` **ignore** a caller-supplied
clientId the bridge has never issued and stamp a fresh one (returned in
`BridgeSession.clientId`); the dispatcher was echoing the connection's own
(unregistered) id on `sendPrompt`. Fix: persist the bridge-stamped id on the
`SessionBinding` and echo it on every per-session call (`sessionCtx`). Re-verified
green above.

---

## 11. Review round 2 — fold-ins

Two independent reviews (correctness/concurrency + protocol-conformance/security) plus a self-read.
All fixes verified by the expanded vitest suite (**18 tests**) + a fresh live smoke run
(21 `session/update` frames → `stopReason=end_turn`).

| #   | Severity | Finding                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                    |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **P0**   | Session-stream **reconnect was permanently dead**: `SessionBinding.abort` was created once and reused; on stream close it was aborted forever, so a reconnect's `subscribeEvents(signal)` got an already-aborted signal and received zero events. | `attachSessionStream` now installs a **fresh** `AbortController` per stream (and closes any prior stream); `index.ts` pumps on that fresh signal.                                      |
| R2  | **P0**   | `await dispatcher.handle()` ran **after** `res.end(202)`; a throwing bridge call (notably the un-try/caught `isResponse` path) would reject and surface as an unhandled rejection → possible daemon crash.                                        | Wrapped the `isResponse` path in try/catch; `.catch()` on the awaited `handle(...)` and on `pumpSessionEvents(...)`.                                                                   |
| R3  | **P1**   | **No connection→session ownership**: any authenticated connection could open the session SSE for, or prompt, _any_ sessionId in the workspace (read-eavesdrop; prompt was only blocked incidentally by the unregistered-clientId error).          | `AcpConnection.ownedSessions` populated by `session/new`/`load`/`resume`; session stream returns `403` and per-session POSTs return `INVALID_PARAMS` for unowned ids (`requireOwned`). |
| R4  | **P1**   | `mountAcpHttp` handle was discarded → TTL sweep timer + live SSE streams leaked on shutdown.                                                                                                                                                      | Handle parked on `app.locals`; `runQwenServe` close hook calls `dispose()` before `bridge.shutdown()` (mirrors the device-flow registry).                                              |
| R5  | **P1**   | **Pending permission leak**: closing a session/connection with a permission outstanding left the bridge blocked awaiting a vote.                                                                                                                  | `closeSessionStream`/`destroy` cancel matching pending requests via an injected `onAbandonPending` → `cancelAbandonedPermission`.                                                      |
| R6  | **P1**   | Pre-attach frame buffers (`connBuffer`/`binding.buffer`) were unbounded.                                                                                                                                                                          | Capped at 256 frames (drop-oldest), matching the EventBus `maxQueued`.                                                                                                                 |
| R7  | **P2**   | `initialize` ignored the client's requested `protocolVersion`.                                                                                                                                                                                    | Negotiates `min(requested, 1)`.                                                                                                                                                        |
| R8  | **P2**   | No `Acp-Session-Id` ↔ `params.sessionId` cross-check (RFD §2.3).                                                                                                                                                                                 | POST asserts they agree; mismatch → `INVALID_PARAMS`.                                                                                                                                  |
| R9  | **P2**   | `session/cancel` request-form (with id) never answered; duplicate top-level `_meta.qwen`.                                                                                                                                                         | Reply when an id is present; single `agentCapabilities._meta.qwen`.                                                                                                                    |

### Accepted / documented (not fixed in v1)

- **Prompt-result vs trailing `session/update` ordering** (P2): `handlePrompt` awaits `sendPrompt` then
  writes the result frame, while updates stream concurrently. In practice the bridge publishes all
  `session/update`s to the bus before `sendPrompt` resolves and both share one ordered SSE write
  chain, so the result lands last (confirmed: 21 updates then result). A strict barrier is a possible
  later hardening if a client reducer proves sensitive.
- **Browser `EventSource` can't set `Authorization`** — `/acp` GET streams require the bearer header,
  so browsers need the deferred WebSocket path (§7); CLI/Node clients are unaffected.
- The daemon's real trust boundary remains the **bearer token + single-workspace bind** (same as the
  REST surface); R3's ownership check is defense-in-depth + contract correctness, not a tenant boundary.

---

## 12. Review round 3 — PR bot fold-ins (#4472)

Two automated PR reviewers plus the summary bot.
All fixes verified by the suite (now **22 tests**) + a fresh live run (16 `session/update` → `end_turn`).

| #   | Severity | Finding                                                                                                                                                                                                                                     | Fix                                                                                                                                                                         |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| B1  | **P0**   | `handlePrompt`'s `AbortController` was never aborted — a disconnecting/cancelling client left the agent running (burned model quota, blocked the session FIFO). Flagged by both bots + 5 sub-agents.                                        | `promptAbort` parked on `SessionBinding`; aborted by `session/cancel` and by session/connection teardown (`closeSessionStream`/`destroy`).                                  |
| B2  | **P0**   | `sessionCtx` missing `fromLoopback` → every ACP permission vote treated as remote; `local-only` policy would reject loopback clients.                                                                                                       | Capture loopback at `initialize` (kernel `remoteAddress`, not forgeable headers) → `AcpConnection.fromLoopback` → threaded through `sessionCtx`.                            |
| B3  | **P0**   | SSE write failures silently swallowed → zombie streams (heartbeats fire, zero events delivered, no logs).                                                                                                                                   | First write failure logs + closes the stream.                                                                                                                               |
| B4  | **P0**   | Idle sweep destroyed connections with no log + no connection cap (initialize-flood).                                                                                                                                                        | Sweep logs each reap; `pumpSessionEvents` calls `touch()` (long quiet prompts aren't reaped); `maxConnections` cap (64) → `503`.                                            |
| B5  | **P1**   | `sessionCtx` silently fell back to the connection's unregistered clientId when the binding lacked one (untested, always-fired in `FakeBridge`).                                                                                             | Throw on missing stamped clientId (invariant violation); `FakeBridge` now stamps one.                                                                                       |
| B6  | **P1**   | `session/new                                                                                                                                                                                                                                | load                                                                                                                                                                        | resume`accepted`cwd` unvalidated (REST validates string/length/absolute — amplification DoS). | Shared `parseOptionalWorkspaceCwd` (string, ≤4096, absolute). |
| B7  | **P1**   | `session/prompt` forwarded an unvalidated `prompt` to the bridge.                                                                                                                                                                           | `validatePrompt` (non-empty array of objects), mirroring REST.                                                                                                              |
| B8  | **P1**   | Raw bridge error messages echoed to the client.                                                                                                                                                                                             | `toRpcError` maps known bridge errors to coded, client-safe shapes; unknown → generic `Internal error` (full detail still to stderr).                                       |
| B9  | **P1**   | `nextId` used sequential negatives — a client legally using negative ids could collide in `pending`.                                                                                                                                        | Daemon-originated ids are now strings (`_qwen_perm_N`), disjoint from any client id.                                                                                        |
| B10 | **P2**   | `resolveClientResponse` param type excluded `JsonRpcError`; conn-scoped SSE stream had no `onClose`; `DELETE` with no header was a silent 202; `SseStream.close` ran `onClose` outside try/catch; `session/load`·`resume`·`close` untested. | Widened param to `JsonRpcResponse`; conn stream logs on close; `DELETE` missing header → `400`; `onClose` wrapped in try/catch; added load/resume/close + DELETE-400 tests. |

**Out of scope (base-branch `daemon_mode_b_main`, not this diff)** — the second reviewer flagged
typecheck errors in `acpAgent.ts` (`entryCount`/`entrySummary`/`sessionClose`) and other pre-existing
items it explicitly attributed to the base branch (introduced by #4353). Tracked separately; not
touched here.

**Still deferred** (documented): per-connection secret for `DELETE`/connection ownership (token remains
the boundary); WebSocket + HTTP/2 (§7); strict prompt-result vs trailing-update barrier (§11).

---

## 13. Review round 4 — PR fold-ins (rebased onto #4469)

Branch rebased onto `daemon_mode_b_main` (#4353 + #4469) — **clean, no conflicts**. Two PR
reviewers (GPT-5 + qwen3.7-max). Suite now **25 tests**; live re-verified (125 `session/update`
→ `end_turn`).

| #   | Severity | Finding                                                                                                                                                                                     | Fix                                                                                                                                                                                            |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **P0**   | Round-3 "SSE write-failure handling" was documented but NOT implemented — `SseStream` still left it to discarding callers (zombie streams).                                                 | `writeRaw` now owns it: first write rejection logs once + `close()`s; `doWrite` also listens for `'error'` (rejects promptly instead of hanging to `'close'`); `onClose` wrapped in try/catch. |
| C2  | **P1**   | `fromLoopback` captured only at `initialize` + helper narrower than REST → `local-only` votes from a later POST misjudged.                                                                  | Per-request loopback threaded through `handle`→`sessionCtx`/`resolveClientResponse`; `isLoopbackReq` widened to `127.0.0.0/8` + `::ffff:127.*` + `::1` (matches REST).                         |
| C3  | **P1**   | Error routing inferred stream from `params.sessionId` → conn-scoped method failures (`session/load`/`resume`/`close`/`heartbeat`) misrouted to a non-existent session stream (silent loss). | `CONN_ROUTED_METHODS` set; errors route the same way as the success path.                                                                                                                      |
| C4  | **P1**   | `bridge.detachClient` never called on teardown → stale bridge-stamped client ids linger in `knownClientIds()`/voter sets.                                                                   | Registry takes a `DetachSessionFn`; `closeSessionStream`/`destroy` detach each owned session (best-effort).                                                                                    |
| C5  | **P1**   | `session/close` skipped local cleanup if `bridge.closeSession` threw.                                                                                                                       | `closeSessionStream` moved into a `finally`.                                                                                                                                                   |
| C6  | **P2**   | Windows `cwd` (`C:\…`) rejected by `startsWith('/')`.                                                                                                                                       | `path.isAbsolute` (platform-aware), matching REST.                                                                                                                                             |
| C7  | **P2**   | `protocolVersion` could negotiate `0`/negative.                                                                                                                                             | Clamp `Math.max(1, Math.min(requested, 1))`; tests for 0/neg/huge/invalid.                                                                                                                     |
| C8  | **P2**   | `session/load`/`resume` accepted empty `sessionId`.                                                                                                                                         | Reject empty with `INVALID_PARAMS`.                                                                                                                                                            |
| C9  | **P2**   | Notification-form `session/prompt` errors vanished silently.                                                                                                                                | Log on the no-id path.                                                                                                                                                                         |
| C10 | **P2**   | Session SSE flushed buffered frames before headers/`retry:`.                                                                                                                                | `open()` before `attachSessionStream`.                                                                                                                                                         |
| C11 | **P2**   | Duplicate local `logStderr`.                                                                                                                                                                | Shared `writeStderrLine` from `utils/stdioHelpers`.                                                                                                                                            |
| C12 | **P2**   | Docs advertised `--no-acp-http` flag, `acp_http` capability tag, and `fs/*` forwarding not in v1.                                                                                           | Doc aligned to shipped surface (env-var toggle only; `fs/*`+`terminal/*` + flag + tag marked deferred).                                                                                        |

Still deferred (unchanged): WebSocket + HTTP/2; per-connection secret for `DELETE`/ownership
(token + single-workspace remains the boundary); strict prompt-result ordering barrier; the
`as never` bridge-boundary casts (targeted, noted for an adapter-types follow-up).

---

## 14. Review round 5 — PR fold-ins

One more reviewer pass (qwen3.7-max). Suite **26 tests**, live re-verified.

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                                                                              |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **P0**   | `resolveClientResponse` deleted the pending entry BEFORE calling `respondToSessionPermission`. A malformed vote (`result: {}`) makes the bridge mediator throw — and with the pending entry already gone, teardown's `abandonPendingForSession` can't cancel it, so the agent's prompt hangs on a vote that never resolves (a token-holder could stall a session with one bad POST). | Wrap the vote in try/catch; on any failure fall back to `cancelAbandonedPermission` so the mediator is always released. New test covers the malformed-vote path. |
| D2  | **P1**   | Session-stream `onClose` aborted only the event pump, not `binding.promptAbort` — a client disconnect (tab close / network drop) left the in-flight prompt running (quota + FIFO) until idle TTL.                                                                                                                                                                                    | `onClose` now also aborts the session's `promptAbort`.                                                                                                           |
| D3  | **P1**   | When `pumpSessionEvents` rejected, the `.catch` only logged — the SSE stream stayed open heartbeating but delivering nothing (zombie, no reconnect signal).                                                                                                                                                                                                                          | `.catch` now also `closeSessionStream(sessionId)`.                                                                                                               |

---

## 15. Review round 6 — PR fold-ins

Another reviewer pass (qwen3.7-max). Suite **28 tests**, live re-verified.

| #   | Severity | Finding                                                                                                                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                                        |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | **P0**   | `handlePrompt` overwrote `binding.promptAbort` without aborting the prior controller — two concurrent `session/prompt`s for one session orphaned the first (runs to completion in the bridge FIFO, unabortable by `session/cancel`). | Abort the prior `promptAbort` before installing the new one. Test added.                                                                                                                                                                                                                                                                   |
| E2  | **P0**   | The `subscribeEvents`-throws path sent a `stream_error` notify then `return`ed (resolved) — the caller's `.catch` never fired, leaving a zombie SSE stream (heartbeats, no events, no reconnect signal).                             | Re-throw after the notify so the caller's `.catch` closes the stream. Test asserts prompt closure.                                                                                                                                                                                                                                         |
| E3  | **P1**   | SSE heartbeat didn't mark the connection active — a long prompt with no intermediate events for >30 min got idle-reaped (streams + prompts killed).                                                                                  | `SseStream` takes an `onHeartbeat` hook; both GET handlers pass `() => conn.touch()`.                                                                                                                                                                                                                                                      |
| E4  | **P2**   | `pumpSessionEvents` `.catch` closed by sessionId — a reconnect between the throw and the microtask could kill the NEW stream.                                                                                                        | Identity-guard: only close if `binding.stream` is still this stream.                                                                                                                                                                                                                                                                       |
| E6  | **P2**   | `sendSession` auto-created a binding — a late pump/reply frame after `closeSessionStream` resurrected a ghost binding that buffered up to 256 frames forever.                                                                        | `sendSession` is now lookup-only: drops frames when the session has no live binding.                                                                                                                                                                                                                                                       |
| E5  | accepted | `session/load`/`resume` don't reject when another live connection owns the session ("hijack").                                                                                                                                       | **Accepted, not changed:** the daemon's trust boundary is the bearer token + single-workspace bind, and multi-client attach is intentional (the bridge is multi-client by design; REST has the same property). A token-holder gains no capability they lack via REST. Tracked with the other token-boundary items (DELETE ownership, §13). |

---

## 16. Review round 7 — PR fold-ins

Another reviewer pass (qwen3.7-max). Suite **30 tests**, live re-verified.

| #   | Severity | Finding                                                                                                                                                                                                        | Fix                                                                                                                                                                                                         |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **P0**   | Concurrent `session/close` TOCTOU: `ownedSessions.delete` ran only in `finally` (after the await), so two concurrent closes both passed `requireOwned` → misleading error to the 2nd + redundant bridge close. | Delete the ownership gate SYNCHRONOUSLY before the await; bridge close runs once. Test added.                                                                                                               |
| F2  | **P1**   | Pump lifecycle: a CLEAN iterator end (subprocess ended, `done`) resolved → the `.catch` never fired → zombie stream; and a MID-STREAM iterator error sent no `stream_error`.                                   | `pumpSessionEvents` wraps the whole loop (sync + mid-stream errors send `stream_error` then re-throw); the consumer `.then(onDone, onErr)` closes the stream on BOTH paths (identity-guarded). Tests added. |
| F3  | **P2**   | 503 connection-cap rejection had no stderr log.                                                                                                                                                                | `writeStderrLine` with the cap value.                                                                                                                                                                       |
| F4  | **P2**   | `_qwen/notify stream_error` spread let `event.data.kind` shadow the discriminator.                                                                                                                             | Spread first, then `kind: 'stream_error'`.                                                                                                                                                                  |
| F5  | **P2**   | `MAX_WORKSPACE_PATH_LENGTH` redeclared (`= 4096`) vs the canonical `fs/paths.js`.                                                                                                                              | Import from `../fs/paths.js` (no divergence).                                                                                                                                                               |
| F6  | **P2**   | `isObjectParams` duplicated `json-rpc.isObject`.                                                                                                                                                               | Import `isObject`.                                                                                                                                                                                          |
| F7  | **P2**   | Raw `process.stderr.write` in `index.ts`/`sse-stream.ts` vs `writeStderrLine` elsewhere.                                                                                                                       | Unified on `writeStderrLine` across the module.                                                                                                                                                             |

---

## 17. REST 等价对齐 + 扩展方案审计落地（round 8）

目标：让 `/acp` 成为 REST+SSE 的**等价替代**。本批基于审计结论重构扩展方案，并补齐**所有 bridge 已暴露**的能力；bridge 尚未拥有的能力（文件 I/O、设备流、agents/memory CRUD）按架构正确性要求**先由 acp-bridge 补齐**（见 §17.3）。

### 17.1 扩展方案审计 → 落地（替换 §5 的旧方案）

依据**仓库实装 SDK `@agentclientprotocol/sdk@0.14.1`**（非仅官网）核对：

- `session/set_config_option` 是**一等（非 `unstable_`）方法**，请求 `{sessionId, configId, value}`，`category` 含 `model`/`mode`/`thought_level`；而 `set_model` 仍走 `unstable_setSessionModel`。
- 规范保留 `_` 前缀给扩展，示例为域风格 `_zed.dev/…`；厂商数据放 `_meta` 按域名分键。

落地：

- **命名空间 `_qwen/` → 反向域名 `_qwen/`**；`_meta` 统一 `_meta:{ "qwen": … }`（含 `initialize` 能力广告与 `session/request_permission` 的 requestId）。
- **模型 + 审批模式 → 标准 `session/set_config_option`**（`configId:"model"|"mode"`），路由到现有 `bridge.setSessionModel`/`setSessionApprovalMode`；`session/new` 结果**广告 `configOptions`**（取自子进程会话状态 `getSessionContextStatus().state.configOptions`，已是 ACP 形状）。**删除**厂商 `_qwen/session/set_model`。
- REST(http+sse) **无需同步修改**：两 transport 共用同一 bridge，状态天然一致。

### 17.2 本批新增的 `/acp` 方法（bridge 已支持，1:1 对齐 REST）

| REST                                                  | `/acp`                                             | bridge                                   |
| ----------------------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `POST /session/:id/model` / `approval-mode`           | **标准** `session/set_config_option`（model/mode） | setSessionModel / setSessionApprovalMode |
| `GET /session/:id/context`                            | `_qwen/session/context`                            | getSessionContextStatus                  |
| `GET /session/:id/supported-commands`                 | `_qwen/session/supported_commands`                 | getSessionSupportedCommandsStatus        |
| `PATCH /session/:id/metadata`                         | `_qwen/session/update_metadata`                    | updateSessionMetadata                    |
| `GET /workspace/{mcp,skills,providers,env,preflight}` | `_qwen/workspace/{…}`                              | getWorkspace\*Status                     |
| `POST /workspace/init`                                | `_qwen/workspace/init`                             | initWorkspace                            |
| `POST /workspace/tools/:name/enable`                  | `_qwen/workspace/set_tool_enabled`                 | setWorkspaceToolEnabled                  |
| `POST /workspace/mcp/:server/restart`                 | `_qwen/workspace/restart_mcp_server`               | restartMcpServer                         |

（既有：session/new·load·resume·close·list·prompt·cancel、heartbeat、permission、events 已对齐。）

### 17.3 仍缺口 → 要求 acp-bridge 先补齐（架构正确性）

REST 的 **文件 I/O**（`/file /glob /list /stat /file/write /file/edit`）、**设备流登录**（`/workspace/auth/*`）、**agents CRUD**（`/workspace/agents`）、**memory CRUD**（`/workspace/memory`）目前**不在 `HttpAcpBridge` 上**——REST 路由直接调 route 级服务（`WorkspaceFileSystemFactory`、`DeviceFlowRegistry`、`SubagentManager`、`writeWorkspaceContextFile`），绕过了 bridge。

**决策（采纳评审/owner 意见）**：不让 `/acp` transport 再去直连这些 route 级服务（那会复制 REST 的架构漂移、并使 transport 耦合翻倍）。**正确做法是先在 `@qwen-code/acp-bridge` 的 `HttpAcpBridge` 上补齐这些能力**（如 `readWorkspaceFile`/`writeWorkspaceFile`/`globWorkspace`、`startDeviceFlow`/`pollDeviceFlow`、`listAgents`/`upsertAgent`/`deleteAgent`、`readMemory`/`writeMemory`），让 REST 与 `/acp` 都经由 bridge。届时 `/acp` 再加 `_qwen/fs/*`、`_qwen/auth/*`、`_qwen/workspace/agent*`、`_qwen/workspace/memory*`（文件读因无标准 ACP client→agent 方法，属合法厂商扩展）。

**完整等价 = 本批（bridge 已有能力）+ acp-bridge 补齐缺口后的后续批**。

---

## 18. Review round 9 — PR fold-ins

| #   | Severity            | Finding                                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                                     |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **P1 (regression)** | Session-stream reconnect aborted the in-flight prompt: `attachSessionStream` closed the OLD stream before installing the new one, and the old stream's `onClose` unconditionally aborted `promptAbort` — so a reconnecting client (network glitch/roaming) lost its running prompt. | Install the new stream BEFORE closing the old; identity-guard `onClose`'s prompt-abort (only abort if THIS is still the session's live stream). Test added (prompt survives reconnect). |
| G2  | **P2**              | `session/cancel` passed `undefined` as the `CancelNotification` body, dropping client-supplied cancel fields (reason/context) that REST forwards.                                                                                                                                   | Forward `{ ...params, sessionId }` (mirrors REST).                                                                                                                                      |

Rebased onto latest `daemon_mode_b_main` (#4473/#4483/#4484/#4500), no conflicts. Suite **33 tests**, live re-verified.

---

## 19. 路线图 / 后续 PR（防遗忘）

本 PR（#4472）= ACP Streamable HTTP transport + **全部 bridge-backed 能力对齐** + 官方扩展方案。已转 **ready**。达到「`/acp` 完全等价 REST+SSE」尚需：

1. **Follow-up PR 1 — acp-bridge 能力补齐（前置 / bridge-first）**：`HttpAcpBridge` 新增 文件 I/O、设备流、agents CRUD、memory CRUD 方法；REST 路由改走 bridge（消除直连 route 级服务的漂移）。
2. **Follow-up PR 2 — `/acp` 剩余对齐（依赖 PR 1）**：`_qwen/fs/*`、`_qwen/auth/*`、`_qwen/workspace/agent*`、`_qwen/workspace/memory*` → 完全等价 REST。

跟踪：#3803（open decisions）、#4175（Mode B roadmap）均已 comment。
Deferred 硬化项见 PR 描述「已知 deferred」。

---

## 20. Extension-namespace rename + SDK-transport analysis (round 11)

- **Namespace `_qwen.ai/` → `_qwen/`**: ACP's only hard rule is the leading `_`; the `_zed.dev/` domain segment is convention-by-example, not a MUST. Since `qwen` is distinctive, we use the shorter bare form. `_meta` key likewise `"qwen"`. (Survey of real agents: Zed/gemini-cli mostly use `_meta`-on-standard-methods + ACP's own `unstable_*`; bare custom `_` methods are rare — our `_qwen/*` are genuinely-new workspace/session ops with no standard equivalent, so a `_` method is the right tool.)
- **Why hand-rolled transport (not SDK-based)**: the TS SDK ships only `ndJsonStream` (stdio); RFD #721 HTTP is SDK Phase-3 (not implemented). The SDK `Connection` is single-duplex-stream; our transport is multi-stream (POSTs + connection-SSE + per-session-SSE) and needs outbound demux by sessionId — which our dispatcher already knows at routing time. A full SDK rewrite fights that model and wouldn't remove the bulk (bridge translation, SSE lifecycle, ownership, EventBus→JSON-RPC). **Pragmatic improvement (candidate follow-up): adopt the SDK's Zod schema validators + types for param validation while keeping the hand-rolled transport.** SDK clients using `extMethod('_qwen/…')` interoperate with our handlers (identical wire shape).
