# Code Mode

[English](code-mode.md) | [简体中文](code-mode.zh-CN.md)

## 状态

已实现。该功能为实验性功能，默认关闭。

## 问题

Qwen Code 目前支持直接工具调用和 `CodeModeOnly`。后者会用 `exec` 替换普通
顶层工具，适合编排调用，但模型无法在直接调用更清晰或更高效时选择直接调用。
Codex 将这套能力建模为三种工具模式：直接模式、混合 Code Mode 和
CodeModeOnly。

## 目标

新增混合 `CodeMode`，同时保持现有默认模式和 `CodeModeOnly` 行为不变。

## 配置

```json
{
  "tools": {
    "mode": "code_mode"
  }
}
```

有效模式如下：

| `tools.mode` 值  | 有效模式         |
| ---------------- | ---------------- |
| 省略 / `direct`  | `direct`         |
| `code_mode`      | `code_mode`      |
| `code_mode_only` | `code_mode_only` |

这些值与 Codex 的 `ToolMode` 序列化值一致。安全模式和 bare 模式会强制使用
`direct`。

## 暴露策略

| 调用面       | `direct`             | `code_mode`              | `code_mode_only` |
| ------------ | -------------------- | ------------------------ | ---------------- |
| 普通即时工具 | 直接调用             | 直接调用和嵌套调用       | 仅嵌套调用       |
| 延迟工具     | `tool_search`        | `tool_search` 和嵌套调用 | 仅嵌套调用       |
| 直接控制工具 | 直接调用             | 仅直接调用               | 仅直接调用       |
| `exec`       | 隐藏                 | 直接调用                 | 直接调用         |
| 隐藏桥接工具 | 保持现有直接模式行为 | 在原本适用时直接调用     | 隐藏             |

在 `code_mode` 中，普通可见工具的描述会附加该工具的 `exec` 调用声明。
`exec` 描述保留完整的 `ALL_TOOLS` 元数据，但不重复所有 schema。延迟工具在
按正常流程暴露顶层声明时获得对应声明。在 `code_mode_only` 中保持现有行为：
由于后续无法暴露顶层声明，所有嵌套声明都集中在 `exec` 描述中。

经过过滤的子智能体声明沿用相同模式。智能体的 `tools` 列表会收窄直接调用面。
显式列出的普通工具会收窄嵌套集合；继承或显式允许的 `exec` 则携带所有仍可用的
code-mode-callable binding。

## 约束与风险

- `direct` 模式下的普通工具声明必须保持完全不变。
- 嵌套调用继续经过现有 scheduler 或 ACP 执行链，不能绕过校验、权限、hook、
  取消和遥测。
- 混合模式若重复全部 schema 会增大提示词，因此只在各顶层工具描述中附加对应的
  嵌套声明。

## 验证

- 验证模式解析以及安全模式/bare 模式回退。
- 验证直接、混合和 CodeModeOnly 三种声明面。
- 验证子智能体过滤后的声明和嵌套 allowlist。
- 运行 Core 和 CLI 的相关测试，然后执行构建和类型检查。

## 验收标准

- `tools.mode: "code_mode"` 注册 `exec`，同时保留普通直接工具和延迟发现。
- 普通可见工具会声明其嵌套 JavaScript 调用签名。
- `tools.mode: "code_mode_only"` 选择严格模式。
- 默认模式、安全模式和 bare 模式仍然只使用直接调用。
