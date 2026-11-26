# Managed 附件容量

[English](2026-10-18-managed-attachment-budget.md) | [简体中文](2026-10-18-managed-attachment-budget.zh-CN.md)

## 问题与范围

48 KiB 内联输入上限无法容纳日常截图和小文本文件。目标为单次提交支持约 5 MiB 附件，并保留完整输入字节、幂等重试、消息投影和有界的模型恢复能力。本设计扩展[Managed Plan 与附件](2026-10-18-managed-plan-attachments.zh-CN.md)中的附件契约。

## 容量与存储

整份 canonical UTF-8 JSON 输入允许 8 MiB，包含文字、名称、MIME 和 base64 图片，足以容纳 5 MiB 图片及其 base64 开销。保留现有文件格式和模型图片能力校验。

仅 `managed-input` 允许 8 MiB 内联资源，`hosted-model-request` 允许 32 MiB 内联资源，其他种类保留现有 64 KiB 上限。用户记录沿用现有 60 KiB 消息分片，带附件的用户记录允许 9 MiB，为元数据和文本文件包装留出空间。内联资源事务总量上限单独设为 40 MiB，日志记录事务上限仍为 8 MiB。现有 LONGTEXT 和 LONGBLOB 列无需数据库迁移。

模型快照包含历史及预备请求，同一图片可能出现两次。捕获和读取预算增加至 32 MiB，其他恢复描述仍限制为 64 KiB。保留摘要、租户、Session 和 activation 校验。receipt checkpoint 快照包含全部资源，总量限制为解码后 128 MiB、JSON 192 MiB，同时保留每种资源的独立限制。

公开签名请求体与 daemon 请求体上限仍为 10 MiB。内部 Session Store 提交使用既有 writer 凭据，不经过公开签名认证。内部提交 JSON 解码器允许接收 32 MiB 资源的有界 base64 表示，下游每种资源和事务总量校验仍为准入依据。

## 浏览器重试持久化

小 pending 请求继续存于 sessionStorage，以兼容已有数据。大 pending 请求存于 IndexedDB，并在原有 sessionStorage key 中保存当前标签页的随机引用。先提交 IndexedDB，再发布引用，最后才允许发出 API 请求。恢复完成后才启用提交，保留原始幂等键和 canonical 输入，准入成功或用户显式丢弃后清理存储正文。持久化失败仍阻止发送。复制的标签页可能在其他标签页清理正文后仍保留引用。恢复失败时继续阻止自动提交，提示此前提交可能已经成功，并提供显式丢弃本地记录的入口，绝不静默发起新请求。

## 影响范围与部署

更新 Managed 输入框的输入和 pending 请求路径、Java 输入/OpenAPI 校验及 Session Store 资源预算、Core HTTP 资源发布与恢复解析、Hosted 准入与模型捕获，以及 receipt checkpoint 读取器。从 OpenAPI 重新生成 Web Shell API 类型。依赖更大预算前同步部署兼容的 Java 和 Harness 读写端；旧二进制仍拒绝大输入。本次不包含上传服务、对象存储接入或新文件格式。

## 验证与限制

验证约 5 MiB PNG、超过 48 KiB 的文本文件、整份 canonical 输入超过 8 MiB 时拒绝、真实 sessionStorage 配额下刷新后精确恢复 pending、Java 准入/重放/投影、每种资源上限、消息分片、模型请求捕获/读取和 checkpoint 检查。运行定向测试、根目录 build/typecheck/bundle 及受影响 Java 验证。区分确定性本地验证与真实模型、部署后验收。

输入容量不保证无限会话：模型快照、checkpoint 导出、模型上下文窗口和 Function Hook 消息预算仍然有限。保留显式拒绝或 recovery-blocked 行为，不截断历史或附件。产品决策均已确定，目标为单次提交约 5 MiB。
