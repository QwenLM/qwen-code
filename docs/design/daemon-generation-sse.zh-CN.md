# 守护进程无状态生成 SSE

[English](daemon-generation-sse.md) | [简体中文](daemon-generation-sse.zh-CN.md)

## 目标

新增 `POST /session/:id/generate`，为短文本生成提供按请求隔离的 SSE
端点。调用方提供一个纯文本 `prompt`。ACP 子进程先解析配置的 fast model；
当 fast model 缺失或无法解析时，回退到会话的 main model。

## 契约

请求体必须包含非空 `prompt`，且 UTF-8 大小不超过 32 KiB。请求可以包含
`skipOutputLanguagePreference: boolean` 和 `outputLanguageFallback: string`；
fallback 是不超过 128 个字符的单行语言标签。默认使用会话运行时的固定语言
偏好；prompt 中明确要求的输出语言或翻译目标优先级更高。当偏好缺失或为
`auto` 时，fallback 用于解释性 prose。`skipOutputLanguagePreference` 为
`true` 时不使用配置的偏好，但提供的 fallback 仍然生效。端点发送
`started`、可选的 `thinking`、`delta`、`done` 和 `error` SSE 事件。调用方应
使用 `fetch`，因为原生 `EventSource` 不能发送 POST 请求体。

生成与主对话隔离：不读取或修改聊天历史，不使用主 system prompt 或 memory，
并始终发送 `tools: []`。调用方不能选择模型或采样参数。契约与具体任务无关；
翻译和 shell 命令解释是 Web Shell 的消费者，不属于端点 schema。

## 架构

路由向 `AcpSessionBridge` 请求生成流。bridge 创建 request ID，在向 ACP 子进程
派发 `qwen/control/session/generation/start` 前注册有界的请求队列。子进程先尝试
`config.getFastModel()`，解析失败时回退到 `config.getModel()`，再通过
`BaseLlmClient.resolveForModel` 创建对应的 content generator，并消费
`generateContentStream`。数据块通过 `qwen/notify/session/generation/event` 返回，
只路由到注册的请求队列，不发布到 session EventBus 或 replay ring。

客户端断开时发送 `qwen/control/session/generation/cancel`；子进程终止对应的
controller。有界 bridge 队列保护守护进程免受慢速 HTTP 读取器影响，HTTP writer
遵守 `res.write()` 的 backpressure。

## 模型回退

回退只发生在选择阶段。缺失或无效的 fast model 会选择 main model。生成开始后，
provider 失败会结束流；在已经发送 delta 后切换模型会造成重复或混合输出。

## Web Shell 思考翻译

完成的 thinking block 在悬停时显示翻译操作。thinking block 展开时操作仍可见。
Web Shell 通过此端点发送翻译 prompt，并在 popover 中渲染 delta。最终输入和输出
token 数量显示在翻译内容下方。popover 可以取消进行中的请求，或丢弃缓存结果后
再次翻译。无内容的 `thinking` 事件只报告进度，不暴露推理内容。进行中的 thinking
block 不显示该操作。

Shell approval 也提供 Explain 操作。它在无固定输出语言偏好时使用当前 UI 语言
作为 fallback，并默认遵循固定的 session 偏好。翻译结果按语言、消息和内容缓存在
页面内存中。Explain 结果缓存在已挂载的 `ThinkingTranslateButton` 实例上，因此
关闭并重新打开 popover 不会再次请求；替换该消息或刷新页面会创建新的解释。页面
刷新会清除两种缓存。

## 非目标

- 对话上下文或历史
- 工具调用
- 任意模型或采样参数覆盖
- SSE 重放或断线恢复
- 任务注册表或任务专用 schema
