# Notebook 读取纠错

[English](2026-09-21-notebook-read-recovery.md) | [简体中文](2026-09-21-notebook-read-recovery.zh-CN.md)

## 问题

Notebook 读取拒绝 `offset`、`limit` 和非空 `pages`。已观察到的评测会话中，模型不断修改这些字段的值，没有省略字段。将 `limit` 设为零时，错误又变成通用的正整数要求，容易让模型继续修改数值。

Responses 适配器也没有指定 `strict`。[OpenAI 文档](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)说明，Responses 可能将这样的 schema 转成 strict 模式，使所有属性变成必填。原始上游 schema 未被捕获，因此这里属于兼容性风险，不能认定为那些会话的已确认根因。

## 修改

- 转换后的 Responses function tools 显式设置 `strict: false`，保留声明中的可选字段。保留现有 schema 规范化和本地校验，不增加 nullable 参数，也不静默丢弃输入。
- 描述 notebook 返回结构化单元格及输出，并明确要求省略分页。行分页提示限定为文本文件。
- 路径校验和空 `pages` 归一化后，先检查 notebook 分页，再检查数字范围。所有符合 schema 类型的分页值，包括零、负整数和无效 PDF 页码字符串，统一返回省略字段的指引，并提供经过 JSON 转义、仅含路径的重试示例。
- schema 类型校验仍先执行。错误类型（包括 `null`）仍被类型校验拒绝。空串或纯空白 `pages` 保留原有的省略行为。文本行范围及 PDF 页码校验保持现有语义。

## 验证与限制

单元测试覆盖 notebook 错误的一致性、可用的重试示例、文本/PDF 校验，以及带有 `strict: false` 的可选参数出站 schema。Headless CLI 测试使用本地确定性 Responses 服务，捕获请求 schema，并验证失败调用后仅传路径能够成功读取。完成构建、类型检查、相关测试和独立审查。

本次不增加 notebook 分页，不放宽循环保护，不修改压缩机制，也不保证每个模型都会遵循有效的纠错指引。本地服务验证客户端行为，不能证明历史上游实际进行了什么转换。
