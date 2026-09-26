# Managed Runtime Broker JDBC 持久化

[English](managed-runtime-broker-jdbc.md) | [简体中文](managed-runtime-broker-jdbc.zh-CN.md)

状态：已在 Repository 边界实现并验证

## 问题

Managed Runtime Broker 基础能力已经定义 Runtime Binding、Runtime Session 和 Tool Execution 状态，但 Tool Execution 实现仍在进程内。进程重启会丢失执行身份、dispatch 所有权、取消意图、`UNKNOWN` 恢复状态和最终结果。多个 Broker 进程也无法通过共享事实源协调 at-most-once dispatch 边界。

## 目标

- 通过 JDBC 持久化 Runtime Binding、Runtime Session 和 Tool Execution。
- 保持 Binding 原子创建、Binding generation fencing、CAS 更新、操作租约、Binding 与 Session 状态的租户和 Workspace 隔离，以及 Session 终态语义。
- 保持 Tool Execution 幂等创建、dispatch owner 与 generation fencing、数据库时钟租约、取消意图、`UNKNOWN` 对账和最终结果。
- 幂等初始化 Broker 私有 Schema。
- 使用同一套 Repository 契约同时验证 H2 和真实 MySQL。

## 非目标

- 启动、停止或以其他方式管理 Runtime 进程。
- 把 Repository 接入 Harness、Spring 装配、传输层或公共 API。
- 执行 Tool call 或自动解决 `UNKNOWN` 执行。
- 通过 SSE、Outbox、MQ 或 Redis 分发事件。
- 让无关 Workspace 共享同一个 Managed Runtime。

## 依赖边界

JDBC Repository 使用 `javax.sql.DataSource` 访问数据库，并使用 fastjson2（2.0.65）作为 `reference_json`/`result_json` 列的 JSON 编解码。不透明 Tool 载荷会关闭 fastjson2 引用检测，使 `$ref` 与 `@type` 成员保持普通数据；有限 `BigDecimal` 不使用指数形式写出，避免读取时被收窄为 double 或溢出。它们不选择连接池、不要求 Spring、不通过框架管理数据库迁移，也不捆绑生产数据库驱动。测试配置默认提供 H2 来运行 Repository 契约，并为可选的 MySQL 集成测试提供 MySQL Connector/J。

## Schema

Broker 私有拥有四张表：

- `qwen_runtime_binding_slot` 用于串行化同一哈希 Runtime Scope 的创建。
- `qwen_runtime_binding` 保存当前 Runtime Binding、generation、endpoint、操作租约、生命周期状态和乐观锁版本。
- `qwen_runtime_session` 保存某个 Binding generation 下的 Runtime Session 及其终态。
- `qwen_tool_execution` 按全局唯一的 idempotency key 保存一个持久化 Tool Execution，包括不可变请求身份、dispatch fencing、取消意图、`UNKNOWN` 状态和最终结果。execution-call 和 idempotency 标识使用确定性哈希，从而在任意数据库排序规则下保持大小写敏感查询；每次查询还会校验完整标识。

Scope 身份使用确定性哈希表示，并始终与完整的租户级身份一起校验。Endpoint token 仍是调用方提供的加密值或不透明值；Repository 不记录也不转换它。

## 事务与并发语义

创建 Binding 时会锁定 Scope slot，在事务内重新读取 Binding，并确保每个 Scope 只插入一个活动记录。Binding 更新同时使用已保存的 version 和 generation 作为 fencing 条件。操作租约使用数据库时钟，使竞争 JVM 不依赖彼此同步的本地时钟。JDBC adapter 会在查询中把数据库时钟转换为 Unix epoch，避免连接的会话时区偏移租约 instant，并将其归一化为整秒，使租约值经过会丢弃小数秒的 MySQL 兼容驱动后仍能一致地往返读取。

创建 Session 时依赖数据库唯一约束，并在并发插入后重新读取胜出的记录。Session 的 CAS 更新会锁定当前行，校验预期 version 和 Binding generation，并拒绝把终态 Session 重新激活。SQL 失败会回滚事务并向调用方传播；不会静默回退到进程内状态。

创建 Tool Execution 时使用唯一 SHA-256 key 保持数据库索引长度可控，同时保留并校验完整 idempotency key。变更操作会锁定 execution 行。CAS 更新和 `UNKNOWN` 对账校验调用方提供的不可变身份与 version；取消请求校验预期 version；dispatch claim 与续租校验各自适用的 owner、generation 和 lease fencing。租约判断使用数据库时钟。过期的 `DISPATCHING` claim 可以重新发放，因为物理执行尚未开始；过期的 `EXECUTING` 或 `CANCEL_REQUESTED` claim 会进入 `UNKNOWN`，在显式对账结果完成它之前不得再次 dispatch。

## Schema 生命周期

Schema 初始化会对四张 Broker 私有表执行幂等的 `CREATE TABLE IF NOT EXISTS`。这满足当前私有模块边界。后续接入服务端之前，还需要明确 Migration 的版本管理和部署方式。

## 恢复边界

持久化的 Binding 或 Session 行只能证明 Broker 状态仍然存在，不能证明它引用的 Runtime 进程仍然存活。同样，`UNKNOWN` Tool Execution 记录的是不确定性，不能证明副作用是否已经发生。进程对账和传输健康检查仍属于后续 Runtime 集成的职责。按需执行对账会询问原 Runtime，只在其给出终态证据时经 `resolveUnknown` 结算；参见 `managed-runtime-broker-service-core.zh-CN.md` 的 UNKNOWN 对账一节。

## 安全与租户隔离

Binding 和 Session 查询与变更受完整 Runtime Scope 或从该 Scope 创建的身份约束。Tool Execution 方法接收不透明的 execution、idempotency 和 Runtime Session 标识，接口没有单独的租户或 Workspace 参数。接入服务必须先根据已认证的租户、Workspace 和 Session 上下文生成全局唯一标识，再调用 Repository，并且不能把不可信标识本身当作充分授权。在此前提下，唯一键会阻止跨 Scope 别名；Tool Execution Repository 本身不独立执行租户或 Workspace Scope 校验。Binding 与 Session Repository 不会跨租户或 Workspace 搜索“兼容”的 Binding；任何 Repository 都不会在状态缺失或不明确时回退到 Primary Runtime。

## 验证

Repository 契约覆盖：

- 同一 Scope 下并发创建唯一 Binding；
- 通过新 Repository 实例恢复状态；
- 拒绝过期 version 和过期 generation；
- 操作租约所有权以及过期后的接管；
- Binding 和 Session 状态的租户与 Workspace 隔离；
- 并发创建 Session；
- 终态 Session 不能重新激活；
- 多 Repository 实例并发幂等创建 Tool Execution；
- dispatch claim、续租、取消、过期 owner fencing 和 `UNKNOWN` 对账；
- 通过新 Repository 实例恢复最终结果；
- Schema 可重复初始化。

默认测试套件在 MySQL 兼容模式的 H2 上运行该契约。CI 还会通过 MySQL Connector/J 在 MariaDB 上运行 `mysql-integration` Maven profile，以便在真实 MySQL 兼容协议上覆盖 session time zone 处理和持久化租约往返读取。同一 profile 也可以在本地对调用方提供的 MySQL 数据库运行。

## 验收标准

- 多个 Repository 实例通过数据库协调，并且同一 Scope 只能观察到一个活动 Binding。
- Binding 和 Session 状态在 Repository 重建后仍然存在。
- 过期所有者不能修改更新后的 Binding generation 或 version。
- 已过期操作租约可被接管，未过期租约仍受 fencing 保护。
- Binding 和 Session 状态按租户和 Workspace 保持隔离。
- 接入服务根据已认证的租户、Workspace 和 Session 上下文生成全局唯一并带命名空间约束的 Tool Execution 标识。
- 终态 Session 不能回到非终态。
- 并发调用方对同一 idempotency key 只能观察到一个 Tool Execution。
- 有效 dispatch 租约会拒绝其他 owner，过期的执行中 claim 会进入 `UNKNOWN` 而不会被重放。
- 取消意图和 Tool 最终结果在 Repository 重建后仍然存在。
- Schema 初始化可安全重复执行。
- H2 契约和 CI 中真实 MySQL 兼容数据库契约均无需进程内回退即可通过。

## 后续工作

服务端装配、进程对账、`UNKNOWN` 执行的接管扫描、Schema migration 部署和多进程端到端验证仍属于后续工作。
