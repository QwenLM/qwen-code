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
- **shell 工具 post-hook**：`run_shell_command` 完成、未中止且退出码为 0 时，先过执行闸门（某命令段以 `gh pr create` 开头，core `session-pr-service.ts` 的 `commandRunsGhPrCreate`），再由 **gh 本身做归因**：`gh pr view --json number,url,state`（core `github-prs.ts` 的 `fetchCurrentBranchPullRequest`）解析当前工作分支对应的 PR，仅当该 PR 状态为 OPEN 且其 URL 出现在本次命令输出里才绑定——命令/输出文本无法把打印出的 URL 归因到 gh 自身的执行（复合命令、引号内短语、注释、`--help` 都能骗过纯文本匹配），所以文本匹配只做执行闸门，归因以 gh 的解析为准，gh 无法解析或状态不可识别时一律不绑（fail-closed）；open 闸门同时挡住"过闸的重试命令（`gh pr create || gh pr view`）解析到分支既有 PR"这一类误绑。命中则经 `upsertSessionPrs` 直写 sidecar（复刻 worktree sidecar 的"工具进程直写"模式，CLI/daemon 双模生效；已绑定的号原样保留、不重盖 createdAt，只有真正新增的绑定才写入并经 `qwen/notify/session/pr-binding` 通知 daemon 标记 session catalog），同自动标题的 `onSessionCatalogChanged` 通道，live-state 客户端 ~2s 内 refetch 到绑定。sidecar 写入与 daemon 侧写入（GitDialog/回填/刷新）经 `proper-lockfile` 跨进程锁序列化（两级：进程内队列 + 文件锁，同 mailbox 先例；锁按规范化路径而非文件 realpath 取得，目标文件不必存在、也不再预先物化空文件）。best-effort，失败不影响工具结果。
  - **只覆盖前台完成的运行**：未中断的前台运行，以及"promote 被拒（子进程已先退出）"的运行走这道闸门；**Ctrl+B promote 成功的运行与 `is_background: true` 的运行不实时绑定**——它们经后台注册表结算、输出流入文件、也没有 pre-run 快照，而 transcript 又明确不是恢复来源（无 gh 侧归因）。这类 PR 经 `/review <N>` 或 worktree `pr-<N>` 约定绑定。`bindGhPrCreate` 的 docstring 与两条负向测试钉住该范围。
  - **执行闸门语法是封闭集合**（`commandRunsGhPrCreate`）：命令段依次为「单词形式的前置赋值」→「{sudo, env, nohup, command} 的任意嵌套链（每个至多三个 flag/赋值）」→「gh 二进制（裸 `gh`、`gh.exe/.cmd/.bat`、任意路径限定写法：`/usr/bin/gh`、`./gh`、`bin/gh`、`C:\\tools\\gh.exe`、UNC）」→「`pr create` 或 `pr new`」。语法之外的形状（含空白的引号值、`$(…)`、`bash -c "…"`、`timeout 60 gh …`、子 shell、调用内部换行续行）**不匹配、fail-closed**：创建照常执行，只是不绑定，可按上一条恢复。不再逐形状扩展。
  - **inline 凭据采集**（`ghPrCreateInlineEnv`）按命令顺序建模：`export`/`unset` 只对其后的段可见（create 之后的 `export` 不归因）；`unset NAME`、`env -u NAME`、`env -i` 记为删除（`undefined` overlay，验证腿同步去掉 create 显式丢弃的环境凭据）；`${VAR:-default}` 一类带运算符的参数展开与 `$(…)` 一样保持字面量（猜错不得给验证腿授权）。赋值值限单个 shell 词。

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

- 遍历 registry 中所有 trusted workspace runtime；每个 workspace 扫描 persisted 会话（active + archived，`isValidSessionId` 门禁先于一切路径构造），解析两源（按权威升序插入，最强者最后、不被 tail-10 挤出）：
  1. **`/review <N|url>` 显式指令**：仅解析**用户键入的提示词**——user 文本记录的首个 text part，或 TUI 技能展开场景下 `slash_command` 系统记录的 `systemPayload.rawCommand`（TUI 先展开技能体再记录，键入命令被追加在展开体末尾、模式不可及，只存活于该字段）；`#N` 与 `pull/N` 两种形态（URL 形态须与 workspace 同仓库，仓库 key 不可解析时 fail-closed）；assistant 散文/工具调用/工具结果里的引用不绑。review 会话绑到**被 review 的 PR**——搜索"PR N 的 review 会话"的正确语义；
  2. **约定**：worktree sidecar slug `pr-<N>` / branch `worktree-pr-<N>`（`[1-9]` 开头，无 PR 0）直接给出 PR 号（零网络），会话"为该 PR 存在"，权威最高。
- **明确不用 transcript `gh pr create` 痕迹**：历史命令没有 gh 侧归因（`echo "...gh pr create...url"` 一类命令即可骗过纯文本闸门并打印任意同仓库 URL 伪造绑定），已移除该源；实时创建由 shell post-hook 归因绑定（见写入端章节）。
- **明确不用裸 `gitBranch`**：首版曾把 transcript gitBranch 与 gh headRefName 交集作为来源，实测是纯噪声——workspace 当时所在分支的 PR 被绑到**所有**会话（主 workspace 272 命中全是这类，含 review 其他 PR 的会话与无关闲聊）。已移除并按 createdAt 时间窗清理错误绑定后重跑。
- **Aone workspace**（origin 为 Aone 主机时，见 `docs/design/2026-08-27-session-pr-aone-provider.md`）：来源与上面完全相同（`/review` 指令 + worktree 约定，**任何平台都不用 transcript 分支映射**，因此 `a1 repo mr list` 不在 backfill 的调用面上）；`/review <url>` 形态在 Aone 上**只当号源、绝不借出 URL**，且只承认恰为本仓库 remote 伪造形状 `<origin>/pull/<N>` 的形态（全路径逐段相等——两段仓库 key 会把嵌套 group 的兄弟项目折叠成同一个 key）；每个待绑定号经一次有上限、带缓存的 `a1 repo mr view` 取 `detailUrl` + state（**绝不从 remote 拼 URL**，view 失败或超预算计 `unresolved` 待下轮）；同 PR 身份判定 fail-closed（本轮 view 证明过、或 URL 恰为该 repoPath 的 detailUrl 形状）；Aone 化之前 backfill 伪造的 `<origin>/pull/<N>` 条目在计划里原地修复（保留 createdAt/provenance），持有这类条目的会话即使本轮无来源也进入候选。响应带 `platform: 'github' | 'aone'`；`ghAvailable` 仅 GitHub。
- 每 workspace 一次 `fetchGitHubPullRequests({state:'all', limit:500, slim:true})` 提供 number→url/state 映射；`slim` 只取 number/url/headRefName/state（全字段 + 500 触发 GitHub GraphQL 504，slim 约 4s/60KB）。
- **gh 页按仓库 key 闸门**：fork 布局（origin=fork）下 `gh pr list` 解析的是**父仓库**，页内 PR 属于另一仓库——与 workspace origin key 不一致的条目一律跳过（fail-closed）；workspace key 不可解析时同样 fail-closed。约定号不受闸门影响：gh 页已归属该号时取 gh 自己的权威 URL（父仓库），不与 origin 推导混用。
- URL 兜底链：gh 映射（`gh pr list` 页内条目）→ `/review <url>` 形态命名的 URL → gh 页按号归属（fork 布局下页属父仓库，仍优先 gh 自己的权威 URL，不同步合成 fork URL）→ git remote web URL 推导 `<repo>/pull/<N>`（`fetchRemoteWebUrl`，支持 https / scp 风格 ssh / `ssh://` 与 enterprise host）；解析不到号的会话原样跳过。
  - **URL 形态的两道闸**：仓库 key 须为 workspace 自身或 gh 页解析到的仓库（fork 父仓库）；URL 还须过 sidecar 的形状校验（≤2048、http(s)、无控制字符，`isValidSessionPrUrl`）——transcript 是用户可控文本，读侧对整份 sidecar fail-closed，写入一条毒 URL 会抹掉全部绑定并每轮再毒。`replaceSessionPrs` 在写边界同样拒绝读侧会拒绝的条目。
  - **同号借用规则**：裸 `/review N` 与约定号 `pr-N` 指的是**本仓库**的 PR N；URL 形态只有在其仓库 key 属于「workspace 自身或已确认的 fork 父仓库」时才把 URL 借给同号，来自未信任（divergent）gh 页仓库的形态只绑定它自己命名的 PR，不借给裸号/约定号（否则 `gh repo set-default` 到陌生仓库就能把陌生仓库的 PR N 绑到"为本仓库 PR N 存在"的会话上）。
- 每会话一次锁定内的读-改-写（`replaceSessionPrs` 计划器，进程内队列 + 跨进程文件锁）：已绑定同一 number 的候选跳过（不刷新 createdAt、不重排，保持绑定序）；本轮未再提供、或本轮无法解析的既有条目视为外来占位者先占槽位；合并列表超过 tail-10 时**按 provenance 排序裁剪**（与 sidecar 自身 cap 规则一致：worktree > create > 无 provenance > review，同级按最旧位置），本轮重新提供的占位者取「持久化 source」与「本轮 stamp」中的高者——`gh pr create` 创建的 PR 被 `/review 100` 重提后不会被降级成 review 挤出。单份上限列表一次写入，失败不会残留半成品；重复调用幂等；按候选隔离——单个 sidecar 写失败计入 `writeErrors` 并继续，不中止整个 workspace 运行。
- 路由在 `written > 0`（有 sidecar 重写，含仅挤出的计划）时失效列表缓存并 `markSessionCatalogChanged()`，live-state 客户端 ~2s 内 refetch。
- 响应按 workspace 聚合 `scanned/bound/written/alreadyBound/overLimit/unresolved/writeErrors/ghAvailable/platform`（失败的 workspace 带 `error`）；untrusted workspace 跳过。

### 合入状态快照 + 定时刷新

- **快照来源**：slim 查询增取 gh `state`（OPEN/MERGED/CLOSED → `open`/`merged`/`closed`）；回填写入当时值，GitDialog 新建记 `open`。
- **定时器**：daemon 启动后挂独立低频任务（不挂列表轮询热路径），默认 **5 分钟**一轮，环境变量 `QWEN_SESSION_PR_REFRESH_MINUTES` 可调（`0` = 关闭）；`unref()` 不阻碍进程退出，首轮延迟启动避开 boot。
- **每轮**：遍历 trusted workspace → 读 `.pr.json` sidecar 挑出非 merged 绑定 → 无目标直接跳过（零 gh 调用）→ 有目标发一次 slim `gh pr list --state all --limit 500` → `updateSessionPrStates` 原地回写 state（**不重排顺序、不刷新 createdAt**，与 upsert 共享同一路径写入队列避免竞态）→ badge 经现有 2s 轮询自动更新。
- **成本**：只对含未合入绑定的 workspace 发查询（每 ~4s）；gh 不可用时静默跳过该轮。
- **明确不做**：定时器不做新 PR 发现（重扫 transcript 全量 6 分钟不适合 5 分钟周期）；发现由 shell post-hook（实时）与 backfill（按需）承担。

## 关键决策

- **绑定时机 = GitDialog 创建 PR 成功时**（用户主力流程）；agent 在 shell 里 `gh pr create` 由 shell 工具 post-hook 实时识别（归因以 `gh pr view` 为准，见写入端章节）；存量由 backfill 两源回填（`/review` 指令、worktree 约定），**不用裸 gitBranch**（实测纯噪声）、**不用 transcript `gh pr create` 痕迹**（无 gh 侧归因、文本可伪造，见回填章节）。
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
- 无 worktree sidecar 且 transcript 无 `/review` 指令的会话：回填无可靠来源，不覆盖。
- **promote 成功 / `is_background: true` 的 `gh pr create` 不实时绑定**，也不从 transcript 恢复（见写入端「只覆盖前台完成的运行」）；这两类 PR 经 `/review <N>` 或 `pr-<N>` 约定绑定。
- **执行闸门语法不再逐形状扩展**：写入端列出的封闭集合之外的写法 fail-closed（创建照常、只是不绑）。
- **transcript 分支映射在任何平台都不是来源**（GitHub 实测纯噪声；Aone 不重新引入）。Aone 的 `/review <url>` 形态只识别 `/pull/<N>` URL，`codereview/<id>` URL 不作为 URL 形态来源（裸 `/review <id>` 与约定号照常经 `mr view` 解析）。
- **PR-backed worktree 的删除语义**：`exit_worktree {action:'remove'}` 对 fork PR worktree 会被既有的 `hasUnmergedWorktreeCommits` 守卫拒绝（PR head 只经 FETCH_HEAD 取得、无远端跟踪引用）——这是合并基线上就存在的行为，本 PR 只把 `pr-<N>` 形状从 slug 校验里放行，不改变删除守卫；按 PR 基线 SHA 豁免属于独立的后续工作。

## 开放问题

无。
