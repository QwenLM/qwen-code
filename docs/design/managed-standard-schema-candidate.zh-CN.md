# 受治理的 Managed Agent 表结构与 Java 完整性

[English](managed-standard-schema-candidate.md) | [简体中文](managed-standard-schema-candidate.zh-CN.md)

## 状态与依赖

这是基于 #16023 常驻外部 Workspace 改动的草案。它与 #16143 的表结构规范方案存在重叠，两者落地前必须明确协调。导出的分支尚未完成运行验证；集成分支上的历史检查不能证明这个公开修订通过。

## 物理结构与完整性

39 张 Managed 表采用数据库生成的 BIGINT UNSIGNED 主键，并保留非空业务唯一键。布尔字段使用 is_* TINYINT UNSIGNED，时间戳保留毫秒语义，9 个生成列继续约束派生身份的唯一性。普通 MySQL 写入要求全局及当前会话均启用严格 SQL 模式。

部分受治理的 DDL 流程无法保留 CHECK 定义。本方案将原 73 条行谓词迁到 Java 完整行校验及具备类型的事务写入边界。必须提供谓词涉及的所有非生成字段。校验保留 SQL FALSE/UNKNOWN 语义、精确封闭域、字段配对、正数及安全整数边界、UTF-8 字节上限和流进度关系。回执命名空间包含现有契约值 EXTERNAL_WORKSPACE。

Session 受理、事务锁定后的 Session/Turn 复制、head/stream 读取、CSI 规范恢复及在线解码使用这些行规则。原始数字布尔值在强制转换前校验。输出捕获插入显式填写数据库时间。物理 NOT NULL、UNSIGNED、唯一键、生成表达式、所有权检查、CAS 和租约 fencing 保留。直接 SQL 写入会绕过 Java 谓词，不能将其视为受支持的业务写入方。

## 锁定

整数主键改变了 InnoDB 的加锁位置。已有 guard 行先按业务身份定位，再按整数主键加锁。首次创建在原连接上使用按 catalog/租户/domain 隔离的命名锁，随事务完成释放，不额外借用连接池连接。CSI 缺失根探测不插入授权证据。在 Repeatable Read 下，快照之后创建的根可能被保守判为缺失，需下一事务重新观察。

该方案与 #16143 在两个协调表保留业务主键聚簇的选择不同。确定采用整数主键前，必须通过真实 MySQL 竞争与连接池清理验证。

## Catalog 边界

默认初始化和校验仍要求精确的独立 Managed catalog。显式的共享库仅校验 API 允许无关业务表和视图共存，但拒绝缺失或未知 ma_* 表、旧 managed_agent_* 表、Managed 视图及结构漂移。不提供共享库初始化或元数据代理。CSI 维护校验仍严格要求独立库；共享启动成功不能证明 CSI 已完整支持共享库。

## 验证与迁移

V1 仍是唯一的预发布基线。不引入 V2 迁移、schema 历史改写或旧库/部分结构自动升级；本草案使用新的开发 catalog。评审需要覆盖完整行受理与恢复、物理元数据、严格模式、负数及非法值、真实 MySQL 锁顺序与竞争、原始 JDBC/Spring 事务清理、共享库显式启用、Session/Worker 复用、工具与并发轮次。

保留的回归源码不等于执行通过。公开 CI 和运行验收仍待完成，包括跨平台及 Hosted/故障注入 profile。
