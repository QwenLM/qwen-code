# 已取消轮次的恢复

[English](cancelled-turn-recovery.md) | [简体中文](cancelled-turn-recovery.zh-CN.md)

## 问题与范围

主动取消 daemon 任务后，恢复出的模型历史可能与崩溃轮次相同。恢复必须读取已有 `turn_result`，区分用户意图和基础设施中断，并拒绝续跑用户停止的工作。来源未知的旧取消记录仍要求确认。模型响应与工具修复语义保持不变。

## 轮次身份与终态

客户端 prompt ID 标识逻辑输入，daemon prompt ID 标识执行及终态。活动 transcript 分支通过用户记录与 `turn_attempt` 关联二者。完整与选择性恢复共享经过验证的归属解析，包含压缩前的记录，且不依赖回放窗口。唯一可归属的用户取消要求 `state: 'cancelled'`、有限 `cancelledAt`、`cancelReason: 'user'` 及无歧义的所属执行。缺失或重复身份不能证明用户意图。最新有效的时间戳取消记录在归属不明或旧来源不明时提供未知取消边界。后续模型输入、attempt 或终态取代该兜底边界；已从模型历史排除的本地命令不取代它。

`LlmClient` 持有当前执行 ID 与规范化取消结果。实时结算和冷恢复使用同一个终态规范化函数。模型输入准备成功后接受已有 invocation ID（直接调用使用已有模型 prompt ID），终态结算只更新该执行。准备失败并回滚输入时不能替换其所有者。发送前取消如果保留输入，则显式接受该输入。仅取消准入，以及另一执行延迟到达的终态，都不能取消当前工作。

持久化 Retry attempt 在异步准备前推进执行归属；Continue 只在最终恢复与确认检查通过后推进。拒绝的 Continue 在创建转录记录前返回，连续空操作请求不能抹掉旧取消边界。已接受的 attempt 保留此前取消，实际输入准备成功后才清除旧结果。恢复工具交互只在通过 restore no-op 检查后写 attempt；写入失败拒绝执行。压缩、启动提醒、工具结果清理及新 chat 实例只改内容，不改逻辑执行。显式历史替换、rewind 和 clear 使执行归属失效。消息数组不携带取消状态，无需取消快照或重新标记。

## 取消与确认

取消来源通过已有取消元信息传递。人工 Cancel、删除排队输入与 active client Close 携带用户意图；传输关闭、超时、Channel steering、自动拆除、runtime disposal 和普通 SDK abort 携带中断。Remote Host Stop 保留明确的 lease 来源，重启 fencing 不制造用户意图。后续人工取消可升级正在进行的中断，FIFO 在两次取消握手完成前不推进归属。只有用户意图写入持久标记；中断提示保留中断措辞。

旧时间戳不能单独证明用户意图。未知取消禁用自动续跑，并暴露终态执行 ID。WebShell 解释不确定性；REST、ACP、SDK 和 stream-json 在显式确认时回传该 ID。准入与最终执行重新检查当前边界；缺失、过期或不匹配确认不发模型请求，确认也不能绕过已证明的用户取消。无效终态不提供来源，历史缺口仍走 degraded-history 保护。

## 验证与验收

使用受控 loopback provider 和真实构建 daemon：执行 `read_file`，挂起下一次 provider 响应，主动 Cancel，重启并重新挂载（`POST /session/:id/resume`），再 Continue。必须拒绝，且不增加 provider 请求。配对对照省略 Cancel，在挂起响应时 SIGKILL；重启、挂载后必须可续跑，并到达关联终态。明确取消已刷盘后再 SIGKILL，仍必须拒绝恢复。未挂载就 Continue 返回路由 404，不能证明任一行为。

验证完整/选择性恢复、压缩历史、用户/未知结果经过完整及快速压缩和空闲清理、准备回滚、本地命令、新输入、延迟结算、显式历史替换、废弃分支及畸形归属。准入与最终执行都检查缺失/当前/过期旧取消确认。Retry 测试使用 bridge 错误轮次或直接 ACP retry；bridge 在取消完成后重新提交属于新输入。保留取消升级与 FIFO 握手覆盖。

## 风险与剩余工作

本范围覆盖有记录的 daemon 取消，不为独立 TUI 路径制造持久来源。未标识 cron/steering 边界仍可能阻断归属解析，跳过它们又可能抑制合法新输入。确切 Todo Stop Guard 和 task-notification 处理尊重已标识输入及冷记录的通知计数，包括零。这些剩余归属决策留在 #13502。active/等待准入的 client Close 保留意图，但先前中断后 idle Close 仍缺持久关闭标记。不含 transcript 迁移或发布。
