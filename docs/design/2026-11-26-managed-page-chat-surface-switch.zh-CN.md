# 将 ManagedSessionsPage 聊天列切换至共享 ChatSurface（Slice 3c 第三增量）

[English](2026-11-26-managed-page-chat-surface-switch.md) |
[简体中文](2026-11-26-managed-page-chat-surface-switch.zh-CN.md)

状态：已实现（slice 3c 第三增量——ManagedSessionsPage 切换至 ChatSurface）。
日期：2026-11-26。属于
[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md) 迁移的一部分，构建在
`ChatSurface` 面向 Managed 宿主的切换就绪（#18246）与退场
`ManagedQuestionForm` 统一至共享 `AskUserQuestion`（#18273）之上。

## 问题陈述

#18273 合入后，`ManagedSessionsPage` 已全部复用共享的四个聊天原语
（`MessageList`、`ToolApproval`、`AskUserQuestion`、`ChatEditor`），但仍由
页面内联编排，尚未切换为由 Managed 适配器驱动的共享后端中立 `<ChatSurface>`。

在 `ManagedSessionsPage` 直接渲染 `<ChatSurface>` 且不重复开启 SSE 流、不丢
失子会话动作隔离、不回退 Managed 持久化出箱与页面布局之前，必须打通三处具体
缝隙：

1. **共享实时 Managed hooks，避免重复开流。**
   `useManagedChatController` 目前内部自建 `useManagedSession`、
   `useManagedActions` 与 `useManagedTurnCancel`。而 `ManagedSessionsPage` 的
   侧边栏、页头、恢复判决、worktree 状态、面板与子控制器已持有这套 hooks；若
   直接叠加调用 `useManagedChatController`，将为同一会话打开第二条 SSE 流并
   重复轮询 `/sessions/get`、`/transcript/query` 与 `/actions/query`。
2. **子会话动作身份隔离与过期动作展示对齐。**
   `ManagedSessionsPage` 将根会话与子会话待处理动作合并展示（两个子会话可能
   共享相同的 `actionId`），并在动作过期时保留禁用卡片及 `managed.question.expired`
   状态提示。`createManagedChatController` 目前仅按裸 `actionId` 缓存投影、将
   根会话 `messages` 传给所有审批投影，并直接过滤掉已过期动作。
3. **`ChatSurface` 的后端中立宿主缝隙。**
   `ManagedSessionsPage` 需要向共享界面透传页面持有的转录属性
   （`welcomeHeader`、`onToolResultOpen`、`showRetryHint`、`tailContent`、
   `hideSessionTimeline`）、决策卡外框（多动作切换器、子会话来源提示、过期/
   超限/参数截断说明、`managed-approval` 测试锚点）、编辑器属性（模型/模式/计
   划/上下文/技能/文件引用/附件/占位文案）、持久化 pending 提交（含 `/btw`、
   `/recap`、运行中消息队列与 IndexedDB 出箱）、保留
   `[data-managed-home][data-managed-empty]` 居中规则的布局类名，以及在决策
   卡打开时保持编辑器可见。

## 范围

- **`use-managed-actions.ts`：**
  - 为 `respond` 新增可选第三参数 `observer?: ManagedAgentOperationObserver`，
    原样透传给 `provider.actions.respond(...)`。
  - 返回 `Promise<boolean>`（响应成功或终态 `endedAction` 关闭卡片时返回
    `true`；非待处理或在飞早退返回 `false`；可重试错误仍按原样抛出）。
- **`chat-controller.ts`：**
  - 将 `pendingProjection.requests` 缓存键改为
    `${action.sessionId}:${action.actionId}`，防止不同子会话同 `actionId`
    撞车。
  - 仅在 `action.sessionId === deps.sessionId` 时向
    `toManagedPermissionRequest` 传入 `messages`，防止根会话消息混入子会话审
    批参数预览。
  - 为 `ManagedChatControllerDeps` 新增可选 `retainExpiredActions?: boolean`
    （默认 `false`）。开启时在 `pendingApprovals`/`pendingQuestions` 中保留过
    期动作供页面展示禁用提示，同时 `respondApproval`/`respondQuestion` 仍
    fail-closed 拒绝过期提交。
- **`use-managed-chat-controller.ts`：**
  - 导出 `useManagedChatControllerFromState(options)`，接收调用方已持有的
    `detail`、`pending`、`turnCancel` 与共享 `cancelObserverRef`（以及
    `messages`、宿主当前选中的单个 `selectedAction`、`retainExpiredActions`、
    `canRespondAction`、`canCancel`），让 `ManagedSessionsPage` 以零重复
    SSE 流、零重复轮询绑定实时 `SessionChatController`。将 `selectedAction`
    限定为单个选中动作可从类型上杜绝多个子会话同 `actionId` 时的裸 ID 提交
    歧义。
  - 审批与提问提交经由 `pending.respond(action, response, observer)` 单次派发，
    同步驱动 `useManagedActions` 状态（`submitting`、`answerError`、
    `respondForbidden`、草稿清理、已答过滤）与控制器的准入/结算观测，并对子会
    话动作按 `action.sessionId` 校验。
  - 保留独立导出 `useManagedChatController({ provider, clientId, sessionId })`
    的原有契约与严格准入语义零变化。
- **`ChatSurface.tsx`：**
  - 新增全部由 `ManagedSessionsPage` 实际消费的后端中立宿主缝隙（零死开关）：
    `className`、`transcriptClassName`、`transcriptProps`、`decisionClassName`、
    `decisionTestId`、`decisionHeader`、`decisionFooter`、`approvalKey`、
    `approvalExtraDescriptionId`、`questionKey`、`askUserInitialDraft`、
    `askUserOnDraftChange`、`askUserSubmitDisabled`、`hideComposerWhenCardActive`
    （默认 `true`）、`composerClassName`、`composerVisible`（默认 `true`）、
    `composerKey`、`composerRef`、`composerContainerRef`、`composerFooter`、
    `composerCancelEnabled`（默认 `true`）、`onComposerSubmit` 与
    `composerProps`。
  - 省略上述可选属性的既有调用方行为 100% 不变。`ChatSurface` 仍绝不按
    `controller.kind` 分支。
- **`ManagedSessionsPage.tsx`：**
  - 在除 `!sessionId && provider.workspaceBinding`（工作区绑定创建页）外的全
    部聊天列状态改由 `<ChatSurface>` + `useManagedChatControllerFromState` 渲染。
  - 删除内联的 `<MessageList>`、`<ToolApproval>`、`<AskUserQuestion>`、
    `<ChatEditor>`、重复的 `pendingQuestionRequest`/`pendingApproval` 投影缓
    存以及内联 `cancel` 回调；`ManagedSessionsPage` 不再直接导入
    `MessageList`、`ToolApproval`、`AskUserQuestion`、`ChatEditor`、
    `toManagedPermissionRequest` 或 `toManagedQuestionPermissionRequest`。

### 明确不在本增量范围（延后至后续增量）

- 将 `ManagedSessionsPage` 的持久化 pending 出箱（`pendingHere`、
  `pendingElsewhere`、`managed-pending-storage.ts`、`/btw`、`/recap`、
  `userMessages` 队列）整体迁入 `useManagedChatController`（本增量通过
  `onComposerSubmit` 承接，待后续收敛迁移）。
- Daemon 主列切换（`App.tsx`，2f 余项）、`ChatPane` 收敛（slice 4）、状态栈/
  统计对齐（slice 5）与 slice 6 产物边界守卫。
- 不改 daemon/Java 路由、OpenAPI schema、存储键或 i18n 键。

## 设计决策与理由

1. **提供共享状态入口 `useManagedChatControllerFromState` 并保留独立 `useManagedChatController`。**
   - 在不违反 React Hooks 规则且不改变 3b 严格独立契约的前提下，彻底避免重复挂
     载 `useManagedSession`（SSE + 转录请求）、`useManagedActions`（轮询 + 子
     会话动作 + 草稿 + 禁止闩锁）与 `useManagedTurnCancel`（持久化取消意图 +
     操作轮询）。
2. **通过 `pending.respond(action, response, observer)` 单次派发动作响应。**
   - 让 `useManagedActions` 的禁止闩锁、错误提示、草稿清理、已答过滤与控制器意
     图台账保持一致。当单测 mock 的 `provider.actions.respond` 未触发
     `onAccepted` 却正常 resolve 时，`useManagedChatControllerFromState` 将已
     完成调用视为已准入（仍绝不在缺少 `onSettlement` 时伪造 `established`），
     而独立 `useManagedChatController` 继续保持严格的 `unknown` 规则。
3. **投影期按需保留过期动作（`retainExpiredActions: true`），对权限与提问统一禁用展示且提交期保持 fail-closed 拒绝。**
   - 保留 Managed 在过期卡片上的体验（经统一的 32 位安全定时器禁用控件，提问
     展示 `managed.question.expired`，权限展示 `managed.actions.expired`），
     同时控制器提交入口的 `isActionExpired` 不变量（含时钟跳变保护）继续生效。
4. **保留布局类名与 `onComposerSubmit` 缝隙。**
   - 透传 `shellStyles.content` 与 `shellStyles.footer` 保证
     `[data-managed-home][data-managed-empty]` 居中与 `--chat-shell-width` 零
     视觉回归。
   - 通过 `onComposerSubmit` 保留 Managed 持久化 IndexedDB 出箱与 `/btw`/
     `/recap`/`userMessages` 队列，避免与 `ChatSurface` 的瞬态
     `admission-locked-banner` 冲突并保持 `managed-draft-retry.spec.ts` 完整有效。

## 约束与风险

- **对既有 `ChatSurface` 调用方与测试零回归：** 新增属性全部可选，默认行为与
  主干完全一致（`hideComposerWhenCardActive = true`、`composerVisible = true`、
  `composerCancelEnabled = true`）。
- **零重复网络流量：** 在 `ManagedSessionsPage.test.tsx` 与本地真实 HTTP/SSE
  Chromium 验证中断言 `getSession`、`getTranscript`、`subscribeEvents` 与
  `actions.listPending` 不因接入 `<ChatSurface>` 而翻倍。
- **视觉对齐：** 通过同一真实 Managed 会话装置在改前/改后截取 Chromium 对比图
  目视核验零布局漂移。

## 验证计划与验收标准

- **单测与集成测试：**
  - `ManagedSessionsPage.test.tsx`（全部 262+ 既有测试保持全绿，并新增断言确
    认渲染 `[data-testid="chat-surface"]`、无重复 `subscribeEvents`/`listPending`
    调用，且取消经 `ChatSurface` → `controller.cancel()` 派发）。
  - `use-managed-chat-controller.test.tsx`：独立 22 条测试零改动全绿 + 新增
    `useManagedChatControllerFromState` 用例（共享 hooks 无重复订阅、子会话动
    作应答与结算、`canRespondAction` 阻塞、`retainExpiredActions` 展示但提交
    拒绝、`canCancel: false` 门控）。
  - `chat-controller.test.ts`：子会话同 `actionId` 缓存隔离、子会话审批不混入
    根会话 `messages`、以及 `retainExpiredActions: true` 展示但提交拒绝。
  - `ChatSurface.test.tsx`：覆盖全部新增宿主缝隙（`transcriptProps`、
    `decisionHeader`/`decisionFooter`/`decisionTestId`、`askUser*`、
    `hideComposerWhenCardActive={false}`、`composerVisible={false}`、
    `composerCancelEnabled={false}`、`onComposerSubmit`、`composerProps`、
    `composerFooter`）。
  - `use-managed-actions.test.tsx`、`chat-controller.local-integration.test.tsx`、
    `build-artifact.test.ts`。
- **变异见证：** 全部可达新增守卫与分支在独立变异装置下验证转红。
- **静态门禁：** `tsconfig.lib.json`、`tsconfig.json`、改动行严格测试 `tsc`、
  `eslint --max-warnings=0`、`prettier --check`、全仓
  `npm run build && npm run typecheck`。
- **本地真实浏览器 Before/After E2E：** 真实本地 HTTP/SSE 服务 + Vite +
  Chromium（`<StrictMode>`）在未改动 `a3560a089b01`（改前）与切至
  `<ChatSurface>` 后（改后）挂载 `ManagedSessionsPage`，验证视觉布局一致、SSE
  连接计数严格唯一（`=== 1`）、多行子会话草稿往返、503 重试同幂等键、32 KiB
  限额、实时过期、prompt 提交与经 `<ChatSurface>` 触发的 turn cancel，0
  pageerror / 0 非预期 consoleerror。

## 未决问题

- 后续收敛可将 Managed 持久化 pending 出箱与用户消息队列下沉至控制器层从而移
  除 `onComposerSubmit`，并将 `App.tsx`（2f）与 `ChatPane.tsx`（slice 4）收拢
  至同一套 `ChatSurface` 宿主缝隙。
