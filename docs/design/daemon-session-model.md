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

1. `acpAgent.newSession` after `createAndStoreSession`.
2. `Session.setModel` after a successful switch (including `persistDefault:
false`).
3. ACP `/model <id>` via `switchMainModel` when `executionMode === 'acp'`.
4. `rewindRecording`, which re-anchors the live binding (not a user switch).

`loadSession` / `resumeSession` must not write. `workspaceReload` must not
write.

Implicit registry records omit `baseUrl` and `isRuntime`. Restore must still
`switchModel` when the cold Config currently holds a same-id runtime snapshot,
so the session leaves the snapshot endpoint instead of no-op'ing.

## Restore (ACP cold start only)

Live attach/resume skips restore. Cold `loadSession` / `resumeSession`:

1. `newSessionConfig` still constructs Config from current settings.
2. Before `ensureAuthenticated`, apply the last `session_model` payload, else
   the last assistant `model` (same auth), else keep settings.
3. `switchModel` failure is non-fatal; resume continues on the settings model.

## Surfaces

JSONL is shared, so core must accept the subtype. Replay already skips ordinary
system records. Only ACP applies `switchModel` on restore.
