# Hosted Harness Session 模块拆分

[English](2026-11-25-hosted-harness-session-module-split.md) | [简体中文](2026-11-25-hosted-harness-session-module-split.zh-CN.md)

## 当前结构

`hosted-harness-session.ts` 有 15,614 行。路由注册函数管理驻留会话表、实例排空、会话打开和大多数 Hosted Session 端点。共享闭包使各功能依赖的状态难以辨认。

## 模块边界

保留现有的路由注册入口，由它管理驻留会话表和实例排空，并按原顺序注册各功能路由。每个注册函数接收会话表及其实际使用的依赖。会话打开与暂停共享打开状态。Runtime 归还把拒绝记录保存在单次注册的作用域内。

提取会话打开、空闲暂停、Workspace 恢复和 Runtime 所有权模块。分开 Turn 执行、取消、Runtime 接管、唤醒恢复和唤醒调度器初始化。其余端点按生命周期、配置、会话交互、事件与状态查询、自动化归组。需要共享会话状态和通用 HTTP 函数的模块可直接引用它们。

## 兼容性与验证

保留现有导出、中间件与路由顺序、请求与响应契约、授权规则，以及驻留状态、重试保护和定时器的生存期。拆分限于 CLI daemon 内部。保留现有测试 fixture，使用 Hosted Session 测试及调用方测试验证现有行为。运行仓库构建和类型检查，并把迁移后的函数体及路由注册与原始源码对比。
