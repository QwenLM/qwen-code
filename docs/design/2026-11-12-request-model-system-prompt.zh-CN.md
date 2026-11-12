# 按请求模型解析主会话系统提示词

[English](2026-11-12-request-model-system-prompt.md) | [简体中文](2026-11-12-request-model-system-prompt.zh-CN.md)

## 状态与范围

已实现并完成本地验证，2026-11-12。基线主线代码核对基于提交
`dd5f1d1b89ab5d1edd9087813b14fc65a0707863`。参考实现为标签
`v1.0.0-preview`，提交 `587e3429cabf8cfb7c6be2d774ab63d0f36fe97e`。
本地验证结果及剩余限制记录于下文。

用一个范围明确的 bugfix PR 交付：在确定出站请求的模型之后，解析主会话的默认系统提示词。
复用 main 现有的提示词内容、模型路由和 provider 适配器；不移植 preview 的事件总线、
提示词 bundle、行为策略或 section 缓存。

## 问题与基线行为

修复前，主会话在创建聊天时构建系统提示词。`getMainSessionBaseSystemPrompt()` 读取
`config.getModel()`，`startChat()` 将组装后的字符串存入
`LlmChat.generationConfig`。后续请求即使发给另一个模型，也继续复用该字符串。

例如，会话使用 `qwen3-coder` 启动，之后向 `qwen3-vl` 发送请求时，仍可能携带 coder
的工具调用示例。目前主要受模型影响的内容是 `getToolCallExamples()` 选择的四套示例：
qwen-coder、qwen-vl、gemma4 或 general。代码模式和 `QWEN_CODE_TOOL_CALL_STYLE`
可能使这种模型差异不再体现；复现时应避免无意启用这两种覆盖。

| 路径                         | 当前行为                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- |
| 本地 TUI 切模型              | 模型变更监听只刷新 UI 状态，没有刷新系统提示词。                              |
| 单次 `/model <id> <prompt>`  | 请求带模型覆盖，但仍使用聊天中保存的提示词。                                  |
| 模型 fallback                | 另一 generator/模型接管请求，提示词仍是原来保存的内容。                       |
| ACP/serve 切模型             | 切换处理器显式调用 refresh，覆盖了这些入口，但没有形成统一请求约束。          |
| 非流式默认提示词             | `LlmClient.generateContent()` 在解析目标模型的 generator 之前构建默认提示词。 |
| 显式侧查询/agent/fork 提示词 | 提示词由调用方拥有；替换为主会话默认提示词会造成回归。                        |

preview 值得借鉴的是顺序：先选模型，再按选中的模型解析提示词；同时区分需要组装的
默认提示词和固定的用户/agent 正文。main 可以局部引入这两个性质。

## 目标行为

每个新准备的主会话请求，如果使用默认提示词，都应按适配器当前模型语义选出的目标选择
模型相关内容。在持久化捕获和发出请求之前，将该模型选择与提示词绑定为准备快照。
本 PR 覆盖请求准备前的选择；已在运行的 generator 被并发修改时，存在“交付与取舍”中
说明的独立限制。

- 常规切模型作用于下一次请求，包括工具结果回传后发起的新模型请求。
- 单次模型覆盖和 fallback 使用适配器选出的实际目标的示例；之后的普通请求重新使用会话选中的模型。
- 同一目标的 HTTP 重试和传输恢复保持已经准备好的提示词字节；切换到另一个 fallback
  目标时生成另一份快照。
- 保留对话历史、来源优先级、提示词层次顺序、工具可见性约束、output style、memory
  和 SessionStart 附加内容。
- 显式请求提示词和已保存的 prepared request 保持最高优先级；agent 提示词和 fork
  已渲染提示词继续遵守固定正文约定。

## 实现

### 1. 为提示词渲染显式传入模型

主会话提示词 builder 增加模型参数，已有调用默认使用会话选中的模型。将该参数传给
现有 `getCoreSystemPrompt()` 的模型选择逻辑。不得为了渲染另一种提示词而临时修改
`Config.getModel()` 或触发模型切换。

拆开提示词渲染和会话静态缓存前缀的发布。按请求模型渲染完整提示词，另外仅为常规会话
变体发布稳定前缀，保留现有层次顺序：

1. Base prompt。
2. 媒体指导。
3. 上下文文件。
4. 追加系统提示词。
5. Auto-memory。
6. 已保存的 SessionStart 上下文（存在时）。

稳定前缀仍截止在 auto-memory 和 SessionStart 上下文之前。

将来源加载和诊断文件导出移出可重复调用的渲染路径。完整系统提示词文件和身份覆盖文件
在启动及现有显式 refresh 生命周期中加载；用一个小型、归会话所有的来源快照保存其
原始文本。完整自定义正文跳过默认模板渲染。现有公开 `getCoreSystemPrompt()` 通过
包装保留原行为。请求路径不重复读取覆盖文件、不写入 `QWEN_WRITE_SYSTEM_MD`
导出文件、不预热工具注册表，也不执行 Hook。

这里仅分离来源所有权与渲染，不建设新的提示词缓存框架。不增加持久的按模型缓存、文件
监听、配置开关或新的失效协议。每个新请求边界都使用已加载的来源和当前内存中的会话输入
进行渲染；现有 refresh 入口继续重新加载来源，并执行原有导出行为。

### 2. 仅为主聊天安装 resolver

给 `LlmChat` 增加聊天实例所有的 resolver，通过独立的内部 setter，由
`LlmClient.startChat()` 安装，保留现有构造函数调用形式。resolver 属于聊天实例，
不得进入 `GenerateContentConfig`、已保存请求或可克隆的缓存快照。

`AgentCore` 和 `createForkedChat()` 不安装主会话 resolver。普通 `LlmChat`
如果只持有固定提示词，继续保持原有行为。

提示词按以下优先级解析：

1. 已保存的 prepared request 直接使用其保存的提示词，不重新求值。
2. 显式传入的请求提示词保留该入口原有的归一化和空值语义。
3. 安装 resolver 的主聊天按实际模型生成提示词。
4. 其他聊天使用保存的 generation configuration。

通过 resolver 是否安装及请求覆盖决策显式表达来源，不通过匹配或替换提示词字符串
猜测其所有权。

### 3. 在统一请求边界解析

使用同一个 send 局部准备 helper，在获得 send 锁并确定目标 generator 配置后调用。
主请求提示词必须在工具结果压力预算裁剪和首次压缩之前准备，不能等到即将调用 API 时
才准备。按现有适配器语义确定提示词模型：

| 适配器                     | 准备时使用的提示词模型                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI/QWEN_OAUTH          | 复用 `getRequestModel(actualConfig, model)`，包括 `samplingParams.model` 和 `extra_body.model` 优先级。                                           |
| Anthropic/OpenAI Responses | 使用这些适配器当前实际发送的 `actualConfig.model`。                                                                                               |
| Gemini/Vertex AI           | 遵循现有适配器，使用请求模型。                                                                                                                    |
| Qwen Subscription          | 遵循其 OpenAI pipeline：使用请求模型，provider 再应用字符串 `extra_body.model` 覆盖；不能假定此 auth 类型同样应用 Chat 的 sampling 模型覆盖规则。 |

将这个小型、感知适配器的选择 helper 放在现有 request-model 工具旁，用 wire 测试覆盖。
单独使用 `getRequestModel()` 并不能统一解析所有协议的 wire 模型。Qwen Subscription
通过 `SubscriptionProvider` 委托 OpenAI pipeline，应覆盖这条委托路径。此次修复不改变适配器模型覆盖能力、路由 selector、
provider pin、凭据或遥测中的模型标识。例如，若某适配器在单次请求指定 B 时实际仍发送
配置模型 A，提示词应跟随实际 A；让该适配器支持 B 属于另一项行为变更。

解析后的提示词写入请求局部配置，通过现有待发请求配置传给压缩。固定输入变化时，
在压力预算读取旧 anchor 之前使其失效。常规流式和 fallback 共用的
`LlmChat.makeApiCallAndProcessStream()` 在确定 `actualConfig` 后消费已准备的快照；
fallback 用同一个 helper 为自己的目标准备快照。临时目标不得覆盖聊天的常规提示词或
会话选中模型。应在 `onPreparedRequest` 之前完成准备，使持久化记录与实际发出的
提示词一致。

同一次 send 内，同一解析后目标复用已经准备好的提示词，包括外层传输恢复尝试。
一个 send 局部快照即可，send 结束后丢弃；fallback 为自己的目标准备快照。独立保留
提示词是否由调用方显式提供的信息，避免 fallback 把为主模型生成的提示词误认为显式
覆盖。resolver 出错时应在发出请求前结束准备，不发送旧提示词，也不因此改试其他模型。
fallback 在当前请求配置中替换生成的提示词，保留此前已应用的输出 token 上限裁剪及
其他恢复调整。

`LlmClient.generateContent()` 将默认提示词解析移至 `resolveForModel()` 之后，
使用解析后的 generator 配置和模型，并在 HTTP 重试回调外构建一次提示词。保留显式
侧查询提示词现有的组装行为。`BaseLlmClient` 中为专门任务提供的侧查询不接入主会话
提示词 resolver。

### 4. 保留 SessionStart 上下文和常规会话快照

将已经生成的 SessionStart 附加内容保留为聊天实例的尾部状态。固定提示词和动态提示词
复用现有尾部组装规则：末尾恰好一个 context block，更新时替换，不累积。
启动、compact、refresh 和 restore 都要维护该状态；重建请求不重新执行 SessionStart。

`getGenerationConfig()` 继续返回普通、可克隆的配置。安装 resolver 的主聊天应按
当前会话选中模型的实际 wire 名称生成常规提示词，不能返回最近一次临时模型/fallback
的变体。固定聊天继续返回自身保存的配置。

另外保留最近一次实际发出的请求所使用的 generation configuration 普通快照。
在持久化准备成功、请求实际发出时记录，不在渲染或读取常规快照时记录。由该请求触发的
advisor 和 fork 工具使用这份快照：即便用了临时模型，执行器上下文及精确父前缀也应描述
真正产生工具调用的请求。快照同时保留其所属路由/模型，不把它与常规模型配对，也不写入
共享全局状态。可克隆的生成配置与保留选中 generator 的临时 runtime view 分开保存。
复制该 view 的配置并标注已发出的模型，不修改共享 generator 配置。fork 将这个父模型、
runtime view 与固定提示词一起继承，后台容量计数也使用它们。这是聊天实例的临时状态，
不新增持久化格式。已有常规快照消费方继续遵守会话模型约定。

常规快照与出站请求共用同一个 renderer。如果为已经解析过的待发请求准备缓存共享压缩，
通过现有 `requestGenerationConfig` 参数传入该请求的完整提示词。保留现有冷路径压缩
提示词和同路由缓存共享资格判断；不把压缩任务的提示词替换为主会话编码助手默认提示词。

### 5. 保留缓存与预算行为

仅为常规会话变体发布 `Config.staticSystemPrefix`。渲染单次覆盖、fallback 或
非流式临时变体不替换该值。继续使用 Anthropic 现有的精确前缀检查：临时变体若不匹配，
安全退回现有的单个 system block 布局。本 PR 接受临时变体可能无法使用额外的稳定前缀
缓存断点；不增加请求 metadata 字段，也不修改 provider 适配器。

请求发出前，将解析后的固定提示词与上一请求使用的提示词比较。若变化，在捕获请求版本前
清除工具预算 usage anchor，并推进 fixed-input version。保留现有保护：迟到的响应或
backoff 期间的 setter 不能把旧输入的 usage 注册为当前 anchor。单纯读取常规会话快照，
不能将临时请求的 usage 归属于常规提示词。

## 影响文件与消费方

以下行号对应本次核对的 main 提交。

| 组件                                                                           | 变更                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/core/client.ts`                                             | 显式提示词模型参数（573）、渲染与前缀发布分离（2242）、安装 resolver（3041）、调整非流式解析顺序（6506）。                                               |
| `packages/core/src/core/llm-chat.ts`                                           | 聊天实例 resolver、保存 SessionStart 尾部（3327）、在预算/压缩前准备、统一 dispatch（5995）、常规快照 getter（6969）、已发出请求快照、预算 anchor 失效。 |
| `packages/core/src/core/prompts.ts`                                            | 使用已加载来源文本复用现有渲染，将文件加载/导出留在每次请求路径之外；保持示例选择逻辑（1362）。                                                          |
| `packages/core/src/core/request-model.ts`                                      | 增加小型、感知适配器的提示词模型选择 helper，保留 `getRequestModel()` 已有调用方行为。                                                                   |
| `packages/core/src/tools/advisor.ts`、`packages/core/src/tools/agent/agent.ts` | 活跃执行器/fork 上下文读取已发出的父请求快照，替代常规会话快照。                                                                                         |
| 同目录测试                                                                     | 覆盖渲染、目标模型选择、fallback/retry/replay、快照所有权和预算行为。                                                                                    |
| 设计与 E2E 产物                                                                | 本中英文文档，以及 `.qwen/e2e-tests/` 下的基线/本地 E2E 报告。                                                                                           |

以下现有消费方需要针对两种快照约定做回归覆盖：

| `getGenerationConfig()` 消费方                          | 需要保留的行为                                      |
| ------------------------------------------------------- | --------------------------------------------------- |
| `client.ts:1706` → cache-safe params → fork/speculation | 可克隆的常规提示词，与会话选中模型配对。            |
| `tools/advisor.ts:110`                                  | 使用已发出请求的执行器提示词及工具上下文。          |
| `tools/agent/agent.ts:2010`                             | fork 使用已发出父请求的固定已渲染提示词及匹配路由。 |
| `agents/background-agent-resume.ts:1801`                | 持久化字面配置，不包含可执行回调。                  |
| `utils/btwUtils.ts:52`                                  | 保留可克隆的侧问题快照。                            |
| `services/chatCompressionService.ts:1022`               | 仅在现有资格规则下共享目标请求的前缀。              |
| `packages/cli/src/ui/commands/summaryCommand.ts:194`    | 保留显式继承的提示词。                              |
| `packages/cli/src/ui/opentui/live-session.ts:863`       | 保留工具可见性检查。                                |

还需验证 `agents/runtime/agent-core.ts:615` 和 `agents/forkedAgent.ts:233`
的固定聊天构造路径、`llm-chat.ts:3380` 的 prepared replay，以及
`anthropicContentGenerator.ts:894` / `converter.ts:1153` 的前缀处理。
不新增 daemon 路由、宿主 API、持久化 schema 或 CLI 选项。运行时代码实现限于 Core。

## 验证与验收

以捕获的实际出站请求体为判断依据。模型自述身份、UI 标签或 resolver mock 被调用，
都不能证明发出了正确提示词。使用不同示例家族，同时断言目标家族存在、前一模型家族缺席。

| 场景                                        | 验收标准                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 同一 TUI 会话 A → B → A                     | 每个下一请求都携带目标模型示例，历史保留。                                                         |
| 选中 A，单次使用 B，适配器支持该覆盖        | B 收到自己的示例；下一普通请求和常规快照使用 A。                                                   |
| 主模型 A → fallback B → 下一主请求 A        | 各目标使用自己的示例；fallback 不改变会话选择。                                                    |
| OpenAI sampling/extra-body 模型覆盖         | 提示词跟随 `getRequestModel()` 和实际 wire 模型，包括覆盖优先级。                                  |
| 切模型后的工具结果续接                      | 新准备的请求使用新目标提示词，无须重启聊天。                                                       |
| 同目标重试及传输恢复                        | backoff 期间 memory/style 等提示词输入变化时字节保持一致；generator 路由并发变化属于下述独立限制。 |
| 非流式默认/显式提示词                       | 默认提示词跟随解析后的模型，显式任务提示词保留原有组装行为。                                       |
| 自定义 system/agent/fork 及工具调用风格覆盖 | 正文及显式风格选择保留原有所有权和优先级。                                                         |
| SessionStart、refresh、compact、restore     | Hook 上下文恰好一次，渲染不引发额外 Hook 执行。                                                    |
| 模型/风格改变后重放 prepared request        | 保存的提示词原样重放，保留现有 provider-pin 检查。                                                 |
| 临时路由期间/之后读取常规快照               | 快照可克隆，描述会话选中模型。                                                                     |
| 临时模型 B 触发 advisor/fork                | 执行器上下文及固定 fork 提示词描述已发出的 B，常规会话快照仍为 A。                                 |
| 压力预算/压缩前提示词变化                   | 使用前清除旧 anchor，共享压缩收到已解析的待发提示词。                                              |
| 适配器忽略请求覆盖而发送配置模型            | 提示词匹配捕获的 wire 模型；本 PR 不增加该适配器的模型覆盖能力。                                   |
| Anthropic 缓存及固定输入变化                | 常规前缀仍可用，临时失配安全退化，拒绝使用旧预算 anchor。                                          |
| 来源 I/O 与确定性渲染                       | 常规请求准备不重复读文件/导出，相同输入生成相同字节。                                              |

### 本地结果

`npm run build`、`npm run typecheck`、`npm run bundle` 和定向 ESLint 均通过。
六个变更测试文件中的 2,034 个用例全部通过；另外 328 个压缩、fork 缓存/agent、
agent runtime 和侧查询快照回归用例通过，单元测试合计 2,362 个。

E2E 计划首先对全局 `qwen` 版本 `0.18.5-preview.0` 做 dry-run，复现切到 VL 模型后
仍携带 coder 示例。同版本 `0.27.2` 基线也复现了问题。该对照 bundle 使用相同 checkout
及依赖，由 esbuild 在来源输入阶段将六个变更生产模块替换为主线提交 `dd5f1d1b89` 的
版本，并非独立干净 main worktree。捕获的基线请求使用不同 wire 模型，系统提示词字节
却相同，且都携带 coder 示例。

修复后的 `0.27.2` bundle 使用合成凭据和隔离的本地回环 provider，通过 11 个交互式
PTY 场景：七个默认提示词场景（A → B → A、单次 B → A、强制 fallback B → A）
和四个完整自定义 system 加 appended system 场景。每个 fallback 组先制造七次主模型
HTTP 503，再由 B 成功响应。默认请求包含实际目标的示例家族，且不包含另一家族；
自定义提示词字节始终相同。历史保留，SessionStart 上下文恰好一次，每个会话 Hook
仅执行一次。环境没有 tmux，因此使用 PTY 自动化。

被忽略的 E2E 计划/报告保存在 `.qwen/e2e-tests/request-model-system-prompt.md`；
原始请求体、交互记录、Hook 计数及机器可读断言保留在
`/private/tmp/qwen-request-model-verify-20261112/`。E2E 报告应另发 PR 评论。
适配器模型选择、重试、重放、预算及快照所有权由定向单测覆盖；真实 provider、其他协议
原生 wire 格式、Windows 和 Linux 未进行本地 E2E。下述在途 Qwen OAuth 限制仍然存在。

## 交付与取舍

建议 PR 标题：`fix(core): resolve system prompts for the request model`。
渲染调整、请求接线、回归测试和中英文设计放进同一个 PR。不先提交仅补 TUI refresh 的
补丁，否则单次覆盖和 fallback 仍不满足统一约束。

主要实现风险是重试快照漂移、Hook 上下文丢失、混淆常规快照与已发出父请求快照，以及旧预算 anchor。
上述请求与快照测试作为发布标准。默认提示词组装会增加请求准备阶段的本地工作；该路径
不包含文件 I/O、Hook、注册表预热或新缓存。临时模型缓存断点的优化，可在有测量依据时
另行考虑。

已知限制：Qwen OAuth 切模型会原地修改 generator 配置，其 OpenAI pipeline 会在重试
及异步加载凭据后再次读取该配置。因此，在请求已运行期间修改模型覆盖，可能在提示词准备
之后改变实际 wire 目标。聊天层提示词快照无法冻结该目标，本 PR 不应宣称对此竞态实现了
preview 更强的模型/提示词原子绑定。应单列后续工作：在适配器边界固定 wire 模型，并覆盖
持久化和重试；不悄然将本 PR 扩大为路由重写。本次验收常规请求完成之间的切换，将在途
请求的 generator 并发修改明确记录为剩余缺口。

实现保持上述所有权、优先级和重试约定。除已记录的检查外，提交前还需对完整差异完成
连续两轮干净自审，并单独完成代码审查。
