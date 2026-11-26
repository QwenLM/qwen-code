# 基于负荷的会话准入

[English](load-based-session-admission.md) | [简体中文](load-based-session-admission.zh-CN.md)

状态：已实现（implemented）

2026-11-26 修订：CPU 信号现在需要事件循环延迟佐证才会进入，并在 daemon
循环恢复健康后退出。一次重启后的 Spotlight 索引风暴曾让原始 ratio 闸门在
一台 10 核 Mac 上持续拒绝约 13 分钟，而当时 CPU 63% 空闲、daemon p99 延迟
仅 21–30 ms（load ratio 峰值 10.8）；闸门还在负荷波谷短暂打开后
重新关闭。涉及文件：`load-admission.ts`、`load-admission.test.ts`、CLI
帮助与选项注释（`commands/serve.ts`、`serve/types.ts`）、本设计文档对，
以及已发布契约文档（`docs/users/qwen-serve.md`、
`docs/developers/qwen-serve-protocol.md`、
`docs/developers/daemon/17-configuration.md`、
`docs/developers/daemon/18-error-taxonomy.md`）。见设计决策中的
「CPU 信号需要佐证」。

## 问题

主机已经高负荷时，daemon 仍继续放行新建会话。新建任务——调用方自带
`sessionId`、子会话、定时任务——强制 `thread` 作用域，每个会话 spawn 一个
新的 ACP 子进程：一个拥有独立堆的完整 Node 进程。（只有不带 id 的裸
`single` 作用域 spawn 才复用 workspace 已有的子进程。）因此每次放行都在加深
饱和。daemon 的单事件循环被饿死，HTTP 路由（包括 cancel 和 status）无法及时
响应，表现为 daemon 卡死。高负荷下继续新建任务不会快速失败，反而让卡死更
严重。

今天所有的准入闸门都是计数型的：

- 每 workspace 存活会话上限 `maxSessions`（默认 32，
  `packages/acp-bridge/src/session-control-plane.ts`）。
- daemon 全局 `maxTotalSessions`，按 workspace 数量推导
  （`packages/cli/src/serve/run-qwen-serve.ts`，
  `deriveDefaultMaxTotalSessions`）；注册容量超过 25（含默认 256）时固定为 800，即使只有一个 workspace；容量 ≤ 25 时按每 workspace 上限与 workspace 数推导，单个这样的 workspace 不设上限。
- 每会话待处理 prompt 上限（`maxPendingPromptsPerSession`，默认 5）。

计数无法反映机器实际能运行多少：每 workspace 32 个会话可以远超主机容量。
内存预算模块（`packages/acp-bridge/src/daemon-memory-budget.ts`）明确只是
描述性的——"Reported, never applied"——并写明真正的策略需要在 spawn 时做
准入。目前没有任何准入路径读取 load average、事件循环延迟或空闲内存。

## 目标

- 主机饱和（需 daemon 事件循环延迟佐证）或 daemon 自身事件循环被饿死时，
  以可重试的 `503` 拒绝新建子进程。
- 过载期间已有会话与控制面（prompt、cancel、detach、status、SSE）保持完全
  可用。
- 决策可通过 `GET /daemon/status` 观测。
- 提供运维侧退出开关。

## 范围边界

- 本次变更的信号只有：主机 load average 与 daemon 事件循环延迟。内存压力与
  cgroup 感知的 CPU 压力是后续工作。
- 被拒绝的新建不排队。以 `503 + Retry-After` 快速失败。
- Managed 并发子进程计数上限（`acp_child_capacity_exhausted`）是正交的计数
  闸门，保持不变。
- 不做专门的 Web Shell 横幅或新建按钮禁用。现有通用 notice 路径已会把
  daemon 的错误消息以 toast 呈现。
- 发往存活会话的 prompt、cancel、detach、status、SSE 永不设闸。

## 设计

### 负荷监视器

新模块 `packages/cli/src/serve/load-admission.ts` 导出
`createLoadAdmissionMonitor`。它以 2 秒周期（`LOAD_ADMISSION_SAMPLE_MS =
2_000`）在一个 `unref()` 的定时器上采样，并缓存一份供准入同步读取的快照：

```ts
interface LoadAdmissionSnapshot {
  enabled: boolean;
  overloaded: boolean;
  reason: 'cpu_load' | 'event_loop_lag' | 'observation_gap' | null;
  loadRatio: number; // os.loadavg()[0] / os.cpus().length（分子分母同为主机作用域）
  eventLoopLagP99Ms: number; // 窗口内 p99，直方图每 tick 重置
  sampledAtMs: number;
}
```

两个信号，各带进入/退出阈值（滞回），外加一个单调钟观测缺口锁存。CPU
信号由事件循环延迟佐证：只有 daemon 循环已经感受到压力时才进入；一旦循环
恢复健康即退出，即使主机负荷仍然偏高：

| 信号 / 锁存  | 来源                                                               | 进入                            | 退出                            |
| ------------ | ------------------------------------------------------------------ | ------------------------------- | ------------------------------- |
| CPU 负荷     | `os.loadavg()[0] / os.cpus().length`                               | ratio ≥ 2.0 且 lag p99 ≥ 250 ms | ratio < 1.0 或 lag p99 < 100 ms |
| 事件循环延迟 | `monitorEventLoopDelay({ resolution: 20 })`，每窗口 percentile(99) | p99 ≥ 1000 ms                   | p99 < 250 ms                    |
| 观测缺口锁存 | 距上次 tick 的单调钟年龄（`performance.now()`）                    | 年龄 > 3 周期                   | 连续 3 次按时健康               |

佐证阈值是导出常量（`LOAD_CORROBORATION_ENTER_MS = 250`、
`LOAD_CORROBORATION_EXIT_MS = 100`），与延迟信号自身的区间相互独立，便于
分别调优。进入侧按设计与延迟信号的健康退出边界（250 ms）同值：高于它
daemon 已不再是从容健康。退出侧远低于它（100 ms），因此循环在 100–250 ms
区间徘徊时，不会单独触发 CPU 信号的进入或退出。

每个信号各自维护持续计数，翻转条件连续 3 次采样（6 秒）成立后才翻转状态。
当一次 tick 迟到超过 `3 * sampleMs`，或 `snapshot()` 读到上次 tick 年龄超过
`3 * sampleMs` 时锁存观测缺口（首次 tick 前的冷启动保持 fail-open），仅在
两个信号均未过载且连续 3 次按时 tick 后才清除。`overloaded` 为
`gapLatched || cpu.overloaded || lag.overloaded`；`reason` 优先级为
`observation_gap` > `cpu_load` > `event_loop_lag`（因此缺口锁存期间即使两个
实测字段都低于进入阈值，快照仍可报告 `overloaded: true, reason:
'observation_gap'`）。快照始终携带两个实测值。延迟直方图为本监视器专用且每
tick 重置，读数是窗口内的，与 `run-qwen-serve.ts` 中现有 metrics sampler
的模式一致。

监视器接受可选的 `readSignals` / `now` 测试接缝（默认真实 `os`/`perf_hooks`
读取与 `performance.now()`）与可选的 `sampleMs` 覆盖。`dispose()` 冻结最后
判定、清除定时器并停用直方图。阈值与持续次数在本次变更中是导出常量，不是
配置。

### 准入集成

`createTotalSessionAdmissionController`
（`packages/cli/src/serve/total-session-admission.ts`）新增可选
`loadAdmission?: { snapshot(): LoadAdmissionSnapshot }` 选项。`admit()`
按序检查：

1. workspace 正在 drain（现有）。
2. 负荷：若 `snapshot().overloaded`，抛 `SystemOverloadedError`。
3. 总会话计数（现有）。
4. 预留在途名额（现有）。

该控制器是唯一的同步接缝，已作为 `freshSessionAdmission` 注入 daemon 构造
的每个 bridge（`run-qwen-serve.ts` 的主/次 runtime；`server.ts` 独立 app
工厂的默认 bridge）。bridge 契约不变：准入保持同步，预留/释放语义不动。

闸门覆盖全部四种新建子进程操作——`spawn`、`load`、`resume`、`branch`——
因为每种都会 spawn 子进程。`skipFreshSessionAdmission` 豁免只属于 branch
操作的内部 restore：branch 已预留准入，其 restore 不应重复预留。
worktree-reset 的替换会话走普通 `spawn` 路径，与其它新建一样受闸门约束——
与现有计数闸门一致；且 spawn 是 reset 流程的第一步，被拒时旧会话状态不受
影响。

监视器在控制器创建处创建，仅在启用负荷准入时创建，并在 daemon 关闭与
runtime 重建时 dispose，跟随 metrics sampler 的生命周期。

### 错误契约

在 `packages/acp-bridge/src/bridgeErrors.ts` 新增 `SystemOverloadedError`，
携带 `reason`、`loadRatio`、`eventLoopLagP99Ms`。消息写明原因与实测值，
日志与 toast 无需额外查询即可诊断。

- REST（`packages/cli/src/serve/server/error-response.ts`）：`503`，
  `Retry-After: 15`，body
  `{ error, code: 'system_overloaded', reason, loadRatio, eventLoopLagP99Ms }`。
  一条 `warn` daemon 日志，与总准入拒绝的日志对齐。
- ACP RPC（`packages/cli/src/serve/acp-http/dispatch.ts`）：`errorKind:
'system_overloaded'`、`httpStatus: 503`、`retryable: true`，附同样的实测
  字段。
- SDK：本次不新增错误类；该状态以 `DaemonHttpError` 的 status 与 body 呈现，
  与其他 503 容量形态一致。独立会话创建路径（`POST /standalone/sessions`）
  在其 pre-dispatch 回滚 catch 中重抛该拒绝，因此回答同一 503 契约，而不是
  500 `standalone_creation_rolled_back`。
- 需要新绑定子会话的定时任务创建，在任务元数据写盘前保留同样的 503；
  其它首次 spawn 失败仍使用原有的 `scheduled_tasks_session_failed` 响应。
- `POST /session` 要求创建 branch 或 worktree 时，一定会分配新的 `thread`
  子进程，因此在 Git 准备前先检查过载；预检后再转为过载时，最终 bridge
  准入预留与既有回滚仍是兜底。
- 被拒的计划任务 `per_run` 子会话沿同样的 503 契约返回。既有的失败尝试记录
  与 `sessionDispatchFailed` 标记继续保留；被消费的一次性任务也先在返回错误前
  恢复。其它派发失败仍使用原有的 `scheduled_task_session_dispatch_failed` 响应。
- 监视器只在准入真正接线时创建：注入 bridge 从不接收
  `freshSessionAdmission`，该路径报告 disabled 快照，而不是为永不运行的闸门
  报告 `enabled: true`。

`Retry-After` 取 15 秒而非计数闸门的 5 秒：主机负荷的消退比会话名额的释放
更慢。

### 配置

`ServeOptions.loadAdmission?: boolean`，默认 `true`。`qwen serve` 的 CLI
flag `--load-admission` / `--no-load-admission`（yargs boolean 带默认值）。
禁用时不创建监视器，准入行为与今天完全一致。

### 状态暴露

`GET /daemon/status` 新增 `loadAdmission` 节，携带快照（`enabled`、
`overloaded`、`reason`、`loadRatio`、`eventLoopLagP99Ms`、`sampledAtMs`）；
过载时 issues 列表新增 `system_overloaded`（severity `warning`），与现有
`total_session_capacity_high` 家族并列。

## 设计决策与理由

- **快速失败，不排队。** 排队会隐藏背压，在恰恰导致卡死的条件下增长 daemon
  内存，并让客户端无限等待。`503 + Retry-After` 是本代码库既有的容量形态。
- **一个接缝，所有 runtime。** 在总准入控制器内设闸即可覆盖每个 bridge，
  不必触碰 bridge 包的准入契约——该契约必须保持同步。逐请求的异步负荷探测
  会违反契约。
- **两个信号。** 主机 load average 捕捉整机饱和，包括 daemon 之外进程的
  压力。事件循环延迟直接捕捉 daemon 被饿死，且在 `os.loadavg()` 恒为零的
  Windows 上仍然有效。
- **CPU 信号需要佐证。** 主机 load average 在不同系统上以不同方式误读
  daemon 承受力：Linux 计入不可中断 IO 等待，IO 风暴在 CPU 空闲时仍显示
  高负荷；macOS（XNU）采样可运行线程数，但其衰减平均在启动或索引的 CPU
  突发后仍居高不下，而此时 CPU 与 daemon 循环已空闲。2026-11-26，一次
  重启后的 Spotlight 索引风暴让一台 10 核 Mac 的 load ratio 峰值达 10.8，
  而 CPU 63% 空闲、daemon p99 延迟 21–30 ms、零 swap；闸门拒绝会话加载
  约 13 分钟，只在短暂的负荷波谷打开过。因此 CPU 信号仅在延迟佐证
  （p99 ≥ 250 ms）——daemon 已感受到压力——时进入，并在负荷降到退出
  ratio 以下、或循环恢复健康（p99 < 100 ms）时退出。主机繁忙本身不再
  拒绝一个健康的 daemon。保护仍然成立：本闸门防范的卡死定义上就是 daemon
  被饿死，佐证后的 CPU 信号比纯延迟信号更早捕捉它（250 ms 对 1000 ms）；
  纯延迟信号与观测缺口锁存仍覆盖硬卡顿、Windows 与容器饥饿。
- **佐证带的不对称是刻意滞回。** CPU 信号在 p99 ≥ 250 ms 佐证进入，但
  经延迟退出只在低于 100 ms 时成立，因此循环在 [100, 250) ms 区间徘徊时
  保持当前状态——既不单独进入也不单独退出。这与 ratio（2.0/1.0）、延迟
  （1000/250 ms）信号用的是同一套进入/退出滞回；把退出侧收紧到 250 ms
  会消除该区间，重新引入本次修订要消除的波谷抖动。低于 100 ms 按延迟
  信号自身的度量已是健康，故在此释放并非「有压力时释放」；达到或超过
  1000 ms 的循环则由独立延迟信号保持触闸，与 CPU 信号无关。
- **观测缺口锁存。** 事件循环停摆时 tick 不运行，缓存判定会在 lag 信号最该起作用时保持健康。监视器在最后一次 tick 的单调年龄超过三个间隔时锁存 `observation_gap`，以同一 503 家族拒绝；锁存仅在三次按时健康 tick 后清除，跳过的间隔不算健康读数，冷启动（尚无 tick）保持 fail-open。新鲜度时钟用单调钟（`performance.now()`）而非 `Date.now()`，NTP 跳变与挂起不会伪造缺口。
- **比值分子分母同为主机作用域。** `/proc/loadavg` 不做命名空间隔离，而
  `os.availableParallelism()` 遵守 cgroup 配额与亲和性掩码；两者相除曾让
  受限 CPU 的 daemon 在空闲时永久闩锁拒绝。分母因此取 `os.cpus().length`，
  容器级饥饿交给延迟信号。`availableParallelism()` 在归一化本进程自身 CPU
  的用途上（内存压力监视器）保留其容器作用域。
- **滞回加 3 次采样去抖。** 一次重 JSON 解析或短暂 spawn 突发不应挡住新建，
  闸门也不能抖动。6 秒才进入是可接受的，因为本闸门防范的过载以数十秒计
  发展；退出侧同样去抖，避免负荷瞬间回落就放行一波新建。
- **`load`/`resume` 与 `spawn` 一样设闸。** 它们同样 spawn 子进程。失控的
  工作存在于已存活的会话中——那些会话无需准入、始终可 cancel；冷会话没有
  在跑的工作，拒绝其恢复不损害可控性。计划任务 keepalive 是例外：它的 revive
  走 `resume`，因此那里的负荷拒绝被归类为瞬态——失败计数与指数退避保持
  不变、下一间隔继续重试，而不是在负荷消退后把绑定 cron 任务停放至多 30
  分钟。
- **保守默认值，默认启用。** load ratio 2.0 意味着运行队列是核数的两倍；
  p99 延迟 1 秒意味着 daemon 已明显无响应。健康主机永远不会触闸，因此
  默认启用的行为变更是安全的；运维可退出。

## 约束与风险

- **Windows：** `os.loadavg()` 返回零，CPU 信号在那里失效；延迟信号仍有效。
- **cgroup：** load average 是主机-wide，不是容器作用域。带 CPU 配额的容器
  可能在自身空闲时看到主机高负荷；2026-11-26 修订后仅凭这一点不再触发 CPU
  信号（空闲容器的循环保持健康）。延迟信号是 daemon 本地的，不受影响；运维
  仍可 `--no-load-admission`。cgroup PSI 压力是后续工作。
- **load average 不等于 daemon 承受力（Linux IO wait、macOS 可运行线程
  平均）：** Linux load average 计入不可中断 IO 等待，IO 密集主机在 CPU
  空闲时仍显示高负荷；macOS 平均可运行线程数，其衰减平均在 CPU 突发后
  仍会滞留。2026-11-26 修订后 CPU 信号需要延迟佐证，这两种形状在 daemon
  循环健康时都不再触闸；同时饿死 daemon 的风暴仍会经延迟信号触闸。
- **误报会挡住新建。** 拒绝可见（toast、status issue、daemon 日志）且可逆
  （退出开关、负荷消退）。闸门绝不触碰已放行的工作。
- **开销：** 多一个直方图与一个 2 秒定时器，与现有 5 秒 metrics sampler
  同一模式；可忽略。

## 验证计划

- 单元测试（同目录）：监视器逐信号与组合的进入/退出/去抖矩阵（含 CPU
  佐证矩阵与 2026-11-26 事故重放：load ratio 10.8 配 25 ms 延迟永不触闸）、
  dispose、零负荷失效；控制器过载拒绝与预留/释放不变量、禁用直通；REST
  与 RPC 错误映射。计划任务 per-run 拒绝也核验 overload 字段、`Retry-After`、绑定父会话
  不变、失败 run 标记与一次性任务暂停待显式恢复的状态，不新分配子会话。

- E2E 计划：`.qwen/e2e-tests/load-based-session-admission.md`。对全局安装
  的 `qwen` CLI 做基线 dry-run，展示缺口（负荷下新建仍被放行）。实现后对
  本地构建分组：真实 CPU burner 负荷 → 新建返回 `503 system_overloaded`，
  存活会话 prompt/cancel 保持可用，负荷停止后恢复；`--no-load-admission`
  在同一负荷下放行；status 报告状态。佐证 A/B
  （`.qwen/e2e-tests/load-admission-corroboration.md`）：低优先级 CPU
  burner 抬高主机负荷而 daemon 循环保持健康——修订前构建以 `cpu_load`
  拒绝新建，修订后构建放行并报告 `overloaded: false`。
- `npm run build && npm run typecheck`，按改动包跑聚焦 vitest。

## 验收标准

- 持续饱和（load ratio ≥ 2.0 且事件循环 p99 ≥ 250 ms，或事件循环 p99
  ≥ 1000 ms 单独成立，达 ≥ 6 秒）时，新建会话返回 `503 system_overloaded`
  带 `Retry-After`，且不 spawn 子进程。
- 主机负荷持续偏高、循环保持在佐证进入阈值以下（p99 < 250 ms）时，CPU
  信号永不进入；新建被放行。一旦进入，循环在 100–250 ms 区间徘徊会保持
  触闸——退出需要 ratio < 1.0 或 p99 < 100 ms。
- 过载期间，发往存活会话的 prompt、cancel、detach、status、SSE 保持可用。
- 各活动信号分别低于各自退出阈值持续 ≥ 6 秒（连续 3 次采样）后——CPU
  信号在 load ratio < 1.0 或 lag p99 < 100 ms 时退出——新建重新被放行；
  若卡顿期间同时触发了 `observation_gap` 锁存，则需在两信号均回落后
  再经过 3 次按时健康 tick 才解除（卡顿结束后总计约 10 秒）。
- `--no-load-admission` 完全禁用闸门；行为与今天一致。
- `GET /daemon/status` 报告负荷准入状态，过载时报告 `system_overloaded`
  issue。
- 健康主机上闸门永不触发；现有准入测试原样通过。

## 开放问题

- 阈值调优（ratio 2.0/1.0、延迟 1000/250 ms、佐证 250/100 ms、2 秒 × 3 次
  采样）待真实观测后进行；当前刻意保持常量。佐证区间于 2026-11-26
  Spotlight 风暴事故后加入；ratio 与延迟区间不变。
- 内存压力信号与 cgroup 感知的 CPU 压力：后续。
- 专门的 Web Shell 过载横幅与基于 status 节的新建按钮禁用：后续。

## 涉及文件

| 文件                                                     | 变更                              |
| -------------------------------------------------------- | --------------------------------- |
| `packages/cli/src/serve/load-admission.ts`               | 新监视器（信号、滞回、快照）      |
| `packages/cli/src/serve/load-admission.test.ts`          | 新单元测试                        |
| `packages/cli/src/serve/total-session-admission.ts`      | `admit()` 中的可选负荷闸门        |
| `packages/cli/src/serve/total-session-admission.test.ts` | 过载拒绝测试                      |
| `packages/acp-bridge/src/bridgeErrors.ts`                | `SystemOverloadedError`           |
| `packages/cli/src/serve/acp-session-bridge.ts`           | 重导出新错误类                    |
| `packages/cli/src/serve/server/error-response.ts`        | REST 503 映射                     |
| `packages/cli/src/serve/acp-http/dispatch.ts`            | RPC 错误映射                      |
| `packages/cli/src/serve/run-qwen-serve.ts`               | 监视器生命周期、控制器接线、选项  |
| `packages/cli/src/serve/server.ts`                       | 控制器接线（独立 app 工厂）       |
| `packages/cli/src/serve/types.ts`                        | `ServeOptions.loadAdmission`      |
| `packages/cli/src/commands/serve.ts`                     | `--load-admission` flag           |
| `packages/cli/src/serve/fast-path.ts`                    | fast-path boolean flag 登记       |
| `packages/cli/src/serve/daemon-status.ts`                | `loadAdmission` 节 + issue        |
| `packages/cli/src/serve/routes/daemon-status.ts`         | status getter 透传                |
| `packages/cli/src/serve/server.test.ts`                  | REST 映射测试                     |
| `packages/cli/src/serve/acp-http/transport.test.ts`      | RPC 映射测试                      |
| `packages/cli/src/serve/daemon-status.test.ts`           | status 节 / issue 测试            |
| `packages/cli/src/serve/fast-path.test.ts`               | flag 解析测试                     |
| `packages/cli/src/serve/routes/scheduled-tasks.ts`       | per-run 拒绝的 503 契约与失败历史 |
| `packages/cli/src/serve/routes/scheduled-tasks.test.ts`  | per-run 拒绝字段与失败历史测试    |
