# Daemon Workspace Runtime Extensions

[English](daemon-workspace-runtime-extensions.md) | [简体中文](daemon-workspace-runtime-extensions.zh-CN.md)

## Goal

Move Extension management onto workspace-owned runtimes without requiring a
chat session. Keep the existing Extension Store as the durable global owner and
use the selected runtime only for the live catalog and reconciliation.

## Ownership

- `GET /extensions` remains the daemon-local global artifact catalog.
- `GET /workspaces/:workspace/extensions` remains the durable activation
  projection for one workspace.
- `GET /workspaces/:workspace/runtime/extensions` returns the selected live
  runtime catalog and its runtime epoch.
- `WorkspaceRuntimeCoordinator` owns desired/applied Extension generation,
  capability readiness, runtime refresh, and stale-result rejection.
- Global mutations invalidate every managed runtime. Workspace activation and
  resource-state mutations invalidate only the selected runtime.

The coordinator is the only writable owner of runtime Extension readiness.
The route controller continues to own operation history and durable mutation
sequencing, but reports committed generations to each affected coordinator.

## Reconciliation

An Extension commit is successful once the Extension Store commit succeeds.
For each affected trusted live runtime, the coordinator refreshes the bootstrap
configuration, discovery configuration, and active sessions, then reads the
live Extension catalog. It marks the capability ready only when the response
comes from the current runtime epoch and the applied generation equals the
latest desired generation. Cold runtimes remain deferred and converge on the
next `ensureRuntime()`.

Only ensure starts a cold runtime; queued reconciliation rechecks liveness and
never preheats. Applied generation is certified in a particular runtime epoch.
A narrow Skill refresh cannot carry that certification across an epoch change.
An obsolete generation returns `superseded`, not a refresh failure. Deferred
drain work preserves its narrow/full scope; full work takes precedence when
both are pending. A repeated failure re-arms the retry cooldown.

The physical refresh has the same five-minute budget as MCP controls because
it includes MCP discovery. The shorter ensure observation deadline does not
cancel that refresh; a later successful result can still certify readiness.
Hard timeouts retain the bridge's channel-retirement policy.

Observing a new generation invalidates retained Skill snapshots even while the
runtime is cold. Projection generation equality alone is not readiness: use
the current epoch and the coordinator capability state. Restore of a lower
store generation is supported by the poller's fresh authoritative read: it
invalidates applied certification and advances the coordinator revision. A
read overtaken by another observed mutation cannot lower the generation;
operation receipts alone never lower it.

Extension invalidation also invalidates the selected runtime's Skills and MCP
capabilities because both catalogs include Extension contributions. A late
refresh or catalog response from a replaced runtime cannot advance readiness.

## API and SDK

Runtime status adds an `extensions` capability with `state`, `revision`,
`runtimeEpoch`, `desiredGeneration`, and `appliedGeneration`. Extension runtime
catalog responses add `runtimeEpoch`.

`WorkspaceDaemonClient` exposes the runtime catalog. Global install, update,
uninstall, update-check, and default activation remain on `DaemonClient`;
workspace activation, Extension Skill state, projection reads, and runtime
catalog reads remain on `WorkspaceDaemonClient`.

Source installs use the V2 global route. Archive uploads remain on the legacy
workspace route until a V2 archive endpoint exists, so they retain the legacy
default-activation behavior.

Interactive installs and updates share the existing operation interaction
endpoint under `/workspace/extensions/operations`. Their preparation deadline
cancels pending input. Prepared resources remain owned by the route until its
`finally` disposal, including when the deadline prevents commit.

## Web Shell

When the daemon advertises `workspace_extensions_config_runtime`, the
Extensions page:

1. loads the global catalog and selected workspace projection without starting
   ACP;
2. calls the shared parameterless runtime ensure;
3. merges live details and `isActive` when the durable catalog generation and
   coordinator are available, the runtime catalog is initialized, and capability
   and catalog epochs match the coordinator epoch. Readiness and matching
   desired/applied generations on the capability and activation projection
   determine whether to re-read the catalog and projection, not whether to
   retain matching-epoch live rows;
4. shows the workspace selector on the list page and the disabled selector in
   detail view.

Older daemons keep the existing primary-workspace flow.

When both the workspace activation projection and live activation state are
unavailable, list and detail badges show unknown, not the global default.

When the daemon also advertises `workspace_extension_mentions`, the composer
uses the selected workspace runtime for both the `+` and `@` Extension menus.
Without that feature, it keeps the legacy primary-workspace loader.

Notice attribution and the in-flight lock are distinct: an unknown or absent
Extension name falls back to the global notice surface without releasing the
active operation's lock.

## Verification

Cover cold/queued-cold runtimes, superseded generations, runtime replacement,
same-epoch narrow refresh, drain replay, repeated failure cooldown, retained
Skills invalidation, expired interactive preparation, and recovered notices.
Run the existing local-install integration test without starting an ACP child.

## Downstream consumers

- runtime status and workspace management routes;
- Extension V2 operation reconciliation and external-generation polling;
- Skills and MCP capability invalidation;
- TypeScript daemon SDK;
- Web Shell Plugin manager and Extensions manager.
