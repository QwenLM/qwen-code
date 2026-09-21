# Managed Runtime Broker JDBC 持久化

[English](managed-runtime-broker-jdbc.md) | [简体中文](managed-runtime-broker-jdbc.zh-CN.md)

状态：已在 Repository 边界实现并验证

## 问题

Managed Runtime Broker 基础能力当前把 Runtime Binding 和 Runtime Session 保存在进程内存中。进程重启会丢失这些状态，多个 Broker 进程也无法通过共享事实源协调所有权。

## 目标

- 通过 JDBC 持久化 Runtime Binding 和 Runtime Session。
- 保持 Binding 原子创建、Binding generation fencing、CAS 更新、操作租约、租户隔离和 Session 终态语义。
- 幂等初始化 Broker 私有 Schema。
- 使用同一套 Repository 契约同时验证 H2 和真实 MySQL。

## 非目标

- 持久化 Tool Execution 账本。
- 启动、停止或以其他方式管理 Runtime 进程。
- 把 Repository 接入 Harness、Spring 装配、传输层或公共 API。
- 通过 SSE、Outbox、MQ 或 Redis 分发事件。
- 让无关 Workspace 共享同一个 Managed Runtime。

## 依赖边界

JDBC Repository 只依赖 `javax.sql.DataSource`。它们不选择连接池、不要求 Spring、不通过框架管理数据库迁移，也不捆绑生产数据库驱动。测试配置默认提供 H2 来运行 Repository 契约，并为可选的 MySQL 集成测试提供 MySQL Connector/J。

## Schema

Broker 私有拥有三张表：

- `qwen_runtime_binding_slot` 用于串行化同一哈希 Runtime Scope 的创建。
- `qwen_runtime_binding` 保存当前 Runtime Binding、generation、endpoint、操作租约、生命周期状态和乐观锁版本。
- `qwen_runtime_session` 保存某个 Binding generation 下的 Runtime Session 及其终态。

Scope 身份使用确定性哈希表示，并始终与完整的租户级身份一起校验。Endpoint token 仍是调用方提供的加密值或不透明值；Repository 不记录也不转换它。

## 事务与并发语义

创建 Binding 时会锁定 Scope slot，在事务内重新读取 Binding，并确保每个 Scope 只插入一个活动记录。Binding 更新同时使用已保存的 version 和 generation 作为 fencing 条件。操作租约使用数据库时钟，使竞争 JVM 不依赖彼此同步的本地时钟。

创建 Session 时依赖数据库唯一约束，并在并发插入后重新读取胜出的记录。Session 的 CAS 更新会锁定当前行，校验预期 version 和 Binding generation，并拒绝把终态 Session 重新激活。SQL 失败会回滚事务并向调用方传播；不会静默回退到进程内状态。

## Schema 生命周期

Schema 初始化会对三张 Broker 私有表执行幂等的 `CREATE TABLE IF NOT EXISTS`。这满足当前私有模块边界。后续接入服务端之前，还需要明确 Migration 的版本管理和部署方式。

## 恢复边界

持久化的 Binding 或 Session 行只能证明 Broker 状态仍然存在，不能证明它引用的 Runtime 进程仍然存活。进程对账和传输健康检查仍属于后续 Runtime 集成的职责。

## 安全与租户隔离

每次查询和变更都受完整 Runtime Scope 或从该 Scope 创建的 Binding/Session 身份约束。Repository 不会跨租户或 Workspace 搜索“兼容”的 Binding，也不会在状态缺失或不明确时回退到 Primary Runtime。

## 验证

Repository 契约覆盖：

- 同一 Scope 下并发创建唯一 Binding；
- 通过新 Repository 实例恢复状态；
- 拒绝过期 version 和过期 generation；
- 操作租约所有权以及过期后的接管；
- 租户和 Workspace 隔离；
- 并发创建 Session；
- 终态 Session 不能重新激活；
- Schema 可重复初始化。

默认测试套件在 MySQL 兼容模式的 H2 上运行该契约。可选的 `mysql-integration` Maven profile 会对调用方提供的 MySQL 数据库运行同一套契约。

## 验收标准

- 多个 Repository 实例通过数据库协调，并且同一 Scope 只能观察到一个活动 Binding。
- Binding 和 Session 状态在 Repository 重建后仍然存在。
- 过期所有者不能修改更新后的 Binding generation 或 version。
- 已过期操作租约可被接管，未过期租约仍受 fencing 保护。
- 租户和 Workspace 状态保持隔离。
- 终态 Session 不能回到非终态。
- Schema 初始化可安全重复执行。
- H2 契约和可选的真实 MySQL 契约均无需进程内回退即可通过。

## 后续工作

Tool Execution 持久化会在其内存状态契约完成评审后单独提案。服务端装配、进程对账和多进程端到端验证也属于后续工作。
