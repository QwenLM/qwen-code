# 保留工具失败正文

[English](tool-result-error-body.md) | [简体中文](tool-result-error-body.zh-CN.md)

## 问题

MCP 工具可以执行完毕并返回 `isError: true`，同时提供业务错误码和恢复说明。把正文、调用参数和序列化后的响应包在同一段错误消息里，会增加模型解读下一轮请求的难度。MCP SDK 的 callable tool 适配器也会包装失败响应，因此两个 MCP 入口都需要读取其中的正文。

## 结果处理

- 为在 `llmContent` 中返回失败正文的工具新增可选字段 `ToolResult.isError`。MCP 对这些结果沿用文本、结构化内容和媒体处理。MCP App 发起的调用继续把原始响应交给 App，并在会话中给出简短摘要。
- Core 和 ACP 复用现有失败状态、失败钩子及函数响应的错误字段。该字段携带工具正文，缺少文本时提供简短提示。现有执行异常继续使用 `ToolResult.error`。
- Shell 沿用现有退出码规则。正常退出的进程打印的文本属于命令输出，其中可以包含确认提示。

## 验证

让 CLI 和 ACP 收到同一个 MCP 结果，对比下一轮模型请求、工具状态及失败钩子。检查 ACP 会话重载，覆盖空结果、图片和 Shell 退出语义。
