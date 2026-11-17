# Managed Agent 事件流精简

[English](2026-10-31-managed-agent-stream-simplification.md) | [简体中文](2026-10-31-managed-agent-stream-simplification.zh-CN.md)

状态：已实现；针对性本地验证记录见下文。更新后 PR 版本的验收仍待 CI。

## 问题与范围

Public 与 WebShell 的 Session 事件流重复维护回放、实时投递、心跳、权限复查和终止循环。在现有 Maven 边界内共享该循环，同时保留两种线上消息投影。

Session 创建入口收敛已由上游 [PR #15955](https://github.com/QwenLM/qwen-code/pull/15955) 合入。当前 PR 沿用现有 `SessionCreationCommand`、具名 builder 及继承后的单入口契约门禁，不修改它们。Session 创建、SQL、仓库角色、provisioner、恢复状态机和摘要工具不在剩余差异内。

## 设计

保留两个入口及其同步 Session 可读性准入。通过事件和重新同步消息的转换函数委托给一个私有循环。事件标识、类型和删除判断使用原始事件记录。保留 Public 的秒级、WebShell 的毫秒级投影及各自的重新同步记录类型。

保持先订阅后回放的顺序，以及分页、溢出协调、心跳调度、权限复查时机、中断处理和完成回调的位置不变。重新同步帧不得携带 SSE ID。不引入公开流式抽象，不改动事件中心、HTTP/OpenAPI 契约、SDK 请求或持久化数据。

## 验证与验收

遵循模块 AGENTS.md 的验证策略，复用适用证据。选择事件流权限、回放、重新同步、投影及 API 契约检查。回放/实时投递与 Public/WebShell 组合的参数化测试，除了消息类型、顺序、时间单位和删除终止，还必须断言 SSE ID 和事件名。修改回放帧 ID 或事件名必须导致这些断言失败。

验收要求为一个共享循环、针对性检查通过、线上行为一致，以及连续两轮自审无新问题。完整 Java/SpotBugs 和必要集成 profiles 仍由 CI 承担；跳过的 profiles 不构成验收证据。当前无未决设计决策。

## 证据

原始版本的选定事件流检查，已在记录的 808 用例本地验证和 52 用例 rebase 后运行中通过。维护者另行报告：在回放、分页、实时投递、溢出、游标过期、撤销访问和心跳的十四个组合中，base/head 消息帧逐字节一致，但修改帧 ID 的变异仍能通过已提交的测试。新增断言补齐了两种消息投影下回放和实时投递的这一覆盖缺口。

在 macOS、JDK 21.0.8 和 Maven 3.9.14 下，rebase 到 `cca888dfcc` 后的 63 个选定事件流、回放、API 及继承的创建契约用例全部通过，reactor 编译和 Checkstyle 通过。分别将回放帧 ID 加一、替换事件名时，Public/WebShell × 回放/实时投递的四个组合均按预期有两个失败。逐字节恢复生产源码后，21 个事件流用例及 Checkstyle 再次全部通过。此前创建/MySQL 证据属于已被上游替代的创建切片，不用于证明本次仅涉及事件流的差异。
