# Runtime Broker JDBC 历史数据保留

[English](runtime-broker-jdbc-retention.md) | [简体中文](runtime-broker-jdbc-retention.zh-CN.md)

状态：已实现 [#13203](https://github.com/QwenLM/qwen-code/issues/13203)

## 问题与范围

Broker 的终态 binding、session 和 execution 无限累积。新 placement 还会加载并解密历史 binding，判断旧 writer 是否仍阻止接纳。清理必须限制单轮工作量，同时保留物理恢复、publication 和迁移证据。

本次删除已退役 binding 下符合条件的 JDBC 记录，不退役 worker、不删除物理存储、不回收 publication 元数据，也不清理活跃 binding 的历史子记录。Slot、generation 计数、placement guard、harness head 和 storage fence 持续保留。两种嵌入方式共同使用 #14069 引入的唯一 canonical 32 表 baseline；清理不创建第二套 schema。

## 资格与引用

使用数据库时间。Binding 必须超过配置保留期且没有有效 operation 租约。RELEASED 可以清理；managed binding 还须具备有效 drain receipt 或 loss 与 stopped-writer 两份证据。FAILED 仅限非托管 legacy/static placement，且 provision seed 三个字段全部缺席。其他状态及不完整证据持续保留。

任何非终态子记录都保护整个 binding。SETTLED、ABANDONED execution 按对应完成时间判断超龄，且不得有有效 dispatch 租约。RELEASED、FAILED session 按 last_active_at 判断超龄，且不得有剩余 execution。所有子记录清空后才删除 binding。

Operator recovery、Workspace holder 和 CSI retirement 保护整个 binding，包括已完成 recovery。Publication 和 CSI worker ACK 保护对应 execution，并通过它保留 session 和 binding；无引用的兄弟记录可以删除。COLLECTED publication 仍保留原证据。Publication 与 ACK 使用原始 UTF-8 的 SHA-256，Broker execution hash 则带长度前缀；从有界候选 ID 计算引用键，禁止直接关联不同算法的哈希。

子 Session 的 lineage 在父 child_run 的 canonical projection 缺失或 settled_at 为空时保护 binding。即使子会话已停止、没有 tool execution 或 Workspace holder，cascade 与 relay 的修复仍可能需要原 binding 身份。在 sweep 同连接上按主键读取 lineage 和父 projection，并精确校验原始身份。Lineage 在子会话 warm 前提交，终态 run 不可重新打开；已提交的 settled_at 结束此项保护。Session lineage、父记录和永久 relay ledger 均保留。

存在 `<call>:process` execution 的 binding，在该 execution 所属 Session 仍有未结算的后台 Shell child_run projection 时也必须保留，覆盖顶层 Session 以及 Session、Workspace 两种隔离方式。Session-open reconciliation 将该行缺失作为未启动证明，因此须在所属 Session 的后台 Shell 记录结算前保留整个家族。Guard 先用 Session 原始值及其二进制身份共同去重，再在 sweep 同连接上执行有索引的存在性查询，并精确复核 tenant、Workspace、Session 和 generation。这是保守的 Session 级保护，并不逐条匹配 Shell 与 execution。

## 组件与并发

JdbcRuntimeRetention 提供不依赖框架的 JDBC sweep，嵌入方提供同连接引用检查器。返回续扫游标以及扫描、跳过和各表删除计数。两层 keyset 游标跟踪 binding 和子表阶段；已检查的受保护行也推进游标。Binding 游标比较使用带六位小数的 UTC 字面值，避免 Connector/J 因 MariaDB 兼容握手截断时间参数而停滞。完整扫描后回绕，重启可安全重扫。

批量值为 B 时，每轮最多选取 B 个 binding 候选、B 个待删子行候选，三表合计最多删除 B 行。引用查询可能读取额外的索引行；批量计数不限制数据库实际读取行数。大家族跨轮处理。每个事务依次锁 tenant placement domain、slot、binding 和子记录；使用当前已提交状态复查资格与引用，然后依次删除 execution、session、binding。不执行无界级联删除。数据库错误回滚并向上抛出。Local publication 修改在原有事务中依次锁 tenant placement guard、原 JDBC binding 和 execution，再锁 publication，防止引用创建与删除竞争，并保持 session 生命周期的锁顺序。CSI 保持现有锁顺序。

Managed-server 使用独立单线程 scheduler，只有 Broker 和 retention 同时开启才创建。qwen.managed-agent.runtime-broker.retention 配置为 enabled=false、max-age=30d、batch-size=100（1–1000）、scan-delay=1m。保留期和间隔必须至少为 1ms。不带单位的 max-age 按天解析；显式单位（包括至少为 1ms 且小于一天的保留期）保持原义。成功轮次记录计数；失败轮次记录错误并在下个周期重试。失败只回滚当前 binding 事务，同轮此前的提交继续保留，暂不提供这些部分提交的计数报告。恢复调度保持独立。已有 HTTP 和业务 repository 接口保持不变。

三类清理家族分别使用 `ma_runtime_binding`、`ma_runtime_session` 和 `ma_tool_execution`。唯一现役 `V1__managed_schema.sql` 提供 binding 状态/时间/ID、tenant/状态索引、`ma_output_capture.execution_key` 索引及 `ma_operation_work` 的 `(work_kind, target_key, operation_key)` 索引，复用 `ma_storage_owner` 的 binding/generation 索引及 `ma_operation` 的有类型 target 索引。Operator recovery 和 CSI retirement 必须具备对应 operation kind 及 `RUNTIME_BINDING` target；CSI ACK 保护要求 `CSI_WORKER_ACK` work 及 `CSI_RETIREMENT` 父 operation 同时匹配。父与 Shell projection 必须是 `ma_session_record` 中的 `DOMAIN` 记录，其他共享表变体不能误保护或授权清理。退役 V69 SQL 与旧库升级 witness 保留在 `docs/archive/managed-agent-schema/`，不在现役 classpath 中；它们是历史证据，不是部署前置条件。Placement 使用 SELECT 1、LIMIT 1 和状态/身份标量条件，保持有效记录的 blocksPlacement 语义、身份精确比较，并把不完整 seed/lease 字段保守视为存在。不解密历史凭据，且不依赖 retention 开关。

## 保留契约与上线

开启清理后，符合清理资格且无引用的历史记录在超过 max-age 后可以删除；这不保证记录在该年龄时被删除。Publication 和 CSI worker ACK 引用持续保留 execution 及其父 session 和 binding，不受年龄限制，包括 COLLECTED publication。无引用的兄弟记录可以删除。删除后沿用缺失记录行为；调用方不得复用过期 runtime-session ID 或 idempotency key。本次不增加永久 execution 墓碑。

使用 canonical 32 表 V1 baseline 初始化新库，并保持清理关闭。验证 Managed Server/Broker 的精确 catalog 一致性，以及重复初始化保持已有终态 receipt 不变。旧库、残缺库或外部 catalog 在初始化写入前被拒绝；本次不迁移旧数据、不支持原地升级。旧环境保留历史读取，切换前停止新准入并结算在途工作，新 Session 只在新环境创建。新库产生数据后的回滚必须保留并从新库提供这些记录。除全部实例使用新的 publication 锁协议外，还须先在 [#13992](https://github.com/QwenLM/qwen-code/issues/13992) 交付并验证精确身份的 Hosted cleanup 释放证明，期间保持清理关闭。Owed cleanup descriptor 可以比 RELEASED binding 保留更久；清理该 binding 后，原释放请求会变成冲突并阻塞 Hosted Session。本 PR 不实现这项释放证明契约。观察扫描、删除、跳过数、耗时和失败次数。回退到旧 writer 前先关闭清理。关闭只停止后续删除，不能恢复已删除数据。

## 验证与验收

覆盖年龄边界、数据库时钟、生命周期状态、物理证据、有效租约、非终态子记录、generation 连续性和过期查询。覆盖全部外部引用、已完成 recovery、COLLECTED publication 和不同哈希算法。验证大家族与受保护行的有界推进，包括亚秒时间戳、同时间戳的 ID 排序和单行批次，并覆盖并发清理、回滚及引用创建竞争。对照内存实现的 placement 决策，并断言历史记录零解密。检查 canonical schema/Flyway 一致性、精确 32 表 catalog、旧库拒绝且不写入、重复初始化的记录不变性、有类型共享表变体、调度隔离和配置开关。事务锁与 collation 必须在 MySQL/MariaDB 上验证，不能只依赖 H2。

复现子会话已停止但父记录仍欠 dispatch/attach journal 修复的场景：清理须保留原 binding，使修复能够完成。验证 projection 缺失时保守保留、原始身份不匹配不能结束保护、guard 能读取 sweep 事务自己的写入，以及 canonical 终态 projection 允许清理而不回收 lineage 或 relay 分类。

验证顶层 Session 的未结算后台 Shell 在两种隔离模式下均保留原 process-status 证据，而已结算 projection 允许清理；检查原始身份与 generation 不匹配，以及替代 generation 的接纳。加入数千条已结算 Shell、其他 Session 噪声及宽松 collation 下的拥有者，验证 guard 能完成查询且实际 sweep 能推进到后续家族。

旧 schema 的验证继续作为历史证据。32 表适配须重跑同一集成 witness、定向回归测试，以及原生 MySQL/MariaDB 清理、引用竞争与 catalog 契约后才验收。查询计划不代表延迟保证；这些检查不构成生产切换、物理 worker 恢复或独立 cleanup 释放证明契约的验收。

实施产物包括 Broker sweep 和 placement guard、managed-server 引用检查器、调度与配置、唯一 canonical baseline、repository 测试和 README 更新。精确 cleanup 释放证明契约由 #13992 单独交付，完成前保持清理关闭。
