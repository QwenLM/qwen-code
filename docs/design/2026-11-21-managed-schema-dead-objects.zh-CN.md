# 删除 Managed schema 中的无用对象

[English](2026-11-21-managed-schema-dead-objects.md) | [简体中文](2026-11-21-managed-schema-dead-objects.zh-CN.md)

## 状态与范围

- 状态：**已实现**，由新增本文档的同一变更完成。
- 日期：2026-11-21。源码基线：`origin/main` 的 `3d7571f2db`。
- 范围：共享的 `V1__managed_schema.sql`、`ManagedSchemaProjection`、`ManagedSchemaRows`、`JdbcManagedActionStore` 中的 Action 决定查询，以及两个 verification 测试。适用发布前策略：原地修改唯一的 V1 baseline，并重建开发库；不新增 V2+ 迁移。
- 背景：与[删除冗余存储键](2026-11-20-managed-storage-redundant-keys.zh-CN.md)同类。若不先删，[身份去哈希](2026-11-20-managed-identity-varchar-dehash.zh-CN.md)会对其中几项做转换或重定义；先删掉可以缩小那个批次。

## 问题

V1 baseline 里仍有一些 schema 对象：要么没有任何代码写入或读取，要么它提供的保证已由另一条约束提供。每一项都占存储、在每次写入时维护索引，还会让去哈希为一个没有作用的对象做转换。

## 现状

### A. 保证已被别处提供的生成唯一列

1. **`ma_session.public_session_id` 与 `uk_ma_session_public_session_id`。** 该列对 `PUBLIC` 行生成为 `session_id`，对 `CONTROL` 行为 `NULL`，因此这条唯一键让 `PUBLIC` ID 跨租户唯一。没有 SQL 读取该列。`AgentSessionAdmissions` 中仅有的两个 `PUBLIC` 写入点（顶层与子 Session 创建）都用 `UUID.randomUUID()` 生成 `session_id`。没有生产路径把 `CONTROL` 行改成 `PUBLIC`，也没有把 Session 复制到另一个租户。Harness 按 ID 索引 Session、不区分租户，它依赖的检查在 `JdbcHarnessPlacementStore.assign`：暴露句柄之前，统计所有租户中该 `session_id` 的 `ma_session` 行数，不唯一则以 `harness_session_scope_ambiguous` 拒绝。这项检查同时覆盖 `PUBLIC` 与 `CONTROL` 行。
2. **`ma_request_receipt.decision_scope_key` 与 `uk_ma_decision_slot`。** `JdbcManagedActionStore` 是唯一的 `ACTION_DECISION` 写入点，它把 `scope_key` 设为 action scope `key(Session scope, actionId, inputRevision)`，`idempotency_digest` 设为 `key(actionId)`，`receipt_key` 设为 `receiptKey(ACTION_DECISION, tenant, SESSION, actionScope, actionId)`。因此同一 `(tenant_key, scope_key)` 的两条决定，`idempotency_digest` 与 `receipt_key` 都相同，`uk_ma_request (namespace, tenant_key, scope_key, idempotency_digest)` 和 `uk_ma_request_receipt_business_key` 已经会拒绝第二条。

### B. 没有任何写入的列

这些列只出现在 `ManagedSchemaProjection` 中（`provider_id` 另外出现在 `ManagedSchemaRows.IDENTITIES`）。没有生产代码写入，没有读取方使用查出的值，也没有 trigger 或基于 projection 的插入填充它们。最后读取它们的是 #16910 删除的 CSI inventory。

| 列                                                                                   | 说明                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `ma_delivery.source_record_key`、`source_revision`、`provider_id`、`payload_version` | `payload_version` 永远是默认值 `1`                                 |
| `ma_operation.payload_version`                                                       | 永远是 `1`；唯一的其他引用是 `ck_ma_operation_generation` 中的一项 |
| `ma_operation_work.payload_version`                                                  | 永远是 `1`                                                         |
| `ma_message.tool_call_key`                                                           |                                                                    |
| `ma_output_capture.manifest_sha256`                                                  | 实际使用的摘要是 `seal_manifest_sha256`                            |
| `ma_runtime_binding.first_activation_journal_revision`                               |                                                                    |

### C. 冗余索引

| 索引                                                              | 由谁覆盖                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `idx_ma_work_page (operation_key, work_kind, target_key)`         | `uk_ma_operation_work_business_key`，列及顺序完全相同 |
| `idx_ma_work_session_page (operation_key, work_kind, session_id)` | `idx_ma_work_pending` 的左前缀                        |
| `idx_ma_operation_claim (operation_kind, state, claim_until)`     | `idx_ma_operation_result_lease` 的左前缀              |

没有语句在 hint 中引用这些索引，也没有测试在执行计划中断言它们。

## 目标与非目标

目标：

- 删除 A、B、C 中的全部对象。
- 保留所有隔离检查、加锁目标与拒绝路径。

非目标：

- 承担真实保证的生成唯一列保留：`ma_side_query.active_slot`（每个 actor 与 kind 只有一个活跃 side query；准入先做一次不加锁的读取）、`ma_operation.publication_command_id`（调用方提供的输出命令 ID，由三种 operation kind 共用）、`ma_workspace.default_tenant` 与 `ma_journal_pack.active_from_revision`。
- `ma_session` 的哈希键归身份去哈希处理。
- 不改公开 API、序列化载荷或加锁顺序。

## 方案

1. DDL：删除 A、B、C 中的列、约束与索引。`ck_ma_operation_generation` 去掉 `payload_version > 0` 这一项。
2. 从 `ManagedSchemaProjection` 中删除同样的列，从 `ManagedSchemaRows.IDENTITIES` 中删除 `public_session_id` 与 `provider_id`。
3. `JdbcManagedActionStore` 中查找已保留决定的查询，过滤条件由 `decision_scope_key = ?` 改为 `scope_key = ?`。`namespace` 与 `tenant_key` 已绑定，因此会使用 `uk_ma_request` 的左前缀。两列都是 PAD SPACE collation 下的 `CHAR(64)`，action scope 是 64 个字符的十六进制摘要，所以旧生成列里的 `RTRIM` 不改变任何结果。
4. 测试：`ManagedSchemaTest.retainsBytePreciseIdentitiesAndSeparatePublicUniqueness` 改名为 `retainsBytePreciseTenantScopedSessionIdentities`，并断言 `PUBLIC` ID 可以在另一个租户中重复。`ManagedSessionHistoryTest` 中引用旧规则的注释同步修正。

## 设计决策

- **删除 `public_session_id`，而不是改成 `UNIQUE (session_id)`。** `CONTROL` 行可以合法地跨租户共用 ID（`HarnessPlacementStoreTest` 固定了由此产生的拒绝）。更严重的是，`ToolPublicationRetentionStore.lockSessionRoot` 用 `INSERT … ON DUPLICATE KEY UPDATE` 插入 `CONTROL` 行；不区分租户的唯一键会让这条语句更新另一个租户的行，随后又查不到自己的行。
- **删除 `decision_scope_key`，而不是为去哈希重定义它。** 它没有在 `uk_ma_request` 之外提供任何保证，而去哈希本来就会在原始列上重建 `uk_ma_request`。
- **合为一个变更。** 所有项都是对同一个 V1 文件和 projection 枚举的删除，没有需要分阶段的共享行为。

## 锁与并发影响

- 加锁目标与顺序不变。
- 向 `ma_session`、`ma_request_receipt`、`ma_operation` 插入时少维护一个二级索引，向 `ma_operation_work` 插入时少维护两个，因此占用的索引记录锁与间隙锁更少。
- 并发 Action 决定：第二条 receipt 插入仍会在 `uk_ma_request_receipt_business_key` 和 `uk_ma_request` 上冲突，与之前一样被拒绝。
- 跨租户的 `PUBLIC` ID 冲突（只可能由 UUID 碰撞引起）现在在 Harness 放置时被拒绝（`harness_session_scope_ambiguous`），而不是在插入时。

## 风险

- 将来若有写入方用调用方提供的 ID 创建 `PUBLIC` Session，必须自行做跨租户检查。放置时仍会拒绝有歧义的 ID。
- 将来若有 `ACTION_DECISION` 写入方使用调用方选择的幂等键，需要自行保证单一决定。
- `packages/sdk-java/managed-kubernetes-archive` 仍引用部分被删除的列。它不在 Maven reactor 和 CI 中，不做修改。
- 开发库必须重建。

## 验证

- H2：`ManagedSchemaTest`、`ManagedSchemaProjectionTest`、`ManagedSchemaCatalogTest`、`ManagedSchemaRowsTest`、`ManagedActionStoreTest`、`ConsolidatedActionStoreTest`、`ManagedActionsTest`、`ManagedSessionHistoryTest`，以及所有生产模块的 Checkstyle。
- MySQL 8.4：`ManagedSchemaMySqlIT`，以及 CI 中完整的 `mysql-integration` profile。

## 验收标准

- V1 中不再包含任何被删除的列、约束或索引，H2 与 MySQL 上的 catalog 校验通过。
- `packages/managed-agent-server` 下没有生产源码引用它们。
- 聚焦的 H2 测试通过，且在验收前 CI 中的 MySQL profile 通过。
