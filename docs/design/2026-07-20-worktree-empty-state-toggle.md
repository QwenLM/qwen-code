# Web Shell 空状态 worktree 隔离开关

## 背景

Worktree 隔离会话（见
[2026-07-19-webshell-worktree-sessions.md](./2026-07-19-webshell-worktree-sessions.md)）
目前的唯一入口是侧边栏 workspace 头部 **git 分支胶囊的下拉菜单**
（`WorkspaceSection.tsx`），且需要同时满足 `onOpenGitDiff`、
`workspace.trusted`、`gitStatus?.branch` 三个条件才渲染。用户很难发现一个
git pill 是可以点击的，功能隐藏过深。

Web Shell 没有独立的"新建会话页面"——点击新建会话后呈现的是聊天空状态
（WelcomeHeader + 输入框），它就是事实上的新建会话页。空状态已经有现成的
worktree pending 徽标 UI（`App.tsx` 的 `worktreeWelcomeBadge`）和完整的
pending 状态机（`pendingWorktreeRef` / `worktreePending`），会话在发送首条
消息时才真正创建（懒创建），因此"开关"只是设置一个 pending 意图。

## 目标

- 在聊天空状态提供可见的 worktree 隔离开关，点击后复用现有 pending 状态机
  与懒创建链路。
- 开启后显示现有 pending 徽标，并提供取消途径。
- 保留侧边栏 git pill 菜单入口不变（per-workspace 快捷入口）。

## 非目标

- 不改动 SDK、daemon 路由、`GitWorktreeService`——创建链路完全复用。
- 不改变"意图跟随 workspace"的既有语义：pending 意图始终作用于下一次创建
  会话时解析出的 workspace（`lockedWorkspaceCwd ?? selectedWorkspaceCwd ??
primary`），与侧边栏入口的现状一致。
- 不处理"pending 开启后切换到非 git workspace"的失败提示（现状即会报错，
  超出本次范围）。

## 设计

### 开关可见性（eligibility）

仅当以下条件全部满足时，空状态显示开关：

| 条件                       | 信号                                                          | 理由                                                            |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 聊天空状态                 | `welcomeHeader` 仅在 `isChatEmptyState` 时渲染                | 天然满足，无需额外判断                                          |
| 当前 workspace 已信任      | `workspaces.find(e => e.cwd === activeWorkspaceCwd)?.trusted` | 与侧边栏入口一致：未信任 workspace 不做 git 变更                |
| 当前 workspace 是 git 仓库 | `selectedWorkspaceGitStatus?.branch`                          | daemon 对非 git 仓库硬失败（`worktree_not_git_repo`），提前隐藏 |

`activeWorkspaceCwd` 复用现有 memo（`connection.sessionId ?
connection.workspaceCwd : (locked ?? selected ?? primary)`），
`selectedWorkspaceGitStatus` 复用现有拉取 effect。两者均为现有状态，不新增
网络请求。git status 未加载完成前开关不显示，与侧边栏 `gitStatus?.branch`
门控行为一致。

### 交互

- **关闭态**：徽标位置渲染一个低调的 ghost 按钮（fork 图标 +
  `worktree.welcomeTitle` 文案）。点击 → `pendingWorktreeRef.current = {}` +
  `setWorktreePending(true)`。
- **开启态**：渲染现有 `worktreeWelcomeBadge`（图标 + 标题 + 描述），右上角
  增加 X 取消按钮（`aria-label` 用新 i18n key）。点击 →
  `pendingWorktreeRef.current = undefined` + `setWorktreePending(false)`。
- 发送首条消息 → `ensureSessionForPrompt` 按现有逻辑携带 `worktree: {}`，
  成功后自动清除 pending；失败保留徽标供重试（现状不变）。
- 点侧边栏"新建会话"、加载已有会话等既有路径对 pending 的清除逻辑不变。

### 文件改动

| 文件                                                              | 改动                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/web-shell/client/App.tsx`                               | eligibility memo、开启/取消 handler、welcomeHeader memo 中渲染开关/徽标  |
| `packages/web-shell/client/App.module.css`                        | ghost 开关按钮样式、徽标取消按钮样式                                     |
| `packages/web-shell/client/i18n.tsx`                              | 新增 `worktree.cancel`（en/zh）                                          |
| `packages/web-shell/client/App.test.tsx`                          | 单元测试：可见性门控、开启/取消、提交时携带 `worktree: {}`               |
| `packages/web-shell/client/e2e/utils/mockDaemon.ts`               | 补 `workspaces` capability（含 `trusted`）与 `/workspaces/:cwd/git` 路由 |
| `packages/web-shell/client/e2e/web-shell.worktree-toggle.spec.ts` | 新增 Playwright E2E：开关出现/开启/取消、提交请求体含 `worktree`         |

## 开放问题

无。
