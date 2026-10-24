# Web Shell 次要工作区侧任务

[English](web-shell-secondary-workspace-side-tasks.md) | [简体中文](web-shell-secondary-workspace-side-tasks.zh-CN.md)

## 问题与范围

`/btw side <question>` 会创建独立的侧任务对话，并继承父会话模型上下文的快照。
Web Shell 在次要工作区也展示此操作，但 `POST /session/:id/side-task` 会返回
`non_primary_session_route_not_supported`，拒绝这些会话。

支持已信任的普通次要工作区中的侧任务。保留主工作区和内部工作区的现有行为、
对 standalone 会话的拒绝，以及 branch、fork 和切换目录的既有限制。保留
Managed 引擎和 SSH 对侧任务的既有禁用规则。

## 设计

将侧任务创建归类为 live-session-owner 作用域。使用现有的会话所有者写操作包装器，
替代仅允许主工作区或内部工作区的包装器。在所有者包装器中保留显式拒绝 standalone
的选项，仅在侧任务创建时启用。所有者解析器保留信任检查，对未知、归属不明确或
不可用的所有者直接拒绝，不回退主工作区。保留现有的归档锁、runtime 代际检查、
响应脱敏和创建失败清理。

解析所得 runtime 的 bridge 已经在其绑定工作区内创建子会话。ACP 子进程通过父会话的
session service 获取快照，bridge 在同一 runtime 中恢复子会话并记录
`sourceType: side_task` 和 `sourceId: <parent session id>`。无需新增 SDK 方法、
接口或文件系统路由。

Web Shell 已经在侧任务标签中保存所属工作区路径，并传给嵌套的 session provider，
用于加载和恢复子会话。现有的 `/workspace/:id/sessions` 列表接口会解析传入的
工作区，并按来源类型和父会话 ID 筛选；legacy URL 并不意味着只查询主工作区。
保留这些路径并增加回归覆盖。

## 影响文件与风险

生产代码修改限定在 `packages/cli/src/serve/routes/session.ts`。测试覆盖 daemon
多工作区路由，以及 Web Shell 的命令、历史列表和面板行为。主要风险是丢失
standalone 拒绝语义，或将创建、列表、恢复操作分发到其他工作区；测试必须核对
实际目标，并确认没有修改主工作区。

## 验证与验收标准

- 已信任的次要工作区父会话可创建侧任务，包括父会话正在响应时。子会话继承
  父会话上下文，并可独立继续对话。
- 侧任务属于同一工作区和父会话。关闭、重新打开和恢复后保留身份与对话记录，
  不重复创建。
- 侧任务历史列表排除其他父会话和其他工作区的任务。
- 未知、未信任、归属不明确或不可用的所有者在创建前被拒绝；runtime 失效时
  仅在解析所得的工作区内清理。
- 主工作区和内部工作区仍可创建。Standalone 仍不支持；branch、fork 和切换目录
  的限制保持不变。
- 使用全局 `qwen` 验证基线，再使用 `node dist/cli.js` 验证修改；执行构建、
  类型检查，以及针对 daemon 和 Web Shell 的单元测试。

## 未决问题

无。本次将现有侧任务接口扩展到普通次要工作区的会话所有者，不引入另一套侧任务协议。
