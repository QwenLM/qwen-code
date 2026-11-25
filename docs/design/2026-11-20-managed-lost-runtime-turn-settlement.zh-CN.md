# Managed 丢失 Runtime 的 Turn 结算

[English](2026-11-20-managed-lost-runtime-turn-settlement.md) | [简体中文](2026-11-20-managed-lost-runtime-turn-settlement.zh-CN.md)

状态：实现 [从持久化原生终态恢复](2026-11-19-managed-recovery-native-terminal.zh-CN.md) §5 推迟的 #17542 后续。日期：2026-11-20。不改 schema、不新增 Harness 动词、不改 Broker；修复是 Hosted Harness 恢复里 passive load 的一个分支。

## 1. 问题

Runtime 在 Turn 在途时被带外终止（空闲回收、平台驱逐、非宿主重启的 kill），该 Turn 永不结算。控制面把它 park 在 `managed_runtime_recovery_blocked`，按 RECHECK 节奏无限重驱取消；恢复视图持续答 `awaiting_evidence` / `operator_required`，`nextTurnAllowed=false`。

原生终态设计 §5 把阻塞点定位在取消就绪性：`HarnessRuntimeRecovery.isCancellationReady` 拒绝 Runtime execution outcome 为 `unknown` 的 park，而该 outcome 只有在 Broker 把被终止的 generation 当作"执行已停止"的权威证据时才能变 known。读当前代码可见链路与 §5 的假设相比已接近完整，并可定位仅剩的一环：

1. 死 lease 把 binding 失效为 `LOST`（`RuntimeBindingRegistry.invalidateBinding`）。本地 provisioner 对"worker 可证缺失"的观察返回带 `JOURNAL_LOST` 证据的 `notFound`，但**没有** `WRITERS_STOPPED` 证据（`LocalProcessRuntimeProvisioner.observeDurable`）。
2. 丢失回收放弃该 generation 的 tool execution（`JdbcToolExecutionRepository.abandonByBinding` → `ABANDONED`，终态围栏），但**无法释放** binding 及其 Runtime Session：释放要求 `hasStoppedWriters()`（loss **与** stop 证据俱备）。stop 证据只由可信宿主重启、运维证明或干净 drain 产生——同 boot 的带外 kill 绝不产生。这是有意的 fail-closed 行为：被 SIGKILL 的 worker 可能留下仍在写 workspace 的孤儿 tool 进程组，故 worker PID 缺失本身不是 writer-stop 证明（见 [shell/monitor runtime 设计](2026-10-03-managed-shell-monitor-runtime.zh-CN.md) 与 [运维恢复设计](2026-09-29-hosted-operator-recovery.zh-CN.md)）。
3. 每次 Harness 恢复 load 都先收养 Runtime Session（`recoverHostedRuntimeTurn` → `broker.acquire()` → `ensureBinding`）。无 stop 证据的 `LOST` binding 回收到 `runtime_broker_runtime_lost` 且不置备替换，于是收养失败、load 在读 execution 之前就抛出。控制面捕获抛出并重新 park。循环。

逃生口已存在但不可达：Broker 的 status 路由对终态 `ABANDONED` 记录**无需收养 Session**即可从持久化账本作答（`RuntimeBrokerService.getExecution` → `requireOwnedExecution` 的 terminal 分支只要求同 generation 的 saved binding/session 行存在，而 binding 卡在 `LOST` 时这些行仍在），且取消机制已接受 abandoned execution 为"已停止但未见证"并以诚实的不可观察结果入 journal（`stopParkedRuntimeExecutions`、`settleParkedTurnCancelled`）。唯一阻塞它的是 passive load 先收养后读取的顺序。

## 2. 决定

让 passive takeover 结算"每个待决 Runtime execution 都已终态 abandoned"的 park，即使收养被以 lost 拒绝。在 `recoverHostedRuntimeTurn`：

- 包裹 `broker.acquire()`；遇 `runtime_broker_runtime_lost`（503）记录该拒绝并跳过收养，而非抛出。其它任何收养失败原样传播。
- 在 passive 逐 execution 读取中，若收养被以 lost 拒绝，则**不**向死 Runtime 对账，直接读每个待决 execution 的持久化 status。只接受 `state === 'abandoned'`；任何其它状态、或无法作答的读取，都重抛捕获的 lost 拒绝，使 load 与之前完全一样地 park。
- 该容忍要求至少有一个待决 execution：若无（全 settled 的 `results_ready` park），则没有 abandoned 围栏可证，重抛捕获的拒绝、load 照旧 park。因此结算范围精确为"一个或多个待决 execution，且每个都终态 abandoned"。
- 全 abandoned 的 park 把每个 execution 报告为 `known` / `abandoned`，于是 `isCancellationReady` 成立，协调器驱动既有取消，把结算入 journal。该报告绝不 continuation-ready：`isContinuationReady` 还要求每个 execution `settled`，而 abandoned 围栏不是。

不改 Broker、控制面、schema 或协议：修复读取的持久化事实已存在，触发的结算就是既有 CANCELLING 车道机制。

## 3. 保留的不变式

- **不在活 writer 之上结算。** load 仅在待决 execution 全部终态 abandoned 时继续——这是 Broker 仅凭 loss 证据写入的围栏。仍 `UNKNOWN` 的 execution（writer 未证）保留 lost 拒绝与 park。重复执行护栏（#14387 / D7-2）完好：不向丢失 generation 重派任何执行，continuation 仍被 settled-state 要求挡住。
- **writer-stop 仍把守重置备。** binding 保持 `LOST`；修复读持久化记录，不释放 binding、不伪造 stop 证据。替换 Runtime 仍仅在 loss **与** stop 证据俱备时置备（重启 / 运维 / 干净 drain）。修复关闭的是无限结算缺口，不是 writer-stop 证明缺口。
- **诚实结果。** abandoned execution 以 parked-Runtime 结算既有的不可观察结果入 journal，绝非被见证的取消。
- **收养纪律。** 跳过的收养不获取任何东西，故不欠 lease、不做补偿释放；非 lost 的收养失败路径保留既有传播与欠收养行为。

## 4. 残留

- 已结算 Turn 的 Session 读作 `ready`（持久化原生终态、无未决工作），但后续需要 Runtime 的 Turn 仍在准入处遇 `runtime_broker_runtime_lost`，按普通有界重试预算失败而非挂起。恢复 tool 执行需要 writer-stop 证据（运维恢复或可信重启）——这是文档化的安全姿态，本修复不改。让平台销毁证明自动产生 stop 证据是 provisioner 专属的后续。
- wake turn 崩溃善后（`settleCrashedWakeTurnAftermath`）在其自有路径上容忍 released/releasing 收养拒绝；本修复只改 parked-Turn recheck 驱动的 passive takeover。若证明 wake 车道也会卡死，把同样的 lost 容忍对称扩展到 wake 路径是独立后续。
- H3 后台 execution 按设计在同 boot 丢失时不被放弃；本修复不触碰该规则。
- 含任何非 abandoned 待决 execution 的 park——包括 ledger 记录已 `settled` 者（kill 落在 broker-settle → harness-fold 窗口）——以及无待决 execution 的全 settled park，都保留 lost 拒绝并照旧 park；lost 分支只接受全 abandoned 的待决 park。两者均非回归（修复前 load 在读任何东西之前就已在 acquire 失败）。settled 结果是被见证的结局，后续可安全地与 `abandoned` 一并接受；本 PR 保持更窄的全 abandoned 范围。

## 5. 验证

- `hosted-runtime-recovery.test.ts`：收养被以 `runtime_broker_runtime_lost` 拒绝的 passive load，把全 abandoned 的 park 报告为 `known`/`abandoned` 且 drivable（协调器在其上取消），且不欠 lease、不做补偿释放；非 abandoned execution、abandoned/unknown 混合 park、持久化读取故障、以及无待决 execution 的全 settled park，各自保留具体的 lost 拒绝（可重试）。完整 100 例文件通过，含既有 abandoned 区分、收养失败传播、欠收养用例。
- `DurableRuntimeRecoveryTest.aLostGenerationsAbandonedExecutionStaysReadableWithoutAdoption`（H2）：仅 loss 的回收使 execution `ABANDONED`、binding `LOST`；无内存 Session 的替换 Broker 进程经 `getExecution` 读到 abandoned 记录，而其 acquire 仍失败 `runtime_broker_runtime_lost`、binding 保持 `LOST`。完整 39 例类通过。
- 仍欠 CI：Linux 真实进程 Hosted/fault 恢复 profile 与 MySQL profile（本改动属恢复相关）；完整 vitest 套件、Checkstyle 与 SpotBugs。本地证据为上述聚焦 TS 文件与聚焦 H2 类。
