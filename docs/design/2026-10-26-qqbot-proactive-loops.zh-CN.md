# QQ Bot 定时 loop 与无人值守结果的主动投递

[English](2026-10-26-qqbot-proactive-loops.md) | [简体中文](2026-10-26-qqbot-proactive-loops.zh-CN.md)

- 状态：本次改动已实现
- 日期：2026-10-26
- 范围：`packages/channels/qqbot`、`packages/channels/base`、
  `packages/cli`（渠道 loop controller）

## 问题

QQ 适配器此前报告 `supportsProactiveSend() === false`（base 的默认值），因此
QQ 上所有无人值守的投递路径都不可用：定时渠道 loop、webhook 任务、
background 与 named-task 回复，以及 daemon 主动投递。平台本身支持主动群消息，
所以这不是能力缺失，而是从未声明。

声明该能力同时会激活一批需要明确语义的路径：无人值守结果由谁恰好投递一次、
哪些失败是永久失败，以及当一个会话再也收不到主动消息时，该会话的 loop 应如何
处理。

## 能力开关翻转及其激活的 base 调用点

`QQChannel` 覆写 `supportsProactiveSend()` 返回 `true`。四个 base 调用点的行为
随之改变：

- **渠道 loop** —— `ChannelBase.runLoopPrompt()` 在没有该能力时拒绝启动，并在
  结束时通过 `pushProactive()` 把最终回复恰好投递一次。`/loop add` 与
  `channel_loop_create` 工具在创建任务前也会检查该能力。
- **webhook 任务** —— `ChannelBase.resolveWebhookTaskTarget()` 与
  `runWebhookTask()` 校验该能力，并通过 `pushProactive()` 投递。
- **background 与 named-task 回复** ——
  `ChannelBase.deliverBackgroundResponseToTarget()` 在能力与目标都支持时使用
  `pushProactive()`。QQ 覆写该方法，使其始终走 `pushProactive()`，因此无人值守
  回复绝不会回落到带 anchor 的 `deliverBackgroundReply()` 路径（见下文的开关
  契约）。
- **daemon 主动投递** —— `ChannelBase.deliverProactive()` 现在接受 QQ 目标，并
  把 `pushProactive()` 包进 `pushProactiveDelivery()`，后者会把未归类的错误标记
  为 `transient`。

## 目标 gate

`QQChannel.supportsProactiveTarget()` 仍然要求 base 的
`threadId === undefined`，然后：

- 通过类自身的 `chatTypeFor()` 解析会话类型，因此只在 `qqConfig.chatTypes` 中
  声明的群，与 `resolveRoute()` 实际选路时所用的类型一致；
- 拒绝显式标记为群、但会话类型尚未学习到的目标，避免为一笔注定无法选路的发送
  白跑一整轮无人值守 agent 回合；
- 拒绝主动消息开关已知为关闭的群；
- 私聊永远不查询开关映射。

## 无人值守回合的「只投递一次」规则

loop 路径与 webhook 路径都会把自己的 `ActivePrompt` 标记为
`loopPrompt: true`，`ChannelBase.isProactivePromptTurn(sessionId)` 暴露该标记。
base 对这类回合只在 `pushProactive()` 中完整投递一次，且从不为它调用
`onResponseComplete()`。

当 `isProactivePromptTurn(sessionId)` 为真时，QQ 的 `onResponseChunk()` 立即返回，
使它冲刷流式 chunk 的 sink 无法在最终主动投递之上再发一遍同样的文本。这是写进
文档的适配器契约，而不是 QQ 的细节：任何会流式输出渐进内容的适配器都必须以同样
方式抑制无人值守回合（见 `packages/channels/base/README.md` 与
`docs/developers/channel-plugins.md`）。

## 投递错误分类

QQ 的发送与 flush 路径会抛出带四种 code 之一的 `DeliveryError`：
`RATE_LIMITED`、`RETRY_EXHAUSTED`、`FALLBACK_FAILED`、`ACTIVE_MSG_DISABLED`。
唯一的判定函数 `isPermanentDeliveryError()` 定义了永久集合：`RETRY_EXHAUSTED`、
`ACTIVE_MSG_DISABLED` 与 `FALLBACK_FAILED` 无法靠重试修复；`RATE_LIMITED`、
网络错误及其他一切错误保持 transient。

`QQChannel.pushProactive()` 在主动投递边界上保留该分类：路由被拦时抛出
`ChannelProactiveDeliveryError(block, …)`，永久 `DeliveryError` 则抛出
`ChannelProactiveDeliveryError('permanent', …)`。base 的
`pushProactiveDelivery()` 随后只会把未归类的错误标记为 `transient`。

该分类有一个真实消费者：daemon 边界的 `classifyChannelDeliveryError()`
（`packages/cli/src/commands/channel/daemon-worker.ts`）把永久
`ChannelProactiveDeliveryError` 映射为 `channel_delivery_rejected`，其他失败
映射为 `channel_delivery_failed`。loop 调度器不读取 disposition：它对任何失败
一视同仁地计数，连续五次失败后自动停用该 loop。

## 按会话批量停用 loop

失去 bot 的群再也收不到任何 loop 结果。`GROUP_DEL_ROBOT` 之后，QQ 会删除该群的
`chatTypeMap` 与 `groupActiveMsgEnabled` 条目，于是目标检查无法识别这个会话，也
无法把「bot 已被移出」与「会话类型从未学习到」区分开。若不做主动停用，loop 会
保持启用并持续触发，直到连续五次失败后自动停用 —— 每次尝试要么先白白消耗一整轮
agent 回合、随后发送仍无法选路，要么在回合开始前就被拒绝并记为一次失败 —— 而最终
的停用状态不记录任何原因。在移出时就停用，使结果立即生效、覆盖整个会话，并出现
在移出日志中。

本设计为跨包契约新增了按会话查询的能力：

- `ChannelLoopController.listForChat?(channelName, chatId)`（可选）返回一个会话中
  的每个 loop，不区分 sender、thread 或消息路由 —— 移出事件只带群 id，拿不到
  创建者的精确目标。
- `packages/cli/src/commands/channel/loop-runtime.ts` 在 `ChannelLoopStore` 之上
  将其实现为 `job.channelName === channelName` 加
  `job.target.chatId === chatId` 的过滤。
- `ChannelBase.disableLoopJobsForChat(chatId)` 停用该查询返回的每个启用中任务。
  QQ 在 `handleGroupDelRobot()` 中调用它，并把停用数量计入移出日志。

重新启用超出范围：`ChannelLoopController` 与 `ChannelLoopStore` 都没有 `enable`，
也没有任何地方记录 loop 被停用的原因，被停用的 loop 与用户主动取消的 loop 无法
区分。想要恢复定时任务的用户需要重新创建。

## 群主动消息开关契约

`GROUP_MSG_RECEIVE` 与 `GROUP_MSG_REJECT` 会更新 `groupActiveMsgEnabled`（同时
持久化到渠道状态）。当一个群的开关已知为关闭时：

- loop 创建（`/loop add`、`channel_loop_create`）被拒绝；
- loop 触发在 agent 回合开始前被目标 gate 拒绝 —— 调度器会记录该失败，连续五次
  失败后自动停用该 loop 并写入 `lastError`；
- webhook 任务的创建/入队被同一 gate 拒绝；
- 开关本身不会停用 loop。

把开关重新打开会恢复仍然启用的 loop 的投递能力，但不会重新启用任何在开关关闭期间
被调度器自动停用的 loop，也不会重新启用因 bot 被移出而停用的 loop。开关关闭刻意
不做即时停用：它是可逆的，而且前置 gate 已经避免了即时停用本意要防止的那次白跑
回合。

当开关状态仍然未知（还没有收到任何事件）时，gate 放行本次运行。若平台随后拒绝
这条主动消息，发送阶梯会以永久失败结束（`FALLBACK_FAILED` 或
`RETRY_EXHAUSTED`），调度器对该失败与任何其他失败一视同仁地计数。

## 非目标

- 撤销停用：不提供按会话的 loop 启用/停用，也不在开关重新打开或 bot 重新加入时
  自动恢复。
- 带 thread 的主动投递目标。
- 主动投递中的媒体、卡片或其他非文本内容。

## 风险

- **主动消息配额。** 每一次发往群的无人值守投递都会消耗该群的平台主动消息配额；
  loop、webhook 任务、background/named-task 结果与 daemon 投递都计入。
- **background/named-task 回复不再有带 anchor 的回落。** 即使目标 gate 会失败，
  QQ 的覆写仍走 `pushProactive()`，因此被管理员关闭主动消息的群会丢掉该回复
  （`ACTIVE_MSG_DISABLED`，永久），而不是静默收到一条带 anchor 的被动回复。这
  正是有意的契约。
- **开关状态未知的代价是一轮回合。** 在开关事件到达之前，运行会被尝试并在发送时
  失败；调度器需要累计五次才会自动停用。
- **未知会话类型在不同路径上的失败方式不同。** loop 与 webhook 会在回合开始前被
  gate 拒绝；background/named-task 目标若会话类型未知，则会在发送时以永久路由
  拦截失败。

## 验证计划

- base 契约：`packages/channels/base/src/ChannelBase.test.ts` 覆盖
  `disableLoopJobsForChat()`。
- QQ 适配器：`packages/channels/qqbot/src/loop.test.ts` 覆盖能力开关、loop 创建
  与触发 gate、主动投递、「只投一次」与流式 chunk 的对比、永久/transient 分类、
  以及 bot 被移出后的停用；`loop-store.test.ts` 覆盖 store 与 controller 的接线；
  `events.test.ts` 覆盖群事件与开关状态。
- 生产 `listForChat`：新增的
  `packages/cli/src/commands/channel/loop-runtime.test.ts` 用真实的
  `createChannelLoopController()` 搭配真实的 `ChannelLoopStore`，写入两个会话、
  两个渠道名的任务，断言 `listForChat('qq-a', 'chat-1')` 只返回渠道名为 `qq-a`、
  会话为 `chat-1` 的任务 —— 其中包含同一会话里的第二个 sender，以钉住「按会话」
  的语义。删掉过滤条件、或只删掉其中的 `channelName` 条件，该测试都会变红；生产
  实现无需改动。
- 静态检查：对改动到的包运行 Prettier、ESLint 与 TypeScript。
- 实机验证：用 QQ 沙箱 bot 分别跑一次 loop、一次 webhook 任务、一次 background
  结果和一次 daemon 主动投递；关闭再打开某个群的主动消息；把 bot 移出某个群并
  确认该群的 loop 被停用。

## 验收标准

1. QQ 渠道声明支持主动投递，因此 loop、webhook 任务、background/named-task 回复
   以及 daemon 主动投递都以主动消息到达会话。
2. 无人值守结果只投递一次：除了 `pushProactive()` 的完整文本之外，不再额外发送
   流式 chunk。
3. 主动消息开关已知关闭的群无法创建或触发 loop 与 webhook 任务，无人值守的
   background/named-task 回复以永久失败结束，而不是变成带 anchor 的被动回复。
4. 投递失败经 `pushProactive()` 后仍保留永久/transient 分类；daemon 边界把永久
   主动投递失败报告为 `channel_delivery_rejected`。
5. 把 bot 移出群会停用该群中启用中的 loop，且没有任何机制会自动重新启用它们。
6. 关闭再打开主动消息开关本身不会停用 loop；仍然启用的 loop 在开关恢复后可以
   继续投递。

## 后续

可以按会话提供可逆的 loop 启用/停用，以取代「重新创建被停用的 loop」。这超出本次
改动范围，并且需要 store 记录停用原因，以免把用户主动取消的 loop 也一并恢复。
