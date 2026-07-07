# Phase 2a Multi-Workspace Sessions Foundation

## Summary

This document records the Phase 2a contract for issue #6378 after the Phase 1
`WorkspaceRegistry` PR and the Phase 2a foundation PR. Phase 2a is now split
into two implementation PRs: PR 1 lands env isolation and total-admission
guardrails while multi-workspace remains gated; PR 2 will wire non-primary live
session dispatch and publish the additive capabilities/status schema.

Phase 2a remains sessions-only. It does not add plural routes, a
`WorkspaceDaemonClient`, workspace-qualified ACP/WebSocket, file, memory, MCP,
settings, voice, or channel-worker migration. PR 1 does not add capabilities
`workspaces[]`, `multi_workspace_sessions`, route dispatch, or non-primary
runtime construction.

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
- `env`: runtime-local env source metadata. In single-workspace production,
  the primary runtime now receives a computed effective env snapshot and a
  mutable env source that can be refreshed after daemon env reload. Direct
  `createServeApp` fallback remains parent-process metadata.

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
- Reuse PR 1 runtime-local env overlays before non-primary child spawn.
- Reuse PR 1 `maxTotalSessions` admission at every future fresh-creation seam
  so REST and primary `/acp` cannot bypass it, while attach still bypasses
  admission.
- Publish `workspaces[]` and `multi_workspace_sessions` only in PR 2 when the
  live session dispatch loop is complete.
- Update SDK capability types when the additive capabilities schema ships, but
  do not add a workspace client in Phase 2a.

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
  attach bypasses it.
- The bridge admission seam is a synchronous reservation hook. Failed fresh
  creation releases the reservation, preventing concurrent oversell across
  runtimes once non-primary bridges exist.
- `/daemon/status.limits.maxTotalSessions` is additive. `/capabilities` and SDK
  capability types remain unchanged until PR 2 ungates multi-workspace
  sessions.

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
