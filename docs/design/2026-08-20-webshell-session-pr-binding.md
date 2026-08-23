# Web Shell 会话绑定 GitHub PR 号

日期：2026-08-20
状态：已确认 MVP 范围

## 问题

Web Shell 同时运行 20+ 会话时，侧栏信息不足以回答"哪个会话对应 PR #N"。
当前链路全断：

1. `GitDialog.doCreatePr` 创建 PR 拿到 `{url, number}` 后只显示状态消息，不回写（`packages/web-shell/client/components/dialogs/GitDialog.tsx:502-553`）。
2. `DaemonSessionSummary` / `BridgeSessionSummary` 无 PR 字段；`updateSessionMetadata` 只放行 `displayName`。
3. 侧栏搜索只匹配标题和 sessionId（`WebShellSidebar.tsx:3289-3302`），不匹配分支名、worktree slug、PR 号。
4. 无任何持久化载体，daemon 重启后即使内存绑定也会丢。

## 方案

### 数据模型

`DaemonSessionSummary` 与 `BridgeSessionSummary`（镜像，需同步）增加：

```json
"prs": [{ "number": 9517, "url": "https://github.com/owner/repo/pull/9517", "state": "open" }]
```

- 一个会话可能创建多个 PR（stacked PR、连续修复），`prs` 按绑定时间排序（最后一个 = 最新），上限 10 个（超出丢弃最旧）。同号重复绑定刷新 url 并移到最新位。
- `state`：可选快照，取值 `open` / `merged` / `closed`；写入端（GitDialog）记 `open`，回填记 gh 查询时刻的值，刷新定时器负责 open→merged/closed 迁移。badge 对 merged 弱化显示。
- `number`：正整数；`url`：http(s) URL（badge/tooltip 直接作为链接目标渲染，拒绝 `javascript:` 等 scheme——route、bridge、SDK 校验器、sidecar 校验四层统一要求）。
- 字段可选、可缺省；不提供"清除"语义。
- 写入 API 保持单条：`updateSessionMetadata(sessionId, { pr: {number, url} })` 每次绑定一个，daemon 负责 upsert 进列表；读取/事件/响应均为完整 `prs` 数组。

### 写入端

- SDK `DaemonClient.updateSessionMetadata` 的 metadata 参数扩展 `pr?: { number: number; url: string }`（单条）；响应解析完整 `prs` 数组。
- daemon 两个 PATCH metadata 路由（`/session/:id/metadata` 与 workspace 作用域版本）校验 `pr` 后透传，bridge 更新成功后将 sidecar upsert 的完整列表回显在响应里。
- bridge `updateSessionMetadata`（`packages/acp-bridge/src/bridge.ts`）先做全部校验再变更（组合请求不允许部分生效）；upsert 进 live entry.prs（去重按 number，上限 10），`session_metadata_updated` SSE 事件 data 带完整 `prs`。
- ACP `session/update_metadata`（`acp-http/dispatch.ts`）同样把最新绑定 upsert 进 sidecar。
- `GitDialog.doCreatePr` 成功后：仅用 dialog 已有的 `sessionId`（`sessionIdRef.current`，即连接会话或 dialog 已为提交信息生成等操作解析出的会话）调用 `updateSessionMetadata(sessionId, { pr })`。**不调 `resolveSessionForWorkspace`**——它可能创建幽灵会话或误绑"最近会话"。写入失败仅降级为 console 警告，不影响 PR 创建成功的状态展示。
- **shell 工具 post-hook**：`run_shell_command` 完成、未中止且退出码为 0 时，先过执行闸门（某命令段以 `gh pr create` 开头，core `session-pr-service.ts` 的 `commandRunsGhPrCreate`），再由 **gh 本身做归因**：`gh pr view --json number,url`（core `github-prs.ts` 的 `fetchCurrentBranchPullRequest`）解析当前工作分支对应的 PR，仅当该 PR 的 URL 出现在本次命令输出里才绑定——命令/输出文本无法把打印出的 URL 归因到 gh 自身的执行（复合命令、引号内短语、注释、`--help` 都能骗过纯文本匹配），所以文本匹配只做执行闸门，归因以 gh 的解析为准，gh 无法解析时一律不绑（fail-closed）。命中则 `upsertSessionPr(..., state:'open')` 直写 sidecar（复刻 worktree sidecar 的"工具进程直写"模式，CLI/daemon 双模生效），并经 `qwen/notify/session/pr-binding` 通知 daemon 标记 session catalog（同自动标题的 `onSessionCatalogChanged` 通道），live-state 客户端 ~2s 内 refetch 到绑定。sidecar 写入与 daemon 侧写入（GitDialog/回填/刷新）经 `proper-lockfile` 跨进程锁序列化（两级：进程内队列 + 文件锁，同 mailbox 先例）。best-effort，失败不影响工具结果。

### 持久化

新增 sidecar `<chatsDir>/<sessionId>.pr.json`，复刻 worktree sidecar 模式：

- 新 core 服务 `packages/core/src/services/session-pr-service.ts`：`SessionPr` 接口、数组 schema 校验（`{prs: [...]}`，容忍 ENOENT/JSON 损坏）、`readSessionPrs` / `writeSessionPrs` / `upsertSessionPr`（按 number 去重、移到最新、cap 10）。
- `SessionService` 增加 `getPrSessionPathForArchiveState` 路径助手；归档/取消归档移动 sidecar、删除会话时清理（与 worktree sidecar 一一对应）。
- `session-list.ts` 的 `enrichPrSidecars` 回填 persisted summary 的 `prs`；live 会话的 entry.prs 只含本 daemon 生命周期内的绑定，回填时与 sidecar 历史按 number 合并（live 的 url 优先，live-only 的排最后；`state` 以 sidecar 为准——定时器只刷 sidecar，live entry 停在绑定时刻）。

### 展示与搜索（web-shell 侧栏）

- `renderSessionRow`：会话行标题旁渲染小号 badge（`session.prs` 非空时），显示最新 PR 号，多于一个时追加 `+N`；点击经 `useExternalLinkOpener` 打开最新 PR（desktop webview 下 `target="_blank"` 会被静默丢弃）；click/doubleClick/keydown 均 stopPropagation（双击 badge 不触发重命名）。
- `SessionDetailsTooltip`：列出全部绑定 PR（最新在前），各为外链。
- `filteredSessions` 匹配逻辑扩展：`label`、`sessionId` 之外，增加**任意一个**绑定 PR 号（输入 `9517` 或 `#9517` 都命中）、`branch.name`、`worktree.branch`、`worktree.slug`（`sessionMatchesGitQuery`，WebShellSidebar 与 WorkspaceSection 共用）。
- SSE 消费侧：web-shell 不直接消费 `session_metadata_updated` 更新 store；bridge 的 `markSessionCatalogChanged()` 触发 catalog revision bump，侧栏 live-state 轮询（2s 周期）发现后自动 refetch——badge 在绑定后 ~2s 内出现（与改名等其他客户端变更的传播机制一致）。
- i18n：新增 `sidebar.sessionPr` / `sidebar.sessionPrMultiple` 两个 key（EN/ZH）。

### 存量回填（按需）

新增 daemon 路由 `POST /sessions/backfill-prs`（进程级、按需触发，启动不自动扫描），实现见 `packages/cli/src/serve/routes/session-pr-backfill.ts`：

- 遍历 registry 中所有 trusted workspace runtime；每个 workspace 扫描 persisted 会话（active + archived），候选分支 = worktree sidecar branch ∪ transcript 各记录的 `gitBranch`（正则提取，distinct 上限 64），解析三源：
  1. **约定**：slug `pr-<N>` / branch `worktree-pr-<N>` 直接给出 PR 号（零网络）；
  2. **gh 批量**：每 workspace 一次 `fetchGitHubPullRequests({state:'all', limit:500, slim:true})`，把候选分支与 headRefName 交集映射到 number + url。实测存量里 `pr-<N>` slug 与 worktree branch 几乎零命中（PR 基本不从 worktree 分支提交），`gitBranch` 是主力来源（主 workspace 342 会话命中 272）；
  3. **transcript `gh pr create` 痕迹不再作为绑定源**：打印出的 URL 无法归因到会话自身的创建（伪造/复合命令会追溯固化错误绑定），gh 无法为之背书的 URL 一律不绑；历史创建由分支映射（上述第 2 源）尽力恢复。URL 兜底链相应缩短为：gh 映射 → remote 推导（仅约定号）。
- `slim` 只取 number/url/headRefName：带 CI rollup 的全字段查询在 `--state all --limit 500` 下触发 GitHub GraphQL 504；slim 约 4s/60KB。
- **gh 页按仓库 key 闸门**：fork 布局（origin=fork）下 `gh pr list` 解析的是**父仓库**（gh 2.95.0 实测），页内 PR 全部属于另一仓库——与 workspace origin key 不一致的条目一律跳过，裸分支名碰撞不会把陌生人的 PR 绑进本工作区（该场景分支映射整体失效，fail-closed）。
- URL 优先取 gh 映射；gh 不可用时由 git remote web URL 推导 `<repo>/pull/<N>`（支持 https / scp 风格 ssh / `ssh://` 与 enterprise host，仅约定号）；解析不到号的会话原样跳过。
- 已知副作用：曾 checkout/review 他人 PR 分支的会话也会被绑定（多 PR 列表可容纳，搜索语义上属于"相关会话"）。
- 已绑定同一 number 的分支映射结果跳过（不刷新 createdAt）；**约定号例外**——已绑定的约定号仍会重新 upsert（移到末位、刷新 createdAt），否则后续运行新绑定的更弱数字会把它挤过 tail-10 上限；重复调用幂等；写入复用 `upsertSessionPr`。
- 响应按 workspace 聚合 `scanned/bound/alreadyBound/unresolved`；untrusted workspace 跳过。

### 合入状态快照 + 定时刷新

- **快照来源**：slim 查询增取 gh `state`（OPEN/MERGED/CLOSED → `open`/`merged`/`closed`）；回填写入当时值，GitDialog 新建记 `open`。
- **定时器**：daemon 启动后挂独立低频任务（不挂列表轮询热路径），默认 **5 分钟**一轮，环境变量 `QWEN_SESSION_PR_REFRESH_MINUTES` 可调（`0` = 关闭）；`unref()` 不阻碍进程退出，首轮延迟启动避开 boot。
- **每轮**：遍历 trusted workspace → 读 `.pr.json` sidecar 挑出非 merged 绑定 → 无目标直接跳过（零 gh 调用）→ 有目标发一次 slim `gh pr list --state all --limit 500` → `updateSessionPrStates` 原地回写 state（**不重排顺序、不刷新 createdAt**，与 upsert 共享同一路径写入队列避免竞态）→ badge 经现有 2s 轮询自动更新。
- **成本**：只对含未合入绑定的 workspace 发查询（每 ~4s）；gh 不可用时静默跳过该轮。
- **明确不做**：定时器不做新 PR 发现（重扫 transcript 全量 6 分钟不适合 5 分钟周期）；发现由 shell post-hook（实时）与 backfill（按需）承担。

## 关键决策

- **绑定时机 = GitDialog 创建 PR 成功时**（用户主力流程）；agent 在 shell 里 `gh pr create` 由 shell 工具 post-hook 实时识别（归因以 `gh pr view` 为准，见写入端章节）+ backfill 的分支映射回填存量。
- **sidecar 而非 transcript 记录**：displayName 走 `custom_title` transcript 记录是因为标题属于会话内容流；PR 绑定是会话外部元数据，worktree sidecar 是同类先例，改动面更小。
- **多 PR 列表（cap 10）**：一个会话可能创建多个 PR（stacked PR、连续修复），只保留最新一个会让"按 PR 号反查会话"在这些场景失效。绑定按 number 去重、重复绑定移到最新位；badge 显示最新号 + `+N`，tooltip 列全部，搜索匹配任意一个。上限 10 防无界增长。
- **workspace 级打开 GitDialog（无会话上下文）时不回写**：dialog 没有已解析的会话就跳过，不报错；绝不通过 `resolveSessionForWorkspace` 创建新会话来绑定（会产生幽灵会话/误绑）。

## 影响文件

| 层          | 文件                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 类型    | `packages/sdk-typescript/src/daemon/types.ts`（DaemonSessionSummary.pr）                                                                                  |
| SDK 事件    | `packages/sdk-typescript/src/daemon/events.ts`（MetadataUpdated data + 校验）                                                                             |
| SDK 客户端  | `packages/sdk-typescript/src/daemon/DaemonClient.ts`（updateSessionMetadata 参数）                                                                        |
| bridge 类型 | `packages/acp-bridge/src/bridgeTypes.ts`（BridgeSessionSummary.pr、metadata 参数）                                                                        |
| bridge      | `packages/acp-bridge/src/bridge.ts`（updateSessionMetadata 校验/存储/广播）                                                                               |
| core        | `packages/core/src/services/session-pr-service.ts`（新增）+ SessionService 路径助手/归档移动/删除清理；`tools/shell.ts`（gh pr create post-hook）         |
| daemon 路由 | `packages/cli/src/serve/routes/session.ts`（两个 PATCH 路由校验 + sidecar 写入）、`acp-http/dispatch.ts`（ACP `session/update_metadata` 的 sidecar 写入） |
| daemon 列表 | `packages/cli/src/serve/server/session-list.ts`（enrichPrSidecars）                                                                                       |
| daemon 回填 | `packages/cli/src/serve/routes/session-pr-backfill.ts`（`POST /sessions/backfill-prs`，存量会话按需回填）                                                 |
| web-shell   | `GitDialog.tsx`（回写）、`WebShellSidebar.tsx`（badge + 搜索）、`SessionDetailsTooltip.tsx`（PR 行）、locale 文件                                         |
| 测试        | 上述各层的 collocated 单测                                                                                                                                |

## 范围边界（明确不做）

- 服务端分页过滤（20+ 会话规模客户端搜索足够；`sourceType/sourceId` 过滤管道是将来扩展的样板）。
- 无 worktree sidecar 且 transcript 无 `gh pr create`/`gitBranch` 痕迹的会话：回填无可靠来源，不覆盖。

## 开放问题

无。
