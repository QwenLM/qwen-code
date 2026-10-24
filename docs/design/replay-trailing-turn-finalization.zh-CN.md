# 实时历史重放中遗留工具调用的终结

[English](replay-trailing-turn-finalization.md) | [简体中文](replay-trailing-turn-finalization.zh-CN.md)

## 问题

忙碌会话调用 `qwen/session/loadUpdates` 时，禁用悬空调用终结可以保护活跃工具，但也会
让较早回合中未匹配结果的调用在重建视图里一直保持运行中（#9953）。遗留的后台工具因此
可能使客户端在任务快照已为空时仍继续轮询。

## 边界与范围

完整的批量重放只保留最后一个 replay 回合来源的未匹配调用。复用 transcript reader
的 `isReplayTurnStartType`，但排除实时语音消息：语音对话记录不进入模型历史，也不拥有
工具，不能据此越过仍活跃的工具调用。普通用户记录开启回合；轮中输入、cron、notification、
Goal 和 session-agent 内联消息不另开回合。无法确定回合起点时，保守地保留未匹配调用。

这是重放视图的边界，不新增运行时准入或 rewind 模型，也不能证明尾部回合里的每个未匹配
调用都仍在执行。是否忙碌继续由既有调用方判断。空闲重放仍终结所有未匹配调用，显式的
restore 豁免除外。

这一渲染边界不识别自治执行回合：cron、Goal 和 notification 活动可能都归在最后一条
普通用户记录之后，同组内部的遗留调用仍会保持 pending。notification 还可能在准入前
持久化，或在活跃回合中以内联方式被消费，因此仅凭 subtype 不能安全判定新的执行边界。
更广的自治回合清理需要执行或交付证据及 maintainer 确认，而不是放宽共享的渲染分类规则。

## 改动

批量重放确定尾部回合的来源记录 UUID 集合，再允许既有 replay machine 终结该集合之外
的未匹配调用。调用与结果的配对仍由状态机负责。按来源 UUID 保留，可以避免重复 call ID
被重命名后，原始 ID 的豁免同时保护了另一条较早的调用。保留回合中的所有并行调用仍可
接收真实结果。

既有 `skipFinalizeCallIds` restore 豁免继续生效。未完成的实时重放不终结旧调用，因为
尚未读取的记录可能包含其结果。记录顺序、持久化 transcript、重放 cursor 格式、工具
执行、模型历史和读写屏障保持不变。

`replayPage` 保留既有布尔契约：尚未结束的页不终结调用，因为结果可能在后续页。本次
改动只覆盖完整批量重放；忙碌会话的分页读取仍是独立问题。

## 消费者与验证

共享 replay machine 服务 ACP 历史重放、SDK transcript 视图和 HTML 历史导出。新增的
来源记录豁免为显式启用，仅由 CLI 批量重放传入；其他消费者保留默认行为。
`collectHistoryReplayUpdates` 继续转发 ACP load/resume 和
`qwen/session/loadUpdates` 的既有忙碌或空闲判断。

回归测试覆盖遗留 A 与活跃并行 B/C、重复 ID、新 prompt 尚无工具调用、延迟结果、不完整
重放、restore 豁免和跨页配对。运行受影响的 CLI 与 bridge 测试、build、typecheck 和
bundle。已记录的 test-script 复现还检查客户端状态及后台任务轮询；真实模型执行阻塞或
幻觉并非本 Issue 已证实的后果。

第一轮复验在预置较早 cron/Goal 调用记录的会话中执行真实 ACP notification 回合，确认
该形态下的清理缺口；还在活跃 shell 调用与其结果之间持久化 notification，对这份真实
快照应用所建议的 subtype-only 边界
会错误终结活跃调用。另一个真实跨 prompt 后台 shell 场景中，job 仍在运行，但启动调用
已经有持久化结果，重放为 completed。这些观察不能证明适用于所有情形的跨回合存活性约束。
