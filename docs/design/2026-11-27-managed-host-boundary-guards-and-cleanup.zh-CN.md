# chat-core 边界守卫与托管宿主叶节点 daemon 导入解耦（Slice 6a）

[English](2026-11-27-managed-host-boundary-guards-and-cleanup.md) |
[简体中文](2026-11-27-managed-host-boundary-guards-and-cleanup.zh-CN.md)

状态：已实现（[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)
切片 6a；剩余 `ChatEditor` 与转录/消息侧 daemon 边清理及最终
`dist-managed-host/index.js` CI 产物守卫分别由切片 6b 与 6c 承接）。日期：
2026-11-27。

## 背景与问题

在全仓全部三条聊天列（`ManagedSessionsPage`、`ChatPane`、`App` 主列）收敛至
共享 `ChatSurface` 且切片 5 补齐 Managed 用量/上下文能力对等后，切片 6 还剩两
项收口任务：

1. 缺少自动化的源码级边界门禁来强制保证 `chat-core/**` 永不导入 daemon 模块
   （`daemon/**`、`@qwen-code/sdk/daemon`、
   `@qwen-code/web-shell/daemon-react-sdk`）且绝不按 `controller.kind` 分支，
   也缺少防回退棘轮阻止新的 daemon 值导入落入 `managed-host.tsx` 依赖图。
2. 在最新 `main`（`b58b8d7992dd`）上用 TypeScript AST 对
   `packages/web-shell/client/managed-host.tsx` 的传递值导入图做实测普查，共
   检出 47 条 daemon 值导入边，清晰聚成三簇：
   - **簇 1（16 条边 — Managed 直接与近叶/纯工具导入）：**
     `use-managed-model-change.ts`（`withActionTimeout`）、`useComposerCore.ts`
     （`subscribeSidechannelRemotePrompt`）、`ToolDetailsContext.tsx` 与
     `ShellToolOutput.tsx`（`isShellResultDisplay`）、`AddWorkspaceDialog.tsx`
     （`DaemonHttpError`）、`turnOutputSelectors.ts` →
     `useSessionScheduledTasks.ts`（`scheduledTaskRuntimeKey`，3 边）、
     `ManagedLocalFilesControl.tsx` → `LocalFilesControl.tsx`（4 边）、
     `ChatContextHeader.tsx` → `LocalControlQrButton.tsx`（4 边），并同步将
     `ArtifactIcon.tsx` 从 `artifactUtils.ts` 解耦（`artifact-mime.ts`）。
   - **簇 2（15 条边 — 切片 6b）：** `ChatEditor.tsx` 静态导入的 daemon 专属工
     具栏与上传模块（`VoiceButton`、`LiveVoiceButton`、`BranchPickerPopover`、
     `useFileUpload`）。
   - **簇 3（16 条边 — 切片 6c）：** `TranscriptViewport`、`TurnOutputs`
     （`artifactUtils.ts` + `useArtifactWorkspaceTarget.ts`）、`ToolApproval`
     （`BrowserNotificationControl`）、`SystemMessage` 状态子卡、
     `ToolFilePreviewButton` 与 `HookStatistics`。

将切片 6 拆成三笔小而干净的增量可让每个 PR 体量可控、零回归，同时立即落位防回
退棘轮。

## 目标

- 新增基于 TypeScript AST 的源码级边界门禁测试
  （`packages/web-shell/client/chat-core/boundary.test.ts`），强制校验：
  - `packages/web-shell/client/chat-core/**` 全部非测试源文件对 `daemon/**`、
    `@qwen-code/sdk/daemon`、`@qwen-code/web-shell/daemon-react-sdk` 保持零导
    入（含值导入、类型导入与动态导入），且 `ChatSurface.tsx` 不含任何
    `controller.kind` 属性访问。
  - 对 `managed-host.tsx` 传递可达的 daemon 值导入边施加双向严格棘轮（新增边
    即红，已清除的边若不删白名单也即红）。
- 通过最小、行为不变的纯工具提取与插槽注入清除簇 1 全部 16 条 daemon 值导入边
  （47 → 31），对所有既有 Daemon 调用方保持 100% 向后兼容。

## 非目标

- 不在本 PR 解耦 `ChatEditor.tsx` 的 daemon 工具栏/上传导入（切片 6b），也不
  处理 `TranscriptViewport` / `MessageList` / `ToolApproval` / `SystemMessage`
  的 daemon 边与 `web-shell-managed-host.yml` 的 `dist-managed-host/index.js`
  产物门禁（切片 6c）。
- 不改动任何 Daemon/Java HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案键。

## 范围

- **纯工具下沉（原 daemon 模块保留重导出以维持向后兼容）：**
  - `packages/web-shell/client/utils/action-timeout.ts`（`withActionTimeout`，
    由 `daemon/timing.ts` 重导出；`components/managed/use-managed-model-change.ts`
    改从此导入，−1 边）。
  - `packages/web-shell/client/utils/remote-prompt-sidechannel.ts`
    （`subscribeSidechannelRemotePrompt`、`publishSidechannelRemotePrompt`、
    `RemotePromptSidechannelEvent`，由 `daemon/remotePromptSidechannel.ts` 重
    导出；`hooks/useComposerCore.ts` 改从此导入，−1 边）。
  - `packages/web-shell/client/utils/shell-result-display.ts`
    （`ShellResultDisplay`、`isShellResultDisplay`，配对等单测校验与
    `@qwen-code/sdk/daemon` 完全一致；`ToolDetailsContext.tsx` 与
    `ShellToolOutput.tsx` 改从此导入，−2 边）。
  - `packages/web-shell/client/components/artifacts/artifact-mime.ts`
    （`AUDIO_EXTENSIONS`、`pathExtension`、`isAudioArtifact`、
    `normalizeArtifactMimeType`，由 `artifactUtils.ts` 重导出；
    `ArtifactIcon.tsx` 改从此导入，切断 `FileTypeIcon` → `ArtifactIcon` 路径）。
  - `packages/web-shell/client/components/dialogs/scheduledTasksSchedule.ts`
    （`scheduledTaskRuntimeKey`，由 `hooks/useSessionScheduledTasks.ts` 重导
    出；`components/artifacts/turnOutputSelectors.ts` 改从此导入，−3 边）。
- **共享 UI 与对话框解耦：**
  - `packages/web-shell/client/components/LocalFilesPanel.tsx`：从
    `LocalFilesControl.tsx` 抽出纯属性驱动的 `LocalFilesPanel`、
    `getLocalFilesDotClass`、`getLocalFilesTooltip`、
    `LOCAL_FILES_DAEMON_COMMAND` 与 `deriveLocalFilesDaemonCommand`（原文件重
    导出）；`ManagedLocalFilesControl.tsx` 改从 `./LocalFilesPanel` 导入
    （−4 边）。
  - `packages/web-shell/client/components/ChatContextHeader.tsx`：移除对
    `LocalControlQrButton` 的直接导入与 `onOpenLocalControlSettings` 属性，改
    为后端中立的 `renderLeadingAction?: (actionClassName: string) => ReactNode`
    插槽由 `App.tsx` 传入（−4 边）。
  - `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx`：将
    `err instanceof DaemonHttpError` 改为针对 `err instanceof Error` 的结构化
    HTTP 404 + `clone_job_not_found` 判断（−1 边）。
- **自动化边界与对等测试：**
  - `packages/web-shell/client/chat-core/boundary.test.ts`：基于 AST 的
    `chat-core/**` 零 daemon / 零 `controller.kind` 守卫 + `managed-host.tsx`
    精确 31 边传递棘轮。
  - `packages/web-shell/client/utils/shell-result-display.test.ts`：与
    `@qwen-code/sdk/daemon` 的 `isShellResultDisplay` 对等测试。

## 关键设计决策

1. **使用 TypeScript AST（`ts.createSourceFile`）而非正则实现边界门禁。**
   - 正则会漏判多行混合 `import { type A, B }`、`export { x } from ...` 重导出
     与动态 `import(...)`，也会在注释上误报。直接遍历 `ts.ImportDeclaration`、
     `ts.ExportDeclaration` 与动态 `ts.CallExpression` 节点可获得与编译器完全
     一致的值导入图。
2. **托管宿主棘轮采用双向精确比对。**
   - 将扫描得到的 daemon 值导入边集合与固定白名单做精确相等断言，既防止回归
     （引入新 daemon 导入），也防止遗留陈旧白名单条目（推动切片 6b 与 6c 将白
     名单干净清零）。
3. **被移出的纯工具在原模块保留重导出。**
   - 在 `daemon/timing.ts`、`daemon/remotePromptSidechannel.ts`、
     `LocalFilesControl.tsx` 与 `artifactUtils.ts` 保留重导出，保证所有既有
     Daemon 调用方与单测零破坏，同时彻底切断托管宿主图的传递边。

## 约束

- Daemon（`App.tsx`、`ChatPane`、`LocalFilesControl`、`AddWorkspaceDialog`）
  与 Managed（`ManagedSessionsPage`、`ManagedLocalFilesControl`、
  `ManagedAgentWebShell`）行为与视觉零变化。
- 不新增运行时依赖、路由、OpenAPI schema、存储键或 i18n 文案键。
- `build:managed-host` 与 `build-artifact.test.ts` 保持全绿。

## 验证与验收标准

- **单测与边界守卫测试：**
  - `chat-core/boundary.test.ts`（断言 `chat-core` 0 daemon 导入、0
    `controller.kind` 访问、`managed-host.tsx` 精确 31 条剩余边且 16 条簇 1
    边全清）、`utils/shell-result-display.test.ts`、`ChatContextHeader.test.tsx`、
    `LocalFilesPanel.test.tsx`、`LocalFilesControl.test.tsx`、
    `ManagedLocalFilesControl.test.tsx`、`AddWorkspaceDialog.test.tsx`、
    `use-managed-model-change.test.tsx`、`ManagedSessionsPage.test.tsx`、
    `App.test.tsx`（头部与移动访问相关用例）与 `build-artifact.test.ts` 全部通
    过。
- **变异见证：** 向 `chat-core` 注入合成 daemon 导入或 `controller.kind` 访问、
  向 `managed-host.tsx` 可达路径注入新 daemon 值导入、以及变异
  `AddWorkspaceDialog` 的 404 判断或 `ChatContextHeader` 的
  `renderLeadingAction` 插槽，均验证测试转红。
- **静态门禁：** `tsconfig.lib.json`、`tsconfig.json`、
  `eslint --max-warnings=0`、`prettier --check`、`web-shell` + `managed-host`
  双构建与全仓 `npm run typecheck`。
- **本地真实浏览器验证：** 真实 Chromium 验证 `<ManagedAgentWebShell>`（解耦后
  零报错渲染）及 Playwright `web-shell.split-persist.spec.ts`。
