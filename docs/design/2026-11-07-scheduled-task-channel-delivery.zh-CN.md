# Web Shell 定时任务 Channel 投递

[English](2026-11-07-scheduled-task-channel-delivery.md) | [简体中文](2026-11-07-scheduled-task-channel-delivery.zh-CN.md)

## 问题与范围

Issue #16516 要求开放 daemon 已有能力：将成功完成的 persistent 定时任务的最终回复发到配置的 Channel。目前 Web Shell 既不显示已保存的投递配置，也无法管理它。本次仅修改 Web Shell 类型、动作、任务表单/卡片、翻译、测试及用户文档，不改变 daemon 路由、授权、存储或投递保证。Webhook、持久化重试、失败告警及 per-run 投递仍不在范围内。

## 设计

任务读取和创建/更新请求复用 SDK 的 `DaemonChannelDelivery` 契约。更新时省略字段表示保留，`null` 表示明确清除。与现有 gate 字段一致，仅在用户实际修改后提交该字段。配置 Channel 不会自动启用任务投递。目标 ID 保持原样：表单会提示首尾空白，并提供由用户明确选择的去除操作，不会自动修改 ID。

表单提供关闭投递，或选择频道实例及用户/群目标 ID。已观察联系人仅提供可选候选，并且仅在选择投递目标后加载；标签同时展示频道名、目标类型和原始 ID，以区分同名目标。允许手工填写 ID，因为发现不是授权。即使发现失败或 daemon 不再声明投递能力，卡片仍显示保存的频道、类型和 ID。没有保存目标的卡片不显示投递行。

已配置 Channel 复用支持工作区的现有 Channel hook。为现有 observed-contacts 路由增加 Web Shell 动作，与任务变更使用同一个显式工作区 ID。仅将顶层用户和群作为候选，线程/话题不是投递目标类型。

在表单内选择其他工作区时，清除草稿投递目标及模型/会话分组选择，使旧发现结果失效，并保留名称、提示词和调度配置。编辑固定在任务所属工作区。如果外部传入的锁定工作区或主工作区身份发生变化，则关闭表单并丢弃整个草稿，避免将其保存到错误的工作区。

完成初始化的 daemon 能力响应始终在 `workspaces` 中包含主工作区，即使只有一个项目。独立托管的 WebShellWithProviders 可能收到含 `workspaceCwd`、但没有 `workspaces` 数组的启动期能力响应。将该显式主工作区 cwd 传给表单，仅用于主工作区目标的回退。其他工作区缺失或不受信任时，不能回退至主工作区。

以 `channel_delivery` 控制编辑，以 `workspace_channel_observed_contacts` 控制发现。能力丢失、频道缺失、联系人过期或请求失败均保留已保存值，显示易懂的加载、失败、空列表和不可用状态。只有成功加载的频道列表才能确认已保存的频道不存在；初始状态、加载中或请求失败均不代表频道缺失。能力丢失后不能静默忽略已修改的草稿。用户可以放弃未保存的投递修改，恢复原目标（新建任务时恢复为不投递），然后保存表单中的其他修改，而不发送投递更新。

投递要求 `persistent`，包括当前会话选项。选择 `per_run` 不会自动清除投递或改变用户选择的模式。解释限制并阻止提交，直到用户主动清除投递或选择固定会话模式。保存未修改的已有目标不依赖再次发现。

## 影响面与风险

主要影响 Web Shell 工作区动作/类型、`ScheduledTasksDialog`、应用层能力接线及中英文文案。主要风险是跨工作区的过期响应和无关编辑误清配置。发现状态须关联所属工作区，保存值须独立于发现候选。具体 Channel 目标支持最终由已有 daemon/provider 验证；catalog 不提供按类型区分的出站能力元数据。

## 验证与验收

聚焦动作测试验证路由作用域和错误处理。表单及浏览器覆盖创建、编辑、清除、已存目标往返、同名身份显示、不同频道的候选隔离、手工 ID、联系人/Channel 缺失、失败、工作区切换及过期响应、仅含主工作区 cwd 的启动期能力响应、能力开关和 per-run 限制。无投递任务保持原有请求行为，且不显示投递行。运行格式、lint、构建、类型检查及相关单元/浏览器测试。实际结果和环境限制写入本地 E2E 报告与 PR 草稿；不根据模拟浏览器测试宣称平台真实收到消息。

## 待定事项与后续工作

没有阻塞实现的问题。送达保证、持久化重试和失败告警仍属于独立工作。

## 浏览器证据

通过仓库 Playwright 测试环境及拦截的 daemon 响应验证：[修改前](assets/scheduled-task-channel-delivery/before.png)、[投递表单](assets/scheduled-task-channel-delivery/after-details.png)、[保存后的任务](assets/scheduled-task-channel-delivery/after-card.png)及[移动端限制和长 ID](assets/scheduled-task-channel-delivery/mobile.png)。这些截图展示 UI，不代表真实平台收件。

针对打包后的 CLI 的浏览器验证还覆盖了[明确去除首尾空白](assets/scheduled-task-channel-delivery/after-whitespace.png)及[清除投递后的卡片](assets/scheduled-task-channel-delivery/after-cleared-card.png)。
