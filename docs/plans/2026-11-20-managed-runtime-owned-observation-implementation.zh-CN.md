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

## 切片 3 — 后台挂起（未动）

设计 §4.8–§4.11。已映射的触点：

- **资格**：逐 run 经 `hasBackgroundHoldEvidence`（`hosted-turn-cleanup.ts:242`）豁免 `suspensionLiveWork` 的后台项（`hosted-harness-session.ts:5059,5063,5075-5088`）；准入时（绝不在 teardown）要求 binding worker advertise `runtime-observation/1`。其余仍阻塞。
- **seal 证书**：挂起 seal 的 `wake` 增加 `backgroundHeld:true`；新 head 列 `wake_seal_background` 在 writer 围栏/revision 检查下写入；任何 writer acquisition 清除。恢复 `ready` 臂仅在 `wake_seal_revision = journal_revision AND wake_seal_background` 时接受未结算 `runtime_state`/`HOSTED_CLEANUP`。`HostedCleanupRetryCoordinator.java:128` 跳过此类 head 的 debt。
- **probe-only release**：两条挂起 drain 路径（`hosted-harness-session.ts:5170,5172`）跑 probe-only；`held` 仅在确认为当前 binding+generation 的后台执行时计为成功；前台 debt 仍失败。后台-only hold 保留 mount（`RuntimeExecutionRecovery.java:370-394` 容忍）。
- **带最终确认的 detach**：publisher 步骤等待在途推送，经 Broker detach 并携带最终 `appliedThrough`；Broker 在同一事务删除至该点的 staged 行；worker 转 held。
- **reclamation 守卫**：`reclaimParkedMcp` 在 `transport.reclaimMcp` 前检查活跃后台执行，拒绝且不关闭连接（`RuntimeBrokerService.java:587`）；移除附带的结算 sweep。
- **drain-only 退出 wake**：terminal 条目标记 wake；加载 drain staging 并结算 run，不提交任何 input（无模型 turn）；若无其他 pending 则重新 seal/挂起。
- **delete 清理**：已在切片 2 落地（提交 `84ab21559a`）；切片 3 按需衔接挂起态摘除/回收路径。
- **发布门**：setting `qwen.managed-agent.runtime-observation.enabled`（默认关）在 writer grant 中 beside `wakeDispatch` advertise 为 `runtimeObservation`；worker capability；逐 run 证据。一旦挂起，pull 不论 setting 均运行。

## 切片 4 — 验收与度量（未动）

设计 §7、§10。真实进程 + MySQL 8.4 故障矩阵（仅 H2 不算验收）：采集等价、Harness 重启、幂等投递、带在途 pull 的 re-attach/drain、挂起期间首条观测（transport 关、空 journal）、detach→seal 窗口、挂起期间 monitor 策略 stop、安静退出在一个 pull 间隔 + 一次 silent load 内结算、背压下强制 stop、边界/watermark wake、挂起资格矩阵、reclamation 拒绝、挂起期间 worker 丢失、跨 Broker 重启/副本的围栏、删除挂起 Session。度量确定 pull wait、staged-bytes watermark、hard cap、outbox 预算（设计 §11 开放问题）。

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
- 本仓库不要对活跃 PR rebase/force-push；改为 merge `origin/main`。
