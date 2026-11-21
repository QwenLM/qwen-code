# ChatSurface 组件（Slice 2e）

[English](2026-11-21-chat-surface.md) |
[简体中文](2026-11-21-chat-surface.zh-CN.md)

状态：已实现（slice 2e，表面组件）。日期：2026-11-21。属于
[统一聊天界面](2026-11-16-unified-chat-surface.md)迁移的一部分。建立在已合入的
契约（#17520）、状态栈（#17684）、意图引擎（#17709）、控制器组装（#17794）与
绑定 hook（#17895）之上。

## 范围

前置切片已建成后端中立的 kernel 与 daemon 适配器，但尚无组件从
`SessionChatController` 契约渲染聊天列。本切片落地 **`ChatSurface`**
（`chat-core/ChatSurface.tsx`）——共享聊天列渲染器——以及它所需的一处契约扩展。
它尚未接入任何列：带视觉前后对比门的 daemon 主列切换是下一增量（2f），故本切片
是增量的、本身不渲染任何内容。

## 设计

- **一个组件，由契约驱动。** `ChatSurface` 接收 `SessionChatController`，渲染聊天列：
  转录（`TranscriptViewport`）、当前工具审批（`ToolApproval`）、当前提问
  （`AskUserQuestion`）、输入框（`ChatEditor`）。它从不按 `controller.kind` 分支；
  一个区域仅在其事实存在时渲染。
- **渲染就绪的待处理项（契约扩展）。** `ToolApproval` 与 `AskUserQuestion` 消费完整
  `PermissionRequest`，但契约的 `PendingApproval`/`PendingQuestion` 此前仅带
  `{ id, status }` / `{ id }`。本切片为两者加上后端中立的
  `request: PermissionRequest`（共享 `adapters/types` 模型），使表面无需探入
  provider 即可渲染。daemon 绑定在待处理拆分中填充它。
- **拆分保留每增量优化。** 渲染就绪的 request 仅在内容签名变化时抽取（slice 2d 的
  ref 缓存），而非每个流式增量；轻量块级分类器仍每次渲染构建签名。签名为
  `id + 分类 + 廉价载荷 revision`（`updatedAt + title + option ids`，不做载荷序列化）：
  同一 id 重发的 `permission.request` 可能在 id 与分类不变时改动 title/options，
  revision 项强制重新抽取，使缓存的 request 不陈旧（verify-r3 F1）。
- **准入不等于建立，输入框亦然。** `ChatEditor.onSubmit` 派发 `controller.submit`，
  仅在 `accepted` 准入时清空草稿（`commitAccepted`）——绝不在建立时。**仅当存在提交
  回调时**才返回字面量 `false` 以推迟 `useComposerCore` 的同步提交
  （`return commitAccepted ? false : undefined`）：无提交回调的入口（`submitSearchMatch`、
  `retryLast`）把 `false` 读作「被拒、保留文本」，故必须拿到 `undefined` 才能保持其同步
  清空。由于控制器的 `phase` 是对快照的 getter、此处无响应式来源，表面自持一个在途 latch
  （ref + state），首次提交同步置位、`.finally` 清除，并传
  `submitDisabled={composerSubmitBlocked || transcriptState === 'loading' || submitInFlight || admissionLocked || phase === 'submitting'}`，
  使 POST 往返期间再按 Enter/点击不会派发重复发送——即便是带附件的 prompt（无乐观回显触发
  重渲染）——而流式期间的发送仍被允许。`unknown` 准入还会置一个准入载荷锁（ref + state），
  持续拒绝一切提交路径，直到用户经横幅（`queue.admissionUnknown` 文案）显式确认——因为送达
  不确定、daemon 可能已在执行该 prompt；草稿保留、绝不抹掉。对 `unknown`、`rejected` 准入与
  transport 拒绝均经 `onError` 上报（被上报的 `Error` 由本地化 `chat.*` 字符串构造、原传输
  错误作为 `cause`，因宿主落点显示 `error.message`），所有非 accepted 路径都保留草稿。
  `chat.*` 文案带 zh-CN/zh-TW/ru 的目录一致性测试。`onCancel` 派发 `controller.cancel`。
  `isRunning` 由 `phase`（`submitting`/`running`/`cancelling`）派生，故取消在途时停止入口与
  流式指示器保持到落定证据到达。
- **审批/提问。** 表面渲染第一个 `pending` 审批（跳过被取代项）与第一个待处理提问。
  `ToolApproval` 确认路由到 `respondApproval(id, optionId)`，并在非 accepted 准入时
  **reject**（经 `onError` 上报），因为 `ToolApproval` 仅经 rejection 重新解锁——resolve
  会把卡片闩死失效。`AskUserQuestion` 确认按所选选项路由：提交（`allow_once`）选项把
  按索引键控的答案记录规范化为 `QuestionAnswer[]` 走 `respondQuestion`；拒绝选项是决策
  投票，走 `respondApproval`（`respondQuestion` 总是投提交选项、无法表达拒绝）。两者均以
  `admission === 'accepted'` 作为组件的成功布尔返回。
- **在流决策卡片。** 待处理卡片在输入框之前以在流方式渲染并替换它（输入框被隐藏并收到
  `dialogOpen`），故转录在卡片上方收缩、而非被浮动层覆盖，输入框也不保留键盘。审批与
  提问各有独立容器（`approval-overlay` / `question-overlay`），同时待处理时两者都可操作；
  任一存在即传 `approvalOverlayActive`。
- **槽位保持 kernel 后端中立。** 头部、后端特定面板、composer 状态栈、本地化的
  转录不可用 UI 均以槽位传入（`header`、`panels`、`composerStatus`、`transcriptError`）。
  状态栈与用量统计需要比当前保守 `statusFacts`（`queueLength`/`goalActive`）更丰富的
  事实，故由宿主页提供，直至 parity 落地。
- **页面提供的事实与门控。** 历史分页转发 `hasOlderHistory`、`onLoadOlderHistory`
  （默认取 `controller.loadOlder`）与成对的 `historyPaginationError`（缺它则更早历史页
  加载失败不可见、且每次顶部滚动都重发）。计划事实与焦点/通知门控以 props 传入
  （`planTodos`、`planExecutionMode`、`approvalDisabled`、`approvalKeyboardActive`、
  `showBrowserNotifications`），因由宿主页计算；分屏面板传 `approvalKeyboardActive={false}`
  以免抢焦点（审批卡与提问卡都收到）。提问卡还接收宿主的 `askUserFreeTextLabel` /
  `askUserDetails`（卡片激活时输入框被隐藏，详情逃生入口因此重要）。composer 接收
  `atWorkspaceCwd` / `composerScopeKey`，使新会话（尚无 session id）仍能落盘草稿——草稿键
  按工作区/新会话作用域事实定位，而非仅靠 `sessionId`、也不是转发 `controller.storageKey`
  （`getComposerDraftStorageKey` 会对其再加前缀）。默认 `onError` 是可观测的
  `console.error` 落点，而非静默空函数。

## 延后到后续增量

- **daemon 主列切换 + 视觉前后对比门（2f）。** `App.tsx` 以 daemon 绑定渲染
  `ChatSurface`，删除重复的内联编排；视觉预览须无未解释的 daemon 侧差异。
- **状态栈 / 用量统计 parity（slice 5）**，待 `statusFacts` 携带完整排队 prompt 与
  goal 事实。
- **managed 适配器（slice 3）** 与 **ChatPane 收敛（slice 4）** 经由同一组件渲染。
- **会话归属的准入锁（2f，评审 R5-1）。** 在途 latch 与 unknown 准入锁目前是组件级状态、
  无会话归属；切换时须按持锁会话归属（真实会话变化时重置，但一次提交可跨 `'' → id` 的会话
  分配、期间不得重置），`ChatPane`/`App` 已如此处理。
- **共享的准入未知外框（收敛，评审 R5-2）。** 三处手写的 unknown 准入渲染（`App`、
  `ChatPane`、`ChatSurface`）应共享纯展示外框 + 文案（动作仍为各表面的回调）；动作集允许
  合理地不同。

## 遵守的约束

- `chat-core` 自身模块不 import `daemon/**` 或 `@qwen-code/sdk/daemon` 值；
  `ChatSurface` 组合的共享组件仅带 type-only SDK 导入（构建期擦除），已对全部八个核实。
- 不改 daemon/Java 路由或 OpenAPI；会话 id 命名空间与存储键不变。composer 复用既有
  草稿键约定：会话分支按 `sessionId` 定位，新会话分支按工作区/作用域事实
  （`atWorkspaceCwd` / `composerScopeKey`）定位，故尚无 session id 时草稿也能落盘。
- 契约扩展是增量且后端中立的；daemon 绑定是当前唯一填充的适配器。
