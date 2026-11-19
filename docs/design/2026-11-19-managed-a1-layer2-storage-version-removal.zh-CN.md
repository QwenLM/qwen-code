# Managed Agent A1 Layer 2 — 删除 Session storage_version 列

[English](2026-11-19-managed-a1-layer2-storage-version-removal.md) | [简体中文](2026-11-19-managed-a1-layer2-storage-version-removal.zh-CN.md)

状态：proposed；持久信号决策已锁定（head 布尔列）。本设计是
[版本收敛设计](2026-11-19-managed-agent-version-convergence.md) 的 A1 Layer 2
follow-up。A1 阶段1 已剥离滚动升级协商（reader 天花板、writer-grant
`supportedStorageVersion`）；`storage_version` 列本身因仍表达活不变量而保留。本设计
删除该列，并用非版本号重新表达这些不变量。服务未投产，故无既有部署数据需要迁移，
worker 与 server 作为一个单元部署。

## 已解决的开放问题 —— activity 持久信号

收敛设计留了一个开放问题：restore 清掉 activity 投影后，靠什么持久信号告诉 server
「这个 Session 有 activity 诊断，需要重建投影、并按其 readiness 门控 writer 准入」？
今天这个信号是 `head.storageVersion() >= 4`。

**决策：head 布尔列 `has_activity_diagnostics`。** 在首次内容携带 activity 诊断的提交
（activity 证据资源，或 `tool.measured` 事件——恰是今天把 floor 提升到 `>= 4` 的条件）
置位。它位于 `ma_session_head` 行上，该行在投影清除中存活，故 restore 后仍是持久标记。

理由：

- head 行在所有读取 `storageVersion()` 处本就已加载，故门与重建跳过变为 O(1) 字段
  检查，无额外查询。
- 删列本就要原地编辑 V1 基线及其 `ck_ma_head_journal` CHECK；加布尔列是同等的 schema
  编辑成本。
- 被否的替代方案——对 `ma_resource kind = 'managed-execution-diagnostics'` 的有界
  `EXISTS` 探测——同样持久（证据资源 journal 拥有、清除不删），但 `ma_resource` 无
  `(session_scope_key, kind)` 索引，探测会扫 Session 资源或需另建索引，且每次提交与
  writer 获取都多一次查询。

该标记单调：一旦置位永不清除（activity 证据不会被反提交），与旧 `Math.max` 提升语义一致。

## 现状（已核实）

`storage_version` / `storageVersion()` 有五类活消费方。行号为撰写时当前值；编辑前重 grep。

1. **activity 重建门 / 跳过（不变量）。** `JournalCommit:105`
   （`head.storageVersion() >= 4` → 要求 activity summary `ready`，否则
   `managed_activity_rebuilding`）；`ManagedActivityDiagnosticProjection.rebuildBatch:362,364`
   （`storageVersion < 4` → 跳过）；`JournalWriterLifecycle:259,277` 把
   `head.storageVersion()` 传入 `rebuildActivityBatch`。重建重放持久 journal
   （`ma_session_journal_tx`）；清除只删 `managed-activity-projection` 资源及其
   `DOMAIN` 记录，从不删 journal 或 journal 拥有的 `managed-execution-diagnostics` 证据。
2. **head 记录与读写。** `JournalStoreRows.HeadRow` mapper（`:46`）、
   `RestoreHead`（`ManagedSessionStoreModels:289`、`JournalStoreRows:142,723`）；
   `session.create` / harness 转换的 INSERT/UPDATE
   （`JournalWriterLifecycle:203,218`，初值 `JournalStoreRows.STORAGE_VERSION`）；
   提交 UPDATE 提升 `Math.max(head.storageVersion(), storageFloor)`
   （`JournalCommit:266,282`）。`ManagedModelDiagnosticProjection.storageFloor():42`
   恰有一个活调用方（`JournalCommit:82`），且只喂这个提升。
3. **快照 manifest 绑定。** `ManagedNativeJournalSnapshots.Manifest` 携带
   `int storageVersion`（`:77`），由 `head.storageVersion()` 构建（`:188`）；
   `select` 要求 `descriptor.snapshot().storageVersion() <= frozen.storageVersion()`
   （`:253`）。TS worker 解析 manifest `storageVersion`
   （`http-managed-session-store.ts:1833-1845`）并拒绝 `storageVersion > head.storageVersion`。
4. **TS 功能存在性完整性检查。** worker 在三处按版本判定功能存在性：快照检查
   （`http-managed-session-store.ts:651-690`）、restore（`:1603-1615`）、快照 descriptor
   检查（`:1958-1968`）；加 head 类型/解析（`:1019,3860`）与
   `workspace-recovery-session.ts:121,361,414,1097`（`[1,2,3,4,5]` 枚举与 `>= 5` 测量检查）。
   `:679-690` 块还检查 `csi-files-retirement/1|2|3` profile floor——这是 CSI 残留
   （#17415 归档后 server 已不再准入 CSI Session），引用了版本号，在此一并删除。
5. **pristine-initial 谓词。** `JournalHistoryQueries.hasPristineInitialJournal:268`
   用 `head.storageVersion() != STORAGE_VERSION` 作为证明「未触动的初始 journal」的
   谓词之一（recovery 快路径，`SessionRecoveryService:123`）。

只读 SELECT 投影也把该列带到 schema/head 视图：
`ToolPublicationAdmissionStore:145`、`ManagedSideQueryStore:568`、
`ToolPublicationStore:227`、`ManagedSchemaProjection:144`、`WorkspaceRecoveryStore:621`。

**保留不动。** `JournalStoreRows.STORAGE_VERSION = 1`（`:92`）还兼任 pack/event 格式
完整性常量（`JournalHistoryQueries:311,332`：`formatVersion == 1`、事件 `"v" == 1`）——
单版本完整性门（C 类），非兼容产物。`/transactions:commit` 与 `/transactions:commit-v2`
是同一 handler 的别名（`ManagedSessionStoreController:202`）；路由按事务由
`ManagedHostedRecoveryRecords.requiresVersionTwo`（`:30`）决定，与 head 版本无关，
故删列不影响它。

## 目标

- 删除 `ma_session_head.storage_version` 列及所有活 `storageVersion` 字段/参数，
  用非版本号重新表达五类消费方。
- 原样保留 activity 重建不变量：有 activity 诊断的 Session 仍按 summary readiness
  门控 writer 准入，仍在清除后从 journal 重建投影。
- 用资源存在性（而非版本 floor）保留快照/restore 功能完整性。

## 非目标

- 删除 pack/event `formatVersion == 1` / 事件 `"v" == 1` 完整性门（C 类）或命名它们的
  `STORAGE_VERSION` 常量。
- 改动 `commit-v2` 路由（按内容，不受影响）。
- 删除 worker 侧 CSI session 代码中除按版本的 profile-floor 检查之外的部分；那是独立的
  CSI TypeScript 清理。
- 任何 V2+ 迁移。V1 基线原地编辑（模块 AGENTS.md）。

## 方案

### Schema（原地 V1）

- 从 `ma_session_head` 删除 `storage_version`（`V1__managed_schema.sql:188`）。
- 增加 `has_activity_diagnostics TINYINT UNSIGNED NOT NULL DEFAULT 0`
  （`is_wake_pending` 布尔约定）。`NOT NULL DEFAULT 0` 使其不参与 head-kind CHECK：
  HARNESS 头恒 `0`（无意义、从不被门控）；MANAGED_SESSION 头初 `0`，首次 activity 提交翻 `1`。
- 编辑 `ck_ma_head_journal`（`:220`）去掉 `storage_version IS NULL` / `IS NOT NULL`
  子句；其余 journal 列仍与 head kind 绑定。

### Java

- `HeadRow` / `RestoreHead`：把 `int storageVersion` 换为 `boolean activityDiagnostics`；
  更新 mapper（`JournalStoreRows:46`）、restore 映射（`:142`）与 record
  （`:723`、`ManagedSessionStoreModels:289`）。
- head INSERT/UPDATE（`JournalWriterLifecycle:203,218`）：写 `has_activity_diagnostics = 0`
  替代 `storage_version`。提交 UPDATE（`JournalCommit:266,282`）：
  `has_activity_diagnostics = has_activity_diagnostics OR ?`，参数为该提交的 activity
  探测（见下）；去掉 `Math.max` 提升。
- 把 `ManagedModelDiagnosticProjection.storageFloor()` 替换为布尔 activity 探测器
  `hasActivityDiagnostics(records, requested, validated)`，返回 `activity || measured`
  （`>= 4` 条件）。`promotes → 2` 与 `diagnostics → 3` 档位变死代码并删除；路由仍直接用
  `requiresVersionTwo`。
- 门（`JournalCommit:105`）：`if (head.activityDiagnostics())`。
- `rebuildBatch` / `rebuildActivityBatch`：以布尔替代 `storageVersion`；false 时跳过。
  `JournalWriterLifecycle:259,277` 传 `head.activityDiagnostics()`。
- SELECT 投影（`ToolPublicationAdmissionStore:145`、`ManagedSideQueryStore:568`、
  `ToolPublicationStore:227`、`ManagedSchemaProjection:144`、`WorkspaceRecoveryStore:621`）：
  从 SELECT 列与携带它的 row/view 映射中删除该列。
- `hasPristineInitialJournal`（`JournalHistoryQueries:268`）：去掉版本谓词。journal 内容
  检查已拒绝 `session.create` 之后任何非 `activation.changed` 事件，故功能提交不可能作为
  pristine 通过；版本检查冗余。对 recovery 快路径测试核实。
- 快照 `Manifest`：删 `storageVersion`（`:77,188`）；`select`（`:253`）去掉
  `storageVersion <= frozen.storageVersion()` 子句。快照是 frozen head journal 的前缀
  （`coveredJournalRevision`、`committedSequence <= frozen`、资源枚举检查），故其特征资源
  必然存在于 frozen head；版本 floor 被这些前缀/资源完整性检查涵盖。

### TypeScript worker

- head 类型/解析（`http-managed-session-store.ts:1019,3860`、
  `workspace-recovery-session.ts:121`）：删 `storageVersion`。
- 功能存在性检查（`:651-690`、`:1603-1615`、`:1958-1968`）：删除版本 floor
  （`< 5` / `< 4` / `< 3`）与按精确版本的 CSI profile-floor 块（`:679-690`）。保留资源
  存在性完整性检查（枚举某资源的快照必须携带它；引用 revision 必须一致）；pre-production
  server 恒支持所有功能，故标记消失后版本 floor 方向无意义。
- manifest 解析（`:1833-1845`）：删 `storageVersion` 与 `storageVersion > head.storageVersion` 拒绝。
- `workspace-recovery-session.ts:361,414,1097`：删 `[1,2,3,4,5]` 枚举与 `>= 5` 测量门；
  按资源存在性判定。

### 测试

- 更新 seed/断言 `storageVersion` 的 Java 测试（head fixture、快照 manifest、
  `ManagedActivityDiagnosticsTest` floor 断言、`ManagedSideQueryStoreTest` version-999
  用例、pristine-journal 测试）到布尔信号与存在性检查。
- 更新设置 `head.storageVersion` / `headOverrides['storageVersion']` 的 TS 测试
  （`http-managed-session-store.test.ts`、`workspace-recovery-session.test.ts`、
  `workspace-recovery-worker.test.ts`、`original-receipt-checkpoint.test.ts`）。

## 设计决策与理由

- **head 布尔列优于 EXISTS 探测。** 从已加载行 O(1) 读、无每次提交查询、无需新索引；
  schema 编辑本就必需。
- **`storageFloor()` 塌缩为布尔。** 其唯一活消费方是版本提升；协商消失后低档位别无消费。
- **快照版本 floor 冗余。** 前缀 + 资源枚举完整性已保证快照特征存在于 frozen head。
- **pristine 谓词版本检查冗余。** 内容检查已排除功能提交。
- **线格式破坏在 pre-production 可接受。** manifest 少一个字段；worker 与 server 作为一个
  单元部署，无既有部署数据需迁移。

## 约束

- 模块 AGENTS.md：原地编辑 V1 基线；禁止 V2+ 迁移。
- Java + TS 线变更（head 视图、manifest）同步落地。
- 保留租户隔离、writer-lease/generation 围栏、双 SQL fencer 参数化。
- 保留 pack/event `formatVersion == 1` 与事件 `"v" == 1` 完整性门。
- 文档保持两个语言版本完整且同步。

## 风险

- activity 标记必须在首次 activity 提交置位并在 restore 后存活；漏置会静默禁用重建门。
  activity 诊断测试（门拒绝 + 重建至 ready）钉住这一点。
- 功能存在性重新表达不得丢掉真正的完整性检查；快照/restore corrupt 测试是护栏。
- manifest 格式变更破坏既有快照的 decode；pre-production 可接受，但测试须新建快照。
- 许多测试 fixture seed `storageVersion`；漏改表现为编译或解析失败，被聚焦套件与
  typecheck 捕获。

## 验证计划

按模块 AGENTS.md，在共享 10 分钟预算内跑 focused 回归（JDK 21、Maven
`~/apache-maven-3.9.12`、隔离仓库 `/tmp/verconv-m2`、`-pl verification -am`、
`env -u QWEN_RUNTIME_DIR -u QWEN_CODE_MANAGED_NPM_PIN -u QWEN_CODE_NO_RELAUNCH`）；
完整门（Checkstyle、SpotBugs、MySQL、全套件）留 CI。

- Java：`ManagedSessionStoreIntegrationTest`、`ManagedActivityDiagnosticsTest`、
  `ManagedSessionStoreWiringTest`、`ManagedSideQueryStoreTest`、`ManagedActionsTest`、
  native snapshot 测试，以及 pristine-journal / recovery 快路径测试。
- TS：`http-managed-session-store.test.ts`、`workspace-recovery-session.test.ts`、
  `workspace-recovery-worker.test.ts`、`local-managed-journal-snapshot` 测试（本地 `/2`
  方言保持绿）；`packages/core` 与 `packages/cli` 的 `tsc --noEmit` / build
  （CLI 用 `NODE_OPTIONS=--max-old-space-size=8192`）。
- MySQL 集成：`ManagedSessionStoreIntegrationTest`、`ManagedSchemaMySqlIT`（head 列）、快照 IT。

## 验收标准

- `ma_session_head.storage_version` 已删；无活 `storageVersion` 字段/参数残留
  （`STORAGE_VERSION` 格式常量保留）。
- 有 activity 诊断的 Session 仍在投影重建期间拒绝 writer 准入，仍在清除后从 journal
  重建至 `ready`；无 activity 诊断的 Session 不受影响。
- 快照/restore 功能完整性由资源存在性保留。
- focused Java + TS 套件绿；core/cli typecheck/build 净。

## 分阶段

1. L2-1：schema + Java（head、门、重建、投影、快照、pristine）。
2. L2-2：TS worker（head 类型、功能存在性、manifest、recovery）。
3. L2-3：Java + TS 测试 fixture；整体验证这一协同变更。

## 开放问题

无残留。持久信号问题已解决（head 布尔列）。
