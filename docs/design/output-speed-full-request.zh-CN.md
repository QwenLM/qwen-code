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

单个请求的输出速度为 `outputTokens / (ttftMs + generationMs)`，即输出 token 数除以从发出请求到最后一个可见输出的时间。按会话或模型汇总时，取按 token 加权的比值 `totalOutputSpeedTokens / totalOutputSpeedDurationMs`，其中 `totalOutputSpeedDurationMs` 是被计入 token 的那些请求的 TTFT 加生成时间之和。请求之间的工具执行时间不属于任何请求，所以多轮会话的速度不包含它。

这与 Artificial Analysis 在方法论 3.0.0 版（2026-11-03）中采用的公开定义一致：输出 token（含推理）除以请求的完整耗时，包含首 token 等待；多轮任务中不计请求之间的工具执行时间。终点取最后一个可见块，而不是流结束：之后到达的 usage 块不含输出；生成计时设计的 D2 也已经在这里结束窗口，以免把消费方的处理时间计入。

### D2 — 去掉 100 ms 门槛

分母包含 TTFT 后，集中到达的输出不会再把单个请求的时间压到零，所以输出速度计入每个计时请求。可见输出只有一个块的响应（`generation_ms = 0`）现在也有速度：输出 token 数除以 TTFT。`totalTimedGenerationDurationMs` 与 `totalTtftMs` 一样累计每个计时请求的生成窗口，两者覆盖同一批请求。

`totalGenerationDurationMs` 和 `totalThroughputOutputTokens` 保持原有含义：不小于 100 ms 的窗口的生成时间和输出 token 数。本次修改之前发布的客户端用后者除以前者。如果去掉门槛，单块响应较多的会话会被这个除法算成每秒上千 token。

### D3 — 没有输出 token 的请求没有速度

没有报告输出 token 的计时请求（例如服务商没有返回 usage）仍计入 TTFT 和生成时间，但不计入 `totalOutputSpeedTokens` 和 `totalOutputSpeedDurationMs`，因为它只增加时间、不增加 token，会拉低速度。请求或总和中没有输出 token，或没有记录到时间时，各界面不显示速度，而不是显示 `0 tok/s`。

### D4 — 推理 token 只计一次

输出速度中的推理 token 只计一次，规则与计费输出相同。OpenAI 兼容服务商和 Qwen OAuth 的输出数已包含推理；Gemini 则单独报告推理：`candidatesTokenCount` 不含 `thoughtsTokenCount`。上报的总数符合任一约定时，以总数为准。如果没有这条规则，Gemini 思考模型的推理时间进了分母，推理 token 却没进分子：先用 8 秒生成 800 个不可见的推理 token，再用 2 秒输出 200 个 token，读数会是 20 tok/s，而不是约 100。最近一次请求的 `outputTokens` 和 `timingSamples[].outputTokens` 使用同样的计数。

### D5 — 涉及的界面

- **CLI `/stats`：** 最近一次请求的 TPS 和 Session TPS，覆盖 Ink 标签页、OpenTUI 对话框和文本输出。三处共用一个辅助函数计算；Generation Time 一行仍显示生成窗口。
- **Web Shell Token Usage：** 总览中的会话输出速度和每个模型的输出速度都按 D1 计算。每个模型的“生成”平均值是 `totalTimedGenerationDurationMs` 除以 `timedRequests`，与“首 token”覆盖同一批请求，两者相加正好是这些计时请求到最后一个可见输出的平均时间。只要模型有速度或有任何生成时间就显示它，所以请求没有返回 usage 的模型也会显示。面板和趋势图共用一个速度辅助函数。
- **速度趋势图和按模型的分布：** 每个样本的速度按 D1 计算，因此生成窗口很短的样本也会出现在速度视图中。提示框里的“输出 N token，耗时 D”使用同一时间，即 TTFT 加生成时间。
- **线上类型：** daemon stats 路由中每个模型的 `generation` 新增三个可选字段：`totalTimedGenerationDurationMs`、`totalOutputSpeedTokens` 和 `totalOutputSpeedDurationMs`。`totalGenerationDurationMs`、`totalThroughputOutputTokens` 和 `timingSamples[].generationMs` 的名称、结构和含义都不变。

## 兼容性

- 新字段在线上都是可选的，没有删除、重命名或重新定义字段，所以本次修改之前发布的客户端读取新 daemon 时，显示的仍是同样的生成窗口速度。恢复会话时会按新规则重放事件。
- `timingSamples[].outputTokens` 现在推理 token 只计一次（D4）。OpenAI 兼容服务商和 Qwen OAuth 的值不变；Gemini 的值现在包含推理 token。
- Web Shell 读取旧版 daemon 时拿不到任何新字段。旧 daemon 的几个总和覆盖的请求不同（TTFT 覆盖所有计时请求，token 和生成时间只覆盖不小于 100 ms 的窗口），它们唯一能支持的是旧 daemon 自己的速度：`totalThroughputOutputTokens / totalGenerationDurationMs`。在 daemon 升级之前，Web Shell 在总览和模型卡片上显示这个速度；趋势图和按模型的分布也使用同一规则，即 token 除以不小于 100 ms 的生成窗口，所以同一个面板只有一种速度定义。同一次 status 中的所有模型都来自同一个 daemon，只要有一个模型缺少这些字段，就对所有模型使用旧规则。
- 所有输出速度读数都会比之前低。prompt 较长时，以及服务商隐藏推理文本时，差距更大。
- TTFT 从发起请求时开始计时，因此本来就包含流打开之前发生的 SDK 重试。现在这类重试也会拉低该请求的输出速度，与客户端对整次调用计时的结果一致。

## 不在范围内

- spinner 旁的实时 tokens/s 估算（`ui.showResponseTokensPerSecond`）。它是基于字符数、按整轮时间（含工具执行）计算的估算值。
- managed 诊断面板。它按模型持久化的计时计数器是一个有版本的契约（TypeScript、Java 和 OpenAPI），仍保留 100 ms 门槛；对齐需要单独修改契约。
- 百分位数，以及按轮次类型（纯文本与工具调用）分开统计速度。

## 验证

- **Core：** `totalTtftMs` 和 `totalTimedGenerationDurationMs` 包含所有计时请求，包括很短的窗口和零窗口；输出速度相关总和不含没有输出 token 的请求，推理 token 只计一次；`totalGenerationDurationMs` 和 `totalThroughputOutputTokens` 仍不含小于 100 ms 的窗口。它们都仍按模型记录在 `statsModels` 中。
- **CLI：** 辅助函数用 TTFT 加生成时间作分母，单块响应也有速度，没有 token 或时间时不返回速度。`/stats` 文本输出和 Ink 标签页显示新的值。
- **Web Shell：** 模型网格和总览按 D1 计算；daemon 没有新字段时，卡片、总览、趋势图和分布都使用按生成窗口计算的速度。趋势图在速度视图中绘制短窗口样本，提示框的耗时包含 TTFT。计时请求都没有报告 token 的模型显示“生成”平均值，不显示速度。
- **实测：** 对 Token Plan 跑一个 headless 会话并输出本地遥测，把 `/stats` 的读数与从记录事件算出的“输出 token ÷ 从发出请求到最后一个可见块的时间”相比较。
