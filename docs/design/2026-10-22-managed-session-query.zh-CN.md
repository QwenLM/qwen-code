# Managed Session 查询过滤

[English](2026-10-22-managed-session-query.md) | [简体中文](2026-10-22-managed-session-query.zh-CN.md)

## 问题与范围

Issue #15077 需要服务端标题搜索和分页前的归档过滤。PR #15100 已提供 WebShell
归档视图与导出。本依赖切片补齐公共 API 过滤及 Java provider 共享的标题查询契约。
独立标题搜索输入已使用该契约；原有导航搜索继续匹配 Session ID 和 Workspace 名称。
输入接线已经实现，运行时与 UI 验收单独跟进。

## 契约与决策

公共列表接受 `archive_state=all|unarchived|archived` 和 `title_query`；WebShell
查询接受 `archiveState` 和 `titleQuery`。省略归档过滤保留现有 `all` 默认值。
公共参数 `include_archived=true` 对应 `all`，`false` 对应 `unarchived`；显式过滤
冲突返回 400。

标题搜索对存储标题执行不区分大小写的字面子串匹配。查询最多 512 个 Unicode
码点，沿用标题判空规则去除两端 Java whitespace、space character（包括 NBSP）及
BOM；内部字符保持字面含义。null 或空串表示不按标题过滤。
`%`、`_` 和反斜线均为字面字符。SQL 在 limit 之前应用两种过滤，保留租户、
Workspace 授权、公共 Session 类型和删除状态约束。大小写转换遵循数据库 `LOWER`
行为，不承诺特定语言环境的等价匹配。

排序仍按创建时间和 Session ID 降序。无过滤的旧游标仅对 `all` 有效；v2 游标保留
归档状态绑定。非空标题查询使用 v3 游标，绑定归档状态和去除两端空白后的查询的
SHA-256。改变查询大小写需要新游标，即使结果相同。游标不是授权凭证，每页重新
检查权限。并发重命名、归档或删除期间，列表不提供快照语义。

## 风险与验收

无需数据库迁移或新路由；两个现有列表路由保留 Workspace 读取授权。子串匹配
可能扫描授权候选集合；本切片不引入索引，也不宣称性能已测量。

定向契约回归覆盖通配字符的字面匹配、大小写转换、分页前过滤、查询或过滤改变
导致的游标拒绝、两套 API、兼容别名冲突及租户隔离。原有归档回归继续覆盖旧游标
及默认值。遵照用户要求，未运行本地测试、构建或检查；CI 和特定数据库执行尚未验证。

## 后续

Java WebShell provider 现在提供独立的标题搜索输入框。首次请求及后续分页都会发送
服务端 `titleQuery`；现有导航搜索继续负责 Session ID 和 Workspace 名称。其他 provider
不会显示该输入框。在确定组合搜索契约前，标题输入与导航搜索保持分离。

该 issue 仍需运行时验收及未来组合搜索决策；本 UI 接线不声称并发变更下提供快照语义。
