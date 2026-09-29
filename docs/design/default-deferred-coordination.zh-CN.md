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
的立即声明回退仍然适用。Code Mode 保持原有发现路径。这不削减 system prompt、
memory、history，也不减少子 Agent 收到的 schema。

## 风险与验收

额外的发现请求可能抵消首次请求的节省，不能降低自然委派或 Goal 完成的可靠性。
离开 Draft 前，使用相同模型、设置、工作区、记忆和提示词，对比基线与候选版本，
不配置 `tools.eager`：

1. 问候和普通只读文件问题：对比真实首次请求的 schema、provider input/cache
   用量，以及整个任务的输入总量。
2. 不点名工具的独立多部分调查：验证 Agent 发现、启动、结果获取和最终答案。
3. 用户明确要求的 Goal：验证桥接路径的提议确认、进度、完成证据和 verifier
   结果；用户拒绝不能启动 Goal。
4. `tools.visible`、禁用桥接、禁用工具及含历史直接调用的恢复会话：验证既有
   可见性和权限契约。

保留原始请求和任务结果，不能只记录声明字符数。单独报告回归和发现开销，不引用
此前 allowlist 实验的降幅作为本次收益。#12333 的外部 benchmark pool overlay
属于独立基础设施，不在本仓库增加没有消费者的新参数。
