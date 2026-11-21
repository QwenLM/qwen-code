# Daemon ACP 通道传输 liveness

[English](2026-08-24-daemon-channel-transport-liveness.md) | [简体中文](2026-08-24-daemon-channel-transport-liveness.zh-CN.md)

## 问题

daemon 知道 ACP 子进程何时退出、或其有界 NDJSON 传输何时拒绝一帧，但无法检测一个仍然活着、事件循环或传输却停止应答的子进程。会话 active-work 快照填不上这个缺口：单个 Session 的沉默不是共享通道已死的证明，而用该信号回收子进程会毁掉其上每一个多路复用的 Session。

#8586 的第 2 层增加一个独立的通道级 liveness 契约。它不改变 `activeWork`、Session 清理或逻辑 Agent 进度检测。

## 范围与归属

一个 `AcpSessionBridge` 拥有一个 workspace runtime，至多一个可 attach 的 ACP 子通道。因此 liveness 监控属于 `ChannelInfo`，而不属于 Session。一次失败判处整个子进程死刑，因为该传输上的每个 Session 都已不可达。

监控只覆盖在 `initialize` 期间确认 v1 能力的 daemon 自有 ACP 子进程。不确认的较旧或替代子进程保持当前行为。直接 ACP 消费者与通道适配器不变。

## 线路契约

daemon 声明如下 initialize 元数据：

```json
{
  "qwen.daemon.channelLiveness": { "v": 1 }
}
```

支持的子进程在 initialize 响应中回显同一元数据。协商完成后，daemon 周期性地调用只读扩展方法：

```text
qwen/status/channel/ping { v: 1, nonce: N }
  -> { v: 1, nonce: N }
```

`nonce` 是在通道生命周期内单调分配的非负安全整数，在 `Number.MAX_SAFE_INTEGER` 之后回绕到零。daemon 只接受版本与 nonce 的精确回显。v1 确认之后的畸形响应或请求 rejection 是确定的协议失败；它不消耗超时重试预算。

该方法不跨越任何 Session id、工作状态、超时或进程细节。

## 计时与升级

固定的内部策略是：

- 健康探测之间等待 15 秒；
- 单次响应允许 10 秒；
- 第一次按时超时后立即重试；
- 第二次连续按时超时后，判处传输失败并回收通道。

这在子进程恰于健康探测后卡死时把检测上界约束在 35 秒，同时要求两个独立无应答请求才拆除多路复用的 Session。成功响应重置连续超时计数。这些值是实现策略而非公共配置，与 #8586 的非目标一致。

> **部分被取代（2026-11-21）：** 上述两次 strike 升级如今只适用于没有观察到 CPU 进展的超时。消耗 CPU 的 agent 在被判处失败前获得有界忙碌宽限（至多 6 次），且每次失败与每次忙碌宽限都携带进程证据（pid、state、wchan、CPU 增量、RSS、计数器）。因此 35 秒上界只对零 CPU 卡死成立。见 [通道 liveness 忙碌宽限与失败证据](2026-11-21-channel-liveness-busy-grace.zh-CN.md)（[English](2026-11-21-channel-liveness-busy-grace.md)）。

至多两个请求可以保持未决：第一个超时请求及其重试。ACP 请求 id 使迟到的第一次响应与重试分离。通道一旦被判处失败，既有传输 teardown 关闭两者。

## 宿主挂起与父进程停摆

每个调度回调用 `performance.now()` 记录其预期触发时间。若间隔回调或探测超时回调在其预期单调 deadline 之后超过 1 秒才运行，daemon 把该观察视为本地调度缺口并清零 miss 计数。迟到的间隔开启新间隔；迟到的探测超时保持同一个有界请求未决并给它一个新的响应窗口。它不从父进程自己没能按时运行的定时器推断子进程的任何事情。

这覆盖单调时钟跨宿主挂起继续前进的平台。在挂起期间时钟暂停的平台，定时器 deadline 随之暂停，不产生逾期回调。墙钟变化从不参与。

该规则也防止 daemon 事件循环的长暂停记入子进程超时。它不因 daemon 早前忙碌而赦免一次按时超时；立即重试提供第二次观察。

## 生命周期与失败路径

监控只在 initialize 成功且通道发布后启动。其定时器 unreferenced，使否则空闲的 daemon 可以退出。它在传输失败、通道退出、同步 kill-all 与优雅 shutdown 时停止；每个回调也复查同一通道仍然存活且非 dying。

终局 liveness 失败在开始 teardown 前进入既有传输失败路径：

1. 同步标记 `ChannelInfo` 为 dying，使新 Session 工作不再被接纳；
2. 为遥测保留有界失败码；
3. 清理在飞扩展刷新簿记；
4. 请求 daemon 传输 guard 失败并终止子进程，或对无 guard 的注入通道调用通道普通 kill 回退；
5. 由既有 `channel.exited` handler 移除每个多路复用 Session、发布 `session_died` 并释放通道状态。

这保持既有重叠不变量：替代通道可以在 dying 通道对 `killAllSync` 仍可达（直到 OS 回收）期间被 spawn。

## 可观测性

升级开始时 daemon 发一个 `channel.liveness_failed` 遥测事件与一条有界 stderr 行。既有 `channel.exited` 事件随后报告 `transport_failed=true`、`transport_failure_initiated_teardown=true`，以及 `acp_channel_liveness_timeout` 或 `acp_channel_liveness_protocol_error`。

不新增健康或状态响应字段。公共健康保持为观察面，而非同步探针。

## 兼容性与非目标

- 未确认的能力对该通道禁用监控。
- 既有 Session active-work 报告与条件关闭行为不变。
- 逻辑上停摆但进程仍有应答的 Agent 仍会回答 ping；第 3 层拥有进度 watchdog。
- runtime 世代 draining 与恢复仍属第 4、5 层。
- 没有公共超时设置、持久化变更、传输重试、Session 级 kill，或从 active-work 快照推断。

## 验证

单元覆盖钉住协商、精确 ping 回显校验、健康节奏、超时重置、两次超时升级、本地定时器延迟抑制、清理、旧版兼容，以及失败通道上每个 Session 的 teardown。子进程侧测试钉住 initialize 确认与无状态 ping 响应。

E2E 计划只用 `SIGSTOP` 冻结 ACP 子进程以复现当前缺口并验证通道回收。宿主挂起安全性是确定性单元覆盖，因为真实机器挂起在 CI 中无法可靠或可移植地制造。
