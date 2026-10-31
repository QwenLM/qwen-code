# FileChanged hooks

[English](file-changed-hooks.md) | [简体中文](file-changed-hooks.zh-CN.md)

## Problem and current state

Integrators need to observe files written by Qwen Code, shell commands, editors,
or another process. Tool completion hooks cannot observe every writer. The
existing settings, extension, and skill watchers serve their own components;
there is no general file-change hook. Memory files are one use case, rather
than a new category of events.

## Proposed behavior

Add `FileChanged`, with the common hook input fields plus an absolute
`file_path` and an `event` of `add`, `change`, or `unlink`. Notifications describe
filesystem observations after a change. They cannot veto or undo a write,
identify its author, or add model context. The session ID identifies the
listening session, even when another session writes the shared directory.

For static registration, the matcher contains literal filenames in the session
working directory, separated by `|` (for example `.envrc|.env`). Omitted, empty,
`*`, and `.*` matchers register no static paths. They receive events from the session’s shared watch set, including dynamic
paths. Matching an observed event uses its basename and the existing hook
matcher rules. Static registration is not a glob or a recursive workspace scan.
Static roots accept only bare literal filenames, including dotfiles. Regex/glob
metacharacters and path separators do not create static roots. Existing
directories and paths that cannot be inspected are excluded; missing files may be watched
for creation. Static file discovery observes their parent directory while excluding
unrelated entries before traversal. Use explicit `watchPaths` for recursive directories. Changing
the session working directory relocates static roots before relocation finishes;
explicit absolute dynamic roots stay unchanged. Bootstrap configs that disabled
watching remain disabled.

Successful synchronous `SessionStart` and `FileChanged` outputs can return absolute files
or directories in `hookSpecificOutput.watchPaths`. Directories are watched
recursively, including future children. Recursive discovery skips `.git` and
`node_modules` subtrees unless a path inside them is explicitly registered.
Only regular files and directories are eligible after resolving explicitly
registered symbolic links; no depth limit is imposed.
Discovery observes the nearest existing
parent directory so deeply missing paths and deleted/recreated roots can appear
later. Only requested files and directory descendants produce notifications;
unrelated subdirectories are excluded before traversal. Discovery may enumerate
entries in an existing ancestor directory. The last valid, explicitly supplied
list in hook execution order replaces the previous dynamic list; an empty list
clears it, and an omitted or invalid list leaves it unchanged. Static paths
remain registered. Async hook output does not register paths.

Recursive discovery ignores atomic-write temporary files whose names end in
`.<12 lowercase hex characters>.tmp`, even if a delayed or failed rename leaves
them present. Explicitly registered files remain observable, and directories
with this suffix remain traversable. Other `.tmp` files are observed normally.

The initial directory scan is not replayed. Native filesystem events from a
recent write may arrive after registration. Explicit file and directory registrations
resolve symbolic links, including links in their ancestors, while notifications keep
the configured path spelling. Each registered alias receives its own notification
when aliases share a target. Registration refreshes resolve the targets again;
retargeting a link requires a refresh. Symbolic links discovered inside a recursive
root are not traversed. Watchers settle writes before reporting them,
using the existing chokidar dependency. Initial registration waits for watcher
readiness during HookSystem initialization, even without a SessionStart hook;
dynamic registration waits before SessionStart returns. Reconfiguration is best effort, rather
than a transaction or a change journal.

## Components and ownership

| Component                                                                 | Change                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hook types, planner, event handler, display metadata                      | Add the event, payload, and basename matching                                                    |
| HookSystem                                                                | Own the watcher, consume outputs, execute notifications with the listening runtime/session owner |
| Client session-start lifecycle                                            | Run internal watcher initialization even when only FileChanged hooks are configured              |
| FileChangedWatcher                                                        | Maintain static and dynamic paths, serialize callbacks, close and cancel on disposal             |
| Config                                                                    | Dispose only its owned hook system during shutdown; validate explicit bus payloads               |
| CLI settings and generated schema, hook UI, ACP metadata, SDK event union | Recognize the event through existing configuration and display surfaces                          |
| Hook documentation                                                        | Explain registration, memory-directory example, and limitations                                  |

The first implementation supports local, non-managed sessions. SSH execution
environments, shell sandbox workers, managed execution engines (including ACP),
and managed dispatchers do not create a
host filesystem watcher. A remote absolute path must never be interpreted as a
host path. Supporting hosted runtimes requires a separate design at the actual
filesystem owner. This feature introduces no daemon route or memory API.

ACP workspace/bootstrap and MCP reconnect initialization load the hook registry
with file watching disabled; actual session configs own their subscriptions. Session hook manager
mutations, including skill registration and removal, refresh the listening
session’s static roots without a reload.

Hook reload and enable/disable update the configured static roots. Events are
filtered through the current trusted registry. Shutdown stops intake, aborts
running hook commands, discards queued notifications, and releases the watcher.
Session rotation discards the outgoing dynamic roots and queued events, then
rebinds static roots to the new listening session before its first turn. A late
outgoing SessionEnd completion must not stop the replacement watcher. Reload
or skill registration after rotation can establish current-session ownership even
when no SessionStart hook ran. Ended sessions remain disarmed until a new
session or an explicit SessionStart; initialization opt-outs remain effective.
Derived configs do not own a second watcher. Failure to watch or execute a hook
is logged without changing the originating file operation.

## Scope and decisions

- Reuse chokidar and the existing hook runner, registry, trust checks, and timeout
  handling; do not add a second memory persistence pipeline.
- Register only paths explicitly requested by hooks. There is no implicit memory
  directory registration, memory enable/disable event, or content in the payload.
- Resolve explicit registrations inside FileChangedWatcher and map observations
  back to their configured aliases there. This keeps basename matching and queued
  events independent of a target's real path without enabling recursive link following.
- Deliver only file `add`, `change`, and `unlink` events, excluding directory-self
  `addDir` and `unlinkDir`. Integrations tracking a watched root's own lifecycle
  must check filesystem state (for example with `stat`) and reconcile independently;
  a child's `unlink` does not prove that the root was removed.
- Hooks that write a watched file can trigger themselves. Handlers must avoid
  such writes or deduplicate their work.
- Notifications are not durable: filesystem coalescing, process downtime,
  inaccessible paths, and reconfiguration can leave gaps. Business integrations
  own initial scans, deletion reconciliation, retry, and synchronization.
- A dedicated `MemoryChanged` API is not part of this proposal. This PR references
  issue #12558 without closing its independent memory-toggle requirement.

## Validation and acceptance criteria

Package tests and a real hook-runner probe must verify static filename events,
dynamic directories outside cwd, deeply missing paths, root deletion/recreation,
future nested files, add/change/unlink,
replacement of dynamic roots while retaining static roots, invalid output,
initial-scan suppression, listener-session ownership, session rotation, failure isolation,
reload/disable, and shutdown with queued work. Remote and managed configs must
not start a local watcher. MCP reconnect must opt out, and late registration
after a rotation without SessionStart must rebind only to the current session.
Temporary siblings must stay silent through delayed rename and orphan cleanup;
the final target, ordinary `.tmp` files, explicit file registrations, and
similarly named directories must remain observable.
Explicit symbolic-link files and directory roots must report target changes with
the configured alias, including multiple aliases to one target and target changes
after a registration refresh. Implicit child links and unrelated siblings stay silent.
Existing SessionStart additional context must still
work when another hook returns watchPaths.

Run build, typecheck, bundle, focused hook/config/schema tests, and the isolated
local CLI test plan. Record macOS runtime results separately from Linux/Windows
CI and from static inspection of Claude Code's directory registration behavior.

## Open questions and follow-up

No open question blocks the local implementation. Hosted/SSH filesystem owners
and durable business synchronization are follow-up work, not implied support.
