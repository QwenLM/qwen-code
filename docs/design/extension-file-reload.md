# Extension File Reload

## Summary

This change makes extension runtime updates visible without requiring a full CLI restart. It preserves the existing immediate UI mutation path for extension enablement and installation, adds a file watcher for out-of-band extension edits, and introduces `/reload-plugins` for package-level changes that cannot be safely applied as content-only updates.

The design separates extension changes into two classes:

- Content-level changes can be refreshed automatically because they only rebuild already-loaded runtime consumers. These include `commands/`, `skills/`, and `agents/`.
- Package-level changes mark the extension set stale and ask the user to run `/reload-plugins`. These include extension manifests, install metadata, enablement and preference files, hooks, context files, extension directory creation/removal, and linked extension package-level edits.

This split keeps common authoring workflows fast while avoiding silent partial reloads for changes that affect package identity, hook execution, context injection, or installed extension topology.

## Goals

- Keep UI extension mutations immediately effective.
- Detect manual edits, additions, and removals under the user extension directory.
- Detect edits in linked extension source directories.
- Auto-refresh extension commands, skills, and agents when their content files change.
- Prompt for `/reload-plugins` when extension package state changes.
- Refresh hooks as part of runtime reload.
- Keep slash command completion in sync after command and skill changes.
- Avoid noisy notifications for changes made by Qwen's own extension mutation operations.
- Surface MCP and hook reload failures instead of reporting a misleading successful reload.

## Non-Goals

- This does not make hook changes content-auto-refreshable. Hooks can affect command execution and security-sensitive behavior, so they remain package-level stale changes.
- This does not hot-reload arbitrary files under an extension. Unknown files are ignored unless they are context files resolved from the extension configuration.
- This does not add per-extension incremental MCP restart. Runtime refresh still delegates to the existing MCP reinitialization entry point.
- This does not change extension discovery or install source semantics.

## Main Components

### ExtensionRefreshState

`ExtensionRefreshState` is the shared event and state object between the filesystem watcher, slash command processor, and `/reload-plugins`.

It owns four user-visible events:

- `ExtensionContentChanged`: content-only files changed and can be auto-refreshed.
- `ExtensionRefreshNeeded`: package-level extension state changed and the user should run `/reload-plugins`.
- `ExtensionsReloadStarted`: a manual reload started, so pending content refresh work should be canceled.
- `ExtensionsReloaded`: a reload completed or was canceled from the UI state perspective, so stale flags and pending timers can be cleared.

It also has a short suppression window used during Qwen-initiated extension mutations. That window prevents the watcher from reporting changes caused by the mutation itself, such as install, uninstall, enable, disable, or update writing extension metadata.

### ExtensionFileWatcher

`ExtensionFileWatcher` watches the user extension directory and linked extension source roots. It is created during interactive CLI startup unless bare mode is enabled.

The watcher observes:

- the user extension root;
- linked extension source roots from active extension metadata;
- the parent directory of the extension root when the extension root does not exist yet.

It ignores `node_modules`, `.git`, editor backup files, temporary files, swap files, and `.DS_Store`. Symlink following is disabled so an extension cannot cause chokidar to watch arbitrary external trees through a symlink inside the extension directory.

The watcher classifies paths into either `auto`, `stale`, or ignored:

- `commands/`, `skills/`, and `agents/` are `auto`.
- `hooks/`, `qwen-extension.json`, `.qwen-extension-install.json`, context files, top-level enablement/preference/marketplace files, extension directory add/remove, and linked package-level edits are `stale`.
- Unknown paths are ignored.

When the user extension directory is created after startup, the bootstrap watcher marks extensions stale and restarts the main watcher on the next microtask. This avoids closing the bootstrap watcher synchronously while chokidar is dispatching the current event.

### ExtensionManager Mutation Events

`ExtensionManager` now exposes `addMutationListener()`. Mutating methods emit paired `start` and `end` events with a stable mutation id.

The watcher uses those events to suppress filesystem notifications while Qwen is intentionally writing extension files, then restarts watching after the outer mutation settles. The id-based pairing handles nested or overlapping mutations, such as install triggering enable internally.

Mutation events are reserved for runtime-relevant extension changes:

- enable and disable;
- install, uninstall, and update;
- source add/remove;
- scope changes;
- per-extension MCP server disablement.

Preference-only operations do not emit runtime mutation events. In particular, toggling favorites and recording a marketplace source update timestamp do not suppress watcher events because they do not change extension runtime capabilities or watched extension contents.

### Runtime Refresh

There are two runtime refresh entry points.

`refreshExtensionRuntime()` lives in core and is used by extension UI mutations. It refreshes runtime subsystems in this order:

1. Reinitialize MCP servers.
2. Refresh skills, subagents, and hooks.
3. Refresh hierarchical memory.

MCP reinitialization is fatal for the operation. If it fails, callers should surface the error because extension MCP tools will not be available. Hook reload failures are also surfaced after the parallel refresh leg settles, because otherwise `/reload-plugins` could report hooks as available when the hook registry did not reload.

Skill, subagent, and memory refresh failures are logged and treated as best effort. Those caches can be refreshed again later, and they should not roll back extension enablement or installation metadata that has already been written.

`reloadPluginsRuntime()` lives in the CLI layer and is used by `/reload-plugins`. It refreshes extension cache, refreshes runtime tools, reloads slash commands, and returns a summary of active extension capabilities.

### Content Auto-Refresh

Content-level file changes call `refreshExtensionContentRuntime()`. It refreshes extension cache, skill cache, subagent cache, and slash commands. It aggregates failures and reports them through the slash command processor, which tells the user to run `/reload-plugins` if auto-refresh fails.

The slash command processor serializes content refreshes. If a second content event arrives while a refresh is running, it marks another pass as pending and runs it after the current pass finishes. The loop has a small upper bound so noisy editors or build processes cannot keep one refresh task alive indefinitely.

If package-level stale state is pending, content auto-refresh exits early. The user should run `/reload-plugins` so the package-level reload and content-level refresh happen from the same extension cache snapshot.

### Slash Commands

`/reload-plugins` is registered as a built-in slash command. It is only supported in interactive mode.

The command:

1. emits `ExtensionsReloadStarted`;
2. runs `reloadPluginsRuntime()`;
3. clears stale extension state on success or failure;
4. returns either a localized summary or an error message.

Clearing stale state on failure is intentional. Without it, a failed manual reload can leave `ExtensionRefreshState` stuck in a stale state where future filesystem notifications are deduplicated away and content auto-refresh remains bypassed.

Slash command completion is refreshed from two paths:

- content auto-refresh calls `reloadCommands()` after command/skill/agent content changes;
- `/reload-plugins` calls `reloadCommands()` after package-level reload.

The skill change listener in the slash command processor still bridges `SkillManager` cache changes into slash command reloads, so skill-backed slash commands stay visible after skill cache rebuilds.

### Hooks

`HookRegistry.reloadConfiguredHooks()` rebuilds configured hooks while preserving agent-scoped temporary hooks. If reloading configured hooks fails, the previous registry entries are restored and the error is rethrown.

`HookSystem.reload()` delegates to the registry reload method. This lets extension runtime refresh update hooks without recreating the whole hook system or losing agent-scoped hooks registered during subagent execution.

### UI Wiring

Interactive startup creates a shared `ExtensionRefreshState` and an `ExtensionFileWatcher`. The state object is passed into `AppContainer`, then into `useSlashCommandProcessor` and slash command contexts.

`useSlashCommandProcessor` listens for extension refresh events:

- `ExtensionRefreshNeeded` cancels pending content refresh and prints a system message telling the user to run `/reload-plugins`.
- `ExtensionContentChanged` schedules debounced auto-refresh.
- `ExtensionsReloadStarted` and `ExtensionsReloaded` cancel pending content refresh work.

The watcher is stopped during CLI cleanup.

## Failure Semantics

| Path                        | Failure behavior                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP reinitialization        | Propagates to caller. A successful summary would be misleading because MCP tools may be unavailable.                                          |
| Hook reload                 | Propagates after other parallel refresh legs settle. A successful summary would be misleading because configured hooks may not be registered. |
| Skill cache refresh         | Logged and best-effort for mutation refresh; aggregated and shown for content auto-refresh.                                                   |
| Subagent cache refresh      | Logged and best-effort for mutation refresh; aggregated and shown for content auto-refresh.                                                   |
| Hierarchical memory refresh | Logged and best-effort. It should not roll back extension mutations that already wrote state.                                                 |
| `/reload-plugins` failure   | Returns an error message and clears stale UI state so future file changes can notify again.                                                   |

## Test Coverage

The PR adds and updates focused tests for:

- filesystem watcher path classification;
- watcher suppression during extension mutations;
- bootstrap watcher behavior when the extension directory is created after startup;
- refresh state events and suppression;
- content runtime reload success and error aggregation;
- `/reload-plugins` command registration and behavior;
- runtime refresh order and failure semantics;
- mutation lifecycle events around enable, disable, install, uninstall, and update failure;
- preference-only operations not emitting runtime mutation events;
- hook registry reload preserving agent-scoped hooks and restoring previous entries on failure;
- hook system reload delegation.

Manual verification should cover:

- enabling and disabling an extension updates runtime capabilities without restart;
- editing `commands/`, `skills/`, or `agents/` updates slash command/runtime lists automatically;
- editing `hooks/`, manifests, install metadata, context files, or extension directory topology asks for `/reload-plugins`;
- `/reload-plugins` refreshes extension commands, skills, agents, hooks, MCP declarations, and LSP declarations;
- failed `/reload-plugins` does not leave the UI permanently stuck in stale state.

## Tradeoffs

The watcher uses package-level stale prompts for hooks and context files rather than trying to hot-apply them silently. This is more conservative, but it keeps model context and hook execution changes explicit.

MCP refresh remains full-runtime refresh through the existing core entry point. That keeps this PR scoped to extension reload behavior instead of introducing a separate incremental MCP reconciliation layer.

Linked extension source roots are watched directly so extension authors get the same behavior when developing through linked installs. The watcher disables symlink following and ignores build-heavy folders to limit accidental watch scope.

## Future Work

- Add incremental MCP restart keyed by extension MCP server changes.
- Add richer user-visible diagnostics for watcher failures such as `ENOSPC` or `EMFILE`.
- Consider content auto-refresh for hooks only if hook reload can be proven safe and observable enough for interactive users.
- Optimize linked extension path lookup if many linked extensions become common.
