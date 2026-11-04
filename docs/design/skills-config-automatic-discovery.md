# Automatic discovery for the Skills configuration catalog

[English](skills-config-automatic-discovery.md) | [简体中文](skills-config-automatic-discovery.zh-CN.md)

## Problem and scope

Issue #15645: after a daemon warms its independent configuration catalog, an
external tool can create a valid project `SKILL.md` that runtime discovery sees
but management cannot. The provider retains its `SkillManager` indefinitely and
only invalidates it after configuration mutations. Settings reload on every
read, but directory discovery does not.

The fix covers both `/workspace/config/skills` (legacy-primary) and
`/workspaces/:workspace/config/skills` (persisted-workspace). Management remains
independent of child and session availability. Applying changes to existing
sessions, runtime fallback policy, extension activation, and core discovery
semantics are outside this change.

## Design

Only the server's two configuration providers enable `autoDiscover`. Other
callers keep their existing behavior. A cold read performs one shared discovery.
A warm read projects the retained manager through freshly loaded settings and
does not await background filesystem work.

Trusted, non-safe catalogs subscribe to project/user directories using chokidar
and the runtime's `watcherIgnored` and `WATCHER_MAX_DEPTH` policy. Subscriptions
are shared by directory within the provider, including user directories shared
by multiple workspaces. Only existing directories are subscribed; a later read or
publication arms newly created roots. Failed watchers retry after 30 seconds,
while read reconciliation remains available. Events debounce for 150 ms and start
background discovery without a GET. An event during a scan queues one further
observation.

Reads also request background reconciliation at most once per second, measured
from task start. This discovers directories created after startup, covers missed
events and watcher failures, and refreshes inert untrusted catalogs without
holding persistent watchers on untrusted workspaces. The one-second interval is
a start throttle, not a guaranteed visibility deadline. An idle catalog whose
change was not watched converges after another read and a successful scan.

Each background observation builds into a fresh temporary manager map. A complete
successful result atomically replaces the retained manager. Failed reads or
incomplete source enumeration preserve the previous inventory. Invalid
project/user manifests are omitted without vetoing unrelated valid changes. Extension discovery errors
remain conservative because the extension loader does not classify their cause.
Core exposes a separate read-failure signal for this distinction; its existing completeness signal and
the snapshot export's strict rejection of incomplete catalogs stay unchanged.
Every warm GET still rereads settings; enable/disable changes do not wait for a
discovery window. The initial discovery retains its existing response semantics.

Background work releases its shared slot after five seconds so a slow filesystem
does not permanently prevent retries. At most two background scans per workspace
generation may remain unsettled: the original scan and one timeout retry. Once
both are occupied, further retries wait for a scan to settle. This does not cancel
underlying I/O. A late
successful observation may publish if its workspace generation is still current
and no newer successful observation has published. Start sequence, not completion
time or wall clock, orders publication. Completion only clears its own slot.
Cold reads wait for actual discovery and do not use this timeout.

## Trust and lifecycle

Safe catalogs remain bundled-only. Effective safe-mode changes discard the
previous manager and subscriptions before answering another read. Inert untrusted
catalogs may read manifests under the existing policy, but never load workspace
settings/extensions or create persistent watchers. Trust replacement invalidates
both providers before runtime draining, even without another configuration read.
Dispatch under a different trust policy invalidates that workspace in the
opposite provider before reading.
No watcher creates directories.

Explicit invalidation advances the existing epoch, drops the manager and active
read/refresh slots, cancels debounce timers, and removes that workspace's watcher
subscriptions. Workspace removal uses this same path. Detached scans cannot
install managers or watchers afterward. Other workspaces keep their subscriptions.

Provider disposal seals all new work before invalidating every workspace,
including cold in-flight reads, and closes the owned watchers. The server
adds this cleanup independently of the owner's replaceable app drain with both
supplied and locally owned lifecycles, preserving ownership of unrelated daemon
resources. The throwaway `snapshot()`
path performs fresh discovery and never starts watchers or background tasks.

## Tradeoffs and attribution

This replaces #15703 and builds on 2SinceJuly's watcher-based direction, failure
cases, and regression scenarios. Core discovery and its existing completeness
consumers remain unchanged; only an additive read-failure signal is introduced.
Its only consumer is the configuration provider's background publication gate.
Fresh background builds scan all enabled levels, including bundled and extension
metadata, rather than introducing partial-cache publication into core. This is
more work per refresh, bounded by the unsettled-scan cap and start throttle; warm reads
remain cache-backed. A hung OS operation is not forcibly cancellable and can
outlive its timeout, but cannot overwrite newer successful observations.

The existing omission of custom `skills.directories` from this provider is not
expanded here. This change does not claim to reconcile every runtime source or
to make an existing session adopt newly discovered skills automatically.

## Validation and acceptance

- Independently reproduce the warmed-catalog defect on the baseline. Attempt the
  global CLI first and record version/API limitations separately.
- On the built daemon, verify external creation, editing, deletion and recreation
  through both configuration routes with no child/session; confirm workspace
  isolation and concurrent readers.
- Verify watcher-driven discovery without reads, missing-directory reconciliation,
  consecutive refresh windows, failed/partial scans, and slow refresh recovery.
- Verify invalidation and disposal during cold discovery and background work,
  late-result ordering, shared subscriptions, and complete cleanup.
- Preserve per-read settings, explicit invalidation, snapshot freshness,
  bundled-only safe mode, and inert untrusted behavior across refresh cycles.
- Run build, bundle, typecheck and focused tests; inspect the complete diff in
  two clean self-audit passes and obtain independent review.

Acceptance requires observed behavior and recorded checks. PR creation or green
CI does not establish deployment or merge.
