# Managed Agent 操作分发与保留

[English](2026-11-28-managed-operation-dispatch-retention.md) | [简体中文](2026-11-28-managed-operation-dispatch-retention.zh-CN.md)

本方案基于 2026-11-28 的 `main` `cc652838c4`。

## 目标与现状

把每个控制面副本的高频任务发现迁到 MQ 唤醒和少量专用恢复 worker。精简已结算的 `ma_operation` 行，保留操作 ID、授权、重放行为和下游读者依赖的证据。首期选择只用 SQL 的会话资源回收。全量会话数据清除、外部发布对象回收和备份到期各有完成条件。

当前控制面在生命周期操作受理后会在本机触发执行，同时定时扫描到期任务和过期租约。会话退役标记与 `SESSION_RESOURCE_GC` 在同一事务内写入。回收器还会补建缺失的历史操作，并核对读租约、原 writer 和恢复活动。仓库已有可选的 RocketMQ 传输用于 Journal 和公开事件通知，采用尽力投递并靠 SQL 对账。任务唤醒使用独立 topic 和消费组，独立控制积压。

[现有生命周期调度](../../packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/session/SessionLifecycleCoordinator.java) · [现有资源回收](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/SessionResourceCollectionCollector.java) · [现有事件传输](2026-10-04-managed-agent-event-transport.zh-CN.md)

## 分发迁移顺序

1. **在纯 MySQL 部署试点 `SESSION_RESOURCE_GC`。** 复用操作 ID、租约、阻塞检查和有界回收。让专用 worker 可以独立于工具发布启用 SQL 回收。从 `SessionResourceCollectionCollector` 提取按操作引用领取的入口，让 MQ 和轮询共用领取及分页逻辑。投影回收、capture 回收和发布验证沿用各自的调度。首期仅迁移现有 SQL 回收的任务发现。
2. **再迁生命周期和其他已有专用执行器的任务发现。** 首期验证重试和接手后，逐个接入 `CLOSE`、`DELETE`、`CWD_CHANGE`。验证期间保留受理后的本机触发。再按各自领取和完成规则评估 `CONTEXT_COMPRESSION`、`ACTION_RESPONSE`、`TASK_CANCEL`。等原证据的 `RECOVERY_BLOCKED` 唤醒对账流程，继续等待原操作的结果。
3. **单独迁依赖其他记录或外部证据的任务。** `CHILD_SESSION_START` 要从 `child_run` 的持久化状态变更开始发现，保留 `CHILD_SESSION_CLOSE` 的关闭补偿。`TOOL_RESULT_PROJECTION`、`OUTPUT_VERIFY`、`CAPTURE_GC`、`WORKSPACE_CREATE`、`WORKSPACE_UPLOAD` 先逐项把前置条件、超时和原目标的结果确认映射到持久化唤醒条件。沿用现有执行方和重试策略。

`SUBMIT_INPUT` 和 `CANCEL` 继续由 Turn dispatcher 推进。未来若迁移任务发现，唤醒原 Turn，并从原 Journal 对账。`ARCHIVE`、`RENAME`、`UNARCHIVE` 继续走同步路径。`CHANNEL_INGRESS`、`PR_WATCH_INJECT` 继续由外部事件入口触发。`OBJECT_PUT` 以及人工启动的恢复和迁移继续由当前流程推进。在纯 MySQL 试点之外，未来全量 SQL 清除等 schema 支持后用独立的完成记录。Workspace 恢复继续读取原 `SESSION_RESOURCE_GC` 成功证据。

[Turn 命令归属](2026-10-16-managed-turn-command-operations.zh-CN.md) · [子会话任务发现](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ChildResultRelayQueries.java) · [恢复完成条件](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/WorkspaceRecoveryStore.java)

## MQ 唤醒与故障处理

首期保持现有 V1 schema，持久化操作行是任务来源。DELETE 成功提交后发送包含租户和会话的唤醒，消费者依此查找 GC 操作。轮询直接处理到期行、过期租约和缺失的历史回收记录。GC 用数据库时间核对 `available_at` 和宽限期。对照现有到期索引验证查询计划，并用有代表性的数据量测查询成本。

消费者核对原操作的作用域和类型，再执行现有的事务内领取。每次写入继续核对 owner、generation、lease 和游标或资源前置条件。ACK 前提交分页进度或阻塞状态。续页和重试由数据库轮询推进，worker 领取后崩溃时，原任务会在租约过期后重新可领。后续其他类型可在受理、重试或续跑提交后按操作引用唤醒。对于结果未知的副作用，继续沿用原协议核对原执行证据。

首期用轮询覆盖提交后发消息前崩溃、消息丢失和租约过期。如果以后要求每次唤醒和业务状态在同一事务可靠登记，在有受支持的 schema 升级后引入事务 outbox。发消息的状态和执行租约独立保存。事务外发消息，broker 确认后登记 outbox 已发送，并对账过期发送 claim。发送方确认后落库前崩溃仍可能产生重复投递。即使有 outbox，租约过期和任务到期也需要定时器或对账推进。

[到期和过期租约扫描](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/AgentLifecycleOperations.java) · [现有 GC 租约校验](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/SessionResourceCollectionCollector.java)

## 最小执行状态、回执和证据

- **在途或结果未知。** 保留 `operation_ref`、公开 `operation_id`、类型、租户与作用域、目标及版本、授权主体范围、幂等键和摘要。按类型保留原始请求及协议版本、`state`/`phase`、受理和投递状态、`available_at`、`claim_owner`、`claim_generation`、`claim_until`、重试和期限、游标及待核验证据引用。分目标进度仍用 `ma_operation_work`。接不接 MQ，结算和恢复都要读这些字段。
- **终态最小回执。** `ARCHIVE`、`CWD_CHANGE`、`CONTEXT_COMPRESSION`、`ACTION_RESPONSE`、`TASK_CANCEL`、`SUBMIT_INPUT`、`CANCEL`、`OUTPUT_UPLOAD`、`OUTPUT_VERIFY`、`OUTPUT_FINISH`、`CHANNEL_INGRESS`、`PR_WATCH_INJECT`、`WORKSPACE_CREATE`、`WORKSPACE_UPLOAD` 可裁剪为原操作身份、授权和去重范围、请求摘要、终态、回执与错误字段、时间以及调用方实际读取的结果。比如 CWD 目标和版本、审批决定回执、压缩结果和版本、接入 input ID、工具发布最终资源引用。输出校验的前序状态保留到后续消费者结算。保证 `ma_request_receipt.result_operation_ref` 仍可解析。会话删除后继续保留创建请求的防重放信息。当前读取方同时验证原幂等键文本和摘要。
- **终态业务证据。** `CLOSE`、`DELETE`、`SESSION_RESOURCE_GC`、`CHILD_SESSION_START`、`CHILD_SESSION_CLOSE`、`CHILD_WORKSPACE`、`SESSION_WORKTREE`、`TOOL_RESULT_PROJECTION`、`WORKSPACE_OPERATOR_RECOVERY`、`WORKSPACE_RECOVERY`、`STORAGE_MIGRATION` 按真实读者的生命周期保留。Workspace 恢复需要 `DELETE` 和固定 `session-resources-<sessionId>` 的证据，后续生命周期准入需要 close 回执，子会话关闭标记用于防重，产物读取需要 READY 结果及来源。要移除完成迁移的记录，先把 `history_identity_json` 移到存储权威记录并切换读者。要移除人工恢复记录，先迁移按 binding 和 generation 查询的 Runtime 保留检查。子会话和 worktree 的关联查询也采用同样的顺序。
- **业务依赖结束后转审计。** `CAPTURE_GC` 等 capture 和资源都持久化为 `COLLECTED`、删除意图引用已处理，且无在途领取后再评估。`OBJECT_PUT` 等发布已回收，原写入的对账和重放结束后再评估。审计事件保存标识、授权用户或服务作用域、时间、结果和计数。清理历史 `WORKSPACE_RETIREMENT` 行前核对 Runtime 保留检查。新 rename、unarchive 继续保存既有命令回执，可额外写结构化审计事件。

先在现有列中按类型做终态投影，在需要时用可区分的回执版本。保留现有 NOT NULL 约束和返回形状。凡是旧 mapper 还要解析的载荷，先增加只读必要字段的终态读路径。比如 `CONTEXT_COMPRESSION` 当前从请求取 `expectedCompactionRevision`，`ACTION_RESPONSE` 构建响应时会解析原请求，`WORKSPACE_UPLOAD` 也会反序列化冻结目标。后续裁剪从满足条件的行开始，新建表和物理删列留待 schema 升级。

[表结构与索引](../../packages/managed-agent-server/persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql) · [回执身份校验](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedReceipts.java) · [产物读路径](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/JdbcManagedToolResultStore.java) · [完成迁移的身份校验](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/LocalStorageOwners.java) · [人工恢复的保留检查](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/runtimebroker/persistence/JdbcRuntimeRetention.java)

## 现有读路径、历史数据与回滚

1. **盘点并先部署兼容读端。** 统计各类型及状态的行数、最老到期任务等待时间，以及 API、worker、Broker 和运维工具的查询。用旧载荷和精简回执对照验证查询和同键重放。保留原操作 ID 和行引用。遇到未知载荷或状态组合，跳过裁剪并记录 ID 或计数。
2. **在同一个数据库双触发。** 部署 MQ 消费者，保留原扫描验证试点类型，两个入口用同一套领取机制。故障测试通过后，切换该类型由 MQ 主唤醒，补偿扫描收敛到专用 worker。其他类型继续原轮询。分发回滚先恢复原扫描，再停止 MQ 消费，未完成消息仍可由同一领取协议结算或重投。
3. **分开补扫任务和裁剪回执。** 在兼容的现有 V1 库中按主键分页，每轮固定上界，在锁内重查到期或终态条件，每页提交进度。按原 ID 重新唤醒未完成的到期任务和过期 claim，复用已有的缺失 GC 行修复。已完成的 `SESSION_RESOURCE_GC` 保持终态，未来全量 SQL 清除用独立身份和完成证据。终态裁剪从新 `ARCHIVE` 回执开始，再按已核对读路径的类型补扫终态行。结果未知的行继续保留。有业务消费的行，先迁移或等待引用到期再裁剪。
4. **分发回滚和回执格式回滚分开。** 所有读取目标类型的进程都升级兼容读端后，再考虑不可逆裁剪，并等兼容回滚窗口结束。分发可以用兼容版本切回轮询。历史回执继续按现有规则保留，直到逐类型的到期策略发布并经验证。生命周期设计里的重试窗口至少是 24 小时。恢复和授权证据按各自依赖确定保留时间。

仓库目前校验单一共享的 V1 baseline，预发布旧库没有维护原地升级路径。首期保持 schema 兼容，已有 V1 历史数据可以留在原库。后续如果需要 outbox 表、新操作类型或证据列，需要单独确定 schema 和部署方案。新开发库遵循现行 baseline 规则。已部署且没有受支持升级路径的库可继续使用 schema 兼容方案并保留历史库。改变库结构前，先具备明确的数据迁移或经过验证的受支持升级路径。

[共享 schema 与升级约定](../../packages/managed-agent-server/README.md) · [生命周期重试契约](2026-09-28-managed-agent-durable-lifecycle.zh-CN.md#47-读取-operation)

## 验收与放量条件

- 用真实 MySQL 8.4 和两个可领取的消费者，在相同数据和条件下对照轮询与 MQ。覆盖重复、迟到、丢失和乱序唤醒，发送不可用、受理后崩溃、领取后崩溃、提交一页后崩溃。验证每一页只有有效 claim 能提交，进度可续跑，已到期任务不会遗漏。覆盖宽限期前唤醒、恢复阻塞和活跃读者。首期验证工具发布关闭时 SQL 回收仍可执行。
- 为每种被裁剪的类型准备兼容数据。对照旧行和精简行的操作查询及同键响应，包括换主体和修改请求摘要。验证回执中的操作引用、输出前序、Worktree 和产物关联、CLOSE 证据以及 Workspace 恢复。验证切回轮询的兼容版本能在原数据库启动并接续原 lease 和游标。
- 观测各实例的操作扫描次数及扫描行数、按类型的最老到期等待时间、MQ 延迟和重投、租约冲突与接手、恢复积压和裁剪差异。只有试点证明减少 API 副本的扫描，并在约定时延内通过故障恢复，才扩大适用类型。启用载荷裁剪或将某类任务正常路径切到 MQ 前，明确各类型回执保留期限和专用 worker 容量。

目标环境的 broker 部署和延迟能力、各类型时延及回执保留目标、历史数据库存量还需要核对。目标环境仍需完成容量和故障注入验收。

## 首期实现范围

开启 `qwen.managed-agent.session-resource-gc.enabled` 即可运行纯 MySQL 资源回收。配置 RocketMQ proxy 地址、专用 DELAY topic 和普通消费组后启用 MQ 投递。DELETE 成功提交后尽力发出唤醒，消息携带租户和会话，worker 据此派生现有 `SESSION_RESOURCE_GC` 操作引用。宽限期、阻塞条件、租约和游标仍由 MySQL 校验。

每条唤醒最多推进一页，和 SQL 轮询共用领取与分页事务。秒级轮询负责续页、延期任务、历史补账，以及漏投或租约过期后的恢复。API 副本可设 `worker-enabled=false`，仍可发唤醒。至少保留一个 worker。将三项 MQ 配置都清空即可回到仅轮询模式。带外部资源、capture 或 journal pack 的会话会被暂缓。实现沿用 V1 schema 和现有工具发布调度。

SDK Java 的多节点任务复用 MySQL 和 RocketMQ 环境运行 `rocketMqWakeupsAndPolling`。它在现有 LiteTopic 测试资源之外创建专用 DELAY topic 和普通消费组。Maven profile 要求提供 GC 连接参数，Failsafe 报告必须记录该指定用例通过。缺失、跳过或失败均会使任务失败。

[配置参考](../users/managed-agent-configuration-reference.zh-CN.md#qwenmanaged-agentsession-resource-gc)
