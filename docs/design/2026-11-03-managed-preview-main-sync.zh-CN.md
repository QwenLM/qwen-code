# Managed 私有预览与主线同步

[English](2026-11-03-managed-preview-main-sync.md) | [简体中文](2026-11-03-managed-preview-main-sync.zh-CN.md)

## 范围与状态

这是私有预览集成候选，尚待编译、聚焦测试、完整 CI、制品校验及预发验收。将既有 `7e79b000ef1f1013a9c14ce15a81d8499ac1b0b5` 预览与上游 `c26a32006a82d516eeb83640f8fc3a4f1243707b` 同步，保留 Session 归属与外部 Workspace 契约。本次不授权生产发布或数据库迁移。

当前内置 SDK 提交 `1f3e2a6de0d6a6de09f042e354ad8907aaf0c28c` 与该上游提交的 Java SDK 源码树完全相同（`f14113e5e31a846b0f66fe2b2b7d6c0def4eebe6`），复用已冻结的 SDK payload。Java Maven 版本与 CLI 包版本保持区分。

## 集成决策

保留主线的 Store 拆分：公开 facade 保持事务入口，admissions 在创建事务中写入 Session 归属，commands 校验不可变身份与回执授权，queries 按同一身份落实可见性。各组件复用既有归属权威。保留迁移准入锁、Session-before-Turn 顺序、原生 journal 事务和拒绝旧归属行的行为。

保留主线的可选运行时模块与 provider registry。外部 provider 负责配置校验及 acquisition/terminal/recovery 证明。contracts 中的 `ExternalWorkspaceProvider` SPI 将这三项操作交给服务端装配，服务端不编译依赖可选的外部实现。既有 recovery gateway 仍将持久恢复委托给 Broker，其他 provider 不因此获得外部能力。

保留预览版本中已验证 payload 的并发派发修复，以及失败/取消终态不阻塞回收的修复。保留 tenant/user/actor 身份、精确注册、原 worker 证明、Session 关闭隔离及失败关闭的恢复语义。不增加工具、Shell 支持、隐式就绪或启动 DDL。

## 制品与结构契约

在指定 devbox 构建新的唯一私有 Server 版本，在真实消费 POM 中保留第三方依赖。仅聚合生产模块；`META-INF/services` 条目须合并去重，不能覆盖其他 provider。冻结源码、源码提交、许可证、校验和与验证证据。不修改旧制品字节，不发布 verification 模块。

共享 V1 基线保留 `ma_session_principal`、外部注册回执和 shared dispatch 分类。开发/预发库必须与最终制品精确匹配。继续拒绝旧库、残缺库和混用业务库；不进行 Flyway repair、结构版本递增、自动迁移或业务混库。

## 验证与验收

选择 Session 身份归属、外部 materialization/ownership、恢复/回收、外部 drain、shared dispatch、runtime dispatch、provider 装配与 schema 测试。共享十分钟本地 Java 预算内无法运行的 MySQL 8.4 与真实进程恢复证据必须明确保留缺口。完整测试集、Checkstyle 和 SpotBugs 由 CI 执行。

消费方验收还须完成 DataAgent 编译及 Java/MySQL 门禁、最终包结构与 provider 资源校验、部署源码/制品/数据库身份核对、两个只读 Session 共享同一 Worker 并发、取消后继续及关闭一个 Session 不影响另一个。部署和 E2E 状态与源码集成分别报告；失败或无法执行的门禁不代表通过验收。
