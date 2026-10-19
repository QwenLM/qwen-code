# Web Shell Token 消耗中的按模型生成计时

[English](model-generation-timing.md) | [简体中文](model-generation-timing.zh-CN.md)

## 状态与范围

已为 #14722 实现。Web Shell「Token 消耗」面板和 daemon 会话 stats 路由新增按模型统计的首 token 延迟（TTFT）、生成时间和输出速度。本改动同时修正 CLI `/stats` 现有生成计时里的两处测量错误。它基于 [`/stats` 生成计时指标](2026-07-24-generation-stats.md)和 [LLM 请求计时拆解](telemetry-llm-request-timing-design.md)两份设计，修改了 TTFT 的触发时机和生成窗口的测量方式。它还扩展了 daemon/Web Shell 的 stats 结构，而 `/stats` 设计当时没有改动这一结构。

## 问题

1. 「Token 消耗」面板为每个模型显示请求数和平均延迟，即请求总耗时除以请求数，失败请求也计入在内。这个数字无法区分起步慢和生成慢。
2. 对纯工具调用的响应，TTFT 覆盖了整个请求。OpenAI 兼容和 Anthropic 生成器要等工具调用的参数完整后才输出 `functionCall` part。在此之前的块只携带 tool-call preparation，而 TTFT 判定会忽略它。
3. 当响应的可见输出在一个块里一次到达时，它的输出速度取决于消费方处理这个块花了多久。生成窗口是 `duration_ms - ttft_ms`，而 `duration_ms` 在消费方处理完最后一个块之后才取值。
4. 生成指标只有会话级汇总，daemon stats 路由也不输出它们。

## 设计

### D1 — tool-call preparation 算作用户可见输出

对携带 tool-call preparation 的块，`hasUserVisibleContent` 返回 true。ACP 已经把 preparation 渲染为 `preparing` 状态的工具调用，因此 TTFT 的含义不变：用户能看到的第一个输出（计时设计 D1）。一次性给出完整工具调用的 provider 不受影响。

### D2 — 生成窗口在最后一个可见块处结束

`LoggingContentGenerator` 在 `ApiResponseEvent` 上记录 `generation_ms`：从第一个到最后一个含用户可见内容的块之间的时间。`UiTelemetryService` 用它计算生成时间和 TPS。该字段出现之前记录的事件回退到 `max(0, duration_ms - ttft_ms)`。当全部可见输出在一个块里到达时，`generation_ms` 为 0。这样的响应计入 TTFT，但不计入 TPS，这正是 `/stats` 设计对零生成时间的既定处理。span 属性 `ttft_ms` 和 `sampling_ms` 的定义不变；由于 D1，工具调用的 `ttft_ms` 会更早触发。

### D3 — 按模型的计数器放在 `statsModels` 中

每个 `statsModels` 条目新增可选的 `generation` 对象，包含 `timedRequests`、`totalTtftMs`、`totalGenerationDurationMs` 和 `totalThroughputOutputTokens`。它们按与会话级 `generation` 相同的规则累计，同样排除内部 prompt。这些计数器不加到 `models` 中：该 map 还会写入 managed 的模型用量记录，而 `CsiNativeActivationProof` 按封闭的字段集合校验其中每个模型条目。

### D4 — stats 路由上的可选 `generation` 对象

当某个模型至少有一次计时请求时，`GET /session/:id/stats` 会在 `models[name].generation` 中返回这四个计数器。`ServeSessionStatsModelMetrics` 和 `DaemonSessionStatsModelMetrics` 将该字段声明为可选。直接对 JSON 做类型断言的消费方不受影响。

### D5 — 每张模型卡片一行延迟

「Token 消耗」中每张模型卡片的标题下方显示 `首 token 延迟 <时长> · 生成 <时长> · 输出速度 <速率> tok/s`：

- **首 token 延迟：** `totalTtftMs / timedRequests`。
- **生成：** `totalGenerationDurationMs / timedRequests`。它与首 token 延迟使用同一个分母，因此两者相加就是这些计时请求到最后一个可见块为止的平均延迟。
- **输出速度：** 按 token 加权，即 `totalThroughputOutputTokens / totalGenerationDurationMs`。
- **缺项时：** 没有任何请求产生生成窗口时，不显示生成和输出速度。没有计时数据的模型不显示这一行。
- **标题不变：** 标题中的平均延迟仍统计所有请求，包括失败、内部和非流式请求，因此可能与这一行前两项之和不同。

## 兼容性

- 所有新字段都是可选的增量字段。旧 transcript 回放时使用回退窗口。
- OpenAI 兼容和 Anthropic provider 的纯工具调用响应，记录的 TTFT 会变短、生成时间会变长。CLI `/stats` 中的 TPS 也会相应变化。
- 通过 `restoreSessionModelMetrics` 恢复的 managed 会话不会恢复按模型的计时。会话级生成指标目前也是如此。

## 范围之外

- 分位数。目前只保留总和与次数。
- CLI `/stats` 和 Web Shell `/stats` 卡片中的按模型计时。
- 单独的首个 chunk TTFT。`gen_ai.response.time_to_first_chunk` 仍只作为 span 属性。
- 延迟行之外的面板布局调整。#14648 正在重新设计该面板。

## 验证

- **Core：**
  - 只携带 preparation 的块计为可见。
  - 纯工具调用的流在 preparation 处记录 TTFT，`generation_ms` 一直计到完整的工具调用。
  - 只有一个可见块时记录 `generation_ms = 0`。
  - `UiTelemetryService` 优先使用 `generation_ms`，缺失时回退。按模型的汇总只写入 `statsModels`，并排除内部 prompt。
- **CLI：** stats 扩展方法返回按模型的 generation，不包含 `last` 样本；没有计时请求的模型不返回该字段。
- **Web Shell：** 延迟行在中英文下都能正确显示。生成时间与首 token 延迟使用同一个分母。没有生成窗口时省略生成和输出速度，没有计时数据的模型不显示这一行。
- **E2E：** 在关闭思考的 OpenAI 兼容模型上运行真实的 daemon 会话。对比改动前后纯工具调用回合记录的 TTFT，并检查面板显示。
