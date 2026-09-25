# ACP Bridge execution engines

[English](./acp-bridge-execution-engines.md) | [简体中文](./acp-bridge-execution-engines.zh-CN.md)

## Status

Implementation plan for the Stage B Bridge slice of #12380, based on upstream
`790bd83c2b`. This slice supplies an opt-in Bridge construction API. Ordinary
serve factories and the Hosted model/tool loop are separate integration work.

## Problem and current behavior

The Bridge owns one reusable ACP channel and one startup promise. Sessions
already keep their own channel and connection, but callbacks look up sessions
through a shared ID map without consistently checking the sending channel.
Adding a second engine must preserve shared admission, reservations, replay,
and physical cleanup rather than duplicating the session control plane.

## Scope

Support Legacy and Managed channels inside one Bridge, fixed session ownership,
engine receipts, channel-scoped callbacks, and complete lifecycle accounting.
Keep existing callers of `channelFactory` compatible.

This change does not implement a Managed Harness, write owner records, select
compatible deployment configurations, wire the ordinary serve factories,
change the public REST API, or implement Stage G takeover. Managed branching
remains unavailable. Workspace control and preheat remain on the Legacy channel.

## Proposed design

### Construction and ownership contract

`executionEngines` contains `legacy` and `managed` factories and a server-owned
`select` callback. It is mutually exclusive with `channelFactory`. Selection
receives a snapshot of the validated spawn/load/resume request, including the
canonical workspace and trusted standalone purpose. It returns only `legacy`
or `managed`. Client metadata cannot override selection.

Selection runs after shared capacity and ID reservation, with the operation
already visible to shutdown. Cold load/resume requires the caller's selector
to read verified durable ownership; ambiguous or unreadable history must reject.
Hot attach uses the existing entry without invoking the selector again.

Paired channels require the actual ACP new/load/resume response to contain
`_meta['qwen.session.executionEngine']` matching the selected engine. This key
matches the pinned design/reference implementation. The host must persist or
verify ownership before returning this receipt and before initialization side
effects. A receipt is a trusted host assertion, not a filesystem proof performed
by the Bridge. The generic single-factory API does not require this receipt.

Owner persistence stays outside this package. #12693 currently introduces its
reader and writer foundations; the issue discussion must still settle the
minimal dependency and the relationship between `session_execution_engine`
and `managed_session_header_v1`. This slice does not create another format or
require all of Stage G. Production enablement requires that host integration.

### Channels and admission

Keep one `byId`, default attach entry, ID reservation map, admission budget,
runtime epoch source and set of physically owned channels. Add engine slots for
reusable channels and startup promises. Coalesce startup within an engine;
allow the two engines to start independently. Track dying generations until
physical exit. Channel quarantine blocks fresh work only for that engine.

Idle timers belong to the actual channel. Binding a restore to its channel and
settling the restore both recheck idle channels, including timers consumed while
selection had not yet bound an owner. An unrelated idle channel must not wait
for the selected engine's restore RPC or cleanup to finish. Re-evaluation arms
missing timers without extending another channel's existing idle deadline.
A late exit from an old generation must not cancel another channel's timer.
Shutdown awaits every engine startup, selection, session operation and owned
channel; force shutdown reaches all
tracked children. No failure path switches to the other factory.

### Registration and cleanup

Before registration, check the actual engine receipt and the returned session
ID. Invalid, conflicting or missing receipts reject registration. Close a
safely addressable unregistered session on its original connection. If its ID
cannot be safely addressed, quarantine the original channel, let other sessions
drain, and retain admission until physical exit. Never close another session
merely because a malformed response returned its ID.

Restore failures after a successful ACP response use the same original-channel
cleanup discipline. Public timeout is not evidence of physical completion.
Keep reservations until the original operation settles and cleanup completes.
The cleanup fence covers receipt rejection as well as timeout; its retry hint
is a backoff policy, not an estimate of when cleanup will complete.

### Live routing and workspace operations

Prompt, cancellation, approvals, model changes and session close use the entry's
bound connection. Inbound session lookups, restore replay, background admission,
and generation events must also match the sending channel/connection.

Workspace MCP, configuration/status control and preheat use Legacy. Aggregate
liveness and activity inspect both engines; idle reclamation locates the actual
candidate by ID. Preheat keepalive extends only Legacy's idle deadline. Managed
sessions and in-flight work prevent their own channel from being reclaimed;
Managed has no independent preheat keepalive in this slice. Child resource
sampling and user-language delivery also remain Legacy-only. Before production
enablement, #12380 must define per-engine resource aggregation and language
propagation together with host wiring.

The existing workspace-stop receipt addresses one physical channel, so stopping
multiple live channels is explicitly blocked until that receipt is extended.
A single live channel remains stoppable. Managed branch/side-task requests reject
before mutating history.

## Files and consumers

| Area                | Files / consumers                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Public construction | `bridgeOptions.ts`, package `index.ts`; daemon, Channels, SDK/embedded Bridge constructors |
| Channel ownership   | `channel-lifecycle.ts`, `channel-startup.ts`, `channel-harness.ts`                         |
| Session routing     | `session-control-plane.ts`, `BridgeClient` callbacks                                       |
| Verification        | Collocated Bridge/lifecycle tests and isolated process test script                         |

Existing daemon, Channels and embedded constructors remain on the single-factory
path. There are no new daemon routes. Workspace control is workspace scoped;
all session operations belong to the live session owner. A missing or failed
Managed owner must never resolve through a Legacy or primary-runtime fallback.

## Validation and acceptance criteria

1. Both engines coexist, with startup coalescing and shared session/ID limits.
2. Changing the selector default cannot change an attached or durably owned
   session. Selection and Managed failures cause zero other-engine dispatches.
3. Matching receipts permit registration; missing/conflicting receipts and
   malformed/colliding IDs reject without losing physical resource accounting.
4. Prompts, cancellation, permissions, replay and close stay on their owner;
   another channel cannot inject events or answer for that session.
5. Idle cleanup, quarantine, delayed startup, late responses and shutdown cover
   both engines and preserve replacement generations.
6. Existing single-factory tests remain green. Run build, typecheck, bundle,
   focused unit tests and isolated process verification. Test doubles prove the
   Bridge contract, not durable host persistence or Hosted inference.

## Risks and open questions

The highest risks are releasing admission before cleanup and treating one
engine's current channel as the entire workspace. Tests must observe actual
factory/connection calls and pending teardown, not only final session counts.
The owner persistence dependency and production host receipt implementation
remain the integration questions posted in #12380; the Bridge seam is usable
for contract tests while those are resolved.
