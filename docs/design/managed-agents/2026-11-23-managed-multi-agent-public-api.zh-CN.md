# Managed Agents 多 Agent 公共 API

[English](2026-11-23-managed-multi-agent-public-api.md) | [简体中文](2026-11-23-managed-multi-agent-public-api.zh-CN.md)

## 状态与目标

这是 [#13785](https://github.com/QwenLM/qwen-code/issues/13785) 的总设计草案，供维护者讨论。目标是让客户端知道哪个 Agent 产生了输出、断线后能重建任务树和团队名册，并能在授权范围内对指定任务或审批采取操作。编排和团队创建继续由模型与现有运行时承担，公共 API 负责投影执行事实和接收受授权的干预。

总设计定义各步共用的契约、依赖和上线条件。已推到 fork 的 [Legacy Agent Team 门禁](2026-11-21-agent-team-host-gate.zh-CN.md) 是 M4 的第一个交付切片，详细设计和实现保留在那里。

## 当前基础

- **Managed 公共契约。** 上游 `main` 在 `1158b9bd5da2` 的 OpenAPI 版本为 `1.125.0`。已有 `child_agents` 能力、`PublicTask.child_session_id`、任务列表／详情／事件／取消和 Action 响应。事件、消息项、任务事件和 Action 来源仍缺少 typed `agent`，任务没有 `parent_task_id` 和 `depth`，团队和成员查询、`multi_agent` 与任务输入路由也未声明。[`managed-agent-public-api.openapi.json`](https://github.com/QwenLM/qwen-code/blob/1158b9bd5da262df920ba0fe67d03e5c555aa8e4/packages/managed-agent-server/contracts/src/main/resources/openapi/managed-agent-public-api.openapi.json)
- **Hosted 运行时。** 子任务已经有持久化 `child_run` 记录，团队运行时已能从持久化 `team_state` 读取名册，并通过 `teamsAdmitted()` 决定是否声明团队工具。H4d 已经实现父子 Session 间的持久消息。它们分别为执行身份、任务树、名册和输入投递提供实现基础。[Hosted 团队设计](../2026-10-10-managed-agent-teams.zh-CN.md) · [H4d 消息运行时设计](../2026-10-10-managed-session-message-runtime.zh-CN.md) · [#13744](https://github.com/QwenLM/qwen-code/issues/13744)
- **Legacy 与 ACP。** fork 上的 Legacy 门禁在首个 `Config.initialize()` 接收 `agentTeamHostSupported`，并与实验开关、沙箱条件一起控制注册。ACP 已有角色路径型归因。开放中的 #15658 接入队友报告和会话级审批，叠在它上面的 #15659 增加增量名册和展示用活动帧。公开执行 ID 与可独立查询的权威名册仍由本路线交付。[Legacy 门禁](2026-11-21-agent-team-host-gate.zh-CN.md) · [ACP 身份设计](../2026-10-11-agent-team-identity-projection.zh-CN.md) · [#15658](https://github.com/QwenLM/qwen-code/pull/15658) · [#15659](https://github.com/QwenLM/qwen-code/pull/15659)

## 共用契约

- **身份与导航。** 投影器从已提交的运行记录派生 typed `agent`，用 `id` 关联一次执行，用 `parent_id` 表达归属，用 `kind` 和 `depth` 表达类型与层级。`path` 由投影器派生，可用于显示。同名并发、重载和回放必须得到正确的执行身份。沿用 `PublicTask.id` 作为任务地址、`child_session_id` 作为导航链接，`PublicSession.agent_id` 继续指向 Agent 定义。`agent.id` 的命名空间、跨 Session 续跑的身份边界和所有权变化时的历史语义，由 M1a 与 M2 一起确定。可选 `phase` 留给 M1 的详细设计，在有可靠来源时再公开。
- **读取与回放。** 任务终态、当前所有权、团队名册和可持久化消息的来源由已提交记录确定。查询、恢复和回放可在冷 Session 中完成。缺少可靠来源的历史数据省略新增归因，保留原事件和游标。模型文本、角色名和通知正文无法设置契约身份。
- **能力与授权。** 工具注册取决于宿主的实际能力。公共能力描述当前 Session 可用的 API，调用方能否读取或干预沿用相应路由的授权检查。Action 继续使用 D6 的请求 ID、所有权和响应规则。状态查询沿用 Session 的可见性边界。

## 五步交付

| 顺序                        | 交付内容                                                                                                                                                                                                                                                                                                                                                | 验收条件                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · M4 Legacy 工具门禁      | 已在 fork 实现。按宿主声明控制团队工具和 `Agent` 的团队专用参数。#15658 后续通过客户端协商并验证报告和审批链路后，在新建、加载和恢复共用的入口声明支持。                                                                                                                                                                                                | 检查模型实际收到的工具声明。已支持的 Ink 和非交互 CLI 保持可用，未声明支持的宿主即使开启实验功能也只收到普通 Agent。ACP 启用时验证完整报告和审批往返。                                         |
| 2 · M1a 普通子 Agent 身份   | 从 `child_run` 投影根与子 Agent 身份，在 `PublicEvent`、`PublicItem`、`PublicTaskEvent` 和 `ActionSource` 中以可选 typed `agent` 输出。同步 Web Shell 与生成类型，按各表面已有的版本契约处理变更。在路由与请求契约确认后，可以同时将任务输入声明为 `planned`。                                                                                          | 两个同名子 Agent 的输出和审批归属可区分。实时读取、查询与按游标回放的身份一致，旧记录和旧客户端仍可读取。终态可从已提交记录重建。此步只投影根和普通子 Agent。                                  |
| 3 · M2 任务树               | 把已提交的子运行父链投影为 `PublicTask.parent_task_id` 和 `depth`，保留 `child_session_id`。默认保持现有 Session 分页范围，单独确定多层后代的枚举范围、跨页关系及一致性保证。投影与开放多层启动分别验收。                                                                                                                                               | 不使用标题或角色名也能连接实际存在的父子任务。分支、缺失父节点和跨页链接有明确行为。若运行时支持转移归属，当前任务树跟随权威记录，历史事件按 M1a 的契约保留归因。                              |
| 4 · M1b + M3 团队身份与名册 | 在明确持久化成员标识和读取边界后，从 `team_state` 等记录投影团队与成员。以 `planned` 先声明 `GET …/teams`、`GET …/teams/{teamId}`、`GET …/teams/{teamId}/members` 及 Web Shell 对应路由，并评估复用 #10078 的读取接口。成员状态沿用已有任务生命周期的词汇。可查询名册与 `kind: teammate` 一起上线，持久消息增加发收方归因，支持的成员审批附上同一身份。 | 晚接入、重连和冷查询能恢复当前名册而不唤醒模型。在事件保留期内，成员离开后仍能解析历史事件里的引用。重名成员、幽灵成员、终态和权限边界均有可验证的行为。                                       |
| 5 · M4 公共能力与定向干预   | 定义 `SessionCapabilities.multi_agent`，以及 daemon 在 `Capabilities.features` 中公布 `multi_agent` 的条件。复用现有 Action 响应和任务取消。任务输入先约定 `POST …/tasks/{taskId}/input`，为有实际投递链路的对象启用 `send_input`，优先验证 H4d 能否支撑普通子任务，再独立验证团队成员。                                                                | 能力位和 `send_input` 对应可用的实现。输入返回明确的接收、排队或拒绝结果，重试不会重复投递，已接收输入可追踪到投递或明确终态。授权检查能拒绝越权请求，取消一个子任务不会误停父任务或同级任务。 |

第 1 步与公共契约开发独立。第 2 步现在即可进入详细设计，M2 的树查询语义可并行设计。名册和成员归因同批开放，保证客户端能解析成员引用。公共能力和输入路由也可提前定契约，按各对象实际具备的能力逐项启用。OpenAPI 先声明的 `planned` 路由在实现就绪时才注册，届时同步公共 API、Web Shell 和生成客户端类型。[#13785 的里程碑和验收](https://github.com/QwenLM/qwen-code/issues/13785) · [#10078](https://github.com/QwenLM/qwen-code/issues/10078)

## 整体验收

使用同一个 Managed Session 启动两个同名的子 Agent。让其中一个等待审批，另一个先完成。断开客户端后重新连接，从已有游标回放并查询任务树，确认执行 ID、子 Session 链接、审批归属和终态仍一致。按已启用的能力对目标子任务回应、输入或取消，检查另一个分支未受到影响。在团队版本中追加一次离队和一次不唤醒模型的名册查询，验证历史引用仍能找到对应成员。按各层分开验证契约、投影与真实宿主接线。
