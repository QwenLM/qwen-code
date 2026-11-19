# 从请求发出开始计算 TTFT

[English](ttft-from-request-dispatch.md) | [简体中文](ttft-from-request-dispatch.zh-CN.md)

## 状态与范围

已实现。本次把流式请求首 token 时间（TTFT）的起点移到 provider 发出已构建请求的时刻。[LLM 请求计时设计](telemetry-llm-request-timing-design.md)的 D1 本来就这样定义 TTFT。[按完整请求时间计算输出速度](output-speed-full-request.zh-CN.md)中的输出速度定义（`outputTokens / (ttftMs + generationMs)`）不变，只是计时起点现在落在该设计所说的位置，即发出请求时。`duration_ms` 和平均 API 延迟仍覆盖整次调用，包括请求构建。

## 问题

TTFT 从 `LoggingContentGenerator.generateContentStream` 开头开始计时。这个时刻早于记录请求日志，也早于 provider 转换和构建请求。在 OpenAI 兼容 pipeline 中，构建并非零开销。在一次对 Token Plan 的 headless 会话里打点，从 TTFT 起点算起测得：

| 会话中的请求 | 构建完成 | 调用 SDK | 请求头写入 socket |
| ------------ | -------- | -------- | ----------------- |
| 第一个       | 188 ms   | 189 ms   | 215 ms            |
| 第二个       | 14 ms    | 14 ms    | 18 ms             |
| 第三个       | 75 ms    | 75 ms    | 77 ms             |

在 CLI 和 provider 之间放一个透传代理，记录每个请求的到达时间和每个 SSE 事件的到达时间。三个会话（deepseek-v4.1-flash、qwen3.6-plus、glm-5.1）的第一个请求，TTFT 都比代理测得的首个可见事件时间多 214–220 ms；后续请求多 8–100 ms。这使该请求的输出速度最多偏低 10%（108.1 tok/s，代理测得 120.3），会话输出速度偏低 1.0–1.7%。

同一段构建时间也会进入 span 的派生计时：`sampling_ms` 和 API 请求分解指标的 `RESPONSE_PROCESSING` 阶段都是 `duration - ttft`。如果只移动 TTFT 起点，它们会吸收构建时间而偏大。

## 设计

### D1 — provider 上报发出时刻

`markRequestDispatched()` 表示一个已构建的请求即将发出。`LoggingContentGenerator` 在调用 provider 的 `generateContentStream` 时，用一个 `AsyncLocalStorage` 回调观察它，做法与为日志捕获 OpenAI 请求相同。每个流式 provider 在把请求交给 SDK 或 fetch 之前调用它：

- OpenAI 兼容 pipeline：构建请求之后、`chat.completions.create` 之前；
- Anthropic generator：`messages.create` 之前；
- Gemini generator：`models.generateContentStream` 之前；
- OpenAI Responses pipeline：`fetch` 之前。

从不上报的 generator 保持原起点，即 `generateContentStream` 开头。打点位置在 HTTP 层之上：SDK 自身的处理和建立连接仍计入。打点中，会话第一个请求的这部分约 26 ms，之后不到 4 ms。

### D2 — 以第一次发出为准

一次 `generateContentStream` 调用内只取第一次上报。因此 provider 在这次调用内再次发出的请求，例如 SDK 重试或 pipeline 重试，仍计入 TTFT，与[按完整请求时间计算输出速度](output-speed-full-request.zh-CN.md)的描述一致。`retryWithBackoff` 的每次尝试都是独立的 `generateContentStream` 调用，各自从自己的发出时刻计时。非流式入口会清除继承来的 dispatch 监听，避免流式请求构建期间的嵌套调用启动外层计时。读取流期间发出的请求（例如 Anthropic 在流为空时补发的非流式探测请求）发生在观察范围之外。

### D3 — 由 TTFT 派生的时间

- `generation_ms` 仍是第一个到最后一个可见块之间的时间。它从第一个可见块本身算起，而不是用已用时间减去 TTFT，所以构建时间不会挪进来。
- `endLLMRequestSpan` 以 `requestBuildMs` 接收从开始到发出的时间。`sampling_ms` 和 `RESPONSE_PROCESSING` 阶段减去它，仍覆盖从第一个可见块到流结束。它不写成 span 属性。`request_setup_ms` 含义不变，仍是本次尝试之前的重试开销。
- `gen_ai.response.time_to_first_chunk` 在自己的单调时钟上从同一个发出时刻起算，所以首块时间不会比 TTFT 多出构建时间。
- managed 诊断的计时计数器拿到同一个 `ttftMs`，所有界面使用同一个定义。
- 本地响应记录用 `first_visible_offset_ms` 保存从请求开始到首个可见输出的时长。会话回放将它表示为可选的 `firstVisibleOffsetMs`。Web Shell 用该偏移定位首 token 标记并计算首个可见块之后的时长，显示的 TTFT 仍从请求发出起算。

## 兼容性

- 远端日志和 span 字段结构沿用现有定义。`ttft_ms`、`/stats` 的 TTFT、Web Shell 的首 token 平均值和 managed 计时计数器都会降低一个构建时间，输出速度略升。
- `duration_ms`、平均延迟和 `request_setup_ms` 不变。`duration_ms` 不再等于 `ttft_ms + sampling_ms`：构建时间位于两者之间。
- 已记录的会话保留原来存下的 `ttft_ms`。恢复的会话会混有新旧两种值。
- Web Shell 遇到缺少首个可见块偏移的轨迹记录时，沿用已记录的 TTFT。

## 不在范围内

- 加快 `buildRequest`。它在第一个请求上的开销另作问题处理。
- 非流式请求，它们没有 TTFT。
- span 的 `output_tokens_per_second`，它继续只按采样窗口计算。

## 验证

- **Core：** 一个流在构建 200 ms 后上报发出，随后在 1000 ms 和 1500 ms 发出可见块，并在 1600 ms 结束；它记录的 `ttft_ms` 为 800，`generation_ms` 为 500，`duration_ms` 为 1600，并传出 `requestBuildMs` 200。250 ms 时的第二次上报不改变结果。`sampling_ms` 和 `RESPONSE_PROCESSING` 不含构建时间。OpenAI 兼容 pipeline 在构建请求之后、调用 SDK 之前上报发出；Anthropic、Gemini 和 Responses 路径在调用 SDK 或 fetch 之前上报。未上报发出的流沿用原起点，现有测试已覆盖。
- **回归覆盖：** 构建请求期间嵌套非流式请求并上报发出时，外层 TTFT 仍为 200 ms。回放上面的计时样例时，轨迹标记位于 1000 ms，显示的 TTFT 为 800 ms，首个可见块之后的时长为 600 ms。
- **实测：** 在 Token Plan 上用 deepseek-v4.1-flash、qwen3.6-plus 和 glm-5.1，经透传代理跑同一个 headless 任务，分别在前一天的 main 构建和本次改动上运行。实测只覆盖 OpenAI 兼容路径。TTFT 减去代理测得的首个可见事件时间：

  | 请求           | 改动前     | 改动后   |
  | -------------- | ---------- | -------- |
  | 会话中第一个   | 214–220 ms | 28–45 ms |
  | 后续主会话请求 | 8–55 ms    | 4–18 ms  |
  | 自动记忆提取   | 81–100 ms  | 6–9 ms   |

  `/stats` 的会话输出速度与代理结果的偏差，改动前为 1.0–1.7%，改动后为 0–0.4%。第一个请求余下的差距是 SDK 自身处理和建立连接的时间，D1 有意保留。改动后，span 的 `sampling_ms` 与代理测得的首个可见事件到流结束的时间相差不超过 8 ms。
