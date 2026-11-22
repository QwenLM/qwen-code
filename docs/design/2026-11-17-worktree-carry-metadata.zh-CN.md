# Worktree 搬运元数据：让回收器排除搬运覆盖层（R9-6）

[English](2026-11-17-worktree-carry-metadata.md) | [简体中文](2026-11-17-worktree-carry-metadata.zh-CN.md)

- 状态：D1–D4 已通过 [#17533](https://github.com/QwenLM/qwen-code/pull/17533) 合入，squash commit 为 [`17217d136a75a3070143cbded6de6b467039368c`](https://github.com/QwenLM/qwen-code/commit/17217d136a75a3070143cbded6de6b467039368c)；P6 U4/U5 与 P7 继续由 [#17237](https://github.com/QwenLM/qwen-code/issues/17237) 跟踪。
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
`hash` 是搬运内容的磁盘原始字节 blob 哈希（`git hash-object --no-filters`）；
`hash === null` 记录搬运删除（携带移除了该路径）；`executable` 是搬运文件的属主可执行
位——git 仅由 `S_IXUSR` 推导索引模式，更宽的掩码会豁免 0755→0655 这类 git 可见的模式
变更（R6-2）。非常规搬运条目（symlink、目录）没有内容身份：搬运的 untracked
symlink 落入通用 symlink 豁免（它在本检出中不持有数据），其余非常规搬运条目读作工作，
方向保守。

可选以向后兼容：该字段出现前写入的 sidecar（以及未用 `carryDirtyState` 创建的 worktree）
省略它，读取方把缺席当作「无记录的覆盖层」——has-work 门不施加搬运豁免（其基础探针，
含共享的隐藏索引位拒绝，仍运行）。运行时
形状校验（`isValidWorktreeSession`）仅当每个条目都有字符串 `path`、`string | null` 的
`hash`、布尔 `executable` 时接受；类型错误的值像其他字段一样使 sidecar 判为损坏。64 KiB
sidecar 读取上限约束记录：由于身份增大了覆盖层，写入方（`fitSidecarToReadCap`）在序列化
记录将超上限时丢弃 `carriedEntries`，使绑定保持可读而非被孤立——回收器随之把覆盖层当作
工作并快照（安全方向）；携带本身（worktree 里的文件）不受影响。journal 背书的创建路径仍用
`maxCarriedPathsBytes`（`CARRIED_PATHS_MAX_BYTES`）约束覆盖层。

伴随字段 `carriedFrom?: string` 记录覆盖层的搬运来源检出（当它与 `originalCwd` 不同时）：
branch-worktree 路由与 handoff 从会话自己的检出捕获 dirty 状态（`dirtyStateSource`），
会话 `/cd` 进兄弟检出会使它与 `originalCwd` 必须保持命名的 workspace 根（所有权校验路由
要求）不同。回收器的源侧校验（D4）读 `carriedFrom ?? originalCwd`；两者不同时若校验
`originalCwd`，可能授权删除覆盖层的最后副本（R5-14）。这两个路由无条件记录它（可能
等于 `originalCwd`）；`POST /session` 与 legacy sidecar 缺席该字段，回退在那里命名的
正是正确检出。非字符串值像其他字段一样使 sidecar 判为损坏。搬迁写入随 sidecar 其余
字段一并保留它。校验先把记录路径解析到其检出顶（会话 `/cd` 到顶之下时记录的是子目录，
而覆盖层路径相对仓库根）；源已消失或不可读时解析失败即拒绝——包括全删除覆盖层，否则其
缺席路径会在已不存在的源里伪装成「仍缺席」（round-6）。已知托管 checkout 时，
源检出顶还必须解析到同一个仓库：双方 `rev-parse --git-common-dir` 经 realpath 规范化后
必须一致。源检出自身的 `.git` 被移除时，不允许通过向上发现落到外层 checkout，
并以另一个仓库的相同字节满足比较（R5-14 的诱饵情形）。

### D2 — 写入方持久化覆盖层

每个以 `carryDirtyState` 调用 `createUserWorktree` 的创建路径，把返回的 `carriedEntries`
记入它写的 sidecar：

- `POST /session`（daemon 缺省 worktree），
- branch-worktree 路由（`POST /session/:id/branch` 带 `worktree`），
- handoff（`to=worktree`）。

`EnterWorktreeTool` 也创建 worktree，但从不启用 `carryDirtyState`，属无携带写入方，
不记录任何内容。branch-worktree 路由与 handoff 还记录 `carriedFrom`（它们的
`dirtyStateSource` 检出）；`POST /session` 从自身根携带，`originalCwd` 已命名该根，
故不记录 `carriedFrom`。

`createUserWorktree` 在携带应用后立即计算身份（`computeCarriedIdentities`：缺席路径成为
null-hash 删除，常规文件分批哈希）。计算失败使 `carriedEntries` 缺席——门随之把覆盖层
当作工作并快照——而不影响 `carriedPaths`，准备好回滚仍使用后者。搬迁写入（handoff、reset）
保留已有的 `carriedEntries` 而非丢弃。不带携带的创建写入方不记录（缺席），而非空数组。

### D3 — has-work 门仅豁免原始搬运内容

`worktreeHasWork` 增可选第二参数 `carriedEntries?: readonly CarriedEntry[]`。在探针之前，
共享谓词先拒绝隐藏索引位（`hasHiddenIndexBit`，`ls-files -v`），因此缺省无携带路径
（core 保留清扫、legacy sidecar、无携带创建）也受保护。assume-unchanged（小写标签，
sparse-checkout 从不设置）恒拒绝。skip-worktree（`S`）仅在属于稀疏检出、叶路径
返回 ENOENT 且最近的现存祖先是目录、并被 `sparse-checkout check-rules` 排除时才豁免。
已物化的 `S` 路径、规则内的隐藏删除、不可读路径和非目录祖先仍然拒绝。
当 Git 明确报告不支持 `check-rules` 子命令时，把工作树索引复制到私有临时目录，
使用显式重定向的索引和工作树执行 `sparse-checkout reapply`。由 Git 按原始稀疏规则
重算权威标记，而不在本地近似解析规则，也不改变原索引、配置或检出。只有重算后
保留的 `S` 集合与原集合完全一致时才豁免稀疏省略；原来被豁免的 `S` 消失表示此路径
属于规则内，其原标记可能隐藏了 tracked 删除。意外标记、输入失败及其他命令错误
（包括不支持 `reapply`）一律保留检出。准备好 worktree 回滚门调用同一谓词，
不再维护另一套 sparse 豁免。`ls-files` 探针仅关闭指定的稀疏索引
展开提示，其它 stderr 仍失败关闭。存在 `carriedEntries` 时，探针是单一折叠的
`status --porcelain --untracked-files=all --ignored=matching -z`（非 ignored 的 untracked
文件保持文件级使搬运路径精确匹配；ignored 条目折叠为目录，即基础谓词的几何，使大
`node_modules` 不以文件级枚举而撑爆捕获缓冲），并一次性计算搬运路径的*当前*身份。
仅当 `carriedEntryMatches` 成立时豁免搬运条目：

- 搬运内容（`hash !== null`）：状态恰为 ` M`（未暂存 tracked 编辑）或 `??`（untracked），
  路径是常规文件，且当前 blob 哈希与可执行位等于搬运时的值；
- 搬运删除（`hash === null`）：状态恰为 ` D`（未暂存删除）且路径仍缺席。

搬运路径的任何其他状态——暂存（`M `、`A `、`D `）、删除搬运内容、恢复搬运删除、symlink
替换、或任何内容/模式漂移——都是不能豁免的新工作，回收器先快照再删除 checkout（P6 U3）。
rename/copy 记录直接拒绝。非搬运条目保留现有 session-marker / disposable-output / symlink 豁免。豁免是
精确路径而非前缀。内容比较在搬运与清理两侧都用 `git hash-object --no-filters`（带 `--`
分隔符使以 `-` 开头的路径不被当作选项），故身份是磁盘原始字节的 blob 哈希。`--no-filters`
是刻意的：路径的 clean 过滤器（`eol`/`text` 归一化）否则可能把一次编辑归一化掉，使被改动
的搬运文件哈希不变而被读作原始——这正是要避免的数据丢失路径（R4-1/R5-5）。git 可见的
仅模式变更由属主可执行位字段捕获（R6-2）。每个搬运条目还会对照其当前身份校验，即使 `git status` 未列出它（会话
删除的搬运 untracked 文件不留 status 记录，R5-8）。仅含原始搬运内容的 checkout 只有在源
检出仍逐内容持有该覆盖层时才免快照回收；否则改为快照（R5-2）。

### D4 — 回收器传入 sidecar 的覆盖层

`executeWorktreeCleanup` 调用 `worktreeHasWork(plan.lockKey, sidecar.carriedEntries)`。
仅含原始搬运内容的 checkout 读作干净；免快照回收前，回收器还校验搬运来源检出
（`sidecar.carriedFrom ?? sidecar.originalCwd`）仍逐内容持有该覆盖层，不再持有或不可读
时改为快照（R5-2/R5-14）。裸回收前立即复核来源；发生变化或读取失败时保留目标，而不是
丢弃最后一副本。归档移动会话记录和 sidecar，并保留 checkout 及其可逆的
archive/unarchive 绑定。删除先校验 ownership，在会话记录已删除后才进行快照与移除。捕获还会读回
真实 tar 内容、可执行位和链接目标，与最终 checkout 不一致时拒绝。含真实会话工作——包括
对搬运路径的会话改动——的 checkout 读作工作并被先快照再删除（P6 U3）。core 保留清扫
（`worktreeCleanup.ts`）在本交付项中保持不变。

## 验收

- 仅含原始搬运覆盖层的会话 worktree 在会话删除后被孤儿回收器回收（复现 S8 的回归）。
- 对已有有效 worktree-backed 会话，归档和取消归档保留 checkout、原始字节和 worktree 绑定；
  归档不触发快照或移除，取消归档后仍能沿原路径加载。
- 搬运来源不再持有覆盖层或不可读时，仅含原始搬运内容的 checkout 改为快照——包括来源
  是 `carriedFrom` 记录的兄弟检出、而 `originalCwd`（诱饵）仍匹配搬运时身份的情形
  （R5-2/R5-14）。
- 对搬运路径的会话改动被快照而非裸删：暂存搬运编辑、删除搬运文件、对搬运 tracked 或
  untracked 文件的进一步未暂存编辑、仅模式变更，各读作工作（F1 单元）。
- 原始搬运删除读作干净；恢复或暂存它读作工作。
- 隐藏在 assume-unchanged 或 skip-worktree 下的会话编辑读作工作；skip-worktree 路径上的
  暂存编辑或新增进一步拒绝快照捕获（稀疏工作树无法表示它），暂停的
  merge/rebase/cherry-pick/revert/bisect 操作整体保留 checkout（其私有状态无法归档）。
  移除以检出仍与捕获内容一致为条件：前后摘要包含 untracked 与 ignored 工作的逐路径
  原始字节身份和可执行位，且不调用 diff/textconv，因此同路径迟到自动保存触发保留而非删除。
  首次摘要在 has-work 与搬运来源分类之前取得，来源哈希期间新保存的文件不会授权无归档删除。
  移除前复核共享隐藏索引位，再复核 pending 操作。
  捕获期间新设置的 index bit 及随后编辑即使不进入 status，也不能授权删除。
  最后的 populated-gitlink 探测还在捕获期间初始化 submodule 时保留检出：对象库位于检出根之外，
  归档与删除都不保留它。
  支持 `check-rules` 时，clean-sparse 例外仅限 Git 当前 sparse-checkout 规则实际排除
  且确实不存在的路径；实体化的 S 与规则内隐藏的删除意图都继续保护。
  `ls-files` 只关闭特定的稀疏索引展开提示，其他 stderr 仍按失败关闭处理。
  无法从 UTF-8 输出可靠还原的原始索引路径也保留 checkout。
  保护路径的大小写变体在 tar 启动前拒绝捕获。
- 含任何非搬运工作（迟到的 ignored 文件、搬运文件之外填充的目录）的 checkout 读作工作，
  被先快照再删除（P6 U3）——绝不裸删。快照无法忠实表示的状态（暂存内容与工作树不同、
  隐藏索引位）拒绝捕获并改为保留 checkout；子模块对象库则即使 deinit 或 `git rm` 把
  gitlink 移出索引也整体保留 checkout（对象库留在 per-worktree 管理目录，归档覆盖不到，
  R5-3）。
- 无该字段的 sidecar 不获搬运豁免（向后兼容）；基础探针（含隐藏索引位拒绝）仍适用。
- 类型错误的 `carriedEntries` 使 sidecar 判为损坏（形状校验）。
- 变异见证：去掉回收器的 `carriedEntries` 参数、把豁免放宽为前缀匹配、去掉内容身份比较，
  各击杀一条 committed 用例。

## 范围外（#17237 后续阶段）

- P6 保留清扫（U4）与重开恢复（U5），设计 D7：按数量的 `worktree.maxRetained`
  清扫与读回快照的入口。删除前快照（U3）**已通过 #17533 落地**（D4）；清扫与恢复读取方
  是 P6 剩余单元。U5 落地前，归档按 `sessionId` 键存于 sidecar 旁（chats 目录，归档会话
  为其 `archive/` 子目录）并在清理日志中点名；U4 落地前，无清理方修剪它。
- P7 可配置 worktree 根（`worktree.root`）。

## 交付与验证证据

#17533 于 2026-11-20 08:46:56 UTC 以 squash 方式合入。验证对应的 PR head 为 `cfea959835ae3e1b2623c14dbef4cf54586dea04`；主线 squash commit 为 `17217d136a75a3070143cbded6de6b467039368c`。

最终真实进程验证在 Linux + Node 24.22.1 + Git 2.39.5 上，通过 HTTP 驱动独立 daemon 实例，执行真实 Git 和文件系统操作。每个场景使用独立夹具，并检查真实 transcript 与最终文件系统状态：

| 场景                     | 通过的检查 |
| ------------------------ | ---------: |
| `legacy-hidden-deletion` |      18/18 |
| `legacy-ordinary-sparse` |      15/15 |
| `injected-generic-error` |      13/13 |
| `injected-stdin-epipe`   |      13/13 |
| `rebase-pending`         |      14/14 |
| `rebase-quit-clean`      |      15/15 |
| **合计**                 |  **88/88** |

独立原始证据审计通过 **27/27** 项检查。全量 build、bundle、根 typecheck、针对性测试及限定范围的 ESLint 在验证的 PR head 上通过；lint 排除范围仅限生成的 SDK JavaDoc 输出。离线夹具没有调用外部模型。这些结果不代表覆盖所有 Git、OS、sparse-index 或 Unicode/provider 组合。

详见[最终验证报告](https://github.com/QwenLM/qwen-code/pull/17533#issuecomment-7033889550)与[独立合入后收尾审查](https://github.com/QwenLM/qwen-code/pull/17533#issuecomment-7034945521)。squash commit 对应的产品 CI [run 44705284375](https://github.com/QwenLM/qwen-code/actions/runs/44705284375) 已成功完成；其中完成的 Linux build、test 和 lint jobs 与上述运行时矩阵相互独立，skip 的条件性 jobs 不增加验证覆盖。

延期的 U4/U5/P7 及覆盖建议（包括串行归档写入保护的覆盖评估）继续归入 #17237。覆盖建议不是现有保护已损坏的证据，本身也不构成启用并行归档写入的理由。
