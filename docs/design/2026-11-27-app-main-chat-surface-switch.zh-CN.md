# App 主 Daemon 聊天列收敛至共享 ChatSurface（Slice 2f.3）

[English](2026-11-27-app-main-chat-surface-switch.md) |
[简体中文](2026-11-27-app-main-chat-surface-switch.zh-CN.md)

状态：已实现（[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)
切片 2f.3 —— 主 Daemon 聊天列渲染及审批/提问路由切至 `ChatSurface`；剩余提交/
取消/状态管线收敛留作后续增量）。日期：2026-11-27。

## 背景与问题

在 `ManagedSessionsPage.tsx`（切片 3c.3）与 `ChatPane.tsx`（切片 4a）先后切换
至后端中立的共享 `ChatSurface` 后，`packages/web-shell/client/App.tsx` 中的主
Daemon 聊天列是全仓最后一条仍在内联渲染 `ToolApproval`、`AskUserQuestion` 与
`ChatEditor` 并维护独立审批/提问/底部连线的聊天列。

将 `App.tsx` 主列切换为由 `useDaemonChatControllerFromState` 驱动的
`ChatSurface`，即可把全仓全部三条聊天列（`ManagedSessionsPage`、`ChatPane`、
`App` 主列）统一到同一共享界面，同时完整保留 `App` 的尾流式性能隔离、Blink
重排边界、空态垂直居中以及宿主自有的提交/取消/恢复/页脚 chrome。

## 目标

- 将 `App.tsx` 主 Daemon 聊天列切换至由 `useDaemonChatControllerFromState` 驱
  动的 `ChatSurface`，从 `App.tsx` 删除对 `ToolApproval`、`AskUserQuestion` 与
  `ChatEditor` 的直接值导入、内联渲染以及 `handleAskUserConfirm`。
- 完整保留 `App.tsx` 已记忆化的尾流式 `LiveMessageList`、`ConversationSearch`、
  `btwPanel`、`mobileWelcomeGroup`、Blink 重排边界（`.chatViewWrap` /
  `.content` / `.appChatEmpty`），以及仅转录更新时 `React.memo(ChatEditor)` 不
  重渲染的稳定性。
- 保持主列 chrome（`scrollToBottomLayer`、`TodoPanel`、
  `ProjectHooksApprovalCard`、供浮动环境面板测量底部留白的
  `askUserOverlayRef`、编辑器状态横幅、`ComposerTaskChips`、
  `ComposerStatusStack`、`WaitingMinigame`、`CustomFooter`、
  `ComposerUsageStats`、`emptyWelcomeFooter`）、`ExitPlanMode` 交接锁、
  `WebShellApi.respondToPendingPermission` 与 `submitComposerInput` /
  `handleCancel` 的行为与像素布局零变化。

## 非目标

- 不将 `App.tsx` 的 `submitComposerInput`（本地斜杠命令、内联 shell 队列、乐观
  回显、`/plan` / `/goal` / `/btw` 编排）或 `handleCancel`（shell 队列清空与回
  退草稿）下沉至 `ChatSurface` 或 `createDaemonChatController`。
- 不移除 `App.tsx` 内 `LiveMessageList` 的按帧尾流式隔离机制。
- 不改动 Daemon HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案键。
- 不在本增量处理 Managed 能力门控对等（切片 5）或 `dist-managed-host` 产物边
  界守卫（切片 6）。

## 范围

- **`packages/web-shell/client/chat-core/ChatSurface.tsx`：**
  - 用 `useMemo(() => [...commands], [commands])` 缓存传给 `ChatEditor` 的命令
    数组引用，保证所有宿主在仅转录更新时 `React.memo(ChatEditor)` 都不被新鲜数
    组破坏。
  - 在 `hideComposerWhenCardActive` 为真时将 `dialogOpen` 合并为
    `cardActive || Boolean(composerProps?.dialogOpen)`，确保宿主级模态阻塞
    （`interactionBlocked`、`projectHooksApprovalActive`）在无会话权限卡时仍能
    正确置位 `ChatEditor.dialogOpen`。
  - 当宿主已在决策外框设置 `decisionTestId="approval-overlay"` 时，不再在内层
    审批容器重复输出相同的 `data-testid="approval-overlay"`，避免嵌套重复测试
    标识。
  - 新增由 `App.tsx` 实际消费的极小后端中立宿主缝隙（省略时保持全部既有默认行
    为）：
    - `transcriptContent?: ReactNode`：替换默认的
      `<div className={transcriptClassName}><TranscriptViewport ... /></div>`，
      使 `App.tsx` 保留记忆化的 `LiveMessageList` + `ConversationSearch` +
      `btwPanel` + `mobileWelcomeGroup`，避免每条流式 token 触发整页 `App` 重
      渲染。
    - `footerRef?: Ref<HTMLDivElement>`、`footerStyle?: CSSProperties`、
      `footerHeader?: ReactNode`、`footerTrailing?: ReactNode`：保留 `App`
      `.footer` 的 `ResizeObserver` 引用、响应式宽度 `contentStyle`、底部顶栏
      浮层（`scrollToBottomLayer`、`TodoPanel`）及位于 `.composerHidden` 之外
      的尾部 chrome（`CustomFooter`、`ComposerUsageStats`、
      `emptyWelcomeFooter`）。
    - `decisionRef?: Ref<HTMLDivElement>`：透传至决策外框，供 `App` 的
      `askUserOverlayRef` 测量 `AskUserQuestion` 卡片高度以计算浮动环境面板底
      部留白。
    - `questionKeyboardActive?: boolean`（默认回退至 `approvalKeyboardActive`）：
      使 `App` 分别驱动 `ToolApproval`（`toolApprovalOverlayVisible`）与
      `AskUserQuestion`（`askUserOverlayVisible`）的独立键盘焦点归属。
- **`packages/web-shell/client/App.tsx`、`App.module.css` 与
  `App.css.test.ts`：**
  - 绑定 `mainSurfaceController = useDaemonChatControllerFromState(...)`：
    `pendingApprovals` / `pendingQuestions` 按 `mainView === 'chat'` 门控，
    `transcriptState` 传 `connection.loadingTranscript ? 'loading' : 'ready'`，
    `submitPermission` 传 `submitMainPermission`（保留 `ExitPlanMode`
    `modeTransitionRef` 串行化、本地化 `t('mode.changePending')`，以及通过
    `pendingPermissionFailureRef` + `handleSurfaceError` 对 `ToolApproval` 与
    `AskUserQuestion` 忽略失败进行不重复的单次原始错误上报）。
  - 将 `WebShellApi.respondToPendingPermission` 路由至
    `mainSurfaceController.respondApproval(...)`，非 `accepted` 时抛出对应原因
    以保持既有外部命令式 API 契约。
  - 用 `<ChatSurface className={styles.chatSurface} ... />` 替换内联的
    `.footer`、`<ToolApproval>`、`<AskUserQuestion>` 与 `<ChatEditor>`，删除
    对 `ToolApproval`、`AskUserQuestion`、`ChatEditor` 的直接值导入与
    `handleAskUserConfirm`。
  - 在 `App.module.css` 中新增 `.chatSubtree .chatSurface { display: contents; }`
    并在 `App.css.test.ts` 固定该规则，保证 `.content` 与 `.footer` 在非空态与
    空态下均为 `.chatViewWrap` 直接弹性子元素。

## 关键设计决策

1. **通过 `.chatSubtree .chatSurface { display: contents; }` 保持 Blink 重排边
   界与空态居中。**
   - `App.module.css` 依赖 `.content` 与 `.footer` 为 `.chatViewWrap` 的直接弹
     性子元素（涵盖非空态 `contain: layout size style`、`.appChatEmpty .chatViewWrap`
     垂直居中与移动端 `.mobileWelcomeGroup`）。对 `.chatSubtree .chatSurface`
     设置 `display: contents` 可在零复制、不放松任何 `App.css.test.ts` 契约的
     前提下保持逐像素一致的布局树。
2. **经 `transcriptContent` 保留 `LiveMessageList` 流式性能隔离。**
   - `LiveMessageList` 在内部订阅 `useAnimationFrameTranscriptSnapshot()`，保证
     流式 token 绝不触发 28k 行 `App.tsx` 重渲染。通过 `transcriptContent` 传入
     `LiveMessageList`（及 `ConversationSearch`、`btwPanel`、
     `mobileWelcomeGroup`）既完整保留该性能隔离，又将底部全部决策卡片与编辑器
     编排统一收敛到 `ChatSurface`。
3. **在 `ChatSurface` 中记忆化 `editorCommands` 守护 `React.memo(ChatEditor)`。**
   - 此前每次渲染 `[...commands]` 都会分配新数组引用，导致仅转录更新也会触发
     `ChatEditor` 重渲染。改用 `useMemo(() => [...commands], [commands])` 兼顾
     防御性拷贝与跨宿主引用稳定。
4. **按 `mainView === 'chat'` 门控主列待审批，并保留宿主级
   `approvalOverlayActive` 隐藏。**
   - 切换到分屏或定时任务全页视图时，外层聊天树保持挂载但隐藏；按
     `mainView === 'chat'` 门控 `pendingApprovals` 与 `pendingQuestions` 可确保
     其他全页视图下绝不挂载外层审批浮层。`ProjectHooksApprovalCard` 置于
     `panels` 插槽，且在无会话权限卡但 `projectHooksApprovalActive` 为真时经
     `composerClassName` 继续隐藏编辑器区。

## 约束

- `chat-core` 模块严格禁止导入任何 `daemon/**` 或 `@qwen-code/sdk/daemon`，且绝
  不按 `controller.kind` 分支。
- 不改动 Daemon HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案键。
- 完整遵守 Web Shell CSS 作用域（`data-web-shell-root`、portal root）及 React
  18/19 `forwardRef` 规范。
- 保持 `App.test.tsx` 中 `React.memo(ChatEditor)` 渲染计数不变量与全部
  `App.css.test.ts` 重排边界契约全绿。

## 验证与验收标准

- **单测与集成测试：**
  - `App.test.tsx`、`App.css.test.ts`、`ChatSurface.test.tsx`、
    `ChatPane.test.tsx`、`SplitView.test.tsx`、`SideTaskPanel.test.tsx`、
    `ManagedSessionsPage.test.tsx`、`useDaemonChatController.test.tsx`、
    `daemon/chat-controller.test.ts` 与 `build-artifact.test.ts` 全部通过。
  - 新增回归用例覆盖 `ChatSurface` 新缝隙（`transcriptContent`、`footerRef`、
    `footerStyle`、`footerHeader`、`footerTrailing`、`decisionRef`、
    `questionKeyboardActive`、`dialogOpen` 合并、去重 `approval-overlay` testid
    与 `editorCommands` 记忆化稳定性）、`App.css.test.ts` 的
    `.chatSubtree .chatSurface` 规则，以及 `App.test.tsx` 中主列经 `ChatSurface`
    渲染、`AskUserQuestion` 提交/忽略与单次原始错误上报。
- **变异见证：** 全部可达新增守卫与缝隙在独立变异装置下验证转红。
- **静态门禁：** `tsconfig.lib.json`、`tsconfig.json`、
  `eslint --max-warnings=0`、`prettier --check` 与全仓
  `npm run build && npm run typecheck`。
- **本地真实浏览器 Before/After E2E：** 真实本地 Vite + Chromium（`<StrictMode>`）
  对比未改动 `origin/main`（改前）与切至 `ChatSurface`（改后）的主 Daemon 聊天
  列（空态欢迎页、含 `ToolApproval` 与 `AskUserQuestion` 的会话、编辑器恢复与
  活动回合取消），验证布局误差 `0px` 以及 0 页面错误、0 非预期控制台错误。
