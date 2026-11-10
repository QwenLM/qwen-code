# 共享库中的 Managed 表结构处理

[English](managed-standard-schema-candidate.md) | [简体中文](managed-standard-schema-candidate.zh-CN.md)

## 发现规则

`ManagedSchema.initialize` 与 `ManagedSchema.validate` 只发现 Managed 命名空间。以下对象保持可见，
并参与与预期表集合的精确比对：

- 所有 `ma_*` 对象；
- 十四个旧版 `managed_agent_*` 名字；
- 四十九个显式旧版名字（`managed_*` 与 `qwen_*` 两代），它们是私有的 catalog 发现细节，不是公开契约；
- `flyway_schema_history`，沿用原有单独处理。

无关业务表、视图及其数据不参与比对，保持原样。由于保留下来的名字要与三十九个目标表精确比对，
Managed 表缺失、未知、属于旧版或由视图替代都会被拒绝；与 Managed 相关的唯一对象是
`flyway_schema_history` 表的库同样被拒绝。拒绝发生在执行任何 DDL 之前：不建表、不迁移、不修复。

六十三个原始 inventory 名字与目标契约的对齐关系是：三十九个目标表，减去五个没有任何原始名字演进到的
目标（`ma_extension_package`、`ma_extension_settings`、`ma_extension_operation`、
`ma_session_worktree`、`ma_session_principal`）。

`managed_agent_*` 前缀的作用是让那十四个名字留在比对里，而不是被丢弃。不复活 R6-1 式的容忍：当年这些
名字是在只校验的 API 上被容忍的，而现在发现逻辑与 `initialize` 共用，容忍会变成在旧 Managed 库上静默
重建自身的表。

## `initialize` 在纯业务库上的放宽

`initialize` 过去只在没有任何 Managed 对象的专用库上建目标表。现在它也会初始化「有无关业务表、但没有
任何 Managed 表」的库：三十九个目标表及其索引会建在业务表旁边。这是相对旧行为的放宽，后果写明——对共享的
应用库执行 `initialize`，会给该库加上 Managed 表与索引。

已经恰好包含目标表的库仍然原地通过校验，`initialize` 仍是幂等空操作。已经装有无法校验的 Managed 对象的
库仍然被拒绝。

## 不再有独立的共享库校验 API

`ManagedSchema.validateSharedCatalog` API 已不存在。发现与校验合并为 `initialize` 与 `validate` 一条
路径，不提供独立的共享库初始化入口。

聚焦回归在 `ManagedSchemaTest`。
