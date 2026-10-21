# Notebook 读取纠错

[English](2026-09-21-notebook-read-recovery.md) | [简体中文](2026-09-21-notebook-read-recovery.zh-CN.md)

## 问题

Notebook 读取拒绝 `offset`、`limit` 和非空 `pages`。已观察到的评测会话中，模型不断修改这些字段的值，没有省略字段。将 `limit` 设为零时，错误又变成通用的正整数要求，容易让模型继续修改数值。

[OpenAI 文档](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)说明，Responses 可能将工具 schema 转成 strict 模式，使所有属性变成必填，并通过 `null` 表达可选值。原始上游 schema 未被捕获，因此这里属于兼容性风险，不能认定为那些会话的已确认根因。工具应接受 nullable 可选值，而不要求关闭 strict 模式。

## 修改

- 保留 Responses 原有的 strict 默认行为，不全局关闭或强制开启 strict，也不对任意工具输入增加通用的类型强转。
- 将 `read_file` 的 `offset`、`limit`、`pages` 声明为 nullable。本地仍只有 `file_path` 必填，同时支持省略参数和显式传入 null。如果提供方要求所有属性必填，nullable 类型已为不使用的字段提供合法表示。
- 在 notebook、数字或页码校验前，将这三个字段的 `null` 归一化为 `undefined`，再创建执行实例。描述、位置、完整读取缓存以及文本/PDF 默认读取行为因此保持一致。
- 描述 notebook 返回结构化单元格及输出，行分页提示限定为文本文件。先检查 notebook 分页，再检查数字范围，统一提示省略字段或使用 `null`，并给出经过 JSON 转义、包含三个 null 字段的重试示例。
- `file_path` 仍不接受 null，其他类型继续正常校验。拒绝实际的 notebook 分页值，包括零和负整数。空串或纯空白 `pages` 保留原有的省略行为。文本/PDF 的非 null 参数保留现有含义。

## 验证与限制

单元测试覆盖 null 归一化、兼容 strict 的 nullable 调用、可用的重试示例、完整读取缓存及文本/PDF 行为。Headless CLI 测试使用本地确定性 Chat Completions 和 Responses 服务，捕获 schema，验证参数省略、null 及非法值。完成构建、类型检查、相关测试和独立审查。

本次不增加 notebook 分页，不放宽循环保护，也不修改压缩机制。本地服务验证客户端行为，不能证明历史上游进行了什么转换，也不能证明真实模型遵循纠错指引的概率。
