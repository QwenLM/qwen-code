# Phase 2a Multi-Workspace Sessions Foundation

## Summary

This document records the multi-workspace sessions contract for issue #6378
after the Phase 1 `WorkspaceRegistry` PR, the Phase 2a foundation PR, and the
first Phase 2b route-expansion PR. Phase 2a was split into two implementation
PRs: PR 1 landed env isolation and total-admission guardrails while
multi-workspace remained gated; PR 2 wired non-primary live session dispatch
and published the additive capabilities/status schema. Phase 2b PR 1 adds a
session owner index and expands the sessions-only route surface without moving
file, memory, MCP, settings, voice, channel workers, ACP, or SDK workspace
clients.

The multi-workspace work remains sessions-only. Phase 2a did not add plural
routes, a `WorkspaceDaemonClient`, workspace-qualified ACP/WebSocket, file,
memory, MCP, settings, voice, or channel-worker migration. Phase 2b PR 1 adds
only the plural session-list alias described below; it still does not add
workspace client APIs or migrate non-session surfaces. PR 1 did not add
capabilities `workspaces[]`, `multi_workspace_sessions`, route dispatch, or
non-primary runtime construction.

## Foundation Contract

- `--workspace` is repeatable at the CLI parser layer so yargs preserves array
  input instead of collapsing it.
- The serve fast path falls back to the full parser when repeated workspace
  values are present.
- A single-item workspace array is treated as the primary workspace and keeps
  the existing single-workspace behavior.
- PR 1 kept multiple explicit workspaces gated before runtime boot.
- PR 2 accepts distinct non-nested explicit workspaces for sessions-only
  multi-workspace mode.
- Duplicate canonical workspace inputs still fail explicitly.
- Nested workspace inputs still fail explicitly.
- The first explicit workspace is the primary workspace and remains mirrored by
  legacy `workspaceCwd` / `app.locals.boundWorkspace` compatibility fields.

The internal `WorkspaceRuntime` contract now carries stable metadata for later
Phase 2a work:

- `workspaceId`: stable hash of the canonical workspace cwd.
- `workspaceCwd`: canonical workspace cwd.
- `primary`: true for the primary runtime.
- `trusted`: boot-time trust metadata; direct `createServeApp` fallback remains
  false unless production passes an explicit trusted value.
- `env`: runtime-local env source metadata. In single-workspace production,
  the primary runtime now receives a computed effective env snapshot and a
  mutable env source that can be refreshed after daemon env reload. Direct
  `createServeApp` fallback remains parent-process metadata.

The internal `WorkspaceRegistry` supports exact cwd lookup, exact id lookup,
`resolveWorkspaceCwd(undefined)` primary fallback, and live session owner
resolution. Live owner resolution scans runtime bridge summaries only; it does
not scan persisted storage, create children, or route any request yet. Duplicate
live owners fail closed as an ambiguous result.

`createServeApp` may accept an injected registry for tests and future assembly.
The foundation PR kept route modules on primary-runtime inputs; PR 2 extends
only the live session, SSE, and session-permission route wiring with the
registry needed for owner dispatch. Existing legacy `app.locals.boundWorkspace`
and `app.locals.fsFactory` remain primary-only compatibility locals.

## Phase 2a Route Classification

The first ungated Phase 2a milestone must classify all `/session/:id/*` routes
before enabling multiple explicit workspaces.

Phase 2a-dispatched routes:

- `POST /session`
- `GET /session/:id/events`
- `POST /session/:id/prompt`
- `POST /session/:id/cancel`
- `POST /session/:id/permission/:requestId`
- `POST /session/:id/heartbeat`
- `POST /session/:id/detach`
- `GET /session/:id/pending-prompts`
- `DELETE /session/:id/pending-prompts/:promptId`
- `DELETE /session/:id`
- `GET /session/:id/status`

Phase 2b-dispatched additions:

- `POST /session/:id/load`
- `POST /session/:id/resume`
- `GET /session/:id/context`
- `GET /session/:id/context-usage`
- `GET /session/:id/stats`
- `GET /session/:id/supported-commands`
- `GET /session/:id/tasks`
- `GET /session/:id/lsp`
- `GET /session/:id/hooks`
- `GET /session/:id/artifacts`

Later or primary-only routes:

- `GET /session/:id/export`
- `POST /sessions/delete`
- `POST /sessions/archive`
- `POST /sessions/unarchive`
- `PATCH /session/:id/organization`
- session-group mutations
- branch, fork, cd, rewind, shell, model, and language session mutations
- non-session `POST /permission/:requestId`
- `/acp`

## Phase 2a Cross-PR Requirements

- Keep scan misses as `404 session_not_found`; never fall back to primary.
- Fail closed if more than one runtime reports the same live session id.
- Keep non-primary persisted session listing gated until restore ownership,
  trust checks, and active-session discovery are implemented together.
- Reuse PR 1 runtime-local env overlays before non-primary child spawn.
- Reuse PR 1 `maxTotalSessions` admission at every future fresh-creation seam
  so REST and primary `/acp` cannot bypass it, while attach still bypasses
  admission.
- PR 2 publishes `workspaces[]` and `multi_workspace_sessions` only after the
  live session dispatch loop is complete.
- PR 2 updates SDK capability types for the additive capabilities schema, but
  Phase 2a still does not add a workspace client.

## PR 1 Guardrails

- Runtime env is computed from daemon base env plus workspace `.env`, settings
  env, and Cloud Shell defaults without mutating parent `process.env` during
  runtime initialization.
- The env helper intentionally does not virtualize `QWEN_HOME`, Storage, or
  global config routing. Those remain daemon boot/base-env responsibilities.
- ACP child spawn accepts an explicit `sourceEnv`, and low-cost
  workspace-scoped status/config readers use injected env instead of direct
  `process.env` reads.
- `maxTotalSessions` is an optional daemon-wide fresh-session cap. It covers
  spawn, persisted load/resume restore, and branch/fork session creation;
  attach bypasses it. In multi-workspace mode, when the operator leaves it
  unset and the per-workspace `maxSessions` cap is finite, PR 2 derives the
  effective total cap as `maxSessionsPerWorkspace * workspaceCount`; single
  workspace mode keeps the historical unlimited total default.
- The bridge admission seam is a synchronous reservation hook. Failed fresh
  creation releases the reservation, preventing concurrent oversell across
  runtimes once non-primary bridges exist.
- `/daemon/status.limits.maxTotalSessions` is additive. `/capabilities` and SDK
  capability types remain unchanged until PR 2 ungates multi-workspace
  sessions.

## PR 2 Sessions Closed Loop

PR 2 removes the explicit multi-workspace boot gate for sessions-only daemon
mode. Multiple explicit `--workspace` values now create one runtime per
canonical workspace, with the first workspace as primary. Duplicate and nested
workspace inputs remain boot errors because they make session ownership
ambiguous before any route-level dispatch can safely resolve a request.

The production assembly keeps the existing primary runtime responsibilities:
daemon identity, log identity, telemetry service id, Web Shell, `/acp`, file,
memory, MCP, settings, voice, channel worker, and legacy workspace-less REST
routes remain primary-only. Non-primary runtimes are bridge/workspace-service
runtimes for live REST sessions only. Their ACP child is still lazy: the bridge
object exists at boot, but no non-primary child is spawned until a trusted
`POST /session { cwd }` request needs a fresh session.

Session creation resolves `cwd` through `WorkspaceRegistry` exact canonical cwd
matching. Omitted `cwd` resolves to the primary runtime. Unknown `cwd` returns
`400 workspace_mismatch`; untrusted non-primary `cwd` returns
`403 untrusted_workspace`; trusted registered runtimes call that runtime's
bridge with its own canonical cwd. This intentionally avoids prefix matching,
nearest-parent matching, or persisted-storage lookup in Phase 2a.

The dispatched live-session routes resolve owner runtime by scanning live bridge
summaries through `WorkspaceRegistry.resolveLiveSessionOwner(sessionId)`.
`not_found` maps to `404 session_not_found`, and `ambiguous` maps to a
fail-closed server error. The scan is synchronous and live-only; it never
spawns a child and never treats a miss as primary fallback. The dispatched
route set is exactly:

- `GET /session/:id/events`
- `POST /session/:id/prompt`
- `POST /session/:id/cancel`
- `POST /session/:id/permission/:requestId`
- `POST /session/:id/heartbeat`
- `POST /session/:id/detach`
- `GET /session/:id/pending-prompts`
- `DELETE /session/:id/pending-prompts/:promptId`
- `DELETE /session/:id`
- `GET /session/:id/status`

`GET /workspace/:id/sessions` resolves by exact workspace id first and exact
canonical cwd second. Primary keeps the existing persisted/live merge and
organized view behavior. Non-primary returns live sessions only, rejects
`archiveState=archived`, and rejects organized/group queries because those are
persisted/organization-backed surfaces reserved for later phases.

`/capabilities` remains backward-compatible: `workspaceCwd` still names the
primary workspace. When more than one runtime is registered, it additionally
publishes `workspaces[]`, `multi_workspace_sessions`, and additive session
limits. `/daemon/status` adds the same `workspaces[]` metadata and aggregates
live session counters across runtime bridges while leaving full workspace
sections primary-only.

Phase 2a PR 2 does not add plural routes, workspace-qualified ACP/WebSocket,
file/memory/MCP/settings/voice/channel-worker migration, dynamic add/remove,
non-primary persisted load/resume/export/archive/delete, branch/fork/cd/rewind,
shell/model/language migration, or SDK workspace client APIs.

## Phase 2b PR 1 Owner Index And Restore Expansion

Phase 2b PR 1 adds a bridge lifecycle callback seam and a
`WorkspaceSessionOwnerIndex` owned by `WorkspaceRegistry`. Bridge
register/remove lifecycle events update the index on spawn, load/resume,
channel exit, close, kill, and daemon shutdown. Owner resolution consults the
index first, verifies the indexed runtime with `getSessionSummary`, drops stale
index entries, and falls back to the existing live bridge scan. Fallback hits
are cached back into the index. The index remains an optimization and
consistency seam, not a persisted ownership database.

`POST /session/:id/load` and `POST /session/:id/resume` now accept explicit
`cwd` for any trusted registered workspace. Omitted `cwd` still resolves to the
primary runtime. Unknown `cwd` returns `400 workspace_mismatch`; untrusted
non-primary `cwd` returns `403 untrusted_workspace`; if the same session id is
already live or being restored in another runtime, restore fails closed with
`409 session_workspace_conflict`. Same-workspace restore races keep the
bridge's existing coalescing and `restore_in_progress` behavior. Restore still
reads persisted session storage from the requested workspace's existing storage
path and does not enable non-primary export/archive/delete.

The owner-routed read-only live routes now use the owning runtime bridge:
context, context-usage, stats, supported-commands, tasks, lsp, hooks, and
artifacts. These routes do not mutate persisted storage and do not require
ACP/WebSocket connection-local state, so they can safely follow the live owner.
`GET /session/:id/rewind/snapshots` remains primary-only because rewind state is
not part of the sessions-only closed loop.

`GET /workspaces/:workspace/sessions` is a plural alias for
`GET /workspace/:id/sessions`. Both resolve exact workspace id first and exact
canonical cwd second. Primary workspaces keep persisted/live merge semantics.
Phase 2b PR 1 kept non-primary workspaces live-only and rejecting archived or
organized list views.

## Phase 2b PR 2 Persisted Session Discovery

Trusted non-primary workspace session listing now includes active persisted
sessions from that workspace's session store and merges matching live summaries
without duplicates. This completes the discovery side of the Phase 2b restore
flow: clients can list a trusted secondary workspace, find an active persisted
session, and then call workspace-aware `POST /session/:id/load` or
`POST /session/:id/resume` from Phase 2b PR 1.

If a trusted non-primary workspace has no active persisted sessions, listing
keeps the previous live-only cursor behavior. Archived, organized, and grouped
non-primary list views remain rejected because archive/unarchive/delete and
session organization surfaces are still primary-only/later-phase work.

The Phase 2b work so far does not add new capability tags, does not alter the
`/capabilities` schema, does not change SDK types, and does not route ACP,
voice, channel-worker, file, memory, MCP, settings, branch/fork/cd/rewind,
shell/model/language, export, archive, delete, or organization surfaces to
non-primary runtimes.

## Audit Decisions

- The foundation PR must not create non-primary runtimes or relax any REST
  route.
- Existing `app.locals.boundWorkspace` and `app.locals.fsFactory` remain
  primary-only compatibility locals.
- The REST `routeFileSystemFactory` remains distinct from bridge filesystem
  factories; it must not be used to represent non-primary bridge boundaries.
- IDE secondary filesystem roots must not be promoted into explicit workspace
  runtimes.
- Single-workspace parent-env behavior remains compatible until true
  multi-workspace mode is ungated.
- PR 2's safe boundary is the live session closed loop plus additive
  capabilities/status metadata. If a route needs persisted storage,
  organization state, workspace settings, or ACP connection-local state, it
  stays primary-only or later.
