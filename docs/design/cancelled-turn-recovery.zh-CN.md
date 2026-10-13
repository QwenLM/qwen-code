# 已取消轮次的恢复

[English](cancelled-turn-recovery.md) | [简体中文](cancelled-turn-recovery.zh-CN.md)

## 问题与范围

明确取消 daemon 任务后，恢复历史可能看起来像崩溃中断。恢复必须查询现有轮次终态并拒绝已停止任务，真正中断的任务仍可继续。本修复覆盖普通 daemon Cancel、活跃 Close 和 SDK 传输中断，不重新设计远程 Host 或 channel 的取消策略。

## 最小生命周期

复用已记录的 prompt 身份、压缩中的 prompt ID 和轮次终态。合法取消终态带有限取消时间时禁止恢复。显式用户来源区分当前用户取消与传输中断；只有时间戳的旧记录来源未知，也禁止 Continue。实际接受的新模型输入替换取消边界；本地命令、提醒、压缩和无关迟到终态不会替换。Retry/Continue 不写新可见用户记录，因此只记录必需的执行 attempt。

客户端在内容改写期间保留所属执行和归一化终态。输入准备成功后接受执行，回滚不会接受；结算只更新所属执行。显式历史替换、回退和清空使旧归属失效。完整与选择性冷恢复在当前转录分支上按已有身份绑定结果。不添加消息数组取消快照、symbol 迁移或 Todo 文本分类器。

恢复准入和最终 Continue 执行都检查这一边界。拒绝的 Continue 不创建 attempt 或终态。普通 SDK/REST/ACP 路径通过元数据传递传输中断。后到的用户 Cancel 独立发送，服务器等待两个取消握手排空再推进 FIFO。SDK 保留已有公开 cancel 方法及 Promise 去重。

## 验收与限制

使用构建后的 daemon 和隔离 provider：read_file 后 Cancel，重启、重新关联并 Continue，必须拒绝且零新增请求。不 Cancel 而 SIGKILL 的对照必须可以继续并完成。只有时间戳的旧取消必须连续拒绝且不修改转录。用定向检查验证新输入、本地命令、回滚、压缩、迟到结果和活跃 Close。

旧取消确认保留在 draft #14087。远程 Host/channel 归因扩展从本 PR 删除，沿用它们既有策略。未标记自动输入及先前中断后的空闲 Close 留在 #13502。不包含迁移或发布。
