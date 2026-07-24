# Web Shell GitHub PR 只读列表

## 问题陈述

Web Shell 已有 Git 能力(状态芯片、`/diff`、`/log` 对话框、Git mode
popover),但用户想看当前仓库的开放 PR(状态、CI、review)时必须打断会话
问 agent,或切到浏览器。目标是在现有 Git 对话框中增加一个只读
"Pull requests" 标签页,让用户不打断会话即可瞟一眼 PR 状态。

范围边界(已与需求方确认):

- **做**:只读开放 PR 列表(标题、分支、作者、review 状态、CI 聚合状态、
  更新时间),点击跳转 github.com。
- **不做**:Issue 面板、创建 PR / 提交 review 的表单(agent 用 `gh` 已能
  完成,重复建设)、PR 详情展开、分页、自动刷新。

## 现状

- daemon 有三层路线模式:`packages/cli/src/serve/routes/workspace-git*.ts`
  用 `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime`
  做 workspace 路由与 trust 门控;核心逻辑在 core
  (`packages/core/src/utils/gitDiff.ts` 的 `fetchGitLog` 等,`execFile`
  - 超时);SDK `WorkspaceDaemonClient` 经 `workspaceJsonRequest` 暴露
    类型化方法。
- daemon 侧 GitHub 先例只有 `POST /workspace/setup-github`(写 workflow)
  与技能安装(直连 GitHub API,用 `GH_TOKEN`/`GITHUB_TOKEN`)。
- Web Shell 的 `GitDialog` 是 tab 容器(`'diff' | 'log'` 两个 view),
  由 `/diff`、`/log` 本地命令和侧栏打开;内容组件
  (`GitDiffContent`/`GitLogContent`)经
  `client.workspaceByCwd(cwd).workspaceGit*()` 取数。
- capability 通过 `SERVE_CAPABILITY_REGISTRY` 登记,Web Shell 用
  `capabilities?.features?.includes(tag)` 门控 UI。

## 方案

### 1. core:`packages/core/src/utils/github-prs.ts`(新)

`fetchGitHubPullRequests(cwd)`,经 `execFile`(参数数组,无 shell 插值,
`windowsHide`,10s 超时)执行:

```
gh pr list --state open --limit 30 --json number,title,url,author,headRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt
```

设计决定:

- **用 `gh` CLI 而非直连 REST API**。AGENTS.md 规定 GitHub 操作一律走
  `gh`;复用用户已有的 `gh auth` 登录,无需 token 配置 UI;`gh` 自动识别
  fork 的 upstream remote;`statusCheckRollup` 一次调用拿到 CI 聚合。
- 先 `git rev-parse --is-inside-work-tree` 探活:非 git 仓库返回
  `{ kind: 'not_a_repo' }`,避免把 "not a git repository" 的 gh stderr
  当错误。
- 结果判别:
  - `ENOENT`(gh 未安装)→ `{ kind: 'cli_unavailable' }`
  - gh 非零退出(未登录、无 GitHub remote、网络)→
    `{ kind: 'failed', message }`(stderr 截断 512 字符)
  - 成功 → 按 `updatedAt` 降序排序,逐项归约:
    - `state`: `'open' | 'draft'`(由 `isDraft` 得出)
    - `reviewDecision`: `'approved' | 'changes_requested' | 'review_required' | null`
    - `checks`: `'passing' | 'failing' | 'pending' | 'none'` —— 在
      daemon 侧聚合 `statusCheckRollup`,面板只渲染一个图标,不下发原始
      rollup 数组。failure 结论(CheckRun 的 FAILURE/CANCELLED/TIMED_OUT/
      ACTION_REQUIRED/STARTUP_FAILURE/STALE,StatusContext 的 ERROR/FAILURE,
      与 `gh pr checks` 的口径一致:cancelled/stale 同样阻塞合并)优先,
      其次未完成(conclusion 为空 / PENDING / EXPECTED),再次成功类
      (SUCCESS/NEUTRAL/SKIPPED);空数组为 `'none'`。
- 返回判别联合,**不抛异常**;错误语义由路由层翻译。

### 2. daemon 路由:`packages/cli/src/serve/routes/workspace-github-prs.ts`(新)

```
GET /workspaces/:workspace/github/prs
```

- 严格复用 `workspace-git-log.ts` 模式:`resolveWorkspaceRuntimeFromParam`
  - `requireTrustedWorkspaceRuntime`,只注册 workspace-qualified 形态
    (Web Shell 只走 `workspaceByCwd`;无旧客户端需要单数形态)。
- 响应(均带 `applyReadHeaders`):
  - 200 `{ v: 1, workspaceCwd, available: true, pullRequests: [...] }`
  - 200 `{ v: 1, workspaceCwd, available: false, pullRequests: [] }`(非
    git 仓库;`pullRequests` 恒在,与 `DaemonGitLog.entries` 风格一致)
  - 502 `{ error, code: 'github_cli_unavailable' }`(gh 未安装)
  - 502 `{ error, code: 'github_prs_failed' }`(gh 失败;message 中的
    workspace 路径替换为 `<workspace>`,同 setup-github 的 sanitize 先例)
- 不做缓存与轮询;每次打开对话框拉一次。
- capability 登记 `workspace_github_prs: { since: 'v1' }`(无条件 tag:
  路由契约恒存在,运行时可用性由错误码表达——与 `workspace_github_setup`
  一致)。
- `server.ts` 注册,紧邻 git 路由。

### 3. SDK:`packages/sdk-typescript/src/daemon/`

- `types.ts`:
  - `DaemonGitHubPullRequest`:`{ number, title, url, author, headRefName,
state: 'open'|'draft', reviewDecision: ... | null, checks: ...,
updatedAt: number }`(`updatedAt` 为 epoch 秒)
  - `DaemonGitHubPullRequestList`:`{ v: 1, workspaceCwd, available: boolean,
pullRequests?: DaemonGitHubPullRequest[] }`
- `DaemonClient.ts` 的 `WorkspaceDaemonClient` 增加
  `workspaceGitHubPullRequests()`,走 `workspaceJsonRequest(..., '/github/prs',
'GET /workspaces/:workspace/github/prs', { mode: 'rest' })`。

### 4. Web Shell

- `client/components/dialogs/GitHubPrsDialog.tsx`(新):导出
  `GitHubPrsContent`(`{ workspaceCwd, onSubtitleChange }` 签名与
  `GitLogContent` 一致)。
  - 挂载时经 `client.workspaceByCwd(workspaceCwd)
.workspaceGitHubPullRequests()` 拉取;渲染行:状态图标(open/draft)、
    `#number 标题`、分支、作者、相对更新时间、review 徽标、CI 图标。
  - 行点击 `window.open(url, '_blank', 'noopener')`。
  - 状态文案:loading / 空列表 / `available:false`(非 git 仓库)/
    `github_cli_unavailable`(引导安装 gh)/ 其他失败(错误 + 重试按钮)。
  - 副标题上报 `N 个开放 PR`。
- `GitDialog.tsx`:view 联合加 `'prs'`,第三个 tab
  (`githubPrs.title`,中英文 "Pull requests"/"拉取请求");tab 键盘导航
  (ArrowLeft/Right/Home/End)适配三个 tab。
- 入口:
  - 本地命令 `/prs`(`constants/localCommands.ts` + App.tsx 分支,仿
    `/log`;无 workspace 时 toast),打开 GitDialog `view: 'prs'`。
  - capability `workspace_github_prs` 不存在时隐藏 tab 与 `/prs` 命令
    (旧 daemon 404 防护)。
- i18n:`githubPrs.*`、`local.prs`、`localCommand.prsNoWorkspace` 中英文。

### 5. 测试

| 层        | 文件                                                           | 覆盖                                                                                              |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| core      | `utils/github-prs.test.ts`                                     | mock execFile:成功解析/排序/checks 聚合/reviewDecision 映射;非 repo;ENOENT;gh 失败                |
| cli       | `serve/routes/workspace-github-prs.test.ts`                    | mock core 函数:200 两形态、untrusted 403、unknown 400、cli_unavailable 502、failed 502 + 路径脱敏 |
| sdk       | DaemonClient 测试                                              | 方法命中正确路径与 query                                                                          |
| web-shell | `GitHubPrsDialog.test.tsx`、`GitDialog.test.tsx`、App 命令测试 | 各状态渲染、tab 切换、capability 门控、`/prs` 打开对话框                                          |
| e2e       | `.qwen/e2e-tests/web-shell-github-prs.md`                      | 真 daemon + 本仓库(真 gh)端到端;mockDaemon 补路由                                                 |

## 关键文件

| 文件                                                                            | 动作        |
| ------------------------------------------------------------------------------- | ----------- |
| `packages/core/src/utils/github-prs.ts`                                         | 新增        |
| `packages/core/src/index.ts`(或对应导出面)                                      | 导出        |
| `packages/cli/src/serve/routes/workspace-github-prs.ts`                         | 新增        |
| `packages/cli/src/serve/capabilities.ts`                                        | 登记 tag    |
| `packages/cli/src/serve/server.ts`                                              | 注册路由    |
| `packages/sdk-typescript/src/daemon/types.ts` / `DaemonClient.ts`               | 类型 + 方法 |
| `packages/web-shell/client/components/dialogs/GitHubPrsDialog.tsx`              | 新增        |
| `packages/web-shell/client/components/dialogs/GitDialog.tsx`                    | 第三 tab    |
| `packages/web-shell/client/App.tsx` / `constants/localCommands.ts` / `i18n.tsx` | 入口 + 文案 |

## 开放问题

- 无。`gh` 缺失/未登录、非 git 仓库、旧 daemon 三条降级路径均有明确
  UI 语义。
