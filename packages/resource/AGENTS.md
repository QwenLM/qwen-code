# Resource

`@qwen-code/resource`（`packages/resource`）是 CLI 仓库内的文件型配置资源包，统一承载 Skill、Agent、MCP、Plugin、Settings、Output Style 等资源的路径发现、加载解析、快照查询和文件变更通知。它随 CLI 一起构建交付，不单独发版。

本包负责把文件系统中的配置加载为稳定、相互独立的领域资源快照；CLI 等宿主负责合并各类加载结果并投影到运行时。

## 当前实现边界

资源按 scope 分成两个 Resource：进程级一份的 `UserResource` 和每个 workspace 一份的 `ProjectResource`，共同管理以下文件：

- user（`UserResource`）：`~/.qwen/skills`、`~/.qwen/commands`，以及开关允许时的 `~/.agents/skills`
- project（`ProjectResource`）：`<cwd>/.qwen/skills`、`<cwd>/.qwen/commands`，以及 trust 和兼容开关允许时的 `<cwd>/.agents/skills`
- additional directory：按 project 来源处理其 `.qwen/skills`、`.qwen/commands` 和兼容目录
- Agent：`~/.qwen/agents` 与 `<cwd>/.qwen/agents`；project Agent 受 trust 和 home-directory 保护，不从 additional directory 加载；user Agent 由 `UserResource` 加载；两个 scope 都通过显式 reload 刷新

本期不由这两个 Resource 加载或监听 MCP、Plugin。Settings 独立归 `src/settings/SettingsService` 管理，不属于 ResourceService、UserResource、ProjectResource 或 ResourceWatchBridge：user 文件源在 Service 内进程一份，project/local 按实际文件路径成组复用。独立命令通过 SettingsService.resolve 完成解析、校验、跨 scope 合并、trust 与环境处理；会话也通过 SettingsService.resolve 获取 LoadedSettings，CLI 注入产品兼容规则与进程副作用。ConfigChange Hook 及候选采用决策仍由宿主会话完成。Output Style 按同一 scope 划分加载：user 目录由 `UserResource` 加载；两个 scope 都通过显式 reload 刷新。路径模型中暂时存在的其他字段只用于保持目录约定，待对应资源正式迁移时再接入。

两个 scope 的 Resource 都只交付「本 scope 的 per-kind 候选列表（带 source）+ loadErrors；Skill/Command 另提供 onDidChange」；跨 scope 的同名赢家选取、alsoDefinedAt 阴影记录和 user/project 来源过滤由 CLI 等宿主完成。

本包不负责任何 Session 语义，包括 Skill 激活、disabled、visibility、allowlist、模型可见性、Agent override、模型/effort 校验、MCP runtime class、prompt/tool 注册和正文缓存。builtin、flag、SDK Agent 继续由 CLI 管理；plugin Agent 的文件解析走本包入口暴露的 loader，注册和安全策略仍在 CLI。

## 职责边界

本包负责：

- 根据 home、cwd、配置目录名和 additional directories 推导资源路径。
- 按领域发现、解析、校验并加载文件型资源，按 scope 归属到 `UserResource` / `ProjectResource`。
- 通过两个 scope Resource 的领域视图发布各领域的最新加载候选快照。
- 监听文件变更，在重新加载并提交快照后通知上层。
- 从统一入口暴露一次性文件解析能力，避免调用方复制 parser 和 scanner。

本包不负责：

- 不把 Skill、Agent、MCP、Plugin 等领域的加载结果合成为最终配置，也不做 user 与 project 之间的同名赢家选取或来源过滤。
- 不决定 Skill 激活、可见性、模型/slash 调用、allowlist 或执行权限。
- 不决定 Agent 选择与执行、MCP client/process 生命周期、Plugin 激活与注册。
- scope Resource 不实现 project trust，只消费上层传入的 trust 状态；SettingsService 按 user 配置和构造上下文计算 Settings 的信任与合并，不替宿主做执行授权。
- Settings 领域负责带锁的原子读改写、共享原始文本、每文件一份物理监听和变更扇出；其他资源文件不由本包安装、修改或删除。会话自行执行 ConfigChange Hook，并决定是否采用候选内容。
- 不依赖 CLI。依赖方向必须保持 `CLI -> @qwen-code/resource`。

canonical path 去重和同一加载目录内的兼容顺序属于加载规范化；跨 scope 优先级、同名赢家和阴影记录归宿主，不代表本包拥有上层资源合并职责。

## 领域模型

Skill、Agent、Output Style 等领域分别加载，按 scope 归属到两个 Resource：

```text
CLI（合并 scoped 候选与 builtin/plugin/dynamic）
  └─ ResourceService
       ├─ UserResource（进程一份）
       │    ├─ SkillResource → UserSkillProvider
       │    ├─ AgentResource → UserAgentProvider
       │    └─ OutputStyleResource → OutputStyleProvider(user)
       └─ ProjectResource（workspace context）
            ├─ SkillResource → ProjectSkillProvider
            ├─ AgentResource → ProjectAgentProvider
            └─ OutputStyleResource → OutputStyleProvider(project)

领域 Resource 管理快照、刷新和通知；scope Resource 选择路径、来源和监听策略。
ResourceWatchBridge → FileWatcher 提供文件监听，Provider 只扫描与解析。
```

- `ResourceService` 位于 `src/resource/core/`，持有进程级唯一的 `UserResource`（宿主启动时 `initializeUserResources()` 或首次 `getUserResource(options)` 固定用户根）和按 context key 缓存的 `ProjectResource`。
- `getUserResource()` 是与 workspace 无关的全局访问器，不参与 context key；`getProjectResource(options)` 只按 workspace 输入缓存 project。
- `UserResource` 负责 user scope 的加载、监听和事件；进程启动选项决定是否预加载兼容目录，首次有会话需要时也可启用。所有会话复用一份 Skill/Command 加载与监听，并按会话开关筛选兼容候选。
- `ProjectResource` 负责 project scope（workspace 根 + additional roots）的加载、监听和事件。
- 两个 Resource 的领域视图（`skills` / `agents` / `outputStyles`）只暴露本 scope 的候选查询和变化订阅；快照提交是 Resource 私有行为。
- Provider 只发现和解析自己的目录，不订阅文件变化，不接触领域视图。
- `ResourceWatchBridge` 把通用路径事件转换为资源事件，先刷新完整快照，再通知消费者。
- `FileWatcher` 是横向基础设施，不理解 Skill 或其他资源语义。

scope Resource 组装所属领域资源，决定来源、目录集合、监听策略和生命周期，不做领域间或跨 scope 合并。领域 Resource 在各自 kinds 目录管理加载状态、快照和刷新，Skill/Command 另管理通知；Provider 只负责发现与解析。领域视图只发布各领域加载候选，不提供合并视图。

SkillResource、AgentResource、OutputStyleResource 是两个 scope 复用的包内实现，不增加包根导出。UserResource 管理进程共享的 Skills 快照和监听，按需增加兼容目录；用户 Agent/OutputStyle 首次加载后保持进程级共享快照，仅通过显式 reload 更新；ProjectResource 管理 workspace 来源、trust、附加目录和 Skill 监听。

当前完整落地的是 workspace 静态 Skill、user/project Agent 和 Output Style。其他领域按同一边界逐步接入。

## 核心接口

### ProjectResource

`ProjectResource` 是 project scope 的生命周期入口；每个 workspace context 一份，由 `ResourceService` 创建和缓存。

当前接口：

```text
new ProjectResource(options)
project.ready
project.skills
project.agents
project.outputStyles
project.reloadOutputStyles(options?)
project.updateWorkspaceContext(context)
project.reloadSkills(options?)
project.reloadAgents(options?)
project.dispose()
```

接口语义：

- `ready` 惰性完成首次加载和快照提交；读取资源前必须等待。文件 watcher 在快照完成后后台启动，不属于 `ready` 门槛。
- `watcherReady` 单独表示后台 workspace Skill watcher 已就绪；启动失败时该 Promise reject，但已提交快照和 `ready` 不受影响。
- `updateWorkspaceContext()` 更新 trust 和 additional directories，必要时重绑监听目标，但不隐式 reload。
- `reloadSkills()` 重新加载 project Skill 快照；`notify: false` 只提交、不通知。
- `reloadAgents()` 显式重新加载 project Agent 快照，不提供变更通知。
- `reloadOutputStyles()` 显式刷新 project Output Style，可传 `projectConfigDirOverride` 指定目录（worktree 场景）；`ready` 之前完成的首次加载会被复用。
- Skill 变更通知携带 watcher 的 `ResourceChangeEvent[]` 和该次加载的候选快照；每个 listener 收到独立的事件副本和快照副本。快照参数始终存在；显式 reload 的通知不带文件事件。
- Skill 的读取与快照提交串行执行，通知在读取队列外等待，允许 listener 内显式 reload；一次失败不能阻断后续刷新。
- Skill 通知可以重叠并乱序完成；每个 listener 收到该次刷新的独立快照副本，应按只读使用。回调等待期间查询 Resource 可能得到更新版本，消费者须自行防止旧结果覆盖新结果。
- `dispose()` 停止监听并等待已排队刷新和在途通知结束；通知失败不会中断销毁，但仍向显式 reload 调用者传播。销毁开始后新的 Skill reload 会 reject，包括在途 listener 发起的 reload。

### UserResource

`UserResource` 是 user scope 的生命周期入口；进程级一份，由 `ResourceService` 持有（宿主启动 `initializeUserResources()` 固定用户根），也可直接构造做一次性读取。

当前接口：

```text
new UserResource(options)
user.ready / user.initialize()
user.skills
user.agents / user.outputStyles
user.reloadSkills(options?)
user.reloadAgents(options?)
user.reloadOutputStyles(options?)
user.dispose()
```

- `initialize()`（等价于 `ready` 的惰性形式）加载全部 user 领域并在后台启动监听；失败后可重试。
- `skills` 返回进程持有的原始 Skill/Command 视图；`getSkills({ loadFromAgentsDirectory })` 返回按会话开关筛选的视图，首次开启时将兼容目录加入共享加载与监听。视图另有 `ready` 和 `watcherReady`，订阅者单独取消自己的 `onDidChange` 订阅。
- `watcherReady` 表示这份 Skill 视图的监听已就绪。
- `reloadSkills()` 重读这份 Skill 快照；`notify: false` 只提交、不通知。
- UserResource 和 Skill 视图由 Service 持有到进程关闭，不随会话释放；监听后端失败后，下一次获取 `skills` 时重建监听来源。
- `hasSamePaths(options)` 用于 Service 校验用户根一致性。

### ResourceService：两个 scope 的获取入口

```text
service.initializeUserResources(options)   // 宿主启动固定用户根并加载；可重试
service.getUserResource(options?)          // 全局用户资源；首次带 options 惰性绑定，之后根不一致会抛错
service.getProjectResource(options)        // 按 context 缓存/隔离 project
  → { project, ready, watcherReady, isForContext(options), release() }
```

- `getUserResource()` 不接收 workspace 输入、不参与 context key；Service 生命周期内返回同一实例。
- `getProjectResource(options)` 只按 workspace 输入（cwd、trust、add-dir、override、来源规则、兼容开关）缓存；缓存键不含用户路径。
- `handle.ready` / `handle.watcherReady` 只描述 project scope，是惰性读；未观测的读取不会产生 unhandled rejection。
- 传入自定义 `fileWatcher` 或缓存降级时，只有 project scope 进入私有模式：该 context 独享一份 `ProjectResource`，保留独立加载与监听；用户资源始终是进程级共享的那一份。
- 会话级生命周期由宿主持有：Skill 变更订阅需要取消，project handle 需要 `release()`；UserResource 和 Skill 视图由 Service 在关闭时释放。

不要增加 `project.watcher`、`load()`、`startWatching()`、`stopWatching()` 或通用 `list()` 旁路。会话消费方从 `user.getSkills({ loadFromAgentsDirectory })` / `project.skills` 等领域视图读取。

新领域接入后，在两个 scope Resource 各增加明确的领域 reload 和视图，不把多个领域塞进一个通用无类型接口。

### 领域视图

两个 scope 的领域视图是对外只读加载候选，当前分别提供：

```text
userSkills.getAllDiscoveredSkills()
project.skills.getAllDiscoveredSkills()
<scope>.skills.getLoadErrors()
<scope>.skills.onDidChange(listener /* events | undefined, snapshot */)

<scope>.agents.getAllDiscoveredAgents()
<scope>.agents.getLoadErrors()

<scope>.outputStyles.getAllDiscoveredOutputStyles()
<scope>.outputStyles.getLoadErrors()
```

- `getAllDiscoveredSkills()` 返回本 scope 的候选：目录内兼容顺序、canonical 去重、条目带 `source` 标注；同名不同位置的两条都保留，供上层合并和阴影诊断。
- `getAllDiscoveredAgents()` / `getAllDiscoveredOutputStyles()` 返回本 scope 的全部候选，按发现顺序。
- Agent / OutputStyle 不提供变更订阅；显式 reload 可重读，用户目录变化不会自动刷新共享候选。
- 通知发生时新快照必须已经提交；Skill 通知额外携带该次刷新的候选快照副本。
- 领域视图会复制 Skill 条目和深复制 Agent 条目，但不会递归 deep-freeze 所有返回值；不要宣称快照完全不可变。

快照提交（replace + notify）是 scope Resource 的私有实现，不对外暴露写入能力。

### FileWatcher

`FileWatcher` 是无资源语义的基础设施，接口只包含：

```text
watch(request, listener) -> unsubscribe
start()
stop()
isNoop
```

它负责 existing/missing path、symlink、recursive/flat anchor、native signal、polling、debounce、await-write-finish 和 internal-write suppression。

默认实现为 `FileSystemWatcher`，由 `createFileWatcher()` 创建；它协调注册、后端选择/回退和通知。`ChokidarBackendPool` 只管理 Chokidar watcher，`NativeSignalBackend` 只管理原生句柄，`watchBackendPolicy.ts` 集中运行时选择规则，`anchorPlanner.ts` 负责路径与监听位置规划。内部函数用 Native/Chokidar 明确所属路径；默认 Chokidar 池与强制 polling 回退池分开，不能把“默认池”理解为一定不轮询。

公开入口新增 `FileSystemWatcher`；已发布的 `ChokidarFileWatcher` 保留为带 `@deprecated` 标记的同一构造器别名，不增加另一套实现。新代码使用 `FileSystemWatcher` 或工厂，后端与选择策略不从包根导出。

约束：

- `signal` 是粗粒度变更通知，消费者据此重建快照，不依赖精确 operation。
- `FileChangeOperation` 的删除名称是 `unlink`。Chokidar 文件/目录删除映射为 `unlink`；原生 signal 对新增、修改、删除统一发出目标级 `change`，消费者通过重新加载确认最终状态。
- `logicalRoot` 用于保持调用方路径祖先可观察，不能因此递归监听 home 或 workspace 根目录。
- FileWatcher 不 import Skill 或其他领域类型，也不产生 `ResourceChangeEvent`。
- Skill/Command 通过 `WatchRequest.preferNativeRecursive` 选择 macOS 原生递归 signal：Node 和稳定 Bun >= 1.4.2 使用 `fs.watch`，旧 Bun、未知版本和 prerelease 保留原策略。Agent 不启用此选项。显式 `usePolling: true` 优先。
- 原生 opt-in 目标注册失败、运行时报错，或有效深度内包含子级 symlink 时，永久回退到独立的受限 polling 后端；不影响其他目标，不定时重试原生。目标本身及祖先 symlink 继续通过 canonical anchor 和 flat guard 处理。
- 未选择原生 opt-in 的 Bun 请求默认使用 polling；`FileWatcherOptions.pollingIntervalMs` 省略或无效时使用 2000ms，可用有限正数覆盖，同时作用于普通文件、二进制文件和目录。此间隔不是端到端刷新时限，事件仍经过写入稳定等待和 debounce。
- `WatchRequest.depth` 指定目标内部的目录遍历深度，语义与 Chokidar 一致，0 只观察直接子项，省略时不限深度，非法值回退到 2。默认使用按 depth 共享的 Chokidar 后端，真正限制遍历；选择 macOS 原生递归 opt-in 时，depth 只过滤事件，操作系统仍观察整个目标子树。祖先 entry guard 仍为 flat，深度从目标本身计算。不同深度的重叠请求分别过滤通知。
- `WatchRequest.ignoredDirectoryNames` 按监听目标内部的路径段排除子树，用于在 Chokidar 遍历阶段减少监听条目，原生模式只过滤通知；不排除目标本身或其祖先，支持目标位于依赖目录内以及 symlink。重叠目标中任一目标需要的路径仍保留底层监听，各目标分别过滤通知。原有 `.git` 全局过滤保持不变。
- `markInternalWrite()` 只登记一次抑制标记，不写文件，也不是权限机制。

### ResourceWatchBridge

`ResourceWatchBridge` 把通用文件事件转换为领域刷新：

```text
start()
setTargets(targets)
getTargets()
stop()
```

Bridge 负责注册 targets、映射 `kind/source`、按 refresh policy 批处理事件并调用刷新函数。它不解析资源、不持有快照、不决定来源优先级。

Skill/Command 监听请求复用 `skillLoader.ts` 中的 `node_modules`、`.git` 排除集，并使用与旧 SkillChangeDetector 一致的 `depth: 2`；Agent/OutputStyle 不注册主动刷新监听。Agent 运行时注册仍由宿主决定，显式调用 `reloadAgents()` 保持重新读盘语义。注入自定义 FileWatcher 的实现应遵循请求中的排除和深度字段；可忽略 `preferNativeRecursive` 优化选项。以 skills 目录为根时，`name/SKILL.md` 和 `name/scripts/helper.py` 可触发刷新，`name/scripts/nested/helper.py` 的内容修改不会触发。此限制只影响监听通知，不改变 Loader 的发现深度或显式 reload 行为。有效资产变化仍触发既有刷新与通知，不以 Skill DTO 相等来抑制资产通知。

两个 scope Resource 各自提供 targets 和 refresh policy，并在 policy 中完成 guard、provider reload 和领域快照提交。

## 公开入口

包只有包根 `index.ts` 一个源码入口（转发 `src/index.ts`），事实来源是 `src/index.ts`、`public-api.json` 和 `dist/index.d.ts`。它同时承载 `UserResource` / `ProjectResource` / `ResourceService` 门面、FileWatcher、共享领域类型，以及一次性的 Skill/Agent/OutputStyle 文件解析与目录扫描；`ResourceWatchBridge` 等生命周期实现保持包内私有。

单入口是硬约束，不是风格选择。`drainSkillLoadErrors()`、`discoverSkillDirsForPaths()` 和 `markInternalWrite()` 背后都是模块级可变状态（Skill 加载错误暂存、已检查目录缓存、内部写入登记表）。打包器会把每个入口可达的依赖图整份内联进产物，CLI 的 esbuild / Bun 构建、tsconfig 和 vitest 都通过别名把 `@qwen-code/resource` 解析到 `packages/resource/index.ts`；一旦出现第二个入口，或出现一份经 `dist` 再引入的副本，就会多一份这些状态：调用方混用入口时，会在一张表里打标、到另一张表里查不到。并发扫描、重试或测试隔离时必须检查这些状态的清理语义，不能把它们扩散到 Resource 的长期快照模型。

接口选择规则：

- user/project Skill、Agent 和 Output Style 通过 `ResourceService.getUserResource()` / `getProjectResource(options)`（或直接构造两个 scope Resource）加载。
- builtin、plugin、安装器和 session dynamic 等一次性 Skill/Agent I/O 直接用入口暴露的 loader 函数；不用它们重复扫描已由 scope Resource 管理的目录。
- 不凭内部文件中的 `export` 判断公共 API；必须同时检查 `src/index.ts`、`public-api.json`、`package.json#exports` 和构建后的声明。
- 修改运行时公共导出时同步更新 `public-api.json`、`src/packageSurface.test.ts` 和本文件。

## 当前 Skill 加载契约

### 路径与 trust

| 来源                  | 默认目录                                               | 条件                               |
| --------------------- | ------------------------------------------------------ | ---------------------------------- |
| user                  | `~/.qwen/skills`、`~/.qwen/commands`                   | 不受 project trust 限制            |
| user compatibility    | `~/.agents/skills`                                     | `loadFromAgentsDirectory: true`    |
| project               | `<cwd>/.qwen/skills`、`<cwd>/.qwen/commands`           | trusted，且 cwd 不是 home          |
| project compatibility | `<cwd>/.agents/skills`                                 | project 条件成立且兼容开关开启     |
| additional roots      | `<root>/.qwen/skills`、commands、可选 `.agents/skills` | 按 project 来源处理并受 trust 限制 |

路径可由 `configDirName`、global/project override 和 Agent Skill override 改变。包外通过 options 传入，包内分别使用 `createUserResourcePaths()` 和 `createProjectResourcePaths()`；这些函数当前不是 npm 公开导出。project 路径解析不计算 user/global 路径；ProjectResource 的 `homeDir` 仅用于 cwd 等于用户主目录时的来源保护。

`skillSettings.allowedSources` 只影响 ProjectResource 实际拥有的 project provider；user 侧不再按它过滤（宿主自行过滤 user 候选）。类型中的 `built-in`、`plugin` 不代表本包会加载这些来源。

### 加载规范化

包内只做 scope 内规范化，不做跨 scope 选取。两个 scope 的候选列表交给宿主，宿主按固定顺序拼接后用自身合并器决定赢家：

```text
宿主拼接顺序（CLI 兼容顺序）
project scope（project workspace < project additional roots，按传入顺序）
  之后拼接 user scope
```

每个目录集合内部：

```text
commands < .agents/skills < .qwen/skills
```

必须保持：

- additional roots 标记为 `source: 'project'`，不是独立 provider。
- cwd 与 home 指向同一真实目录时跳过 project Skill。
- 同一 canonical file 在一个 scope 内只加载一次（`normalizeSkillCandidates`，克隆后打 source 标注，不改动共享贡献）。
- 同名不同位置的两条候选都保留；赢家选取、`alsoDefinedAt` 阴影链和跨来源冲突计数在宿主。
- `SkillDefinition` 是 CLI 与本包共享的唯一 Skill DTO，不建立镜像类型。
- Provider 只加载自己的目录，不监听文件、不写领域视图、不处理 Session 策略。
- CLI 负责把两个 scope 的候选与 builtin、plugin、dynamic Skill 合并（skills：project 先、user 后）。

## 当前 Agent 加载契约

Agent 默认从 `~/.qwen/agents` 和 `<cwd>/.qwen/agents` 加载。project Agent 受 trust 和 home-directory 保护，不从 additional directory 加载。

Agent 候选按 scope 交付：user 视图返回 `~/.qwen/agents` 候选，project 视图返回 `<cwd>/.qwen/agents` 候选；宿主按 `user 先、project 后` 拼接并按来源过滤，同名后者覆盖前者（CLI 兼容顺序）。候选在提交和读取时深复制。

## 当前 Output Style 加载契约

- 两个 scope 的 `outputStyles` 视图提供 `getAllDiscoveredOutputStyles()` 和 `getLoadErrors()`。返回条目和错误均复制，不暴露快照写入能力。
- Provider 负责 user/project `output-styles/*.md` 的平层扫描和 frontmatter 解析。来源标签保持 `userSettings` / `projectSettings`；两个 scope 的候选都保留，同名最终选择由宿主完成（拼接顺序 user 先、project 后）。
- 路径使用统一 global/project override；不读取 additional directories。保持原 OutputStyle 行为：不新增 trust 或 home-directory 过滤，同一 home 路径仍保留两种来源标签。
- project 侧 `ready` 加载初始快照；`reloadOutputStyles({ projectConfigDirOverride?: string })` 串行刷新并提交快照。宿主可在完整 ready 之前仅加载此领域，ready 复用已完成的首次加载。显式 reload 可传入当前会话的 project config 目录，用于切换 worktree，缺省采用 Resource 路径；user 目录不变。user/project OutputStyle 都不注册主动刷新 watcher；显式 reload 更新文件候选，不修改会话选中的提示词。用户共享快照不会因新会话创建而自动刷新。
- 文件缺失忽略；非法 YAML 保留原正文和文件名回退，同时记录诊断。整体刷新抛错时保留旧快照，后续显式刷新可以恢复。
- 包根导出 `loadOutputStylesFromDir` / `loadOutputStylesFromPath` 供 plugin 等一次性 I/O，支持递归目录或单个 Markdown 文件。扫描不跟随目录中的 symlink，显式 manifest 路径沿用 stat/read 的 symlink 行为。
- `OutputStyleConfig` / `OutputStyleSource` 是共享 DTO；解析透传 keep-coding-instructions 和 force-for-plugin，不执行这些字段的运行时策略。内置样式、隐藏保护、插件启用、强制选择、跨来源最终合并及会话提示词应用保留在 CLI。
- `src/resource/kinds/outputStyles/` 是独立领域；内部 Provider 和 View 不导出。

## 生命周期与失败语义

```text
首次 ready
  -> user scope：initialize（Skill 集合 + Agents + OutputStyles）
  -> project scope：分领域 reload
  -> 各 scope 分领域提交快照（不通知）
  -> handle.ready 完成
  -> 后台启动 workspace 与 user Skill / Command 的 WatchBridge

文件变更
  -> FileWatcher
  -> WatchBridge 批处理
  -> 对应 scope 的 Skill / Command reload
  -> scope 提交对应领域快照
  -> Skill / Command onDidChange
```

必须保持：

- 每次 reload 先构造完整新快照，再一次性提交。
- 同一批文件变更只提交一次并通知一次。
- 加载失败时保留上一份完整快照，后续事件或显式 reload 可以重试。
- 宿主 Hook 拒绝变更时，只保留该会话已采用的旧快照；资源层候选快照及其他订阅者不受影响。
- watcher refresh policy 捕获异常，不能让监听链路失活。
- 异步 listener 失败发生在快照提交之后，不能描述为回滚旧快照。
- `ready` 只等待首次快照加载和提交，不等待 watcher。watcher 在快照完成后后台启动；`watcherReady` 单独暴露启动结果，Resource 内部也会消费拒绝以避免 unhandled rejection。启动失败保留已提交快照，不能使调用方启动失败。Resource 仍为每个 Chokidar 后端的首次 ready 设置 5 秒总等待上限（从创建后端开始，不随条目或 warning 重置），超时报 ETIMEDOUT 并附监听路径；该错误只降级本次热更新能力。该上限不是整个 Resource 初始化时限，也不约束 ready 之后的运行时扫描。调用方退出时调用 `dispose()`，Resource 会等待后台启动 Promise 收尾。
- Chokidar 的首次 ready 结果在创建后端时绑定并缓存；启动致命错误或就绪前 stop 会拒绝等待。单个目录条目的 ENOENT、ENOTDIR、ELOOP 等可恢复扫描错误不阻断其他条目的扫描。
- 只使用 Chokidar 的公开 ready/error/close API，不修改或接入其内部扫描流。公开致命 error 立即拒绝就绪等待；被 Chokidar 吞掉的错误或无 ready 事件由 5 秒上限兜底。失败启动会清理相关后端并允许重试，清理不延迟原始错误上报。正常就绪和停止清理定时器；运行时公开 error 保持向上报告。此层不保证 Chokidar 内部每次运行时扫描的异常收尾。
- user/project Agent 均保留首次加载和显式 reload，不提供文件变更订阅；运行时采用及 ConfigChange Hook 由宿主决定。调用方退出时调用 `dispose()`。

## 模块导航

```text
index.ts                           # 包根入口，转发 src/index.ts
public-api.json                    # 运行时公共导出清单
src/
  index.ts                         # 唯一公开入口
  packageSurface.test.ts           # 入口边界测试
  file-watcher/
    fileWatcher.ts                 # FileSystemWatcher 协调、工厂与兼容别名
    watchBackendPolicy.ts          # Node/Bun 与平台后端选择规则
    chokidarBackend.ts             # Chokidar 监听池与句柄生命周期
    nativeSignalBackend.ts         # 原生监听句柄与事件接入
    anchorPlanner.ts               # 路径解析与监听位置规划
    internalWrites.ts              # 外部写入事件抑制
  resource/
    core/
      resourceService.ts           # 全局 user 一份 + per-context project 的缓存与获取入口
      userResource.ts              # user scope：路径、共享来源、监听、引用与生命周期
      projectResource.ts           # project scope：路径、来源筛选、trust、附加目录、监听与生命周期
      resourceViews.ts             # 各 scope 共用的领域视图与快照类型
      types.ts                     # 通用资源事件
    paths/                         # 资源路径推导
    watch/resourceWatchBridge.ts   # 文件事件到领域刷新
    kinds/skills/
      types.ts                     # 共享 SkillDefinition
      skillLoader.ts               # frontmatter 与扫描
      discoverSkillDirs.ts         # 子目录 Skill 发现
      skillResource.ts             # 两个 scope 复用的 Skill 快照、刷新、通知与候选复制
      providers/                   # user/project 加载来源
    kinds/agents/
      types.ts                     # Agent DTO 与加载错误
      agentLoader.ts               # frontmatter 与目录扫描
      agentResource.ts             # 两个 scope 复用的 Agent 快照、刷新与复制
      providers/                   # user/project 加载来源
    kinds/outputStyles/
      outputStyleResource.ts       # 两个 scope 复用的 OutputStyle 快照与刷新
      outputStyleLoader.ts         # 文件解析与目录扫描
      providers/
      types.ts
```

## 修改规则

- `ProjectResource` / `UserResource` 负责各自 scope 的路径、来源筛选、目录集合、监听策略和生命周期；候选规范化、加载状态、刷新和通知位于各领域目录。跨 scope 合并、来源过滤和赢家选取在宿主。
- Skill、Agent、MCP、Plugin、Settings、Output Style 是并列领域，不把新领域实现成 Skill 的特殊分支。
- scope Resource 新领域在 `resource/kinds/<领域>/` 实现 Provider、加载快照、领域视图、变化订阅和回归测试；两个 scope Resource 提供来源、路径、刷新并发策略与 watcher policy，不再内嵌领域视图或刷新队列。Settings 是独立 Service，文件源、持久化、写事件、解析与测试统一放在 `src/settings/`，不向 Resource 路径模型或 WatchBridge 增加 Settings 字段。
- scope Resource 和领域视图只发布加载候选；跨领域、跨 scope、跨运行时来源及面向最终消费者的合并由上层完成。
- Provider 不接触 watcher 或领域视图；FileWatcher 不接触任何领域类型。
- 不把 Session 状态、展示策略或执行授权下沉到本包；SettingsService 只计算配置层的 trust，scope Resource 仍只消费宿主给定的 trust。
- 不引入通用 `Resource` 基类、`TState`、`version` 或公共 `getDiagnostics()`，除非至少两个已落地领域证明存在稳定共同契约。
- 领域视图只提供领域化查询，不增加无语义的通用 `get/list/set`。
- 路径处理必须考虑 realpath、symlink 和跨平台分隔符，不能只靠字符串前缀判断。
- 修改接口或语义时同步更新本文件。

常见修改入口：

| 需求                   | 入口                                                             | 联动验证                                                     |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Skill frontmatter/类型 | `types.ts`、`skillLoader.ts`                                     | compatibility tests、CLI 消费方                              |
| Skill 扫描/JIT         | `skillLoader.ts`、`discoverSkillDirs.ts`                         | symlink、嵌套、预算、状态清理 tests                          |
| Skill scope 内归一化   | `skillResource.ts`、providers                                    | discovered 顺序、canonical 去重、source 标注 tests           |
| Agent frontmatter/扫描 | `agentLoader.ts`、`types.ts`                                     | compatibility、重复名称、错误收集、kind 透传与默认值 tests   |
| scope Resource 行为    | `projectResource.ts`、`userResource.ts` 与 kinds 下领域 Resource | 视图、reload、watcher、失败保留快照 tests                    |
| trust/add-dir          | `projectResource.ts`                                             | targets 重绑、领域视图 tests                                 |
| 文件监听               | `fileWatcher.ts`                                                 | missing path、symlink、signal、polling、internal write tests |
| 领域刷新               | `resourceWatchBridge.ts`                                         | debounce、批处理、失败保留快照 tests                         |
| 公共接口               | `index.ts`、`public-api.json`、`package.json`                    | 入口边界测试 `src/packageSurface.test.ts`                    |

## 验证与构建

在包目录下运行：

```bash
npx vitest run src/path/to/file.test.ts   # 定向测试
npm run typecheck
npm run build
```

`npm run build` 走仓库通用的 `scripts/build_package.js`（`tsc --build --force`），只产出 `dist/`。本包不再单独发布、混淆或校验 tarball，交付形态是随 CLI bundle 内联的源码。

根仓库 `patches/readdirp+4.1.2.patch` 由 patch-package 管理：readdirp 4.1.2 把 `ENOTDIR` 当致命错误，会让 Chokidar 永不 ready。CI 用 `npm install --ignore-scripts` 安装，脚本钩子不会执行，因此补丁挂在本包和根 `build` / `bundle` 路径上（`npm run patch:dependencies`），失败即阻断构建；本地安装后可手动执行同一条命令。升级 readdirp 或 Chokidar 必须重新审核这个补丁。

## 共享资源上下文

AppFramework 独立持有 ResourceService 和 SettingsService，在 Main 阶段创建并在应用关闭时销毁。所选启动模式调用 `initializeUserResources(options)` 固定用户资源根目录并加载 UserResource；loadCliConfig 准备 Config 的 workspace 资源视图，并将会话设置接到独立 SettingsService。Config 只释放项目 handle 和会话订阅，不关闭切项目后仍需复用的共享服务；直接构造的 fallback 服务由嵌入宿主管理，最后一份 Settings 订阅取消时物理 watcher 即停止。Config.initialize 复用已加载视图，trust、附加目录或其他上下文变化时重新申请。

- 用户初始化使用独立的 `UserResourceOptions` 与用户路径解析，仅接收 home、用户配置目录和兼容 Skill 选项，不需要 cwd。用户兼容开关由宿主在启动时从 user/flag settings 固定；workspace 申请使用 `ProjectResourceOptions`（消费 cwd/trust/add-dir/project override），项目兼容开关可采用当前 workspace 的合并设置，并通过无参 `getUserResource()` 引用已初始化的全局用户资源。独立调用 `loadCliConfig` 的嵌入入口在申请 workspace 前完成用户资源初始化。
- UserResource 持有用户 Skills/Commands、Agents、OutputStyles 的加载；只监听 Skills/Commands，用户 Agent/OutputStyle 维持进程快照。启动加载只执行一次，并发读复用 Promise；直接嵌入调用通过 `ready` 惰性加载。
- 每个 ResourceService 只持有一份 UserResource，由显式初始化或首次 `getUserResource(options)` 确定用户配置根和兼容 Skill 根；后续不同用户路径的申请会被拒绝。需要不同用户目录的嵌入调用使用各自的 Service。用户资源不使用多实例缓存 key，project 缓存保持原有上下文 key。
- ProjectResource 组装各 workspace 的领域资源；各领域持有自己的视图和刷新状态。缓存键包含 cwd、路径覆盖、trust、来源规则、兼容开关和有序附加目录；相同上下文可复用，策略不同的上下文分别创建。
- 用户 Skill/Command 事件每个来源只读一次，随后通知所有视图订阅者。user 事件只刷新 user scope，不重读 project 文件；两个 scope 的候选合并、来源过滤和优先级由宿主在读取时完成。
- workspace Skill 持续监听；workspace Agents/OutputStyles 目录的被动监听只使未来申请的缓存失效，活动会话仍显式刷新。
- 用户 Agents/OutputStyles 文件变化不会自动刷新共享候选；需要更新时由宿主显式 reload。宿主决定 Agent 运行时采用时机及 OutputStyle 选择。
- attached worktree 的原项目 OutputStyle 与共享配置目录不同时，Config 保存会话私有组合：复用 user 候选，单独加载原项目目录，不覆盖共享 project 快照。
- builtin、plugin、flag、SDK 资源及 Session 策略仍由宿主管理；候选在归一化时克隆，共享贡献不被打标污染。
- 显式 reload 保持重新读盘和失败保留上一快照的语义。Skill/Command 仍支持 notify:false，通知不占用读取队列，listener 可再次显式 reload。
- 自定义 FileWatcher 的申请只让 project scope 进入私有模式：该 context 独享一份 ProjectResource，保留独立加载与监听；用户资源始终是进程级共享实例，不随 workspace 私有化。
- 会话只取消自己的 Skill 变更订阅并释放 project handle；UserResource 及其 Skill watcher 随 Service 关闭。
- project watcher 错误使该项目缓存失效，新申请重新加载；活动持有者保留原资源和后端回退，旧 watcher 的迟到错误不能使替代缓存失效。缓存监听失败时停止上下文复用。
- user watcher 错误只使该进程的 Skill 监听失效；下一次获取 `skills` 时在同一 UserResource 中重建监听，已有视图仍可显式 reload，不因此重建 project 缓存。
- 失败的 Skill watcher 立即停止；重复初始化可按首次绑定的用户选项重新预加载。
- 清理时单个 unwatch、stop 或 dispose 失败不阻断其他资源清理，完成所有尝试后报告失败。

### 用户 Skill/Command 来源

- UserResource 按进程启动时固定的 skills、commands、兼容 `.agents/skills` 目录集合维护一份快照和 watcher；不按 cwd、trust 或会话来源过滤分叉。新会话不能改变兼容开关或用户目录覆盖。
- 项目 Skill 事件复用用户快照；显式 reload 重新读取用户来源。用户事件仍保留资产变化通知，不按 DTO 是否相等抑制。
- ConfigChange Hook 由会话独立判断是否采用 Skill 候选，不影响资源共享资格。通知携带该次候选快照，宿主须防止较慢的旧 hook 覆盖新结果。
- Provider 用 AsyncLocalStorage 隔离并发加载诊断；一次性 loader 的 drainSkillLoadErrors 公共行为保持不变。

### Settings 文件来源

- SettingsService.getUserSettingsSource(path) 可在 initialize 前固定用户文件根，进程宿主持有的 Service 只保留一份 UserSettingsSource。它与 UserResource 的路径和 Skill 开关无关；getCompatibleUserSettingsSource(path) 首次可绑定，已有不同根返回 undefined；peekUserSettingsSource(path?) 只读取已绑定来源，可选路径不匹配时返回 undefined，永不绑定。
- SettingsService.getProjectSettingsSources(projectPath, localPath) 按两个实际文件路径成组复用 project/local 来源，不受会话 trust、附加目录或 Skill 来源策略影响。SettingsSourceStore 为 Service 私有成员，仅保留包内实现与测试导出，不从包根公开，也不暴露 Service 的 store 实例。
- SettingsFileSource 只缓存原始文件文本（10 秒），不保存解析对象、trust、flag 或合并结果。initialize 首次经 source 读取，同根重复不重读；resolve 必须完成 initialize，user 经共享 source 读取解析，project/local 每次 invalidate 后重读，flag 维持独立读取。TTL、watch、显式失效和写事件会更新后续 user 读取，已返回对象保持独立。
- Settings 写入事务会同步刷新共享原始文本；无变化事务也更新原始文本但不扇出变更。实际写盘变化向活动会话扇出一次逻辑变更，写入会话自行抑制回声。文件系统事件先刷新共享原始文本，再通知各会话执行 ConfigChange Hook。
- SettingsService.watchFiles() 委托私有 store 对同一路径建立一份物理监听；会话释放自己的逻辑订阅。requestDispose() 立即拒绝新获取/resolve，已有监听保留到订阅全部释放；dispose() 直接关闭监听，两者不禁止已返回快照的既有写入行为。takeWatchUnavailableWarning() 供宿主报告一次监听降级，invalidateAll() 失效共享文件文本。
- 删除事件保留短暂等待，以兼容编辑器的原子替换；删除后重建会取消等待并按一次变更处理。watcher 不可用时保留初始快照和显式 reload 能力。文件源与写观察者注册表使用 WeakRef，不创建 watch 的独立命令 Service 可由 GC 回收。

- Hook 配置过滤的原始位置通过包根 `rememberHookArrayRemoval` / `originalHookSettingsPath` 共享，CLI 旧入口和 SettingsService 必须使用同一份映射；不得新增子路径入口或把映射写入用户配置。
