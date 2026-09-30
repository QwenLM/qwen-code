# Workspace Agent PR 堆叠边界

[English](2026-09-27-workspace-agent-pr-stack.md) | [简体中文](2026-09-27-workspace-agent-pr-stack.zh-CN.md)

## 决策

将持久化工作区 Agent 协作拆成可审查的堆叠改动：

1. Core 包中的持久化线程、消息、运行、准入和生命周期状态。
2. Agent 执行、协作工具、daemon 路由、恢复、流式事件，以及完整使用这些能力的 Web Shell 工作流。
3. A2A 外部接入。
4. 远程 Qwen、Codex 与 Claude Runtime。

第一层刻意保持为内部能力。它持久化并校验状态机，用包级测试证明行为，但不注册工具、路由、定时任务或 UI。因此单独合入不会暴露功能，也不会启动后台工作。

执行层和 Web Shell 一起交付，让审查者可以验收完整的本地工作流，而不是先审查一个没有用户入口的 API，再审查它唯一的 UI。每个后续 PR 必须基于前一层独立构建并通过定向测试。测试跟随它保护的行为移动；跨层修复归入拥有该不变量的最低层。

## 边界

基础层负责工作区身份、持久化线程记录、消息路由、准入决策、关闭义务、token/轮次计量、文件锁和搁置运行检查。它不负责模型执行、ACP 会话、HTTP 路由、浏览器组件、A2A 授权或远程主机租约。

本地协作 PR 消费这些内部 API、实际运行 Agent，并通过 Web Shell 暴露 daemon 契约。A2A PR 在这套可工作的本地能力上增加经过授权的外部接入。远程 Runtime PR 随后增加 Qwen、Codex 与 Claude 的运行时适配器。

## 合入顺序

先将基础层合入 `main`，再合入本地协作 PR。之后依次合入 A2A 与远程 Runtime 适配器。每次变更 base 后都重新运行当前提交 CI。
