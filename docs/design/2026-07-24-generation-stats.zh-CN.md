# `/stats` 中的生成时序指标

[English](2026-07-24-generation-stats.md) | [简体中文](2026-07-24-generation-stats.zh-CN.md)

> 后续的 GenAI 对齐在既有私有 `ttft_ms` 之外增加了独立的
> `gen_ai.response.time_to_first_chunk` Span 属性。本文档的
> `ApiResponseEvent.ttft_ms` 数据流与"首个用户可见输出"语义保持不变；
> `/stats` 不消费该标准首块属性。
>
> [全请求输出速度](output-speed-full-request.md)（#16714）后续修订了
> TPS：它用输出 token 数除以 TTFT 加生成时间，因此零生成时长也有速率。
> 下文的 TPS 规则描述的是本设计面向 #4252 实现时的形态。

## 背景

Issue #4252 要求 `/stats` 把生成时序与会话墙钟时间、端到端 API 延迟区分
展示。底层时序已经存在：

- `LoggingContentGenerator` 从请求派发到首个用户可见流式分块测量
  `ttftMs`。
- `endLLMRequestSpan` 派生 `sampling_ms` 与 `output_tokens_per_second`。
- `ApiResponseEvent` 已把请求时长、模型、prompt id 与输出 token 数带入
  `UiTelemetryService`。

缺的一环是让既有的 TTFT 值对 `/stats` 所用的无内容会话指标可见。

## 范围

本变更为以下位置增加会话级实时生成指标：

- 交互式 `/stats` 的 Session 标签页；
- 非交互式 `/stats` 的文本响应。

它不新增第二个计时器、不把时序持久化进按日/按月 token 用量文件、不改变
导出，也不改变 daemon/Web Shell 的 stats 模式。

## 数据流

```text
LoggingContentGenerator.loggingStreamWrapper
  -> ApiResponseEvent(ttft_ms)
  -> logApiResponse
  -> UiTelemetryService
  -> SessionMetrics.generation
  -> SessionContext
  -> /stats
```

`ttft_ms` 是可选的。非流式响应与没有产生用户可见内容的流保持当前行为，
不创建生成样本。

## 指标与语义

对每个带 TTFT 的成功流式响应：

- **TTFT** 是既有的 `ttftMs` 测量值。
- **生成时间** 是 `max(0, duration_ms - ttft_ms)`，从首个用户可见流式
  内容起量到完成。
- **TPS** 是 `output_token_count / generation_time_seconds`。生成时间为零
  时不可用。

`SessionMetrics.generation` 惰性创建，包含：

- 最近一次完成请求的模型、TTFT、生成时间与输出 token 数；
- 计时请求总数与 TTFT 总量，以及吞吐合格请求的生成时间与输出 token
  总量。

会话平均 TTFT 是计时请求的算术平均。会话 TPS 是加权吞吐：输出 token
总量除以生成时间总量。生成时间为零的请求计入 TTFT 统计，但不计入会话
TPS 计算的任一侧。这避免了除零与短请求的过度加权。

内部辅助 prompt 不计入生成指标。它们不记录进可恢复 transcript，计入
既会让用户意外，也会让实时与恢复会话的数值不一致。主会话与子代理请求
保持计入，与既有会话级模型统计一致。

## 兼容性

- `ApiResponseEvent.ttft_ms` 与 `SessionMetrics.generation` 是纯增量且
  可选的。
- 既有的已记录事件与调用方保持有效。
- 既有的按日/按月记录继续只含 token 与 API 时长数据，保持
  `issue-4479-token-usage-stats-coordination.md` 记录的所有权边界。
- Session 上下文的克隆/相等逻辑会复制并比较这个可选的 generation 对象，
  使交互式仪表盘在每次完成的计时请求后刷新。

## 验证

- Core 测试证明聚合、内部 prompt 排除、零生成时长处理、会话隔离与重置
  行为。
- LoggingContentGenerator 测试证明捕获的 TTFT 到达 `ApiResponseEvent`，
  且对无可见内容的流保持缺失。
- CLI 测试证明非交互式输出与交互式 Session 标签页渲染。
- i18n 测试覆盖所有内置语言的新高可见度标签。
