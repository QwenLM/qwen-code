# 原生 Anthropic thinking 回放

[English](native-anthropic-thinking-replay.md) | [简体中文](native-anthropic-thinking-replay.zh-CN.md)

## 问题

共享历史可能包含设置了 `thought: true` 却没有 `thoughtSignature` 的片段，
来源可能是其他提供方，也可能是不完整的历史响应。当前原生 Anthropic 请求会将其
序列化为无签名的 `thinking` 块，导致重复 HTTP 400。仅凭缺少签名不能确认是
持久化丢失了字段。参见 [issue 15742](https://github.com/QwenLM/qwen-code/issues/15742)。

## 决策

在发出请求的边界执行原生回放约束。复用现有消息级无签名 thinking 清理，
不受本次请求的 thinking 配置或模型代际限制。保留原始存储历史。

将外来推理的展示与无签名 thinking 删除分开。转换器单独接收
`demoteForeignThoughtToText`，仅在原有 adaptive proxy 条件下开启。
原生请求在已完成轮次中丢弃不支持的外来 thinking，不将其摘要转成回答正文。

| 端点                                 | 已完成轮次中的无签名 thinking    |
| ------------------------------------ | -------------------------------- |
| 原生 Anthropic，thinking 开启或关闭  | 删除                             |
| Adaptive Claude proxy，thinking 开启 | 删除；保留既有外来摘要转正文行为 |
| Adaptive Claude proxy，thinking 关闭 | 保留既有行为                     |
| 较旧的兼容 proxy                     | 填入 `signature: ''`             |
| DeepSeek                             | 保留既有规范化、注入和剥离行为   |

## 约束

清理保留已有签名的 thinking。进行中的工具调用链若含无签名块，仍在本地失败：
客户端无法重建其不透明签名，也不能宣称可以安全继续。诊断描述会话历史缺少签名，
不归因于 proxy。清理保持在 assistant 合并和孤立工具修复之后、空 thinking 删除
之前，确保前序步骤中的异常仍能被发现。

无需新增用户配置、迁移会话记录、重构共享 `Part[]`，或按 HTTP 错误猜测重试。
托管侧查询已选择剥离 thinking，不启用本次拆分的两种行为。

## 验证与验收

- 原生请求在 manual 和 adaptive 模型、请求级 thinking 覆盖及模型 reasoning
  关闭时，均删除缺失或空签名的 thinking。
- 显式地址、SDK 默认地址和环境变量提供的原生地址均选择清理。
- 有效签名 thinking、可见回答及已完成工具交换保留；仅含 thinking 的消息消失，
  相邻 user 消息合并。
- 外来摘要不转成原生回答正文；保留 proxy 摘要转换、DeepSeek 和较旧 proxy
  补签名的回归覆盖。
- 单步和多步活动工具循环均在 SDK 请求前失败，包括前序步骤中的空无签名块。
- 转换不修改存储输入，并支持后续回放。

运行转换器和生成器的定向测试、工作区构建与类型检查，以及基于 bundle 的请求
转换复现。真实原生 API 是否接受请求需要单独验证：测试中的假签名不能证明密码学
回放或 preserved-thinking 前缀有效性。现有 `block_binding` 行为保持不变，
真实验收需包含该行为。

## 后续工作边界

只有原始响应与会话记录证据能定位具体机制时，才进一步调查签名丢失或恢复与持久化
的差异。本次改动恢复已完成历史，不修复进行中的工具循环，也不解决更广泛的历史
表示问题。
