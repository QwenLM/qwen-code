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
`openaiContentGenerator/provider/` 中现有的每一项 hostname 匹配都指向公开厂商域名，
没有一项匹配回环地址。

该字段声明在 `ContentGeneratorConfig` 上，并加入 `ModelGenerationConfig` 与
`MODEL_GENERATION_CONFIG_FIELDS`，因此 `modelProviders` 条目可按模型设置它；
文档见 `docs/users/configuration/settings.md`。

### 在下一层修复，而不是在 converter 中

`ToolParametersMandatoryOpenAICompatibleProvider` 覆写 `buildRequest`，为转换后
`parameters` 为 `undefined` 的任意工具补上
`{ "type": "object", "properties": {} }`，位置与 MiniMax 执行等价修复的位置相同。
若在 converter 中处理，就意味着为所有 OpenAI 兼容路由选定同一种形状，
而 `provider/minimax.ts` 明确记录了这一约束。

在请求层而非工具列表层处理，也同时覆盖了工具缺失该字段的两种成因：
声明了空参数列表的工具（被 converter 归约为 `undefined`），
以及完全没有声明 schema 的工具（从未获得 schema）。
在 converter 侧的修复只能覆盖前者。

### 形状

采用 `{ "type": "object", "properties": {} }`，即 MiniMax 已为其自身端点注入的
空对象 schema（#11834）。两个 provider 现在发出同一形状，因此开启该开关的路由
无论由哪一个持有，行为都相同。只校验字段是否存在的服务器可以接受这一形状。
本 provider 最初发出的裸 `{ "type": "object" }` 正是 #11410 在 llama.cpp、
LM Studio 与 vLLM 上报告的 HTTP 400 —— 那些必须继续省略的路由，
因此从不开启该开关。

### 选择顺序

该开关在每一项厂商 hostname 检查之后才判断，因此匹配到厂商域名的路由仍保留该厂商的
provider —— MiniMax 会自行注入同一形状，不能被通用 provider 取代。

## 限制与风险

- 该开关在路由的 provider 构建时读取，因此在下一次模型切换或重启后生效，
  而不是作用于正在进行的请求。`qwen-oauth`
  的热更新路径只复制固定的字段集合且不重建 provider，也不是该开关能服务的路由。
- 该开关按模型路由生效。把多条路由指向要求相反的服务器时，
  只在需要它的那条路由上设置该键。
- 只新增字段，从不删除。服务器会拒绝存在的 `parameters` 对象的路由仍使用默认
  provider，不受影响。
- 注入的 `properties` 对象发生在转换之后，因此它不会被
  `relaxSchemaForFunctionCalling` 在转换中删除空 `properties` 的那一步影响。
  拒绝空 `properties` 对象的服务器不应开启该开关。
- 判断条件读取的是 `parameters === undefined` 这个值，而非键是否存在：
  converter 会带着 `undefined` 值发出该键，
  若只判断键是否存在，就会跳过每一个需要修复的工具。

## 不在范围内

- 修改 converter 的默认省略行为，或 `relaxSchemaForFunctionCalling` 产生的形状。
- 通过 URL 探测 TabbyAPI 或任何其他自托管服务器。
- Responses 线（`openaiResponsesContentGenerator`），它同样省略该字段；
  该报告针对的是 Chat Completions。
- Anthropic 与 Gemini 生成器，它们没有等价约束。

## 验证

- 单元测试覆盖开关判断（设为 true、未设置、显式 false）、provider 选择
  （被选中、未被选中、开启时 MiniMax 仍然胜出），以及 `buildRequest`
  （没有 `parameters` 键、`parameters: undefined`、已声明 schema 原样透传、
  不含 tools 的请求）。
- 既有 converter 测试仍然固定默认省略行为，包括
  `expect(JSON.stringify(result.slice(0, 5))).not.toContain('parameters')`。
- 已在真实 TabbyAPI 路由（`http://localhost:5000/v1`）上验证：请求体 A/B 显示，
  省略该字段时返回 HTTP 422，错误为
  `{"type":"missing","loc":["body","tools",0,"function","parameters"],"msg":"Field required"}`；
  带 `"parameters": { "type": "object" }` 时返回 HTTP 200。CLI 在该路由上默认失败为
  `422 status code (no body)`，在对应的 `modelProviders` 条目上设置该键后可正常完成。
  该次运行早于上面的形状对齐：HTTP 200 记录的是裸 `{ "type": "object" }`，
  空对象形状尚未在该端点上重新验证。
  运行记录：`.qwen/e2e-tests/2026-09-17-tool-parameters-mandatory-results.md`。
