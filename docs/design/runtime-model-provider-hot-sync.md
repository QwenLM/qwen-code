# Runtime model-provider hot sync

## Problem

The daemon currently has four relevant copies of model-provider state:

1. persisted user and workspace settings;
2. the parent daemon's environment snapshot used for future ACP children;
3. the live ACP child's loaded settings and environment;
4. each live Session's `ModelRegistry` and per-model generator cache.

Provider installation and model deletion update the first copy. The Web Shell
provider list also reads that copy directly, so a newly added model is visible
before the live Session can resolve its ACP model route. Restarting the daemon
works only because it reconstructs the other three copies from disk.

## Ownership and synchronization

Settings remain the durable source of truth. A provider mutation synchronizes
the other copies after persistence, in this order:

1. rebuild the parent runtime environment used by future ACP children;
2. ask the current workspace ACP child to reload its settings and environment;
3. reload the bootstrap, initializing, and live Session Config registries;
4. clear per-model generator caches for future model-specific calls.

The child command is workspace-global within one ACP channel. The existing
unqualified provider-install and model-delete routes remain legacy-primary for
request ownership, trust, and persistence. After persistence, a workspace-owned
provider registry synchronizes only the primary workspace's live runtime, while
a user-owned registry synchronizes every active runtime because the same user
settings feed all of them. The primary generation is resolved at invocation
time so a trust replacement cannot redirect work to the daemon's startup
generation. Transitioning and draining generations are excluded; their
replacement or next child reads the persisted settings. The internal command
remains workspace-scoped so a future qualified mutation route can reuse it
without falling back to the primary runtime.

Secondary runtimes rebuild only their runtime-local child-spawn environment
snapshot. They do not apply their workspace overlays to the daemon's global
`process.env`, which remains owned by the primary runtime.

The command reads settings from disk. Provider configurations and API keys are
not copied into ACP request parameters, events, or response bodies.

The internal contract is
`qwen/control/workspace/model-providers/reload` with request `{ cwd }`. Its
response contains only `configsRefreshed` and `configsFailed`; it never returns
environment values, Config identifiers, or raw exceptions.

## Session semantics

Provider reload does not switch a Session's current model, refresh its current
authentication, or run the broader workspace reload path. Clearing a
per-model generator cache affects only future lookups; a generator already
held by an active turn continues running.

Each Config reloads both `modelProviders` and `providerProtocol`. The reload
clears its per-model generator cache but does not replace its current
`ContentGenerator`.

Reload is not gated on Session idleness. Each live Session also refreshes its
own `LoadedSettings`, so a later model-selection write resolves its persistence
scope from current settings. A final refresh before Session publication closes
the race where provider mutation overlaps asynchronous Session construction.
Because an unpublished Session has no active turn to preserve, that final step
also reloads its environment and, when provider state changed during creation,
rebuilds its current generator. If another child reload interleaves with the
asynchronous generator rebuild, the final refresh repeats before the Session is
published. Provisional Sessions defer the same authentication rebuild to
workspace activation.
Activation atomically re-reads the provisional Session's own user and workspace
settings before applying its environment, so a Session that waited while the
settings cache advanced cannot restore a creation-time env snapshot. If that
read fails, activation leaves the current process environment unchanged.

Deleting a model removes it from future route resolution but does not force an
already-running Session away from its current generator.

## Failure semantics

Provider persistence is not rolled back when runtime synchronization fails.
Mutation responses report one of three additive states:

- `applied`: every targeted parent environment was refreshed and every live
  targeted child synchronized; targets without a live child are already ready
  for their next child;
- `deferred`: no targeted child is live, and every next child will load the
  persisted state;
- `failed`: persistence succeeded, but some targeted runtime state could not be
  updated.

An environment snapshot rebuild or env-file read failure counts as an
incomplete parent refresh and therefore returns `failed`, even if the live ACP
child reload succeeds.

The same fail-closed environment helper also backs the existing full workspace
reload. Its response and `settings_reloaded` event therefore expose the
additive optional `runtimeEnvironmentApplied` boolean; `false` means the child
reload may have succeeded while the parent spawn environment was deliberately
left unchanged.

If the child cannot reload either settings scope from disk, it does not apply
the stale in-memory provider registry and reports a failed child refresh.
During Session publication, the same read failure is fail-closed only when the
provider revision advanced during construction; otherwise the Session keeps
its already loaded settings so an unrelated malformed file does not block all
new and restored Sessions.

`failed` is returned as a successful mutation with a user-facing warning. A
workspace generation closing during the operation keeps its existing 503
lifecycle behavior. Per-Config failures are isolated so one damaged Session
does not prevent healthy Sessions from refreshing.

## Alternatives rejected

- Full `workspaceReload` changes unrelated tools, memory, auth, model defaults,
  and system instructions, and skips busy Sessions.
- Reloading lazily only after an unknown model route leaves deletion and other
  registry consumers stale and adds disk/environment mutation to model switch.
- A settings file watcher expands lifecycle and concurrency scope beyond the
  two explicit provider mutation routes.
