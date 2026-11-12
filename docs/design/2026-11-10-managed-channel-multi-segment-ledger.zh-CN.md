# Managed Channel 多分段交付台账

[English](2026-11-10-managed-channel-multi-segment-ledger.md) | [简体中文](2026-11-10-managed-channel-multi-segment-ledger.zh-CN.md)

状态：提议中。本文是 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 下 H5 channel 域（[H5 设计](2026-10-04-managed-channels.zh-CN.md)、[运行时设计](2026-10-07-managed-channel-runtime.zh-CN.md)）的存储地基切片。它让控制面的交付台账逐段保真，使后续适配器（H5d）或卡片界面（H5e）能落在其上。它不改 journal 记录契约、Harness 漏斗、可信线路面或公开 API 形状。

## 问题

Java 控制面台账之上的每一层都已支持 1–64 段的交付：

- H5a 记录契约（`managed-channel-record.ts`，由 `ManagedChannelRecords` 镜像）携带稳定的 `segmentId`/`ordinal` 计划，每段一个写一次的回执。
- Harness 漏斗（`hosted-channel-session.ts`）对 claim 应答**全部未结分段**，**按 ordinal** 接受回执（仍有分段时为 `partial`，最后一段为 `delivered`），重发只携带已证明未发送的分段。
- 可信适配器面（`ChannelAdapterModels`）已暴露 `ClaimedDelivery.segments[]` 与 `ReceiptRequest.ordinal`。
- email 适配器（`managed-email-adapter.ts`）已遍历每个被认领的分段、逐段发送、按 ordinal 逐段回执。

单分段瓶颈在控制面台账。`ma_delivery`（交付种类 `CHANNEL`）**每个 `deliveryId` 一行**，只带一个 `segment_id`、`segment_ordinal` 与 `provider_receipt_json`。对超过一段的交付，这会歪曲事实：

- `ManagedChannelService.claimOne` 把台账行钉在**第一个未发送分段**上。
- `receipt` 用最新回执覆盖 `provider_receipt_json`，而行的分段身份保持陈旧：较早的回执丢失，最新回执被归到错误的分段。
- `resend` 只取新链的 `segments.getFirst()`。
- `reconcileClaim` / `committedProviderReceipt` 取所有分段中**最后一个**回执。

对早前路线图措辞的一处纠正：**交付级**状态线（`planned → sending → partial → delivered`，以及 `unknown` / `rejected` / `cancelled`）已经通过 `stepLedger` 正确跟随已提交记录；`partial` 在交付级已经生效。缺口是**逐段身份与回执的保真**，不是交付状态线。

## 为什么不在 `ma_delivery` 里按段拆行

`ma_delivery` 由 `CHANNEL`、`SESSION_MESSAGE`、`CHILD_RESULT` 三种交付种类共享。它的唯一性（`uk_ma_delivery_identity (delivery_kind, source_scope_key, delivery_id)`）与认领机制——`claim_generation`、`claimed_at`、`reconcile_operation_id` 列、待交付发现查询、公开分页——全是**交付级**的。交付状态线包含 `partial`，这是交付的属性而非分段的属性。把 `ma_delivery` 拆成逐段行会重复或搁浅这套机制，并破坏共享表。因此交付级行仍是状态与认领的锚点。

## 决策

新增一个子分段台账：新表 `ma_channel_segment` 中每个 `(delivery_key, segment_id)` 一行，携带该分段的 ordinal 与其写一次的 provider 回执。交付行不变——它的状态线、认领围栏与单一代表字段继续服务既有公开读模型。分段表是恢复路径收敛、后续公开投影读取的持久逐段明细。

回执每段写一次、绝不改写，因此写入是一条幂等的 `UPDATE ... WHERE provider_receipt_json IS NULL`：没有读改写合并，没有两个并发回执之间的丢失更新竞态，重放的回执是空操作。这正是优先子表而非把分段计划塞进交付行 `payload_json` 的原因（后者需要在围栏状态转移内做原子 JSON 合并，并在重放路径上重算）。

### 模式（V1 基线，原地编辑）

按模块发布前的模式策略，新表加进 `V1__managed_schema.sql`；不引入 V2+ 迁移。

| 列                            | 类型              | 含义                                         |
| ----------------------------- | ----------------- | -------------------------------------------- |
| `delivery_key`                | `CHAR(64)`        | 父行 `ma_delivery.delivery_key`（CHANNEL）。 |
| `tenant_id`                   | `VARBINARY(512)`  | 租户隔离，与父行一致。                       |
| `channel_id`                  | `VARBINARY(512)`  | 租户内的 channel 实例身份。                  |
| `segment_id`                  | `VARBINARY(512)`  | 来自记录计划的稳定分段身份。                 |
| `segment_ordinal`             | `BIGINT UNSIGNED` | 交付内的位置，从 0 连续。                    |
| `provider_receipt_json`       | `LONGTEXT`        | 写一次的 provider 回执；未回执前为 null。    |
| `gmt_create` / `gmt_modified` | `BIGINT UNSIGNED` | 数据库时钟的 epoch 毫秒。                    |

唯一性 `uk_ma_channel_segment_identity (delivery_key, segment_id)`；索引 `(delivery_key, segment_ordinal)` 服务有序读取。该表登记进 `ManagedSchemaContract.TABLES` 与 `WorkspaceCsiApplicationInventory` 清单，跟随 `ma_delivery` 进入整租户清扫桶（`new Query("1 = 1", ...)`）。

### 仓储

新增 `ChannelSegmentRepository`（contracts）与 `JdbcChannelSegmentRepository`（persistence），与既有 channel 仓储并列：

- `plan(tenantId, channelId, deliveryId, segments)` —— 幂等插入分段计划（`INSERT IGNORE`），并回填既有行仍缺失的回执，携带记录已持有的任何回执（恢复的 `partial`）。已存回执绝不被覆盖。
- `receipt(tenantId, channelId, deliveryId, ordinal, providerReceipt)` —— 写一次的 `UPDATE`；返回是否写入。重放或冲突的回执保持已存回执不变。
- `list(tenantId, channelId, deliveryId)` —— 按 ordinal 有序的分段。

`delivery_key` 的推导与 `JdbcChannelDeliveryRepository.deliveryKey` 完全一致，因此分段行只能经其租户、channel 与交付身份到达。

### 服务接线（`ManagedChannelService`）

- `claimOne` 规划记录的**全部**分段（带其当前回执），而非仅第一个未发送的。交付级 `findOrCreate` 以记录的**首段**为身份，跨 resumed partial 稳定：若用首个未发送段，一旦有分段被回执，就会拒绝首次认领写入的行。
- `receipt` 在 Harness 提交之后、`stepLedger` 可能把交付移到终态**之前**，把按 ordinal 的回执记入分段台账。对账器跳过终态交付，因此回执必须在交付线关闭前持久化；回执写入失败会让交付保持开放、可恢复。
- `resend` 规划新链携带的（未发送）分段。
- `reconcileClaim` 把已提交记录中**每个**分段回执收敛进分段台账，而非仅最后一个。交付级代表回执不变。

### 读模型

本切片不变。`PublicChannelDelivery` 与可信 `DeliveryView` 保持其单一字段（第一个分段的身份与交付的代表回执）。把逐段明细作为公开 `segments` 数组暴露是紧接着的后续工作（API 切片），由它负责 OpenAPI 变更、契约版本与 WebShell 类型再生。

## 涉及文件

- `persistence/.../db/managed-schema/V1__managed_schema.sql` —— 新表。
- `contracts/.../persistence/ChannelSegmentRepository.java` —— 新接口。
- `persistence/.../JdbcChannelSegmentRepository.java` —— 新实现。
- `persistence/.../WorkspaceCsiApplicationInventory.java` —— 清单 + 清扫桶登记。
- `contracts/.../runtimebroker/schema/ManagedSchemaContract.java` 与 `verification/.../managedschema/ManagedSchemaTest.java` —— 表、其业务键（`delivery_key, segment_id`）与原始实体排除集。
- `verification/.../persistence/WorkspaceCsiApplicationInventoryTest.java` —— 声明列数棘轮增加新表的八列。
- `server/.../config/ManagedAgentConfiguration.java` —— 仓储 bean。
- `control-plane/.../channel/ManagedChannelService.java` —— claim / receipt / resend / reconcile 接线。
- `verification/.../channel/ManagedChannelServiceTest.java` —— 对着记录型 Harness 的多分段服务用例。
- `verification/.../persistence/JdbcChannelSegmentRepositoryTest.java`（H2）与 `JdbcChannelSegmentRepositoryMySqlIT.java` —— 分段计划 / 写一次回执 / 列表 / 隔离契约，以及一个并发回执 MySQL 用例。
- 本设计文档与其中文版本。

## 范围边界

- 不改 journal 记录契约、Harness 漏斗、可信线路面、email 适配器或公开 API 形状。
- 不做第二个适配器；多分段生产者不在本台账切片范围内，此后已落地（多分段生产者设计，2026-11-12），email 计划如今把长回复拆成有序分段。多分段行为经记录型 Harness 与仓储契约演练，而非真实 provider。
- 不做公开 `segments` 投影，不做 OpenAPI / WebShell 变更。

## 验证计划

- H2 服务用例：一个多分段交付被认领、按 ordinal 逐段回执（分段之间为 `partial`，最后一段为 `delivered`），每段回执持久且归属正确；重发只规划未发送分段；对账器在应答丢失后收敛每个分段回执。每条规则逐一禁用都有测试失败（变异见证）。
- 仓储契约（H2，并在 MySQL 重跑）：计划幂等、写一次回执（同段第二次回执不覆盖）、有序列表、租户/channel 隔离。
- 既有单分段套件在本切片保持绿色不变；其后的多分段生产者切片（2026-11-12）把长回复钉住点重定靶为有序分段。
- 新表的写一次与并发行为经一个继承 H2 仓储测试的仓储级 MySQL IT（`ManagedSideQueryStoreMySqlIT` 模式）取得真实 MySQL 证据，含「同段两个并发回执只留一个持久回执」；完整 Hosted/fault profile 仍归 CI。不新增 `Hosted*IT` 类，因此不重测共享 failsafe fork 预算。

## 未决问题

1. 公开 `segments` 投影（形状、契约版本、WebShell 再生）是下一个切片；本切片只让台账保真。
2. 分段行的保留跟随交付行的保留，而后者本身随 Session 归档/删除推迟（H5 运行时未决问题 2）。
