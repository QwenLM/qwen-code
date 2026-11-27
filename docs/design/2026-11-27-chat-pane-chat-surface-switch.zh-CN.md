# ChatPane 收敛至共享 ChatSurface（Slice 4）

[English](2026-11-27-chat-pane-chat-surface-switch.md) |
[简体中文](2026-11-27-chat-pane-chat-surface-switch.zh-CN.md)

状态：已实现（[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)
Slice 4）。日期：2026-11-27。

## 背景与问题

在 Managed 聊天列（`ManagedSessionsPage.tsx`）切换至后端中立的共享
`ChatSurface`、以及 Daemon 控制器与绑定 hook（`createDaemonChatController`、
`useDaemonChatController`）落地后，Daemon 分屏与侧任务聊天列
（`packages/web-shell/client/components/ChatPane.tsx`）仍在内部直接拼装
`TranscriptViewport`、`ToolApproval`、`AskUserQuestion` 与 `ChatEditor`，并维护
独立的审批、提问与取消连线。

将 `ChatPane.tsx` 切换至 `ChatSurface` 可让首批真实 Daemon 聊天列（`SplitView`
与 `SideTaskPanel`）落地到共享界面上，删除 `ChatPane` 重复的审批、提问、取消与
底部布局编排，并在主列（`App.tsx`）切换前验证共享 Daemon 适配器与宿主缝隙。

## 目标

- 将 `ChatPane.tsx` 切换为由 Daemon 控制器适配器
  （`useDaemonChatControllerFromState`）驱动的 `ChatSurface`，从
  `ChatPane.tsx` 删除对 `TranscriptViewport`、`ToolApproval`、`AskUserQuestion`
  与 `ChatEditor` 的直接值导入及内联渲染。
- 直接复用 `ChatPane` 已挂载的 Daemon 上下文 hook、帧节流转录快照
  （`useAnimationFrameTranscriptSnapshot`）、消息投影
  （`useMessagesFromBlocks`）、历史分页、实时状态事实（`queueLength`、
  `goalActive`）与 `ExitPlanMode` 模式切换锁，不新增重复订阅或重复消息投影。
- 完整保留窗格 chrome（`<header>`、`PaneHeaderActions`、
  `SessionDetailsTooltip`、`connectionError`）、`GoalEditDialog`、
  `ReportedArtifactRegistration`、编辑器状态区（`StreamingStatus`、
  `ComposerStatusStack`、`SessionRecoveryBanner`、`runtimeStopped`）、
  `CapacityRecoveryDialog`、`CustomComposerFooter` 以及 `ChatPane.handleSubmit`
  （斜杠命令 / `/plan` / `/goal` / 队列 / 容量恢复编排），在 `SplitView` 与
  `SideTaskPanel`（含 `embedded` 与 `readOnly` 模式）下保持行为与像素布局不变。

## 非目标

- 不切换 `App.tsx` 中的 Daemon 主聊天列（后续专项切片承接）。
- 不将 `ChatPane.handleSubmit` 中的窗格级斜杠命令（`/plan`、`/goal`、`/logout`、
  `/model`、宿主 `onSlashCommand`）、回合中消息队列（`useQueuedPrompts`）或
  `CapacityRecoveryDialog` 下沉进 `ChatSurface` 或 `createDaemonChatController`。
- 不改动任何 Daemon HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案键。
- 不在本增量落地 `dist-managed-host` 产物边界守卫（属 Slice 6）。

## 范围

- **`packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx`：**
  - 导出 `useOptionalDaemonPromptSettled(listener)`，行为与
    `useDaemonPromptSettled` 一致，但在未包裹 `DaemonSessionProvider` 时静默空操作
    （兼容直接 mock `@qwen-code/web-shell/daemon-react-sdk` 的单测宿主）。
- **`packages/web-shell/client/daemon/useDaemonChatController.ts`：**
  - 抽取共享绑定核心 `useDaemonChatControllerFromState`，并让独立
    `useDaemonChatController()` 直接委托给该核心，既有公开契约与行为零变化。
  - `useDaemonChatControllerFromState` 接收调用方已持有的 `connection`、
    `actions`、`transcriptHistory`、`messages`、`pendingApprovals`、
    `pendingQuestions`、`pendingSignature`，以及可选的 `transcriptState`、
    `statusFacts` 与 `submitPermission` 覆盖回调。
  - 独立与共享两种绑定统一经由同一 `derivePermissionSignals` 派生权限时效与决策
    结算，直接从就绪的 `PendingApproval.request` / `PendingQuestion.request` 读取
    `ExitPlanMode` 与 `AskUserQuestion` 元数据，并将回合结算事件转发给
    `createDaemonChatController`。
- **`packages/web-shell/client/chat-core/ChatSurface.tsx`：**
  - 透传给 `TranscriptViewport.pendingApproval` 的值收窄为
    `activeApproval?.request ?? null`（仅工具审批，不含 `AskUserQuestion`），同时
    保留 `approvalOverlayActive={cardActive}` 覆盖审批与提问两类卡片。
  - 新增 3 处极小且后端中立、由 `ChatPane.tsx` 实际消费的可选宿主缝隙（省略时保
    持既有默认行为不变）：
    - `transcriptRef?: Ref<MessageListHandle>`：转发给 `TranscriptViewport`（同步
      将 `'ref'` 加入 `SurfaceOwnedTranscriptKeys`）。
    - `footerClassName?: string`：提供时将底部区（决策卡、`panels`、未知准入横
      幅、编辑器区）包裹在单一带类名的容器中。
    - `composerEditorVisible?: boolean`（默认 `true`）：仅隐藏 `ChatEditor` 与
      `composerFooter`，同时将 `composerStatus` 留在随审批隐藏的容器内（供
      `ChatPane` 在 `readOnly` 为 `true` 时使用）。
- **`packages/web-shell/client/components/ChatPane.tsx` 与
  `ChatPane.module.css`：**
  - 用由 `useDaemonChatControllerFromState` 驱动的 `<ChatSurface>` 替换内联的
    `<TranscriptViewport>`、`<ToolApproval>`、`<AskUserQuestion>` 与
    `<ChatEditor>`。
  - 删除对 `TranscriptViewport`、`ToolApproval`、`AskUserQuestion`、`ChatEditor`
    的直接值导入，删除 `handleAskUserConfirm` 与 `handleCancel`，并移除
    `ChatPane.module.css` 中不再使用的 `.composerHidden`。
  - 在 `ChatPane.module.css` 中限定 `.pane .surface` 与 `.pane .body`，确保不论样
    式导入顺序如何，弹性高度与滚动容器均与改前逐像素一致。

## 关键设计决策

1. **通过 `useDaemonChatControllerFromState` 复用同一份 Daemon 绑定核心。**
   - `ChatPane` 已通过 `useAnimationFrameTranscriptSnapshot` 对转录更新做帧节流、
     经 `useMessagesFromBlocks` 缓存 `messages`，且其单测直接 mock
     `@qwen-code/web-shell/daemon-react-sdk`。将 `useDaemonChatController()` 收拢为
     `useDaemonChatControllerFromState()` 的薄包装，既避免二次消息投影与代码复
     制，又完整保留独立 `useDaemonChatController()` 的公开契约与严格上下文守卫。
2. **`TranscriptViewport.pendingApproval` 仅透传工具审批。**
   - `MessageList` 仅用 `pendingApproval` 在工具审批期间保持对应紧凑工具组展开；
     `AskUserQuestion` 并非工具审批，浮层定位已由 `approvalOverlayActive={cardActive}`
     负责。将其收窄为 `activeApproval?.request ?? null` 与 `App.tsx`、
     `ChatPane.tsx` 及 `ManagedSessionsPage.tsx` 保持一致。
3. **通过 `submitPermission` 覆盖回调衔接宿主 `ExitPlanMode` 交接锁。**
   - `ChatPane` 维护 `modeTransitionRef` 与 `modeControlsBusy` 来串行化审批模式切
     换与 `ExitPlanMode` 确认。向 `useDaemonChatControllerFromState` 传入
     `submitPermission` 回调可使该锁与窗格模式控件保持同步，同时把审批准入、时效
     与结算统一纳入 `createDaemonChatController` 与 `ChatSurface`。
4. **通过 `composerEditorVisible` 保留 `readOnly` 状态栏展示。**
   - `ChatPane` 在 `readOnly` 时隐藏 `ChatEditor` 与 `CustomComposerFooter`，但仍需
     在随审批隐藏的容器内展示 `runtimeStopped`、`StreamingStatus`、
     `ComposerStatusStack` 与 `SessionRecoveryBanner`。保留 `composerVisible` 控
     制整块显隐（`ManagedSessionsPage` 使用），新增默认 `true` 的
     `composerEditorVisible`，在不引入后端分支的前提下干净覆盖两类宿主。
5. **`ChatPane.handleSubmit` 暂留于 `ChatSurface.onComposerSubmit` 之后。**
   - 窗格本地斜杠命令、`/plan` 模式准备、`/goal` 命令、回合中排队与容量恢复对话
     框继续经由 `onComposerSubmit` 承接，待后续专门的提交流程收敛切片再统一。

## 约束

- `chat-core` 自身模块严格禁止任何 `daemon/**` 或 `@qwen-code/sdk/daemon` 导入，
  且绝不按 `controller.kind` 分支。
- 不改动 Daemon HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案键。
- 完整遵循 Web Shell CSS 作用域（`data-web-shell-root`、portal root）及 React
  18/19 `forwardRef` 规范。
- `SplitView`（多窗格）与 `SideTaskPanel`（`embedded` + `readOnly`）布局保持像素
  一致。

## 验证与验收标准

- **单测与集成测试：**
  - `ChatPane.test.tsx`、`SplitView.test.tsx`、`SideTaskPanel.test.tsx`、
    `ChatSurface.test.tsx`、`useDaemonChatController.test.tsx`、
    `daemon/chat-controller.test.ts` 与 `build-artifact.test.ts` 全部通过。
  - 新增回归用例覆盖 `useDaemonChatControllerFromState`、`ChatSurface` 新增缝隙
    （`transcriptRef`、`footerClassName`、`composerEditorVisible`、仅提问时
    `pendingApproval === null`）以及 `ChatPane` 通过 `<ChatSurface>` 渲染与
    `AskUserQuestion` 提交/忽略路由。
- **变异见证：** 全部可达新增守卫与缝隙在独立变异装置下验证转红。
- **静态门禁：** `tsconfig.lib.json`、`tsconfig.json`、
  `eslint --max-warnings=0`、`prettier --check` 与全仓
  `npm run build && npm run typecheck`。
- **本地真实浏览器 Before/After E2E：** 真实本地 Vite + Chromium（`<StrictMode>`）
  分别挂载未改动 `origin/main`（改前）与切至 `ChatSurface`（改后）的 `ChatPane`，
  验证布局像素一致、工具审批、`AskUserQuestion` 提交/忽略、取消回合、`readOnly`
  状态栏以及 0 页面错误、0 非预期控制台错误。
