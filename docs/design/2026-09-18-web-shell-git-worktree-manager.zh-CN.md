# Web Shell worktree 管理器

[English](2026-09-18-web-shell-git-worktree-manager.md) | [简体中文](2026-09-18-web-shell-git-worktree-manager.zh-CN.md)

状态：已实现。属于 [#11941](https://github.com/QwenLM/qwen-code/issues/11941)；同一 issue 中的提交历史泳道图与搜索见 [2026-09-18-web-shell-git-history-graph.zh-CN.md](2026-09-18-web-shell-git-history-graph.zh-CN.md)。

## 问题

Web Shell 用户可以在 worktree 中开会话，但 Web Shell 里没有任何地方列出仓库的 worktree，看不到哪些是脏的或过期的，也看不到每个 worktree 里跑着哪些会话。过期的 worktree 无声堆积，清理只能靠终端。

## 现状

- `packages/core/src/services/gitWorktreeService.ts` 中的 `GitWorktreeService` 为会话在 `<workspace>/.qwen/worktrees/<slug>` 下创建与删除托管 worktree，daemon 的 `POST /session` 每次请求创建一个。没有任何 daemon 路由列出 worktree。
- 住在托管 worktree 里的会话，其摘要（无论活跃还是持久化）都带 `worktree: { slug, path, branch }`。
- `packages/web-shell/client/components/dialogs/GitDialog.tsx` 中的 `GitDialog` 承载「变更」「提交历史」「拉取请求」三个标签页；拉取请求标签页由 daemon 能力特性门控。
- `exit_worktree` 拒绝删除有未提交改动的 worktree，除非调用方明确选择丢弃。

## 目标

- 列出工作区仓库的每个 worktree：路径、分支、HEAD、锁定与可清理状态、工作树计数，以及其中运行的会话。
- 从列表中删除 worktree，对破坏性情形拒绝执行，除非用户明确确认。
- 在同一界面恢复住在 worktree 里的会话，或新建 worktree 会话。
- 从分支 chip 进入该界面。

## 非目标

- 不新增 worktree 创建管道：「新建 worktree 会话」只是给输入区装上现有的 worktree 意图，由现有会话路由创建 worktree。
- 删除时不删分支；分支保留，删分支仍在分支选择器里做。
- 不列出其它仓库或其它工作区的 worktree。

## 设计

### Core

`packages/core/src/utils/git-worktrees.ts` 把 `git worktree list --porcelain -z` 包装成 `GitWorktreeEntry` 记录（path、head、branch、detached、bare、locked、prunable、isMain；主工作树是第一条），并封装 `git worktree remove [--force --force] -- <path>` 与 `git worktree prune`。它与分支辅助函数共用 `runGit`，因此环境变量清洗一致。

### Daemon 路由

三条工作区限定路由，全部为 **selected-runtime 作用域**：为 `:workspace` 解析受信任的 runtime，断言其 generation 打开，只对该 runtime 的 `workspaceCwd` 操作。没有任何一条回退到主 runtime。

- `GET /workspaces/:workspace/git/worktrees` 列出条目并附两个派生标记：`isWorkspace`（runtime 自己的检出，按真实路径比较）与 `slug`（位于该 runtime `.qwen/worktrees/` 下的条目的目录名）。非仓库返回 `available: false`。
- `GET /workspaces/:workspace/git/worktrees/status?path=` 返回某个已列出 worktree 的工作树计数。path 必须与列表条目精确匹配，否则 404，因此该路由永远无法探测任意目录。
- `POST /workspaces/:workspace/git/worktrees/remove`，请求体 `{ path, force? }`，走严格变更门。无论 `force` 与否都拒绝主工作树与任何已注册工作区（409 `worktree_is_main` / `worktree_is_workspace`）。不带 `force` 时，还会在该 worktree 有活跃会话（409 `worktree_in_use`，附 `sessions`）、工作树有暂存/未暂存/未跟踪/冲突条目（409 `worktree_dirty`，附 `changes`）或无法读取工作树（409 `worktree_status_unknown`）时拒绝。可清理条目（目录已丢失）走 prune 而非 remove。git 失败经共享的脱敏 git 错误路径返回。

能力特性 `workspace_git_worktrees` 宣告这些路由；旧 daemon 上标签页与 chip 条目保持隐藏。

### SDK

`WorkspaceDaemonClient` 新增 `workspaceGitWorktrees()`、`workspaceGitWorktreeStatus(path)`、`workspaceGitRemoveWorktree(path, { force })`，以及对应的 `DaemonGitWorktree*` 类型。

### Web Shell

`packages/web-shell/client/components/dialogs/GitWorktreesDialog.tsx` 中的 `GitWorktreesContent` 是 `GitDialog` 的第四个标签页「Worktree」，daemon 宣告该特性时显示。打开时同时拉取 worktree 列表与工作区会话列表，按 `worktree.path` 把会话关联到 worktree，每个 worktree 一行：slug 或目录名、徽标（主工作树、当前工作区、已锁定、目录已丢失）、分支或游离 HEAD、短 HEAD、工作树状态、其中的会话 chip，以及可删除条目的删除按钮。工作树状态在列表渲染后惰性拉取，每次三个请求，因此有数百个 worktree 的仓库也能即时列出。过滤框按路径、分支或 slug 收窄。

删除是两步行内确认。第一次请求从不强制。daemon 返回 409 时，确认区变成对将要丢失内容的说明（未提交改动数或运行中会话数），并给出「仍然删除」按钮，以 `force: true` 重发请求。其它失败显示 daemon 的消息，只提供取消。删除成功后重新拉取列表。

点击会话 chip 会关闭对话框并切换到该会话；「新建 worktree 会话…」关闭对话框并以装好 worktree 意图的草稿开始，与侧边栏入口走同一条路。`BranchPickerPopover` 在「管理远程仓库…」之后新增「管理 Worktree…」动作；`ChatEditor` 与 `EnvironmentPanel` 从 `App` 透传，`App` 仅在 daemon 宣告该特性时传入。

## 约束

- worktree 列表是仓库级的，因此包含在 Qwen Code 之外创建的 worktree。它们可以像其它条目一样删除，受同样的拒绝规则约束。
- 删除会删掉目录。强制删除会丢弃未提交的工作，并让活跃会话失去 cwd；第二次点击前的确认文案会说明这一点。
- 会话在客户端按会话列表的一页（100 条）关联；会话落在该页之外的 worktree 不显示会话。

## 验证

- `packages/core/src/utils/git-worktrees.test.ts`：porcelain 解析、真实仓库列出锁定与游离状态、删除对脏或锁定的 worktree 在强制前拒绝、清理。
- `packages/cli/src/serve/routes/workspace-git-worktrees.test.ts`：列表标记、不可用仓库、不受信任工作区、仅对已列出路径返回状态、删除空闲 worktree、对主工作树/已注册工作区/脏/使用中的拒绝、目录丢失时 prune、非法输入。
- `packages/web-shell/client/components/dialogs/GitWorktreesDialog.test.tsx`：带徽标的行、惰性状态、会话关联与打开、主工作树与当前工作区不可删除、确认与刷新、脏与使用中的拒绝及强制、原样显示的失败、过滤、新建会话入口、不可用占位。
- `packages/web-shell/client/components/dialogs/GitDialog.test.tsx`：标签页只在有能力时出现。
- `packages/web-shell/client/components/BranchPickerPopover.test.tsx`：「管理 Worktree…」条目。

## 验收标准

- Worktree 标签页列出仓库的每个 worktree 及其路径、分支、状态与会话，即使有数百条也即时加载。
- 干净且空闲的链接 worktree 一次确认即可删除；脏的或有会话的需要第二次明确的「仍然删除」。
- 主工作树与已注册工作区在该标签页中永远不可删除。
- 列在 worktree 下的会话点击即打开；「新建 worktree 会话…」开始一个 worktree 草稿。
