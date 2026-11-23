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
- **结构化提问交接** —— 经 `QuestionAnswer`、`ChatSurface` 与共享
  `AskUserQuestion` 卡片传递问题和选项 `id`，同时为既有宿主保留原
  `Record<string, string>` 答案。

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
  吸收后续结算。operation 只在存在在飞派发时缓冲未命中活跃行的结算；turn 因在
  submit 的传输响应到达前不知道 `turnId`，也在存在在飞派发时缓冲；action 仅在
  其 `actionId` 位于 `inFlightActionIds` 时缓冲。operation 与 turn 缓冲记录到达时最新
  已启动的派发序号，绑定时只有当时已经启动的尝试才能消费，故无关派发不能把旧 turn
  或 action 证据泄漏给稍后发起的重试。即使共享 `turnId` 的 submit 行仍活跃，尚未绑
  定的在飞 cancel 仍能消费 turn 结算。operation/action 缓冲在消费时删除，三者均
  在所有在飞派发排空时清空。
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
  `PermissionRequest`，携带问题和选项 `id` 且仅投影 `allow_once` `'submit'` 选项
  （Managed 提问协议无字符串选项忽略变体，故 `respondApproval` 对提问动作直接
  fail-closed 返回 `rejected`）。卡片为既有宿主保留原有
  `Record<string, string>` 答案参数，在后端 id 可用时额外给出结构化
  `QuestionAnswer`，将所选 `optionIds` 与自由文本 `text` 分开，即使文本恰等于另
  一选项的标签或标签带首尾逗号也不混淆。`ChatSurface` 直接转发结构化答案，不
  再反解标签。`normalizeManagedQuestionAnswers` 严格校验结构化 id、重复值、数量、
  `allowText`、`required` 和单条文本 8192 字符上限，并经由
  `canonicalQuestionAnswers` 实施规范排序与 32 KiB
  `MAX_MANAGED_QUESTION_ANSWER_BYTES` 上限。无 id 的旧调用方仍按单选唯一命中与
  多选有界 O(k·|options|) DP 处理，比较两侧做同一逗号规范化，对重复标签与
  `Alpha`+`Beta` 撞 `Alpha, Beta` 的拼接碰撞 fail-closed；仅在
  `allowText: true` 时，未匹配的扁平字符串 `option, free text` 载荷原样作为
  `text`。`respondApproval` 与 `respondQuestion` 还对未知或已过期动作 id、非法选
  项、同一 `actionId` 的在飞或活跃非终态决策行（`hasLiveAction`，与 daemon 适配
  器的 `hasLiveDecision` 对齐，既防止同一动作被决策两次又允许终态 `failed` 行重
  试）fail-closed 返回 `rejected`。
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
  `ManagedCapabilityKey` 的 one-hot 映射与严格 `terminal === true` 门控。
- `ChatSurface.test.tsx`、`AskUserQuestion.test.tsx` 与
  `components/managed/chat-controller.test.ts` 钉住结构化交接，包括选择
  `Dry run` 的 id 加独立输入的 `Verbose`，且全部既有旧三参数提交保持不变。
- `components/managed/chat-controller.test.ts` 覆盖穷举相态与操作状态映射、按尝试
  归属的结算缓冲（含旧 action/turn 证据后重试）、实时
  one-hot 分页透传与 `loadOlder({ force: true })`、权限/提问拆分与投影、提问答案
  归一化与 fail-closed 拒绝、四个意图的准入/结算分离（含提前到达缓冲、
  `recovery_blocked`、派发期 cancel `turnId` 盖章、回合自行完成令 cancel 失败、并发
  重复拦截）、快照引用稳定性与 `AbortSignal` 清理。
- `components/managed/chat-controller.local-integration.test.tsx` 挂载真实的
  `ChatSurface`、共享提问卡片与 Managed 控制器，通过 DOM 驱动翻页、选择及
  自由文本输入并断言精确传输载荷；仅隔离本切片范围外的 daemon 转录与编辑器宿主。
  Java provider 绑定仍属切片 3b，因此这不是连接真实 Java 服务的测试。
- `daemon/useDaemonChatController.test.tsx` 补齐钉住
  `!settledDuringSubmit.has(accepted.promptId)` 的 P3 竞态用例。
- 全套测试绿；web-shell 两个类型项目（`tsconfig.lib.json`、`tsconfig.json`）退出 0；
  ESLint 与 Prettier 干净。

## 延后（切片 3b–3c 与后续）

- **切片 3b —— `useManagedChatController` 绑定 hook**：将 `useManagedSession`、
  `useManagedPendingActions` 与 `ManagedAgentProvider` 接入
  `createManagedChatController`。
- **切片 3c —— `ManagedSessionsPage` 切换至 `ChatSurface`** 并过浏览器级视觉前后
  对比门（实现双模式首个真实 UI 收敛）。切换前让共享 `AskUserQuestion` 卡片学习
  `required` 与 `allowText`，使可选题可跳过、`allowText: false` 题目不再展示必然
  被适配器拒绝的自由文本框。结构化选项 id 与独立自由文本已由本切片携带。
- **Daemon 主列切换（2f 其余）**、**ChatPane 收敛（slice 4）**、**状态栈 parity
  （slice 5）** 与 **边界守卫（slice 6）**。
