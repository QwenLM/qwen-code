# Managed Web Terminal

[English](2026-11-10-managed-web-terminal.md) | [简体中文](2026-11-10-managed-web-terminal.zh-CN.md)

Status: implemented; product decisions confirmed 2026-11-10.
Date: 2026-11-10.

## Problem and current state

The local daemon already ships a complete Web Terminal: the Web Shell
`TerminalPanel` (xterm) connects to the daemon's `/terminal` WebSocket
(`packages/cli/src/serve/routes/terminal.ts`), which is backed by the core
`WebTerminalRegistry` (`packages/core/src/services/web-terminal-registry.ts`,
node-pty/bun-pty, bounded scrollback replay, detach/reconnect, idle reclaim).
The `web_terminal` capability gates the UI entry, and the daemon supplies the
resolved workspace runtime's cwd and environment to the PTY
([web terminal lifecycle](web-terminal-lifecycle.md)).

Managed Agent had no equivalent; the capability parity matrix recorded this
as a deliberate gap (`web_terminal: NO_MANAGED_EQUIVALENT`, issue #15075).
This increment closes that gap: the parity row now stands at `managed`,
evidenced by the terminal-ticket surface route and this design.
The existing Managed "shell" is an agent tool, not a user terminal:
`hosted-workspace-shell/1` exposes `run_shell_command` and `monitor` through
durable Broker dispatch with approval, and the H3 background Shell design
([managed shell monitor runtime](2026-10-03-managed-shell-monitor-runtime.md))
explicitly defers `send_input`, the interactive-input capability. The Java
control plane has no WebSocket surface today; the Managed Web Shell consumes
HTTP and SSE.

Users operating a Managed Session therefore cannot run ad-hoc commands,
inspect processes, or debug the hosted workspace interactively; every command
must go through a model Turn.

## Goals and scope

Goals:

- An interactive user terminal in the hosted workspace of a Managed Session,
  opened from the Managed Web Shell, with the same frame protocol and UI as
  the local Web Terminal.
- The PTY runs inside the Runtime worker that owns the workspace, reusing
  `WebTerminalRegistry` semantics: scrollback replay, detach/reconnect, idle
  reclaim, bounded concurrency.
- Tenant, actor, Workspace grant and Session lifecycle authorization identical
  in strength to the existing WebShell routes; fail-closed binding resolution.
- Active terminals hold the Runtime durably so close, delete and release
  cannot silently kill or orphan them.

Non-goals:

- No change to agent tool execution, approval modes, or the Shell profile's
  tool list. A user terminal is not a model tool call.
- No `send_input` for H3 background Shells; that reserved capability remains a
  separate slice.
- No terminal survival across worker replacement, no detach that survives
  Session close, and no durable transcript of terminal content.
- No terminal on `external-scratch` or K1 Kubernetes scratch runtimes, whose
  contracts require Workspace files and Shell to stay disabled.
- No new public (`/v1/agents/**`) surface in this increment; the terminal is a
  WebShell capability.

## Architecture

```
Browser (TerminalPanel / xterm, existing frame codec)
   |  1. POST terminal-ticket on the authenticated WebShell surface
   |     (full admission: tenant, actor, grant, role, profile, opt-ins)
   |  2. WebSocket upgrade offering the single-use ticket as a bearer
   |     subprotocol (browsers cannot set the deployment auth headers)
   v
Java control plane (WebShell surface)
   - upgrade consumes the ticket once, re-checks Session/terminal identity
   - Session -> READY terminal-capable binding -> worker endpoint; fail closed
   - byte-level relay; no tool-execution rows for terminal I/O
   - durable hold while any terminal is attached; drains on lifecycle ops
   |  WebSocket, worker bearer/lease protocol
   v
Runtime worker (private HTTP surface, port 43190)
   - new terminal upgrade route behind the owned-route gate
   - WebTerminalRegistry: PTY in the Session's workspace cwd/env
```

The data plane is a stateless passthrough; the control plane owns only
authorization and the durable hold. This preserves the ownership boundary:
the Java control plane supervises no processes, and the worker remains the
single process owner.

## Design

### Worker terminal endpoint

The worker (`packages/cli/src/serve/managed-runtime-attestation-worker.ts`)
gains one terminal route on its private HTTP surface, authenticated with the
existing bearer/lease protocol and listed in the owned-route gate inventory.
Because the server sets short request timeouts (`requestTimeout`,
`headersTimeout`), the route is served from an `upgrade` listener on the same
`http.Server`; upgraded sockets leave the request lifecycle and are governed
by the terminal heartbeat and idle rules instead.

The endpoint hosts a `WebTerminalRegistry` instance. Terminals are tagged with
the owning Session identity; an attach may only address a terminal of the
same Session, and the PTY receives the Session's resolved workspace cwd and
effective environment, exactly as the local daemon supplies its workspace
runtime's context. The registry's existing bounds apply unchanged:
`MAX_CONCURRENT_WEB_TERMINALS` (8) per worker, roughly 4 MB replayed
scrollback, `IDLE_RECLAIM_MS` (15 minutes) detached reclaim, 64 KiB pending
input, 8 MiB socket backpressure ceiling, 15 s heartbeat, dimensions capped
at 1000. A per-Session cap of 4 terminals applies within the worker-wide 8
(confirmed 2026-11-10).

The worker advertises the terminal capability in its boot capability digest.
The digest is a frozen binding input (see Constraints), so this ships as a
coordinated control-plane/Harness/Runtime deployment.

### Control-plane relay

The Java server adds its first WebSocket endpoint, on the WebShell surface:
`GET /api/agent/web-shell/v1/sessions/{sessionId}/terminal` (HTTP upgrade).
The handshake runs the same authorization chain as other WebShell Session
routes, plus terminal-specific admission:

1. Tenant and actor authentication; Workspace read grant; OPERATOR role.
2. Session active, undeleted, Workspace-bound, on the unified
   `hosted-workspace-shell/1` profile.
3. The deployment Shell opt-in and persisted approval remain valid, and the
   new terminal deployment opt-in is enabled.
4. The Session's own binding resolves to READY in the resolved runtime.
   Unknown, untrusted, ambiguous, bootstrapping, draining or removed states
   fail closed with a typed error; the relay never falls back to another
   runtime or to the primary.

After the handshake the relay forwards binary frames and NUL-prefixed control
frames verbatim in both directions. Terminal I/O creates no tool-execution
rows, no journal events and no artifacts; it is keystroke-volume live data
with no idempotent-replay semantics, and journaling it would also persist
whatever secrets the terminal prints. Only the hold (below) is durable.

The control plane terminates active relays through the hold drain: close,
delete and drain stop the terminals, collect exit evidence and settle the
hold, and the worker's resulting close propagates through the relay to the
browser leg. Grant revocation is enforced at attach; a relay attached before
a revocation stays open until the Session's next lifecycle drain, because
transitions that leave ACTIVE without sweeping holds do not yet enumerate
live relays (see Risks and follow-up).

The unified local launcher (`qwen serve --managed`) mounts Java routes behind
daemon authentication; its managed proxy must forward this route's WebSocket
upgrade as well. The ordinary daemon's own `/terminal` route and its
`web_terminal` capability are unchanged.

### Durable hold and lifecycle

An attached terminal is live work on the Runtime. The design reuses the H3
two-row ledger pattern: admitting the first terminal of a Session creates a
non-terminal hold execution that holds the Runtime against
`hasActiveByRuntimeSession`/`hasActiveByBinding`, exactly as a background
Shell's second execution does. The hold settles when the last terminal is
released, idle-reclaimed, or drained. Terminal admission and settlement are
owner-side operations; they never create a model Turn.

The hold reuses the existing execution tables unchanged (confirmed
2026-11-10): a terminal hold is identified by the operation identity pinned
in its execution reference, the same mechanism that distinguishes H3
background Shell executions. No new column, table or record domain is
introduced.

Close and delete follow the existing release-ordered drain: stop the
terminals (kill the PTYs), collect exit evidence, settle the hold, then
continue resource settlement. A stop whose outcome cannot be proven keeps
the hold active and blocks retirement, matching the existing wedge semantics
— an uncertain terminal stop is never fabricated as settled.

Idle reclaim releases the PTY and settles the hold without user action. A
worker replacement loses every terminal: the registry is in-memory state, and
the relay forwards the worker's non-retryable close code to the browser leg,
which renders the explicit terminal-lost notice. Terminals are never
replayed on a replacement worker, consistent with the Broker rule that
ambiguous work is settled only on the original Runtime's evidence. The hold
follows the existing lost-Runtime recovery semantics; this design adds no new
recovery path.

### Admission and approval model

The terminal is a human-driven surface. Keystrokes are not agent tool calls,
so the Shell profile's per-command approval (default/auto-edit) does not
apply; the authorization boundary is the deployment opt-in plus the caller's
OPERATOR grant on the Workspace. This is a deliberate product decision: a
deployment that enables the terminal accepts that an authorized operator can
run arbitrary commands as the worker user in the workspace, without
per-command approval. Only ordinary local Workspace bindings can enable the
terminal, and there the worker runs as the server account with no container
isolating it, so the opt-in grants that account's shell access. The opt-in
defaults to off and is independent of the Shell opt-in so a deployment can
enable agent Shell while keeping the user terminal closed.

`external-scratch` and K1 scratch runtimes refuse terminal admission: their
contracts disable Workspace files and Shell, and the terminal inherits that
refusal. Sessions on `hosted-workspace-files/1` are out of scope.

### Contract and capability advertisement

The terminal's data plane is a WebSocket upgrade, not a REST handler, so the
upgrade itself takes no `SurfaceRegistry` route label (the D6 gate enumerates
`RequestMappingHandlerMapping` handlers). Its admission, however, is minted
over a real public route that is fully contracted:

- `POST /api/agent/web-shell/v1/sessions/terminal-ticket` carries the
  `SESSION_TERMINAL_TICKET` `SurfaceRegistry` label and an OpenAPI path
  (`WebShellTerminalTicketRequest` / `WebShellTerminalTicket`), so it is
  covered by the contract's actor-scope drift assertions. It runs the full
  terminal admission and returns a single-use, short-lived ticket.
- The parity row flips to `managed` with `surface:SESSION_TERMINAL_TICKET`
  evidence (plus this design as secondary evidence);
  `capability-parity.test.ts` resolves both.
- `ManagedAgentSessionSummary.capabilities` gains a `terminal?: boolean`
  field, computed server-side from the same admission chain and gated on a
  placement that can actually attach, so the UI entry appears only for
  Sessions that can attach. WebShell types are regenerated with
  `npm run generate:managed-agent-api --workspace=packages/web-shell`.
- The upgrade consumes the ticket once and re-checks Session/terminal
  identity; its typed refusals are documented here.

### Web Shell UI

The Managed conversation uses a dedicated `ManagedTerminalPanel` sharing the
local frame codec and the extracted xterm theme / subprotocol / reconnect
constants; the connection factory differs (Java WebShell WS URL with the
Session id, offering the minted single-use ticket as a bearer subprotocol)
from the local daemon connection. The entry is gated by
`capabilities.terminal`. Reconnect mints a fresh ticket and replays
scrollback and exit state through the registry, as locally. A page reload
loses the in-memory terminal id, so the detached terminal is idle-reclaimed
rather than restored — identical to the local lifecycle. A non-retryable
worker close code renders an explicit terminal-lost notice instead of a silent
reconnect loop.
Escape and outside-interaction dismissal are prevented so they cannot release
a live PTY, and the panel stays mounted across transient UI/capability dips.

## Design decisions and rationale

| Decision     | Choice                                                | Rejected alternative                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTY location | Runtime worker, reusing `WebTerminalRegistry`         | K8s `pods/exec` bypasses worker attestation, needs extra RBAC, and does not exist for local-process providers; a full `qwen serve` inside the worker adds a second security boundary the dual-path design forbids |
| Data plane   | Stateless byte relay, no durable I/O                  | Journaling keystrokes through Broker dispatch misuses idempotent-replay semantics and persists terminal secrets                                                                                                   |
| Lifecycle    | Durable hold on the H3 execution pattern              | An in-memory-only hold lets close/release kill or orphan live terminals                                                                                                                                           |
| Approval     | Deployment opt-in + OPERATOR, no per-command approval | Per-keystroke approval is meaningless for a human terminal; reusing agent approval would conflate two different actors                                                                                            |

## Affected components

| Component                             | Change                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` `WebTerminalRegistry` | Session-tagged ownership if not already expressible; no semantic change to bounds, replay or reclaim                                                                                                 |
| `packages/cli` managed runtime worker | Terminal upgrade route, route-gate entry, bearer/lease auth, capability digest bump                                                                                                                  |
| `packages/cli` unified launcher proxy | WebSocket upgrade forwarding for the terminal route                                                                                                                                                  |
| `packages/cli` `capability-parity.ts` | `web_terminal` row flips to `managed` with `surface:SESSION_TERMINAL_TICKET` + `docs:` evidence                                                                                                      |
| Java WebShell surface                 | First WebSocket endpoint: handshake authorization, binding resolution, byte relay, lifecycle-triggered close                                                                                         |
| Java hold admission                   | Owner-side hold execution admission/settlement on the H3 pattern; drain ordering in close/delete                                                                                                     |
| Contracts                             | `capabilities.terminal` on the session summary + regenerated WebShell types (the terminal-ticket POST is SurfaceRegistry-labelled and OpenAPI-contracted; the WS upgrade itself is not a REST route) |
| Web Shell client                      | Managed connection factory for `TerminalPanel`, entry gating, terminal-lost notice                                                                                                                   |
| Verification                          | Focused worker/Java/frontend tests, contract gates, real-process E2E and fault cases                                                                                                                 |

## Constraints

- The ownership boundary holds: control plane owns lifecycle and durable
  state, Broker owns execution bindings, the worker owns processes. The relay
  is the first live channel and must not grow process supervision on the Java
  side.
- The Harness capability digest is a frozen binding input; changing it after
  Sessions are placed invalidates existing bindings with no unblock path.
  Terminal capability therefore ships only in a coordinated deployment, as
  the Shell profile consolidation required.
- Until the first formal Managed Agent release the shared V1 schema baseline
  is edited in place; if the hold needs new columns or tables they join
  `V1__managed_schema.sql`, and development catalogs are recreated. Reusing
  the existing execution tables avoids even that.
- Workspace-scoped relay resolution stays inside the Session's resolved
  runtime; every ambiguous state fails closed and never falls back to the
  primary runtime.
- Terminal content is not journaled, exported, or retained as artifacts; the
  durable footprint is limited to hold lifecycle rows.

## Validation and acceptance

Focused tests first: worker route authentication and route-gate refusals,
Session-scoped attach, registry bounds/replay/reclaim under the worker;
Java handshake authorization matrix (tenant, grant, role, profile, opt-ins,
binding states), relay byte fidelity, hold admission/settlement, drain
ordering, lifecycle-triggered relay close; contract and parity gates;
frontend entry gating and terminal-lost rendering.

Real-process acceptance on Linux with the bundled worker and matching Java
artifacts: attach and run commands in the workspace cwd; resize; detach and
reconnect with scrollback and exit-state replay; idle reclaim settles the
hold; close with an active terminal drains with exit evidence before
settlement; killing the worker mid-terminal yields terminal-lost, no replay
on a replacement worker, and the existing lost-Runtime hold semantics.
Fault cases (worker kill during attach, database cut during hold admission)
join the existing fault-gate profile. Hold persistence runs the affected
`mysql-integration` cases against a disposable MySQL 8.4; H2 alone does not
establish it. Local Java verification follows the module's shared budget;
full suites stay in CI.

Acceptance is binary:

1. With the terminal opt-in off, attach is refused; with it on, an authorized
   `shell/1` Session attaches and echoes input/output in the workspace cwd.
2. Every unauthorized combination (wrong tenant, missing grant, below
   OPERATOR, files-only profile, scratch runtime, non-READY binding) is
   refused with a typed error and no fallback.
3. Terminal I/O creates no execution-result rows; the hold exists while a
   terminal is attached and settles on release, idle reclaim and drain.
4. Close/delete drains terminals with proven exit evidence; unproven stops
   keep the hold and block retirement.
5. Worker replacement never replays a terminal; the client receives an
   explicit terminal-lost notice.
6. The parity test passes with the `web_terminal` row citing this design, and
   the regenerated WebShell types carry `capabilities.terminal`; the existing
   `ManagedAgentApiContractTest`/`SurfaceRegistryGateTest` stay green (the WS
   upgrade adds no REST surface).

## Rollout

Deploy matching control-plane, Harness and Runtime artifacts together before
enabling the opt-in; the capability digest change invalidates bindings placed
against the old digest. The terminal opt-in defaults to off, independently of
the Shell opt-in. Existing Sessions gain the terminal only when their runtime
is placed on the new digest and the admission chain passes; saved Session
scope is not rewritten. Do not downgrade consumers with active holds.

## Risks and follow-up

- The Java WebSocket infrastructure is new; handshake authentication and
  relay backpressure need the same review rigor as the existing signed
  routes. A relay that buffers without bound is a memory exhaustion vector;
  the worker-side 8 MiB ceiling must be mirrored on the Java side.
- The hold reuses the two-row execution pattern with no schema change; the
  drain and wedge semantics are fixed by this design.
- Terminal content escaping the workspace (for example `cd /`) is not bounded
  by the terminal; the workspace containment rules that govern agent tools do
  not apply to a human terminal. The only placements that can enable the
  terminal are ordinary local Workspace bindings, where the worker runs as
  the server account with no container isolating it. Deployments must treat
  the opt-in as granting that account's shell access.
- No control-plane live-relay registry exists yet: lifecycle transitions do
  not enumerate live relays, so a grant revocation terminates an
  already-attached terminal only at the Session's next drain. A future
  registry would let lifecycle transitions close relays directly without
  waiting for the drain.
- Follow-ups: `send_input` for background Shells (H3 reserved), detach that
  survives close via an independent durable owner, per-Session terminal
  quotas, and any later decision to expose terminals to files-only Sessions.

## Open questions

None for this increment. The three questions raised with the proposal were
confirmed on 2026-11-10: the per-Session terminal cap is 4 within the
worker-wide 8; the hold reuses the execution tables unchanged, identified by
its pinned operation identity; and the terminal ships WebShell-only, with
any public-API exposure deferred to a later increment.
