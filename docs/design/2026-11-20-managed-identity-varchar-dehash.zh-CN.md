# Managed 身份列：VARCHAR 预算与移除身份哈希键层

[English](2026-11-20-managed-identity-varchar-dehash.md) | [简体中文](2026-11-20-managed-identity-varchar-dehash.zh-CN.md)

## 状态与范围

- 状态：**提案**。本文不改动任何代码或 schema。实施需要各自的改动、基线复现与 MySQL 证据。
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

| 身份                                                       | 实际形态 / 长度                           | 证据                                                                                                                        | 预算             | 索引字节 |
| ---------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| `tenant_id`、`actor_id`                                    | 数值型，≤20 位                            | 上游库表定义 `tenant_id bigint(20) unsigned`、`act_id` 同类（维护者提供，2026-11-20）；以十进制串经 `X-Qwen-Tenant-Id` 注入 | `VARCHAR(36)`    | 144      |
| `session_id`                                               | UUID，36                                  | 转录文件即 `<uuid>.jsonl`（`packages/core/src/services/sessionService.ts:1841`）                                            | `VARCHAR(64)`    | 256      |
| `workspace_id`                                             | `workspace-` + UUID 派生 receipt key，≈46 | `WorkspaceCreationStore.java:278,309`                                                                                       | `VARCHAR(64)`    | 256      |
| `resource_id`、`operation_id`、`activation_id` 等生成 id   | `randomUUID()`，36                        | `http-managed-session-store.ts`、`managed-session-assembly.ts`、Java `UUID.randomUUID()`                                    | `VARCHAR(64)`    | 256      |
| 外部渠道 `account_id`、`sender_id`、`chat_id`、`thread_id` | 平台 opaque、变长                         | schema 注释 "External platform … identity"                                                                                  | `VARCHAR(512)`   | 2048     |
| `object_key`、`capture_object_key`                         | OSS key、长、不进索引                     | `ma_resource`、`ma_journal_pack`                                                                                            | 保持 `VARBINARY` | 不适用   |

utf8mb4 下 `VARCHAR(N)` 按 `4×N` 字节计入索引键算术；磁盘存储为实际字节。类表给出
默认值；实施须枚举每个身份列的生成格式并定稿逐列预算，显式列出例外（如复合
turn/event id）。

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
  `(guard_scope, guard_domain)`，其中 `guard_scope VARCHAR(64)` 是**可读** scope：
  租户域用 tenant 十进制串，跨租户/主机锁用显式哨兵
  （`external-storage-registration/1`、`local-storage-host/<hostId>`，≈55 字符）。
  哨兵不是数值 tenant，不能硬塞进 `tenant_id VARCHAR(36)`；专用可读 scope 列在不
  哈希的前提下保留它们（256+128=384 字节）。
  `INSERT … ON DUPLICATE KEY UPDATE` + `SELECT … FOR UPDATE` 的获取形态与两个 domain
  不变（[lock inventory](2026-11-12-managed-agent-lock-inventory.md)）。
- **Session head。** `uk_ma_session_head_business_key (tenant_key, harness_key)` 改为
  `(tenant_id, harness_session_id)`（144+256=400 字节）；`FOR UPDATE` 锁点移到该原始
  唯一键。`idx_ma_head_workspace`、`idx_ma_head_wake`、`idx_ma_head_session` 在原始列
  重建。`head_kind` 语义不变。
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
  **可读** scope 串（明确不是哈希），并复核宽度。

### 外部渠道身份与 OSS key

- 外部平台 id 给 `VARCHAR(512)`；它们不领头宽复合键，故无需哈希即可容纳。若某部署的
  平台 id 可能超 512，该列单独保留压缩键（唯一允许的残留哈希）。
- `object_key` / `capture_object_key` 保持 `VARBINARY`（opaque 存储指针）。

## 应用层变更

- Java 绑定在 persistence、runtime-broker、control-plane、contracts、verification
  fixtures 全链路 `byte[]` → `String`；row mapper 与 binder 同步改（H2 拒绝字符串绑
  `VARBINARY`，故类型与绑定必须同一次改动移动）。
- 删除 `ManagedSchemaKeys.key()` 的身份派生（410 处调用）；摘要 helper 保留。跨表
  引用携带原始身份列。
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
- **压在哈希键上的生成列。** `ma_request_receipt.decision_scope_key`
  （`GENERATED … RTRIM(scope_key)`，V1:681）与 `ma_side_query.active_slot`
  （`GENERATED … actor_scope_key`，V1:1333）由哈希列派生；二者必须在原始 scope 列上
  重定义，或连同其消费方一起删除。
- **压在哈希键上的 CHECK 约束。** `ck_ma_resource_capture`（scope_key/slot_key 空值
  耦合，V1:508）、`ck_ma_ref_binding`（runtime_binding_key，V1:536）、
  `ck_ma_storage_registered`（physical_key，V1:989）引用哈希列，必须在原始列上重写。
- **前缀领头查询与 catalog 钉死。** 每个 `session_scope_key = ?` / `scope_key = ?`
  领头谓词必须保留其原始 `(tenant_id, session_id[, workspace_id])` 前缀，使重建索引
  仍约束扫描；钉死哈希列的 schema-shape meta-test 与 catalog 校验随 DDL 更新。

验收增加逐 store 的游标/锁序等价测试（同行、同序、并发下无死锁），以及两个引擎上的
生成列/CHECK 重写测试。

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

- 在全新 H2 与一次性 MySQL 8.4 重建 catalog；catalog 校验拒绝漂移、残留哈希列、错误
  collation；断言全部 246 键 < 3072。
- 跨引擎身份等值测试：大小写、尾随空格、多字节；MySQL NO PAD 与 H2 对齐行为。
- Admission 拒绝测试：超长/畸形 tenant/actor/外部 id。
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
