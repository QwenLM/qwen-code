# ChatSurface 面向 Managed 宿主的切换就绪（Slice 3c 首个增量）

[English](2026-11-24-chat-surface-managed-readiness.md) |
[简体中文](2026-11-24-chat-surface-managed-readiness.zh-CN.md)

状态：已实现（slice 3c 首个增量——切换就绪前置）。日期：2026-11-24。属于
[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md) 迁移的一部分，构建在
`ChatSurface`（#17952）、会话作用域准入锁与历史分页（#18066、#18091）、
Managed 适配器核心（#18117）以及 `useManagedChatController` provider 绑定
（#18205）之上。

## 问题陈述

`useManagedChatController` 现已能为 Managed 会话提供可用的
`SessionChatController`，但在把 `ManagedSessionsPage` 正式切到 `ChatSurface`
之前，用真实转录消息与真实 composer 渲染 `<ChatSurface controller={managedController} />`
仍被以下具体阻塞拦住：

1. **`TranscriptViewport` 与默认 `ChatEditor` 工具栏动作硬编码依赖 daemon React 上下文。**
   `TranscriptViewport` 无条件调用 `useTranscriptViewport`（内部调用
   `useDaemonHistoryNavigationStore()`，在 `DaemonSessionProvider` 外直接抛错）
   和 `useMessageDeletion`（调用 `useConnection`、`useActions`、
   `useTranscriptStore`、`useWorkspace`，在
   `DaemonSessionProvider`/`DaemonWorkspaceProvider` 外直接抛错）。同样，
   `ChatSurface` 渲染 `ChatEditor` 时未传 `visibleToolbarActions`，导致
   `ChatEditor` 默认开启全部工具栏动作（包含 `'voice'`：`LiveVoiceButton` 与
   `VoiceButton`，两者均无条件调用 `useWorkspace()` / `useConnection()`）。
   - 在独立的 Managed 外壳（`ManagedAgentWebShell`）中不存在任何 daemon
     provider，只要 `transcriptState !== 'error'` 并挂载真实 `ChatEditor`，挂载
     `ChatSurface` 就会立刻崩溃。
   - 在完整 Web Shell（`App.tsx`）中，`ManagedSessionsPage` 挂载在
     `DaemonSessionProvider` 与 `DaemonWorkspaceProvider` **内部**。如果只把
     hook 改成 optional，Managed 聊天列反而会静默读到同屏 daemon 会话的历史导航视
     口、消息删除工具栏、语音控件与 composer 工作区特性
     （`ComposerWorkspaceProvider`），造成跨 provider 污染。
2. **共享 `AskUserQuestion` 卡片尚未覆盖 Managed 问题契约。**
   - Managed 问题携带 `required: boolean`、`allowText: boolean` 与单题 8192 字符
     上限（`MAX_MANAGED_QUESTION_TEXT_LENGTH`），且协议上不存在
     dismiss（`reject_once`/`reject_always`）变体。
   - `toManagedQuestionPermissionRequest` 目前丢弃了 `required`、`allowText` 与
     `maxTextLength`。
   - `AskUserQuestion` 目前把所有题目当作必答（进入单选即自动预选首项，且阻断提
     交直到每题都有文本）、无条件渲染"其他"自由文本行（即便 `allowText` 为
     `false`）、在 `request.options` 不含 reject 选项时仍渲染点击无反应的"忽略"
     死按钮、为未答可选题发出空结构化条目而非省略，且不接受 `disabled` prop（导
     致 `ChatSurface` 的 `approvalDisabled` 只到达 `ToolApproval` 而未到达
     `AskUserQuestion`）。

## 范围

本增量关闭上述两项硬阻塞，使由 Managed controller 驱动的真实 `<ChatSurface>`
既能在无 daemon provider 的独立宿主中、也能在与 daemon 共存的宿主树中端到端渲
染和交互，且不泄漏任何 daemon 上下文：

- **解耦 `TranscriptViewport` 并在 `ChatSurface` 默认 fail-closed 隔离：**
  - 在 `DaemonSessionProvider.tsx` 中导出
    `useOptionalDaemonHistoryNavigationStore()`（与既有的
    `useOptionalDaemonActions()` 并列）。
  - 将 `TranscriptViewport` 拆分为纯实时路径 `<LiveTranscriptViewport>`（仅渲染
    `<ModRowsProvider>` + `<MessageList>`，零 daemon hook 调用）与既有的
    `<DaemonTranscriptViewport>`。
  - 为 `TranscriptViewportProps` 新增后端中立属性
    `sessionViewportEnabled?: boolean`（在 `TranscriptViewport` 上默认 `true`；
    后续在 [切片 6c](2026-11-28-managed-host-zero-daemon-cleanup.zh-CN.md) 演
    进为与显式注入的 `sessionViewportComponent` 配对，不再在
    `TranscriptViewport.tsx` 内直接导入 daemon hook）。当
    `sessionViewportEnabled === false` 或未注入 `sessionViewportComponent` 时，
    `TranscriptViewport` 直接渲染 `<LiveTranscriptViewport>` 且不读取任何
    daemon 上下文（若开启 `sessionViewportEnabled` 却未注入组件则在开发环境输
    出告警）；当 daemon 宿主（`App.tsx`、`ChatPane.tsx`）注入
    `DaemonTranscriptViewport` 时，后者检查
    `useOptionalDaemonHistoryNavigationStore()`，缺失时优雅回退到
    `<LiveTranscriptViewport>` 而非抛错。
  - 为 `ChatSurfaceProps` 新增后端中立属性 `sessionViewportEnabled?: boolean`
    （默认 `false`）、`workspaceFeaturesEnabled?: boolean`（默认 `false`）与
    `visibleToolbarActions?: readonly ComposerToolbarAction[]`（默认 `[]`），
    分别透传给 `TranscriptViewport` 与 `ChatEditor`。默认关闭/空集保证
    Managed `ChatSurface` 既不会在无 daemon provider 环境下因默认工具栏动作
    （如 `LiveVoiceButton`/`VoiceButton`）崩溃，也不会在共存于 `App.tsx` 时
    泄漏祖先 `DaemonSessionProvider` 或 `ComposerWorkspaceProvider`，未来
    daemon 列切换时显式开启即可。`ChatSurface` 仍绝不按 `controller.kind`
    分支。
- **共享 `AskUserQuestion` 对齐 Managed 问题契约：**
  - 扩展 `toManagedQuestionPermissionRequest`，在 `rawInput.questions` 的每道题
    上透传 `required`、`allowText` 与
    `maxTextLength: MAX_MANAGED_QUESTION_TEXT_LENGTH`。
  - 让 `AskUserQuestion` 支持可选的 `required?: boolean`（默认 `true`）、
    `allowText?: boolean`（默认 `true`）、`maxTextLength?: number`、
    `disabled?: boolean`（默认 `false`），并根据 `request.options` 是否存在
    `reject_once`/`reject_always` 决定是否渲染 Ignore 按钮。
  - `ChatSurface` 将 `approvalDisabled` 透传给 `AskUserQuestion` 的 `disabled`。
- **无 mock 的 Managed `ChatSurface` 集成覆盖：**
  - 将 `chat-controller.local-integration.test.tsx` 从
    `transcriptState: 'error'` 升级为 `transcriptState: 'ready'` 与真实渲染消
    息（不 mock `TranscriptViewport`），并补充共存树下的跨 provider 隔离回归。

### 明确不在本增量范围（延后至后续增量）

- 把 `ManagedSessionsPage.tsx` JSX 切换到 `<ChatSurface>` 并删除
  `ManagedQuestionForm`（slice 3c 后续增量，附视觉 before/after 门禁）。该切换
  还需承接 Managed 持久化 pending 出箱、运行中用户消息队列、侧查
  （`/btw`/`/recap`）、文件引用、技能列表、多待处理动作切换器（含子会话）及工具
  栏子控制器。
- 从独立 Managed 产物图中彻底剥离 `TranscriptViewport.tsx` 传递引入的
  `daemon/**` 值导入（slice 6 边界守卫）。
- Daemon 主列切换（2f 余项）、`ChatPane` 收敛（slice 4）与状态栈/统计对齐
  （slice 5）。
- 不改 daemon/Java 路由、OpenAPI schema、session-id 命名空间、存储键，不新增
  i18n 文案键。

## 设计决策与理由

1. **`TranscriptViewport` 采用双层防御（显式开关 + optional hook）。**
   - 为何不能只靠 optional hook？在 `App.tsx` 中，`ManagedSessionsPage` 挂载在
     `DaemonSessionProvider` 与 `DaemonWorkspaceProvider` 之下；仅做 optional
     hook 仍会解析到同屏 daemon 会话的 store，把 daemon 历史导航与消息删除 UI 挂
     到 Managed 转录列上。
   - 为何不能只靠显式开关？在无 daemon provider 的树（独立壳或单测）里渲染默认
     `<TranscriptViewport>` 或 `<ChatSurface sessionViewportEnabled />` 时，也应
     平稳退回纯实时 `<MessageList>` 而不是崩溃。
   - 为何 `TranscriptViewport` 默认 `true` 而 `ChatSurface` 默认 `false`？
     `ChatSurface` 本身后端中立，fail-closed 默认值无需按 `controller.kind` 分
     支即可防止静默跨 provider 泄漏；随后在
     [切片 6c](2026-11-28-managed-host-zero-daemon-cleanup.zh-CN.md) 中，
     `DaemonTranscriptViewport` 已从 `TranscriptViewport.tsx` 拆出并由
     `App.tsx` 与 `ChatPane.tsx` 通过 `sessionViewportComponent` 显式注入，使
     `TranscriptViewport.tsx` 彻底零 daemon 导入。
2. **可选题（`required: false`）绝不替用户伪造答案。**
   - 挂载或切换到可选单选题时，答案保持未选（所有选项 `aria-checked="false"`），
     不再自动预选第 0 项。
   - 再次点击可选单选题已选中的选项可取消选中，方便撤回误点。
   - 方向键在可选单选题上只移动焦点/roving tabindex、不提交选中；在聚焦选项上按
     `Enter` 选中并前进（与多选一致），而 `Next`、`ArrowRight`、`Submit`、
     `Ctrl+Enter`/`Cmd+Enter` 可直接跳过或提交。
   - 未回答的可选题从 `structuredAnswers` 中省略，与 `ManagedQuestionForm` 及
     `ManagedUserQuestions.java`（拒绝既无 `optionIds` 又无 `text` 的空答案对
     象）保持一致。
   - 既有 daemon 问题均省略 `required`（默认 `true`），完全保持原有 WAI-ARIA
     radiogroup 自动预选与必填校验行为。
3. **`allowText: false` 彻底移除自由文本行。**
   - 当 `allowText` 为 `false` 时不渲染"其他"行，roving tabindex 与数字键/`Home`/
     `End` 上界收紧到 `options.length`，`focusCustomInput` 为空操作。即使同时出现
     `allowText === false` 且 `options.length === 0`，键盘导航也防范模零 `NaN`
     并安全置空焦点。
   - 当 `allowText` 为 `true` 且 `options.length === 0`（纯文本题）时，索引 `0`
     直接指向自定义输入触发器，无选项也能顺畅完成键鼠输入。
4. **无 reject 选项时隐藏 Ignore 按钮。**
   - `toManagedQuestionPermissionRequest` 有意不投影 reject 选项，因为 Managed
     线协议没有问题 dismiss 变体。无条件渲染 Ignore 只会给用户一个点击毫无反应的
     死按钮。改为按是否存在 `reject_once`/`reject_always` 选项控制显示，daemon
     行为零变化、Managed 消除死按钮。
5. **`AskUserQuestion` 对齐 `disabled` 能力。**
   - `ChatSurface` 已将 `approvalDisabled` 传给 `ToolApproval`；同步传给
     `AskUserQuestion` 可确保会话级写锁（如 `respondForbidden` 或压缩阻塞）通过
     点击与快捷键一致禁用两类决策卡。

## 约束与风险

- **对 daemon 零回归：** 省略 `required`、`allowText`、`disabled` 时，
  `App.tsx`、`ChatPane.tsx`（按
  [切片 6c](2026-11-28-managed-host-zero-daemon-cleanup.zh-CN.md) 显式经
  `sessionViewportComponent` 注入 `DaemonTranscriptViewport`）与既有
  `TranscriptViewport`/`AskUserQuestion` 测试行为保持完全一致。
- **测试 mock 对齐：** 4 份 `TranscriptViewport*.test.tsx` 部分 mock 了
  `../daemon/session/DaemonSessionProvider`（仅导出
  `useDaemonHistoryNavigationStore`），需在各自 mock 中同步补齐
  `useOptionalDaemonHistoryNavigationStore`。
- **零新增 i18n 键：** 避免多语种漂移，且不触碰文档导出渲染器字节预算棘轮。
- **残余风险：** 若宿主在缺少 `DaemonWorkspaceProvider` 的情况下单独挂载
  `DaemonSessionProvider` 且保持 `sessionViewportEnabled={true}`，
  `useMessageDeletion` 仍要求 `DaemonWorkspaceProvider`（与 main 现行行为一致；
  生产 daemon 壳始终将其嵌套在 `DaemonWorkspaceProvider` 之内）。

## 验证计划与验收标准

- **单测与集成测试：**
  - `TranscriptViewport`：无 `DaemonSessionProvider` 时渲染真实 `<MessageList>`
    不崩溃；在提供 `DaemonTurnNavigationContext` 的树中传
    `sessionViewportEnabled={false}` 时不调用 `useTranscriptViewport` /
    `useMessageDeletion` 且不显示 daemon 导航 UI；4 份既有
    `TranscriptViewport*.test.tsx` 全绿。
  - `AskUserQuestion`：覆盖 `required: false`（不自动预选、再点取消选中、方向键
    仅移焦点不提交、跳过可选题仍拦必填题、`structuredAnswers` 省略未答可选题）、
    `allowText: false`（无自由文本行、方向键/`Home`/`End`/数字键不越界、空选项无
    `NaN`）、纯文本题（`options: []` + `allowText: true`）、无 reject 选项隐藏
    Ignore（有 `reject_once` 时保留）、`disabled` 阻断点击与
    `Ctrl+Enter`/`Escape`/`Enter`/数字键、以及 `maxLength` 透传。
  - `ChatSurface` 与 `chat-controller`：验证 `sessionViewportEnabled` /
    `workspaceFeaturesEnabled` 默认 `false`、`visibleToolbarActions` 默认
    `[]`（及显式开启透传）、`approvalDisabled` 透传给 `AskUserQuestion`、
    `toManagedQuestionPermissionRequest` 投影
    `required`/`allowText`/`maxTextLength`，且
    `chat-controller.local-integration.test.tsx` 在不 mock
    `TranscriptViewport` 与 `ChatEditor` 的情况下以 `transcriptState: 'ready'`
    渲染真实 `<ChatSurface>` 与消息（零组件 mock、零 daemon provider）。
- **变异见证：** 每条新增守卫与分支在独立变异装置下均验证转红。
- **静态门禁：** `tsconfig.lib.json`、`tsconfig.json`、含测试严格 `tsc`、
  `eslint --max-warnings=0`、`prettier --check`、全仓
  `npm run build && npm run typecheck`。
- **本地真实浏览器 E2E：** 真实本地 HTTP/SSE 服务 + Vite + Chromium
  （`<StrictMode>`）直接挂载由 `useManagedChatController` 驱动的**真实
  `<ChatSurface>`**（无 daemon provider），端到端验证转录渲染、可选题与
  `allowText: false` 与纯文本题、`approvalDisabled` 门控、仅改 `expiresAt`
  保留作答、SSE prompt 提交与轮询 cancel 结算，且 0 pageerror / 0 consoleerror。

## 未决问题

- `ManagedSessionsPage` 切换（3c.2）时，32 KiB 合并 UTF-8 字节计数提示是直接内置
  进 `AskUserQuestion` 还是沿用控制器拒绝文案，留待移除 `ManagedQuestionForm` 时
  决定。
- `ChatSurface` 后续如何承接 Managed 的模型/审批/压缩工具栏子控制器（通过槽位还是
  能力驱动子控制器），归 3c.2 范围。
