# Daemon Multi-Workspace Phase 4b: Channel Workers by Workspace

## Summary

This document designs the channel-worker slice of Phase 4b of issue #6378:
grouping daemon-managed channel workers by workspace. Voice
(`/workspaces/:workspace/voice/stream`) is a separate Phase 4b slice and is out
of scope here.

Today `qwen serve --channel <name>` starts a single channel worker bound to the
primary workspace. In multi-workspace mode the worker must be grouped by the
workspace that owns each channel: each registered, trusted workspace gets its
own worker process bound to that workspace's cwd, `QWEN_DAEMON_WORKSPACE`, and
effective env overlay. The pidfile and daemon status grow an additive
worker-list while preserving the existing single-worker fields. `--channel all`
stays primary-only in v1. Single-workspace behavior is unchanged.

Mapping model: channels are grouped **implicitly by their resolved cwd** — a
channel belongs to the registered workspace its configured cwd resolves to. No
new CLI syntax is added.

## Baseline: current channel-worker seam

- `run-qwen-serve.ts` creates one `ChannelWorkerSupervisor` in the listen
  callback (bound to `boundWorkspace`, the primary) and starts it in
  `completeRuntimeStartup`. `completeRuntimeStartup` is the single convergence
  point across every runtime-start path (the eager `deps.bridge` path and the
  `startRuntime` -> `buildRuntime` path). `deps.bridge` is restricted to a
  single workspace, so multi-workspace always flows through `startRuntime`.
- `commands/channel/daemon-worker.ts` validates its own workspace against
  `capabilities.workspaceCwd` (the primary), so a non-primary worker throws.
  `validateChannelWorkspaces` additionally requires every channel's resolved
  cwd to equal the daemon workspace.
- `config-utils.ts` resolves a channel's cwd as
  `resolvePath(rawConfig.cwd || defaultCwd)`; `loadChannelsConfig(W)` returns
  `loadSettings(W).merged.channels`, which merges system/user/workspace scopes.
- `channel-worker-supervisor.ts` builds the worker env from `{...process.env}`.
  In multi-workspace mode the parent env is the daemon base env (Phase 2a env
  isolation), so it would miss the workspace's own `.env`.
- The pidfile `ServiceInfo` is single-worker (`channels[] / servePid? /
workerPid?`); daemon status `runtime.channelWorker` is a single snapshot.
- The workspace registry (built inside `buildRuntime`) exposes each runtime's
  `env.effectiveEnv`, `trusted`, and canonical `workspaceCwd`. Phase 2a/3
  session routing already targets a runtime by `workspaceCwd`.

## Grouping algorithm

A pure function `resolveChannelWorkspaceGroups` mirrors the worker-side
`validateChannelWorkspaces` and the `config-utils` cwd resolution — otherwise
the serve-layer grouping and the worker's own validation could disagree.
Because `loadChannelsConfig(W)` is merged across scopes, ownership cannot be
decided by "which workspace's merged config contains the name."

For each selected channel `name`, iterate the registered workspaces `W`. If
`name` is in `loadChannelsConfig(W)`, compute
`resolvedCwd = canonicalizeWorkspace(resolvePath(cfg[name].cwd ?? W))`. `W` is a
candidate owner **iff `resolvedCwd === W`** (i.e. the channel would pass
`validateChannelWorkspaces` under `W`):

- explicit `cwd` = a registered path X: only `W === X` satisfies -> owner = X
  (unambiguous).
- no `cwd`, defined only in a workspace's own scope (`/B/.qwen/settings.json`):
  appears only in B's merged config and resolves to B -> owner = B
  (unambiguous).
- no `cwd`, defined in user/system scope: satisfied under every W -> multiple
  owners -> genuinely ambiguous.
- explicit `cwd` = an unregistered path: no W satisfies -> zero owners.

Errors and aggregation:

- zero owners -> `channel_workspace_mismatch` (unconfigured, or cwd points to an
  unregistered workspace).
- more than one owner -> `ambiguous_channel_workspace` (a user/system-scope
  channel with no `cwd`; the operator must scope it to a workspace or add an
  explicit `cwd`).
- owner not trusted -> `untrusted_workspace` (a channel needs to create
  sessions).
- unique trusted owner -> group names by owner -> each group gets
  `{mode:'names', names}`.
- `mode:'all'` -> primary-only: `[{ workspaceCwd: primary, selection:
{mode:'all'} }]`. The primary worker loads primary's merged channels; entries
  whose cwd is not primary keep the existing `validateChannelWorkspaces` error
  behavior.
- single workspace (primary only): `resolvedCwd` can only be primary, producing
  exactly the same single group as today.

A shared cwd helper is used by config parsing and ownership grouping. Explicit
absolute paths and `~/...` keep their existing meaning; ordinary relative paths
resolve against the workspace whose settings are being loaded. The owner path
is then canonicalized, so the serve layer and worker cannot disagree about
ownership.

## Worker identity and env

`CreateChannelWorkerSupervisorOptions` gains an optional `workerBaseEnv`
(default `process.env`). `createWorkerEnv` uses `workerBaseEnv ?? process.env`
as the base; everything else is unchanged (`QWEN_DAEMON_WORKSPACE`, token env
scrubbing, daemon token injection). The group manager passes
`runtime.env.effectiveEnv ?? process.env` — reading the field directly avoids
importing a private helper from `server.ts`, and a parent-process-mode runtime
(single workspace) has `effectiveEnv` undefined, falling back to `process.env`
exactly as today.

## daemon-worker validation fix

`DaemonCapabilitiesLike` gains an optional `workspaces?: Array<{ cwd; id;
primary; trusted }>` (already published by `/capabilities` since Phase 2a). The
validation resolves `daemonWorkspace = canonicalizeWorkspace(opts.workspace)`;
when `capabilities.workspaces` is present it must match one of them and be
trusted, otherwise it falls back to the legacy `== capabilities.workspaceCwd`
check for old single-workspace daemons. Both sides are canonical (the
supervisor passes `runtime.workspaceCwd`), so the comparison is stable. The rest
of the worker (channel config load, `validateChannelWorkspaces`,
`createOrAttach({workspaceCwd})`) already works with multi-workspace routing.

## Supervisor group manager

A thin `ChannelWorkerGroup` owns `Map<workspaceId, ChannelWorkerSupervisor>`:

- built from the resolved groups and the registry; each supervisor is bound to
  its runtime's `workspaceCwd`, selection, and `env.effectiveEnv`, and is
  created through the same injectable factory the single worker uses.
- `start()` launches supervisors sequentially and rolls back those already
  started if a later launch fails. `stop()` waits for any in-flight restart and
  stops every supervisor. `killAllSync()` remains the signal-handler fallback.
- `restart()` is the daemon-wide reload transaction. Concurrent requests
  coalesce; supervisors restart sequentially, and any failure stops the entire
  group to avoid a partially reloaded fleet.
- `snapshots()` returns per-workspace snapshots (`ChannelWorkerSnapshot & {
workspaceId; workspaceCwd; primary }`); `primarySnapshot()` backs the legacy
  single-worker fields.
- any supervisor's `onReady` / `onExit` triggers a full pidfile rewrite from
  `snapshots()` (never an incremental single-entry update — see below).

## pidfile schema and concurrency

`ServiceInfo` gains an optional `workers?: Array<{ workspaceId?; workspaceCwd?;
channels: string[]; workerPid? }>`. The top-level `channels` becomes the union
of all workers' channels, and the top-level `workerPid` stays the primary
worker's pid, so old readers (`qwen channel status`, which only reads
`workerPid` and `channels`) are unaffected.

Concurrency: with N workers, `onReady`/`onExit` callbacks fire concurrently. A
read-modify-write of a single entry would lose updates. Instead the writer takes
the full set of snapshots from the group and performs one synchronous full
rewrite. `writeServeServiceInfo` uses synchronous `openSync`/`writeSync` with no
`await`, so a full-snapshot write is atomic enough — the last write always holds
the complete picture. `writeServeServiceInfo` gains an optional `workers`
parameter written verbatim under the existing `O_RDWR + O_NOFOLLOW` +
serve-ownership guard; `parseServiceInfo` validates `workers?` optionally and
passes it through.

## daemon status schema

`DaemonStatusRuntime` gains an optional `channelWorkers?: Array<
ChannelWorkerSnapshot & { workspaceId; workspaceCwd; primary }>`; the required
`channelWorker` stays as the primary group snapshot for old clients. The getter
(`getChannelWorkerSnapshots`) is threaded from `run-qwen-serve` through
`ServeAppDeps` and `BuildDaemonStatusOptions`, mirroring the existing
`getChannelWorkerSnapshot` path, and is also surfaced in the bootstrap status.
Before the group is created (pre-startup) it reports the disabled snapshot.

## Orchestration and timing

- The single `channelWorker` variable becomes a group manager reference in the
  outer scope so the pidfile writer and shutdown paths still see it.
- Early fail-fast: at listen time (before `buildRuntime`), the pure grouping
  function runs once against `workspaceInputs` + `loadSettings` + boot-frozen
  trust (`getWorkspaceTrustStatus`). Unknown, ambiguous, untrusted, and invalid
  cwd ownership reject startup before a usable handle is exposed. The resolved
  group plan is frozen for the rest of startup; settings are not regrouped
  later under a different filesystem snapshot.
- Actual creation/start moves into `completeRuntimeStartup`: it reads the
  registry from `runtimeApp.locals.workspaceRegistry` (guaranteed present for
  multi-workspace, which always flows through `startRuntime` -> `buildRuntime`),
  builds a supervisor per frozen group, and starts them — replacing the single
  `channelWorker.start()`.
- The newly built runtime app is published and attached to ACP transports before
  channel supervisors start. Workers require the runtime `/capabilities` route
  during bootstrap and may receive channel traffic as soon as they connect, so
  their daemon session routes must already be available. This matches the
  existing single-workspace ordering on `main`; `runtimeReady` still settles
  only after every requested supervisor reaches ready.
- A channel-worker startup failure remains fatal. Runtime publication is
  withdrawn before the group, pidfile, bridges, and listener are torn down; a
  runtime startup timeout during the worker phase follows the same path rather
  than leaving a listening daemon behind. Group cancellation also prevents a
  later workspace supervisor from launching after that teardown starts.
- The pidfile reservation keeps the aggregate channel names; shutdown paths
  (`stopChannelWorkerAfterFailedStartup`, `killAllSync`, normal shutdown) fan
  out to the group.

Regression risk: for a single workspace the creation timing moves from the
listen callback to `completeRuntimeStartup`. Existing `run-qwen-serve.test.ts`
channel tests (injected factory, pidfile-on-ready, second-signal force-kill)
must stay green. Multi-workspace orchestration coverage also probes the live
daemon `/capabilities` route from supervisor startup so the runtime/worker
ordering cannot regress behind an injected ready-only factory.

## Boot behavior

- single workspace: identical to today.
- multi-workspace + `--channel names`: grouped by owner, one worker per trusted
  workspace; zero / multiple owners / untrusted -> a clear boot error (no
  half-enable).
- multi-workspace + `--channel all`: primary worker only, with an stderr note
  that non-primary channels are not hosted.

## Compatibility and limitations

- single workspace is unchanged; old pidfile/status readers keep
  `channels`/`workerPid`/`channelWorker`.
- operator guidance: to host a channel in a non-primary workspace, define it in
  that workspace's own `.qwen/settings.json` (no `cwd` needed) or define it in
  any scope with an explicit `cwd` equal to the workspace path. A user/system
  scope channel with no `cwd` must be disambiguated in multi-workspace mode or
  the daemon boot-errors.
- v1 limitations: ambiguous/same-named channels need a future explicit syntax;
  `--channel all` is primary-only; the single-daemon fault radius covers all
  workspaces' workers; one daemon token covers all workspaces.

## Open questions

- Should ambiguous channels be resolvable via an explicit
  `--channel <workspace>:<name>` syntax instead of boot-erroring?
- Should `--channel all` eventually fan out across all workspaces?

## Out of scope

- voice `/workspaces/:workspace/voice/stream` and per-workspace voice.
- dynamic workspace add/remove (Phase 5).
