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
`lockOwner` 状态加每次提交捕获的 `ownerTokenRef` 跟踪归属会话；当某次渲染中控制器
的会话与之不同时，用 React「渲染期调整状态」模式重置闩：

- **真实的会话变更**（一个非空 id 到另一个不同 id、回到空的新聊天 id、或无提交在飞
  时从已锁定新聊天侧边栏点击切换到已有会话的空闲 `'' -> id`）放弃两个闩并轮换
  `ownerTokenRef`：在飞 ref + state 与准入锁 ref + state 一并清除，使渲染门
  （`submitDisabled`）与派发门（`onSubmit` 读取的 ref）都不再为已不拥有它们的会话
  保持武装，且已放弃在飞提交的迟到结算不会清除新会话的草稿或锁住新会话的 composer。
- **唯一不算切换的变更**是新聊天首次提交**在该提交仍在飞时**跨越的 `'' -> id` 分配
  （`lockOwner === '' && controller.sessionId !== '' && submitInFlight`）：提交
  开始时无会话 id，daemon 在提交中途分配一个，控制器在新 id 下重建。那是同一个逻辑
  聊天，故在飞闩与归属令牌在其间保持武装（使结算仍能 commit 草稿、提交中途也不会让
  重复发送溜过去）。

重置同时清除 ref 与 state 两半；只清其一会留下「可见但可派发」或「不可见但被阻塞」
的 composer。这镜像了 `App` 与 `ChatPane` 已有的会话归属准入状态
（`admissionOwnerRef`），并把提交中途的分配例外显式化。

### 历史分页绑定

`useDaemonChatController` 现在读取 `useDaemonTranscriptHistory()`，并把契约的
`loadOlder` 绑定到其 `loadMore`。控制器按会话构造一次，因此绑定经由每次渲染更新的
ref 读取历史句柄（`transcriptHistoryRef.current.loadMore()`），绝不钉死陈旧句柄。
历史分页是 provider 能力而非意图：它不走准入/结算引擎。`ChatSurface` 已优先使用
页面提供的 `onLoadOlderHistory` 而非 `controller.loadOlder`，故主列切换仍可直接传
`transcriptHistory.loadMore`（携带 `force` 选项），其他表面则回退到已绑定的能力。

## 设计决策与理由

- **渲染期重置，而非 effect。** effect 会在新会话的首次渲染之后才运行，让陈旧武装
  锁可见一帧，并能在 effect 清除它之前门禁一次提交。渲染期更新会收敛（重渲染时归属
  已匹配），并在新会话能派发之前清除闩。
- **分配例外要求有提交在飞。** 提交在飞时的 `'' -> id` 是分配；空闲的 `'' -> id`
  （从已锁定新聊天侧边栏切换出去）像其他任何切换一样重置准入锁。
- **归属令牌守卫迟到结算。** 每次提交捕获当前 `ownerTokenRef`；切换时轮换令牌使已放弃
  提交的 `.then`/`.catch`/`.finally` 空操作，而不会覆盖新会话。
- **`loadOlder` 按调用读取。** 会话稳定的控制器不得捕获首次渲染的历史句柄；ref
  读取保持加载器为最新。

## 遵守的约束

- `chat-core` 不导入任何 `daemon/**` 值；会话作用域仅使用契约的 `sessionId`。
  历史绑定位于 daemon 适配器。
- 无 daemon/Java 路由、OpenAPI、会话 id 命名空间或存储键变更。
- 加法：尚未切换任何生产列；本改动由组件/绑定套件验证，而非浏览器门（那属于切换）。

## 验证

- `ChatSurface` 套件新增三个会话作用域用例：准入锁在会话切换时清除（包括从已锁定新
  聊天侧边栏切换出去的空闲 `'' -> id`）、在飞闩与归属令牌在提交中途的 `'' -> id`
  分配间存活、会话切换清除在飞闩并忽略已放弃提交的迟到结算。在各命名变异下验证转红
  （永不重置、无条件分配、恒重置、仅清准入锁、去掉归属令牌轮换），并逐字节还原。
- 绑定套件新增 `loadOlder` 用例，在去掉绑定时验证转红。
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
