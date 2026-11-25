# Code Mode exec Freeform 输入

[English](freeform-exec-experiment.md) | [简体中文](freeform-exec-experiment.zh-CN.md)

## 问题与范围

Code mode 当前将 exec 暴露为接收含 `source` 字段的 JSON 对象的函数。
生成内嵌 JavaScript 或 shell 代码因此需要额外一层 JSON 转义。
新的全局配置 `tools.freeform` 在 Code Mode Only 开启且当前模型使用
`wireApi: "responses"` 时移除这一层；exec 内部的 JavaScript 字符串求值依然存在。

## 设计

通过 `tools.freeform` 将 exec 切换为接收文本的 Responses custom tool。
该配置只有在 `tools.codeModeOnly` 为 true 且当前模型的 `wireApi` 为
`"responses"` 时生效。其他工具和默认行为仍使用 function tool。
Responses 转换器将完成的 custom 输入映射为内部 `{ source }`，保留调度器校验、
权限、运行时执行、工具调用显示和记录方式。启用时，适配器将 exec 历史回传为配对的
`custom_tool_call` 和 `custom_tool_call_output`，包括不含工具的请求。
孤立调用清理覆盖两种协议类型。完成事件提供完整权威源码，delta 不执行部分程序。

该配置是全局配置，并在每次请求时根据当前模型重新判断。历史保持为统一的
内部 Content，因此在 Responses 模型之间，或 Responses 与 Chat Completions
之间切换时，只需按当前 wire 重新编码，无需迁移历史或增加 per-model 配置。
该配置保留在 settings schema 中，但刻意不显示在 Settings 对话框中，用户需要
直接在 settings 文件中配置。

修改包含全局 tools 配置、Config 接线、Responses 类型、转换器、pipeline 及测试。
范围不包含自动能力探测、回退、语法约束或其他 Provider 适配器的修改。
用户只应在确认接口支持
[Responses Custom Tools](https://developers.openai.com/api/docs/guides/function-calling#custom-tools)
时启用配置。
当 `tools.codeModeOnly` 为 false 时，`tools.freeform` 会被保存但不生效。

## 验证与验收

定向测试覆盖原始源码保真、普通工具兼容、custom 调用与结果配对、配置接线、
Provider 切换后的历史重放，以及 Settings 对话框中隐藏该配置。验收要求默认行为和
非 Code Mode 行为继续使用 function tool，完成的 custom 输入保持原始源码并只执行
一次，以及切换 Provider 后保留调用 ID 和工具结果。

已在持久化 CLI session 中完成双向真实 API 测试：Idealab `gpt-6-astra` 使用
Responses Freeform，切换到使用 Chat Completions 的 DashScope `qwen3.8-max`，
以及反向切换。每次均等待首轮正常完成后再切换模型；随后的 follow-up 成功调用
工具并正常回答，历史调用与工具结果保持完整。正向测试使用原始新闻研究任务，
反向测试通过 exec 读取项目元数据。

这些运行中两个主模型均未产生 API 错误、重试或空最终回答。
接口兼容性由用户自行确认。

状态：实现及双向真实 API 验证完成。详细结果记录在
`.qwen/e2e-tests/freeform-original-task/`。
