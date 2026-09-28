# Workspace Agent PR 堆叠边界

[English](2026-09-27-workspace-agent-pr-stack.md) | [简体中文](2026-09-27-workspace-agent-pr-stack.zh-CN.md)

## 决策

将持久化工作区 Agent 协作拆成可独立构建的堆叠改动：

1. Core 包中的持久化线程、消息、运行、准入和生命周期状态。
2. Agent 执行、协作工具、daemon 路由、恢复和流式事件。
3. Web Shell 中的 Agent 列表、协作对话、路由和活动界面。
4. A2A 外部接入与远程 Runtime 作为两个并列的后续 PR。

第一层刻意保持为内部能力。它持久化并校验状态机，用包级测试证明行为，但不注册工具、路由、定时任务或 UI。因此单独合入不会暴露功能，也不会启动后台工作。

每个后续 PR 必须基于前一层独立构建并通过定向测试。测试跟随它保护的行为移动；跨层修复归入拥有该不变量的最低层。

## 边界

基础层负责工作区身份、持久化线程记录、消息路由、准入决策、关闭义务、token/轮次计量、文件锁和搁置运行检查。它不负责模型执行、ACP 会话、HTTP 路由、浏览器组件、A2A 授权或远程主机租约。

执行 PR 消费这些内部 API，并成为首个可以实际运行 Agent 的层。Web Shell PR 只展示已可用的 daemon 契约。A2A 与远程 Runtime 都依赖 Web Shell/执行链，但彼此不依赖。

## 合入顺序

先将基础层合入 `main`，再把执行 PR 改为基于 `main`，随后合入 Web Shell PR。UI 层合入后，再调整并协调 A2A 与 Runtime 两个并列 PR。每次变更 base 后都重新运行当前提交 CI。
