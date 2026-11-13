# Managed Verification 棘轮裁剪

[English](2026-11-12-managed-verification-ratchet-trim.md) | [简体中文](2026-11-12-managed-verification-ratchet-trim.zh-CN.md)

## 问题

对 `packages/managed-agent-server` 的架构评审发现，`verification` 模块在行为
测试之外混入了一小批钉住实现文本而非行为的元棘轮：AST 扫描的仓储方法签名与
SQL 字面量清单、逐字保留 Javadoc 的固定测试，以及两份纪念合并前 63 张旧表的
TSV 清单。这些门禁会在无害的内部改动（重命名私有辅助方法、给 SQL 字符串换行、
改写注释）时变红，而它们指向的行为早已被真实测试覆盖。

`verification` 模块本身保留：它是所有生产模块唯一的测试存放处（没有任何模块
自带 `src/test`），是
[2026-10-29-managed-agent-maven-modules](2026-10-29-managed-agent-maven-modules.md)
的既定设计，也是 CI 报告完整性守卫的锚点。本变更裁剪的是模块内部的棘轮，
不是删除或搬迁模块。

## 删除内容

- `SessionRowLockOrderTest` 与 `src/test/resources/lock-contract/`
  （`entries.txt`、`sql-owners.txt`）。该测试自注 "Inventory only: executed
  branches are checked by StoreLockTrace and MySQL scenarios"。文本快照本身
  被放弃；它们指向的锁行为仍由 `StoreLockTraceTest`、`AgentLockContractTest`、
  `JournalLockContractTest`、`AgentLockContractMySqlIT`、
  `JournalLockContractMySqlIT`、`ManagedLockScopeConcurrencyMySqlIT` 覆盖，
  它们执行真实锁路径。
- `AgentStateStoreJavadocPinTest` 与
  `src/test/resources/managed-agent/role-javadoc-inventory.txt`。该固定测试
  守护的是一次历史拆分回归（成员 Javadoc 被整体丢弃）；它锁的是注释文本而非
  行为，且六个角色接口已经稳定。
- `ManagedSchemaMapping`、`ManagedSchemaTest` 的
  `all63OriginalEntitiesHaveOnlyRealTargetDestinations` 用例，以及两份旧表
  清单 `original-managed-table-inventory.tsv` 与
  `db/managed-schema/legacy-table-map.tsv`。旧表在 V1 基线之前就已合并删除，
  映射不再守护任何现存事物。`ManagedSchemaTest` 的其余部分（schema 校验、
  漂移拒绝、业务键、CHECK 约束）不变。

## 保留内容

- `ClassSizeRatchetTest` 与 `class-size-ratchet.properties`：它们棘轮的是
  `persistence` 与 `runtime-broker` 的生产类尺寸，巨类回潮是真实且已被观察到
  的风险。
- `ModuleArchitectureTest`（ArchUnit 模块矩阵）、OpenAPI 契约与
  `SurfaceRegistry` 门禁、全部 MySQL IT，以及 Hosted/故障/MQ/OSS 门禁。

## Profile 一致性修复

九个本地聚焦 Failsafe profile（`hosted-process-crashes`、
`hosted-workspace-tools`、`hosted-channel-gates`、`hosted-monitor-run-gates`、
`hosted-session-relay-gates`、`hosted-workflow-gates`、`hosted-mcp-gates`、
`hosted-automation-gates`、`o4-oss-gates`）缺少其他门禁 profile 都有的
Surefire `skipTests` 块，导致本地聚焦运行会先重跑全量单元套件。现在它们与
同类 profile 一样跳过 Surefire。没有任何 CI lane 调用这些 profile；CI 的
Hosted lane 在 `hosted-harness-mysql` 下运行同一批类，而该 profile 早已跳过
Surefire。

`mysql-integration` 有意继续运行完整 H2 单元套件（fast tier 跳过该 lane，
套件由它持有），保持不变。

更深层的 profile 结构去重（把共享的 Failsafe 版本与 executions 移入
`pluginManagement`）有意不做：v0.26.5 发布修复补丁
`scripts/patches/managed-runtime-v0.26.5-verification.patch`（由
`scripts/tests/managed-runtime-release.test.js` 演练）会对当前 pom 做
reverse-apply，逐字节钉住 `pluginManagement` 块。为省约 100 行 XML 而重构它
会破坏被钉住的发布修复。

## 文档策略

早先设计文档中提到 `SessionRowLockOrderTest` 或 lock-contract 清单之处，记录
的是各自变更当时的验收标准；它们是历史记录，不予改写。本文档是此次删除的
前瞻性参考。

## 验证

- 本地：聚焦运行 `ManagedSchemaTest`、`ClassSizeRatchetTest`、
  `ModuleArchitectureTest`（编译全部生产模块与完整 verification 测试树，
  证明对已删类无悬空引用），并对改动的测试源码跑 Checkstyle。
- CI：接受修订上的完整 unit/H2 套件、两个 Checkstyle execution、SpotBugs，
  以及 MySQL/Hosted/故障/MQ/OSS profile。报告完整性守卫动态扫描测试树，
  删除的类无需修改任何名册。

## 验收标准

- 已删除的类与资源不再有任何源码、脚本或 CI 引用（历史设计文档除外）。
- 聚焦测试与 Checkstyle 本地通过；CI 门禁在接受修订上通过。
- 九个本地 profile 跳过 Surefire；`mysql-integration`、默认构建与
  `pluginManagement` 行为不变。
