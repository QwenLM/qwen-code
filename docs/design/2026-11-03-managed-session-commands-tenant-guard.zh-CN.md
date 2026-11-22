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
   `ACTION_RESPONSE`、`CWD_CHANGE`、`TASK_CANCEL`、待处理的 `SESSION_COMMAND` 回执），
   要么在通过 `requireOpen` 对 fence 行做锁定读的事务内创建，
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

| 命令                                                                                                                  | 结论               | 理由                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimRename`、`settleRename`、`abandonSessionRename`、`retryRename`                                                  | 去掉               | 在 Session 锁和操作行条件更新之下，推进本 Session 已有的 `RENAME` 投递。                                                                                                |
| `completeSessionMutation`、`settleParkedRename`、`completeCwdChangeOperation`                                         | 去掉               | 结束本 Session 已有的命令或操作，并以锁定读定位它们。                                                                                                                   |
| `changeSessionModel`、`changeSessionApproval`                                                                         | 去掉               | 回执作用域为（操作、Session、actor），所以 Session 锁会串行化重放。`requirePolicyChange` 会检查 fence。回执以 `COMPLETED` 写入。                                        |
| `beginContextCompression`、`beginTaskCancelOperation`、`ManagedActionStore.admit`                                     | 去掉               | 幂等键按 Session 划分。它们在写入 `TASK_CANCEL` 或 `ACTION_RESPONSE` 之前，都通过 `requireOpen` 或 `requireSessionOpen` 检查 fence，迁移 prepare 的修复覆盖了这种情况。 |
| `requireMcpManagement`、`requireExtensionManagement`                                                                  | 去掉               | 独立的只读校验事务。配置提交会在自己的事务中再次校验。                                                                                                                  |
| `beginSessionMutation`                                                                                                | 去掉，并做下述修改 | 命令键按租户划分，由回执唯一键处理跨 Session 竞争。                                                                                                                     |
| `settleRenameSync`（[单一权威重构](2026-11-12-managed-rename-single-authority.zh-CN.md)中取代 `beginSessionRename`）  | 去掉               | 同步结算不写投递行，因此不会锁定任何操作范围。Session 锁最先获取，跨 Session 竞争由回执唯一键裁决，与 `changeSessionModel` 一致。                                       |
| `insertWorkspaceSessionCommand`、`insertInternalTeamLeadSessionCommand`、`insertChildSession`                         | 保留               | 本次未审计。创建流程依赖 guard 排在事务首次一致性读之前，且其 Workspace 解析与准入辅助方法尚未追踪（标准 2 与 4）。                                                     |
| 生命周期（`beginLifecycle`、`beginOperation`、`beginWorkspaceClose`、`beginChildClose`、`unarchiveWorkspaceSession`） | 保留               | L3 生命周期协议，频率低。                                                                                                                                               |

## 设计

从标记为"去掉"的命令中删除 `WorkspaceMigrationAdmission.lockTenant` 调用。
mutation 准入另有以下修改：

- `beginSessionMutation` 的重放探测对所有类型都改为非锁定读。`UNARCHIVE` 原先使用锁定读；
  键不存在时，它会对租户共享的回执索引加间隙锁，去掉 guard 后，两个不同键的准入会在向同一
  间隙插入时死锁，这正是 Turn 准入已经规避的问题。Session 锁仍会串行化同一 Session 的命令，
  并且它最先获取，因此探测的快照在该锁之后。
- 插入回执时出现 `DuplicateKeyException`，说明另一请求已先提交了同一按租户划分的键，因为回执
  的所有唯一键都由它派生。此时尚未写入任何数据。命令以锁定读重新读取该回执，并沿用现有规则：
  Session 或摘要不同则返回 `409 idempotency_conflict`。若引擎仍看不到该回执，同样返回该冲突。

改名准入也去掉 guard。[单一权威重构](2026-11-12-managed-rename-single-authority.zh-CN.md)
已用 `settleRenameSync` 取代 `beginSessionRename`：同步结算不写投递行，保留 guard 的
空范围锁定读与 supersede 更新随之消失，统计未结束标题投递的迁移空闲门也一并删除。
本改动依赖 Turn 准入设计中的迁移 prepare 修改，因为任务取消和 action 响应会创建
迁移需要统计的工作。

## 风险

- 同一 Session 的命令仍在其 Session 行上串行。检查 fence 的命令在迁移或物理 fence 期间，
  会在存储的别名行和目录行上短暂等待。
- 去掉 guard 的命令先锁定 Session 行或 root，然后锁定别名行和目录行，与 Turn 准入和
  生命周期 begin 一致。

## 验证与验收

1. `ManagedModelSelectionTest`：另一事务持有租户 placement guard 时，模型修改仍能完成。
2. `ManagedSchemaSessionStoreTest`（及其 MySQL 子类）：在另一 Session 以同一键提交改名之前
   固定快照，改名仍返回 `idempotency_conflict`，且不写入任何数据。
3. 同一租户的两个 Session 使用不同键并发准入首次改名，两者均成功，revision 均为一，
   且不写任何投递行。保持打开的首次改名不阻塞另一 Session 的首次改名（同租户或跨租户）。
   用例在 H2 及其 MySQL 子类中执行。
4. 现有的改名、模型、审批、MCP、扩展、上下文压缩、任务取消、cwd 变更、action 响应、
   迁移以及 CSI Session 拒绝测试继续通过，包括 CI 中的 MySQL profile。

## 后续工作

- 已完成：改名准入的 guard 已去掉。单一权威重构通过删除投递行消除了共享空范围的间隙锁，
  `ManagedSchemaSessionStoreTest` 的 `anOpenFirstRenameDoesNotHoldBackAnotherSessionsFirstRename`
  （及其 `ManagedSchemaSessionMySqlIT` 子类）在 MySQL 上验证了并发首次改名。

- 审计 Session 创建：追踪其 Workspace 解析与准入辅助方法，并在首次一致性读之前改用对相关行的锁定读，替代 guard 的排序作用。
