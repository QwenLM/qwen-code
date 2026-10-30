# 按会话选择 Skill 和 Extension 刷新

[English](session-targeted-refresh.md) | [简体中文](session-targeted-refresh.zh-CN.md)

## 问题与当前行为

Extension REST 刷新可以选择 workspace runtime，但会刷新其中全部活动会话。Skill 刷新目前是 ACP workspace 命令，同样刷新全部会话。Skill 启停和自动协调继续负责各自现有的刷新行为。调用方需要一个能选择会话的显式刷新操作，同时保持现有调用方的行为。

## 契约与范围

显式刷新接受可选 `sessionIds`。省略时保持全量刷新。传入数组时只选择其中的活动会话，按请求顺序去重；`[]` 表示不选择任何会话。参数形状不合法时返回 HTTP 400。未知 ID（包括属于其他 workspace 的会话）在开始刷新前返回 HTTP 404。ID 只能通过选定 runtime 的 bridge 解析，不允许回退到 primary runtime。

新增 `POST /workspace/skills/refresh`（legacy-primary）和 `POST /workspaces/:workspace/skills/refresh`（selected-runtime）。两者返回现有 Skill 刷新计数，使用 `reason: all`。现有 Extension 刷新路由保留同步或异步响应契约，接受相同的可选字段。所有路由保留严格 mutation gate、信任检查和客户端身份校验。

新增 `workspace_session_refresh` capability，涵盖新 Skill 路由和 Extension 刷新的会话选择能力。SDK 在发送指定会话的刷新前检查此 capability，避免旧 daemon 静默忽略过滤条件并刷新全部会话。现有 Extension SDK 调用保留原有参数和请求行为，可选会话选择作为附加参数。新增 Skill SDK 方法暴露显式刷新。

## 分层实现

REST 在提交工作前验证请求形状与会话归属。Workspace service 和 Extension operation controller 透传选择条件。Extension bridge 在现有 bootstrap 去重、逐会话刷新、重试和事件处理之前筛选会话记录。计数描述选中的会话；workspace 事件仍是 workspace 范围的通知。HTTP 接收请求时检查会话归属。如果选中的 Extension 会话在排队期间关闭，执行时将其计入失败并继续刷新其余选中会话。请求携带非对象 JSON 时，在任何刷新前拒绝。

Skill ACP 命令接受 `sessionIds`，在重载设置或缓存前验证全部选中的本地会话。Bridge 收到指定会话的 Skill 刷新时，按会话所属 channel 分组，只向这些 channel 调用命令。该路径绕过常规 workspace-change 广播，避免刷新未选中的 execution engine。省略字段时的路径保持不变。各 channel 的结果计数合并，channel 失败计入该 channel 选中的会话数。

指定会话的刷新可能更新目标 channel 共用的 bootstrap/catalog 缓存。选择条件控制立即执行的会话刷新和命令通知，不创建会话级启停策略，也不冻结共享配置。

## 协调与兼容性

带有 `sessionIds` 的 Extension operation 永远不推进 runtime 范围的 applied generation，即使传入列表恰好覆盖全部当前会话。现有全量 generation reconciler 保持不变，之后仍可能刷新其他会话。此显式请求不更新 Skill coordinator 的 revision 或 readiness；自动协调仍覆盖整个 runtime。

Web Shell、Skill 启停请求、安装/删除操作和自动刷新调用方保持不变。本次不在 HTTP 启停请求体中增加 `refreshRuntime`，也不解耦旧 Skill 启停接口。

## 受影响的组件

- CLI 刷新路由、共享请求校验、workspace service 和 Extension operation controller。
- ACP bridge 的刷新选择和 Skill 所属 channel 路由。
- ACP Skill 刷新处理器。
- TypeScript daemon SDK、capability 注册表和 daemon 协议文档。
- 定向路由、bridge、ACP 和 SDK 测试。

## 验证与验收标准

- 省略 `sessionIds` 时保持全量刷新和现有响应契约。
- 从多个会话中选择一个时，只刷新该会话，包括跨 execution engine 的情形。
- 重复 ID 只刷新一次；`[]` 不刷新会话或 bootstrap。
- 参数不合法、未知或跨 workspace 的 ID 不产生刷新副作用。
- Extension 部分刷新不推进 workspace applied generation。
- 现有 bootstrap 去重、失败计数和协调测试继续通过。
- SDK 序列化与 capability 检查阻止向旧 daemon 发送指定会话的刷新。
- 完成 build、typecheck、定向单元测试、基线/本地 daemon HTTP 检查和两次干净的自审。

## 开放问题

无。选择条件只影响显式刷新；现有启停和自动协调行为仅纳入回归验证。
