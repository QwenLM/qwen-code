# 在工具调用之间保留 Claude thinking

[English](2026-09-24-anthropic-thinking-binding.md) | [简体中文](2026-09-24-anthropic-thinking-binding.zh-CN.md)

## 问题

Claude Opus 5.5 在工具调用续接时返回了 400 `Invalid signature in thinking block`。成功响应中的带签名 thinking 以两个换行结尾，但历史合并删掉了换行，同时保留了签名。后台 MCP 发现还在两次请求之间改变了工具声明，导致 thinking block 所绑定的对话前缀发生变化。

## 改动

合并历史时逐字节保留 thinking 文本，包括文本为空但带签名的块。`trim()` 仅用于丢弃没有签名的空文本。对于 Claude Opus 5.5 的 adaptive 请求，从首轮起同时发送 `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` 和 `thinking-binding-controls-2026-08-01` beta header。当前缀变化时，服务端可以丢弃不匹配的块，且各轮请求的设置保持一致。

## 验证与限制

单元测试覆盖末尾空白、空文本签名块，以及工具声明变化后的续接。全新 Opus 5.5 交互会话原样回放了带签名 thinking 的末尾换行，并完成了工具调用续接。该交互测试没有改变工具声明；工具变化由请求构造测试覆盖。已持久化且 thinking 文本被改动的旧会话应重新开始。
