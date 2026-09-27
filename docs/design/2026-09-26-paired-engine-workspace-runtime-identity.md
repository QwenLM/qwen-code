# Paired engine workspace runtime identity

[English](./2026-09-26-paired-engine-workspace-runtime-identity.md) | [简体中文](./2026-09-26-paired-engine-workspace-runtime-identity.zh-CN.md)

## Status

First part of slice B2b of #12737, the Stage B host integration for #12380,
based on upstream `8629086ae2`. It specifies two of the workspace-contract gates
recorded in [ACP Bridge execution engines](./acp-bridge-execution-engines.md):
separating aggregate liveness from workspace-control readiness, and
channel-owned epochs with a stop generation policy, including a stop receipt for
multiple live channels. The third gate, delivering session-affecting workspace
changes to every live engine with the acknowledgement and permission-fence
semantics decided for Q2 in #12737, is the second part of B2b and a separate
change. After this change no ordinary daemon, Channels or embedded constructor
passes `executionEngines`.

## Problem and current behavior

A paired Bridge owns one channel per engine, but three workspace-level
contracts still treat the runtime as a single channel.

- **Liveness.** `isChannelLive()` and the lifecycle snapshot count any engine,
  while workspace control (workspace status and commands, MCP, Skills, preheat)
  is served only by the Legacy channel. With only a Managed channel live, the
  workspace runtime coordinator skips starting Legacy and records Skills
  preparation as failed with
  `No session with id "workspace-command:qwen/control/workspace/skills/refresh"`,
  and the workspace service reports a failed Legacy preheat as ready.
- **Epochs.** Every channel start allocates a new epoch from the shared source,
  but the Bridge reports one harness-wide value, the last allocated, as the epoch
  of the workspace-control runtime, of the stop target and of the idle
  candidate. Starting a Managed channel therefore restamps the Legacy runtime:
  unchanged Legacy MCP and Skills preparation reads as stale, MCP preparation
  aborts mid-poll, and a stop confirmation taken before the Managed start is
  rejected. In the other direction, when Legacy exits while Managed stays live,
  capabilities stamped with the newest epoch still read as ready.
- **Stop.** The stop snapshot and receipt name one channel, so a runtime with two
  live channels cannot be stopped (`multiple_engine_channels`).

## Scope

In scope:

- An epoch stored on each channel, reported for the channel it describes.
- A workspace-control lifecycle next to the aggregate one, and a
  workspace-control liveness check, used by the coordinator and the workspace
  service.
- A stop snapshot and receipt that cover every live channel, and the generation
  policy for stop confirmations.
- The #12698 coverage deferred to this area: the workspace-generation
  foreign-connection guard and clearing the multi-channel stop block.

Out of scope: propagating session-affecting workspace changes and their
acknowledgement (B2b part two); per-engine resource aggregation, language
propagation, Managed preheat/keepalive and quarantine recovery (B2c); host
wiring (B2d). Workspace control stays on Legacy. No route is added. Public
changes are the additive `channels` field in the stop preview and receipt, and
the paired-runtime meaning of the runtime status fields described below.

## Proposed design

### Channel-owned epochs

The shared, monotonic epoch source is unchanged. When a channel's handshake
completes, the epoch allocated for it is stored on that channel
(`HarnessChannel.runtimeEpoch`), and every report names the epoch of the
channel it describes:

- workspace status stamps (`workspaceSkills`, `workspaceMcp`, MCP tools and
  resources) use the workspace-control channel's epoch;
- the idle-channel candidate uses its own channel's epoch;
- the lifecycle snapshot's `runtimeEpoch` is the workspace-control channel's
  epoch while that channel is live, and the source's current value otherwise.

The harness keeps its last allocated value to detect a source that goes
backwards and, as before, as the stop snapshot's epoch when no channel is live. Starting or stopping a Managed channel leaves the Legacy epoch and
its MCP and Skills preparation unchanged. When Legacy exits, workspace control
is no longer live, so its capabilities read as stale even while Managed stays
live, and the next Legacy channel gets a new epoch.

On a single-factory Bridge the only live channel is always the newest one, so
every reported value is unchanged.

### Aggregate liveness and workspace-control readiness

The workspace-control channel is the Legacy channel of a paired Bridge and the
only channel otherwise. The Bridge reports both views:

| Signal                                                                                                               | Scope                              |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `isChannelLive()`, daemon status `channelLive`, lifecycle `state`, `runtimeLive` and `activeWork`                    | Every engine channel (unchanged)   |
| `isWorkspaceControlLive()`, lifecycle `workspaceControl` (`cold`, `starting`, `live`, `stopping`) and `runtimeEpoch` | The workspace-control channel only |

A paired Bridge reports `workspaceControl`: `live` while the Legacy channel is
live, `stopping` while a runtime stop runs or that channel is dying, `starting`
while its startup is in flight, and `cold` otherwise. A Bridge with one channel
omits it, because the aggregate fields already describe that channel, so its
lifecycle snapshot is unchanged. `isWorkspaceControlLive()` is optional in the
Bridge interface; a Bridge without it has one channel.

Consumers use the view they need:

- The workspace runtime coordinator reads the lifecycle through the
  workspace-control view for every decision: whether to preheat, whether a
  reconciliation must wait or retry after startup, and whether a capability is
  stale. Only its activity check stays aggregate.
- The public workspace runtime status therefore reports `runtimeLive` and
  `runtimeEpoch` for the channel that owns its capabilities, and `state` reports
  that channel as `cold`, `starting` or `stopping` while it is not live; `active`
  and `idle` still count work on every engine. Clients that compare a
  capability's epoch with the runtime epoch keep working when another engine is
  live.
- The workspace service checks workspace-control liveness for its preheat
  result, post-mutation refreshes and the `acpChannelLive` fields. All four
  constructors (primary, secondary, dynamic and the default `createServeApp`
  Bridge) wire it that way, so a live Managed channel cannot make a failed
  Legacy preheat look successful.
- Daemon status, health and capacity accounting keep aggregate liveness.

### Stopping every live channel

The stop snapshot lists every live channel as
`channels: [{ channelId, runtimeEpoch, executionEngine? }]`, workspace-control
channel first. Blocking reasons are evaluated over all of them, and
`multiple_engine_channels` is removed. The top-level `channelId` is the first
listed channel and `runtimeEpoch` is the newest epoch among the listed
channels, or the last allocated epoch when none is live (that stop is blocked as
`not_live`).

A confirmation stays valid while the stop token, `channelId`, `runtimeEpoch`
and the exact session set are unchanged. Epochs come from one monotonic source,
so a channel started after the preview always raises the newest epoch and
invalidates the confirmation; a replaced workspace-control channel also changes
`channelId`. A stop therefore never reaches a channel or session that was not
in its preview. A channel without sessions that exits after the preview can
leave the confirmation valid, and the stop then has less to do. The request
shape is unchanged.

The stop closes each confirmed session on its own channel, then stops every
listed channel and waits for each child's registry release. The receipt carries
the snapshot's `channelId`, `runtimeEpoch` and `channels`; it reports
`released` only after every release and `stopped` only after every channel was
stopped and released. Sessions torn down because a listed channel exited during
the stop are reported with `cause: "workspace_runtime_stop"`. If a session
close fails while a listed channel is exiting or gone, the receipt waits for
those channels' releases, reports the sessions that remain, and counts as
interrupted every session it tried and every session that no longer exists.
Sessions of surviving channels that the stop had not reached stay live and are
neither interrupted nor closed. Idle timers are cancelled while the stop runs;
when it ends, every listed channel it did not stop returns to the idle policy,
so a surviving channel whose sessions were all closed is reclaimed as usual.

## Files and consumers

| Area                   | Files                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Bridge                 | `channel-lifecycle.ts`, `channel-startup.ts`, `session-control-plane.ts`, `bridgeTypes.ts`                                 |
| Coordinator and wiring | `serve/workspace-runtime-coordinator.ts`, `serve/run-qwen-serve.ts`, `serve/server.ts`, `serve/workspace-service/types.ts` |
| Clients                | SDK daemon stop types, Web Shell blocked-reason labels, `docs/developers/qwen-serve-protocol.md`                           |

No route is added. `GET /workspaces/runtime-stop-options` stays process-global
and `POST /workspaces/:workspace/runtime/stop` stays selected-runtime scoped;
both gain `channels`. `/workspace/runtime/status`, `/workspace/runtime/ensure`
and `/workspace/acp/*` stay primary-runtime scoped, and their
`/workspaces/:workspace/...` forms stay selected-runtime scoped. None falls back
to the primary runtime.

## Validation and acceptance criteria

1. Starting and stopping a Managed channel leaves the workspace-control epoch,
   the workspace status stamps and prepared Legacy MCP/Skills unchanged. A Legacy
   exit with Managed live makes them stale, and the next Legacy channel gets a
   new epoch. Covered on the Bridge and through the workspace runtime routes of
   a real serve app with an injected paired Bridge.
2. With only Managed live, the coordinator defers reconciliation and preheats
   Legacy before preparing capabilities; `/workspace/acp/status` reports no live
   ACP channel, and a failed Legacy preheat is not reported as ready. The
   workspace services of all four constructors use workspace-control liveness.
3. The idle candidate carries its own channel's epoch.
4. A paired stop lists both channels, closes the sessions on both engines, stops
   both children, and reports `stopped` and `released` only after both releases;
   workspace control reports `stopping` meanwhile, as it does while the Legacy
   channel is dying. A channel started after the preview stales the
   confirmation even when the session set is unchanged. When a close fails
   because its channel exited, sessions the stop had not reached on the
   surviving channel stay live and are not counted as interrupted, while
   sessions that die before the receipt settles are. An incomplete stop returns
   a surviving channel without sessions to the idle policy.
5. The workspace-generation stream ignores events from the other engine's
   connection (deferred #12698 coverage).
6. Existing single-factory Bridge lifecycle, status and stop tests pass without
   changes; a CLI stop-route fake only gains the `channels` field its type now
   requires. Each new test fails when its behavior is reverted.

## Risks and open questions

- On a paired runtime with only Managed sessions, the public runtime status
  reports `runtimeLive: false` while those sessions run. Paired mode is not wired
  to any host until B2d.
- A confirmation can survive the exit, after the preview, of a channel without
  sessions. This never widens a stop, but the receipt then lists fewer channels
  than the preview.
- Session-affecting change propagation remains open (B2b part two). Resource
  aggregation, language propagation, Managed preheat/keepalive and quarantine
  recovery are specified in
  [paired engine per-engine operations](./2026-09-26-paired-engine-per-engine-operations.md)
  (B2c).
