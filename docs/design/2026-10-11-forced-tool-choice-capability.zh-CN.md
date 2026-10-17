# OpenAI 兼容端点的强制 tool_choice 能力开关

[English](2026-10-11-forced-tool-choice-capability.md) | [简体中文](2026-10-11-forced-tool-choice-capability.zh-CN.md)

## 1. 状态

已实现并验证，2026-10-11，分支 `fix/tool-choice-optout-13807`，基线
`263d47e29d`。实现随同一变更交付；第 9 节记录了已执行的验证结果。
唯一遗留缺口是 `fm serve` 实机验证（仅 macOS，见第 9 节）。

## 2. 问题

macOS Foundation Models 服务器（`fm serve`）会以 HTTP 500
`An unsupported generation guide was used.` 拒绝 `tool_choice: "required"`
和具名 tool choice（[#13807](https://github.com/QwenLM/qwen-code/issues/13807)）。

所有内部结构化输出查询都经过 `generateJson`
（`packages/core/src/core/baseLlmClient.ts:500`），它无条件强制一次 tool
call：始终发送 `toolConfig.functionCallingConfig.mode = ANY`
（`baseLlmClient.ts:563-571`），而 Chat Completions 管线会把该 mode 翻译为
wire 上的 `tool_choice: 'required'`
（`packages/core/src/core/openaiContentGenerator/pipeline.ts:1336-1343`）。

后果：在任何拒绝强制 tool choice 的 OpenAI 兼容端点上，每一次结构化旁路查询
（会话标题、摘要、记忆选择、权限分类器、压缩辅助、fork-tool 子查询）都以 500
失败——在其他地方都正常的 wire 形态，在这类端点上却是致命的。

`response_format` 这条退路也不可用：`buildResponseFormat` 只对官方 OpenAI
端点开放（`pipeline.ts:1631`，
`packages/core/src/core/openaiContentGenerator/prefix-caching.ts:34-47`），
因此 `fm serve` 永远不会收到它（另见第 5 节非目标）。

端点需要一种方式来声明拒绝强制 tool choice，从而由 `generateJson` 现有的
散文回退接管（`baseLlmClient.ts:615-620`）。

## 3. 当前状态（基于 `263d47e29d` 验证）

### 3.1 写入 `tool_choice` 的位置

- Chat Completions：`pipeline.ts:1337-1339` 在 `fcMode === 'ANY'` 时写入
  `'required'`；`pipeline.ts:1340-1342` 在 `fcMode === 'NONE'` 时写入
  `'none'`；`fcMode` 于 `pipeline.ts:1336` 读取。这是该 wire 上仅有的
  `tool_choice` 写入点。
- DashScope 抑制已经存在：在 thinking 激活时，它会在
  `provider.buildRequest` 之后删除 `'required'`（`pipeline.ts:1591-1616`）；
  `isDashScope` 按请求计算（`pipeline.ts:1379-1381`）。
- 兄弟 wire 同样强制：Responses 把 `ANY` 翻译为 `'required'`
  （`packages/core/src/core/openaiResponsesContentGenerator/responses-pipeline.ts:453-458`，
  写入在 `:455`），Anthropic 把 `ANY` 映射为 `{ type: 'any' }`
  （`packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts:1244-1254`，
  在 `:859`、`:886` 附加）。

### 3.2 `generateJson` 与回退

- `generateJson`（`baseLlmClient.ts:500-645`）注册 `respond_in_schema` 工具
  （`:518-530`），并始终强制 ANY（`:563-571`）。
- 响应处理：`respond_in_schema` function call 优先（`:604-613`）；否则响应
  文本经过 `parseLooseJsonObject`（`:615-620`，实现 `:410-437`）：剥离
  ```json 围栏，取第一个 `{`到最后一个`}`之间的子串，只接受 JSON 对象
（绝不接受数组），任何失败返回`null`。返回 `null` 时，`generateJson`返回`{}`（`:620`）。
- `forkedAgent` 在不保留 tools 时会以同样强制的配置到达同一管线
  （`packages/core/src/agents/forkedAgent.ts:566-591`），因此翻译点上的
  一个 guard 即可覆盖两个调用方。

### 3.3 provider 与配置管线

- 诸如 `http://localhost:1976/v1` 的自定义端点不匹配任何内置探测，落入
  `DefaultOpenAICompatibleProvider`
  （`packages/core/src/core/openaiContentGenerator/index.ts:62-133`）。
- `ModelGenerationConfig` 是 `ContentGeneratorConfig` 的直接
  `Pick<...>`（`packages/core/src/models/types.ts:47-70`），因此 provider
  条目无需形状转换即可喂给 content generator 解析。运行时字段列表是
  `MODEL_GENERATION_CONFIG_FIELDS`（`packages/core/src/models/constants.ts:21-43`）；
  `PROVIDER_SOURCED_FIELDS`（`:60-63`）展开该列表以支持来源追踪
  （`packages/core/src/core/contentGenerator.ts:285`）。
- 解析路径：`models/modelRegistry.ts:445-471` 展开条目自身的
  `generationConfig`（`:451`）；`models/modelsConfig.ts:356-362` 返回解析后的
  模型；`BaseLlmClient.resolveForModel`（`baseLlmClient.ts:844-913`）构建
  按模型划分的 generator（`:874-880`），并以该配置到达管线
  （`openaiContentGenerator/types.ts:146-151`、`pipeline.ts:518-536`）。
- 设置向导通过 `packages/core/src/providers/types.ts:162-170`
  （`advancedConfig`）与 `packages/core/src/providers/provider-config.ts:106-139`
  （`buildAdvancedGenerationConfig`）产出 `generationConfig`。

## 4. 目标

1. 让 provider/model 条目声明其端点不支持强制 tool choice，使 `generateJson`
   的旁路查询不再以 500 失败。
2. 保持默认 wire 行为逐字节不变：支持强制 tool choice 的端点不受影响。
3. 复用现有散文回退及其测试作为安全网；不新增解析层，不修改
   `generateJson`。
4. 让声明沿现有模型配置路径流动（`modelProviders[].generationConfig` →
   解析后的模型 → 按模型划分的 generator → 管线），不新增 provider 类，
   不做主机名启发式。

## 5. 非目标

- **不做主机名自动探测。** 不添加 `isFoundationModelsProvider` 式检查，
  也不特判 `localhost:1976`。端口与主机可变，其他自定义端点有同样限制；
  用户声明的能力可泛化，而启发式只对单一场景过拟合。
- **不修改 `isOfficialOpenAIEndpoint` / `buildResponseFormat`**
  （`pipeline.ts:1621-1648`）。放开 `response_format` 是另一片回归面：
  第三方端点会拒绝该字段（`pipeline.ts:1624-1630`）。
- **不做 500 重试。** 匹配第三方错误字符串后再不带 `tool_choice` 重试既脆弱，
  也已在 triage 中被否决。
- **本次变更不涉及 Responses wire 与 Anthropic**
  （`responses-pipeline.ts:453-458`、
  `anthropicContentGenerator.ts:1244-1254`）。它们继续强制；是否扩展是后续
  决策（第 8 节、第 11 节）。
- **不修改 `'NONE'` 分支。** `tool_choice: 'none'` 保持原样；#13807 只记录
  了对 `required` 与具名 choice 的拒绝。

## 6. 设计

### 6.1 字段与默认值

`ContentGeneratorConfig` 上的新可选字段：

```ts
// When false, the endpoint rejects forced tool selection (`tool_choice:
// "required"`), so the pipeline must not force a tool call for structured
// side queries. Default: true (force, current behavior).
supportsForcedToolChoice?: boolean;
```

- 默认 `true`：缺省/`undefined` 表示当前行为；只有显式 `false` 才退出强制。
- 正向极性（`supports...`）与 `thinkingMandatory`（`contentGenerator.ts:186-188`）
  一致，比否定式 flag 更易读。
- 该字段声明在模型条目上、紧邻其所属端点，位于
  `modelProviders[].generationConfig`：

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "system",
        "baseUrl": "http://localhost:1976/v1",
        "generationConfig": { "supportsForcedToolChoice": false }
      }
    ]
  }
}
```

### 6.2 写入点的 guard

在 `pipeline.ts` 中扩展 `:1337` 的条件：

```ts
if (
  fcMode === 'ANY' &&
  this.contentGeneratorConfig.supportsForcedToolChoice !== false
) {
  (baseRequest as unknown as Record<string, unknown>)['tool_choice'] =
    'required';
} else if (fcMode === 'NONE') {
  (baseRequest as unknown as Record<string, unknown>)['tool_choice'] = 'none';
}
```

- 被抑制时完全省略该字段；管线不会以 `'auto'` 作为替代。省略是兼容性最广的
  形态（对校验型网关不产生未知字段），且语义上本就是 OpenAI 的默认值。
- 在写入点加 guard 可避免在 `:1337` 写入、再到 `:1615` 删除。DashScope 抑制
  （`:1591-1616`）保持不动：若两者同时生效，后续删除是无害的 no-op。
- 这一个位置即可覆盖 `generateJson` 与 `forkedAgent` 路径（第 3.2 节），
  因为两者到达同一管线。

### 6.3 管线路径（settings → guard）

1. **类型。** 在 `ContentGeneratorConfig`（`contentGenerator.ts:82-208`，
   靠近 `:186-188` 的 `thinkingMandatory`）中添加
   `supportsForcedToolChoice?: boolean`。
2. **模型作用域。** 把该键加入 `ModelGenerationConfig`
   （`models/types.ts:47-70`）与 `MODEL_GENERATION_CONFIG_FIELDS`
   （`models/constants.ts:21-43`）。`PROVIDER_SOURCED_FIELDS`
   （`models/constants.ts:60-63`）展开该列表，因此来源追踪
   （`contentGenerator.ts:285`）会自动纳入该字段；应用测试断言解析后的配置
   仍保留它。
3. **解析。** 值经由 `modelRegistry.ts:451`（`resolveModelConfig` 展开）、
   `modelsConfig.ts:356-362`（`getResolvedModel`）以及
   `BaseLlmClient.resolveForModel` 的按模型 generator
   （`baseLlmClient.ts:874-880`）流动，后者构建管线配置
   （`openaiContentGenerator/types.ts:146-151`、`pipeline.ts:520`、`:528`）。
4. **settings schema 与文档。** 在 settings schema 的 generation-config
   区域添加属性元数据（`packages/cli/src/config/settingsSchema.ts:1972-2140`），
   并在 `docs/users/configuration/model-providers.md`（`generationConfig`
   示例位于 282-420）与 `docs/users/configuration/settings.md`
   （`model.generationConfig` 表位于 197）中记录。注意 `modelProviders`
   条目校验较宽松（`settingsSchema.ts:393-403`），该属性仅在
   `model.generationConfig` 节点上受 schema 校验；`modelProviders[]`
   条目面仅在文档中记录，不参与 schema 校验。
5. **向导（待决问题）。** 在自定义 provider 设置流程中暴露开关
   （`providers/types.ts:162-170`、
   `providers/provider-config.ts:106-139`）是可选项，暂缓；最小面是
   settings + 文档。

### 6.4 回退语义

guard 抑制 `tool_choice` 后，请求仍携带 `respond_in_schema` 工具。在
`fm serve` 上，工具 `parameters` schema 会作为生成指南被应用，对象以散文
内容到达，`tool_calls: null`（依据报告者引用的指南）。此时 `generateJson`：

1. 找不到 function call（`baseLlmClient.ts:604-613`）；
2. 读取文本（`:615`）并运行 `parseLooseJsonObject`（`:617`、`:410-437`）；
3. 返回解析出的对象；文本不是可用 JSON 对象时返回 `{}`（`:620`）。

`{}` 是静默降级（标题/建议为空，分类器退化为 `failUnavailable`），不是错误。
它被接受为严格优于当前的 500（第 8 节）。

## 7. 约束

- **默认行为保持不变。** 字段缺省 ⇒ 请求体完全一致，现有测试不变；
  既有 `tool_choice` 契约（`pipeline.test.ts:758`、`:837`、`:868`、`:1203`）
  必须原样通过。
- **类型与运行时列表同步变更。** `ModelGenerationConfig`
  （`models/types.ts:47-70`）与 `MODEL_GENERATION_CONFIG_FIELDS`
  （`models/constants.ts:21-43`）必须在同一变更中更新，否则该字段会在来源
  追踪（`contentGenerator.ts:285`）中被丢弃。
- **声明按模型作用域。** 受支持的配置面是按模型的 provider 条目
  （`modelProviders[].generationConfig`），与其他面向 provider 模型的
  请求塑形字段的声明方式一致（`docs/users/configuration/settings.md:197`）。
- **不修改 `isOfficialOpenAIEndpoint` 与 `buildResponseFormat`**
  （`prefix-caching.ts:34-47`、`pipeline.ts:1621-1648`）。
- **不新增 provider 类，不做主机名检查，不加重试逻辑。**

## 8. 风险与已接受的债务

1. **在有能力支持的端点上置为 `false`。** 若用户在支持强制 tool choice 的
   端点上关闭它，thinking 重的模型可能跳过 tool call，`generateJson` 静默
   返回 `{}`（`baseLlmClient.ts:563-568` 记录了强制存在的原因）。缓解：
   默认 `true`、仅显式退出、文档说明、测试钉住两个分支。这是 #13807 的
   已接受债务：静默 `{}` 降级优于每次旁路查询都 500。
2. **回退只接受对象。** `parseLooseJsonObject` 拒绝数组与畸形 JSON
   （`baseLlmClient.ts:422-436`），因此即使模型输出了内容，`{}` 仍可能出现。
   由 `baseLlmClient.test.ts:293-320` 钉住。
3. **`fm serve` 的散文行为未实机验证。** “schema 作为指南 → 可解析散文”
   来自报告者引用的指南；CI 中没有 macOS 环境。报告者已提议复验。
4. **兄弟 wire 仍在强制。** 对这类端点使用 `wireApi: 'responses'` 的用户
   仍会遇到 500（`responses-pipeline.ts:453-458`）。已记录；是否覆盖可作为
   后续工作（第 11 节）。
5. **`tool_choice: 'none'` 仍会上线。** #13807 只记录了对
   `required`/具名 choice 的拒绝；若未来端点拒绝任何 `tool_choice`，
   需要放宽 gate（第 11 节）。
6. **DashScope 冗余。** 在 DashScope 上置为 `false` 时，
   `pipeline.ts:1615` 的抑制变得冗余，但仍无害。

## 9. 验证结果

于 2026-10-11 在分支 `fix/tool-choice-optout-13807` 上执行；按仓库约定，
包测试均在包目录内运行。TDD 红灯基线（实现前）：下列四个 core 测试文件为
6 failed / 481 passed，钉住了缺失的能力。

| 命令                                                                                                                                                                                                    | 钉住的内容                                                                                                                               | 结果                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd packages/core && npx vitest run src/core/openaiContentGenerator/pipeline.test.ts src/core/baseLlmClient.test.ts src/models/content-generator-config.test.ts src/models/modelConfigResolver.test.ts` | `false` 抑制 `'required'`；`undefined` 保留；DashScope 与 GLM 契约不变；散文回退与按模型解析不变；字段在解析与来源追踪后仍保留           | 487/487 通过 ✅（pipeline 290、baseLlmClient 94、content-generator-config 41、modelConfigResolver 62）                                                                             |
| `cd packages/cli && npx vitest run src/config/settingsUtils.test.ts`                                                                                                                                    | `model.generationConfig` schema 节点接受布尔值 `supportsForcedToolChoice`（`modelProviders[]` 条目面仅在文档中记录，不参与 schema 校验） | 67/67 通过 ✅                                                                                                                                                                      |
| `npm run build --workspace=@qwen-code/qwen-code-core`                                                                                                                                                   | 新字段与 guard 可编译                                                                                                                    | ✅                                                                                                                                                                                 |
| `npm run typecheck`（仓库根目录）                                                                                                                                                                       | 全仓库类型检查                                                                                                                           | ✅                                                                                                                                                                                 |
| 变异检查：移除 guard 中的 `supportsForcedToolChoice !== false` 条件后重建 core 并运行 `pipeline.test.ts`                                                                                                | 测试确实钉住 guard                                                                                                                       | 变异：1 failed / 289 passed——`pipeline.test.ts:886` 处 `AssertionError: expected 'required' to be undefined`；恢复：290/290 通过 ✅；变异前后 `git diff` sha256 一致（`dcf0bce…`） |
| 手动：macOS、`fm serve`、fast model `openai:system\0http://localhost:1976/v1`、字段 `false`                                                                                                             | 旁路查询不再 500；散文解析产出对象；默认配置在支持处不变                                                                                 | 待办——未运行（仅 macOS）；应由报告者复验                                                                                                                                           |

手动检查受环境限制（仅 macOS），无法在当前 Linux 工作区运行。

## 10. 验收标准

- [x] 带有 `generationConfig.supportsForcedToolChoice: false` 的条目在
      Chat Completions 上对 `fcMode: 'ANY'` 查询不再发送 `tool_choice` 字段。
- [x] 字段缺省或为 `true` 时请求体不变；现有管线测试无需修改即可通过。
- [x] 值沿 settings → 解析后的模型 → 按模型 generator → 管线中的
      `contentGeneratorConfig` 流动，且 provider 解析后来源追踪仍保留它。
- [ ] `generateJson` 可通过 `parseLooseJsonObject` 从散文恢复 JSON 对象，
      解析失败时返回 `{}`。单元测试已全绿；实机 `fm serve` 的散文恢复
      尚未观测，报告者应复验。
- [x] 目标单测、`npm run build`、`npm run typecheck` 与 `npm run lint` 全绿。
- [x] `docs/users/configuration/model-providers.md` 记录了该字段并包含
      `fm serve` 示例；`docs/users/configuration/settings.md` 也在设置表中
      记录了该字段，因为 Runtime Model 也可在 `model.generationConfig` 下
      设置它。
- [x] 未改动 `isOfficialOpenAIEndpoint`、`buildResponseFormat`、Responses
      wire 或 Anthropic。

## 11. 待决问题

1. **向导与 schema 暴露。** 自定义 provider 设置流程
   （`providers/types.ts:162-170`）是否应增加开关，还是暂以 settings + 文档
   为预期面？
2. **wire 覆盖。** 本次变更是否扩展到 Responses wire 与 Anthropic 的抑制，
   还是作为后续工作跟踪？
3. **可观测性。** 抑制时是否应输出类似 DashScope 删除的 `debugLogger` 行
   （`pipeline.ts:1611-1614`）？
4. **`'none'` 分支。** 若端点拒绝任何 `tool_choice` 值，之后是否以同样方式
   对 `'none'` 加 gate？
