# Daemon 会话权限模式持久化

[English](daemon-session-approval-mode.md) | [简体中文](daemon-session-approval-mode.zh-CN.md)

## 问题

权限模式是每个 daemon 会话 `Config` 中的运行时状态。最后一个客户端离开后，daemon 可能关闭 ACP 子进程。随后冷加载会话时，新 `Config` 从 workspace 和 CLI 默认值初始化，因此原先切换到 Full Access 的会话可能静默恢复为其他模式。

`persist: true` 不能解决这个生命周期问题，因为它会改变以后所有会话的 workspace 默认值。会话需要自己的持久状态。

## 设计

Transcript 使用最后一条有效的 `system/session_approval_mode` 记录保存 `{ mode, prePlanMode?, planExecutionMode? }`。Plan 记录保留进入 Plan 前的非 Plan 模式，使冷恢复后的普通审批退出回到该模式。若 Plan 另行选择了执行权限，审批退出则优先采用该权限；可选字段让它也能跨恢复保留。没有该字段的旧记录仍可恢复。读取器独立于 replay 和 compression 选择，从当前有效 UUID 链中提取最后一条有效记录。Rewind 会在新分支上重新记录当前状态。

Canonical `Config` 的权限模式监听器记录成功的运行时切换。派生 agent config 不发布变化。如果会话的初始模式从未变化，就在第一次真实 user、Goal 或 cron 活动前写入锚点。构造会话和冷恢复时应用历史状态本身保持只读。构造后显式改变权限模式（包括创建请求携带的覆盖）会立即记录，确保首次 prompt 前冷加载也能恢复该模式。

冷加载在构造运行中的 `Session` 前应用恢复的权限状态，因此恢复本身不会触发新记录。从启动 Plan 模式进行的合成退出既不会排队“手动退出”提示，也不会批准 workflow 计划版本。Bare 和 safe 启动模式忽略历史权限状态。通过 `Config.setApprovalMode` 重新评估当前 workspace trust；若保存的特权 Plan 前置模式被拒绝，就退回当前安全模式。显式 load 或 attach 权限覆盖在之后应用，因此优先于历史记录。Workspace settings 重载仍以原始文件派生模式作为比较基线，因此文件未变时不会覆盖恢复的会话状态。

## 验证与验收

可信会话在冷加载或 daemon 重启后必须恢复最后的模式，且不改变其他会话。普通 Plan 恢复后必须保留真实审批退出所用的前置模式；另选的 Plan 执行权限也必须保留。显式 load 覆盖须在当次和下一次冷加载时生效。当当前 trust 拒绝历史特权时，真实权限敏感操作仍须请求审批。测试还覆盖未发生模式变化的创建只读、显式变化立即记录、非法尾记录、写入前失败后重试、rewind 以及 fork/checkpoint 分支选择。

## 兼容性与失败语义

HTTP 请求和响应结构不变。`persisted` 仍仅表示 workspace settings 写入成功。会话 transcript 写入尽力而为，并沿用现有的 recording-degraded 报告路径；磁盘故障不会拒绝已成功的实时权限切换。记录尝试失败不会缓存新模式，但仅在 recorder 仍健康时后续操作才可重试；append 失败会使该 recorder 持续降级。旧版本记录的会话没有权限记录，在下一次真实活动写入初始锚点前继续使用当前 workspace 或 CLI 默认值。如果当前 trust 拒绝历史特权，后续活动会记录安全模式；重新设为可信也不会自动恢复先前的特权模式。

一次性授权、待处理权限请求、权限 revision、AUTO 拒绝计数、临时权限规则调整和派生 config 状态均不持久化。
