# Web Shell 会话绑定 GitHub Issue 号（由 PR 派生）

日期：2026-08-27
状态：已确认范围（路线 A）

## 问题

[会话绑定 PR 号](2026-08-20-webshell-session-pr-binding.md)落地后，侧栏能回答"哪个会话产出了 PR #N"，但回答不了"哪个会话在处理 issue #N"。维护者的主力流程（bugfix / triage / autofix develop-issue）都从 issue 出发，最终以 PR 收口。

Issue 和 PR 的语义不同：PR 是会话的**产出**，会话自己在 GitDialog 里点了 Create PR，daemon 有一个精确的写入点；Issue 是会话的**意图**，web-shell 里没有任何结构化写入点（`/bugfix #N` 是提示词参数，`create-issue` skill 是模型自己跑 `gh issue create`），而 PR 与 Issue 共用编号空间，扫描提示词或分支名会误绑。

## 方案：从已绑 PR 派生

GitHub 上 PR 与 Issue 的关联已经存在——PR 正文里的 `Fixes #N` 就是 `closingIssuesReferences`。不新增写入点，也不新增 sidecar；daemon 现有的 PR 状态刷新定时器顺手把每个已绑 PR 关闭的 issue 及其状态快照进同一个 sidecar 条目。

### 数据模型

`SessionPr` 条目增加可选字段：

```json
{
  "number": 10303,
  "url": "https://github.com/QwenLM/qwen-code/pull/10303",
  "createdAt": "...",
  "state": "open",
  "issues": [
    {
      "number": 10293,
      "url": "https://github.com/QwenLM/qwen-code/issues/10293",
      "state": "open"
    }
  ]
}
```

- `issues` 缺省表示"尚未抓取"；空数组表示"抓过，没有"。二者区别决定 sweep 是否还需要为该 PR 发查询。
- `state`：`open` / `completed` / `not_planned`（GitHub 的 `stateReason` NOT_PLANNED 与 DUPLICATE 都归 `not_planned`）。
- 每个 PR 最多保留 10 个 issue（`SESSION_PR_ISSUE_LIST_LIMIT`，GraphQL 也只取 `first: 10`）；url 与 PR url 同样只接受 http(s)、限长、无控制字符——core sidecar 校验、bridge 类型、SDK `isDaemonSessionPrInfo` 三层同步。
- 派生数据跟着来源走：PR 条目被 cap 淘汰时 issue 一起走；同 PR 重绑（`upsertSessionPr` / bridge `updateSessionMetadata`）保留已有 `issues`，跨仓库同号 PR 不继承。客户端永远不能写 `issues`。

### 抓取

新增 core 工具 `fetchGitHubPullRequestIssues(cwd, env, numbers)`，一条 `gh api graphql`，用 gh 自带的 `{owner}` / `{repo}` 占位符解析仓库，按编号别名查询：

```graphql
p10303: pullRequest(number: 10303) {
  number url
  closingIssuesReferences(first: 10) { nodes { number url state stateReason } }
}
```

为什么不在 `gh pr list --json` 上追加 `closingIssuesReferences`：

1. 该字段不带 issue state，仍需第二条查询；
2. 实测 `--state all --limit 500` 加该字段从 4.9s 涨到 6.7s（gh 超时 10s），现有 sweep 的 list 查询保持原样零风险；
3. 按编号查询不受 500 条窗口限制，老 PR 也能补齐。

每次调用最多 100 个别名，超出分批；任一批失败整体返回 `failed`。gh 对 NOT_FOUND 别名（绑定指向别的仓库的同号 PR）以非零退出码返回，但 stdout 仍带其它别名的完整数据——包装器在 stdout 有 JSON 时照常解析，未解析的别名直接缺席。

### Sweep 集成

`refreshWorkspaceSessionPrStates` 每 workspace 每轮：

1. 扫描 sidecar，挑出 `state !== 'merged' || issues === undefined` 的绑定（open/closed 的 closing references 会随正文编辑变化；merged 但无快照的是升级前的存量，只补一次）。
2. 若存在非 merged 绑定，跑原有 slim `gh pr list --state all` 刷 PR state（不变）。
3. 对第 1 步的编号去重后跑一次 GraphQL 拿 issues。
4. 每个 sidecar 一次 `updateSessionPrStates` 原地写入 state + issues：url 不匹配不写；`state` / `issues` 任一缺省则保留原值；都无变化则不写文件。
5. 收敛：merged 且无快照、又永远不可能被查询解析到的绑定写入空快照 `issues: []`（渲染上等同于没有），否则它会永远重新进入查询，违背"全 merged 且有快照零调用"的不变量。触发条件：查询成功但仓库不认识该编号（外仓同号 PR）、查询结构上不可能（无 gh / 无 git root）、平台根本没有 closing references（Aone）。瞬时失败（`failed`）不收敛。
6. 可解析性过滤：用列表查询返回的 PR url 推出本 workspace 仓库的 `host/owner/repo` 键，url 不在该仓库下的绑定不进入查询（与 Aone 的 refreshable 过滤对称），merged 的直接本地收敛；列表没跑或为空则放行进查询，由逐别名 NOT_FOUND 收敛。
7. 查询结果与绑定的匹配按 `host/owner/repo` + 编号（容忍 `www.`、`http:`、`/files` 后缀、大小写），命中后以绑定自己的 url 写入——sidecar 的写入门仍按 canonical url 比对，这一宽松匹配只限 sweep 内部，其它同 PR 判定（重绑、session-list 合并）不放宽。
8. GraphQL 响应的顶层 `errors[]` 必须检查：只有 `path: ['repository', '<alias>']` 的 NOT_FOUND 才代表"仓库没有该 PR"；其它局部错误（服务端错误置空某别名、子字段错误置空 closingIssuesReferences）一律当 `failed`，否则一次瞬时错误会被洗成 `ok` 并永久写空快照。gh 因无远端 / 远端不是 GitHub 而解析不了仓库（stderr 里的 placeholder 解析报错），或仓库在 GitHub 侧已不存在（`NOT_FOUND` 且 `path: ['repository']`、`data.repository` 为 null），都归为结构性的 `repo_unresolved`，参与收敛。

成本：全 merged 且已有快照的 workspace 零调用；否则多一条 ~1–3s 的 GraphQL。已合入 PR 的 issue 之后被 reopen 不再跟踪（与"merged 是终态"同一取舍）。

### 线协议与展示

- bridge `SessionPrInfo` / SDK `DaemonSessionPrInfo` 增加 `issues?`；所有 sidecar → 线协议投影统一走 core 新增的 `toSessionPrInfo`（原先散落在 session-list / session.ts / dispatch / backfill / bridge 共 8 处手写的 `{number, url, state?}`）。
- `mergeSummaryPrs`：`issues` 与 `state` 一样以 sidecar 为准（live entry 停在绑定时刻），且与其它合并点一致只在 canonical url 相同时才采用——跨仓库重绑的 live 变更与 sidecar 写入之间，旧 sidecar 仍指向别的仓库的同号 PR。
- 写入侧类型（bridge `SessionMetadataUpdate.pr`、SDK 三个 `updateSessionMetadata` 参数）用 `Omit<…, 'issues'>`，客户端绑 issue 是编译错误；运行时 bridge 也只从已知快照重建 `issues`。
- web-shell：
  - `SessionDetailsTooltip` 在 PR 行之后列出 issue（按 url 去重，stacked PR 关同一个 issue 只列一次），复用 GitHub 视觉词汇：open 绿 circle-dot、completed 紫 circle-check、not planned 灰 circle-slash；可见文本 `Issue #N`，sr-only 追加状态。
  - 侧栏搜索 `sessionMatchesGitQuery` 命中 issue 号（带不带 `#` 都行）。
  - 会话行 badge 保持只显示 PR，避免 `#N` 并排歧义。
- 时延：GitDialog 创建 PR 后，issue 在下一轮 sweep（首轮 60s 延迟、之后 5 分钟）出现；`QWEN_SESSION_PR_REFRESH_MINUTES` 不变。

## 关键决策

- **派生而非绑定**：唯一高精度的来源是 GitHub 自己的 closing references；显式输入绑定（`/bugfix #N` 拦截、欢迎页入口）留作后续路线，届时再考虑独立 sidecar。
- **挂在 PR 条目上而非独立 sidecar**：派生数据的生命周期等于来源 PR，独立文件会引入第二套 cap、归档移动和写入 lane。
- **保留 `gh pr list` 不动**：sweep 的 list 查询已经贴近超时上限，issue 单独走按编号 GraphQL。

## 影响文件

| 层        | 文件                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core      | `services/session-pr-service.ts`（`SessionPrIssue`、校验、`toSessionPrInfo`、`updateSessionPrStates` 扩展）、`utils/github-pr-issues.ts`（新增）                |
| daemon    | `serve/server/session-pr-refresh.ts`（sweep 第二阶段）、`session-list.ts`、`routes/session.ts`、`acp-http/dispatch.ts`、`routes/session-pr-backfill.ts`（投影） |
| bridge    | `bridgeTypes.ts`、`bridge.ts`（类型、重绑保留、投影）                                                                                                           |
| SDK       | `daemon/types.ts`、`daemon/session-pr.ts`、`daemon/index.ts`                                                                                                    |
| web-shell | `SessionPrStateIcon.tsx`(+css)、`sidebar/SessionDetailsTooltip.tsx`、`sidebar/sessionSearch.ts`、`i18n.tsx`                                                     |
| 测试      | 上述各层 collocated 单测                                                                                                                                        |

## 范围边界（明确不做）

- 显式 issue 绑定入口与独立 issue sidecar。
- 从提示词 / 分支名 / commit trailer 反推 issue 号。
- 会话行 badge 显示 issue；回填路由立即抓 issue（下一轮 sweep 兜底）。
- 已合入 PR 的 issue 被 reopen 后的状态跟踪。
