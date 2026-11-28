# Workflow 计划阶段

[English](2026-11-18-workflow-planned-phases.md) | [简体中文](2026-11-18-workflow-planned-phases.zh-CN.md)

状态：提议，已在同一变更中实现。

## 问题

workflow 脚本在运行前就定好了计划，但执行视图要等脚本走到某个阶段才知道它的存在。在那之前，用户看不到当前阶段之后的任何内容。还没调度第一个 agent 的运行只显示"等待第一个 Agent 调度…"。

agent 本身无法事先列出。`agent()` 是运行时调用的，调用多少次取决于前面的结果。在 `workflow-authoring` 的示例里，Verify 阶段为审查者返回的每条发现各派一个 agent；循环、分支、预算和断点续跑也都会改变 agent 集合。能事先知道的是阶段计划：脚本在 `export const meta = { phases: [{ title, detail? }] }` 里声明它，审批提示也已经会打印出来。

## 现状

- `workflowPreLaunchGate` 在脚本开始前就解析了 `meta`，但运行登记时用的是 `meta: null`。`meta` 要等运行结束才补上。
- 发给客户端的任务快照带了 `meta.name` 和 `meta.description`（作为 `label` 和 `description`），没有带 `meta.phases`。
- Web Shell 执行视图每次进入阶段画一条泳道，所以脚本没有用这个标题调用 `phase()` 之前，这个阶段没有泳道。

## 目标

- 运行一开始就显示每个声明的阶段，包括脚本还没走到的，并带上它的 `detail`。
- 对没开始的阶段，绝不编造 agent 或数量。

不做：根据脚本源码预测 agent、修改 TUI、在新泳道之外改动执行视图的布局。

## 设计

1. **Core。** 运行登记时直接带上 pre-launch gate 已经解析出的 meta，不再写 `null`。条目的 label 和 description 从运行一开始就用 `meta.name`，而不是等运行结束。
2. **传输。** 运行中和已保存的 workflow 任务快照新增可选字段 `plannedPhases: { title, detail? }[]`，按顺序从 `meta.phases` 复制。脚本没有声明阶段时不带这个字段。阶段的 `model` 不下发，因为执行视图用不到。这个字段加到 `ServeSessionWorkflowTaskStatus`（acp-bridge）和 `DaemonSessionWorkflowTaskStatus`（SDK），类型分别为 `ServeWorkflowPlannedPhase` / `DaemonWorkflowPlannedPhase`。旧 daemon 不会发送它，所以不需要能力标记。
3. **Web Shell。**
   - 运行中的 run 处于 `running`、`paused` 或 `pausing` 时，所有还没有阶段访问使用其标题的声明阶段，按声明顺序排在已访问阶段之后，各占一条泳道。
   - 计划泳道的标题行用虚线，写"未开始"而不是 dispatch 数，并显示它的 `detail`。
   - 脚本走到这个阶段后，由该次访问的泳道取代它。
   - 有计划泳道但还没有 dispatch 的运行，显示这些泳道而不是等待文字。
   - 计划泳道计入现有的泳道渲染上限。

## 决定

- **按标题精确匹配。** authoring 指南要求脚本把声明的标题传给 `phase()`，registry 记录的也是传入的标题，所以精确相等是客户端可以依赖的规则。用 meta 里没有声明的标题调用 `phase()`，照旧单独占一条泳道。
- **只在运行还能走到这个阶段时显示。** 已结束、失败、取消的运行，以及所有已保存的运行，都不显示没走到的阶段。脚本没有走到它们，写"未开始"会让人以为还可能开始。
- **不放占位 agent。** 计划泳道保持为空：阶段开始前的 agent 数只能是猜测。

## 风险

- label 更早改变：TUI 的标签和对话框在运行中显示 `meta.name`，而不是运行 id。这和运行结束后显示的值相同。
- 如果脚本调用 `phase()` 的标题和声明的标题不同，运行结束前会同时显示计划泳道和访问泳道。

## 验证

- Core：登记运行后，第一个阶段开始前条目上就有脚本的 meta。
- CLI：运行中和已保存的快照都带 `plannedPhases`（只有 title 和 detail），没有声明阶段时不带。
- Web Shell：布局把计划泳道排在已访问阶段之后，跳过已走到的标题，运行结束或已保存时不显示；没有 dispatch 的运行显示计划泳道而不是等待文字。
- E2E：用真实 daemon 运行一个三阶段脚本，第二个阶段开始前三条泳道都在；运行结束后计划泳道消失。

## 验收标准

- 带 `meta.phases` 的运行中的 workflow，从第一个快照起就显示每个声明的阶段。
- 没开始的阶段，泳道里不显示数量，也不显示 agent。
- 没有 `meta.phases` 的运行、已结束的运行和旧 daemon 的表现与之前相同。

## 后续

- 在 TUI 的 workflow 详情里显示计划阶段。
- 执行视图改版选定主形态后，把计划阶段带进去。
