# Managed 聊天控制器适配器核心（切片 3a）

[English](2026-11-22-managed-chat-controller.md) |
[简体中文](2026-11-22-managed-chat-controller.zh-CN.md)

状态：已实现（切片 3a——Managed 适配器核心）。日期：2026-11-22。属于
[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)迁移的一部分。基于已合入的
契约（#17520）、daemon 适配器与 `ChatSurface`（#17684、#17709、#17794、#17895、
#17952、#18066、#18091）。

## 范围

本切片在 `packages/web-shell/client/components/managed/` 下落地纯依赖注入的
Managed 适配器核心，复用切片 1 已落地的 `components/managed/chat-capabilities.ts`，
并镜像 `client/daemon/chat-controller.ts` 的结构，且零导入任何 `daemon/**` 模块：

- **`components/managed/chat-capabilities.ts`** —— 在既有穷举式
  `MANAGED_CHAT_CAPABILITY_MAP` 与三态 `isManagedCapabilityOn` 之上新增
  `managedCapabilitiesFromSummary(...)`。
- **`components/managed/chat-controller.ts`** —— 实现 `SessionChatController`
  （`kind: 'managed'`）的 `createManagedChatController(deps)`，以及纯助手
  `mapManagedPhase`、`mapManagedOperationStatus`、
  `toManagedQuestionPermissionRequest` 与 `normalizeManagedQuestionAnswers`。
- **Daemon 遗留 P3 钉子** —— 在 `daemon/useDaemonChatController.test.tsx` 中补齐
  #18091 评审留下的非阻塞 P3 用例，钉住 `!settledDuringSubmit.has(accepted.promptId)`，
  防止在 `submitPrompt` 解析前已结算的 prompt 被错误注入重建后的控制器。

本增量是加法的：尚未切换 `ManagedSessionsPage`。React 绑定 hook
（`useManagedChatController`）与带视觉前后对比门的 `ManagedSessionsPage` 切换属于
切片 3b 与 3c。

## 设计

### 能力投影（`components/managed/chat-capabilities.ts`）

`managedCapabilitiesFromSummary` 基于既有穷举式 `MANAGED_CHAT_CAPABILITY_MAP`
与 `isManagedCapabilityOn`（严格 `=== true`，因 `terminal` 类型为三态
`boolean | null | undefined`）将 `ManagedAgentSessionSummary['capabilities']`
投影为 `ChatCapabilities`：

- `modelChange` → `modelSelection`
- `approvalModeChange` → `approvalSelection`
- `contextCompression` → `contextUsage`
- `tasks`、`childAgents` → `tasks`
- `artifacts` → `artifacts`
- `diagnostics` → `diagnostics`
- `terminal` → `terminal`
- `canRename`、`sessionClose`、`sessionArchive`、`sessionUnarchive`、
  `sessionDelete` → `sessionOps`

其余标志（`canSend`、`canCancel`、`actions`、`workspaceTurns`、
`inputAttachments`、`btw`、`recap`、`clientFiles`）均映射为 `[]`。

### 纯控制器组装（`components/managed/chat-controller.ts`）

`createManagedChatController(deps)` 将 Managed 会话状态、待处理动作与 Java 命令操作
投影为 `SessionChatController`：

- **相态投影（`mapManagedPhase` + `deriveChatPhase`）。** 穷举映射全部 10 个
  `ManagedAgentSessionPhase` 取值（`created`/`completed`/`cancelled` → `'idle'`，
  `failed` → `'failed'`，`cancelling` → `'cancelling'`，活跃运行/工具态 →
  `'running'`），并与 `operations` 组合：任一非终态 `cancel`（包括
  `recovery_blocked` 带来的 `unsettled`）均将运行中会话提升为 `'cancelling'`，
  在飞 `submit` 将空闲/失败会话提升为 `'submitting'`。
- **准入 ≠ 建立。** `submit`、`cancel`、`respondApproval` 与 `respondQuestion` 各自
  通过返回 `ManagedTransportAdmission` 的 `deps.*` 派发。`'rejected'` 不入账且省略
  `outcome`（与 `contract.ts` 和 daemon 适配器对齐）；`'unknown'` 或抛错移除追踪
  行，避免 `phase` 永久卡死。`'accepted'` 保持 `'pending'`（`outcome: 'unsettled'`），
  仅在权威结算证据到达时推进：`subscribeOperationSettlement`（`completed` →
  `'established'`，`failed`/`cancelled` → `'failed'`，`recovery_blocked` →
  `'unsettled'`）、`subscribeTurnSettlement`（按操作类型投影：回合自行完成使绑定
  的 `cancel` 转为 `'failed'`）或 `subscribeActionSettlement`（`resolved` →
  `'established'`，`expired`/`superseded`/`failed` → `'failed'`）。已终态行永不
  吸收后续结算；存在在飞派发时，未命中活跃行的 operation 结算按 `operationId` 缓
  冲，而 turn 与 action 结算（其 id 在 submit 与 cancel 或多次尝试间共享）只要有在
  飞派发即缓冲，使尚未绑定的在飞 cancel 或重试即使在前序行仍活跃时也能收到结算；
  operation/action 缓冲在绑定时消费删除，且三者均在所有在飞派发排空时清空。
- **回合作用域取消与按目标保留。** `deps.activeTurnId` 为 `undefined` 时 `cancel()`
  fail-closed 返回 `rejected`（Managed 取消要求 `turnId`）；派发时捕获
  `cancelTarget = deps.activeTurnId`，保留在 `controller.operations` 中的操作目标
  保持裸 `{ sessionId }`，使 `retainOperations` 按 `(kind, target)` 最多保留一条
  终态行（`submit`/`cancel` 每会话一条，`approval`/`question` 按 `requestId` 各一
  条，与 daemon 适配器一致），并将 `turnId: cancelTarget` 写入返回的
  `IntentResult.target` 副本，使 `ChatSurface` 的回合级取消守卫对 Managed 会话同样
  生效。
- **待审批与待提问投影。** 已过期动作（`expiresAt <= now`，使用可选 `deps.now`，默
  认 `Date.now`）在两处投影 getter 中过滤并在 `respondApproval`/`respondQuestion`
  入口拒绝。权限动作（`kind !== 'question'`）复用既有
  `toManagedPermissionRequest(action, messages)`；提问动作（`kind === 'question'`）
  经 `toManagedQuestionPermissionRequest` 投影为共享 `AskUserQuestion` 卡片所需的
  `PermissionRequest`，仅投影 `allow_once` `'submit'` 选项（Managed 提问协议无字符
  串选项忽略变体，故 `respondApproval` 对提问动作直接 fail-closed 返回 `rejected`）。
  `respondApproval` 与 `respondQuestion` 对未知或已过期动作 id、非法选项、同一
  `actionId` 的在飞或活跃非终态决策行（`hasLiveAction`，与 daemon 适配器的
  `hasLiveDecision` 对齐，既防止同一动作被决策两次又允许终态 `failed` 行重试）、以及
  非法、有歧义、缺失必填项或超体积上限的回答均 fail-closed 返回 `rejected`
  （`normalizeManagedQuestionAnswers` 同时接受十进制索引与显式问题 id，单选要求唯
  一选项命中、多选经按逗号边界的有界 O(k·|options|) DP 要求唯一完整覆盖——对重复选
  项标签与 `Alpha`+`Beta` 撞 `Alpha, Beta` 的拼接碰撞均 fail-closed 返回 `null`，
  在切片 3c 传入结构化选项 id 前，自由文本或扁平字符串混合「选项 + 文本」在
  `allowText: true` 时原样保留为 `text`、`allowText: false` 时拒绝——严格校验
  `required`、单条 8192 字符上限，并经由 `canonicalQuestionAnswers` 实施规范排序与
  32 KiB `MAX_MANAGED_QUESTION_ANSWER_BYTES` 上限）。
- **快照稳定与生命周期。** `operations` 记忆化为冻结数组，仅在追踪状态变化时重建。
  `deps.signal` 触发 abort 时释放全部结算订阅；构造时若 `deps.signal?.aborted` 已为
  `true` 则同步跳过订阅。

## 遵守的约束

- `components/managed/chat-capabilities.ts` 与
  `components/managed/chat-controller.ts` 零导入 `daemon/**`。
- 不做 daemon↔Java 协议互转：适配器直接将 Java 原生 summary/action/operation 结构
  投影到 `SessionChatController`。
- 无 Java 路由、OpenAPI、会话 id 命名空间或存储键变更。
- 加法：尚无生产页面经由 `createManagedChatController` 渲染；浏览器视觉前后对比门
  属于页面切换（切片 3c）。

## 验证

- `components/managed/chat-capabilities.test.ts` 覆盖空值/`null`/关闭态及全部映射
  能力键的 one-hot 映射与严格 `terminal === true` 门控。
- `components/managed/chat-controller.test.ts` 覆盖穷举相态与操作状态映射、实时
  one-hot 分页透传与 `loadOlder({ force: true })`、权限/提问拆分与投影、提问答案
  归一化与 fail-closed 拒绝、四个意图的准入/结算分离（含提前到达缓冲、
  `recovery_blocked`、派发期 cancel `turnId` 盖章、回合自行完成令 cancel 失败、并发
  重复拦截）、快照引用稳定性与 `AbortSignal` 清理。
- `daemon/useDaemonChatController.test.tsx` 补齐钉住
  `!settledDuringSubmit.has(accepted.promptId)` 的 P3 竞态用例。
- 全套测试绿；web-shell 两个类型项目（`tsconfig.lib.json`、`tsconfig.json`）退出 0；
  ESLint 与 Prettier 干净。

## 延后（切片 3b–3c 与后续）

- **切片 3b —— `useManagedChatController` 绑定 hook**：将 `useManagedSession`、
  `useManagedPendingActions` 与 `ManagedAgentProvider` 接入
  `createManagedChatController`。
- **切片 3c —— `ManagedSessionsPage` 切换至 `ChatSurface`** 并过浏览器级视觉前后
  对比门（实现双模式首个真实 UI 收敛）。切换前需明确共享 `AskUserQuestion` 卡片是
  否学习 `required` 与 `allowText`（以及是否改为传递结构化选项 id 而非逗号拼接的标
  签），使可选题可跳过、`allowText: false` 题目不再展示必然被适配器拒绝的自由文本框。
- **Daemon 主列切换（2f 其余）**、**ChatPane 收敛（slice 4）**、**状态栈 parity
  （slice 5）** 与 **边界守卫（slice 6）**。
