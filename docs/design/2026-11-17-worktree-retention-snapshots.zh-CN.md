# Worktree 保留 + 快照/恢复（P6）

- 状态：提议（#17237，继 R9-6 搬运元数据交付项之后）
- 基于：`2026-11-14-web-shell-codex-worktree-parity.md` D7（快照是工作归档）、
  D3（dirty 携带），及 `2026-11-17-worktree-carry-metadata.md`（R9-6，sidecar
  `carriedPaths` 字段）。
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

`WorktreeSnapshotService`（core）把 worktree 捕获为自包含归档并恢复：

- **捕获** `captureSnapshot(worktreePath, header) -> snapshotPath`：worktree 树的
  `tar.gz`，排除可再生集合（`DISPOSABLE_IGNORED_ROOTS`——`node_modules`、构建产物——
  与 `worktreeHasWork` 豁免的同一集合）及 `.git` 文件/目录与会话 marker。用 core 已有
  的 `tar` 依赖。归档以相对 worktree 根的路径存储。JSON 头随旁（或作为首个归档条目）：
  base commit（`worktreeBase`）、HEAD commit、分支（如有）、dirty 摘要（tracked/untracked
  计数）、会话 id、时间戳、schema 版本。
- **恢复** `restoreSnapshot(snapshotPath, targetWorktreePath)`：把归档解压到新重建的
  worktree（detached 于记录的 HEAD，或在记录的分支上）。恢复忠于 commit + dirty tracked
  - untracked 内容；不恢复 `node_modules`（可再生）。
- **格式稳定**：头带 schema 版本；读取方拒绝未知版本而非错误恢复。捕获原子（暂存临时
  文件再 rename），使捕获中途崩溃绝不留下半写归档供后续恢复信任。
- Fail-closed：捕获错误拒绝（调用方未获持久快照不得删除 worktree）；恢复错误拒绝，
  尽可能不留部分状态。

测试：快照内容+排除（无 node_modules/.git/marker）、恢复保真（committed+dirty tracked+
untracked 往返）、原子捕获、未知版本拒绝、捕获错误拒绝。

### U2 — `worktree.maxRetained` 设置

给 worktree 设置块（`settingsSchema.ts`）加 `worktree.maxRetained`（number，缺省 15，
`0` 关闭按数量自动删除），像 `defaultForNewSessions` 一样伺服给 Web Shell。更新 schema
新鲜度门 + capabilities 信封基线（钉死基线规则）。i18n 标签/描述。

### U3 — 归档/删除触发：先快照再删除

托管会话 worktree 被会话归档/删除移除时（`executeWorktreeCleanup` 与归档流），移除前
捕获快照（U1），然后无论 dirty 状态如何都移除——快照保存了 work。这对**仅托管会话
worktree** 解除 `worktreeHasWork` 拒绝；工具/agent worktree 保留现有拒绝语义。记录快照
路径以便重开查找（U5）。捕获失败回退到当前保留行为（fail-closed：未获持久快照绝不删除）。

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
- **删除**复用 U3 路径：构造 `WorktreeCleanupPlan` 调 `executeWorktreeCleanup`（先快照再删除，
  fail-closed）。清扫本身对每个候选取 worktree 所有权锁（`acquireWorktreeOwnershipOp`），
  以免与 restore/reset 竞态。
- **触发**：daemon 周期清扫（与会话 reaper 并列），从 workspace 设置读 `worktree.maxRetained`；
  `0` 短路。保持 fail-closed：任何枚举/读取错误跳过候选，绝不删除。
- 测试：按数量排序保留最近 N、`0` 关闭、活跃/置顶受保护、超限最旧优先先快照再删除、枚举错误跳过。
  变异：去保护、去数量上限各击杀一条 committed 用例。

### U5 — 重开恢复入口

重开 worktree 已删除的 chat 提供恢复：路由重建 worktree（detached 于记录 HEAD 或记录
分支）、解压快照（U1）、翻回 sidecar。Web Shell 呈现入口（chat 头/会话概览）。i18n。

## 验收（P6 整体）

- 归档 chat 在快照后删除其 worktree；重开提供恢复；清扫保留最近 15（缺省）。
- dirty 托管会话 worktree 在快照后删除（不再永久保留）；快照保真恢复 commit+dirty+untracked。
- 工具/agent worktree 保留现有拒绝语义。
- 活跃/置顶 worktree 受保护；`0` 关闭按数量删除。

## 范围外

- P7 可配置 worktree 根（`worktree.root`）——独立单元，安全敏感的包含性/shell-guard 重推导。
- 托管（server）会话自身 worktree 设计对齐（后续）。
