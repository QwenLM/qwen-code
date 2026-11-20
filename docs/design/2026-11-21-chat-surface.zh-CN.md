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
  ref 缓存），而非每个流式增量；轻量块级分类器仍每次渲染构建签名。
- **准入不等于建立，输入框亦然。** `ChatEditor.onSubmit` 派发 `controller.submit`，
  仅在 `accepted` 准入时清空草稿（`commitAccepted`），绝不在建立时。`onCancel` 派发
  `controller.cancel`。`isRunning` 由 `phase`（`submitting`/`running`）派生。
- **审批/提问。** 表面渲染第一个 `pending` 审批（跳过被取代项）与第一个待处理提问。
  `ToolApproval` 确认路由到 `respondApproval(id, optionId)`；`AskUserQuestion` 确认把
  其按索引键控的答案记录规范化为 `QuestionAnswer[]` 并路由到 `respondQuestion`，以
  `admission === 'accepted'` 作为组件的成功布尔返回。
- **槽位保持 kernel 后端中立。** 头部、后端特定面板、composer 状态栈、本地化的
  转录不可用 UI 均以槽位传入（`header`、`panels`、`composerStatus`、`transcriptError`）。
  状态栈与用量统计需要比当前保守 `statusFacts`（`queueLength`/`goalActive`）更丰富的
  事实，故由宿主页提供，直至 parity 落地。

## 延后到后续增量

- **daemon 主列切换 + 视觉前后对比门（2f）。** `App.tsx` 以 daemon 绑定渲染
  `ChatSurface`，删除重复的内联编排；视觉预览须无未解释的 daemon 侧差异。
- **状态栈 / 用量统计 parity（slice 5）**，待 `statusFacts` 携带完整排队 prompt 与
  goal 事实。
- **managed 适配器（slice 3）** 与 **ChatPane 收敛（slice 4）** 经由同一组件渲染。

## 遵守的约束

- `chat-core` 自身模块不 import `daemon/**` 或 `@qwen-code/sdk/daemon` 值；
  `ChatSurface` 组合的共享组件仅带 type-only SDK 导入（构建期擦除），已对全部八个核实。
- 不改 daemon/Java 路由或 OpenAPI；会话 id 命名空间与存储键不变（composer 经
  `sessionId` 复用既有草稿键约定）。
- 契约扩展是增量且后端中立的；daemon 绑定是当前唯一填充的适配器。
