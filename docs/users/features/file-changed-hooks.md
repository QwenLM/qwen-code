# FileChanged hooks

[English](file-changed-hooks.md) | [简体中文](file-changed-hooks.zh-CN.md)

Use `FileChanged` to observe files changed by Qwen Code, shell commands, editors,
or other processes. It runs in local, non-managed sessions. See the
[Hooks guide](hooks.md) for hook configuration, executors, and trust rules.

## Event input

The input includes the [common hook fields](hooks.md#hook-input-structure) and:

```json
{
  "file_path": "/home/me/work/demo/.envrc",
  "event": "change"
}
```

`file_path` is absolute. `event` is `add`, `change`, or `unlink` for an observed
file addition, modification, or deletion. The common `session_id` and `cwd`
belong to the listening session; they do not identify the writer. Multiple
sessions watching a shared directory can each receive its changes. File content
is not included.

Only file events are delivered. Directory-self `addDir` and `unlinkDir` events
are not delivered. Integrations tracking a watched root's own lifecycle must
check filesystem state (for example with `stat`) and reconcile independently;
a child's `unlink` does not prove that the root was removed.

## Watch filenames in the working directory

Add a `FileChanged` hook with literal filenames separated by `|`:

```json
{
  "hooks": {
    "FileChanged": [
      {
        "matcher": ".envrc|.env",
        "hooks": [
          {
            "type": "command",
            "name": "configuration-changed",
            "command": "node \"$QWEN_PROJECT_DIR/.qwen/hooks/on-file-changed.mjs\""
          }
        ]
      }
    ]
  }
}
```

This registers `.envrc` and `.env` in the session's cwd. Static registration does
not expand globs or scan directories recursively. Omitted or empty matchers,
`*`, and `.*` register no static paths; those hooks receive events from the
session's watched paths, including dynamic paths. Events are filtered against
the file's basename using the
[existing matcher rules](hooks.md#matcher-patterns).

Regex patterns filter already watched paths; register their files or directories
explicitly through `watchPaths`.

Static roots accept only bare literal filenames, including dotfiles. Regex/glob
metacharacters and path separators do not create static roots. Existing
directories and paths that cannot be inspected are excluded; missing files may be watched
for creation. Static file discovery observes their parent directory while excluding
unrelated entries before traversal. Use explicit `watchPaths` for recursive directories. Changing
the session working directory relocates static roots before relocation finishes;
explicit absolute dynamic roots stay unchanged.

## Watch directories and paths outside cwd

A successful synchronous `SessionStart` hook can register absolute files or directories
through `hookSpecificOutput.watchPaths`. Directories are watched recursively,
including children created later. Recursive discovery skips `.git` and
`node_modules` subtrees. To observe a path inside them, register that file or
directory explicitly. Special file types are ignored, and ordinary directories
have no depth limit. Initial registration waits for watcher
readiness before `SessionStart` returns.

Recursive discovery ignores atomic-write temporary files named
`<target>.<12 lowercase hex characters>.tmp`, including delayed renames and
orphans. Explicitly registering such a file still observes it. Directories with
this suffix remain traversable, and other `.tmp` files are observed normally.

For example, register memory folders:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "name": "watch-memory-folders",
            "command": "node \"$QWEN_PROJECT_DIR/.qwen/hooks/watch-memory.mjs\""
          }
        ]
      }
    ],
    "FileChanged": [
      {
        "hooks": [
          {
            "type": "command",
            "name": "memory-file-changed",
            "command": "node \"$QWEN_PROJECT_DIR/.qwen/hooks/on-file-changed.mjs\""
          }
        ]
      }
    ]
  }
}
```

Have `watch-memory.mjs` print this JSON to stdout. Replace the example paths with
the actual absolute folders shown by `/memory`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "watchPaths": [
      "/home/me/.qwen/projects/demo/memory",
      "/home/me/.qwen/memories"
    ]
  }
}
```

The `FileChanged` hook has no matcher, so it receives changes throughout those
registered directories. Its handler reads the event JSON from stdin. Choose a
log or synchronization destination outside the watched paths to avoid triggering
the handler with its own writes.

## Update dynamic paths

For several workspaces in the same filesystem, register all their actual memory
directories in one list. Route notifications using `file_path` and your own
directory-to-workspace mapping, rather than the listening session's `cwd`.
Independent sessions can observe the same shared root, so deduplicate the work
in the business handler. Roots in another container or remote instance need a
watcher in that filesystem owner; registering their paths on the host does not
observe them.

Successful synchronous `SessionStart` and `FileChanged` output can set `watchPaths`. Include
the matching `hookEventName` in `hookSpecificOutput`.

| Output                                  | Effect on dynamic paths            |
| --------------------------------------- | ---------------------------------- |
| A list of absolute files or directories | Replaces the previous dynamic list |
| `[]`                                    | Clears the dynamic list            |
| Omitted or invalid `watchPaths`         | Keeps the previous dynamic list    |
| Output from an async hook               | Does not register or change paths  |

When several hooks return lists, the last valid, explicitly supplied list in
hook execution order wins. All entries must be absolute paths; one invalid entry
makes the list invalid. Static filename registrations remain active after a
dynamic replacement or clear.

To clear dynamic paths from a `FileChanged` handler, return:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "FileChanged",
    "watchPaths": []
  }
}
```

## Observation limits

The initial directory scan is not replayed. Native filesystem events from a
recent write may arrive after registration. Explicitly registered symbolic-link
files and directory roots observe their targets, including links in ancestor paths.
Notifications use the configured alias; registering multiple aliases to one target
produces a notification for each alias. Refresh registration after retargeting a
link. Symbolic links discovered inside a recursive root are not traversed.
Events are reported after writes settle.
Watching is best effort: filesystem coalescing, inaccessible paths, process
downtime, and path reconfiguration can leave gaps. Integrations that require a
complete synchronized copy must handle initial scans, reconciliation, and retry.
Watcher or hook failures are logged and leave the originating file operation
unchanged.

`FileChanged` cannot veto or undo a write or add model context. Only explicitly
registered paths are watched: memory folders are not registered automatically,
and there is no dedicated auto-memory enable/disable event. A hook that writes
a watched file can trigger itself; avoid those writes or deduplicate the work.

SSH execution environments, shell sandbox workers, and managed dispatchers do
not start a local filesystem watcher. Normal hook enablement and trust rules
still apply. Watching stops when its owning session shuts down.
