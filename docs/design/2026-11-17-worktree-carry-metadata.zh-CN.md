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

把搬运覆盖层**连同其搬运时的内容身份**记入 sidecar，has-work 门仅当某搬运路径的当前
状态仍与该身份匹配时才豁免它。仅按路径豁免（准备好门的几何）对*已附着*的会话 worktree
不安全：会话在创建后继续工作，对搬运路径的再编辑、暂存或删除是源检出并不持有的新工作，
仅凭路径相等无法把它与原始搬运副本区分。这一点被 #17533 的独立 `/verify-pr` 轮实测为
数据丢失路径（发现 F1），正是 sidecar 记录身份而非仅路径的原因。

准备好 worktree 门（`removePreparedUserWorktree`）保持其仅路径豁免不变：准备好 worktree
从未附着，其 `atBase`/`checkoutMatches` 门证明没有会话工作发生，同一几何在那里安全。
因此 `createUserWorktree` 同时返回 `carriedPaths: string[]`（供准备 journal / 准备好门）
与 `carriedEntries: CarriedEntry[]`（供会话 sidecar / 托管门）。

### D1 — Sidecar 字段

给 `WorktreeSession` 增可选 `carriedEntries?: CarriedEntry[]`，其中
`CarriedEntry = { path: string; hash: string | null; executable: boolean }`。
`hash` 是搬运内容的 `git hash-object` blob 哈希；`hash === null` 记录搬运删除（携带
移除了该路径）；`executable` 是搬运文件的可执行位，使仅模式变更也可检测。非常规搬运
条目（symlink、目录）不被记录——门随之把它们当作工作，方向保守。

可选以向后兼容：该字段出现前写入的 sidecar（以及未用 `carryDirtyState` 创建的 worktree）
省略它，读取方把缺席当作「无记录的覆盖层」——has-work 门则与今日行为完全一致。运行时
形状校验（`isValidWorktreeSession`）仅当每个条目都有字符串 `path`、`string | null` 的
`hash`、布尔 `executable` 时接受；类型错误的值像其他字段一样使 sidecar 判为损坏。64 KiB
sidecar 读取上限约束记录：由于身份增大了覆盖层，写入方（`fitSidecarToReadCap`）在序列化
记录将超上限时丢弃 `carriedEntries`，使绑定保持可读而非被孤立——回收器随之把覆盖层当作
工作并快照（安全方向）；携带本身（worktree 里的文件）不受影响。journal 背书的创建路径仍用
`maxCarriedPathsBytes`（`CARRIED_PATHS_MAX_BYTES`）约束覆盖层。

### D2 — 写入方持久化覆盖层

每个以 `carryDirtyState` 调用 `createUserWorktree` 的创建路径，把返回的 `carriedEntries`
记入它写的 sidecar：

- `POST /session`（daemon 缺省 worktree），
- branch-worktree 路由（`POST /session/:id/branch` 带 `worktree`），
- handoff（`to=worktree`），
- `EnterWorktreeTool`。

`createUserWorktree` 在携带应用后立即计算身份（`computeCarriedIdentities`：缺席路径成为
null-hash 删除，常规文件分批哈希）。计算失败使 `carriedEntries` 缺席——门随之把覆盖层
当作工作并快照——而不影响 `carriedPaths`，准备好回滚仍使用后者。搬迁写入（handoff、reset）
保留已有的 `carriedEntries` 而非丢弃。不带携带的创建写入方不记录（缺席），而非空数组。

### D3 — has-work 门仅豁免原始搬运内容

`worktreeHasWork` 增可选第二参数 `carriedEntries?: readonly CarriedEntry[]`。在两个探针
之前，共享谓词先拒绝任何隐藏索引位（`hasHiddenIndexBit`，`ls-files -v`），因此缺省无携带
路径（core 保留清扫、legacy sidecar、无携带创建）也受保护——隐藏在 assume-unchanged /
skip-worktree 下的会话编辑读作工作而非干净。存在 `carriedEntries` 时，探针切换到文件级
原始输出（`status --porcelain --untracked-files=all -z` 加 `ls-files --others -z`），并
一次性计算搬运路径的*当前*身份。仅当 `carriedEntryMatches` 成立时豁免搬运条目：

- 搬运内容（`hash !== null`）：状态恰为 ` M`（未暂存 tracked 编辑）或 `??`（untracked），
  路径是常规文件，且当前 blob 哈希与可执行位等于搬运时的值；
- 搬运删除（`hash === null`）：状态恰为 ` D`（未暂存删除）且路径仍缺席。

搬运路径的任何其他状态——暂存（`M `、`A `、`D `）、删除搬运内容、恢复搬运删除、symlink
替换、或任何内容/模式漂移——都是新工作并保留 checkout（回收器快照它）。rename/copy 记录
直接拒绝。非搬运条目保留现有 session-marker / disposable-output / symlink 豁免。豁免是
精确路径而非前缀。内容比较在搬运与清理两侧都对原始工作树字节哈希（`git hash-object` 不带
`--path`，并带 `--` 分隔符使以 `-` 开头的路径不被当作选项），因此自洽且独立于
`core.autocrlf`/过滤器。

### D4 — 回收器传入 sidecar 的覆盖层

`executeWorktreeCleanup` 调用 `worktreeHasWork(plan.lockKey, sidecar.carriedEntries)`。
仅含原始搬运内容的 checkout 读作干净并被免快照回收；含真实会话工作——包括对搬运路径的
会话改动——的 checkout 读作工作并被先快照再删除（P6 U3）。core 保留清扫
（`worktreeCleanup.ts`）在本交付项中保持不变。

## 验收

- 仅含原始搬运覆盖层的会话 worktree 在会话删除后被孤儿回收器回收（复现 S8 的回归）。
- 对搬运路径的会话改动被快照而非裸删：暂存搬运编辑、删除搬运文件、对搬运 tracked 或
  untracked 文件的进一步未暂存编辑、仅模式变更，各读作工作（F1 单元）。
- 原始搬运删除读作干净；恢复或暂存它读作工作。
- 隐藏在 assume-unchanged 或 skip-worktree 下的会话编辑读作工作。
- 含任何非搬运工作（迟到的 ignored 文件、搬运文件之外填充的目录）的 checkout 仍被保留。
- 无该字段的 sidecar 行为与今日完全一致（向后兼容）。
- 类型错误的 `carriedEntries` 使 sidecar 判为损坏（形状校验）。
- 变异见证：去掉回收器的 `carriedEntries` 参数、把豁免放宽为前缀匹配、去掉内容身份比较，
  各击杀一条 committed 用例。

## 范围外（#17237 后续阶段）

- P6 保留 + 快照/恢复（设计 D7）：`worktree.maxRetained`、删除前快照、重开恢复；
  保留清扫在那里读取 sidecar（及 `carriedPaths`）。
- P7 可配置 worktree 根（`worktree.root`）。
