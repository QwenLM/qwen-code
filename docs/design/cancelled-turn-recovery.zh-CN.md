# 已取消轮次的恢复

[English](cancelled-turn-recovery.md) | [简体中文](cancelled-turn-recovery.zh-CN.md)

## 问题与范围

明确取消 daemon 任务后，恢复历史可能看起来像崩溃中断。恢复必须查询现有轮次终态并拒绝已停止任务，真正中断的任务仍可继续。本修复覆盖普通 daemon Cancel、活跃 Close 和 SDK 传输中断。channel 生命周期关闭和 detach 失败回退按中断处理，显式 channel Cancel 仍表示用户意图。远程 Host 策略不在本修复范围内。

## 最小生命周期

复用已记录的 prompt 身份、压缩中的 prompt ID 和轮次终态。合法取消终态带有限取消时间时禁止恢复。显式用户来源区分当前用户取消与传输中断；只有时间戳的旧记录来源未知，也禁止 Continue。实际接受的新模型输入替换取消边界；本地命令、提醒、压缩和无关迟到终态不会替换。Retry/Continue 不写新可见用户记录，因此只记录必需的执行 attempt。

现有 recorder 在恢复准入和最终执行时读取活动转录分支。终态同时保存已有客户端 prompt ID 和 daemon 结果 ID；Retry/Continue 在发送前严格写入执行 attempt。恢复将这些记录与已有 API-history 身份比较，因此本地命令和回滚输入不能替换已停止的模型任务。Continue 准入和最终执行门禁直接读取转录。同步 UI 状态沿用原有结构判定，取消拒绝检查位于能够启动执行的操作。不新增客户端状态、Session 取消缓存、加载时读取或转录 reader 索引。

恢复准入和最终 Continue 执行都检查这一边界。拒绝的 Continue 不创建 attempt 或终态。普通 SDK/REST/ACP 路径通过元数据传递传输中断。后到的用户 Cancel 独立发送，服务器等待两个取消握手排空再推进 FIFO。SDK 保留已有公开 cancel 方法及 Promise 去重。生命周期中断独立发送，避免吞掉后到的用户 Cancel。非交互准入读取浅层历史保留已有 prompt 身份，planner 继续使用克隆历史。

## 验收与限制

使用构建后的 daemon 和隔离 provider：read_file 后 Cancel，重启、重新关联并 Continue，必须拒绝且零新增请求。不 Cancel 而 SIGKILL 的对照必须可以继续并完成。只有时间戳的旧取消必须连续拒绝且不修改转录。用定向检查验证新输入、本地命令、回滚、压缩、迟到结果和活跃 Close。

远程 Host/channel 归因扩展、未标记自动输入及先前中断后的空闲 Close 留在 #13502 等独立工作中。不包含迁移或发布。

## 旧记录显式确认

本后续仅为现有 daemon/WebShell Continue 路径增加显式确认。复用经校验且唯一归属的旧时间戳终态 UUID 作为确认 ID。Context 暴露此 ID，准入及最终执行必须匹配同一个当前 ID。明确用户取消、归属不明或损坏的证据、缺失或过期确认继续拒绝。记录不可用时禁用 Continue，同时保留只读 context 的其余内容。不新增缓存、planner 字段、索引或迁移。

WebShell 复用现有恢复横幅和所有权保护，通过浏览器原生确认框询问，再沿现有 SDK/REST/ACP 路径传递 ID。状态是确认 ID 的唯一来源；拒绝后由现有 action 刷新。Stream-json 续跑沿用 main 对取消记录的拒绝。取消通知、转录投影、Goal 和队列策略均沿用 main 行为。

验收：关闭确认框不发请求；当前 ID 仅恢复一次；缺失或过期 ID、明确用户 Cancel 和歧义记录均不发模型请求。记录执行尝试前和模型执行前再次校验边界，不能绕过后到取消。新任务仍可正常执行。关闭记录或记录不可读时，context 仍可读取。
