# Managed 控制面 wake 调度与 Runtime 持有观测（Phase 3）

[English](2026-11-19-managed-control-plane-wake.md) | [简体中文](2026-11-19-managed-control-plane-wake.zh-CN.md)

状态：提案，实现前设计。经一轮对抗式代码级评审后修订，再经 PR #17805 设计评审后修订（六项 P1 与两项 P2 全部采纳），再经一轮 Simplicity First 自审删去投机面（按输入投影表、并发 drain 屏障、独立 wake 标记列、grant 续期协议）。本文是[无状态 Hosted Harness 设计](2026-11-16-managed-stateless-harness.md)（#17527）的 Phase 3 设计，对照 `main` 的 `4ed278b37c` 核实，该提交包含已合并的 Phase 1（#17690，merge `7150c58a01`）与 Phase 2（#17749，merge `4ed278b37c`）。父设计的 Phase 3「仅定义边界；实现前先出独立设计」；本文把该边界展开为提案、成本模型、与 Phase 1/2 的交互、测量计划与可行性结论。下文所有成本占比都是**代码级分析估算，尚未实测**；测量是启用门槛，与父设计和 Phase 2 的要求一致。

**交付建议。** 3a（wake 调度）小且可独立交付；3b（Runtime 持有观测）是捕获状态机重写加 staging 管线，应作为独立后续设计。先发 3a；下文 3b 视为它必须契合的边界，而非本阶段承诺的工作。

## 1. 问题与现状

Phase 1 仅在 Session 不欠任何工作时挂起它：无 pending 输入（包括 `notBefore` 在未来的 loop 输入）、无活的后台观测、无未结算工作。Phase 2 让挂起的 Session 保留其 MCP 连接 parked。因此仍有两类 Session 无法挂起，二者都为并未在跑的工作支付完整常驻成本（writer lease 与 activation 续约、已恢复的 journal 状态、定时器、Harness 内存）：

1. **带排队或延迟 wake 输入的 Session。** 已提交但尚未消费的 monitor 通知、channel 消息、child-result 接受、automation fire、session message、PR 事件或自定步 loop wakeup，都会让 Session 常驻。一个定在一小时后的 loop wakeup 会把 Harness 钉住一小时。
2. **带活后台 Shell 或 Monitor 的 Session。** 物理进程住在 Runtime worker 里，但把其输出变成持久记录的观测循环跑在 Harness 里，且任何非终态 `child_run`/`monitor_run` 记录都直接阻止挂起。

### 1.1 wake 输入已经是持久的；只有它们的时钟是常驻的

输入以 `input.accepted`（`inputId`、`turnId`、`source`、`contentRef`、`deadline`、`admissionRef`、可选 `notBefore`）连同权威生成的 `wake.requested` 在一个 journal 事务中提交。它恰好在同 `turnId` 的 `turn.settled` 提交时被消费；别无其他消费方式。因此 pending 集可仅由 journal 派生，任意多次重启后亦然（`pendingSessionInputs`，`packages/cli/src/serve/hosted-wake-intake.ts:37-68`）。wake 来源为 `monitor`、`channel`、`child_agent`、`workflow`、`automation`、`session_message`、`loop`、`pr_event`（`JdbcWakeRecoveryStore.SOURCES`，`packages/managed-agent-server/persistence/.../JdbcWakeRecoveryStore.java:29-30`；Harness 分类器 `isWakeInputSource`，`packages/cli/src/serve/hosted-harness-session.ts:1616-1627`）。

常驻投递机制是内嵌泵 `HostedMonitorWakeScheduler`（`packages/cli/src/serve/hosted-monitor-wake.ts:117`）。它不在内存持有任何东西：每一趟重读 journal，把最老的到期输入作为普通文本 turn 运行，并通过重读验证消费。busy/blocked Session 以 500 ms 节奏重试；被持有的审批等待以 15 s 节奏重新派生；尚未到期的输入按输入逐个跳过，并在最早的未来 `notBefore` 处恰好武装一个延迟定时器（`deferIfPending`）。kick（新武装、取消、加载）重新求值。泵在每次加载时重建（`hosted-harness-session.ts:7693`），延迟是按输入的，不是队头阻塞（`hosted-harness-session.ts:7711-7724`）。产生 `notBefore` 的自定步 loop wakeup 已实现（`hosted-loop-session.ts`；`shell/3` profile 声明 `loop_wakeup`），尽管其设计的状态行仍写着过时的「proposal」。

所以输入、其到期时间、其投递都已经是持久的或可重新派生的。常驻的只有**时钟**：泵及其延迟定时器住在 Harness 进程里，而资格谓词在任何输入 pending 时拒绝让进程离开。因此控制面只需要知道**何时**唤醒一个 Session，不需要知道**哪个**输入到期——后者泵在加载时从 journal 重新派生。

### 1.2 控制面已有两条 wake 路径，但都不是到期时间调度器

**Transport 快速路径（提示级）。** `JournalCommit.publishJournalAfterCommit`（`persistence/.../JournalCommit.java:305-325`）把每个已提交事件的一个 envelope 发布到按 Session 的 LiteTopic，并把 `wake.requested` 复制到每个节点都消费的共享 wake-bootstrap LiteTopic（`adapters/.../event/LiteTopicEventTransport.java:59-76`）。`TransportWakeActivator.onWake`（`control-plane/.../event/TransportWakeActivator.java:118-160`）仅把 envelope 当作「更早去看 SQL」的提示：它重新核对 `TransportConsumerStore.wakeFence`（workspace 匹配、`sequence <= committedSequence`、Session 开放、**无活 writer**、Harness 可用），在尝试前经 CAS 水位 `wake_covered_sequence` 认领（`JdbcTransportConsumerStore.java:117-126`），并把加载交给有界池（4 线程 / 256 队列）。池满答 `DROPPED`，留给 SQL 扫描。加载使用 `HarnessConnector.activateForWake`（`QwenHostedHarnessConnector.java:1731-1768`），它驱逐 sealed writer 留下的陈旧缓存附件，并走与 Turn 相同的新工作准入。EventTransport 投递是尽力而为，绝非恢复证据（`contracts/.../event/EventTransport.java:17-19`）；TypeScript 没有 envelope 消费者（`packages/core/src/managed-runtime/managed-event-envelope.ts:21-32`）。

**SQL 兜底（正确性地板）。** `WakeRecovery.scan`（`control-plane/.../session/WakeRecovery.java:34-70`）在专用调度器上每 2 s 运行，读取至多 8 个候选，对每个：认领、通过重放 journal 证明 pending 集、stamp 结果、调用 `harness.recoverForWake`（被动加载，`QwenHostedHarnessConnector.java:1718-1727`）。认领设置持久的 `wake_retry_at = NOW + 30 s`（`JdbcWakeRecoveryStore.claim:113-133`）；一次证明调用至多读 32 个 journal 事务，每查询一个，校验每个 chunk 的 digest 与 sequence 连续性（`hasPendingInput`，`PROOF_PAGES = 32`、`JOURNAL_PAGE = 1`、128 条证明缓存）。proof 已追踪最早的延迟 `notBefore`（`deferredUntil`），并在存在未来输入时拒绝证明「无 pending」（`JdbcWakeRecoveryStore.java:249-262`）；`recordPending` 在已证明 revision 上 stamp `is_wake_pending` 与 `wake_head_revision` 水位（`:311-319`）。资格是 `ACTIVE`、未退役、journal 未压缩、head 无主的公开 Session——`SEALED`，或 `ACTIVE` 且 writer lease 过期（`UNOWNED`，`JdbcWakeRecoveryStore.java:34-35`）。兜底还会在父 run 终态或 stop-requested 时丢弃 child Session 的 wake，**不产生** `turn.settled` 就清除 head 提示（`WakeRecovery.java:52-62`）。边界设计见 [Hosted wake recovery after writer loss](2026-10-18-hosted-wake-recovery.md)（#14116/#14603）。

**缺口。** 两条路径都不在延迟输入的 `notBefore` 处及时触发。transport 通知在**武装时**发出，那时 Session 仍常驻（`OWNED`，不加载）；fire 时刻没有 journal 事件提交。兜底的延迟锁存器知道 fire 时刻，但受 30 s 认领与 2 s 扫描节奏限制，且证明长 journal 需多次 32 页调用。父设计记录了后果：在 201 个事务的 journal 上，wake 在输入到期后至少三分钟才来。兜底是崩溃恢复机制，不是通用持久调度器——其自身设计把「持久增量证明与目录清理」列为剩余容量工作。修法是控制面可廉价扫描的到期提示加更快的到期优先分发，**复用**既有 proof，而非 pending 集的第二份副本。

### 1.3 后台工作：进程已归 Runtime 持有；观测尚未

后台 Shell（`child_run`，`kind=shell`）与 Monitor watch（`monitor_run`）是 Runtime worker 的子进程，各在自己的委托 cgroup v2 单元下，单元名由执行身份派生，因此替换 worker 按名重新附着（[H3 设计](2026-10-03-managed-shell-monitor-runtime.md)；`ManagedChildRunSupervisor`，`packages/core/src/managed-runtime/managed-child-run-supervisor.ts:129`）。每个进程持有一个非终态 Runtime 执行，直到其结束被证明；带活 hold 的常规 Runtime 释放答 `runtime_session_held` 且不停止任何东西（`RuntimeSessionRelease.java:103-145`，拒绝在 `:133`）；只有 close 的 drain 臂停止它。hold 持久于 Broker 账本并在加载时恢复：`heldRuntimeTurns` 既携带 Runtime 结束时被持有的 turn 的 promptId，也携带从 Broker 持久 hold 行恢复的 Runtime Session id（`hosted-harness-session.ts:959-970`）。

跑在 Harness 里的是**观测**：

- `HostedMonitorLoop`（`packages/cli/src/serve/hosted-monitor-loop.ts:100`）把 watch 的 stdout 行按 debounce 窗口聚合成一次观测。`flush()`（`:387-415`）经 `HostedMonitorSession.observe`（`hosted-monitor-session.ts:184-207`，提交在 `:398-410`）**在同一事务提交一个 `monitor_run` revision 加一个通知 `input.accepted`（source `monitor`）**，然后 kick wake 泵。通知策略是**每个被接受的观测一条通知**（`hosted-monitor-loop.ts:417-435`）；`notifiedThrough` 只是记账，不是门。watch 本身跑在 worker 里；Harness 侧的 `HostedMonitorRemoteExecutor`（`hosted-monitor-remote-executor.ts:25-67`）只在 publisher 上注册 `{onLine, onExit}` 并经 Broker 的 `monitor-stop` 请求 worker 停止（`managed-monitor-runtime.ts:89-135`）。
- 后台 Shell 没有独立的循环类；其观测是 `HostedShellPublisher` 的捕获转发（`fanMonitorLines`，`hosted-shell-publisher.ts:623-664`；`advanceBackgroundManifest` 把每个持久 manifest revision 转发到记录）。
- 唯一的 worker→Harness 后台事件路径是 HTTP POST 到 Harness 拥有的**环回**服务器：`HostedShellPublisher` 监听 `127.0.0.1:0`，带随机 32 字节 bearer token（`hosted-shell-publisher.ts:102-193`）；worker 客户端 `rpc()` post 到 descriptor URL（`managed-shell-publisher.ts:72-133`）。该服务器随 Harness 死亡。它喂给的每个 journal 提交都经 Harness 的 writer 权威——今天没有 worker→Store 或 Broker→journal 的提交路径（`v3/hooks` 是 Java→worker 分发，不是 journal writer）。直连路径已按字节 offset 幂等：write handler 拒绝不匹配的 offset 并在成功时推进它（`hosted-shell-publisher.ts:333,348`）。

worker 侧的三个事实界定了 3b 必须改什么：

- **worker 的捕获在 publisher 失联时是 fail-stop，不是重试或改道。** `RemoteShellCapture.append` 捕获任何 RPC 失败并调 `failCapture()`（`managed-shell-publisher.ts:258-280`）；一旦 `failed`，后续 write 被丢弃、`finish` 标记流不完整、`finalize` 产出 `captureStatus:'unavailable'`、`captureReason:'producer_lost'`、`deliveryStatus:'blocked'`（`:340-378`）。因此今天挂起时关闭环回 publisher 会**永久失败**一个在途捕获；它不会回退到任何东西。3b 必须重写这一语义，而非仅仅新增一个 staging 端点（§4.4）。
- **Broker 只在某操作触发其 sweep 时结算已结束的后台执行——没有周期结算者。** `ManagedBackgroundShellRegistry.complete()` 在进程结束被证明且 finalize/accept 链解决时 drop hold（`managed-background-shell-registry.ts:200-290`，hold drop 在 `:280-290`），并把已结束 receipt 保留在 worker 内存直到 worker 结束（`:64-70`）。Broker 的 `settleUnprovenBackgroundRows` sweep 经 worker 状态路由查询该保留 receipt（`managed-monitor-runtime.ts:113-127`）并结算执行行——但该 sweep 是**操作触发**的：Session 释放（`RuntimeSessionRelease.java:85`）、parked-MCP 回收（`RuntimeBrokerService.java:601`）、维护结算（`:1502`）或 drain（`RuntimeDrainCoordinator.java:639`）。它**不是定时任务**。因此挂起后退出的安静 Shell 没有主动结算者：唯一的周期路径是 incidental 的 parked-MCP 回收，而 §4.5 的后台执行拒绝会挡住它；无 MCP owner 的纯 shell-profile Session 则根本没有周期触发。3b 必须新增一个不重新加载 Session 的主动结算触发（§4.4）。
- **cleanup 重试会为欠债重新加载 Session。** `HostedCleanupRetryCoordinator.retry` 调 `harness.recheckRecoveryCleanup`（`HostedCleanupRetryCoordinator.java:126-146`），这是一次加载/复查，节奏化以避免每 tick 都重载。对后台持有的 Session 这是一个击败挂起的 wake 源；3b 的 cleanup 扫描必须识别 Runtime 持有的后台工作而不重载它（§4.4、§4.5）。

### 1.4 钉住这些 Session 的守卫

`suspensionLiveWork`（`hosted-harness-session.ts:4981-5032`）在活跃工作项之外，还阻止于活的 monitor 循环（`:5015-5020`）与**任何非终态 `child_run`/`monitor_run` 记录**（`:5021-5029`）——所以即便一个 parked 的 `runtime_lost` 记录或没有活循环的后台 Shell 也会阻止。对于活过其 turn 的后台 run，另有两项才是真正的钉子：`session.heldRuntimeTurns.size > 0`（`:5003`）与 `hasHostedCleanupDebt`（`:4999`）。shell profile 的 turn 在 `finish()` 遇到 `runtime_session_held` 时置 `runtimeHeld`（`hosted-workspace-tool-turn.ts:10749-10758`），加入 `heldRuntimeTurns`（`hosted-harness-session.ts:4531,13038`）；cleanup-hold 路径加入被持有的 Runtime Session id（`retainHostedCleanupHolds`，`:2771-2782`）。`attemptSuspend` 中一个独立的 `pendingInputs` 检查（`:5050-5060`）统计已提交前缀上**所有** `pendingSessionInputs`，无来源或到期时间过滤，且每次尝试跑两遍（`hosted-session-suspension.ts:232,242`）；任何 pending 输入都回退并重新武装。这正是阻止未来 `notBefore` loop 输入的检查。非 wake 持有的未结算输入由 `unsettledInputs`（`:5002`）单独统计，它排除 wake 持有的输入，恰因为泵拥有其消费（`unsettledInputsThrough`，`:2035-2062`；`isWakeOwnedInput`，`:2006-2016`）。

恢复视图的 `ready` 臂要求：sealed writer、released activation、当前投影、无活跃 Turn、无未结算 Runtime 执行或清理债务之外，还要 **wake emptiness 证明**：`is_wake_pending = 0` 且 `wake_head_revision = journal_revision`（`SessionRecoveryService.java:139-156`；[恢复视图附录](2026-11-18-managed-suspension-recovery-view.md) §2-3）。未结算工作探针命名非 null `runtime_state` 的 DOMAIN 行与 `REFERENCED` 的 `HOSTED_CLEANUP` ref（`JdbcSessionRecoveryRepository.java:34-56`）。因此带 pending 输入的 Session 按契约不是 `ready`，且该附录把拓宽此证明列为后续工作。

## 2. 目标与范围

**目标。** 控制面决定挂起的 Session 何时有到期输入，并唤醒任意 pool member 去运行它；Harness 运行输入后再次挂起。后台工作的观测移到 Runtime worker 与控制面，使带后台 Shell 或 Monitor 的 Session 能在其进程持续运行、记录持续持久的同时挂起。

**范围，第一增量（3a — wake 调度）。** 唯一欠的工作是未尝试 wake 输入（排队或延迟）的 Session 可以挂起。一个容忍陈旧的 **head 到期提示**加更快的到期优先分发器——二者都复用既有 journal proof——取代分钟级迟到的兜底成为主 wake 时钟；transport 快速路径与 SQL 兜底作为提示与正确性地板保留。资格与恢复视图守卫相应放宽。无新表，无后台工作变更。

**范围，第二增量（3b — Runtime 持有观测，独立后续）。** worker 聚合并监督其后台进程；一个 Broker 侧 staging 账本在无 Harness 持有 writer 时持久持有观测**及其输出字节**；Harness 在 wake 时 drain staging（先发布资源再提交记录）并恢复直连投递。带活后台工作的 Session 可以挂起；Runtime hold 跨挂起存续并在重开时重新附着。3b 是捕获状态机重写加 staging 管线、主动结算触发、binding 范围 staging 授权、只探测/mount 交还 teardown 容忍（§4.4–4.5）。它重到值得独立设计，不承诺于本阶段。

**范围外（后续增量 / 其他阶段）。**

- Phase 4 停泊审批：等待审批的 Turn 仍钉住 Harness（`session.active`/`recoveredTurn`）。泵的 15 s held 节奏不变。
- 第二个 journal writer。所有 journal 提交仍经 Harness writer；3b 把观测 stage 在 Broker 账本并在 wake 时提交，而非引入维护 writer 权威（见 §5.3）。
- 按输入 wake 投影表。head 提示 + proof 复用是第一版；按输入索引仅是后续优化，当且仅当测量表明按需 proof 重放成本不可接受（§5.1、§7）。
- journal 压缩交互。活压缩今天未启用（`compacted_through_revision` 仅在 `ManagedSessionRetirementStore` 对 `DELETED` head 推进；TS store 拒绝压缩 head，`http-managed-session-store.ts:493-495`）。proof 的未压缩前缀约束原样继承；压缩感知 wake proof 是独立工作。
- `EXTERNAL` 存储上的后台工作、后台进程向独立持有者的 detach、跨主机重启的进程附着（H3 已推迟这些）。
- 随历史增长的 journal 恢复成本（父设计：Phase 3 不消除它）。

## 3. 成本模型（分析估算，未实测）

### 3.1 常驻让这些 Session 付出什么

父设计实测的空闲成本是历史 rig 上每空闲分钟每 Session 51–56 条 SQL 语句（续约主导），外加 Harness 内存与定时器；当前常量须重测。被延迟 loop 输入钉住的 Session 在整个延迟期（至多 3600 s clamp，或 24 h 链）支付此成本。被后台 Monitor 钉住的 Session 在 watch 生命周期内支付。二者都没有在跑 Turn。

### 3.2 3a 消除与新增什么

消除：唯一欠的工作是未尝试 wake 输入的 Session 的常驻——它在空闲期后挂起，并保持挂起直到输入到期。wake 本身以到期分发（目标：秒级，受扫描周期与冷开准入限制）取代分钟级迟到的兜底。

新增：每个被接受 wake 输入一次 head 列更新（到期提示的 `LEAST` 递减，§4.1）；对 head 提示的周期到期扫描加每个到期候选一次按需 proof 重放（§4.2）；每个到期批次一次 wake 驱动的冷开。冷开的 MCP 分量已被 Phase 2 parked 复用移除；剩余冷开成本是无 MCP 地板加 journal 恢复。陈旧偏早的提示导致一次浪费加载，由 proof 纠正并重新挂起——有界且无害。proof 重放是本设计为简单性付出的代价；测量（§7）门控按输入索引后续是否值得其面。

### 3.3 3b 消除与新增什么

消除：唯一欠的工作是活后台观测的 Session 的常驻。worker 已拥有进程；3b 移除挂起期间的 Harness 侧循环与环回依赖。

新增：每个观测批次一次 Broker staging 写（debounce ≥1 s，受 10,000 观测记录界限制），**携带观测字节与输出段**；一次 drain-then-open 的 wake 交接，先发布 staged 资源再提交记录；一个主动执行结算触发；staged 活状态的任务视图读路径；以及把 worker 捕获管线从 fail-stop 一次性重写为 buffer-and-redirect（§4.4）。通知 turn 仍需要 Harness——3b 不消除 wake，它消除 wake 之间的常驻。持续吵闹的 Monitor 从不空闲因而从不挂起（空闲时钟让它常驻，与今天一致）：3b 的常驻收益针对突发或安静的后台工作，而非不间断流（§4.4）。

### 3.4 见证

- **常驻见证**：N 个各持一个按最大延迟武装的 loop 输入的 Session 的 rig 上的 `attachedSessions`——Phase 1 保持 N 常驻；3a 在空闲期后挂起 N 并恰好唤醒到期的那些。
- **到期延迟见证**：在 `now + T` 武装 loop 输入，挂起，测量 fire-to-turn-start 延迟，对比长 journal 上兜底的 ≥3 分钟。
- **重连见证**：Phase 2 的 `mcp.start` 计数在 3a wake 跨保持 0（parked 复用）。
- **后台见证**：挂起 Session 的 Monitor 持续 stage 观测且其通知在 wake 时触发 turn；`cgroup.kill` 证明的 Shell 退出在挂起期间经主动触发（§4.4）结算其 Broker 执行，且不重新加载 Session；捕获跨挂起存活，无 `producer_lost`。

## 4. 提案

### 4.1 head 到期提示，复用既有 proof（3a）

控制面需要廉价找到有到期输入的 Session。它**不需要**按输入索引：泵在加载时从 journal 重新派生哪些输入到期（§1.1）。所以 3a 给 `ma_session_head` 加一个容忍陈旧的列 `wake_due_at`（epoch ms；最早 pending `notBefore`，立即为 `0`，无 pending 时 null/缺省），完全像现有 `is_wake_pending` 提示那样维护：

- **接受时递减。** `JournalCommit` 已 OR 维护 `is_wake_pending` 并有条件推进 `wake_head_revision`（`JournalCommit.java:263-264`）。它额外对被接受 wake 输入置 `wake_due_at = LEAST(wake_due_at, notBefore)`。这单调朝更早，所以新被接受输入**绝不被漏**（提示总 ≤ 其 `notBefore`）。它不在结算时递增，所以最早输入结算后可能陈旧偏早——正是 `is_wake_pending` 已容忍的陈旧。
- **证明时刷新。** 兜底 proof 已计算 pending 集与最早延迟 `notBefore`（`deferredUntil`），且 `recordPending` 在已证明 revision stamp head（`JdbcWakeRecoveryStore.java:249-262,311-319`）。它额外把 `wake_due_at` 刷新为真实最早 pending `notBefore`（无 pending 时清除）。proof 是正确性地板：陈旧偏早提示触发一次浪费加载由 proof 纠正；提示绝不陈旧偏晚，所以无到期输入丢失。

无新表、无提交路径按输入写、无重建、无按行失效。现有 `is_wake_pending`、`wake_head_revision` 与生成列 `is_wake_scan_pending`（`V1__managed_schema.sql:222-230`，索引 `idx_ma_head_wake` 在 `:1474`）保持其角色；`wake_due_at` 作为另一个 head 提示加入，到期扫描按它排序。

**失效是 proof 的职责，与今天一致。** 因父 run 终态被丢弃的 child 通知、或已停止 run 的 message，由既有 proof 处理：兜底不结算就清除 head 提示（`WakeRecovery.java:52-62`），泵跳过被策略跳过的输入（`stoppedMessage`，`hosted-harness-session.ts:7687-7691,7706-7710`）。因为没有投影行，就没有东西重新填满到期页并饿死有效 Session——被失效 Session 的提示由 proof 清除，它离开候选集。这正是 head 提示优于按输入表之处：表恰恰需要为这些跨 Session 失效另设持久行清理机制。

### 4.2 到期分发（3a）

专用 `wakeDispatchScheduler` bean 上的新 `WakeDispatchJob` 遵循房屋调度器模式（命名单线程 `ThreadPoolTaskScheduler` + `@Scheduled` fixed delay；不存在也不需要 leader 选举——安全是逐行 CAS 加围栏，正如 wake 认领、transport 水位与 automation 账本已经是的那样）。候选周期 1 s，启用前实测。是否把这并入兜底扫描而非独立 job，是由测量门控的实现选择；下述契约两者相同。

每个 tick：

1. **扫描到期。** 选择 head `wake_due_at <= NOW`（或 `is_wake_pending` 置位）的无主、`ACTIVE` 公开、未退役 Session，按 `wake_due_at` 排序，有界页（候选 8）。稳定游标翻过剩余，而非重读队头同一批。
2. **证明并认领。** 复用既有 journal proof 确认有到期 pending 输入并刷新提示（§4.1）；proof 的 child 终态/策略过滤在失效候选消耗 wake 前丢弃它们。按 Session 认领（lease + 单调 fence，automation 账本之形）防止两节点同时分发一个 Session；租约至少为冷开上界，使慢加载不会让自己的认领过期。兜底的 `wake_retry_at` 保持不动。
3. **唤醒。** 调用现有 `activateForWake`：它驱逐陈旧附件、走新工作准入，Harness 的 writer 获取是 activation 围栏。加载重建泵，泵投递到期输入并为仍在未来的输入重新武装延迟定时器。3a 不需要新 Harness 动词。
4. **失败节奏。** 瞬态拒绝（`hosted_session_open_busy`、`hosted_session_closing`、pool 所有权等待）以 backoff 重试，受 #17681 建立的同一 churn cap 限制（`WAIT_CHURN_BUDGET_FACTOR = 4`，`HarnessCoordinator.java:101`）；确定性拒绝记录其自身代码并停止分发该 Session 直到 journal 前进。

**突发控制与 takeover 路径。** wake 加载继承每实例冷开上限（`HOSTED_COLD_OPEN_LIMIT = 8`，`hosted-session-suspension.ts:18`；拒绝 `409 hosted_session_open_busy`，在 `HarnessConflictCodes.java:23-29` 分类为瞬态）。placement 路径有两种情形：

- **sticky 路由到可达 owner（正常情形）。** 干净挂起的 Session 把其 placement 保持 `ACTIVE` 于挂起它的实例。`HarnessPoolConnector.select` 路由到该 owner 而不经 takeover；Store 在 `SEALED` head 上**立即**重获 writer——lease-lapse 守卫只对 `ACTIVE` head 生效，而 `SEALED` head 直接落到 generation 递增的重获（`JournalWriterLifecycle.java:257-292`；seal 只置 `state='SEALED'`，保留 `writer_lease_until`，`:399`）。所以正常 3a wake 不受 writer lease 门控。
- **跨实例 takeover（owner 宕机或 quiescing）。** 只有当 pool 必须 takeover placement 时 `harness_owner_still_live` 门才生效：takeover 需要 placement `RELEASED` 加 release 记录，或 writer lease lapse 加已知 activation（`JdbcHarnessPlacementStore.java:163-171`）。这是崩溃/重分配路径，不是稳态 wake。

分发器的有界页、认领租约与 jitter 使同步到期批次不至于填满一个实例的槽位；churn cap 让持续遇到满实例的调用者老化退出。

**与现有路径的关系。** transport activator 仍是无主 Session 上立即 `wake.requested` 通知的提示级快速路径；分发器是延迟输入的到期主路径，也是 transport 关闭或通知被丢弃时的可靠路径；SQL 兜底仍是正确性地板与提示刷新触发器。三者共享同一 wake 动词、同一 proof、同一 SQL 真相；没有一个是凌驾 journal 的恢复证据。

### 4.3 带 pending wake 输入的挂起（3a）

`attemptSuspend` 中的 `pendingInputs` 门**对未尝试 wake 输入**移除。区分已由活跃工作守卫与泵自身强制执行：turn 已开始的 wake 输入是运行中 Turn（`session.active`）、恢复 Turn（`recoveredTurn`）或 blocked 善后。在崩溃于 wake-turn 中途后的 takeover 加载上，泵首趟检测到先前 transcript 尝试（`wakeHasPriorAttempt`）并返回 `'recovery'`，置 `session.blocked = true`（`hosted-monitor-wake-turn.ts:122-171`）；`suspensionLiveWork` 随即阻止于 `session.blocked`。所以已尝试输入绝不被变为可挂起——它归恢复舰队，与今天完全一致。未尝试 wake 输入没有 Turn 也没有善后；它是分发器拥有的可调度工作。非 wake 持有的 `unsettledInputs` 项（`:5002`）不变。

teardown 不变：`wake.close()` 已停止泵且**不结算任何输入**（`hosted-monitor-wake.ts` `close()`），所以输入在 journal 与 head 提示中保持 pending；`mcp.suspend()` park（Phase 2）；writer 最后 seal。空闲时钟与有界准入工作等待不变。被分发器唤醒的 Session 运行其到期输入，再次空闲时 Phase 1 重新挂起它——现在允许带 pending 输入。

**发布控制。** 遵循 Phase 2 的 `mcpParkable` 先例（Phase 2 设计 §5.6），控制面广告 wake-dispatch 能力，由 `qwen.managed-agent.wake-dispatch.enabled`（默认关）门控。Harness 仅在能力被广告时放宽 `pendingInputs` 门；关闭时行为恰为 Phase 1。这使资格变更与分发器耦合，挂起 Session 绝不会在没有调度器的情况下被搁浅。

### 4.4 Runtime 持有观测（3b，独立后续）

观测移到 worker；其挂起期间的持久提交经 Broker staging 账本，journal 提交在 wake 时发生。这保全了整个恢复证明所依赖的单 writer 不变量（§5.3）。

**捕获重写（最大改动）。** 今天 worker 的 `RemoteShellCapture` 是 fail-stop：任何 publisher RPC 失败永久失败该捕获（`managed-shell-publisher.ts:258-280,340-378`），且 `ManagedBackgroundShellRegistry.complete()` 经 `sink.finish`/`finalize`/`publisher.accept` 投递终态信封（`managed-background-shell-registry.ts:200-290`）。3b 把**后台 lane** 改为 buffer-and-redirect：当环回 publisher 缺失或拒绝（无 Harness）时，捕获把其输出段与终态证据写入 Broker staging 路由而非失败，并在 wake 时恢复直连投递。`HostedMonitorLoop` 今天做的聚合与 debounce 移入 worker 的 `ManagedMonitorRuntime`。前台 lane 保持其 fail-stop 保证。这是对捕获状态机的重写，不是在其旁新增端点，需先有自己的特征化测试。

**staging 携带字节；wake 时 drain-then-open。** 新 Broker 维护路由接受观测批次与终态证据并写入按 run 有界的 staging 账本，持有**观测字节与输出段/manifest 链**，不只是元数据：一次观测提交发布一个 `managed-monitor-observation` 资源（`hosted-monitor-session.ts:194-197`）并推进一条 lineage 被校验的 manifest 链（`isToolResultManifestChainLink`，`:215-240`）。wake 时 Harness **完全 drain staging——先发布 staged 资源，再提交 `monitor_run` revision 及其通知输入——然后才重开直连 publisher**，在 drained-to offset 交接。drain 先于 open 的顺序消除任何直连/staging 并发重叠，所以无需连续 drain 屏障；幂等复用直连路径既有的 offset 冲突检查（`hosted-shell-publisher.ts:333,348`）而非新 digest 键。资源先于记录的顺序很重要，因为加载的恢复趟对每个 `tool.receipt` manifest 向 publication owner 校验（`hosted-harness-session.ts:3196-3225`）。generation 切换保留前代已确认字节并拒绝旧代进一步追加。staging 界镜像 10,000 观测记录界。

**staging 行即 wake 标记。** 第一条观测在 journal 尚无 `input.accepted` 时到达 staging，旧 journal 提示不能信号它——journal 无 pending 时兜底清除 `is_wake_pending`（`WakeRecovery.java:44-51`、`JdbcWakeRecoveryStore.java:249-262`）。所以分发器**直接扫描 staging 账本的未提交通知行**；提交一行即移除它，这就是清除。无需独立标记列或第二围栏——staging 行的未提交状态就是标记，独立于 journal 提示。策略是每个被接受观测一条通知（§1.3），所以每个 staged 批次都值得通知；一次 wake drain 整个积压，泵串行投递通知 turn。常驻时 worker 像今天一样 post 到重新建立的环回 publisher。持续吵闹的 Monitor 经空闲时钟保持常驻（无收益，无回归）；收益针对突发或安静工作。

**不重载的主动执行结算。** 挂起期间退出的安静 Shell 有保留的 worker receipt，但没有操作触发 Broker 的 sweep（§1.3）。3b 新增主动触发：终态 staging 写请求 Broker 核验退出证据并幂等结算执行行（复用 `settleUnprovenBackgroundRows` 的 observe-and-settle 逻辑，由 staging 而非 release 驱动），或一个专用后台任务发现已证明的退出。hold 在有界延迟内释放、任务视图更新，**且不加载 Session**。cleanup 重试扫描必须识别 Runtime 持有的后台 run 而不重载它（`HostedCleanupRetryCoordinator.java:126-146`）；仅后台 hold 不是恢复债务。终态记录 revision 仍在下次 wake 时提交，所以 journal 记录滞后于执行账本直到 wake。

**binding 范围 staging 授权。** staging 路由必须围栏，但短寿命 per-operation `OperationGrant`（由 Harness 侧 authority 从已提交记录事实签发，`managed-session-authority.ts:2362-2399`；gate 拒绝过期，`managed-operation-grant-gate.ts:108-122`）对长寿命后台观测是错误形状——它会迫使挂起期续期协议。3b 改用 **binding 范围、持久的 staging 授权**（与 MCP owner 持久成员资格同形）： tied 到 Session 的 Runtime binding 与 generation，在后台 run 生命周期内有效，generation 变更时撤销。不变量：同代 worker 在静默期后无需续期往返总能 stage 并投递，而被撤销或被取代的 generation 不能追加。确切授权形状是命名设计决策（§10）。

**挂起期间的任务视图。** 执行账本已投影活 `runtime_state`；公开任务视图读它取活性，并从已提交 Artifact 加有界 staging 尾读输出。第一版接受 journal 记录状态滞后到 wake；活指示器来自执行账本。更完整的 staged 输出读路径是后续，若测量要求。

**发布控制。** 独立门 `qwen.managed-agent.runtime-observation.enabled`（默认关）加 worker 能力广告；Harness 仅在控制面与 worker 都广告观测时放宽 `suspensionLiveWork` 的后台项。关闭时，后台工作 Session 像今天一样常驻。

### 4.5 后台 hold 跨挂起（3b）

**完整资格项集合，带逐 run 证据。** 观测被广告时，3b 移除每一个仅为后台工作钉住 Session 的项：活 monitor 循环（`:5015-5020`）、非终态 `child_run`/`monitor_run` 记录（`:5021-5029`），**以及**后台 hold 项 `session.heldRuntimeTurns.size > 0`（`:5003`）与仅欠于后台 hold 的清理债务（`hasHostedCleanupDebt`，`:4999`）。豁免是**逐 run 而非逐 domain**：`child_run` 携带 `shell`、`child_agent`、`workflow` 三种 kind（`MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS`，`managed-session-records.ts:199-203`），且非终态记录可能是 `runtime_lost`。只有通过 cleanup 路径已用的同一证据检查——匹配 Runtime Session、binding 与 generation、start receipt、活 run 状态（`hasBackgroundHoldEvidence`，`hosted-turn-cleanup.ts:257-296`）——的 `child_run(kind=shell)` 或 `monitor_run` 才豁免。`child_agent`/`workflow` run、`runtime_lost` 记录、或绑定旧 generation 的 Shell 不是后台观测，仍阻止。挂起资格与恢复视图 `ready`（§4.6）共用这一套逐 run 条件。欠于真正未释放前台 owner 的清理债务仍阻止。每个活跃工作、恢复、流、client-files 与 lifecycle 项保留。

**teardown 对后台 hold 必须只探测，而非 drain。** 进程是 Runtime 的，hold 是 Runtime 的；Harness 离开二者都不变，teardown 不得停止或 drain 后台工作。但现有挂起 teardown 主动 drain：`retryHostedCleanup(session, broker, true)` 传 `drain=true`（`hosted-harness-session.ts:5093-5098`），到达 `broker.release({drain:true})` 与 Broker 对活行的 stop 分支（`RuntimeExecutionRecovery.java:330-343`）；`releaseHeldRuntime` 同样转发 `drain` 标志（`hosted-harness-session.ts:11219-11283`）。即便 Hook 或 MCP owner 保住其 mount，这个 cleanup drain 仍会为仍欠清理的 Session 停止后台进程。因此 3b 为挂起定义**只探测的释放**：它观察并保留已核验属于本 Session binding 与 generation 的后台 hold，不停止任何东西，覆盖 cleanup-drain 路径与恢复 lease 释放路径两者。前台清理债务仍阻止挂起。（恢复 lease 调用 `releaseLeaseNow` 本身传 `drain=false`；必须改的 drain 点是挂起 teardown 的 `retryHostedCleanup(..., true)`。）

**teardown 还须容忍 mount 交还。** owner close 主动交还 mount，而该交还在后台执行活时拒绝：

- Hook 配置 Session 的 `hooks.close({terminal:false})` 调 `releaseMount`（`hosted-hook-session.ts:2066-2095`），而 `releaseMountAfterSweep` 对 owner 下任何活后台执行无排除地拒绝 `runtime_session_busy`（`RuntimeExecutionRecovery.java:388-395`），抛 `HostedHookRecoveryRequiredError` 并失败 teardown。
- turn Runtime 即 MCP owner 的 MCP-profile Session 仅在 parking 成功时经 `mcp.suspend()` park；否则 `closeResources({terminal:false})` 调同一拒绝的 `releaseMount`（`hosted-mcp-session.ts:1143-1146,1296-1305`）。**因此此类 Session 的 3b 依赖 Phase 2 parking 启用**，或依赖下述同一容忍。

3b 加一个挂起模式交还容忍：当持有 mount 的唯一东西是本 Session 的活后台执行（上述逐 run 证据）时，非终态 close 保持成员资格（如 Phase 2 的 park 所为），而非把拒绝当作 recovery-required。close 路径审计必须钉住只探测 drain 与此容忍两者，使后续 detach 变更不能在挂起时静默停止后台工作。

**回收守卫。** 带活后台执行的挂起 Session 不得被回收。Runtime Session 释放已被执行账本围栏（`runtime_session_held`/`runtime_session_busy`，`RuntimeSessionRelease.java:103-145`），所以 `RuntimeRetentionJob` 与完整释放放过它。Phase 2 MCP parked-owner 回收**不**被自动覆盖：其 `hasPendingWork` 守卫是 MCP 范围的（`managed-mcp-runtime.ts:765-779`），并不命名后台执行，后者住在执行账本。3b 给 parked-owner 回收资格加显式后台执行拒绝，并验证 mount 成员资格释放被同一 hold 围栏。此拒绝也移除了回收过去 incidental 触发的周期 sweep，这正是主动结算者（§4.4）必需的原因。活后台工作约束 park 直到它结束。

**重开。** 加载经 H3 的重放容忍 start 附着重新附着到活执行；`heldRuntimeTurns` 从 Broker 持久 hold 行恢复（`:959-970`），所以重开的 Harness 恰欠 hold 到 close，与今天一致。

**挂起期间 worker 丢失。** Runtime generation 变更让 Session recovery-required，进程未证明且其 hold blocked；不铸造新持有者、不启动第二进程——与 Phase 2 的 `workerKillWhileIdleNeverMintsAFreshOwnerOnMySql` fault gate 对 parked MCP 钉住的契约相同。被丢失 generation 孤儿化的 staged 观测在下次加载时在 generation 围栏下被调和或丢弃，绝不作为重跑提交。

### 4.6 恢复视图契约更新

`ready` 臂的 wake-emptiness 守卫被**proof 当前性加未尝试输入证明**取代，并（3b）加逐 run 后台豁免：

- **当前性复用既有水位。** `wake_head_revision == journal_revision` 已意味「proof 已评估此 revision」（`JdbcWakeRecoveryStore.recordPending:311-319`）。3a 保留它作为当前性条件，但删去 `is_wake_pending = 0` 的 emptiness 要求：pending 未尝试 wake 输入是可调度工作，非 owed-uncertain。滞后或不完整的 proof 保持保守答案。不引入新水位。
- **获准的 pending 输入必须可证明未尝试。** 现有所有权释放流程已逐输入证明此（`pending.some(!isWakeInputSource || wakeHasPriorAttempt) → throw`，`hosted-harness-session.ts:4874-4889`）。`ready` 守卫复用同一证明：每个 pending wake 输入都未尝试（无 transcript 尝试）。已尝试但未结算的输入保持保守答案。
- **（3b）逐 run 后台豁免。** 通过共享逐 run 证据检查（§4.5）的后台 run 不再经其非 null `runtime_state` 阻止 `ready`，仅欠于此 hold 的清理债务不再经其 `REFERENCED` `HOSTED_CLEANUP` ref 阻止（`JdbcSessionRecoveryRepository.java:34-56`）。例外恰是豁免集，而非整个 domain。
- 其他守卫不变：无活跃 Turn、无真正欠的清理债务、sealed writer、released activation、当前 activation 投影。不能证明这些的 sealed head 保持保守答案；不因缓存缺失而被重标为健康。

这是[恢复视图附录](2026-11-18-managed-suspension-recovery-view.md) §3 命名为后续工作的拓宽。[有界恢复附录](2026-11-18-managed-suspension-bounded-recovery.md)的证明不受影响：它依赖 writer 围栏（lease 过期 → generation + 1），而非「sealed ⟹ 资源已释放」；3b 把后台资源留在 Runtime 照管下，与该证明已声明的崩溃恢复分支同形。

## 5. 设计决策与理由

### 5.1 head 到期提示，而非按输入投影表

控制面只需要知道**何时**唤醒 Session；泵在加载时从 journal 重新派生**哪个**输入到期。按输入表会重复 journal 已有、泵已重派生的信息，并增加提交路径按输入写、重建路径、持久跨 Session 行清理机制（兜底清除被丢弃 child 的 head 提示，而非投影行）。单个 head 提示避免所有这一切。早先的反驳——「head 列无法在结算时递减」——一旦该列是**容忍陈旧的提示**而非精确投影即消解：接受只递减它（绝不偏晚），既有 proof 刷新它（纠正偏早）。这正是 `is_wake_pending` 已有的工作方式。代价是每个到期候选一次按需 proof 重放；测量（§7）门控按输入索引后续是否值得其面以避免该重放。简单性优先；表在实测前是投机的。

### 5.2 兜底旁的分发器，而非取代

兜底是正确性地板与提示刷新触发器；移除它会使提示成为发现的单点故障。分发器是到期主路径；transport 仍是提示快速路径。三个机制，一个 proof，一个 SQL 真相，一个 journal 权威——与 wake-recovery 设计已用于 MQ-over-SQL 的相同分层。分发器复用现有 wake 动词、proof 与准入，所以 3a 不新增 Harness 契约。

### 5.3 staging，而非维护 writer

单 writer 不变量是恢复证明起作用的原因：两个 Harness 推进一个 Session 会分叉并重复副作用。让 Broker 或 worker 直接向 journal 提交 `monitor_run` revision 的维护 writer 权威，需要针对 writer generation 的新围栏故事，并触及 H0c 权威规则与两个恢复证明。staging 让每个 journal 提交都在 Harness writer 下；Broker 账本是进行中观测的可重建缓存，恰如 automation 账本是 journal 事实的可重建索引。代价是真实且被命名的：有界提交滞后、复用既有 offset 幂等的携带字节 drain-then-open 交接、staging 行作 wake 标记、主动结算触发、binding 范围授权、任务视图读路径、一次性捕获管线重写（§4.4）。收益是 3b 不重开单 writer 安全项目。维护 writer 仅是滞后被证明不可接受时的后续增量。

### 5.4 hold 存续；挂起不是 drain

后台进程归 Runtime，不归 Harness。挂起时停止它们会取消用户的工作——与 Phase 1 挂起不复用 detach close 路径同一理由。hold 已持久于 Broker 并在加载时恢复；3b 让它跨挂起不变，使挂起 teardown 只探测并容忍 owner mount 交还（§4.5），并以它约束回收。

### 5.5 无新 journal kind；契约是封闭的

journal kind 词汇在 TS 与 Java 两侧都冻结（`managed-event-envelope.ts`；`ManagedEventEnvelopes`）。3a 不加事件：head 提示是 SQL 侧，由现有 `input.accepted`/`turn.settled` 派生。3b 在 wake 时提交现有 `monitor_run` revision 与 `input.accepted` 通知；staging 是 Broker 账本，不是 journal 记录。`notBefore` 字段已在封闭 `input.accepted` schema 中（loop wakeup 设计加入），所以到期时间无需 schema 变更。

### 5.6 能力门控发布

Phase 1 选择无配置开关；Phase 2 引入 `mcpParkable` 作为发布控制，因为 parking 改变资源寿命。Phase 3 改变哪些 Session 可挂起、谁拥有其时钟与观测，所以遵循 Phase 2：wake dispatch 的控制面能力与观测的 worker 能力，都默认关，都在 Harness 放宽相应守卫前必需。无能力的部署行为恰如前一阶段。

## 6. 与 Phase 1 和 Phase 2 的交互

- **资格谓词。** 3a 对未尝试 wake 输入移除 `pendingInputs` 门；3b 经共享逐 run 证据检查移除活循环、非终态后台记录、`heldRuntimeTurns` 与仅后台清理债务项（§4.5）。每个活跃工作、恢复、流、client-files 与 lifecycle 项保留，欠于真正前台 owner 的清理债务也保留。
- **teardown 顺序。** 顺序不变：wake → owners（park）→ lease + cleanup → publishers → writer seal → stopLocal。3a 的 `wake.close()` 已不结算任何东西。3b 的 teardown 对后台 hold 只探测（无 drain stop），对仅后台 hold 容忍 owner mount 交还（§4.5），publisher close 只停 Harness 侧转发而 worker 捕获改道 staging（§4.4）。
- **parked MCP owner。** 3a wake 走 Phase 2 复用路径（acquire → status → revalidate → replace-then-retire）；`mcp.start` 重连见证保持 0。同时有 parked MCP 与活后台工作的 Session park 其 MCP 并持有其后台；后台工作 pending 时 MCP owner 的回收被拒绝（§4.5）。MCP-owner Session 的 3b 依赖 Phase 2 parking 启用。
- **有界恢复。** #8 证明成立：writer 围栏而非资源释放是其前提。失败的 3b teardown 走现有 drain 失败路径；后台 hold 作为 blocked 存续，绝不静默释放。
- **恢复视图。** §4.6 拓宽 `ready`；滞后臂（偏斜 activation 投影上的 `awaiting_evidence`）与保守 fall-through 不变。

## 7. 测量计划（启用门槛）

父设计要求启用前测量；§3 是估算。扩展 Phase 2 测量 rig（或其构建于上的 WP3 rig）：

1. **常驻**：N 个各持一个按最大延迟（3600 s clamp）武装的 loop 输入的 Session；测量 3a 前后的 `attachedSessions` 与续约 SQL，以及它们同时到期时的 wake 扇出。
2. **到期延迟**：1/40/200+ 事务 journal 上延迟输入的 fire-to-turn-start，分发器对比兜底；选择扫描周期与认领租约（租约 ≥ 冷开上界）。含饿死情形：8 个失效候选领先一个有效候选（proof 须清除它们，而非反复分页）。
3. **proof 重放成本（简单性权衡）**：目录规模下每个到期候选的按需 proof 重放成本，及 head 提示的提交路径成本。这是决定按输入索引（§5.1）后续是否值得其面的测量；head 提示先发。
4. **冷开突发**：同步到期批次对比 `HOSTED_COLD_OPEN_LIMIT`；选择分发器页/jitter 并确认 churn cap 让饱和调用者老化退出。
5. **后台（3b）**：吵闹 Monitor 下的 staging 写率与字节量；drain-then-open 交接成本（资源发布 + 记录提交）；通知延迟与 wake 合并；吵闹 Monitor 常驻边界；挂起期间主动 Shell 退出结算延迟（无 Session 重载）；捕获跨挂起及跨 ack-loss/drain 交接存活（无 `producer_lost`，字节 digest 不变）；静默期后的 binding 范围授权；任务视图陈旧界。
6. **重连见证**：`mcp.start` 在 3a/3b wake 跨保持 0（Phase 2 复用）。

输出选择发布常量（扫描周期、认领租约、分发器页、staging 界、结算延迟界）并确认收益值得新增成本。

## 8. 约束与风险

- **head 提示陈旧。** 提示可能陈旧偏早（一次浪费加载，proof 纠正）但绝不陈旧偏晚（接受只递减它）。proof 刷新与兜底地板必须被演练，而非假设。因为没有投影行，跨 Session 失效无需独立清理——proof 清除提示。
- **proof 重放成本。** head 提示以每个到期候选一次按需 proof 重放换取按输入索引。目录规模下这是测量（§7.3）门控的成本；按输入索引是不可接受时的退路，而非第一版。
- **捕获管线重写（3b）。** worker 捕获今天是 fail-stop（§1.3）；把后台 lane 变为 buffer-and-redirect 同时保持前台 lane fail-stop，是 3b 最大改动也是最可能的输出丢失或重复投递回归源。它需要在接 staging 路由前有自己的特征化测试。
- **drain-then-open 交接（3b）。** staging 持有输出字节与 manifest 链；wake drain 必须先发布资源再提交记录、在 drained-to offset 交接直连、围栏旧代追加（§4.4）。先提交记录、drain 前开直连、或丢失 manifest lineage 的 drain 会失败加载或重复/搁浅输出。幂等复用既有 offset 检查；staging 字节界与保留是开放项（§10）。
- **staging wake 标记（3b）。** 旧 journal 提示不能信号 staged 观测——journal 无 pending 时兜底会清掉它（§4.4）。分发器必须扫 staging 未提交行； lingering 或过早清除的行会搁浅或重复投递第一条观测。
- **主动结算（3b）。** Broker sweep 是操作触发而非周期（§1.3）；没有主动触发，安静退出的 hold 会 lingering 且 cleanup 重试重载 Session。触发必须不重载而幂等结算，cleanup 扫描不得把仅后台 hold 当恢复债务。
- **mount 交还与 drain 容忍（3b）。** 挂起 teardown 的 `retryHostedCleanup(drain=true)` 与 owner mount 交还都在活后台执行时停止/拒绝（§4.5）；只探测释放与 keep-membership 容忍必须限定于仅后台 hold，使真正前台 owner 仍 drain/拒绝。MCP-owner Session 依赖 Phase 2 parking 启用。
- **binding 范围授权（3b）。** 短寿命 per-operation grant 对长寿命观测是错误形状（§4.4）；binding 范围授权必须让同代 worker 静默后无需续期即可 stage，而被撤销/取代的 generation 不能追加。
- **staging 滞后与孤儿（3b）。** 观测立即持久于 staging 但仅在 wake 时持久于 journal；任务视图读执行账本取活性。丢失的 worker generation 孤儿化 staged 观测；generation 围栏调和或丢弃它们，绝不提交重跑。10,000 观测界适用于 staging 一如适用于记录。
- **后台约束 park（3b）。** 活后台工作拒绝 MCP 回收并持有存储成员资格；长寿命 Monitor 延迟维护直到它结束。
- **冷开突发。** 同步 wake 即便每实例限制自身冷开也可能过载共享 Session Store；churn cap 与分发器节奏是缓解。
- **close 路径耦合。** 挂起复用部分 detach close 路径；3b 的只探测 drain 与 mount 交还容忍必须钉住 close 路径审计的每一行，使后续 detach 变更不能在挂起时静默停止后台工作。
- **单 writer 保全。** 3b 刻意不引入第二 writer；任何未来维护 writer 增量必须重访两个恢复证明与 H0c 权威规则。

## 9. 验证与验收

- **3a 挂起**：唯一欠的工作是未尝试排队或延迟 wake 输入的 Session 在空闲期后挂起；其 writer seal、activation release、续约停止，恢复视图在 proof 当前性当前且输入可证明未尝试时报 `ready`。
- **3a 到期分发**：延迟输入在其 `notBefore` 的实测延迟界内触发（非兜底的分钟级）；挂起期间提交的立即输入被分发；过期输入恰好迟到触发一次；无追赶计数。到可达 owner 的正常 wake 不受 writer lease 门控（§4.2）。
- **3a 无双跑**：两个竞争分发器（或分发器 + transport + 兜底）每次 wake 加载一个 Session 一次；writer 获取围栏；输入在其 `turnId` 下结算一次。
- **3a 已尝试工作仍常驻**：turn 已开始的 wake 输入绝不被变为可挂起；泵的先前尝试检测阻止 Session（`hosted-monitor-wake-turn.ts:122-171`）。
- **3a 失效与无饿死**：父 run 终态的 child 通知、已停止 run 的 message 输入，其 head 提示由 proof 清除且不空转 wake–load–suspend 循环；8 个失效候选领先第 9 个有效到期 Session 时，第 9 个在分发器界内启动。
- **3a 退路**：wake-dispatch 禁用时，行为恰为 Phase 1 + 兜底；无输入丢失。
- **3b 只探测挂起**：各带一条 owed 清理记录的后台 Shell 与 Monitor 挂起；原进程持续运行、原 hold 仍在、stop 调用数为 0；随后显式 close 仍经正常 close drain 终止它们。
- **3b 第一条观测**：transport 关闭且 journal 为空时，单条 staged 观测仍经 staging 行扫描唤醒 Session（即便旧兜底先扫描），并在界内恰好投递一次通知。
- **3b drain 交接**：publisher 已持久写入某段后丢失 ack，worker 重 stage 该段且 wake drain 期间输出继续，产出不变的最终字节 digest、顺序、manifest 链与通知计数；generation 切换仍能读回已确认前缀。
- **3b 捕获存活**：Session 挂起时在途的后台捕获保持其输出（无 `producer_lost`），改道 staging 并在 wake 时恢复环回；前台 lane 保持 fail-stop。
- **3b 后台挂起**：带活 Monitor 或后台 Shell 的 Session 挂起（包括经逐 run 证据移除 `heldRuntimeTurns`/清理债务钉子）；进程在其 cgroup 下持续运行；观测连同其字节持久 stage；通知在 wake 时触发 turn。
- **3b 主动结算**：安静长任务运行期间不被 cleanup 扫描反复唤醒；其自然退出后，Broker 在界内释放 hold 且任务视图显示退出，全程无 Session 访问、无 release 请求。
- **3b drain 顺序**：wake drain 先发布 staged 资源再提交记录，保持 manifest 链，通过加载的 receipt 校验；按既有 offset 检查幂等且不提交重跑。
- **3b mount 交还**：带仅后台 hold 的 Hook- 或 MCP-owner Session 挂起而无 `HostedHookRecoveryRequiredError`/`HostedMcpRecoveryRequiredError`；真正前台 owner 仍拒绝交还。
- **3b 逐 run 豁免**：`child_agent`、`workflow`、`runtime_lost`、旧 generation Shell 不豁免；只有带当前 hold 与 receipt 的 `child_run(kind=shell)`/`monitor_run` 豁免，在挂起资格与 `ready` 两者中皆然。
- **3b 授权**：静默超过短 grant 租期再发首行的 Monitor 在同代 worker 上 stage 并投递（无续期往返）；generation 切换或撤销后，旧 worker 的追加被拒绝而已确认字节仍可读。
- **3b 重开 / worker 丢失 / 回收守卫**：加载重新附着并恢复 `heldRuntimeTurns`；挂起期间被杀的 worker 取 recovery-required，不铸造新持有者，不启动第二进程，调和或丢弃孤儿 staging；带活后台工作的挂起 Session 不被回收。
- **恢复视图**：其余条件相同的三个 Session——(a) proof 当前、未尝试延迟输入，(b) 已尝试但未结算且加载被拒的输入，(c) proof 滞后——只有 (a) 返回 `nextTurnAllowed=true`；带被持有后台工作及其仅后台清理 ref 的 sealed head 报 `ready`；偏斜投影产生 `awaiting_evidence`。
- **回归**：新范围外 Session 的 Phase 1 与 Phase 2 现有测试不变；非 wake 挂起路径与 parked-MCP 路径不变。
- **真进程/MySQL IT**：镜像 Phase 1/2 验收——在所需 CI tier 跑真 Harness + worker + MySQL wake/dispatch/staging/fault 矩阵；跳过 Hosted/MySQL gate 不是验收。
- **测量**：§7 证明常量合理且收益值得。

## 10. 开放问题

1. 扫描周期、认领租约、分发器页与 jitter（由测量选择）；分发器是独立 job 还是并入兜底扫描；以及 proof 重放成本（§7.3）后续是否证明按输入索引值得。
2. staging 字节界与保留、drain 批处理，以及任务视图是否需要执行账本活性指示器之外的 staged 输出读路径。
3. 确切 binding 范围 staging 授权形状（§4.4）：如何从已提交 binding/generation 事实无需 Harness 加载即签发与撤销，以及 generation 变更间未确认字节如何保留。
4. 挂起期间结束的后台运行应 wake Session 以 promptly 提交其终态 revision，还是等下次加载（主动触发无论如何释放 hold；journal 记录滞后）。
5. worker 捕获重写的确切形状：`RemoteShellCapture` 内部的 staging 回退 vs 独立后台 sink，以及如何保全前台 fail-stop 保证。
6. 只探测释放与 mount 交还容忍的确切形状：owner close 上的挂起模式标志 vs 按逐 run 后台 hold 键控的 keep-membership 臂。
7. 活压缩落地后的压缩感知 wake proof。
8. Phase 4 停泊审批是否复用分发器认领与 proof 当前性守卫（被持有审批 Turn 是不同的欠工作类）。

## 11. 可行性结论

**值得做；3a 先发，3b 是独立后续；测量是启用门槛。**

- **3a 小且主要是组装。** 输入契约、journal 派生 pending 集、常驻泵、transport activator、SQL 兜底及其 proof、wake 动词、冷开上限、churn cap 与 head 提示模式都已存在。新增是一个容忍陈旧的 head 到期列（接受递减、proof 刷新）、一个复用 proof 的到期优先分发器、两处守卫放宽（资格与 proof 当前性恢复视图）。无新表。收益是移除每个仅被排队或延迟输入钉住的 Session 的常驻，并以秒级到期分发取代分钟级迟到的兜底。
- **3b 的关键是无 Harness 持有 writer 时的持久提交路径。** Broker 账本 staging 加 drain-then-open wake 交接保全单 writer 不变量与恢复证明，代价是有界提交滞后、复用既有 offset 幂等的携带字节 drain、staging 行作 wake 标记、主动结算触发、binding 范围授权、任务视图读路径、捕获管线重写、只探测/mount 交还 teardown 容忍。worker 已拥有进程、cgroup 监督、hold 账本与重新附着路径；sweep 逻辑存在但是操作触发，所以 3b 新增主动驱动者而非结算本身。
- **前提。** head 提示绝不偏晚陈旧与 proof 刷新的正确性证明；分发器无双跑围栏与无饿死分页；3b 捕获重写特征化、drain-then-open 交接、staging 行标记、不重载的主动结算、binding 范围授权、只探测 drain 与 mount 交还容忍限定、generation 围栏孤儿调和；恢复视图拓宽（proof 当前性 + 未尝试证明 + 逐 run 豁免）对照两个附录证明；真进程/MySQL fault 验收；以及 §7 测量。
- **与 Phase 1 和 Phase 2 兼容。** 资格谓词的活跃工作项、teardown 顺序、parked-MCP 复用、有界恢复证明与恢复视图滞后臂都成立（§6）。无新 journal kind、journal 契约无 schema 变更、无第二 writer。MCP-owner Session 的 3b 依赖 Phase 2 parking 启用。

**建议切片**：(1) head 到期提示 + proof 刷新 + 到期优先分发器 + 能力门 + 资格放宽 + proof 当前性恢复视图拓宽 + proof 重放成本测量（3a 启用）；(2) worker 捕获管线重写（fail-stop → buffer-and-redirect）+ 特征化测试；(3) 携带字节的 Broker staging 路由/账本 + staging 行 wake 标记 + drain-then-open 交接 + worker 侧聚合；(4) 主动执行结算 + binding 范围授权 + 只探测/mount 交还 teardown 容忍 + 完整逐 run 资格放宽 + 回收守卫 + 任务视图活性（3b 启用）；(5) 真进程/MySQL fault 矩阵 + 发布常量选择。按输入 wake 索引、维护 writer 权威、压缩感知 proof 是由测量门控的独立后续设计。
