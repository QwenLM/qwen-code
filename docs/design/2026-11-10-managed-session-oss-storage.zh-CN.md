# Managed Session OSS 存储：资源外置（D2 补完）与 journal compaction

[English](2026-11-10-managed-session-oss-storage.md) | [简体中文](2026-11-10-managed-session-oss-storage.zh-CN.md)

状态：提案，仅设计。本文不实现任何代码、schema 或 wire 变更。
基线：`main @ 488845a4a8`（2026-11-10）。所有 `file:line` 引用均在该基线实读；实现前须重核（并行工作会移动 main）。

> **实现后说明（2026-11-12）。** S1a/S1b 已在 #16868 落地，并在 #16910（「scope CSI retirement evidence to its own session」）**删除 CSI application inventory/image 机制**（`WorkspaceCsiApplicationInventory`、`CsiActivityDiagnosticProjection`、`CsiModelDiagnosticProjection`、各 `*Image`/`*Identities` 类）之后与 main 整合。因此下文所有 `WorkspaceCsiApplicationInventory` 引用均为**历史性**——该类已不存在，它点名的 pack-aware inventory 读取方随之移除，核心（journal compaction、资源外置、非 CSI 的 pack-aware 读取方）保持不变。两项后果仍开放：(1) 幸存的 `record_bytes` 直读方 `JournalStoreRows.activationLeaseRow`、`WorkspaceCsiCheckpointSnapshotStore`、`JdbcCsiActivationAdmission`、`JdbcCsiExecutionAdmission` **尚未 pack-aware**，覆盖区间被 EVICTED 后即失败关闭——它们是启用 `deletion-enabled` 的前提（见 §5.4）；(2) compaction job 的并发控制（§5.3「claim/lease」）已实现为 BUILDING 行上 replica 范围的 `builder_id` lease，加上 `publish()` 的行数断言（被取代的构建者回滚，而非把水位推进到没有已发布 pack 的区间）。`ck_ma_request_namespace` 的 `RESOURCE_ALLOCATE` 臂为 **17**，非 16。

## 1. 问题与范围

私有 Hosted Managed Session 的资源体与 journal 事务字节目前内联在 MySQL。超过 per-kind 内联上限的资源被 HTTP 501 `managed_session_oss_disabled` 拒绝（`JournalCommit.java:762-772`）；README 明示 OSS-backed 资源 pending，"until the immutable OSS path is implemented"（README §655-657）。内联 journal 字节无界累积（单事务至多 8 MiB），这正是大对象测试要求 `max_allowed_packet >= 128MB`（模块 AGENTS.md）、读者携带 `OCTET_LENGTH` 守卫（`CancelEvidence.java:75`）与 inventory 8 MiB 上限（`WorkspaceCsiApplicationInventory.java:1257`）的原因。

本设计补完已决策的路径，分两个解耦部分加两个搭车小 schema 增补：

- **S1a — D2 资源外置**。实现 `docs/design/2026-09-21-managed-session-durable-store.md` §12 点名的 `OSS_OBJECT` 路径：allocate/upload/finalize/read、scoped 签名 URL、digest 验证、加密、孤儿盘点。目标 placement 依 `2026-09-25-managed-session-typescript-foundation.md:15`：不超过 per-kind 上限的 body 留 MySQL inline；更大的 body 成为不可变 OSS 对象。
- **S1b — journal compaction**。把 `ma_session_journal_tx.record_bytes` 的连续已提交前缀打包为不可变压缩 OSS 对象，原子发布 manifest 与水位，grace 窗口后才删除被覆盖的 SQL blob。即 durable-store §9 sketch 的「later measured optimization」；这才是真正让 MySQL 变瘦的部分。
- **附录 A — A3/A4**。会话列表 preview 反范式与队列修订号计数器，两个独立小 schema 增补，搭同一个 release 前 V1 窗口。

非目标：把真相源搬出 SQL（digest 链与 head CAS 仍是 authority）；改 per-kind 内联上限；改 retirement 墓碑语义；任何公共 API 或 wire 变更；融合表拆分（S2 类）。

## 2. 已锁定决策

| #     | 决策点                | 选择                                                                                                                                                                                                                   |
| ----- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1    | finalize 验证         | 全量 GET + SHA-256 + 字节长度校验。multipart 上传的 OSS ETag 不是 SHA-256；provider-neutral 验证必须读字节。                                                                                                           |
| D2    | allocate 幂等 receipt | `ma_resource` allocation 行即 durable 幂等记录：唯一业务键 + digest/长度比对提供重放与冲突语义，比独立 receipt 机件更少。`RESOURCE_ALLOCATE` receipt namespace 保留（一行 CHECK 编辑）供未来命令级 receipt。           |
| D3    | 资源读/写路径         | 首版经现有 `GET resources/{resourceId}` 路由 server 代理读，并经 server 代理 `resources/{id}:upload` 路由上传。`ToolPublicationObjectStore` 无 presign 操作；新增会波及全部实现者，故 scoped 签名直连 URL 为后续优化。 |
| D4    | bucket 隔离           | 与工具发布共用一个 bucket、按用途独立 key 前缀；独立 bucket 保留为部署选项。                                                                                                                                           |
| D5    | 加密                  | bucket 级服务端加密作为部署 gate；per-resource 客户端加密后续（`encryption_key_id` 列已预留）。                                                                                                                        |
| D6    | per-kind 内联上限     | S1a 不动，含 32 MiB 的 `hosted-model-request`。改 placement 边界需 storage-versioned 兼容决策 + 生产测量（durable-store §10）。                                                                                        |
| E1    | compaction 水位       | 新增 head 列 `packed_through_revision`。`compacted_through_revision` 保持现 retirement 墓碑语义零改动（§3.2）。                                                                                                        |
| E2    | 压缩                  | 首版 JDK `Deflater`/GZIP，不引新依赖；zstd 仅在实测比例证明值得时作为已声明依赖引入。                                                                                                                                  |
| E3    | pack 边界             | 配置化；提案默认压缩目标 16 MiB、每 pack 4096 事务，测量后定。                                                                                                                                                         |
| E4    | 删除 grace            | 配置化，默认 72h。硬约束：grace >= 备份复制 lag SLA。当前无明确 SLA，故 P3 qualification 增加人工确认 gate：启用删除前运维必须确认实际 lag < grace。                                                                   |
| E5    | range 读              | `ToolPublicationObjectStore` 扩展 `openRange(key, offset, length, guard)`。仅 S1b P2 需要；S1a 用全量读。拒绝全量流 skip。                                                                                             |
| E6    | pack 边界对齐         | 方便时优先在 checkpoint revision 收尾；非强制。                                                                                                                                                                        |
| E7    | 既有全 journal 扫描器 | `AgentExecutionOperations.backfillCompactionProjection` 等先走统一 record reader；增量化维护为后续优化。                                                                                                               |
| F1    | 顺序                  | S1a P1 先（解锁 501 拒绝）；S1b P1 可并行（无依赖）；A3/A4 独立小变更。                                                                                                                                                |
| G1/G3 | 交付与边界            | 本统一双语文档；本轮仅设计，实现另行授权。                                                                                                                                                                             |

**对旧设计文本的修正。** durable-store §11 写「Enable OSS versioning」。已实现的存储契约取代该表述：`AliyunToolPublicationObjectStore` 是「private OSS profile: immutable keys in a bucket that has never enabled versioning」，`validateConfiguration()` 拒绝 versioning 为 ENABLED 或 SUSPENDED 的 bucket（`AliyunToolPublicationObjectStore.java:72-84`）。不可变性由每次创建的 `x-oss-forbid-overwrite: true` 头（`:86-90`）加「从未开 versioning 的私有 bucket」检查强制。本设计遵循已实现 profile；SSE 仍为部署要求。

## 3. 现状（已核验）

### 3.1 placement 门与限额

`ManagedSessionStoreModels.java:17-28`：默认内联上限 64 KiB；`managed-checkpoint` 1 MiB；`managed-input` 8 MiB；`hosted-model-request` 32 MiB；`managed-agent-skills` 2 MiB；`MAX_TRANSACTION_BYTES` 单 journal 事务 8 MiB；`MAX_INLINE_TRANSACTION_BYTES` 单事务内联资源总量 40 MiB；每事务 1024 资源、256 事件。

`JournalCommit.java:762-772` 对超限资源抛 501 `managed_session_oss_disabled`（`ManagedSessionStoreModels.java:53-54`）。唯一现存例外是 `managed-tool-outcome` 且 `bytesBase64 == null`，即已外置的工具发布引用。S1a 泛化的正是这个例外。

### 3.2 journal 读取与 `compacted_through_revision` 的墓碑语义

schema COMMENT 称 `compacted_through_revision` 为「compaction 覆盖的最高 journal revision」，但当前代码把它当 **retirement 墓碑**：`ManagedSessionRetirementStore:117-135` 物理删除 `ma_session_journal_tx` 行及其 JOURNAL 引用，然后在 DELETED head 上设 `compacted_through_revision = GREATEST(current, lastDeletedRevision)`。读者把任何非零值视为「journal 不完整/不可验证」并 fail closed：

- `JdbcWakeRecoveryStore:112-114` throw corrupt；`:133-139` 分页读 `record_bytes` 做 wake proof。
- `JdbcWorkspaceLifecycleStore.requireIdleJournal:120-131` 以 `workspace_lifecycle_journal_unverified` 阻塞（head 行锁是 per-session fence；#13800 快照读重试）。
- `WorkspaceCsiCheckpointSnapshotStore:148` 要求为零。
- `AgentExecutionOperations:225-245`（`backfillCompactionProjection`，16 行/页）与 `:805`（sealed 判定）。
- `ManagedRuntimeRetentionGuard:72`（`state <> 'DELETED' OR compacted_through_revision < journal_revision`）。
- `JdbcChildResultRelayStore:505` 读水位；`:513` 读 `record_bytes`。
- `WorkspaceCsiApplicationInventory:2874` 校验要求为零。

因此 S1b **不得**复用该列表示活会话覆盖（决策 E1）。复用会把墓碑与覆盖语义融合——正是本计划 elsewhere 拒绝的融合表反模式。

读取协议：`ManagedSessionStoreController:214 /restore`、`:234 /transactions`、`:246 /transactions:recent`、`:258 /transactions:lookup`；`JdbcManagedSessionStore:250/:256-259` 委托 `JournalHistoryQueries:36-44`（restore head）与 `:46-127`（两阶段分页：候选阶段只选 `journal_revision, byte_length` 并强制连续性 + 8 MiB 页预算；全行阶段经 `storeRows.transactionMapper` 与 `storeRows::storedTransaction` 选 `ManagedSchemaProjection.SESSION_JOURNAL_TX.columns()`）。`ManagedSideQueryStore:231` 自有 transactions 读。wire 每事务返回 `recordBytesBase64 + recordDigest`；TS 客户端逐事务验 SHA-256（`packages/core/src/managed-runtime/http-managed-session-store.ts:363-369, :1321-1326, :1399`）。**pack 解析放在这些路由背后的 server 侧可保持 wire 字节不变，故 S1b 的 TS 客户端零改动。**

其余必须走统一 reader 的 `record_bytes` 直读点：`JdbcWorkspaceLifecycleStore:169/:482`、`JdbcWakeRecoveryStore:133-139`、`JdbcChildResultRelayStore:513`、`SideQueryConversation:82`、`AgentExecutionOperations:239-245`、`WorkspaceCsiApplicationInventory:1257/:2598/:2880-2882`。

### 3.3 对象存储契约与 OSS profile

`contracts/artifact/ToolPublicationObjectStore`：私有、durable、不可变对象；`putIfAbsent` 永不覆盖、删后永不重建同 key；`open(key, guard)` 在每次新存储请求（含重试）前检查授权/租约 guard；`deleteIfPresent` 删除精确 owned key；`validateConfiguration` 校验 backend 保证。生产实现：`adapters/artifact/AliyunToolPublicationObjectStore`（私有 bucket、从未 versioning 检查、forbid-overwrite 头、guarded read loop 拥有重试——GET 500/502/503 抛 `TransientReadException`，`:33-52`）。装配：`AliyunToolPublicationStorageAutoConfiguration`，门控 `qwen.managed-agent.tool-publication.enabled`，`@ConditionalOnMissingBean` 允许应用 `@Bean` 替换 OSS（README §232）。一个部署一个权威 store；SQL 行存 object key 而非 provider 身份；对象缺失阻塞读取、绝不 fallback（storage-interface 设计）。

`openRange` 增补波及的实现者：1 个生产（`AliyunToolPublicationObjectStore:25`）、6 个测试 fixture（`PublicationProbeWiring:94` InMemoryObjectStore、`O4OssGate:157` OssFixture、`ToolPublicationAsyncVerificationTest:1078` Bucket、`ToolPublicationRetentionStoreTest:527` MemoryObjects、`O4FileObjects:13`、`ManagedSchemaPublicationStoreTest:115` Bucket）、1 个维护工具匿名实现（`WorkspaceCsiWorkerAckMain:102`）。

### 3.4 schema 与配置先例

`ma_resource`（V1:438-478）已具备 `storage_kind`、`object_key`、`object_version_id`、`encryption_key_id`、`quarantine_reason`、`deletion_operation_key`、`retention_until`、`last_verified_at`、`sha256`、`byte_length`；`storage_kind` 与 `state` 均无枚举 CHECK。`ma_resource_ref.owner_kind` 已枚举 `JOURNAL`。`ma_session_head`（V1:185-233）已有 `compacted_through_revision` 与 `latest_checkpoint_resource_id`。`ma_request_receipt`（V1:619-666）有 `result_json LONGTEXT` 与封闭 namespace CHECK。配置先例：`ManagedAgentProperties.ToolPublication:738-763` 含容量、验证限速、`gcEnabled`、`deletionGrace` 默认 24h；新配置段镜像该形状并扩展 `ManagedAgentSettings` 契约接口。

## 4. S1a — D2 资源外置

### 4.1 协议

1. **allocate** — `POST /internal/managed-session-store/v1/sessions/{id}/resources:allocate`，带 writer token 与 `{resourceId, kind, schemaVersion, byteLength, digest}`。Server 校验 writer credential/generation/lease、kind 上限与配额；插入 `ma_resource`，`state='ALLOCATED'`、`storage_kind='OSS_OBJECT'`、server 生成的 attempt-owned `object_key`（`<prefix>/<session_scope_key>/<resource_id>/<attempt_key>`，attempt 绑定 writer generation）；在 namespace `RESOURCE_ALLOCATE` 记幂等 receipt，`result_json` 存 `{objectKey, byteLength, digest, attemptKey}`。返回已分配的 `objectKey` 与 server 代理上传路由（D3）；由 store 自身以 forbid-overwrite 头执行 `putIfAbsent`。同幂等键重放返回原 allocation；digest 冲突由 `request_digest` 拒绝。
2. **upload** — Harness 将精确字节 POST 到 `resources/{resourceId}:upload`；server 对已分配 key 调 `putIfAbsent`。重试同 key 且安全，因为已完成的创建绝不被覆盖，包括后续删除之后（接口契约）。digest/长度验证在 finalize 而非 upload。
3. **finalize** — `POST .../resources/{resourceId}:finalize`。Server 经 `open(key, guard)` 全量读对象，对请求与行校验 SHA-256 与字节长度，然后 CAS `ALLOCATED -> PUBLISHED` 并设 `last_verified_at`。失败记 `quarantine_reason`、行保持不可用（fail-closed）。session 资源不占 capture slot：`scope_key/publication_id/slot_key` 保持 NULL，满足 `ck_ma_resource_capture`；不复用 `capture_state`。
4. **commit 引用** — `transactions:commit` / `commit-v2`（`ManagedSessionStoreController:199`）接受任何 kind 的 `resources:[{resourceId, kind, digest, byteLength, bytesBase64:null}]`，只要其行是 `OSS_OBJECT` 且 `PUBLISHED`。校验泛化 `ToolPublicationAdmissionStore.referenceCapturedResource:492-521`：`FOR UPDATE` 行锁、kind/scope/length/digest 匹配、`PUBLISHED -> REFERENCED` CAS、同 `commandId` 幂等重引用。与 journal 行、head 推进同一 MySQL 事务内插入 `ma_resource_ref`：`owner_kind='JOURNAL'`、`owner_key=<scope>`、`owner_revision=<journal_revision>`。committed head 永不引用未 finalize 的对象。

崩溃窗口：PUT 成功但 commit 失败留下无引用不可变对象，对 recovery 不可见，仅在 publisher 被 fence + 安全窗口后可收集（durable-store §8）。finalize 成功但 commit 失败留下 PUBLISHED 无引用行，由同一孤儿收集器处理。

### 4.2 Schema

零新列零新表。一处 V1 原地编辑：`ck_ma_request_namespace` 增加 `WHEN 'RESOURCE_ALLOCATE' THEN 17`。应用层枚举扩展：`storage_kind='OSS_OBJECT'`、`state='ALLOCATED'`。须核对 Java 行校验器（`JournalStoreRows` resource mapper、`WorkspaceCsiApplicationInventory` 列映射）接受新取值；Broker projection 只带列清单、无取值白名单（已核验：`runtimebroker/managedschema` 包无 `MYSQL_INLINE`/`TOOL_PUBLICATION` 字符串）。

### 4.3 读取、GC、配置、客户端

- 统一资源 body 解析：`MYSQL_INLINE` 返回 `inline_bytes`；`OSS_OBJECT` 带 guard 经 store 打开、验 digest/length、流式返回。缺失/损坏 fail closed（`managed_session_resource_missing` / TS `BLOCKED_RESOURCE`，`managed-session-authority.ts:658`）；绝不 fallback。Touchpoints：`ManagedSessionStoreController:294`、restore bundle、`JournalStoreRows:477` 门、`SideQueryConversation:82`、`JdbcChildResultRelayStore:651`、`WorkspaceRecoveryReader:88-123`、`ManagedNativeJournalSnapshots:515-560`。Harness 可按 digest 在 Pod 缓存不可变 body（durable-store §9）。
- 孤儿收集器：新小 collector 类（`ToolPublicationRetentionStore` 的模式，而非扩展 `ManagedProjectionResourceCollector:67` 的 inline-only filter），扫描无引用且 publisher 已 fence 的 ALLOCATED/PUBLISHED 行，写 durable 删除意图（`deletion_operation_key`），经 `ma_operation` 驱动 `deleteIfPresent`，标记 COLLECTED。首版绝不自动删除被引用资源（safe leak，durable-store §11）；session retirement 走既有墓碑流程。
- 配置：复用唯一 store bean；新段 `qwen.managed-agent.session-resources`，`oss.enabled` 默认 false（保持 501 fail-closed）、key 前缀、容量镜像 `ToolPublication`。启动 `validateConfiguration()`。
- TS 客户端：`http-managed-session-store.ts` 增加 allocate/upload/finalize、同 key 重试与 digest 缓存；扩展 D1b Java/TS shared fixture，pin 新路由的 headers、限额、digest 与错误分类。
- 维护工具 `WorkspaceRecoveryMain` / `WorkspaceCsiWorkerAckMain` 构造同一 store（README §236）。Broker：零代码改动。

## 5. S1b — journal compaction

### 5.1 pack 对象、manifest、目录

pack 对象（不可变、单对象、三段）：

```
[ compressed payload ][ index JSON ][ 8 字节 index 长度 ][ magic "QJPK" ]
```

payload 为 `[from, through]` 区间 `record_bytes` 按序拼接后用 JDK Deflater/GZIP 压缩。index JSON 每事务一条 `{revision, offset, length}`，**不含 digest**：per-tx `record_digest` 留在 SQL 行，manifest 因此保持小。读取用 range GET：trailer → index → 事务切片。

manifest：pack 级元数据 `{packId, fromRevision, throughRevision, txCount, uncompressedBytes, compressedBytes, packSha256, indexSha256, prevPackId}`，存 `ma_resource`，kind `managed-journal-pack-manifest`、`MYSQL_INLINE`、恒 <= 64 KiB。**故 S1b 不依赖 S1a 的 OSS_OBJECT 路径。**

目录：新小专表（S3 原则）：

```sql
CREATE TABLE ma_journal_pack (
    pack_id VARBINARY(144) NOT NULL COMMENT 'Stable pack identity.',
    session_scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Session identity.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    from_revision BIGINT UNSIGNED NOT NULL COMMENT 'First journal revision covered by the pack.',
    through_revision BIGINT UNSIGNED NOT NULL COMMENT 'Last journal revision covered by the pack.',
    manifest_resource_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the pack manifest resource.',
    object_key VARBINARY(8192) NOT NULL COMMENT 'Object-store key of the immutable pack.',
    state VARCHAR(16) NOT NULL COMMENT 'BUILDING, VERIFIED, PUBLISHED, or RETIRED.',
    byte_length BIGINT UNSIGNED NOT NULL COMMENT 'Compressed pack length in bytes.',
    sha256 CHAR(64) NOT NULL COMMENT 'SHA-256 of the complete pack object.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_journal_pack_scope_from UNIQUE (session_scope_key, from_revision),
    CONSTRAINT uk_ma_journal_pack_id UNIQUE (pack_id),
    CONSTRAINT ck_ma_journal_pack_range CHECK (from_revision >= 1 AND through_revision >= from_revision),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_journal_pack PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Immutable journal pack catalog and lifecycle.';
CREATE INDEX ix_ma_journal_pack_through ON ma_journal_pack (session_scope_key, through_revision);
CREATE INDEX ix_ma_journal_pack_state ON ma_journal_pack (state, gmt_modified);
```

### 5.2 V1 schema diff

1. `ma_session_journal_tx.record_bytes`：`MEDIUMBLOB NOT NULL` -> `MEDIUMBLOB NULL`，加 `CHECK (record_bytes IS NULL OR OCTET_LENGTH(record_bytes) = byte_length)`。
2. `ma_session_head`：新增 `packed_through_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Highest journal revision covered by published live packs.'`。
3. 新增上述 `ma_journal_pack`。
4. `compacted_through_revision` 不动（retirement 墓碑）。
5. manifest 引用：`ma_resource_ref` `owner_kind='JOURNAL'`、`owner_key=pack_id`、`owner_revision=1`。

### 5.3 构建、验证、发布

后台 job 自有 claim/lease。前缀选择：`from = packed_through_revision + 1`；`through` 受 E3 限额与 `head.journal_revision` 减安全边际约束；方便时 checkpoint 对齐收尾（E6）。已提交事务行不可变，故打包前缀不需要 writer lease；水位推进与删除取 head 行锁（与 writer 同一 fence，#13800）。

步骤：插 pack 行 BUILDING（attempt-owned key）→ 读 SQL 字节拼接压缩 → `putIfAbsent` → 全量回读验 `packSha256`、`indexSha256`、逐事务 digest 对 SQL 行 → VERIFIED。**单 MySQL 事务原子发布**：head 锁、校验 head state 非 DELETED、CAS `packed_through_revision` 从 `from-1` 到 `through`、pack -> PUBLISHED、插 manifest 资源与引用。committed head 永不引用未验证 pack。

崩溃窗口：发布前 PUT 留下 BUILDING 孤儿（fence + 安全窗口后 GC）；删除前发布留下安全双副本期（pack 为 authority）；删除中断幂等续做；删除后 pack 丢失/损坏 fail closed（备份一致性约束是运维 guard）。

### 5.4 读取解析

新统一 `JournalRecordReader`：`revision <= packed_through_revision` 且 `compacted_through_revision == 0` 时，按 `(session_scope_key, through_revision >= revision)` 定位 pack，加载 manifest，`openRange` 取切片，对 SQL 行 `record_digest` 验 SHA-256，返回原字节；否则读 SQL inline。插入点：`JournalHistoryQueries:46-127` 全行阶段（`storeRows.transactionMapper` / `storeRows::storedTransaction`，`JournalStoreRows:690` `TransactionRow.recordBytes`）、`JournalHistoryQueries:129` recentTransactions、`ManagedSideQueryStore:231`、以及 §3.2 列出的全部扫描器。候选分页阶段只读 `byte_length`（留在 SQL），故分页与预算逻辑不变。restore = 最新 checkpoint 资源 + tail；tail 中被覆盖的 revision 走同一 reader。digest 链验证语义不变：链元数据永不离 SQL；pack 只供字节。OSS 对象 listing 永不是顺序/完整性的 authority（durable-store §9）。

wire 兼容：路由返回相同的 `recordBytesBase64`/`recordDigest`；TS 客户端零改动，其既有逐事务 SHA-256 验证兼作 pack 完整性检查。

### 5.5 grace 删除与 retirement

删除条件：PUBLISHED + 已验证 + `now - publish >= grace`（E4）+ head 锁复核；然后分批幂等 `UPDATE ma_session_journal_tx SET record_bytes = NULL WHERE ... journal_revision BETWEEN from AND through AND record_bytes IS NOT NULL`。NULL 即「走 pack」；已发布水位使 authority 无歧义。

retirement 保持现物理删行 + 墓碑行为，并在同事务把该 session 的 pack 标 RETIRED、写 durable 删除意图，由 GC 删 pack 对象并回收 manifest。compaction 发布 CAS 校验 head state != DELETED；两流程在 head 行锁上互斥。

## 6. 共享契约变更：openRange

`ToolPublicationObjectStore` 增加：

```java
/** Range read with the same guard-before-each-request contract as open. */
InputStream openRange(String key, long offset, long length, Runnable guard);
```

OSS 实现在既有 guarded read loop 内用 Range GET（重试所有权同 `TransientReadException`，`AliyunToolPublicationObjectStore:33-52`）；fixture 在其存储字节上实现切片。§3.3 列出的全部实现者重编译；沿用 storage-interface 变更中 `requireUnversioned -> validateConfiguration` rename 的先例。S1a 不需要该方法；随 S1b P2 落地（若两者同推进则合并一次）。

## 7. 附录 A — 搭车 schema 增补

**A3 会话列表 preview。** `ma_session` 增加 `preview VARCHAR(1024)`（有界、可空），带类比 `title_revision` 的 revision 守卫（陈旧 writer 不能覆盖更新 preview）。首片在用户输入 admission 时 settlement preview（最后一条用户输入、截断 1024 字符、`preview_revision < sequence` 守卫）；agent 终端 preview settlement 为同计划后续 slice。`last_activity` **无需新列**：列表查询 `AgentStoreRows:99`（`SESSION_WITH_STREAM`）已 LEFT JOIN `ma_event_stream`；增选 `es.gmt_modified AS list_last_activity`，扩展 `StreamCounters`/`SessionRecord` 与两个 mapper（`AgentStoreRows:104-127`）。更新 `ManagedSchemaProjection.SESSION` 列清单。列表排序/索引变更仅在测量证明需要时做（模块设计文化）。

**A4 队列修订号。** `ma_user_message_queue`（V1:114-127）增加 `queue_revision BIGINT UNSIGNED NOT NULL DEFAULT 0`。在 `JdbcManagedUserMessageStore` 的每个内容/状态变更点同事务维护：submit（`:92-99`）、edit/withdraw（`:103-121`）、resume（`:131`）、claim（`:168`）与 startNext（`:235`）、reconcile 驱动的 `recovery_blocked` 转换；排除 `attempted()`（`:186-190`，仅调度时间戳）。一个私有 helper 做 `queue_revision = queue_revision + 1`；WebShell 轮询/ETag 降为单行读。更新 `ManagedSchemaProjection` 队列列清单与队列插入（`:259-261`）。

两者均为 release 前 V1 窗口的独立小变更；不触碰 journal 与资源路径。

## 8. schema 校验波及清单

任何 V1 编辑须同变更更新：`ManagedSchemaProjection` 列枚举（`SESSION_HEAD:137`、`SESSION_JOURNAL_TX:147`、`SESSION`、队列枚举）、`WorkspaceCsiApplicationInventory` 列类型映射（`:254` head、`:267` journal、`:882` resource keys）及其校验谓词（`:2874`）、`JournalStoreRows` mapper 与 record（`headMapper:40-66`、`HeadRow:677`、`TransactionRow:690`、`ResourceRow:703`、`restoreHead:119`）、以及 wire 可见处的 Java/TS shared fixture。S1a 零 DDL 结论成立是因为无列清单变化；只动 namespace CHECK 与应用枚举。

## 9. 不变量（review gate）

1. SQL 仍是唯一 authority：digest 链、head CAS、writer lease/generation fencing 不变；OSS 只放字节。
2. `putIfAbsent` 永不覆盖；删后同 key 永不重建。
3. committed head 永不引用未 finalize 资源或未验证 pack。
4. 每次存储请求（含重试）前 guard；签名 URL 短 TTL + scope 绑定；私有响应 `Cache-Control: no-store`。
5. body/pack 缺失或损坏 fail-closed；无 fallback、无 partial authority。
6. 幂等重试：同 command/幂等键返回原 receipt；allocate/finalize 同 key 重试安全。
7. 不超过 per-kind 上限的热路径零 OSS 依赖；placement 边界变更需 storage-versioned 决策。
8. 私有字节不进公共事件与普通日志。
9. 首版绝不自动删被引用资源；删除走 tombstone/intent + grace + 幂等物理删。
10. MySQL 与 OSS 备份一致：DB point 新于可用对象副本不是有效恢复点；grace >= 复制 lag。
11. 一部署一权威 store；SQL 行存 key 非 provider 身份；换 backend 非数据迁移。
12. `compacted_through_revision` 墓碑语义与所有非零 fail-closed 读者行为与今日完全一致。
13. pack 连续、不重叠、覆盖 `[1, packed_through_revision]`；水位在 head 锁下单调推进。
14. Server/Broker 共享 schema 校验保持一致。

## 10. 验证计划

- **H2 单元**：inline 路径字节不变（回归）；S1a 状态机与 S1b pack 生命周期经 `InMemoryObjectStore` / `O4FileObjects` fixture（含 `openRange`）。
- **mysql-integration（真实 MySQL 8.4，disposable）**：allocate/finalize/commit/read/GC 事务性；并发 writer + compaction + restore + lifecycle settle（#13800 快照窗口）；crash 矩阵：发布前 PUT、删除前发布、删一半、删除后 pack 丢失（fail-closed）、retirement 竞态。
- **wire 兼容**：TS fixture 断言有/无 pack 时 `/transactions` 与 `/restore` 字节与 digest 逐字节一致；TS 零改动跑通 D1b close/reopen。
- **进程级**：扩展 managed-continuation-failover 多进程模式：settle 闭包含 >64 KiB OSS 资源与 checkpoint（S1a，D2 exit condition）及 packed 历史（S1b）；kill Java/Harness、删 local home，替换 owner restore 并完成第二 Turn。
- **真实 OSS qualification（独立 gate）**：Range GET、私有 + 从未 versioning bucket、forbid-overwrite、SSE、slow-reader 与大对象限制；InMemory 证据不是部署证据。
- **指标**：first-token 延迟、commit p50/p95/p99、restore 延迟、MySQL bytes/turn 与回收字节、压缩比、pack 数/体积、OSS requests/bytes/turn、cache hit（durable-store §10 清单）。

## 11. 分期与 exit

| 阶段   | 内容                                                                    | Exit                                                                  |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| S1a P1 | Java 协议 + 写/读路径；除 namespace CHECK 外零 DDL；opt-in；inline 不变 | H2 + mysql-integration crash 矩阵绿                                   |
| S1a P2 | TS 客户端 + shared fixture + D2 进程证明                                | 含 OSS 资源 + checkpoint 的 settle 闭包 failover（D2 exit condition） |
| S1a P3 | 孤儿 GC + 维护工具 + 真实 OSS qualification + 指标                      | 生产 qualification gate                                               |
| S1b P1 | pack 构建/验证/发布 + 目录 + 水位；不删 blob、不改读者（双副本）        | 并发 writer 下 mysql-integration 绿                                   |
| S1b P2 | JournalRecordReader + openRange 契约 + 全插入点 + 维护工具 + wire 证明  | 进程级 packed-closure failover                                        |
| S1b P3 | grace 删除 + 孤儿 GC + retirement pack 清理 + 指标 + qualification      | 生产 gate + 回收字节实测                                              |
| A3/A4  | 独立小 schema 变更                                                      | 聚焦 store 测试 + list/queue fixture 更新                             |

依赖：S1a 与 S1b 可并行；共享 store bean；`openRange` 随 S1b P2 落地。S1b 前置：MySQL bytes/turn 与表规模基线测量（measurement-first，durable-store §10）。

## 12. 部署 gate

- 启用 S1b 删除前运维确认实际备份复制 lag < 配置 grace（E4；今日无明确 SLA）。
- bucket：私有、从未 versioning、SSE 启用、forbid-overwrite 生效；启动 `validateConfiguration()`。
- 私有 journal/resource 表与公共读者使用独立数据库 role（durable-store §11）。
- 宣称 cross-Pod recovery 前做覆盖 MySQL 与 OSS 的一致性备份/恢复演练（D3）。

## 13. 证据索引

门/限额：`JournalCommit.java:762-772`、`ManagedSessionStoreModels.java:17-28,53-54`。写入：`JournalCommit.java:338,451`、`JournalResourceWrites.java:82-84,174-176,291-294`。外置引用模板：`ToolPublicationAdmissionStore.java:492-521`。读取门：`JournalStoreRows.java:477`；mapper/record `:40-66,119,677,690,703`。路由：`ManagedSessionStoreController.java:199,214,234,246,258,294`；`JdbcManagedSessionStore.java:250,256-259`；`JournalHistoryQueries.java:36-44,46-127,129`；`ManagedSideQueryStore.java:231`。墓碑：`ManagedSessionRetirementStore.java:117-135`；读者 `JdbcWakeRecoveryStore.java:112-114,133-139`、`JdbcWorkspaceLifecycleStore.java:120-131,169,482`、`WorkspaceCsiCheckpointSnapshotStore.java:148`、`AgentExecutionOperations.java:225-245,805`、`ManagedRuntimeRetentionGuard.java:72`、`JdbcChildResultRelayStore.java:505,513`、`WorkspaceCsiApplicationInventory.java:2874`。其余读者：`SideQueryConversation.java:82`、`WorkspaceCsiApplicationInventory.java:1257,2598,2880-2882`、`WorkspaceRecoveryReader.java:88-123`、`ManagedNativeJournalSnapshots.java:515-560`。GC：`ManagedProjectionResourceCollector.java:67,118`。Store：`ToolPublicationObjectStore.java`、`AliyunToolPublicationObjectStore.java:25,33-52,72-84,86-90`、`AliyunToolPublicationStorageAutoConfiguration.java`、实现者见 §3.3。配置：`ManagedAgentProperties.java:738-763`。Schema：V1 `ma_session:8-95`、`ma_user_message_queue:114-127`、`ma_session_head:185-233`、`ma_session_journal_tx:235-274`、`ma_resource:438-478`、`ma_resource_ref:484-508`、`ma_request_receipt:619-666`。Projection/校验：`ManagedSchemaProjection.java:137,147`、`WorkspaceCsiApplicationInventory.java:254,267,882`。List/queue：`AgentStoreRows.java:99,104-127`、`JdbcManagedUserMessageStore.java:92-99,103-121,131,168,186-190,235,259-261`。TS：`http-managed-session-store.ts:363-369,1321-1326,1399,3237`、`managed-session-authority.ts:658`。设计：`2026-09-21-managed-session-durable-store.md` §7-§12、`2026-09-25-managed-session-typescript-foundation.md:15`、`2026-10-16-managed-tool-storage-interface.md`、`2026-09-20-managed-agent-storage-event-architecture.md:303`；README §232/§236/§655-657。
