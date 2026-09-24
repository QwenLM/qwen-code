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
- `operation`: `create`, `update`, or `delete`.
- `workspace`: absolute workspace directory. Present for project and team memory. Omitted for user memory.

`write_file` and `edit` notify when the target is inside a managed memory root. `/forget` notifies after a delete or rewrite. `MEMORY.md` rebuilds notify after the index write, and skip a byte-identical rewrite. Scheduled dream and extract compare the memory trees before and after the agent, including its index rebuild, and emit the difference once. A shell delete inside that agent is a `delete` event. Manual `/dream` submits a prompt to the main agent, so a shell delete in that turn is not covered by the snapshot. Scheduling files are classified out.

### On/off toggle

```json
{
  "paths": [],
  "relative_paths": [],
  "workspace": "/abs/project",
  "enabled": false
}
```

`enabled` is present only for this toggle. `operation` and `memory_scope` are omitted. The Memory dialog writes the workspace setting and emits with that project root. `qwen/settings/setMemory` writes the user setting and emits with the request workspace when `enableManagedAutoMemory` actually changes. The toggle has no relative path, so every `MemoryChanged` hook receives it. A hook that only cares about documents ignores events where `enabled` is present. Editing the settings file on disk does not emit this event. Only the Memory dialog and `qwen/settings/setMemory` do.

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

Out: uploading bytes, remote storage, hydration of a fresh instance, and blocking or rewriting a memory write before it hits disk.

## Validation

- Unit tests classify user, project, and team paths, drop scheduling files and unrelated files, batch paths that change together, omit `workspace` for user memory, and emit the toggle with empty `paths`.
- A listener that throws does not reject the notify call.
- The hook input omits `workspace` for user documents and omits `operation` / `memory_scope` for the toggle.

## Acceptance

- A configured `MemoryChanged` command hook receives the JSON above on stdin after the document or toggle change.
- No hook configured means the write path does not run hook commands.
- `meta.json`, `extract-cursor.json`, and `consolidation.lock` do not emit the event.
