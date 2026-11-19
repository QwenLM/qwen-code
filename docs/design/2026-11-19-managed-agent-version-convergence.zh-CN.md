# Managed Agent 版本收敛（storage 阶梯、action options、pack reader）

[English](2026-11-19-managed-agent-version-convergence.md) | [简体中文](2026-11-19-managed-agent-version-convergence.zh-CN.md)

状态：proposed。服务尚未上线，因此仅为保护既有部署或为滚动升级协商而存在的版本机制可以删除。本设计覆盖 2026-11-19 版本兼容盘点中标记为「A 类」的各项：Session storage 版本阶梯与 reader 版本头（A1）、`managed-action-options` 格式族（A5）、journal pack 的 `minimumReader` 声明（A2）。CSI resource-handle 版本阶梯（A4）已被下文所述的冷归档丢弃。源码级核实修正了若干初判分类；下文记录修正后的范围，使变更集保持有界且诚实。

修订（2026-11-19）—— CSI 冷归档 #17415（`0c2458a3ca0f`，2026-11-16；设计记录：`2026-11-13-managed-kubernetes-java-archive.md`）。该归档把 Kubernetes runtime、Resident Workspace / Workspace CSI 后端、Kubernetes Harness pool discovery 的 Java 源码移入 `packages/sdk-java/managed-kubernetes-archive/`（构建之外的冷源码归档），并从 live server 删除 CSI 专属的 schema 列、配置、端点与维护入口。对本设计的后果：A4 整体丢弃；A1 的 CSI 专属部分（profile 能力围栏，职责 3，以及 CSI 维护调用点）与 A2 的 `CsiNativeActivationProof` 头检查在 live server 中已不复存在。A 批现为 A2 / A5 / A1（非 CSI）。描述已归档机制的章节作为历史记录保留并标注作废。归档未触碰 TypeScript，因此 worker 侧 CSI session 代码仍在，但其 server 侧准入对应物已归档。

## 问题

managed server 携带多套独立的「版本」机制。它们外观相似但职责不同，其中只有一部分是向下兼容产物。盲目全删会连带删掉活的功能不变量。本设计对每套机制区分：(a) 没有保护对象的滚动升级/旧 reader 限制（pre-production 可删），与 (b) 必须保留（或刻意重新表达）的活功能编码/能力不变量。目标是删除 (a)、以最小可辩护的变更集统一或保留 (b)，沿用 `2026-11-12-managed-agent-tier1-convergence.md` 的先例。

## 现状（已核实）

### A1 — Session storage version 是一列里的四套机制

`ma_session_head.storage_version`（`V1__managed_schema.sql:192`，可空 INT UNSIGNED；`:224` 的 `ck_ma_head_journal` CHECK 将其与 `head_kind` 绑定）被四类不同职责的代码读写：

1. **滚动升级 reader 围栏（纯兼容）。**
   - `ManagedStorageVersions.SUPPORTED = 5`（contracts）是天花板。
   - `ManagedSessionReaderVersion`（server config）在 `/internal/managed-session-store/` 与 `/internal/managed-tool-publications/` 上读取 `X-Qwen-Managed-Max-Readable-Storage-Version` 请求头，按 `[12345]` 校验，**头缺省时天花板按 1 处理**。它在 `ManagedAgentConfiguration:101` 被装配为 `StorageReadPolicy` bean。
   - `StorageReadPolicy.requireReadable(floor)` 拒绝 floor 超过 reader 天花板的提交（`JournalCommit:96`、`JournalStoreRows:587`、`JournalWriterLifecycle:210`）。`StorageReadPolicy.inProcess()`（天花板 5）用于嵌入路径：`JdbcManagedSessionStore:67`、`ManagedSideQueryStore:57`。（CSI 维护调用点 `WorkspaceCsiRuntimeMain:163` 与 `WorkspaceCsiWorkerAckMain:63` 已被 #17415 归档。）
   - 范围读者接受 1..5 内任意版本：`ToolPublicationStore:244`、`ToolPublicationAdmissionStore:147`、`WorkspaceRecoveryStore:616`（`List.of(1,2,3,4,5)`）、`ManagedSideQueryStore:576`、`JournalStoreRows:583`。
   - worker 通过发送该头声明自己的 reader 天花板：`http-managed-session-store.ts:2457,3301` 发 `'5'`；`hosted-side-query.ts:186` 发 `'4'`。

2. **writer 能力协商（滚动升级护栏）。**
   - server 在 writer grant 中返回 `supportedStorageVersion`：`JournalWriterLifecycle.supportedStorage()`（`:654`）返回 5。（CSI-profile 推导已被 #17415 归档。）
   - worker 按该 grant 门控诊断产出：`http-managed-session-store.ts:936-940`（`supportsExecutionDiagnostics() = grant >= 4`、`supportsModelDiagnostics() = grant >= 3`），并在所分配 profile 需要的档位 server 不支持时拒绝 CSI 准入（`hosted-csi-session.ts:273-284`，`csi_activity_storage_unavailable` / `csi_diagnostics_storage_unavailable`；分配这些 profile 的 server 侧 CSI 准入已被 #17415 归档）。
   - worker 对每次提交按 grant 预检（`http-managed-session-store.ts:2149-2177`，needsVersionTwo/Three/Four/Five），并拒绝接管比 grant 更新的 head（`:3087-3088`，`head.storageVersion > grant.supportedStorageVersion`；head 校验 `[1,2,3,4,5]` 在 `:356`）。

3. **CSI profile 能力围栏（已被 #17415 归档——作废）。**
   已取代：`CsiFilesRetirementProfile` 及所有 CSI 准入路径现位于 `packages/sdk-java/managed-kubernetes-archive/`；live server 没有 CSI 围栏。下文为归档前的历史记录。
   - `CsiFilesRetirementProfile.supportsStorage(scope, version)`（`:96`）接受版本 1、或带 diagnostics 的 3、或带 activity diagnostics 的 4。它在提交时（`JournalCommit:104-105`，对 `max(csiHead.storageVersion(), storageFloor)`）、writer 接管时（`JournalWriterLifecycle:305-306`）、CSI 激活时（`JdbcCsiActivationAdmission:506`）被检查。它防止 `/1`（无 diagnostics）Session 累积其 pinned worker 读不了的 storage。

4. **activity 投影重建标记（活不变量）。**
   - `JournalCommit:168` 在 `head.storageVersion() >= 4` 且 activity 统计 summary 非 `ready` 时以 `managed_activity_rebuilding` 阻止 writer 准入。
   - `ManagedActivityDiagnosticProjection.rebuildBatch(storageVersion, ...)`（`:362-364`）在 `storageVersion < 4` 时跳过重建；否则在 summary 不存在时重建一个 `clearing` summary 并从 journal 页重建。由 `JournalWriterLifecycle:282,300` 调用。此处版本号是一个持久的「该 Session 有 activity diagnostics、其投影可能需要重建」标记——包括 summary 行缺失的情形。

floor 本身由 `ManagedModelDiagnosticProjection.storageFloor()`（`:42-72`）逐提交计算：`tool.measured` 记录→5、activity diagnostics 资源→4、model diagnostics 资源（或 `managed-history_maintenance` schemaVersion 2）→3、Hosted recovery 记录 / `managed-action-options` v3/v4→2、否则 1。head 存 `max(existing, floor)`（`JournalCommit:415`）；新 head 从 `JournalStoreRows.STORAGE_VERSION = 1` 起（`JournalWriterLifecycle:227,249`）。原生 journal 快照把版本绑入 descriptor 并要求 `descriptor.storageVersion <= frozen.storageVersion`（`ManagedNativeJournalSnapshots:80,188,253`）；worker 在 restore 与快照检查时按版本复核功能存在性（`http-managed-session-store.ts:519-553,1600-1736`）。

**结论。** 职责 1、2 是 pre-production 没有保护对象的滚动升级限制；职责 3 已被 #17415 归档，职责 4 是仅存的、用版本号表达的活不变量。直接删列必须重新表达职责 4；只删协商（职责 1+2）则其原样保留。

### A5 — `managed-action-options` v1/v2/v3/v4 是活的 writer 形状

当前 worker 仍按功能上下文产出全部四种形状（`hosted-workspace-tool-turn.ts:10021-10040`）：

- question → `v:4`（questions + inputRef + continuationRef）；
- 有 `continuationRef` → `v:3`（preview 工具再加 inputRef）；
- 无 `continuationRef`、preview 工具 → `v:2`（仅 inputRef）；
- 无 `continuationRef`、其他工具 → `v:1`（裸）。

`continuationRef` 在调用位于 native batch 之外（`ordinal < 0`，`:10001-10005`）或 capture 失败时为 undefined，因此 v1/v2 是活的 fallback 路径，而非死遗留。命令审批恒写 `v:3`（`:9886`）。Java 读侧按 `v` 分支构造逐版本闭集字段与命令交叉校验（`JdbcManagedActionStore:216-285`），公开 input preview 接受 v2/v3（`ManagedActionService.inputPreview:383,389`），`ManagedUserQuestions.isQuestion` 即 `v == 4`（`:29`），Hosted recovery 闭包校验只走 v3/v4（`ManagedHostedRecoveryRecords:66`），v3/v4 把 storage floor 提升到 2（`ManagedModelDiagnosticProjection:51`）。伴生的 `managed-action-decision` body 用 `v == (question ? 2 : 1)`（`JdbcManagedActionStore:302-303`）——那是 kind 判别器，不是阶梯。

**结论。** A5 是格式统一（writer + reader），不是删旧读者。四种形状的差异仅在于 `inputRef`、`continuationRef`、`questions` 哪些存在；一个带可选字段与 kind 判别器的超集 schema 即可取代版本阶梯。

### A2 — pack `minimumReader` 有服务器与本地方言

journal 头携带 `formatVersion` 与 `minimumReader`。共享 TS 解析器 `parseManagedSessionHeader`（`managed-session-records.ts:1788-1822`）拒绝 `minimumReader` 超过 reader 自身能力的头：`MANAGED_SESSION_FORMAT_VERSION = 1`（`:31`）、`MANAGED_SESSION_MINIMUM_READER = 'managed-session/1'`（`:38`，服务器 authority 所写，`managed-session-authority.ts:721`）、`MANAGED_SESSION_READER_CAPABILITY = 'managed-session/3'`（`:39`）。Java 服务器只接受 `managed-session/1`：`JournalHistoryQueries:311-312`（pack value），事件信封 `"v"` 与 head 版本在 `:333`、`:268` 按 `JournalStoreRows.STORAGE_VERSION` 校验。（`CsiNativeActivationProof:235-238` 头闭集是 CSI 专属的，已被 #17415 归档；其通用 JSON helper 移到了 `ManagedCheckpointHistory` 与 `RuntimeToolMeasurements`。）

另有独立的**本地**（standalone daemon）journal 路径写并要求 `managed-session/2`：`local-managed-journal-snapshot.ts:232,266,273,541` 与 `sessionStorageUtils.ts:1190`。这是同一记录格式族，但属不同部署面。

**结论。** `formatVersion == 1` 与事件 `"v" == 1` 是单版本完整性门（保留）。`minimumReader` 是前向兼容声明；服务器侧取值恒为 `/1`，故服务器侧协商可删。共享解析器须继续容忍本地 `/2` 方言（或把本地路径也纳入范围）；让 `minimumReader` 在共享解析器中可选、并让服务器 authority 不再写它，是有界的服务器侧变更。

### A4 — CSI handle 版本 1/4 是活形状；2 和 3 是死写路径（已被 #17415 取代）

已取代——从本批丢弃。#17415 冷归档把 `WorkspaceCsiRuntimeIdentity`、CSI provisioner 及所有 CSI 准入类移入 `packages/sdk-java/managed-kubernetes-archive/`，并从 live server 删除 CSI 专属的 schema、配置与端点。本项已无 live 目标。下文分析作为历史记录保留。

`WorkspaceCsiRuntimeIdentity` 定义 `VERSION=1`、`FILES_VERSION=2`、`FILES_AUTHORITY_VERSION=3`、`FILES_FINALIZATION_VERSION=4`（`:22-25`），各有自己的 handle-value 键集（`KEYS`、`FILES_KEYS`、`FILES_AUTHORITY_KEYS`、`FILES_FINALIZATION_KEYS`）。`validate()`（`:88-92`）要求版本与 boot 形状匹配，`boot(request, seed, handle)`（`:71-79`）按 handle 版本重建 boot。provisioner 按 boot 内容选版本（`WorkspaceCsiRuntimeProvisioner:228`）：

- 非 files CSI（`ManagedCsiProtocol`，isolation `workspace`，`isolationKey == null`）→ **v1**，活（resident-workspace 路径）；
- files CSI 无 authority → **v2**，**无生产写路径**（见下）；
- files CSI 有 authority → `finalizationBoot` → **v4**，生产 files 路径（`:182-183`，`selects(request) && authority != null`）。

`selects()` 即 `CsiFilesRetirementProfile.isProfile(scope)`（`ManagedCsiFilesProtocol:47-53`）；boot payload 自身携带 `version` 4/5/6（`:73,:88`）。生产环境恰好有两个 provisioner 构造点。维护入口 `WorkspaceCsiRuntimeMain` 用**必填**的 `K2_RUNTIME_BROKER_ORIGIN` 构造 spec（`:92`，经 `KubernetesRuntimeProviderFactory:80`），故其 files runtime 恒带 authority → v4。`ResidentWorkspaceProvisioner:49` 走无 authority 的构造器重载（`WorkspaceCsiRuntimeProvisioner:96-114`，authority 默认 null），但**只服务非 files** 请求：它要求 `isolationClass == "workspace"` 且拒绝 `isolationKey != null`（`ResidentWorkspaceProvisioner:33,64-69`），而 files 请求携带 `isolationKey = sessionId`。因此 authority=null 的 provisioner 永远见不到 files 请求。**v2（files 无 authority）与 v3（files + authority、无 finalization）都没有生产写路径**：v2 需要 files 请求落到 authority=null 的 resident provisioner（被拒），v3 需要有 authority 却无 finalization（provisioner 有 authority 必加 finalization）。二者仅作为被容忍的读形状存在（`fileHistoryBoot` 在 `WorkspaceCsiRuntimeIdentity:59-60` 接受 3 或 4；`JdbcCsiExecutionAdmission:464-465` 要求 3 或 4；`JdbcCsiActivationAdmission:283` 与 `CsiFileFinalizeProtocol:31` 要求 4）。测试仍可通过包私有 `(transport, authority)` 构造器构造 v2/v3 handle。

**结论。** v1（非 files resident）与 v4（files 维护）是仅有的活形状；v2、v3 是死写路径，其读容忍属纯兼容。有界的 pre-production 收益是退役 v2、v3 两者的读容忍，保留 v1 + v4——**无需 `authorityOrigin` 配置决策**，因为每个生产 files provisioner 本就强制要求它。把 v1、v4 塌缩成单一形状（退役非 files CSI 或赋予其 files 形状）仍是独立的架构决策，不在范围内。

## 目标

- 删除 Session storage 的滚动升级 reader 围栏与 writer 能力协商（A1 职责 1+2），Java 与 TS 同步。
- 把 `managed-action-options` 统一为 worker 产出、server 按字段存在性校验的单一超集形状（A5）。
- 删除服务器侧 `minimumReader` 协商，同时保持本地 journal 方言可用（A2）。
- A4（丢弃）：CSI handle v2/v3 读容忍退役在 #17415 冷归档后已无 live 目标。
- 在本批中原样保留 activity 投影重建不变量（A1 职责 4）。（CSI profile 能力围栏，职责 3，已被 #17415 归档。）

## 非目标

- 彻底删除 `storage_version` 列。那需要用非版本号重新表达 activity 重建标记（职责 4）；见 [A1 Layer 2 follow-up](2026-11-19-managed-a1-layer2-storage-version-removal.zh-CN.md) 的设计。（CSI 围栏，职责 3，已被 #17415 归档。）
- 统一 CSI boot 形状 / 退役非 files CSI（A4 完全塌缩）。#17415 后作废：CSI 后端已归档。
- 触碰本地 standalone journal 的 `managed-session/2` 方言，仅保持共享解析器对其容忍。
- 删除单版本完整性门：资源 `schema_version == 1`、事件 `EventIdentity.SCHEMA_VERSION/PROJECTION_VERSION`、pack `formatVersion`、事件 `"v"`、manifest/bundle `formatVersion`、`managed-action-decision` kind 判别器，以及 `qwenCodeVersion` / `expectedQwenVersion` 一致性 pin。这些不是兼容产物。
- tool 执行协议 v2/v3/v4 共存（A3）。它需要先统一编码，是独立的更大批次。

## 方案

### 阶段 1 — A1：剥离 storage 版本协商（建议先行）

原样保留 `storage_version`、`storageFloor()`、activity 重建标记、快照 descriptor 绑定（CSI 围栏已不复存在——被 #17415 归档）。只删协商/限制层：

Server（Java）：

- 删除 `ManagedSessionReaderVersion` 及其 bean（`ManagedAgentConfiguration:101`）；删除 `StorageReadPolicy` 接口与 `inProcess()`。从 `JournalStoreRows`、`JournalWriterLifecycle`、`JournalCommit` 与 `JdbcManagedSessionStore` 构造器移除 `readerVersion` 参数与字段；去掉 `requireReadable(...)` 调用（`JournalCommit:96`、`JournalStoreRows:587`、`JournalWriterLifecycle:210`）。移除两个 live 嵌入调用点的 `StorageReadPolicy.inProcess()` 实参（CSI 维护入口已归档）。
- 把 1..5 范围读者改为单版本完整性检查（`== JournalStoreRows.STORAGE_VERSION` 是错的——head 合法地携带 2..5；应去掉上界拒绝，仅保留 schema 已有的 `head_kind`/可空性 CHECK）。具体：移除 `ToolPublicationStore`、`ToolPublicationAdmissionStore`、`WorkspaceRecoveryStore`、`ManagedSideQueryStore`、`JournalStoreRows:583` 中的 `<= SUPPORTED` / `List.of(1..5)` 拒绝；该列仍是由 `storageFloor()` 写入的合法功能档位标记。
- 从 `WriterGrant`（`ManagedSessionStoreModels:153-163`）与 `JournalWriterLifecycle.grant()` / `supportedStorage()` 移除 `supportedStorageVersion`；grant 不再携带 storage 天花板。

Worker（TS）：

- 停止发送 `X-Qwen-Managed-Max-Readable-Storage-Version`（`http-managed-session-store.ts:2457,3301`、`hosted-side-query.ts:186`）。
- 从 grant 类型与解析器移除 `supportedStorageVersion`（`:875,:3637-3642`）；令 `supportsModelDiagnostics()` / `supportsExecutionDiagnostics()` 返回 true（pre-production server 恒为当前），并删除 profile-vs-grant 准入拒绝（`hosted-csi-session.ts:273-284`）。server 侧 CSI 围栏（`supportsStorage`）已不复存在、无法作为纵深防御——它已被 #17415 归档。
- 删除按 grant 的提交预检（`:2149-2177`）与 `head.storageVersion > grant.supportedStorageVersion` 拒绝（`:3088`）。保留 restore/快照的功能存在性完整性检查（`:519-553,1600-1736`），但把 `[1,2,3,4,5]` 枚举改为仅凭存在性检查（携带 measurements 的 head 必须有 measurements 资源，等等）；版本号仍作为这些检查已在使用的标记保留。

本阶段删除所有滚动升级限制，同时原样保留 activity 重建不变量（CSI 围栏已被 #17415 归档）。它以删除为主，是满足「pre-production 不做版本限制」的最低风险路径。

### 阶段 2 — A5：把 action options 统一为单一形状

- Worker：permission 与 question 统一产出单一 options 形状，带可选 `inputRef`、可选 `continuationRef`、可选 `questions`；保留 kind 判别器（`permission` / `question`）与常量 `v`（或去掉 `v` 改按 kind 校验）。保留语义不变量：question 必须有 `continuationRef`；`managed-extension-command-input` 的 inputRef 必须有 `continuationRef` 及既有命令交叉校验。
- Server：把 `JdbcManagedActionStore`（`:216-285`）的逐版本闭集塌缩为单一的按字段存在性校验；更新 `ManagedActionService.inputPreview`（`:383,389`）、`ManagedUserQuestions`（`:29`）、`ManagedHostedRecoveryRecords`（`:66`）改按 kind/字段存在性而非 `v`。更新 floor 提升（`ManagedModelDiagnosticProjection:51`）按同一判别器。
- 保留 `managed-action-decision` 的 `v == (question ? 2 : 1)` 作为 kind 门。

实现要点（已落地）：permission 保留 `v: 3`，`inputRef` 与 `continuationRef` 可选；question 保留 `v: 4`。`hosted-approval-continuation.ts` 与 `hosted-plan-mode.ts` 中基于版本的 continuation 守卫改为按 `continuationRef` 存在性判断，保持原 v1/v2 的早退行为。`ManagedHostedRecoveryRecords.validateResource` 对无 `continuationRef` 的 action options 跳过闭包遍历（而非移除守卫），从而把缺失 `inputRef` 的失败保留在 action 准入阶段，而不是提前到 commit 期闭包校验。floor 提升按 `continuationRef` 存在性判断。

### 阶段 3 — A2：删除服务器侧 minimumReader 协商

- 让 `minimumReader` 在共享解析器（`parseManagedSessionHeader`）中可选：缺省→接受；存在→仍按 reader 能力校验，使本地 `/2` 方言继续可用。
- 服务器 authority 不再写 `minimumReader`（`managed-session-authority.ts:721`）；Java 从头闭集移除 `minimumReader` 成员及 `== "managed-session/1"` 检查（`JournalHistoryQueries:311-312`；`CsiNativeActivationProof` 头检查已被 #17415 归档）。
- 保留 `formatVersion == 1` 与事件 `"v" == 1` 完整性门。

### 阶段 4 — A4：退役死的 CSI handle 变体（丢弃——已被 #17415 取代）

丢弃。本阶段编辑的每个类（`WorkspaceCsiRuntimeIdentity`、`JdbcCsiExecutionAdmission`、CSI provisioner 与准入测试）都已被 #17415 冷归档移入 `packages/sdk-java/managed-kubernetes-archive/`；live server 中无可改之物。下文步骤作为历史记录保留。

- 移除 v2（`FILES_VERSION`）与 v3（`FILES_AUTHORITY_VERSION`）读容忍：`fileHistoryBoot` 与 `JdbcCsiExecutionAdmission` 仅要求 v4；删除 `WorkspaceCsiRuntimeIdentity` 中的 v2/v3 键集与 boot 重建分支。二者都是死写路径（上文已核实），故这是纯兼容删除——无需任何 `authorityOrigin` 配置变更。
- 保留 v1（非 files resident CSI）与 v4（files + finalization）。把 v1、v4 统一为单一形状不在范围内（架构决策）。
- 把通过包私有 `(transport, authority)` 构造器构造 v2/v3 handle 的测试改用 v1 或 v4。

## 设计决策与理由

- **先剥协商再删列（A1）。** 版本号对 activity 重建标记是 load-bearing 的（CSI 能力围栏已被 #17415 归档）。删协商以有界、以删除为主的变更删除真正的滚动升级限制，且零不变量风险；删列是更深的重构，必须先重新表达该不变量。
- **A1 Layer 2（删列）——已解决。** activity 重建标记的无版本替代是 head 布尔列 `has_activity_diagnostics`，首次 activity 提交置位、在投影清除后仍持久。完整删列计划（head 记录、门、重建、快照 manifest、功能存在性检查、pristine 谓词）见 [A1 Layer 2 — storage_version 删除](2026-11-19-managed-a1-layer2-storage-version-removal.zh-CN.md) 的设计。（重新表达 CSI 围栏已作废：围栏已被 #17415 归档。）
- **A5 是统一而非删除。** v1/v2 是活 fallback；设计把 writer 改为单一超集形状、reader 改为按字段存在性校验，保留 question/command 不变量。
- **A2 保留本地方言。** 共享记录解析器同时服务服务器与 standalone 本地 journal；让 `minimumReader` 可选即可删除服务器协商而不破坏本地 `/2`。
- **A4 只退役死变体（已取代——被 #17415 归档）。** v1（非 files resident）与 v4（files 维护）曾是活形状判别器；v2、v3 可证明在生产中从不被写入（authority=null 的 provisioner 仅 resident/非 files；有 authority 必加 finalization）。整个 CSI 后端现已归档，故此决策已无 live 目标。

## 约束

- 模块 AGENTS.md：任何 schema 触碰原地编辑 V1 基线；禁止 V2+ 迁移。阶段 1 无 schema 变更（列保留）。A1 Layer 2 若推进，原地编辑 V1。
- 保留租户隔离、writer-lease/generation 围栏、双 SQL fencer 参数化。（CSI 锁序 `lockSessionFirst → lockCsiContinuation → requireHeadAfterCsiCheck` 已被 #17415 归档。）
- 阶段 1 中 activity 重建不变量行为保持一致（CSI profile 能力围栏已被 #17415 归档）。
- Java + TS 线变更（grant 字段、头、options 形状、pack 头）必须同步落地；pre-production worker 与 server 作为一个单元部署。
- 文档变更保持两个语言版本完整且同步。

## 风险

- 阶段 1 触碰 writer-grant 线形状与 store 请求头；Java 与 TS 必须同步变更，否则准入中断。focused store 测试是回归网（CSI 激活门测试已归档）。
- 移除 grant 天花板会改变错误面：worker 侧拒绝码随协商一并消失。本风险原先依赖的 server 侧 CSI 围栏已被 #17415 归档，故已无 CSI 提交拒绝可供迁移测试；余下的按版本门控的 server 检查是 activity 重建门与快照/history 完整性检查。
- A5 writer/reader 统一必须保留命令交叉校验与 question continuation 要求；丢失不变量会让不可恢复的审批被提交。action store 测试钉住这些。
- A2 解析器变更不得拒绝本地 `/2` 头；本地快照测试是护栏。
- A4（丢弃——已被 #17415 取代）：v2/v3 读容忍移除已无 live 目标；归档源码保留其 handle 形状。

## 验证计划

按模块 AGENTS.md，在共享 10 分钟预算内跑 focused 回归（JDK 21、Maven 3.8.9+、从 checkout 安装 sibling SDK）；完整门在 CI。

- A1：`ManagedSessionReaderVersionTest`（删除/改用途）、`ManagedSessionStoreIntegrationTest`（`:387,424,440,486` 头/天花板用例）、`ManagedActivityDiagnosticsTest`（`:98,143` floor 断言保留）、`ManagedSideQueryStoreTest`（`:83` version-999 拒绝改用途）、`HostedSideQueryProcessIT:196`、`HostedCleanupRetentionMySqlIT:53`，以及注入 `StorageReadPolicy` 的 wiring 测试（`VerificationFixtures:73`、`ToolPublicationStorageConfigurationTest:51`、`ManagedSessionStoreWiringTest:54`、`ToolPublicationAsyncVerificationTest:320`）。（`WorkspaceCsiNativeActivationGateTest` 已被 #17415 归档。）TS：`http-managed-session-store.test.ts` grant/头/restore 用例（`:2528,2558,2623,2771,7083,9166`）、`hosted-csi-session` 准入测试。
- A5：`ManagedActionsTest`（`:171`）、`JdbcManagedActionStore` action 校验测试、`hosted-workspace-tool-turn.test.ts`（`:6160,6176`）与 `hosted-approval-fallback.test.ts`（`:320`）。
- A2：`JournalPackTransactionRegressionTest`、`managed-session-records.test.ts` 头用例（`:1003-1067`）、`local-managed-journal-snapshot` 测试（本地 `/2` 保持绿）。（`CsiPackRecordsTest` 已被 #17415 归档。）
- A4：丢弃——所列套件（`WorkspaceCsiNativeActivationGateTest`、CSI 执行/激活准入测试、`WorkspaceCsiRuntimeProvisioner` 测试）均已被 #17415 归档。
- MySQL 集成：`ManagedSessionStoreIntegrationTest`、`HostedHarnessMySqlIT:240`、`ManagedSchemaMySqlIT`（head 列）。
- 线变更后对 `packages/core` 与 `packages/cli` 做 TS typecheck/build。

## 分阶段与 follow-up

1. 阶段 1（A1 剥协商）——建议先行，风险最低。
2. 阶段 2（A5 统一）与阶段 3（A2 minimumReader）——独立，阶段 1 后可以任意顺序落地。
3. 阶段 4（A4 v2 + v3 读容忍移除）——丢弃，已被 #17415 冷归档取代。
4. Follow-up A1 Layer 2：在重新表达 activity 重建标记后删除 `storage_version`（先解决开放问题；CSI 围栏已归档）。
5. Follow-up A3 tool 协议统一：独立的更大批次（盘点中的 A3）。A4 完全塌缩已作废——CSI 后端已归档。
