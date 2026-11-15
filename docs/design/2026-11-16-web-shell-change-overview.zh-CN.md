# Web Shell 变更总览（按交付单元划分）

语言：[English](./2026-11-16-web-shell-change-overview.md) | 中文

## 问题

会话进行中，agent 会编辑大量文件，用户逐渐不清楚改动规模到底有多大。目前 Web
Shell 在三处展示变更信息，但都无法回答「按我交付的方式组织，改动到底有多大」：

- 每轮文件变更卡片与右侧审阅面板（`TurnOutputs.tsx`、`ArtifactPanel.tsx`）基于
  **工具调用编辑**（`edit` / `write_file`）。它们按轮划分、归属会话、无需 git，
  但不认识 commit / PR 边界：已提交的工作仍被计入，也没有全会话汇总。
- Git 对话框的 diff 页（`GitDialog.tsx` / `GitDiffDialog.tsx`）展示工作区**未提交**
  变更及每文件 `+/-`，但它是工作区口径，不按 commit / PR 分段。
- Git 对话框的 log / PRs 页列出 commit 与 PR，但没有把某个 PR 的变更文件列表与
  规模放在一起展示。

用户想要一个统一的变更文件与规模总览，并按交付方式分段：

- 尚未提交时：会话的变更总览（待交付 / 未提交批次）。
- 会话产生 commit 与 PR 后：每个 PR 一个总览；尚未进入 PR 的 commit 逐个展示，
  外加仍未提交的批次。

## 已确认的范围模型

与需求方确认：

1. **口径为 git 交付单元**，而非工具调用编辑。「未提交」「按 PR」都是 git 概念，
   工具调用口径无法表达。
2. **分段为 PR 优先、commit 兜底**：绑定的 PR 成为 PR 单元；未被绑定 PR 覆盖的
   commit 成为 commit 单元；工作区未提交变更始终是一个单元。

## 现状（在本文撰写所在提交上核实）

会话归属已经现成——无需自行推导 baseline：

- `DaemonSessionSummary` 携带 `worktree?: DaemonWorktreeInfo`
  （`{ slug, path, branch }`）、`branch?: DaemonBranchInfo`（`{ name, baseBranch }`）、
  以及 `prs?: DaemonSessionPrInfo[]`（绑定的 PR，`{ number, url, state, issues }`，
  末位为最新）。见 `packages/sdk-typescript/src/daemon/types.ts`。
- 从 Git 对话框创建 PR 时，PR 服务
  （`packages/core/src/services/session-pr-service.ts`）会把 PR 绑定到会话，并
  体现在会话摘要上。

可直接复用的现成只读能力：

- 未提交 diff：`fetchGitDiff`（`packages/core/src/utils/gitDiff.ts`）→ 每文件
  `added/removed/isBinary/isUntracked/isDeleted`，暴露为
  `GET /workspaces/:workspace/git/diff` 与 `workspaceGitDiff(cwd, sessionId)`。
  限定路由会解析会话的 worktree cwd，因此 worktree 会话下天然按会话隔离。
- 逐 commit 规模：`fetchGitCommitDetail` → `files[]` numstat + 汇总，暴露为
  `GET /workspaces/:workspace/git/log/commit` 与
  `workspaceGitCommitDetail(sha, cwd, sessionId)`。
- 带区间的 commit log：`fetchGitLog`（接受安全 `range`），暴露为
  `GET /workspaces/:workspace/git/log` 与 `workspaceGitLog(...)`。
- PR 列表：`fetchGitHubPullRequests`（`gh pr list`），暴露为
  `GET /workspaces/:workspace/github/prs`。

唯一缺失的能力：**绑定 PR 的变更文件列表与规模**。
`GitHubPullRequestView`（`parseGhPrView`）返回 `headRefOid`、state、checks，但没有
文件统计；也没有任何路由返回某 PR 的文件。

## 设计方案

### 数据层（core）

在 `packages/core/src/utils/github-prs.ts` 新增
`fetchGitHubPullRequestFiles(cwd, number, env?)`，底层用
`gh pr view <number> --json files,additions,deletions,headRefOid,baseRefName`。
返回与现有 PR 助手一致的可辨识结果（`ok` / `cli_unavailable` / `failed`），并给出
解析且设上限的文件列表：

- `files: { path, additions, deletions }[]`（设上限，附 `hiddenCount`），
- `additions`、`deletions` 汇总，
- `headSha`（`headRefOid`）与 `baseRefName`，用于归属与链接。

`gh` 输出不可信；复用 `fetchGitHubPullRequestView` 现有的脱敏 / 超时 / cwd 守卫
模式。文件路径与数量按 diff 路由同样的方式设界。

### 路由层（serve）

在 `packages/cli/src/serve/routes/workspace-github-prs.ts` 新增
`GET /workspaces/:workspace/github/prs/:number/files`，沿用现有限定路由模式：
解析可信运行时、解析会话托管的 git cwd、调用 core 助手、套用只读响应头并返回
文件列表。该路由挂在**现有** `workspace_github_prs` capability 标签下（扩展其
注释以覆盖 files 路由），而不新增标签：files 路由是 PRs 面的只读扩展，新增标签
需要同步多处顺序敏感的钉死 capability 基线。客户端用 `workspace_github_prs`
作为拉取 PR 文件的门槛；早于 files 路由的 daemon 会返回 404，总览将其渲染为
「文件列表不可用」。

总览本身**在客户端组合**现成路由加这一个新路由，而不是新增一个大型聚合端点。
这样每一块都小而可复用，也与 Git 对话框已经组合 `git/diff`、`git/log`、
`github/prs` 的方式一致。

### SDK

在 `packages/sdk-typescript/src/daemon/types.ts`、`DaemonClient.ts` 新增
`DaemonGitHubPullRequestFiles` 类型与
`workspaceGitHubPullRequestFiles(number, cwd?, sessionId?)` 客户端方法，与现有
PR 方法保持一致。

### UI（web-shell）

在右侧 `ArtifactPanel` 新增**变更总览**页，从「+」菜单打开（位于现有「文件更改」
入口旁）。渲染：

- **范围选择器**，列出交付单元：
  - `未提交`（工作区是 git 仓库时始终存在），
  - 每个绑定 PR 一项（`summary.prs`），标注 `#number`（摘要的绑定 PR 条目不含
    标题），并附 PR 链接，
  - 未被绑定 PR 覆盖的 commit 的兜底项。
- 所选单元的**文件列表（每文件 `+/-`）与总规模头部**，复用现有 `LineStats`
  渲染。逐行 diff 仍由 Git 对话框 / 审阅页承担；总览只做文件列表 + 规模汇总。

组合逻辑放在可测试的 hook `useChangeOverview`：

- 未提交单元 ← `workspaceGitDiff(cwd, sessionId)`。
- PR 单元 ← `summary.prs`，每项拉取 `workspaceGitHubPullRequestFiles`。
- commit 兜底单元 ← 用 `workspaceGitLog` 取最新绑定 PR `headSha` 之后的 commit
  （无绑定 PR 时取会话近期 commit），每项用 `workspaceGitCommitDetail` 渲染。
  位于最新绑定 PR head 及之前的 commit 视为已被 PR 覆盖，不重复展示。

降级：

- 非 git 工作区：任何工作区都提供该页，面板显示「不是 git 仓库」。入口刻意不
  依赖 branch chip 的 git 状态——那只在 chip（或环境面板）可见时才抓取。
- `gh` 不可用 / PR 文件拉取失败：PR 单元仍显示（number、title、链接），并给出
  「文件列表不可用」状态，绝不出现空白面板。
- 共享（非 worktree）工作区：单元为工作区口径；头部标注口径，避免被误认为仅会话
  归属。

## 涉及文件

- `packages/core/src/utils/github-prs.ts`（+ 同目录测试）：PR 文件统计。
- `packages/cli/src/serve/routes/workspace-github-prs.ts`（+ 测试）：files 路由。
- `packages/cli/src/serve/capabilities.ts`：扩展 `workspace_github_prs` 标签
  注释（不新增标签、不改基线）。
- `packages/sdk-typescript/src/daemon/types.ts`、`DaemonClient.ts`（+ 测试）。
- `packages/web-shell/client/components/artifacts/`：总览页 + hook（+ 测试）。
- `packages/web-shell/client/App.tsx`：打开总览页、传入会话摘要。
- `packages/web-shell/client/i18n.tsx`：中英文案。

## 范围边界

- 只读。不新增 stage / commit / push / 创建 PR 行为。
- 不替代每轮工具调用卡片或现有审阅页；它们仍是轮级细节。总览是交付单元级汇总。
- 不实时监听文件树；总览在打开时、显式刷新时、以及已有的 git-status-change 事件
  后重新拉取。

## 分期

1. core PR 文件统计 + 路由 + SDK（唯一的新数据能力）。
2. Web Shell 总览页，含未提交 + PR + commit 兜底范围。
3. 验证（build、typecheck、聚焦单测、E2E）与自审。

## 待决问题

- 无绑定 PR 且无 `baseBranch` 时的 commit 兜底：展示 worktree 近期 commit
  （worktree 会话从零开始）还是要求 baseline。默认：近期 commit，设上限并按口径
  标注。
- 是否额外提供「整个会话」净 diff（baseline..工作区）作为一个范围。暂缓；已确认
  模型并不要求。
