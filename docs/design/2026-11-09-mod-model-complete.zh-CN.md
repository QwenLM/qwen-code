# Mod 模型调用

[English](2026-11-09-mod-model-complete.md) | [简体中文](2026-11-09-mod-model-complete.zh-CN.md)

状态：提议中。本文新增 `$.model.complete`，这是 `$.model` 的第一个方法，在 #13749 跟踪。契约以 Claude Code 2.1.319 的插件 API 声明为准。

## 问题与现状

Mod 没法向模型提问。它的 hook 能读取、改写流经会话的内容，但要做摘要、分类或翻译，就需要自己发起一次补全。Claude Code 为此给 Mod 提供了 `$.model.complete`：在会话自己的客户端上跑一次文本补全，不带工具，也不带历史。

在 Qwen Code 里，`$.model` 是未知的：调用会以 `Mod API not supported: $.model.complete` 拒绝，`model.complete` 上的 hook 能加载但从不运行。

驱动场景是一个把英文回复显示成中文的 Mod：它需要对每个回复块做一次补全，后续阶段再补上它用来绘制的消息渲染站点。

## 目标与非目标

目标：

- 在 headless 运行和两种终端里提供 `$.model.complete(request, {signal})`，请求字段和结果形状与 Claude Code 一致。
- `model.complete` 作为 API 事件，其他 Mod 的 hook 可以改写、代答或拒绝。
- 模型调用不会让发起它的 hook 或所在 dispatch 超时。

非目标：

- `$.model.classify` 和 `$.model.fork`。
- 把指定的 `effort` 级别或 `cache` 标记发给 provider。
- 比发起它的 dispatch 活得更久的模型调用，或在其他 Mod dispatch 运行时并行的调用。两者都需要尚不存在的能力（定时器、并发 dispatch）。
- ACP 会话，它目前不加载 Mod。

## 方案

### 1. 请求与事件

guest 的 `$.model.complete(request, options)` 检查 `options`（只接受 `signal`），然后带上每次调用的 token 发出请求。worker 把请求转换成 Claude Code 的 `ModelCompleteInput`：块列表拼接成 `prompt` 或 `system`，原样保留在旁边的 `promptBlocks` 或 `systemBlocks` 里。形状错误、`maxTokens` 超过 64000、未知的 `effort`、`timeoutMs` 不在 1 到 2147483647 之间，都会在任何 hook 运行前拒绝。

之后输入像其他 API 事件一样，依次经过每个插件的 `model.complete` hook。hook 可以把改写后的输入往下传、回答 `{value: result}`，或返回 `{deny: reason}`。改写后的输入会再次校验；`system: null` 或 `false` 表示不发系统提示。到链的最底层，worker 请宿主执行调用。

### 2. 执行调用

worker 向主线程发送 `model-complete {id, input}`，等待 `model-result {id, result | error}`。宿主运行 CLI 的 `completeModModel`：

- 模型名：`haiku` 使用已配置的 fast model，其选择器按配置原样传递，以保留它固定的 endpoint；没有设置 fast model 时用会话模型。`sonnet` 和 `opus` 映射到 `inherit`。其他名字经 `resolveModelId` 解析，必须是会话模型，或已配置且支持文本的模型。否则 `BaseLlmClient` 会把未知 id 静默发给会话模型。
- `maxTokens` 默认 1024，超过已知的输出上限时拒绝。
- `BaseLlmClient.generateText` 把 prompt 作为唯一一条用户消息发送，`system` 作为系统指令，`maxAttempts: 1`、`failClosed: true`。除非请求指定了 `effort`，否则关闭推理。
- 回复为空时结果是 `empty-reply`。失败时是 `api-error`，带 HTTP 状态码，以及由共用的 `classifyApiError` 给出的错误类别，另加 `overloaded` 和 `model_not_found`。中止或 `timeoutMs` 到期时是 `aborted`。
- `usage` 使用与 `turn.complete` 相同的四项计数换算，这段换算现在是共用的。
- 回复超过 Mod 载荷的一半时，只保留首尾，中间用标记替代。

### 3. 信号与生命周期

guest 通过 token 转发自己的 `signal`：中止时发出内部的 `model.abort`，任何 hook 都听不到。worker 中止该调用的 controller，通知宿主取消，并立即以 `aborted` 返回。如果 signal 在调用前就已中止，直接返回 `aborted`，不发请求。

调用属于发起它的 dispatch。dispatch 被放弃或结束时，worker 取消宿主操作，宿主中止该根上仍在运行的所有调用。

### 4. 预算

hook 自己的预算在 `$` 调用期间本来就会暂停。dispatch 的 60 秒上限此前只在原生工具执行时暂停。现在，当没有 guest 代码、检查或其他宿主调用在运行时，worker 会把正在进行的模型调用报告为它在等待的操作；只要这个操作是该根的模型调用，宿主就暂停根的计时，与原生工具完全相同。

## 设计决策

- 模型调用放在 CLI 而不是 core：它需要 `Config`、`BaseLlmClient` 和 CLI 的错误分类器，ACP 宿主以后也从这里复用。
- 未知的模型 id 直接拒绝，不透传，因为客户端会静默退回会话模型，以另一个模型的身份计费和回答。
- 推理默认关闭，与 Qwen Code 所有的旁路请求一致；需要推理的 Mod 用 `effort` 声明。
- 只尝试一次，避免 Mod 的调用在重试循环里一直占着会话唯一的 dispatch 位置；结果里带有 Mod 自行重试所需的信息。

## 与 Claude Code 的差异

- `haiku`、`sonnet`、`opus` 被解读为 Qwen Code 的 fast model 和会话模型。
- `effort` 会打开推理，但不发送级别；Claude Code 会发送级别。
- 接受 `cache` 标记但不发送。
- Claude Code 默认使用模型自己的推理设置；Qwen Code 默认关闭。
- 一个会话同一时间只运行一个 Mod dispatch，所以调用进行时，会话里其他所有 Mod hook 都要等待。Claude Code 把后台工作放在定时器上运行；Qwen Code 还没有定时器。

## 验证与验收

core 运行时测试，使用真实的 QuickJS worker：

- 带块的请求到达宿主时已拼接，块保留在旁边，各种结果形状都能返回。
- 错误形状、超限和宿主拒绝都会 reject；不支持模型调用的宿主会 reject，`$.session.version()` 只在宿主支持时列出 `model.complete`。
- 另一个插件可以改写、代答和拒绝 `model.complete`。
- 中止的 `signal` 会切断进行中的调用，并跳过新的调用。
- 宿主执行调用期间，dispatch 计时暂停。

`completeModModel` 的 CLI 单元测试：别名和 id 解析、发出的请求、输出上限拒绝，以及空回复、API 错误、超时三种结果。

验收：一个调用 `$.model.complete({model: 'haiku', prompt})` 的 Mod 命令，在 headless 运行和两种终端里都能打印出 fast model 的回答。

## 风险与待定问题

- 调用进行时，其他 Mod 的 `tool.call` hook 要等待。并发 dispatch 是单独的阶段。
- 翻译类 Mod 会对每个消息块调用一次模型；成本只能从 `usage` 看到。
- `effort` 是否应该像子代理那样构建专用的 generator 视图，以便发送级别。
