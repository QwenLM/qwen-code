# 无参数工具的 `parameters` 字段开关

[English](./2026-09-17-parameterless-tool-parameters.md)

状态：已实现。

## 问题

不接受任何参数的 function tool 在请求中不会携带 `parameters` 对象。
严格 OpenAI 兼容服务器如果把 `tools[].function.parameters` 声明为 Pydantic
必填字段，就会因此拒绝整个请求 —— 在 TabbyAPI 上报错为
`tools[].function.parameters` 的 `Field required`。请求在模型看到任何工具之前就失败了，
所以一个工具调用都无法发出。

## 为什么今天会省略该字段

省略是有意为之，并非疏漏。提交 `03005a2bbf`
（`fix(core): omit parameterless OpenAI tool schemas`，#11431）在 #10080 的
语法放宽之上加入了这一行为，其提交信息中的脉络为 #10520 → #11410 → #11431：

- `relaxSchemaForFunctionCalling` 会删除空的 `properties` 对象，因此零参数 schema
  到达线上时是裸的 `{ "type": "object" }`。
- 这个裸形状正是 #11410 报告的 HTTP 400，出现在 llama.cpp、LM Studio 与 vLLM 上 ——
  即 #10080 当初所针对的那些端点。
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

在请求层而非工具列表层处理，也同时覆盖了工具缺失该字段的两种成因：
声明了空参数列表的工具（被 converter 归约为 `undefined`），
以及完全没有声明 schema 的工具（从未获得 schema）。
在 converter 侧的修复只能覆盖前者。

### 形状

采用 `{ "type": "object", "properties": {} }`，即 MiniMax 已为其自身端点注入的
空对象 schema（#11834）。开关修复与 MiniMax 的无条件注入现在共用同一形状，
因此开启该开关的路由无论由哪一个 provider 持有，行为都相同。
只校验字段是否存在的服务器可以接受这一形状。
本分支最初发出的裸 `{ "type": "object" }` 正是 #11410 在 llama.cpp、
LM Studio 与 vLLM 上报告的 HTTP 400 —— 那些必须继续省略的路由，
因此从不开启该开关。

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

- provider 持有其构建时的 `ContentGeneratorConfig`，因此该开关在下一次模型切换
  或重启后生效，而不是作用于正在进行的请求。`qwen-oauth`
  的热更新路径只复制固定的字段集合且不重建 provider，也不是该开关能服务的路由。
- 该开关按路由生效，不会被其它路由继承。子 agent、fork 或 `baseLlmClient` 目标
  这类侧模型，只要其 `baseUrl` 与父级不同就会失去父级的取值，共用同一 `baseUrl`
  时则保留。侧模型自身条目上的 `generationConfig.toolParametersMandatory`
  总是优先，包括显式 `false`。
- 只新增字段，从不删除。服务器会拒绝存在的 `parameters` 对象的路由不会开启该开关，
  因而不受影响。
- 注入的 `properties` 对象发生在转换之后，因此它不会被
  `relaxSchemaForFunctionCalling` 在转换中删除空 `properties` 的那一步影响。
  拒绝空 `properties` 对象的服务器不应开启该开关。
- 判断条件读取的是 `parameters === undefined` 这个值，而非键是否存在：
  converter 会带着 `undefined` 值发出该键，
  若只判断键是否存在，就会跳过每一个需要修复的工具。
- DashScope 不串联 `super.buildRequest`，因此它的两条返回路径经由自身的合并步骤
  到达这份修复。以同样方式组装请求的 provider 也必须调用它。

## 不在范围内

- 修改 converter 的默认省略行为，或 `relaxSchemaForFunctionCalling` 产生的形状。
- 通过 URL 探测 TabbyAPI 或任何其他自托管服务器。
- Responses 线（`openaiResponsesContentGenerator`），它同样省略该字段；
  该报告针对的是 Chat Completions。
- Anthropic 与 Gemini 生成器，它们没有等价约束。

## 验证

- 单元测试按路由固定线上形状。四条模型名路由 —— DeepSeek、Z.ai、MiMo 与
  Mistral 的模型 id 指向 `http://localhost:5000/v1` —— 断言厂商 provider 仍被选中
  且 schema 已存在。无厂商判定的普通路由断言默认省略、开启后发出 schema，
  以及完全没有声明 schema 的工具。DashScope 与 MiniMax 两种状态都断言。
  已声明的 schema 原样透传，不含 tools 的请求仍然不带 tools。
  关闭修复时，七个依赖开关的用例会变红，而 MiniMax 与省略类用例仍为绿，
  因此测试套件区分的是开关，而不是 provider 类。
- 既有 converter 测试仍然固定默认省略行为，包括
  `expect(JSON.stringify(result.slice(0, 5))).not.toContain('parameters')`。
- #11956 已确认的抓包正是一条模型名路由 —— 经网关的 `deepseek-v4.1-flash`，
  `400 litellm.BadRequestError: ... tools[5].function: missing field parameters` ——
  正是过去被遮蔽的那一支。回环 baseUrl 上使用 `deepseek` 模型 id 的单元测试用例
  已将其固定；针对该网关的线上重跑仍待完成。
- 2026-09-19 在同一条真实 TabbyAPI 路由（`http://localhost:5000/v1`）上重跑，
  三个请求体只在该字段上不同：省略 → HTTP 422，错误为
  `{"type":"missing","loc":["body","tools",0,"function","parameters"],"msg":"Field required"}`；
  `{ "type": "object" }` → HTTP 200；线上采用的
  `{ "type": "object", "properties": {} }` → HTTP 200。CLI 在该路由上默认失败为
  `422 status code (no body)`，在对应的 `modelProviders` 条目上设置该键后可正常完成。
  运行记录：`.qwen/e2e-tests/2026-09-19-tool-parameters-shape-ab.md`。
  2026-09-17 在同一路由上的较早运行以裸形状记录到 HTTP 200，见
  `.qwen/e2e-tests/2026-09-17-tool-parameters-mandatory-results.md`。
- 属于他人报告、并非本机实测：另有两个严格 Rust/serde 网关
  （`api-inference.modelscope.cn`、`apihub.agnes-ai.com`）的评论称带 `properties`
  的形状作为本地补丁被接受。这些报告都早于本次形状改动，
  因此只能佐证该选择，不能替代验证。
