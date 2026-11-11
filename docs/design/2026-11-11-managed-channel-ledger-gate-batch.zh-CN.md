# Managed Channel 台账对账前置门与分段批量计划

[English](2026-11-11-managed-channel-ledger-gate-batch.md) | [简体中文](2026-11-11-managed-channel-ledger-gate-batch.zh-CN.md)

状态：提议中。这是 [#16818](https://github.com/QwenLM/qwen-code/issues/16818)
的健壮性/性能后续项（item A 与 B），在落地
[多分段交付台账](2026-11-10-managed-channel-multi-segment-ledger.md)（#16797）
及其[公开 segments 投影](2026-11-10-managed-channel-segments-projection.md)（#16807）
时延期。它们细化对账读取路径与分段台账的语句数，不改动日记账记录契约、交付状态线
或公开读取形状。

## 问题

地基遗留的两处开销：

- **A — 对账器重复读取已完成的交付。** `reconcileClaim` 对每个过期认领都读取并
  解析整条交付记录（LONGTEXT 资源体）并重规划其分段，包括它无法推进的认领。一条
  认领租约已过期的 delivered 交付每 30s 扫描都被返回，付一次 LONGTEXT 读 + JSON
  解析 + 逐分段语句却无有效功（#16797 R3-1）。
- **B — 分段计划逐段一条语句。** `plan` 每段写一条 `INSERT IGNORE`，每个已回执段
  再写一条回填 `UPDATE`，而 `claimOne` 对 `partial` 交付的每次认领轮询都重规划。
  在 64 段契约上限下，重认领的 partial 付约 127 条语句（#16797 R3-2）。交付列表
  读同样是 N+1：每行交付一次分段查询。

## 决策

### A. 按「可证完整＋全回执台账」给记录读取加前置门

读取记录体前，`reconcileClaim` 检查分段台账是否已持有**整个不可变计划**且每段回执
非空。计划段数随交付持久化（`ma_delivery.segment_count`，在交付行创建时写入），故门
仅凭台账即可证明完整：仅当台账恰好持有 `segment_count` 行且每行回执非空时才跳过
LONGTEXT 读。完整性证明是承重的：计划写入无事务（批量 `INSERT IGNORE` 逐条提交），
且其写入的每行都从记录带上回执，故中途打断会留下**带回收前缀**——无论记录处于何态
（包括 `delivered`）。台账恰好持有的行集不足以证明计划完整；短台账必须落入记录读取块，
由其 `planSegments` 补齐缺失尾部，而不是在截断链上关闭交付线。台账可证完整且全回执时，
门从台账自身的回执关闭滞后线（以末段回执 `stepLedger` 到 `delivered`），并完全跳过
读 + 解析 + 重规划。以下情况保留读取：

- 台账行数少于持久化的计划段数（截断计划仍需补齐缺失行，无论记录何态）；
- 台账行缺失或分段行缺失（pre-ledger 认领仍需记录回填计划）；
- 任何空回执（应答丢失的回执仍需收敛）。

真正受益的是崩溃窗口：末段回执已落库但台账到 `delivered` 的 `stepLedger` 失败——台账
持有整个计划、每段回执非空，却滞后于 `partial`，扫描持续选中该 `partial` 线。从台账
收敛即可关闭该线而**无需**记录读取；若仅按回执加门、只跳过读取，会把它搁死在
`partial`。收敛保持在结算路径之前：门在既有记录读取块之前运行；其后的结算路径不变。
交付行只加载一次并贯穿门与记录读取块；凡发生状态推进即采用其返回的行，故门在常见扫描
路径上不增加额外的点查。

### B. 批量计划插入与列表读取

`plan` 先校验整个计划，再对全部分段发一条 `jdbc.batchUpdate` 的 `INSERT IGNORE`
（`AgentEventJournal` 的写法），并按逐行计数驱动写一次回填：插入刚创建的行（计数 1）
已携带回执，故只有预先存在的行（计数 0，插入被忽略）需要带守卫的 `UPDATE`。报告
无逐行计数（`SUCCESS_NO_INFO`，-2）的驱动回退到带守卫的更新——它对已回执行是空操作。
回填与插入一样批量——对需要回填的行发一条带守卫的 `UPDATE` 批。两个批都把计划收敛为
每类语句一条 `PreparedStatement` 加一次 `executeBatch`，省去逐分段的 Java 侧语句构建。
网络往返的进一步减少还需 Connector/J 的 `rewriteBatchedStatements`，本模块未开启，故
服务端仍逐分段执行一条语句；开启该参数是独立的配置决策（见待决问题）。
`provider_receipt_json IS NULL` 守卫不变，故重放或竞态的第二回执绝不覆盖已存回执。

交付列表的 N+1 也批量：新增 `ChannelSegmentRepository.listByDelivery`，用一条
`WHERE delivery_key IN (...)` 查询读取整页分段，按 deliveryId 分组（各按 ordinal
排序，每个被请求的 id 都保留条目——无分段时为空）。它复用 `list` 所用的同一个
`RowMapper`，故两条读取路径不会对同一交付发布不同的 `segments`。`listDeliveries`
一次读整页，不再每行一次分段查询。`getDelivery` 保留单交付的 `list` 读取。

## 涉及文件

- `control-plane/.../channel/ManagedChannelService.java` —— 对账前置门
  （`convergeFullyReceiptedFromLedger`，按持久化计划段数加门）与批量
  `listDeliveries` 读取；认领/重发路径持久化计划段数。
- `persistence/.../db/managed-schema/V1__managed_schema.sql` ——
  `ma_delivery.segment_count` 列，持有不可变计划段数。
- `contracts/.../persistence/ChannelDeliveryRepository.java` ——
  `ChannelDelivery` 的 `segmentCount` 字段。
- `persistence/.../JdbcChannelDeliveryRepository.java` —— 随交付行读写
  `segment_count`。
- `persistence/.../JdbcChannelSegmentRepository.java` —— 批量 `plan` 与新增
  `listByDelivery`。
- `contracts/.../persistence/ChannelSegmentRepository.java` —— `listByDelivery`
  边界方法。
- `verification/.../channel/ManagedChannelServiceTest.java` —— 门的跳过见证
  （对普通实例存储打 spy，验证全回执台账绝不触发记录读取，而滞后崩溃窗口线仍收敛到
  delivered）与某段缺回执时保留读取的用例；`FailingSegments` 包装实现新边界方法。
- `verification/.../persistence/JdbcChannelSegmentRepositoryTest.java` —— 64 段
  批量、混合插入/回填空量、分组列表读取；MySQL 门禁在真实数据库重跑。
- 本设计文档及其中文版。

## 范围边界

- 不改日记账记录契约、Harness 漏斗、可信适配器面、分段台账模式、交付状态线或公开
  读取形状（`segments` 数组不变）。
- 不升契约版本：公开 API 文档未触碰。
- 门保持收敛结果不变：全回执线无论从记录还是从台账自身回执收敛，终态都是
  `delivered`；门仅移除冗余读取。

## 验证计划

- 门的跳过由普通实例存储上的 Mockito spy 钉住：一条被强制回 `partial` 且清空交付
  回执的全回执台账（崩溃窗口）以末段回执收敛到 `delivered`，同时验证 `readResource`
  绝不被调用；移除门即转红（读取会运行），转发空回执亦转红回执断言（fixture 清空该列，
  使门的写入承重，而非预置值经 `COALESCE` 存活）。一个伴生用例以空回执验证读取被保留。
  两个截断前缀用例（规划 3 段、删除尾部台账行只余带回收前缀——其一记录仍 `partial`、
  其一记录已 `delivered`）验证读取被保留且 `planSegments` 补齐缺失行、以计划末段回执
  而非前缀回执关闭；移除门的计划段数完整性检查两者均转红。
- 批量计划由既有回填/幂等用例加 64 段批量与混合批量钉住：混合批中预先存在的缺回执行
  所在批次位与其 ordinal 不同，故跳过计数 0 行或按 ordinal 取计数下标都会转红。一个
  打桩插入批返回 `SUCCESS_NO_INFO` 的用例钉住无逐行计数回退。回填亦批量，故重认领发
  一条带守卫 `UPDATE` 批而非每已回执分段一条语句。MySQL 门禁在真实数据库重跑。
- 分组列表读取由多交付页（一交付为空）钉住按交付分组与 ordinal 顺序，并复用与 `list`
  相同的 `RowMapper`。
- 改动模块 Checkstyle 通过；真实 MySQL 并发腿与完整 CI 套件仍为验证基线。

## 待决问题

1. 常见「缺回执 partial」仍付一次交付行查找加一次分段查询来判定门不适用；若该路径
   的扫描量增大，可考虑用更廉价的预检（如交付行上的回执计数）短路分段查询。
2. 是否开启 Connector/J 的 `rewriteBatchedStatements`（经模块集中管理的驱动属性、
   沿用既有运维覆盖门），使批量计划同时减少网络往返而非仅 Java 侧语句构建。这是
   模块级驱动行为变更，需真实 MySQL 的前后测量，故刻意不在本切片内。
