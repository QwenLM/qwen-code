# 动态 workflow 默认开启

[English](2026-11-19-workflows-on-by-default.md) | [简体中文](2026-11-19-workflows-on-by-default.zh-CN.md)

状态：提议，已在同一变更中实现。

## 问题

Workflow 工具默认关闭，除非用户在用户级或系统级设置里打开 `tools.workflowsEnabled`，或设置 `QWEN_CODE_ENABLE_WORKFLOWS=1`。大多数用户不会发现这个开关，所以在任务适合用并行 subagent 时，模型也用不了 workflow；`/workflows`、已保存的 workflow 和扩展提供的 workflow 也一直不可见。

## 现状

- `Config.isWorkflowsEnabled()` 先看环境变量对（禁用优先）和强制关闭的情况（shell 执行沙箱、临时工作区），再返回设置值，未设置时为 `false`。
- daemon 为每个工作区 runtime 单独读取这个设置，只有值为 `true` 时才算开启。
- 这是受限设置：工作区设置不能修改它。
- Workflow 工具延迟加载、藏在工具搜索后面，所以在模型加载它之前，上下文里只有它的名字。

## 目标

- 不做任何配置就能使用 workflow。
- `tools.workflowsEnabled: false` 和 `QWEN_CODE_DISABLE_WORKFLOWS=1` 仍然能关闭它。

不做：修改规模指引、单次运行的上限或关键词触发。

## 设计

- `tools.workflowsEnabled` 默认为 `true`。在普通模式下，CLI、TUI、ACP 会话和可信的本地 daemon 工作区 runtime 默认开启 workflow。显式设为 `false` 可关闭。
- CLI 使用 `--bare` 时忽略此设置，且受限的工具集不包含 Workflow。使用 `--safe-mode` 时默认关闭。在未设禁用环境变量时，显式设为 `true` 或设置 `QWEN_CODE_ENABLE_WORKFLOWS=1` 可开启。
- daemon 根据所选 runtime 的设置和环境变量声明能力。重新加载工作区时，会更新已有 ACP 会话的工具可用性和模型工具声明。
- 设置说明、Web Shell 说明和用户文档写明 workflow 默认开启，以及如何关闭。

## 决定

- **保护措施保持不变。** 一次运行受规模指引（默认 `medium`，少于 15 个 agent）、单次运行的 agent 数上限和 30 分钟总时长上限约束，运行前是否先征求确认由当前审批模式决定。这些对已经主动开启的用户本来就生效，正是它们限制了消耗。
- **bare 模式使用受限工具集，safe 模式按需开启 workflow。** 这延续了两种启动模式的现有行为。
- **关键词触发保持开启。** 现在会有更多用户在消息里含 `workflow` 或 `ultracode` 时收到提醒。提醒只在任务合适时建议使用工具，`ui.disableWorkflowKeywordTrigger` 可以关掉它。

## 风险

- 更多用户可能启动消耗大量 token 的运行。规模指引默认让运行保持中等规模，各项上限约束每次运行。
- 在其他含义下使用 "workflow" 的消息（例如 CI workflow）现在也会收到引导提醒。提醒告诉模型，workflow 不合适时照常处理。

## 验证

- Config：未设置表示开启；`false` 表示关闭；bare 或 safe 模式下未设置表示关闭；环境变量对仍然优先。
- daemon：主 runtime、动态 runtime 和次级 runtime 都报告各自的有效 workflow 开关，包括安全模式的默认值和环境变量覆盖。已有 ACP 会话在移除关闭配置后可运行已保存的 workflow，恢复关闭配置后会收回工具。
- E2E：没有任何 workflow 设置的全新 HOME 里，`qwen -p` 能加载并运行 Workflow 工具；设置 `tools.workflowsEnabled: false`、`QWEN_CODE_DISABLE_WORKFLOWS=1` 或使用 `--bare` 时工具不存在。

## 验收标准

- 全新安装不做任何设置就提供 Workflow 工具、`/workflows` 和已保存的 workflow。
- 显式 `false` 或 `QWEN_CODE_DISABLE_WORKFLOWS=1` 会禁用工具和已保存的 workflow。支持 Workflow 模式的会话仍可使用 `/workflows mode status` 和 `/workflows mode off`。

## 后续

- 暂无计划。
