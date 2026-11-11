# 会话 PR 手动绑定

[English](2026-11-11-manual-session-pr-binding.md) | [简体中文](2026-11-11-manual-session-pr-binding.zh-CN.md)

日期：2026-11-11
状态：提案

## 问题

会话的 GitHub PR 绑定（sidecar `<chatsDir>/<sessionId>.pr.json`，渲染为侧栏
badge 并参与会话搜索）由三条自动路径写入：Web Shell Git 对话框创建 PR 后回
写、shell 工具的 `gh pr create` post-hook、按需 backfill 扫描（`/review` 提
及与 `pr-<N>` worktree 约定）。三条路径都刻意收窄——backfill 拒绝把
transcript 文本作为来源，因为打印出的 URL 无法归因到 gh 自身的执行（见
[Web Shell 会话绑定 GitHub PR 号](2026-08-20-webshell-session-pr-binding.md)）。

三条路径都没触发时，绑定就漏了。真实反复出现的场景：

- `cd <worktree> && gh pr create` 且未给 shell 工具传 `directory` 参数：
  post-hook 按启动目录的分支解析而非 worktree 的分支，于是拒绝绑定；裸
  `git worktree add` 建的 worktree 没有 daemon worktree sidecar，`pr-<N>`
  约定也救不回。
- 会话接管一个既有 PR（评审修复、autofix），但从未在命令位置跑过
  `/review <N>`。
- 后台运行或被 promote 的 `gh pr create`——post-hook 刻意不绑定这类运行。

目前唯一的补救是手动 REST 调用：带 bearer token、会话 id 与完整
`{number, url, state}` body 的 `PATCH /session/:id/metadata`。TUI 与 Web
Shell 里的用户够不着这条路径，实践中总要提醒 agent 去跑。

## 现状

| 面                                                                | 状态                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| REST `PATCH /session/:id/metadata`（及 workspace 作用域孪生路由） | 接受 `pr`；以 `source: 'create'` 落盘 sidecar。需要 token + 会话 id + 完整 body。                       |
| ACP `qwen/session/update_metadata`                                | 接受 `metadata.pr`；同样的落盘与对账（`acp-http/dispatch.ts`）。                                        |
| SDK `DaemonSessionClient.updateMetadata`                          | 类型已是 `{displayName?, pr?}`；Web Shell Git 对话框创建 PR 后已经经 workspace REST 孪生路由发送 `pr`。 |
| Web Shell UI                                                      | 没有绑定任意既有 PR 的入口；`updateMetadata` 只用于改名与 Git 对话框的创建后回写。                      |
| Slash 命令                                                        | 不存在 PR 绑定命令。                                                                                    |
| Backfill `POST /sessions/backfill-prs`                            | 只认信任来源；救不回任意漏登记的号。                                                                    |

因此 daemon、bridge、SDK 的客户端主动绑定管道已经完整。缺的是会话内
（TUI + Web Shell）与 Web Shell 会话总览面板上的用户入口。

## 目标

- 用户在 TUI、headless CLI 或 daemon（Web Shell）会话里敲 `/pr <number|url>`
  即可把 PR 绑到当前会话——不需要 token，不需要查会话 id。
- 用户在 Web Shell 会话总览面板或侧栏会话菜单通过一个小对话框把 PR 绑到任意会话。
- 两个入口都复用既有的落盘、provenance、上限与刷新机制；daemon 与 SDK 不
  新增路由或类型。

## 范围边界（明确不做）

- 不提供解绑/清除语义（原始绑定设计就没有）。
- 不放宽自动归因门控；transcript 文本仍不是来源。手动绑定是显式用户意图，
  与既有 REST PATCH 同级权威，不是新的自动来源。
- 不新增 daemon 路由、不改 bridge、不改 SDK 类型。
- 仅 GitHub。Aone workspace 沿用既有 REST/backfill 路径；命令的 `gh` 解析
  与对话框的 PR 列表都是 GitHub 专用。
- 手动绑定不做仓库身份闸门：PR 由用户指名，`gh` 只用于解析规范 URL/state，
  不用来证明归因（不同于 shell post-hook 必须证明会话创建了该 PR）。

## 方案

### A. `/pr` slash 命令

新增内置命令 `packages/cli/src/ui/commands/pr-command.ts`，注册进
`BuiltinCommandLoader`，`supportedModes: ['interactive', 'non_interactive', 'acp']`，
`argumentHint: '<number | url>'`。daemon 会话经 `handleSlashCommand` 在会话
子进程内执行内置命令 action——与 `/forget`、`/rename` 同一条路径；子进程直
写 shell post-hook 所写的同一份 sidecar，因此不需要 token，也不需要 daemon
往返。

行为：

1. **无参数**——读会话 sidecar（`readSessionPrs`），列出已绑定 PR（号 +
   state），附用法行。TUI 此外没有查看绑定的手段，这一步提供验证入口。
2. **参数解析**——接受裸号（`[1-9]\d{0,8}`，与 backfill 的界一致）、`#N`、
   完整 PR URL。`#N` 与 URL 形态复用 `GitWorktreeService.parsePRReference`；
   其余形状是用法错误。
3. **解析**——`utils/github-prs.ts` 新增 core helper
   `fetchPullRequestByReference(cwd, ref)`，执行
   `gh pr view <ref> --json number,url,state`（ref 为号或 URL），复用
   `resolveGhBinary`、`ghEnv` 与既有超时。
   - gh 解析成功 → 绑定 gh 的 `{number, url, state}`（gh 是规范来源，对带
     `/files` 子路径、query、enterprise host 的 URL 亦然）。
   - gh 失败且输入是完整 URL → 绑定 `{number, url}`、不带 state；daemon 刷
     新定时器随后补 state。URL 须过 `isValidSessionPrUrl`。
   - gh 失败且输入是裸号 → 报错并要求给完整 PR URL（不从 remote 合成 URL）。
4. **落盘**——与 shell post-hook 完全一致：best-effort `getSessionLocation`
   → `getPrSessionPathForArchiveState` →
   `upsertSessionPrs([{number, url, state?, source: 'create'}])` → 号是新增
   时 `emitSessionPrBound`。ACP 宿主已把该回调接到
   `qwen/notify/session/pr-binding`，daemon 据此标记 session catalog，
   live-state 客户端 ~2s 内 refetch 到 badge——与自动创建绑定完全相同。
5. **结果消息**——成功（`Bound PR #N to this session.`）、已绑定（同 URL
   保持位置与 `createdAt`，报告为已绑定）、解析/用法错误。

`source: 'create'` 与既有手动 REST/ACP 路径的盖章一致；`upsertSessionPrs`
绝不降级更强的已持久化 provenance（`worktree`），约定绑定在手动重绑后仍存
活。

i18n：描述与全部用户可见字符串进全部 9 个内置 locale；`zh` 与 `zh-TW` 是
strict-parity locale，其测试套件对任何未翻译的内置命令描述都会失败。

### B. Web Shell 绑定 PR 对话框

新组件
`packages/web-shell/client/components/dialogs/BindSessionPrDialog.tsx`，
仿 `SessionRenameDialog`（`DialogShell size="sm"` + `Input` + 错误行 +
Cancel/Bind）。输入框接受 PR 号或 URL：

- **URL**——客户端解析 `/pull/<N>`，校验 http(s)，提交 `{number, url}`、不
  带 state（刷新定时器负责解析）。
- **号**——经既有 `workspaceGitHubPullRequests()` SDK 调用拉 workspace PR
  列表（`GitHubPrsContent` 的 fetch 模式），按号匹配 →
  `{number, url, state: 'open'}`。列表只含 open/draft PR；号不在列表时报错
  并要求给完整 URL（merged/closed PR 走 URL 绑定）。

入口：`SessionOverviewPanel` actions 列 Rename 旁加一个 `GitPullRequestIcon`
ghost 按钮，用与 Rename 相同的 `canRenameCard` 能力门控（元数据变更）；
侧栏会话下拉菜单（`WebShellSidebar`）加一个 Bind PR 项，用 `showRename`
门控，standalone 会话隐藏（其元数据路由只接受 `displayName`）。
`bindPrTarget` / `bindPrCandidate` state 从两个面驱动同一个对话框。

提交路由仿 `saveRename` 的三分支：

- 当前会话 → `daemon/session/actions.ts` 新增 `bindSessionPr(pr)` action
  （与 `renameSession` 相同的 `withActionTimeout` + `dispatchActionError`
  包装），签名补进 `daemon/session/types.ts`；
- 其他会话且有 workspace cwd →
  `workspace.client.workspaceByCwd(cwd).updateSessionMetadata(id, {pr})`；
- 其余 → `workspace.client.updateSessionMetadata(id, {pr})`。

成功后：`sessionCatalogController.refreshWorkspace(ownerCwd)` +
`reloadData()`（与改名相同的刷新路径；badge 从会话列表读 `prs`，不依赖
pr-only 的 `session_metadata_updated` 事件，其 mapper 语义保持不动）。失败
走面板的 `setActionError` 行。

i18n：`client/i18n.tsx` 的 EN 与 ZH 两份字典各加 `sessionsOverview.bindPr*`
键。

## 关键设计决策

- **显式用户意图即权威。** 两个入口都是用户的主动行为，与既有 REST PATCH
  等价。它们不扩大自动归因面，backfill 设计的防伪造边界保持完整。
- **命令复用 shell post-hook 的写入路径。** 子进程本就带跨进程锁与 catalog
  通知直写 sidecar；命令照做即继承全部机制，无需 daemon 参与。
- **手动绑定里 `gh` 只解析、不做闸门。** `gh` 查询失败时降级到用户给的 URL
  而非拒绝绑定；刷新定时器随后修 state。裸号无法降级（没有 URL 可绑），所
  以报错。原样持久化的 URL（含 `/pull/N/files` 一类子路径）由 sweep 的补偿
  层兜底：`session-pr-refresh` 按 `samePullRequest`（容忍子路径/query）匹配
  后，把抓到的快照改写到条目自己的 URL 下再交给 sidecar 的规范门，因此状态
  解析不依赖绑定 URL 的规范化。
- **不伪造 state。** URL 绑定省略 `state` 而非猜 `open`；只有列表匹配
  （open/draft）才盖 `open`。
- **对话框而非行内输入。** 绑定需要解析步骤（号 → URL）与错误展示面；总览
  面板的行内改名表单两者都没有，而 `DialogShell` 模板是现成的。

## 影响文件

| 层        | 文件                                                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core      | `utils/github-prs.ts`（新增 `fetchPullRequestByReference`）                                                                                                                                                                         |
| CLI 命令  | `ui/commands/pr-command.ts`（新增）、`services/BuiltinCommandLoader.ts`                                                                                                                                                             |
| CLI i18n  | `i18n/locales/*.js`（9 个文件）                                                                                                                                                                                                     |
| Web Shell | `components/dialogs/BindSessionPrDialog.tsx`（新增）、`components/SessionOverviewPanel.tsx`、`components/sidebar/WebShellSidebar.tsx`、`daemon/session/actions.ts`、`daemon/session/types.ts`、`i18n.tsx`、`test/sidebarHarness.ts` |
| 测试      | 上述各处的 collocated 单测                                                                                                                                                                                                          |

## 约束与风险

- 命令在会话目标目录里跑 `gh`；origin 无法被 gh 解析的检出里，裸号解析会
  失败，用户须粘贴 URL。这是文档化的降级，不是缺陷。
- sidecar 上限（10）与 provenance 驱逐规则不变；手动绑定可能挤掉较弱的
  `review` 条目——与今天的 REST PATCH 完全一致。
- 对话框的号匹配依赖 workspace PR 列表缓存（仅 open/draft、有上限）；条目
  陈旧或缺失时降级到 URL 输入路径。
- locale parity 测试钉住命令描述；漏翻会在 CI 失败，而不是在 zh/zh-TW 里
  发布英文兜底。

## 验证计划

- 单测：命令 action 测试（解析、解析分支、落盘、通知、消息），用 mock
  command context；`gh` helper 测试 mock `execFile`；对话框测试（号匹配、
  URL 解析、错误路径、提交 payload）与总览面板测试（按钮门控、提交路由、
  刷新），沿用既有 jsdom + act 风格。
- E2E：本地 bundle 在临时 git 仓库里用真实 `gh` 跑 headless `/pr`；隔离
  daemon 会话经 `/pr` prompt 绑定并回读 sidecar 与会话列表；Playwright 用
  mock daemon 驱动对话框。
- 先在全局安装的 CLI 上跑基线 dry-run：那里 `/pr` 是未知命令，确认本特性
  填补的缺口。

## 验收标准

- TUI、headless、daemon 三种模式下，`/pr <N>`、`/pr #N`、`/pr <url>` 都把
  PR 绑到当前会话；sidecar 条目带 `source: 'create'`，gh 可解析时带 state。
- 无参 `/pr` 列出会话已绑定的 PR。
- 重绑同一 PR 报告已绑定，不移动位置、不刷新 `createdAt`。
- Web Shell 总览面板能把 PR 绑到当前会话与其他会话；catalog 刷新后 badge
  出现；不在 open 列表的号与非法输入产生可操作的错误。
- `npm run build`、`npm run typecheck`、聚焦单测套件（含 i18n parity 套件）
  与 E2E 各组通过。

## 开放问题

无。
