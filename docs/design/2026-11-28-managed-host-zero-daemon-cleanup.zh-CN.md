# 托管宿主零 Daemon 依赖清零与 CI 产物门禁（Slice 6c）

[English](2026-11-28-managed-host-zero-daemon-cleanup.md) |
[简体中文](2026-11-28-managed-host-zero-daemon-cleanup.zh-CN.md)

状态：已实现（[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md) /
issue #17460 收官切片 6c，承接
[切片 6a](2026-11-27-managed-host-boundary-guards-and-cleanup.zh-CN.md) 与
[切片 6b](2026-11-27-chat-editor-daemon-decoupling.zh-CN.md)）。日期：
2026-11-28。

## 背景与问题

在切片 6a（47 → 31 边）与切片 6b（31 → 16 边）之后，
`packages/web-shell/client/managed-host.tsx` 依赖图中仅剩最后 16 条传递
daemon 值导入边：

1. **纯叶节点工具与错误判断（4 边）：**
   - `components/messages/HookStatistics.tsx`（从 `@qwen-code/sdk/daemon` 导
     入 `summarizeHookExecutions`），
   - `components/messages/GoalStatusMessage.tsx`（从 `@qwen-code/sdk/daemon`
     导入 `DAEMON_GOAL_STATUS_SENTINEL_PREFIX`），
   - `components/messages/SystemMessage.tsx`（从 `@qwen-code/sdk/daemon` 导入
     `parseDaemonBackgroundTurn`），
   - `components/artifacts/artifactUtils.ts`（从 `@qwen-code/sdk/daemon` 导入
     `DaemonHttpError` 与 `isSessionLevelNotFound`）。
2. **浏览器通知设置上下文（1 边）：**
   - `components/messages/BrowserNotificationControl.tsx` 从
     `browser-turn-notifications.tsx` 导入 `useBrowserNotificationSettings`，
     从而传递拉入 `./daemon/session/turn-notification-context`。
3. **Daemon 转录历史视口与消息删除（5 边）：**
   - `components/TranscriptViewport.tsx` 静态导入
     `useOptionalDaemonHistoryNavigationStore`、`useTranscriptViewport` 与
     `useMessageDeletion`（传递拉入 `adapters/transcriptToMessages`、
     `@qwen-code/sdk/daemon` 与 `@qwen-code/web-shell/daemon-react-sdk`）。
4. **`SystemMessage` 内的 daemon 状态子卡（4 边）：**
   - `components/messages/SystemMessage.tsx` 静态导入 `McpStatusMessage.tsx`
     （1 边）与 `TasksStatusMessage.tsx`（3 边）。
5. **共享转录渲染器中的工作区目标解析（2 边）：**
   - `components/artifacts/TurnOutputs.tsx`（`useArtifactWorkspaceTarget.ts`）
     与 `components/messages/ToolFilePreviewButton.tsx` 直接导入
     `@qwen-code/web-shell/daemon-react-sdk`（`useWorkspace` /
     `useWorkspaceActions`）。

此外，`.github/workflows/web-shell-managed-host.yml` 此前只校验了
`packages/web-shell/dist-managed-host/` 中的正向产物标记，尚未在 daemon 运行
时代码回流进托管宿主打包产物时自动阻断 CI。

## 目标

- 彻底清除 `packages/web-shell/client/managed-host.tsx` 中最后 16 条传递
  daemon 值导入边（47 → 31 → 16 → 0）。
- 从 `packages/web-shell/client/chat-core/boundary.test.ts` 中完全删除
  `REMAINING_MANAGED_HOST_DAEMON_EDGES` 白名单，直接断言精确零边
  （`expect(daemonEdges).toEqual([])`），并继续保持零未解析说明符与零
  `chat-core/**` 违规。
- 在 `.github/workflows/web-shell-managed-host.yml` 中落位经压缩产物活签名验
  证的零 daemon 运行时产物门禁，并在
  `scripts/tests/web-shell-managed-host-workflow.test.js` 中钉住该契约。

## 非目标

- 不移除 `web-shell-managed-host.yml` 中的前置工作区构建步骤（`core`、
  `acp-bridge`、`sdk`），浏览器安全的 core 子路径与纯类型 SDK 引用仍为合法输
  入。
- 不改动 Daemon、Managed 或静态导出转录视图的任何 HTTP/SSE 路由、OpenAPI
  schema、存储键、i18n 文案键或用户可见行为。

## 范围

- **纯叶节点解耦与对等测试（−4 边）：**
  - `components/messages/HookStatistics.tsx`：改从
    `@qwen-code/qwen-code-core/telemetry/hook-lifecycle-contract.js` 直接导入
    `summarizeHookExecutions`。
  - `components/messages/GoalStatusMessage.tsx` 与 `.test.tsx`：本地导出常量
    `GOAL_STATUS_SENTINEL_PREFIX = 'web-shell:goal-status:v1:'`，并用对等单测
    与 `@qwen-code/sdk/daemon` 的 `DAEMON_GOAL_STATUS_SENTINEL_PREFIX` 钉死。
  - `utils/background-turn.ts` 与 `.test.ts`：浏览器安全版
    `parseBackgroundTurn`，逐子句与 `@qwen-code/sdk/daemon` 的
    `parseDaemonBackgroundTurn` 对等测试；由 `SystemMessage.tsx` 消费。
  - `components/artifacts/artifactUtils.ts` 与 `.test.ts`：将
    `instanceof DaemonHttpError` 与 `isSessionLevelNotFound` 改为校验
    `error.name === 'DaemonHttpError'` 与数字 `status` 的结构化判断，并与
    `@qwen-code/sdk/daemon` 对等测试。
- **浏览器通知设置上下文拆分（−1 边）：**
  - `browser-notification-settings-context.ts`：承载零 daemon 导入的
    `BrowserNotificationSettings`、`BrowserNotificationSettingsContext` 与
    `useBrowserNotificationSettings`（`browser-turn-notifications.tsx` 保留
    重导出；`BrowserNotificationControl.tsx` 改从此直接导入）。
- **Daemon 转录视口拆分（−5 边）：**
  - `components/DaemonTranscriptViewport.tsx`：原样迁出
    `SessionAwareTranscriptViewport` 与 `DaemonSessionTranscriptViewport`。
  - `components/TranscriptViewport.tsx`：保持纯净（`LiveTranscriptViewport`、
    `followRangeFromRows` 及兼容 React 18/19 ref 的可选属性
    `sessionViewportComponent`）。
  - `App.tsx` 与 `components/ChatPane.tsx`：传入
    `sessionViewportComponent={DaemonTranscriptViewport}`（`App.test.tsx` 与
    `ChatPane.test.tsx` 均钉住该绑定）。
- **Daemon 状态子卡上下文（−4 边）：**
  - `components/messages/daemon-status-cards-context.ts`：中立的
    `DaemonStatusCardsContext` / `useDaemonStatusCards`。
  - `components/messages/daemon-status-cards.tsx` 与 `.test.tsx`：
    `DAEMON_STATUS_CARD_RENDERERS: Required<DaemonStatusCardRenderers>` 绑定
    `McpStatusMessage` 与 `TasksStatusMessage`。
  - `SystemMessage.tsx`：改读 `useDaemonStatusCards()`，不再导入
    `McpStatusMessage` 或 `TasksStatusMessage`。
  - 由 `App.tsx`、`ChatPane.tsx` 与 `WebShellTranscript.tsx` 共同提供（保持无
    头 `DaemonWorkspaceProvider` 零 UI 导入，同时保持离线导出转录兼容）。
- **共享工作区运行时上下文（−2 边）：**
  - `utils/workspace-context.ts`：中立 `WorkspaceRuntimeContext` 与
    `useOptionalWorkspaceRuntime()`，在 `DaemonWorkspaceProvider.tsx` 内直接
    作为 `DaemonWorkspaceContext` 复用（保留模块作用域 Context 身份与重复副
    本诊断）。
  - `components/artifacts/artifact-workspace-target.ts`：原样抽出
    `resolveArtifactWorkspaceOwner` 与
    `useArtifactWorkspaceTargetFromRuntime`（无工作区运行时时安全返回
    `undefined`）；`useArtifactWorkspaceTarget.ts` 保留为 daemon 调用方的薄
    封装。
  - `components/artifacts/TurnOutputs.tsx` 与
    `components/messages/ToolFilePreviewButton.tsx`：改读
    `useOptionalWorkspaceRuntime()` + `useArtifactWorkspaceTargetFromRuntime`，
    在无 `DaemonWorkspaceProvider` 时安全 fail-closed。
- **零 daemon 边界与 CI 产物门禁：**
  - `chat-core/boundary.test.ts`：删除 `REMAINING_MANAGED_HOST_DAEMON_EDGES`，
    直接强制 `expect(daemonEdges).toEqual([])`。
  - `.github/workflows/web-shell-managed-host.yml` 与
    `scripts/tests/web-shell-managed-host-workflow.test.js`：在
    `packages/web-shell/dist-managed-host` 禁止 8 个经压缩产物实测验证的活
    daemon 运行时签名（`DaemonSessionProvider`、`DaemonWorkspaceProvider`、
    `useDaemonWorkspace must be used within`、
    `The daemon is unavailable. Automatic refresh is paused.`、
    `__qwenWebShellDaemonWorkspaceProviderCopies`、`DaemonUnavailableError`、
    `web-shell:mcp-status:v1:`、`web-shell:tasks-status:v1:`）。

## 关键设计决策

1. **原样保留抽离守卫与工作区权限边界的全部运行时不变量。**
   - 将 `useArtifactWorkspaceTarget` 的信任边界、StrictMode 微任务撤销与能
     力 ref 逻辑原样迁入 `artifact-workspace-target.ts`，既确保零行为漂移，
     又让 `TurnOutputs` 与 `ToolFilePreviewButton` 在脱离 Provider 时安全
     fail-closed。
2. **复用模块级 React Context 实例（`WorkspaceRuntimeContext` 与
   `BrowserNotificationSettingsContext`）。**
   - 沿用切片 6b `ServiceAvailabilityContext` 的模式，复用同一 Context 实例
     避免双套 Provider，使所有既有 daemon Provider 树无缝生效。
3. **CI 产物门禁的全部负向签名均经真实压缩产物验证为“活闸”。**
   - 压缩会改写部分内部类名（如 `RestSseTransport` 与
     `useDaemonSession must be used within` 在压缩后的 `dist/` 中命中 0 次），
     因此门禁所选全部 8 个签名均先实测在压缩 `packages/web-shell/dist/` 中
     命中 3–5 次、在 `packages/web-shell/dist-managed-host/` 全部 JS 中命中
     0 次。

## 约束

- Daemon（`App.tsx`、`ChatPane.tsx`、`DaemonWorkspaceProvider`、
  `TranscriptViewport`、`TurnOutputs`、`ToolFilePreviewButton`、
  `SystemMessage`）、Managed（`ManagedSessionsPage`、`ManagedAgentWebShell`）
  与静态 `WebShellTranscript` 视觉与行为零回归。
- `build`、`build:managed-host`、`build-artifact.test.ts`、全仓
  `npm run typecheck`（含 `nodenext` 下的 `typecheck:integration`）与
  `scripts/tests/web-shell-managed-host-workflow.test.js` 保持全绿。

## 验证与验收标准

- **边界与工作流门禁：** `chat-core/boundary.test.ts` 以 `daemonEdges === []`
  且 `unresolvedSpecifiers === []` 通过；
  `scripts/tests/web-shell-managed-host-workflow.test.js` 通过；在本地针对
  `packages/web-shell/dist-managed-host` 重放工作流验证脚本退出 0。
- **单测与对等测试：** `utils/background-turn.test.ts`、
  `components/messages/GoalStatusMessage.test.tsx`、
  `components/messages/HookStatistics.test.tsx`、
  `components/messages/SystemMessage.test.tsx`、
  `components/messages/daemon-status-cards.test.tsx`、
  `components/messages/TasksStatusMessage.test.tsx`、
  `components/messages/ToolFilePreviewButton.test.tsx`、
  `components/artifacts/artifactUtils.test.ts`、
  `components/artifacts/TurnOutputs.dom.test.tsx`、
  `components/artifacts/SubagentDetail.integration.test.tsx`、
  `components/artifacts/ArtifactPanel.test.tsx`、
  `components/TranscriptViewport*.test.tsx`、`components/ChatPane.test.tsx`、
  `App.test.tsx`、`components/managed/ManagedSessionsPage.test.tsx`、
  `daemon/workspace/DaemonWorkspaceProvider.test.tsx` 与
  `build-artifact.test.ts` 全部通过。
- **本地真实浏览器验证：** 真实 Chromium 验证 `<ManagedAgentWebShell>` 及覆盖
  转录导航/历史、回合产物、文件预览与分屏持久化的 Playwright E2E 套件。
