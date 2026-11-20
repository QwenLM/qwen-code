# Managed 由 Runtime 持有的后台观测（Phase 3b）

[English](2026-11-19-managed-runtime-owned-observation.md) | [简体中文](2026-11-19-managed-runtime-owned-observation.zh-CN.md)

状态：提案，实现前设计。日期：2026-11-19。本文是 [Phase 3 控制面唤醒设计](2026-11-19-managed-control-plane-wake.zh-CN.md)（#17805）§2 和 §4.4–§4.6 要求的独立 3b 设计，基于 `main` 的 `e108e089bd` 核对。它建立在经 [seal 时唤醒戳补充设计](2026-11-19-managed-control-plane-wake-seal-stamp.zh-CN.md)（#17869；实现 #17908）修订后的 3a 之上。它回答父设计 §10 第 4–10 项，并在 §12 所列之处取代父设计的 3b 机制。父设计的目标、单一 writer 约束（§5.3）、"挂起不是排空"原则（§5.4）以及封闭的 journal 词汇表（§5.5）保持不变。

## 1. 问题与现状

目标（父设计 §2）：如果一个 Session 仅剩的活跃工作是后台 Shell 或 Monitor，它应当可以挂起；挂起期间这些进程继续运行，输出继续持久保存，Monitor 的观测仍能唤醒 Session 去投递通知。目前这类 Session 无法挂起。下面四个代码层面的事实决定了需要改什么，其中第一个与父设计的一个假设相矛盾。

### 1.1 后台捕获在 Harness 里，无法比 Harness 活得更久

进程和它的管道归 worker 所有，但输出持久化的每一步都发生在 Harness 里：

- worker 把原始字节转发给 Harness 持有的回环 publisher（`127.0.0.1:0`，带随机 bearer token，`hosted-shell-publisher.ts:185`）。这个描述符经 Broker 的 `:publisher` 路由交给 worker（`RuntimeBrokerService.java:1198`）。
- Harness 把这些字节交给 `LocalShellStreamCapture`。它以 1 MiB 为单位缓冲分段，把分段、分页和 manifest 修订发布为 Session 资源，并在进程内存里维护整条流的**增量 SHA-256**（`local-shell-stream-capture.ts:76,293`）。每个 manifest 修订都带有截至当时整条流的摘要。
- 随后每个 manifest 修订被提交到 `child_run`/`monitor_run` 记录（`advanceBackgroundManifest`，`hosted-shell-publisher.ts:666`）。

Node 的哈希对象无法导出再恢复，而发布资源需要活着的 writer（`JournalResourceWrites.java:159`）。因此别的进程都无法续写一个打开的捕获：新的 Harness 必须重读所有已发布字节才能重建摘要，而挂起的 Session 没有 writer 可以发布。父设计在唤醒时"重新打开直连 publisher"的做法（§4.4）因此行不通。目前这种情况从不出现，因为 Harness 每次退出前都先停掉后台工作：挂起会拒绝（§1.3），两条关闭路径都会排空（`hosted-harness-session.ts:9428,14676`）。如果 worker 还活着而 Harness 崩溃，推送会失败，捕获变为 `producer_lost`。

这条链路还导致 worker 侧两个事实：

- **publisher 一旦丢失，捕获就永久失败。** `RemoteShellCapture.append` 遇到任何 RPC 失败都会调用 `failCapture()`（`managed-shell-publisher.ts:257-280`），之后的写入一律丢弃，finalize 报告 `captureStatus: 'unavailable'`、`captureReason: 'producer_lost'`。
- **worker 无法换上第二个 publisher。** 如果同一个 Session 登记的描述符与 worker 已持有的不同，worker 的 publisher 登记表会返回 `409 managed_runtime_identity_conflict`（`managed-shell-publisher.ts:434-441`）。因此，在同一个 Runtime Session 上重新打开的 Harness 无法接管投递。

### 1.2 Monitor 的策略依赖 Harness 的定时器

`HostedMonitorLoop` 运行在 Harness 里，掌管 watch 的所有策略决定：把行防抖聚合成观测、启动空闲超时、执行 `maxEvents`（`hosted-monitor-loop.ts:377-414`）。它还在提交时才确定通知标识：`${monitorId}:notify:${sequence}`，其中 `sequence = observationSequence + 1`（`hosted-monitor-notification.ts:77`、`hosted-monitor-session.ts:194-205`）。Harness 离开后，空闲超时和配额停止都不会再触发；而一次重放的观测会得到一个新的标识。

### 1.3 哪些条件把 Session 钉住，哪些步骤会拆掉后台工作

`suspensionLiveWork` 会因以下条件阻止挂起（`hosted-harness-session.ts:4999-5047`）：

- 后台清理债务（`:5017`）；
- 被持有的 Runtime turn（`:5021`）；
- 存活的 monitor loop（`:5033-5038`）；
- 任何非终态的 `child_run`/`monitor_run` 记录（`:5039-5047`）。

即使放宽这些条件，挂起拆除过程中仍有两步会停止后台工作：

- Runtime 释放会排空。`releaseLeaseNow(session, false, true)`（`:5112`）以 `drain = true` 调用 `releaseHeldRuntime`；它还把 `released`/`deferred` 以外的任何结果当作失败（`:11412`），所以一个经核实的后台 `held` 会让拆除失败。
- 清理重试同样会排空：`retryHostedCleanup(session, broker, true)`（`:5114`）。

接下来的 owner 关闭会请求交还挂载，而只要后台进程还活着，`releaseMountAfterSweep` 就会拒绝（`RuntimeExecutionRecovery.java:370-394`）。最后，Phase 2 的 parked owner 回收会在这次拒绝之前先断开 MCP 连接（`RuntimeBrokerService.java:587-606`）。因此，对一个有活跃后台工作的 Session 发起回收，会白白断开它的 MCP 服务器。

### 1.4 Broker 能联系 worker，反过来不行

这里有两个关于 Broker 的事实：

- **只有 Broker 调用 worker。** 它通过 `RuntimeTransport`、使用租约范围的凭证调用（`control`，`RuntimeTransport.java:138`），worker 从不调用 Broker。租约已经把每次调用隔离到绑定的代次上：在当前租约下，被取代的 worker 是不可达的。
- **后台结算由操作触发。** 只有在释放、回收、维护结算或排空执行其扫描时，Broker 才会结算后台执行（`settleUnprovenBackgroundRows`，`RuntimeExecutionRecovery.java:296`）。没有定时器去跑这个扫描。

挂起中的 Session，其 `child_run` 和 `monitor_run` 的投影保持最后一次提交的状态，因为 `runtime_state` 只从 journal 提交投影而来（`JdbcManagedExtensionRecordStore.java:1542,1566`）。

## 2. 目标与范围

**范围内。**

- 仅剩经核实的后台 Shell 和 Monitor 作为活跃工作的 Session 可以挂起。它的进程在各自的 cgroup 下继续运行；在没有 Harness 持有 writer 的期间，它的输出仍然持久保存。
- Session 挂起期间产生的 Monitor 观测会唤醒它，观测及其通知各自恰好提交一次。
- Session 挂起期间，Broker 结算后台进程的退出，不加载 Session。
- 重新打开的 Harness 续写同一个捕获：同一个输出产物继续增长，没有 `producer_lost`。

**保持不变。**

- 只有一个 journal writer；Broker 从不向 journal 提交。
- journal kind 词汇表保持封闭。
- 前台捕获通道不变。
- 挂起判定中所有活跃工作、恢复、流、client-files 和生命周期条件都保留。
- 关闭仍然终止并排空后台工作。

**不在范围内。**

- 维护 writer。
- 除任务视图的存活与退出指示之外，暂存输出的公开读取路径。
- `EXTERNAL` 存储。
- 跨启动的进程挂接。
- Phase 4 的审批挂起。

## 3. 总览

本设计把捕获搬到寿命覆盖整条流的那个进程里，并用一条有序的投递流取代父设计的三方通道交接。这条投递流有两个可能的消费者：

```
            ┌──────────── worker（持有进程、捕获、Monitor 策略）──────────────┐
            │  捕获 → 投递 outbox：每个 run 的条目，deliverySeq 为 1,2,3…   │
            └───────────────┬───────────────────────────────┬────────────────┘
        已挂接：推送         │                               │  已持有：拉取（受租约隔离）
                            ▼                               ▼
       Harness 应用器（常驻、同机）                Broker 暂存（SQL + 暂存资源）
       发布资源、提交记录、                        遇观测/退出时标记唤醒、
       确认 appliedThrough                         结算退出、确认 stagedThrough
                            ▲                               │
                            └──────── 唤醒：排空暂存条目 ────┘
```

- **worker 持有后台捕获。** 它构建分段、分页和 manifest 修订（§4.1），执行 Monitor 策略（§4.2），并把所有需要持久化的东西变成带编号的**投递条目**（§4.3）。只有在某个消费者确认条目已持久化之后，它才丢弃该条目。
- **有 Harness 挂接时，worker 推送给它。** Harness 通过它已经持有的 writer 幂等地应用每个条目（§4.4）。
- **没有 Harness 挂接时，由 Broker 拉取。** 它通过受租约隔离的传输通道拉取，并把条目写入暂存账本（§4.5）。观测或退出会标记 Session 需要唤醒；退出还会立即结算执行行（§4.7）。
- **加载时，Harness 排空暂存并重新挂接**（§4.6）。worker 从最后一个已暂存的条目之后继续推送，因此不需要三方冻结。

## 4. 机制

### 4.1 worker 持有后台捕获

对后台通道（`capture.background === true`，即 `child_run(kind=shell)` 和 `monitor_run`），`LocalShellStreamCapture` 改在 worker 里运行，不再在 Harness 里运行。前台通道及其"失败即停止"的保证都不变。

- **内容完全一致，且不需要访问 Store。** worker 构建的 `managed-tool-result/1` 对象与今天 Harness 构建的完全相同——分段、分页，以及带增量摘要的 manifest 修订——所以读者看到的内容不变。每个对象使用 worker 选定的资源 ID：今天资源 ID 本来就由客户端选定（`randomUUID()`，`http-managed-session-store.ts:828`），所以 worker 不用联系 Store 就能算出每个完整的 `ManagedSessionDurableRef`。
- **分段小，刷新勤。** 后台分段最大 256 KiB，即最大分页的大小（`maxPageBytes`）。这样捕获产生的每个资源都能放进一次投递请求：新的投递请求上限为 512 KiB（今天 publisher 的上限是 256 KiB，`managed-shell-publisher.ts:43`），为 base64 留出余量。未填满的分段在短暂空闲后就刷新，输出不必等分段填满就能持久化。协议上限能容纳这一点：65,536 个序号 × 256 KiB = 每条流 16 GiB，在 64 个分页、每页 1,024 个分段的上限之内（`managed-tool-result.ts:33-45`）。
- **worker 被替换时，捕获封顶，与 H3 的决定一致。** 旧 worker 未被确认的条目和它的增量摘要都会丢失。新 worker 根据最后一个已持久化的 manifest 发布一个封顶的最终修订：分页、摘要和字节长度不变，尾部标记为缺失。封顶不追加字节，所以不需要哈希状态。

### 4.2 Monitor 的策略在 worker 里执行

worker 的 monitor 运行时接管今天在 Harness 里执行的 Monitor 策略：

- 切分行，包括 4 KiB 的不完整行上限，以及跳过空行（`fanMonitorLines`，`hosted-shell-publisher.ts:623`）；
- 防抖窗口，下限 1 s（`HostedMonitorLoop`）；
- 空闲超时；
- `maxEvents`。

观测序号由 worker 分配。它从启动或重建时传入的已提交水位继续计数，所以通知标识 `${monitorId}:notify:${sequence}` 在观测产生时就固定，而不是到提交时才确定。配额停止或空闲停止由 worker 终止 unit，随后发出带停止原因的 `terminal` 条目。模型发起的停止仍然走 Broker 的 `monitor-stop`。Harness 只保留观测条目的应用器；loop 的定时器以及它到 Broker 的停止往返都不再需要。

### 4.3 投递条目

每个后台 run 维护一个有序的条目 outbox，用每个 run 独立的 `deliverySeq` 编号，从 1 开始。每个条目都带有该 run 的 `executionCallId` 以及它的 `bindingId` 和代次。引入资源的条目带有该资源的完整字节，并且资源条目总是排在引用它的条目之前：

| 种类          | 内容                                                         | 应用时的效果                                     | 何时算已应用                 | 是否唤醒挂起的 Session         |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------ | ---------------------------- | ------------------------------ |
| `resource`    | 一个分段、分页或 manifest 资源，以及 worker 构建的引用       | 发布它                                           | 已存在相同 ID 和摘要的资源   | 仅在超过暂存字节水位时（§4.5） |
| `output`      | manifest 修订 `r` 的引用                                     | 推进记录的 `outputRef`                           | 记录的 manifest 修订号 ≥ `r` | 仅在超过暂存字节水位时（§4.5） |
| `observation` | Monitor 序号 `s`、它的各行，以及内联的小型观测资源和通知资源 | 在同一个事务里执行 `observe` 并提交通知输入      | `observationSequence` ≥ `s`  | 是                             |
| `terminal`    | 退出证据、停止标记或原因、最终 manifest 引用和信封           | 结算记录，与今天 `finalizeBackground` 的做法相同 | 记录已是终态                 | 是                             |

- **每一层的重传都是幂等的。** 以相同的 ID 和摘要再次发布资源不产生任何效果。每种条目都用记录里已有的水位去重，所以记录体不需要新增字段。
- **内存有上限。** outbox 有按 run 和按 worker 的字节预算。预算用满时，现有的管道背压会暂停进程（`managed-runtime-tool-executor.ts:1745-1771`），直到消费者确认了更多条目。
- **只有在条目已持久化之后，worker 才丢弃它。** 也就是被 Harness 确认为已应用，或被 Broker 确认为已暂存。

### 4.4 已挂接投递：常驻的 Harness

在 Harness 已登记且可达期间，worker 通过现有的回环 publisher 按顺序把条目推送给它。Harness 应用每个条目，先发布资源，再提交记录，然后回复 `appliedThrough`：已持久化或已发现应用过的最高序号。在同一个 Harness 的生命周期内，序号必须连续；出现缺口时 Harness 拒绝，worker 从它最早的未确认条目开始重发。

- **推送失败不等于捕获失败。** 对后台通道而言，推送被拒或不可达时不再调用 `failCapture()`，而是把该 run 切换到已持有模式，条目保留在 outbox 里。
- **更新的 Harness 替换 publisher。** 登记请求带上 Harness 的 writer 代次。对同一个 Session，worker 接受来自相同或更新 writer 代次的描述符，替换原来的那个，不再回复冲突（§1.1）。来自更旧代次的登记被拒绝。
- **显式解除挂接，把投递交给 Broker。** 挂起拆除时通过 Broker 解除 publisher 的挂接，worker 把该 run 切换到已持有模式。如果 Harness 没有解除挂接就死掉，推送失败会产生同样的结果。

### 4.5 已持有投递：Broker 暂存

Broker 通过现有的、受租约隔离的通道上新增的传输操作 `observation-pull` 拉取条目。一次拉取指明 run 和它最后确认的序号，并最多等待一段有限的时间（长轮询）。处于已挂接模式的 worker 回复 `attached` 且不返回条目，所以拉取一个已挂接的 Session 只花一次往返。Broker 只在某个绑定还有活跃的后台执行行时才拉取它。

由于拉取在绑定的当前租约下进行，被取代的 worker 不可达。worker 侧不需要任何凭证、授权或撤销记录，父设计 §10 第 5 项因此不复存在。

- **暂存在一个事务里写入。** Broker 在服务端以 worker 选定的 ID 发布条目的资源，并使用新的资源 owner 类型 `RUNTIME_STAGE`。在同一个事务里，它向新表 `ma_runtime_stage` 为每个条目插入一行，键为 `(execution_call_id, delivery_seq)`。该行记录条目种类、绑定和代次、条目的元数据，以及是否唤醒 Session。Broker 只在这个事务提交之后才确认拉到的条目：下一次拉取带上 `ackThrough`。
- **暂存的载荷是持久化的数据源。** 在 journal 引用这些字节之前，这些资源是它们唯一的副本。资源引用的 owner 防止它们被回收；它们使用的 Session 资源存储（包括对象存储外置）与 journal 提交使用的是同一套。不需要重建任何其他东西：这些行本身就是索引。
- **暂存有上限。** 每个 run 最多 10,000 个 `observation` 条目（与记录自身的上限相同），每个 Session 有一个暂存字节水位。超过水位时 Session 被标记为需要唤醒，于是输出很多的 Shell 通过一次短暂的常驻来排空，而不是把 SQL 填满。达到硬上限时，Broker 停止拉取该 run，管道背压会让它停顿，直到 Session 被唤醒。
- **暂存条目只在提交之后才删除。** Harness 的排空确认只删除到已应用位置为止的行及其暂存引用（§4.6）。代次变化不会删除它们。

### 4.6 唤醒与排空

**暂存如何唤醒 Session。** 暂存一个需要唤醒的条目的同一个事务，会把 Session head 的 `wake_retry_at` 拉到现在，并设置 `is_wake_pending = 1`。现有的兜底扫描随后会选中这个 head。它的候选带有 `staged` 标记，表示存在一个尚未提交、需要唤醒的行。带 `staged` 标记的候选跳过 journal 证明，直接通过被动的 `recoverForWake` 加载，与 3a 里带戳的 head 完全相同；如果只做 journal 证明，它会看到没有待处理输入，从而清掉提示。seal 戳本身不受影响：暂存的条目只是把到期时间提前。

**加载时做什么。** 在加载现有的各个恢复步骤之后、turn 泵运行之前，Harness 依次：

1. **先重新挂接。** 它通过 Broker 登记自己的 publisher。worker 把该 run 切换到已挂接，并为每个 run 回复 `stagedThrough`：Broker 最后确认的序号。worker 已经交给 Broker 但还没收到确认的条目仍留在它的 outbox 里，它会再推送一次。
2. **把暂存排空到 `stagedThrough`。** 对每个 run，按 `deliverySeq` 顺序，把每个暂存条目按推送条目同样的方式应用（§4.4）：资源已经在存储里，记录按顺序提交。然后确认排空，Broker 删除到已应用位置为止的行。
3. **应用 `stagedThrough` 之后的推送。** 对每个 run，它接受的第一个推送是 `stagedThrough + 1`；排空完成之前到达的推送以"尚未就绪"拒绝，worker 会重发。worker 切换到已挂接时还在进行中的拉取，仍可能提交高于 `stagedThrough` 的行。这些行与 worker 重新推送的条目重复；下一次排空会发现它们已应用并删除它们，挂起拆除在解除挂接之前也会把暂存确认到自己的已应用位置，同样删除它们。

不会有缺口，因为 worker 只在条目已在某个消费者那里持久化之后才丢弃它。不会重复投递，因为每次应用都会检查记录水位。如果在提交之后、删除之前崩溃，残留的行会在下一次排空时被判为已应用并删除。

### 4.7 不加载 Session 也能结算后台退出

- **拉取就是结算者。** 后台进程结束时，worker 发出 `terminal` 条目。暂存这个条目的同一个事务也会结算该进程的执行行，使用当前代次 worker 提供的退出证据（证据和规则与今天状态路由使用的相同）。持有随之释放，回收守卫和 `RuntimeRetentionJob` 都看到 Runtime 已空闲，全程不加载 Session。因此，挂起期间悄悄退出的 Shell 会在一个拉取周期内结算，不需要单独的任务。
- **已退出、待提交。** `terminal` 条目会唤醒 Session，所以 journal 会在一个扫描周期加一次加载的时间内提交终态修订，公开的输出产物随之生成。在这段时间里，任务视图把尚未提交的暂存 `terminal` 行叠加在记录的投影上，显示已退出；recovery view 和清理重试都不再把该 run 当作活跃。来自旧代次的行无法改变当前 run。

### 4.8 挂起资格、seal 与 recovery view

能力开启时（§4.11）的挂起资格：

- **后台条件按 run 逐个豁免。** 对于通过现有逐 run 证据检查 `hasBackgroundHoldEvidence`（`hosted-turn-cleanup.ts:242`）的 run，`suspensionLiveWork` 的后台条件（`:5017,5021,5033-5047`）不再阻止挂起。通过检查的是：当前绑定和代次上的 `child_run(kind=shell)` 或 `monitor_run`，有启动回执，状态为 `running` 或 `waiting`，执行状态为 `running_attached`。
- **其余情况仍然阻止。** 包括 `child_agent` 或 `workflow` run、`runtime_lost`、旧代次、前台清理债务，以及所有其他条件（父设计 §4.5）。

seal 为后台持有作出证明，扩展 3a 的戳：

- **seal 记录什么。** 当 Session 仅剩的未结算 run 和清理债务都是上述经核实的后台持有时，挂起 seal 的 `wake` 对象增加 `backgroundHeld: true`。Store 把它写入 head 的新列 `wake_seal_background`，所用的 writer 围栏和 revision 检查与戳相同。任何一次 writer 获取都会清除它。
- **recovery view。** 只有当 `wake_seal_revision = journal_revision AND wake_seal_background` 时，`ready` 分支才接受未结算的 `runtime_state` 行和 `HOSTED_CLEANUP` 引用。控制面无法执行逐 run 证据检查，因为那需要读 journal；seal 让能够执行它的 Harness 来作出证明。
- **清理重试。** 对这样的 head，`HostedCleanupRetryCoordinator` 跳过其债务，不再重新加载它（`HostedCleanupRetryCoordinator.java:128`）。

这两点都沿用 3a 的论证：戳由执行过检查的 writer 在精确的 revision 上写入，在某次获取清除它之前不会有任何提交。

### 4.9 拆除：只探测的释放，保留挂载

- **挂起时的释放从不排空。** 挂起拆除的两条排空路径（`:5112,5114`）都以只探测模式运行：只观察持有，什么都不停止。只有当 Broker 确认该持有是本 Session 当前绑定和代次的后台执行时，`held` 结果才算成功；前台债务仍会让拆除失败。关闭仍走原来的终止并排空路径。
- **后台工作保留挂载。** 在挂起模式下，仅由后台持有的情况会保留挂载成员资格，而不是把 `runtime_session_busy` 拒绝当作需要恢复。这与 Phase 2 的停放是同一个形态，它同时覆盖 Hook owner 的关闭和无法停放的 MCP owner 的关闭（父设计 §4.5）。
- **publisher 是解除挂接，不是关闭。** publisher 那一步通过 Broker 解除挂接（§4.4），worker 因此把该 run 切换到已持有模式，而不是失去消费者。

### 4.10 回收守卫与 worker 丢失

- **回收先检查后台工作。** `reclaimParkedMcp` 在调用 `transport.reclaimMcp` 之前先检查有没有活跃的后台执行，有则拒绝，且不断开任何连接（`RuntimeBrokerService.java:599`）。因此活跃的后台工作会把停放延长到它结束为止。这个守卫也去掉了回收顺带触发的结算扫描，而 §4.7 已经让那次扫描变得没有必要。
- **挂起期间 worker 丢失，按现有方式处理。** 绑定变为需要恢复，进程保持未证实，不会产生新的 owner。暂存的条目来自一个已证实的代次，记录的是确实发生过的事实，所以下一次加载会排空它们；排空不是重跑。捕获封顶在最后一个已持久化的 manifest（§4.1），记录走现有的 `runtime_lost` 路径停放。

### 4.11 发布与回滚

允许后台 Session 挂起需要三项条件同时满足：

- 配置项 `qwen.managed-agent.runtime-observation.enabled`（默认关闭），以 `runtimeObservation` 的形式在 writer grant 中与 `wakeDispatch` 并列公告；
- worker 能力 `runtime-observation/1`，出现在 worker 的能力列表中；
- 逐 run 证据检查（§4.8）。

§4.1–§4.4 的 worker 持有捕获和 outbox 只受 worker 能力这一项控制，不受该配置项控制：只要 worker 声明了该能力，它们就取代后台通道。这是因为它们在常驻时等价，唯一的区别是 Harness 重启时不再出现 `producer_lost`。

回滚：

- **关闭配置项会停止新的后台挂起。** 已经挂起的 Session 仍会被拉取和暂存，因为无论配置如何，拉取都在 Broker 运行的地方进行；它们照常被唤醒。
- **回滚 worker 是最后一步。** 只有在该能力下启动的后台 run 全部结束之后，回滚才安全。

3b 不需要 3a 的配置项就能挂起后台 Session。但一旦某次唤醒提交了一条通知，在该通知仍待处理时再次挂起，就需要 3a 放宽后的门；否则 Session 会保持常驻，直到那个通知 turn 执行完。

## 5. 决定与理由

1. **捕获搬到 worker。** 这个决定是 3b 可行的前提。捕获的正确性依赖一个任何其他进程都无法续算的增量摘要。worker 的寿命覆盖整条流，而且 H3 本来就在 worker 被替换时把流封顶。其他方案的代价更高：
   - 重新打开时重建摘要，每次唤醒都要重读整条流，最多达到流的协议上限。
   - 可导出的 SHA-256 中间状态需要自定义的哈希实现，外加一份持久化的旁路记录。
   - 每个 Harness 生命周期新建一个捕获，会破坏"每个任务一个产物"的约定。
2. **由 Broker 拉取，worker 从不主动外呼。** 拉取复用带租约认证、按代次隔离的传输通道。这样，父设计里持久的绑定级暂存授权（§10 第 5 项）及其续期和撤销问题，都不需要任何新机制。代价是拉取延迟，以及每个有活跃后台工作的绑定占用一个长轮询；§7 会测量这两项。
3. **每个 run 一条投递序号。** 一条带确认位置的有序流，取代了父设计里的已接收与已持久化两个字节位置、三方冻结，以及单独的观测标识。字节偏移只留在 worker 的捕获内部，观测序号在观测产生时就分配。
4. **先重新挂接，再排空到上报的位置。** worker 报告"已暂存"与"将重新推送"之间的分界点，于是交接变成一次分界点已知的双方交换，而不是一次冻结。
5. **暂存的载荷就是 Session 资源。** 字节只写一次，写到 journal 将要引用的存储里，并由 owner 引用防止被回收。唤醒时的排空只提交记录，不复制字节。
6. **seal 为后台持有作证。** 控制面无法重新推导逐 run 的证据。一个在 seal 时写入、在获取时清除的证明，正是把 3a 的论证用在了第二个事实上。
7. **退出会唤醒 Session。** 退出时唤醒，能让 journal、清理债务和输出产物在有限时间内收敛。否则，一个悄悄结束的 Shell 的产物要等到某次无关的唤醒才会生成。

## 6. 与 Phase 1、2 和 3a 的交互

- **资格判定。** 3b 按 run 逐个豁免后台条件（§4.8）。Phase 1 的活跃工作条件和 3a 的待处理输入门都不变。
- **拆除顺序。** 顺序不变：唤醒 → owner（停放或保留）→ 租约与清理 → publisher → writer seal → `stopLocal`。有两步不同：释放改为只探测，publisher 改为解除挂接而不是关闭（§4.9）。
- **Phase 2。** 停放的 MCP owner 照常复用。有活跃后台工作时，回收在断开连接之前就拒绝（§4.10）。无法停放的 MCP owner 通过 §4.9 的容忍规则保留成员资格。
- **3a。** 暂存触发的唤醒复用兜底扫描、被动的 `recoverForWake` 和 transport 围栏。seal 戳增加 `backgroundHeld`。暂存的条目只是把到期时间提前。
- **有界恢复。** 其证明依赖 writer 围栏，不受影响。3b 拆除失败时走现有的排空失败路径。

## 7. 测量（启用门槛）

以下内容扩展父设计 §7 第 5 项：

1. **拉取的开销与延迟**：
   - 每个 Broker 的长轮询连接数，以及每次空闲拉取的 CPU 开销；
   - 从观测到唤醒再到 turn 开始的时间；
   - 从退出到结算的时间；
   - 据此选定拉取等待时间、暂存字节水位和硬上限。
2. **挂起期间的大量输出**：暂存的行数和字节数、水位触发唤醒的频率，以及背压是否介入。
3. **排空开销**：分别有 1、100 和 10,000 个暂存观测时的加载耗时。
4. **常驻时的等价性**：每个 run 经由 worker 持有捕获的吞吐和延迟，与今天的 Harness 捕获对比。

## 8. 约束与风险

- **worker 侧捕获是最大的改动。** 需要先为今天的 manifest 输出写特征测试，以证明迁移前后逐字节等价。
- **挂起期间拉取是唯一的路径。** 如果 Broker 宕机，暂存会停止，管道背压最终会让后台进程停顿。这是有界的、可见的，绝不是静默丢失。
- **对于 journal 尚未引用的字节，暂存持有唯一的副本。** 它的引用必须像 journal 引用一样，经受住保留和删除顺序的考验。
- **Broker 会发布 Session 资源。** 暂存需要与 Store 相同的 Session 资源存储配置，包括对象存储外置。Broker 已经与 Store 共用数据库；如果部署时把它与 server 分开运行，还必须共用这份存储。
- **输出很多的 Shell 实际上不会真正挂起。** 它会在水位触发的唤醒之间循环。这不会比今天的常驻花费更多，§7 会量化它。
- **证明的可靠程度取决于逐 run 证据检查。** 这个检查今天已经在把守清理。

## 9. 切片

1. **worker 持有捕获和 outbox，仅常驻场景。**
   - 内容：捕获和 Monitor 策略搬到 worker；投递条目；Harness 应用器；按 writer 代次替换 publisher；推送失败转入已持有模式。
   - 对外行为：不变，唯一的区别是 Harness 重启时续写捕获，不再报告 `producer_lost`。
2. **Broker 暂存。**
   - 内容：`observation-pull`；带 `RUNTIME_STAGE` 引用的 `ma_runtime_stage`；由拉取完成的结算；兜底扫描的暂存分支；先重新挂接、再排空的协议。
   - 这时唯一会用到它的路径是 Harness 崩溃，还没有任何 Session 会挂起。
3. **后台挂起。**
   - 内容：资格豁免和 `backgroundHeld` seal 证明；recovery view 和清理重试的改动；只探测的释放；保留挂载；回收守卫；任务视图的退出叠加；发布开关。
4. **验收与测量。** 真实进程加 MySQL 的故障矩阵，以及确定各项常量的 §7 测量。

## 10. 验收标准

- **捕获等价。** 对同样的输出，worker 持有的捕获发布的分段、分页和 manifest 对象与今天的逐字节一致（分段大小除外），最终产物也相同。
- **Harness 重启。** 在后台 Shell 持续写入时，杀掉并重新加载 Harness，结果只有一个捕获，没有 `producer_lost`，每个字节恰好出现一次，manifest 链有效。
- **幂等投递。**
  - 确认丢失后重新推送任意条目，不产生任何变化。
  - 乱序推送被拒绝，并通过重发恢复。
  - 在提交与删除行之间崩溃后重新排空，每个观测和通知恰好提交一次。
- **重新挂接与排空。** Session 重新挂接时有一次拉取正在进行，且输出持续不断，最终字节顺序和摘要正确，每个观测恰好一个通知，暂存中不留残行。
- **挂起期间的第一个观测。** 挂起 Monitor 的第一行被暂存，即使 transport 关闭、journal 为空，也通过兜底扫描的暂存分支唤醒 Session，并恰好投递一个通知 turn。
- **Monitor 策略。** Session 挂起期间，空闲超时和 `maxEvents` 照样停止 watch，停止原因在下一次唤醒时提交。
- **悄悄退出。** 挂起期间无输出退出的后台 Shell，其执行行在一个拉取周期内结算，不加载 Session。任务视图在唤醒之前就显示退出；唤醒时提交终态修订和产物。
- **上限。** 挂起期间的大量输出会触发水位唤醒；达到硬上限时，背压让进程停顿，不丢任何数据。
- **挂起。**
  - 只持有经核实的后台 Shell、Monitor 或两者都有的 Session 可以挂起：进程继续运行，什么都不停止，挂载和持有都保留，recovery view 为 `ready`。
  - `child_agent`、`workflow`、`runtime_lost`、旧代次或前台债务仍会阻止挂起。
  - 显式关闭仍会终止并排空这些工作。
- **回收。** 对有活跃后台工作的停放 MCP owner 发起回收，在断开任何连接之前就被拒绝。
- **挂起期间 worker 丢失。** 下一次加载排空暂存条目，把捕获封顶在最后一个已持久化的 manifest，把记录停放在 `runtime_lost`，不启动新进程。
- **隔离。** 拉取永远不会到达被取代的代次；来自更旧 writer 代次的 Harness 登记被拒绝。
- **MySQL 与真实进程。** 暂存、结算、唤醒和故障用例在 MySQL 8.4 上、使用真实的 Harness 和 worker 通过；仅有 H2 不构成验收。

## 11. 开放问题

1. 拉取等待时间、暂存字节水位、硬上限，以及按 run 和按 worker 的 outbox 预算，由 §7 决定。
2. 挂起期间，任务视图是否应读取暂存的输出（而不只是退出状态），由 §7 和产品需求决定。
3. 后台分段大小（建议最大 256 KiB）和未满分段的刷新间隔，需要在请求上限、outbox 预算和输出可见性之间权衡。
4. 对无法停放的 MCP owner Session，第一版是否干脆不允许挂起，而不使用 §4.9 的成员资格容忍规则。

## 12. 父设计各节的回答或取代情况

| 父设计                                                       | 状态                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1.3"观测不归 Runtime 所有"                                  | 由 §1.1 扩展：捕获本身归 Harness 所有，无法比它活得更久。                                                                                                                       |
| §4.4 捕获重写、已接收与已持久化、重传                        | 由 §4.1 与 §4.3–§4.4 取代：worker 持有捕获，投递条目幂等，并有持久化确认。                                                                                                      |
| §4.4 协调的先排空后打开                                      | 由 §4.6 取代：先重新挂接，再排空到上报的位置。                                                                                                                                  |
| §4.4 稳定的观测标识、暂存行作为唤醒标记                      | §4.2（由 worker 分配序号）与 §4.6（兜底扫描的暂存分支）。                                                                                                                       |
| §4.4 原始载荷作为持久化数据源                                | §4.5：暂存资源由 `RUNTIME_STAGE` 引用持有，只在提交后删除。                                                                                                                     |
| §4.4 主动结算、已退出待提交                                  | §4.7：拉取完成结算，退出唤醒 Session。                                                                                                                                          |
| §4.4 持久的绑定级授权                                        | 撤销：Broker 在现有租约下拉取（§4.5、§5 第 2 条）。                                                                                                                             |
| §4.4 任务视图、发布                                          | §4.7、§4.11。                                                                                                                                                                   |
| §4.5 资格、只探测释放、挂载交还、回收、重新打开、worker 丢失 | §4.8–§4.10，并修正了回收的检查顺序。                                                                                                                                            |
| §4.6 的 3b 条目                                              | §4.8 的 seal 证明 `backgroundHeld` 与 §4.7 的退出叠加。                                                                                                                         |
| §10 第 4–10 项                                               | 4 → §4.5 与 §11；5 → 撤销；6 → §4.7（两者兼用：暂存终态的叠加显示，并由退出唤醒在一个扫描周期加一次加载内收敛）；7 → §4.2 与 §4.3；8 → §4.3–§4.6；9 → §4.1 与 §4.4；10 → §4.9。 |
| §11 切片 (2)–(4)                                             | 由 §9 的切片 1–4 取代。                                                                                                                                                         |
