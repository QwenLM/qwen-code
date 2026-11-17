# Worktree 搬运元数据：让回收器排除搬运覆盖层（R9-6）

- 状态：提议（#17237 的首个交付项）
- 基于：`2026-11-14-web-shell-codex-worktree-parity.md`（D3 dirty 携带、D6 handoff、D7 快照）
- 跟踪：#17237「Carry metadata for the reaper (R9-6, deferred from #17228)」
- 关联：#17228 评审评论 6900008905 / 4579730709

## 问题

`createUserWorktree(..., { carryDirtyState: true })` 把源检出的 dirty 覆盖层复制进
新托管 worktree，并以 `carriedPaths` 返回精确的覆盖层路径
（`gitWorktreeService.ts`，`[...dirtyState.trackedFiles, ...createdUntracked]`）。
已有两个消费方使用该集合：

- 准备好的 worktree 清洁度门精确豁免这些路径（`exempt = new Set(carriedPaths ?? [])`），
  使仅持搬运副本、从未附着的准备好 worktree 仍能完成 finalize；
- branch-worktree 路由把它持久化进准备 journal（`branch-worktree-preparation.ts`），
  其读取方拒绝超限记录。

但该集合从未进入**会话 sidecar**（`worktreeSessionService.ts` 的 `WorktreeSession`），
也从未被**孤儿回收器**（`worktree-orphan-cleanup.ts`）查询。`executeWorktreeCleanup`
以 `worktreeHasWork(plan.lockKey)` 作保留门，其签名只接受路径。因此*仅*含搬运覆盖层
的会话 worktree 被读作「有未提交工作」而被永久保留，而非回收。在 #17228 head
`8bdb8bb549` 复现（round-9 单元 S8）：`DELETE`→`204`、checkout 留存、sidecar 未记录
`carriedPaths`。

该泄漏方向安全（保留而非删除 checkout），这正是 #17228 延后它的原因；修复需拓宽
sidecar 契约，排期于 #17237。

## 决定

把搬运覆盖层记入 sidecar，并让 has-work 门豁免它，镜像准备好 worktree 门的精确路径豁免。

### D1 — Sidecar 字段

给 `WorktreeSession` 增可选 `carriedPaths?: string[]`。可选以向后兼容：该字段出现前
写入的 sidecar（以及未用 `carryDirtyState` 创建的 worktree）直接省略它，读取方把缺席
当作「无记录的覆盖层」——has-work 门则与今日行为完全一致。运行时形状校验
（`isValidWorktreeSession`）仅当该字段是字符串数组时接受；类型错误的值像其他字段一样
使 sidecar 判为损坏。现有 64 KiB sidecar 上限已约束记录；携带的创建路径用
`maxCarriedPathsBytes`（`CARRIED_PATHS_MAX_BYTES`）约束覆盖层，使 journal 与 sidecar
保持可读。

### D2 — 写入方持久化覆盖层

每个以 `carryDirtyState` 调用 `createUserWorktree` 的创建路径，把返回的 `carriedPaths`
记入它写的 sidecar：

- `POST /session`（daemon 缺省 worktree），
- branch-worktree 路由（`POST /session/:id/branch` 带 `worktree`），
- `EnterWorktreeTool`。

搬迁写入（handoff、reset）保留已有的 `carriedPaths` 而非丢弃：在会话提交或清理之前，
覆盖层仍描述该检出的搬运内容。不带携带的创建写入方不记录（缺席），而非空数组，使
「缺席」「未搬运任何东西」与「搬运了这些路径」保持可区分。

### D3 — has-work 门豁免记录的覆盖层

`worktreeHasWork` 增可选第二参数 `carriedPaths?: readonly string[]`。缺席或为空时，
谓词与当前行为逐字节一致（core 保留清扫与 canary 调用方不传）。存在时，探针切换到
文件级原始输出（`status --porcelain --untracked-files=all -z`，与准备好门同一形式，
使未跟踪目录不被折叠、非 ASCII 路径不被 C 转义），并在现有 session-marker /
disposable-output / symlink 豁免之外，豁免路径恰在搬运集合中的条目。任何搬运集合之外
的条目——迟到的 ignored 文件、嵌套的类 marker 名、会话创建后做的 tracked 编辑——仍算
工作并保留 checkout。rename/copy 记录拒绝（携带以无 `--index` 应用 stash，覆盖层从不
含它们；出现即意味着 worktree 内索引被触碰）。

豁免是精确路径而非前缀：搬运文件 `a/b.txt` 不豁免无关的 `a/c.txt`，会话在搬运文件之外
填充的目录仍读作工作。这与准备好门的 `exempt.has(p)` 几何一致，保持豁免狭窄。

### D4 — 回收器传入 sidecar 的覆盖层

`executeWorktreeCleanup` 调用 `worktreeHasWork(plan.lockKey, sidecar.carriedPaths)`。
仅含搬运内容的 checkout 现在读作干净并被回收；含真实会话工作的 checkout 仍被保留。
core 保留清扫（`worktreeCleanup.ts`）在本交付项中保持不变——它今日不在作用域内持有
会话 sidecar；接线它属于 P6（D7），后者为「先快照再删除」读取 sidecar。

## 验收

- 仅含搬运覆盖层的会话 worktree 在会话删除后被孤儿回收器回收（复现 S8 的回归：
  修复前 `DELETE` 留下 checkout；修复后 checkout 被移除）。
- 含任何非搬运工作（创建后的 tracked 编辑、迟到的 ignored 文件、搬运文件之外填充的
  目录）的 checkout 仍被保留。
- 无该字段的 sidecar 行为与今日完全一致（向后兼容）。
- 类型错误的 `carriedPaths` 使 sidecar 判为损坏（形状校验）。
- 变异见证：去掉回收器的 `carriedPaths` 参数、把豁免放宽为前缀匹配，各击杀一条
  committed 用例。

## 范围外（#17237 后续阶段）

- P6 保留 + 快照/恢复（设计 D7）：`worktree.maxRetained`、删除前快照、重开恢复；
  保留清扫在那里读取 sidecar（及 `carriedPaths`）。
- P7 可配置 worktree 根（`worktree.root`）。
