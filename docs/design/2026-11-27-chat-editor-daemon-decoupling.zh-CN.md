# ChatEditor Daemon 工具栏与文件上传解耦（Slice 6b）

[English](2026-11-27-chat-editor-daemon-decoupling.md) |
[简体中文](2026-11-27-chat-editor-daemon-decoupling.zh-CN.md)

状态：已实现（[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)
切片 6b，承接 [切片 6a](2026-11-27-managed-host-boundary-guards-and-cleanup.zh-CN.md)；
剩余 16 条转录/消息/通知 daemon 边与 `dist-managed-host/index.js` CI 产物守卫
由切片 6c 承接）。日期：2026-11-27。

## 背景与问题

在切片 6a 落地 fail-closed 的 AST/编译器边界守卫并将
`packages/web-shell/client/managed-host.tsx` 的传递 daemon 值导入图从 47 条
压降至 31 条后，剩余 31 条中有 15 条全部经由
`packages/web-shell/client/components/ChatEditor.tsx` 的四处静态值导入引入：

1. `hooks/useFileUpload.ts`（2 条边：`../daemon/availability-context.js` 与
   `../daemon/availability.js`）——Daemon 与 Managed 宿主均复用该 hook 进行
   工作区文件上传，但它直接耦合了 daemon 可用性上下文与
   `isDaemonUnavailableError`。
2. `voice/VoiceButton.tsx`（3 条边：`voice/VoiceButton.tsx` 与
   `voice/useVoiceCapture.ts` × 2）——Daemon 专属语音转写控件。
3. `live/LiveVoiceButton.tsx`（8 条边：`live/useLiveBrowserHost.ts`、
   `live/useLiveVoice.ts` × 3、`session-catalog/session-catalog-hooks.ts` × 3
   与 `session-catalog/session-catalog-store.ts`）——Daemon 专属实时语音会话。
4. `components/BranchPickerPopover.tsx`（2 条边：`@qwen-code/sdk/daemon` 与
   `@qwen-code/web-shell/daemon-react-sdk`）——Daemon 专属 Git 分支切换浮层。

Managed 宿主（`ManagedSessionsPage` 与 `WorkspaceBindingCreator`）从不启用
`'voice'` 或渲染 `BranchPickerPopover`，却仍被迫将这 15 个 daemon 模块静态打入
`managed-host.tsx` 依赖图。

## 目标

- 从 `managed-host.tsx` 传递依赖图中彻底清除簇 2 全部 15 条 daemon 值导入边
  （将 `packages/web-shell/client/chat-core/boundary.test.ts` 中的双向棘轮从
  31 条收紧至 16 条），使 `ChatEditor.tsx` 与 `hooks/useFileUpload.ts` 零
  daemon 值导入。
- 保持 Daemon（`App.tsx`、`ChatPane.tsx`、`DaemonWorkspaceProvider.tsx`）与
  Managed（`ManagedSessionsPage.tsx`、`WorkspaceBindingCreator.tsx`）的视觉
  与行为 100% 不变。

## 非目标

- 不触碰剩余 16 条簇 3 边（`TranscriptViewport`、`TurnOutputs`、
  `ToolApproval`、`SystemMessage`、`ToolFilePreviewButton`、`HookStatistics`）
  与 CI 构建产物守卫——留待切片 6c 一次性清零。
- 不改动任何 HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案键。

## 范围

- **后端中立服务可用性桥（−2 边）：**
  - `packages/web-shell/client/utils/service-availability.ts`：定义零 daemon
    导入的 `ServiceAvailabilityState`、`ServiceAvailabilityController`、
    `ServiceUnavailableError`、`isServiceUnavailableError`、
    `ServiceAvailabilityContext`、`useServiceAvailabilityController` 与
    `useServiceAvailability`。
  - `packages/web-shell/client/daemon/availability.ts`：令
    `DaemonUnavailableError extends ServiceUnavailableError`（保留
    `this.name = 'DaemonUnavailableError'`、原错误文案及
    `isDaemonUnavailableError`），并声明 `DaemonAvailability implements
ServiceAvailabilityController`。
  - `packages/web-shell/client/daemon/availability-context.tsx`：将同一个
    `ServiceAvailabilityContext` 实例重导出为 `DaemonAvailabilityContext`，并
    委托 `useDaemonAvailabilityController` / `useDaemonAvailability`，使所有
    既有 `<DaemonAvailabilityContext.Provider>` 无缝供 `useFileUpload` 消费，
    无需改动 `DaemonWorkspaceProvider` 或任何既有 daemon 调用方。
  - `packages/web-shell/client/hooks/useFileUpload.ts`：改从
    `../utils/service-availability.js` 导入
    `useServiceAvailabilityController` 与 `isServiceUnavailableError`。
- **可选编辑器集成注入（−13 边）：**
  - `packages/web-shell/client/components/composer/composer-integrations.ts`：
    纯类型接口 `ComposerIntegrations`，声明可选的 `VoiceButton`、
    `LiveVoiceButton` 与 `BranchPickerPopover` 组件（通过
    `RefAttributes<VoiceButtonHandle>` 兼容 React 18/19 ref）。
  - `packages/web-shell/client/components/composer/daemon-composer-integrations.ts`：
    Daemon 专属常量 `DAEMON_COMPOSER_INTEGRATIONS`，绑定真实的
    `VoiceButton`、`LiveVoiceButton` 与 `BranchPickerPopover`。
  - `packages/web-shell/client/components/ChatEditor.tsx`：将 `VoiceButton`、
    `LiveVoiceButton` 与 `BranchPickerPopover` 导入改为 `import type`，新增可
    选属性 `composerIntegrations?: ComposerIntegrations`，按注入组件是否存在
    统一门控分支选择器可见性与宽度测量（`hasGitBranchControl`、
    `gitBranchVisible`、`branchPickerContextAvailable`）、移动端 `AddMenu`
    实时语音入口及工具栏语音控件，并在集成移除时重置 `voiceActive` /
    `liveVoiceOpen` / `liveVoiceSupported`。
  - `packages/web-shell/client/App.tsx` 与
    `packages/web-shell/client/components/ChatPane.tsx`：在
    `<ChatSurface composerProps={...} />` 中传入
    `composerIntegrations: DAEMON_COMPOSER_INTEGRATIONS`。
- **边界棘轮与回归测试：**
  - `packages/web-shell/client/chat-core/boundary.test.ts`：从
    `REMAINING_MANAGED_HOST_DAEMON_EDGES` 删除全部 15 条切片 6b 边（31 → 16）。
  - `packages/web-shell/client/hooks/useFileUpload.test.tsx`：移除模块 mock，改
    用真实 `<DaemonAvailabilityContext.Provider>` 端到端验证 React Context
    同实例与 `DaemonUnavailableError extends ServiceUnavailableError` 继承链。
  - `packages/web-shell/client/components/ChatEditor.test.tsx` 与
    `ChatPane.test.tsx`：通过 `composerIntegrations` 注入测试替身，补充未传/
    部分传入/动态切换 `composerIntegrations` 的用例（含未传
    `BranchPickerPopover` 时 `GitModePopover` 仍正常工作），并断言 `ChatPane`
    正确传入 `DAEMON_COMPOSER_INTEGRATIONS`。

## 关键设计决策

1. **复用同一 React Context 实例与错误基类，而非复制双套 Provider。**
   - 将 `ServiceAvailabilityContext` 直接作为 `DaemonAvailabilityContext` 重导
     出，并令 `DaemonUnavailableError extends ServiceUnavailableError`，可在
     完全保留 `instanceof DaemonUnavailableError` 与所有既有
     `<DaemonAvailabilityContext.Provider>` 的前提下零改造清除
     `hooks/useFileUpload.ts` 的两条 daemon 导入。
2. **通过显式可选 prop 注入 daemon 编辑器控件，而非新增隐式环境 Context。**
   - 全仓仅两处生产 daemon 宿主渲染 `ChatSurface`/`ChatEditor`（`App.tsx` 与
     `ChatPane.tsx`），且 `App.test.tsx` 存在不包裹 `DaemonWorkspaceProvider`
     的渲染方式。通过 `composerProps` 显式传递 `composerIntegrations:
DAEMON_COMPOSER_INTEGRATIONS` 既无隐式耦合、兼容无 Provider 测试夹具，又
     让 `ManagedSessionsPage` 与 `WorkspaceBindingCreator` 天然省略。
3. **保持 `gitBranchVisible` 及工具栏宽度测量与实际渲染控件严格一致。**
   - 以 `hasGitBranchControl = Boolean(gitModeIntent && onGitModeIntentChange)
|| Boolean(BranchPickerPopoverComponent)` 统一门控，避免宿主仅传
     `gitBranch` 却未注入 `BranchPickerPopover` 或 `gitModeIntent` 时出现空白
     上下文行或幽灵测量节点，同时不影响 `GitModePopover`。

## 约束

- Daemon（`App.tsx`、`ChatPane.tsx`、`VoiceButton`、`LiveVoiceButton`、
  `BranchPickerPopover`、`useFileUpload`）与 Managed（`ManagedSessionsPage`、
  `WorkspaceBindingCreator`、`ManagedAgentWebShell`）视觉与行为零变化。
- 通过 `RefAttributes<VoiceButtonHandle>` 保持 `VoiceButton` 的 React 18/19
  ref 兼容性。
- `build:managed-host`、`build-artifact.test.ts` 与全仓 `npm run typecheck`
  （含 `typecheck:integration`）保持全绿。

## 验证与验收标准

- **单测与边界测试：** `chat-core/boundary.test.ts`（断言 `chat-core/**` 0
  违规、0 未解析说明符、`managed-host.tsx` 精确剩余 16 条边且 15 条簇 2 边全
  清）、`hooks/useFileUpload.test.tsx`、`daemon/availability.test.ts`、
  `components/ChatEditor.test.tsx`、`components/ChatPane.test.tsx`、
  `components/managed/ManagedSessionsPage.test.tsx`、
  `components/managed/WorkspaceBindingCreator.test.tsx`、`App.test.tsx`（语音/
  分支/上传相关用例）与 `build-artifact.test.ts` 全部通过。
- **变异见证：** 从 `ChatPane.tsx` 或 `App.tsx` 去掉 `composerIntegrations`、
  破坏 `DaemonUnavailableError extends ServiceUnavailableError`、拆分
  `DaemonAvailabilityContext` 与 `ServiceAvailabilityContext`、或去掉
  `ChatEditor.tsx` 的 `hasGitBranchControl` / `LiveVoiceButtonComponent` 门控
  均验证测试转红。
- **静态门禁：** `eslint --max-warnings=0`、`prettier --check`、
  `tsconfig.json`、`tsconfig.lib.json`、`web-shell` + `managed-host` 双构建与
  全仓 `npm run typecheck`。
- **本地真实浏览器验证：** 真实 Chromium 验证 `<ManagedAgentWebShell>` 及
  Playwright 端到端套件（覆盖 daemon 编辑器/语音/分支选择、文件上传与分屏持久
  化）。
