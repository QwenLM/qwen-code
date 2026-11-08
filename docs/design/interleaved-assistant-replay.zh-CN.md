# 交错 assistant 输出的历史回放

[English](interleaved-assistant-replay.md) | [简体中文](interleaved-assistant-replay.zh-CN.md)

日期：2026-10-26。状态：已在本地实现；下述验收检查仍为验证计划。

## 问题与范围

assistant 可能依次输出推理摘要 `R1`、消息 `M1`、推理摘要 `R2` 和消息
`M2`。此前的 Chat Completions 转换把所有推理汇总为
`reasoning_content: R1R2`，把所有消息汇总为 `content: M1M2`。连续
assistant 消息的合并也会丢失这种顺序。UI 则会把后续推理放到更早的
assistant 输出上方。

本次修改在发往 Chat 的历史和流式 UI 中保留推理与消息的顺序，涉及
[Chat 转换器](../../packages/core/src/core/openaiContentGenerator/converter.ts)、
[严格 provider 适配](../../packages/core/src/core/openaiContentGenerator/provider/utils.ts)
和[流式 UI hook](../../packages/cli/src/ui/hooks/use-llm-stream.ts)。共享历史、
会话持久化和 Responses 回放签名沿用现有表示。

## 历史回放转换

当消息正文或工具调用之后再次出现推理时，`processContent` 会输出当前
assistant 段。`normalizeAssistantMessages` 保留新的推理段，不再将其
压入前一条消息。以 `A(R, M)` 表示一条 assistant 消息，目标映射为：

```text
R1, M1, R2, M2
→ A(R1, M1), A(R2, M2)
```

每段分别携带自己的 `reasoning_content` 和 `content`。只有推理的段使用
`content: ""`；只有工具调用的消息可以使用 `content: null`。

### 工具批次与观察顺序

一组连续 assistant 消息在下一条非 assistant 消息处结束。按原顺序收集
其中的工具调用，将整个批次附到最后一个 assistant 段。匹配的工具结果
必须紧接其后，组成连续的结果块；拆出的工具媒体放在结果块之后。

```text
R1, M1, F1, R2, M2, F2, O1, O2
→ A(R1, M1), A(R2, M2, tools=[F1, F2]), O1, O2
```

其中 `Fi` 为工具调用，`Oi` 为对应结果。Chat 要求结果紧接调用消息，无法
同时表达原有的调用与推理交错。集中工具调用会推迟这些调用在回放中的
位置，但保留推理与消息的顺序以及完整工具批次。如果把 `O1` 提前到 `R2`
之前，就会暗示模型生成 `R2` 时已经看到了当时尚未返回的结果；转换器
不得这样处理。

孤立工具清理仅在紧随其后的结果块中匹配结果，不越过普通 assistant 或
user 消息继续寻找。沿用现有的调用 ID 去重和孤立调用清理。清理后再次
规范化，让新相邻的片段也遵守同样的规则。

## Provider 适配与限制

转换器生成出站消息，不改写共享历史。Responses 的 `thoughtSignature`、
item 元数据和 `encrypted_content` 仍供 Responses 回放路径使用。Chat
没有这类密文的标准对应字段，因此不得将其写入消息正文或自行添加的
Chat 字段。目标端支持时，可通过 `reasoning_content` 回放可读推理摘要。

Mistral 和 Cerebras 在出站边界删除 `reasoning_content`。适配器也会删除
因此变空的纯推理段，同时保留携带正文、工具调用或其他内容的消息。
过滤不得修改共享的源消息。

连续 Chat assistant 消息保留序列化后的分段顺序，但不会重建 Responses
item 身份或同一轮内的语义。目标端可能拒绝连续 assistant、忽略推理，
或自行合并消息。若声明兼容某个端点，仍需单独验证；本次修改不代表
所有协议之间均可无损回放。

## UI 顺序

assistant 输出之后再次出现可见推理时，先暂存此前的输出，再显示新的
摘要。将完成的推理片段放入同一条有序的待提交序列，并保留现有
`gemini_thought` 的折叠展示、耗时和长摘要处理。

暂存位置与摘要是否完成应分别记录。下一条正文开始后，摘要就应显示为
可点击的完成态；稳定的推理组标识让续行及随后提交到历史的摘要保持
同一份展开状态。

已完成的工具组始终位于基于其结果生成的后续回复之前，包括暂存的正文
和推理段。仍在执行的工具组沿用原有显示位置。

在正常结束、工具、取消以及可见控制消息边界按顺序提交这条序列。
全新重试或模型回退时，交错的待提交输出仍应可以整体丢弃，避免失败
尝试中的后续推理附到较早的回答上。不可读的签名属于回放数据，不是
显示正文。

## 验证与验收

验证将覆盖以下标准：

- 转换器测试将检查准确的 `R1,M1,R2,M2` 映射、纯推理段、连续源消息，
  以及源历史未被修改。
- 工具用例将覆盖交错推理与并行调用、调用之间的正文、重复 ID、缺失
  结果和拆出的媒体。每个保留的调用都应有一个紧接调用批次的结果，
  任何结果都不得提前到后续推理之前。
- Provider 测试将检查删除推理时仅移除因此变空的段，保留正文和工具
  内容，并且不修改源消息。
- UI 测试将检查实时与提交后的顺序、可折叠摘要、长摘要、取消、控制
  边界、重试和模型回退，以及已完成但仍暂存的摘要、跨提交的展开状态，
  以及已完成工具位于其后续回复之前。
- 将通过构建后的 converter → provider → SDK 管线向本地严格 HTTP mock
  发出请求，检查实际出站顺序和工具调用与结果的合法性，并检查
  Responses 回放仍保留签名与 item 顺序。

验收将要求上述检查通过，Chat 正文和 UI 输出不含不可读签名，中英文
文档含义一致。Provider 特有的不兼容问题将在出站适配层处理，不通过
压平共享历史解决。只有声明兼容某个远端端点时才需要验证该端点；
远端检查不属于本次本地修复的验收范围。
