# Managed Agent 会话 SQL 模式

[English](2026-11-04-managed-session-sql-mode.md) | [简体中文](2026-11-04-managed-session-sql-mode.zh-CN.md)

## 问题与范围

上游 `2f56b6b5ef3298782ff7de19730dbba9bda84274` 的结构准入同时要求全局和会话启用严格 SQL 模式。内嵌部署在共享 MySQL 实例上使用独立库，应用账号不能修改全局默认值。SQL 写入行为由连接的会话模式决定。本次私有 SNAPSHOT 调整准入与内嵌默认 Managed 连接池；独立服务、维护工具和自定义 DataSource 的生命周期配置仍由调用方负责。

## 决策

准入要求当前会话包含 `STRICT_TRANS_TABLES` 或 `STRICT_ALL_TABLES`。内嵌默认 Druid 池通过连接初始化 SQL，为每条新建的 MySQL 或 MariaDB 物理连接在继承的会话模式中追加 `STRICT_TRANS_TABLES`，不修改全局模式。H2 不受影响。提供其他 DataSource 的调用方必须为每条连接配置严格模式。MariaDB 的全局和会话 CHECK enforcement 要求保持。

库、列、键、CHECK、生成列和外键校验保持。内嵌宿主继续禁止外部数据库自动初始化。严格模式避免普通写入将无符号计数器的负数静默截成零；应用不得在准入后关闭它。不引入绕过开关或新的数据库迁移。

## 验证与交付

聚焦的结构测试拒绝空值和伪严格会话模式，且不查询全局 SQL 默认值。真实 MySQL 测试关闭 Connector/J 自动截断处理，使原始连接从非严格模式开始，再验证同时借出的池连接及物理连接终止后的替代连接。每条池连接均保留其他模式，拒绝无符号列的负数写入并返回错误 1264，旧值保持。CI 在全局模式为空的一次性 MySQL 实例上执行该测试，核对全局值不变。同时保留 H2 内嵌和 Hosted 隔离 mock 的覆盖。

宿主采用前，将固定源码打成独立私有 SNAPSHOT。本任务原生本地验证预算已耗尽，构建与剩余原生验证交给 producer CI。producer 通过不代表预发启动或业务验收通过。部署须使用配套的已建好 39 表结构，先完成只读结构核验，再执行已声明的预发单轮场景验收。
