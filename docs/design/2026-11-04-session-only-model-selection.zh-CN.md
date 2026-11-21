# 通过能力协商选择仅作用于当前会话的模型

[English](2026-11-04-session-only-model-selection.md) | [简体中文](2026-11-04-session-only-model-selection.zh-CN.md)

## 状态

Issue #15702 的修复原型。已发布 0.26.6 在 AWS 上的基线结果记录于本地 E2E
报告。公开参数和能力名称仍是提案，需要维护者审查。

## 问题

daemon SDK 只暴露会更新默认配置的模型选择。底层 ACP agent 已通过
`qwen.session.modelPersistDefault` 支持仅作用于当前会话的选择，并记录该选择以便
冷恢复。REST 会转发元数据，但 ACP 分发器重建模型请求时将其丢弃，因此成功的 ACP
响应可能掩盖默认配置的改变。bridge 还会为普通会话的临时选择广播工作区设置改变。

## 范围

通过类型化 daemon SDK 和两种 daemon 传输暴露现有机制。保留位置参数形式的客户端
身份、未提供选项时的行为、会话所有权、模型变更串行化和现有记录语义。不改变 Core
配置、会话文件格式、Web Shell、MCP 工具 schema 或定时任务创建。

## 设计

在 `session_set_model` 之外增加独立的 `session_set_model_transient`。SDK 在发送
`persistDefault: false` 前检查此能力；不支持的 daemon 在收到模型变更前即被拒绝。
未提供选项或显式传入 `true` 保留现有持久化行为，不要求新能力。

`DaemonClient.setSessionModel` 接受现有客户端 ID 字符串，或包含 `clientId` 和
`persistDefault` 的选项对象。会话包装层单独接受 `persistDefault`，同时保留自身的
客户端身份。

REST 将 `persistDefault` 暴露为一等布尔字段。共享 CLI 解析器将其映射到已有 ACP
元数据键，并由 REST 模型路由和两条 ACP 模型设置入口共同使用。有效旧元数据继续
受支持。类型错误及公开字段与旧元数据的冲突在调用 bridge 之前被拒绝，两种来源都
不能静默覆盖另一方。其他元数据保持不变。
仅属于 daemon 的公开字段在转发 ACP 请求前移除。

仅作用于会话的选择发送 `model_switched`，不发送工作区 `settings_changed`。
会更新默认配置的选择继续发送两类事件。顺序仍由现有会话队列负责。

新能力涉及 legacy 默认设置的持久化。Managed 对照表如实记录该 legacy 关注点，
不新增 Java API。

## 涉及文件

SDK 客户端和会话包装层；daemon 能力注册表和对照表；共享模型选项解析器；REST
模型路由；ACP 分发器；bridge 模型控制；对应测试和协议文档。

## 风险与约束

旧 daemon 可能忽略未知字段，因此能力协商失败后不允许回退执行变更。REST 与 ACP
必须校验相同的值。路径确定的会话所有者和客户端租约保持权威。模型记录本就尽力
而为，本改动不承诺切换响应返回瞬间的崩溃持久性。现有 standalone 和定时任务规则
继续适用。

## 验证与验收

- 旧调用无需预检，保持原请求体和客户端身份。
- 不支持的临时切换请求不产生任何模型变更。
- 公开字段和旧元数据在 REST、ACP HTTP、ACP WS 上一致；冲突及错误类型在变更前
  被拒绝。
- A 切换到 M1 后，B、新建的 C、用户和工作区默认配置仍为 M0。
- 真实模拟服务请求使用 M1，冷恢复后 A 仍为 M1。
- 会话事件仍可观察，不产生工作区默认配置改变事件。
- 定向单测、构建、类型检查及 AWS E2E 验证覆盖补丁。

## 待定问题

公开参数与能力名称需要维护者确认。现有 MCP 工具和 UI 保留会更新默认配置的
行为，在这些界面增加控制不属于本次改动。
