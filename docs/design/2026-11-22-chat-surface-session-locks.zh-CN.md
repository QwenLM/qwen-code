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

- **R5-1——会话作用域准入锁。** `ChatSurface` 的在飞提交闩与 unknown 准入载荷锁
  原本是无会话归属的组件级状态；陈旧锁可能阻塞下一会话的 composer。
- **`loadOlder` 绑定。** daemon 绑定此前未绑定契约的可选 `loadOlder` 能力
  （slice-2d 遗留），依赖 `controller.loadOlder` 的表面会静默丢失更早历史分页。

本增量是加法的：尚无生产列经 `ChatSurface` 渲染，故其本身不改变任何可观察行为。
带视觉前后对比门的主列切换仍是 2f 的其余部分。

## 设计

### 会话作用域锁（R5-1）

两个闩都属于武装它们的会话。`ChatSurface` 用初始化为 `controller.sessionId` 的
`lockOwner` 状态、每次提交捕获的 `ownerTokenRef` 以及按会话索引的
`parkedLatchesRef` 映射（`sessionId -> { token, inFlight, admissionLocked }`）跟踪
归属会话；当某次渲染中控制器的会话与之不同时，用 React「渲染期调整状态」模式暂存离开
会话的闩并恢复进入会话的闩：

- **真实的会话变更**（一个非空 id 到另一个不同 id、回到空的新聊天 id、无提交在飞时从
  已锁定新聊天侧边栏点击切换到已有会话的空闲 `'' -> id`、或新聊天首次提交仍在飞时从侧边
  栏切到无关已有会话）在任一闩处于武装态时暂存离开的持久会话的
  `{ token, inFlight, admissionLocked }`（空闲时则删除其暂存条目；未分配的 `''` 新聊天
  无持久会话可返回，直接放弃），并恢复进入会话的暂存条目（默认全新令牌与清零闩）。这确
  保渲染门（`submitDisabled`）与派发门（`onSubmit` 读取的 ref）都不会阻塞非锁归属会话，
  同时往返切回（`A -> B -> A`）能够恢复 `A` 的在飞守卫、归属令牌与 unknown 准入锁。
- **唯一不算切换的变更**是新聊天首次提交**在该提交仍在飞、且控制器将 `controller.sessionId`
  标识为该次提交所分配的 id 时**跨越的 `'' -> id` 分配
  （`lockOwner === '' && controller.sessionId !== '' && submitInFlight && allocatedId === controller.sessionId`，
  其中 `allocatedId` 读取 `controller.allocatedSessionId` 或发起提交的控制器的
  `allocatedSessionId`）：提交开始时无会话 id，daemon 在提交中途分配一个，控制器在新 id
  下重建且 `allocatedSessionId` 与之匹配。那是同一个逻辑聊天，故在飞闩与归属令牌在其间
  保持武装（使结算仍能 commit 草稿、提交中途也不会让重复发送溜过去）。
- **跨切换的 accepted 结算仍提交发起会话自身的草稿。** `useComposerCore` 中的
  `commitAccepted` 本身已按身份作用域（`sourceChanged` 时只清除提交方草稿 key 并按提交
  方 key 写入历史，不触碰当前活动会话），因此 `.then` 在陈旧归属返回之前先对
  `result.admission === 'accepted'` 调用 `commitAccepted?.()`。若非活动的已暂存会话的
  提交以 `unknown` 结算，其暂存条目记录 `admissionLocked = true` 而不打扰当前活动会话。

切换同时更新 ref 与 state 两半；只更新其一会留下「可见但可派发」或「不可见但被阻塞」
的 composer。这镜像了 `App` 与 `ChatPane` 已有的会话归属准入状态
（`admissionOwnerRef`），并以契约的 `allocatedSessionId` 信号作为提交中途分配例外的门禁。

### 历史分页绑定

`useDaemonChatController` 现在读取 `useDaemonTranscriptHistory()`，并把契约的
`loadOlder(options?: { force?: boolean })` 绑定到其 `loadMore(options)`。控制器按会话
构造一次，因此绑定经由每次渲染更新的 ref 读取历史句柄
（`transcriptHistoryRef.current.loadMore(options)`），绝不钉死陈旧句柄，并在转录的分页
错误重试按钮调用该绑定能力时转发 `{ force: true }`。历史分页是 provider 能力而非意图：
它不走准入/结算引擎。`ChatSurface` 仍优先使用页面提供的 `onLoadOlderHistory` 而非
`controller.loadOlder`，同时依赖该绑定能力的表面获得完整的重试 parity。

## 设计决策与理由

- **渲染期重置，而非 effect。** effect 会在新会话的首次渲染之后才运行，让陈旧武装
  锁可见一帧，并能在 effect 清除它之前门禁一次提交。渲染期更新会收敛（重渲染时归属
  已匹配），并在新会话能派发之前清除闩。
- **分配例外要求同时满足有提交在飞且 `allocatedSessionId` 匹配。** 仅凭 `sessionId`
  无法区分会话创建往返期间的「提交中途会话分配（`'' -> 已分配 s1`）」与「用户点击侧边栏
  已有会话（`'' -> 已有 s2`）」。因此契约暴露可选的 `allocatedSessionId`（由
  `useDaemonChatController` 在未分配新聊天提交分配出会话 id 时从 `onAdmissionStarted`
  填入，并在结算或切换到其他 id 时清除），`ChatSurface` 仅当新的 `controller.sessionId`
  与之匹配时才保留在飞闩与归属令牌。
- **按会话暂存 + 归属令牌守卫迟到结算。** 每次提交捕获当前 `ownerTokenRef`；在离开的持久
  会话 id 下暂存 `{ token, inFlight, admissionLocked }` 并恢复进入会话的条目，既防止跨会
  话阻塞，又在往返切换（`A -> B -> A`）间保留归属会话的在飞与 unknown 准入锁。在非活动
  期间，accepted 提交仍 commit 其自身身份作用域的草稿，unknown 提交武装其暂存的
  `admissionLocked`，而任何错误与闩更新对当前活动会话均空操作。
- **`loadOlder` 按调用读取并转发 `options`。** 会话稳定的控制器不得捕获首次渲染的历史
  句柄，且转发 `{ force?: boolean }` 确保分页错误重试在绑定控制器能力路径与页面直接回调
  路径上都能正常工作。

## 遵守的约束

- `chat-core` 不导入任何 `daemon/**` 值；会话作用域仅使用契约的 `sessionId` 与
  `allocatedSessionId`。历史绑定位于 daemon 适配器。
- 无 daemon/Java 路由、OpenAPI、会话 id 命名空间或存储键变更。
- 加法：尚未切换任何生产列；本改动由组件/绑定套件验证，而非浏览器门（那属于切换）。

## 验证

- `ChatSurface` 套件新增六个会话作用域用例：准入锁在会话切换时清除（包括从已锁定新
  聊天侧边栏切换出去的空闲 `'' -> id`）、在飞闩与归属令牌在由 `allocatedSessionId` 标识
  的提交中途 `'' -> id` 分配间存活、首次提交在飞期间从未分配新聊天切到无关已有会话时清
  除在飞闩并忽略已放弃的 `unknown` 结算、已分配会话之间的切换清除在飞闩（且非活动结算不
  会清除新会话自身的在飞闩）、切换后的 accepted 结算仍提交发起会话的草稿同时拒绝结算对新
  会话保持静默、以及往返切换（`A -> B -> A`）恢复准入锁与在飞提交闩。在各命名变异下验证
  转红并逐字节还原。
- 绑定套件新增 `loadOlder`（含 `{ force: true }` 转发）与 `allocatedSessionId` 生命周期
  用例，各在其命名变异下验证转红并逐字节还原。
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
