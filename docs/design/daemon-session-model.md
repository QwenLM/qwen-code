# Daemon session model persistence

## Status

Implementation companion to keeping a daemon session on the model it was
created or last switched to, across detach / idle reap / daemon restart.

## Problem

Each ACP session has its own in-memory `Config`, but `Session.setModel` (and
ACP `/model`) also write `settings.model.name`. Switching away from an idle
session typically detaches and closes it. The next load/resume builds a new
`Config` from current settings, so session A picks up model B.

Assistant JSONL records store `model` per turn, but restore does not apply it.

## Goals

- Daemon load/resume of an existing session restores that session's model.
- New sessions still inherit the last persisted `model.name` default.
- TUI and CLI `--resume` do not switch models from this record.
- Resume stays read-only (no JSONL append).

## Non-goals

- Restoring model in TUI / CLI `--resume`.
- Changing approval-mode persistence.
- Stopping `model.name` updates for new-session defaults.
- Rebinding idle live sessions after `workspaceReload`.

## Record format

Append-only `system` / `session_model` JSONL records, last-wins, same pattern
as `session_source`.

```ts
interface SessionModelRecordPayload {
  modelId: string;
  authType: string;
  baseUrl?: string;
  isRuntime?: boolean;
}
```

`modelId` is the canonical id after `switchModel` (no ACP route id, no
`$runtime|` prefix). Runtime selections store the underlying id with
`isRuntime: true`.

## Write sites (daemon user intent only)

All writes go through `ChatRecordingService.recordSessionModel` (best-effort,
identical payload is a no-op), except rewind: `rewindRecording` re-appends the
in-memory binding after the rewind record so last-wins on the active branch
still matches Config.

1. `Session.setModel` after a successful switch (including `persistDefault:
false`).
2. ACP `/model <id>` via `switchMainModel` when `executionMode === 'acp'`.
3. `rewindRecording`, which re-anchors the live binding (not a user switch).

`acpAgent.newSession` must not write. Empty daemon sessions have no transcript
file; listing, DELETE, and child death all depend on that. A new session
already inherits `settings.model.name`. Load/resume of a session that never
switched models uses the last assistant `model`, else the current settings
default. A session that has user records but no assistant record and was never
switched therefore has no binding; that residual window is accepted so empty
sessions stay file-less.

`loadSession` / `resumeSession` must not write. `workspaceReload` must not
write.

Implicit registry records omit `baseUrl` and `isRuntime`. Restore must still
`switchModel` when the cold Config currently holds a same-id runtime snapshot,
so the session leaves the snapshot endpoint instead of no-op'ing.

## Restore (ACP cold start only)

Live attach/resume skips restore. Cold `loadSession` / `resumeSession`:

1. `newSessionConfig` still constructs Config from current settings.
2. Before `ensureAuthenticated`, apply the last valid `session_model` payload,
   else the last assistant `model` (same auth from
   `modelsConfig.getCurrentAuthType()` when content-generator auth is not yet
   populated), else keep settings. A recorded `baseUrl` is a registry route
   selector, not an arbitrary endpoint: it is honored only when it matches a
   configured registry route for that auth type and model, otherwise the
   implicit registry route is used. `authType` must be a known `AuthType`.
3. `switchModel` failure is non-fatal. A recorded runtime-snapshot binding
   whose live snapshot is gone still switches the bare id when a registry
   route exists; that can be a different endpoint than the recorded
   binding. Restore continues on the settings default only when no route
   resolves. If the restored auth then fails `ensureAuthenticated`,
   load/resume reverts to the settings model and retries authentication
   once.

## Surfaces

JSONL is shared, so core must accept the subtype. Replay already skips ordinary
system records. Only ACP applies `switchModel` on restore.
