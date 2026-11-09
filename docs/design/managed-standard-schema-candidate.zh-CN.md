# 显式共享库结构校验

[English](managed-standard-schema-candidate.md) | [简体中文](managed-standard-schema-candidate.zh-CN.md)

## 目标

允许嵌入式应用校验已有 Managed Agent 表，即使同一 catalog 中还存在无关业务表或视图。这是显式库 API，不改变默认启动行为。

## 行为

`ManagedSchema.validateSharedCatalog(DataSource)` 及其 `Connection` 重载只校验 Managed 命名空间。所有 `ma_*` 及旧版 `managed_agent_*` 对象均保留在预期表集合的精确比对中，因此缺失、未知、旧版或由视图替代的 Managed 表都会被拒绝。

选出命名空间后，复用现有的列、生成表达式、主键/唯一键/索引、CHECK、外键和数据库引擎校验。无关业务对象及数据保持原样。现有 Flyway 历史表处理和应用 catalog 检查继续生效。

DataSource 重载关闭自行获取的连接；Connection 重载保持调用者连接打开。校验不创建、迁移或修复任何对象，空库和只有业务表的库均被拒绝。

## 范围

V1 SQL 基线、数据库约束、物理主键、列名、锁机制、Session 身份和 HTTP 授权均不改变。`initialize`、默认 `validate`、`schemaVersion` 和 CSI 维护继续严格校验整个 catalog。不提供共享库初始化入口或配置开关。

PR 保留现有的 #16023 快照基线，不复制 #16143 的表结构规范化改动，也不宣称完成 CHECK 向 Java 的迁移。

## 验收

- 完整 Managed 表加无关业务表与视图，只能通过显式共享校验；默认校验和初始化仍拒绝混合 catalog。
- 两个重载均保留业务数据和 catalog 对象。
- 缺失/未知 Managed 表、旧版对象、Managed 视图及约束漂移，均由独立库使用的同一套校验器拒绝。
- 空库和只有业务表的库在被拒绝后保持原样。

`ManagedSchemaTest` 包含聚焦回归案例。本次范围收敛不跑本地测试、构建或 typecheck，运行验收仍待完成。此前验证报告只适用于旧版本。
