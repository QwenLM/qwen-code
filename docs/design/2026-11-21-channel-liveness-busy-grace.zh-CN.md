# 通道 Liveness：忙碌宽限与失败证据

[English](2026-11-21-channel-liveness-busy-grace.md) | [简体中文](2026-11-21-channel-liveness-busy-grace.zh-CN.md)

状态：已实现并验证（2026-11-21）

## 问题陈述

daemon 的 ACP 通道 liveness 监控（`packages/acp-bridge/src/channel-liveness.ts`）
每 15 s（`CHANNEL_LIVENESS_INTERVAL_MS`）向 agent 子进程发一次探测，要求 10 s
（`CHANNEL_LIVENESS_PROBE_TIMEOUT_MS`）内应答，连续 2 次准时超时
（`CHANNEL_LIVENESS_FAILURE_THRESHOLD`）后 SIGKILL 整个通道进程。一个通道承载
多个会话（观察到的事故中为 4–5 个），因此一次误杀会撕掉其上的全部会话：在飞
回合死亡，prompt ledger 记入 `terminal: "error"`，下一次 Web Shell 加载即显示
`interrupted_prompt` 恢复横幅（"The previous request was interrupted before
the response completed."）。

监控无法区分**暂时忙碌或停摆**的 agent（GC 暂停、重同步工作、调度延迟、停摆的
ndjson pump）与**已死或永久卡死**的 agent。今天唯一的豁免是 `local_delay`，
它只覆盖 daemon 自身定时器迟到，不覆盖 agent 侧停摆。代码库自己已记录了一种
误杀模式：`ndJsonStream.ts` 的注释指出 30 s 内两次队列饱和"would tear the
channel down as a liveness timeout — the outage this backpressure exists to
prevent, with a misleading cause"。

2026-11-21 在一台 32 核开发机上观察到：一天 4 次 liveness kill（本地时间
01:28、03:38、17:18、17:34）。整机 CPU 饥饿被排除（32 核 load ≈ 9），worker
RSS 0.3–0.9 GB（无多 GB 级 GC），日志无队列饱和告警。真正的停摆原因未知，因为
SIGKILL 销毁了现场：没有任何记录保存 kill 时刻 agent 的进程状态。

## 现状

基线策略——节奏、探测超时、两次 strike 即失败、kill 机制——记录于
[daemon channel transport liveness](2026-08-24-daemon-channel-transport-liveness.md)。
本设计放宽其中针对仍在消耗 CPU 的 agent 的失败计数，并增加失败证据；节奏、
零 CPU 阈值与 teardown 路径保持不变。

- `startChannelLivenessMonitor` 接受注入的 `probe`、`onFailure`、`isActive`
  与可选 `now`，无法访问子进程。
- `channel-startup.ts` 把探测接到 `qwen/status/channel/ping`；失败时标记传输
  失效、发 `channel.liveness_failed` 遥测事件、写一条 stderr 日志，然后杀通道
  （`transportGuard.fail` 或 `killChannelWithLog`）。
- agent 侧 ping 处理器（`acpAgent.ts` 的 `channelPing` 分支）校验 nonce 后
  立即返回，本身不可能慢。慢意味着 agent 事件循环被阻塞，或请求/应答无法穿过
  ndjson 队列。
- `AcpChannel`（`channel.ts`）不暴露子进程 OS pid；`spawnChannel.ts` 持有
  `child.pid` 但未发布。
- 常量硬编码，无 env/settings 开关；initialize 请求无条件提议 liveness
  （`channel-handshake.ts`）。

## 目标

1. 对确有证据仍在消耗 CPU 的 agent 进程，先给有界额外宽限再杀——忙不等于死。
2. 每次 liveness 失败与每次忙碌宽限都留下可行动的证据：pid、`/proc` 状态、
   wchan、CPU tick 增量、RSS 与监控计数器，且必须在 kill **之前**采集。
3. 保持对真死/零 CPU 卡死通道的快速检测：观察不到 CPU 进展时，连续 2 次超时
   即失败的路径不变。
4. 证据不可得时行为不变：非 Linux 平台、`/proc` 不可读、进程内通道保持今天的
   语义。

## 范围边界

范围内：`packages/acp-bridge`（liveness 监控、新增 `/proc` 采样器、
`AcpChannel.pid`、spawn 接线、startup 接线）与同址测试。

范围外：

- agent 停摆的根因本身。本改动记录的证据是后续根因工作的输入；这里不实现任何
  停摆假设的修复。
- 节奏/超时/阈值的配置开关。常量保持原样；若收集到的证据证明需要按机器调优，
  后续再加开关。
- 零 CPU 检测阈值（15 s / 10 s / 2）与 `local_delay` 容差。
- 按会话拆分通道，或 kill/teardown 机制的任何改动。
- agent 侧 ping 处理器与 ndjson 背压宽限窗口。

## 方案

### 1. 进程采样器 — `channel-process-sample.ts`（新增）

无依赖的 Linux 采样器，使用 `node:fs` 同步读：

- `sampleChannelProcess(pid: number | undefined): ChannelProcessSample | undefined`
  返回 `{ cpuTicks, state, wchan, rssBytes }`：`cpuTicks` 为
  `/proc/<pid>/stat` 的 `utime + stime`，`state` 为第 3 字段，`wchan` 为
  `/proc/<pid>/wchan` 去空白后的内容，`rssBytes` 取自 `/proc/<pid>/status`
  的 `VmRSS` 行。
- 非 Linux、非法 pid、任何读取/解析失败均返回 `undefined`。
- stat 解析器是纯函数导出，锚定**最后一个** `)`（`comm` 字段可含空格与括号），
  与 `core/src/utils/process-liveness.ts` 同一手法。它放在 `acp-bridge` 是因为
  只有一个消费者，且 liveness 模块保持无依赖；core 的助手专用于身份/僵尸判定，
  不做修改。

### 2. 监控 — `channel-liveness.ts`

新常量：`CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT = 6`。

新可选选项：

- `sampleProcess?: () => ChannelProcessSample | undefined`
- `onBusyExtension?: (info: { extension: number; limit: number; cpuDeltaTicks: number; sample?: ChannelProcessSample }) => void`
  ——`sample` 为超时侧快照，使宽限行携带与 kill 行相同的守卫证据字段。

行为：

- 探测开始时采集基线样本（提供采样器时）。
- 准时超时后再采一次。两份样本都存在且 `cpuTicks` 有进展，则该超时记为
  **忙碌宽限**：不计入 `consecutiveTimeouts`；`busyExtensions` 自增；触发
  `onBusyExtension`；立即发起下一次探测（沿用现有超时重试节奏）。
  `busyExtensions` 达到上限时仍以超时码失败——busy-loop 卡死的 agent 依然
  会被杀，只是更晚。
- 任一样本缺失或 CPU 无进展，则该超时按今天的方式计入
  `consecutiveTimeouts`（2 → 失败）。
- 合法应答重置两个计数器。`local_delay` 结果也重置两个计数器（它本就重置
  `consecutiveTimeouts`）。
- `ChannelLivenessFailure` 增加可选 `evidence` 字段：
  `{ lastSample?, lastCpuDeltaTicks?, consecutiveTimeouts, busyExtensions }`。
  失败码与构造签名保持向后兼容。四条失败路径都附带 evidence：两条超时
  失败携带超时侧样本与最后一个探测窗口的 CPU 增量；两条 protocol-error
  失败携带当场快照与计数器，无 CPU 增量（未经历超时窗口）。

最坏检测延迟：零 CPU 卡死仍在停止应答后 ≈ 20 s 被杀（两个 10 s 探测窗口）；
消耗 CPU 的卡死至多 6 个忙碌窗口后被杀（停止应答后 ≈ 60 s）。

### 3. 通道契约 — `channel.ts` / `spawnChannel.ts`

`AcpChannel` 增加 `pid?: number`——传输拥有子进程时为其 OS pid，进程内通道
无此字段。`spawnChannel.ts` 在返回的通道上发布 `child.pid`。字段可选，现有
消费者（`channels/base`、VSCode IDE companion、测试 fake）不受影响。

### 4. 接线 — `channel-startup.ts`

- 传入 `sampleProcess: () => sampleChannelProcess(info.channel.pid)`。
- 传入 `onBusyExtension`，每次宽限写一条 stderr：
  `qwen serve: channel liveness probe timed out but agent pid=<pid> consumed CPU (<n> ticks) state=<S> wchan=<w> rssMB=<m>; extending grace <k>/<limit>`。
  `state`/`wchan`/`rssMB` 来自该次宽限的超时侧样本，守卫与失败行相同
  （空 wchan 渲染 `?`；样本缺失时省略这三个字段），使宽限期内就能区分
  "事件循环卡死且处于 R 烧 CPU"与"worker 线程烧 CPU 而循环卡死"，
  而不必等到 kill 行。
- 增强 `failChannelLiveness`：stderr 日志与 `channel.liveness_failed` 遥测
  事件在现有通道 id、会话数之外携带证据字段（pid、state、wchan、CPU 增量、
  RSS、计数器）。kill 路径本身不变。

## 设计决策与理由

- **以 CPU tick 增量作为忙碌信号。** 无论 agent 事件循环能否应答 ping，内核
  都累计 CPU 时间，因此该信号恰好在我们关心的失败模式（循环被阻塞）下有效。
  它把"在计算 / 在 GC / 在被调度"与"零 CPU 阻塞在 futex 或 pipe"区分开。
  代价是每次探测开始一份快照、超时探测再补一份；每份快照为 3 次微秒级
  `/proc` 读（健康时每通道每 15 s 约一份快照）。
- **有界宽限，而非无限。** 卡在 busy loop 的 agent 永远消耗 CPU；无限豁免会
  让其会话永远挂起。6 次宽限把额外延迟限制在 ≈ 40 s，同时能扛住数十秒级的
  暂时停摆。
- **先证据后 kill。** SIGKILL 不留现场。在失败时刻采集 state/wchan/CPU 增量，
  让下一次事故变成根因数据（例如 `pipe_wait` 指向 stdout 背压；`D` 状态指向
  I/O）。
- **无证据时退回今天的行为。** 样本缺失（非 Linux、hidepid、进程内通道、
  子进程已退出）按原样计入超时。本改动只在有 CPU 进展的正面证据处增加宽限，
  绝不削弱无证据处的检测。
- **采样器放在 acp-bridge 本地。** 单一消费者；保持 liveness 模块无依赖；
  避免给 core 的身份助手增加第三种形态（其注释自设两个调用者的上限）。

## 约束

- Linux `/proc` 布局：`comm` 之后 state = 索引 0、utime = 索引 11、
  stime = 索引 12；`comm` 锚定最后一个 `)`。
- clock tick 粒度（通常 10 ms）：10 s 窗口内运行不足一个 tick 的进程读出的
  增量为零，落回今天的路径——保守方向。
- PID 稳定性：daemon 拥有子进程，仅经 exit handler 回收，而该 handler 同时
  停止监控（`isActive`），因此存活监控下的采样 pid 不会被复用。
- 同步 `/proc` 读在探测开始与探测超时后运行于 daemon 定时器路径；微秒级、
  有界（每份快照 3 个文件）。

## 风险

- busy-loop 卡死的 agent 如今多活 ≈ 40 s 才撕掉其会话。有界且有日志；相对
  观察到的误杀代价可接受。
- 忙碌信号可能被无关线程满足：事件循环永久卡死而某 worker 线程在 busy loop。
  宽限上限仍会强制 kill；证据日志记录状态供分诊。
- 忙碌宽限的额外 stderr：每通道每探测窗口至多一条，且只在停摆 episode 内。

## 验证计划

- `channel-liveness.test.ts` 单元矩阵（fake timers、注入采样器）：忙碌宽限
  延迟失败直至上限；第上限次忙碌超时带证据失败；零 CPU 与无采样器路径保持
  2 次超时行为；成功与 `local_delay` 重置两个计数器；序列中途样本缺失按
  非忙碌计入。
- `channel-process-sample.test.ts`：解析夹具（普通 comm、含空格与 `)` 的
  comm、畸形输入）、pid 守卫、平台门、Linux 上的自身实时采样。
- 真实进程回归已提交为
  `integration-tests/cli/qwen-serve-liveness-grace.test.ts`（Linux 门禁、
  真实计时器、生产采样器与 startup 接线）：SIGSTOP 的
  agent → 带证据的 kill；busy 子进程 → 宽限后有界 kill；健康通道 → 无失败。
  先对全局 `qwen` 做基线 dry-run。
- `npm run build && npm run typecheck`、受影响包的聚焦测试、lint/format。

## 验收标准

1. 零 CPU 无应答的 agent 按今天的方式在连续 2 次准时超时后被杀，失败日志/
   遥测携带 pid、state、wchan、CPU 增量、RSS 与计数器。
2. 消耗 CPU 的无应答 agent 至多存活
   `CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT` 个忙碌窗口，每次宽限有日志，
   随后带证据被杀。
3. 健康通道与 `local_delay` 路径行为与之前完全一致。
4. 非 Linux、`/proc` 不可读、进程内通道行为与之前完全一致（采样器不生效）。
5. 既有 liveness 测试原样通过；build、typecheck、聚焦测试全绿。

## 开放问题

无阻塞项。证据积累后的后续工作：定位 agent 停摆根因（主要嫌疑是阻塞事件
循环的同步工作与 ndjson pump 停摆），并重新评估是否需要运维调优开关。
