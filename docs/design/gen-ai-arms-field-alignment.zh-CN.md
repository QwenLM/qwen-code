# GenAI 与 ARMS 字段对齐

[English](./gen-ai-arms-field-alignment.md)

## 范围与标准基线

本设计对齐 Qwen Code 首批在 OpenTelemetry GenAI 语义约定与阿里云 ARMS LLM Trace 之间名称、类型和含义一致的 Span 属性，保留框架现有的 Span 名称和类型。主 Agent 扩展让现有交互 Span 成为完整工具续接拓扑的父节点。
本文也记录需显式启用的 ARMS 专用终端用户身份扩展。

OpenTelemetry GenAI 约定仍处于 Development 状态。本变更锁定到提交
[`2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b`](https://github.com/open-telemetry/semantic-conventions-genai/tree/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b)：

- [推理 Span](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/docs/gen-ai/gen-ai-spans.md)
- [Agent Span](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/docs/gen-ai/gen-ai-agent-spans.md)
- [GenAI 注册表](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/2e994c6d59a93bb4fc1752c5378eedb9b8e14d6b/model/gen-ai/registry.yaml)

主 Agent 调用与错误状态行为还遵循 semantic-conventions-genai 提交
[`8d3e4a0f3c34a46f6edb9c71e8666e02e6bf3958`](https://github.com/open-telemetry/semantic-conventions-genai/tree/8d3e4a0f3c34a46f6edb9c71e8666e02e6bf3958)
中的 Agent Span 和错误记录文档。

流式属性是一项范围有限的补充，锁定到
[OpenTelemetry Semantic Conventions v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-spans.md)。
此补充仅采纳 `gen_ai.request.stream` 和 `gen_ai.response.time_to_first_chunk`，并非整体升级上述基线。

`gen_ai.request.reasoning.level` 是一项范围有限、仅依据 OTel 的补充，来自上述锁定的 GenAI 注册表。它将 OpenAI 兼容请求中已有的推理强度暴露到遥测中，不引入私有别名或 ARMS 专属仪表盘映射。

ARMS 基线为 [LLM Trace 字段定义](https://help.aliyun.com/zh/arms/application-monitoring/developer-reference/llm-trace-field-definition-description)。
升级任一基线都需要重新生成并审查此矩阵。

## 字段契约

| Span     | 本阶段发出的标准属性                                                                                                                                                                                                                                       | 来源与省略规则                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| LLM      | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.request.model`                                                                                                                                                          | 在创建 Span 时写入。会话 ID 使用现有 session ID。                                                                                       |
| LLM 请求 | `gen_ai.request.choice.count`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.frequency_penalty`, `gen_ai.request.presence_penalty`, `gen_ai.request.stop_sequences`, `gen_ai.request.reasoning.level` | 从经过提供方适配后的首个最终 SDK 请求对象读取。无效或不可用的值省略；不推断 SDK 或服务端默认值。                                        |
| LLM 流式 | `gen_ai.request.stream`, `gen_ai.response.time_to_first_chunk`                                                                                                                                                                                             | 流式请求发出 `true`；非流式请求省略标准流式标记。收到首个归一化响应后，以秒为单位发出首块时间。                                         |
| LLM 输入 | `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`                                                                                                                                                                           | 来自同一个首个最终请求的敏感紧凑 JSON。每个完整值在无效或超限时独立省略。                                                               |
| LLM 响应 | `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`                                                                                                                                                                            | 仅使用提供方响应数据。缺失响应模型时省略，不以请求模型替代。所有候选的结束原因按候选索引排序。                                          |
| LLM 输出 | `gen_ai.output.type`, `gen_ai.output.messages`                                                                                                                                                                                                             | 对支持的 Gemini/Vertex 请求设置发出输出类型。敏感输出消息来自最后一次物理请求尝试，保留每个候选。                                       |
| LLM 用量 | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`                                                                                                              | 仅使用提供方报告的非负安全整数。保留显式零值。只报告总量时省略输入/输出用量，不作估算。                                                 |
| 工具     | `gen_ai.operation.name=execute_tool`, 条件性的 `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.tool.description`, `gen_ai.tool.type=function`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`                             | Agent 名称复制自实际父 Agent。描述为静态元数据；敏感参数反映实际执行的调用，结果仅在成功时记录。                                        |
| 主 Agent | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=qwen-code`, `gen_ai.conversation.id`, 可选的 `gen_ai.output.type=json`, 敏感的 `gen_ai.input.messages`, 敏感的 `gen_ai.output.messages`                                                           | 使用现有交互 Span。输入为一条原始用户提示的投影；输出为一条最终用户可见回答。省略请求模型、提供方、Agent ID/版本/描述、指令与聚合用量。 |
| 子 Agent | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.conversation.id`, 可选的 `gen_ai.request.model`                                                                                                             | 描述限制为 1024 个 UTF-16 代码单元。内部调用 ID 保持私有。                                                                              |

没有精确标准对应项的私有属性继续保留以维持兼容性，下表明确移除的除外。与标准完全等价的私有别名和无效 GenAI 别名直接移除，不设双写过渡期：

| 移除的属性                               | 替代项                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| LLM `qwen-code.model`                    | `gen_ai.request.model`；主 Agent 交互保留 `qwen-code.model` 并省略标准请求模型，因为模型选择可能在调用期间变化 |
| LLM `response_id`                        | `gen_ai.response.id`；API 响应/错误日志保留现有 `response_id` 模式                                             |
| LLM `input_tokens`                       | 提供方报告输入明细时使用 `gen_ai.usage.input_tokens`                                                           |
| LLM `output_tokens`                      | 提供方报告输出明细时使用 `gen_ai.usage.output_tokens`                                                          |
| LLM `cached_input_tokens`                | 提供方报告缓存读取时使用 `gen_ai.usage.cache_read.input_tokens`                                                |
| `qwen-code.tool` Span 的 `tool.name`     | `gen_ai.tool.name`；等待用户和 Hook Span 继续使用 `tool.name`                                                  |
| `gen_ai.usage.cached_tokens`             | 提供方报告缓存读取时使用 `gen_ai.usage.cache_read.input_tokens`                                                |
| LLM `llm_request.stream`                 | `gen_ai.request.stream`；流式发出 `true`，非流式按语义约定省略此属性                                           |
| `gen_ai.server.time_to_first_token`      | 不发出；它不等价于标准首块属性                                                                                 |
| `gen_ai.usage.reasoning_tokens`          | 此基线中没有 ARMS/GenAI 共有属性；继续查询私有 `thoughts_token_count`                                          |
| LLM `system_prompt*`                     | `gen_ai.system_instructions`；OpenAI system/developer 消息表示在 `gen_ai.input.messages` 中                    |
| LLM `tools`, `tool_schema` 事件          | `gen_ai.tool.definitions`                                                                                      |
| LLM `response.model_output*`             | `gen_ai.output.messages`                                                                                       |
| 工具 `tool_input*`                       | `gen_ai.tool.call.arguments`                                                                                   |
| 工具 `tool_result*`                      | `gen_ai.tool.call.result`                                                                                      |
| `tools_count`, 哈希/预览/长度/截断元数据 | 无标准对应项；移除                                                                                             |

`gen_ai.response.finish_reasons` 现在为所有候选保留提供方原始字符串，不再使用之前归一化到 Gemini 的值。过滤 `STOP` 或 `MAX_TOKENS` 等值的现有查询必须迁移到提供方值，例如 `stop`、`length`、`tool_calls` 或 `end_turn`。

`gen_ai.response.time_to_first_chunk` 使用单调计时器，从调用被包装的提供方之前开始计时，直到 `LoggingContentGenerator` 观察到首个归一化的 `GenerateContentResponse`。提供方适配器可能在原始协议帧到达日志包装器前对其过滤或合并，因此适配器丢弃的帧（例如 OpenAI 管道的空响应过滤）不计入此测量，记录值可能晚于真正的首个网络帧。通过适配器过滤的仅元数据和仅用量归一化响应也算作块。流随后失败、被中止或超时时仍保留此属性；没有块到达时省略。

内部 `ttftMs` 计时器仍表示首次用户可见输出的延迟，并继续驱动 `ApiResponseEvent.ttft_ms`、`sampling_ms`、`output_tokens_per_second` 和 API 请求耗时分解指标。因此，`duration_ms - gen_ai.response.time_to_first_chunk * 1000` 并不等于 `sampling_ms`。

现有流式 Span 查询应将 `llm_request.stream=true` 替换为 `gen_ai.request.stream=true`；非流式 Span 通过缺少 `gen_ai.request.stream` 识别（旧的 `llm_request.stream=false` 过滤器现在匹配零行）。Span 的 `ttft_ms` 仍可用于首次用户可见输出的延迟；`gen_ai.response.time_to_first_chunk` 是独立的标准属性，以秒为单位测量首个归一化块的延迟。

## 提供方与操作解析

解析是基于生效的内容生成器配置的纯函数。它不会返回 URL、凭据、任意代理主机名，也不会从模型名称推断值。

1. Qwen OAuth 以及与 `DASHSCOPE_PROXY_BASE_URL` 完全匹配的地址解析为 `dashscope`。
2. 主机名匹配检查域名边界，识别阿里云百炼端点和阿里内部网关、Azure OpenAI，以及受支持的第三方端点（DeepSeek、xAI、Mistral、MiniMax、Z.AI、ModelScope、MiMo、OpenRouter 和 Requesty）。
3. 主机未知时，使用已知的 `apiKeyEnvKey` 识别配置的提供方。发生冲突时以主机身份为准。
4. 未知端点回退到协议提供方：`openai`、`anthropic`、`gcp.gemini` 或 `gcp.vertex_ai`。

OpenAI 兼容、Anthropic 和 Qwen OAuth 请求使用 `chat` 操作。
Gemini 和 Vertex AI 请求使用 `generate_content`。

## 请求参数

在提供方适配器应用默认值、覆盖值、移除不支持字段并限制输出窗口之后，紧接着调用提供方 SDK 之前，收集请求属性。这是 Qwen Code 能观察到的最终 SDK 请求对象，不是原始逻辑配置或序列化后的 HTTP 请求体。一个逻辑 LLM Span 只记录其首个此类请求快照。

| 标准属性                           | OpenAI 兼容与 Qwen OAuth                                  | Anthropic        | Gemini 与 Vertex AI       |
| ---------------------------------- | --------------------------------------------------------- | ---------------- | ------------------------- |
| `gen_ai.request.choice.count`      | `n`                                                       | 不适用           | `config.candidateCount`   |
| `gen_ai.request.max_tokens`        | `max_tokens`, `max_completion_tokens` 或 `max_new_tokens` | `max_tokens`     | `config.maxOutputTokens`  |
| `gen_ai.request.temperature`       | `temperature`                                             | `temperature`    | `config.temperature`      |
| `gen_ai.request.top_p`             | `top_p`                                                   | `top_p`          | `config.topP`             |
| `gen_ai.request.frequency_penalty` | `frequency_penalty`                                       | 当前不发送       | `config.frequencyPenalty` |
| `gen_ai.request.presence_penalty`  | `presence_penalty`                                        | 当前不发送       | `config.presencePenalty`  |
| `gen_ai.request.stop_sequences`    | `stop`                                                    | `stop_sequences` | `config.stopSequences`    |
| `gen_ai.request.reasoning.level`   | `reasoning_effort`                                        | 不映射           | 不映射                    |

有限数值和安全整数精确保留，包括失败的提供方请求中的零值与负值。候选数量为一时省略。停止序列必须是完整的字符串数组；OpenAI 的单字符串形式归一化为单元素数组。保留空数组，混合类型数组整体省略，不进行筛选。记录显式的适配器默认值，不推断隐式的 SDK 或服务端默认值。

当多个 OpenAI 兼容输出预算别名同时存在时，仅在所有出现的值均为有效安全整数且相等时发出标准最大值。存在冲突时省略，因为各兼容端点没有共同的优先级规则。

推理强度精确保留请求自身 `reasoning_effort` 属性中的非空字符串，包括提供方特有档位，以及实际发送时的 `none`。缺失、空字符串、非字符串和继承的属性值均省略。不从设置恢复被提供方适配器移除的值，也不映射提供方特有的嵌套推理对象。此非敏感请求参数沿用现有首个请求观察器和通用 Span 导出器，独立于敏感内容采集开关。实现与回归测试位于 `packages/core/src/telemetry/gen-ai-request.ts` 及其同目录测试文件；开发者遥测指南列出导出的属性。验证时对比捕获的请求和导出的 LLM Span，检查省略规则及首个请求的保留行为，不改变提供方或重试行为。

## 内容与工具载荷

仅在启用 `telemetry.includeSensitiveSpanAttributes` 时采集敏感 GenAI 内容。Qwen Code 不读取 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`，因此只有一个内容采集开关。OpenAI 兼容、Anthropic、Gemini 和 Vertex 适配器将经过提供方适配后的最终 SDK 请求及原始响应结构转换为本设计锁定的 JSON 模式。

第一次物理请求尝试提供输入消息、系统指令和工具定义。响应绑定到对应生成尝试：提供方回退或要求启用思考的重试会启动新的响应累加器，旧尝试中迟到的块被忽略。流式累加器保留规范化的部分而非原始块。部分失败时，未完成的候选标记为 `error`；成功响应中某个候选缺少显式结束原因时，省略整个输出消息属性。

主 Agent 交互使用独立投影，不使用提供方累加器。其输入为模型上下文扩展前可靠的原始用户文本。其输出为工具、重试、回退、Hook、Steer 和 next-speaker 续接全部结束后，用户可见的单条最终文本。ACP 通道投递保留独立的全文缓冲区，不受遥测限制截断。结构化输出为紧凑 JSON 文本，使用 `finish_reason=tool_call`。

每个 JSON 属性紧凑序列化，独立受 `telemetry.sensitiveSpanAttributeMaxLength` 限制。无效、循环、不完整或超限的属性值整体省略；绝不截断 JSON。在 `gen_ai.tool.definitions` 中，`type` 和 `name` 是必需标识，标识无效时省略整个属性。`parameters` 在标准模式中为可选项；提供方参数模式无法归一化为 Draft-07 时，仅省略此可选项，保留有序的工具标识列表。提供方显式发送或返回的空数组和空对象会被保留。默认限制为 1 MiB 时，应用侧敏感属性理论上限约为每个 LLM Span 4 MiB、每个工具 Span 2 MiB，以及每次交互的 Agent 输入、Agent 输出和兼容属性 `new_context` 合计 3 MiB。采集器和后端可以施加更低限制。

工具参数在权限检查和编辑 Hook 之后、紧接着执行之前，从最终调用参数中捕获。工具结果仅在调用和后处理均成功之后，从返回给模型的最终 `FunctionResponse.response` 对象中捕获。两个根值都必须是 JSON 对象。`gen_ai.tool.description` 来自静态注册表描述，不属于敏感内容；限制为 4096 个 UTF-16 代码单元，保留代理对，缩短时追加 `…[truncated]`。Agent 描述和 Span 错误仍保留 1024 单元限制。

## 响应与用量来源

提供方转换器通过 `WeakMap` 向归一化 Gemini 用量对象附加内部来源信息，记录缓存读取字段是否实际存在，以及 Anthropic 缓存创建 token 数。此做法保留公开响应 JSON 的形状，并让垃圾回收跟随归一化用量对象。

OpenAI 兼容提供方仅报告 `total_tokens` 时，归一化总量仍供现有内部消费者使用，但不会合成输入/输出拆分，也不会发出这两个标准用量属性。

OpenAI 的 `response.model`/`chunk.model` 和 Anthropic 消息模型保留为 `modelVersion`。提供方模型缺失时，追踪中也保持缺失；请求模型回退仍仅用于现有 API 日志和 UI 行为。流合并将最后已知的提供方模型和用量来源带入终止响应。Anthropic 的 `message_start` 输入及缓存用量附加到随后第一个产出的块，使流部分失败时仍保留提供方报告的用量，而不合成输出数量。

## ARMS 配置

ARMS 自动识别 GenAI 应用需要以下 Resource 属性：

```json
{
  "telemetry": {
    "resourceAttributes": {
      "acs.arms.service.feature": "genai_app"
    }
  }
}
```

Qwen Code 不注入此厂商专用 Resource 属性或 `gen_ai.span.kind`。ARMS 可以通过 `gen_ai.operation.name` 推断 LLM、工具和 Agent 角色。

### ARMS 终端用户身份扩展

`gen_ai.user.id` 是 ARMS Span 通用属性，不属于上述锁定的 OpenTelemetry GenAI 基线。仅当操作者显式配置 `telemetry.userId` 或 `QWEN_TELEMETRY_USER_ID` 时，Qwen Code 才发出此属性。在创建交互 Span 时设置该值，并通过现有进程内上下文传播至 LLM、工具和 Agent Span，包括通过链接关联的根级 fork/后台 Agent。工具结果续接通过精确的 prompt ID 查找同一个活动交互，并保持为其子节点。活动注册表和保留的身份条目沿用现有 30 分钟 Span 兜底 TTL 到期。

该值绝不被推断或自动生成，不写入 Resource/日志/指标，也不放入出站 Baggage。Qwen Code 不双写 `enduser.id` 或 `user.id`。之前配置的 `telemetry.resourceAttributes.user.id` 仍为通用 Resource 维度，迁移时必须显式移除。因为此设置作用于整个进程，仅支持一个进程代表一个终端用户的场景；共享守护进程和通道部署中的请求级身份，推迟到可信调用者身份能够端到端接通之后再实现。

## 延后工作

- `seed` 和 `top_k` 在基线中的 ARMS 与 GenAI 类型不兼容。
- Embedding 在追踪前需要正确的请求模型生命周期。
- ARMS 首 token 时间与 OpenTelemetry 首块时间的名称、单位和含义不同。Qwen Code 同时发出标准 `gen_ai.response.time_to_first_chunk` 和私有 `ttft_ms`，不保证自动填充 ARMS 首 token 仪表盘。
- 完整 GenAI Span 命名、CLIENT Span 类型和逻辑重试拓扑属于独立的合规工作。
