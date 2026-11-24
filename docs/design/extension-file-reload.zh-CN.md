# 扩展文件重载设计

[English](extension-file-reload.md) | [简体中文](extension-file-reload.zh-CN.md)

## 背景

扩展变更目前从两条路径进入运行时。用户在界面中执行启用、停用、安装、卸载和更新等操作时，都会经过 `ExtensionManager`，因此可以直接刷新运行时状态。用户在界面操作之外编辑已安装扩展的 `skills/`、`commands/`、`workflows/`、`hooks/` 或 `qwen-extension.json` 时，没有对应的单一界面操作负责处理，所以需要由文件监听器提供刷新路径。

本设计补上文件监听路径，同时保留直接变更路径。分层方式与 MCP、LSP 热重载设计一致：

- CLI 决定文件系统变更何时触发重载或用户提示；
- Core 负责刷新扩展运行时状态；
- UI 组件使用小型事件／状态对象，不直接轮询扩展文件。

关键限制是，不同扩展文件在运行中安全生效的方式不同。内容类能力文件可以自动刷新；包级变更则应提示用户执行 `/reload-plugins`，让扩展缓存、运行时工具、hook、上下文文件和斜杠命令列表从同一份一致快照重新建立。

## 当前代码评估

- `ExtensionManager` 已经加载扩展清单、约定目录、安装元数据、启用状态、市场来源状态、命令、skill、agent、workflow、hook、MCP 声明和 LSP 声明。
- UI 扩展操作在改变运行时相关状态后，已经调用 `ExtensionManager.refreshTools()`。这条路径会通过 Core 刷新 MCP、skill、subagent、hook 和分层记忆。
- 斜杠命令补全由加载器交给 `CommandService.create()` 构建。扩展命令、扩展 workflow 和由 skill 提供的斜杠命令，只有在 `reloadCommands()` 重建命令服务后才会出现。
- Skill 和 subagent 管理器都有缓存刷新 API，但这些缓存与斜杠命令补全彼此分开。
- Hook 由 `HookSystem` 和 `HookRegistry` 管理。重建整个 hook 系统会丢失 agent 作用域的临时 hook，因此重载只能针对已配置的 hook。
- `SettingsWatcher` 以及已有的 MCP/LSP 监听器不会覆盖已安装扩展的包内容。扩展文件需要自己的监听器。
- 链接扩展可以位于用户扩展目录之外，只监听 `~/.qwen/extensions` 无法覆盖这些扩展的日常开发流程。

## 目标

让扩展变更在当前交互会话中生效，不需要完整重启 CLI：

- 让 UI 发起的扩展变更立即生效；
- 检测用户扩展目录中的手动编辑、新增和删除；
- 检测链接扩展源目录中的编辑；
- 自动刷新 `commands/`、`skills/`、`agents/` 和 `workflows/` 下的内容级能力文件；
- 对包级变更提示用户执行 `/reload-plugins`；
- 在刷新运行时时重新加载 hook，同时保留 agent 作用域的 hook；
- 让命令、skill 和 workflow 变更及时反映在斜杠命令补全中；
- 抑制 Qwen 自己执行扩展变更时产生的监听器通知；
- 显示 MCP 和 hook 重载失败，避免发出误导性的成功摘要。

## 非目标

- 不让 hook 文件编辑走内容自动刷新。Hook 行为会影响命令执行和涉及安全的工作流程，因此 hook 编辑按包级变更处理。
- 不热重载任意扩展文件。未知文件会被忽略，除非它们是已解析的上下文文件。
- 不增加按扩展逐个重启 MCP 的能力。本设计继续使用现有的 MCP 重新初始化入口。
- 不改变扩展发现、转换、安装来源解析或市场语义。
- 不支持运行时切换 bare mode。Bare mode 下不会启动监听器。

## 代码结构

实现按层拆分。

```text
packages/core/src/extension/
  extensionManager.ts
    扩展变更生命周期事件。
    UI 变更方法仍然负责直接刷新运行时。

  extension-runtime-refresh.ts
    扩展变更使用的 Core 运行时刷新契约。

packages/core/src/hooks/
  hookRegistry.ts
    重新加载已配置的 hook，同时保留 agent 作用域的 hook。

  hookSystem.ts
    供扩展运行时刷新使用的公开 hook 重载接口。

packages/cli/src/config/
  extension-refresh-state.ts
    供监听器、斜杠处理器和重载命令共用的事件／状态对象。

  extension-file-watcher.ts
    文件系统监听器和路径分类器。

  extension-runtime-reload.ts
    /reload-plugins 和内容自动刷新使用的 CLI 重载辅助函数。

packages/cli/src/ui/commands/
  reload-plugins-command.ts
    用于包级扩展重载的交互式斜杠命令。

packages/cli/src/ui/hooks/
  slashCommandProcessor.ts
    处理过期通知和内容自动刷新的事件消费者。

packages/cli/src/
  gemini.tsx
  ui/AppContainer.tsx
  ui/startInteractiveUI.tsx
    ExtensionRefreshState 和监听器的启动及依赖注入。
```

## 设计

### 1. 分类文件系统变更

`ExtensionFileWatcher` 将 chokidar 事件映射为三种结果之一：

```ts
type RefreshAction = 'auto' | 'stale' | false;
```

分类会保持保守。

| 路径类别                       | 动作    | 原因                                                                             |
| ------------------------------ | ------- | -------------------------------------------------------------------------------- |
| `commands/**`                  | `auto`  | 斜杠命令加载器可以从现有扩展缓存重建。                                           |
| `skills/**`                    | `auto`  | Skill 缓存和斜杠命令加载器可以刷新，不需要改变扩展包标识。                       |
| `agents/**`                    | `auto`  | Subagent 缓存可以刷新，不需要改变扩展包标识。                                    |
| `workflows/**`                 | `auto`  | 斜杠命令重载时，已保存的 workflow 命令加载器会重新读取 workflow。                |
| `hooks/**`                     | `stale` | Hook 执行行为应从一致的包快照重新加载。                                          |
| `qwen-extension.json`          | `stale` | 清单可能改变命令、skill、agent、workflow、hook、MCP、LSP、上下文文件名和元数据。 |
| `.qwen-extension-install.json` | `stale` | 安装元数据会影响链接源目录和扩展包标识。                                         |
| 已配置的上下文文件             | `stale` | 模型上下文可能发生变化，应显式重新加载。                                         |
| 扩展目录新增／删除             | `stale` | 已安装扩展的拓扑发生变化。                                                       |
| 顶层扩展配置文件               | `stale` | 启用状态、偏好或市场配置在 UI 变更路径之外发生变化。                             |
| 未知文件                       | 忽略    | 避免因构建产物或无关数据触发刷新。                                               |

用户安装的扩展和链接扩展源目录使用同一个分类器。对于链接源目录，监听器会先找到所属的链接扩展，再根据相对于该源目录的路径分类。

### 2. 监听用户扩展目录和链接扩展源目录

`ExtensionFileWatcher.startWatching()` 根据以下内容建立监听根目录：

1. 存在时使用 `Storage.getUserExtensionsDir()`；
2. 使用安装元数据中的活动链接扩展源路径；
3. 只有在用户扩展目录尚不存在时，才监听其父目录。

父目录启动监听器负责覆盖首次安装扩展，或 CLI 启动后手动创建扩展目录的情况。目录出现后，监听器会将扩展状态标记为过期，并在微任务中安排 `restartWatching()`。延后重启可以避免在 chokidar 仍在派发事件时关闭启动监听器。

监听器选项：

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

`followSymlinks: false` 可以避免扩展通过符号链接让 Qwen 监听任意外部路径。忽略过滤器会跳过 `node_modules`、`.git`、常见的编辑器备份文件、交换文件、临时文件和 `.DS_Store`。

### 3. 通过 ExtensionRefreshState 共享刷新状态

`ExtensionRefreshState` 是监听器、斜杠命令处理器和 `/reload-plugins` 共用的小型事件／状态原语。

关键方法：

```ts
markExtensionsChanged(reason?: string): boolean;
markExtensionContentChanged(reason?: string): boolean;
clearExtensionsChanged(): void;
notifyExtensionsReloadStarted(): void;
needsExtensionRefresh(): boolean;
beginSuppression(onSettle?: () => void): () => void;
suppressNotifications<T>(fn: () => T, onSettle?: () => void): T;
```

事件：

| 事件                      | 生产者                            | 消费者                     | 含义                                               |
| ------------------------- | --------------------------------- | -------------------------- | -------------------------------------------------- |
| `ExtensionContentChanged` | `ExtensionFileWatcher`            | `useSlashCommandProcessor` | 内容级文件发生变化，安排自动刷新。                 |
| `ExtensionRefreshNeeded`  | `ExtensionFileWatcher`            | `useSlashCommandProcessor` | 包级状态发生变化，提示用户执行 `/reload-plugins`。 |
| `ExtensionsReloadStarted` | `/reload-plugins`                 | `useSlashCommandProcessor` | 手动重载前取消待处理的内容刷新计时器。             |
| `ExtensionsReloaded`      | `/reload-plugins`、监听器重启路径 | 监听器和斜杠处理器         | 清除过期标记，并重启或取消待处理工作。             |

`markExtensionsChanged()` 会在状态清除前合并重复的过期通知。内容变更通知不会由这个状态对象去重，因为防抖和串行化由斜杠命令处理器负责。

### 4. 抑制程序化变更产生的监听器噪声

`ExtensionManager` 提供：

```ts
interface ExtensionMutationEvent {
  id: number;
  phase: 'start' | 'end';
  operation: string;
}

addMutationListener(listener: ExtensionMutationListener): () => void;
```

与运行时相关的变更方法会调用 `beginMutation()`，并在 `finally` 中始终发出匹配的结束事件。

会发出变更事件的方法：

- `enableExtension()`
- `disableExtension()`
- `installExtension()`
- `uninstallExtension()`
- `updateExtension()`
- `addSource()`
- `removeSource()`
- `setExtensionScope()`
- `setMcpServerDisabled()`

不会发出变更事件的方法：

- `toggleFavorite()`
- `markSourceUpdated()`

监听器在 `Map` 中保存 `变更 id -> 结束抑制回调`。安装可能在内部触发启用，不同变更也可能重叠，因此按 id 配对可以避免依赖栈顺序。

外层抑制深度回到零时，监听器会重启。这样可以在变更完成后刷新链接源路径、上下文文件名和活动扩展元数据。

### 5. 从 Core 刷新运行时状态

`refreshExtensionRuntime()` 是供扩展 UI 变更使用的 Core 侧运行时刷新入口。

刷新顺序如下：

1. `config.reinitializeMcpServers(config.getSettingsMcpServers())`
2. `config.getSkillManager()?.refreshCache()`
3. `config.getSubagentManager().refreshCache()`
4. `config.getHookSystem()?.reload()`
5. `config.refreshHierarchicalMemory()`

MCP 重新初始化先于其他步骤，因为 skill 和 subagent 工具描述可能依赖更新后的 MCP 工具列表。

Skill、subagent 和 hook 通过 `Promise.allSettled()` 运行，因此某一步骤失败不会阻止其他步骤执行。Hook 重载失败会先保存，等分层记忆尝试刷新后再重新抛出。这样可以显示 hook 失败，同时尽可能完成其他缓存刷新。

失败契约：

- MCP 失败立即向上传播，后续运行时步骤不会执行。
- Hook 重载失败会在并行刷新步骤和记忆刷新完成后传播。
- Skill 刷新失败会记录日志，并继续执行其他步骤。
- Subagent 刷新失败会记录日志，并继续执行其他步骤。
- 分层记忆刷新失败会记录日志，并继续执行其他步骤。

### 6. 使用 /reload-plugins 重载包级变更

`reloadPluginsRuntime()` 是斜杠命令使用的 CLI 侧运行时重载辅助函数：

```ts
async function reloadPluginsRuntime(options: {
  config: Config;
  reloadCommands?: () => void | Promise<void>;
}): Promise<ReloadPluginsSummary>;
```

流程：

1. `config.getExtensionManager().refreshCache()`
2. `config.getExtensionManager().refreshTools()`
3. `reloadCommands()`
4. 汇总活动扩展能力

摘要会统计活动扩展声明的以下内容：

- 扩展；
- 命令；
- skill；
- agent；
- workflow；
- hook；
- 扩展 MCP 服务器；
- 扩展 LSP 服务器。

`/reload-plugins` 负责面向用户的命令行为：

1. 要求存在 `config`；
2. 发出 `ExtensionsReloadStarted`；
3. 调用 `reloadPluginsRuntime()`；
4. 无论成功还是失败都调用 `clearExtensionsChanged()`；
5. 返回本地化的信息摘要或错误信息。

失败时清除过期状态是有意设计。如果失败的重载留下 `extensionRefreshNeeded = true`，之后的文件监听通知会因去重而被忽略，内容自动刷新也会一直跳过。

### 7. 自动刷新内容级变更

`refreshExtensionContentRuntime()` 用于只涉及内容的文件系统变更。

流程：

1. 刷新扩展缓存；
2. 刷新 skill 缓存；
3. 刷新 subagent 缓存；
4. 重载斜杠命令；
5. 汇总错误；如果任一步骤失败，则抛出一条合并后的错误信息。

扩展 workflow 通过既有的斜杠命令重载步骤刷新。

斜杠命令处理器监听 `ExtensionContentChanged`，并对刷新使用 250 毫秒的防抖延迟。它使用以下引用串行化刷新：

```ts
extensionContentRefreshRunningRef;
extensionContentRefreshPendingRef;
```

如果刷新运行期间收到内容事件，处理器会标记另一次待处理刷新，并在当前刷新结束后执行。较小的执行次数上限可以避免编辑器或构建进程频繁发出的事件让同一刷新任务无限持续。

如果 `ExtensionRefreshState.needsExtensionRefresh()` 为 true，内容自动刷新会提前结束。必须先完成包级重载，让命令、skill、agent、workflow、hook、MCP、LSP 和上下文状态从同一份扩展缓存快照重新建立。

### 8. 重载 Hook，同时保留 Agent 作用域 Hook

`HookRegistry.reloadConfiguredHooks()` 只替换已配置的 hook 条目。它会保留 `agentScope !== undefined` 的条目，因为这些条目是为 subagent 执行临时注册的 hook。

流程：

1. 保存 `previousEntries`；
2. 保留 `agentEntries`；
3. 将注册表条目设置为 `agentEntries`；
4. 执行 `processHooksFromConfig()`；
5. 失败时恢复 `previousEntries` 并重新抛出错误。

`HookSystem.reload()` 只提供简单的调用入口，实际委托给 `hookRegistry.reloadConfiguredHooks()`。因此运行时重载不需要重建整个 hook 系统。

这条重载路径不会从磁盘重新读取用户或项目设置文件。`processHooksFromConfig()` 会使用当前 `Config` 值重新处理用户／项目 hook 和刷新后的扩展配置值。设置文件重载仍由设置重载路径负责；`/reload-plugins` 只处理扩展运行时状态。

### 9. 将状态接入交互式 UI

交互式启动会创建一个共享的 `ExtensionRefreshState`：

```ts
const extensionRefreshState = new ExtensionRefreshState();
const extensionFileWatcher = isBareMode(argv.bare)
  ? undefined
  : new ExtensionFileWatcher(config, undefined, extensionRefreshState);
```

状态会沿以下路径传递：

```text
gemini.tsx
  -> startInteractiveUI(...)
    -> AppContainer
      -> useSlashCommandProcessor
      -> CommandContext.services.extensionRefreshState
```

只有在没有传入状态时，`AppContainer` 才会创建备用的 `ExtensionRefreshState`。这样既能简化测试和其他 UI 入口，也能让主交互路径在监听器和斜杠命令处理之间共享状态。

清理流程会注销重载监听器并停止监听器。

## 事件流程

### 内容文件编辑

```text
编辑扩展的 commands/skills/agents/workflows 文件
  -> ExtensionFileWatcher 分类为 auto
  -> ExtensionRefreshState.markExtensionContentChanged()
  -> useSlashCommandProcessor 安排防抖刷新
  -> refreshExtensionContentRuntime()
      -> ExtensionManager.refreshCache()
      -> SkillManager.refreshCache()
      -> SubagentManager.refreshCache()
      -> reloadCommands()
```

### 包级文件编辑

```text
编辑 qwen-extension.json/hooks/上下文/安装元数据/拓扑
  -> ExtensionFileWatcher 分类为 stale
  -> ExtensionRefreshState.markExtensionsChanged()
  -> useSlashCommandProcessor 显示：
       "Extensions changed on disk. Run /reload-plugins to apply updates."
  -> 用户执行 /reload-plugins
  -> reloadPluginsRuntime()
      -> ExtensionManager.refreshCache()
      -> ExtensionManager.refreshTools()
      -> reloadCommands()
```

### UI 变更

```text
用户启用/停用/安装/卸载/更新扩展
  -> ExtensionManager 发出变更开始事件
  -> ExtensionRefreshState 开始抑制通知
  -> ExtensionManager 写入磁盘/运行时状态
  -> ExtensionManager.refreshTools()
      -> refreshExtensionRuntime()
  -> ExtensionManager 发出变更结束事件
  -> 抑制结束
  -> ExtensionFileWatcher 使用更新后的根目录/上下文文件重新启动
```

## 并发与顺序

- 监听器重启由代次编号保护。`watchGeneration` 变化后，旧监听器实例发出的事件会被忽略。
- 变更抑制按变更 id 配对，不依赖栈顺序。
- `stopWatching()` 在丢弃监听器引用前结束所有待处理的抑制，因此监听器在变更进行中停止时不会泄漏抑制深度。
- 内容自动刷新在斜杠命令处理器中串行执行。并发事件最多合并为一次待处理重跑。
- `/reload-plugins` 发出 `ExtensionsReloadStarted` 和 `ExtensionsReloaded`，因此手动重载期间会取消待处理的内容刷新计时器。
- 包级过期状态优先于内容自动刷新。如果需要包级重载，内容自动刷新会退出并等待 `/reload-plugins`。

## 失败语义

| 路径                                         | 行为                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 变更或 `/reload-plugins` 中的 MCP 重新初始化 | 向上传播。扩展 MCP 工具可能不可用，此时返回成功信息会产生误导。                          |
| 变更或 `/reload-plugins` 中的 Hook 重载      | 等待其他并行刷新步骤完成后传播。已配置的 hook 可能没有注册，此时返回成功摘要会产生误导。 |
| 变更期间的 Skill 缓存刷新                    | 记录日志，并继续执行。                                                                   |
| 变更期间的 Subagent 缓存刷新                 | 记录日志，并继续执行。                                                                   |
| 变更期间的分层记忆刷新                       | 记录日志，并继续执行。它不应回滚已经写入的扩展状态。                                     |
| 内容自动刷新失败                             | 汇总后在 UI 中显示，并提供 `/reload-plugins` 作为后备路径。                              |
| `/reload-plugins` 失败                       | 返回错误信息并清除过期状态，让后续文件监听通知仍能触发。                                 |
| Hook 注册表重载失败                          | 恢复原有 hook 条目并重新抛出错误。                                                       |
| 监听器错误                                   | 通过 debug logger 记录，当前会话继续运行。                                               |

## 测试

### Core 测试

`packages/core/src/extension/extension-runtime-refresh.test.ts`

- 没有 config 时直接返回；
- 先刷新 MCP，再刷新 skill、subagent、hook 和记忆；
- 传播 MCP 状态同步失败；
- Skill 刷新失败时继续执行；
- 其他并行刷新步骤完成后传播 Hook 重载失败；
- 分层记忆失败时继续执行。

`packages/core/src/extension/extensionManager.test.ts`

- disable 前后发出变更开始／结束事件；
- disable 失败时仍发出变更结束事件；
- install 前后发出变更开始／结束事件，并覆盖内部嵌套的 enable 事件；
- uninstall 前后发出变更开始／结束事件；
- update 创建临时目录失败时仍发出变更开始／结束事件；
- favorite 变更或来源时间戳更新不会发出变更事件；
- 保留现有的扩展加载、命令发现、hook 加载和 `refreshTools` 覆盖。

`packages/core/src/hooks/hookRegistry.test.ts`

- 重新加载已配置的 hook；
- 重载期间保留 agent 作用域的 hook；
- 配置的 hook 重载失败时恢复原有条目。

`packages/core/src/hooks/hookSystem.test.ts`

- 将 reload 委托给 hook 注册表。

### CLI 测试

`packages/cli/src/config/extension-refresh-state.test.ts`

- 清除前只发出一次过期刷新事件；
- 发出内容刷新事件；
- 变更抑制期间不发出通知；
- 正确清除过期状态和抑制窗口。

`packages/cli/src/config/extension-file-watcher.test.ts`

- 将 commands、skills、agents 和 workflows 分类为自动刷新；
- 将清单、安装元数据、hook、上下文文件和扩展拓扑变更分类为过期；
- 忽略未知文件和被忽略的目录；
- 监听链接扩展源目录；
- 在程序化变更期间抑制通知；
- 变更完成后重启监听；
- 处理扩展目录延迟创建。

`packages/cli/src/config/extension-runtime-reload.test.ts`

- 为 `/reload-plugins` 刷新扩展缓存、运行时工具和斜杠命令；
- 汇总活动扩展能力；
- 刷新内容运行时组件；
- 汇总内容自动刷新失败。

`packages/cli/src/ui/commands/reload-plugins-command.test.ts`

- 将命令注册为仅限交互式行为；
- config 缺失时返回错误；
- 成功时重载运行时并清除过期状态；
- 失败时清除过期状态并返回错误。

`packages/cli/src/services/BuiltinCommandLoader.test.ts`

- 内置命令加载中包含 `/reload-plugins`。

### 手动验证

手动验证应覆盖：

1. 从 UI 启用扩展，确认命令、skill、agent、workflow、MCP、hook 和上下文在不重启的情况下刷新。
2. 停用同一扩展，确认运行时能力被移除或不再提供。
3. 编辑 `commands/` 下的命令文件，确认斜杠命令补全自动更新。
4. 编辑 `skills/` 下的 skill 文件，确认由 skill 提供的斜杠命令补全自动更新。
5. 编辑 `agents/` 下的 agent 文件，确认 agent 缓存反映变更。
6. 启用 workflows 后，编辑 `workflows/` 下 workflow 文件中的描述，确认对应斜杠命令的描述自动更新，无需重启。
7. 编辑 `hooks/hooks.json`、`qwen-extension.json`、安装元数据、上下文文件或扩展目录拓扑，确认 UI 要求执行 `/reload-plugins`。
8. 执行 `/reload-plugins`，确认摘要报告扩展、命令、skill、agent、workflow、hook、扩展 MCP 服务器和扩展 LSP 服务器。
9. 强制制造一次重载失败，确认 UI 报告错误；随后再发生文件系统变更时，确认仍能触发新的通知。

## 取舍

- 即使存在已配置 hook 的重载 API，hook 仍按包级过期变更处理。这样可以避免后台文件事件悄悄改变 hook 执行行为。
- MCP 刷新仍采用完整的运行时重新初始化。按扩展逐个重启 MCP 可以降低成本，但会把本次 PR 扩大到 MCP 归属和状态同步逻辑。
- 监听器将未知文件分类为忽略，而不是过期。这样可以减少构建产物产生的噪声，但扩展作者必须把运行时能力文件放在受支持的约定目录中。
- 监听器直接监听链接扩展源目录。这能改善开发体验，但对于有大量链接扩展的用户，会增加监听器数量。

## 后续工作

- 增加按扩展进行的增量 MCP 状态同步。
- 为 `ENOSPC` 或 `EMFILE` 等致命监听器错误增加用户可见的诊断信息。
- 如果调用方需要部分成功摘要，考虑让 `refreshExtensionRuntime()` 返回带类型的刷新结果。
- 如果使用大量链接扩展的情况变得常见，使用预先计算的根目录映射优化链接扩展源路径查找。
- 只有在 hook 重载足够明确、可观察，并且适合后台应用后，再重新评估 hook 内容自动刷新。
