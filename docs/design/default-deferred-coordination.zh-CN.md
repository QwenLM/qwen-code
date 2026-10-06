# 默认延迟加载协作工具

[English](default-deferred-coordination.md) | [简体中文](default-deferred-coordination.zh-CN.md)

## 状态与问题

这是 #12028 下 #12326 的候选方案。即使会话不委派任务、不使用 Goal，仍承担
Agent 和 Goal 的完整声明成本。此前显式配置 `tools.eager` 的实验不能证明本候选
方案的收益或自然召回率。

## 决策与范围

将 `agent`、`list_agents`、`get_goal`、`update_goal`、`propose_goal` 标记为原生
延迟加载。复用现有简短发现目录及 `tool_search` → `tool_call` 桥接，不新增设置，
不修改 schema，不删除工具指令，不改变执行和审批语义。

常用文件工具保持不变。`tools.eager` 语义不变，在其中列出原生延迟工具不会强制
常驻；`tools.visible` 可以强制提前声明。已有预加载逻辑，以及桥接缺少任意一端时
的立即声明回退仍然适用。Code Mode 保持原有发现路径。基于声明工具的 system
prompt 指引过滤仍生效，并新增一个输入：Agent 可达性。Subagent Delegation 与
Codebase Search 两行在 `agent` 已声明、或已注册在桥接两端之后且出现在延迟摘要
中时满足 Agent 条件；Codebase Search 仍要求 `grep_search` 和 `glob` 已声明。
桥接不完整的会话里被排除在立即声明之外的 Agent 两个条件都不满足，
因此这两行会被裁掉。其余受控行不新增例外，也不增加其他 prompt 裁剪策略。
memory、history 和子 Agent 收到的 schema 保持不变。

ACP 在应用已有的仅 Agent 并发规则前，先解析桥接调用的目标。桥接 Agent 结果
通过已验证的执行记录保留立即发送的 todo 提醒；其他桥接目标保持原有调度和提醒
节奏。关键词发现先过滤当前上下文中不可用的声明，再应用 `max_results`，包括
host turn key 缺失时不可用的 Goal 提议。

共享 Goal 续跑指令为隐藏的 `get_goal` 和 `update_goal` 明确发现及调用路径：
Direct 模式先 `tool_search`、再 `tool_call`；Code Mode 通过 `exec` 调用返回的
JavaScript 绑定。所有 host 的普通续跑、目标更新和收尾回合均使用这份指令。

Agent、消息工具说明和后台 Agent 恢复通知也说明 Direct 模式下如何发现缺失的
`list_agents`。复用已有的条件式桥接指引，兼容提前声明和会话内后续揭示；不修改
注册表判定或执行策略。

五处结果记录入口根据最终返回的 schema 判断 Goal 发现的证据类型，不根据查询
拼写猜测。完整结果仅含 `get_goal`、`update_goal` 或 `propose_goal` 声明时，
属于 Goal 运行时记账；关键词发现和 Code Mode 的调用提示也适用。混合工作工具
的 schema、能力诊断以及不完整或不可解析的结果保留普通工具结果来源，交由
verifier 使用。

## 风险与验收

额外的发现请求可能抵消首次请求的节省，不能降低自然委派或 Goal 完成的可靠性。
离开 Draft 前，使用相同模型、设置、工作区、记忆和提示词，对比基线与候选版本，
不配置 `tools.eager`：

1. 问候和普通只读文件问题：对比真实首次请求的 schema、provider input/cache
   用量，以及整个任务的输入总量。
2. 不点名工具的独立多部分调查：验证 Agent 发现、启动、结果获取和最终答案。
3. 用户明确要求的 Goal：验证桥接路径的提议确认、进度、完成证据和 verifier
   结果；用户拒绝不能启动 Goal。所有 host 的续跑指令都须说明隐藏 Goal 工具的
   调用路径，包括目标更新和收尾回合。
   无论引号、大小写或搜索模式，纯 Goal 发现都不得进入外部事实证据；混合工作
   工具和缺失能力的结果必须保留在证据窗口中。
4. `tools.visible`、禁用桥接、禁用工具及含历史直接调用的恢复会话：验证既有
   可见性和权限契约。
5. ACP 直接和桥接 Agent 调用：验证并发委派及立即发送的 todo 提醒。非 Agent
   桥接调用保持串行，不强制该提醒。Goal 关键词搜索须跟随 turn key 可用性。
6. 形如真实部署、带非零 `tools.toolSearch.threshold` 的配置文件：在基线与候选
   版本上分别记录 `/context` 和首次请求的 schema，说明延迟工具池是否仍装得进
   预加载预算（整池揭示），还是现在一个都揭示不出来——该预加载对整个池子是全有
   或全无，而本次改动往池子里加了五个很大的声明。此项须与下面的发现开销分开报告。

保留原始请求和任务结果，不能只记录声明字符数。单独报告回归和发现开销，不引用
此前 allowlist 实验的降幅作为本次收益。#12333 的外部 benchmark pool overlay
属于独立基础设施，不在本仓库增加没有消费者的新参数。
