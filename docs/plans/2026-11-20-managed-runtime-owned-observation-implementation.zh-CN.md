# Managed Runtime 自持后台观测 — 实施计划与交接（Phase 3b）

[English](2026-11-20-managed-runtime-owned-observation-implementation.md) | [简体中文](2026-11-20-managed-runtime-owned-observation-implementation.zh-CN.md)

状态：进行中。权威设计：[`docs/design/2026-11-19-managed-runtime-owned-observation.md`](../design/2026-11-19-managed-runtime-owned-observation.md)（PR #17912）。本计划按设计 §9 的四个切片跟踪实施，精确记录已落地内容、剩余工作，以及每个剩余步骤必须保持的契约。请按切片在新会话中接续（不要 resume 超大转录）。

## 已落地（已验证、已提交）

提交 `f577250f41` — `feat(managed-agent): worker-owned background capture and delivery outbox (Phase 3b slice 1)`。6 个文件。这是切片 1 的基础垂直核心：worker 自持采集、投递 outbox、常驻 Harness applier、按 writer generation 围栏的 publisher 替换、推送失败转 held 模式。

文件：

- `packages/core/src/managed-runtime/managed-delivery-entry.ts`（新增）：`managed-delivery/1` 条目契约 — `output`/`observation`/`terminal` 三种 kind、每 run 的 `deliverySeq`、条目自带资源（`published` 段内容 vs `referenced` 页/manifest/观测/通知），以及严格解析器。请求上限 512 KiB。
- `packages/core/src/managed-runtime/local-shell-stream-capture.ts`：加性选项 `segmentBytes`（默认 1 MiB）、`segmentsPerPage`（默认 512）、每次 manifest revision 后触发的 `onRevision(ref)` 钩子；新增 `flushPartial(stream)` 用于空闲 flush。默认值逐字节保持前台 lane 不变。
- `packages/cli/src/serve/managed-background-delivery.ts`（新增）：`WorkerDeliveryResourceStore`（本地 ref 计算 + 按插入序 `since(marker)`）、`BackgroundDeliveryRun`（有序 outbox、带异步 room 闸的字节预算 → 管道背压、保留 terminal 槽、`appliedThrough`/`stagedThrough`、attached/held 推送循环）、`WorkerBackgroundCaptureSink`（256 KiB 段、1024/页、空闲 flush、output/terminal 条目）、`WorkerMonitorPolicy`（行切分 + debounce/idle/maxEvents、worker 分配 sequence、本地构建通知资源）。
- `packages/cli/src/serve/managed-shell-publisher.ts`：registry 构造接收 `{ enabled, workspaceId }`；注册接受相同或更新的 `writerGeneration`（更旧 → 409）；`prepare` 将 background+capability 路由到 `prepareWorkerOwned`（本地计算确定性 `captureId`）；`accept` 为 worker run 返回 terminal 回执。
- `packages/cli/src/serve/hosted-shell-publisher.ts`：`deliver` 操作 + `applyDelivery`/`applyDeliveryEntry` — 幂等发布自带资源、推进 `outputRef`、应用观测、按 `finalizeBackground` 的方式结算记录；每 run `appliedThrough` 水位；强制连续性。
- `packages/cli/src/serve/managed-background-delivery.test.ts`（新增）：采集→outbox→applier→结算、幂等重投、generation 围栏。

验证（全绿）：新套件 3/3；`managed-shell-publisher.test.ts` + `hosted-shell-publisher.test.ts` 54/54；`hosted-shell-publisher.background.test.ts` 26/26；core `local-shell-stream-capture.test.ts` 13/13。capability 关闭时旧 lane 不变（registry 默认 `enabled:false`）。

### 已钉住的关键契约

- `captureId = sha256(JSON.stringify([sessionKey, executionCallId, bindingGeneration])).slice(0,32)`，`sessionKey = {tenantId, workspaceId, sessionId}`。worker 由 `capture.tenantId/sessionId` + `observation.workspaceId` 计算；applier 的准入重算同一值。
- 段内容资源 ID = `sha256(JSON.stringify([captureId, streamId, ordinal]))`；seal 用 `'seal'`。`ResourceToolResultSegmentStore` 在 worker 本地资源 store 上原样复用，段/seal 行为完全一致。
- 条目携带自上一条目以来引入的全部资源（`WorkerDeliveryResourceStore.since(marker)`）；manifest revision 的 `onRevision` 钩子对其快照。同 ID+digest 重发为 no-op。
- 推送失败绝不 `failCapture()`；转 held 并保留条目。terminal 条目绕过字节预算，强制 stop 总能产出退出证明。

## 切片 1 — 剩余

1. **worker 中的 Monitor 策略 — 已落地（worker 侧）。** executor monitor lane（`managed-runtime-tool-executor.ts`，`executeV3Monitor`）在 prepared sink 为 `WorkerBackgroundCaptureSink` 时挂载 `WorkerMonitorPolicy`；sink 将 stdout 路由到 `policy.onChunk`，policy 分配 sequence（全新启动 `startSequence:0`）并构建通知资源，quota/idle stop 经 `monitorRegistry.terminate` 终止 unit，其退出经 terminal 条目的 `monitorStopReason` 结算记录。参数与 Harness admit 一致（`max_events` 默认 1000 clamp 1..10000，`idle_timeout_ms` 默认 300000 clamp 1..600000，`debounceMs` 1000）。测试：观测条目恰好提交一次（`observationSequence=1`、`notifiedThrough=1`、settled `exited`）。**仍剩余：** capability 模式下 Harness `HostedMonitorLoop` 须变为纯 applier — `resumeMonitorWatch`（`hosted-workspace-tool-turn.ts:9263`）在 worker 自持观测时须跳过启动 loop，否则双方都观测。rebuild/re-attach 须以已提交的 `observationSequence` 水位作为 `startSequence`（全新 worker lane 恒为 0）。
2. **capability 门 + publisher generation — TS 已落地；Java 转发剩余。** TS 侧（提交 `833d61d0bb`，验证：cli tsc 0、broker+delivery 104、tool-turn 654）：worker registry 启用时在注册响应回 `observation:true`，由 env `QWEN_MANAGED_RUNTIME_OBSERVATION=1`（默认关）在 `managed-runtime-attestation-worker.ts:658` 门控，`workspaceId` 取自 boot；`HostedWorkspaceBroker.registerPublisher(publisher, writerGeneration?)` 保持 string 返回、加 `observationOwned` 字段、发送 `writerGeneration`；turn 在 publication 模式传 `writer.writerGeneration` 并置 `workerOwnsObservation`，`resumeMonitorWatch` 在其为 true 时提前返回。向后兼容（返回 `'1'` 的旧 mock 仍绿；两处 publication 模式 `toHaveBeenCalledWith(descriptor, 1)` 断言已更新）。
   **Java 转发 — 已落地（提交 `2891496191`，已验证）。** `installPublisher`/`installPublisherV3` 现接受 `Long writerGeneration` 并返回 `CompletionStage<Map<String,Object>>`。`HttpRuntimeTransport.installPublisherV3` 存在时将 generation 加入闭键 body，在 `ManagedContextProtocol.verify`（精确匹配）前剥离可选 `observation` 并单独返回；`RuntimeBrokerService.installPublisher` 透传 generation 并将 `observation` 拷入响应；`:publisher` 路由解析可选正 `writerGeneration` 并转发 `observation`。已更新实现/调用/mock：`RuntimeTransport`、`WorkspacePhysicalTransport`、`RuntimeBrokerOperations`、`WorkspaceRuntimeTransport`、`RuntimeBrokerHttpServer`，及测试 `UnknownExecutionObservationTest`、`RuntimeBrokerHttpServerTest`、`HttpRuntimeTransportTest`（+ 新增 `forwardsWriterGenerationAndReturnsObservationOwnership`）、`SshRuntimeInteropTest`、`WorkspaceRuntimeTest`。验证（隔离仓库 `/tmp/p3b-m2`，sibling SDK 以 `-Dgpg.skip` 安装）：全 reactor `test-compile` 绿；聚焦 `HttpRuntimeTransportTest` 86、`WorkspaceRuntimeTest` 54、`RuntimeBrokerHttpServerTest` 40、`UnknownExecutionObservationTest` 3（0 失败）；双 Checkstyle 绿。注册链至此端到端闭合。
   - 正式 `runtime-observation/1` capability 字符串进 attestation + 准入检查属切片 3；env 门 + 注册响应信号即切片 1 的 worker capability。在 characterization（项 3）证明等价前保持生产关闭，之后翻 `QWEN_MANAGED_RUNTIME_OBSERVATION=1`。
3. **characterization 测试 — 已落地（提交 `55beeb7def`）。** `core/local-shell-stream-capture.equivalence.test.ts`（2 测试）：相同输入经 worker 选项集（256 KiB/1024）与 Harness 集（1 MiB/512）产出相等的每流 `{byteLength, digest, state}`、相等 `executionStatus`、逐字节一致的可重构输出（经真实 `ResourceToolResultSegmentStore.readRange`），且 worker 确实分段更细（`segmentCount` 严格更大）。覆盖 ~3 MiB stdout 跨多个 Harness 段、跨 chunk 拆分的 UTF-8 字符、空流、单部分段。`cli/managed-background-delivery.test.ts` 新增 held 续采测试：无 publisher attach 时采集保持 `held`（条目保留、`isLostCaptureResult` false），注册后投递恢复并以正确流 digest 结算同一 `captureId`。验证：core tsc 0、cli tsc 0、equivalence 2/2、delivery 5/5。**完整设计 §10 仍剩：** 真实进程 Harness kill+reload、跨*全新* applier 每字节恰好一次的测试需切片 2 的 re-attach-then-drain 水位同步（全新 applier 从 `appliedThrough=0` 起；worker 须报 `stagedThrough`、applier 从其续）。切片 1 的 held→resume 测试覆盖同 applier 续采与无 `producer_lost` 保证。

## 切片 2 — Broker staging（已落地、已验证）

设计 §4.5–§4.7。切片 2 全部触点已实现并验证通过：

- **Schema 与 binding 拉取者 claim — 已落地（提交 `beaa2948ec`、`84ab21559a`）。** `ma_runtime_stage` 按 `(execution_call_id_hash, delivery_seq)` 键控，含 `staged_bytes` 与 `idx_ma_runtime_stage_session`；`RUNTIME_STAGE` 加入 `ck_ma_ref_owner` 与 `ManagedSchemaContract.ResourceOwnerKind`；`ma_runtime_binding` 新增 `observation_owner`/`observation_lease_until`/`observation_generation`（独立于 `operation_owner`，使 drain/release/reconcile 不被 long poll 阻塞）。验证：`ManagedSchemaTest` 27/27（H2）、双 Checkstyle 绿；真实 MySQL 8.4 `ManagedSchemaMySqlIT` 属切片 4 验收。
- **Staging store 与单事务 — 已落地（提交 `84ab21559a`、`98d4d66744`）。** `RuntimeStageStore` + `JdbcRuntimeStageStore` 在拉取者 claim 校验与 `ma_runtime_binding -> ma_session -> ma_session_head` 锁序下于单事务内完成：`PUBLISHED` 段资源、`RUNTIME_STAGE` 下 `REFERENCED` 页/manifest/观测/通知资源（`owner_key = executionCallIdHash`、`owner_revision = deliverySeq`）、剥离内联 `resources` 后的 `ma_runtime_stage` 行、每 run 10,000 条观测上限 + Session `staged_bytes` 水位线唤醒 + 带保留 `terminal` 槽位的硬上限、`ma_session_head` 唤醒拉近（`is_wake_pending = 1`、`wake_retry_at <= now`），以及经 `JdbcToolExecutionRepository.settleBackgroundProcessOnConnection` 同连接结算 `ma_tool_execution`（`:process` 行）。重复重放跳过已暂存行且不重复计入字节。
- **manifest 闭包遍历（TS）— 已落地（提交 `732a6f875f`）。** `http-managed-session-store.ts` 的 `isReferenceContainer` 包含 `managed-tool-result-manifest`，drain 提交时由服务端收集嵌套分页 `JOURNAL` ref（246 个 store 测试全绿）。
- **Worker `observation-pull` 与 `publisher/detach` + transport — 已落地（提交 `6d38181b06`、`98d4d66744`）。** Worker 挂载 `/internal/managed-runtime/v3/observations/pull`（lease 围栏、attached 时立即返回 `attached`、held 时 long poll、每 run 最新 long poll 取代旧等待者、按 `ackThrough` 裁剪前缀）与 `/internal/managed-runtime/v3/publisher/detach`（generation 围栏），并在 `/v3/publisher` 返回 `observedRuns`；贯通 `ManagedContextProtocol`、`WorkspacePhysicalTransport`、`RuntimeTransport`、`HttpRuntimeTransport`、`WorkspaceRuntimeTransport` 与 `RuntimeObservationCoordinator`（每 binding 单拉取者 claim + terminal/硬上限零等待 worker 确认）。
- **wake 与 seal 围栏 + delete/retirement 清理 — 已落地（提交 `84ab21559a`）。** `JournalWriterLifecycle.sealWriter` 在 `hasWakeWorthyRow` 为真时保留 `is_wake_pending = TRUE` 与 `wake_retry_at <= now`，排空后仍正常清除 `is_wake_pending`；`JdbcWakeRecoveryStore.hasPendingInput` 对暂存唤醒行短路跳过 journal proof，`recordPending(candidate, false)` 带 `NOT EXISTS (... is_wake_worthy = 1)` 守卫。`ToolPublicationRetentionStore.retire` 清除唤醒提示，`ManagedSessionRetirementStore` 删除 `ma_runtime_stage` 行与 `RUNTIME_STAGE` ref；退役后到达的尾随 `stageBatch` 跳过暂存但仍结算 `:process`。
- **re-attach-then-drain 与持久化 Broker adoption — 已落地（提交 `6d38181b06`、`98d4d66744`）。** `HostedShellPublisher` 对 `output`/`observation`/`terminal` 重放幂等，并在 `reattachAndDrainBackgroundDeliveries`（`hosted-background-delivery-recovery.ts`，于 `hosted-harness-session.ts` 的 `retryHostedCleanup` 之前接入）执行期间通过 `deliveryGate` 暂住实时 worker 推送，先重挂 publisher，再经 `/harness-sessions/{id}/staged-deliveries/list` 按序排空提交、经 `/staged-deliveries/acknowledge` 删除暂存并播种 `observedRuns` 水位。`RuntimeObservationCoordinator.requireOrAdoptReadySession` 跨 Broker 重启与多副本领养持久化 binding/Session，覆盖 publisher 安装/摘除、后台观测/取消（`stopBackgroundProcess`）与 Monitor 控制。验证：TS `managed-background-delivery.test.ts` 7/7、`managed-runtime-worker-routes.test.ts` 26/26、`hosted-shell-publisher.background.test.ts` 26/26、`managed-context-worker.test.ts` 814/814、`cli` build+eslint 0；Java `RuntimeStageStoreTest` 4/4、`RuntimeObservationPullerTest` 1/1、`RuntimeBrokerHttpServerTest` 40/40、`WakeRecoveryStoreTest` 29/29、`WakeSealStampTest` 8/8、`ClassSizeRatchetTest`/`ModuleArchitectureTest`/`SurfaceRegistryGateTest` + 双 Checkstyle 全绿。

## 切片 3 — 后台挂起（已落地、已验证；生产默认关闭）

设计 §4.8–§4.11。落地于提交 `f9e5fc0d94`（Java）与 `b920907f61`（TS + grant）：

- **资格 — 已落地。** `backgroundSuspensionCertificate`（`hosted-turn-cleanup.ts`）仅在「每个未结算 run 都是带 start receipt、`running`/`waiting` + `running_attached`、且其 binding 的 worker 已接管采集（`HostedShellTurnOptions.observationBindings`，键 `bindingId@generation`，在 `dispatchStarted` 处登记）的 shell/monitor hold」且「每个 owed cleanup descriptor 都通过既有 `hasBackgroundHoldEvidence`」时，豁免 `suspensionLiveWork` 的四个后台项（owed cleanup、`heldRuntimeTurns`、活跃 monitor loop、未结算 `child_run`/`monitor_run`）。`child_agent`/workflow run、`runtime_lost`、旧 generation、不支持的 worker 一律保持常驻。证书在每轮资格检查重新推导；两轮之间豁免失效则回退本次尝试。
- **seal 证书 — 已落地。** 新增 `ma_session_head.wake_seal_background`（含 boolean CHECK 与 projection 列），由 `sealWriter` 在与 stamp 相同的 writer 围栏与 revision 校验下写入，任何 writer acquisition 清除；`WakeStamp.backgroundHeld`（TS `ManagedSessionWakeStamp.backgroundHeld`）承载。恢复 `ready` 臂在该 sealed revision 上经 `hasUnsettledWork(..., backgroundCertified)` 读取，此时仅未结算 Turn 仍阻塞；`JdbcHostedCleanupDebtStore.OWED` 跳过此类 head 的 debt，不再为其重新加载。
- **probe-only release — 已落地。** 两条挂起路径均传 `probeOnly`：`releaseLeaseNow` 不 drain 释放并把 Broker 确认的 `held` 视为成功，`retryHostedCleanup` 不带 `drain: true` 对账。前台 debt 仍使 teardown 失败；close 保留其终止并排空路径。
- **带最终确认的 detach — 已落地。** `HostedShellPublisher.quiesce()` 只等一轮有界的在途推送（绝不等「静默」——活跃 Shell 会持续推送），随后 `detachBackgroundPublishers` 对每个 lane 的 publisher 经 `/tool-sessions/{id}/publisher/detach` 携带 `appliedThrough` 摘除；Broker 在摘除事务内删除至该点的暂存行，worker 转 held。本地监听仍关闭，因为该常驻正在退出。
- **reclamation 守卫 — 已落地。** `reclaimParkedMcp` 在 `transport.reclaimMcp` 之前，只要该 binding+generation+Runtime Session 仍有活跃执行行即拒绝，因此活跃后台工作下不会关闭任何连接；附带的结算 sweep 已移除（由 pull 结算已结束的 run）。
- **drain-only 退出 wake — 已落地（切片 2 + 既有 idle 挂起）。** terminal 条目标记 wake，加载排空并结算且不提交任何 input，idle 计时器重新 seal；不为其跑模型 turn。
- **delete 清理 — 已在切片 2 落地**（`84ab21559a`）。
- **发布门 — 已落地，默认关闭。** `qwen.managed-agent.runtime-observation.enabled`（默认 false）在 writer grant 中 beside `wakeDispatch` advertise 为 `runtimeObservation`（`WriterGrant.withRuntimeObservation`、`supportsRuntimeObservation()`）；worker capability 即上述逐 binding 登记。一旦 Session 挂起，pull 与 staging 不论 setting 均运行。

验证：Java `WakeSealStampTest` 12/12、`SessionRecoveryServiceTest` 67/67、`HostedCleanupDebtStoreTest` 7/7、`RuntimeBrokerServiceTest` 214/214、`ManagedSessionStoreIntegrationTest` 16/16、`WorkspaceRecoveryStoreTest` 33/33、`StoreLockTraceTest` 16/16、`ManagedSchemaTest` 27/27、surface/架构/尺寸门 + 双 Checkstyle 全绿。TS `hosted-turn-cleanup.test.ts` 33/33（新增 4 个证书用例）、`hosted-session-suspension.test.ts` + `managed-background-delivery.test.ts` + `hosted-shell-publisher.background.test.ts` 合计 89/89、core store 246/246、core+cli 构建与 ESLint 干净。

**切片 3 投产前仍剩：** 真实 worker 上的端到端挂起 E2E（经 daemon 走完 资格 → 摘除 → 暂存唤醒 → 排空 循环），与 MySQL 8.4 故障矩阵一并属切片 4 验收。

## 切片 4 — 验收与度量（进行中）

设计 §7、§10。仅 H2 不算验收：staging、结算、wake 与故障用例还必须在 MySQL 8.4 + 真实 Harness/worker 上通过。

### 已落地

- **真实进程静默退出**（`packages/cli/src/serve/managed-background-delivery.process.test.ts`）：真实 `bash` 子进程在 publisher 已摘除时静默退出；worker 保留 terminal 条目，新 applier 以更新的 writer generation 重挂，记录带退出证据结算，且 manifest 声明每个流零字节。
- **真实进程流中 Harness 重启**（同文件）：真实生产者跨过段边界、首个 applier 应用了一段前缀后死亡，新 applier 以 generation 2 重挂。结算后的 manifest 声明整段输出的精确字节长度与 SHA-256，且属同一 lineage —— 这是 §10「Harness restart」在真实管道上的用例。

  该装置必须精确照抄生产协议：先 `holdDeliveries` 暂住实时推送、再安装、然后用安装响应报告的 `observedRuns` 水位播种游标。缺少播种时，第一条「已确认之后」的条目会被判 `Delivery sequence is not contiguous`（worker 早已裁剪已确认前缀）——产品是对的，装置是错的。生产的 `reattachAndDrainBackgroundDeliveries` 本就如此。

- **投递批次上界（验收发现的缺陷）。** 原先一个 revision 最多携带 1024 个 256 KiB 段，base64 后单个 output 条目即可超过 `MANAGED_DELIVERY_REQUEST_LIMIT_BYTES`（512 KiB）。`deliverRpc` 在发出任何 HTTP 之前就拒绝超限请求，因此该条目永远推不出去、run 永久停在 held——违反 §11「预算下界为最大 flush 批次」。背景采集现改为 128 KiB 段、每段一页，使一个 revision 只携带单个段（编码后约 175 KB），即使两个流同时封页进同一条目也远低于上限。副作用是输出可见性提升：每 128 KiB 一个 revision，而非每 1024 段一页。

- **背压下强制停止（验收发现的缺陷）。** outbox 满且 run 处于 held 时，采集的写队列停驻在 `waitForRoom` 内，stop 的 `finish`/`finalize` 排在其后——保留的 terminal 槽位根本不可达，registry 的 completion 协程会永久挂起、Runtime hold 永不释放。这正是 §4.4 的违反（「满 outbox 绝不能让已停止的进程产不出退出证明」）；此前「broken capture 的终态 manifest 无法 chain」的假设在其下游——terminal 条目从未发出。修复落实设计的丢尾契约：
  - `WorkerBackgroundCaptureSink.setStopRequested()` 调用 `BackgroundDeliveryRun.requestStop()`，释放所有停驻的 room 等待者，stop 绝不等停驻队列。
  - `waitForRoom` 仅在 stopping **且** outbox 确实满时丢弃条目；首次丢弃门闩 `tailDropped`，使被丢的尾巴是一段连续后缀，后续条目绝不能越过它恢复入队（否则破坏消费方强制的序列连续性）。outbox 尚有空间的 stop 照旧投递与封口——既有 stop 用例仍见 `complete`。
  - 被丢条目不消耗 `deliverySeq`：序号在实际入队时才抽取，而非构造时，因此 terminal 条目与最后入队的条目保持连续。
  - sink 的 revision 钩子在首个被丢 revision 上以新增的 `cancelled` 原因标记 capture broken（`LocalShellStreamCapture.cancelCapture()`），冻结缓冲尾巴；终态 revision 经 `missingRanges` 声明缺口。
  - 资源 marker 仅在条目实际入队时前进，因此 terminal 条目携带终态 manifest 所指一切资源的完整闭包——含被丢 revision 的段、页与 manifest。applier 无需改动：终态 manifest 从最后应用的 revision 链接（`isToolResultManifestChainLink` 容许 revision 缺口），结算校验每个携带的 ref。

  验收用例（同一进程测试文件）用真实无界生产者填满 held outbox，等到写队列停驻（生产者仍在写而条目数稳定不变），以 SIGSTOP 冻结生产者再 SIGKILL 强杀，然后按 registry 的 completion 顺序执行。结算后的记录为 `cancelled`/`stop_requested` 且无退出状态；manifest 为 `partial`/`cancelled`，保留前缀的 digest 与生产者精确字节一致，被丢尾巴是声明出的缺口。装置陷阱：在 outbox 停驻之前就冻结生产者，可能恰好落在段边界上、无尾可丢——capture 会诚实地封口为 `complete`，因此用例等待停驻信号而非固定条目数。

### 真实 MySQL 8.4 — 已落地

`mysql@8.4`（8.4.11）本来就已装在 `/opt/homebrew/opt/mysql@8.4`；默认 `mysql` keg（26.7.0）的 `mysqld` 已损坏，因此无需安装任何东西。一次性实例跑在 3307 端口、独立 socket 与数据目录，跑完已 shutdown 并删除。

- **`ManagedSchemaMySqlIT` 3/3** — 切片 2/3 的 schema 新增（带 `staged_bytes` 的 `ma_runtime_stage`、`observation_*` binding claim 列、`wake_seal_background` 及其 boolean CHECK）在真实 8.4 上初始化与校验通过，含系统 catalog 与 strict-mode 拒绝路径。
- **`RuntimeStageMySqlIT` 4/4（新增）** — 真实 8.4 上：单 staging 事务（PUBLISHED 段、`RUNTIME_STAGE` 下 REFERENCED 页/manifest、wake 提示拉近至 now、`:process` 结算）与幂等重放；detach→seal 围栏加 `recordPending(false)` 拒绝、排空后干净清除；水位线 wake、硬上限与保留 terminal 槽位；退役清理行与 ref，且尾随批次仍结算执行行。

运行配方（聚焦，在 `packages/managed-agent-server` 下，带隔离仓库）：

```bash
mvn -Dmaven.repo.local=/tmp/<task>-m2 -Pmysql-integration -Dspotbugs.skip=true \
  -Dtest=WakeSealStampTest -Dsurefire.failIfNoSpecifiedTests=false \
  -Dit.test=RuntimeStageMySqlIT -Dfailsafe.failIfNoSpecifiedTests=false \
  -Dmysql.url='jdbc:mysql://127.0.0.1:3307/managed_agent_test?createDatabaseIfNotExist=true&allowPublicKeyRetrieval=true&useSSL=false' \
  -Dmysql.user=root verify
```

仅该聚焦车道需要 `-Dspotbugs.skip=true`：完整 `verify` 生命周期会撞上 `ToolPublicationAdmissionStore.acknowledgementReceiptCatalog` 里**既有**的 SpotBugs `NP_NULL_ON_SOME_PATH`，该文件本 PR 未触碰（最后改动来自已合并的 #17907）。该门在 CI 仍会跑。

### 真实 MySQL 8.4 — 故障矩阵（已落地）

剩余故障用例的 Java 半已在一次性 8.4.11 实例上见证（3307 端口、独立 socket/datadir，跑完 shutdown 并删除），配方同上，分两批——**158 条 failsafe 断言，0 失败**：

- **批 1（115）：** `RuntimeHarnessDrainMySqlIT` 69（re-attach-then-drain）、`WakeRecoveryMySqlIT` 30（暂存 wake 臂 + seal/`recordPending` 提示守卫）、`ManagedRuntimeRetentionGuardMySqlIT` 12（活跃后台工作下 retention 拒绝）、`RuntimeStageMySqlIT` 4（staging 事务、detach→seal 围栏、水位/硬上限/terminal 槽、退役）。`WakeSealStampTest` 12 在 H2 上随 surefire 腿跑。
- **批 2（43）：** `HostedCleanupRetentionMySqlIT` 19（background-held head 的 cleanup-debt retention）、`WorkspaceRecoveryMySqlIT` 12（恢复 `ready` 臂）、`JdbcRuntimeBrokerMySqlIT` 9（broker 持久化/单拉取者 claim）、`ManagedSchemaMySqlIT` 3（schema 新增）。

这覆盖了故障矩阵的 MySQL 半；daemon 级见证（经真实 daemon、worker、Broker 走完 资格 → 摘除 → 暂存唤醒 → 排空 全循环）仍见下方。

### §7 度量 — worker/applier 半（已落地）

`scripts/measure-background-observation.mjs`（`npm run build` 后运行；约 8 分钟，主要是 10,000 条观测的 drain）逐项打印 JSON 报告。采集 lane 跑在内存资源 store 上以把采集开销与 store I/O 隔离；drain 经真实落盘 session authority 提交。本机数值（Apple Silicon、node 24、loopback）：

- **M1 常驻等价性（§7 项 4）。** 6 MiB stdout：worker lane 129–158 MB/s，49 个 manifest revision / 147 资源 / 12.7 KB 终态 manifest；常驻 Harness lane 455–523 MB/s，2 revision / 11 资源 / 1.3 KB manifest。worker lane 纯采集开销约慢 3.5×，但两者都远快于任何真实管道生产者；代价是换来 128 KiB 输出可见性的逐 revision manifest churn。
- **M2 条目尺寸（§11 Q1/Q3）。** output 条目编码后 178–192 KB（中位 185 KB）；45 条填满 8 MiB outbox。强制停止的 terminal 闭包——被丢 revision 的段/页/manifest 加公告与终态 manifest——实测 **226 KB（5 资源），远低于 512 KiB 请求上限**（约 2.3× 余量）。
- **M3 背压（§7 项 2，worker 半）。** 45 条停驻条目（~8 MiB）时触发；drain 恢复加完整排空仅 **20 ms**、36 次 staging pull。有界且确认后立即释放。
- **M4 applier drain 成本（§7 项 3）。** 经真实 authority 提交观测 revision 加通知 input：**1 条 30 ms、100 条 31 ms/条、10,000 条 48 ms/条**（共 476 s，随 journal 增长而退化）。提交 10,000 条观测的 drain-only wake 约 8 分钟静默加载工作；backstop 的扫描上限为突发节流（§8）。
- **M5 总输出上限（§11 Q3 发现，已证实）。** worker lane 恰好准入 **8 MiB**（64 页 × 1 段 × 128 KiB），随后 `size_limit` break、信封降级为 `unavailable`，最后持久 revision（64）存续。前台 lane 的 512 段页可达 ~32 GiB。

**据此证据定下的常量（无需改动）：** `RUN_OUTBOX_BYTES` 8 MiB（≈最大条目的 45×，terminal 闭包有余量）、`BACKGROUND_SEGMENT_BYTES` 128 KiB 配 `BACKGROUND_SEGMENTS_PER_PAGE` 1（每个条目与最坏 terminal 闭包都合请求上限）、`PARTIAL_FLUSH_MS` 250（空闲 flush 开销相对 30 ms/条的提交成本可忽略）。**8 MiB 总上限不能单方面抬高：** 每页 2 段虽使上限翻倍，却把双流被丢尾闭包推到 ~700 KB、超过请求上限，terminal 将永远推不出去。抬高它需要协同改动 `maxPagesPerStream`/`maxManifestBytes`/请求上限——属 maintainer 设计决策（§11 Q3 携此证据保持开放）。Java 侧 pull 等待、staged-bytes 水位线、硬上限以及 wake→load 延迟，需下方 Broker + MySQL + daemon 度量。

### Daemon 启动见证（已落地）

Phase 3b server jar 在真实 daemon 拓扑里端到端启动。配方（全部来自本 checkout）：

1. **构建 exec jar：** `mvn -Dmaven.repo.local=/tmp/p3b-m2 -pl server -am -DskipTests -Dspotbugs.skip=true -Dcheckstyle.skip=true -Dgpg.skip=true package`（在 `packages/managed-agent-server` 下）→ `server/target/qwen-managed-agent-server-0.1.0-alpha-exec.jar`（spring-boot repackage，mainClass `ManagedAgentServerApplication`，约 88 MB）。
2. **打包 CLI：** `npm run build && npm run bundle` → 根 `dist/cli.js`（daemon 为 harness 与 worker spawn 的 `runtime.cliEntry`）。
3. **Runtime payload：** 一个目录含 `server.jar`（exec jar）+ `manifest.json` `{schemaVersion:1, cliVersion:"0.28.0", target:"darwin-arm64", javaMajor:21, javaSource:"system", serverSha256:<server.jar 的 sha256>}`。`QWEN_MANAGED_LOCAL_RUNTIME_DIR` 指向它即绕过下载（`managed-local-runtime.ts`）；`javaSource:"system"` 用 `JAVA_HOME` 的 Java 21。
4. **启动：** `JAVA_HOME=<jdk-21> QWEN_MANAGED_LOCAL_RUNTIME_DIR=<payload> node dist/cli.js serve --managed --managed-data-dir <data> --port 4199`（不带 `--open` → headless）。

已验证：公共前门 4199 回 200 并提供 WebShell；harness（`serve --profile hosted-harness`，端口 50889）以 bootId/capabilityDigest/lifecycleV2Profiles 应答 `/capabilities`；Java 控制面启动（Flyway 迁移 schema、**Embedded Runtime Broker 监听 50890**、actuator readiness OK）。关闭干净（向 launcher 发 SIGTERM 即停掉 detached 的 harness + java 子进程；端口全释放）。此启动走默认 `managed-local` profile（内嵌 H2、`runtime-observation` 关）。

**启动见证尚未覆盖：** 挂起循环本身。两个发现界定它能在哪里跑：

- **平台门（决定性）。** managed serve 用的 durable local-process provisioner（`QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=true`）是 **Linux-only**——`LocalRuntimeStore` 在非 Linux 抛 "Durable local-process mode requires Linux"，后台 Shell 还额外要求 delegated Linux cgroup v2 root（`RuntimeBrokerServiceTest` 断言此准入拒绝）。因此带真实后台进程的完整 资格 → 摘除 → 暂存唤醒 → 排空 循环**不能在 macOS 跑**；属 CI `hosted-harness-mysql` 车道（Linux）或 Linux 主机。上面的 macOS 启动见证只验证了控制面 + harness + Embedded Broker；真实进程采集/投递机制由 macOS 兼容的 `managed-background-delivery.process.test.ts`（直接 spawn、无 cgroup provisioner）另行覆盖。
- **配置门（已用注入解决）。** `managed-local-serve.ts` 硬编码 `SPRING_APPLICATION_JSON` 并剥离 `SPRING_*`/`QWEN_MANAGED_AGENT_*`，但 **`JAVA_TOOL_OPTIONS` 能穿透**，JVM 将其作为系统属性（优先级高于 application JSON）。故无需改码即可注入：`JAVA_TOOL_OPTIONS="-Dqwen.managed-agent.extensions.enabled=true -Dqwen.managed-agent.runtime-observation.enabled=true -Dqwen.managed-agent.managed-extensions.enabled=true -Dqwen.managed-agent.managed-extensions.cache-directory=<绝对路径> -Dqwen.managed-agent.managed-extensions.cgroup-root=<已委派>"`。各 flag 逐级硬依赖（extensions → managed-extensions → 绝对 cache-directory → cgroup-root），缺一个 Spring 启动即报精确错误。

### Linux 真实 daemon 见证（mingrong，2026-11-22）

在 Linux 主机 `mingrong`（215.192.182.119，uid 63338）上，完整生产拓扑启动并挂起，已端到端验证：

- **构建/部署：** checkout 克隆到 PR head；依赖用 standalone pnpm/npm wrapper + Aliyun npm mirror（系统 corepack 坏）；macOS 构建的 exec jar scp 过去（平台无关）；`npm run bundle` 出 `dist/cli.js`。
- **cgroup 委派：** 顶层 `/sys/fs/cgroup/qwen-bg` 进程迁移失败（与 worker 会话 scope 的共同祖先是 root，非用户可写）。可用 root 在 **user slice 下**：`sudo chown 63338:63338 /sys/fs/cgroup/user.slice/user-63338.slice{,/cgroup.procs,/cgroup.subtree_control}`，再 `mkdir .../user-63338.slice/qwen-bg` + `echo "+cpu +memory +pids" > .../qwen-bg/cgroup.subtree_control`。此后迁入 `qwen-bg/<unit>` 成功（已验证）。`Delegate=yes` 不能经 `systemctl set-property` 运行时设置。
- **启动 + 挂起：** 注入 flag + `QWEN_E2E_IDLE_SUSPEND_MS=3000` + `QWEN_MANAGED_RUNTIME_OBSERVATION=1` 后，daemon 启动（Embedded Broker listening、`Started ManagedAgentServerApplication`），WebShell 创建的 session 跑一个模型 stub turn，harness 日志 `Hosted Session <id> suspended idle.`——**真实 daemon 上见证挂起。**
- **剩余阻塞（精确）：** 后台 Shell 工具被拒 _"Hosted Shell requires a foreground command… Background jobs and Monitor are unavailable"_。已定位：`backgroundShellAdmitted()`（`hosted-workspace-tool-turn.ts`）= `publication !== undefined && childRuns !== undefined && childRunAdmissionsEnabled()`。kind 门通过（`'shell'` 在冻结的 `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 里）。缺口是 `session.publication`，仅当 session 有 hosted-workspace-shell `toolProfile` **且** `captureBytes !== undefined` **且** `!foregroundOnly` 时才接线（`hosted-harness-session.ts` ~7200）。`captureBytes` 来自 `/session` body 或 agent definition（`definition?.['captureBytes']`）；WebShell 创建的 session 两者皆无，故无 publication、故前台拒绝。

  **`captureBytes` 源头（已追到源码）。** `QwenHostedHarnessConnector`（~1990）仅在 `toolPublication.isEnabled()` 且 profile 为 public-shell/team-lead 时 `builder.captureBytes(toolPublication.getExecutionBytes())`。该 flag＝`qwen.managed-agent.tool-publication.enabled`（默认 false）。在 mingrong 实测启用它会让 Spring 启动报 _"Tool publication OSS endpoint is required"_——`toolPublicationOss` bean（`AliyunObjectStoreClient`）对该 flag 无条件创建，且 `object-storage.enabled` 默认随它。故后台 Shell 准入当前**与 OSS publication lane 耦合**：经 WebShell 路径见证真实后台 Shell 需 (a) 配 OSS（`tool-publication.oss-endpoint/oss-region/oss-bucket`+凭证；用户的 `oss` profile STS+disposable bucket 可用），或 (b) 改码把 worker-owned observation 的 `captureBytes` 与 OSS publication bean 解耦。这是「后台进程存活 + staging + drain」见证前的最后开放项；属设计/准入问题（Phase 3b worker-owned observation 是否应依赖 OSS），非本地 env 开关。

  **OSS 尝试（2026-11-22，卡在 V4）。** 在 mingrong 用 `default` profile 的长期 AK 接生产 OSS 路径（`oss`/`oauth-data-govermence` OAuth token 过期且 refresh 400，重新授权未刷新）：建 disposable bucket `p3b-susp-witness-995ae0`（cn-hangzhou），注入 `OSS_ACCESS_KEY_ID/SECRET`（已验证到达 java 进程）+ `tool-publication.enabled/execution-bytes/oss-endpoint=https://oss-cn-hangzhou.aliyuncs.com/oss-region/oss-bucket`。endpoint 必须是固定 regional **HTTPS** URL（`AliyunObjectStoreClient.buildOss` 校验 scheme + `host == "oss-"+region+".aliyuncs.com"`）。启动报 `AccessDenied: The bucket you access does not belong to you`。根因已隔离：SDK 强制 `SignVersion.V4`，该 AK 在 V4 下 cn-hangzhou 与 cn-shanghai **都**报 `Ec=0003-00001403`（"must be addressed using the specified endpoint"，用 ossutil `signatureVersion=v4` 对现有 bucket 也复现），而 V1 访问正常。故 default AK 仅支持 V1；强制 V4 的 publication store 用不了它。完成 (a) 需支持 V4 的 OSS 凭证（正确重授权的 ap-southeast-1 `oss` profile，或其它启用 V4 的 AK）；否则走 (b)（解耦 captureBytes 与 OSS bean）。disposable bucket 为空可删。

  **V4 已解 + 后台 Shell 已准入（2026-11-22）。** `oss` profile OAuth 重授权成功（浏览器回调 127.0.0.1:12345），新鲜 STS **支持 V4**（ap-southeast-1 建桶 p3b-susp-oss-775954 + V4 ls 成功，印证 o4 qualification）。经 JAVA_TOOL_OPTIONS -D 配齐 publication：tool-publication.enabled=true、service-base-url=http://127.0.0.1:<javaPort>（state.json 稳定）、容量取 distribution/kubernetes/qualification/server.example.yaml（execution-bytes 1048576/session-bytes 33554432/tenant-bytes 134217728/active-captures 16/entry-concurrency 8/operation-timeout 10s/claim-timeout 3s/verification-bytes-per-second 1048576/max-verification-timeout 30s）、oss-endpoint=https://oss-ap-southeast-1.aliyuncs.com、oss-region=ap-southeast-1、oss-bucket=p3b-susp-oss-775954；STS 凭证（OSS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN）source 进 boot.sh。daemon 启动，后台 Shell 工具错误**前进**：从 "Background jobs and Monitor are unavailable"（前台拒绝）变为 **"Background Shell requires a delegated Linux cgroup v2 root on this Runtime"**——即 captureBytes/publication 已接通、后台 lane 已准入。

  **cgroup-root 下发已解 + 后台进程已见证（2026-11-22）。** 此前混淆了两道门：(1) binding capability digest 须 == LINUX_CAPABILITY_DIGEST，Java 才下发 extension 配置（LocalProcessRuntimeProvisioner:658）——这**本就生效**（DB ma_runtime_binding.capability_digest = sha256:6210cbb6…，READY）；(2) worker 的 backgroundSupervisor 由**独立 env 变量** QWEN_MANAGED_HOOK_CGROUP_ROOT 构建（managed-context-worker.ts:496-503），**不是** boot.managedExtensions.cgroupRoot。该 env 在 worker 上未设。修法：boot.sh `export QWEN_MANAGED_HOOK_CGROUP_ROOT=/sys/fs/cgroup/user.slice/user-63338.slice/qwen-bg`（穿透 managed-local env 过滤、provisioner 转发）。此后后台 Shell 工具返回 **"Background shell started under unit qwen-bg-…; it keeps running after this result and holds its Runtime until it exits"**（TOOL STATUS completed），后台进程确认**在委派 cgroup 内**（/proc/<pid>/cgroup = …/qwen-bg/qwen-bg-<uuid>）且 **turn 结算 15s 后仍存活**——进程跨 turn 存活并持有 Runtime，即后台隔离核心见证。H2 查询需 MODE=MySQL;DATABASE_TO_LOWER=TRUE + user qwen（空密码）；AUTO_SERVER=TRUE 可在 server 运行时第二连接读（间歇——须 server 已开启）。

  **剩余门（精确）：后台挂起认证。** 持有活跃后台工作的 session 仅在 backgroundCertified 时挂起（hosted-harness-session.ts:5072 以 !backgroundCertified && heldRuntimeTurns.size>0 阻止挂起）。backgroundCertified = stores.supportsRuntimeObservation()===true 且 backgroundSuspensionCertificate(managed, observationBindings)（hosted-turn-cleanup.ts:307）：证书需非空 observationBindings（来自 session.shell/backgroundLane.observationBindings）、每个活跃 shell child_run 记录 state running/waiting 且 execution==='running_attached'、runtime binding 在 observationBindings 中、有 startReceiptRef、≥1 held run、无欠 cleanup debt 缺后台持有证据。已见证 session（85725706）保持 ACTIVE——其后台挂起证书未过（observation-binding 注册 / running_attached 记录态待核）。认证通过后 session 即在后台运行时挂起、输出暂存 ma_runtime_stage、drain-only wake 无模型 turn 结算。

  **证书输入追到 worker observation env。** observation-binding 注册需 workerOwnsObservation=broker.observationOwned（hosted-workspace-tool-turn.ts:5818/6345），observationOwned=(:publisher 响应).observation===true（hosted-workspace-broker.ts:492）。Java 从 **worker** 响应转发 observation 字段（RuntimeObservationCoordinator:218），worker 仅在 process.env.QWEN*MANAGED_RUNTIME_OBSERVATION==='1' 时启用 ManagedShellPublisherRegistry（managed-runtime-attestation-worker.ts:662）。故 QWEN_MANAGED_RUNTIME_OBSERVATION=1 须到达 **worker** 进程。provisioner 继承 java env 减去 CONTROL_PLANE_ENV_PREFIXES（QWEN_MANAGED_AGENT*/QWEN*MANAGEDAGENT*/QWEN*MANAGED_RUNTIME_BROKER*/SPRING*/OSS*，LocalProcessRuntimeProvisioner:75/712）——QWEN_MANAGED_RUNTIME_OBSERVATION **不在**该列表，故由含该 env 的 java 进程 spawn 的 worker 会继承。实测阻塞：stale/重复 java server（一个含 env 一个不含）spawn 出 OBS=0 worker；boot.sh 导出该变量但 node launcher env 跨重启间歇缺失（CLI 启动 env scrub/re-exec 竞争）。前置＝干净单 daemon 重启并核实 java **与** worker 都有该 env；之后证书应过。STS ~3h 过期，续作前刷新 oss profile。

  **新会话收尾清单（mingrong，~/p3b-suspension/）。** 环境已就位：boot.sh（完整 -D publication 配置 + export QWEN_MANAGED_RUNTIME_OBSERVATION=1 + export QWEN_MANAGED_HOOK_CGROUP_ROOT=…/user-63338.slice/qwen-bg + source oss-creds.env）、model-stub.mjs（后台命令 for i in $(seq 1 300); do echo line $i; sleep 1; done，端口 41990）、drive2.mjs/witness3.sh（WebShell 建 session+轮询）、thorough.sh（杀全部 p3b java/node/worker 再起一个）。桶 p3b-susp-oss-775954（ap-southeast-1）。步骤：(1) STS 过期则刷新 oss profile OAuth（aliyun configure --profile oss --mode OAuth，浏览器回调），从 ~/.aliyun/config.json oss profile 重生 oss-creds.env（OSS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN）scp 到 mingrong；(2) bash thorough.sh，等 ~50s，断言**恰一个** p3b java 含 QWEN_MANAGED_RUNTIME_OBSERVATION=1 **且** spawn 的 worker 也含（失败模式＝重复 java 一个不含 env）；(3) bash witness3.sh——预期 TOOL STATUS completed、后台 pid cgroup …/qwen-bg/qwen-bg-<uuid>、随后 session head 翻为挂起/recovery-ready 而后台 pid 仍活、ma_runtime_stage 行累积、drain-only wake 无模型 turn 结算。H2 读：jdbc:h2:file:…/data/database/managed;MODE=MySQL;DATABASE_TO_LOWER=TRUE;AUTO_SERVER=TRUE，user qwen 空密码。若干净单重启后 node launcher 仍丢 env，查 CLI 启动 re-exec env 路径（loader scrub **不**剔 QWEN_MANAGED_RUNTIME_OBSERVATION）。

  **收尾验证执行（2026-11-22，新会话）：清单步骤 1–2 通过；certificate-env 假设被更上游的 commit 门缺陷取代（已修复）；首次见证持后台工作的挂起；staging/drain 被下一缺口（observation 注册）阻塞。**
  - **步骤 1–2 已验证。** `oss` profile STS 仍有效（无需重授权；重生的 `oss-creds.env` 与已部署文件哈希一致）。`thorough.sh` 加基于 comm 的进程普查（`pgrep -x java` / `pgrep -x node` 配 cmdline 过滤——`pgrep -f` 会自匹配包裹 shell）确认恰一个 p3b java 含 `QWEN_MANAGED_RUNTIME_OBSERVATION=1`，spawn 的 worker 也含。env 竞争假设关闭：干净单 daemon 重启可靠送达 env。
  - **真实阻塞在证书上游：journal commit 门拒绝运行中 capture 的已发布 manifest。** env 验证后 turn 仍不结算。回环 java 端口 tcpdump 抓到 `commitChildRunRecord`（rev 20→21）409 `managed_session_resource_missing`：事务引用后台 capture 的 `managed-tool-result-manifest`/`-page` 行，publication lane 让其保持 **PUBLISHED**（`ToolPublicationAdmissionStore` 仅在 `capture_state='VERIFIED'` 时提升 PUBLISHED→REFERENCED——进程运行中不可能）。`JournalStoreRows.storedResource` 只接受 REFERENCED 或 settled-published **配置类** kind，而 reader（`JournalResourceReads`，无 state 门）与 verifier（`verifyStoredResource` 的 OSS_OBJECT/MYSQL_INLINE 分支）都接受 PUBLISHED tool-result kind。child_run 记录因此永远提交不上 → 无 `running_attached` 记录 → 证书永不可能过 → 不挂起、不 stage、不 drain；卡死的 turn 还在 ~40s 带走 worker（及后台）。此前每次后台运行（12393117、af6272dc、85725706）都被同一 409 静默阻塞。
  - **修复（已落本分支）。** `storedResource` 增接受 `publishedToolResult`（PUBLISHED + `toolResultLimit(kind) > 0`），与 reader/verifier 对齐；TOOL_PUBLICATION outcome 信封仍 fail-closed（其 kind limit 为 0，且 verifier 仍要求 REFERENCED + capture 目录匹配）。回归：`JournalStoreRowsPublishedResourceTest`（3 例：PUBLISHED manifest/page 如 reader 般被接受；PUBLISHED outcome 仍 409；object key 为 null 的 PUBLISHED manifest 仍 500）——无修复时红、有修复时绿已验证；`ManagedSessionStoreIntegrationTest` 16/16 不变；CI 同款双 execution Checkstyle 干净。exec jar 重建（`serverSha256 808ccd4c39eec827…`）并部署 mingrong。
  - **持后台工作的挂起已见证（session `ceca1278-b2d1-4a0a-92fa-fca789f01fee`）。** TOOL STATUS completed；后台 pid 在 `…/qwen-bg/qwen-bg-f093c8b7-…` 内；worker OBS=1；model stub 恰服务 2 个请求（turn 结算）；harness 记录 `Hosted Session ceca1278… suspended idle.`；head 达 SEALED/READY 时后台仍活——真实 daemon 上首次有持活跃后台工作的 session 挂起。
  - **下一缺口（精确）：harness 对 worker-owned 后台盲挂起。** seal 携带 `wake_seal_background=0`、`wake_retry_at=0`——未盖后台持有戳。writer lease 失效（seal 后 ~60s），runtime 被回收，后台 ~70s 死亡（命令要求 300s）；`ma_runtime_stage` 恒 0，无 drain wake。代码路径：`backgroundSuspensionCertificate` 在 `observationBindings` 为空时返回 false，而 harness session 的 `shell/backgroundLane.observationBindings` 为空——逐 binding 的 worker observation 注册从未到达 harness session，故无可见持有工作，挂起按普通 idle seal 进行（`backgroundCertified` false、`suspensionLiveWork` false）。切片 4 剩余工作即此注册/交接链（worker attestation → broker binding observation 能力 → harness lane `observationBindings`）；落地后 seal 盖 `backgroundHeld`、摘除后 capture 存活、输出暂存、drain-only wake 结算。model-stub 请求日志（2 请求，回收全程不变）是「drain 无模型 turn」的常设 oracle。
  - **健壮性发现（worker-loss 族）：kill -9 重启搁浅 ACTIVE turn。** 硬重启后在途 turn 的 recovery 永久 deferred（`Original Harness attachment is unavailable`——重启的 harness 无 attachment），`requireRecoverablePlacement` 拒绝同 workspace 全部新 session（`runtime_placement_recovery_required`）。fixture 需全清 `ma_*` 才能继续（boot 以固定 idempotency key 确定性重建 workspace）。归入剩余「worker loss / Broker 重启围栏」fault case。
  - **fixture 机制修正。** server 开 H2 不带 `AUTO_SERVER`，运行中第二连接读失败；改读 `managed.mv.db` 的**副本**（MVStore 快照副本可正常打开）。身份列为 `VARBINARY(2048)`：字符串字面量需 `CAST('…' AS BINARY(2048))`（裸 `=` 报 90110）。`witness4.sh`（timeline：后台存活/stub 请求数/staged 数/head 态）取代 `witness3.sh` 跑全周期。

完整 E2E harness（仿 `HostedHarnessMySqlIT` + `managed-local-serve.ts` 的新 MySQL IT，或上述脚本化真实 daemon 驱动）必须在 Linux 跑；publication 准入已接通、commit 门已修复——开放项是上述 observation 注册 → 后台感知 seal 链。

### 剩余故障用例

- **带在途 pull 的 re-attach/drain、挂起期间首条观测、detach→seal 窗口、挂起期间 monitor 策略停止、边界/水位线 wake、挂起资格矩阵、worker 丢失、跨 Broker 重启/副本围栏、删除挂起 Session** — Java 侧已由 H2 上的 `RuntimeStageStoreTest`、`RuntimeObservationPullerTest`、`WakeSealStampTest`、`SessionRecoveryServiceTest`、`HostedCleanupDebtStoreTest`、`RuntimeBrokerServiceTest` 覆盖，并已在真实 MySQL 8.4 上见证（见上）；各自仍需 daemon 级 E2E。
- **daemon 级挂起 E2E** — 经真实 daemon、worker 与 Broker 走完 资格 → 摘除 → 暂存唤醒 → 排空 循环（切片 3 投产门）。Linux 上 daemon 已带 flag 启动，WebShell session 已准入后台 Shell 进委派 cgroup，且**持活跃后台工作的挂起已见证**（见上收尾验证执行；阻塞 `running_attached` child_run 记录的 commit 门缺陷已修复）。开放项是 observation 注册 → 后台感知 seal 链：harness 目前对 worker-owned 后台盲挂起（`observationBindings` 空 → 无 `backgroundHeld` 戳 → lease 失效回收 runtime），故 staging + drain-only 结算断言尚不可捕获。Linux-only（durable local-process provisioner），故 CI hosted 车道或 Linux 主机。
- **§7 度量 — Broker/daemon 半** — pull 成本/延迟（每 Broker 的 long-poll 连接数、每次空闲 pull 的 CPU、观测→wake→turn-start 与退出→结算时延）、挂起期间活跃输出下的 staging 行数/字节、静默加载的 drain 突发；这些确定 pull 等待（`pullWaitMs`，现 2,000）、staged-bytes 水位线（4 MiB）与硬上限（16 MiB）（§11 开放问题 1）。worker/applier 半已如上落地。

## 验证命令

```bash
npm run build && npm run typecheck
cd packages/cli && npx vitest run src/serve/managed-background-delivery.test.ts
cd packages/cli && npx vitest run src/serve/hosted-shell-publisher.background.test.ts
cd packages/core && npx vitest run src/managed-runtime/local-shell-stream-capture.test.ts
# Java（managed-agent-server）：遵循 packages/managed-agent-server/AGENTS.md 的 Maven 验证。
```

## 注意 / 陷阱

- 即便 worker 模式，applier 仍要求经 `HostedShellPublisher.register()` 注册采集（prepare RPC 被跳过，但 `applyDelivery` 查找已注册采集）。生产在 `hosted-workspace-tool-turn.ts` 的后台准入处注册。
- 测试资源 store 必须将字节落到 session 资源根布局（`<runtimeBaseDir>/resources/<sessionId>/<kind>/<resourceId>`）并经 `session.resources` 读取，否则 authority 的 `verifyExtensionResources` 拒绝记录 ref。
- `LocalManagedSessionResourceStore.publish` 总是生成 UUID； honoring 客户端选定 ID 的 `DurableToolResultResourceStore` 须直接写该布局（见测试 double）。
- 疑似潜在环（既有、本切片未复现也未修）：若 Monitor 的**尾**窗口恰是跨过 `maxEvents` 的那个，`flushTail → flush → autoStop → terminate` 会等待 registry completion，而后者正在等 `flushTail`（`registry.terminate` 返回 `entry.completion`）。正常 quota 路径从窗口 flush 触发、尾窗口为空，不触环。修复前需先单独复现。
- 本仓库不要对活跃 PR rebase/force-push；改为 merge `origin/main`。
