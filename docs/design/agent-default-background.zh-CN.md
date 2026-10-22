# 可配置的子代理默认执行模式

[English](agent-default-background.md) | [简体中文](agent-default-background.zh-CN.md)

## 问题与当前行为

顶层普通子代理默认在后台运行。需要在当前调用中直接获得完整结果的用户，必须在每次调用中重复指定 `run_in_background: false`，或在每个代理定义中设置 `background: false`。目前没有用于表达这一偏好的全局设置。本次变更解决 [#15147](https://github.com/QwenLM/qwen-code/issues/15147)。

## 预期行为

增加布尔设置 `agents.defaultBackground`，默认值为 `true`。设为 `false` 后，符合条件的顶层普通子代理在前台运行，并直接返回结果。未设置时保持现有行为。

```json
{
  "agents": {
    "defaultBackground": false
  }
}
```

优先级依次为显式 `run_in_background`、代理定义中的 `background`、`agents.defaultBackground`、现有内置默认值。每一层中的两个显式布尔值均保持有效。

## 实现与决策

CLI 设置 schema 声明该设置，并生成编辑器使用的 JSON schema。CLI 配置将其传递给现有核心 `AgentsCollabSettings` 对象。Agent 工具仅在现有普通子代理默认分支中通过 `getAgentsSettings()` 读取该设置。无需新增运行时状态或执行路径。

可选工具参数不声明静态 schema 默认值，因为其实际默认值取决于代理定义和设置。这样，即使消费者会应用 JSON schema 默认值，也能保留参数未指定的语义。

该设置需要重启，因为核心代理设置是在构造时保存的快照。若声明为实时生效，则需要增加本功能范围之外的同步机制。

受影响代码包括 CLI 设置 schema 和配置映射、核心配置类型与 Agent 工具，以及相关的针对性测试。设置参考、子代理指南和 Agent 工具文档会说明该偏好及其优先级。面向模型的工具说明也会提及可配置的默认值。

## 兼容性与范围

- Headless fork 仍作为后台任务运行。交互式 fork 保持现有行为。
- 嵌套代理仍在前台运行，嵌套调用中的显式后台请求仍被拒绝。
- 调用方拥有的 `working_dir` 与命名代理限制继续使用现有约束。具名 teammate 保留独立执行路径。
- 代理定义优先于全局设置，包括设置了 `background: false` 的外部执行器。
- 展示和生命周期消费者继续使用解析后的 `executionMode` 与 `isBackgrounded`。旧 transcript 的分类规则保持不变。
- 已有后台任务恢复、hosted workspace 执行 profile 及外部桌面实现不在本次变更范围内。

## 验证与验收标准

针对性测试覆盖未设置、`true` 和 `false`，显式参数与 frontmatter 的双向覆盖、CLI 配置传递、schema 默认值以及现有执行约束。断言检查返回结果、展示模式和注册表状态。

行为验证使用隔离的 CLI 会话与确定性的本地模型端点，请求未显式指定模式的普通子代理。实现前，即使设置为 `false`，仍会在后台启动。实现后，子代理结果直接返回；显式后台请求仍会启动后台任务。E2E 计划记录命令、结果及环境限制。构建、类型检查、打包、格式检查和相关 lint 检查共同完成验证。

## 待定问题

本次实现没有必须解决的待定问题。维护者可以单独考虑增加实时配置更新。
