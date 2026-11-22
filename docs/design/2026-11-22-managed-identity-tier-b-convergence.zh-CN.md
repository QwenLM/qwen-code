# Managed 身份 Tier B 收敛

[English](2026-11-22-managed-identity-tier-b-convergence.md) | [简体中文](2026-11-22-managed-identity-tier-b-convergence.zh-CN.md)

- 状态：**已批准，实施中**。维护者已确认收敛预算（2026-11-22）与「写设计文档＋分批实施」
  路径。基于 [Tier A 去哈希](2026-11-20-managed-identity-varchar-dehash.zh-CN.md) 与
  统一拒绝尾随空格策略。
- 日期：2026-11-22。

## 问题

Tier A 已把简单的服务端铸造身份转为有界 `VARCHAR`。剩余 Tier B 列仍用 `VARBINARY`，
契约上限是懒散的 512 字节（或 2048 字节）。该上限是上界，不是真实值域：追溯实际外部
生产者可知大多数值远短于此。处处保留 512 会膨胀索引，并迫使若干列保留二进制或重设计
索引。从真实生产者收敛每列预算可消除这些阻塞。

## 当前状态

- 表默认 `utf8mb4` / `utf8mb4_bin`（PAD SPACE）。统一策略：所有身份准入拒绝尾随空格，
  因此合法身份不会发生 PAD SPACE 折叠。大小写敏感由 `utf8mb4_bin` 保持。
- 索引字节规则：utf8mb4 `VARCHAR(N)`/`CHAR(N)` = 4N 字节；`VARBINARY(N)` = N；
  `BIGINT` = 8；`TINYINT` = 1。InnoDB 键上限 **3072**。前缀长度对 `VARBINARY` 按字节、
  对 `VARCHAR` 按字符。
- H2 2.3.232 `VARCHAR(n)` 按 UTF-16 unit 计长；MySQL 按 code point。下文每个预算保持
  N ≥ 现有 UTF-16-unit 准入上限，使两引擎都 fit。
- canonical 引用（`owner_ref`、`scope_ref`、`operation_ref`、`command_ref`、
  `request_id`、`physical_id`、`deletion_operation_ref`…）是精确 ASCII 百分号编码的
  `ManagedIdentityRef` 元组，带 fail-closed 字节预算。保留 `VARBINARY`；4× 膨胀无收益
  且破坏预算。

## 目标

- 将 Tier B 身份列收敛到由真实生产者推导的预算。
- 消除迫使保留二进制/重设计索引的索引宽度阻塞。
- 准入保持 fail-closed（有界、well-formed、无尾随空格）。

## 非目标

- 转换 canonical `*_ref` 协调键、摘要、密文、对象键。
- 把 opaque 模型 `callId` 收紧到收敛界以下，或把第三方平台 id 限制到规格界以下。
- 去哈希 main 新增的 `ma_runtime_stage` hash-key 设计（verbatim 保留自 #17953；单独跟进）。

## 收敛预算

| 类别 | 列 | 预算 |
|---|---|---|
| 我们的代码铸造 | `item_id`、`content_part_id`、`transaction_id`、`command_id`、`activation_id`、`writer_id`、`ma_session_head.operation_id`、`source_scope_id`、`parent_child_run_id`、ma_channel_segment `delivery_id`/`segment_id`、PR `binding_id`、`idempotency_key`（多数命名空间） | `VARCHAR(128)` |
| 复合 resource 铸造 | `resource_id`（ma_resource **及** ma_resource_ref） | `VARCHAR(256)` |
| childRunId union | `record_id`、`child_run_id`、`execution_call_id`、`delivery_id`（CHILD_RESULT） | `VARCHAR(256)` |
| 短确定值 | `isolation_key` | `VARCHAR(64)` |
| 复合契约安全 | `provision_request_id` / `loss_evidence_id` | `VARCHAR(160)` / `VARCHAR(192)` |
| GitHub 规格 | PR `owner` / `repo` | `VARCHAR(64)` / `VARCHAR(128)` |
| 平台规格 | `account_id`、`sender_id`、`chat_id`、`thread_id` | `VARCHAR(256)` |
| 维护者选定 128 | `model_id`、`tool_call_id`、`runtime_instance_id`、`runtime_lease_id` | `VARCHAR(128)` |
| 保留二进制 | 所有 canonical `*_ref`、摘要、密文、对象键 | `VARBINARY` |

### childRunId union 理由

`childRunId = hostedPromptKey(≤64) + ":" + callId`。`tool_call_id` 准入收紧到 128 后，
`childRunId ≤ 64 + 1 + 128 = 193`，故 `VARCHAR(256)` 覆盖且有余量。reconcile 现有 gate
不一致：child-result relay gate `childRunId ≤ 128`（`requireOperationId`），而
child-operation 路径允许 320；统一到收敛的 256 界。

## 生产者证据与准入收紧

- `item_id`/`content_part_id`：`EventIdentity` 铸造 `item_<turnId>_assistant`（≤52）、
  `item_tool_<UUID>`（46，callId 已 digest）、`part_<turnId>_<type>_<seq`（≤74）。在事件
  摄入处对 harness 供给的 `data.itemId`/`contentPartId` 加显式 ≤128 无尾随空格校验
  （当前无校验）。
- `resource_id`：UUID(36) / sha256hex(64) / snapshot-page(101)，但复合铸造超 128：
  message-body `message:`+64hex+`:rev:`+64hex（139+，`AgentMessageProjection`）与
  workspace-proof `workspace-proof:`+ownerKey+`:`+64hex（~170，`WorkspaceEvidenceResources`）。
  收敛到 **256**，非 128。收紧 `JournalStoreRows.validateStableId`（共享，亦覆盖
  transaction/command/writer/activation/head.operation_id）。
- `record_id`/`child_run_id`/`delivery_id`：域 id 经 `ManagedExtensionRecords.id`
  （≤512 字节 NFC）；在此加尾随空格拒绝（共享，覆盖 delivery records）。
- `model_id`：catalog 文本；真实 id ≤30（registry 最长 `qwen3-coder-480b-a35b-instruct`），
  自定义名 ≤~80。收敛到 128 **字符**（把字节校验改为字符界）。需一起动：
  `ManagedSessionModelConfigs.catalog()`、`ApiModels @Size`、易漏的 child-snapshot 校验
  （`AgentSessionAdmissions` ~:383，绕过 catalog 成员校验）、`SessionModelConfig`、
  中英文配置参考文档。
- `tool_call_id`：原始模型 function-call id；已知 provider ≤~45，最坏可推导形状 ~90。
  收敛到 128，用 `requireToolCallId`（Java `ToolExecutionRecord`）、TS
  `managed-tool-protocol` `boundedId(...,512)→128`、以及 tool-result manifest 解析中的
  专用 callId 界（不要动共享 `maxIdBytes`）。跨语言 fixture 契约由
  `managed-tool-result-v1.fixtures.json` 钉住。
- `runtime_instance_id`/`runtime_lease_id`：动态 = bindingId(≤128)/UUID(36)，经 seed +
  recovery 等值证明；静态运营 slug ≤~64。经 `RuntimeLease` validator 收敛到 128；静态
  配置 >128 在启动时 fail-fast。文档 512→128。
- `isolation_key` = harnessSessionId（UUID36）；经 `RuntimeProvisionRequest` 收敛到 64。
- PR `owner`/`repo`：GitHub login ≤39 / repo ≤100（规格在外部，标注）；`@Size` 对齐
  64/128。`binding_id` = `prb-`+sha256(68)，不在索引。
- 平台 `account/sender/chat/thread`：规格界 256（覆盖 RFC-5321 email 254）；收紧 channel
  API `@Size`/TS 512→256。平台规格不在仓库——标注。

## 索引核算（收敛后；canonical ref 保留 VARBINARY）

| 索引 | 收敛字节 | 原 | 结果 |
|---|---:|---:|---|
| `uk_ma_resource_ref_business_key`（resource_id@256） | 2072 | 3096 | 解决；ma_resource_ref.resource_id 可转 |
| `idx_ma_message_execution`（item_id@128） | 1792 | 4096 | 解决 |
| `uk_ma_channel_segment_identity`（@128） | 1680 | 4752 | 解决 |
| `uk_ma_pr_watch_binding_business_key`（owner@64/repo@128） | 1432 | 4760 | 解决 |
| `idx_runtime_binding_scope`（isolation@64） | 2432 | 4224 | 解决 |
| `idx_ma_resource_delete_intent`（resource_id@256） | 2576 | 3600 | 解决 |
| `uk_ma_delivery_identity`（delivery@256/scope@128） | ≤2064 | 4368 | fit |

收敛预算下七个问题索引全部 ≤3072。

## P0 — 独立 MySQL bug 修复

完全删除 `idx_ma_record_identity`。其 `record_id /*!50000 (1024) */` 前缀是在 512 字节列
上的 1024 字节前缀 → MySQL error 1089（H2 忽略版本注释，故 H2 套件通过）。去掉前缀后它与
`uk_ma_session_record_business_key` 重复。VARCHAR 转换修不好（VARCHAR 前缀按字符）。
无论是否收敛都必须做。

## 死列

main 的死对象删除已删 `ma_delivery.provider_id`、`ma_session_record.prompt_id`/`turn_id`、
`ma_message.tool_call_key`、`public_session_id`、`manifest_sha256`、`decision_scope`、
`payload_version`、`source_record_key`。Tier B 无需再删死列；不要重新加回这些。

## 贯穿迁移机制（每批）

1. hex 字面量 `X'6C6174657374'`（'latest'）→ `'latest'` 文本。
2. VARCHAR 列的 `ManagedSchemaKeys.identity(value)` 字节绑定 → 纯 `String`。
3. 仅在类型对齐使 CAST 精确性守卫冗余时重写；保留 permissive-collation 守卫（有测试验证）。
4. 保持 N ≥ UTF-16-unit 准入上限（H2 vs MySQL 长度语义）。
5. CI 中真实 MySQL DDL 初始化检查（H2 漏前缀/长度错误）。

## 约束

- PAD SPACE＋准入统一拒绝尾随空格是承重设计；任何身份 helper 不得重新允许尾随空格。
- canonical ref 保留 VARBINARY（精确 ASCII 预算）。
- 无本地 MySQL；MySQL DDL/竞态/性能门在 CI 跑。

## 风险

- 契约收窄会拒绝超收敛界的值（fail-closed）。我们的代码铸造无真实 outlier；模型 `callId`
  与平台 id 的界是 deliberate 契约变更。
- 第三方平台/GitHub 规格不在仓库；256/64/128 为规格界，带标注的不确定性。
- `model_id` 字符界 vs 字节界须明确决定（已选：字符）。
- 跨语言 tool-result manifest callId fixture 契约须保持钉住。

## 验证计划

- 每批：focused H2 套件＋双 Checkstyle（`checkstyle:check` +
  `checkstyle:check@runtime-broker-checkstyle`）。
- `ManagedSchemaTest`/`ManagedSchemaCatalogTest`/`ManagedSchemaProjectionTest` 在每次 DDL
  变更后强制 catalog/projection 对齐。
- CI 中真实 MySQL DDL 初始化＋索引预算门（`ManagedSchemaIdentityColumnsMySqlIT`）；
  竞态/性能 IT 在 CI。

## 验收标准

- 所有收敛列按上述预算为 `VARCHAR`；准入拒绝超界/尾随空格/malformed 值。
- 所有受影响索引 ≤3072 字节；`idx_ma_record_identity` 已删。
- canonical ref / 摘要 / 密文 / 对象键不变。
- 每批 focused H2＋双 Checkstyle 绿；MySQL 门 CI 绿。

## 分批计划

1. P0：删 `idx_ma_record_identity`。
2. our-code 128 批（item/content_part/resource/tx/command/activation/writer/
   head.operation_id/source_scope/parent_child_run/channel-segment/PR binding_id/
   idempotency_key）＋共享 `validateStableId`/`ManagedExtensionRecords.id` 拒绝。
3. childRunId union 256＋gate reconciliation；isolation_key 64；provision 160 / loss 192。
4. model_id 128（字符界，所有准入点＋文档）；tool_call_id 128（Java+TS+manifest）；
   runtime_instance/lease 128（＋静态配置文档）。
5. PR owner 64 / repo 128；平台 account/sender/chat/thread 256。

## 开放问题

- 第三方平台 id 规格（DingTalk/WeCom/GitHub/email）仅由外部知识确认；若某平台吐更长 id
  需重新评估。
- `ma_runtime_stage`（main #17953）保留 hash-key 设计，`observation_owner` 仍
  VARBINARY(2048)；去哈希这些是单独跟进。
