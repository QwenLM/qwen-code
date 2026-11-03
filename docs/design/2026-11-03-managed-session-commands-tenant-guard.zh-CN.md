# 去掉 Session 命令的租户 guard

[English](2026-11-03-managed-session-commands-tenant-guard.md) | [简体中文](2026-11-03-managed-session-commands-tenant-guard.zh-CN.md)

## 问题与现状

[Turn 准入设计](2026-11-03-managed-turn-admission-tenant-guard.zh-CN.md)已经为 Turn 提交
去掉了租户 placement guard，并让迁移 prepare 在锁定存储 fence 行之后基于已提交数据检查
是否空闲。另外大约二十个 Session 命令仍以 `WorkspaceMigrationAdmission.lockTenant` 开头，
因此同一租户内的每次改名、修改模型或审批、MCP 或扩展检查、任务取消、上下文压缩以及
action 响应，都在同一行上排队，而且没有 Turn 提交那样的五秒上限。

## 标准

只有同时满足以下条件，命令才能去掉 guard：

1. **迁移。** 迁移空闲检查统计的工作（Turn、`CLOSE`、`ARCHIVE`、`DELETE`、
   `ACTION_RESPONSE`、`CWD_CHANGE`、`TASK_CANCEL`、待处理的 `SESSION_COMMAND` 回执、
   未结束的 `RENAME` 投递），要么在通过 `requireOpen` 对 fence 行做锁定读的事务内创建，
   要么该命令本来就从不检查 fence。对于后者，它原本就可能在 fence 提交之后立即被准入，
   因此在 prepare 执行期间被准入，留下的状态相同。
2. **之后不再获取 guard。** 事务后续步骤都不获取 guard，因此去掉第一次获取只会删除一条
   等待边。
3. **没有读取方依赖它。** 没有其他 guard 持有者以非锁定读检查该命令写入的行，并依赖
   guard 防止这些行变化。
4. **快照在加锁之后。** 去掉 guard 后，第一条语句仍是锁定读（Session 行或 Session
   root），因此后续检查读取的快照建立在该锁之后。
5. **幂等。** 共享同一幂等键的并发请求，仍由命令自己获取的锁串行化，或者冲突被正确处理。

## 审计

下列命令在 guard 之后的第一条语句都是锁定 Session 行（`requireLegacySessionForUpdate`）
或 Session root（`requireLegacyMutation`）（标准 4）。CSI 固定的 Session 会被该行上的
`is_csi_guard` 标志拒绝，因此 CSI 退役及其应用清单不会看到这些命令的写入。生命周期 begin
（包括 Workspace close）按单个 Session 执行，并在检查未结束操作之前锁定同一 Session 行
（标准 3）。被调用方向下追踪了两层，都不获取 guard（标准 2）。

| 命令 | 结论 | 理由 |
| --- | --- | --- |
| `claimRename`、`settleRename`、`abandonSessionRename`、`retryRename` | 去掉 | 在 Session 锁和操作行条件更新之下，推进本 Session 已有的 `RENAME` 投递。 |
| `completeSessionMutation`、`settleParkedRename`、`completeCwdChangeOperation` | 去掉 | 结束本 Session 已有的命令或操作，并以锁定读定位它们。 |
| `changeSessionModel`、`changeSessionApproval` | 去掉 | 回执作用域为（操作、Session、actor），所以 Session 锁会串行化重放。`requirePolicyChange` 会检查 fence。回执以 `COMPLETED` 写入。 |
| `beginContextCompression`、`beginTaskCancelOperation`、`ManagedActionStore.admit` | 去掉 | 幂等键按 Session 划分。它们在写入 `TASK_CANCEL` 或 `ACTION_RESPONSE` 之前，都通过 `requireOpen` 或 `requireSessionOpen` 检查 fence，迁移 prepare 的修复覆盖了这种情况。 |
| `requireMcpManagement`、`requireExtensionManagement` | 去掉 | 独立的只读校验事务。配置提交会在自己的事务中再次校验。 |
| `beginSessionRename`、`beginSessionMutation` | 保留 | 命令键按租户划分。guard 会串行化两个复用同一键的 Session；去掉后失败方会得到未处理的 `DuplicateKeyException`，而不是 `idempotency_conflict`（标准 5）。 |
| `insertWorkspaceSessionCommand`、`insertInternalTeamLeadSessionCommand`、`insertChildSession` | 保留 | 本次未审计。创建流程依赖 guard 排在事务首次一致性读之前，且其 Workspace 解析与准入辅助方法尚未追踪（标准 2 与 4）。 |
| 生命周期（`beginLifecycle`、`beginOperation`、`beginWorkspaceClose`、`beginChildClose`、`unarchiveWorkspaceSession`） | 保留 | L3 生命周期协议，频率低。 |

## 设计

从标记为"去掉"的十四个命令中删除 `WorkspaceMigrationAdmission.lockTenant` 调用，不做其他
代码改动。本改动依赖 Turn 准入设计中的迁移 prepare 修改，因为任务取消和 action 响应会创建
迁移需要统计的工作。

## 风险

- 同一 Session 的命令仍在其 Session 行上串行。检查 fence 的命令在迁移或物理 fence 期间，
  会在存储的别名行和目录行上短暂等待。
- 锁顺序为 Session 行或 root，然后是别名行和目录行，与 Turn 准入和生命周期 begin 一致。

## 验证与验收

1. `ManagedModelSelectionTest`：另一事务持有租户 placement guard 时，模型修改仍能完成。
2. 现有的改名、模型、审批、MCP、扩展、上下文压缩、任务取消、cwd 变更、action 响应、
   迁移以及 CSI Session 拒绝测试继续通过，包括 CI 中的 MySQL profile。

## 后续工作

- 为按租户划分的改名和 mutation 键处理 `DuplicateKeyException`，然后去掉它们的 guard。
- 审计 Session 创建：追踪其 Workspace 解析与准入辅助方法，并在首次一致性读之前改用对相关行的锁定读，替代 guard 的排序作用。
