# Managed Agent 容量观测

[English](2026-10-22-managed-capacity-observation.md) | [简体中文](2026-10-22-managed-capacity-observation.zh-CN.md)

## 问题与范围

Issue #15082 请求建立容量和空闲回收模型。首个交付物是一个只读运维观测，
把持久化 Runtime 状态与尚未测量的主机条件区分开。本切片扩展参考发行包已有的
`--check` 预检，不执行准入、拒绝、回收或任何 Runtime 修改。

## 观测事实

数据库预检成功时，`--check` 会按状态统计 `ma_runtime_binding`、
`ma_runtime_session` 和 `ma_operation`。输出明确这些是持久化的逻辑记录。
binding 行表示一个持久化 Runtime generation，runtime-session 行表示一个持久化
逻辑 Session；两者都不被声称等于一个物理进程。operation 状态统计提供 pending、
running、recovery 及终态的分布，帮助运维判断积压。

报告明确把物理进程数和内存标为 `unknown`。空闲状态标为
`not measured`：仅凭 `last_active_at` 不能证明 Runtime 可以安全回收，因为租约、
writer、工具调用或恢复工作仍可能存在。本改动不新增超时、阈值、准入拒绝或清理动作。

## 失败与兼容行为

现有数据库检查仍是前置条件。数据库检查失败时，容量行显示 `SKIP`，不会把数据库
不可用误报为空部署。数据库可连接但观测表不可用时，容量行显示 `WARN`，预检继续保持
只读行为。查询使用共享 schema 中固定的表名和列名，不修改 schema。
固定五秒观测连接发生超时时也显示 `WARN`，但 detail 会说明观测在读取完全部状态
计数前超时，fix 会指向数据库负载，而不会把它说成 schema 损坏。本切片有意保留
精确的全状态计数，不加索引，也不把查询限制为非终态；如有需要，后续状态视图可以
单独设计有边界的运维视图。查询仍使用共享 schema 中固定的表名和列名，不修改 schema。

## 验收与后续

验收条件是稳定的 `capacity` 行，其中包含三个持久化状态映射，并明确输出
`physical-processes=unknown`、`memory=unknown` 和 `idle-reclamation=not measured`。
定向 H2 回归会覆盖状态分组输出，无需真实部署；遵照当前任务要求，本次不运行该回归。

后续 #15082 仍需确定部署侧容量权威、主机内存和物理 Runtime 身份的测量方式、精确的
空闲定义，以及通过 Runtime Broker drain/close 保留证据的回收流程。这些决策不属于
本次只读报告改动。
