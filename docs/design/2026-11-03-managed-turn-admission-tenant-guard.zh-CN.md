# 去掉 Turn 准入的租户 guard

[English](2026-11-03-managed-turn-admission-tenant-guard.md) | [简体中文](2026-11-03-managed-turn-admission-tenant-guard.zh-CN.md)

## 问题与现状

每次 Turn 提交都会执行 `AgentSessionCommands.insertTurnCommand`。它首先通过
`WorkspaceMigrationAdmission.lockTenant` 获取租户 placement guard；自
[#13800](2026-10-11-managed-tenant-guard-wedge.zh-CN.md) 起，该获取限时五秒。因此，
一个租户内所有 Session 的每个 Turn 都在同一行上排队，排在 Runtime placement、存储
注册、fencing、迁移、维护、CSI 工作和 retention 之后；遇到长时间持有者时就会变成
`tenant_guard_contended`。

#13800 设计记录了保留这把 guard 的原因：存储迁移 fence 必须排除新工作，而
`WorkspaceMigrationStore.prepare` 先检查存储是否空闲，再写入 fence。Turn 准入与
fence 安装共用这把 guard，所以不会有 Turn 在空闲检查和 fence 之间被准入。

## 已经在约束 Turn 准入顺序的锁

Turn 准入在同一事务内按以下顺序加锁：

1. `ma_session` 行（`FOR UPDATE`）。生命周期 begin（close、archive、delete）在检查
   未结束的 Turn 和操作之前也锁定同一行，所以两者已在该行上串行。
2. 对 Workspace Session，`WorkspaceMigrationAdmission.requireOpen` 以锁定读读取该
   存储的 `ma_storage` 别名行（同时也是迁移 fence 行）及其 `ma_storage_owner` 目录行，
   并要求没有 fence、挂载为 `READY`。物理 fencing 与 restore 会锁定别名行和目录行，
   workspace recovery 只在目录处于 `FENCED` 时执行。
3. 插入 Turn 及其命令。

事务后续步骤都不再获取租户 guard：事件追加、worktree 就绪检查和配置检查只使用行锁。
因此去掉开头这次获取只会删除一条等待边，不会新增等待边。

## 缺口与改动

迁移一侧，`prepare` 先获取 guard，再调用 `migrationSource`；后者通过
`LocalStorageOwners.lockCovered` 锁定该物理存储的所有别名行，其中包括 fence 行。
持有 fence 行的准入会在该锁授予之前提交；之后的准入会等待，然后看到 fence。但
`migrationSource` 在加锁之前先以非锁定读读取了 `ma_storage`，因此在 MySQL 上，迁移
事务的 REPEATABLE READ 快照可能早于加锁时间。去掉 guard 后，在该快照与加锁之间提交
的 Turn 将对空闲检查不可见。

改动包括两部分：

- `insertTurnCommand` 不再获取租户 guard。锁定 Session 行是它的第一条语句，因此它
  自己的快照建立在该锁之后。
- `prepare` 在 `migrationSource` 锁定 fence 行之后，在一个独立的、自动提交的只读
  连接上执行空闲检查（`requireCommittedIdle`）。这与
  `LocalStorageOwners.lockCovered` 检查 authority 清单时已采用的方式相同。加锁之前
  准入的未结束 Turn 都已提交且可见，之后的准入都会被 fence 拒绝。

其他空闲检查（`retire` 及后续阶段）都在 fence 提交之后执行：要么在首次读取为 fence
行锁定读的事务内，要么不在事务内，因此它们的快照已经在 fence 之后。

## 范围

范围内：Turn 提交准入，以及迁移 prepare 的空闲检查。

范围外、继续持有 guard：其他使用 `WorkspaceMigrationAdmission.lockTenant` 的 Session
命令（改名、修改模型与审批、MCP 与扩展管理、cwd 变更、任务取消、上下文压缩、Session
与子会话插入、actions）、用户消息队列的 `startNext`（它在通过同一路径提交前仍获取
guard）、生命周期操作、Journal 写者以及发布。它们都需要先完成同样的审计，才能去掉
guard。

## 风险

- Turn 准入现在等待的是存储的别名行和目录行，而不是租户行。因此同一存储的 Turn 仍会
  在这些行上短暂串行，该存储的迁移或物理 fence 也会短暂阻塞它们。
- 锁顺序为 Session 行、别名行、目录行，与生命周期 begin 一致。若某个 guard 持有者先锁
  别名行再锁 Session 行，可能与之死锁；InnoDB 会检测并回滚其中一方，调用方将其表现为
  可重试的失败。审计中没有发现这样的持有者。
- `prepare` 持锁期间，空闲检查会额外使用一个连接池连接。迁移是管理员操作。

## 验证与验收

1. `WorkspaceMigrationStoreTest`：在快照已固定的 REPEATABLE READ 事务内，由另一连接
   提交的 Turn 仍使 `prepare` 以 `migration_work_unsettled` 拒绝，并且不安装 fence。
2. `ManagedSessionGuardConvoyIT`（MySQL）：另一事务持有租户 guard 时，Turn 提交不再
   以 `tenant_guard_contended` 失败。
3. 现有迁移、Turn 准入、生命周期与用户消息队列测试继续通过，包括 CI 中的 MySQL。

## 未决问题

本增量没有。其余 Session 命令留作后续工作。
