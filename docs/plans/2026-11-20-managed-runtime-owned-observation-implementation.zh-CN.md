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

1. **将 Monitor 策略接入 worker monitor 路径。** `WorkerMonitorPolicy` 已存在但尚未挂载。capability 开启时，executor 的 monitor start（`managed-runtime-tool-executor.ts`，monitor lane ~1713）与 `ManagedMonitorWatcher` 须在 watcher 旁构造 policy，从已提交的 `monitor_run.observationSequence` 水位传入 `startSequence`，并将 stdout chunk 路由到 `policy.onChunk`。Harness `HostedMonitorLoop` 在 capability 模式下变为观测条目的纯 applier（其定时器/Broker stop 往返消失）。terminal 条目的 `monitorStopReason` 须反映 policy 的 quota/idle/自然原因。
2. **advertise capability 并在生产启用 registry。** 将 `runtime-observation/1` 加入 worker capabilities（attestation 契约 `managed-runtime-attestation-contract.ts` + Java `ManagedContextProtocol`/`RuntimeAttestation` capability 集），并在 `managed-context-worker.ts` 以 `{ enabled: <capability>, workspaceId: boot.workspaceId }` 构造 `ManagedShellPublisherRegistry`。按设计 §4.11 门控：worker 自持采集仅由 worker capability 门控，而非 server setting。
3. **characterization 测试。** 证明 worker 自持采集发布的段/页/manifest 对象与 Harness 采集逐字节等价（段大小与页容量除外），且最终 Artifact 相同（设计 §10「Capture equivalence」）。新增 Harness 重启测试：连续后台输出、kill+reload Harness、单一采集、无 `producer_lost`、每字节恰好一次、manifest 链有效。

## 切片 2 — Broker staging（未动）

设计 §4.5–§4.7。已映射的触点：

- **Schema**：在 `persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql` 新增按 `(execution_call_id, delivery_seq)` 键控的 `ma_runtime_stage`；在 `contracts/.../schema/ManagedSchemaContract.TABLES` 注册；更新 `verification/.../managedschema/ManagedSchemaTest`（BUSINESS_KEYS / 实体排除集）。行携带 kind、binding+generation、条目元数据、wake-worthy 标志。
- **资源 owner kind**：新增 `RUNTIME_STAGE` ref owner kind；staging 在其下写 `REFERENCED` 资源，段字节用 `PUBLISHED` 形态（`persistence/.../JournalResourceWrites.java:117,159`）。stage ref 随条目携带；仅在该条目的 journal commit 后删除。
- **Transport**：在 `RuntimeTransport`/`HttpRuntimeTransport` 上新增 `observation-pull` 操作（lease 围栏、long poll、`ackThrough`），路由进 `ManagedContextProtocol`；attached 时 worker 回 `attached` 无条目。每 binding 单拉取者 claim（复用 Broker operation-claim 形态）；worker 每 run 仅保留最新 long poll。
- **Staging 事务**：单事务写自带资源 + 每条目一行 `ma_runtime_stage` +（wake-worthy 条目）将 `wake_retry_at` 拉到 now 并置 `is_wake_pending=1` + 用 terminal 证据结算 `ma_tool_execution` 行（`RuntimeExecutionRecovery.settleUnprovenBackgroundRows` 规则）。仅在 commit 后确认。
- **manifest 闭包遍历（TS）**：已落地 — `http-managed-session-store.ts` 的 `isReferenceContainer` 现已包含 `managed-tool-result-manifest`，使 drain 的 Harness 提交 manifest 时其页的嵌套 `JOURNAL` ref 由服务端收集（无内存 staged 集）。ref-collector 的 manifest→页分支早已存在；246 个 store 测试全绿。
- **wake hint 围栏**：seal（`JournalWriterLifecycle.java:421`）写 `is_wake_pending = journalPending OR EXISTS(未提交 wake-worthy staged 行)`，存在该行时保持 `wake_retry_at ≤ now`；backstop `recordPending(candidate,false)`（`JdbcWakeRecoveryStore.java:314`）仅在无 wake-worthy staged 行时清除。staged 候选跳过 journal proof，经被动 `recoverForWake` 加载。
- **re-attach-then-drain（TS）**：加载时先注册 publisher；worker 每 run 报 `stagedThrough`；Harness 按序 drain staged 条目后从 `stagedThrough+1` 接受推送；确认删除至 applied 点的行。publisher/detach/drain/cancel 路由的持久化 adoption（像 `reclaimParkedMcp` 一样从持久记录 adopt，`RuntimeBrokerService.java:554`）， survives Broker 重启/副本。

## 切片 3 — 后台挂起（未动）

设计 §4.8–§4.11。已映射的触点：

- **资格**：逐 run 经 `hasBackgroundHoldEvidence`（`hosted-turn-cleanup.ts:242`）豁免 `suspensionLiveWork` 的后台项（`hosted-harness-session.ts:5059,5063,5075-5088`）；准入时（绝不在 teardown）要求 binding worker advertise `runtime-observation/1`。其余仍阻塞。
- **seal 证书**：挂起 seal 的 `wake` 增加 `backgroundHeld:true`；新 head 列 `wake_seal_background` 在 writer 围栏/revision 检查下写入；任何 writer acquisition 清除。恢复 `ready` 臂仅在 `wake_seal_revision = journal_revision AND wake_seal_background` 时接受未结算 `runtime_state`/`HOSTED_CLEANUP`。`HostedCleanupRetryCoordinator.java:128` 跳过此类 head 的 debt。
- **probe-only release**：两条挂起 drain 路径（`hosted-harness-session.ts:5170,5172`）跑 probe-only；`held` 仅在确认为当前 binding+generation 的后台执行时计为成功；前台 debt 仍失败。后台-only hold 保留 mount（`RuntimeExecutionRecovery.java:370-394` 容忍）。
- **带最终确认的 detach**：publisher 步骤等待在途推送，经 Broker detach 并携带最终 `appliedThrough`；Broker 在同一事务删除至该点的 staged 行；worker 转 held。
- **reclamation 守卫**：`reclaimParkedMcp` 在 `transport.reclaimMcp` 前检查活跃后台执行，拒绝且不关闭连接（`RuntimeBrokerService.java:587`）；移除附带的结算 sweep。
- **drain-only 退出 wake**：terminal 条目标记 wake；加载 drain staging 并结算 run，不提交任何 input（无模型 turn）；若无其他 pending 则重新 seal/挂起。
- **delete 清理**：delete/retirement 移除 `ma_runtime_stage` 行 + `RUNTIME_STAGE` ref（`ManagedSessionRetirementStore`）。
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
