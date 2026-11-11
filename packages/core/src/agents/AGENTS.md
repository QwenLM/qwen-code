# Agents and Subagents

本目录负责 Agent 定义、发现、注册、调度和执行，覆盖普通本地 Subagent、隐式
fork、后台任务持久化、进度展示与 SDK 事件桥接。

修改本目录时，先判断目标属于普通本地 Subagent 还是 fork 执行分支。

## 模块边界

- 本目录拥有 Agent 定义和生命周期编排，但不拥有通用工具实现。
- 工具名称、通配符和 `disallowedTools` 删除逻辑在
  `../tools/tool-names.ts`。
- 工具注册、active/known 过滤和 schema 生成在
  `../tools/tool-registry.ts`。
- MCP 发现和 `includeTools` / `excludeTools` 过滤在
  `../mcp/tools/mcp-tool.ts`。
- CLI 与磁盘权限规则的组装在 `../permissions/`；本目录只建立或标记
  Subagent 权限上下文。
- 主会话统一 `Agent` 工具的注册、热更新和 `--agent` 会话级工具裁剪在
  `../config/config.ts`。

## 执行链

### 普通本地 Subagent

```text
@qwen-code/resource UserResource.agents / ProjectResource.agents views
  -> registry/agentLoader.ts runtime materializer
  -> registry/agentRegistry.ts
  -> subagent-tool.ts: AgentTool.createInvocation()
  -> local-agent-runner.ts: runLocalAgentInvocation()
  -> run-agent.ts: runAgent()
  -> agent-setup.ts: buildSubagentRegistries()
  -> run-subagent.ts: runSubagent()
  -> core/agent-loop.ts: query()
```

### 显式 fork

```text
subagent-tool.ts: AgentTool.createInvocation()
  -> fork-subagent.ts: FORK_AGENT
  -> run-agent.ts: runAgent()
  -> core/forkedAgent.ts: runForkedAgent()
```

fork 可以向模型复用父会话的工具 schema，但实际执行仍委托给子 registry。修改
工具策略时必须分别检查“模型看到的 schema”和“执行 bridge 能调用的工具”。

## 工具可用性不变量

普通本地 Subagent 的有效工具集按以下顺序构造：

```text
Subagent 自有 MCP 发现
  -> tools 白名单或调用方 active 工具继承
     （注册期即应用 fresh 主会话控制工具过滤，
       background 再按异步工具 allowlist 收窄；fork 跳过两层）
  -> memory 所需 Read/Write/Edit 自动补充
  -> disallowedTools 删除
  -> additionalTools / CompleteTask 内部追加
  -> 运行时 permission pipeline
```

- 不要用原始 frontmatter 推断最终工具集；以隔离 `ToolRegistry` 或
  `task_started.tools` 为准。
- 缺少 `tools` 表示继承调用方 active 工具。经 Markdown、`--agents` 或 SDK
  解析的 `tools: []` 也会变成未配置，因此同样是继承全部，不是零工具。
- 显式 `tools` 支持精确名称、`*`、`mcp__*`、`mcp__server__*` 和
  `Agent(name1, name2)`。
- 子 Agent 不能通过 `tools` 重新启用调用方不可见的工具。
- `disallowedTools` 对普通工具只做精确名称删除，不支持 `*`、MCP 通配或
  `Bash(command)` 参数模式。
- `Agent(name)` 是特殊 deny 表达式：保留统一 `Agent` 工具，但禁用指定类型。
- `permissions.deny` 是执行期权限层，不等同于 `disallowedTools` 的 schema 删除。
- 插件 Agent 保留 `tools` / `disallowedTools`，但其 hooks、MCP、permissionMode
  和非 worktree isolation 会经过安全清理。

## 文件与函数职责

### Agent 注册表（`registry/`）

`registry/` 拥有「哪些 Agent 可被调用」这一状态，覆盖三件事：

- **准入**：`agentRegistry.ts` 的 `loadAgents()` 按 built-in -> user -> project ->
  plugin -> flag/SDK 顺序注册，同名后者覆盖前者；enabled 判断、插件字段清理、
  model + effort 能力校验不通过的写入 `loadErrors`，不注册为可调用 Agent。
- **快照**：`_withBuffer()` 在临时 buffer 上完成加载后原子交换进 live 状态，
  因此 reload 期间外部读到的永远是完整快照，不会是半加载状态。
- **变更事件**：订阅 `ModelChanged` / `ModelInfoChanged` / `TrustChanged` 触发重校验，
  自身通过 `emitAgentsRefreshed()` 通知下游刷新。

组成：`agentLoader.ts` 解析各来源（准入的输入端），`agentRegistry.ts` 是注册表本体
与运行期查询入口，`pluginAgentPolicy.ts` 是插件定义的准入清理。内部依赖单向
（`agentRegistry -> agentLoader + pluginAgentPolicy`），目录外只依赖前两者。

- `../utils/frontmatterParsers.ts` 负责 effort 与 thinkingBudget 的统一归一；
  `registry/agentRegistry.ts` 在 settings override 合并后生成 Agent 显式 reasoning 配置；仅当
  Agent 未配置 reasoning 时，`run-subagent.ts` 才从主会话的实时 effort 生成兜底配置。

#### `registry/agentLoader.ts`

- `AgentLoadError`：统一表示文件、frontmatter、JSON 或 SDK Agent 定义加载失败。
- user/project Agent 的 Markdown 发现、解析、快照和监听由
  `@qwen-code/resource` 的 `UserResource.agents` / `ProjectResource.agents`
  负责；Config 按 user 在前、project 在后的顺序拼接两个 scope 的候选并应用
  来源过滤，同名后者覆盖前者。
- `parseAgentMarkdown()` 保留 CLI 的兼容 DTO API；实际文件目录加载入口委托
  `@qwen-code/resource`，不要再增加第二套磁盘扫描逻辑。
- `markdownToAgentDefinition()`：把 Markdown 定义映射成
  `LocalAgentDefinition`，包括 `toolConfig`、`disallowedTools`、MCP、模型和运行限制。
- `agentResourceToAgentDefinition()`：把 runtime-independent Agent resource
  映射成 CLI `LocalAgentDefinition`；MCP runtime class 和模型策略仍由本层拥有。
- `loadAgentsFromDirectory()` / `loadAgentFromFile()`：加载文件系统 Agent 定义并
  汇总错误；目录加载负责 namespace 和插件名前缀。
- `loadAgentsFromPath()`：统一识别插件 Agent source 是 manifest 单文件还是约定目录；
  Registry、validator 和 resource collector 应复用此入口，避免路径解释漂移。
- `parseAgentsFromJson()`：解析 `--agents` JSON。
- `parseAgentsFromSdkInitialize()`：把 SDK initialize 的 `agents` 字段复用同一
  JSON 解析契约。
- 私有 Zod 错误格式化函数只服务加载阶段，不应承担运行期权限或工具过滤。

#### `registry/agentRegistry.ts`

- `AgentRegistry.initialize()` / `reload()` / `_doReload()`：初始化和热重载全部来源，
  并保留 SDK 注入 Agent；模型目录更新后会重校验依赖模型能力的 Agent。
- `loadAgents()`：按 built-in -> resource 快照中的 user/project discovery order ->
  plugin -> flag/SDK 的顺序投影；同名定义以后注册者覆盖先注册者。
- `reload()` 先要求 Config 刷新 resource 和 settings，再重建 registry；user/project
  Agent 文件变化不会自动触发 reload，只有显式 reload 路径（trust 变化、plugin
  refresh 等）会重新投影。
- `loadBuiltInAgents()`：注册本目录内置 Agent。
- `_withBuffer()` / `_applySnapshot()`：用缓冲快照保证 reload 不暴露半加载状态。
- `registerAgent()`：注册本地 Agent 定义。
- `registerLocalAgent()`：校验、enabled 判断、settings override 合并和模型配置注册。
- `applyOverrides()`：合并 model、run、tools 和 MCP override；不要在此实现
  `disallowedTools` 执行逻辑。
- `resolveReasoning()`：在 override 合并完成后生成一致的 thinkingBudget 和
  reasoningEffort；settings/modelConfig thinkingBudget 优先于 frontmatter effort。
- 显式同时配置 `model` 和 `effort` 时，注册阶段必须使用模型目录的 effort 能力
  校验有效组合；不支持或模型不可用时写入 load error，不注册为可调用 Agent。
- `registerModelConfigs()`：为 Agent 注册模型别名；`inherit` 保持未解析，避免注册期基础模型覆盖运行期父请求模型。
- `getDefinition()` / `getAllDefinitions()`：只返回当前可调用定义。
- `getAllDiscoveredDefinitions()` 等 discovered 查询：包含被禁用或被同名定义遮蔽的
  发现结果，主要用于管理 UI。
- `applyPluginAgentPolicy()` / `applyPluginAgentContentSubstitution()`：插件安全清理和
  插件路径变量替换。
- `registerSdkAgents()`：运行时增量注册 SDK Agent 并触发刷新事件。

#### `types.ts`

- 定义本地 Agent、工具配置、运行限制、输入输出、进度、终止原因和 MCP
  引用等共享类型。
- `omitAgentsMd` 是定义级行为开关；不要按 Agent 名称推断是否省略项目/会话指令。
- `isSubagentProgress()`：运行时结构守卫。
- `formatMaxTurnsReachedNotice()` / `formatMaxTurnsReachedSummary()`：
  `AgentTerminateMode.MAX_TURNS` 的完整文案与 UI 精简文案，与它们渲染的枚举同文件。
- 修改字段时同时检查 loader schema、SDK 协议 schema、CLI 展示和测试 fixture。

### 统一 Agent 工具与本地执行

#### `subagent-tool.ts`

- `buildAgentToolInputSchema()`：根据 feature gate 构造统一 `Agent` 工具输入 schema，
  并隐藏仅供内部调用的 `cwd` 字段。
- `buildAgentToolDescription()`：提供稳定的 Agent 工具使用契约；可用 Agent 类型由
  attachments 层的 `agent_listing_delta` system reminder 独立注入，避免类型变化污染
  工具 schema 的缓存前缀。
- `AgentTool.checkPermissions()`：按 deny > ask > allow > 默认放行处理
  `Agent(name)` 内容级规则（名称匹配大小写不敏感）；plain `Agent` 规则由外层
  权限 pipeline 处理。
- `resolveAgentTypeName()`：集中处理模型传入 Agent 类型的精确/归一化/歧义匹配。
  经过它校验的调用入口（`createInvocation()`、`checkPermissions()`、workflow
  adapter）必须用返回的 canonical 名查询 registry，不要再用原始拼写；registry
  自身的 `getDefinition()` 仍是精确匹配，其余直接按名查询的路径不做归一化。
- `disableAgentType()` / `clearDisabledAgentTypes()`：维护 deny 的 Agent 类型集合。
- `setAllowedAgentTypes()`：设置主会话 Agent 的 `tools: Agent(a, b)` 类型白名单；
  克隆到嵌套 Agent 后继承调用方状态，不用子定义重新覆盖（对齐 CC 2.1.233）。
- `setQuerySource()`：给 fork child 标记来源，防止递归 fork。
- `refreshDescription()` / `_buildExcludedTypesSet()`：刷新策略相关描述，并合并
  disabled、全局 exclude 和 allowlist 限制；`getAvailableAgentListing()` 将同一结果
  提供给 attachments 层。
- `createInvocation()`：省略 `subagent_type` 时选择 `general-purpose`；仅当 fork
  feature gate 开启且显式传入 `subagent_type: "fork"` 时进入 fork；Agent 类型在
  精确匹配失败后按 NFKC、大小写、空白、连字符和下划线归一化，并拒绝歧义匹配。
- `AgentInvocation.execute()`：执行本地 Agent 调用。
- `executeLocal()`：处理 execution ID、后台启动、task registry、transcript 和取消；首次启动时只解析一次模型，并同步写入任务与 Teammate 恢复状态；模型解析失败必须经过启动回滚，释放已取得的并发名额。
- `runLocalAgentCore()`：把本地执行收束到 `runLocalAgentInvocation()`。
- 后台完成/失败辅助函数只负责生命周期和输出，不应重新决定工具集。

#### `local-agent-runner.ts`

- `runLocalAgentInvocation()`：本地 Agent 的公共执行门面，统一调用 `runAgent()`，并
  处理任务输出、完成状态、SDK 事件和错误回收；恢复调用把已保存模型作为启动模型输入，
  按原规则解析并登记，不重新继承当前主会话模型。
- `isSubagentProgressLike()`、`getAgentQueryText()` 和活动格式化函数只做结果适配。
- 新增本地 Agent 调用入口时优先复用本函数，避免复制 `runAgent()` 周边生命周期。

#### `run-agent.ts`

- `runAgent()`：本地 Subagent 的主编排函数，负责 worktree、transcript、hook、
  registry、prompt、模型、超时、结果和清理。
- `resolveAgentModel()`：按环境、调用、定义和父请求顺序解析本次执行模型；`inherit` 在启动时读取父请求实际模型，模型策略修改不要混入工具装配。
- 已登记、无父快照的 Agent fork 不再向 `runForkedAgent` 透传模型，由 selector 读取任务中的 `resolvedModel`；未登记仍保留原传参，父快照复用不变。
- 同一个后台 Agent 或 Teammate 恢复时必须复用首次启动保存的 `resolvedModel`；只有
  新建 Agent 才继承当前父请求模型。缺失该字段的旧记录继续使用既有 fallback。
- `buildSubagentRequest()`：保持调用方任务原文，并把 memory、worktree/cwd 和预加载
  skill 构造成独立的 synthetic context messages；仅在定义声明 `omitAgentsMd` 时省略
  项目和会话指令。
- `buildAgentWorktreeSlug()` / isolation 辅助函数：生成并解析隔离执行信息。
- `updateTaskProgressState()` 和 tool display 辅助函数：将 query 事件映射到进度状态。
- 必须在 `buildSubagentRegistries()` 完成后生成 `task_started.tools`，该字段代表最终
  有效工具集。
- 资源清理必须覆盖成功、失败、超时、取消和后台转移分支。

#### `agent-setup.ts`

- `createSubagentToolCallScopeId()`：按 prompt 和 agent invocation 构造隔离的 tool-call scope ID。
- `buildSubagentRegistries()`：工具可用策略的唯一核心实现，依次执行 MCP 发现、
  `tools` 选择、memory 工具补充、fresh/background 公共过滤、`disallowedTools`、
  内部工具和 scheduler/bridge 创建，并把克隆的 `AgentTool` 绑定到子
  `AgentLoopContext`。
- fork 必须同时在父 schema 和子执行 registry 中保留 `AgentTool`；普通 fresh Agent
  在嵌套深度上限内继承 `AgentTool`，达到上限后不再向模型暴露；fork 为保持父工具
  schema 与执行 registry 一致而保留精确工具面，并在真正调用时执行同一深度检查。
- 普通 fresh Agent 不继承主会话控制工具；background fresh Agent 再按异步工具
  allowlist 收窄，MCP 工具继续可用，持久 teammate 额外保留 task/cron 编排工具。
  这两层由 `isAllowedForFreshAgent()` 在注册期判定，被过滤的工具不会克隆进子
  registry；`FRESH_SUBAGENT_DISALLOWED_TOOLS` 同时是
  `READ_ONLY_SUBAGENT_DISALLOWED_TOOLS` 的组成部分，两份策略不会各自漂移。
- `buildSubagentSystemPrompt()`：组合强制前缀、Agent prompt、memory、执行规则和
  已解析模型；cwd/platform 等运行环境通过 query 的统一附件发送。
- Git 分支、状态和最近提交通过 query 的 `session_context` 附件发送。普通子 Agent
  在自己的 cwd 采集；定义声明 `omitGitStatus` 的 Agent（内置 Explore/Plan）跳过新
  采集，不按名称推断。恢复及 fork 复用各自保留的附件，
  fork 同时携带父请求的结构化附件基线，避免重复投影或使用父会话后续状态。
- `session_context` 的 `changed` 附件携带完整替换快照；空替换会明确使旧值失效。
  `reason` 解释重读原因，不触发 Git 重新采集。非 Git 字段通过 query 的
  `resolveSessionContext` 在压缩后按请求解析：未提供解析器时保留继承值，显式空
  `context` 移除非 Git 字段。恢复时最后一条附件校验通过后，即使标记了 `changed`
  也作为完整基线；
  压缩移除全部基线后重新首次注入，辅助 fork 保留已有公告及父请求前缀。
- `toAgentDefinitionLike()`：把内部定义转换成 prompt renderer 使用的最小结构。
- 不要把工具策略散落到 `run-agent.ts` 或 prompt 构造中；新增工具选择语义应集中在
  `buildSubagentRegistries()`。

#### `run-subagent.ts`

- `resolveEffectiveMode()`：合并父会话 mode 和 Subagent 声明 mode。
- `runSubagent()`：建立独立 query 上下文、compression、权限标记、消息 lineage
  和事件包装；selector 主动读取可用的 Agent 定义配置及登记模型。未登记但定义可读时
  只保留必要的运行模型 key；本次配置经内部 config-only `querySelection` 显式传入。
  临时定义及特殊继承由 `getCompatibilitySelection()` 保留原规则，然后调用 `query()`。
- Sampling 只透传 Agent 显式配置，不补通用 temperature；缺省值由公共 query 链路的
  最终模型偏好和后端默认策略决定，transport 负责出站兼容过滤。
- 普通产品请求通过 `providerPurpose: 'task'` 接入会话 manager 的 select/inference，
  暂时复用 prepared 请求与原 runner；子任务不得改写共享主模型锚点。直连 Provider
  保持原传输，SDK 内联 custom_model 在 CLI 解析策略回包时直接拒绝；记忆等 helper
  不因本入口接入而自动迁移。
- `normalizePermissionModeKey()` / `parsePermissionMode()`：接受 permissionMode 的
  兼容拼写并映射为 canonical mode。
- `isPlanModeRequest()`：识别独立 plan 状态；plan 是权限状态，不是工具白名单。

### fork 与内部 Agent 上下文

#### `fork-subagent.ts`

- `isForkSubagentEnabled()`：读取 fork feature gate。
- `FORK_AGENT`：未注册到 registry 的合成定义，仅用于显式
  `subagent_type: "fork"` 的 fork。
- `isInForkChild()`：从消息标记检测递归 fork。
- `buildForkDirectivePrompt()`：构造 fork worker 行为约束和本次执行指令。
- fork 父会话的缓存友好上下文由 `../utils/forkContextUtils.ts` 的
  `buildForkContextMessages()` 统一构造。
- `buildWorktreeNotice()`：把父工作目录路径语义转换到隔离 worktree。
- `ForkToolBridge.getToolSchemas()`：向模型复用父工具 schema。
- `ForkToolBridge.execute()`：把执行委托给 child bridge。
- `NoopToolBridge`：只展示 schema、禁止真实工具执行的文本型 fork bridge。
- `wrapWithParentToolSchemas()`：按是否存在父 schema/child bridge 选择包装方式。

#### `agent-context-factory.ts`

- `buildCheckPermissionOptions()`：构造受限或 bypass fork 的 checkPermission 选项（允许清单或 Yolo，均配拒绝 ask 的 handler）。
- `buildAutoApproveAgentContext()`：建立内部 AgentLoopContext；Skill fork 提供 caller 时继承它的 registry、permission 和深度，保留 deny 与单次调用限制，Skill 自身的 allow 只留在 fork 内。
- `buildMemoryForkToolBridge()`：为 memory fork 构造受限工具 bridge。
- `resolveSkillForkAgent()`：解析 skill fork 使用的 Agent 定义。
- 这些函数服务内部 fork/helper 流程，不代表用户可配置 Subagent 的默认权限。

### 后台任务、结果与可观测性

#### `agent-session-feature.ts`

- `isAgentSessionsEnabled()`：统一判断持久化 Agent session/background 能力是否开启。

#### `agent-task-runtime.ts`

- `registerAgentTask()`：持久化 running task 初始记录，包括首次启动解析出的模型。
- `readAgentTaskRecord()` / `loadAgentTaskRecords()`：读取单个或整组记录。
- `updateAgentTaskRecord()` / `completeAgentTaskRecord()`：更新进度和终态。
- `deleteAgentTaskRecord()`：删除任务记录。
- `reconcileAgentTaskRecords()`：启动时把遗留 running 状态修正为 interrupted 等终态。
- 任务记录、Subagent transcript 和 metadata 是恢复与诊断所需的便利状态，不是
  Agent 执行契约。状态目录返回 `EACCES`、`EPERM` 或 `EROFS` 时，`agent-task-runtime`
  的读写函数记录 WARN 并降级，内存 task registry 继续驱动本次执行；其他 I/O
  错误继续抛出。
- 降级范围仅限 subagent 侧：transcript 读取和 sidechain transcript recorder 自带
  容错，但 `writeSubagentMetadata()` 本身仍会抛出，由 `run-agent.ts` 的 setup
  边界统一捕获并丢弃本次 transcript；主会话 transcript 不参与降级。
- Transcript recorder 一旦因权限失败即锁定降级，后续消息不再尝试写入，因此该
  writer 上更晚出现的其他 I/O 错误不会再被观测到。
- 私有路径和写入函数只负责原子持久化，不应承担 UI 状态推断。

#### `agent-tool-result.ts`

- completion/background 两组接口定义统一 `Agent` 工具结果协议。
- `isAgentToolCompletionResult()` / `isAgentToolBackgroundLaunchResult()`：结果守卫。
- `buildAgentToolCompletionResult()` / `buildAgentToolBackgroundLaunchResult()`：结果构造器。

#### `progressTracker.ts`

- `ProgressTracker` 把 assistant、tool use、tool result 和错误事件转换成
  `SubagentProgress`。
- `markRunningAs()` / `addErrorActivity()`：批量或追加终态活动。
- `updateToolDisplay()`：接收 scheduler 完成事件的工具展示信息。
- `makeProgress()`：生成当前 UI progress 快照。
- `handleQueryEvent()`：消费 query 事件并更新 thought/tool activity。
- 私有 result/description 解析函数只做展示适配，不改变真实执行状态。

#### `subagent-message-context.ts`

- `attachSubagentMessageContext()`：给 transcript message 添加 session 和
  `parent_tool_use_id`。
- `attachSubagentQueryEventContext()`：对 query event 做同样的 lineage 包装。

#### `subagent-sdk-events.ts`

- `enqueueSubagentSdkEvent()` / `drainSubagentSdkEvents()` /
  `waitForSubagentSdkEvent()`：维护按 root session 隔离的有界事件队列。
- `getSubagentSdkEventTaskIdentity()`：把事件归属投影成中立的 `taskId` /
  `toolUseId`，供会话层按后台任务过滤。
- `disposeSessionEventQueue()`：释放等待者和队列。
- `createTaskStartedEvent()`：创建包含最终 `tools` 快照的启动事件。
- `createTaskProgressEvent()` / `createTaskNotificationEvent()`：创建进度和终态通知。
- `countUsageTotalTokens()`：规范化 usage 汇总。

### Memory

#### `agentMemory.ts`

- `isValidMemoryScope()`：校验 Agent memory scope。
- `getAgentMemoryDir()` / `getAgentMemoryEntrypoint()`：解析每个 Agent 的 memory 路径。
- `isAgentMemoryPath()`：判断路径是否位于 Agent memory 目录。
- `ensureAgentMemoryDirExists()`：按需创建 memory 目录。
- `buildAgentMemoryPrompt()`：生成持久化 memory 使用说明。
- memory 开启时工具补充发生在 `buildSubagentRegistries()`，不是本文件。

#### `memory-extraction-agent.ts`

- `buildMemoryExtractionDirective()`：为内部 memory extraction worker 构造 scope、
  现有文件和写入约束。
- scope routing 私有函数只负责 prompt 文本，不负责实际文件授权。

### 内置 Agent 定义（`builtin/`）

注册进 registry 的内置 Agent 定义统一放在 `builtin/` 子目录：

- `builtin/general-purpose-agent.ts`：`GeneralPurposeAgent()`，全工具继承后移除主会话控制工具。
- `builtin/explore-agent.ts`：`ExploreAgent()`，继承 active 工具后应用只读/搜索型黑名单。
- `builtin/plan-agent.ts`：`PlanAgent()`，工具策略与 Explore 同类，prompt 负责计划输出。
- `builtin/statusline-setup-agent.ts`：`StatusLineSetupAgent()`，显式只允许
  Read/Edit/Write/Bash。
- `builtin/read-only-agent-prompt.ts`：Explore/Plan 共享的只读 prompt 与工具黑名单常量。

### Agent Teams（`teams/`）

进程内 agent team（持久 teammate）相关代码统一放在 `teams/` 子目录：

- `teams/agent-teams-feature.ts`：feature gate（`isAgentTeamsEnabled()` 等）、
  `IN_PROCESS_TEAMMATE_TASK_TYPE` 和 `deriveSessionTeamName()`，是目录外
  （config、scheduler、messaging）唯一广泛依赖的入口。
- `teams/agent-team-runtime.ts`：team 状态与成员记录的持久化。
- `teams/agent-team-tools.ts`：`createAgentTeamTools()` 构造 teammate 的
  task/cron 编排工具集。
- `teams/agent-team-hook-coordinator.ts`：teammate hook 协调与 team mailbox
  消息格式化。
- `teams/agent-team-controller.ts` / `agent-team-task-coordination.ts` /
  `agent-team-wakeup.ts` / `agent-message-delivery.ts`：teammate 信号、任务
  协调、空闲唤醒和消息投递（唤醒执行统一走
  `../local-agent-runner.ts: runLocalAgentInvocation()`）。
- `teams/agent-team-peer-message.ts` / `agent-team-main-delivery.ts`：
  teammate 消息与 idle 摘要的格式化。

与 agents 核心的耦合点：`run-agent.ts` 按 `IN_PROCESS_TEAMMATE_TASK_TYPE`
注入 team tools 和 hook coordinator 并生成 idle 摘要；`subagent-tool.ts` 是
teammate 后台生命周期的宿主，依赖 7 个 teams 模块（成员预留与状态更新、
inbox 读取、任务认领与释放、controller 信号等待、消息与 idle 摘要格式化）。
存在 `run-agent -> teams -> local-agent-runner -> run-agent` 的模块级循环，
改动 teammate 生命周期时两侧都要检查。

### 其他共享文件

- `agentModelConfig.ts`：合并 Agent 模型配置；`resolveConfiguredAgentModel()` 在注册校验、Subagent 执行和会话 Agent 启动时先复用 `../provider/model/resolveModelName.ts` 解析目录名称并检查歧义，未命中时才查询 Provider 以兼容目录外路由 key；只负责异步查询和 Agent 错误转换，Provider 查询契约保持按 key。
- `readAgentSelectionDefaults()` 默认读取 AgentRegistry 的有效定义，并在 TaskRegistry 可用时读取启动模型；没有任务登记也可返回配置。fork 用途仍只读登记模型，不查定义。`generationOverridesFromDefinition()` 投影显式生成配置。两者不负责恢复历史、持久化新状态或执行 SDK 策略。
- `subagent-limits.ts`：嵌套深度与并发上限的唯一来源。`canSpawnSubagentAtDepth()`
  是深度比较的单一实现（`AgentTool.createInvocation()` 拒绝调用、
  `buildSubagentRegistries()` 隐藏工具，两处共用）；env 名来自 `config/brand.ts`
  的 `ENV_MAX_SUBAGENT_SPAWN_DEPTH` / `ENV_MAX_CONCURRENT_SUBAGENTS` 常量，
  勿硬编码品牌前缀（实际变量名由构建品牌决定）。
- 所有同名 `*.test.ts` 与实现文件同目录；修复时优先补对应单测，不要只依赖宽泛
  integration test。

## 修改落点

| 需求 | 首选文件/函数 |
| --- | --- |
| 新增或修改 frontmatter/`--agents` 字段 | `registry/agentLoader.ts` schema、转换函数、`types.ts` |
| 修改 Agent 来源优先级、enable 或 override | `registry/agentRegistry.ts` |
| 修改 `tools`、MCP 通配、递归 Agent 或 `disallowedTools` 顺序 | `agent-setup.ts: buildSubagentRegistries()` |
| 修改 `Agent(name)` allow/deny | `subagent-tool.ts` 与 `../tools/tool-names.ts` |
| 修改 Subagent permissionMode | `run-subagent.ts`，并检查 `../permissions/` |
| 修改本地执行生命周期、worktree、hook、timeout | `run-agent.ts` |
| 修改后台启动/完成/取消 | `subagent-tool.ts`、`local-agent-runner.ts`、`agent-task-runtime.ts` |
| 修改 SDK `task_*` 事件 | `subagent-sdk-events.ts`、`run-agent.ts` |
| 修改 fork schema 或 cache 对齐 | `fork-subagent.ts` |
| 修改内置 Agent 工具策略 | `builtin/` 下对应 `*-agent.ts`，并验证最终 registry |
| 修改 fresh/background 公共工具过滤 | `../tools/tool-names.ts` 常量 + `agent-setup.ts: isAllowedForFreshAgent()` |
| 修改嵌套深度或并发上限 | `subagent-limits.ts`，env 名加到 `config/brand.ts` |

## 验证要求

- Loader 或字段变更：运行 `registry/agentLoader.test.ts`、
  `registry/agentRegistry.test.ts`。
- 工具白名单、黑名单、MCP 或递归 Agent 变更：运行 `agent-setup.test.ts`、
  `subagent-tool.test.ts`，断言最终 registry 或 `task_started.tools`。
- permissionMode 变更：运行 `run-subagent.test.ts` 和相关 permissions 测试。
- 生命周期、后台、worktree、hook 变更：运行 `run-agent.test.ts`、
  `subagent-tool.test.ts`、`agent-task-runtime` 相关测试。
- fork 变更：运行 `fork-subagent.test.ts`，同时检查 schema 展示和 bridge 执行。
- 在 `packages/core` 目录直接运行目标测试，避免从仓库根目录启动 Vitest，
  也避免 workspace `posttest` 在只验证局部逻辑时触发整包构建：

```bash
npx vitest run src/agents/<target>.test.ts
```

## 维护本文件

- 新增生产文件或移动核心函数时，同步更新“文件与函数职责”和“修改落点”。
- 记录稳定的函数名和职责，不记录易漂移的行号，也不复制大段实现代码。
- 如果某个子目录获得自己的 `AGENTS.md`，将具体文件说明下沉，父级只保留模块边界
  和跨模块约束。
- 结论必须区分声明配置、模型可见 schema、可执行 registry 和 permission 决策；不要
  把其中任一层当成完整的“工具可用性”。

### 单次调用工具限制

- `buildSubagentRegistries()` 在 Agent 定义裁剪前保留父工具与本次发现池的名称，用于校验单次 deny 的拼写；additionalTools/CompleteTask 注入后应用内部 `toolConstraints`，校验最终可执行工具集；定义、父 registry 和其他 agent 不变。
- `../tools/agent-tool-constraints.ts` 校验单次 deny/clamp 参数，解析工具别名与 MCP server 名称，并移除最终 registry 中被禁用的工具。`requiredTools` 防止结构化输出工具被禁用后又被注入恢复。
- `../permissions/agent-tool-constraints.ts` 为该执行上下文包装父 permission manager：每次调用先检查约束，再交给原权限决策；批准后的输入重写同样检查。子 agent 继承包装后形成交集。
- 新 TUI 的 Skill fork 及 Skill shell 预处理必须传递实际调用上下文；定义预加载 Skill 使用已经收窄的 schedulerContext。不能从 Config 根权限重建并丢弃单次限制。集成入口继续由各自开关单独启用。
- Bash clamp 复用 `shellPermissions.ts` 的规则匹配和 `shell-utils.ts: getBashClampCommandSegments()` 的解析；不能逐段验证的命令拒绝执行。对应宿主额外执行面（Monitor、BashInput、MCP）在 clamp 下不可用。
- `local-agent-runner.ts` / `run-agent.ts` 只传递内部选项；不增加 Agent frontmatter、SDK 参数或全局权限设置。
