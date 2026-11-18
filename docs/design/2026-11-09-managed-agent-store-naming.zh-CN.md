# Managed Agent 存储实现类命名

[English](2026-11-09-managed-agent-store-naming.md) | [简体中文](2026-11-09-managed-agent-store-naming.zh-CN.md)

## 状态与范围

- 状态：已在新增本文档的变更中实现。
- 日期：2026-11-09
- 范围：`packages/managed-agent-server` —— 生产源码，以及按名字引用生产类的 verification 测试资源。
- 基线：`origin/main` `e5eb6a1775`。

## 问题

`com.alibaba.qwen.code.managedagent.repository`（`contracts` 模块）中有 24 个 repository 接口，它们在 `com.alibaba.qwen.code.managedagent.persistence`（`persistence` 模块）中的实现与接口同名，例如 `ManagedSessionStore`、`WorkspaceExecutionStore`。子工作树 Git 端口 `contracts.workspace.ChildWorktreeGit` 也与其适配器 `adapters.workspace.ChildWorktreeGit` 同名。

同名的两个类型，一个 Java 文件只能 import 其中一个。因此每个实现类，以及同时用到接口嵌套 record 或静态方法的 persistence 类，都只能用全限定名书写接口。在基线上，生产源码共有 1,347 行内联全限定类名，其中 662 行指向这些同名类型。例如单是 `com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable()` 就出现在 200 多行中。在这类文件里，一个裸的简单类名指哪个类型，要看文件所在的包和 import 才能确定。

## 设计

重命名实现类；若实现类本身的名字已经更具体，则改为重命名端口。被调用方注入的接口保持原名。

- 自身代码执行 JDBC 的 23 个实现类加 `Jdbc` 前缀，沿用已有的 `JdbcRuntimeBindingRepository`、`JdbcChannelRouteRepository` 命名：`JdbcAutomationLedgerStore`、`JdbcChannelInstanceStore`、`JdbcChildResultRelayStore`、`JdbcChildWorkspaceStore`、`JdbcHarnessPlacementStore`、`JdbcHostedCleanupDebtStore`、`JdbcManagedActionStore`、`JdbcManagedAgentDefinitionStore`、`JdbcManagedExtensionRecordStore`、`JdbcManagedSessionSkills`、`JdbcManagedSessionStore`、`JdbcManagedTaskEventStore`、`JdbcManagedToolDetailsStore`、`JdbcManagedToolResultStore`、`JdbcManagedUserMessageStore`、`JdbcManagedWorkspaceRegistry`、`JdbcSessionMessageRelayStore`、`JdbcSessionWorktreeStore`、`JdbcSshWorkspaceStore`、`JdbcTransportConsumerStore`、`JdbcWakeRecoveryStore`、`JdbcWorkspaceExecutionStore` 和 `JdbcWorkspaceLifecycleStore`。
- `ManagedArtifactReader` 的实现本身不查询数据库，而是通过工具发布数据存储读取，改名为 `ToolPublicationArtifactReader`。
- 子工作树端口改名为 `ChildWorktreeOperations`，与已有的 `SessionWorktreeOperations` 端口及其 `SessionWorktreeGit` 适配器保持一致。适配器保留 `ChildWorktreeGit` 这个名字。
- 同名冲突消除后，指向这些类型的内联全限定名改为 import。改动后，生产代码仍有 685 行使用内联全限定名，但其中不再有任何一行指向被改名的这些类型。
- 静态方法和错误工厂仍留在各自接口上，例如 `WorkspaceExecutionStore.unavailable()`。简单名不再有歧义，就不需要再挪动它们。

新代码约定：`persistence` 实现类不复用其所实现的 `repository` 接口的简单名；JDBC 实现类命名为 `Jdbc<接口名>`。

## 约束

- 运行时行为不变。SQL、事务边界与属性、加锁顺序、wire 与 JSON 名称、配置键、数据库字节与摘要均不变。每个改名类都保留原有的注解、qualifier 和构造器。
- Spring 按类型注入这些组件。现有的 qualifier 指向数据源、JDBC 模板、事务管理器、对象映射器、时钟和执行器等基础设施 bean，从不指向被改名的组件。由改名类派生的默认 bean 名会变化（例如 `managedSessionStore` 变为 `jdbcManagedSessionStore`），但仓库中没有任何地方按这些名字引用 bean。
- `JdbcHostedCleanupDebtStore` 和 `JdbcManagedExtensionRecordStore` 声明了基于类的 logger，它们的日志分类名会随类名变化。仓库中没有为这些分类配置日志级别。
- 改名是机械完成的。每个简单名按 Java 的查找顺序解析：文件自身的类型、单类型 import、同包、按需 import，只修改绑定到被改名类型的引用。import 顺序符合 Checkstyle 规则。
- 按名字书写生产类的 verification 测试资源同步更新：锁契约签名清单、SQL 归属源码路径（按测试要求保持有序），以及类体量上限表的 key。

## 类体量棘轮例外

[类体量棘轮](2026-11-04-managed-agent-class-size-ratchet.zh-CN.md)按全部行数计数，包括 import。14 个被锁定的类各多出 1–3 行 import，其余各行都没有变化。它们的上限恰好上调相同的行数，每个上调条目都在上限表中标注 `imports +N`。全局上限和其他上限均不变。这是对"上限只降不升"规则的一次有意且经过评审的例外：增加的是 import 声明，不是代码。

## 范围之外

- 并非由这些同名冲突引起的内联全限定名，例如 schema 行与 key 辅助类。
- 两个互不相关的 `WorkspaceSelection` 值类。
- 测试类名（如 `ManagedSessionStoreTest`），以及提到旧类名的历史设计文档。

## 验证与验收

- 归一化检查确认：每个改动的 Java 文件与基线相比，只有改名及其 import 上的差异。
- 验收：全部生产模块和 verification 源码编译通过；CI 中 Checkstyle、SpotBugs 与完整的 unit/H2 套件通过，包括 `ModuleArchitectureTest`、`ClassSizeRatchetTest` 和 `SessionRowLockOrderTest`。MySQL、Hosted 和故障 profile 按现有选择器通过。
