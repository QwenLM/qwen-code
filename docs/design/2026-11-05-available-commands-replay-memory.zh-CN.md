# 有界的可用命令重放内存

[English](2026-11-05-available-commands-replay-memory.md) | [简体中文](2026-11-05-available-commands-replay-memory.zh-CN.md)

## 背景

一个空闲的托管 daemon 反复收到约 2.55 MB 的
`available_commands_update`，其中包含所有已安装技能的完整正文。
断线重放 ring 保存了每个原始对象。实例配置的 32,000 条上限不限制字节数，
而浏览器出口的正文剔除发生得太晚，无法释放原始对象。一次观测中，491 个通知
对应约 1.17 GiB 的序列化输入，堆增长与通知体积高度相关。这是快照保留证据，
并非通过堆快照证明每个分配字节的来源。

## 范围

修改 qwen-code 的通知产生与保留逻辑，不修改 Opencode 的周期性扩展检查或
公开 ACP 事件结构。保留实时 ACP/Desktop 技能详情、SDK/浏览器正文剔除、
事件 ID、epoch 校验和已有断线恢复机制。

## 源头去重

每个 ACP `Session` 串行构建和发送命令快照。对完整的线上的 `SessionUpdate`
计算 SHA-256，仅保存最后一次成功发送的摘要。首次必发，字节相同的快照不再
发送；命令、数组顺序、技能元数据、启用状态或正文变化后重新发送。只在发送
成功后提交摘要，失败不能阻断下一次重试。在排队执行时以及异步发现结束后
检查 held/disposed 状态。即使命令通知被去重，仍执行工作流模式刷新和技能
消费者通知。

## 最新完整快照

共享的不可变投影仅移除 `update._meta.availableSkillDetails`，同时支持
wrapped 和 flat 事件。实时广播和 `publish()` 返回值仍是完整事件。ring 和
两个 compaction journal 保存保留原 ID 和元数据的投影。EventBus 的单独槽
仅保留最新完整命令事件；替换时释放上一份正文，不依赖 journal 淘汰。

断线重放、`snapshotReplay()` 和 `liveJournalSnapshot()` 只在原始 ID 匹配
的位置恢复最新完整事件。较早的命令事件仍保留命令与名称，但不再保留旧技能
正文。这是状态重放，不是技能源码历史档案。如果淘汰或重放截断已经移除了
对应事件，不合成乱序替代事件，继续依赖已有 resync、load 和历史截断机制。

seed 重放采用相同投影，并仅保留最后一个完整命令事件。reset 和 close 清空
ring 与最新槽。随后收到不含详情的命令事件时，清除之前的完整槽，避免重新
出现过期技能正文。不新增协议字段、capability、游标或无 ID 的快照通知。
浏览器/REST 出口复用同一投影，ACP 出口仍传递最新的完整快照。

## Ring 字节预算

通过 `eventRingMaxBytes` 和 `--event-ring-max-bytes` 传递
`EventBusOptions.maxRingBytes`。默认值为 8 MiB，只接受不超过 256 MiB 的
正安全整数，不提供无限制值。该预算独立于 `ringSize`、订阅者队列、
`replayBudgetBytes`、compacted replay 和自适应 journal 扩容。

在每个 ring 项旁记录序列化保留字节数，将最新完整槽与投影 ring 字节一起
保守计入预算。依次淘汰最旧项直到条数和字节都满足上限，但至少保留最新 ring
事件。单个超大事件或完整命令快照是明确例外：保留最新完整状态和至多一个 ring
事件，而不是静默丢掉全部可恢复状态。字节预算衡量序列化载荷，不是精确的 V8
堆上限。

重放预算按照实际恢复后发送的事件计算。ring 淘汰继续使用 `ring_evicted`，
重放超预算继续使用 `replay_budget_exceeded`。不重新编号 ID，也不从保留后缀
中间删除事件。seed/reset/close 清零当前字节计数；累计淘汰数保留为生命周期
诊断。

## 诊断

暴露 `limits.eventRingMaxBytes`，以及每会话的 `eventRingCount`、
`eventRingBytes`、可选的 `eventRingEarliestEventId`、
`eventRingEvictedEvents`、`eventRingEvictedBytes` 和
`availableCommandsSnapshotBytes`。`eventRingBytes` 保守包含最新完整快照槽。
这些增量状态字段区分实际保留、配置上限与本次运行已淘汰的字节数。

## 验证

- Session 的首次、重复、变化、失败、并发、held 和 disposed 发送。
- 不可变的实时全文发送与轻量 ring/compaction 保留。
- 仅最新正文恢复到原始 ID，包括 seed 重放和已完成回合快照。
- ACP/Desktop 初始加载和重连仍拿到最新完整技能详情；SDK/浏览器不暴露正文。
- 条数与字节双限、UTF-8 计费、恰好达到上限、超大项例外、reset/close 和
  累计淘汰计数。
- epoch 不匹配、过旧游标、窗口内连续重放和独立的重放发送预算。
- CLI/fast-path/bridge/status 的默认及自定义值贯穿所有工作区 runtime 构造。
- 使用受控 daemon 反复刷新大命令数据：相同生产端快照不再发送，变更仍实时
  可见，EventBus 保留字节稳定而非随刷新次数增长。

运行包内定向测试、构建、类型检查，以及改动文件的格式和 lint 检查。
已有的[有界重放窗口](2026-07-07-bounded-replay-snapshot-window.md)和
[大帧测量](2026-07-05-large-frame-handling-measurement.md)说明了独立的保留与
发送契约。
