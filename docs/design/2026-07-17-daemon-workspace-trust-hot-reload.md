# Daemon Workspace Trust Hot Reload

## Status

Implemented for QwenLM/qwen-code#6378.

## Problem

The daemon currently evaluates workspace trust while constructing a
`WorkspaceRuntime`. `GET /workspace/trust` reports that snapshot and
`POST /workspace/trust/request` only publishes `trust_change_requested`.
Changing `trustedFolders.json`, IDE trust, or the user/system folder-trust
setting does not rebuild the runtime, so settings, environment, filesystem,
ACP sessions, MCP, extensions, channel workers, and scheduled work remain on
the old trust boundary until the daemon restarts.

Trust cannot be updated in place. The filesystem factory, bridge, settings,
environment, ACP mount, and several workspace-scoped managers capture their
runtime inputs during construction.

## Security invariants

1. A trust decrease closes the affected runtime generation guard before the
   first asynchronous drain step. No new privileged side effect may begin
   after that point.
2. A closed generation guard never reopens. A replacement receives a new
   guard and monotonically increasing generation id.
3. A failed revoke never restores the previous trusted runtime.
4. Malformed or unreadable system/user settings fail closed. A malformed or
   unreadable trusted-folders file fails closed when file trust is needed, but
   is irrelevant when folder trust is disabled or IDE trust has already
   resolved the primary workspace.
5. Transitioning, blocked, and stale session owners never fall back to the
   primary runtime.
6. Every runtime activation path validates the policy revision immediately
   before publication.

## Trust policy

The daemon uses a side-effect-free policy loader that reads only system
overrides, user settings, system defaults, IDE trust, and
`trustedFolders.json`. Workspace settings and project environment files are
excluded from policy evaluation. Existing trust-rule precedence and
path-comparison behavior are preserved.

The loader produces an immutable semantic snapshot. A workspace materializes
that snapshot into an operational trust boolean and an allowed-root list.
Only a materialization change rebuilds a runtime. Source-only changes advance
the applied policy revision without a rebuild.

The primary filesystem keeps the existing trusted IDE multi-root behavior.
When a secondary root is removed from the primary allowed-root list, both the
secondary and primary generations are closed before either is drained.

The monitor re-reads the policy inputs once per second and publishes only when
their semantic hash changes. IDE and same-process trusted-folder writes also
trigger an immediate read. `/workspace/reload` and dynamic workspace
registration request a reconciliation explicitly.

Trusted-folder writes acquire `proper-lockfile`, re-read under the lock,
preserve comments, and atomically replace a regular 0600 file without following
symlinks. A malformed file is not silently rewritten.

## Runtime ownership

The registry owns stable `WorkspaceEntry` objects. An active entry refers to
one immutable `RuntimeGeneration`, which owns the runtime and its generation
guard. Workspace identity, persistent registration metadata, and applied
policy state live on the entry, not the generation. Runtime construction and
cleanup remain coordinated by the daemon host.

Workspace-qualified data-plane routes resolve their runtime at request time.
Primary routes that retain process-wide paths use live delegates for the
current runtime. Privileged REST mutations capture the generation guard and
recheck it at their commit boundary. ACP, Voice, channel workers, and session
admission use their existing drain mechanisms. Trust status and daemon
inventory read stable entries without acquiring a runtime.

The session-owner index is generation-aware. Session creation and restoration
register ownership explicitly, and runtime replacement invalidates old
ownership. The existing active-bridge scan remains as a compatibility repair
path for sessions that predate indexing.

Runtime cleanup shuts down the bridge and child channels, Voice state,
sub-sessions, ACP mounts, channel workers, scheduled keepalive, and git state.
Managers owned by the replacement runtime are rebuilt with fresh settings,
environment, filesystem, trust, policy, and cache inputs. Shared path locks and
process telemetry survive replacement because they carry no workspace
capability.

## Reconciliation

Trust reconciliation and runtime publication share one daemon topology gate;
workspace add and reload request reconciliation through that gate after their
own operation. Trust snapshots are coalesced so the latest observed revision
is applied before the caller is released. Shutdown stops the monitor and waits
for the topology gate before taking its cleanup snapshot.

For a trust decrease, the controller synchronously closes every affected
generation before the first asynchronous drain, closes admission paths,
disposes the old runtime, builds a fresh runtime, rechecks the policy revision,
and installs the new entry generation and ACP mount. Existing bridge and ACP
shutdown paths provide bounded or forceful cleanup. A stale candidate is
disposed and rebuilt.

A grant uses the same destructive replacement. If it fails, the controller
attempts a new untrusted runtime and reports the configured revision as failed
until a later reconciliation succeeds. If runtime containment cannot be
confirmed, the entry remains blocked and deep health is degraded; other
workspaces remain available.

## Protocol

The request-only endpoint remains request-only. Trust status v1 remains the
default compatibility view. Clients request v2 with `statusVersion=2`; old
servers may return v1. V2 separates configured policy from effective runtime
state and reports `stable`, `applying`, or `failed`, an opaque revision, and a
stable error code. The daemon advertises `workspace_trust_hot_reload` only
after primary and secondary routing use generation-aware resolution.

No reliable applied-event bus is introduced. GET status is the source of
truth. A trust-change request requires an active generation to publish the
existing event; otherwise it returns a retryable 503.

## Non-goals

- Direct remote trust approval.
- Zero-downtime dual runtimes or session migration.
- Public generation identifiers.
- Parallel runtime rebuilds.
- Rebuilding the complete Express application.
- Changing standalone CLI trust semantics.
