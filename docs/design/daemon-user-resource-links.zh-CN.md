# 用户资源链接的持久化

[English](daemon-user-resource-links.md) | [简体中文](daemon-user-resource-links.zh-CN.md)

## 状态

已在 [#11178](https://github.com/QwenLM/qwen-code/issues/11178) 的拟议修复中实现，等待维护者评审和发布。验证结果记录在 PR 中。

## 问题

ACP 用户 prompt 可以包含携带 URI 和展示元数据的 `resource_link`。实时客户端可以在本地生成附件卡片，但这不能证明已持久化。ACP session 只记录用户文字和 Daemon 原生附件引用，URI 链接在 transcript 回放前已经丢失。SDK 的归一化也会丢弃这些链接。

[PR #11194](https://github.com/QwenLM/qwen-code/pull/11194) 处理了 SDK 投影，但假定本地文件的模型输入就是持久化的用户记录。原始引用必须独立于模型输入展开保存。

## 持久化和回放

将原始 ACP `resource_link` 块保存到现有用户记录的可选 `systemPayload.resourceLinks` 集合。引用来自公开 prompt，覆盖纯附件 prompt，以及模型输入被可信上下文替换的 prompt。传递给 recorder 前对引用生成快照。

现有回放机将保存的块作为 `user_message_chunk` 内容发出，并携带记录的 source、segment、prompt 和 branch 身份。保留 URI、name、MIME type、size、description、title、annotations 和 `_meta`，包括合法的 ACP nullable 字段。原生 `attachmentReferences` 继续使用既有 hydration 契约。

不从 `fileData`、生成的 `@uri` 文字或模型展开后的文件内容推断原始链接。这些形式有信息损失，也可能表示正常的远程媒体而非 ACP 附件。旧记录如果没有保存引用，则无法恢复已丢失的卡片。

## SDK 契约

新增类型化事件 `user.resource_link.delta`，携带 `resourceLink: DaemonResourceLink`。引用保留 ACP 内容判别字段 `type: 'resource_link'`。ACP update 的元数据继续保存在事件独立的 `meta` 字段中。

用户 transcript 块提供可选的 `resourceLinks: DaemonResourceLink[]`。在所属用户块内按 URI 去重，重复回显补齐缺失的元数据。同名不同 URI 保持独立，同一 URI 在不同轮次各自保留。复用现有 reducer 的消息归属、写时复制、保留容量、reset、rewind 和分支重建规则。

这是增量的公开 SDK 契约，需要维护者评审。对事件做穷尽处理的消费者需要新增分支；投影 transcript 链接的客户端应使用正式发布的内容形状。

## 范围和约束

仅保存引用。本次变更不获取 URI、不上传、不预览、不下载，也不创建 `attachmentId`。不改变模型能力、本地文件信任检查、原生附件存储或前端 renderer。独立的轮次内 ACP 内容接收策略保持不变。

## 验证和验收

覆盖原始 prompt 记录、recorder 输出、回放、SDK 归一化和归并，以及离线重建。包含文字加两个同名不同 URI 链接、纯附件消息、重复回显、跨轮次复用 URI、元数据、可信模型专用输入，以及 `transit://`、`https://`、`file://` 的 URI 保留。

验证 reset/rewind 删除被擦除的引用，重建选择当前分支；确认只处理引用而不发起网络请求。Daemon 验收应读取保存的 JSONL，并在重连或重启后重建历史。包测试和 Daemon 验收与已部署下游的浏览器刷新验证分别报告。
