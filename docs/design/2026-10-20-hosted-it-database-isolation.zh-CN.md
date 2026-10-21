# Hosted 集成测试数据库隔离

[English](2026-10-20-hosted-it-database-isolation.md) | [简体中文](2026-10-20-hosted-it-database-isolation.zh-CN.md)

## 问题

`hosted-harness-mysql` profile 在一个 Failsafe fork 中顺序运行 `Hosted*IT`
类，共用一个临时 MySQL schema。测试类虽然关闭了自己的 Spring context，持久化行却仍然存在。
下一个类的恢复协调器因此会发现之前测试类的 operation 和 Turn。它们的 Runtime 凭据与
Workspace 挂载属于另一个 fixture，恢复无法完成。见 [#14850](https://github.com/QwenLM/qwen-code/issues/14850)。

生产恢复有意跨租户运行。为了测试 fixture 而修改其查询条件，会削弱对生产行为的覆盖。

## 决策

在 `hosted-harness-mysql` profile 中通过服务发现启用一个仅测试使用的 JUnit extension。
每个顶层测试类开始前，它连接传入的 `mysql.url`，清空当前 catalog 中所有 `ma_` 基表。
表定义、索引、约束以及 `flyway_schema_history` 均保留。
catalog 必须是独立的应用 catalog；未指定 catalog 或选择 MySQL 系统 catalog 都会被拒绝。

禁用和恢复外键检查与清空操作使用同一个短生命周期连接。清理失败会使测试类初始化失败，
此时 Spring 和恢复扫描器尚未启动。在类初始化前清理，也能移除之前失败的测试类或上次运行遗留的数据。

profile 固定使用一个 fork，并禁用 JUnit 并行执行。现有测试类的 teardown 继续负责关闭
context 和子进程。extension 跳过嵌套类 context，且不会在测试方法之间运行，因此 fixture
内部的重启和恢复场景仍保留其持久状态。

## 范围与权衡

正常单元测试、`mysql-integration` 和其他 profile 不会启用此 extension。
生产查询、生命周期行为和迁移均不变。所选数据库必须只包含可丢弃的测试数据：所有 `ma_`
行都会删除，包括 Session、Turn、operation、Broker 和自动化状态。无关表保持原样。

统一的类初始化入口避免了每个 fixture 都要手动调用清理，也避免了为每个类创建新 catalog
并重复执行 schema 迁移。此方案依赖顺序执行和现有资源 teardown。不支持其他测试进程共用该数据库。
如果将来需要类级并行，必须改为使用独立 catalog。

## 验证与验收

- 两个独立 Hosted 测试类各自创建待恢复的 CLOSE operation。在任意执行顺序以及对同一数据库
  重复运行时，每个恢复扫描都必须只返回当前类的租户。
- 回归覆盖必须检查 operation 和 Turn 的清理、Flyway 历史及 schema 校验的保留，以及类内状态的保留。
- 验证 profile 会自动启用 extension 并保持顺序执行。运行模块验证和 CI profile 契约测试。
- 完整 Linux/cgroup Hosted 故障测试仍需由 CI 验证；macOS 上的 MySQL 回归不能证明这些进程恢复保证。
