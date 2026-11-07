# 无参数工具的 `parameters` 字段开关

[English](./2026-09-17-parameterless-tool-parameters.md)

状态：已实现。

## 问题

不接受任何参数的 function tool 在请求中不会携带 `parameters` 对象。
严格 OpenAI 兼容服务器如果把 `tools[].function.parameters` 声明为必填字段，
就会因此拒绝整个请求。已确认的抓包属于 serde 一族 —— 经网关的
`deepseek-v4.1-flash` 路由上报出 `400 litellm.BadRequestError: ...
tools[5].function: missing field parameters`（#11956）。Pydantic 一族的服务器
对同一种拒绝给出的报错是 `tools[].function.parameters` 的 `Field required`，
也就是 TabbyAPI 在该服务器为这个字段提供默认值（tabbyAPI `fb80a9372859`，
2026-09-26）之前所报告的形态；因此"验证"一节里的 TabbyAPI 实测记录是带日期的
历史纪录，而不是当前可复现的路径。请求在模型看到任何工具之前就失败了，
所以一个工具调用都无法发出。

## 为什么今天会省略该字段

省略是有意为之，并非疏漏。提交 `03005a2bbf`
（`fix(core): omit parameterless OpenAI tool schemas`，#11431）在 #10080 的
语法放宽之上加入了这一行为，其提交信息中的脉络为 #10520 → #11410 → #11431：

- `relaxSchemaForFunctionCalling` 会删除空的 `properties` 对象，因此零参数 schema
  到达线上时是裸的 `{ "type": "object" }`。
- 这个裸形状正是 #11410 报告的 HTTP 400：LM Studio 的校验器指明
  `function.parameters.properties` 缺失，因为请求里 `parameters` 存在却没有
  `properties`。#11410 只涉及 LM Studio —— #11410 与 #11431 的正文和全部评论
  都完全没有提到 vLLM。
- MiniMax 相反地要求该字段存在，并且需要 `{ "type": "object", "properties": {} }`
  （#11834），已经在自己的 provider 里于下一层注入。

因此规范的两端互相冲突：满足一方的形状会被另一方拒绝。converter 无法选出一个
同时服务两者的形状。

## 决策

### 按路由显式开启，不做端点探测

`model.generationConfig.toolParametersMandatory`（默认 `false`）决定该行为，
与既有的 `splitToolMedia`、`toolResultContentFormat` 同属严格服务器类开关。
否决了端点探测：自托管服务器与 llama.cpp、LM Studio、Ollama、vLLM 共用
`localhost` —— 正是需要省略该字段的那些端点 —— 而 TabbyAPI 的端口可配置，
所以 URL 并不能提供把它区分出来的事实。

provider 选择同样不能充当闸门。`openaiContentGenerator/provider/` 里九项厂商
判定条件中有四项同时按模型 id 匹配：`deepseek` 子串（`deepseek.ts`）、
`glm-` 前缀（`zai.ts`）、`mimo-` 前缀（`mimo.ts`）以及七个 Mistral 标记
（`mistral.ts`）。因此运行 `deepseek-v4.1-flash` 或 `glm-4.6` 蒸馏版的本地服务器
在任何 baseUrl（包括回环地址）下都会被路由到该厂商的 provider，
而其中只有 MiniMax 会注入 `parameters` schema。该开关改为在每次请求时读取。

该字段声明在 `ContentGeneratorConfig` 上，并加入 `ModelGenerationConfig` 与
`MODEL_GENERATION_CONFIG_FIELDS`，因此 `modelProviders` 条目可按模型设置它；
文档见 `docs/users/configuration/settings.md`。

### 在出网边界修复，而不是在 converter 中

`DefaultOpenAICompatibleProvider` 在开关开启时，为 `parameters` 为 `undefined`
的任意工具补上 `{ "type": "object", "properties": {} }`。每一个厂商 provider 都会
串联 `super.buildRequest`，因此无论路由由哪一个 provider 持有，修复都能到达；
DashScope 自行组装请求，从其合并步骤调用同一份修复。映射本身放在
`provider/utils.ts`，MiniMax 的无条件注入也使用它。

若在 converter 中处理，就意味着为所有 OpenAI 兼容路由选定同一种形状，
而 `provider/minimax.ts` 明确记录了这一约束。

在请求层而非工具列表层处理，也同时覆盖了工具完全没有 `parameters` 的两种成因：
以 converter 会归约的形式声明空参数列表的工具（被归约为 `undefined`），
以及完全没有声明 schema 的工具（从未获得 schema）。
在 converter 侧的修复只能覆盖前者。

第三种形状被原样保留，因为它本就带有该字段：声明为 `{ "type": "object" }`
且没有 `properties` 键的 schema。归约的条件比"声明了空参数列表"更窄，
必须同时满足三项：schema 经 `parametersJsonSchema` 声明而非 Gemini 的
`parameters`；它声明了空的 `properties` 对象，或 `properties` 缺失且
`additionalProperties: false`；并且源 schema 的每一个键都在
`PARAMETERLESS_SCHEMA_KEYS` 白名单所列的关键字之中。裸对象不满足第二项，
因此 `relaxSchemaForFunctionCalling` 保留它，以 `parameters === undefined`
为条件的修复也不改动它。携带白名单之外某个键的零参数 schema 不满足第三项：
`required` 与 `minProperties` 都不在白名单内，因此
`{ "type": "object", "properties": {}, "required": [] }` 既未被归约也未被修复，
而放宽步骤在出网前删去了它的空 `properties`，最终上线为
`{ "type": "object", "required": [] }`。针对 converter 的实测结果为：
`{ "type": "object", "properties": {} }` 先被归约、随后被修复为空对象 schema；
`{ "type": "object" }` 原样上线；带 `required: []` 的 schema 上线为
`{ "type": "object", "required": [] }`。经 Gemini `parameters` 声明的工具
不满足第一项，因此其 schema 到达修复时本就带有该字段。开启开关的请求于是
对被归约的工具发出空对象 schema，对每一个被修复步骤原样保留的工具发出其
自身声明的形状。两种情况字段都在，下面的 2026-09-19 TabbyAPI 实测记录裸形状为
HTTP 200，所以这是形状不一致，而非请求被拒。以空参数列表注册的 MCP 工具并不属于这一豁免：
SDK 会把它发布为 `{ "type": "object", "properties": {} }`，
该形状同时满足三项条件，因此开启开关后它同样被改写。给这些被保留的工具补上
`properties` 以使所有无参数工具发出同一形状，已记入下方的不在范围内，
面向用户的文档也以同样方式限定这一承诺。

### 形状

采用 `{ "type": "object", "properties": {} }`，即 MiniMax 已为其自身端点注入的
空对象 schema（#11834）。开关修复与 MiniMax 的无条件注入现在共用同一形状，
因此开启该开关的路由无论由哪一个 provider 持有，行为都相同。
只校验字段是否存在的服务器可以接受这一形状；LM Studio 公布的校验器同样接受它：
其中 `function.parameters` 是可选的，一旦存在就需要 object 值的 `properties`，
而空的 record 即可满足（#11431）。本分支最初发出的裸 `{ "type": "object" }`
才是 #11410 报告的 HTTP 400。必须继续省略、因此从不开启该开关的，
是 #10080 当初所针对的那些基于 grammar 的 llama.cpp 路由；
这一形状实际被测到的范围见「限制与风险」。

### 不再使用独立 provider

本改动最初的形态是新增一个专用 provider，并在九项厂商判定条件之后加入对应分支，
其注释声称这些都是 hostname 检查。这是错的：该分支位于上面四项模型名判定条件之下，
因此由严格网关托管的 `deepseek`、`glm-`、`mimo-` 或 `mistral` 模型 id 会拿到
厂商 provider，开关从未被读取，服务器仍返回该开关本要防止的同一个
`Field required` —— 而且没有任何日志能把这个开关与未改变的线上形状联系起来。
把分支提前会剥夺这些路由其 provider 本要提供的内容分块处理，
而 `deepseek.ts` 与 `zai.ts` 明确记录了这一处理是为自托管的 sglang、vLLM
与 ollama 部署而有意保留的。因此修复与所选的 provider 组合生效，
不涉及任何 provider 类或选择分支。

`zai.ts` 会在非 Z.ai 域名上的 `glm-*` 模型未能展平 `reasoning_effort` 时告警一次。
这里的修复不需要这样的告警：它不以 hostname 为条件，
在用户开启的任意位置都会生效。

## 限制与风险

- provider 持有其构建时的 `ContentGeneratorConfig`，因此该开关在构建该路由的
  请求 provider 时读取。`modelProviders` 下的修改会被设置热重载消费：
  watcher 按最长前缀把该变更归类到 `modelProviders` 叶节点（它不要求重启），
  监听器随后重载模型注册表并刷新鉴权，从而重建 provider，
  因此该取值作用于下一个请求。`model.generationConfig` 下的修改没有这样的
  消费者：该块只在 CLI 于启动时通过 `resolveCliGenerationConfig` 构建
  generation config 时被读取一次，因此该取值在重启后生效。模型切换同样不会
  重新读取它 —— `syncAfterAuthRefresh` → `applyResolvedModelDefaults` 会用所选
  provider 条目的 generation config 覆盖每一个 `MODEL_GENERATION_CONFIG_FIELDS`
  条目 —— 这正是该开关在 provider 托管的路由上应当写在 `modelProviders`
  下的原因。两者都不作用于正在进行的请求，
  且在 bare 模式（不监听设置文件）下都不会热重载。`qwen-oauth`
  的热更新路径只复制固定的字段集合且不重建 provider，也不是该开关能服务的路由。
- 该开关按路由生效，不会被其它路由继承。子 agent、fork 或 `baseLlmClient` 目标
  这类侧模型，只要其 `baseUrl` 与父级不同就会失去父级的取值，共用同一 `baseUrl`
  时则保留。侧模型自身条目上的 `generationConfig.toolParametersMandatory`
  总是优先，包括显式 `false`。
- 只新增字段，从不删除。服务器会拒绝存在的 `parameters` 对象的路由不会开启该开关，
  因而不受影响：开关关闭时这份映射根本不会运行。但一条从未开启该开关的路由
  并非完全没有被这次改动触及 —— MiniMax 恰恰要求该字段存在，
  无论该开关取值都会调用共享映射。它的守卫会让一份畸形的 `extra_body` 列表
  被原样保留 —— 其中的空值成员、声称 `type: 'function'` 却不带 `function`
  对象的条目，以及 `function` 键存在但为 null 的条目 —— 不再像此前未加守卫的
  MiniMax 映射那样，以一个不指明工具名的 `TypeError` 中断请求构建。
  这些畸形条目，就是"开关关闭即一切未变"唯一不成立的地方。
- 注入的 `properties` 对象发生在转换之后，因此它不会被
  `relaxSchemaForFunctionCalling` 在转换中删除空 `properties` 的那一步影响。
  拒绝空 `properties` 对象的服务器不应开启该开关。
- 这一注入形状被测到的范围是有界的，而这个边界才是 `default: false` 之所以关键
  的真实理由。#10080 删除空对象形状，是因为早年的 llama.cpp 构建被报告拒绝它
  （llama.cpp#25923）；但它的验证者在自己能编译的任何 llama.cpp 构建上，都没有
  找到这一半放宽的真实复现：在 `llama-server` b10068（LM Studio 0.4.21 所用的
  那一代）、b10745 与 b10425 上，该形状都能编译 grammar 并返回 HTTP 200，
  其中在 b10068 上经过 60 个真实 chat template 也是零失败。#11956、#11431、
  #11410、#10080、#10065、#11834 上记录到的真实拒绝，只指向裸
  `{ "type": "object" }` 形状、`maxLength` 重复规则，或 MiniMax 要求该字段必须
  存在 —— 没有一条是服务器拒绝空 `properties` 对象，也没有任何一条提到 vLLM。
  所以省略作为默认值，理由是「跨版本未被测量」，而不是「已知会让 llama.cpp、
  LM Studio 或 vLLM 出问题」——后者是本改动此前在注释、设置说明与用户文档中
  发布的说法。
- 判断条件读取的是 `parameters === undefined` 这个值，而非键是否存在：
  converter 会带着 `undefined` 值发出该键，
  若只判断键是否存在，就会跳过每一个需要修复的工具。
- DashScope 不串联 `super.buildRequest`，因此它的两条返回路径经由自身的合并步骤
  到达这份修复。以同样方式组装请求的 provider 也必须调用它。

## 不在范围内

- 修改 converter 的默认省略行为，或 `relaxSchemaForFunctionCalling` 产生的形状。
- 对已经带有该字段的无参数工具补上 `properties`，使所有无参数工具发出同一形状。
- 通过 URL 探测 TabbyAPI 或任何其他自托管服务器。
- Responses 线（`openaiResponsesContentGenerator`），它同样省略该字段；
  该报告针对的是 Chat Completions。
- Anthropic 与 Gemini 生成器，它们没有等价约束。

## 验证

- 单元测试按路由固定线上形状。四条模型名路由 —— DeepSeek、Z.ai、MiMo 与
  Mistral 的模型 id 指向 `http://localhost:5000/v1` —— 断言厂商 provider 仍被选中
  且 schema 已存在。另有两条用例在真实的 Z.ai 与 DeepSeek 主机名上让修复
  穿过按主机名门控的 reasoning 重排。无厂商判定的普通路由断言默认省略、
  条目显式设为 `false` 时的省略、开启后发出的 schema，以及完全没有声明
  schema 的工具。DashScope 断言开启、显式 `false` 退出与默认省略三种状态；
  MiniMax 断言在开关缺省、开启、以及显式设为 `false` 三种取值下都会注入 ——
  最后这一例是唯一钉住"该注入在 MiniMax 路由上无法关闭"这一已发布承诺的用例。
  它还断言在开关关闭时，经由 `extra_body` 合入、声称 `type: 'function'`
  却不带 `function` 对象的条目会被原样保留 —— 在这条路由上撑起请求构建的是
  守卫而不是开关。共享 helper 也会被直接调用，输入中同时含有空值成员、
  值为 null 的 `function`、一个仍带有 `function` 对象的非 function 条目，
  以及一个 converter 形状的条目，因此每一道守卫都对应一个"仅移除该守卫即变红"
  的用例 —— 包括那会被其后空值判断掩盖的 `tool.type === 'function'`。
  已声明的 schema 原样透传，
  不含 tools 的请求仍然不带 tools。关闭修复时，每一个受开关门控的用例都会变红，
  而 MiniMax、省略与透传类用例仍为绿，因此测试套件区分的是开关，
  而不是 provider 类。
- settings schema 也会钉住自身的默认值：该开关缺省为 `false`，
  而没有任何 provider 测试会读取 schema，因此维持"默认省略"的这个取值
  在声明它的地方被断言。生成的 JSON Schema 由该条目重新生成，绝不手工修改。
- 既有 converter 测试仍然固定默认省略行为，包括
  `expect(JSON.stringify(result.slice(0, 5))).not.toContain('parameters')`。
- 本豁免所推理的三种形状无需实时服务器即可在 converter 处确定：
  `{ "type": "object", "properties": {} }` 先被归约、随后被修复为空对象 schema；
  `{ "type": "object" }` 原样上线；
  `{ "type": "object", "properties": {}, "required": [] }` 上线为
  `{ "type": "object", "required": [] }`。`converter.test.ts` 中的 `constrained`
  用例已经固定了带 `minProperties` 的 schema 的白名单条件，
  因此只有"严格端点是否接受每一种形状"需要下面的实时运行。
- #11956 已确认的抓包正是一条模型名路由 —— 经网关的 `deepseek-v4.1-flash`，
  `400 litellm.BadRequestError: ... tools[5].function: missing field parameters` ——
  正是过去被遮蔽的那一支。回环 baseUrl 上使用 `deepseek` 模型 id 的单元测试用例
  已将其固定；针对该网关的线上重跑仍待完成。
- 2026-09-19 在同一条真实 TabbyAPI 路由（`http://localhost:5000/v1`）上重跑，
  三个请求体只在该字段上不同：省略 → HTTP 422，错误为
  `{"type":"missing","loc":["body","tools",0,"function","parameters"],"msg":"Field required"}`；
  `{ "type": "object" }` → HTTP 200；线上采用的
  `{ "type": "object", "properties": {} }` → HTTP 200。就那次运行而言，CLI 在该
  路由上默认失败为 `422 status code (no body)`，在对应的 `modelProviders` 条目上
  设置该键后可正常完成。这条复现路径此后已经失效：tabbyAPI `fb80a9372859`
  （2026-09-26，晚于此处记录的两次运行）为 `parameters` 提供了默认值，因此当前的
  TabbyAPI 会接受省略，而本设置当前有效的抓包是上方 #11956 的 serde/litellm 那一条。
  2026-09-17 在同一路由上的较早运行记录了省略该字段时的 HTTP 422 与裸形状的
  HTTP 200，并额外记录：在存在匹配 provider 条目的路由上，写在
  `model.generationConfig` 下的键会被报告为忽略，请求仍为 422 ——
  与本文在"限制与风险"下记录的同一分支。
- 属于他人报告、并非本机实测：另有两个严格 Rust/serde 网关
  （`api-inference.modelscope.cn`、`apihub.agnes-ai.com`）的评论称带 `properties`
  的形状作为本地补丁被接受。这些报告都早于本次形状改动，
  因此只能佐证该选择，不能替代验证。
