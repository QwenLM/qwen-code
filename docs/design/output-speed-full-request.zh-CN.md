# 按完整请求时间计算输出速度

[English](output-speed-full-request.md) | [简体中文](output-speed-full-request.zh-CN.md)

## 状态与范围

已为 #16714 实现。本次修改 CLI `/stats` 和 Web Shell Token Usage 计算输出速度（TPS）的方式，TTFT、生成时间和记录的事件保持不变。它修订了[按模型的生成计时](model-generation-timing.zh-CN.md)中关于输出速度的规则（D2、D5），以及[Token 用量趋势](token-usage-trend.zh-CN.md)的速度视图。spinner 旁的实时 tokens/s 估算和 managed 诊断面板不在范围内。

## 问题

1. 输出速度用请求的输出 token 数除以生成窗口，即第一个到最后一个可见块之间的时间。输出 token 包含推理 token，但第一个可见块之前的时间不在分母里，所以读数高于用户实际等待感受到的速度。在百炼 Token Plan 上实测，deepseek-v4.1-flash 纯文本读数为 143 tok/s，而用输出 token 除以从发出请求到最后一个 token 的时间只有 125；只调工具的轮次读数为 212，实际为 195。prompt 越长，TTFT 越长，差距越大。
2. 有的服务商对推理 token 计费，却不推送推理文本。这些 token 在第一个可见块之前生成，于是进了分子，对应的时间却没进分母。用一个 mock 服务商测试：先用 8 秒生成 800 个不可见的推理 token，再用 2 秒输出 200 个回答 token，`/stats` 读数为 511 tok/s，实际约 100。
3. 可见输出集中到达时窗口会趋近于零，所以 D2 只能把小于 100 ms 的窗口排除在输出速度之外。这些请求仍计入 TTFT，导致 TTFT 和生成时间两个总和覆盖的请求不一致，Token Usage 里每个模型的首 token 平均值和生成平均值相加对不上。

## 设计

### D1 — 输出速度包含 TTFT

单个请求的输出速度为 `outputTokens / (ttftMs + generationMs)`，即输出 token 数除以从发出请求到最后一个可见输出的时间。按会话或模型汇总时，取按 token 加权的比值 `totalThroughputOutputTokens / totalThroughputDurationMs`，其中 `totalThroughputDurationMs` 是被计入 token 的那些请求的 TTFT 加生成时间之和。请求之间的工具执行时间不属于任何请求，所以多轮会话的速度不包含它。

这与 Artificial Analysis 在方法论 3.0.0 版（2026-11-03）中采用的公开定义一致：输出 token（含推理）除以请求的完整耗时，包含首 token 等待；多轮任务中不计请求之间的工具执行时间。终点取最后一个可见块，而不是流结束：之后到达的 usage 块不含输出；生成计时设计的 D2 也已经在这里结束窗口，以免把消费方的处理时间计入。

### D2 — 去掉 100 ms 门槛

`UiTelemetryService` 把每个计时请求的 TTFT 和生成窗口加入 `totalTtftMs` 和 `totalGenerationDurationMs`，不再有 100 ms 门槛。分母包含 TTFT 后，集中到达的输出不会再把单个请求的时间压到零。可见输出只有一个块的响应（`generation_ms = 0`）现在也有速度：输出 token 数除以 TTFT。

### D3 — 没有输出 token 的请求没有速度

没有报告输出 token 的计时请求（例如服务商没有返回 usage）仍计入 TTFT 和生成时间，但不计入 `totalThroughputOutputTokens` 和 `totalThroughputDurationMs`，因为它只增加时间、不增加 token，会拉低速度。请求或总和中没有输出 token，或没有记录到时间时，各界面不显示速度，而不是显示 `0 tok/s`。

### D4 — 涉及的界面

- **CLI `/stats`：** 最近一次请求的 TPS 和 Session TPS，覆盖 Ink 标签页、OpenTUI 对话框和文本输出。三处共用一个辅助函数计算；Generation Time 一行仍显示生成窗口。
- **Web Shell Token Usage：** 总览中的会话输出速度和每个模型的输出速度都按 D1 计算。每个模型的“生成”平均值仍是 `totalGenerationDurationMs` 除以 `timedRequests`；去掉门槛后，它与“首 token”覆盖同一批请求，两者相加正好是这些计时请求到最后一个可见输出的平均时间。面板和趋势图共用一个速度辅助函数。
- **速度趋势图和按模型的分布：** 每个样本的速度按 D1 计算，因此生成窗口很短的样本也会出现在速度视图中。提示框里的“输出 N token，耗时 D”使用同一时间，即 TTFT 加生成时间。
- **线上类型：** daemon stats 路由中每个模型的 `generation` 新增可选字段 `totalThroughputDurationMs`。`totalGenerationDurationMs`、`totalThroughputOutputTokens` 和 `timingSamples[].generationMs` 名称和结构不变，注释改为描述新规则。

## 兼容性

- 唯一的新字段 `totalThroughputDurationMs` 在线上是可选的，没有删除或重命名字段。恢复会话时会按新规则重放事件。
- Web Shell 读取旧版 daemon 时拿不到 `totalThroughputDurationMs`。旧 daemon 的几个总和覆盖的请求不同（TTFT 覆盖所有计时请求，token 和生成时间只覆盖不小于 100 ms 的窗口），它们唯一能支持的是旧 daemon 自己的速度：`totalThroughputOutputTokens / totalGenerationDurationMs`。在 daemon 升级之前，Web Shell 显示这个速度。
- 所有输出速度读数都会比之前低。prompt 较长时，以及服务商隐藏推理文本时，差距更大。
- TTFT 从发起请求时开始计时，因此本来就包含流打开之前发生的 SDK 重试。现在这类重试也会拉低该请求的输出速度，与客户端对整次调用计时的结果一致。

## 不在范围内

- spinner 旁的实时 tokens/s 估算（`ui.showResponseTokensPerSecond`）。它是基于字符数、按整轮时间（含工具执行）计算的估算值。
- managed 诊断面板。它按模型持久化的计时计数器是一个有版本的契约（TypeScript、Java 和 OpenAPI），仍保留 100 ms 门槛；对齐需要单独修改契约。
- 百分位数，以及按轮次类型（纯文本与工具调用）分开统计速度。

## 验证

- **Core：** TTFT 和生成时间的总和包含所有计时请求，包括很短的窗口和零窗口；吞吐相关总和不含没有输出 token 的请求。它们都仍按模型记录在 `statsModels` 中。
- **CLI：** 辅助函数用 TTFT 加生成时间作分母，单块响应也有速度，没有 token 或时间时不返回速度。`/stats` 文本输出和 Ink 标签页显示新的值。
- **Web Shell：** 模型网格和总览按 D1 计算，daemon 没有 `totalThroughputDurationMs` 时回退到按生成窗口计算的速度；趋势图在速度视图中绘制短窗口样本，提示框的耗时包含 TTFT；按模型的分布使用同样的速度。
- **实测：** 对 Token Plan 跑一个 headless 会话并输出本地遥测，把 `/stats` 的读数与从记录事件算出的“输出 token ÷ 从发出请求到最后一个可见块的时间”相比较。
