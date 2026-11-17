# Mod 回合事件

[English](2026-10-24-mod-turn-events.md) | [简体中文](2026-10-24-mod-turn-events.zh-CN.md)

状态：提议中。本阶段接在 #15348 的会话信息之后，由 #13749 跟踪。本文以 Claude Code 2.1.309 插件 API 中 `turn.start`、`turn.complete` 和 `$.turn.abort` 的声明为准，它们自 2.1.308 以来没有变化。

## 问题与现状

为 Claude Code 编写的 Mod 会跟随会话的回合：

- Token Weather 是标志第一个里程碑的示例，它在 `turn.complete` hook 里读取 `$.session.usage()`，在每个回合之后把上下文窗口的占用画成图表。
- Mod 从 `turn.complete` 返回 `{ text }`，在答案下方显示一行文字，例如摘要。
- 守卫类 Mod 的某个 hook 判断回合必须停止时，用 `$.turn.abort` 结束正在进行的回合。

Qwen Code 在加载时跳过这些 hook，并提示 `Hooks for unsupported events will not run: turn.complete, turn.start`。`$.turn.abort` 会抛出 `Mod API not supported`。

## 目标与非目标

目标：

- 在 headless 运行以及 Ink 和 OpenTUI 终端里，为主循环的回合运行 `turn.start` 和 `turn.complete`，结构与 Claude Code 相同。
- 让 Mod 能用 `$.turn.abort` 结束正在进行的回合。
- 把 `turn.complete` hook 返回的文字显示在答案下方。

非目标：

- 子代理和队友的回合。Claude Code 用 `agentId` 标出它们，这部分随子代理支持一起做。
- `turn.step`，即流式的模型请求。
- `$.prompt.submit`。Claude Code 在 `$.turn.abort` 之后用它发送下一条提示。
- 主循环自己发起的回合：定时提示、后台通知、队友消息和目标续行。

## 提议的改动

### 1. 什么是一个回合

主循环发出一条提示时，回合开始。模型不再调用工具而给出回答、回合被取消或者失败时，回合结束。工具结果和 Stop hook 引发的续行，都属于它们所延续的那个回合。

回合事件覆盖由人提交的提示：

- 输入或通过管道传入的提示，以及命令提交的提示；
- 用 Ctrl+Y 重试上一条提示，以及 headless 模式下续行一个被中断的回合。这两种回合没有输入的提示，`$.session.turns()` 也不计入它们，因为会话记录不会为它们新增用户回合。

### 2. `turn.start`

`turn.start` 在提示被放行时触发，即 UserPromptSubmit 放行之后、第一次模型请求之前。被 hook 拦下的提示不形成回合。输入为：

- `text`：人提交的提示，粘贴的内容已展开；重试和续行时为 `""`。
- `turnId`：新生成的 id，本回合的 `turn.complete` 带同一个 id。
- `isTextTruncated`：提示太长、超出一次 Mod 传输的上限时为 `true`。这样的提示保留开头和结尾，中间换成一行 `[... truncated for Mods ...]`，按 JSON 计不超过 128 KiB，hook 照常运行。其他情况下没有这个字段。

模型请求不等待这些 hook。本回合的 `tool.call` 派发和 `turn.complete` 都排在它们后面，所以听到开始的 hook 一定在之后听到结束。取消回合时，仍在运行的 `turn.start` hook 也随之结束，与 Claude Code 相同，本回合的工具调用不必等它们。输入字段是固定的，hook 的返回值不会改变任何东西。

### 3. `turn.complete`

`turn.complete` 在回合结束时触发一次。会话关闭（例如 `/quit`）时，其他 hook 会被立即取消，回合的结束事件不会：已经在运行的 `turn.complete`、仍在排队的每一个，以及仍在进行、以 `aborted` 结束的回合的结束事件，都会在 `session.end` 之前按顺序运行，共用一个与 `session.end` 等长的时限。输入为：

- `answer`：本回合最后一次模型响应的可见文字，去掉首尾空白；没有时为 `""`。流式输出过程中被取消时，是已经收到的文字。
- `durationMs`：回合耗时。
- `isAborted` 和 `reason`：
  - 人或 Mod 取消了回合时为 `aborted`；
  - API 错误、循环检测或会话上限结束了回合时为 `error`；
  - 其他情况为 `answer`。
  - 不会出现 `refusal`。
- `turnId`。
- `usage`：本回合各次模型响应的四项 API token 计数之和，以及最后一次响应的模型；没有响应完成时没有这个字段。子代理、辅助查询和上下文压缩发出的请求不计入。
- `isAnswerTruncated`：答案像长提示那样被截断时为 `true`。

hook 返回的 `{ text }` 与答案不同且不是空白时，这段文字显示在答案下方，署名为挂了 `turn.complete` hook 的插件：

- 终端里是一行记录 `[Mod <plugins>] <text>`；
- headless 文本模式下是 stderr 上的同一行，位于答案之后；
- JSON 模式下是 result 之前的一条 `system` `ui_log` 消息。

文字最多保留 4,096 个字符，会话记录本身不做修改。hook 原样返回它收到的答案时（无论是否截断过），不会多出这一行。

终端里，这些 hook 在回合结束后运行，此时下一条提示已经可以开始。headless 运行会等它们跑完再输出结果。

### 4. `$.turn.abort`

`$.turn.abort({ turnId })` 像取消操作一样结束正在进行的回合和其中正在运行的工具，但不留下"Request cancelled."之类的取消提示，也不把提示放回输入框。之后排队的提示照常运行。

以下情况调用会被拒绝：没有回合在运行；`turnId` 不是正在运行的回合；回合已经在结束中。它和其他 `$` 方法一样是 API 事件，其他插件可以观察、改写或拒绝。

如果人也按了 Esc，不论在 Mod 调用之前还是之后，回合都按人的取消结束，和没有 Mod 时一样。

在 headless 运行中，回合以错误结果"A Mod ended the turn."结束，退出码为 130，与被中断的回合相同。stream-json 会话会继续处理下一条消息。

## 设计决策

- **放行信号来自 core。** UserPromptSubmit 在客户端的发送过程中运行，此时宿主已经交出了提示。`sendMessageStream` 新增 `onPromptAdmitted` 选项，在提示被放行时通知三个宿主，所以被拦下的提示永远不会开始回合。宿主本来就用同样的方式为单次发送传入回调。
- **回合读取自己的流。** 每个宿主把本回合各次模型流的全部事件交给回合对象。答案、失败和用量都从这些事件得出，所以各宿主的报告方式一致。headless 的两条循环都是如此：当前的循环，以及 `experimental.unifiedAgentLoop` 下的共享 agent 循环。
  - 用量由每次响应的结束事件累加而来，所以只计入本回合自己的请求。
  - 模型取自会话对每次 API 响应的记录。
- **`turn.start` 不阻塞请求。** Claude Code 不会为这些 hook 推迟模型请求。把本回合之后的派发排在开始之后，既保证了顺序，又不增加延迟。
- **Ink 在流回到空闲时结束回合。** Ink 结束回合的路径很多，而空闲是每条路径都会到达的状态。取消和失败的路径在途中记下原因。
- **说明文字走 Mod 记录日志的同一通道**，不需要新的输出通道。
- **由宿主判定 `$.turn.abort`。** worker 去问掌握当前回合的宿主，再把宿主的判定作为调用结果返回。

## 与 Claude Code 的差异

这些差异会写进用户指南：

- 回合事件只覆盖主循环，而且只覆盖由人提交的提示，不会出现 `agentId`。
- `reason` 不会是 `refusal`。
- `usage.cache_creation_input_tokens` 为 0，除非 provider 单独报告缓存写入（Anthropic 会报告）。
- 按 JSON 计超过 128 KiB 的提示或答案，截断后才交给 hook，并带上 `isTextTruncated` 或 `isAnswerTruncated`。Claude Code 会完整传入。
- headless 文本模式下，说明文字输出到 stderr。
- 还没有 `$.prompt.submit`，所以 Mod 不能在 `$.turn.abort` 之后发送提示。

## 验证与验收

- 真实 QuickJS worker 测试：
  - 哪些插件能收到回合事件；
  - 固定的输入；
  - `{ text }` 结果和结构不对的结果；
  - 截断到会话所允许长度的提示和答案；
  - `$.turn.abort` 询问宿主、各种拒绝，以及其他插件拒绝或改写它；
  - 宿主始终不回复的 `$.turn.abort`，由 dispatch 结束时收尾。
- 客户端测试：`onPromptAdmitted` 在放行之后、请求之前调用，一次自行续发的发送只调用一次，被拦下的提示不会调用。
- Mod 会话测试：
  - `turn.start` 与回合并行，结束排在本回合的工具之后；
  - 取消回合会结束它的 `turn.start` hook，但不影响 `turn.complete` hook；
  - 重试、取消以及 MAX_TOKENS 之后续写时的答案；
  - 结束原因；
  - 用量累加，各 provider 的推理 token 只计一次，总数自洽时以总数为准，不是整数计数的用量，以及只取本回合提示的模型；
  - 超出 Mod 传输上限的提示和答案；
  - 说明文字，截断时不拆开字符，终端里保留到 4,096 个字符，文本模式下写在答案之后，退出结束的回合也是如此；
  - `$.turn.abort` 的判定规则，以及宿主取消失败后的再次请求；
  - hook 失败；
  - 所属会话已经结束的回合；
  - 会话关闭时仍在进行的回合、被关闭抢先的结束事件、关闭时已在运行的结束事件、按顺序运行的每个排队中的结束事件，以及限制它们的时限。
- 宿主测试：
  - headless，在当前循环和共享 agent 循环上各跑一遍：正常回答、结构化输出的回答、被拦下的提示、续行被中断的回合、JSON 和文本模式下的 Mod 中止、在 `tool.call` hook 里中止、工具结束 Goal 回合后再续行、检测到循环的回合在 Mod 关闭前结束、请求失败；
  - Ink：从放行到空闲的回合、Mod 中止与 Esc 的对比、重试在放行渲染之前被 Mod 中止、Esc 之后的 Mod 中止不会结束仍在运行的旁路提问（`?btw`）、不经 Esc 的取消、在后续轮次取消时结束 `turn.start` hook、工具被取消或无法继续的回合、续行失败、等待 Mod 启动的 slash 命令、丢失输入框来源的提示与重试、没有 Mod 时不传回调；
  - OpenTUI：放行和只结束一次、中断和出错、Mod 中止后排队提示继续运行、Esc 在 Mod 中止之前或之后、工具全部被拒绝的回合、没有输入提示的重试、没有 Mod 时不传回调。
- 用构建出的 CLI 连接测试用的服务器，在 headless JSON 和文本模式以及 Ink 和 OpenTUI 终端里验证：
  - `turn.start` 的文字；
  - `turn.complete` 的答案，以及与服务器计数一致的用量；
  - 答案下方的说明文字；
  - 带工具调用的回合；
  - Esc；
  - Mod 在 `tool.call` hook 里结束自己的回合。

## 风险与待定问题

- Ink 在流回到空闲时结束回合。如果某条路径让流一直处于忙碌状态，`turn.complete` 会推迟到它空闲为止。下一条被放行的提示会先结束任何未结束的回合。
- 终端里，`turn.complete` hook 在答案之后运行。慢的 hook 最多让下一回合的工具中间件推迟一个预算的时长。
