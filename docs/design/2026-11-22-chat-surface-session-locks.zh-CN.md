# ChatSurface 会话作用域准入锁与历史分页绑定（切片 2f，首个增量）

[English](2026-11-22-chat-surface-session-locks.md) |
[简体中文](2026-11-22-chat-surface-session-locks.zh-CN.md)

状态：已实现（切片 2f 首个增量——切换前置）。日期：2026-11-22。属于
[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)迁移的一部分。基于已合入的
契约（#17520）、状态栈（#17684）、意图引擎（#17709）、控制器组装（#17794）、
绑定 hook（#17895）与 `ChatSurface` 组件（#17952）。

## 范围

daemon 主列切换（2f）无法作为单个行为不变的改动落地：主列的提交编排（本地 slash
命令、内联 shell、乐观回显）、`LiveMessageList` 的流式尾部投影、以及约 90 个
composer props 都超出当前 `SessionChatController` 契约。因此切换是一个多增量工程。
本首个增量关闭明确延后到它的两项，使后续切换不会回归它们：

- **R5-1——会话作用域准入锁与停止错误。** `ChatSurface` 的在飞提交闩、unknown 准入载荷锁
  以及 `onCancel` 错误上报原本是无会话归属的组件级状态/回调；陈旧锁或迟到结算可能阻塞下一会
  话的 composer 或在下一会话报错。
- **历史分页状态事实与 `loadOlder` 绑定。** daemon 绑定此前未绑定契约的可选 `loadOlder`
  能力与四项分页状态标志（`hasOlderHistory`、`loadingOlderHistory`、
  `historyCapacityReached`、`historyPaginationError`），仅依赖控制器的表面会静默丢失更早
  历史分页与重试状态。

本增量是加法的：尚无生产列经 `ChatSurface` 渲染，故其本身不改变任何可观察行为。
带视觉前后对比门的主列切换仍是 2f 的其余部分。

## 设计

### 会话作用域锁（R5-1）

两个闩都属于武装它们的会话。`ChatSurface` 用初始化为 `controller.sessionId` 的
`lockOwner` 状态与 `refOwnerRef` ref、每次提交捕获的 `ownerTokenRef` 以及按会话索引的
`parkedLatchesRef` 映射（`sessionId -> { token, inFlight, admissionLocked }`）跟踪
归属会话；当某次渲染中控制器的会话与之不同时，用 React「渲染期调整状态」模式暂存离开
会话的闩并恢复进入会话的闩：

- **每一次会话变更**（一个非空 id 到另一个不同 id、回到空的新聊天 id、无提交在飞时从
  已锁定新聊天侧边栏点击切换到已有会话的空闲 `'' -> id`、或新聊天首次提交仍在飞时从侧边
  栏切到已有会话；在 daemon 路径上 `actions.submitPrompt` 经 `requireSessionForAction`
  要求会话已存在，且会话创建在派发 `submitPrompt` 之前完成）在任一闩处于武装态时暂存离开
  的持久会话的 `{ token, inFlight, admissionLocked }`（空闲时则删除其暂存条目；未分配的
  `''` 新聊天无持久会话可返回，直接放弃），并恢复进入会话的暂存条目（默认全新令牌与清零
  闩）。这确保渲染门（`submitDisabled`）与派发门（`onSubmit` 读取的 ref）都不会阻塞非锁
  归属会话，同时往返切回（`A -> B -> A`）能够恢复 `A` 的在飞守卫、归属令牌与 unknown
  准入锁。
- **跨被丢弃渲染的幂等 ref 转换。** 由于 React 在丢弃未提交渲染（例如后代在
  `<Suspense>` 中挂起）时会回滚状态更新但不会回滚 ref 写入，实时 ref 的归属会话由独立于
  `lockOwner` 状态的 `refOwnerRef` 跟踪：ref 的暂存与恢复仅在
  `refOwnerRef.current !== controller.sessionId` 时执行；当未提交渲染重试且
  `refOwnerRef.current` 已等于 `controller.sessionId` 时，仅从实时 ref 重新应用
  `setLockOwner` / `setSubmitInFlight` / `setAdmissionLocked` 状态更新，而不会用已恢复
  的 ref 覆盖或删掉刚暂存的条目。
- **跨切换的 accepted 结算仍提交发起会话自身的草稿。** `useComposerCore` 中的
  `commitAccepted` 本身已按身份作用域（`sourceChanged` 时只清除提交方草稿 key 并按提交
  方 key 写入历史，不触碰当前活动会话），因此 `.then` 在陈旧归属返回之前先对
  `result.admission === 'accepted'` 调用 `commitAccepted?.()`。若非活动的已暂存会话的
  提交以 `unknown`（而非 `rejected`）结算，其暂存条目记录 `admissionLocked = true` 而不打
  扰当前活动会话。
- **停止结算错误留在发起会话上。** `onCancel` 捕获发起请求的 `controller.sessionId`（未分
  配时同时捕获 `ownerTokenRef.current`），仅当 `.then` 或 `.catch` 结算时该会话仍处于活动
  态（持久会话匹配 `refOwnerRef.current === cancelSessionId` 以使往返切回仍能收到错误，未
  分配 `''` 聊天匹配 `ownerTokenRef.current === token` 以免污染全新 `''` 聊天）才上报
  `chat.stopNotConfirmed`。

切换同时更新 ref 与 state 两半；只更新其一会留下「可见但可派发」或「不可见但被阻塞」
的 composer。这镜像了 `App` 与 `ChatPane` 已有的会话归属准入状态
（`admissionOwnerRef`）。

### 历史分页绑定

`SessionChatController` 与 `DaemonChatControllerDeps` 现与
`loadOlder(options?: { force?: boolean })` 一并暴露四项分页状态标志
（`hasOlderHistory`、`loadingOlderHistory`、`historyCapacityReached`、
`historyPaginationError`）。`useDaemonChatController` 读取
`useDaemonTranscriptHistory()`，经由 `factsRef.current` 响应式投影 `hasMore`、
`loading`、`capacityReached` 与 `paginationError`，并把 `loadOlder` 绑定到
`transcriptHistoryRef.current.loadMore(options)`，使会话稳定的控制器绝不钉死挂载时的历史
状态或陈旧加载器句柄，且在分页错误重试时转发 `{ force: true }`。`ChatSurface` 将
`<TranscriptViewport />` 的每项分页 prop 默认回退到控制器的绑定事实或加载器
（`prop ?? controller.prop`），同时允许所属页面显式覆盖任一属性。

## 设计决策与理由

- **带 `refOwnerRef` 幂等守卫的渲染期重置，而非 effect。** effect 会在新会话的首次渲染之
  后才运行，让陈旧武装锁可见一帧，并能在 effect 清除它之前门禁一次提交。将实时 ref 的归
  属会话由独立于 `lockOwner` 状态的 `refOwnerRef` 跟踪，确保当 React 在修改 ref 后丢弃未
  提交渲染时，重试不会拿着已恢复的 ref 再次执行暂存/恢复并删掉刚暂存的条目。
- **按会话暂存 + 归属令牌守卫迟到结算。** 每次提交捕获当前 `ownerTokenRef`；在离开的持久
  会话 id 下暂存 `{ token, inFlight, admissionLocked }` 并恢复进入会话的条目，既防止跨会
  话阻塞，又在往返切换（`A -> B -> A`）间保留归属会话的在飞与 unknown 准入锁。在非活动
  期间，accepted 提交仍 commit 其自身身份作用域的草稿，unknown 提交武装其暂存的
  `admissionLocked`，而任何错误与闩更新对当前活动会话均空操作。
- **`loadOlder` 与分页事实每次访问实时读取。** 会话稳定的控制器不得捕获首次渲染的历史句柄或
  标志；ref 读取保持加载器与标志为最新，`ChatSurface` 经 `??` 回退到它们，且转发
  `{ force?: boolean }` 确保分页错误重试在绑定控制器能力路径与页面直接回调路径上都能正常工
  作。

## 遵守的约束

- `chat-core` 不导入任何 `daemon/**` 值；会话作用域仅使用契约的 `sessionId`。历史绑定
  位于 daemon 适配器。
- 无 daemon/Java 路由、OpenAPI、会话 id 命名空间或存储键变更。
- 加法：尚未切换任何生产列；本改动由组件/绑定套件验证，而非浏览器门（那属于切换）。

## 验证

- `ChatSurface` 套件覆盖会话作用域提交闩、unknown 准入锁（含暂存期间 `unknown` 与
  `rejected` 结算的区分）、被丢弃的 `<Suspense>` 切换渲染、会话作用域 `onCancel` 错误上报
  （跨切换、持久会话往返及已放弃未分配新聊天）、以及控制器默认历史分页标志与显式 `false`
  覆盖。在各命名变异下验证转红并逐字节还原。
- 控制器与绑定套件覆盖实时 `hasOlderHistory`、`loadingOlderHistory`、
  `historyCapacityReached`、`historyPaginationError` 与 `loadOlder`（含 `{ force: true }`
  转发与每次渲染历史句柄刷新），在其命名变异下验证转红并逐字节还原。
- 全套迁移套件绿；web-shell 两个类型项目（`tsconfig.lib.json`、`tsconfig.json`）
  均退出 0；ESLint 与 Prettier 干净。

## 延后（2f 其余与后续）

- **主列切换本身 + 视觉前后对比门。** 需要经契约或槽位承载流式尾部投影、提交编排
  与富 composer 面；多增量工程。
- **状态栈 / 用量统计 parity（slice 5）**，待 `statusFacts` 承载完整排队提示与
  goal 事实。
- **Managed 适配器（slice 3）** 与 **ChatPane 收敛（slice 4）**。
- **共享 admission-unknown 框架（收敛，R5-2）** 与 **SDK 单调转录 revision
  （verify-r4 发现 3）** 仍按 slice-2e 设计所记录。
