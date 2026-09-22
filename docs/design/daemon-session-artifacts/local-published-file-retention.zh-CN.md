# 本地 published 文件的保留策略

[English](local-published-file-retention.md) |
[简体中文](local-published-file-retention.zh-CN.md)

## 状态

已落地（2026-09-21）。本文记录对
[session-artifacts-persistence-v2-design.md](./session-artifacts-persistence-v2-design.md)
§2.2 的偏离：非快照的 `published` `file://` 定位符不再按 `restorable` 写入
journal。

## 问题

Artifact 工具会同时发布 `~/.qwen/artifacts/<id>/index.html` 下的当前页，以及
运行时快照目录里可恢复的历史页。当前页是 `published` `file://` 定位符。V2
默认把所有 `published` artifact 标成 `restorable`，于是当前页被写入会话
journal。恢复并不信任该定位符，加载时出现
`skipped artifact restore: url must use http or https`。`skipped ` 前缀还会被
当成不完整恢复，从而阻止快照文件回收。

## 现状

恢复路径已经只通过 `getWebPreviewSnapshotId()` 信任快照描述符。伪造或 client
写入的 `file://` 记录仍会恢复失败；当它们是剩余的唯一记录时仍会回滚。快照
描述符保持 restorable，并继续走内容读取路由。

## 目标

- Store 仍是安全边界。不要靠字符串匹配藏 warning，也不要放行所有已持久化的
  `file://` 恢复。
- 停止把非快照的 published 文件定位符写入 journal。
- 恢复时安静丢弃匹配的 Artifact 工具历史记录，避免产生 `skipped ` warning，
  也不要挡住快照回收。
- 改动留在 `packages/acp-bridge`。复用 `getWebPreviewSnapshotId()`，不另做
  一套分类器。

## 非目标

- OpenCode 前端的 warning 去重，以及通过内容路由打开快照卡片。
- 改 Artifact 工具生产方或 core 持久化辅助函数。
- 本次不翻译完整 V2 设计。

## 决策

写入时，任何不是快照描述符的 `published + file://` artifact 都强制
`ephemeral`，并设置 `retentionExplicit: true`，即使调用方请求 `restorable`。
当前页仍出现在本会话列表中。

恢复和 marker 恢复时，只丢弃 Artifact 形态的本地页：

- `storage: published`
- `kind: html`
- `source: tool`
- `toolName: artifact`
- 不是快照描述符的 file URL

丢弃时不要加 `skipped ` 前缀。在 stderr 记录
`action=legacy_local_published_dropped`。回滚条件为
`snapshot.artifacts.length - expectedExpiredDrops > 0 && restoredCount === 0`。
伪造的 client `file://` 记录仍会恢复失败。

这只覆盖非快照文件定位符，取代 V2 §2.2「published 默认 restorable」。
HTTP/HTTPS published 定位符和快照描述符不变。

## 约束

- 现有「恢复时不信任已持久化 published file URL」测试仍须回滚。
- `getWebPreviewSnapshotId()` 仍是唯一的快照白名单。
- 不改 core 模块。

## 风险

回放（rewind）时 live 页面仍然可见 —— rewind 调用方使用 `preserveLiveEphemeral`
进行 restore，而该页面现在是 ephemeral —— 但回放之后记录的 snapshot 不再包含它。
这就是丢弃后的 durable metadata 状态；不会产生面向用户的 warning。运维仍然可以
通过 stderr action 看到。

## 验证

- `packages/acp-bridge` 单测覆盖生产形态（省略 `retention` 的批量写入）强制、
  跳过持久化、安静恢复丢弃、workspace/快照混合恢复、marker 丢弃、
  `preserveLiveEphemeral` rewind、重新发布时清除 tombstone、伪造 id 与混合
  journal 回滚、合并后再强制 ephemeral、原有伪造文件回滚，以及 issue #12389
  形态的 journal 回放。
- `cd packages/acp-bridge && npx vitest run src/sessionArtifacts.test.ts`

## 验收标准

- 新的本地 published 页只存在于 live store，不写 durable event。
- 快照描述符仍会持久化并恢复。
- 加载含 Artifact 工具本地页的 journal 时，不再返回
  `skipped artifact restore: url must use http or https`。
- 伪造的已持久化 `file://` 记录仍会恢复失败；当它是剩余的唯一记录时仍回滚。

## 后续工作

OpenCode 应去重恢复 warning，并通过
`GET /session/:id/artifacts/:artifactId/content` 打开快照卡片。该项不在本次
范围内。
