# Extension File Reload Design

## Background

Extension changes currently enter the runtime from two different directions.
User-initiated UI mutations, such as enable, disable, install, uninstall, and
update, already go through `ExtensionManager` and can refresh runtime state
directly. Out-of-band filesystem changes, such as editing an installed
extension's `skills/`, `commands/`, `hooks/`, or `qwen-extension.json`, are not
owned by a single UI action and therefore need a watcher-driven path.

This design adds that missing watcher path while preserving the direct mutation
path. It follows the same layering used by the MCP and LSP hot-reload designs:

- the CLI decides when filesystem changes should trigger a reload or a user
  notification;
- Core owns how extension runtime state is refreshed;
- UI components consume a small event/state object instead of polling extension
  files directly.

The key constraint is that not every extension file can be safely hot-applied in
the same way. Content-like capability files can be refreshed automatically, but
package-level changes should ask the user to run `/reload-plugins` so the
extension cache, runtime tools, hooks, context files, and slash command list are
rebuilt from one coherent snapshot.

## Current Code Assessment

- `ExtensionManager` already loads extension manifests, convention directories,
  install metadata, enablement state, marketplace source state, commands,
  skills, agents, hooks, MCP declarations, and LSP declarations.
- UI extension operations already call `ExtensionManager.refreshTools()` after
  changing runtime-relevant state. That path refreshes MCP, skills, subagents,
  hooks, and hierarchical memory through Core.
- Slash command completion is built by `CommandService.create()` from loaders.
  Extension commands and skill-backed slash commands do not automatically
  appear unless `reloadCommands()` rebuilds that command service.
- Skill and subagent managers have cache refresh APIs, but those caches are
  separate from slash command completion.
- Hooks are owned by `HookSystem` and `HookRegistry`. Recreating the whole hook
  system would lose agent-scoped temporary hooks, so reload must target
  configured hooks only.
- `SettingsWatcher` and existing MCP/LSP watchers do not cover installed
  extension package content. Extension-specific files need their own watcher.
- Linked extensions can live outside the user extension directory, so watching
  only `~/.qwen/extensions` misses active development workflows.

## Goals

Make extension changes take effect in the current interactive session without a
full CLI restart:

- keep UI extension mutations immediately effective;
- detect manual extension edits, additions, and removals under the user
  extension directory;
- detect edits in linked extension source directories;
- auto-refresh content-level capability files under `commands/`, `skills/`,
  and `agents/`;
- prompt the user to run `/reload-plugins` for package-level changes;
- refresh hooks as part of runtime reload without losing agent-scoped hooks;
- keep slash command completion in sync with command and skill changes;
- suppress watcher notifications for changes written by Qwen's own extension
  mutations;
- surface MCP and hook reload failures instead of reporting a misleading
  successful reload summary.

## Non-goals

- Do not make hook file edits content-auto-refreshable. Hook behavior can affect
  command execution and security-sensitive workflows, so hook edits are treated
  as package-level changes.
- Do not hot-reload arbitrary extension files. Unknown files are ignored unless
  they are resolved context files.
- Do not add per-extension incremental MCP restart. This design continues to use
  the existing MCP reinitialization entry point.
- Do not change extension discovery, conversion, installation source parsing, or
  marketplace semantics.
- Do not support runtime toggling of bare mode. The watcher is simply not
  started in bare mode.

## Code Structure

The implementation is intentionally split by layer.

```text
packages/core/src/extension/
  extensionManager.ts
    Extension mutation lifecycle events.
    UI mutation methods still own direct runtime refresh.

  extension-runtime-refresh.ts
    Core runtime refresh contract for extension mutations.

packages/core/src/hooks/
  hookRegistry.ts
    Reload configured hooks while preserving agent-scoped hooks.

  hookSystem.ts
    Public hook reload facade used by extension runtime refresh.

packages/cli/src/config/
  extension-refresh-state.ts
    Shared event/state object for watcher, slash processor, and reload command.

  extension-file-watcher.ts
    Filesystem watcher and path classifier.

  extension-runtime-reload.ts
    CLI reload helpers for /reload-plugins and content auto-refresh.

packages/cli/src/ui/commands/
  reload-plugins-command.ts
    Interactive slash command for package-level extension reload.

packages/cli/src/ui/hooks/
  slashCommandProcessor.ts
    Event consumers for stale notifications and content auto-refresh.

packages/cli/src/
  gemini.tsx
  ui/AppContainer.tsx
  ui/startInteractiveUI.tsx
    Startup and dependency injection for ExtensionRefreshState and watcher.
```

## Design

### 1. Classify Filesystem Changes

`ExtensionFileWatcher` maps a chokidar event to one of three outcomes:

```ts
type RefreshAction = 'auto' | 'stale' | false;
```

The classification is deliberately conservative.

| Path class                       | Action  | Reason                                                                                           |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `commands/**`                    | `auto`  | Slash command loaders can rebuild from the existing extension cache.                             |
| `skills/**`                      | `auto`  | Skill cache and slash command loaders can rebuild without changing package identity.             |
| `agents/**`                      | `auto`  | Subagent cache can rebuild without changing package identity.                                    |
| `hooks/**`                       | `stale` | Hook execution behavior should be reloaded from a coherent package snapshot.                     |
| `qwen-extension.json`            | `stale` | Manifest can change commands, skills, agents, hooks, MCP, LSP, context file names, and metadata. |
| `.qwen-extension-install.json`   | `stale` | Install metadata affects linked source roots and package identity.                               |
| configured context files         | `stale` | Model context can change and should be reloaded explicitly.                                      |
| extension directory add/remove   | `stale` | Installed extension topology changed.                                                            |
| top-level extension config files | `stale` | Enablement, preferences, or marketplaces changed outside UI mutation path.                       |
| unknown files                    | ignored | Avoid refreshing for build artifacts or unrelated data.                                          |

The same classifier is used for user-installed extensions and linked extension
source roots. For linked roots, the watcher first finds the owning linked
extension and then classifies the path relative to that source root.

### 2. Watch User and Linked Extension Roots

`ExtensionFileWatcher.startWatching()` builds watch roots from:

1. `Storage.getUserExtensionsDir()`, when it exists;
2. active linked extension source paths from install metadata;
3. the parent of the user extension directory, only when the extension
   directory does not exist yet.

The parent bootstrap watcher covers first extension installation or manual
creation of the extension directory after startup. When the directory appears,
the watcher marks extension state stale and schedules `restartWatching()` in a
microtask. Scheduling the restart avoids closing the bootstrap watcher while
chokidar is still dispatching the event.

Watcher options:

```ts
watchFs(roots, {
  ignoreInitial: true,
  followSymlinks: false,
  awaitWriteFinish: {
    stabilityThreshold: 200,
    pollInterval: 50,
  },
  ignored: (filePath) => this.isIgnored(filePath),
});
```

`followSymlinks: false` keeps an extension from causing Qwen to watch arbitrary
external paths through symlinks. The ignore filter skips `node_modules`, `.git`,
common editor backup files, swap files, temporary files, and `.DS_Store`.

### 3. Share Reload State Through ExtensionRefreshState

`ExtensionRefreshState` is the small event/state primitive shared by the
watcher, the slash command processor, and `/reload-plugins`.

Key methods:

```ts
markExtensionsChanged(reason?: string): boolean;
markExtensionContentChanged(reason?: string): boolean;
clearExtensionsChanged(): void;
notifyExtensionsReloadStarted(): void;
needsExtensionRefresh(): boolean;
beginSuppression(onSettle?: () => void): () => void;
suppressNotifications<T>(fn: () => T, onSettle?: () => void): T;
```

Events:

| Event                     | Producer                                | Consumer                    | Meaning                                                              |
| ------------------------- | --------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `ExtensionContentChanged` | `ExtensionFileWatcher`                  | `useSlashCommandProcessor`  | Content-level files changed; schedule auto-refresh.                  |
| `ExtensionRefreshNeeded`  | `ExtensionFileWatcher`                  | `useSlashCommandProcessor`  | Package-level state changed; tell the user to run `/reload-plugins`. |
| `ExtensionsReloadStarted` | `/reload-plugins`                       | `useSlashCommandProcessor`  | Cancel pending content refresh timers before manual reload.          |
| `ExtensionsReloaded`      | `/reload-plugins`, watcher restart path | watcher and slash processor | Clear stale flags and restart/cancel pending work.                   |

`markExtensionsChanged()` deduplicates stale notifications until the state is
cleared. Content-change notifications are not deduplicated by this state object,
because the slash command processor owns debounce and serialization.

### 4. Suppress Watcher Noise During Programmatic Mutations

`ExtensionManager` exposes:

```ts
interface ExtensionMutationEvent {
  id: number;
  phase: 'start' | 'end';
  operation: string;
}

addMutationListener(listener: ExtensionMutationListener): () => void;
```

Runtime-relevant mutation methods call `beginMutation()` and always emit a
matching end event in `finally`.

Methods that emit mutation events:

- `enableExtension()`
- `disableExtension()`
- `installExtension()`
- `uninstallExtension()`
- `updateExtension()`
- `addSource()`
- `removeSource()`
- `setExtensionScope()`
- `setMcpServerDisabled()`

Methods that do not emit mutation events:

- `toggleFavorite()`
- `markSourceUpdated()`

The watcher keeps `mutation id -> end suppression callback` in a `Map`. This is
important because install can trigger enable internally, and separate mutations
can overlap. Pairing by id avoids relying on stack order.

When the outer suppression depth reaches zero, the watcher restarts. That
refreshes linked source roots, context file names, and active extension
metadata after the mutation has settled.

### 5. Refresh Runtime State From Core

`refreshExtensionRuntime()` is the Core-side runtime refresh entry point used by
extension UI mutations.

It refreshes in this order:

1. `config.reinitializeMcpServers(config.getSettingsMcpServers())`
2. `config.getSkillManager()?.refreshCache()`
3. `config.getSubagentManager().refreshCache()`
4. `config.getHookSystem()?.reload()`
5. `config.refreshHierarchicalMemory()`

MCP reinitialization runs first because skill and subagent tool descriptions can
depend on the updated MCP tool list.

Skills, subagents, and hooks run through `Promise.allSettled()` so one rejected
leg does not prevent the others from applying. Hook reload failure is stored and
rethrown after hierarchical memory has had a chance to refresh. This keeps hook
failures visible while still applying best-effort cache refreshes.

Failure contract:

- MCP failure propagates immediately and later runtime legs do not run.
- Hook reload failure propagates after parallel refresh legs and memory refresh
  settle.
- Skill refresh failure is logged and best-effort.
- Subagent refresh failure is logged and best-effort.
- Hierarchical memory refresh failure is logged and best-effort.

### 6. Reload Package-Level Changes With /reload-plugins

`reloadPluginsRuntime()` is the CLI-side runtime reload helper used by the
slash command:

```ts
async function reloadPluginsRuntime(options: {
  config: Config;
  reloadCommands?: () => void | Promise<void>;
}): Promise<ReloadPluginsSummary>;
```

Flow:

1. `config.getExtensionManager().refreshCache()`
2. `config.getExtensionManager().refreshTools()`
3. `reloadCommands()`
4. summarize active extension capabilities

The summary counts active extension declarations for:

- extensions;
- commands;
- skills;
- agents;
- hooks;
- extension MCP servers;
- extension LSP servers.

`/reload-plugins` owns the user-facing command behavior:

1. require `config`;
2. emit `ExtensionsReloadStarted`;
3. call `reloadPluginsRuntime()`;
4. call `clearExtensionsChanged()` on success or failure;
5. return either a localized info summary or an error message.

Clearing stale state on failure is intentional. If a failed reload left
`extensionRefreshNeeded = true`, future file watcher notifications would be
deduplicated away and content auto-refresh would keep bypassing itself.

### 7. Auto-Refresh Content-Level Changes

`refreshExtensionContentRuntime()` is used for content-only filesystem changes.

Flow:

1. refresh extension cache;
2. refresh skill cache;
3. refresh subagent cache;
4. reload slash commands;
5. aggregate errors and throw a single message if any leg failed.

The slash command processor listens for `ExtensionContentChanged` and debounces
the refresh by 250 ms. It serializes refreshes with:

```ts
extensionContentRefreshRunningRef;
extensionContentRefreshPendingRef;
```

If a content event arrives while a refresh is running, the processor marks
another pass as pending and runs that pass after the current one finishes. A
small upper bound prevents a noisy editor or build process from keeping the
same refresh task alive indefinitely.

If `ExtensionRefreshState.needsExtensionRefresh()` is true, content
auto-refresh exits early. The package-level reload must run first so command,
skill, agent, hook, MCP, LSP, and context state are rebuilt from one extension
cache snapshot.

### 8. Reload Hooks Without Dropping Agent-Scoped Hooks

`HookRegistry.reloadConfiguredHooks()` replaces only configured hook entries.
It preserves entries with `agentScope !== undefined`, because those are
temporary hooks registered for subagent execution.

Flow:

1. save `previousEntries`;
2. keep `agentEntries`;
3. set registry entries to `agentEntries`;
4. run `processHooksFromConfig()`;
5. on failure, restore `previousEntries` and rethrow.

`HookSystem.reload()` is a narrow facade that delegates to
`hookRegistry.reloadConfiguredHooks()`. Runtime reload therefore does not need
to recreate the whole hook system.

This reload path does not re-read user or project settings files from disk.
`processHooksFromConfig()` re-processes the current `Config` values for
user/project hooks and the refreshed extension config values. Settings file
reload remains owned by the settings reload path; `/reload-plugins` is scoped to
extension runtime state.

### 9. Wire State Into Interactive UI

Interactive startup creates one shared `ExtensionRefreshState`:

```ts
const extensionRefreshState = new ExtensionRefreshState();
const extensionFileWatcher = isBareMode(argv.bare)
  ? undefined
  : new ExtensionFileWatcher(config, undefined, extensionRefreshState);
```

That state is passed through:

```text
gemini.tsx
  -> startInteractiveUI(...)
    -> AppContainer
      -> useSlashCommandProcessor
      -> CommandContext.services.extensionRefreshState
```

`AppContainer` creates a fallback `ExtensionRefreshState` only when one was not
provided. This keeps tests and alternate UI entry points simple while the main
interactive path shares state between watcher and slash command processing.

Cleanup unregisters the reload listener and stops the watcher.

## Event Flows

### Content File Edit

```text
edit extension commands/skills/agents file
  -> ExtensionFileWatcher classifies as auto
  -> ExtensionRefreshState.markExtensionContentChanged()
  -> useSlashCommandProcessor schedules debounced refresh
  -> refreshExtensionContentRuntime()
      -> ExtensionManager.refreshCache()
      -> SkillManager.refreshCache()
      -> SubagentManager.refreshCache()
      -> reloadCommands()
```

### Package-Level File Edit

```text
edit qwen-extension.json/hooks/context/install metadata/topology
  -> ExtensionFileWatcher classifies as stale
  -> ExtensionRefreshState.markExtensionsChanged()
  -> useSlashCommandProcessor prints:
       "Extensions changed on disk. Run /reload-plugins to apply updates."
  -> user runs /reload-plugins
  -> reloadPluginsRuntime()
      -> ExtensionManager.refreshCache()
      -> ExtensionManager.refreshTools()
      -> reloadCommands()
```

### UI Mutation

```text
user enables/disables/installs/uninstalls/updates extension
  -> ExtensionManager emits mutation start
  -> ExtensionRefreshState begins suppression
  -> ExtensionManager writes disk/runtime state
  -> ExtensionManager.refreshTools()
      -> refreshExtensionRuntime()
  -> ExtensionManager emits mutation end
  -> suppression settles
  -> ExtensionFileWatcher restarts with fresh roots/context files
```

## Concurrency and Ordering

- Watcher restarts are generation-guarded. Events from an old watcher instance
  are ignored after `watchGeneration` changes.
- Mutation suppression is paired by mutation id, not stack order.
- `stopWatching()` ends all pending suppressions before dropping watcher
  references, so suppression depth cannot leak when the watcher is stopped
  while a mutation is in flight.
- Content auto-refresh is serialized in the slash command processor. Concurrent
  events coalesce into at most one pending rerun.
- `/reload-plugins` emits `ExtensionsReloadStarted` and `ExtensionsReloaded` so
  pending content refresh timers are canceled around manual reload.
- Package-level stale state wins over content auto-refresh. If a stale reload is
  needed, content auto-refresh exits and waits for `/reload-plugins`.

## Failure Semantics

| Path                                                  | Behavior                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP reinitialization in mutation or `/reload-plugins` | Propagates. A success message would be misleading because extension MCP tools may be unavailable.                                          |
| Hook reload in mutation or `/reload-plugins`          | Propagates after other parallel refresh legs settle. A success summary would be misleading because configured hooks may not be registered. |
| Skill cache refresh during mutation                   | Logged and best-effort.                                                                                                                    |
| Subagent cache refresh during mutation                | Logged and best-effort.                                                                                                                    |
| Hierarchical memory refresh during mutation           | Logged and best-effort. It should not roll back already-written extension state.                                                           |
| Content auto-refresh failure                          | Aggregated and shown in the UI with a `/reload-plugins` fallback.                                                                          |
| `/reload-plugins` failure                             | Returns an error message and clears stale state so future watcher notifications can fire again.                                            |
| Hook registry reload failure                          | Restores previous hook entries and rethrows.                                                                                               |
| Watcher error                                         | Logged through debug logger; the session continues.                                                                                        |

## Tests

### Core Tests

`packages/core/src/extension/extension-runtime-refresh.test.ts`

- returns early without config;
- refreshes MCP before skills/subagents/hooks/memory;
- propagates MCP reconcile failures;
- keeps skill refresh failure best-effort;
- propagates hook reload failures after other refresh legs settle;
- keeps hierarchical memory failure best-effort.

`packages/core/src/extension/extensionManager.test.ts`

- emits mutation start/end around disable;
- emits mutation end when disable fails;
- emits mutation start/end around install, including nested enable events;
- emits mutation start/end around uninstall;
- emits mutation start/end around update temp directory failure;
- does not emit mutation events for favorite changes or source timestamp
  updates;
- preserves existing extension loading, command discovery, hook loading, and
  refreshTools coverage.

`packages/core/src/hooks/hookRegistry.test.ts`

- reloads configured hooks;
- preserves agent-scoped hooks during reload;
- restores previous entries when configured hook reload fails.

`packages/core/src/hooks/hookSystem.test.ts`

- delegates reload to the hook registry.

### CLI Tests

`packages/cli/src/config/extension-refresh-state.test.ts`

- emits stale refresh events once until cleared;
- emits content refresh events;
- suppresses notifications during mutation suppression;
- clears stale state and suppression windows correctly.

`packages/cli/src/config/extension-file-watcher.test.ts`

- classifies commands, skills, and agents as auto-refresh;
- classifies manifests, install metadata, hooks, context files, and extension
  topology changes as stale;
- ignores unknown files and ignored directories;
- watches linked extension sources;
- suppresses notifications during programmatic mutation;
- restarts watching after mutation settlement;
- handles late creation of the extension directory.

`packages/cli/src/config/extension-runtime-reload.test.ts`

- reloads extension cache, runtime tools, and slash commands for
  `/reload-plugins`;
- summarizes active extension capabilities;
- refreshes content runtime components;
- aggregates content auto-refresh failures.

`packages/cli/src/ui/commands/reload-plugins-command.test.ts`

- registers the command as interactive-only behavior;
- returns an error when config is missing;
- reloads runtime and clears stale state on success;
- clears stale state on failure and returns an error.

`packages/cli/src/services/BuiltinCommandLoader.test.ts`

- includes `/reload-plugins` in built-in command loading.

### Manual Verification

Manual verification should cover:

1. Enable an extension from the UI and confirm commands, skills, agents, MCP,
   hooks, and context are refreshed without restarting.
2. Disable the same extension and confirm runtime capabilities are removed or no
   longer offered.
3. Edit a command file under `commands/` and confirm slash command completion
   updates automatically.
4. Edit a skill file under `skills/` and confirm skill-backed slash command
   completion updates automatically.
5. Edit an agent file under `agents/` and confirm agent cache behavior reflects
   the change.
6. Edit `hooks/hooks.json`, `qwen-extension.json`, install metadata, context
   files, or extension directory topology and confirm the UI asks for
   `/reload-plugins`.
7. Run `/reload-plugins` and confirm the summary reports extensions, commands,
   skills, agents, hooks, extension MCP servers, and extension LSP servers.
8. Force a reload failure and confirm the UI reports the error, then a later
   filesystem change can still trigger another notification.

## Tradeoffs

- Hooks are treated as package-level stale changes even though a configured hook
  reload API exists. This avoids silently changing hook execution behavior from
  a background filesystem event.
- MCP refresh remains full runtime reinitialization. Per-extension incremental
  MCP restart would reduce cost but would expand this PR into MCP ownership and
  reconciliation logic.
- The watcher classifies unknown files as ignored instead of stale. This reduces
  noise for build artifacts but means extension authors must put runtime
  capability files in the supported convention directories.
- Linked extension roots are watched directly. This improves authoring
  ergonomics but can increase watcher count for users with many linked
  extensions.

## Future Work

- Add per-extension incremental MCP reconciliation.
- Add user-visible diagnostics for fatal watcher errors such as `ENOSPC` or
  `EMFILE`.
- Consider a typed reload result from `refreshExtensionRuntime()` if callers
  need partial-success summaries.
- Optimize linked extension source lookup with a precomputed root map if many
  linked extensions become common.
- Revisit hook content auto-refresh only if hook reload can be made explicit,
  observable, and safe enough for background application.
