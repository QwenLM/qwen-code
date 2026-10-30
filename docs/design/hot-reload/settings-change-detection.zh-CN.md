# 设置文件变更检测（Issue #3696 子任务 1）

[English](settings-change-detection.md) | [简体中文](settings-change-detection.zh-CN.md)

## 背景

提出这套基础设施时，Qwen Code 没有设置文件变更检测机制，用户修改 `settings.json` 后必须重启会话才能生效。本设计描述 #3696 热重载系统的基础设施层：自动检测设置文件变更并分发事件。

**范围**：本子任务只负责“检测文件变更 → 重载 → 通知监听器”。`Config` 在构造时复制了许多设置字段（`approvalMode`、`mcpServers`、`telemetry` 等），本子任务不会自动更新这些快照。只有实时读取 `LoadedSettings.merged` 的调用方（如 `useSettings()` hook、`disabledSkillNamesProvider`）会立即看到变更。其他子任务（MCP 重连、`/reload` 命令）负责把更新传递到 Config 内部状态。

## 架构决策

### 模块位置：`packages/cli/src/config/settingsWatcher.ts`

- `LoadedSettings` 和设置文件路径都位于 `packages/cli`。
- `reloadScopeFromDisk()` 是 `LoadedSettings` 的方法。
- core 包只接收最小生命周期接口 `{ stopWatching(): void }`，不导入 `SettingScope` 等 CLI 类型。
- 变更事件分发和下游刷新逻辑全部在 CLI 层接入。

### 监听策略：监听父目录并严格过滤路径

`writeWithBackupSync` 在本次调用独占的 `settings.json.write-*` 目录中暂存完整字节并复制旧设置，再通过一次替换 rename 发布。已有目标始终存在，但发布会替换其 inode。监听父目录（`depth: 0`）可检测替换以及后续文件创建或删除，不把监听绑定到旧 inode。按**精确 basename 匹配**过滤，只响应 `settings.json` 文件事件，忽略 `settings.json.write-*` 目录及其子文件、历史 `.tmp`/`.orig` 和编辑器临时文件。发布成功后尽力清理私有辅助文件；保存失败、进程中断或清理失败可能留下它们，watcher 必须忽略这些残留。发布与恢复契约参见[原子保存设置设计](../2026-09-30-atomic-settings-save.zh-CN.md)。

### 延迟目录处理：启动时不创建 `.qwen/`

> **明确避免启动时的文件系统副作用。** watcher 绝不能仅为了监听而创建 `<project>/.qwen/`（或 `~/.qwen/`）。早期实现对缺失设置目录调用 `mkdirSync({ recursive: true })`，导致普通非 bare 启动在从未使用 Qwen 设置的项目中也悄悄创建 `<project>/.qwen/`，污染工作区和 git status。目录创建只由设置持久化负责；用户实际写入设置时，`saveSettings()` 自行调用 `mkdirSync`。

为了在不创建目录、不递归项目树的前提下，检测会话期间新增的 `settings.json`，watcher 按每个 scope 的**目录**是否存在采用两阶段策略：

- **启动时 `.qwen` 已存在** → 直接监听该目录（`watchTargetDir`，即上述策略）。
- **`.qwen` 缺失** → **先监听父目录以引导建立监听**（`watchParentForDir`）：`chokidar.watch(parentDir, { depth: 0, ignoreInitial: true, ignored })`，其中 `ignored` 谓词 `(p) => p !== parentDir && basename(p) !== '.qwen'` 只允许 `.qwen` 条目通过，抑制其他顶层变动且从不递归。`.qwen` 出现后 watcher **提升**：关闭引导 watcher，在 `.qwen` 上创建目标 watcher，并安排一次刷新以读取其中可能已存在的 `settings.json`。

健壮性细节：

- **TOCTOU 守卫**：设置引导 watcher（使用 `ignoreInitial`）后再次检查 `existsSync(dir)`；若 `.qwen` 在间隙中已创建，立即提升。
- **删除时降级**：若 `.qwen` 目录本身被删除（`unlinkDir`），目标 watcher 降级为父目录上的引导 watcher，以便捕获后续重建。
- **代次守卫**：chokidar 的 `close()` 是异步的，正在关闭的 watcher 所遗留的 `'all'` 回调可能重新触发提升，叠加 watcher。每个 scope 使用单调递增的代次标记，在每次提升、降级和 `stopWatching` 时递增，使过期回调成为空操作，保证每个 scope 最多一个活动 watcher。

### 变更检测：以语义差异作为主要去重机制

每次 watcher 触发时，先对**重载前的当前内存状态**进行快照（`JSON.stringify(file.settings)`），再调用 `reloadScopeFromDisk()` 重载，最后比较前后快照。只有语义内容确实改变时才通知监听器。

关键在于比较**重载前后**的内存状态，而不是历史存储快照。`setValue()` 在写磁盘前同步更新内存中的 `file.settings`，所以 watcher 触发重载时，内存已包含本次写入值：重载内容相同 → 无差异 → 不通知。

这自然抑制以下事件：

- 自写入的重复事件（`setValue()` 已更新内存，重载结果相同 → 无差异 → 不通知）。
- 仅格式或注释变更（解析后的设置不含注释）。
- 编辑器保存但内容未变。
- 重复 chokidar 事件。

已知限制：`JSON.stringify` 对键顺序敏感。用户手工重排 settings.json 的键而未修改值时，会产生一次无害的额外通知。该行为可接受，无需引入 deep-equal 依赖。

## 实现

### 1. 新增 `SettingsWatcher` 类

**文件**：`packages/cli/src/config/settingsWatcher.ts`

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

**核心方法**：

#### `startWatching()`

- 遍历 User 和 Workspace 两个 scope。
- 按**目录**是否存在分支：`.qwen` 存在则直接监听，否则先监听父目录（参见[延迟目录处理](#延迟目录处理启动时不创建-qwen)）。
- **从不**创建目录，不调用 `mkdirSync`。
- 全程使用 `ignoreInitial: true`、`depth: 0`。
- bare mode 中不调用。

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

`watchTargetDir` 是上述父目录与严格 basename 监听器；`.qwen` 本身被移除时也会降级为引导 watcher。`watchParentForDir` 设置仅关注 `.qwen` 的引导 watcher，并在 `.qwen` 出现后提升：

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

#### `stopWatching()` — 幂等关闭

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

#### `scheduleRefresh(scope)` — 300ms 防抖并累积 scope

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

#### `drainPendingChanges()` — 串行处理，避免重入

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

#### `handleChange(scopes)` — 重载、语义比较与通知

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

#### `notifyListeners(events)` — `Promise.allSettled()` 与 30s 超时

复用 SkillManager 的监听器通知模式（`packages/core/src/skills/skill-manager.ts:188-236`）：每个监听器都包装成与 30s 超时竞争的任务，通过 `Promise.allSettled` 并行执行，失败不向外传播。

#### `addChangeListener(listener)` — 返回取消订阅函数

### 2. `LoadedSettings` 的修改

**文件**：`packages/cli/src/config/settings.ts`

**无需修改**。语义差异机制完全在 watcher 内部实现。`setValue()` 同步更新内存 → `saveSettings()` 写磁盘 → watcher 触发 → `reloadScopeFromDisk()` 重载 → 比较得到内容相同 → 不通知，该链路自然闭合。

### 3. 接入 Config（最小接口）

**文件**：`packages/core/src/config/config.ts`

在 `ConfigParameters` 中增加：

```typescript
/** Lifecycle handle for an external file watcher. Stopped during shutdown. */
settingsWatcher?: { stopWatching(): void };
```

在 `Config.shutdown()` 中，于 `initialized` 检查**之前**停止 watcher：

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

**不向 Config 增加 settingsChangeListeners**。变更事件完全由 CLI 层分发，监听器直接调用 core 刷新方法（如 `skillManager.refreshCache()`、`toolRegistry.restartMcpServers()`）。这样 core 不需要理解设置变更语义。

### 4. 启动时接入

**文件**：`packages/cli/src/gemini.tsx`

在 `loadSettings()` 和 `loadCliConfig()` 之后：

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

**`loadCliConfig` 签名变更**（`packages/cli/src/config/config.ts`）：增加可选参数，把 `settingsWatcher` 传给 `ConfigParameters`。

## 边界情况处理

| 场景                                  | 处理方式                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `.qwen` 目录不存在                    | **从不创建。** 先监听父目录（`depth: 0`、仅允许 `.qwen` 的过滤），出现后提升   |
| 启动后创建 `.qwen`                    | 引导 watcher 捕获 `addDir`，提升为目标 watcher 并安排刷新                      |
| 提升后删除 `.qwen`                    | 目标 watcher 捕获 `unlinkDir`，降级为父目录上的引导 watcher                    |
| 删除文件                              | `reloadScopeFromDisk` 检测 `!existsSync`，重置为 `{}`，差异触发 `deleted` 事件 |
| 启动后创建文件（目录已存在）          | 目录 watcher 捕获 `add`，`reloadScopeFromDisk` 读取新文件                      |
| 提升/降级期间的过期回调               | 每个 scope 的代次标记使正在关闭的 watcher 回调成为空操作，不叠加 watcher       |
| 编辑器原子写入                        | 监听目录、严格 basename 过滤（排除 `.tmp`/`.orig`），并以 300ms 防抖合并       |
| 保存辅助文件及 `.tmp`/`.orig` 事件    | basename 过滤精确匹配 `settings.json`，忽略其他名称和私有目录内的文件          |
| 自写入（`setValue` → `saveSettings`） | 语义比较：重载内容与内存快照相同，不通知                                       |
| 自写入与外部编辑并发                  | 外部编辑改变内容，比较检测差异并正确通知                                       |
| 仅格式/注释变化                       | `reloadScopeFromDisk` 解析后的设置不含注释，比较相同，不通知                   |
| 重复 chokidar 事件                    | 防抖合并与语义比较提供双重保护                                                 |
| `QWEN_HOME` 重定向                    | `getUserSettingsPath()` 已解析路径，watcher 使用解析后的路径                   |
| bare mode                             | 从不调用 `startWatching()`，零开销                                             |
| watcher 创建失败                      | 捕获异常并记录警告；该 scope 无实时检测，但其他功能不受影响                    |
| `reloadScopeFromDisk` 解析失败        | 内部 try/catch（`settings.ts:501`）保留旧状态，前后比较相同，不通知            |
| 键顺序变化但值未变                    | `JSON.stringify` 对顺序敏感，可能产生一次无害的额外通知                        |
| Config 初始化失败                     | `shutdown()` 在 `initialized` 检查前停止 watcher，避免泄漏                     |
| 重入（监听器仍在运行）                | `processing` 与 `drainPendingChanges` 循环使处理串行化                         |
| 无效 JSON                             | `reloadScopeFromDisk` 内部 try/catch 保留旧状态                                |

## 性能分析

- 每个 scope 最多 1 个 watcher（总数 ≤ 2），均为 `depth: 0`，文件描述符开销最小；提升/降级交换 watcher，不叠加。
- `depth: 0` 意味着**不递归遍历**项目树，即使大型 monorepo 的父目录引导 watcher 也一样。成本限于父目录直接子项：无关顶层变动唤醒 chokidar，执行一次 `readdir` 和 `ignored` 过滤（`O(top-level entries)`）后抑制事件，从不递归扫描。
- 300ms 防抖避免连续编辑器保存引发多次重载。
- `reloadScopeFromDisk` 使用同步 `readFileSync`，每次 < 1ms。
- `JSON.stringify` 比较为 O(n)，设置对象通常 < 10KB，不额外存储快照。
- 通过 `Promise.allSettled` 并行通知监听器。
- 不轮询，完全依赖事件。

## 待创建或修改的文件

**新增文件**：

- `packages/cli/src/config/settingsWatcher.ts` — watcher 类。
- `packages/cli/src/config/settingsWatcher.test.ts` — 单元测试。

**修改文件**：

- `packages/core/src/config/config.ts` — 向 `ConfigParameters` 增加 `settingsWatcher` 字段，并在 `Config.shutdown()` 的 `initialized` 检查前调用 `stopWatching()`。
- `packages/cli/src/config/config.ts`（`loadCliConfig`）— 增加用于传递 `settingsWatcher` 的可选参数。
- `packages/cli/src/gemini.tsx` — 实例化并接入 watcher。

**无需修改**：`packages/cli/src/config/settings.ts`，语义比较独立实现，不需要 `LoadedSettings` 配合。

## 测试计划

### 单元测试（`settingsWatcher.test.ts`）

mock chokidar，复用 `skill-manager.test.ts` 的模式：

1. **生命周期**：`startWatching` 创建 watcher，`stopWatching` 关闭，两者均幂等。
2. **路径过滤**：只有 `settings.json` basename 事件触发刷新；忽略 `settings.json.write-*` 目录、其子文件、`.tmp`/`.orig` 和其他文件。
3. **防抖**：多次连续事件合并为一次重载（`vi.useFakeTimers()`）。
4. **语义比较**：内容未变不调用监听器，内容变化则携带正确事件调用。
5. **自写入抑制**：`setValue()` 引起的 watcher 事件因比较相同而自然过滤。
6. **串行化**：`handleChange` 期间出现的新事件累积，并在处理后排空。
7. **错误隔离**：chokidar 错误、监听器异常不会引起崩溃或影响其他监听器；捕获 `reloadScopeFromDisk` 失败。
8. **监听器超时**：30s 超时保护。
9. **延迟监听目录**：`.qwen` 缺失时不调用 `mkdirSync`；在父目录设置引导 watcher，`ignored` 谓词仅允许 `.qwen` 条目。
10. **提升/TOCTOU**：`.qwen` 出现（`addDir` 或设置监听后的复查）时关闭引导 watcher，在 `.qwen` 上打开目标 watcher 并安排刷新。
11. **降级/重建**：删除 `.qwen`（`unlinkDir`）后重新引导监听父目录；后续重建再次提升。
12. **代次守卫**：已关闭的引导 watcher 的过期回调不创建第二个目标 watcher。

### 回归验证

```bash
cd packages/cli && npx tsc --noEmit
cd packages/core && npx tsc --noEmit
cd packages/cli && npx vitest run src/config/
cd packages/core && npx vitest run src/config/
```

### 人工验证

在会话运行期间编辑 `~/.qwen/settings.json`，观察 debug 日志中的变更事件。

---

## 后续子任务：抑制需要重启或敏感设置的事件

> **状态：抑制守卫已实现；两项 schema 标记修改仍待调查。** 上述子任务 1 对任意语义变化为每个 scope 发出一个 `SettingsChangeEvent`。本后续任务增加过滤，使仅涉及无法在重启前生效的设置，或敏感设置（凭据）的变更不通知监听器。
>
> - **已完成**：`SettingsWatcher.handleChange()` 中基于 `requiresRestart` 的抑制守卫及单测，参见下述机制。
> - **待完成**：两项 `requiresRestart` schema 修正（`modelProviders` → `true`、`permissions.*` → 保持可热重载），均须先验证运行时读取路径。

### 动机

某些设置只在进程启动时读取一次，如 `Config.initialize()`、content-generator/client 构造、子进程启动和 Node 运行时标志。用户明确举出的例子包括 **API tokens、`env` 和 model providers**。对这些设置发出热重载事件会误导用户：监听器虽“刷新”，新值却要等重启 `qwen-code` 才真正生效。敏感值（凭据）也不应重新接入正在运行的会话。

### 决策：复用 schema 的 `requiresRestart` 标记作为唯一事实来源

`settingsSchema.ts` 已对**每个**键声明 `requiresRestart: boolean`，`packages/cli/src/config/settingsUtils.ts` 已提供查询方法：

- `requiresRestart(key: string): boolean` — 点分路径键对应的标记。
- `getFlattenedSchema()` — 完整的扁平化 `key → definition` 映射。
- `getRestartRequiredSettings()` — 所有 `requiresRestart: true` 的键。

**复用该标记作为抑制信号**，无需维护会与 schema 偏离的单独人工拒绝列表。`requiresRestart: true` 本来就表示“不重启不会生效”，正是应抑制事件的条件。

### 机制（已在 `SettingsWatcher.handleChange()` 中实现）

旧守卫通过整文件 `JSON.stringify` 比较，无法指出哪些键改变。现改为叶节点比较与逐键分类：

1. **`collectChangedKeys(before, after)`** 对重载前内存状态做快照（`structuredClone`），遍历前后状态，收集值发生变化的每个叶节点的点分路径。递归普通对象，整体比较数组和原始值（对应 `permissions.allow` 等 schema 数组键）。新增或删除键均表现为叶节点变化，因此不需要额外存在性检查即可覆盖文件创建和删除。
2. **`isRestartRequiredKey(path)`** 采用**等于该路径或为其前缀的最长 schema 键**解析每个变化路径。自由对象设置（`env`、`modelProviders`）是 schema 叶键，故 `env.FOO` 对应 `env` 定义。未知键默认**不**要求重启，不静默抑制无法分类的变更。
3. scope **仅当至少一个变化键可热重载**（`!isRestartRequiredKey`）时通知。所有变化键均要求重启时，不产生事件。

`SettingsChangeEvent` 形状不变，仍为 `{ scope, path, changeType }`；在事件中携带过滤后变化键可作为后续增强。自写入抑制（空差异 → 无事件）、防抖、串行化和监听器超时均不变。

### 待调查并应用的两项 schema 调整

要让复用方案按预期工作，需修正这两个 `requiresRestart` 值。**每项修改标记前均须验证实际运行时读取路径。**

1. **`modelProviders`：`false` → `true`**（`settingsSchema.ts:294`）
   - 当前为 `requiresRestart: false`，复用后不会抑制，与 provider 变更不热重载的要求矛盾。
   - provider 配置（含每个 provider 的 `apiKey` / `baseUrl`）在启动时构建模型 client/content generator 时使用。
   - **调查项**：搜索 content-generator/client 构造，确认运行时不会重新读取 `modelProviders`。预期结果：`false` 为潜在 bug，改为 `true`。
2. **`permissions.*`：保持可热重载**（`settingsSchema.ts:1560`，整个子树当前为 `requiresRestart: true`）
   - 权限规则（`deny > ask > allow`）每次工具调用时计算，也是用户最希望立即生效的设置。
   - 整个 `permissions` 子树为 `showInDialog: false`，其 `requiresRestart` 当前没有 UI 意义。这强烈暗示 `true` 是默认值而非刻意的“需要重启”决策，修改影响较小。
   - **调查项**：确认运行时实时重新读取权限（例如求值时调用 `config.getXxx()`），而非使用启动快照。确认后把 `permissions` 子树设为 `requiresRestart: false`，使复用机制不抑制它。

> 注意：`requiresRestart` 也用于设置 UI 和重启提示，所以修改标记也会改变这些行为。该改变可接受且更准确，但应在 PR 描述中说明。

### 验收标准

- 只修改需要重启或敏感键（`security.auth.*`、`env`、`modelProviders`、`mcpServers`、`proxy` 等）时，**不**发出 `SettingsChangeEvent`。
- 修改可热重载键（`ui.*`、`model.name`、修改标记后的 `permissions.*` 等）仍发出事件。
- 混合变更（一个要求重启键和一个可热重载键）仍发出事件，因为可热重载部分需要刷新。
- 修改未知（非 schema）键仍发出事件，不静默抑制。

测试状态：

- **已完成**：`settingsWatcher.test.ts` 的 `restart-required suppression` 测试组覆盖全部抑制（`env`、`security.auth.apiKey`）、全部允许（`ui.theme`）、混合及未知键情形。
- **待完成（与 schema 标记修改一起）**：`settingsSchema.test.ts` 固定两项修正后的 `requiresRestart` 值，以及 watcher 测试断言修改标记后不再抑制 `permissions.*`。
