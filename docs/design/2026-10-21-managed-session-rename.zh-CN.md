# Managed 会话重命名

[English](2026-10-21-managed-session-rename.md) | [简体中文](2026-10-21-managed-session-rename.zh-CN.md)

## 问题与当前行为

Managed WebShell 会显示 Session 标题，但无法修改。新建空 Session 因而一直以
自动生成的 ID 作为可见名称。Java 服务已经实现了带授权检查、幂等与版本保护的
Session 重命名，并持久化 Harness 确认的标题。Daemon WebShell 已有手动重命名，
其中 standalone Session 使用小型弹窗。

## 方案

将现有 standalone Session 改名表单提取为共享 `SessionRenameDialog`，供 daemon
standalone 最近会话与 Managed 共同使用：Enter 保存，Escape 或取消按钮关闭，
空白名称不能保存，输入最多 256 个 UTF-16 代码单元。Managed 在当前标题旁提供
重命名入口，双击标题也可打开相同编辑器。请求进行中不能重复提交。

新增可选 provider 方法 `renameSession(sessionId, displayName, options)`。
Java provider 将 `displayName` 映射为后端的 `title` 字段，并返回服务端确认的
名称。动作名称与手动改名语义和 daemon 一致，同时保留 Managed 自身的传输与
Session 归属边界。

新增针对所选 Session 的 WebShell 路由
`POST /api/agent/web-shell/v1/sessions/rename`，接受 `sessionId`、`title`、
`idempotencyKey`，直接调用现有 `ManagedAgentService.renameSession`。
返回包含 `sessionId`、`title`、`replayed` 的小型结果，直接由 mutation 结果
投影，不再执行第二次可见性查询。同步更新规范 OpenAPI、生成的客户端类型、
surface registry 与契约测试。本地前门继续只暴露现有 WebShell 接口范围。

在 Session 摘要中提供独立的 rename capability，沿用现有服务的授权与运行时
支持条件。缺失 capability 时，Managed 不提供改名编辑器。不能用 `canSend`
推断改名权限：存在正在执行的 Turn 本身不妨碍改名。

## 状态与失败处理

收到确认成功后才更新所选摘要与导航名称。成功后刷新列表，并使确认之前开始
的标题读取失效，避免延迟快照恢复旧名称。将 `session.updated` 投影为摘要刷新
事件，使其他客户端的改名也能显示出来。手动刷新导致摘要暂时为空时，仍保留
已经确认的名称。

每次编辑和请求绑定 provider 与 Session。切换 Session 或 provider 时关闭该
编辑器；旧响应不能改动新选中会话的名称、关闭新编辑器或向其显示错误。同一
提交名称重试时保留原幂等键；修改名称后视为新意图。错误显示在编辑器中，不
宣告改名成功。
提交后关闭编辑器只关闭界面，不取消已接入的改名；延迟结果只在原 Session
仍被选中时应用。

现有 Java mutation 在确认 Harness 持久化与 SQL 落定后才返回 HTTP 200。
HTTP 503 或连接断开可能意味着结果未知，重试相同名称时复用原 key。此次不
引入乐观成功、后台 operation、数据库旁路写入或恢复修复。既有授权与删除后
重放语义继续生效。

## 涉及范围与边界

修改限于共享弹窗及其 daemon standalone 调用方、Managed UI/provider/client
与摘要和事件同步、Java WebShell 适配与 capability 投影、API 契约和聚焦测试。

自动命名与 daemon 的 `/rename --auto` 命令委派不在本次范围。重命名不修改
Session ID、Workspace 名称、提示词草稿、执行中的 Turn、凭据或 Workspace 项目文件。
不需要数据库迁移或新增依赖。

## 验证与验收标准

E2E 计划位于 `.qwen/e2e-tests/managed-session-rename.md`。基线使用全局安装的
CLI 及隔离的旧轻量发行包。修改后使用匹配的新 CLI 和 Java runtime，在隔离的
本地存储上验证，并包含真实浏览器 UI。

- 新建空 Session 和存在活动 Turn 的 Session 均可改名；确认的名称出现在标题、
  导航和后续 API 查询中。
- Enter 保存；提交前按 Escape 或取消保留原存储名称；空白名称不提交。共享的 daemon
  弹窗保留相同行为。
- 刷新页面与重启后保留新名称。
- 非法名称、无权限调用、不支持的 runtime 和未知结果不会造成假成功；同一
  意图的重试复用原 key。
- 延迟摘要、列表或请求响应不能回退已确认名称，也不能影响其他所选 Session
  或 provider。
- 新路由满足规范 API、surface admission 以及既有改名授权与幂等契约。

## 待确认问题

无。实现与验证结果另行记录，本设计不代表尚未测试的 runtime 或操作系统路径
已经验收。
