# ACP 嵌入式文本资源的持久化回放

[English](daemon-embedded-resource-replay.md) | [简体中文](daemon-embedded-resource-replay.zh-CN.md)

## 状态

针对 [#12538](https://github.com/QwenLM/qwen-code/issues/12538) 的拟议修复。构建、测试和运行态证据记录在 PR 中。

## 问题

ACP `session/prompt` 接收嵌入式 `resource` 块，并将其内联内容交给模型。持久化用户记录保留 Prompt 文字和 `resource_link` 引用，却不保留原始的类型化 `resource`，因此刷新或重启后 transcript 回放与 SDK 离线投影会丢失该资源。这不同于 Daemon 原生 `attachmentReferences`，也不同于 #12088 修复的 `resource_link`。

## 持久化与回放

从提交的 ACP Prompt 快照原始嵌入式文本资源块，存入所属用户记录可选的 `systemPayload.embeddedResources`。采集发生在模型输入展开之前，因此可信的 model-only 指令不会覆盖用户原始资源。纯资源 Prompt 也会生成 payload。Daemon 标记由原生附件引用展开得到的输出位置，只将这些位置排除在内联大小预算之外；URI 相同的直接资源仍独立回放。对于没有位置字段的旧 Daemon 元数据，仅按 URI 排除能唯一对应的原生资源；同 URI 的多个块会保留而非静默丢弃，并受内联大小预算约束。原生引用继续作为自身的预览来源，不额外生成重复的嵌入式资源卡片。

回放器验证保存的文本资源块，并逐个作为 `user_message_chunk` 发出，保留 URI、MIME 类型、文本、ACP 元数据、Prompt ID、来源记录 ID 和分支身份。回放不会访问 URI，也不会伪造 `attachmentId`。修复前的旧记录无法恢复当时未保存的资源。rewind 和有效分支选择继续使用既有的 transcript 记录关系图。

## SDK 契约与保留策略

Daemon UI SDK 暴露携带类型化 `DaemonEmbeddedResource` 的 `user.resource.delta`，并将资源保存在 `DaemonTextTranscriptBlock.embeddedResources` 中。标准化过程使原始 ACP 块与 `resource_link`、原生文件事件保持区分；reducer 将资源归入所属用户轮次，并计入 transcript 保留预算。同一轮中完全相同的资源块回显会去重，不同轮次中的相同 URI 仍分别保留。

本契约仅保留文本资源。一个 ACP Prompt 内序列化的直接嵌入式文本资源块合计最多 256 KiB；超限的直接文本 Prompt 会在 Daemon 向其他客户端实时回显前拒绝，子进程也会在轮次录制前复核。通过新位置元数据识别的原生文本附件不受此限额约束；旧元数据下的歧义块仍受其约束。Blob 资源仍按现有方式进入模型，但本契约不持久化；大体积内联 Blob 的保留需要独立的存储策略。客户端提供的 URI 和元数据会被保留，而不会被抓取。新保留的用户内容仍由现有 journal 与 transcript 访问控制保护。

## 验证与验收

覆盖文字加资源、纯资源 Prompt、多个资源、下一轮不含资源、与原生附件并存（包括超过 256 KiB 的原生附件和同 URI 的直接资源）、直接超限文本在回显前拒绝、非法持久化资源、Prompt/来源身份、有效分支重建、rewind、SDK 标准化与归并，以及 Daemon 重启后的回放。包级测试证明代码行为；运行中的 ACP Session 加持久化记录及 `session/load` 回读证明运行态行为。下游产品页面刷新属于独立的部署验收步骤。
