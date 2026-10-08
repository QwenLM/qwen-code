# Runtime Broker JDBC 历史数据保留

[English](runtime-broker-jdbc-retention.md) | [简体中文](runtime-broker-jdbc-retention.zh-CN.md)

状态：已实现 [#13203](https://github.com/QwenLM/qwen-code/issues/13203)

## 问题与范围

Broker 的终态 binding、session 和 execution 无限累积。新 placement 还会加载并解密历史 binding，判断旧 writer 是否仍阻止接纳。清理必须限制单轮工作量，同时保留物理恢复、publication 和迁移证据。

本次删除已退役 binding 下符合条件的 JDBC 记录，不退役 worker、不删除物理存储、不回收 publication 元数据，也不清理活跃 binding 的历史子记录。Slot、generation 计数、placement guard、harness drain 和 storage fence 持续保留。

## 资格与引用

使用数据库时间。Binding 必须超过配置保留期且没有有效 operation 租约。RELEASED 可以清理；managed binding 还须具备有效 drain receipt 或 loss 与 stopped-writer 两份证据。FAILED 仅限非托管 legacy/static placement，且 provision seed 三个字段全部缺席。其他状态及不完整证据持续保留。

任何非终态子记录都保护整个 binding。SETTLED、ABANDONED execution 按对应完成时间判断超龄，且不得有有效 dispatch 租约。RELEASED、FAILED session 按 last_active_at 判断超龄，且不得有剩余 execution。所有子记录清空后才删除 binding。

Operator recovery、Workspace holder 和 CSI retirement 保护整个 binding，包括已完成 recovery。Publication 和 CSI worker ACK 保护对应 execution，并通过它保留 session 和 binding；无引用的兄弟记录可以删除。COLLECTED publication 仍保留原证据。Publication 与 ACK 使用原始 UTF-8 的 SHA-256，Broker execution hash 则带长度前缀；从有界候选 ID 计算引用键，禁止直接关联不同算法的哈希。

## 组件与并发

JdbcRuntimeRetention 提供不依赖框架的 JDBC sweep，嵌入方提供同连接引用检查器。返回续扫游标以及扫描、跳过和各表删除计数。两层 keyset 游标跟踪 binding 和子表阶段；已检查的受保护行也推进游标。Binding 游标比较使用带六位小数的 UTC 字面值，避免 Connector/J 因 MariaDB 兼容握手截断时间参数而停滞。完整扫描后回绕，重启可安全重扫。

批量值为 B 时，每轮最多检查 B 个 binding、B 个子行，三表合计最多删除 B 行。大家族跨轮处理。每个事务依次锁 tenant placement domain、slot、binding 和子记录；使用当前已提交状态复查资格与引用，然后依次删除 execution、session、binding。不执行无界级联删除。数据库错误回滚并向上抛出。Local publication 修改在原有事务中依次锁 tenant placement guard、原 JDBC binding 和 execution，再锁 publication，防止引用创建与删除竞争，并保持 session 生命周期的锁顺序。CSI 保持现有锁顺序。

Managed-server 使用独立单线程 scheduler，只有 Broker 和 retention 同时开启才创建。qwen.managed-agent.runtime-broker.retention 配置为 enabled=false、max-age=30d、batch-size=100（1–1000）、scan-delay=1m。保留期和间隔必须为正数。成功轮次记录计数；失败轮次记录错误并在下个周期重试。失败只回滚当前 binding 事务，同轮此前的提交继续保留，暂不提供这些部分提交的计数报告。恢复调度保持独立。已有 HTTP 和业务 repository 接口保持不变。

在独立 schema initializer 和新 Flyway migration 中同步增加 binding 状态/时间/ID、tenant/状态及嵌入方引用键索引，不修改历史 migration。Placement 使用 SELECT 1、LIMIT 1 和状态/身份标量条件，保持有效记录的 blocksPlacement 语义、身份精确比较，并把不完整 seed/lease 字段保守视为存在。不解密历史凭据，且不依赖 retention 开关。

## 保留契约与上线

开启清理后，历史 receipt 与幂等保证具有有限保留期。删除后沿用缺失记录行为；调用方不得复用过期 runtime-session ID 或 idempotency key。本次不增加永久 execution 墓碑。

保持清理关闭，先部署 migration 和代码。全部实例使用新的 publication 锁协议后才开启。观察扫描、删除、跳过数、耗时和失败次数。回退到旧 writer 前先关闭清理。关闭只停止后续删除，不能恢复已删除数据。

## 验证与验收

覆盖年龄边界、数据库时钟、生命周期状态、物理证据、有效租约、非终态子记录、generation 连续性和过期查询。覆盖全部外部引用、已完成 recovery、COLLECTED publication 和不同哈希算法。验证大家族与受保护行的有界推进，包括亚秒时间戳、同时间戳的 ID 排序和单行批次，并覆盖并发清理、回滚及引用创建竞争。对照内存实现的 placement 决策，并断言历史记录零解密。检查 schema/Flyway 一致性、旧库升级、调度隔离和配置开关。事务锁与 collation 必须在 MySQL/MariaDB 上验证，不能只依赖 H2。

集中 H2 和 MySQL 8.4.11 验证已通过，包括有界清理、回滚、精确 placement 比较、publication 行锁，以及过期 Broker 历史查询不会触发 provisioning 或 dispatch。查询计划检查确认 MySQL 可以使用候选、tenant/状态和引用索引。本地尚未验证 MariaDB；查询计划检查不代表延迟基准测试。

实施产物包括 Broker sweep 和 placement guard、managed-server 引用检查器、调度与配置、增量 migration、repository 测试和 README 更新。不存在未决产品选择。
