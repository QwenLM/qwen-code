# Gemini 4 协议默认值与推理控制

[English](2026-11-21-gemini-4-support.md) | [简体中文](2026-11-21-gemini-4-support.zh-CN.md)

## 问题陈述

Gemini 4 模型 id 不在内置模型目录中。因此，当 Gemini 或 Vertex 路由没有显式声明 `capabilities.reasoning` 时，运行时无法得到该模型的推理能力，同时通用 Gemini 输出回退仍只报告 8K token。用户无法为新世代模型获得一致的默认行为。

## 当前状态

- token 上限先来自 models.dev 目录，再由 `packages/core/src/core/tokenLimits.ts` 中按规范化模型名组织的家族表推导。通用 Gemini 输入回退是 1M，但输出回退是 8K；64K 输出行只覆盖 `gemini-3*`。
- 显式声明的 `profile: "gemini"` 支持 `low`、`medium`、`high` 和 `xhigh`（仍拒绝 `max`）。没有声明时，Gemini 尚无内置能力回退；其他协议已有各自的专用回退。
- `/effort`、ACP 会话选项和 Web Shell 提供商预览都消费解析后的能力。未声明的 Gemini 4 路由要么暴露通用五档选项，要么完全没有提供商预览。
- Gemini 请求生成器把推理档位映射为 `thinkingLevel`（`LOW`、`MEDIUM`、`HIGH`，并在模型或声明支持 `xhigh` 时映射为 `XHIGH`）、处理 `reasoning: false`，并在能力可解析时尊重单次请求的退出设置，无需新增传输字段。

## 目标

- 为规范化后的 `gemini-4*` id 提供内置 1M 输入窗口和 64K 输出上限。
- 为承载 `gemini-4*` 的 Gemini 与 Vertex 路由提供默认 `high` 的内置推理能力：`gemini-4-neon*` 与 `gemini-4-hydrogen*` 为 `low`、`medium`、`high`、`xhigh`，其余 `gemini-4*` 为 `low`、`medium`、`high`。
- CLI、ACP 和 Web Shell 控件只提供该模型支持的档位，允许关闭 thinking，并把历史遗留的更高档设置钳制到该阶梯内。
- 保留显式用户设置和显式能力声明。

## 变更方案

### Token 上限

在通用 Gemini 输出回退之前增加世代专用行。现有通用 1M 输入规则已经覆盖 Gemini 4，补充显式回归测试即可。现有规范化逻辑继续处理提供商前缀、`-preview` 和日期别名；目录将来发布对应值后，仍按现有优先级生效。

### 推理能力

为 `gemini` 和 `vertex-ai` 路由上的 `gemini-4*` 增加范围严格的内置识别器。它返回 `gemini` profile、默认 `high` 以及 `thinking` 禁用字段：对规范化后的 `gemini-4-neon` 和 `gemini-4-hydrogen`（含日期、`-preview` 与后缀别名）暴露 `low/medium/high/xhigh`，对其余 `gemini-4*` 模型暴露 `low/medium/high`。

没有声明时，该识别器充当与 DeepSeek 回退相对应的 Gemini 内置回退。存在部分声明时，可像 GPT 和 Claude 内置定义一样继承原生阶梯与默认值；完整的显式声明仍由原逻辑接管，且 `profile: "gemini"` 允许 `xhigh`、拒绝 `max`。

现有 effective-reasoning 钳制会在请求时把不支持的遗留档位转为该模型的上限（Neon/Hydrogen 上 `max` → `xhigh`，其余 Gemini 4 模型上 `xhigh`/`max` → `high`）；选择控件拒绝接受阶梯外的新选择。选择提供商默认值时发送 `thinkingLevel: HIGH`，在支持 `xhigh` 的模型上选择 `xhigh` 时发送 `thinkingLevel: XHIGH`，选择关闭 thinking 时发送现有禁用配置。

### 控件与文档

不新增单独的 UI 阶梯表。CLI `/effort` 查询和 ACP/Web Shell 路由预览已经消费 `resolveReasoningForModel`，同一份内置定义驱动所有界面。面向用户的提供商文档记录默认值及覆盖方式。

## 设计决策

- 同时按协议和规范化模型 id 限定识别器。通过 OpenAI 兼容路由提供的 `gemini-4-neon` 不得获得 Gemini 线上行为。
- 只覆盖 Gemini 4。现有 Gemini 2.x 和 3.x 路由保持当前声明与回退行为。
- 使用仓库现有十进制 `1M`（`1,000,000`）和二进制 `64K`（`65,536`）约定，与现有家族表一致。
- 继续复用现有禁用 thinking 的请求结构，不在缺少端点证据时臆造 Gemini 4 专用字段。

## 范围边界

- 不生成或获取模型目录条目。
- 不修改端点认证、SSE 或代理行为。
- 不修改非 Gemini 协议；Gemini 2.x/3.x 显式声明路由也不新增行为。

## 验证计划

- 单元测试覆盖输入/输出上限、别名、非 Gemini 排除、默认值继承、默认 high 的有效推理、钳制、退出设置和受限 CLI/ACP 选项。
- 生成器测试覆盖默认 `HIGH`、显式较低档位、关闭 thinking，以及单次请求退出。
- 构建并执行 TypeScript 类型检查，运行受影响的 core/CLI 和提供商状态测试。
- 使用本地模拟 Gemini 端点捕获默认、选中档位和禁用三种最终线上请求，无需真实凭据。

## 验收标准

1. 未声明的 `gemini-4*` Gemini/Vertex 路由解析为 1M 输入和 64K 输出默认值。
2. 默认请求使用 `thinkingLevel: HIGH`；`low` 和 `medium` 原样生效，`xhigh` 在 `gemini-4-neon*` / `gemini-4-hydrogen*`（或显式声明 `xhigh` 的路由）上发送 `thinkingLevel: XHIGH`、其余模型钳制为 `HIGH`，遗留 `max` 钳制到对应模型上限，并可关闭 thinking。
3. `/effort` 与提供商推理控件对 Neon/Hydrogen 提供 `low`/`medium`/`high`/`xhigh`、对其余 Gemini 4 模型提供 `low`/`medium`/`high`，默认 `high`，不把隐式默认值持久化为用户选择。
4. 使用同一模型 id 的 OpenAI 路由及 Gemini 4 之前的路由行为不变。
5. 定向测试、类型检查和模拟线上请求验证通过。

## 未决问题

无。超过这些默认值的端点专用功能，在取得服务端证据之前不加入。
