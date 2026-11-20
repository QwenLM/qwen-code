# Web Shell 变更总览（按交付单元划分）

语言：[English](./2026-11-16-web-shell-change-overview.md) | 中文

> **已被取代的边界机制。** 本文描述 #17378 交付时的设计。其 commit 兜底边界——
> files 路由的 `git merge-base --is-ancestor` 探针（`headIsAncestor`）与 hook 的
> 「最新祖先 head」窗口——已由跟进设计
> [变更总览边界修复](./2026-11-17-change-overview-boundary-fix.zh-CN.md)**退役**：
> 跟进设计把窗口定界到会话不可变起点 commit，并用单次原生
> `git log <range> --not <refs>` 排除从任一绑定 PR head（及基线分支）可达的所有
> 提交。下文「Files 路由」「UI 组装」「降级」「涉及文件」各节以现在时描述原祖先
> 探针机制，仅为保留历史准确；应读作已被跟进设计取代，而非当前行为。

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

会话归属在会话摘要上现成可用——无需自行推导 baseline——但本设计依赖一个持久性
前提：

- `DaemonSessionSummary` 携带 `worktree?: DaemonWorktreeInfo`
  （`{ slug, path, branch }`）、`branch?: DaemonBranchInfo`（`{ name, baseBranch }`）、
  以及 `prs?: DaemonSessionPrInfo[]`（绑定的 PR，
  `{ number, url, state, source, issues }`，末位为最新）。`source` 记录绑定来源
  （`create` / `worktree` / `review`），由 wire 投影（`toSessionPrInfo`）透传。
  见 `packages/sdk-typescript/src/daemon/types.ts`。
- 从 Git 对话框创建 PR 时，PR 服务
  （`packages/core/src/services/session-pr-service.ts`）会把 PR 绑定到会话，并
  体现在会话摘要上。
- daemon 重启/重载后 bridge 条目重建时**不带** `prs`，因此
  `GET /session/:id/status`（`packages/cli/src/serve/routes/session.ts`）在读取
  摘要**之前**先从持久化 sidecar 补齐绑定（`readSessionPrs` +
  `bridge.seedSessionPrs`，实时条目已有绑定时为 no-op）。这条最常被调用的会话
  路由上的无条件 sidecar 读取，正是绑定 PR 跨重启持久的原因；缺了它，重开的会话
  会丢失全部 PR 范围，并把已被 PR 覆盖的 commit 当作 loose 工作重新列出。

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
`fetchGitHubPullRequestFiles(cwd, number, env?, repo?)`，底层用
`gh pr view <number> --json files,additions,deletions,headRefOid,changedFiles`
（绑定 PR 属于其他仓库或 Enterprise host 时另加 `--repo [host/]owner/repo`）。
host 按 `gh` 文档化的 `[HOST/]OWNER/REPO` 形式透传：裸 `owner/repo` 会在
github.com（或 `GH_HOST`）上解析，可能返回外仓库同编号 PR 的数据。slug 校验器
接受普通 `owner/repo`，或裸点分主机名（可带 `:port`）前缀——绝不接受 URL、空白
或前导 `-`；host 必须点分或带端口，使 `owner/repo/extra` 无法冒充带 host 的形式。
返回与现有 PR 助手一致的可辨识结果（`ok` / `not_a_repo` / `cli_unavailable` /
`failed`），并给出解析且设上限的文件列表：

- `files: { path, additions, deletions }[]`（设上限，附 `hiddenCount`），
- `additions`、`deletions` 汇总，
- `headSha`（`headRefOid`），用于界定 commit 兜底窗口。

`gh` 输出不可信；复用 `fetchGitHubPullRequestView` 现有的脱敏 / 超时 / cwd 守卫
模式。每文件列表以 `GITHUB_PR_FILES_MAX` 设上限，但 `gh` 自身会把 `files` 数组
截断到远低于该上限（当前 CLI 为 100 行），因此 `hiddenCount` 以 PR 全面的
`changedFiles` 总数推导，而非解析出的行数——如此大 PR 的文件数与「…另有 N 个」
提示才准确。这与 git diff 路由的 `MAX_FILES` 是不同机制，二者并非同一套界限。

### 路由层（serve）

在 `packages/cli/src/serve/routes/workspace-github-prs.ts` 新增
`GET /workspaces/:workspace/github/prs/:number/files`，沿用现有限定路由模式：
解析可信运行时、解析会话托管的 git cwd、调用 core 助手、套用只读响应头并返回
文件列表。该路由挂在**新增**的 `workspace_github_pr_files` capability 标签下，
遵循注册表「新行为要有新 tag」的规则——预检过 `workspace_github_prs` 的客户端
据此能判断 files 路由是否存在，而不必乐观探测。钉死的 capability 基线
（server.test.ts、capability-parity.ts、集成 capabilities 信封）随新 tag 同步。
客户端用 `workspace_github_pr_files` 作为拉取 PR 文件的门槛；没有该标签的
daemon 不显示 PR 范围，有标签但拉取失败的降级为「文件列表不可用」并给出真实原因。
传入但不可用的 `repo`（重复查询键、空值、或 core 校验器拒绝的 slug）属调用方错误，
回 `400`，按机器可读的 `reason: 'invalid_repo'` 分类而非面向人的文案——改文案不会
把它变成可重试的 `502`。未传 `repo` 时在会话自身仓库按编号解析。`ok` 结果还会探测
`git merge-base --is-ancestor <headSha> HEAD`（`packages/core/src/utils/gitDiff.ts`
的 `isGitAncestorOfHead`）并返回 `headIsAncestor`：客户端只在该 head 是 HEAD 祖先时
才信任 `<head>..HEAD` 作为 commit 兜底边界——已合并或被改写的 PR 的 head 在本地仍
可解析，但不是祖先，那个窗口会把基线分支历史当作本会话的 loose 工作重新列出。
探测失败即拒绝该边界（`false`）。

总览本身**在客户端组合**现成路由加这一个新路由，而不是新增一个大型聚合端点。
这样每一块都小而可复用，也与 Git 对话框已经组合 `git/diff`、`git/log`、
`github/prs` 的方式一致。

### SDK

在 `packages/sdk-typescript/src/daemon/types.ts`、`DaemonClient.ts` 新增
`DaemonGitHubPullRequestFile` / `DaemonGitHubPullRequestFiles` 类型（并在 `daemon`
barrel 中与兄弟 PR 类型一并重导出）与
`workspaceGitHubPullRequestFiles(number, cwd?, sessionId?, repo?)` 客户端方法，与现有
PR 方法保持一致。

### UI（web-shell）

在右侧 `ArtifactPanel` 新增**变更总览**页，从「+」菜单打开（位于现有「文件更改」
入口旁）。渲染：

- **范围选择器**，列出交付单元：
  - `未提交`（工作区是 git 仓库时始终存在），
  - 每个绑定 PR 一项（`summary.prs`，排除 `source === 'review'` 的绑定——仅被
    评审过的 PR 不是本会话的交付），标注 `#number`（摘要的绑定 PR 条目不含
    标题），并附 PR 链接，
  - 未被绑定 PR 覆盖的 commit 的兜底项。
- 所选单元的**文件列表（每文件 `+/-`）与总规模头部**，复用现有 `LineStats`
  渲染。逐行 diff 仍由 Git 对话框 / 审阅页承担；总览只做文件列表 + 规模汇总。

组合逻辑放在可测试的 hook `useChangeOverview`：

- 未提交单元 ← `workspaceGitDiff(cwd, sessionId)`。
- PR 单元 ← `summary.prs`，每项拉取 `workspaceGitHubPullRequestFiles`。
- commit 兜底单元 ← 用 `workspaceGitLog` 取最新绑定 PR head 之后的 commit，
  且仅当**每个**绑定 PR head 都**是 HEAD 祖先**（`headIsAncestor`）时才以该
  head 为边界。任一绑定 PR head 不是祖先（已合并或被改写）时，即便较旧的祖先
  head，其窗口也会跨越吸收了合并工作的基线历史，因此边界退回会话基线分支；
  无基线且无绑定 PR 时取 HEAD 近期历史（daemon 的 detached-HEAD `'HEAD'` 哨兵
  视为无基线；`HEAD..HEAD` 恒空）。无可信边界的抑制以会话绑定 PR 为准，而非
  产出的 PR 单元，因此 files 能力缺失时同样成立。每项用 `workspaceGitCommitDetail`
  渲染。位于边界及之前的 commit 视为已被 PR 覆盖，不重复展示。合并提交被跳过；
  commit detail 拉取失败会让整个总览失败（见降级）。基线分支若在 daemon 区间
  白名单之外，则整体跳过兜底（独立的「拒绝」哨兵），而不是落到无界遍历、把会话
  之前的历史重新列出；有绑定 PR 但无可信边界且无已知基线分支时，兜底同样被抑制。
  head 边界 log 被报为不可用时，hook 用基线分支窗口重试一次——仅当该窗口是真实
  range 字符串时才重试，绝不使用「无基线」哨兵，因为其缺省 range 会无界遍历 HEAD。

降级：

- 非 git 工作区：任何工作区都提供该页，面板显示「不是 git 仓库」。入口刻意不
  依赖 branch chip 的 git 状态——那只在 chip（或环境面板）可见时才抓取。
- `gh` 不可用 / PR 文件拉取失败：PR 单元仍显示（number、链接），并给出
  「文件列表不可用」状态，绝不出现空白面板。
- git diff 瞬时拉取失败（超时 / 5xx）：独立的「无法加载」可重试状态，不误标为
  「不是 git 仓库」。
- 任一产出的 PR 单元解析不出 head：完全抑制 commit 兜底，避免该 PR 的 commit
  在较旧 PR head 界定的窗口里被当作 loose 工作重新列出。files 能力缺失时不产出
  PR 单元，兜底仍运行。
- commit log 被 daemon 报为不可用、commit log 拉取抛错（超时 / 5xx）、或 commit
  detail 拉取失败：可重试的「无法加载」状态，而非空会话或把部分列表当作完整列表。
  基线窗口重试被拒绝时保留首次响应的不可用结论，不会抹成「没有 loose commit」。
- 绑定中存在已合并或被改写的 PR（任一 head 不是 HEAD 祖先）：不用任何 head 作
  兜底边界——较旧祖先 head 的窗口会跨越吸收了合并工作的基线历史；改用基线分支
  窗口，无已知基线分支时抑制兜底。
- 绑定 PR 属于另一仓库（或 Enterprise host）时，按其 URL 推导 `[host/]owner/repo`
  （含 host）并用 `gh --repo` 在该仓库解析，而非在会话检出里按编号查。
- 共享（非 worktree）工作区：单元为工作区口径，而非仅会话归属。

## 涉及文件

- `packages/core/src/utils/github-prs.ts`（+ 同目录测试）：PR 文件统计与带 host
  的 `[host/]owner/repo` slug 校验。
- `packages/core/src/utils/gitDiff.ts`（+ 同目录测试）：commit 兜底边界的
  `isGitAncestorOfHead` 祖先探针。
- `packages/core/src/services/session-pr-service.ts`（+ 测试）：wire 投影透传
  绑定 `source`。
- `packages/cli/src/serve/routes/workspace-github-prs.ts`（+ 测试）：files 路由，
  含 `ok` 结果上的 `headIsAncestor` 探针。
- `packages/cli/src/serve/routes/session.ts`（+ server.test.ts）：status 路由
  绑定补齐（读摘要前先读 sidecar + `seedSessionPrs`）。
- `packages/cli/src/serve/capabilities.ts`、`capability-parity.ts`、
  `server.test.ts`、`integration-tests/cli/qwen-serve-routes.test.ts`：新增
  `workspace_github_pr_files` 标签及其钉死基线。
- `packages/sdk-typescript/src/daemon/types.ts`、`DaemonClient.ts`、`index.ts`
  （+ 测试）：类型、客户端方法与 barrel 重导出。
- `packages/web-shell/client/components/artifacts/`：总览页 + hook（+ 测试）。
- `packages/web-shell/client/customization.tsx`：`changeOverview` 右面板项。
- `packages/web-shell/client/App.tsx`：打开/持久化/恢复总览页并回填会话 id、传入
  会话摘要。
- `packages/web-shell/client/main.tsx`（+ 测试）：独立入口 rightPanel items 列出
  `changeOverview`，使功能在发行版 shell 中可达。
- `packages/web-shell/client/i18n.tsx`（+ 对齐测试）：中英文案。

## 范围边界

- 只读。不新增 stage / commit / push / 创建 PR 行为。
- 不替代每轮工具调用卡片或现有审阅页；它们仍是轮级细节。总览是交付单元级汇总。
- 不实时监听文件树，也不订阅 git-status-change 事件；总览仅在打开时与显式刷新时
  重新拉取。

## 分期

1. core PR 文件统计 + 路由 + SDK（唯一的新数据能力）。
2. Web Shell 总览页，含未提交 + PR + commit 兜底范围。
3. 验证（build、typecheck、聚焦单测、E2E）与自审。

## 已知限制

合入时接受的两条展示残留均已由跟进设计
[变更总览边界修复](./2026-11-17-change-overview-boundary-fix.zh-CN.md)**解决**：
该设计用单一的 `<start>..HEAD --not <绑定 heads>` 窗口取代「最新祖先 head」
启发式。

- **无绑定 PR 且无记录基线分支时的 commit 兜底**（原 R7-1）。已交付的默认
  行为遍历 HEAD 近期历史，因为「worktree 会话从零开始」的前提不成立。跟进
  设计记录会话起点 commit 并组 `<startCommit>..HEAD`；无起点 commit 时，若
  记录了基线分支则回退到 `<baseBranch>..HEAD`，仅当两者皆无才抑制兜底——
  绝不发起无范围遍历。（因此 `originalBranch` 有值但 `originalHeadCommit`
  为空的 legacy worktree sidecar，仍得到一个由会移动的本地分支名界定的窗口。）
  起点 commit 对 **worktree 会话 durable**（sidecar 的 `worktreeBase`，否则
  `originalHeadCommit`），但对**分支与普通会话仅 live**：分支元数据不在
  daemon 重启后恢复，而普通会话根本没有分支元数据——其起点 commit 是 spawn
  时在工作区检出读取的 `getHeadCommit`，只存在于 live bridge entry、从不持久化
  ——故恢复的分支/普通会话抑制兜底，而非遍历 HEAD。
- **绑定时间序非提交图序**（原 R7-2）。两个不可比的祖先 head 使最后绑定
  head 的窗口重复列兄弟 PR 的提交。跟进设计用一次原生
  `git log <range> --not <heads>` 排除从*任一*绑定 PR head 可达的所有提交，
  统一处理已合并、并行与不可比的 head。

## 待决问题

- 是否额外提供「整个会话」净 diff（baseline..工作区）作为一个范围。暂缓；已确认
  模型并不要求。
