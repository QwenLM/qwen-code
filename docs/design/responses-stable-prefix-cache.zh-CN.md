# Responses 稳定前缀缓存

[English](responses-stable-prefix-cache.md) | [简体中文](responses-stable-prefix-cache.zh-CN.md)

## 问题与范围

自动记忆目录和重新附加的图片属于请求临时尾部，带有
`REATTACH_BOUNDARY_METADATA`，不会进入持久历史。Responses 目前忽略了这个边界。
对于 GPT-5.6 及后续模型，覆盖临时尾部的隐式缓存写入，不会在不变的会话前缀末尾
单独写入可复用端点。仅使用稳定的 session cache key 无法修复。必须保留目录、
指令、工具结果、推理、图片及其原有顺序。

## 实现

转换器返回最后一个稳定输入项的位置；必要时也返回该项中最后一个稳定内容块的
位置。这些元数据仅在本地使用。合并调用方请求选项后，pipeline 在最近最多三个
稳定用户文本或工具结果组末尾的 function output 上添加显式断点。保留隐式尾部
断点，使总写入点数不超过四个。在清理孤立工具调用之前应用，确保转换位置仍指向
预期输入项。

应用此策略时，将全部历史用户字符串和 function output 统一为文本块数组，
包括断点轮换后不再带标记的结果。轮换断点不能改变早期文本的表示形式。
Custom tool output 保持原有表示；后面仍有 function 或 custom output 的
function output 不属于结果组末尾。不删除或修改任何文本。

## 兼容性与费用

复用现有 GPT-5.6+ 能力检测。官方 Responses 端点及其默认 URL 自动启用策略。
兼容代理通过现有 `enableCacheControl: true` 或隐式模式的
`extra_body.prompt_cache_options` 显式启用。`enableCacheControl: false`
关闭自动添加。显式模式和调用方已有断点继续由调用方控制。没有临时区域边界的
请求保持不变。

保留 `prompt_cache_key` 和调用方 TTL 设置。不主动选择更长 TTL；省略时保持
服务端默认的 30 分钟生命周期。新增稳定端点可能产生缓存写入，后续读取仍依赖
前缀一致性、路由、有效期和压缩。不保证命中率百分比。机制依据见
[官方 Prompt caching 文档](https://developers.openai.com/api/docs/guides/prompt-caching)。

## 验证与验收

最新 main 的 pipeline 回归必须在修复前失败，修复后通过。覆盖目录之前的用户
文本、工具结果组、六轮断点轮换、图片重附加、工具返回媒体、调用方设置、旧模型
和代理显式启用。核对原始历史、正文、顺序、cache key 和 TTL 不变，显式断点不
超过三个，轮换后仍包含上一轮端点。执行相关测试、build、typecheck、lint 和基于
构建产物的本地回环传输验证。这些本地检查证明请求构造正确；此前受控在线实验
支持根因机制，但不代表当前版本的生产验收，也不是完整长历史命中率测量。
