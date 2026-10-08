# 流式捕获输出的回收（O4 扩展，P1）

[English](managed-stream-capture-collection.md) | [简体中文](managed-stream-capture-collection.zh-CN.md)

## 问题与基线

O4（`managed-tool-output-retention.md`）让工具输出的物理回收变得安全，但只覆盖
`qwen_tool_publication` 行 —— 即前台 Shell 的 O2 发布。#13265（H3）让后台 Shell
成为第二个真实的生产者。它的字节并不进入发布协议：每个分段、页与 manifest 都通过
`POST /tool-results:publish`（`ManagedSessionStore.publishToolResult`）写入
`qwen_managed_session_resource`，行的形状是 `state = 'PUBLISHED'`、
`storage_kind = 'MYSQL_INLINE'`，kind 为 `managed-tool-result-content`（上限 1 MiB）、
`managed-tool-result-page`（上限 256 KiB）或 `managed-tool-result-manifest`（上限
64 KiB）三者之一。前台 Shell 的流式遗留输出与它是同一形状。

生产代码里没有任何路径会删除 `qwen_managed_session_resource` 行。该表自 V4 起就
带着一个从未被使用的 `retention_until` 列；唯一释放内联字节的路径，是 O4-2 回收器
对「已被某个已回收发布物编目」的副本所做的清空，它只触及 `REFERENCED` 行，永远不
会触及本通道针对的 `PUBLISHED` 流式捕获行。因此即使 `gc-enabled = true`，一个长时间运行的后台 Shell 也会无限期持有它产生过的每一个字
节：在托管存储下，这些行（前台遗留与后台捕获一样）以 `MYSQL_INLINE` 形式驻留在
MySQL 里。Session 级退役墓碑（`qwen_output_session_retirement`，V30）已经能在
Session 被永久删除时证明写入者已关闭；缺的是在同一策略下释放这些行字节的回收通道。
这就是 #13534 的 P1。

基线：`main` = `2e962b6121`。V30/V34 的生命周期（`PINNED → RETIRING → DELETING →
COLLECTED`）、`ToolPublicationRetentionStore.candidate` 中的候选谓词、以及
`ToolPublicationCollector` 的 claim/分页/确认形状全部保持不变。

## 契约与范围

Session 仍然是保留根。流式捕获输出与 O4 发布物一样，在 close、archive、Runtime
draining 与事件过期期间都保持钉住。Session 的永久删除会写入既有墓碑；经过同一
`deletion-grace`（默认 24h）、并在证明没有读者、写者或恢复流程依赖这些字节之后，
回收通道丢弃该 Session 流式捕获行的字节副本。身份行（`resource_id`、`kind`、
`byte_length`、`sha256`、`publish_command_id`、时间戳、journal 引用账本）永不删除。

逐行的可回收条件：

- `qwen_managed_session_resource` 行满足 `state = 'PUBLISHED'`、
  `storage_kind = 'MYSQL_INLINE'`、`schema_version = 1`、
  `object_key`/`object_version_id`/`encryption_key_id` 全为 NULL、
  `inline_bytes` 仍然存在，且 `kind` 为上述三个 `managed-tool-result-*`
  种类之一，同时 `byte_length` 落在 `toolResultLimit` 已经 fail-closed
  执行的逐 kind 上界内（content ≤ 1 MiB，page ≤ 256 KiB，manifest ≤ 64 KiB）。
  违反这些布局不变量的行只可能来自损坏，由 fail-closed 读方保护为证据；本通
  道绝不丢弃它的字节。存在性谓词守护的是记账而非字节清除：`byte_length` 是
  比字节更长命的元数据，因此已被其它写者释放过的行不得被重复计数；
- 其 Session 存在退役墓碑，`recovery_protected` 为 false，且
  `retired_at + deletion-grace` 已经过去；
- 该 Session 不存在未到期的 `qwen_output_read_lease`；
- 不存在以该资源为名的 `qwen_managed_session_resource_ref` 行。

落在谓词之外的行保持钉住并保留全部字节，保守且永久：

- `state = 'REFERENCED'` 的行。它们属于已提交事务与 tool-publication 的 admission
  副本；O4-2 回收器只清空被已回收发布物编目在 `qwen_tool_publication_object` 中
  的行的字节，而经由普通事务提交的 manifest 并不编目在其中。
- monitor 观察输出（kind 为 `managed-monitor-observation`）、MCP 记录、media 对象、
  checkpoint 以及其它一切 kind。
- 带有 journal 引用的 PUBLISHED 行。每一次已提交 Shell 捕获的封存 manifest 恰恰
  就是这样的行 —— 前台回执携带 `resources: [manifestRef]`，后台捕获的 manifest
  以 `child_run.outputRef` 到达 —— 因此它被永久钉住：P1 只释放分段、分页与内容
  字节，#13534 的「封存 manifest」交付项保持开放，留待一个能在不破坏 CSI 不变量
  的前提下回收带引用行的后续切片。要求 `qwen_managed_session_resource_ref` 不存
  在，是为了保护 CSI checkpoint 快照 —— 该快照要求每条引用行都能解析到一个存活
  资源。
- 违反布局不变量的行：未知 `storage_kind`、`object_key`/`object_version_id`/
  `encryption_key_id` 非 NULL、`schema_version` 不符、或 `byte_length` 列超出逐
  kind 上界。`verifyStoredResource` 对这些行保持 fail-closed；回收通道绝不清空它们
  的字节。但该谓词从不把存储的字节与 `byte_length` 或 `sha256` 比较：字节已与自身
  元数据不符的行会像其他行一样被回收，而回收之后，`verifyStoredResource` 本可报告
  的损坏在任何地方都不再可见。

行状态词汇新增一个值：`COLLECTED`。处于 `COLLECTED` 状态的行保留其元数据、
`inline_bytes = NULL`，且永远不会回到其它状态。不新增基于时间的 TTL 回收（永久
Session 删除之外的场景）：`retention_until` 继续闲置。

## 回收与记账

一张新表按 Session scope 记录一份回收账本（迁移 V53）：

```
qwen_managed_session_resource_collection
  session_scope_key CHAR(64) PRIMARY KEY
  tenant_key CHAR(64), session_key CHAR(64)
  tenant_id VARCHAR(128), session_id VARCHAR(512)（审计副本）
  gc_generation BIGINT          -- claim 防护，对应 gc_generation
  gc_owner VARCHAR(36) NULL     -- 回收实例身份（每进程一个 UUID）
  gc_claim_until BIGINT         -- 毫秒；60 秒 claim 预算
  gc_next_at BIGINT             -- 下一次尝试的到期时间；回收完成后为 -1
  gc_cursor VARCHAR(512)        -- 最近回收的 resource_id（起始为 ''）
  gc_blocker VARCHAR(64) NULL   -- 最近一次评估出的 blocker，供观察用
  collected_at BIGINT NULL
  collected_bytes BIGINT NOT NULL DEFAULT 0
  created_at DATETIME(6)
```

已完成的行以 `gc_next_at = -1` 落在 claim 扫描的 `gc_next_at >= 0` 区间之
外，因此即使账本行永久保留，每 tick 扫描的开销也只与未完成工作量成正
比。V53 同时新增 `idx_output_session_retirement_due (retired_at)`，使到
期候选扫描（`r.retired_at <= now - grace`）走索引：墓碑永不删除，没有
索引时每个 60 秒节律周期的扫描代价将永久为 O（已退役 Session 数）。

回收器镜像 `ToolPublicationCollector`：在既有的单线程 `managedToolOutputScheduler`
上每 tick 一次有界回收，使大 blob UPDATE 永远不占用在线会话调度器。

1. 当某个 Session 的墓碑首次到期（`retired_at + deletion-grace <= now`）时创建账本
   行；该扫描每次至多检查 32 个到期候选（`retired_at` 最老优先），并按每实例
   60 秒的节律运行。到期积压为空时，一个 Session 在其宽限结束后约一分钟内
   进入可回收状态；在批量退役之后，或在退役历史很深的集群上首次开启时，积
   压以每实例约每分钟 32 个 Session 的速度进入回收。这个粗节律为历史级扫描
   的成本封顶（开放问题 3）。
2. claim 在 tenant 与 Session 锁下（`ToolPublicationRetentionStore.lockSession`）重估
   资格：墓碑行存在且身份一致、journal head 缺失（写者已关闭 —— 发表必需 head，
   且退役后不可再造）或读取为 `state = 'DELETED'`、`recovery_protected` 为 false、
   grace 已过、且无未到期读租约。blocker 为 `session_not_retired`、
   `recovery_protected`、`grace_period`、`session_head_live`（存活、非 `DELETED`
   的 head）与 `reader_active`。每次失败都按与发布回收器相同的退避分类法重排：
   `recovery_protected` 等 24 小时，`grace_period` 等到
   `retired_at + grace`，其它 blocker 一律 60 秒。
3. 确认的 claim 持有账本 60 秒。每一页在同一个数据库事务里完成：选取 `cursor` 之后
   至多 100 行合格行，若其字节总量超过 32 MiB 则提前结束本页；把这些行翻转为
   `COLLECTED` 且 `inline_bytes = NULL`，把它们的 `byte_length` 总和累加进
   `collected_bytes`，并把 `cursor` 推进到最后回收的 resource_id。字节预算是有意义
   的：content 行可达 1 MiB，MEDIUMBLOB 更新不是零成本。全部效果落在同一事务内；
   崩溃绝不会留下半回收的行；因为这些行没有任何对象存储写入或删除，所以也不存在
   事务外步骤。
4. 找不到 `cursor` 之后更多合格行的那一页关闭 claim：设置 `collected_at`，清空
   `owner`/`claim_until`，把 `collected_bytes` 作为永久记账留下。账本行永久保留，与
   被回收发布物的目录行一致。从未跑过流式捕获的 Session，合格行之和合法地为零。

没有配额需要释放：`PUBLISHED` 行在任何地方都不携带 `capture_held_bytes` 式的计
费。`collected_bytes` 是被丢弃各行的 `byte_length` 元数据之和：对生产路径写入的每
一行，它等于实际释放的字节数；对字节已与自身元数据不符的行，则可能大于实际值。
部署侧通过回收器日志观察它。被阻塞的账本保持全部计费不动并记录其 blocker，与发布
回收器的观察者模型一致。

claim 防护使用与 `ToolPublicationCollector` 相同的证据：一个过期 claim 只能经由原
owner/generation 防护被接管（`generation + 1` 且 `owner = self`），因此两个 broker
实例绝不可能重复回收同一页。`collected_bytes` 只在同时推进 `cursor`、并检查
`generation` 一致的所有权的事务内增长，因此字节恰好被释放一次。

## 回收后的可观察结果

被保留的引用必须解析为准确的结果，而不是不可读或判定为损坏。一个闸门事
实决定了所有表面的行为：一行只有在它的 Session 已被立墓碑、journal
head 为 `DELETED` 之后才可能进入 `COLLECTED`，而 `ManagedSessionStore`
的每个漏斗在触达该行之前都已被拦截 —— 对任何立了墓碑的 Session，
`requireLive` 抛出 `tool_output_session_retired`，写路径则要求 `ACTIVE`
的 head。因此各结果面是：

- `ManagedSessionStore` 读写面（`readResource`、`publishToolResult`、提
  交路径）：不变 —— 与一个已退役 Session 一贯的回答完全相同
  （`tool_output_session_retired` / writer conflict）。被回收 run 的准确
  「已退役」结果就是既有的 Session 级围栏；这里不新增错误码。
- `storedResource`（提交时按 REFERENCED 查询）对任何非 REFERENCED 行继续
  以既有 `managed_session_resource_missing` 冲突应答，与今天一致。
- `WorkspaceRecoveryReader.resource` 在 bundle 读物理触达一份已回收字节时，
  以新增的命名检查 `resource_collected` 失败，而不是
  `resource_layout_unsupported` 或 `resource_corrupt`。这是唯一可能真实碰到
  已回收行的表面，现在它给出了准确的命名结果。
- `WorkspaceCsiCheckpointSnapshotStore` 只选取 `state = 'REFERENCED'` 的行，因此不
  受影响；CSI 快照从不包含 PUBLISHED 行，上述无引用谓词保持着这个不变量。

通道不变：TS 运行时继续经由相同端点读取；broker 错误码照旧向上传播。TS 侧的分类
变化不在范围内（见非目标）。

## 配置与发布

不新增配置键。本通道只在 `qwen.managed-agent.tool-publication.enabled` 与
`qwen.managed-agent.tool-publication.gc-enabled` 同为 true 时运行，并使用既有
`deletion-grace`（默认 24h）。默认值不变：`gc-enabled` 为 false 时绝不丢字节、也不
创建账本，既有部署无感知变化。Bean 放在 `ToolPublicationConfiguration` 里
`ToolPublicationCollector` 旁边。

发布注意事项：

- 落地前立即按最新 `main` 向前重排迁移号（O4 迁移已建立的重排纪律）。
- 运维文档（`managed-tool-output-retention-operations.md`）补一段：开启 GC 现在同时
  会释放流式捕获字节；其部署门禁（先升级 Java 写者、隔离 OSS、数据库门禁）照旧适
  用。
- 没有 V53 的旧版 broker 不会启动本通道。由于没有版本握手，第一台升级的 broker 在
  `gc-enabled` 已为 true 时立刻开始回收；低于 V53 的 broker 会把合法回收的行误报
  为 `resource_layout_unsupported`，因此升级期间仍可能回滚工作负载的集群应保持该
  开关关闭，直到全部 broker 跑上 V53 —— 与 O4 发布已要求的「先升级全部写者」顺
  序一致。

## 影响面与交付

| 层                                                        | 变化                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 迁移 V53                                                  | 新增 `qwen_managed_session_resource_collection` 账本表；`qwen_output_session_retirement` 的 `retired_at` 索引 |
| `store/SessionResourceCollectionCollector.java`（新）     | tick、候选扫描、claim、分页、字节记账                                                                         |
| `store/WorkspaceRecoveryReader.java`                      | `resource_collected` 命名检查                                                                                 |
| `config/ToolPublicationConfiguration.java`                | 复用现有调度器的回收器 bean                                                                                   |
| `store/SessionResourceCollectionCollectorTest.java`（新） | 谓词、blocker、分页、防护、字节精确记账、退役围栏后的结果                                                     |
| `packages/sdk-java/managed-agent-server/README.md`        | 运维一段                                                                                                      |

不在本变化内：`ToolPublicationRetentionStore`、`ToolPublicationCollector`、以及除文
档链接外的所有 TS 包均不改动。刻意不把发布回收器与本回收器合并出一个公共骨架：
两条通道各自约 200 行、表不同，共享骨架只会增加耦合而不减少策略面。

## 验收与验证

单元测试（JUnit，基础设施镜像 `ToolPublicationCollectorTest`）必须证明：

1. 一个已退役、超过 grace、墓碑有效且无租约的 Session，其合格行被按字节精确回收
   （被回收行的 `SUM(byte_length)` 等于 `collected_bytes`），且 `inline_bytes` 已清
   空。
2. 每个 blocker 都让所有字节保持不动：无墓碑；`recovery_protected`；grace 未到；
   存活（非 `DELETED`）的 journal head；存在未到期读租约。每个 blocker 都持久化
   记录并带正确的下次尝试时间（`24h` / `retired_at + grace` / `60s`）。
3. 逐行排除：`REFERENCED`、kind 不符、`TOOL_PUBLICATION` 存储、存在引用行、超出
   字节/kind 边界的行都不被回收；全部被排除的 Session 仍以
   `collected_bytes = 0` 完成。
4. 分页：超过一页的捕获按 cursor 顺序回收，在 100 行与 32 MiB 两个上限下分页边界
   均确定，且页间被 kill 后恢复不产生重复计数。
5. 防护：两个回收器身份只能经由 generation-owner 交接持有账本；过期 claim 被接管
   并完成。
6. 结果面：回收完成后，对已退役 Session 的 `readResource` 以既有
   `tool_output_session_retired` 冲突应答（不是损坏判定，也不是新造的错
   误码）；`WorkspaceRecoveryReader.resource` 应答 `resource_collected`；
   `verifyStoredResource` 对被篡改的非已回收行仍然 fail-closed。

真实 MySQL 验证：字节丢弃是 SQL 本地的，因此既有 H2/testcontainer 测试足以提供单
元证据；本切片不扩展真实 MySQL 的 O4 门禁。后续在运维方需要机群数字时，可以向 O4
部署门禁补一个有实测的闭合计费案例（大于 100 MiB 的捕获）。

## 非目标与开放问题

- P2（MCP 结果保留）与 P3（media 与共享输出）是 #13534 的独立切片，引用闭包不同：
  MCP 记录的 set-once 引用规则与 omni 对象存储的跨 Session 内容寻址各自需要独立的
  设计。
- 本地文件运行时（`LocalToolResultSegmentStore`，运行时基目录下的文件系统布局）不
  归本设计管理；它的保留是独立的主机本地问题。
- 回放容忍：`loadExtensionRevision` 在恢复工作区时会重读 `child_run.outputRef`。
  该 manifest 行带有 journal 引用、永远不会被回收，但它指向的分页与内容行不携带
  引用行，是可回收的。如果某台机器在一个已退役 Session 的字节被回收之后回放它的
  journal，回放会在某个分页或内容行上撞上 `resource_collected` —— 这是一个准确
  的结果 —— 但恢复是否应当对带墓碑的 Session 跳过引用闭包检查，是一个开放的产
  品决策。P1 不改动回放。
- 按 tenant 的 `collected_bytes` 机群级汇报（metrics 端点）留待运维跟进。

开放问题：

1. 观察者（`ToolPublicationRetentionObserver`）是否也应为新账本 blocker 采样进入其
   直方图，还是 P1 阶段每 claim 一行的日志足够？
2. 32 MiB 是不是生产 MySQL 上大 blob 行的正确页字节预算，还是预算应当遵循
   `max_allowed_packet` 式的内省而不是常量？
3. 60 秒的账本创建节律对退役历史很深的集群是否够用？扫描走索引但每个节律 tick 仍
   遍历全部历史；基于 `retired_at` 的持久高水位游标可以让开销与新增到期量成正
   比，代价是跨实例的游标状态。在拿到机群数字之前暂不实现。
