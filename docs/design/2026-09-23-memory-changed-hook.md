# MemoryChanged hook

[English](2026-09-23-memory-changed-hook.md) | [简体中文](2026-09-23-memory-changed-hook.zh-CN.md)

## Problem

Managed auto-memory is local filesystem state. Nothing tells an external integrator which documents were created, updated, or deleted, or whether memory is on for a workspace. `PostToolUse` does not cover index rebuilds, `/forget`, or writes that never go through a tool. A later consumer, such as a Data Agent hook that uploads the markdown files to its own API, needs a stable document identity and a path it can read after the write.

## Current state

`HookEventName` has no memory-document event. Remember, forget, extract, and dream persist documents under the user, project, and team memory roots, then rebuild `MEMORY.md`. Scheduling files (`meta.json`, `extract-cursor.json`, `consolidation.lock`) live outside `memory/`. The Memory dialog and `qwen/settings/setMemory` write `memory.enableManagedAutoMemory` without emitting a hook.

## Proposal

Add a post-write, non-blocking hook event, `MemoryChanged`. The change is already applied. Hook output and a hook failure do not roll it back. The event does not include file bodies. The integrator reads `paths` for `create` and `update`. For `delete`, the file is already gone.

### Document change

```json
{
  "paths": ["/abs/memory/user/role.md"],
  "relative_paths": ["user/role.md"],
  "memory_scope": "user",
  "operation": "update"
}
```

```json
{
  "paths": ["/abs/project/memory/a.md", "/abs/project/memory/b.md"],
  "relative_paths": ["a.md", "b.md"],
  "memory_scope": "project",
  "workspace": "/abs/project",
  "operation": "update"
}
```

- `paths`: absolute paths. One file is `[path]`. Files changed together stay in one array, split by scope.
- `relative_paths`: the same documents, relative to that scope's memory root, using `/`, in the same order as `paths`. This is the stable document key. Absolute sandbox paths are not.
- `memory_scope`: `user`, `project`, or `team`.
- `operation`: `create`, `update`, or `delete`, based on filesystem existence. Writing an existing empty `MEMORY.md` is an `update`, including a scaffold-created index or an index that was cleared and refilled. This event does not replay earlier creations; a mirror must initialize from existing documents and accept updates to documents it has not seen before.
- `workspace`: absolute workspace directory. Present for project and team memory. Omitted for user memory.

`write_file` and `edit` notify when the target is inside a managed memory root. `/forget` notifies after a delete or rewrite. `MEMORY.md` rebuilds notify after the index write, and skip a byte-identical rewrite of a regular index file. Runtime-managed project/user dream, extract, and metadata migration compare the memory trees before and after the operation, including its index rebuild, and emit the difference once. A shell delete inside that agent is a `delete` event. In structured recall mode, manual `/dream` uses the managed operation and its snapshot. In legacy mode it submits a prompt to the main agent, so a shell delete in that turn is not covered by the snapshot. A write that notifies on its own while that comparison is open keeps that event, and the window's difference is taken against what that event reported. An explicit delivery id matches only its owning registration; an unavailable id never falls back to another session. Only an event without an id uses the newest active registration for that workspace. A closing session immediately leaves that fallback while retaining its own pending notifications until its memory tasks drain. Only Markdown documents enter both direct notifications and snapshots; scheduling and temporary files are excluded. If an outside notification arrives after the closing snapshot read, the window skips that stale comparison and leaves the event to the writer.

Snapshot keys use the filesystem's stored spelling while preserving symlink components. A path hidden by a new symlink is unknown to the walk, not a deletion. An outside delete remains the baseline even when the opening snapshot could not read the document.

If the opening directory snapshot is incomplete, explicit notifications are delivered directly. If the closing snapshot is incomplete, retained explicit notifications are delivered with their original owner, excluding paths superseded by a newer outside notification. Neither case infers raw changes from a partial snapshot. Migration records each committed document and index inside the configured memory roots. A secondary repository-local compatibility root may still be migrated, but is outside the notification scope; including it under the same project scope would collide with configured-root document keys. Final notifications for committed changes run independently of task cancellation, subject to the normal hook timeout; this event is not a durable delivery queue.

Team-memory synchronization registers a boundary around the pull and its imported-content baseline. Snapshots wait for that boundary and retry if a sync overlaps their read. Only the Git-changed document paths move the baseline, using checkout-converted content; local raw edits that differ from that content still produce events. If an imported file is not materialized in the checkout or Git cannot read its converted content, that path is unknown to the comparison: no raw change is inferred, while subsequent explicit writes still notify their owner. A newer explicit notification wins over a delayed sync baseline. All snapshot windows in a process share one execution queue because they include global user memory. The next task starts after the preceding task has delivered its closing diff; queued tasks check cancellation before running. Nested work joins its enclosing window. This does not coordinate raw writes from other processes.

### On/off toggle

```json
{
  "paths": [],
  "relative_paths": [],
  "workspace": "/abs/project",
  "enabled": false
}
```

`enabled` is present only for this toggle. `operation` and `memory_scope` are omitted. The Memory dialog commits the workspace setting before changing its displayed state or emitting with that project root. A failed settings write shows an error and emits no toggle. `qwen/settings/setMemory` writes the user setting and emits with the request workspace when `enableManagedAutoMemory` actually changes. A multi-key request can partially commit: it reports the later write failure while still notifying an effective toggle that was already saved. The toggle has no relative path, so every `MemoryChanged` hook receives it. A hook that only cares about documents ignores events where `enabled` is present. Editing the settings file on disk does not emit this event. The Memory dialog, `qwen/settings/setMemory`, and `qwen/settings/setCoreValue` emit when a successfully persisted change alters the effective setting. Both ACP routes use the requesting session registration when supplied, otherwise the settings workspace registration.

The base hook input still carries `session_id` and `cwd`. `cwd` is the working directory, not the workspace.

## Decisions

| Decision                                                                  | Why                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Emit after the write, from the memory write sites, not from `PostToolUse` | Index rebuilds and `/forget` are not tool calls. The file is readable, or already deleted, when the hook runs.                                                                        |
| Do not put file bodies in the payload                                     | The hook reads `paths`. A delete has no body. A large document does not have to fit in the hook stdin JSON.                                                                           |
| Add `relative_paths` and `memory_scope`                                   | A later uploader can name the remote object without reimplementing Qwen's memory directories, and can skip `team` if that layer is already git-synced.                                |
| One event per scope                                                       | User memory must omit `workspace`. Project and team memory in the same call stay separate.                                                                                            |
| Hook failure is ignored                                                   | The local write has landed. A failed upload must not undo it.                                                                                                                         |
| Deliver only to the workspace that wrote                                  | A process can host more than one workspace. Another workspace's hooks do not see the change. When several sessions share that workspace, the event goes to the session that wrote it. |
| Matcher uses `relative_paths`                                             | `MEMORY.md` and `user/role.md` can be selected without matching an absolute sandbox path.                                                                                             |

## Scope

In: the hook event, its settings entry, the emit sites above, and the user hook doc.

The project scope uses the configured project memory root. Local mode uses the literal `.qwen/memory` location below the canonical workspace, excluding roots relocated by symlinks in that suffix. The secondary repository-local compatibility root, when different, is outside the notification scope.

Out: uploading bytes, remote storage, hydration of a fresh instance, and blocking or rewriting a memory write before it hits disk.

## Validation

- Unit tests classify user, project, and team paths, drop scheduling files and unrelated files, batch paths that change together, omit `workspace` for user memory, and emit the toggle with empty `paths`.
- A listener that throws does not reject the notify call.
- The hook input omits `workspace` for user documents and omits `operation` / `memory_scope` for the toggle.

## Acceptance

- A configured `MemoryChanged` command hook receives the JSON above on stdin after the document or toggle change.
- No hook configured means the write path does not run hook commands.
- `meta.json`, `extract-cursor.json`, and `consolidation.lock` do not emit the event.
