# Managed 身份列：VARCHAR 预算与移除身份哈希键层

[English](2026-11-20-managed-identity-varchar-dehash.md) | [简体中文](2026-11-20-managed-identity-varchar-dehash.zh-CN.md)

## 状态与范围

- 状态：**实施中（核心迁移已落地，待 CI 全量验证）**。混合身份表示已获维护者确认；DDL、生产 SQL、verification fixtures 已完成去哈希迁移，本地 focused H2 与双 Checkstyle 通过，MySQL/全量 H2/性能证据待 CI。
- 修订（2026-11-20）：对"与同表另一唯一键重复的哈希键"做了后续调研，修正了 `workspace_id`
  预算，补充了回执、operation、Session 哈希列与 read lease 的约束，并对调研提出的三个
  问题作出决定（见[重复业务键](#重复业务键)）。
- 修订（2026-11-21）：增量 2 在 VARCHAR 转换之前，先删除只复述本行原始列的哈希键（见
  [增量 2](#增量-2同行冗余哈希键)）。
- 日期：2026-11-20。源码基线：`origin/main` 的 `7ef9d6decb`。分析在 `f10299764e` 上
  执行；其间 3 个提交不触及任何 `packages/managed-agent-server` 文件，共享 V1 schema
  与 `ManagedSchemaKeys` 在两者间逐字节相同（`git diff` 核实），故全部计数与宽度在
  当前 main tip 上成立。
- 范围：`packages/managed-agent-server`（persistence、runtime-broker、control-plane、
  contracts、verification）、共享 `V1__managed_schema.sql`，以及任何派生相同键的
  TypeScript 消费方。适用 release 前政策：原地编辑单一 V1 基线、重建开发 catalog；
  不引入 V2+ 迁移。

## 问题

身份列是 `VARBINARY(512/1024/2048)`，另有一层平行的 `CHAR(64)` SHA-256 键
（`ManagedSchemaKeys.key()`，410 处调用）承载这些身份的可索引/业务唯一形态：60 列
注释明标 "Hashed …"（`tenant_key`、`session_key`、`session_scope_key`、`harness_key`、
`scope_key`、`resource_key`、`record_key`、`operation_key`、`receipt_key` 等），另有
同族但未带该注释词的派生键（`physical_key`、`storage_key`、`holder_key`、
`*_resource_key` 等）。另有 32 个 `CHAR(64)` 列是**内容摘要**（`sha256`、commit 链
摘要、`idempotency_digest`、token 哈希），不属于本次改动。

哈希层的存在理由：身份声明上界达 2048 字节时把复合索引键压到 InnoDB 3072 字节上限
之内，并把多元组（`scope_key = hash(tenant, workspace, session)`）压缩成一个被引用
列。其代价：每次写每个键一次 SHA-256、raw+hash 双份存储、额外唯一索引、双谓词查询
（`tenant_key = ? AND tenant_id = ?`），以及一套织入每个 store 与跨表引用的派生方案。

声明的 512/2048 字节预算是**上界而非实际值**。实际身份很短（见下方证据），因此哈希
的宽度正当性对它们不成立，该层可以移除、改用原始列。

## 目标与非目标

目标：

- 身份改存 `VARCHAR`，按类给预算（真实长度 + buffer），等值比较保持字节精确（NO PAD）。
  契约只含 ASCII 的身份类也可保留按契约定长的字节类型（见[重复业务键](#重复业务键)下的决策 2）。
- 移除身份哈希键层；协调、唯一性、跨表引用改键在原始身份列上。
- 保留所有隔离、fencing、幂等、锁序、replay 不变量。

非目标：

- 不改公共 API；序列化 payload 字段名保持不变。
- 32 个内容摘要列原样保留；journal commit 链、租约 fencing、幂等回执、replay floor
  不重设计。
- 数据库行 `id` 仍排除在 domain 身份与 CSI 证据之外
  （[schema conventions](2026-11-02-managed-schema-conventions.md)）。
- 不引入异步缓存、不放大预取；8 MiB 读取预算不变。
- OSS object key 是存储指针而非业务身份；保持二进制。

## 身份证据与预算

| 身份                                                       | 实际形态 / 长度                                                                                                               | 证据                                                                                                                                      | 预算                           | 索引字节 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------- |
| `tenant_id`、`actor_id`                                    | 数值型，≤20 位                                                                                                                | 上游库表定义 `tenant_id bigint(20) unsigned`、`act_id` 同类（维护者提供，2026-11-20）；以十进制串经 `X-Qwen-Tenant-Id` 注入               | `VARCHAR(36)`                  | 144      |
| `session_id`                                               | UUID，36                                                                                                                      | 转录文件即 `<uuid>.jsonl`（`packages/core/src/services/sessionService.ts:1841`）                                                          | `VARCHAR(64)`                  | 256      |
| `workspace_id`                                             | `workspace-` + 64 位十六进制 receipt key，74；`ws_` + UUID（SSH），39；32 位十六进制子 workspace id，32；注册方指定，最长 128 | `WorkspaceCreationStore`、`JdbcSshWorkspaceStore`、`ChildWorkspaceStore`、`WorkspaceValues.requireIdentifier`（`[A-Za-z0-9._:-]{1,128}`） | `VARBINARY(128)`（ASCII 契约） | 128      |
| `storage_id`                                               | `created-` / `imported-` + 同一个 receipt key，72 / 73；`ssh_` + UUID，40；注册方指定或配置，最长 256                         | `WorkspaceCreationStore`、`JdbcSshWorkspaceStore`、`WorkspaceRecord.MAXIMUM_STORAGE_ID_LENGTH`（可打印 ASCII）                            | `VARBINARY(256)`（ASCII 契约） | 256      |
| `resource_id`、`operation_id`、`activation_id` 等生成 id   | `randomUUID()`，36                                                                                                            | `http-managed-session-store.ts`、`managed-session-assembly.ts`、Java `UUID.randomUUID()`                                                  | `VARCHAR(64)`                  | 256      |
| 外部渠道 `account_id`、`sender_id`、`chat_id`、`thread_id` | 平台 opaque、变长                                                                                                             | schema 注释 "External platform … identity"                                                                                                | `VARCHAR(512)`                 | 2048     |
| `object_key`、`capture_object_key`                         | OSS key、长、不进索引                                                                                                         | `ma_resource`、`ma_journal_pack`                                                                                                          | 保持 `VARBINARY`               | 不适用   |

utf8mb4 下 `VARCHAR(N)` 按 `4×N` 字节计入索引键算术；磁盘存储为实际字节。类表给出
默认值；实施须枚举每个身份列的生成格式并定稿逐列预算，显式列出例外（如复合
turn/event id）。

更正（后续调研）：此前版本把 `workspace_id` 写成约 46 字符的"UUID 派生 receipt key"，
预算 `VARCHAR(64)`。实际 receipt key 是创建回执元组的 64 位十六进制 SHA-256，因此回执
派生的 `workspace_id` 为 74 字符，对应的 `storage_id` 为 72 或 73 字符。按 `VARCHAR(64)`
落地会在严格模式下让生产环境的 workspace 创建 fail closed，与 83 字符 guard 哨兵属同一
类错误。不过真正起约束作用的是公开契约，而不是回执派生的形态：外部存储注册接受最长 128
字符的 `tenantWorkspaceId`（`[A-Za-z0-9._-]{1,128}`），它同时成为 `workspace_id` 与
`storage_id`；workspace 选择也接受最长 128 字符的 workspace id。storage id 还要更宽：契约
类型接受最长 256 个可打印 ASCII 字符。下文决策 2 保留这两个契约，并按契约确定列宽。去掉 `workspace-` /
`created-` / `imported-` 前缀也无济于事：注册表靠 `workspace-` 加 64 位十六进制来区分回执
派生的 id 与注册方指定的 id，storage 前缀记录 workspace 是新建还是导入，而注册方指定的 id
仍可长达 128 字符。

契约注意：代码把 tenant/actor 当作不透明 header 串，不强制长度。开发默认
`local-java-demo`（`managed-development-options.ts:16`），verification fixture 用
`"tenant-" + UUID` = 43 字符（`Issue13181QueryBudgetTest.java:96`）。因此采用
`VARCHAR(36)` 必须把这些 fixture/默认值对齐到 ≤36，并加 fail-closed 的 admission
校验（见应用层）。

## 索引宽度核算

方法：解析 V1 中全部 `PRIMARY KEY`、`UNIQUE`、`CREATE INDEX`（246 个键）；把每个身份
哈希列替换为其保守的原始元组展开、每个原始 `VARBINARY` 身份替换为其类预算；枚举/
数值/摘要保持原样。展开是估算而非逐键推导；余量足够大故结论稳健，实施时逐键精确复核。

按上表预算的结果：**246/246 键 < 3072 字节；最宽 2800 字节。**

| 键                                                    | 估算宽度 |
| ----------------------------------------------------- | -------- |
| `ma_resource.idx_ma_resource_delete_intent`           | 2800     |
| `ma_operation_work.idx_ma_work_pending`               | 2784     |
| `ma_operation_work.uk_ma_operation_work_business_key` | 2400     |
| `ma_operation.uk_ma_operation_request`                | 2304     |
| `ma_operation.uk_ma_operation_identity`               | 2016     |

此前边际的 `uk_ma_operation_request`（actor 按 `VARCHAR(256)` 预算时 ≈3184 字节）在
actor 改数值型 `VARCHAR(36)` 后降到 ≈2304（`actor_key` 展开为 tenant+actor = 288
字节）。没有任何键需要保留哈希。

以上估算按 `VARCHAR(64)` 计 `workspace_id`，即 256 索引字节。按决策 2，workspace 身份
占 128 字节（`VARBINARY(128)`），storage 身份占 256 字节（`VARBINARY(256)`），因此凡直接或
经展开的 scope 元组包含 workspace 身份的键，每含一次就收窄 128 字节（下文回执最坏情形变为
≈1120 字节）。最终宽度仍以精确重算为准。

## 方案：schema 变更

### 列类型与 collation

- 身份 `VARBINARY` 列转换为上表类预算。
- 每个身份列钉死 **NO PAD** 二进制 collation（`utf8mb4_0900_bin`），使等值比较保持
  字节精确、含尾随空格；表默认 `utf8mb4_bin` 是 PAD SPACE，会把 `'t'` 与 `'t '` 折叠
  相等、放宽隔离（[consolidation](2026-10-13-managed-schema-consolidation.md) 要求
  字节精确 "including trailing spaces"）。核实 H2 的 VARCHAR 尾随空格语义并对齐；
  增加跨引擎等值测试。
- 展示/枚举/JSON 列保持现状。

### 删身份哈希列、保留摘要

- 移除 60 个 "Hashed" 列及同族派生身份键；移除其唯一约束与索引；在原始列上重建这些
  键（见下）。
- 保留全部 32 个内容摘要列及 `ManagedSchemaKeys` 中的摘要 helper（commit 链、
  `sha256`、`idempotency_digest`、token 哈希）。
- 移除双谓词模式；查询直接按原始身份过滤。哈希碰撞复核不再需要，因为原始值就是键。

### 协调协议改键在原始列

- **租户 guard。** `ma_tenant_guard` PK `(tenant_key, guard_domain)` 改为
  `(tenant_id, guard_domain)`，其中 `tenant_id VARCHAR(96)` 是**可读** scope：
  租户域用 tenant 十进制串，跨租户/主机锁用显式哨兵
  （`external-storage-registration/1`、`local-storage-host/<hostId>`，19+64=83 字符，hostId 为 64-hex HMAC）。
  哨兵不是数值 tenant，不能硬塞进数值 tenant 预算；可读 scope 列在不哈希的前提下
  保留它们（384+128=512 字节）。回归测试绑定真实 64-hex 主机哨兵，防止宽度静默回退。interim 边界：scope <=96 字符，超长在严格模式下于 guard INSERT fail-closed；完整 admission 校验留待后续阶段。
  `INSERT … ON DUPLICATE KEY UPDATE` + `SELECT … FOR UPDATE` 的获取形态与两个 domain
  不变（[lock inventory](2026-11-12-managed-agent-lock-inventory.md)）。
- **Session head。** `uk_ma_session_head_business_key (tenant_key, harness_key)` 改为
  `(tenant_id, harness_session_id)`（144+256=400 字节）；`FOR UPDATE` 锁点移到该原始
  唯一键。`idx_ma_head_workspace`、`idx_ma_head_wake`、`idx_ma_head_session` 在原始列
  重建。`head_kind` 语义不变。
  `ma_session.tenant_key`、`session_key`、`session_scope_key` 只由 publication-retention
  的 CONTROL upsert 写入（对已存在的行也会补写），因此凡按这些列 join，都同时把匹配限制在
  被该路径登记过的 Session 上。改为原始列 join 时必须显式保留这层限制。`ma_read_lease`
  只存 `(tenant_key, session_key)`，其与 `ma_session` 的 join 迁移前，需要先补原始
  `tenant_id` 与 `session_id` 列。
- **Session scope 前缀。** 子表用原始 `(tenant_id, session_id)` 前缀替代
  `session_scope_key`，并重建所有以它领头的索引（`idx_ma_record_identity`、
  `ma_journal_pack` 唯一键、resource/ref/operation/side query/client-files 索引）。
  该前缀谓词是承重墙（[shared helpers](2026-10-17-hosted-gate-shared-helpers.md)）；
  查询形态必须保留 `tenant_id = ? AND session_id = ? AND …` 以约束扫描量。
  `ma_session.uk_ma_session_scope` 因与 PK 冗余而删除。
- **幂等与回执。** `receipt_key`、`operation_key`、`target_key`、`scope_key` 在
  `ma_request_receipt` / `ma_operation` 中替换为类型化原始 scope 列
  （`scope_kind` + `tenant_id` + `workspace_id` + `session_id` + `actor_id`，按需），
  唯一键在适用子集加 `idempotency_digest` 上计算。最坏情形
  （namespace+tenant+scope_kind+workspace+session+actor+digest）≈1248 字节。
  多态单列 scope 展开为类型化列而非保留编码串；若某跨表引用被证明过宽，回退为规范
  **可读** scope 串（明确不是哈希），并复核宽度。`receipt_key` 也是一个被生成出来的
  标识，而不只是索引键：对 `WORKSPACE_CREATE`，它被嵌入 `workspace_id`
  （`workspace-<receipt_key>`）、created/imported 的 `storage_id`，以及磁盘上的
  workspace 根目录 `<base>/<key(tenant)>/<receipt_key>`；workspace 注册表会从 workspace
  id 中去掉前缀，再按 `receipt_key` 反查回执。这种反查无法还原为原始回执元组；下文决策 1
  保留 `receipt_key` 作为生成的标识。
- **Operation 身份。** `operation_key` 的派生方式不统一。多数写入方使用
  `operationKey(kind, scope_key, target_key, operation_id)`，但有三组写入方按 tenant、
  kind 与 id 定位 operation：SSH workspace 创建使用 `key(OPERATION, tenant, id)`，
  `WorkspaceOperations` 的各 kind 与 workspace 上传使用 `key(kind, tenant, id)`。对它们，
  `operation_key` 比 `uk_ma_operation_identity` 更严，因为它不含 target：同一 tenant 与
  operation id 落在两个不同 target 上，现在会被拒绝，只靠身份唯一键时则会被接受。下文
  决策 3 用一个显式唯一键保留这一约束。

### 外部渠道身份与 OSS key

- 外部平台 id 给 `VARCHAR(512)`；它们不领头宽复合键，故无需哈希即可容纳。若某部署的
  平台 id 可能超 512，该列单独保留压缩键（唯一允许的残留哈希）。
- `object_key` / `capture_object_key` 保持 `VARBINARY`（opaque 存储指针）。

## 应用层变更

- Java 绑定在 persistence、runtime-broker、control-plane、contracts、verification
  fixtures 全链路 `byte[]` → `String`；row mapper 与 binder 同步改（H2 拒绝字符串绑
  `VARBINARY`，故类型与绑定必须同一次改动移动）。
- 删除 `ManagedSchemaKeys.key()` 的身份派生（410 处调用）；摘要 helper 保留。跨表
  引用携带原始身份列。用于生成公开标识或文件系统路径的派生（workspace/storage id 用的
  `receiptKey`、workspace 根目录用的 `key(tenant)`）是标识而非索引键，予以保留。
- Admission 在边界 fail-closed 校验身份长度/格式（tenant/actor ≤36、UUID/前缀形态、
  外部 ≤512）；超长或畸形身份被拒绝，绝不截断。
- 将 verification fixture 与开发默认值对齐到新契约（数值或 ≤36 字符 tenant）；保留
  多字节与尾随空格语义测试。
- 确认是否有 TypeScript 消费方派生这些键；若有则同一次改动移动。schema-shape
  meta-test 与 catalog 校验随 DDL 更新。

## 代码侧索引与查询普查

DDL 普查（246 键）不是代码面的全部。对 Java 生产代码做引用普查，身份哈希列上约有
**1613 处列引用**（`session_scope_key` 314、`scope_key` 270、`tenant_key` 133、
`resource_key` 126、`operation_key` 117、`physical_key` 88、`owner_key` 83、
`storage_key` 82、`record_key` 81、`harness_key` 71、`alias_key` 57、`target_key` 54、
`receipt_key` 38，其余更少），独立于 410 处键派生。每一处都是必须随 DDL 移动的查询、
binder、row-mapper 或排序依赖。除索引重建外，有四类需要显式重设计：

- **键集游标与确定性锁序。** 多个 store 按哈希键序分页与加锁：
  `ManagedSessionRetirementStore`（`ORDER BY owner_key, owner_revision,
resource_key … FOR UPDATE`、`ORDER BY query_key / receipt_key / request_key /
record_key … FOR UPDATE`）、`WorkspaceRecoveryStore`（`target_key > ? ORDER BY
target_key`）、`SessionResourceCollectionCollector`（`resource_key > ? ORDER BY
resource_key`）、`JdbcHostedCleanupDebtStore`（`owner_key > ?`）、
  `ManagedExtensionQueries`（`record_key DESC` 游标）。哈希提供的全序既作分页游标，
  又作一致的 `FOR UPDATE` 获取顺序（防死锁）。替换它需要复合元组序（如
  `(tenant_id, session_id, resource_id)`）加字典序 row-value 游标比较，且所有锁这些
  行的事务必须保持同一全序。
- **压在哈希键上的生成列。** `ma_side_query.active_slot`
  （`GENERATED … actor_scope_key`，V1:1333）由哈希列派生；必须在原始 scope 列上
  重定义，或连同其消费方一起删除。`ma_request_receipt.decision_scope_key` 已由
  [删除无用 schema 对象](2026-11-21-managed-schema-dead-objects.zh-CN.md)移除。
- **压在哈希键上的 CHECK 约束。** `ck_ma_resource_capture`（scope_key/slot_key 空值
  耦合，V1:508）、`ck_ma_ref_binding`（runtime_binding_key，V1:536）、
  `ck_ma_storage_registered`（physical_key，V1:989）引用哈希列，必须在原始列上重写。
- **前缀领头查询与 catalog 钉死。** 每个 `session_scope_key = ?` / `scope_key = ?`
  领头谓词必须保留其原始 `(tenant_id, session_id[, workspace_id])` 前缀，使重建索引
  仍约束扫描；钉死哈希列的 schema-shape meta-test 与 catalog 校验随 DDL 更新。

验收增加逐 store 的游标/锁序等价测试（同行、同序、并发下无死锁），以及两个引擎上的
生成列/CHECK 重写测试。

## 重复业务键

后续调研检查了：那些只是重复同表另一唯一键的哈希键，能否像 `ma_memory_store.store_key`
与扩展的 `package_key` / `settings_key` 那样，在 VARCHAR 转换之前单独删除。#17958 提议
再删除两个符合条件的：`ma_storage (tenant_key, storage_key)` 与
`ma_storage_owner.physical_key`。其余各项都不能单独删除：

| 键                                           | 同表等价唯一键                                       | 不能单独删除的原因                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ma_storage.alias_key`                       | `(tenant_id, storage_id)`                            | 按当前宽度，原始二元组为 2048+2048 = 4096 字节；被 `ma_runtime_binding.storage_alias_key` 引用；alias 按 `alias_key` 顺序加锁。                                                                                                                    |
| `ma_session` 的 `tenant_key` / `session_key` | 主键 `(tenant_id, session_id)`                       | 是与 `ma_session_head (tenant_key, harness_key)` 的 join 桥，而 head 的原始键 `(tenant_id, harness_session_id)` 为 4096 字节；另有上文的已登记 Session 限制。                                                                                      |
| `ma_operation.operation_key`                 | `uk_ma_operation_identity`                           | `ma_operation_work` 没有 operation 身份列，在其上重建 `idx_ma_work_pending` 约 3200 字节；另有上文的派生不统一问题。                                                                                                                               |
| `ma_resource.resource_key`                   | `uk_ma_resource_id (session_scope_key, resource_id)` | 原始三元组为 4608 字节。`(session_scope_key, resource_id)` 放得下，但 6 张引用表（7 个引用列）需要补 resource 身份列（只有 `ma_resource_ref` 已有可空的 `resource_id`），两处 `FOR UPDATE` 游标要改，且在 `session_scope_key` 转换时还得再改一遍。 |
| `ma_request_receipt.receipt_key`             | `uk_ma_request`（6 个写入方逐一核实）                | 被生成进 workspace 与 storage id 以及 workspace 根目录（见上文）；作为生成的标识保留（决策 1）。                                                                                                                                                   |
| `ma_delivery.delivery_key`                   | `uk_ma_delivery_identity`                            | 可在 `ma_channel_segment` 上改用 `(source_scope_key, delivery_id)`（2624 字节），但只是把一个哈希列换成哈希列加原始列；随转换一起做。                                                                                                              |

数据库行 `id` 不能作为替代引用：业务身份、租户隔离、幂等与 fencing 继续使用业务键
（[schema conventions](2026-11-02-managed-schema-conventions.md)）。因此本次调研确认，
剩余工作是一个原子簇（[实施计划](../plans/2026-11-20-managed-identity-dehash-cluster-impl.zh-CN.md)）。

### 决策

1. **回执派生的 id：`receipt_key` 作为生成的标识保留。** 它是新建或导入 workspace 的
   身份根：workspace id、storage id 与磁盘根目录都在回执仍处于 pending 时由它派生，这使重试的
   创建能找回同一个目录。有两处查找依赖它：`created-` / `imported-` storage id 经回执解析其本地
   根目录；workspace 列表从回执读取回执派生 workspace 的默认工作目录；两者都会用回执的原始
   列重新派生 `receiptKey` 来校验该行。若改为在 workspace 与 storage 行上记录回执元组或
   创建详情，只为删掉一个 64 字符的列就要新增列并改动创建协议，而且生成 id 仍然需要这一
   派生。因此去哈希保留 `ma_request_receipt.receipt_key` 及其唯一键，把它当作标识而非
   索引键，并保留 `receiptKey` 与 `key(tenant)` 派生；幂等仍由 `uk_ma_request` 保证。
2. **workspace 与 storage id 预算：保留契约，按契约确定字节列宽。** 契约类型接受匹配
   `[A-Za-z0-9._:-]{1,128}` 的 workspace id 与最长 256 个可打印 ASCII 字符的 storage id，
   外部注册已经接受完整的 128 字符 workspace 范围。没有任何生成方需要更窄的契约：生成的
   workspace id 为 74（回执）、39（SSH）、32（子 workspace）字符，storage id 为 72/73 与
   40 字符。收紧契约是没有收益的公开契约变更。由于两个契约都只含 ASCII，`workspace_id` 与
   `storage_id` 保留按契约定长的字节类型 `VARBINARY(128)` 与 `VARBINARY(256)`，而不是
   utf8mb4 `VARCHAR`：等值天然字节精确，索引占 128 与 256 字节而非 512 与 1024 字节，且
   这两列无需改动绑定。其他 ASCII 契约的身份类是否采用同一规则，由精确宽度重算决定。
3. **按 tenant 定位的 operation 通过显式唯一键保持唯一性。** 有三组写入方通过重新计算
   `key(kind, tenant, id)` 来读写 operation：SSH workspace 创建（`WORKSPACE_CREATE`）、
   `WorkspaceOperations` 的六种 kind（`WORKSPACE_RECOVERY`、`WORKSPACE_OPERATOR_RECOVERY`、
   `STORAGE_MIGRATION`、`WORKSPACE_RETIREMENT`、`CHILD_WORKSPACE`、`SESSION_WORKTREE`）
   与 `WORKSPACE_UPLOAD`。对 SSH 创建，该唯一键是幂等在数据库层的兜底：operation id 由
   tenant、actor 与幂等键派生，而每次尝试都会生成一个新的随机 workspace 作为 target，因此
   仅靠 `uk_ma_operation_identity` 拦不住重复。其余写入方都使用
   `operationKey(kind, scope_key, target_key, operation_id)`，与 `uk_ma_operation_identity`
   完全一致。去哈希新增生成列 `tenant_operation_id`：对这些 kind 等于 `operation_id`，
   其余为 NULL，并加 `UNIQUE (tenant_id, operation_kind, tenant_operation_id)`，这是 schema
   已用于 `publication_command_id` 的模式；它们的查找改为
   `tenant_id = ? AND operation_kind = ? AND operation_id = ?`。这样无需统一派生、也不依赖
   未经证明的 id 唯一性，就能精确保持现有约束。kind 清单写在 DDL 里，新增按 tenant 定位的
   kind 时必须同步加入。

## 增量 2：同行冗余哈希键

若一个哈希列只由本行原始列派生、没有其他表在它上面 join、也不生成任何标识，它就是冗余的。
增量 2 删除这些列，在原始列上按相同列序重建它们的唯一键与索引，并把所有查询改为过滤原始列。
VARBINARY 类型不变；VARCHAR 转换、跨表引用与上文各项决策仍属于
[实施计划](../plans/2026-11-20-managed-identity-dehash-cluster-impl.zh-CN.md)描述的原子簇。

| 表                                                           | 删除                               | 替代为                                                           |
| ------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------- |
| `ma_session_head`                                            | `tenant_key`、`harness_key`        | `UNIQUE (tenant_id, harness_session_id)`                         |
| `ma_session_record`、`ma_resource`、`ma_resource_ref`        | `session_scope_key`                | `(tenant_id, session_id)` 前缀                                   |
| `ma_operation`、`ma_journal_pack`、`ma_client_files_binding` | `session_scope_key`                | `(tenant_id, session_id)` 前缀                                   |
| `ma_client_files_request`                                    | `session_scope_key`、`request_key` | `UNIQUE (tenant_id, session_id, binding_generation, request_id)` |
| `ma_side_query`                                              | `session_scope_key`、`query_key`   | `UNIQUE (tenant_id, query_id)`；session 索引改用原始列           |
| `ma_memory_entry`                                            | `entry_key`                        | `UNIQUE (tenant_id, memory_store_id, memory_id)`                 |
| `ma_extension_package`、`_settings`、`_operation`            | `scope_key`                        | `(tenant_id, workspace_id, extension_id, …)`                     |
| `ma_output_capture`                                          | `tenant_key`                       | `idx_ma_capture_tenant (tenant_id, state)`                       |

宽度。有几处原始替代之所以能放下，是因为把子表身份列收窄到了父表宽度 512 字节：
`ma_session_head.tenant_id` 与 `workspace_id`，`ma_session_record`、`ma_resource`、
`ma_resource_ref` 的 `session_id`，以及 `ma_operation.tenant_id`。这些列的租户与 Session id
取自 `ma_session` 与 `ma_workspace`（512 字节）；而 journal writer 是唯一写入 workspace 的
head 写入方，它本就拒绝超过 128 字节的租户 id 和超过 512 字节的 workspace 与 Session id，
因此不会丢失任何已接受的值。这取代上表 `ma_session` 一行中关于 Session head 的部分：head 的
租户收窄到 512 字节后，原始 head 键为 2560 字节。三个非唯一索引使用键前缀：
`idx_ma_record_identity`、`idx_ma_ref_journal` 与 `idx_ma_delivery_source`
（`record_id`、`resource_id` 与 `delivery_id` 限 1024 字节，仅 MySQL）；所有唯一键都用完整列。最宽的重建键 `uk_ma_resource_id` 与 `idx_ma_head_workspace`
正好 3072 字节，InnoDB 接受。

保留（因为不冗余）：

- `ma_session.tenant_key`、`session_key` 与 `session_scope_key` 是发布保留 CONTROL upsert
  写入的登记标记。所有迁离它们的 join 都改为 join 原始列，并保留
  `s.session_scope_key IS NOT NULL`，因此该路径从未登记的 Session 仍不会匹配。
- `ma_output_capture.scope_key` 是 `ma_operation`、`ma_resource` 与 `ma_artifact` 引用的
  发布 scope 锚点。
- `resource_key`、`record_key`、`operation_key`、`target_key`、delivery 键、actor 键、storage
  键以及 runtime request 与 scope 键属于跨表引用、生成的标识或非统一派生（见上文）。
- `ma_request_receipt.tenant_key`：它在 ingress 键集索引中的原始替代为 3208 字节。
  `ma_read_lease` 不存原始身份。

查询规则：

- 每个 Session head 写入方都令 `session_id` 等于 `harness_session_id`，因此原来的
  `tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?` 查找改为
  `tenant_id = ? AND harness_session_id = ?`：同一唯一行、同一 `FOR UPDATE` 锁。
- 原先比较哈希列的跨表 join，要么绑定派生值（`l.source_scope_key = ?`），要么经索引路径
  join 原始列。Session 消息交接 join 需要新增一个索引
  `idx_ma_delivery_source (delivery_kind, tenant_id, source_session_id, delivery_id)`。
- Session 退役按重建唯一键的顺序（`query_id`；`binding_generation, request_id`）而非哈希序
  锁 side query 与 client-files 请求。它是唯一按序锁这些多行的路径，另一处多行锁（按状态锁
  活跃 side query）保持其索引序，故不引入锁环。
- 针对已删哈希的碰撞复核随之删除；容量日志仍打印租户哈希，从不打印原始租户 id。

## 保留的不变量

- 租户/actor/workspace 鉴权先于 LIMIT 与分页；无跨请求鉴权缓存。
- 锁序 guard → session root → head；writer/claim 代际、租约 fence、repeatable-read
  快照规则、fresh-committed 检查不变。
- 结算与退休保持幂等；引用与恢复保护不变；PUT 未证明完成前 GC 绝不报告完成。
- 身份等值在两个引擎上保持字节精确、含尾随空格。
- H2/MySQL 一致：仅参数化 SQL；VARBINARY→VARCHAR 绑定同步移动。

## 风险与权衡

- 刚合并的 [sql-hot-paths](2026-11-19-managed-agent-server-sql-hot-paths.md)（#17856）
  把索引建在哈希键上；每个都必须在原始列重建，并用 `ManagedSqlPerformanceMySqlIT`
  基准重新证明（基线 vs 改动的结果指纹与 examined 行数），否则热读退化为 lane 扫描。
- 协调协议重设计是锁协议变更：按 lock inventory，每项移除前都需独立连接的 MySQL
  竞态测试。
- 410 处调用的机械重写有丢共享逻辑的风险；逐消费方核实，不做关键词式删除。
- H2 与 MySQL 的 collation/尾随空格分歧可能静默放宽隔离；跨引擎等值测试强制。
- 宽度数字是保守估算；实施须逐键精确复核，任何超 3072 的键单独重设计（更窄）索引，
  而非重新引入哈希。
- 写放大：移除双份存储与额外唯一键减少写；本次不引入新 ledger。

## 验证与验收

- 在全新 H2 与一次性 MySQL 8.4 重建 catalog；catalog 校验拒绝漂移与残留哈希列；guard scope collation 由 MySQL-shape 门（`ManagedSchemaMySqlIT`）钉死，而非跨引擎 catalog 校验；断言全部 246 键 < 3072。
- 跨引擎身份等值测试：大小写、尾随空格、多字节；MySQL NO PAD 与 H2 对齐行为。
- Admission 拒绝测试：超长/畸形 tenant/actor/外部 id。
- workspace 创建与准入测试绑定真实的回执派生 `workspace_id`（74 字符）与 `storage_id`
  （73 字符）、一个 128 字符的注册方指定 workspace id 与一个 256 字符的 storage id，如同
  guard 回归测试绑定真实的 64 位十六进制主机哨兵。
- 用同一幂等键重试 SSH workspace 创建只产生一个 operation；并发的重复插入即使 target
  workspace 不同，也会被按 tenant 定位的唯一键拒绝。
- `created-` / `imported-` storage 根目录与回执派生 workspace 的默认值仍经 `receipt_key`
  解析。
- 从 `ma_session` 哈希列迁走的 join 保留已登记 Session 限制：retention 路径从未登记过的
  Session 不被匹配。
- MySQL 竞态套件：guard 获取（租户 + 哨兵域）、head claim/drain/renew、rename 结算、
  退休/GC 顺序、回执幂等。
- sql-hot-paths 基准：1k/10k/100k 下结果指纹相等、examined 行数不劣于已合并基线。
- 触及消费方的完整 Java verification 加 TypeScript build/typecheck/test；Checkstyle
  与格式通过。

## 分阶段实施

1. 契约 + admission 校验 + fixture/dev 对齐（暂不改 schema）。
2. V1 原地 DDL（预算、NO PAD、删身份哈希、重建键）与 Java 绑定/派生重写、schema-shape
   meta-test 同一次落地。
3. 重建并重新证明热路径索引；跑基准与竞态套件。
4. 外部渠道与哨兵 guard 边界情形；逐键精确宽度复核。

## 开放问题

- 非纯 UUID 的复合 id（turn/event/prompt/pack/lease）的确切生成格式与定稿逐列预算。
- 是否有 TypeScript 消费方派生身份哈希（须同步移动）。
- 生产 tenant/actor 注入：在定死 `VARCHAR(36)` 前确认十进制串契约与各部署最大位数。
- 是否有外部平台 id 可能超 512 字符（残留压缩情形）。

## 2026-11-21 实施补充（维护者已确认）

### 混合身份表示

简单身份（tenant/session/actor 等）使用有界 `VARCHAR` 与显式 `utf8mb4_0900_bin`。
过宽或多态的跨表身份不再复制大量可空原始列，而是使用**可逆 canonical readable
reference**；它不是 SHA-256，不丢失组件信息。所有索引按 **<= 3072 字节**验收，
编码长度 fail closed。

`ManagedIdentityRef` 的编码格式为：

```text
v1|<component-count>|<component>|...
component := "-" | <utf8-byte-length>:<escaped-payload>
```

- `null` 组件编码为 `-`；空字符串编码为 `0:`。
- payload 按 UTF-8 字节百分号转义；仅 ASCII 字母数字与 `. _ ~ : -` 保持字面量。
- 解码严格校验版本、数量、长度、转义规范与 UTF-8 良构，并拒绝非规范编码。
- `encode(maximumBytes, components...)` 在写入前强制最终 ASCII 字节预算。

### 表级决策

- `ma_session` 新增单调布尔列 `is_publication_retention_registered`，由
  publication-retention CONTROL upsert 设置；原 `session_scope_key IS NOT NULL`
  过滤改为该标记。旧哈希列在完整原子簇中删除。
- `ma_operation` 增加原始 `scope_kind/scope_id`；跨表引用使用 `operation_ref`。
  tenant-addressed operation 的唯一性由同一 reference 机制保留，不再需要额外
  `tenant_operation_id` 生成列。
- `ma_resource_ref` 的 owner 是多态身份，使用非空 `owner_ref`；资源侧优先使用
  原始 `(tenant_id, session_id, resource_id)`，过宽时退回 `resource_ref`。
- Runtime request/scope 使用 `request_id/scope_id` canonical reference，原始组件
  保留在权威表用于校验；`ma_tool_execution.runtime_session_key` 只是单值哈希，
  直接由原始 `runtime_session_id` 替代。
- delivery 增加 `source_scope_id`；channel segment 增加原始 `delivery_id`；
  `ma_delivery.source_record_key` 无生产消费者，已删除。
- 子 Session 的合成 actor 使用有界派生 ID `ChildActorId.of(parentSessionId)`：
  `c:` + parentSessionId UTF-8 SHA-256 的前 32 hex（34 字符），保持 actor 36
  预算；persistence 与 control-plane 共用同一派生。
- 保留 `receipt_key`、workspace/storage 生成身份、extension/automation/CSI 协议
  派生 ID、内容/提交/token 摘要与二进制 payload。

### 当前检查点

已完成并验证：

- tenant/actor 36 字符/code-point admission 边界；
- `ma_session` publication-retention 登记标记及四处过滤迁移；
- 全部基线 `tenant_id`/`session_id`（含 session 族列）转换为
  `VARCHAR(36)/VARCHAR(64)` 与 NO PAD collation；
- Runtime Broker 身份绑定按 JDBC 参数类型区分文本/字节；
- `ManagedIdentityRef` codec 与单测；
- `ma_delivery.source_record_key` 删除及 projection 同步；
- 子 Session 合成 actor 有界派生（`ChildActorId`）与相关回归修复；
- H2 schema/catalog/projection、核心 business/session/retention/side-query/
  client-files/channel/workspace/SSH store、Runtime Broker 失败回归套件；
- 两个 Checkstyle execution；
- 规范化可读引用层（`operation_ref`/`scope_ref`/`owner_ref`、`request_id`/`scope_id`）
  取代身份哈希键列，以及跨表 SQL/锁序迁移；
- 准入处的规范化引用预算校验（RuntimeScope 与 RuntimeProvisionRequest 构造、
  journal command 与 owner 引用），超预算元组在边界即为具名 4xx，而非 INSERT/重放
  处的原始错误；
- 按列宽约束的 Harness/Runtime Session 准入（`VARCHAR(64)`/`VARCHAR(128)`）；
- Tier B 身份列 `resource_id`/`record_id`/`child_run_id`/`execution_call_id`
  `VARCHAR(256)`；
- 重复索引清理（删除 `idx_ma_operation_target_raw` 与 `idx_ma_resource_scope_page`）
  及 resource-GC 分页索引路径；
- retention 登记标记的行解码与按字节约束的 recovery work-key 守卫。

未完成：完整 MySQL 8.4 类型/collation/索引宽度门与竞态/性能证据（本地无 MySQL，
pending CI）、完整 H2 套件（本地 10 分钟预算内未跑完）、SQL 性能基准与 TypeScript
消费者同步。canonical `*_ref`、`record_resource_id` 与
`ma_runtime_stage.execution_call_id` 按设计保留 `VARBINARY`，并非待转换项。

## 2026-11-22 最终策略（取代早期 NO PAD 提案）

本节记录维护者最终确认并已落地的策略，取代上文「NO PAD / `utf8mb4_0900_bin` /
尾随空格字节精确」的早期提案，以及 actor 列暂留 `VARBINARY(144)` 的 interim 决策。

### Collation 与尾随空格

- 移除所有列级 `COLLATE utf8mb4_0900_bin`，身份列继承表默认 `utf8mb4_bin`（PAD SPACE）。
- 统一策略：**所有身份准入拒绝尾随空格**（`requireActor` 及
  `requireBindingId/requireOperationId/requireShortId/requireWorkspaceId/requireStorageId/requireInstanceId/requireWorkerOwner`）。
  准入既不允许尾随空格进入系统，PAD SPACE 折叠就不会发生在合法身份上。
- 「等值精确含尾随空格」不再由 collation 保证，而由准入保证；大小写敏感仍由
  `utf8mb4_bin` 保持。早期「尾随空格区分」测试改为「尾随空格拒绝」测试，大小写区分保留。

### actor 列

- raw actor（≤36 code points）授权/幂等键列统一 `VARCHAR(36)`：ma_user_message、
  ma_user_message_command、ma_workspace_access、ma_schedule、ma_client_files_binding，
  以及既有 ma_session.creator/owner_actor_key、ma_operation、ma_session_record、
  extension、delivery、memory_store、session_worktree。
- `ma_channel_instance.actor_id` 为 `VARCHAR(512)`（adapter 契约 `@Size(max=512)`，
  register 拒绝尾随空格）。不再保留 actor 二进制/文本混用。

### 已完成的 Tier A 转换

- operation 家族 + `publication_command_id` `VARCHAR(128)`（`uk_ma_publication_operation`
  3136→1600B）；短铸造 ID `VARCHAR(64)`（`decision_receipt_id` 128）；
  action/run/channel/route/artifact/publication/capture/task/stream/instance/creation/worker-owner
  `VARCHAR(128)`；`memory_id` `VARCHAR(256)`；`slot_key`/`occurrence_key` `VARCHAR(144)`；
  workspace/storage/extension 按 registry 128 / runtime 512 / storage 256。
- canonical ref、摘要、密文、对象键、`source_key` 等保留 `VARBINARY`。

### 跨引擎注意

- H2 2.3.232 的 `VARCHAR(n)` 按 UTF-16 unit 计长，MySQL 按 code point 计长；36 code point
  的补充平面字符（emoji）在 H2 会超 36 unit。actor 边界测试用 BMP 字符（CJK）覆盖
  36 code point 预算；生产目标 MySQL 按 code point 计。

### 仍未完成

- Tier B 核心身份（`resource_id`/`record_id`/`child_run_id`/`execution_call_id`）
  已落地 `VARCHAR(256)`；其余 Tier B/C 身份及其准入/索引设计仍待完成。
- 早期 wenshao 阻塞已解决：record_id 1024B prefix（已删除）、Action owner_ref
  退役泄漏（共享三元组 owner 引用）、Hook 列宽（128 字符准入）与 PAD SPACE
  （统一拒绝尾随空格）、N9 schema gate 空匹配。N7 `lockPlacementDomain` 锁序已实现，
  其 MySQL 死锁/竞态证据 pending CI。
- 与 #18048 语义合并冲突；完整 H2、MySQL 8.4 门/竞态/性能 pending CI。

## 2026-11-23 跟进：身份列的混合类型连接

MySQL 比较 `VARCHAR` 与 `VARBINARY` 操作数时按二进制串比较。用二进制值去探测
`VARBINARY` 列的索引不受影响；用二进制值去探测 `VARCHAR` 列的索引时，该列会退出
索引查找：连接只剩前导的 tenant/Session 前缀，并扫描其下的全部行。常量不受影响，
包括绑定到 `VARCHAR` 列的 `byte[]` 参数；外层行经唯一键解析为单个常量行时同样不受影响。
基于 V1 DDL 在 MySQL 8.4 上的实测：

| 连接                                                                                                   | 修复前                                                             | 修复后                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------- |
| `ma_resource.resource_id = ma_session_record.record_resource_id`（MCP 引用、Session 列表的模型上下文） | 仅用前缀 `(tenant_id, session_id)`；50 条记录 × 2 万资源耗时 2.8 s | 完整 `uk_ma_resource_id`，2.7 ms       |
| `ma_operation.operation_id = ma_artifact.result_id`（artifact 分页）                                   | 先读取全部 `TOOL_RESULT_PROJECTION` 行                             | 每个 artifact 单行查找                 |
| `CAST(target_id AS BINARY(512)) = CAST(binding_id AS BINARY(512))`（恢复候选）                         | 丢失 `idx_ma_operation_target` 查找，物化全部 operator recovery    | `idx_ma_operation_target` 覆盖索引查找 |

决策：

- `ma_session_record.record_resource_id` 改为 `VARCHAR(256)`，`ma_artifact.result_id`
  改为 `VARCHAR(128)`，即它们所引用身份（`ma_resource.resource_id`、
  `ma_operation.operation_id`）的宽度。每个写入方写入的 id 都已存在于被引用列中，
  因此不会丢失任何已接受的值。本节取代前文“`record_resource_id` 保留 `VARBINARY`”的表述。
- `ma_operation.target_id` 保持 `VARBINARY(512)`：它是多态的（Turn、binding、storage、
  Workspace、item 与 execution 目标），改为 `VARCHAR(512)` 会使
  `uk_ma_operation_request` 超过 3072 字节。连接让二进制一侧作为被探测方
  （`binaryIdentity`）；唯一一处用它探测 `VARCHAR` 键的连接（cancel evidence → `ma_turn`）
  改为把目标转换为文本。
- 从不与 `VARCHAR` 列比较的列在本次变更中保持原类型：canonical ref（按设计）、
  `ma_runtime_stage`（单独的去哈希跟进）、receipt、Session 记录与工具执行中的
  `turn_id`，以及 checkpoint/admission/terminal/side query 输入的资源 id。转换最后
  一组还需要收紧准入上限。
- actor 准入按 code point 计数，与 36 code point 预算及 MySQL 的 `VARCHAR(36)` 一致；
  此前的 UTF-16 检查会拒绝合法的补充平面 actor。最宽的可接受 actor 编码后的
  actor scope ref 为 549 字节，在 `ACTOR_SCOPE_REF_BYTES`（550）以内。

验收：`IdentityJoinScaleMySqlIT` 在 MySQL 上断言完整资源键、有界的 artifact 分页与
`idx_ma_operation_target` 探测；schema 门与受影响的 H2 测试保持通过。
