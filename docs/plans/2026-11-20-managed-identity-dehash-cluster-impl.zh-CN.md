# 实施计划：managed-agent-server 身份去哈希原子簇

[English](2026-11-20-managed-identity-dehash-cluster-impl.md) | [简体中文](2026-11-20-managed-identity-dehash-cluster-impl.zh-CN.md)

配套设计：[design EN](../design/2026-11-20-managed-identity-varchar-dehash.md) · [design ZH](../design/2026-11-20-managed-identity-varchar-dehash.zh-CN.md)。
状态：执行规格。增量 1（tenant guard）已在 #17927 合并。本计划覆盖剩余 join 连通簇，须原子转换。修订（2026-11-20）：按[重复业务键调研](../design/2026-11-20-managed-identity-varchar-dehash.zh-CN.md#重复业务键)及其决策更新。修订（2026-11-21）：增量 2（同行冗余哈希键，[设计](../design/2026-11-20-managed-identity-varchar-dehash.zh-CN.md#增量-2同行冗余哈希键)）先于原子簇落地；见[增量 2 执行](#增量-2-执行)。

## 为什么簇是原子的（没有可保绿子步）

- 身份列通过哈希键与原始 actor/scope 列互相 join（如 `ma_memory_store.owner_actor_key = COALESCE(ma_session.owner_actor_key, ma_session.creator_actor_key)`），转换单表会破坏 join 直到全部转换。
- 预算收缩与 fixture 对齐耦合：`VARCHAR(64)` 会拒绝现有长 fixture（`ws-<cwd>` workspace id、43 字符 `"tenant-"+UUID`），故 DDL 预算与 fixture 改动须同批落地。
- 除增量 2 的同行冗余键外，没有任何重复键哈希能在转换之前单独删除。按当前 VARBINARY 宽度，原始替代超过 3072 字节（storage alias 4096、resource 4608、`idx_ma_work_pending` 约 3200），且 `receipt_key` 被生成进公开的 workspace 与 storage id。Session head 键之所以能放下，只因增量 2 把 head 租户收窄到父表的 512 字节。
- 跨表哈希引用（`ma_message.body_resource_key`、`ma_event_stream.artifact_refs_resource_key`、`ma_resource_ref.resource_key` 等）无法展开为引用表中不存在的本地原始列；需在同批给引用表加原始 scope+resource 列（或规范可读键），即 schema 扩张。
- 探针（H2 2.4.240 MySQL mode）：`utf8mb4_0900_bin` 可解析，但列级 plain `CHARACTER SET … COLLATE …` 子句后接 `NOT NULL DEFAULT` 或用于生成列时会语法报错；须把 charset+collate 包进 MySQL 可执行注释 `/*!80000 … */` 让 H2 忽略。VARCHAR 等值/PK 为 NO PAD；`setBytes`→VARCHAR 在 INSERT/`getBytes` 往返保留 UTF-8 与尾随空格，**但 H2 拒绝 VARCHAR 列与 byte[] 绑定做 WHERE 比较**（`CHARACTER VARYING` 与 `BINARY VARYING` 不可比）。故仅改 DDL 类型的迁移必红：DDL 类型变更与 Java `byte[]`→`String` 绑定变更须同批落地，叠加上述预算/fixture/哈希耦合。仅迁移绑定（String 绑定对接仍为 VARBINARY 的列）同样红：H2 比较要求绑定类型族与列类型族一致（`BINARY VARYING` 与 `CHARACTER VARYING` 不可比），故两半都无法单独落地。

因此：单分支、转换期间暂红、仅在全绿时 commit+push。

执行尝试日志（2026-11-20，经授权硬推）：曾以定向脚本尝试 trio（278 列 DDL raw→VARCHAR + helper/`actorKey` 绑定→String）。编译暴露约 40 处 ripple，横跨 contracts records/接口（`StoreModels`、`ManagedToolResultStore`）、persistence stores 与 control-plane；泛化 `getBytes(`→`getString(` regex 还误伤了摘要计算（`String.getBytes(UTF_8)`），证明绑定迁移必须逐点编译器引导、绝不能泛化 regex。该尝试已回退到增量 1 绿基线；未推送红代码。故剩余批次=对 ripple 的一次编译器引导人工 pass，加上下述删哈希/重建/游标/生成列/CHECK/meta-test 工作。

### 安全绑定迁移配方（编译器引导，禁泛化 regex）

- `byte[]`→`String` 变量名白名单：`actorKey`、`ownerActorKey`、`owner`、`creator`、`actor`。**绝不改 bare `key`**（crypto 签名/bracket key 是 byte[]，如 `RuntimeBrokerBracketKeyBindingTest` 的 `Arrays.fill`）；绝不改用于摘要/签名的 `getBytes`。第二次会话内尝试证实：白名单 pass 后主代码可编译，但 verification 测试源（约 56 文件）仍需迁移，且 bare-`key` 替换会坏 crypto key。
- **`List<byte[]>`、`byte[].class`、`Arrays.equals` 不是安全的全局替换**：二进制载荷列（`inline_bytes`、`record_bytes`）合法使用它们。第三次会话内尝试证实全局替换会坏二进制载荷读取（`SELECT inline_bytes … byte[].class` 被改成 `String.class`）。这些只能在身份读取点手工改；对二进制载荷做 `Arrays.equals`→`Objects.equals` 会静默破坏内容相等。全局安全的只有：变量名白名单、`setBytes(x.getBytes(…))`→`setString(x, …)`、helper 签名；其余逐点编译器引导。
- 中心 helper：`JdbcRepositorySupport.setIdentity`→`setString`；`ManagedSchemaRows.identity`→`getString`；`ManagedWorkspaceRegistry.actorKey`→返回 String；`ManagedReceipts.actorScope(String)`→`Base64(actor.getBytes(UTF_8))`；`UNATTRIBUTED`→`""`；`ManagedRuntimeRetentionGuard.identity`→`return value`。
- 语义修复由编译错误驱动：身份行读取 `getBytes`→`getString`；`return x.getBytes(UTF_8)`→`return x`；`actor.length==0`→`isEmpty()`；byte[]/String 条件表达式；**仅身份点**`Arrays.equals`→`Objects.equals`、`List<byte[]>`→`List<String>`、`queryForObject byte[].class`→`String.class`；测试 `containsExactly`/`fill` 身份值→String。
- 循环：白名单类型脚本（主+verification 测试）→`test-compile`→人工修所列语义点→重复至编译绿→广谱 H2→双 Checkstyle→提交。

## 增量 2 执行

范围、保留键与查询规则见[设计](../design/2026-11-20-managed-identity-varchar-dehash.zh-CN.md#增量-2同行冗余哈希键)。执行要点：

- 单个改动：V1 DDL、`ManagedSchemaProjection`、`ManagedSchemaTest` 业务键、所有生产查询与所有 verification fixture 一起改。VARBINARY 类型不变，绑定保持原类型。
- 生产 SQL 逐语句重写，绝不按关键字删除。每个被删谓词都保留重建索引的原始 `(tenant_id, session_id)` 或 `(tenant_id, harness_session_id)` 前缀；join 到 `ma_session` 时保留登记标记。
- 测试 SQL 由语句级工具重写后再审计。把 scope 变量解析为租户与 Session 时，必须取作用域内最近的声明（含方法参数）；按全文件最后一次定义解析会静默把 fixture 指向另一个 Session，并可能让断言变成空断言。原先植入与原始列不一致的哈希（伪造外部 scope 或冲突 head）的 fixture，改为使用真正不同的租户或 Session，因为原始键现在是唯一的键。
- 绑定数断言随语句形状变化（automation ledger 批量每个 run 三个绑定，capture GC 入队每行十二个）。

## 执行顺序

1. **DDL（V1 原地）。** 文本身份 `VARBINARY` 转 `VARCHAR` 预算，逐列 NO PAD collation 以 MySQL 可执行注释 `/*!80000 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin */` 表达（H2 忽略；plain 子句在 `NOT NULL DEFAULT`/生成列处会语法报错）；二进制载荷（`record_bytes`、`object_key`、`capture_object_key`）保持 `VARBINARY`。删 60 个 "Hashed" 列及同族派生身份键（`physical_key`、`storage_key`、`holder_key`、`*_resource_key`、`import_key`、`runtime_binding_key`、`execution_storage_key`、`delivery_key`、`result_operation_key`、`deletion_operation_key`）。保留 32 个内容摘要列与 git-sha `VARCHAR(64)` 列。在原始列上重建所有用到被删键的唯一键/索引；删 `ma_session.uk_ma_session_scope`（与 PK 冗余）。在原始 scope 列上重定义生成列 `ma_side_query.active_slot`；在原始列上重写三个 CHECK（`ck_ma_resource_capture`、`ck_ma_ref_binding`、`ck_ma_storage_registered`）。join 迁离 `ma_session` 哈希列时显式保留已登记 Session 限制，并给 `ma_read_lease` 补原始 `tenant_id` / `session_id`。删除 `operation_key` 之前，为按 tenant 定位的 kind 新增生成列 `tenant_operation_id` 与 `UNIQUE (tenant_id, operation_kind, tenant_operation_id)`，并把它们的查找改到该唯一键上（设计决策 3）。保留 `ma_request_receipt.receipt_key` 及其唯一键，作为生成的标识（决策 1）。`workspace_id` 与 `storage_id` 定为 `VARBINARY(128)` 与 `VARBINARY(256)`，这两列保持字节绑定（决策 2）。
2. **跨表引用。** 给每个引用表补其所缺的原始 scope+resource 列（按需 `tenant_id`、`workspace_id`、`session_id`、`resource_id`）并在写入时填充；join/唯一键中用这些原始列替换哈希引用列。若某表承载不了完整 scope，改用规范**可读** resource key `VARCHAR(256)`（明确不是哈希）并复核索引宽度。
3. **Java 绑定 + 派生。** persistence/runtime-broker/control-plane/contracts/verification 全链路 `byte[]`→`String`；删 `ManagedSchemaKeys.key()` 身份派生（410 处）但保留摘要 helper，以及生成公开 id 与路径的派生（workspace/storage id 用的 `receiptKey`、workspace 根目录用的 `key(tenant)`）；按类别重写 ~1613 处列引用：等值、领头前缀（`tenant_id=? AND session_id=? …`）、键集游标、`FOR UPDATE` 序、生成列消费方、CHECK 消费方、projection（`ManagedSchemaProjection`）、contract 表清单、schema-shape（`ManagedSchemaTest` BUSINESS_KEYS）与 catalog 校验。
4. **游标 + 锁序。** 把哈希全序的键集游标与 `ORDER BY … FOR UPDATE` 获取序替换为复合字典序元组序（如 `(tenant_id, session_id, resource_id)`），游标用 row-value 比较，且所有锁这些行的事务保持**同一**全序（防死锁）。涉及 store：`ManagedSessionRetirementStore`、`WorkspaceRecoveryStore`、`SessionResourceCollectionCollector`、`JdbcHostedCleanupDebtStore`、`ManagedExtensionQueries`、`JdbcAutomationLedgerStore`。
5. **契约 + admission + fixture。** 边界加 fail-closed 身份长度/格式校验（tenant/actor ≤36、UUID/前缀形态、外部 ≤512）；verification fixture 与 dev 默认值对齐预算（替换 43 字符 tenant 与超长 `ws-<cwd>` workspace id）；保留多字节与尾随空格语义测试；回归测试绑定真实的回执派生 `workspace_id`（74 字符）与 `storage_id`（73 字符），一个 128 字符的注册方指定 workspace id 与一个 256 字符的 storage id。
6. **Meta-test。** 随 DDL 更新 schema-shape 钉死、catalog 校验、surface fixture（`managed-surface.txt`）；加逐键宽度断言（<3072）与逐 store 游标/锁序等价测试（同行、同序、并发无死锁）。

## 预算（索引字节 = 4×字符，utf8mb4）

| 类                                        | 预算           | 字节   |
| ----------------------------------------- | -------------- | ------ |
| tenant / actor（上游数值 ≤20）            | VARCHAR(36)    | 144    |
| UUID 类 id                                | VARCHAR(64)    | 256    |
| workspace_id（ASCII 契约，最长 128 字符） | VARBINARY(128) | 128    |
| storage_id（ASCII 契约，最长 256 字符）   | VARBINARY(256) | 256    |
| 外部渠道 account/sender/chat/thread       | VARCHAR(512)   | 2048   |
| 规范可读 resource key（回退）             | VARCHAR(256)   | 1024   |
| 二进制载荷 / OSS object key               | 保持 VARBINARY | 不适用 |

guard 例外（已落地）：`ma_tenant_guard.tenant_id VARCHAR(96)` 可读 scope 承载哨兵（`local-storage-host/<64-hex>`=83 字符）；PK `(tenant_id, guard_domain)`。回归测试绑定真实 64-hex 主机哨兵；`ManagedSchemaMySqlIT` 钉死列宽与 `utf8mb4_0900_bin` collation。

## 验证

- 隔离 Maven 仓库：`cp -Rc ~/.m2/repository /tmp/dehash-m2`；装 sibling SDK `mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true -Dmaven.repo.local=/tmp/dehash-m2 install`。
- 转换后 `cd packages/managed-agent-server && mvn -Dmaven.repo.local=/tmp/dehash-m2 test`（全量 H2 套件）；若改编译期常量先 `mvn -pl verification clean`。
- `mvn checkstyle:check checkstyle:check@runtime-broker-checkstyle`（双 execution）。
- 一次性 MySQL 8.4：竞态套件（guard/head/claim/drain/rename/retirement/receipt）与 `ManagedSqlPerformanceMySqlIT` 基线 vs 改动指纹 + examined 行数；无本地 MySQL 则记 pending CI。native/media 测试需已构建 core+cli TS dist。
- 仅当编译 + 全量 H2 + 双 Checkstyle 全绿才 commit+push；MySQL 门未本地跑时记 pending CI。

## 验收

- 无残留身份哈希列；全部 246+ 重建键 <3072 字节；两引擎 NO PAD 字节精确等值；游标/锁序等价且无死锁；admission 拒绝超长 id；fixture/dev 对齐；全量 H2 + 编译 + 双 Checkstyle 绿；MySQL 竞态 + sqlperf 证据（本地或 CI）。
- 回执派生的 workspace 与 storage id 按真实长度往返；迁离 `ma_session` 哈希列的 join 保留已登记 Session 限制；按 tenant 定位的 operation 唯一性由生成列唯一键保持（重试的 SSH 创建只产生一个 operation）；`created-` / `imported-` 根目录仍经 `receipt_key` 解析。
