# Phase 2a Multi-Workspace Sessions Foundation

## Summary

This document records the Phase 2a foundation contract for issue #6378 after
the Phase 1 `WorkspaceRegistry` PR. The current implementation batch combines
the Phase 1 repeated `--workspace` follow-up, the Phase 2a prep guardrails, and
the first internal registry/runtime contract needed by later multi-workspace
session work.

Phase 2a remains sessions-only. It does not add plural routes, a
`WorkspaceDaemonClient`, workspace-qualified ACP/WebSocket, file, memory, MCP,
settings, voice, channel-worker migration, env overlays, total-session
admission, capabilities `workspaces[]`, `multi_workspace_sessions`, route
dispatch, or non-primary runtime construction in this foundation batch.

## Foundation Contract

- `--workspace` is repeatable at the CLI parser layer so yargs preserves array
  input instead of collapsing it.
- The serve fast path falls back to the full parser when repeated workspace
  values are present.
- A single-item workspace array is treated as the primary workspace and keeps
  the existing single-workspace behavior.
- Multiple explicit workspaces remain gated and fail before runtime boot.
- Duplicate canonical workspace inputs fail explicitly.
- Nested workspace inputs fail explicitly.
- Distinct non-nested multiple workspace inputs fail with the generic
  "multi-workspace serve is not enabled" boot error.
- The first explicit workspace is the future primary workspace once the gate is
  removed; this foundation batch does not expose that list publicly.

The internal `WorkspaceRuntime` contract now carries stable metadata for later
Phase 2a work:

- `workspaceId`: stable hash of the canonical workspace cwd.
- `workspaceCwd`: canonical workspace cwd.
- `primary`: true for the primary runtime.
- `trusted`: boot-time trust metadata; direct `createServeApp` fallback remains
  false unless production passes an explicit trusted value.
- `env`: metadata only. This foundation batch records parent-process mode and
  empty overlay keys; it does not compute runtime-local env overlays.

The internal `WorkspaceRegistry` supports exact cwd lookup, exact id lookup,
`resolveWorkspaceCwd(undefined)` primary fallback, and live session owner
resolution. Live owner resolution scans runtime bridge summaries only; it does
not scan persisted storage, create children, or route any request yet. Duplicate
live owners fail closed as an ambiguous result.

`createServeApp` may accept an injected registry for tests and future assembly,
but route modules still receive the primary runtime only. Existing legacy
`app.locals.boundWorkspace` and `app.locals.fsFactory` remain primary-only
compatibility locals.

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

Later or primary-only routes:

- non-primary `POST /session/:id/load`
- non-primary `POST /session/:id/resume`
- `GET /session/:id/export`
- `POST /sessions/delete`
- `POST /sessions/archive`
- `POST /sessions/unarchive`
- `PATCH /session/:id/organization`
- session-group mutations
- branch, fork, cd, rewind, shell, model, and language session mutations
- non-session `POST /permission/:requestId`
- `/acp`

Additional live read routes may be owner-routed in a later Phase 2a slice only
after tests prove they depend solely on the owning live bridge.

## Later Phase 2a Requirements

- Keep scan misses as `404 session_not_found`; never fall back to primary.
- Fail closed if more than one runtime reports the same live session id.
- Keep non-primary session listing live-only unless persisted entries are
  explicitly marked non-resumable.
- Add runtime-local env overlays before non-primary child spawn.
- Add `maxTotalSessions` at the bridge fresh-creation seam so REST and primary
  `/acp` cannot bypass it, while attach still bypasses admission.
- Publish `workspaces[]`, total limits, and `multi_workspace_sessions` only in
  the final ungate PR.
- Update SDK capability types when the additive capabilities schema ships, but
  do not add a workspace client in Phase 2a.

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
