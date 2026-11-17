# 后台智能体状态与详情

[English](background-agent-status-and-details.md) | [简体中文](background-agent-status-and-details.zh-CN.md)

## 问题

Agent 工具调用在后台智能体启动后随即返回。因此它的 transcript 块带有一个终态工具事件，其负载为 `status: background`。Web Shell 有意将该启动结果映射回一个 pending 工具卡片，但之后没有任何机制把该卡片与实时的后台任务注册表对齐。底部任务列表已经进入终态，而原始 Agent 卡片仍显示为运行中。

前台智能体已经会打开共享的 subagent 详情面板。后台智能体拥有相同的 `toolUseId`、任务注册表条目、JSONL transcript 和虚拟会话解析器，但这条路径此前缺少显式覆盖。

## 设计

保持启动投影不变：带 `status: background` 的启动结果保持 pending，直到权威的任务状态到达。daemon 已经通过会话 SSE 流发出后台智能体的终态通知，其中带有任务的 `status` 和 `toolUseId`。Web Shell 消费这些隐藏的通知元数据，并把它们对齐回投影出的 Agent 工具卡片。

- `completed` 和 `cancelled` 使卡片完成。
- `failed` 使卡片失败。
- 通知的时间戳成为卡片的结束时间。
- 不带 `toolUseId` 的通知、非智能体通知以及无关的工具调用不会直接改变消息。

现有的 subagent 详情 provider 仍然是唯一的 UI 入口。后台 Agent 卡片在 pending 期间和终态对齐之后都保持可点击。虚拟会话解析器继续流式读取任务 JSONL，并从任务注册表获取实时状态，不按前台/后台模式过滤。对于没有 `toolUseId` 的遗留任务，它把启动记录与持久化的 sidecar 匹配，并在原始后台启动结果仍显示 `running` 时保留终态的 sidecar 状态。

当分离式工作处于活动状态时，其在主列表中的卡片使用专用的静态 `background task` 标签，而不是前台的 `running` 标签。该卡片不使用运行中的 shimmer 或走秒的 elapsed 计时器。它会把图标染成活动智能体的颜色并缓慢脉动，且只在整行没有其他动画时才启用脉动，这样分离式卡片无需 JS interval 或前台级别的视觉权重就能与已完成的卡片区分开。减弱动态效果（reduced-motion）偏好会去掉脉动但保留染色——染色不属于动态效果。终态通知会把该标签替换为正常的 completed、failed 或 cancelled 呈现。

未完成的后台工作以 chip 的形式显示在输入框正上方，每种类型一个（例如 `1 workflow`、`2 shells`、`1 monitor`、`1 local agent`），沿用现有的 `tasks.pill.*` 字符串。只有工作尚未结束时才有 chip：运行中的 shell 与监控，运行中、暂停中或已暂停的 workflow，以及运行中的后台智能体。已结束的任务直接退出，因此不会残留任何 “done” 计数；它们仍保留在完整的 Tasks 面板中，在出货形态（shipped entry）中也保留在环境面板里。暂停的智能体不显示 chip：暂停的智能体会在整个会话中被保留，并一直显示在环境面板的 subagents 部分，为它们显示 chip 会钉住一个过时的计数。后台智能体只在环境面板可达的形态（出货形态）中显示 chip；没有 header 的嵌入形态不会把智能体放进它们的任务界面。代表单个任务的 chip 点击后直接打开该任务：workflow chip 会把 transcript 滚动到发起该运行的工具调用并展开其内联视图（如果该运行在已加载的 transcript 中没有对应的行，则打开 Tasks 面板），shell 或监控 chip 打开其输出面板，智能体 chip 打开共享的 subagent 详情面板。代表多个任务的 chip 会在 chip 行上方列出这些任务供选择。宿主提供的 footer 会收到 composer 任务和后台智能体，并按自己的方式渲染；宿主提供 footer 时不显示这些 chip。chip 不引入新的轮询：它们读取 Web Shell 在后台工作活跃时已经在轮询的任务快照（`hasActiveTaskActivity` 会把后台 sub-agent 工具调用计入活动）。

持久化的通知记录并不总是保留 `toolUseId`。因此，当加载的 transcript 中包含活动的后台 Agent 卡片时，Web Shell 会在 transcript 追平之后通过现有的 subagent 端点解析每一个 pending 卡片。它在重连之后、以及任何终态 Agent 通知到达时都会重复这一一次性检查——即使该通知无法直接定位到对应卡片。它从不启动 interval。输入焦点和普通的流式输出不会改变 pending Agent 调用 ID 或终态通知 key，因此不会触发额外的请求。

停靠式详情面板从右边缘展开，使聊天区域被连续地推向左侧，而不是先调整尺寸再单独做面板动画。减弱动态效果（reduced-motion）偏好会禁用停靠式动画。面板标签保持固定宽度，过长的标题被截断，标签列表超出可用宽度时水平滚动。

## 范围

本变更更新了 Web Shell 投影和 daemon 的虚拟 subagent 状态解析器。它不重写已持久化的父级 transcript，不改变任务生命周期，不为后台智能体添加任务轮询，不从完整 Tasks 面板中移除智能体，也不添加第二个 subagent 查看器。
