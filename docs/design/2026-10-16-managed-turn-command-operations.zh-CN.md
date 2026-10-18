# Managed Turn 命令 operation（Stage D7-1）

[English](2026-10-16-managed-turn-command-operations.md) | [简体中文](2026-10-16-managed-turn-command-operations.zh-CN.md)

状态：已在本次改动中实现。Turn 的输入与取消成为持久命令 operation，种类为 `submit_input` 与 `cancel`，可经 operation 查询读取；契约 `1.58.0`，schema V8。#14318 先合入了契约 `1.52.0` 与 schema V7，#14358、#14412、#14413、#14405 与 #14414 先后合入了契约 `1.53.0` 至 `1.57.0`，本改动排在它们之后。准入响应暂不携带该 operation，那属于 D7-3。

这是 [#14122](https://github.com/QwenLM/qwen-code/issues/14122)（[#12380](https://github.com/QwenLM/qwen-code/issues/12380) Stage D 的 D7 伞形 issue）的 **D7-1** 切片，由 [#14168](https://github.com/QwenLM/qwen-code/issues/14168) 跟踪。#12380 规定 Stage D 只有在具备持久命令投递与原命令对账时才能暴露 `java_durable`。本切片提供前一半。D7-2（[#14166](https://github.com/QwenLM/qwen-code/issues/14166)）提供对账，D7-3（[#14167](https://github.com/QwenLM/qwen-code/issues/14167)，可选 profile）须等两者都落地。

## 问题

契约里的命令 operation 早已列出 `submit_input` 与 `cancel`，`PublicTurn`、`CommandAdmission` 与 `WebShellAdmission` 也为 D7 预留了 `operation_id`、`admission_stage` 与 `delivery_state`。服务端两个种类都没有。Turn 的提交或取消以 Turn id 回 `202`，却没有任何 operation 记录这条命令，于是丢失的应答没有原 operation 可以找回。这正是 #12867 的 D7 退出检查：响应丢失时经原 operation 找回结果，且不重复产生副作用。

## 现状

取自 `main` 的 `20ddb526ff`（契约 `1.51.0`，schema V6）：

- **投递已经存在，在 Turn 上。** 提交在一个事务里写入 `ma_turn` 行（`ACCEPTED`）、它的 `SUBMIT_TURN` 命令回执与 `turn.accepted` 事件。`HarnessCoordinator` 用派发租约认领 Turn、提交它，并把 Harness 的 event epoch 记到 Turn 上（`recordAdmission`）。它每秒一次的扫描会重新派发租约已过期的 Turn，它的重试预算会让每个 Turn 都走到终态。取消在一个事务里写入 `CANCEL_TURN` 回执并把 Turn 置为 `CANCELLING`。随后由同一个派发器取消它：准入前取消（`cancelBeforeAdmission`）、经 Harness 取消，或经运行时恢复取消。
- **幂等已经存在，在回执上。** 同一个键重放其回执的准入结果，同键不同请求摘要回 `409 idempotency_conflict`。
- **operation 表没有 Turn 种类。** `StoreModels.OperationKind` 为 `CLOSE, ARCHIVE, DELETE, ACTION_RESPONSE, CWD_CHANGE, TASK_CANCEL`。`ManagedSchemaContract.OperationKind` 是其超集，二者以 `valueOf(kind.name())` 桥接。CHECK 约束 `ck_ma_operation_kind` 列举了全部可存种类，因此新增种类需要一次迁移。
- **表上的 Session 屏障按种类列举。** `SESSION_OPERATION_KINDS` 供给未结 operation 守卫（`hasOpenOperation`）、生命周期认领与读取。`findDeliverableOperations`、`hasOpenExecutionOperation`、Workspace 迁移的空闲检查与恢复计数各自显式列出种类。
- `contract-known-gaps.txt` 没有条目，但其文件头仍指向已关闭的 #12867。

## 目标

- 把每条 Turn 输入与取消命令记为一个持久 operation，在准入该命令的事务里保存，带上命令的幂等键与请求摘要。
- 让该键的重放找回这个原 operation，绝不新建，并让同键不同载荷继续冲突。
- 每个 operation 都依据 Turn 自身已提交的事实结算，使现有 Turn 派发器仍是两种命令唯一的投递者。
- 两种 operation 经两个表面上现有的 operation 查询提供。

## 非目标

- 准入路由返回 operation、准入阶段与投递状态，以及 `durable_operations` 能力。那是 D7-3 的可选 profile；这些字段保持 `planned`。
- 跨种类推广 `recovery_blocked` 对账（D7-2）。
- 任务取消表面（H4f，#13746）。`TASK_CANCEL` 不变。
- 不由输入命令创建的 Turn：Session 的初始输入、channel 入站与自动化运行。它们的准入是 `create_session` 或各自的台账。
- 容量上限，它属于部署 profile 的选定。

## 决策

### 1. 两个种类，按契约的线上类型命名

`OperationKind` 在同一改动中给两个枚举都加上 `SUBMIT_INPUT` 与 `CANCEL`，使 `valueOf` 桥接不会抛异常。operation 视图把种类名转为小写，所以线上类型恰好是契约的 `submit_input` 与 `cancel`。与其他种类一样，种类在线上为小写、在存储中为大写，无需另设映射。

### 2. 每条命令一个 operation，与命令一同保存

`insertTurnCommand` 与 `insertCancelCommand` 在各自的事务里、紧随命令回执插入 operation。operation 为 `PENDING`、`JAVA_DURABLE`、`PENDING`，带命令的幂等键、键摘要、请求摘要与记录者，以及准入时的 Session 状态。它的目标是 Turn（`target_kind = 'TURN'`，`target_key` 为 Turn id 的键）。这两个方法的每个调用者都会得到它：公开与 WebShell 的输入和取消路由，以及子结果中继的内部停止（它以父 run 为其取消派生键）。

因此，输入或取消的 `202` 正是 #12867 所要求的含义：命令已保存，且 Java 负责投递它。Turn 行原本就如此。现在命令本身也持久且可寻址。

### 3. 回执指名 operation

命令回执把 operation 的键存进 `result_operation_key`，与动作决策回执和 channel 入站回执的既有做法相同。`replayCommand` 读取回执并返回它指名的 operation id，因此同键重试（包括存储内的重放探测与重复键分支）都会找回原 operation 且不插入任何行。不同摘要仍在回执上以 `409 idempotency_conflict` 失败，早于读取任何 operation。`StoreModels.Admission` 携带 operation id，供 D7-3 返回。准入响应暂不显示它。

幂等域仍是回执的：租户、命令名与键。同一个键字符串下的一次输入和一次取消是两条命令、两个 operation。

### 4. Turn 派发器仍是唯一投递者

新种类没有扫描、认领或 coordinator。输入与取消作用于一个 Turn，而 Turn 行上的派发租约是唯一可以作用于该 Turn 的租约：提交、Harness 挂接与事件流、恢复接管与取消都在它之下运行。为同一 Turn 再设一个驱动者就会与该租约竞争。因此对这两个种类，operation 的租约、认领代次与尝试列保持不用，其投递状态在结果持久之前读作 `pending`。

这就是通用取消扩展 `TASK_CANCEL` 而不分叉它的方式。它沿用任务取消的结果契约：依据权威方已提交的证据结算，绝不依据线上应答；完成的 operation 为 confirmed 并带回执；失败的 operation 保持 `java_durable` 与 `blocked` 并写明原因。它不沿用其 coordinator。那个 coordinator 的发送（父 Session 的子操作路由）与证据（任务记录）属于任务，而 Turn 已经同时拥有投递者与证据。D7-2 随后在一条"证据优先"的规则上推广对账：面对两种证据来源，而非两条投递路径。

### 5. 结果来自 Turn 已提交的事实

私有方法 `settleTurnCommands` 运行于每个提交了结果所依赖的 Turn 事实的事务中：`recordAdmission` 与 `recordRecoveryAdmission`（Turn 获得 Harness event epoch）、`recordHarnessEvents` 中的终态 Harness 批次、`cancelBeforeAdmission`、`failTurn`，以及在已结束的 Turn 上准入的取消。它读取 Turn，只移动 `PENDING` 的 operation：

| Turn 事实                                  | `submit_input`                                                                  | `cancel`                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 持有 Harness event epoch                   | `completed`、`harness_confirmed`、`confirmed`、回执                             | 不变                                                                                   |
| `CANCELLED`                                | `cancelled`、`java_durable`、`blocked`（无 epoch），否则同上                    | `completed`、`confirmed`、回执；有 epoch 为 `harness_confirmed`，无则为 `java_durable` |
| `COMPLETED` 或 `FAILED`                    | `failed`、`java_durable`、`blocked`、Turn 的 `error_code`（无 epoch），否则同上 | `failed`、`java_durable`、`blocked`、`turn_already_settled`                            |
| 仍为 `ACCEPTED`、`RUNNING` 或 `CANCELLING` | 同上                                                                            | 不变（pending）                                                                        |

- **event epoch 就是准入事实。** 派发器在 Harness 应答提交时记录它，或在为一个已尝试过提交的 Turn 采纳某个 Harness 挂接时记录它。派发器此后的每个决定都读取它；例如 `cancelBeforeAdmission` 拒绝已带 epoch 的 Turn。因此完成意味着某个 Harness 已准入该 Turn，而非 Turn 已结束，这正是契约的要求。准入后失败的 Turn 会让其输入保持 `completed`。
- **取消在 Turn 被取消时完成。** 没有任何持久事实记录 Harness 对取消调用本身的应答，所以 operation 等待 Turn 自身的结果。在任何 Harness 准入该 Turn 之前就被准入的取消以 `java_durable` 完成，因为停止它的权威方是 Java。以其他方式结束的 Turn 会让取消以 `turn_already_settled` 失败，对应 `task_already_settled`。
- **同一 Turn 的多次取消会合并。** 对 `CANCELLING` 的 Turn 的第二次取消没有命令效果，保持 pending。Turn 结束时两者以相同方式结算，各带自己的回执。对已结束 Turn 的取消在其准入事务里即结算。
- **失败与已取消的 operation 从不带回执**，并保持 `blocked`，因此不会再被投递。这两个种类从不写 `recovery_blocked`。Turn 自身的预算会让它结束，operation 随之结算。

### 6. 两个种类都不是 Session 屏障

`SESSION_OPERATION_KINDS` 与每份显式种类清单都不变，所以待处理的输入或取消绝不会回 `session_operation_active`，不会阻塞 cwd 变更、迁移或恢复，也不会被生命周期或任务取消的扫描投递。Turn 行仍是屏障（`turn_active`），与之前完全一致。新的 operation 以 Turn 而非 Session 为目标，因此任何以 Session 为目标的查询都不会意外匹配到它们。

### 7. operation 查询读取它们

当以 Session 为目标的查找未命中时，`findOperation` 回退到按 Session scope 与 operation id 查找 Turn 命令种类。`getSessionCwdOperation` 与 `webShellQueryCwdOperation` 以 `PublicCommandOperation` 与 `WebShellCommandOperation` 提供它们，读授权与墓碑行为不变。该回退扫描标识索引 `(scope_key, operation_kind, target_key, operation_id)` 中该 Session 自己的条目，且不在准入路径上。

### 8. 结算使用当前读

每个结算调用者都先锁 Session 行，但其 REPEATABLE READ 快照可能早于该锁。例如 `requireLegacyMutation` 在 `recordHarnessEvents` 加锁之前就做了读取。普通读于是可能漏掉其间提交的取消，使其 operation 永远停在 pending。因此 `settleTurnCommands` 以 `FOR UPDATE` 读取 Turn，并以固定在该 Turn 的 `uq_ma_operation_identity` 前缀上的加锁读查找待处理的 operation（写在 MySQL 可执行注释里的 `FORCE INDEX`，H2 会跳过）。这些读只覆盖一个 Session scope 内一个 Turn 的条目。这个固定是必需的：交给优化器时，若某个 Turn 有很长的已结算历史、而表中待处理行很少，扫描会转向 `ix_ma_operation_claim`，其 `(operation_kind, state)` 范围包含所有 Session 的待处理行，两个 Session 的结算于是越过各自的 Session 锁形成死锁。没有调用者会在其后向 `ma_operation` 插入，所以它们无法形成 #13918 所消除的那类插入-间隙环。回执插入及其后的 operation 插入，仍遵循两个准入既有的 Session 与租户 guard 加锁顺序。

### 9. Schema V8 与契约 1.58

- `V8__turn_command_operations.sql` 删除并重建 `ck_ma_operation_kind`。它保留 V7 约束的每个种类（包括 `WORKSPACE_CREATE`），并加入 `SUBMIT_INPUT` 与 `CANCEL`。这类迁移每次都重建整条 CHECK，所以必须以迁移链末端的约束为起点，而不是 V1 基线。由 #14318 一般化的 `ManagedSchema.extend` 会在规范 DDL 中就地替换重建的 CHECK。服务端由 Flyway 应用 V8，Broker 由 `ManagedSchema.initialize` 应用。V7 目录会被识别为版本 7 并升级。
- 契约升至 `1.58.0`。operation 路由的描述列出它所服务的每个种类，两处 `failure_code` 描述写明新的失败，两个命令 operation schema 写明输入与取消"完成"的含义，版本说明写明 D7-1 改变什么、不改变什么。生成的 WebShell 类型只在 WebShell operation 的 `failure_code` 与 schema 描述上变化。
- `contract-known-gaps.txt` 仍无条目，文件头改为指向 #14122。该文件为空意味着 D4 的出口已满足，而不是不再有契约缺口。

## 验证

- `ManagedTurnCommandOperationTest`（H2）覆盖：
  - 带身份的准入；
  - 经 `replayCommand` 与经存储内探测的重放，二者都返回原 operation；
  - 摘要冲突，且每条命令一个 operation；
  - 输入在准入时完成，且不受此后 Turn 失败影响；
  - 派发器采纳恢复准入时输入完成；
  - 输入以 Turn 的错误码失败；
  - 准入前取消（输入为 `cancelled`，取消为 `java_durable`）；
  - Harness 取消使两次合并的取消都完成，且回执各不相同；
  - 取消以 `turn_already_settled` 失败，包括 Turn 完成与派发器判 Turn 失败两种情况；
  - 对已结束 Turn 的取消在准入时结算；
  - 不产生任何屏障或扫描效果。
- `ManagedTurnCommandOperationMySqlIT` 在 InnoDB 上运行同样的用例。它为决策 8 增加三个见证，每个都固定为 REPEATABLE READ，使服务端默认值无法让它失效。第一个：两个 Session 各持有一个运行中 Turn 的待处理取消，再各自取消一个带 1000 条已结算取消的已结束 Turn；两次结算都成功。去掉索引固定会让它们死锁。第二个：一个终态事务固定了快照，其间提交了一次取消，结算仍以 `turn_already_settled` 失败该取消。第三个：一次取消固定了快照，其间 Turn 失败，该取消仍在准入时结算。把待处理 operation 的查找改成普通读会让第二个失败；把 Turn 的读取改成普通读会让第三个失败。
- 去掉任意一个结算挂钩、回执链接或读取回退，都会让上述至少一个用例失败。
- `HostedConcurrentTurnBurstMySqlIT`（#13333 的同租户突发）每轮都完成结算，没有准入或续租失败，锁等待采样与基线构建相同。
- `ManagedAgentApiContractTest` 经两个 operation 路由读取一个被 Harness 取消的 Turn 的 `submit_input` 与 `cancel` operation，并按契约校验。
- schema 测试改为版本 8。`ManagedSchemaTest` 在完整迁移链之后，经 Broker 初始化器与 Flyway 两条路径插入每个已发布的 operation 种类。`WorkspaceCreationSchemaMySqlIT` 升级一个已存有 `WORKSPACE_CREATE` operation 的 V7 目录，保留该行并接受全部三个种类。从 V8 删掉 `WORKSPACE_CREATE` 一支会让两者都失败。

## 验收

取自 #14168，对两个种类：

- 丢失的应答经原 operation 找回：回执指名它，operation 查询读取它（决策 3 与 7）。
- 同键重试返回原 operation（决策 3）。
- 同键不同载荷冲突（决策 3）。
- 重试保留身份：operation 保留命令的键与摘要，结算从不生成第二个 operation（决策 2 与 5）。

## 后续工作

- **D7-2：** 在多种证据来源（此处为 Turn 行，`TASK_CANCEL` 为任务记录）之上的统一对账规则，包括 Turn 命令 operation 是否需要 `recovery_blocked`。
- **D7-3：** 可选 profile，已在 [managed java_durable 准入](2026-10-17-managed-java-durable-admission.zh-CN.md) 中落地。请求该 profile 的 Turn 输入与取消准入会返回其 operation 及准入阶段与投递状态，Session 声明 `durable_operations`，`harness_confirmed` 仍为默认。`PublicTurn` 的 operation 字段保持 planned。
