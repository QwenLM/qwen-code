# Managed Agent 数据库历史迁移归档

[English version](README.md)

这些文件记录提交 `18f80f56666a347a2b67b2ef98099cc58356b253` 中已停用的 63 表数据库，只供历史参考，不在运行时或测试 classpath 中。归档的 Java 迁移与升级验收不会在新环境执行。

唯一启用的 baseline 是 [`V1__managed_schema.sql`](../../../packages/managed-agent-server/src/main/resources/db/managed-schema/V1__managed_schema.sql)。Managed Server 与 Runtime Broker 读取同一个版本化资源，仅允许空库或结构验证通过的完整 32 表库。旧库、残缺库、外部表及仅有迁移历史的库，在初始化写入前被拒绝。重复初始化只验证结构，不回填或修复。

本次不迁移旧数据、不原地升级。旧环境及旧库保留历史读取，切换前停止新请求准入并结算在途工作，新会话只在新环境创建。新库产生数据后，回滚必须保留并从新库提供这些记录。

归档测试保留旧迁移算法的历史证据，现役替代测试验证空库初始化、已有记录保持不变、有类型的可选字段、Hook 唯一约束及索引准入，以及旧库拒绝。重复的 Broker `schema.sql` 已移除，不再保留第二套结构权威。

PR #13642 的清理 V69 SQL 与 `RuntimeBrokerRetentionLegacyUpgradeTest.java` 保留 head `db4c37064b9f34d2aa879b23b0e894fbed0281e1` 中原清理索引/receipt 升级证据，仅作为归档。现役 32 表 V1 baseline 提供清理索引，替代测试验证新库 catalog 一致性及重复初始化时 receipt 不变。V69 不是现役 migration，也不构成版本预留。
