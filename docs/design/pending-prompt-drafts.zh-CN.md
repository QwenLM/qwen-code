# 排队草稿

[English](pending-prompt-drafts.md)

队列摘要不足以在刷新后还原问题：展示文本和媒体省略了业务上下文。按会话 owner 授权的 pending-prompts 接口接收 `includeDraft=true`，可选返回真实受理的 prompt blocks 和业务 `_meta.context` 组成的 `queueDraft`，同时返回 `restoreComplete=true`。默认响应不变。受理时独立复制，读回再次复制。

仅支持 context 元数据。未知 metadata、可信 model-prompt 覆盖、Channel 展示覆盖、由 mid-turn 晋升的请求不生成完整草稿。身份、路由和内部 metadata 不作为草稿回显。context 沿用现有调用方业务语义与授权边界，不作为认证通道。宿主必须验证能恢复的上下文 schema 和内容。完整草稿不代表允许将 resource 或带上下文的问题转成 mid-turn 文本。

验证覆盖复制隔离、路由显式 opt-in、外部 client 拒绝、未知 metadata。验收应排队纯文本和带上下文的问题，刷新后恢复支持的草稿，继续拒绝不支持的草稿。旧 daemon 和缺草稿的历史队列条目保持不可恢复。不新增持久队列或 daemon 重启恢复。

## 回退身份

文件快照可能仅覆盖会话恢复后的尾部，其数组位置不是持久历史的用户轮次序号。原生回退定位唯一的持久用户记录与 API 历史 prompt 标记，返回全局序号和 `sourceRecordId`，独立保留文件快照位置。历史变更锁内再次核验 `expectedRecordId`。缺失、重复或压缩导致的映射不一致在变更前拒绝。测试覆盖快照 25–35 与完整 35 轮历史以及身份不符。宿主必须拒绝缺少持久身份的快照；旧运行时的安全拒绝是预期行为。
