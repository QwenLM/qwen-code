# 退场 ManagedQuestionForm 并统一到共享 AskUserQuestion（Slice 3c 第二增量）

[English](2026-11-24-managed-ask-user-question-switch.md) |
[简体中文](2026-11-24-managed-ask-user-question-switch.zh-CN.md)

状态：已实现（slice 3c 第二增量——Managed 提问卡片收敛）。日期：2026-11-24。
属于 [统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md) 迁移的一部分，构
建在 `ChatSurface` 面向 Managed 宿主的切换就绪（#18246）之上——共享
`AskUserQuestion` 已具备 `required`、`allowText`、`maxTextLength`、按需隐藏
Ignore 与 `disabled` 能力。

## 问题陈述

`ManagedSessionsPage` 现已复用共享的 `MessageList`、`ToolApproval` 与
`ChatEditor`，但对于待处理 Managed 问题动作仍单独渲染定制的
`ManagedQuestionForm`——这也是仓库中 `ManagedQuestionForm` 仅剩的唯一调用方。

在 `ManagedSessionsPage` 退场 `ManagedQuestionForm`、切换到共享
`AskUserQuestion` 且不回退任何 Managed 生产行为之前，必须满足四项具体要求：

1. **跨待处理动作切换保留草稿。** `useManagedActions` 同时列出根会话与子会话
   的待处理动作（`includeChildren`），并按动作维护草稿（`questionDraft` /
   `setQuestionDraft`），使用户在某道题答到一半时切去查看其他待处理请求或审
   批、再切回时不会丢失草稿。共享 `AskUserQuestion` 目前仅将答案留在内部状态，
   卸载重挂即丢失。
2. **内容稳定的 `PermissionRequest` 投影。** `ManagedSessionsPage` 目前在依赖
   `messages`（每次流式 delta 都会换新数组引用）与原始 `approvals.action`（每
   次轮询或 `expiresAt` 续期都会换新对象引用）的 `useMemo` 里重建
   `pendingApproval`。若直接把未缓存的 `toManagedQuestionPermissionRequest`
   结果传给 `AskUserQuestion`，每次流式更新或轮询都会改变 `request.rawInput`
   并清空用户正在填写的答案。
3. **32 KiB 合并 UTF-8 答案字节上限且不锁死输入框。** Managed 答案序列化后的
   UTF-8 字节总长不得超过 `MAX_MANAGED_QUESTION_ANSWER_BYTES`（32 KiB），单题
   文本不得超过 8192 字符。超限时必须阻断提交并显示本地化的
   `managed.question.tooLarge` 警告，同时保持文本输入框可编辑以便用户删短内容。
4. **实时过期门控。** 当待处理问题的 `expiresAt` 到期（挂载时已过期，或展示期
   间经有界定时器到期），卡片必须切换为禁用态、阻断提交（含提交时刻的
   `Date.now() >= action.expiresAt` 校验）并展示本地化的
   `managed.question.expired` 状态提示。

## 范围

- **为 `AskUserQuestion` 增加后端中立的草稿与禁提交缝隙：**
  - 导出 `AskUserQuestionDraft`
    （`Record<string, { optionIds: string[]; text: string }>`），新增可选属性
    `initialDraft?: AskUserQuestionDraft`、
    `onDraftChange?: (draft: AskUserQuestionDraft) => void` 与
    `submitDisabled?: boolean`（默认 `false`）。
  - 在 `useState` 惰性初始器中同步（以及在后续 `(questions, request.id)` 身份变化时）
    从 `initialDraft` 恢复 `answers`、`selectedMulti`、`customInputs` 与初始
    `selectedIdx`，避免 React 19 `StrictMode` 下首帧空草稿闪烁，并在单选题已有
    恢复的自定义文本时不再自动预选第 0 项。
  - 通过受脏标记门控的 commit 期 `useEffect` 通知 `onDraftChange`（挂载时不
    被动发射、不在 React state updater 内触发父级更新，并用 ref 持有回调以防
    内联箭头触发多余重跑）。
  - `submitDisabled` 仅作用于提交路径（Submit 按钮、`Ctrl+Enter`/`Cmd+Enter`
    与末题 `Enter` 提交），选项与文本输入框保持可编辑。
  - 在 `Question` 上支持可选 `multilineText?: boolean`（由
    `toManagedQuestionPermissionRequest` 投影为 `true`，单行 Daemon 问题省略
    默认 `false`）。当 `multilineText` 为真或当前自定义文本已包含 `\n` 时渲
    染 `<textarea>`（`Shift+Enter` 换行，单独 `Enter` 前进/提交）并在折叠触发
    器上使用 `white-space: pre-wrap`，确保多行自定义答案在草稿恢复与编辑往
    返中不丢失换行。
- **将 `ManagedSessionsPage` 从 `ManagedQuestionForm` 切到共享 `AskUserQuestion`：**
  - 将 `ManagedQuestionDraft` 类型与 `MAX_MANAGED_QUESTION_TEXT_LENGTH`（由
    `chat-controller.ts` 复用再导出以保持单一事实源）迁入
    `managed-question-response.ts`，解除 `use-managed-actions.ts` 对旧表单的依赖。
  - 在 `ManagedSessionsPage` 中通过按内容签名缓存的
    `toManagedQuestionPermissionRequest` 投影待处理 Managed 问题（以动作标识、
    修订号与序列化题目列表为键，显式排除 `expiresAt` 且不依赖 `messages`）。
  - 渲染以 `managedActionKey(action)` 为 `key` 的共享 `<AskUserQuestion>`，传入
    `variant="floating"`、`keyboardActive={false}`、
    `customInputLabel={t('managed.question.other')}`、
    `initialDraft={approvals.questionDraft}`、`onDraftChange`、`disabled`（无权
    限 / 提交中 / 压缩阻塞 / 已过期）、`submitDisabled={questionTooLarge}`，并
    通过 `onConfirm` 把规范结构化答案路由到 `approvals.respond`（完成返回
    `true`，可重试失败抛出以重置提交态并保留答案与幂等键）。
  - 在卡片旁展示 `managed.question.expired`（`role="status"`）与
    `managed.question.tooLarge`（`role="alert"`），配 32 位安全的过期定时器。
- **退场 `ManagedQuestionForm` 与孤儿 i18n 键：**
  - 删除 `ManagedQuestionForm.tsx` 与 `ManagedQuestionForm.test.tsx`，将其全部
    独特契约用例（重名/含逗号选项 ID、选项顺序、未裁剪自定义文本、刷新稳定、
    失败重试复用幂等键、重复提交栅栏、无权限/过期/32 KiB UTF-8 上限）迁移到
    `AskUserQuestion.test.tsx` 与 `ManagedSessionsPage.test.tsx`。
  - 从全部四个语种词表（`i18n.tsx`、`i18n-zh-cn.ts`、`i18n-zh-tw.ts`、
    `i18n-ru-part1.ts`）移除不再使用的 `'managed.question.title'`。

### 明确不在本增量范围（延后至后续增量）

- 用 `<ChatSurface>` 替换 `ManagedSessionsPage` 外层聊天列 JSX（slice 3c.3），
  需解决在不重复开启 SSE 流的前提下共享 `useManagedSession` /
  `useManagedActions` / `useManagedTurnCancel` 状态，并为 `ChatSurface` 提供
  类型化 transcript/composer 宿主缝隙。
- Daemon 主列切换（2f 余项）、`ChatPane` 收敛（slice 4）、状态栈/统计对齐
  （slice 5）与产物边界门禁（slice 6）。
- 不改 daemon/Java 路由、OpenAPI schema、session-id 命名空间或存储键。

## 设计决策与理由

1. **采用 `initialDraft` + commit 期 `onDraftChange`，而非全受控内部状态。**
   - `AskUserQuestion` 拥有复杂的键盘状态（roving tabindex、自定义输入焦点、多
     题翻页、单选自动预选）。若将其改为每次渲染全受控于外部草稿，会把键盘焦点
     管理与父级重渲染纠缠在一起，容易给 daemon 调用方引入回归。
   - 在 `(questions, request.id)` 挂载/重置时从 `initialDraft` 恢复（切换动作时
     由 `key={managedActionKey(action)}` 驱动重挂），并在 commit 期 `useEffect`
     向外同步用户编辑，既 100% 保持 daemon 零变化，又兼容 React 19 StrictMode，
     同时完整保留跨动作切回草稿的能力。
2. **将 `submitDisabled` 与 `disabled` 分离。**
   - 合并 UTF-8 字节超过 32 KiB 时，若用 `disabled` 锁住全部控件，用户将无法退格
     缩短输入。`submitDisabled` 仅拦提交、保持输入可编辑。
3. **在 `ManagedSessionsPage` 对 `toManagedQuestionPermissionRequest` 做内容键缓存。**
   - 将投影请求对象的引用稳定性与 `messages`、`expiresAt` 解耦，防止流式消息增
     量或轮询刷新重置 `AskUserQuestion` 局部状态与当前题号。
4. **过期定时器做 32 位上限守卫。**
   - 当 `expiresAt - Date.now()` 超过 `setTimeout` 的 32 位有符号整数上限（约
     24.8 天）时避免溢出立即触发过期。
5. **视觉 Before/After 门禁。**
   - Managed 问题 UI 由堆叠式 `ManagedQuestionForm` 转为共享浮动卡片
     `AskUserQuestion` 属于用户可见变化，需在真实 Chromium 上锚定同一 Managed 会
     话状态截取改前/改后对比图并目视确认。

## 约束与风险

- **对 daemon 零回归：** 省略 `initialDraft`、`onDraftChange`、`submitDisabled`
  时，所有 daemon 调用方行为保持完全一致。
- **逐题卡片与堆叠表单的交互差异：** 共享 `AskUserQuestion` 采用逐题展示（`1/2
questions`、`previous`/`next`）与键盘导航，与 Daemon 对齐。
  `ManagedSessionsPage.test.tsx` 中原本直接查多个堆叠 `<textarea>` 的两条用例需
  改写为驱动共享 `AskUserQuestion` 卡片，但保留全部线协议载荷、幂等键、失败重
  试与子会话草稿隔离断言。
- **多语种一致性：** 在全部四个词表同步删除 `'managed.question.title'`，避免残
  留孤儿键并保持 `i18n.test.ts` 对齐检查全绿。

## 验证计划与验收标准

- **单测与集成测试：**
  - `AskUserQuestion.test.tsx`：覆盖 `initialDraft` 恢复（单选选项 ID、单选自定
    义文本不触发首项自动预选、多选选项+自定义文本、忽略非法选项 ID）、
    `onDraftChange` commit 期发射（挂载不被动发射、追踪选择/输入/清空、内联回
    调不抖动），以及 `submitDisabled` 阻断 Submit 按钮、`Ctrl+Enter`、末题
    `Enter` 同时保持选项与文本输入可编辑。
  - `ManagedSessionsPage.test.tsx`：验证根会话与子会话 Managed 问题均渲染共享
    `AskUserQuestion`（无 `ManagedQuestionForm`、无审批按钮、无死按钮 Ignore）、
    流式刷新/轮询刷新与失败重试保留答案并复用同一幂等键、跨 `child-a` /
    `child-b` / 权限审批切换保留各自草稿、重复提交栅栏、32 KiB UTF-8
    `role="alert"` + `submitDisabled` 且输入框可编辑、实时过期 `role="status"` +
    禁用卡片。
  - `use-managed-actions.test.tsx`、`chat-controller.local-integration.test.tsx`、
    `i18n.test.ts` 与 `build-artifact.test.ts` 全绿。
- **变异见证：** 全部可达守卫与分支（挂载与同实例换请求的草稿水合、commit 期
  草稿发射、挂载不被动发射、自定义文本抑制首项预选、`submitDisabled` 仅禁提交
  不锁输入、多行 `<textarea>` 与 `Shift+Enter` 保活、内容签名请求缓存、32 KiB
  UI 门控、初始过期、提交时刻时钟跳变过期校验、以及实时过期定时器）均在独立变
  异装置下验证转红；`onConfirm` 内的 `exceedsManagedQuestionAnswerLimits` 位
  于 UI `submitDisabled={questionTooLarge}` 之后作为纵深防御保留。
- **静态门禁：** `tsconfig.lib.json`、`tsconfig.json`、含测试严格 `tsc`、
  `eslint --max-warnings=0`、`prettier --check`、全仓
  `npm run build && npm run typecheck`。
- **本地真实浏览器 Before/After E2E：** 真实本地 HTTP/SSE 服务 + Vite +
  Chromium（`<StrictMode>`）在未改动的 `origin/main`（改前）与改动后（改后）同
  一装置挂载 `ManagedSessionsPage`，验证多题作答、子动作草稿切换、仅改
  `expiresAt` 刷新保留作答、32 KiB 门控、503 失败重试同幂等键，并目视检查改前/
  改后截图，0 pageerror / 0 consoleerror。

## 未决问题

- Slice 3c.3 将确定最简洁的共享状态缝隙，使 `ManagedSessionsPage` 与
  `useManagedChatController` 在接入 `<ChatSurface>` 时共用同一套
  `useManagedSession` / `useManagedActions` / `useManagedTurnCancel` 实例，避免
  重复开启 SSE 流或重复轮询。
