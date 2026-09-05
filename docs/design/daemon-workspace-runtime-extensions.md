# Daemon Workspace Runtime Extensions

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

## Web Shell

When the daemon advertises `workspace_extensions_config_runtime`, the
Extensions page:

1. loads the global catalog and selected workspace projection without starting
   ACP;
2. calls the shared parameterless runtime ensure;
3. merges live details and `isActive` only when capability and catalog epochs
   match the current runtime and applied generation equals desired generation;
4. shows the workspace selector on the list page and the disabled selector in
   detail view.

Older daemons keep the existing primary-workspace flow.

When the daemon also advertises `workspace_extension_mentions`, the composer
uses the selected workspace runtime for both the `+` and `@` Extension menus.
Without that feature, it keeps the legacy primary-workspace loader.

## Downstream consumers

- runtime status and workspace management routes;
- Extension V2 operation reconciliation and external-generation polling;
- Skills and MCP capability invalidation;
- TypeScript daemon SDK;
- Web Shell Plugin manager and Extensions manager.
