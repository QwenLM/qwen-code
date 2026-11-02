# 移除 Managed 会话目录切换

[English](2026-10-26-retire-managed-cwd-change.md) | [简体中文](2026-10-26-retire-managed-cwd-change.zh-CN.md)

## 问题

Managed 对话提供了普通 daemon WebShell 没有的 Change directory 操作。Workspace 与初始工作目录已经确定新会话的执行位置。用户要求移除这个额外入口，并删除没有其他业务调用方的后端提交代码。

## 决策

移除对话 UI 和 public/WebShell 两条提交 API 创建新的 Managed 会话目录切换操作的能力。全仓调用审计表明 WebShell 是仓库内唯一的生产客户端，公开 API 没有 SDK 或其他业务消费者。daemon/ACP 的 changeSessionCwd 另有 Live、standalone/恢复与子会话调用方，继续保留。

保留创建时 cwdRelative、独立布局的目录展示、上下文修订、Workspace 校验和执行绑定。主页对话不再显示额外的 Workspace/目录/模型/Runtime 摘要行，输入框保留模型选择器。既有持久化 CWD_CHANGE 操作可能跨越 UI 发布：保留记录词汇、操作查询/投影、协调器清算、恢复和准入屏障，直至原操作结算。删除不再使用的新建操作方法，不删除历史数据或悄悄取消请求。无需数据库迁移或重写历史。

## 实施与验证

删除前端控件、hook、不再使用的 provider/client 提交代码及操作文案；保留独立布局的目录展示和创建引用。删除主页摘要行及其无用样式。删除两个 Java 提交控制器映射、请求 DTO 与新建准入方法。撤销 cwdChange 能力通告，更新 OpenAPI 和生成消费者，保留通用操作查询仍使用的历史响应 schema。同步 surface/capability 契约，将过时的新建准入测试改为被移除路由与历史清算的专项覆盖。

专项计划位于 `.qwen/e2e-tests/remove-managed-directory-change/plan.md`。验证面对仍通告能力的旧服务端也不显示入口，已完成历史和创建行为保留，路由契约移除，历史操作仍能清算。完成 TypeScript 构建与类型检查，在模块预算内验证受影响 Java/契约测试，并审查完整 diff。独立构建，不影响实际预览。只刷新前端并代理原 Java 进程，只能证明 UI 行为；后端路由移除必须由匹配的新 Java 构建或隔离控制器检查验证，并单独报告。

## 范围

不移除 Workspace 本地导入、文件上传、目录浏览、工具级工作目录、daemon 迁移、历史操作记录或恢复。不新增配置、兼容转发层或替代 UI。

后续项：待历史操作清算完毕且其余消费者完成迁移后，再通过单独的契约版本变更移除已废弃、始终为 false 的 `cwdChange` 响应字段。
