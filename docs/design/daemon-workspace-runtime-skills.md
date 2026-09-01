# Daemon Workspace Runtime Skills

## Goal

Make Skills management workspace-aware without requiring a chat session and
without exposing the daemon's internal snapshot cache as API state.

## Ownership

- `config/skills` is the daemon-local, durable inventory. Reading it does not
  start or query ACP.
- `runtime/skills` is the catalog returned by the selected live workspace
  runtime. It carries the runtime epoch that produced it.
- The workspace runtime coordinator owns runtime preparation and reconciliation.
  Its Skills capability reports `state`, `revision`, and `runtimeEpoch`.
- User-global mutations use the singular workspace route and reconcile every
  trusted managed runtime. Project mutations and toggles use a qualified
  workspace route and reconcile only that runtime.

## Freshness

Consumers may merge runtime-only Skills only when the Skills capability is
`ready` and both the capability and catalog epochs equal the current runtime
epoch. Otherwise they use the config inventory. A revision orders mutations
within one daemon process; it is not durable and consumers do not persist it.

The existing daemon snapshot cache remains an implementation detail. No public
cache/source state is added.

## Web Shell

When `workspace_skills_config_runtime` is advertised, the Skills page loads
config first, then ensures and reads the selected runtime in the background.
With multiple registered workspaces it shows a workspace selector on the list
page and the same disabled selector on the detail page. Without the feature it
keeps the legacy primary-workspace routes and does not ensure a runtime.
Runtime-only Extension Skills are visible but not managed through config routes.

The new-session composer and deferred session bootstrap gate their split read
on the `workspace_skills_config_runtime` feature. They show the selected
workspace's config Skills immediately, then replace them with a current-epoch
runtime catalog after ensuring that runtime. Other consumers do not use this
feature.

## Compatibility

Legacy Skills routes keep their synchronous refresh behavior. New config routes
disable that legacy refresh and delegate exactly one runtime reconciliation to
the coordinator.
