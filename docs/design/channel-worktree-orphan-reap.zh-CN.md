# 孤儿回收（orphan-reap）worktree 清理（#11024 第 1 项）

[English](channel-worktree-orphan-reap.md) | [简体中文](channel-worktree-orphan-reap.zh-CN.md)

## 状态

已实现并验证（2026-09-07）。两轮真实 daemon A/B：第一轮抓到了 `supersedes`
分类缺陷（reset 之后的替代会话永远无法被清理——规则 3 已据此修订）；第二轮确认
了正常路径、tombstone 变体、被替代的前任会话跳过逻辑，以及所有按设计应予保留的
状态。验证过程中记录的一个既有缺口（不在本设计范围内）：不带 source metadata
发起的 `worktree-reset` 会让替代会话没有任何 transcript 记录，`/sessions/delete`
对它返回 `notFound`。

## 问题

当 daemon 确定性地删除一个拥有 worktree 的会话时，checkout 及其分支从不会被移
除。因此崩溃/回收循环与运维删除都会永久泄漏 worktree 和分支（由 yiliang114 在
issue #10643 上指出，`session-archive.ts:656`）。

## 泄漏路径图（真实 daemon，实测）

场景：渠道 worktree 会话（`POST /session` 带 `worktree:{}`），产物 = JSONL 记
录、sidecar `<chatsDir>/<sid>.worktree.json`、worktree 内标记 `.qwen-session`、
checkout `W/.qwen/worktrees/<slug>`（已在 git 注册）、分支 `worktree-<slug>`。

| 路径                                              | 记录       | Sidecar    | Checkout | Marker   | 分支     |
| ------------------------------------------------- | ---------- | ---------- | -------- | -------- | -------- |
| Bridge 空闲回收器（worker 崩溃）                  | 保留       | 保留       | 保留     | 保留     | 保留     |
| `POST /sessions/delete`（`deleteDaemonSessions`） | **已删除** | **已删除** | **泄漏** | **泄漏** | **泄漏** |
| `DELETE /session/:id`                             | 保留       | 保留       | 保留     | 保留     | 保留     |

- 空闲回收器不删除任何已持久化的东西；会话仍可恢复。就本议题所指的泄漏而言，这
  不算泄漏。
- `POST /sessions/delete` 是**唯一**真正移除拥有 worktree 的会话记录的删除路径，
  并且它在删除记录的同时销毁 sidecar（即归属证据）。对空闲存活会话和已被回收的
  会话都已确认。
- 没有任何生产流程会对拥有 worktree 的会话走到 `deleteDaemonSessionIfOrphan`
  （实测驱动了 6 个会话 / 6 次回收 / 5 次删除；它的静态调用点是回滚/保活路径，
  这些路径要么从不拥有 worktree，要么通过请求内的 `worktreeMeta` 自行清理）。
- 删除之后，后续的恢复请求返回 404 `session_not_found`；残留 marker 里的会话 id
  就此悬空。

## 决策

在 **`deleteDaemonSessions`** 处启用清理——这是唯一真实的泄漏路径——通过把清理
逻辑放进这个共享函数内部（而不是放在每条路由上），统一覆盖它的两个生产调用点
（REST `POST /sessions/delete` 与 ACP `qwen/sessions/delete`）。

`deleteDaemonSessionIfOrphan` 刻意**不**启用：证据表明没有生产流程会对拥有
worktree 的会话走到它，它被点名的调用点必须保持不启用（ACP dispatch 回滚、定时
任务保活、Part 4B reset 回滚），而 create 路由的回收点已经会自行清理请求内的
worktree。在那里加一个用不到的开关只会是个死开关。

因为 `deleteDaemonSessions` 在删除记录的过程中就会销毁 sidecar，所以清理的分类
必须在记录被删除**之前**完成，而执行必须在删除被确认**之后**进行。

## 并发与加锁顺序

恢复（Part 4A）与 reset 路由（Part 4B）都通过一条以规范化 worktree 路径为 key
的 promise 链来串行化 worktree 操作（`acquireWorktreeOwnershipOp`），并且这把锁
在任何 session-archive coordinator 锁**之前**获取（reset 路由：worktree 锁 →
`deleteDaemonSessionIfOrphan` → coordinator）。清理必须遵循同样的顺序——先
worktree 锁，后 coordinator——否则两种顺序可能死锁（AB-BA）。

- ownership-op 锁从一个路由内的局部闭包搬到一个共享模块，只以规范化 worktree 路
  径为 key（被串行化的资源是磁盘上的 checkout；按 bridge 划分只是一种 GC 上的便
  利，而且 release-on-finally 已经限制了这个 map 的大小）。按路径划分严格更保守，
  并且让清理不必再关心 REST 与 ACP 调用点之间的 bridge 身份问题。
- 当 `deleteDaemonSessions` 以 `coordinatorLockHeld: true` 运行时（内部的活跃对
  话 runtime，此时外层 batch 锁已被持有），清理会被**跳过**：在那里获取 worktree
  锁会颠倒顺序，而内部 runtime 从不拥有 Part 4A 的 worktree。
- 每次删除只获取一把 worktree 锁（它自己候选项的那把），所以并发批量删除不需要
  多锁排序——共享同一个 checkout 的两个会话会在同一个 key 上串行化，输的一方按
  删除后的状态重新分类。

## 安全契约

只有当整条归属链都验证通过时清理才会触发；任何疑问都保留 checkout，并记录一条
具名告警（通过 `writeStderrLine` 输出到 `qwen serve:` 的 stderr 行）。

分类（在记录删除之前，持有 worktree 锁）：

1. 严格读取 sidecar（`readWorktreeSessionStrict`）。`missing` → 不是 worktree
   拥有者，不清理。`invalid` → 保留 + 记录日志。归档位置也会被检查——sidecar
   随记录一起迁移。
2. sidecar 没有 `workspaceCwd`（旧版工具 worktree）→ 静默保留；不归 daemon 路
   由所有。
3. sidecar 带有 `supersededBy` → **静默**跳过：这是 reset 之后的预期状态
   （checkout 现在属于替代会话），因此"保留并记录日志"才能保持它原有的含义。
   sidecar 带有 `supersedes` 意味着本会话在 reset 之后**就是**当前拥有者，仍然
   可清理——第一轮 A/B 证明了更严格的读法（只要有任何关联就跳过）会让每个
   reset 之后的会话的 worktree 永久无法清理，这违背本设计自己的目标。
4. 严格读取 marker（`readWorktreeSessionMarkerStrict`）必须为 `valid`，且其
   中的会话 id 正好是被删除的那个会话。
5. 路径包含性：checkout 必须解析到工作区的 worktree 根目录之下
   （`<ws>/.qwen/worktrees`，或仓库顶层的等价目录，allowed-roots 的推导方式与
   create 路由一致）。
6. 跨会话共享：扫描 sidecar 目录下的 `*.worktree.json`，必须找不到**其他**会话
   的 sidecar 指向同一个（规范化）worktree 路径。tombstone 前任会话
   （`supersededBy` 正好指向被删除的会话）合法地指向同一个 checkout——它是这次
   移交的证据，不是共享。

执行（在删除被确认之后，仍持有 worktree 锁）：

7. **以实际删除结果为门控**：只有 `kind === 'removed'` / `mutationApplied`
   ——绝不含 `notFound` 或错误形态，与 create 路由的 `if (removed)` 门控保持一
   致。
8. 重新校验 marker（未变化，且仍指向被删除的会话）——关闭分类阶段看不到的带外
   窗口。
9. 共享的 `worktreeHasWork` 谓词
   （`packages/core/src/services/gitWorktreeService.ts`）必须报告"没有工作"：
   一次完整的 `git status --porcelain` 遍历，**包含未跟踪文件**，也包含被 git
   忽略的文件，因此 agent 写入但从未提交的文件算作工作并保留 checkout。这正是
   安全契约中"任何疑问都保留"背后的刻意选择：已跟踪且已提交的工作本来就受保
   护，把门控扩展到未跟踪文件的代价是每次删除多一次 `git status` 遍历，换来堵
   上"草稿被静默销毁"这个只检查已跟踪文件时会留下的漏洞。该谓词同时也是豁免项
   的权威枚举处（可再生构建产物、符号链接，以及当 git 把 daemon 自己的
   `.qwen-session` marker 列为未跟踪或已忽略时的该 marker），所以本文档刻意不
   重述它们：CLI 启动清扫与本回收器都调用它，两者不会走偏。读取错误一律 fail
   closed 为"有工作"。bridge 会话在记录删除之前已经关闭，因此删除之后不会再有
   daemon 内的写入方弄脏 checkout。
10. `removeUserWorktree(slug, { deleteBranch: true })` —— 绝不用
    `forceDeleteBranch`。记录 `branchPreserved` 结果，以便区分"checkout 已移
    除、分支因未合并提交而保留"与"checkout 保留、归属存疑"。

## 失败语义

- 会话记录的删除完全按现状进行，不受清理分类结果影响：被保留的 checkout 绝不会
  阻塞删除，`removeUserWorktree` 失败会被记录日志，此外一律忽略（它留下的泄漏
  就是现状，绝不会更糟）。
- 在记录删除与 worktree 移除之间崩溃会留下此前那种泄漏形态；将来的清扫可以恢复
  它（不在范围内）。

## 不在范围内

- 针对崩溃/回收泄漏形态（记录保留、一切都保留——没有东西丢失，只是闲置）的周期
  性/启动时孤儿 worktree 清扫。
- 启用 `deleteDaemonSessionIfOrphan`（没有生产可达路径；见"决策"）。
- 在 checkout 被保留时移除残留的 sidecar/marker（保留意味着归属存疑；sidecar
  正是后续修复所需要的证据）。

## 测试计划

单元测试（`session-archive.test.ts`，在临时目录中使用真实 git 仓库 + 真实
sidecar/marker）：

- 正常路径：删除会移除记录 + checkout + 分支 + marker。
- 门控：`notFound`（记录不存在、sidecar 存在）→ checkout 保留。
- 被替代的 sidecar → 保留，且不记录告警（静默跳过）。
- 旧版 sidecar（无 `workspaceCwd`）→ 保留。
- 非法 sidecar → 保留 + 告警。
- marker 缺失 / 不匹配 / 非法 → 保留 + 告警。
- 跨会话共享（第二个 sidecar，同一路径）→ 保留 + 告警。
- 包含性校验失败（checkout 在 allowed roots 之外）→ 保留 + 告警。
- 脏 checkout（已跟踪文件被修改）→ 保留 + 告警。
- worktree 分支上有未合并提交 → checkout 移除、分支保留，并记录
  `branchPreserved`。
- `coordinatorLockHeld: true` → 即使完全验证通过也跳过清理（checkout 保留）。

E2E（真实 daemon A/B）：重复泄漏路径图的场景 3/4——在 `POST /sessions/delete`
之后，checkout、marker、注册信息与分支都已消失；脏 checkout 变体则保留。
