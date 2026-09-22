# Managed Runtime Broker JDBC 持久化

[English](managed-runtime-broker-jdbc.md) | [简体中文](managed-runtime-broker-jdbc.zh-CN.md)

状态：Repository 边界已实现并验证

## 问题

Runtime Broker 状态基础已经为 Runtime 绑定和逻辑 Runtime Session 定义了
乐观并发 Repository 契约，但目前只有进程内实现。Java 进程重启后会丢失
调度代次、Session 绑定、操作所有权，以及判断请求能否重试所需的证据；多个
Java 实例也无法通过这些实现进行协调。

Managed 工具执行还需要另一条持久边界。调用方必须能在响应丢失后查询原始
`executionCallId`，并且不能为同一个幂等键创建第二次物理执行。

## 当前状态

本次变更前，完整 Managed Agent 分支已经提供不可变的 Runtime scope、binding、
lease、Session、Tool execution 记录和 compare-and-set Repository 接口，但不
包含 MySQL 持久化。分支中的 Hosted Harness、Java Managed Agent 服务和 Runtime
Broker 仍选择内存实现；本次只增加持久化实现，尚不改变生产接线。

## 目标

- 为 Runtime binding 和 Runtime Session 增加持久化 JDBC 实现。
- 为已有 Tool execution ledger 增加持久化 JDBC 实现。
- 在多个 JVM 之间保持现有的原子创建、代次、compare-and-set、所有权租约、
  租户隔离和终态语义。
- 为四张私有状态表（包括稳定的 binding 分配 slot）提供显式、可重复执行的
  schema 初始化器。
- 使用两个独立 Repository 实例，在内存 JDBC 数据库和真实 MySQL 上验证行为。

## 非目标

- 迁移旧数据；这些表没有生产前身，全部是新表。
- 改变现有 Runtime 进程生命周期或健康检查。
- 在本次变更中把 JDBC Repository 接入 Spring Managed Agent 服务，或改变
  Hosted Harness、Runtime transport、Public Agent API。
- 跨节点 SSE 通知、Item/Snapshot 物化或 Outbox。
- 跨 Session 共享同一个 Runtime。

## 设计

### 依赖边界

模块只接收标准 `javax.sql.DataSource`，不依赖 Spring、连接池、Flyway 或具体
JDBC 驱动。嵌入服务负责 DataSource 和 schema 生命周期。测试使用 MySQL 模式
的 H2 以及 MySQL Connector/J。

私有 Tool execution ledger 中的 JSON 字段使用 Fastjson2；它们是 Broker
内部不透明载荷，不是公开 Agent Event 或 Item 资源。读取时关闭引用检测，确保
`$ref` 和 `@type` 保持普通数据；有限十进制数不使用指数形式写出，避免持久化
过程通过浮点转换造成收窄或溢出。

### 数据表

| 表                          | 身份                                                               | 并发约束                                                                                                    |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `qwen_runtime_binding_slot` | 不可变请求摘要                                                     | 每个请求一条加锁分配记录；非空 Session isolation key 全局唯一；保存当前活跃 binding 和最后分配的 generation |
| `qwen_runtime_binding`      | `binding_id`；不可变请求摘要与 generation                          | generation 唯一且单调递增；version 和 operation generation fencing                                          |
| `qwen_runtime_session`      | 全局唯一的公共 `runtime_session_id`                                | 原子创建；version compare-and-set；scope、binding generation 与 Session 身份不可变                          |
| `qwen_tool_execution`       | 哈希加完整 `execution_call_id`；唯一的哈希加完整 `idempotency_key` | 原子幂等创建；version compare-and-set；dispatch owner、过期时间和 generation fencing                        |

请求摘要和 scope 摘要使用对不可变字段做长度前缀编码后的 SHA-256。原始字段
仍完整保存在记录中，并在读取后重建和比对；即使出现摘要冲突，也会失败关闭，
不会合并两个身份。

分配或进入终态前会锁定稳定的 `qwen_runtime_binding_slot` 行。该行保存最后分配
的 generation 和当前活跃 binding 标识。历史终态 binding 继续保存在
`qwen_runtime_binding` 中；slot 行锁无需依赖未加锁的聚合查询，就能阻止同时
产生两个活跃 generation。

### 事务语义

- Runtime binding 的 `findOrCreate` 会在需要时插入稳定 slot，用
  `SELECT ... FOR UPDATE` 加锁；存在活跃 binding 时直接返回，否则在同一事务中
  递增持久化 generation 并分配新 binding。
- Runtime Session 与 Tool execution 的 `findOrCreate` 使用数据库唯一约束；
  唯一键竞争通过重新读取并核验胜出的记录来收敛。
- 可变操作使用 `SELECT ... FOR UPDATE` 锁定记录，在同一事务中校验当前 version
  和不可变身份，然后推进 version。
- operation 和 dispatch claim 读取数据库时钟并持久化 UTC 微秒时间；过期
  claim 只有在递增 fencing generation 后才能被接管，JVM 时钟偏差不会选出
  owner。
- 终态 Runtime binding 和 Session 不能重新激活；已结算 Tool execution 不能
  再次派发。
- SQL 失败会回滚并显式上报；适配器不会静默退回进程内存。

### Tool execution 身份

Tool execution 记录把稳定幂等键绑定到 Runtime binding generation、Harness
Session、Runtime Session、Turn、Tool call、请求摘要和不可变调用引用。重复的
幂等键返回原记录，由调用方比对请求并拒绝内容变化。派发响应丢失或结果不明确
时，仍可通过原 `executionCallId` 查询。execution 与 idempotency 标识都使用
SHA-256 key，确保在任意数据库排序规则下获得有界且大小写敏感的索引；每次查询
都会核验完整标识，哈希冲突时失败关闭。

### Schema 生命周期

`JdbcRuntimeBrokerSchema.initialize(DataSource)` 只创建四张新表和相关索引，
可安全重复执行；它不会修改已有表，也不会导入进程内状态。生产环境也可以通过
既有 schema 管理系统执行同一份随包 SQL，而不调用初始化器。

## 安全与租户

tenant、workspace、workspace generation、规范化工作目录、capability digest
和 isolation class 仍属于持久化 scope。公共 Session UUID 全局唯一，并作为
Runtime Session 主键；任何试图把它复用于其他 Harness 或 scope 的操作都会被
拒绝。Session 隔离的 binding 使用同一个 UUID 作为唯一 isolation key；
workspace 隔离的 binding 保持该 key 为空。JDBC 适配器不鉴权这些字段；Java
管控面必须从可信准入上下文生成它们。

Tool execution 方法有意不再单独接收 tenant 或 workspace 参数。嵌入服务必须从
已认证的 tenant、workspace 和 Session 上下文生成全局唯一的 execution 与
idempotency 标识；仅凭不可信标识绝不能完成授权。

Runtime endpoint token 是私有管控面凭证。为了重启恢复，schema 需要保存原始
lease，但嵌入服务必须使用加密存储或数据库级加密，且不能通过公共 API 或日志
暴露这些记录。

## 恢复边界

Broker 状态持久化并不等于 Java 重启后就能接管本地 Runtime 进程。持久化的
`READY` binding 可能指向已被上一 Java 实例停止的进程；生产集成必须先对该
lease 做健康检查与 reconcile。完整的本地进程恢复还需要 durable provision
seed、进程接管或重新拉起，以及 dead binding 的 Session 重绑策略。在这些内容
完成前，本实现只证明共享状态、fencing 和 execution 幂等。

## 验证

- 运行原有 Runtime Broker 生命周期测试及强化后的内存 Repository 测试。
- 使用共享同一个 H2 MySQL 模式数据库的两个 Repository 对象运行 JDBC 契约
  测试。
- 在真实 MySQL 上重复验证持久创建、CAS、租约接管、租户隔离、Session 计数、
  execution 幂等和重启后读取。
- 在 JDK 21 上使用模块现有的 Java 11 release target 运行 Maven 测试、
  Checkstyle 和 package verification。

## 验收标准

- 两个等价于不同 JVM 的 Repository 实例对同一 key 只产生一条活跃 binding
  和一次 Tool execution。
- 新建的 Repository 实例可以读取并修改上一个实例创建的记录。
- 过期 version、operation generation 和 dispatch generation 不能修改当前状态。
- tenant 与 workspace 身份不能被标识符冲突替换。
- 终态 binding 或 Session 不能重新激活，已结算 execution 不能重新派发。
- schema 初始化可重复执行，且不修改无关表。
- 默认测试和真实 MySQL 集成 profile 均通过，模块不增加 Spring 依赖。

已于 2026-09-20 使用 JDK 21.0.8 和 Java 11 release target 验证：内存测试与
H2 JDBC 契约测试通过；同一套 JDBC 契约通过 `mysql-integration` profile 在
本机临时 MySQL 数据库上通过；Checkstyle 为 0 个问题。契约测试使用两个独立
构造的 Repository 对象，并执行 32 路并发 binding 与 execution 创建。

## 后续集成

本次变更完成后，Managed Agent 服务可以通过 Spring DataSource 将这些
Repository 注入 `RuntimeBrokerService`。下一个集成切片必须移除生产路径的
InMemory 接线，让两个 Java 进程共享一个 MySQL，在重启后 reconcile 失效
Runtime lease 并恢复原 execution，随后再加入延迟 Runtime 的 TTFT 场景。
后续集成必须依赖这套持久事实来源，不能再增加另一套状态存储。
该切片所需的调度器无关 endpoint、resource handle 和恢复契约，详见
[Managed Runtime Endpoint 持久化与恢复](2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md)。
