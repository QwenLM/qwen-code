# Extension Management V2

## Status

This design extends daemon protocol `v1` under the additive
`extension_management_v2` capability. The already-published
`workspace_extensions` capability and `/workspace/extensions/*` routes remain
available as a primary-workspace compatibility adapter.

## Resource model

An installed extension is one user-level artifact in `QWEN_HOME/extensions`.
Activation is policy, not a second copy of that artifact:

1. An exact workspace override (`enabled` or `disabled`).
2. An internal exact `inherit` mask created while migrating legacy path rules.
3. An ordered V1 path rule.
4. The global default.

Workspace identity uses the daemon's canonical workspace path. A workspace
route selects an existing runtime by workspace id first and canonical cwd
second. Reads are allowed for untrusted runtimes; activation changes, refresh,
and workspace-scoped install require a trusted target. Global mutation uses the
normal daemon mutation authentication and install consent, not the trust state
of whichever workspace initiated the request.

## Store and transaction boundary

`ExtensionStore` is the only writer of final extension directories and V2
activation state. `ExtensionManager` remains the workspace-facing facade, but
CLI, TUI, auto-update, daemon, and SDK-backed operations delegate mutations to
the store.

The layout is:

```text
~/.qwen/
├── extensions/
└── extension-store/
    ├── lock
    ├── state.json
    ├── state.previous.json
    ├── staging/
    ├── rollback/
    └── transactions/
```

The store and artifacts share a filesystem so artifact swaps are directory
renames. An in-process mutex and a `proper-lockfile` lock serialize commits
across all V2-aware processes. Every mutation re-reads state while holding the
lock and increments a monotonic generation, preventing lost updates.

Install/update preparation happens outside the final artifact directory. The
commit writes a `prepared` journal, moves the old artifact to rollback, moves
staging into place, and atomically writes `state.json`. That state rename is the
commit point. Before it, recovery rolls back; after it, recovery only completes
projection and cleanup. A committed policy is never rolled back because one
runtime refresh failed.

Store files use owner-only permissions and atomic no-follow writes. Extension
ids, direct-child artifact paths, transaction paths, and names are validated.
Failures are reported with credential-redacted sources.

## V1 migration and downgrade projection

The first V2-aware process imports ordered rules from
`extension-enablement.json` without materializing the current set of registered
workspaces as exact overrides. V2 writes a compatible projection after each
state commit and stores its hash in `state.json`.

If hashes differ, modification order decides the recovery direction: an older
projection is repaired from authoritative V2 state; a projection modified after
V2 state is treated as a sequential write by a downgraded binary and is
re-imported with a new generation. Concurrent V1 and V2 writers sharing one
`QWEN_HOME` are intentionally unsupported.

Clearing a public workspace override normally deletes the exact record. If an
older path rule would then change the effective value, the store writes an
internal `inherit` mask so DELETE still means “inherit the global default.”

## Daemon API

The global surface is:

```text
GET    /extensions
POST   /extensions/install
POST   /extensions/check-updates
POST   /extensions/:extensionId/update
DELETE /extensions/:extensionId
PUT    /extensions/:extensionId/activation
GET    /extensions/operations/:operationId
```

Install requires explicit consent and initial activation:

```ts
type InitialActivation =
  | { scope: 'user' }
  | { scope: 'workspace'; workspaceId: string };
```

The daemon install endpoint accepts Git, GitHub Release, and npm sources.
Local/link remains a local CLI feature. Update preserves the extension id,
manifest name, settings, and activation policy. “Already current” is a
successful `updated: false` result. Uninstall is idempotent and removes both the
artifact and policy.

The workspace projection is:

```text
GET    /workspaces/:workspace/extensions
PUT    /workspaces/:workspace/extensions/:extensionId/activation
DELETE /workspaces/:workspace/extensions/:extensionId/activation
POST   /workspaces/:workspace/extensions/refresh
```

It intentionally has no workspace artifact mutation routes. Projection entries
include default, exact workspace value, effective value, and source. Desired
generation and locally applied generation are top-level response fields.

Potentially slow mutations return `202`, `Location`, and `Retry-After`. The
operation record is daemon-local memory, retains at most 100 terminal records,
and can disappear on restart. Catalog/store recovery is authoritative. SDK
polling timeout stops polling only; it never cancels accepted work.

The daemon admits at most 10 unfinished extension operations. A daemon-wide
FIFO preparation queue runs at most two downloads, extractions, conversions,
or single-extension update checks at once. Install and update use an explicit
`prepare -> commit/dispose` lifecycle: preparation owns only staging files and
does not change the store, cache, or runtime. Prepared mutations enter a
separate single-concurrency FIFO commit queue in the order preparation
finishes. Activation and uninstall enter only the commit queue; check-updates
enters only the preparation queue. Manual refresh is serialized through the
commit queue. The commit lane is released after the store commit and settings
commit; extension reload, manager runtime refresh, prepared-file cleanup, and
daemon runtime reconciliation run outside it. These post-commit steps do not
occupy either slot, so later commits may proceed while an earlier generation is
being applied or cleaned up.

The preparation deadline starts when an operation first acquires a preparation
slot, not while it waits. Abort is propagated to network operations. A started
task continues to occupy its slot until its underlying promise settles even if
it ignores abort. Commit is not cancellable. Prepared updates carry the target
artifact generation: unrelated extension or activation changes safely rebase,
while a stale update of the same artifact fails with `extension_conflict`.

## Runtime reconciliation

A successful commit invalidates local status and refreshes affected runtimes.
Global artifact/default changes reconcile all runtimes in this daemon; an exact
workspace override reconciles only its target. Per-workspace generation
coalescing means applying generation N also satisfies waiters for older
generations; a late lower-generation refresh therefore cannot move the applied
generation backwards. Partial refresh failure or post-commit reload/cleanup
failure produces `succeeded_with_warnings` with workspace-specific or commit
diagnostics, without rolling back the artifact.

The extension file watcher observes only `extension-store/state.json` for
policy generation and continues to observe installed/linked extension content
for command, skill, agent, hook, and MCP changes. A 30-second generation poll
repairs missed filesystem events and bounds convergence for other daemons that
share the store.

## Compatibility

`workspace_extensions` remains the capability for the existing singular
surface. Its handlers call the same manager/coordinator and adapt responses:
project activation becomes a primary workspace override; user activation keeps
the legacy rule-clearing behavior; global mutation reconciles every local
runtime. The legacy operation endpoint maps V2 warning completion back to the
published legacy refresh-error status.

Clients must check `extension_management_v2`; neither daemon mode nor another
workspace capability implies this API. The abandoned
`workspace_qualified_extensions` proposal is not part of the protocol.

## Non-goals

- Per-workspace artifact copies.
- A daemon registry or remote acknowledgement protocol.
- User cancellation of accepted operations.
- Concurrent old-binary and V2-aware writes to one `QWEN_HOME`.
- Removing the V1 adapter before a future protocol-v2 migration.
