# Worktree 保留 + 快照/恢复（P6）

[English](2026-11-17-worktree-retention-snapshots.md) | [简体中文](2026-11-17-worktree-retention-snapshots.zh-CN.md)

- 状态：U1–U3 已在本 PR 实现；U4/U5 仍由 #17237 跟踪。
- 基于：`2026-11-14-web-shell-codex-worktree-parity.md` D7（快照是工作归档）、
  D3（dirty 携带），及 `2026-11-17-worktree-carry-metadata.md`（R9-6，sidecar
  `carriedEntries` 字段）。
- 跟踪：#17237 P6。

## 目标

Codex 保留最近的托管 worktree，且清理时绝不丢失工作：归档/删除 chat 会在移除前
快照其 worktree，重开提供恢复，保留清扫保留最近 N 个。今日含 dirty 搬运状态的托管
会话 worktree 被 `worktreeHasWork` 门永久保留（R9-6 让*仅含搬运*的 checkout 可被
回收，但含真实会话工作的 checkout 仍拒绝删除）。P6 对托管会话 worktree 以「先快照
再删除」取代该拒绝，使清理把 work 保存在归档中，而非搁置 checkout。

## 分解

P6 在 #17237 分支上分五个单元落地；每个可独立测试。

### U1 — 快照捕获/恢复服务（core）

快照服务（`worktree-snapshot-service.ts`，core）把 worktree 捕获为自包含归档并恢复：

- **捕获** `captureWorktreeSnapshot({worktreePath, snapshotDir, meta})`：worktree 树的
  `tar.gz` 加随旁 JSON 头。排除与 has-work 门的*仅 ignored* 几何对齐：可再生目录名
  （`DISPOSABLE_IGNORED_ROOTS`——`node_modules`、`dist`、`coverage`）下的路径仅当 git
  报告 ignored 时才排除，因此这些名字下的 tracked 或非 ignored 文件是工作并被归档
  （验证发现 F3）。ignored 条目取自门自身的 `status --porcelain --ignored=matching -z`
  列举的 `!!` 记录——同一命令，使两个几何不可能漂移：内容匹配规则
  （`packages/app/node_modules/**`）比 `ls-files --directory` 多折叠一层，几何不一致
  曾让门判为工作的内容被归档丢弃（R6-1）。`.git` 文件/目录与会话 marker 始终排除。
  用 core 已有的 `tar` 依赖；路径相对 worktree 根。头
  （`buildWorktreeSnapshotMeta`）记录 base commit（`worktreeBase`）、HEAD commit、分支、
  dirty 摘要（tracked/untracked 计数**及删除的 tracked 路径列表**，含 rename 源）、
  会话 id、时间戳、schema 版本。
- **恢复** `restoreWorktreeSnapshot(snapshotPath, targetWorktreePath, meta)`：在新重建的
  worktree（detached 于记录的 HEAD，或在记录的分支上）上恢复，不丢失任何归档内容（验证
  发现 F2），分三步：(1) 为每个归档非目录条目清除冲突的 HEAD 目标——node-tar 能用目录替换
  文件但不能用文件替换目录，故 dir→file 替换否则会静默丢弃归档文件；(2) 在解包前重新施加
  *纯*删除（归档中缺席的路径），使被删 tracked 文件不从 HEAD 复活——会话删除后又重建的
  路径（归档中存在）留给解包恢复，删除后变成目录的路径持有归档内容，同样不动；
  (3) 以 `strict` 解包，使残留冲突显式失败而非静默丢内容。恢复忠于 commit + dirty
  tracked + untracked 内容及删除；不恢复 ignored 可再生产物，也不保留索引状态（暂存与
  未暂存）——契约是不丢失任何文件内容。路径校验为安全相对路径、约束在目标根内，且拒绝把
  `.git`/会话 marker 作为删除目标。非有效 UTF-8 的删除路径使 `buildWorktreeSnapshotMeta`
  拒绝捕获（调用方保留），而非记录一个无法按名重新施加的删除。
- **格式稳定**：头带 schema 版本（当前 2）；读取方拒绝未知版本而非错误恢复。版本 1
  （无记录的删除）被拒绝，因为它无法忠实恢复删除。捕获原子（暂存临时文件再 rename），
  使捕获中途崩溃绝不留下半写归档供后续恢复信任。
- **仓库钉住 + 加固**：捕获与元数据构建首先要求 worktree 自身的 `.git`（`fs.access`），
  使链接丢失时 git 不会回答外层仓库（验证发现 F4）；两者的 git 探针都带 `NO_EXEC_CONFIG`
  与 `--no-optional-locks`，使仓库配置的 `core.fsmonitor` hook 不被执行（验证发现 F5）。
- Fail-closed：捕获错误拒绝（调用方未获持久快照不得删除 worktree）；恢复错误拒绝，
  尽可能不留部分状态。

测试：快照内容+仅 ignored 排除（dist/ 下 tracked/非 ignored 文件被归档；ignored
node_modules 被排除；ignored 非 disposable 工作被归档）、恢复保真（committed+dirty+
untracked 往返；未暂存/暂存删除与 rename 源在重建 HEAD 上重新施加）、原子捕获、未知与
版本 1 拒绝、遍历路径拒绝、缺 `.git` 捕获拒绝（无归档）、`core.fsmonitor` 执行 canary。
捕获扫描真实文件系统（仅看 `git status` 会漏掉 clean tracked 保护路径的大小写变体），
在启动 tar 前拒绝这些变体；`ls-files -v` 使用 64 MiB 捕获缓冲，避免大索引截断。
恢复先于任何删除/解包，对包括 Directory 在内的每个成员进行词法与最近存在父目录校验；
hardlink 目标不得离开根目录。Directory 成员可以替换已校验的 tracked 普通文件：更深层的
realpath 检查只放行显式声明的文件到目录边界，且仅在所有成员通过校验后移除该文件。
每个计划删除的文件还校验最终真实目标：若嵌套 Directory 成员经别名指向顶层 `.git` 或会话
marker，则在任何清理之前拒绝，不能只相信成员的词法路径。绝对与父相对符号链接目标继续支持，但父符号链接不得作为
解包写入目标：tar 先跳过归档中的符号链接，待其它成员写完后再按受约束路径重建，
使归档不能在后续子成员之前创建一个越界父链接。

### U2 — `worktree.maxRetained` 设置

给 worktree 设置块（`settingsSchema.ts`）加 `worktree.maxRetained`（number，缺省 15，
`0` 关闭按数量自动删除）。更新 schema 新鲜度门；i18n 标签/描述预先加入。该键**现在声明，
但待 U4 落地时才伺服/渲染/消费**：Web Shell 设置漂移不变量要求每个被伺服的键都有渲染行，
而读取该值的保留清扫是 U4。在渲染行与消费方存在之前就把它加入 `WEB_SHELL_SETTINGS` 会
破坏该不变量（并留下一个无人读取的设置），故 U4 把允许清单条目、UI 行与清扫一并接线。

### U3 — 归档/删除触发：先快照再删除

托管会话 worktree 被会话归档/删除移除时（`executeWorktreeCleanup` 与归档流），移除前
捕获快照（U1），然后尝试移除——快照保存了 dirty work，故对**仅托管会话 worktree** 解除
`worktreeHasWork` 拒绝；工具/agent worktree 保留现有拒绝语义。移除仍委托
`removeUserWorktree`，它拒绝携带无 ref 可达 commit 的检出（缺省托管 worktree 是
detached）：此时快照已写但检出被保留（`unmerged commits`），故「无论 dirty 状态都移除」
对 dirty 内容成立，对未合并 commit 不成立。捕获失败同样回退保留（fail-closed：未获持久
快照绝不删除）；快照无法忠实表示的状态——暂存内容与工作树不同、非 UTF-8 删除路径、
skip-worktree 路径上的暂存编辑或新增、暂停的 merge/rebase/cherry-pick/revert/bisect——
同样拒绝捕获并保留。移除还以检出仍与捕获内容一致为条件：捕获前后，回收器为每个
非 disposable 状态路径记录其状态、`hash-object --no-filters` 原始字节身份与可执行位；
递归展开折叠的非 disposable ignored 目录和折叠的 untracked 嵌套仓库而不跟随链接，并记录
符号链接目标。首次摘要在 has-work 分类和搬运来源校验之前取得。disposable
豁免仅适用于最初折叠的 status 条目；非 disposable ignored 目录的全部子内容都计数，
因为 tar 会归档它们。marker 临时文件豁免仅限根路径。不运行 `git diff`，故 textconv 不执行。
自动保存在 tar 写入期间改写字节或重定向链接时，漂移触发保留而非删除归档覆盖不到的工作。
移除前重新探测 pending 操作，以拒绝元数据检查后新启动的操作，即使文件字节与 HEAD 未变。
同一位置复用共享的隐藏索引位探针，它先于最后一道 pending 探测：捕获中途新设的 flag
令 tracked 编辑在前后摘要中均不可见时，也不能仅因摘要一致就删除。
稀疏例外通过 `git sparse-checkout check-rules` 区分合法省略与规则包含路径上的异常 S
所隐藏的删除意图。规则排除本身还不够：实体化 S 在 `sparse.expectFilesOutsideOfPatterns=true`
让 status 保持为空时，仍可能藏有编辑内容。只有 leaf 确实不存在、且最近存在祖先为目录时才豁免；
其他路径与探测失败都保留 checkout。`ls-files` 与 `ls-files --stage` 仅关闭已知的
稀疏索引展开提示，其他 stderr 仍保留失败关闭行为。无法从 UTF-8 输出可靠还原原始索引字节的路径同样保留，
不用替代字符猜测其规则归属。
每对归档按捕获时刻唯一命名（`<sessionId>.<createdAt>.<pid>.worktree-snapshot.tar.gz`，
头部同规则），复用同一 session UUID 不再覆盖早先快照；读取方按 `<sessionId>.*.worktree-snapshot.*`
前缀于 sidecar 旁解析（chats 目录，归档会话为其 `archive/` 子目录——回收器写入 sidecar
自身所在目录），清理日志给出完整路径；重开恢复入口（U5）按该键读回。

### U4 — 保留清扫

每仓库托管会话 worktree 的按数量清扫：按最后活动排序，保留最近 `worktree.maxRetained`
个，超出限制者按最旧优先「先快照再删除」（U3）。保护活跃会话与置顶 chat 的 worktree。
`0` 关闭按数量清扫。与现有按龄期的临时 agent 清扫（`worktreeCleanup.ts`）不同，后者不变。

实现要点（已调查）：

- **枚举基于 sidecar，而非 `GitWorktreeService.listSessions`。** 该静态方法枚举的是
  _旧 agent-session_ 布局（`<baseDir>/<sessionId>/config.json` + `worktrees/`），不是
  Web Shell 会话 worktree。清扫须枚举会话 chats 目录的 `*.worktree.json` sidecar
  （`WorktreeSession` 记录，经 `SessionService.getWorktreeSessionPath` / chats 目录），
  按仓库托管根过滤（`sidecar.originalCwd` / `worktreePath` 包含性）。
- **最后活动**取会话记录的 updated 时间戳（持久化会话元数据），而非 worktree 目录 mtime；
  会话记录已删时回退 sidecar/快照时间戳。降序排序，保留前 `maxRetained` 个，其余最旧优先清扫。
- **保护**：跳过会话仍在 bridge 活跃（`bridge.getSessionSummary` 有答）或 chat 置顶
  （session-organization `isPinned`）的 worktree。活跃/置顶 worktree 绝不计入删除候选。
- **删除**复用 U3 的先快照再移除机制，但**不**原样调 `executeWorktreeCleanup`：后者的
  契约是「会话记录与 sidecar 已删」（删除路径）。清扫保留记录与 sidecar（chat 仍在，仅
  回收其 worktree），故需要一个变体：快照、移除检出、然后在留存的 sidecar 上记录
  「已移除＋快照」状态（`worktreeRemoved` 标志＋归档键），供 U5 读取以提供恢复。原样调
  删除专用函数会留下一个指向已移除检出、却无快照记录的 sidecar。清扫对每个候选取
  worktree 所有权锁（`acquireWorktreeOwnershipOp`），以免与 restore/reset 竞态。
- **触发**：daemon 周期清扫（与会话 reaper 并列），从 workspace 设置读 `worktree.maxRetained`；
  `0` 短路。保持 fail-closed：任何枚举/读取错误跳过候选，绝不删除。
- 测试：按数量排序保留最近 N、`0` 关闭、活跃/置顶受保护、超限最旧优先先快照再删除、枚举错误跳过。
  变异：去保护、去数量上限各击杀一条 committed 用例。

### U5 — 重开恢复入口

重开 worktree 已删除的 chat 提供恢复：路由重建 worktree（detached 于记录 HEAD 或记录
分支）、调 `restoreWorktreeSnapshot`（U1）解压归档并重新施加记录的删除、翻回 sidecar。
Web Shell 呈现入口（chat 头/会话概览）。i18n。同一 session 前缀存在多份捕获时，U5
依次比较头部 `createdAt`、归档 `mtimeNs`、完整归档路径的字典序，绝不依赖目录枚举顺序；
竞争头部不可读时拒绝选择，而非静默回退看似有效的旧归档。

## 验收（P6 整体）

- 归档 chat 在快照后删除其 worktree；重开提供恢复；清扫保留最近 15（缺省）。
- dirty 托管会话 worktree 在快照后删除（不再永久保留）；快照保真恢复 commit+dirty+
  untracked 内容及 tracked 删除。对搬运路径的会话改动被快照，绝不裸删（R9-6 内容感知门）。
- 工具/agent worktree 保留现有拒绝语义。
- 活跃/置顶 worktree 受保护；`0` 关闭按数量删除。

## 范围外

- P7 可配置 worktree 根（`worktree.root`）——独立单元，安全敏感的包含性/shell-guard 重推导。
- 托管（server）会话自身 worktree 设计对齐（后续）。
