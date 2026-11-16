# OpenAI 兼容接口的 Gemini thought signature

[English](openai-thought-signatures.md) | [简体中文](openai-thought-signatures.zh-CN.md)

日期：2026-11-03。状态：已在本地实现；Idealab 工具续跑、会话恢复、Kimi/DeepSeek 全新会话及 Gemini 历史切换检查均已验证。Google 官方端点的双字段回放仍是独立验收门禁。

## 问题与范围

Gemini 可以要求历史 function call 携带不可读的 thought signature，否则会在工具结果后的下一次请求中返回 HTTP 400。此前 OpenAI Chat 转换器在读取响应和重建 assistant 历史时都会丢弃该签名，因此首个工具调用成功，紧随其后的模型请求失败。

本次修改覆盖非流式与流式 Chat Completions 中的签名 function call、后续请求回放，以及 JSONL 录制和恢复。不修改推理文本、工具执行、provider 配置，也不修改 Gemini 原生、Anthropic 和 Responses 转换。

对应的上游报告是 [QwenLM/qwen-code#1187](https://github.com/QwenLM/qwen-code/issues/1187)。已关闭且未合并的 [#1202](https://github.com/QwenLM/qwen-code/pull/1202) 未覆盖 Google 官方 OpenAI 字段形状。

## 协议与证据

内部表示沿用现有的 Gemini Part 结构：

```json
{
  "functionCall": { "id": "call_read", "name": "read_file", "args": {} },
  "thoughtSignature": "sig-a"
}
```

本次覆盖两种 OpenAI 兼容字段：

```text
tool_calls[].thoughtSignature
tool_calls[].extra_content.google.thought_signature
```

嵌套形式见 [Google thought signature 文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures)，直接形式是实测的 Idealab 映射。

最小线上回放实验得到：

| 回放形状           | Idealab 结果           | Google 官方证据                            |
| ------------------ | ---------------------- | ------------------------------------------ |
| 仅直接字段         | HTTP 200               | #1202 实测仍提示缺签名，与该字段被忽略一致 |
| 仅嵌套字段         | HTTP 400，仍提示缺签名 | 官方要求的形状                             |
| 两种字段携带相同值 | HTTP 200               | 尚未实跑                                   |

签名属于单个工具调用。并行调用不得共享或复制同一个签名；官方协议允许只有第一个并行调用携带签名。

## 设计

### 捕获

`converter.ts` 从两种字段中读取字符串签名。两个字段值相同表示同一签名；值冲突属于歧义，不猜值也不合并。非法容器和非字符串值不会被字符串化。

非流式转换直接把签名附到生成的 function-call Part。流式转换将签名交给现有的 `StreamingToolCallParser`。

### 流式关联

解析器在现有工具调用 metadata 槽位中保存一个可选签名。先按既有规则解析 `actualIndex`，包括 same-index collision remapping，再保存签名。独立签名 delta 是 metadata，不是参数片段，也不是 phantom call。

实现覆盖签名先于或晚于参数、位于 finish delta、重复完整参数回放、缺少 id，以及重映射后的迟到签名。签名是不可读值，不做拼接。现有 reset 和非法调用校验保持不变。

### 回放

出站转换用同一个原始值同时写出两种字段，从而避免持久化方言 metadata、端点探测、provider 设置和按历史分派。包含不同来源方言调用的历史也可以使用同一种表示。

双字段写出是兼容超集，不是严格的来源原样回放。在声明支持 Google 官方双字段之前必须实测。如果失败，回退方案是通过每个调用的 `partMetadata` 保存方言并精确回放，不采用 URL 推断或自动换格式重试。

无签名调用保持标准 OpenAI 形状。其他未知 `extra_content` 扩展不会被复制。

### 录制与恢复

`redactStructuredOutputArgsForRecording` 现在保留 `thoughtSignature`，同时继续脱敏 structured-output 参数。内存中的 consolidation 本已保留完整 Part，但此前录制边界会重建为不含同级字段的 function call，因此必须修复该边界。现有 API-history 重建会保留录制后的签名。

## 边界与风险

- 已丢失签名的旧会话无法补回原始值。本次不伪造签名，也不自动使用 `skip_thought_signature_validator`。
- 双字段会重复不可读值，增加请求体积和 wire-log 体量。
- 签名历史切换到其他模型时，严格的非 Gemini provider 可能拒绝任一扩展；保留字段形状不等于签名跨模型有效。
- 不进入后续模型请求的 logging-only 投影不属于本次运行时修复范围。
- 尚未声明 Google 官方双字段验证通过；该检查是双字段方案上游验收的必要条件。

## 验证与验收

单元测试覆盖直接、嵌套和相同双字段输入，冲突值，流式参数分片，独立签名和 finish delta，并行调用，重映射，精确双字段回放，无签名兼容性，普通录制及 structured-output 脱敏。另有 `llm-chat` 测试直接覆盖实际录制调用路径。

验收要求相关 core 测试、仓库构建、类型检查和 bundle 全部通过。端到端验收使用 `node dist/cli.js` 与 `gemini-4-argon`，证明真实工具结果后的模型请求成功，且回放日志包含两种字段。第二个进程必须恢复该会话，并在保留历史签名的情况下完成新的工具续跑。

Google 官方嵌套单字段与双字段回放仍是独立验收项。未经过对应端点测试，不得声称 provider 切换具有普遍兼容性。
