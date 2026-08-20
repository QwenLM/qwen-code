# Settings File Change Detection (Issue #3696 Sub-task 1)

## Context

Qwen Code currently has no settings file change detection mechanism. Users must restart the session after modifying `settings.json` for changes to take effect. This proposal implements the infrastructure layer for the #3696 hot-reload system — automatic detection and event dispatching for settings file changes.

**Scope**: This sub-task is only responsible for "detect file changes → reload → notify listeners". `Config` copies many settings fields at construction time (`approvalMode`, `mcpServers`, `telemetry`, etc.), and these snapshots are NOT automatically updated by this sub-task. Only consumers that read `LoadedSettings.merged` in real time (e.g., the `useSettings()` hook, `disabledSkillNamesProvider`) will immediately see changes. Other sub-tasks (MCP reconnection, `/reload` command) are responsible for pushing updates to Config's internal state.

## Architecture Decisions

### Module Location: `packages/cli/src/config/settingsWatcher.ts`

- `LoadedSettings` and settings file paths are both in `packages/cli`
- `reloadScopeFromDisk()` is a method on `LoadedSettings`
- The core package only receives a minimal lifecycle interface `{ stopWatching(): void }`, without importing CLI types like `SettingScope`
- Change event dispatching and downstream refresh logic are entirely wired in the CLI layer

### Watching Strategy: Watch Parent Directory + Strict Path Filtering

The `writeWithBackupSync` write flow is `write(.tmp) → rename(target, .orig) → rename(.tmp, target) → unlink(.orig)`, which causes the target file to briefly disappear. Watching the file path directly would cause chokidar to lose the watch. Therefore, we watch the parent directory (`depth: 0`) and filter by **exact basename match**, only responding to `settings.json` file events and ignoring `.tmp`, `.orig`, editor temporary files, etc. The `.orig` backup is an in-flight safety net and is **removed on success** (final `unlink` step), so it never lingers in the user's directory.

### Lazy Directory Handling: Never Create `.qwen/` at Startup

> **Startup filesystem side effect (intentionally avoided).** The watcher must **never** create `<project>/.qwen/` (or `~/.qwen/`) just to be able to watch it. An earlier version called `mkdirSync({ recursive: true })` for any missing settings directory, which meant a normal non-bare startup silently created `<project>/.qwen/` even in projects that never had Qwen settings — polluting the workspace and git status. Directory creation is owned solely by settings _persistence_ (`saveSettings()` does its own `mkdirSync` when the user actually writes settings).

To still detect a `settings.json` added later in the session without creating the directory and without recursing the project tree, the watcher uses a two-stage, per-scope strategy keyed on **directory** existence:

- **`.qwen` exists at startup** → watch it directly (`watchTargetDir`, the strategy above).
- **`.qwen` missing** → **bootstrap-watch the parent** (`watchParentForDir`): `chokidar.watch(parentDir, { depth: 0, ignoreInitial: true, ignored })` where the `ignored` predicate `(p) => p !== parentDir && basename(p) !== '.qwen'` allows **only** the `.qwen` entry through. This suppresses all unrelated top-level churn and never recurses. Once `.qwen` appears, the watcher **promotes**: it closes the bootstrap watcher and starts a target watcher on `.qwen`, then schedules a refresh to pick up a `settings.json` that may already be inside.

Robustness details:

- **TOCTOU guard**: after arming the bootstrap watcher (which uses `ignoreInitial`), `existsSync(dir)` is re-checked; if `.qwen` was created in the gap, promotion happens immediately.
- **Demote on removal**: if `.qwen` itself is deleted (`unlinkDir`), the target watcher demotes back to a parent bootstrap watcher so a later re-create is still caught.
- **Generation guard**: chokidar `close()` is async, so a stale `'all'` callback from a watcher being torn down could otherwise re-trigger promotion and stack watchers. A per-scope monotonic generation token (bumped on every promote/demote, and on `stopWatching`) makes stale callbacks no-ops, guaranteeing at most one active watcher per scope.

### Change Detection: Semantic Diff as the Primary Deduplication Mechanism

Each time the watcher triggers, it first snapshots **the current in-memory state before reload** (`JSON.stringify(file.settings)`), then calls `reloadScopeFromDisk()` to reload, and finally compares the before/after snapshots. Listeners are only notified when the semantic content has actually changed.

Key: the comparison is between the in-memory state **before and after reload**, not against a stored historical snapshot. This is because `setValue()` synchronously updates `file.settings` in memory before writing to disk, so when the watcher triggers a reload, the in-memory state already contains the self-written value — reload produces the same content → no diff → no notification.

This naturally suppresses:

- Duplicate events from self-writes (`setValue()` has already updated memory, reload produces identical content → no diff → no notification)
- Format/comment-only changes (resolved settings don't include comments)
- Editor saves without content modification
- Duplicate chokidar events

Known limitation: `JSON.stringify` is sensitive to key ordering. If a user manually reorders keys in settings.json without changing values, it will trigger one harmless extra notification. This is acceptable; no need to introduce a deep-equal dependency.

## Implementation

### 1. New `SettingsWatcher` Class

**File**: `packages/cli/src/config/settingsWatcher.ts`

```typescript
export interface SettingsChangeEvent {
  scope: SettingScope;
  path: string;
  changeType: 'modified' | 'created' | 'deleted';
}

export type SettingsChangeListener = (
  events: SettingsChangeEvent[],
) => void | Promise<void>;

export class SettingsWatcher {
  private readonly settings: LoadedSettings;
  private readonly watchers: Map<SettingScope, FSWatcher> = new Map();
  // 'bootstrap' = watching parent for `.qwen`; 'target' = watching `.qwen`
  private readonly watchStage: Map<SettingScope, 'bootstrap' | 'target'> =
    new Map();
  // Monotonic token per scope; bumped on promote/demote to void stale callbacks
  private readonly watchGeneration: Map<SettingScope, number> = new Map();
  private readonly changeListeners: Set<SettingsChangeListener> = new Set();
  private refreshTimer: NodeJS.Timeout | null = null;
  private pendingScopeChanges: Set<SettingScope> = new Set();
  private processing: boolean = false; // serialization guard
  private started: boolean = false;

  static readonly DEBOUNCE_MS = 300;
  static readonly LISTENER_TIMEOUT_MS = 30_000;
}
```

**Core Methods**:

#### `startWatching()`

- Iterates both User and Workspace scopes
- Branches on **directory** existence: watch `.qwen` directly if it exists, otherwise bootstrap-watch the parent (see [Lazy Directory Handling](#lazy-directory-handling-never-create-qwen-at-startup))
- **Never** creates the directory — no `mkdirSync`
- `ignoreInitial: true`, `depth: 0` throughout
- Not called in bare mode

```typescript
startWatching(): void {
  if (this.started) return;
  this.started = true;

  for (const { scope, settingsPath } of this.getScopePaths()) {
    if (!settingsPath) continue;
    const dir = path.dirname(settingsPath);
    // Never create the directory; settings persistence (saveSettings) owns that.
    if (fs.existsSync(dir)) {
      this.watchTargetDir(scope, settingsPath);
    } else {
      this.watchParentForDir(scope, settingsPath);
    }
  }
}
```

`watchTargetDir` is the parent-directory + strict-basename watcher described above (it also demotes back to a bootstrap watcher if `.qwen` itself is removed). `watchParentForDir` arms the `.qwen`-only bootstrap watcher and promotes once `.qwen` appears:

```typescript
private watchParentForDir(scope: SettingScope, settingsPath: string): void {
  const dir = path.dirname(settingsPath);
  const parentDir = path.dirname(dir);
  const dirBasename = path.basename(dir); // ".qwen"
  const gen = this.bumpGeneration(scope);

  const watcher = watchFs(parentDir, {
    ignoreInitial: true,
    depth: 0,
    ignored: (filePath: string) =>
      filePath !== parentDir && path.basename(filePath) !== dirBasename,
  })
    .on('all', (_event: string, changedPath: string) => {
      if (this.watchGeneration.get(scope) !== gen) return; // stale callback
      if (path.basename(changedPath) !== dirBasename) return;
      void this.promoteScope(scope, settingsPath);
    })
    .on('error', (error: unknown) => {
      debugLogger.warn(`Settings bootstrap watcher error for ${parentDir}:`, error);
    });

  this.watchers.set(scope, watcher);
  this.watchStage.set(scope, 'bootstrap');

  // TOCTOU guard: `.qwen` may have appeared between the existence check and here.
  if (fs.existsSync(dir)) void this.promoteScope(scope, settingsPath);
}

private async promoteScope(scope: SettingScope, settingsPath: string): Promise<void> {
  if (this.watchStage.get(scope) !== 'bootstrap') return; // guard double-promote
  await this.replaceWatcher(scope); // bumps generation + awaits async close()
  if (!this.started) return;
  this.watchTargetDir(scope, settingsPath);
  this.scheduleRefresh(scope); // pick up a settings.json already inside .qwen
}
```

#### `stopWatching()` — Idempotent shutdown

```typescript
stopWatching(): void {
  if (!this.started) return;
  this.started = false;
  for (const [, watcher] of this.watchers) {
    watcher.close().catch((err) => debugLogger.warn('Watcher close error:', err));
  }
  this.watchers.clear();
  if (this.refreshTimer) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
  this.pendingScopeChanges.clear();
}
```

#### `scheduleRefresh(scope)` — 300ms debounce + scope accumulation

```typescript
private scheduleRefresh(scope: SettingScope): void {
  this.pendingScopeChanges.add(scope);
  if (this.refreshTimer) clearTimeout(this.refreshTimer);
  this.refreshTimer = setTimeout(() => {
    this.refreshTimer = null;
    void this.drainPendingChanges();
  }, SettingsWatcher.DEBOUNCE_MS);
}
```

#### `drainPendingChanges()` — Serialized processing to prevent re-entrancy

```typescript
private async drainPendingChanges(): Promise<void> {
  if (this.processing) return; // previous round still running; it will drain on exit
  this.processing = true;
  try {
    while (this.pendingScopeChanges.size > 0) {
      const scopes = new Set(this.pendingScopeChanges);
      this.pendingScopeChanges.clear();
      await this.handleChange(scopes);
    }
  } finally {
    this.processing = false;
  }
}
```

#### `handleChange(scopes)` — Reload + semantic diff + notification

```typescript
private async handleChange(changedScopes: Set<SettingScope>): Promise<void> {
  const events: SettingsChangeEvent[] = [];

  for (const scope of changedScopes) {
    const file = this.settings.forScope(scope);

    // Snapshot the current in-memory state before reload (includes setValue() mutations)
    const beforeSettings = JSON.stringify(file.settings);
    const existedBefore = file.rawJson !== undefined;

    // reloadScopeFromDisk has internal try/catch; on parse failure it preserves old state
    this.settings.reloadScopeFromDisk(scope);

    const afterSettings = JSON.stringify(file.settings);
    const existsNow = file.rawJson !== undefined;

    // Semantic diff: only notify when content actually changed
    // Self-write suppression: setValue() already updated memory → reload matches → no notification
    if (afterSettings === beforeSettings) continue;

    events.push({
      scope,
      path: file.path,
      changeType: !existedBefore && existsNow ? 'created'
                : existedBefore && !existsNow ? 'deleted'
                : 'modified',
    });
  }

  if (events.length > 0) {
    await this.notifyListeners(events);
  }
}
```

#### `notifyListeners(events)` — `Promise.allSettled()` + 30s timeout

Reuses the SkillManager listener notification pattern (`packages/core/src/skills/skill-manager.ts:188-236`): each listener is wrapped in a 30s timeout race, executed in parallel via `Promise.allSettled`, failures don't propagate.

#### `addChangeListener(listener)` — Returns an unsubscribe function

### 2. Modifications to `LoadedSettings`

**File**: `packages/cli/src/config/settings.ts`

**No modifications needed**. The semantic diff mechanism is entirely self-contained within the watcher. `setValue()` synchronously updates memory → `saveSettings()` writes to disk → watcher triggers → `reloadScopeFromDisk()` reloads → diff comparison finds identical content → no notification. The chain closes naturally.

### 3. Config Integration (Minimal Interface)

**File**: `packages/core/src/config/config.ts`

Add to `ConfigParameters`:

```typescript
/** Lifecycle handle for an external file watcher. Stopped during shutdown. */
settingsWatcher?: { stopWatching(): void };
```

In `Config.shutdown()`, stop the watcher **before** the `initialized` check:

```typescript
async shutdown(): Promise<void> {
  try {
    // Stop the external watcher regardless of initialization state
    this.settingsWatcher?.stopWatching();

    if (!this.initialized) return;
    // ... remaining cleanup logic ...
  }
}
```

**No settingsChangeListeners are added to Config**. Change event dispatching is handled entirely in the CLI layer, where listeners directly call core refresh methods (e.g., `skillManager.refreshCache()`, `toolRegistry.restartMcpServers()`). This keeps core unaware of settings change semantics.

### 4. Startup Wiring

**File**: `packages/cli/src/gemini.tsx`

After `loadSettings()` and `loadCliConfig()`:

```typescript
// Create watcher (skip in bare mode)
const settingsWatcher = isBareMode(argv.bare) ? undefined : new SettingsWatcher(settings);
settingsWatcher?.startWatching();

// Pass watcher lifecycle handle when loading CLI config
const config = await loadCliConfig(settings.merged, argv, ..., {
  settingsWatcher,
});

// Register change listener (future sub-tasks will add actual refresh logic here)
settingsWatcher?.addChangeListener(async (events) => {
  debugLogger.info('Settings changed:', events.map(e => `${e.scope}:${e.changeType}`));
  // Sub-tasks 2-6 will add:
  // - skillManager.refreshCache()
  // - toolRegistry.restartMcpServers()
  // - clearAllCaches()
  // - needsRefresh flag
});
```

**`loadCliConfig` signature change** (`packages/cli/src/config/config.ts`): Add an optional parameter to pass `settingsWatcher` to `ConfigParameters`.

## Edge Case Handling

| Scenario                                 | Handling                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `.qwen` directory doesn't exist          | **Never created.** Bootstrap-watch the parent (`depth: 0`, `.qwen`-only filter), promote once `.qwen` appears |
| `.qwen` created after startup            | Bootstrap watcher catches `addDir`, promotes to a target watcher + schedules a refresh                        |
| `.qwen` deleted after promotion          | Target watcher catches `unlinkDir` → demotes back to a parent bootstrap watcher                               |
| File deleted                             | `reloadScopeFromDisk` detects `!existsSync`, resets to `{}`, diff triggers `deleted` event                    |
| File created after startup (dir existed) | Directory watcher catches `add` event, `reloadScopeFromDisk` reads the new file                               |
| Stale callback during promote/demote     | Per-scope generation token makes the closing watcher's in-flight callback a no-op (no watcher stacking)       |
| Editor atomic writes                     | Directory watching + strict basename filtering (excludes `.tmp`/`.orig`) + 300ms debounce coalescing          |
| `.tmp`/`.orig` file events               | Basename filter exact-matches `settings.json`, all other filenames are ignored                                |
| Self-write (`setValue` → `saveSettings`) | Semantic diff: reload content matches in-memory snapshot → no notification                                    |
| Self-write concurrent with external edit | External edit changes content → diff detects the change → correctly notifies                                  |
| Format/comment-only changes              | `reloadScopeFromDisk` resolves settings without comments → diff matches → no notification                     |
| Duplicate chokidar events                | Debounce coalescing + semantic diff provide dual protection                                                   |
| `QWEN_HOME` redirect                     | `getUserSettingsPath()` already resolves the path; watcher uses the resolved path                             |
| Bare mode                                | `startWatching()` is never called, zero overhead                                                              |
| Watcher creation failure                 | Exception caught, warning logged, that scope has no real-time detection but functionality is unaffected       |
| `reloadScopeFromDisk` parse failure      | Internal try/catch (`settings.ts:501`) preserves old state → before/after diff matches → no notification      |
| Key order change (no value change)       | `JSON.stringify` is sensitive to key order; may produce one harmless extra notification                       |
| Config initialization failure            | `shutdown()` stops watcher before `initialized` check, preventing leaks                                       |
| Re-entrancy (listener still running)     | `processing` flag + `drainPendingChanges` loop serializes processing                                          |
| Invalid JSON                             | `reloadScopeFromDisk` internal try/catch preserves old state                                                  |

## Performance Analysis

- At most 1 watcher per scope (≤ 2 total), each at `depth: 0` — minimal file descriptor overhead; promote/demote swap watchers, never stack them
- `depth: 0` means **no recursive walk** of the project tree, even for the parent bootstrap watcher in a large monorepo. Cost is bounded to the parent dir's direct children: unrelated top-level churn wakes chokidar for one `readdir` + `ignored` filter pass (`O(top-level entries)`) before the event is suppressed — never a recursive scan
- 300ms debounce ensures rapid editor saves don't trigger multiple reloads
- `reloadScopeFromDisk` uses synchronous `readFileSync`, < 1ms per call
- `JSON.stringify` comparison is O(n) but settings objects are typically < 10KB; no additional snapshot storage needed
- Listener notification runs in parallel via `Promise.allSettled`
- No polling — purely event-driven

## Files to Create/Modify

**New files**:

- `packages/cli/src/config/settingsWatcher.ts` — watcher class
- `packages/cli/src/config/settingsWatcher.test.ts` — unit tests

**Modified files**:

- `packages/core/src/config/config.ts` — add `settingsWatcher` field to `ConfigParameters`, call `stopWatching()` before `initialized` check in `Config.shutdown()`
- `packages/cli/src/config/config.ts` (`loadCliConfig`) — add optional parameter to pass `settingsWatcher`
- `packages/cli/src/gemini.tsx` — instantiate watcher + wiring

**No modifications needed**: `packages/cli/src/config/settings.ts` (semantic diff is self-contained and requires no cooperation from `LoadedSettings`)

## Test Plan

### Unit Tests (`settingsWatcher.test.ts`)

Mock chokidar (reusing the `skill-manager.test.ts` mock pattern):

1. **Lifecycle**: `startWatching` creates watchers, `stopWatching` closes watchers, both are idempotent
2. **Path filtering**: Only `settings.json` basename events trigger refresh; `.tmp`/`.orig`/other files are ignored
3. **Debouncing**: Multiple rapid events coalesce into one reload (`vi.useFakeTimers()`)
4. **Semantic diff**: Unchanged content → listener not called; changed content → listener called with correct events
5. **Self-write suppression**: `setValue()`-triggered watcher events are naturally filtered by identical diff
6. **Serialization**: New events during `handleChange` are accumulated, drained after processing completes
7. **Error isolation**: chokidar errors don't crash; listener exceptions don't affect other listeners; `reloadScopeFromDisk` failures are caught
8. **Listener timeout**: 30s timeout protection
9. **Lazy directory watching**: when `.qwen` is missing, `mkdirSync` is never called; a bootstrap watcher is armed on the parent and its `ignored` predicate allows only the `.qwen` entry
10. **Promote / TOCTOU**: `.qwen` appearing (via `addDir` or the post-arm re-check) closes the bootstrap watcher and opens a target watcher on `.qwen` + schedules a refresh
11. **Demote / re-create**: removing `.qwen` (`unlinkDir`) re-bootstraps on the parent; a subsequent re-create promotes again
12. **Generation guard**: a stale callback from an already-closed bootstrap watcher does not create a second target watcher

### Regression Verification

```bash
cd packages/cli && npx tsc --noEmit
cd packages/core && npx tsc --noEmit
cd packages/cli && npx vitest run src/config/
cd packages/core && npx vitest run src/config/
```

### Manual Verification

Edit `~/.qwen/settings.json` during a running session and observe debug log output for change events.

---

## Follow-up Sub-task: Suppress Events for Restart-Required & Sensitive Settings

> **Status: suppression gate implemented; two schema flips still pending
> research.** Sub-task 1 above emitted a single `SettingsChangeEvent` per scope
> for _any_ semantic change. This follow-up adds a filter so that changes
> confined to settings that cannot truly take effect without a restart — or that
> are sensitive (credentials) — do **not** notify listeners.
>
> - **Done:** the `requiresRestart`-based suppression gate in
>   `SettingsWatcher.handleChange()` plus unit tests (see Mechanism below).
> - **Pending:** the two `requiresRestart` schema corrections
>   (`modelProviders` → `true`, `permissions.*` → keep hot-reloadable), each
>   gated on verifying the runtime read path first.

### Motivation

Some settings are read exactly once during process startup (`Config.initialize()`,
content-generator/client construction, child-process spawning, Node runtime
flags). Examples the user explicitly called out: **API tokens, `env`, and model
providers**. Emitting a hot-reload event for these is actively misleading — the
listener would "refresh" but the new value would not actually apply until the
user restarts `qwen-code`. Sensitive values (credentials) additionally should
not be re-plumbed through a running session.

### Decision: Reuse the schema's `requiresRestart` flag (single source of truth)

`settingsSchema.ts` already declares `requiresRestart: boolean` on **every** key,
and `packages/cli/src/utils/settingsUtils.ts` already exposes the lookups:

- `requiresRestart(key: string): boolean` — flag for a dot-path key
- `getFlattenedSchema()` — full flattened `key → definition` map
- `getRestartRequiredSettings()` — all keys with `requiresRestart: true`

We will **reuse this flag as the suppression signal** rather than maintaining a
separate hand-curated denylist (which would inevitably drift from the schema).
`requiresRestart: true` already means precisely "won't take effect without a
restart", which is exactly the condition under which an event should be
suppressed.

### Mechanism (implemented in `SettingsWatcher.handleChange()`)

The old gate did a whole-file `JSON.stringify` diff and could not say _which_
keys changed. It is replaced by a leaf-level diff + per-key classification:

1. **`collectChangedKeys(before, after)`** snapshots the in-memory state before
   reload (`structuredClone`), then walks before/after and collects the dot-path
   of every leaf whose value differs. Plain objects are recursed; arrays and
   primitives are compared whole (matching schema array keys like
   `permissions.allow`). Added/removed keys surface as changed leaves, so
   file creation/deletion is covered without a separate existence check.
2. **`isRestartRequiredKey(path)`** resolves each changed path against the
   schema using the **longest schema key that is a prefix of (or equal to)** the
   path. Free-form object settings (`env`, `modelProviders`) are leaf schema
   keys, so `env.FOO` resolves to the `env` definition. Unknown keys default to
   **not** restart-required, so a change we cannot classify is never silently
   suppressed.
3. The scope notifies **only if at least one changed key is hot-reloadable**
   (`!isRestartRequiredKey`). If every changed key is restart-required, the
   scope produces no event.

`SettingsChangeEvent`'s shape is unchanged (still `{ scope, path, changeType }`);
carrying the surviving changed keys on the event is left as a possible later
enhancement. Self-write suppression (empty diff → no event), debounce,
serialization, and listener-timeout behavior are all unchanged.

### Two schema adjustments to research & apply

These two `requiresRestart` values must be corrected for the reuse approach to
behave as intended. **Each requires verifying the actual runtime read path
before flipping the flag.**

1. **`modelProviders`: `false` → `true`** (`settingsSchema.ts:294`)
   - Today it is marked `requiresRestart: false`, so under the reuse approach it
     would _not_ be suppressed — contradicting the requirement that provider
     changes not hot-reload.
   - Provider configuration (including per-provider `apiKey` / `baseUrl`) is
     consumed when the model client / content generator is built during startup.
   - **Research item:** confirm there is no runtime re-read of `modelProviders`
     (search content-generator / client construction). Expected outcome: the
     `false` is a latent bug; flip to `true`.

2. **`permissions.*`: keep hot-reloadable** (`settingsSchema.ts:1560`, whole
   subtree currently `requiresRestart: true`)
   - Permission rules (`deny > ask > allow`) are evaluated per tool call and are
     intended to be the settings users most want to take effect immediately.
   - The whole `permissions` subtree is `showInDialog: false`, so its
     `requiresRestart` flag currently has **no UI meaning** — strong hint the
     `true` was a default rather than a deliberate "needs restart" decision, so
     the blast radius of flipping it is low.
   - **Research item:** confirm the runtime re-reads permissions live (e.g. via
     `config.getXxx()` at evaluation time) rather than from a startup snapshot.
     If confirmed, set the `permissions` subtree to `requiresRestart: false` so
     it is **not** suppressed by the reuse mechanism.

> Note: because `requiresRestart` is also surfaced in the settings UI / restart
> prompts, flipping these flags changes that behavior too. That is acceptable
> and arguably more correct, but should be called out in the PR description.

### Acceptance

- A change touching only restart-required/sensitive keys (`security.auth.*`,
  `env`, `modelProviders`, `mcpServers`, `proxy`, …) emits **no**
  `SettingsChangeEvent`.
- A change to a hot-reloadable key (`ui.*`, `model.name`, `permissions.*` once
  flipped, …) still emits an event.
- A mixed change (one restart-required key + one hot-reloadable key) still emits
  an event (the hot-reloadable part legitimately needs to refresh).
- An unknown (non-schema) key change still emits, rather than being silently
  suppressed.

Test status:

- **Done** — `settingsWatcher.test.ts` `restart-required suppression` block
  covers all-suppressed (`env`, `security.auth.apiKey`), all-allowed
  (`ui.theme`), mixed, and unknown-key cases.
- **Pending (with the schema flips)** — `settingsSchema.test.ts` assertions
  pinning the two corrected `requiresRestart` values, and a watcher test
  asserting `permissions.*` is no longer suppressed once flipped.
