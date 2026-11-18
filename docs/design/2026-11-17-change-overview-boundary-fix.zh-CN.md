# 变更总览：可信的 commit 兜底边界 + 加固

语言：[English](./2026-11-17-change-overview-boundary-fix.md) | 中文

#17378（已合入 `6db070d787`）的跟进。消除该 PR「已知限制」中记录的两条
维护者接受的展示残留，并清理延后加固清单中廉价且带见证的项（status 路由性能项
与行为变化项——永久 400 渲染、切换会话陈旧态、持久化 workspaceId 陈旧——仍延后）。
单个 PR，有序提交。

## 问题

变更总览的 commit 兜底列出「尚未被任何绑定 PR 覆盖」的提交。#17378 交付了
两条仅展示的缺陷，作为残留风险接受：

- **R7-1——完全没有边界。** 无绑定 PR 且无记录 `baseBranch` 的会话（默认
  `POST /session` 形态，以及不记录 `baseBranch` 的 worktree 会话）落到对
  HEAD 的无范围 `git log`。worktree 分支在基线顶端创建，其 HEAD 携带基线
  分支历史；至多 `COMMIT_FALLBACK_LIMIT`（20）条会话前提交被渲染成本会话的
  松散 `commit:` 单元。原始理由（「worktree 会话从零开始」）不成立。
- **R7-2——绑定时间序非提交图序。** 边界取最后*绑定*的 PR head。两个绑定
  head 都是 HEAD 祖先但彼此不可比时（绑定列表为「stacked 或互不相关」，按
  `createdAt` 排序），`<lastBound>..HEAD` 把兄弟 PR 自己的提交重复列为松散
  工作——这些提交已在该 PR 单元下展示。

两者均为只读展示缺陷（无写入路径、无数据丢失）。所有相邻状态都已拒绝无范围
遍历；这两条是不自洽的例外。

## 现状（在 `6db070d787` 上核实）

- `useChangeOverview.ts` 经 `commitFallbackRange` 组窗：最新祖先 PR head →
  `<head>..HEAD`；否则 `baseBranch`（`'HEAD'` detached 哨兵映射为无基线）；
  否则无绑定 PR 时无范围遍历。抑制以 `boundPrs.length` 与每个产出 PR 单元
  解析出 head 为判据。
- files 路由探测 `isGitAncestorOfHead` 并返回 `headIsAncestor`；hook 用它选
  最新祖先 head。这正是 R7-2 击败的启发式（不可比祖先）。
- `session.ts` 为分支会话解析 `baseCommit = getHeadCommit(workspaceCwd)`
  （`:3269`）但仅用于回滚；`DaemonBranchInfo` 为 `{ name, baseBranch }`——
  起点 commit **未持久化也未投影**。worktree 会话记录 `{ slug, path, branch }`，
  无基线 commit。
- `fetchGitLog`（`core/utils/gitDiff.ts`）接受 `{ limit, skip, range, all,
search }`；log 路由（`workspace-git-log.ts`）转发 `range`/`search`。无法
  排除从一组 ref 可达的提交。

## 设计方案

### 统一边界模型

以单一规则取代「最新祖先 head」启发式：

> 兜底窗口为 `<start>..HEAD`，`start` 为会话记录的起点 commit（否则其基线
> 分支），再减去从任一绑定 PR head 可达的每个提交。无可信 `start` 时抑制兜底。

一举修复两条残留：R7-1 因为永不发出无范围遍历（无 start → 抑制）；R7-2 因为
排除按*每个*绑定 head 的可达性，而非对某个任意排序 head 求交。

### 层 1——持久化会话起点 commit（cli + SDK）

- `DaemonBranchInfo` 增 `baseCommit?: string`；`DaemonWorktreeInfo` 增
  `baseCommit?: string` 与 `baseBranch?: string`；`DaemonSessionSummary` 增顶层
  `baseCommit?: string` 供普通会话使用。
- 分支会话：把已解析的 `baseCommit` 随 `branchMeta` 持久化并投影到摘要。
  仅 live——分支元数据尚未在 daemon 重启后恢复（恢复的分支会话抑制兜底，待
  durable 分支元数据落地）。
- worktree 会话：在 `createUserWorktree` 前解析 `getHeadCommit(workspaceCwd)`
  （worktree 创建所自的基线顶端），持久化到 `worktreeMeta` **并 durable** 写入
  worktree sidecar（`worktreeBase`，legacy sidecar 回退 `originalHeadCommit`）。
  `session-restore.ts` 两处重建与 `enrichWorktreeSidecars` 都读
  `worktreeBase || originalHeadCommit`（worktree 自身的 base，而非源检出的
  HEAD——从兄弟 managed worktree 创建时二者不同）；日志式 branch-worktree、
  worktree-reset 与「在此创建分支」（`worktree-branch`）流程都携带
  `baseCommit`/`baseBranch`，故 daemon 重启后仍能定界窗口。`baseBranch`
  （worktree 创建所自的分支，sidecar `originalBranch`）被投影，使 hook 能排除
  上游整合。
- 普通会话：创建时捕获 `getHeadCommit(workspaceCwd)`（会话起始的 HEAD），投影
  为摘要顶层 `baseCommit`；读取失败保持 `undefined`（无边界）。仅 live（不在
  daemon 重启后恢复）。hook 优先
  `summary.baseCommit ?? branch.baseCommit ?? worktree.baseCommit`：会话自身
  创建时的起点优先于派生的分支/worktree 基线顶端，故普通会话移交给 worktree
  后仍保住移交前的提交（worktree 的创建顶端晚于会话起点）。回本地的提升
  （`setSessionBaseCommit`）为仅填充（`entry.baseCommit === undefined`），绝不
  覆盖已记录的起点；作为 worktree 创建的会话无顶层起点，回本地时仍由此补上
  边界。`worktreeBase` 保持物理语义（worktree 自身的创建基线，供 handoff 回退
  分类与孤儿清理使用），与会话起点不同。
- status 路由水合与摘要投影转发新字段；无此字段的 legacy 会话保持 `undefined`。

### 层 2——log 路由的可达性排除（core + cli + SDK）

- `fetchGitLog` 增 `excludeRefs?: string[]`。存在时修订列表在 range 后追加
  `--not <ref…>`，git 原生返回窗口减去从任一排除 ref 可达的提交。单次 log
  调用，外加每个排除 ref 一次廉价存在性探针（见下）；无逐条目祖先调用。
- 每个排除 ref 按单 ref 白名单校验（`isSafeSingleRef`：字符集、无前导 `-`/`^`、
  无 `..`）；不安全 ref 使整个排除集落入拒绝（`available:false`）结果，而非
  静默无范围运行。前导 `^` 被拒，因为 git 的 `--not ^ref` 把双重否定异或成
  包含（扩大窗口）。hash 前缀搜索臂携带 `--not <refs>` 尾部，使排除在该臂
  同样生效。
- 安全但**缺失**的 ref 被丢弃，而非致命。绑定 PR head 可能不在本地对象库
  （刷新后的 `headRefOid`、被 gc 的 head），基线分支的远程跟踪 ref 也可能不
  存在（整合远端为 `upstream` 的 fork、无远端的克隆）。`git log --not <缺失>`
  以 `bad object` 失败，会拒绝整个窗口——并经 hook 的无排除重试把**存在的**
  排除也一起丢掉，重新列出已被覆盖的提交（这正是朴素 `origin/<base>` 猜测
  引入的回归）。故每个 ref 先以 `rev-parse --verify --quiet <ref>^{commit}`
  探针校验存在性，仅存在的 ref 进入 `--not`；排除保持外科手术式（仅缺失 ref
  的提交可能重现）。不安全 ref 仍拒绝取数——存在性丢弃仅适用于白名单安全的 ref。
- core 的 range 守卫是注入守卫，而非 fail-closed 边界：不安全 `range` 被丢弃
  （绝不传给 git），取数退化为无范围 HEAD 遍历而非拒绝。变更总览的「绝不无范围
  遍历」不变量因此由 hook 自身的客户端白名单（`isSafeRangeRef` /
  `isSafeSingleRef`）保持——它在 unsafe ref 到达路由前就抑制取数。把 core range
  守卫本身改成 fail-closed 会改变其他 SDK 消费方依赖的契约（现有注入守卫测试
  钉住「忽略 unsafe range，返回 log」），故保持原样；边界保证落在 hook。
- log 路由增 additive `exclude` 查询参数（逗号分隔 ref）。缺省 → 行为不变。
  重复键、空值或仅分隔符值（`,,,`）以 400 拒绝（fail closed），而非丢弃排除
  无过滤运行。新 capability tag `workspace_git_log_exclude_refs` 声明之；钉死
  基线（server.test.ts、capability-parity.ts、集成信封）更新。
- SDK `workspaceGitLog` 增可选 `excludeRefs` 参数，作为 `exclude` 转发
  （双客户端，有测试）。

### 层 3——hook 重写（web-shell）

- 边界优先级：`summary.baseCommit ?? branch.baseCommit ?? worktree.baseCommit`
  （会话自身起点优先于派生基线顶端）→ `<start>..HEAD`；否则 `baseBranch`
  （非 `'HEAD'`、白名单安全）→ `<base>..HEAD`；否则**抑制**（永不再无范围
  遍历）。
- exclude 能力存在且 PR head 已解析时，把每个绑定 PR `headSha` 作为
  `excludeRefs` 传入。可达性排除统一处理已合并、并行、不可比 head。
- 基线分支的**远程跟踪 ref** 加入排除集。记录的 `baseBranch`
  （`branch.baseBranch ?? worktree.baseBranch`）是**本地**名（如 `main`），
  整合上游从不推进它——只有远程跟踪 ref 推进——故仅排除本地名减不去任何
  东西。hook 排除**两个文档化远端**下的远程跟踪 ref：`origin/<baseBranch>`
  （标准克隆）与 `upstream/<baseBranch>`（fork，`origin` 是个人 fork、整合来自
  `upstream`——CONTRIBUTING 命名的布局）。会话自身的提交（基线的子代）存活。
  worktree 会话无分支元数据，其基线分支携带在 `worktree.baseBranch`（sidecar
  `originalBranch`）。这只收窄窗口；记录的起点 commit 仍定界它。（仅祖先/
  merge-base 探针无效：上游线性推进后起点 commit 仍是 HEAD 的祖先。）本地不
  存在的远程跟踪 ref（另一远端、或无远端的克隆）由路由的存在性探针丢弃而非
  使遍历失败，故存在的排除——尤其是绑定 PR head——仍生效。已知残留：命名为
  `origin`/`upstream` 以外的远端不在覆盖内（其整合提交可能作为松散工作重现）；
  基线分支上**没有任何**远程跟踪 ref 到达的推进（本地独有的基线分支、或本地
  基线上的未推送提交）在会话合并它之后会作为松散工作重现——这是「仅排除远程
  跟踪 ref」的刻意取舍：`--not <本地基线>` 无法区分「基线吸收了会话自身的
  提交」（不能排除，否则窗口清空）与「基线推进进了会话」（应当排除），而排除
  本地名会破坏远更常见的吸收形态，故不含本地名；worktree-handoff 流程可能从
  兄弟检出记录 `originalBranch`，其 HEAD 与记录的 base commit 分叉，故该罕见
  情形下基线收窄可能不精确；普通会话不记录 `baseBranch`，故无基线收窄（起点
  commit 窗口仍定界其工作）；worktree 会话**移交回本地**后也会失去基线收窄，
  因为 `baseBranch` 的唯一载体（`branch.baseBranch` / `worktree.baseBranch`）
  随 worktree 元数据一起被清除，而基线分支并未作为顶层会话字段持久化——故移交
  回本地之前的上游整合可能在之后作为松散工作重现（与仅 live 的普通起点 commit
  同一耐久性缺口）。任何情形下起点 commit 窗口都仍定界会话工作；这些
  残留只影响窗口内的尽力上游收窄。
- 保留守卫：任一产出 PR 单元未解析出 head 则抑制兜底（其提交无法被排除，
  故不得重新列出）。
- capability 偏差：有绑定 PR 单元但**无** exclude 能力（新客户端对旧 daemon）
  时也抑制兜底——无过滤窗口会把这些 PR 自身的提交重复列为松散。仅门控参数不
  够；兜底本身按 `boundPrs.length === 0 || !prFilesSupported ||
excludeRefsSupported` 门控。
- 缺失 head 降级：绑定 `headSha` 是 files 路由从不 fetch 的实时 `gh` 值，可能
  不在本地对象库（刷新后的 `headRefOid`、被 gc 的 head、跨仓绑定）。路由的存在性
  探针如今丢弃这类缺失 ref（层 2），故窗口仍可用、仅该 PR 的提交可能重现——
  存在的排除仍生效。作为兜底，若排除后的 log 仍不可用（如起点 commit 本身不在
  对象库），hook 在**同一边界窗口不带 `excludeRefs`** 重试一次，使总览降级到
  松散窗口而非清空全部单元。仅当重试后仍不可用才呈现 `loadFailed`。
- 退役冗余的祖先启发式：从 files 路由移除 `headIsAncestor` 探针、SDK 字段、
  hook 的祖先 head 选择。若无消费方残留则移除 `isGitAncestorOfHead` 及其测试
  （排除模型已涵盖；保留两者是冗余面）。
- `commitFallbackRange` 由起点 commit 组合器取代，保留三值契约
  （字符串 / `null` 拒绝 / `undefined` 抑制）。

### 层 4——加固清单（测试 + 小修）

清理廉价且带见证的延后项。其中数项已在 #17378 评审轮中钉住；本层补齐缺失项
及唯一的行为变化（ARIA tab 契约）：

- status 路由：**新增**水合 `catch` 测试（sidecar 路径放一个目录使
  `readSessionPrs` 重抛 EISDIR；摘要仍被提供）。`?cwd=` 正向解析已在解析器层
  覆盖（`workspace-route-runtime.test.ts`，真实临时仓库/worktree）；files 路由
  原样把解析出的 cwd 转发给 core helper。
- core：spawn 的 fallback gh binary **已有**断言（`github-prs.test.ts`，
  「spawns the fallback gh when PATH cannot resolve it」）。SDK：**新增**空
  repo slug 抑制测试（空 `repo` 省略参数，使路由本地解析而非拒绝 `repo=`）。
- 面板：**实现** ARIA tab 契约（长期 D4-1）——roving tabindex、Arrow/Home/End
  移动焦点与选择并回绕、带标签的 `tabpanel`。**新增**控制字符净化、badge 抑制
  的 commit 臂、外链 opener 路由的钉住。unavailable-cause 精度、totals 省略、
  失败时 Refresh 可用、空消息存在此前已钉住。
- `changeOverviewAvailable` JSDoc 措辞（按活跃工作区门控，而非 git 性）；
  README 右面板枚举（`changeOverview` 是工作区级空态入口）；bridge
  `SessionPrInfo.source` 类型（镜像 SDK 的 `'create' | 'worktree' | 'review'`）。

每个新增行为守卫配击杀变异见证（字节级还原）。

## 关键设计决策

- **可达性排除优于成对祖先。** `git log <range> --not <heads>` 是单次原生
  调用，恰好表达「不被任何绑定 PR 覆盖」；成对 `is-ancestor` 探针需 N×M 次
  调用且仍需边界。排除也使祖先探针冗余，故移除而非保留为死面。
- **抑制，绝不无范围遍历。** 无 start 情形抑制而非遍历 HEAD。这是所有相邻
  拒绝的一致延伸，彻底移除 R7-1 的证伪前提。
- **exclude 参数用新 capability tag。** 声明 `workspace_github_pr_files` 但
  早于 `exclude` 的 daemon 会忽略该参数返回未过滤条目；独立 tag 让 hook 探测
  实际支持。tag 本身只阻止 daemon 静默忽略参数——hook 还按 tag 门控兜底本身
  （绑定 PR head 无法被排除时抑制），使偏差窗口不重复 PR 提交。
- **起点 commit 不可变。** 创建时记录一次；绝不从当前 HEAD（会移动）重算。
  无此字段的 legacy 会话抑制。

## 涉及文件

- `packages/sdk-typescript/src/daemon/types.ts`、`DaemonClient.ts`
  （+ `test/unit/DaemonClient.test.ts`）：`baseCommit` 字段、`excludeRefs` 参数
  与转发、空 repo slug 抑制。
- `packages/core/src/utils/gitDiff.ts`（+ 测试）：带单 ref 白名单的
  `excludeRefs`；移除 `isGitAncestorOfHead`。
- `packages/cli/src/serve/routes/session.ts`（+ server.test.ts）：在分支、
  worktree、日志式 branch-worktree 与 worktree-reset 路径持久化/投影起点
  commit；水合 catch 测试。
- `packages/cli/src/serve/server/session-restore.ts`：从 sidecar 的
  `originalHeadCommit` 恢复 `baseCommit`。
- `packages/cli/src/serve/routes/workspace-git-log.ts`（+ 测试）：`exclude`。
- `packages/cli/src/serve/routes/workspace-github-prs.ts`（+ 测试）：移除探针。
- `packages/cli/src/serve/capabilities.ts`、`capability-parity.ts`、
  `server.test.ts`、`integration-tests/cli/qwen-serve-routes.test.ts`：新 tag。
- `packages/web-shell/client/components/artifacts/`：hook 重写（边界、排除、
  偏差抑制、缺失 head 重试）、面板 ARIA + 加固测试、`change-overview.ts`
  组合器；`ArtifactPanel.tsx` JSDoc；`README.md` 右面板枚举。
- `packages/acp-bridge/src/bridgeTypes.ts`、`session-control-plane.ts`：
  worktree/branch 元数据的 `baseCommit`；PR entry `source` 类型。
- `docs/design/2026-11-16-web-shell-change-overview*.md`：已知限制 → 已解决。

## 范围边界

- 只读。不新增 stage/commit/push/创建 PR 行为。
- exclude 参数 additive；既有 log 消费方不受影响。
- 加固项为测试钉住 + ARIA 契约；无无关重构。

## 待决问题

- 是否额外提供「整个会话」净 diff 范围。仍延后；已确认模型不要求。
