# Daemon 回放接口的 summary 投影

[English](replay-summary-api.md) | [简体中文](replay-summary-api.zh-CN.md)

## 问题与范围

Web Shell 主界面只展示顶层 Agent 卡片，但 prompt 事件流与历史响应中包含大量
subagent 详情。第一个 PR 增加 summary 投影，保留现有内存回放生命周期。
第二个 PR 基于它，将已保存历史改为 JSONL 分页读取。

## 接口行为

所有模式默认 `full`。prompt 的 `eventDetailMode: "summary"` 在进入 ring buffer、
SSE 推送和回放引擎之前过滤事件。被过滤的事件不占用 SSE ID。
模式在该 prompt 执行期间作用于会话事件，结束时恢复为 `full`。如果 subagent
在发起它的 prompt 结束后继续运行，其事件使用发布时的模式：空闲时为 `full`，
新的 prompt 开始后使用新 prompt 的模式。daemon 不按 subagent 保存发起时的模式。
同一会话的订阅者共享这个选择，之后无法从 ring buffer 找回已过滤的详情。

load 的 `liveReplayMode: "summary"` 选择精简 live journal。
`compactedReplayMode: "summary"` 精简 load 的 `compactedReplay`，以及两条
transcript 分页接口的 `events`。这些读取选项不修改已存历史或其他调用者的 full 响应。
Web Shell 使用这三个模式，包括向前加载历史的导航请求。

summary 保留主会话内容、顶层工具、Agent 状态与最终结果、主模型 usage。
过滤 subagent 的嵌套文本、thinking、工具、usage 和纯进度帧，并移除 Agent 的
prompt、内嵌工具调用和执行中的 token 计数。终态 Agent 结果保留 `tokenCount`
和 `executionSummary` 的 token 汇总（包括失败、取消），供轮次统计计入 subagent
消耗。不新增独立汇总 usage 事件，沿用工具 ID 去重，避免重复回放再次累加。
任务状态优先于工具状态，因为后台启动工具返回时，Agent 可能仍在执行。
subagent 详情仍可通过独立视图获取。

daemon 投影是公开数据契约：保留 Agent 最终结果，移除 prompt。Web Shell
在此基础上再做主卡片投影，省略结果正文；如果收到的事件仍带 prompt（例如按 full
模式发布的迟到事件），则保留有长度上限的预览。预览只用于描述兜底，不是 summary
接口保证提供的字段。独立 subagent 详情视图请求 full 数据，两层投影无需拥有相同字段集。

summary 模式下，Agent 卡片不显示执行中持续变化的 token 徽标；该 Agent 完成、失败
或取消时，最终汇总才可用，此时主 turn 可能仍在处理中。

mid-turn 消息携带的 `eventDetailMode` 随队列保存，并传入提升后的 prompt，
包括附件回退路径。消息在当前轮被消费时，不改变当前轮模式。省略表示 full；
消息仍在队列或提升后的 prompt 尚未结束时，同 ID 重试也必须匹配有效模式。
模式属于请求内容身份的一部分：接受不同模式的重试，等于确认了一份 daemon
实际上没有保存的请求内容。
REST 空闲拒绝语义保持不变。daemon ACP 的 `session/prompt` 接受相同的顶层可选扩展，
转发给子进程前移除。它影响会话共享事件流，不是单个订阅者的渲染偏好。
公开 OpenAPI 和协议参考应同步描述 load、transcript、prompt 的选项和错误。

## 边界与取舍

本 PR 保持现有含义：`liveJournal` 是当前未结束轮次，`compactedReplay` 是内存中
压缩后的已结束轮次，或恢复时读取的历史页。终止事件仍会触发内存轮次压缩。
不增加持久化 UUID 或 ACK 依赖，现有裁剪限制保持不变。

选页仍发生在 summary 过滤之前，因此返回的可见内容可能少于请求页大小。
按可见回放记录计数留在第二个 PR。summary 减少 prompt 详情的内存保留量与响应体积，
但单独不能消除长轮次裁剪或已完成历史的内存增长。

## 验证与验收

验证默认 full、非法模式拒绝、入 ring 前过滤、SSE ID 连续、prompt 模式复位、
full/summary load 响应相互独立、两条 transcript 路由，以及 Web Shell 更早分页参数。
确认不依赖持久化 ACK，已完成轮次仍可从内存回放。使用包内单测和隔离的真实 daemon，
模型提供方使用模拟服务；模拟的是模型响应，daemon 路由和事件保留逻辑是真实实现。

评审验收包括 REST prompt 模式转发和上述 Agent token 徽标变化。既有隔离 daemon
验证使用模拟 provider：summary 的子事件/usage 数为 0/0，默认 full 为 7/2，
两者根卡片汇总均为输入 200 / 输出 40 / 总量 240。实时流与重连流的 31 个编号事件
完全一致。在下一轮执行中及两轮均结束后，load 和 transcript 对同一 call ID 返回
相同汇总。测试页均为完整小页（`hasMore=false`），未验证跨页、浏览器或真实模型。
提交 PR 时附 E2E 报告摘要；原始证据保存在被忽略的
`.qwen/issues/pr1-summary-terminal-usage.md` 及配套目录中。
