# Daemon Workspace Runtime Removal

## Context

Runtime workspace registration and persistent registration are already available, but forgetting a persistent registration does not unload the live bridge, ACP mount, session admission state, or memory lane. This design adds synchronous hot removal for secondary runtimes while preserving the existing registration-forget API.

## Scope and invariants

- Only dynamically registered and persistence-restored secondary runtimes are removable. The primary and every `--workspace` runtime are static.
- `DELETE /workspaces/:workspace` removes the runtime and all known persistent aliases. It never removes workspace files, settings, transcripts, archives, or other project data.
- Non-force removal is observational: if the frozen runtime has activity, every gate is rolled back and the request returns `409 workspace_busy`. Force removal terminates that activity.
- Persistence is committed before destructive cleanup. A store failure restores the active runtime. Cleanup failures after the store commit cannot roll the operation back and use synchronous bridge kill as a fallback.
- A removed cwd remains reserved until cleanup completes, then may be registered again with a fresh bridge, ACP dispatcher, connection registry, and memory lane.

## Protocol

Production daemons advertise `workspace_runtime_removal` when the removal controller is installed. Capability workspace rows add optional `removable`; old clients and daemons remain compatible.

`DELETE /workspaces/:workspace` uses the existing workspace-id-or-canonical-cwd selector and accepts an optional JSON body containing a boolean `force`. Success returns the removed identity, whether force was requested, whether any persistent alias was removed, and the frozen activity snapshot. Existing `DELETE /workspace-registrations/:id` remains forget-only.

## Lifecycle

The registry tracks active, draining, and removed runtimes. Public resolution sees only active runtimes; management resolution retains draining runtimes for conflict reporting and cwd reservation.

Removal first takes a fast activity snapshot. It then synchronously marks the registry draining, closes per-workspace session admission, and drains the ACP mount and memory lane. The final snapshot reads pending session reservations before live bridge counts so a reservation-to-session transition cannot appear idle. A busy non-force request reverses the gates. Otherwise all known registration IDs are deleted atomically, queued memory work is failed, the sub-session launcher and bridge are stopped, the ACP mount is disposed, ownership indexes are cleared, and the registry entry is completed.

Runtime cleanup is memoized by runtime identity, not cwd, so a later runtime registered at the same path cannot reuse an old cleanup promise. Daemon shutdown seals management operations, waits for them to converge, stops launchers, and then uses the same bridge teardown path for the remaining managed runtimes.

## Persistence identity

Restoration records the ID of each raw stored path before canonicalization. Multiple raw aliases that resolve to one runtime are retained as one ID set, including aliases shadowed by an explicit startup workspace. Removal deletes that set plus the canonical registration ID under one store lock without changing the schema.

## UI

The Web Shell exposes removal only when both the feature tag and `removable: true` are present. The action remains available for untrusted workspaces. The first confirmation performs a non-force request; `workspace_busy` renders the activity counts and offers force removal. Force is disabled when the current session belongs to the target workspace. Success reconciles capabilities and session lists and falls back to the primary workspace when necessary.

## Failure and compatibility analysis

Client disconnects and SDK timeouts do not cancel server-side cleanup. Concurrent add, persistence promotion, and remove operations are serialized per canonical cwd. Shutdown rejects new management operations with `daemon_shutting_down` and waits for already-started work. Old clients ignore the optional capability field and feature; old daemons continue to produce a normal `DaemonHttpError` for the missing route.

The workspace-scoped channel worker group supplies activity and teardown through a thin adapter. Draining blocks reload and webhook routing for the target workspace; committed removal stops and unregisters only that worker so daemon status and pidfile metadata converge without affecting other workspaces.

## Verification

Unit coverage targets registry state transitions and owner cleanup, admission drain rollback, alias batch deletion, busy/force/store-failure route behavior, bridge shutdown reason idempotence, memory-lane cancellation, SDK request encoding, and Web Shell feature and force guards. The E2E plan lives at `.qwen/e2e-tests/workspace-runtime-removal.md`.
