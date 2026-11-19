# Daemon 聊天控制器组装（Slice 2c）

[English](2026-11-19-daemon-chat-controller.md) |
[简体中文](2026-11-19-daemon-chat-controller.zh-CN.md)

状态：已实现（slice 2c，适配器核心）。日期：2026-11-19。属于
[统一聊天界面](2026-11-16-unified-chat-surface.md)迁移的一部分。建立在已合入的
契约（#17520）、composer 解耦（#17661）、状态栈抽取（#17684）与 daemon 意图引擎
（#17709）之上。

## 范围

Slice 2b 落地了意图生命周期引擎（`createDaemonChatIntents`）：它把 admission 与
outcome 分开、并把结算绑定到被派发的操作 id，但它不认识 daemon 的后端身份。本切片
落地 **daemon 适配器的控制器组装** `createDaemonChatController(deps)`，把注入的
provider 事实与动作包装成后端中立的 `SessionChatController`，并兑现引擎留下的关联
要求：到来的 daemon 事件在能结算任何东西**之前**，先被绑定到它所属的那次尝试。

适配器的新逻辑是**关联**，而非 transcript 或子控制器。transcript 消息、状态事实、
能力旗标、能力门控的子控制器都从 provider 透传；适配器不重新投影、不重新推导。
从 `DaemonSessionProvider` 各 context 构造 `deps` 的绑定 hook、以及消费该控制器的
`ChatSurface` 组件，是接下来的步骤（表面切换，含视觉前后对比门）。

## 依赖注入

`createDaemonChatController(deps)` 是纯组装：每个 provider 事实与动作都被注入，
故无需挂载约 7k 行的会话 provider 即可测试。事实字段经 getter 在每次访问时读取，
故带 getter 字段的 `deps` 对象在渲染之间保持最新；绑定 hook 用活的 provider 状态
支撑它们。transport 只 resolve 出 **admission**；权威 outcome 证据经独立订阅到来。

- `submitPrompt(input, onAdmitted)` 在 admission 时（provider 的 `onAdmitted`
  钩子）报告 daemon 的 `promptId`，先于 turn 运行。
- `cancelPrompt()`、`submitPermission(requestId, optionId)`、
  `submitQuestionAnswers(requestId, answers)` 仅 admission。
- `subscribePromptSettlement` 送达 turn 的终态事件
  （`completed` / `cancelled` / `failed`），按 `promptId` 键控。
- `subscribeDecisionSettlement` 送达某决定是否作用于它所点名的请求。
- `subscribeApprovalCurrency` 在请求到达时标存活、仅在被取代或取消时标不存活——
  绝不只因被应答。
- `signal` 在 abort 时释放证据订阅（绑定 hook 把它系到控制器的挂载生命周期）。

## 关联：证据必须点名它所建立的尝试

引擎按操作 id 结算；daemon 事件点名 `promptId` 或 `requestId`。适配器桥接两者：

- submit admission 时记录 `promptId -> operationId`；approval/question 派发时记录
  `requestId -> operationId`。终态事件只结算绑定到其身份的尝试，绝不按可见的
  session/turn target 匹配。故已结束尝试的迟到事件无法建立共享同一可见 target 的
  重试。
- 一个 turn 的终态事件同时关闭启动它的 submit 与指向它的 cancel：
  `promptId -> Set<operationId>`。cancel 指向**存活 turn**——存活 turn FIFO 的队首
  （终态事件尚未到达的最旧准入 prompt），在派发时捕获——绝不用最新被准入的 id
  （那可能是排队中的 prompt、或已结束的 turn）。prompt 在其终态事件到达或 submit
  被拒时出队。无可绑定的存活 turn 时，cancel 结算为 `failed`，使 phase 不至于被一条
  永久非终态行钉死。
- 引擎只在 transport resolve 后才返回操作 id，但终态事件可能在 POST 仍在飞时到达。
  适配器按后端身份保留终态见证，并在尝试被绑定时应用，故在飞证据不被丢弃。意图方法
  返回尝试实际到达的 outcome（绑定后），而非证据前的 dispatch 快照。
- 一个 prompt 恰有一个终态事件；保留它也让「turn 正在结束时才派发的 cancel」仍能
  结算。prompt 每个 turn 都是全新 id，故保留不会把一个 turn 的判决泄漏到另一个。
- **决策**见证不同：`requestId` 在多次尝试间稳定，故见证只在「事件到达至该尝试绑定」
  这段窗口内保留，随后即**消费**。同一请求的重试必须赢得自己的证据；失败决策保持请求
  存活（非取代），重试仍可建立。
- **rejected** 的 dispatch 绝不绑定：其被丢弃的操作 id 指向任何不可保留之物，绑定它
  会让裁剪毁掉属于另一条尝试的、被保留的在飞见证。只有 submit 的绑定才把其 prompt
  清出在飞集合。
- 一个请求**至多一条非终态决策尝试**：已有在飞决策时，第二次
  `respondApproval`/`respondQuestion` 被拒绝——因为决策事件点名请求而非选项，兄弟
  尝试无法被独立结算，会泄漏一条永久非终态行。

### 关联状态有界

关联 map 以引擎的保留为上界：一旦尝试不再属于保留的操作（被确认或被取代），其
后端身份即停止被跟踪。此外，结算订阅会送达本控制器从未派发过的身份的终态事件
（回放的历史、其他客户端的决定）。这些**孤儿**见证除非该身份是正等待绑定的在飞
尝试，否则被丢弃，故既不累积、也不会认证未来的尝试。在飞尝试的早到终态事件被保留
（它在在飞集合里）直到绑定应用它。

## 保留的不变量

admission 不等于 establishment。仅 transport resolve 使 outcome 保持 `unsettled`；
只有被绑定的终态/决定见证才提升它。被取代或无身份的 approval 在正向证据下绝不建立
（引擎的时效守卫），而否定证据仍使尝试终态化。负向测试随本适配器落地，符合父设计
要求。

## 测试

`chat-controller.test.ts` 用 fake 注入 provider 钉住：已 resolve 的 submit 在 turn
结算前保持 unsettled；失败 turn 终态化；rejected submit 不跟踪；已结束尝试的迟到
事件无法建立同 target 重试；乱序事件各落在它点名的尝试；在飞证据在 admission 解析
后应用；孤儿终态事件不能认证之后的尝试；重复终态事件不再结算；已 resolve 的 cancel
在 turn 结算 cancelled 前保持 cancelling；turn 已结算后的 cancel 既不认证也不钉死；
cancel 绑定存活（FIFO 队首）turn 而非排队 prompt；在飞的 rejected cancel 不搁死与之
重叠的 submit；作用于存活请求的决定建立而被取代者绝不；无证据的已准入决定保持
unsettled；失败决策后的重试赢得自己的证据；rejected 决策派发不破坏关联；已有在飞决策
时第二次派发被拒绝；question 应答建立；透传事实被暴露且活读；无操作持有时报告结算
`failed` phase；signal 释放订阅。每条修复均可经变异判别：还原最新准入定向会红排队
cancel 用例；恢复从不消费的决策见证会红重试用例；绑定 rejected cancel 会红重叠
submit 用例；写死结算 phase 会红 `failed` 用例；去掉拒绝会红双派发用例；去掉孤儿裁剪
会红孤儿用例、在飞用例仍绿。

## 留给表面切换的后续

- 契约尚未暴露 `acknowledge` / `abandon`；表面必须释放已消费的终态行（否则按不同
  target 增长）、并给抛错的 transport 一条出路。这些在表面消费控制器时加入。
- 无存活 turn 时派发的 cancel 结算为 `failed`（终态出口）；表面仍仅在 turn 在飞时
  启用 cancel。
- `deps.settledPhase` 由绑定 hook 从会话的结算态填充；其 `failed` 读取在此已有测试
  钉住，故该分支非死开关。
- 绑定 hook（provider context -> `deps`，复用既有 daemon 能力映射）与带视觉前后
  对比门的 `ChatSurface` 主列切换，是接下来的增量。

## 遵守的约束

- 不改 daemon 路由、Java 路由或 OpenAPI；不改 UI 行为（控制器尚未被渲染）。
- 适配器位于 `daemon/`、在 `chat-core` 之外；它导入契约与引擎，`chat-core` 不导入它。
- 会话 id 命名空间与存储键不变。
