# OpenTelemetry 上下文使用量属性

[English](otel-context-usage-attribute.md) | [简体中文](otel-context-usage-attribute.zh-CN.md)

## 状态与范围

本设计为每个面向用户的
`qwen-code.llm_request` span 增加一个私有 OpenTelemetry 属性：

```text
qwen-code.context.usage
```

该属性值是紧凑的、带版本的 JSON 字符串。它报告模型上下文窗口、`/context`
使用的输入分项估算、当前的压缩预留，以及自动压缩前剩余的输入容量。

本变更不增加指标、日志事件、会话属性或标准的 `gen_ai.*` 字段。
`gen_ai.usage.input_tokens` 仍然是 provider 报告的权威输入 token 总数。
由于在 `gen-ai-arms-field-alignment.md` 中锁定版本的 GenAI 语义约定基线没有
用于表示 Qwen Code 上下文分类明细的标准属性，本设计扩展 Qwen Code 的私有命名空间。

## 属性契约

OpenTelemetry 属性不能包含任意对象，因此该值是通过 `JSON.stringify` 生成的
JSON 字符串。下面展示一个格式化后的最终值示例；实际发出的值不包含无意义的空白：

```json
{
  "version": 1,
  "window_size_tokens": 200000,
  "breakdown": {
    "system_prompt_tokens": 12000,
    "builtin_tools_tokens": 8000,
    "mcp_tools_tokens": 3000,
    "memory_files_tokens": 2000,
    "skills_tokens": 1500,
    "messages_tokens": 83000
  },
  "compaction_reserve_tokens": 33000,
  "available_before_compaction_tokens": 57500,
  "estimated": true
}
```

对应的 span 还包含：

```text
gen_ai.usage.input_tokens = 109500
```

JSON 有意不重复该总数。需要计算使用率的消费者读取标准标量，并且只从
`qwen-code.context.usage` 解析额外的上下文元数据。

### Schema 版本 1

```ts
interface ContextUsageV1 {
  version: 1;
  window_size_tokens: number;
  breakdown: {
    system_prompt_tokens: number;
    builtin_tools_tokens: number;
    mcp_tools_tokens: number;
    memory_files_tokens: number;
    skills_tokens: number;
    messages_tokens: number;
  };
  compaction_reserve_tokens: number;
  available_before_compaction_tokens?: number;
  estimated: true;
}
```

所有 token 值都必须是有限的非负数。分类估算值是整数。压缩预留由
`computeThresholds` 返回的自动阈值推导；通常是整数，但自定义百分比产生小数阈值时也可能是小数。

`estimated` 适用于分类归因。窗口大小和压缩预留来自生效的运行时配置。
如果存在 `available_before_compaction_tokens`，它基于 provider 报告的标准输入
token 数，而不是分类估算器。

`available_before_compaction_tokens` 特意没有命名为 `free_space_tokens`。
它与 `/context` 当前的 `freeSpace` 计算具有相同的操作含义：

```text
max(
  0,
  window_size_tokens
    - compaction_reserve_tokens
    - gen_ai.usage.input_tokens
)
```

因此，它表示自动压缩前剩余的输入容量，而不是模型上下文窗口边界前的原始剩余容量。

`compaction_reserve_tokens` 是自动压缩阈值到窗口边界之间的距离：

```text
window_size_tokens - computeThresholds(window_size_tokens, configured_pct).auto
```

它同时包含摘要输出预留，以及按比例的自动压缩阈值引入的额外余量。它不是固定摘要输出预算的别名。

Warn、auto、hard 和 effective-window 阈值不会作为单独的 JSON key 序列化。
自动阈值可以由窗口和预留推导，其他阈值不属于请求的 payload。

## 分类归因

快照由 `LoggingContentGenerator` 收到的逻辑请求同步构建。这是所有支持的 provider
共享的、provider 无关的最后一种请求形态，其中已经包含本次尝试生效的 Qwen Code
系统指令、消息和工具声明。provider 适配器在调用 SDK 前仍可能对请求进行规范化，因此
这里的分项描述的是 Qwen Code 的逻辑上下文，而不是 provider 的线缆序列化形式或计费 tokenizer。

如果直接调用方或自定义调用方提供了尚未解析的 `CallableTool`，Qwen Code 会省略本次尝试的完整私有属性。
解析 callable 会给同步快照路径增加异步的 provider 适配器工作，而将其当作空声明会静默地错误归类其 token 成本。
正常的 Qwen Code 请求构造会提供已经物化的函数声明，不受此限制影响。

| JSON 字段              | 来源与归因规则                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window_size_tokens`   | 被包装 generator 所拥有的 `ContentGeneratorConfig`，如果没有则回退到 `DEFAULT_TOKEN_LIMIT`。这样可以避免错误地为 fallback 或 side model 使用主模型的窗口。                                                                                                                                                                                                           |
| `system_prompt_tokens` | 生效的请求系统指令，不包括已识别的 memory 片段。基础 prompt、追加 prompt、git 状态以及任何未分类的系统文本都保留在这里。                                                                                                                                                                                                                                             |
| `builtin_tools_tokens` | 逻辑请求中的工具声明，不包括 MCP 声明和 Skill 工具声明。尚未 reveal 的延迟工具不在请求中，因此不会出现在这里。                                                                                                                                                                                                                                                       |
| `mcp_tools_tokens`     | 逻辑请求中与 registry 条目匹配且实例为 `DiscoveredMCPTool` 的声明。不序列化 server 名或工具名。                                                                                                                                                                                                                                                                      |
| `memory_files_tokens`  | 生效系统指令中的 memory policy：当 `Config.getUserMemory()` 与 `Config.getAutoMemoryPrompt()` 的每个精确 trim 后片段存在时计入；另外，仅当 `Config.getAutoMemoryContext()` 精确匹配最终 user `Content` 的最终 text part 时计入。匹配到的 catalog part 只从消息估算中移除；其他 user part 和更早出现的相同 user 文本仍保留在 `messages_tokens` 中。不暴露路径或内容。 |
| `skills_tokens`        | Skill 工具声明，加上与 Skill 工具插入请求历史时保留的不可变、面向 LLM 的输出精确匹配的已加载 `SKILL.md` 内容。                                                                                                                                                                                                                                                       |
| `messages_tokens`      | 请求中的 user、assistant 和工具结果内容，不包括归因到 `memory_files_tokens` 的精确匹配的末尾 catalog part，以及归因到 `skills_tokens` 的已加载 Skill 内容。完成归一化时，它变为固定分类根据 provider 输入用量归一化后的残差。                                                                                                                                        |

Memory 归因使用精确的片段移除。对于 `getUserMemory()` 和
`getAutoMemoryPrompt()` 返回的每个非空值，先从生效系统指令中移除其精确的 trim 后文本，
再估算 `system_prompt_tokens`，然后将被移除的文本计入一次 `memory_files_tokens`。
如果配置的块不在请求中，或精确匹配失败，它会保留在 `system_prompt_tokens` 中，
不会再次加入 `memory_files_tokens`。

Catalog 归因使用独立的精确边界检查。非空的 `Config.getAutoMemoryContext()` 值只有在
精确匹配最终 user `Content` 的最终 text part 时，才会计入 `memory_files_tokens`。
匹配成功时，只有该最终 catalog part 会在估算 `messages_tokens` 前被移除；该 user 内容的其他 part
以及更早出现的相同 user 文本仍保留在 `messages_tokens` 中。Part 元数据不参与 token 估算。如果最终 text part
没有精确匹配，catalog 会完整保留在 `messages_tokens` 中，也不会再次加入 `memory_files_tokens`。

系统指令、工具定义、memory 和 Skill 文本使用 `/context` 已有的 CJK 感知启发式方法：
ASCII 字符按每 4 个字符估算为一个 token，非 ASCII 字符按每个字符 1.5 个 token 估算。
实现会将这个小型纯函数 helper 提取到 core 中，避免 CLI 与 telemetry 产生偏差。

结构化请求消息使用现有的 `estimateContentTokens` 遍历，而不是将完整请求字符串化。
该遍历处理文本、函数调用、函数响应和内联媒体，不会把图片 base64 当作普通 prompt 文本计数。
本报告变更不会修改 `estimateContentTokens`，也不会修改已经依赖它的安全关键压缩闸门。

两个估算器在请求开始时有意保持不对称。固定文本分类使用 CJK 感知的上下文报告启发式方法，
结构化消息继续使用压缩估算器的扁平字符比例。因此，对于没有收到 provider 用量的失败、取消或
TTL 放弃 span，CJK 较多的消息可能会被低估。当 `messages_tokens` 变成 provider 总数的残差时，
已完成的 span 会吸收这一差异。提取出的 helper 使用独立的上下文报告名称，不得在压缩闸门中替换
`estimateContentTokens`。

Telemetry 路径永远不会调用 `SkillManager.listSkills()`。内存中的 Skill 工具在首次将
`buildSkillLlmContent` 的精确输出插入请求历史时保留它，因此后续编辑或缓存重新加载不会改写历史归因。
对请求 parts 的一次遍历只匹配 `functionResponse.name === "skill"` 的 part，并将
`functionResponse.response.output` 与保留的输出进行精确比较。它不会将整个 part 字符串化，也不会匹配
`parts[].text`。匹配到的输出只计入一次 `skills_tokens`，并从 `messages_tokens` 中排除。
如果 body 后面紧跟 scheduler 添加上下文时使用的换行边界，也会匹配；只有不可变 body 归因到
`skills_tokens`，后缀保留在 `messages_tokens` 中。截断和持久化 wrapper 不会保留该精确 body 前缀，
因此会整体保留在 `messages_tokens` 中。后续已经加载的确认消息和 microcompacted 输出同样不会匹配
首次加载的 body。当压缩移除了精确 body 时，不会向 `skills_tokens` 添加 body token；剩余摘要保留在
`messages_tokens` 中。属性保持完整且不会阻塞请求，同时 `estimated: true` 表明归因是近似值。

会话恢复或 fork 时，Skill 工具通过将恢复的 Skill 响应与同步缓存的 Skill body 匹配，重新填充其已加载内容缓存。
重建过程会将每个响应与其 Skill 函数调用以及请求的文件 Skill 名称配对，因此模型可调用的命令响应不会被误认为缓存的文件 Skill。
精确 body 和已知的换行分隔 hook 后缀会被恢复；截断和持久化 wrapper 仍然排除在外。
在重建之前，输出会话在 session ID 切换时清除其已加载状态。这样，跨进程或会话边界后仍保持相同的归因规则，
而且请求路径不需要读取文件。

### Provider 总数归一化

请求开始时每个分类都是本地估算，并且省略 `available_before_compaction_tokens`。
如果 provider 随后报告有效的 `gen_ai.usage.input_tokens`，结束时按以下规则处理：

有效的 provider 报告 `gen_ai.usage.input_tokens` 值对最终总数具有权威性。本地估算不会覆盖它；
本地估算只用于确定下述固定分类分配和消息残差。

1. 保留五个固定分类的比例：系统 prompt、内置工具、MCP 工具、memory files 和 Skill。
2. 如果它们的估算总和超过 provider 总数，则使用最大余数分配按比例缩小：每个分类乘以相同的缩放系数，
   对五个结果全部向下取整，然后按小数余数降序分配剩余的 `provider_total - sum(floors)` 个 token。
   平局时使用上面 schema 字段的顺序。在此分支中，五个固定分类的总和等于 provider 总数，
   `messages_tokens` 为零。
3. 否则保留五个固定分类的估算值，并将 `messages_tokens` 设为
   `provider_total - fixed_category_sum`。
4. 使用窗口、预留和同一个 provider 总数设置 `available_before_compaction_tokens`。

最终不变量为：

```text
sum(breakdown.*_tokens) == gen_ai.usage.input_tokens
```

当 provider 报告有效输入总数时必须满足该不变量。缓存输入 token 不需要特殊处理：不要复制
`/context` 的 `apiCachedTokens` 分支，也不要从 `messages_tokens` 减去 cache reads。
Cache reads 影响计费和延迟，而不影响 token 所属的上下文分类；它们只保留在
`gen_ai.usage.cache_read.input_tokens` 中。

当没有有效的 provider 总数时，请求开始时的估算保留在 span 上，breakdown 不会被强制设为未知总数，
`available_before_compaction_tokens` 也保持省略。

## Span 生命周期与归属

`LoggingContentGenerator.generateContent` 和 `generateContentStream` 在同步前置阶段、
第一个 `await` 之前构建快照。这样可以捕获本次尝试的请求工具 reveal、memory、Skill、模型窗口和压缩预留状态，
避免后续可变配置改变 span。当 tracing 未启用时，工作受 `isTelemetrySdkInitialized()` 控制，正常请求无需承担上下文扫描成本。

`LoggingContentGenerator` 由并发调用共享。只有生效窗口大小作为不可变的构造函数状态保留；每个上下文快照都是方法局部值，
随后由其 `SpanContext` 持有。generator 实例不保存可变的请求级快照。

快照通过 `StartLLMRequestSpanOptions` 传递，并保留在内部 `SpanContext` 中：

1. `startLLMRequestSpanWithContext` 立即将请求开始时的快照序列化到 span 上。因此，由 TTL 清理结束的放弃 span 仍然携带基本上下文元数据。
2. `endLLMRequestSpan` 使用有效的 `metadata.inputTokens` 归一化 breakdown，并在结束 span 前覆盖同一个属性。
3. 成功、流完成、取消、超时和错误路径继续使用已有的集中式结束 helper，不新增按路径分别调用的 telemetry。

当前重试层为每个物理尝试创建一个 LLM span。因此每次尝试都会获得自己的快照。
失败尝试通常保留本地估算，成功尝试通常获得 provider 总数归一化后的值。

`isInternalPromptId` 识别出的后台 prompt ID 不会发出该属性。它们的请求不是该字段所表示的面向用户的会话，
也不是 `/context` 状态和自动压缩容量对应的会话。这些 span 上的标准 provider 用量属性保持不变。
主 agent、subagent 以及非内部的独立 LLM 请求会发出该属性。

## 工件边界与离线分析

会话 JSONL 和导出的 trace 是分开的诊断工件。聊天记录默认启用，本地 JSONL 会持久化已接受的会话内容、
工具调用和结果、用量元数据、上下文窗口大小以及压缩检查点。它也可以被禁用；收集它会泄露原始会话内容，
而集中式 operator 可能没有访问权限。因此，该属性面向的离线工作流是分析经过清理的导出 trace，
不收集或关联用户本地 transcript。

JSONL 同时是会话和恢复记录，并不是完整的物理尝试快照。它不保存生效的组装后系统指令、某次尝试实际 reveal 的工具声明、
精确的 memory/configuration 与已加载 Skill 归因，也不保存每一次失败的重试尝试。这里支持的具体查询是：
对于一次物理 LLM 尝试，上下文压力、延迟、错误、缓存行为或压缩，主要与系统指令、内置或 MCP 工具、memory、
已加载 Skill 还是消息相关？trace 可以在不暴露底层文本、也不需要跨工件 join 的情况下回答该问题。
这个查询所需、无法重建的输入，是该次尝试的有效 `system_prompt_tokens`、`builtin_tools_tokens`、
`mcp_tools_tokens`、`memory_files_tokens` 和 `skills_tokens` 值。

一些已接受 turn 的值，尤其是消息用量和窗口大小，可以从本地 JSONL 重建。尽管如此，版本 1 仍保留全部六个分类，
使每个 trace 快照自包含，并使 provider 总数不变量不依赖另一个具有不同保留策略、权限和尝试覆盖范围的工件。

该属性不增加第二个 opt-in 或采样开关。Tracing 初始化后，每个非内部物理尝试都遵循上述发出规则，包括重试和 subagent。
现有 trace 与 exporter 策略继续作为决定是否记录或导出 span 的控制面。

## 失败、隐私与性能规则

- 上下文 telemetry 尽力而为。快照或序列化失败时省略完整属性，且永远不改变请求执行。
- 窗口大小无效时省略完整属性。无效的分类值不会被部分序列化。
- payload 只包含固定的 key 集合、数值聚合、一个布尔值和 schema 版本。它永远不包含 prompt 文本、消息文本、文件路径、工具名、MCP server 名、Skill 名、模型 ID、会话 ID 或 user ID。
- 该属性不受 `telemetry.includeSensitiveSpanAttributes` 控制；聚合 token 数与现有标准用量统计具有相同的敏感性分类。
- span 开始路径不允许文件系统、网络、tokenizer 或异步工作。工具和 Skill 信息只来自请求以及已提交的内存缓存。
- 快照构建只对逻辑请求执行有界数量的线性遍历。不得为每个工具、Skill 或消息增加嵌套扫描。
- schema 具有固定 key 集和有界序列化大小。JSON 是紧凑的，永远不会被截断成无效 JSON。在 SDK 初始化时，Qwen Code 按照 `NodeSDK` 使用的相同优先级解析标准 OTel span 专属/通用属性值限制，并显式传给 SDK。若属性超过该正有效限制与固定的 1024 字符安全限制中较小的一个，则序列化会省略完整属性。没有正的有效限制时，只使用固定限制。Span 开始时还会为同一快照预检保守的最终化最大大小；如果 provider 总数归一化后的值可能超过限制，则从开始阶段省略属性，避免未归一化的值在最终化后残留。
- 大小限制约束的是每个 span 的 payload，而不是全 fleet 的摄入量或值基数。总量随物理尝试数增长，包括重试和 subagent，并且聚合 JSON 值预计几乎都是唯一的。后端应解析选定的 key，而不是将完整字符串建立索引。

## 兼容性与查询契约

消费者必须解析 JSON 并根据 `version` 分支处理。未知 key 必须忽略。在语义不变的情况下增加可选 key，
在版本 1 内兼容。重命名或删除 key、改变单位，或改变分类含义，都需要新版本。

不可用的可选值会被省略，而不是序列化为 `null` 或 sentinel。发出属性时，版本 1 始终包含六个 breakdown key、
压缩预留和 `estimated`。

后端查询使用标准标量获取总用量，使用 JSON 提取进行分类分析。概念上：

```text
input utilization = gen_ai.usage.input_tokens
                  / json(window_size_tokens)

MCP share = json(breakdown.mcp_tools_tokens)
          / gen_ai.usage.input_tokens
```

JSON 解析比单独的标量属性更不利于建立索引，而近乎唯一的完整字符串不适合作为索引维度。
这是只增加一个字段所接受的权衡。版本 1 尚未针对生产 fleet 规模或真实后端查询进行验证。
发布验证必须测量每次尝试导出的字节数和有代表性的 JSON 提取查询成本。如果任一项不可接受，后续变更可以使用现有 trace 采样控制，
或定义更窄的版本化契约；版本 1 不预分配标量别名。

## 实现计划

1. 将现有的 `/context` CJK 感知文本估算器以独立的上下文报告名称加入依赖轻量的
   `services/tokenEstimation.ts` 模块，并通过 core package 导出。让 `/context` 导入这个 helper。
   保持现有的 `estimateContentTokens` 压缩估算器不变，并将 CLI 的明细解析、本地化和渲染保留在 CLI package。
2. 增加纯 `telemetry/context-usage.ts` 模块，定义 V1 类型、provider 总数归一化、校验、生效的 OTel/固定字符限制和紧凑序列化。
   它不得导入 `Config`、工具实现或 `LoggingContentGenerator`，这样 `session-tracing` 不会产生 telemetry 到工具的依赖循环。
3. 在请求 wrapper 边界保留请求源信息收集。让 `LoggingContentGenerator` 持有 generator configuration 引用，
   在快照时读取其生效的上下文窗口大小，在那里使用 `Config` 和工具 registry 对请求分类，并将得到的纯数字快照同时传给流式和非流式 span 开始逻辑。
4. 将结构化快照加入 `StartLLMRequestSpanOptions` 和内部 `SpanContext`。开始时预检并序列化，仅在发出属性时保留快照，
   并在 `endLLMRequestSpan` 获得有效输入用量后覆盖它。
5. 不改变 span 名称、span kind、现有标准用量字段、敏感内容控制、事件、指标或 exporter。

## 验证计划

上下文用量模块的单元测试覆盖：

- 精确的版本 1 JSON 形状和紧凑序列化；
- 超过生效的正 OTel span 限制或 1024 字符安全限制时省略整个属性；
- 与 `/context` 一致的 CJK 和 ASCII 估算；
- 含内联媒体的结构化消息，且不会因 base64 大小而膨胀；
- system prompt 与 memory 的归因；
- 精确的最终 user Content catalog 归因，只移除最终 catalog part，并将其他 user part 和更早出现的相同 user 文本保留在 messages 中；
- catalog 精确匹配失败时，将 catalog 保留在 messages 中且不加入 `memory_files_tokens`；
- 精确匹配失败时只将 memory 留在 system prompt 分类；
- 来自逻辑请求的内置、已 reveal 的 MCP、隐藏的延迟工具和 Skill 工具归因；
- 从不可变插入输出进行已加载 Skill 归因，包括缓存编辑和压缩后的无陈旧 body 归因；
- 最大余数归一化，包括确定性的平局处理，且 breakdown 总和等于 provider 输入；
- 缓存的 provider 输入仍保留在完整分类总和中，而 cache reads 保留在标准 cache-read 属性中；
- 没有 provider 输入时省略可用量，以及有输入时根据推导出的自动阈值计算可用量；
- 拒绝无效或非有限值；以及
- 序列化 payload 不包含名称、路径和内容。

Session-tracing 测试覆盖初始发出、结束时覆盖、无效快照省略、有 provider 用量的成功情况、无用量的错误、取消和幂等 span 最终化。

`LoggingContentGenerator` 测试覆盖流式和非流式接线、有效 fallback-model 窗口归属、每次重试尝试一个快照，以及内部 prompt ID 的省略。
测试还会验证快照构建或序列化失败不会阻止被包装的 provider 调用。

本地 OTLP smoke test 发送一次正常请求，并验证导出的 LLM span 包含可解析的版本 1 JSON、标准输入 token 标量、
归一化总和不变量以及预期的自动压缩可用量。由于本阶段不改变 `/context` 渲染或其他用户可见行为，不需要 UI E2E 计划。
从对应 package 目录运行针对性的 core 和 CLI 测试，然后执行 repository build 和 typecheck。

## 未选择的替代方案

- **`qwen-code.context.window_size`**：对于所需的分类和压缩信息过于狭窄，并且会使后续重命名不可避免。
- **多个标量属性**：更容易建立索引，但会为每个分类和阈值增加字段，而需求只要求一个字段。
- **`gen_ai.context.*` 属性**：会在标准命名空间中放入非标准契约。
- **OTel 对象值**：任意对象不是有效的 span 属性值；必须使用 JSON 序列化。
- **从 telemetry 调用 `collectContextData`**：它是异步的，包含 CLI 类型和本地化逻辑，可能从文件系统发现 Skill，并读取响应后的 UI/session 计数器。它对 provider 请求路径来说既不安全，时机也不正确。
- **单独的指标或日志事件**：会失去与具体 LLM 尝试的一对一关联，并在该需求不需要时增加另一条 telemetry 面。
