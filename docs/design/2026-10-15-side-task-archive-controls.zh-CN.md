# 侧边任务归档入口

[English](2026-10-15-side-task-archive-controls.md) | [简体中文](2026-10-15-side-task-archive-controls.zh-CN.md)

## 状态

本变更已完成实现；验证结果记录在 Pull Request 中。

## 问题

实时子进程被回收后，已完成的 `side_task` Session 仍会因为持久化 transcript 保留在活跃 Session 目录中，因此持续出现在 Web Shell 的侧边任务菜单里。Daemon 已支持可恢复的 Session 归档操作，但该菜单没有暴露入口。长期运行的协调 Session 会不断积累已完成 thread，用户只能重启 daemon 或关闭父 Session 来清理列表。

## 目标

- 允许用户从菜单中归档单个已完成侧边任务。
- 允许用户一次归档当前全部已完成侧边任务。
- 从活跃列表移除归档成功的任务，并关闭其已打开的面板标签。
- 允许用户从同一菜单恢复已归档侧边任务。
- 保护仍在运行、状态未知或不支持状态判断的工作，避免被归档。
- 在现有归档路由上增加原子空闲校验，并通过独立能力标签供兼容客户端识别。

## 范围边界

本变更不新增自动 TTL 保留策略、新的 daemon 路由、数据库迁移或 transcript 删除。归档后的侧边任务仍可通过侧边任务菜单中的“已归档”子菜单恢复。TTL 策略继续作为 #14289 中 managed child-session 生命周期工作的后续项。

## 设计

活跃侧边任务目录继续使用 `ArtifactPanel` 现有的小型展示模型，并增加从权威 Session summary 派生的 `archivable` 判定。只有在没有活跃 prompt、没有运行中的后台任务，且 active-work 观测为 `idle`，或因为实时子进程已被回收而缺失时，任务才允许归档。明确的 `active`、`unknown` 与 `unsupported` 状态全部按不可归档处理。

当现有归档路由支持 `requireIdle: true` 时，daemon 声明 `session_archive_idle_guard`。归档前，所属 bridge 会在把 Session 标记为 closing 的前一刻检查 active-work 快照。仍在运行、状态未知或不支持判断的工作会失败，不会关闭 Session，也不会移动 transcript。实时子进程已回收时没有 bridge 条目，仍可沿用现有持久化 Session 归档路径。这个写入时校验可以阻止任务在列表快照之后恢复运行却仍被归档。

仅当 daemon 同时声明 `session_archive` 与 `session_archive_idle_guard` 时，每个任务入口才显示“打开/归档”子菜单，任务列表同时显示“归档已完成任务”。两个入口共用同一个批量回调，以 `requireIdle: true` 调用现有归档路由。

归档与恢复都必须带上 Workspace 限定。两个回调会先按任务自身的 `workspaceCwd` 分组，再通过对应 Workspace 的客户端调用 `/workspaces/:workspace/sessions/archive`（或 `.../unarchive`）；没有记录 Workspace 的 id 继续走原有未限定调用。未限定路由会按 primary workspace 目录解析 session id，因此缺少这一步时，属于普通 secondary workspace 的侧边任务只会返回 `notFound`，其 transcript 不会发生任何状态迁移。

归档成功与已经归档的任务会离开活跃列表；`notFound` 不会——任务继续留在列表中，并把该 id 作为单项错误通过现有 Web Shell 错误界面展示，因此 UI 绝不会为 daemon 没有真正执行的操作清理状态。当 daemon 声明 `session_archive` 时，同一菜单会列出当前父 Session 的已归档侧边任务，并通过带 Workspace 限定的 unarchive 路由恢复。两个路由都支持安全重试。

归档结果会先让旧的目录请求失效，再发起一次新目录请求；同时从当前面板、按 Session 保存的内存状态、延迟恢复列表和浏览器持久化状态中删除已归档的侧边任务标签。一个内存删除集合会阻止已经开始的面板恢复流程重新加入这些标签；用户之后显式打开已恢复的任务时会清除对应标记。

## 验证计划

- 单元测试已完成与实时工作状态的分类边界。
- 单元测试单项、批量、禁用、恢复、能力门禁、旧列表响应、部分成功和已保存标签行为。
- 单元测试 bridge 原子空闲检查、daemon 路由校验、归档结果与 SDK 请求体。
- 运行 Web Shell 定向测试、typecheck、lint 与 format 检查。
- 驱动真实 `qwen serve` Web Shell：创建已完成和运行中的侧边任务；归档单个已完成任务；批量归档其余任务；确认运行中的工作保留；恢复一个已归档任务，并确认它重新出现在活跃菜单中。

## 验收标准

- 未同时声明 `session_archive` 与 `session_archive_idle_guard` 时不显示归档操作入口。
- 无需重启 daemon 或关闭父 Session，即可归档已完成侧边任务。
- “归档已完成任务”移除全部符合条件的任务，并保留实时或状态不确定的工作。
- 归档失败的任务继续保留在列表中，并显示可见错误。
- 已归档任务出现在侧边任务菜单中，并可恢复。
