# 会话 Prompt 重新生成元数据

[English](session-prompt-regeneration-metadata.md) | [简体中文](session-prompt-regeneration-metadata.zh-CN.md)

状态：代码已实现；自动化检查与真实环境验证尚未完成。

## 问题

追加原问题来重新生成会在刷新后留下两个 canonical 轮次。本地答案版本状态没有
持久关联。text 块的 `_meta` 不会持久保存；rewind 会排除旧轮次，branch 会创建
另一个会话。

## 契约

先检查 `/capabilities.features` 中的 `session_prompt_regenerate_of`。普通
Prompt 可以在顶层 `_meta["qwen.regenerateOf"]` 携带原 Daemon prompt UUID，
原用户输入回放时会以 `_meta.promptId` 恢复该 UUID。它不是文件历史的
`session########n` ID。非法值会被忽略。

Bridge 回显保留标记，Session 录制保存为
`UserPromptRecordPayload.regenerateOf`；回放重新校验并恢复为
`user_message_chunk._meta["qwen.regenerateOf"]`。SDK 现有元数据透传可保留
该字段。普通 Daemon 公告该能力，hosted persona 不公告；现有按 owner 路由的
会话能力代理会保留该标签。

标记仅供 UI 使用：两个轮次仍追加保存，模型正文、模型历史和鉴权不变。渲染器
只解析同一会话中实际已知轮次的显式关联。不增加路由或第二套存储。

## 发布与验证

先升级 Runtime，再开放客户端入口；回滚后能力缺失时关闭重新生成。存量无标记
历史保持独立，即使正文相同也不自动归组。客户端归组和版本选择、模型历史分支、
resource_link 展开不在本次 Daemon 改动范围内。

定点测试覆盖非法标记、模型输入、journal 持久化、多客户端实时回显、含
resource_link 的回放、SDK 保真与能力公告。重启回放和消费端 UI 验收尚待执行，
简短 E2E 计划位于 `.qwen/e2e-tests/session-prompt-regeneration-metadata.md`。
