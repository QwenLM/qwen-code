# Daemon 聊天控制器绑定（Slice 2d）

[English](2026-11-20-daemon-chat-binding.md) |
[简体中文](2026-11-20-daemon-chat-binding.zh-CN.md)

状态：已实现（slice 2d，绑定 hook）。日期：2026-11-20。属于
[统一聊天界面](2026-11-16-unified-chat-surface.md)迁移的一部分。建立在已合入的
契约（#17520）、状态栈（#17684）、意图引擎（#17709）与控制器组装（#17794）之上。

## 范围

Slice 2c 落地了 `createDaemonChatController(deps)`——依赖注入、后端中立、无需
provider 即可测试的组装。本切片落地**绑定 hook** `useDaemonChatController()`，
从活的 `DaemonSessionProvider` 状态构造该控制器，使 daemon 聊天列能由共享的
`SessionChatController` 契约驱动。它本身不渲染任何内容；`ChatSurface` 组件与主列
切换（带视觉前后对比门）是下一增量。

## 设计

- **每会话一个控制器。** hook 按 `connection.sessionId` 构造一次控制器，会话变化
  时重建（并重置权限跟踪状态）。活事实（messages、transcript 态、待处理审批、能力、
  状态事实）经 getter 读取一个每次渲染更新的 ref，故长生命周期的控制器总能看到当前
  provider 状态而无需重建。
- **transport 包装会话动作。** `submitPrompt` 把 composer 输入映射到
  `actions.submitPrompt` 并转发 daemon 的 `onAdmitted` prompt id；`cancelPrompt`、
  `submitPermission`、`submitQuestionAnswers` 包装对应动作并把结果映射为 admission
  （`accepted`/`rejected`/抛错时 `unknown`）。被拒的应答不再跟踪，故不会播种决策信号。
  问题应答应投票该请求的提交（`allow_once`）选项并附带答案——与
  `AskUserQuestion.handleSubmit` 相同的 wire 形状，由 `questionSubmitOptionId`
  查找；不带 optionId 投票会发出 `cancelled` 结果，丢弃答案并取消问题，故缺失提交
  选项时是 `rejected` admission，而非取消投票。
- **prompt 结算**由 `useDaemonPromptSettled`（终态 `turn_complete`/`turn_error`/
  cancelled 事件）桥接到控制器的 `subscribePromptSettlement`，按 `promptId` 键控。
- **approval 时效与决策结算是派生的**，因为 provider 没有显式通道。纯助手
  `derivePermissionSignals` 跨渲染 diff 待处理权限集合：
  - 新出现的待处理请求标为存活；
  - **本控制器已应答**的请求离开待处理集合时，发出 `applied: true` 决策结算
    （块解析是 daemon 已应用该应答的权威证据），并保持存活使决策能建立——引擎在
    建立时自行释放身份；
  - **未经本控制器应答**就离开待处理集合的请求是被取代，标为不存活。
    该助手是纯函数且有单测；hook 用 ref 保存上一次待处理集合与已应答集合，并把派生
    信号转发给控制器。
- **存储键**复用 `getComposerDraftStorageKey(sessionId, workspaceCwd)`，使表面的
  草稿持久化与既有 daemon composer 一致。
- **能力**由 `connection.capabilities.features` 经穷举的
  `DAEMON_CHAT_CAPABILITY_MAP` 派生（未知 tag 跳过）。

## 保守绑定（ChatSurface 增量的后续）

- `pendingQuestions`、`statusFacts.queueLength`、`statusFacts.goalActive` 尚无
  直接的 provider 选择器/hook；此处保守绑定（空/0/false），待状态栈与问题区域切换
  时接到真实来源。
- `settledPhase` 为 `idle`；失败会话的 phase 将在需要时从 connection 态派生。
- 可选的能力门控子控制器（模型选择、审批模式、上下文用量、会话操作）尚未绑定；其
  区域在后续增量接线前保持隐藏。契约的 `acknowledge` 暴露（释放已消费终态行）也随
  表面落地。

## 遵守的约束

- 不改 daemon 路由、Java 路由或 OpenAPI；不改 UI 行为（hook 尚未被渲染）。
- hook 位于 `daemon/`、在 `chat-core` 之外；它导入契约、控制器与 provider，
  `chat-core` 不导入它。
- 会话 id 命名空间与存储键不变（草稿键是复用，而非重定义）。
