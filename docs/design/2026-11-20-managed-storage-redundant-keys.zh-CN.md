# 删除冗余的 storage 键

[English](2026-11-20-managed-storage-redundant-keys.md) | [简体中文](2026-11-20-managed-storage-redundant-keys.zh-CN.md)

## 状态与范围

- 状态：**提案**。本文档不改动任何代码或 schema。
- 日期：2026-11-20。源码基线：`origin/main` 的 `18846c6e4b`。
- 范围：`packages/managed-agent-server`（persistence、runtime-broker persistence、verification）与共享的 `V1__managed_schema.sql`。适用 release 前政策：原地编辑单一 V1 基线并重建开发 catalog；不加 V2+ 迁移。
- 背景：这是身份去哈希增量（PR #17927）延后的后续工作。那个 PR 删除的哈希键只用来重复同表已有的唯一键，且没有其他表、游标或锁序使用。本文的两项删除冗余性质相同，但位于 storage 协调路径上，且改动大量测试 fixture，所以需要单独的改动和 MySQL 证据。

## 问题

两张 storage 表各带一个与业务键识别完全相同行的第二唯一键：

1. `ma_storage` 同时有 `uk_ma_storage_business_key (alias_key)` 与 `uk_ma_storage_alias (tenant_key, storage_key)`。由于 `alias_key = key("qwen-csi-alias/1", tenant_id, storage_id)`、`tenant_key = valueKey(tenant_id)`、`storage_key = valueKey(storage_id)`，两个键都是同一个 `(tenant_id, storage_id)` 的函数。
2. `ma_storage_owner` 同时有 `uk_ma_storage_owner_business_key (storage_key)` 与 `uk_ma_storage_owner_physical (physical_key)`。每个写入方都往这两列写同一个值。

每个多余的键都要付出一列、一个唯一索引、每次插入多一次重复检查，以及一条可以锁住同一行的第二条索引路径。storage 锁序测试已经把这第二条路径标为隐患（`StorageRowLockOrderMySqlIT.migrationAbortClearsTheFenceThroughTheAliasIndex`）。

## 现状

### `ma_storage`：表合并留下的两套键

[schema 整合](2026-10-13-managed-schema-consolidation.zh-CN.md)把 `qwen_runtime_storage_fence`（主键 `(tenant_key, storage_key)`）与 `managed_workspace_csi_registration`（主键 `alias_key`）合并为 `ma_storage`，两套键都保留了下来。

写入方。全部 5 个生产 INSERT 都从同一个 `(tenant, storage)` 写入两套键：

| 写入方                                             | 语句形态                           |
| -------------------------------------------------- | ---------------------------------- |
| `JdbcRuntimeBindingRepository.requestStorageFence` | `INSERT … ON DUPLICATE KEY UPDATE` |
| `WorkspaceMigrationStore`（fence 插入）            | `INSERT … ON DUPLICATE KEY UPDATE` |
| `WorkspaceStorageGuard`（本地注册 upsert）         | `INSERT … ON DUPLICATE KEY UPDATE` |
| `JdbcSshWorkspaceStore`（SSH fence-only 行）       | `INSERT … ON DUPLICATE KEY UPDATE` |
| `ExternalStorageRegistrationStore`（外部注册）     | 普通 `INSERT`，重复 → 409          |

`tenant_key` / `storage_key` 的读取方只有两处：

- `RuntimeAdmissionFences.storageFence`：不加锁的 `SELECT … WHERE tenant_key = ? AND storage_key = ?`，随后复核原始 `tenant_id` / `storage_id`，哈希碰撞时抛异常。调用方是 `RuntimeAdmissionFences` 与 `JdbcRuntimeBindingRepository` 中的准入检查、`requestStorageFence` 以及 `isStorageFenced`。
- `ExternalWorkspaceMaterializationStore`：`COUNT(*)`，条件为 `alias_key = ? AND tenant_key = ? AND storage_key = ? AND physical_key = ? AND registration_revision = ?`。同一事务此前已用 `alias_key = ? AND tenant_id = ? AND storage_id = ? … FOR UPDATE` 锁住这一行，所以这两个哈希谓词没有增加任何约束。

`RuntimeAdmissionFences.storageFenceKey()` 没有其他生产调用方。`ManagedSchemaProjection.STORAGE` 列出了这两列。没有任何 join、游标、`ORDER BY`、`FORCE INDEX` 提示、其他表或 TypeScript 代码使用这两列或 `uk_ma_storage_alias`。`alias_key` 本身保留：`ma_runtime_binding.storage_alias_key` 引用它，`LocalStorageOwners` 也按 `alias_key` 顺序锁 alias。

### `ma_storage_owner`：`physical_key` 恒等于 `storage_key`

整合设计规定 `storage_owner`「按 canonical physical identity 建键」。`storage_key` 源自旧的 execution lease 表，`physical_key` 是后来为 CSI 加的。如今两列存的都是 canonical physical identity：

- 4 个 INSERT（`ExternalStorageRegistrationStore`、`JdbcSshWorkspaceStore`，以及 `WorkspaceStorageGuard` 中的两个）都给两列绑定同一个值。
- 唯一会改动这两列的 UPDATE 在 `WorkspaceIdentityReattestationStore`，它把两列设为同一个 `next`。
- 没有写入方只写其中一列，也没有写入 `NULL` 的。
- alias 行通过 `ON o.storage_key = s.physical_key` 关联到 owner。

`ma_storage_owner.physical_key` 的读取方：

| 类型                                         | 位置                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL 过滤                                     | `ExternalStorageRegistrationStore` 预检查（`WHERE physical_key = ?`）；`ExternalWorkspaceMaterializationStore` 与 `WorkspaceIdentityReattestationStore` 的三处读取（`storage_key = ? AND physical_key = ?`；物化读取与其中一处 reattestation 读取带 `FOR UPDATE`） |
| `WHERE storage_key = ?` 之后的 Java 等值比较 | `LocalStorageOwners.requireOwner`、`WorkspaceStorageGuard.row`、`RuntimeAdmissionFences` 物理准入、`JdbcRuntimeBindingRepository` holder 锁、`JdbcExternalWorkspaceOwnership` owner 检查、`WorkspaceMigrationAdmission` 外部物理准入                               |
| projection 与证据                            | `ManagedSchemaProjection.STORAGE_OWNER`；`WorkspaceMaintenanceRecovery.MOUNT_FIELDS`，它构造恢复证据记录、之后再比对的 `mount` 快照                                                                                                                                |

有两个测试往 `physical_key` 写入不同的值来模拟漂移（`LocalStorageAliasTest.driftedPhysicalMappingAndCopiedMarkersCannotAuthorizeAnAlias` 与 `WorkspaceMigrationAdmissionTest.localAliasesCanShareAnOwnerButCannotNameADifferentPhysicalIdentity`）。没有任何生产路径能产生这种状态。

## 目标与非目标

目标：

- 删除 `ma_storage.tenant_key`、`ma_storage.storage_key` 与 `uk_ma_storage_alias`。
- 删除 `ma_storage_owner.physical_key` 与 `uk_ma_storage_owner_physical`。
- 保留所有隔离检查、原始身份复核、锁目标与 fail-closed 路径。

非目标：

- `ma_storage.alias_key` 与 `ma_storage_owner.storage_key` 保留。把它们换成原始列属于身份去哈希的工作。
- physical identity 本身是否继续用摘要，是去哈希的问题，本文不作决定。
- 不把 `ma_storage_owner.storage_key` 改名为 `physical_key`。
- 不改公共 API 或序列化 payload。

## 方案

### A. `ma_storage`

1. DDL：删除 `tenant_key`、`storage_key` 与 `uk_ma_storage_alias`。
2. `storageFence` 改为 `WHERE alias_key = ?`，绑定 `storageAliasKey(tenantId, storageId)`；保留原始 `tenant_id` / `storage_id` 复核与碰撞异常。
3. 物化路径的 `COUNT(*)` 把 `tenant_key = ? AND storage_key = ?` 换成 `tenant_id = ? AND storage_id = ?`，谓词集合不变，只是不再用哈希。
4. 5 个 INSERT 不再写这两列。`ON DUPLICATE KEY UPDATE` 行为不变：以前重复总是同时命中两个唯一键，现在只命中 `alias_key`。
5. 删除 `storageFenceKey()`，并从 `ManagedSchemaProjection.STORAGE` 去掉这两列。

### B. `ma_storage_owner`

1. DDL：删除 `physical_key` 与 `uk_ma_storage_owner_physical`。
2. SQL 过滤：在 `storage_key = ?` 已绑定同一个值的地方去掉 `AND physical_key = ?`；注册预检查改为 `WHERE storage_key = ?`；`SELECT physical_key` 改为 `SELECT storage_key`。
3. Java 等值比较改为与 `storage_key` 比较，而不是删除。该列是 `utf8mb4_bin`（PAD SPACE）下的 `CHAR(64)`，`WHERE storage_key = ?` 会忽略尾随空格；真正保证字节精确匹配的是 Java 的 `equals`，所以要保留。
4. reattestation 的 UPDATE 只设置 `storage_key`。
5. 从 `ManagedSchemaProjection.STORAGE_OWNER` 与 `WorkspaceMaintenanceRecovery.MOUNT_FIELDS` 中去掉 `physical_key`。恢复 `mount` 比对的两侧都由这个列表构造，所以两侧保持一致；快照里仍有 `storage_key`。

### 测试

- 约 20 个测试文件（61 行）不再写 `tenant_key` / `storage_key` 或调用 `storageFenceKey`；约 14 个文件不再写 `ma_storage_owner.physical_key`。
- 两个漂移测试改为测试仍可能发生的漂移，即 alias 映射漂移：把 alias 的 `ma_storage.physical_key` 设成一个没有 owner 行的值。这仍会走到 fail-closed 分支：`row(physical)` 为 `null` 时 `WorkspaceStorageGuard.verify` 返回 `unverified`，`LocalStorageOwners.requireOwner` 找不到 owner。
- `SshWorkspaceStoreTest`（替换 owner 键）与 `ExternalWorkspaceOwnershipTest`（读取 `physical_key`）改用 `storage_key`。
- 更新 `StorageRowLockOrderMySqlIT` 中提到 `uk_ma_storage_alias` 的注释；它对 `uk_ma_storage_business_key` 的执行计划断言不变。

## 设计决策

- **保留 `ma_storage_owner.storage_key`，删除 `physical_key`。** `storage_key` 是 `NOT NULL`，是 `ManagedSchemaTest` 钉死的业务键，被 `ma_runtime_session.execution_storage_key` 引用，也是每个 owner `FOR UPDATE` 的过滤列。反过来删它会重写 owner 的加锁路径。它与其他表 `physical_key` 的命名不一致只是表面问题，现有 join `o.storage_key = s.physical_key` 已经表达了这层关系。
- **保留 `alias_key`，删除 `(tenant_key, storage_key)`。** `alias_key` 是业务键，被 `ma_runtime_binding` 引用，并决定 alias 的锁序；那一对列只有两个读取方，没有结构性作用。
- **保留复核。** 哈希查找之后的原始身份复核，以及 PAD SPACE 查找之后的字节精确 Java 比较，都保留，只是换了比较对象，不删除。
- **一个 PR、两个 commit，基于 `main`。** A 与 B 共享 fixture（`WorkspaceTestStorage`、锁序 IT），但彼此独立。该 PR 不依赖 #17927，与之重叠的只有 V1 和 `ManagedSchemaProjection` 的不同 hunk。

## 锁与并发影响

- 锁目标不变，锁住的还是同样的行。
- A：`INSERT … ON DUPLICATE KEY UPDATE` 只检查一个二级唯一索引而不是两个，全新插入时持有的索引记录锁和 gap 锁更少。`storageFence` 是不加锁读。物化路径的 count 执行时，事务已经通过 alias 索引持有该行锁。之后不再有任何行能通过第二个唯一索引被锁住。
- B：`ExternalWorkspaceMaterializationStore` 的一处读取与 `WorkspaceIdentityReattestationStore` 的一处读取目前用 `storage_key = ? AND physical_key = ? … FOR UPDATE` 锁 owner，优化器可以任选其中一个唯一索引。改动后它们总是走 `uk_ma_storage_owner_business_key`，与其他所有 owner 加锁一致。
- 没有新的锁序，也没有新的锁域。按[锁清单](2026-11-12-managed-agent-lock-inventory.zh-CN.md)的要求，改动过的语句仍需要 MySQL 证据（见验证）。

## 风险

- 约 30 个测试文件会被机械修改。两个漂移测试的改写是唯一的语义性测试改动，必须保留 fail-closed 断言。
- 改动前记录的恢复证据包含 `physical_key`，改动后比对不会相等。release 前政策会重建 catalog，所以可以接受。
- `packages/sdk-java/managed-kubernetes-archive` 仍引用旧列名。它不在 Maven reactor 和 CI 中，不做改动。

## 验证

- H2，聚焦改动的类及其使用方：`ManagedSchemaTest`、`ManagedSchemaCatalogTest`、`LocalStorageAliasTest`、`WorkspaceMigrationAdmissionTest`、`WorkspaceMigrationStoreTest`、`ExternalStorageRegistrationTest`、`ExternalWorkspaceMaterializationTest`、`ExternalWorkspaceOwnershipTest`、`WorkspaceIdentityReattestationStoreTest`、`SshWorkspaceStoreTest`、`SessionWorktreeStoreTest`、`ManagedSessionPhysicalFenceTest`、`JdbcPhysicalStorageReleaseTest`、`ChildWorkspaceStoreTest`、`JournalLockContractTest`、`WorkspaceLifecycleStoreTest`、`ManagedWorkspaceAdmissionTest`、`RuntimeMaintenanceRecoveryTest`、`WorkspaceSchemaConsolidationTest`，以及全模块 Checkstyle。
- 变异校验：在 `storageFence` 中绑定错误的 alias，并在一处改写后的 owner 检查中绑定错误的键；fence 与 owner 相关测试必须失败。
- MySQL 8.4（CI 完整检查或一次性实例）：`StorageRowLockOrderMySqlIT`、`ManagedLockScopeConcurrencyMySqlIT`、`WorkspaceMigrationMySqlIT`、`ToolPublicationStorageMySqlIT`、`WorkspaceQueryScaleMySqlIT`、`ManagedSchemaMySqlIT`。记录 `EXPLAIN` 证据，证明 `storageFence` 使用 `uk_ma_storage_business_key`，两处 owner `FOR UPDATE` 读取使用 `uk_ma_storage_owner_business_key`。
- `HostedMonitorRunFaultGatesIT` 在 CI 的 Hosted 故障 profile 中运行。

## 验收标准

- V1 中不再有 `ma_storage.tenant_key`、`ma_storage.storage_key`、`uk_ma_storage_alias`、`ma_storage_owner.physical_key`、`uk_ma_storage_owner_physical`；catalog 校验在 H2 与 MySQL 上通过。
- 没有生产源码引用已删除的列或 `storageFenceKey`。
- 所有原先与 `physical_key` 的 Java 比较都改为与 `storage_key` 比较；所有原始身份复核都保留。
- 两个漂移测试对 alias 映射漂移断言 fail-closed。
- 聚焦 H2 测试本地通过；验收前，列出的 MySQL IT 在 MySQL 8.4 上通过。

## 未决问题

- `EXPLAIN` 检查应作为 `StorageRowLockOrderMySqlIT` 的永久断言，还是只作为一次性的 PR 证据？提议：为 owner `FOR UPDATE` 路径加一条断言，因为它改变了可选的索引；其余作为 PR 证据。
