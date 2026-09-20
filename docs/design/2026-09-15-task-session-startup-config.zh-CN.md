# 新建会话时选择模型与思考强度

[English](2026-09-15-task-session-startup-config.md) | [简体中文](2026-09-15-task-session-startup-config.zh-CN.md)

跟踪：[#11944](https://github.com/QwenLM/qwen-code/issues/11944)，独立 PR 4。
状态：已在本分支实现，尚未合并。基线：`39b22efb6f`（2026-09-20）。

## 目标

外部调用方可以指定模型和思考强度发起新会话，效果等同于用户在输入框中选择后发送提问。
创建操作只设置本会话，不保存共享默认值。后续提问、人工切换、reload、fallback、skill 和恢复沿用普通会话行为。
首轮结束后不会自动清除选择。

## 契约

普通及 standalone 创建接受可选的 `startupConfig: { modelServiceId, reasoningEffort? }`。
`modelServiceId` 必填，`reasoningEffort` 可选。省略时只选择模型，不调用思考强度 setter，也不自动补 `default`，因此支持没有思考强度控件的模型。显式思考强度复用现有 `ReasoningSelection`，包括 `default`、`none`，
校验和应用语义与输入框一致。拒绝未知字段、同时提供旧的顶层 `modelServiceId`、显式
`sessionScope: 'single'`。普通会话的启动配置隐含 `sessionScope: 'thread'`。省略对象完全保留旧 API。

daemon 声明 `session_startup_config` 能力。TypeScript SDK 检查能力并支持 REST 与 daemon ACP HTTP/WS 映射。
直接子进程 ACP、load/resume 和 `create_sub_session` 工具 schema 不在本 PR 范围内。

成功返回 `modelApplied: true` 和 `startupConfigApplied`，描述当前规范模型选择符；仅显式请求思考强度时才包含请求档位及实际思考状态。
仅指定模型时，`startupConfigApplied` 只返回已确认的模型选择符，不声称应用过思考强度选择。
这表示启动准备完成，不代表整个生命周期内不可变。结构错误在任何工作区变更之前拒绝。
不合法的选择使创建失败，不允许初始提问使用不同配置执行。
认证、归属、超时与结果不确定错误保留既有语义。

## 实现

当前 UI 先创建并 attach 普通会话，再设置模型、设置思考强度，最后发送 prompt。
复用这些已有 setter，关闭模型持久化并使用 reasoning `persist: false`。

普通 bridge 创建在返回之前应用并确认组合。standalone 在 managed binding commit 完成延迟认证后、
release 和首条 prompt 放行前准备组合。准备失败沿用已有的本次会话清理，不关闭共享子进程里的其他会话。
启动选择只发送会话状态变更，不发送共享 `settings_changed` 事件。

复用模型路由解析和 config-option 返回值进行确认，不引入第二套 provider reasoning 模型。
所有 daemon 路由继续使用已解析的 workspace runtime 和 owner。

## 范围取舍

本文替代 issue #11944 中先前的生命周期隔离提案。
不引入 `startupPinned`、持久策略记录、recording schema 变更、严格恢复协议、fallback 限制、变更门禁或 UI 修改。
不承诺在 `Config.initialize` 或初始认证前选择路由；准备顺序与现有 UI 相同。
本次启动操作不修改共享默认设置；之后人工操作保持现有持久化语义。其他三个 PR 不是依赖。

## 验收

- 比较输入框等效准备流程与新创建 API 的实际 provider 请求，包含工具循环的后续请求。
- 覆盖不支持思考强度控件的模型仅指定模型创建、显式档位、`default`、`none`、不支持的选择，以及共享为 `none`、请求为 `high`。
- 验证 standalone commit → 配置 → release → prompt 顺序；准备失败时 prompt 次数为零。
- 验证用户/工作区设置和兄弟会话不变、不产生默认值变更事件、第二轮和人工修改沿用现状、legacy 创建兼容。
- 覆盖旧 daemon、非法请求、工作区归属、断连和清理失败。
- 运行 build、typecheck、bundle、聚焦包测试及 E2E；区分受控 provider 与真实外部 provider 验证证据。
  完成两轮连续干净的完整 diff 自审。
