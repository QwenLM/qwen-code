---

# EventTransport：Managed Agent 控制面的 MQ 分发

[English](2026-10-04-managed-agent-event-transport.md) | [简体中文](2026-10-04-managed-agent-event-transport.zh-CN.md)

**状态：设计预留·未交付。** 传输侧仍未实现：仓库中不存在 MQ 客户端、
消费者以及跨节点唤醒。（成文时仓库中尚不存在 `EventTransport` 类型；MQ1
此后已落地该接口与组合 seam——见
[2026-10-11-managed-agent-event-transport-seam](2026-10-11-managed-agent-event-transport-seam.zh-CN.md)。）
下文所有架构陈述都是
前瞻性的设计预留，不是对运行中代码的描述；涉及架构的各节标题均再次标注。
本文件不改变任何生产行为，不随附任何生产代码。

属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)，认领其被推迟的
「optional MQ/Redis transport … later design scope」范围。跟随 H 阶段跟踪单
[#12827](https://github.com/QwenLM/qwen-code/issues/12827)；实现阶段的门禁依赖
[#13300](https://github.com/QwenLM/qwen-code/issues/13300)（H0c 评审跟进项）与
[#13265](https://github.com/QwenLM/qwen-code/issues/13265)（H3 后台 Shell 与
Monitor 运行时，后者落定唤醒路径所承载的持久任务事件与取消语义）。
上游权威设计：固定于 `6891216` 的扩展运行时文档
[managed-agent-extension-runtime.md](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)
（第 1 节与架构流程）。
仓内相关设计：[存储与事件架构](2026-09-20-managed-agent-storage-event-architecture.zh-CN.md)
已勾勒概念性 Java
`EventTransport { publish(CommittedBatch); consume(ConsumerSpec, BatchHandler) }`
并点名 "RocketMQ or Redis Streams"，且明确留作「proposed follow-up work」
（"external EventTransport, PostgreSQL adapter, multi-instance wakeup … remain
proposed follow-up work"）。本文是该被推迟范围的细化后承，收窄到 #12380 的认领范围。
基线：`main` 的 `5ddfacc9d4`（2026-10-04）。

## 1. 问题与范围

Managed Agent 提案把产品级持久资源交给 Java 控制面：定义修订、运行记录、Session
路由、outbox、租约代际、配额与公共投影。目前整条提交后分发路径都是单进程的：
Java 侧 after-commit 扇出是进程内的 `SessionEventHub`，TypeScript 侧的 Session 激活
是进程内的 `EmbeddedHarnessScheduler`（基于文件 activation 租约）。两者都无法通知另一台
Java 节点。

Java 节点之间的共享 SQL **投影物化**今天就有——`MessageMaterializer` 以定时 SQL 扫描
（默认 100 ms）运行其 `materializeNextBatch` 投影批量,节点 B 的投影 worker 会在一个轮询周期内
用共享 SQL 重算节点 A 已提交的记录；这条反证足以推翻「跨节点物化不可能」。但它覆盖的只到**投影层**：
它**不送唤醒**——`wake.requested` 激活、交付回执与 `domain.committed` 事实不经过它到另一台节点
（每台的 `EmbeddedHarnessScheduler` 把唤醒留在本进程;`SessionEventHub` 的缓冲亦然）。**仍缺的**是在
提交时的事实分发——路由到节点 A 的后台 Shell 后续轮次，节点 B 的 Harness 既不被扫描唤醒（扫描只跑
投影批量），也读不到 journal 的另节点事实。

权威设计已经命名了这个缺失的元素，其架构流程（原文照录）：

```text
外部事件 / 定时触发 / 子任务结果 / Monitor 变化
                    │
                    ▼
Java 可信入口 → SQL 事务提交领域记录 + outbox + WakeIntent
                    │ after commit
                    ├──────────────→ EventTransport → 物化 / 跨节点唤醒
                    ▼
              Session Authority
```

本文设计**这个 `EventTransport` 的引入方式**，以 RocketMQ LiteTopic 作为候选生产
实现，并保留 #12380 点名的备选 Redis Streams。传输层只分发「已提交事实」的通知——
唤醒意图与已提交记录的指针——使对端 Java 节点可以尝试激活（经由 Session Authority
的 activation fence）或执行物化，而无需任何数据库轮询。

**本切片范围（现在）。** 仅设计：不变式、概念性消息信封、经核实的候选对比、带明确
门禁的阶段计划、部署故障矩阵。本文件不随附任何代码改动。

**永久不在本切片范围内。**

- 任何 MQ 客户端、生产者、消费者或配置接线。
- 第二条同步事件路径。浏览器侧路径保持
  `Harness SSE → Java bounded batch → SQL commit → Java SSE → browser`；
  按 #12380：「MQ is not on the synchronous frontend path or the authority for
  model history」，以及「MQ delay cannot block local post-commit SSE」。
- PostgreSQL 支持、更广泛的编排，以及 H0/H1–H6 能力切片本身。
- 事件信封的 wire schema 版本机制：信封由独立的 TypeScript 契约切片固定
  （共享 fixture + Java fixture 消费者），形态跟随
  `packages/core/src/managed-runtime/contracts/`。
- 开发机上的真实 broker 验收。本机无容器运行时；所有真实 broker 检查归属 CI 或
  云环境。

## 2. 不变式

以下不变式逐条取自固定版扩展运行时设计第 1 节与 #12380 的所有权表（概念照录）。
它们约束本切片的后续每一个阶段；凡违反其中一条的设计细节，无论 broker 能力如何，
均为错误。

1. **MQ 只分发已经提交的事实。**
   _「MQ 只分发已经提交的事实，不成为 Session 真相或浏览器游标。」_
   生产者发出的每条消息都派生自同一 SQL 事务提交的行。传输层永远不成为 Session
   的真相，也永远不成为浏览器的游标：SSE 游标与 replay floor 依旧保持基于 SQL
   序列，与今天完全相同。

2. **每个异步能力都是「持久资源 + 触发意图」。**
   _「所有异步能力都是'持久资源 + 触发意图'。内存 callback、Promise、PID、
   notified=true、本地 sidecar 或 MQ offset 都不是恢复凭据。」_
   MQ offset、流位置、已 ACK 的投递或消费者的内存进度都不是恢复证据。恢复一律从
   SQL 重放：已提交事件序列、扩展记录的 delivery 行、activation store。传输层只缩短
   消费者去查看真相之前的延迟。

3. **SQL outbox 保持真相来源地位。**
   「领域 intent、必要资源引用、outbox 和 WakeIntent 尽量在同一 Session 事务提交；
   跨 Session 使用发送方 outbox、接收方幂等接受与 ACK，明确不承诺跨库原子。」
   Java schema 已经把 Stage H 记录的 delivery 行编码进
   `qwen_managed_session_extension_record`（`delivery_target`/`delivery_state`），
   由提交事务本身写入。MQ 发布严格发生在 commit 之后，且严格是这些行的投影。

4. **`domain.committed` 保持唯一扩展领域提交载体。**
   _「已有 `domain.committed` 保持唯一扩展领域提交载体。」_ 传输层不引入第二条
   领域提交通道；它携带的是指向已提交事实的指针，而不是新的提交。

5. **消费者在重复投递下幂等，以已提交序列为键。** 重复投递、重复或乱序的消息，
   对照持久水位必须是无操作；判定键按 **stream 分源**:(`public_event` 位于
   `managed_agent_session.last_sequence` 分配的 `sequence_id`,`authoritative_journal`
   位于 `qwen_managed_session_journal_tx` 的自提交序）——两个计数器绝不在流间
   比较，因此判定键是 `(tenantId, sessionId, stream, sequence)`，来自 SQL 而不是 broker
   的任何汇报。这与现有 `SessionEventHub` 的纪律一致（`overflowed` → 订阅者重读 store）。

6. **未知副作用不盲重试。** _「未知副作用不盲重试。」_ 目标 Session 已被指派、被
   fence 到另一代际或已结算的唤醒一律是无操作；由 activation 准入与 activation
   fence 决定，而不是由消息决定。

### 排序（按 key 分析）

排序 key 为 `(tenantId, sessionId)`。本设计**明确不要求** MQ 对这些 key 有序投递：
正确性建立在每个 Session 已提交序列与消费者对照 SQL 对账之上，因此无序的
at-least-once 传输不可能损坏 Session——它至多浪费延迟。若所选 broker 经核实确实提供
按 key FIFO（一个 Session 一个 LiteTopic，或一条 Redis stream），则仅将其用作缩短
消费者重读 store 频率的延迟优化。任何阶段门禁都不得依赖本文未能核实的 FIFO 保证。

## 3. 现状：接缝与缺口

证据见附录 A；以下每个路径均在 `5ddfacc9d4` 上实际阅读过。

- **Java after-commit 接缝——存在，但它只覆盖一半的通道。** `CommittedEventPublisher`
  （单方法 `publish(List<EventRecord>)`）被注入 `ManagedAgentStore`，并从 Spring
  `TransactionSynchronization.afterCommit()` 钩子中调用
  （`ManagedAgentStore.java` 第 2403–2411 行）。其唯一实现是
  `SessionEventHub`：进程内按 Session 的有界缓冲（容量 512，溢出标记后订阅者重读
  store），服务 Java SSE 路径。**但该接缝挂在公共 `managed_agent_event`
  事件流上。** 权威 Session journal——`domain.committed`、`wake.requested`、
  工具回执以及 EventTransport 必须携带的提交标记——由 `ManagedSessionStore.commit`
  随私有 journal（`qwen_managed_session_journal_tx`）提交，是另一条代码路径、
  另一类事件。`EventTransport` 生产者适配器因此需要 **两条腿，不是一条**:
  公共事件流的 after-commit hub 扇出，加权威 Session commit 事务内的
  journal 事实发布点（同事务提交、after-commit drain)——MQ2 阶段并线第二个,
  且绝不把第一个牵强为已覆盖它。
- **专用传输抽象——基线时不存在,MQ1 此后已命名。** 基线读取(`5ddfacc9d4`,
  2026-10-04)时,代码搜索 `EventTransport`/`eventTransport`/`RocketMQ` 在设计
  文档之外零匹配,该名字只存在于 2026-09-20 的存储与事件设计(概念性接口、
  proposed follow-up work)。MQ1
  ([2026-10-11-managed-agent-event-transport-seam](2026-10-11-managed-agent-event-transport-seam.zh-CN.md))
  此后已在 after-commit 接缝后引入 `EventTransport` 接口;仍无实现、无传输配置
  属性、无面向 broker 的 outbox drain 循环、无跨节点唤醒消费者。
- **TypeScript 内嵌调度器——按设计无接缝。** `EmbeddedHarnessScheduler` 在单进程内
  从 `FileManagedActivationStore` 租约泵取激活，并用进程内定时器
  （`scheduleRecoveryWake()`）调度恢复唤醒。`managed-session-records.ts` 中已存在
  已提交的 `wake.requested` 记录类型，并与其 Session 输入在同一事务提交
  （Session authority）。提案与权威设计指定的多节点部署单元是 Java 控制面，因此
  传输接缝定义在 Java 侧；本文不给内嵌 TypeScript 路径引入 broker。
- **可分发化的记录/投影管线已就绪。** `EventRecord` 已携带可分发的身份字段
  （`tenantId`、`sessionId`、`sequence`、`eventId`、`turnId`、`type`、`createdAt`、
  schema/projection 版本）；扩展记录 store 把每条已提交修订的 delivery（outbox）行
  一并持久化；`MessageMaterializer` 执行设计中"物化"消费端要在其他节点触发的异步
  Item/Snapshot 物化。

## 4. 信封契约（概念）——设计预留·未交付

以下信封**是概念性的，将由独立的 TypeScript 契约切片固定**（版本化 schema + fixture、
TypeScript 门禁测试与 Java fixture 消费者——本仓跨语言契约的既有模式）。这里的字段与
禁令是该切片的设计输入。

```text
ManagedEventEnvelope/1（概念）：
  envelopeId       本次发布发生的稳定 id（仅作去重提示）
  tenantId         路由 + 去重键的一部分
  sessionId        路由 + 排序键的一部分
  sequence         每个 Session 已提交的事件/记录序列
  kind             持久记录/事件类型，如 'domain.committed'、
                   'wake.requested'，或本信封宣告的已提交变更
  commitEpoch      信封内事实所属的已提交代际
                   （activation/lease generation 族；消费者据此 fence）
  committedAt      数据库提交时间戳（仅供参考；只用 DB 时钟）
  payloadRefs      身份引用（record resource id、payloadRef、
                   artifact refs）——消费者回 SQL/对象存储取内容
  schemaVersion    信封 schema 版本

任何信封中显式禁止：
  秘密材料（token、凭据、SecretHandle）；本地绝对路径；
  裸 PID；运行时端点身份（Pod、地址）；模型历史或工具载荷字节；浏览器可见游标状态。
```

禁令的理由，依不变式 1 与 #12380（"Full tool bytes do not belong in token-event
rows, SSE frames, or MQ payloads"）：信封只是缩短延迟的指针。凡披露后会扩大信任
边界、或其重放可能被 broker 伪造的内容，一律由接收节点从权威 store 读回。

## 5. 候选分析——设计预留·未交付

### 5.1 核实台账

仅以下内容为**已从公开文档核实**（2026-10-04 抓取自 Apache RocketMQ 文档首页
`rocketmq.apache.org/docs/`）：

- Apache RocketMQ 文档记载 **"Million-Scale LiteTopics"** 特性：百万级轻量化、
  按会话划分的 topic，资源开销极小，明确面向 AI Agent 会话管理，基于 RocksDB 索引
  实现细粒度状态隔离与生命周期管理。
- 一个 AI Agent 会话映射一个 LiteTopic；应用服务器保持无状态，重连的客户端可从
  断点恢复会话。
- 存在按 LiteTopic 的消费端级 **Suspend/Resume** 操作，支持毫秒级按会话限流与异常隔离。
- **"Lite Mode Subscription"** 被记载为面向 AI 场景的更轻的订阅模型（相比传统订阅
  资源消耗更低）。

**UNVERIFIED（未核实）**（不作为事实写入本设计；需在 MQ2 阶段开始前从 broker/客户端
文档或预发环境重新核实）：

1. LiteTopic 的投递保证（at-least-once？at-most-once？）与重试/再投递语义——抓取时
   直接文档页 404 不存在。
2. LiteTopic 排序语义（每 topic FIFO 是否有保证）。
3. LiteTopic 的消费组模型与 offset 管理、保留策略、每 topic 生命周期（创建/删除 API
   面、限制、配额）。
4. 部署基线中 LiteTopic 的 Java 客户端可用性与版本钉版；商业（阿里云）LiteTopic
   限制与计费。
5. RocketMQ 经典语义（带 ACK/重试的 at-least-once 消费、按 message group 有序）在
   经典 topic 上有充分文档，但**其对 LiteTopic 的适用性未核实**。

**核销(2026-10-12,北京时间,依据公开文档与 5.5.0 源码 tag)。** 五项全部向
LiteTopic 有利方向核销;MQ2 启动时的预发复核仍然保留。来源:[RIP-83
wiki](https://github.com/apache/rocketmq/wiki/RIP%E2%80%9083-Lite-Topic:-A-New-Message-Model)、
[LiteTopic 领域模型](https://rocketmq.apache.org/docs/domainModel/03litetopic/)、
[5.5.0 发布说明](https://rocketmq.apache.org/zh/release-notes/2026/04/10/5.5.0/)、
[multi-agent 最佳实践](https://rocketmq.apache.org/zh/docs/bestPractice/04multiagent/)、
[阿里云 LiteTopic 参考](https://help.aliyun.com/zh/apsaramq-for-rocketmq/cloud-message-queue-rocketmq-5-x-series/developer-reference/litetopic)与
[使用限制](https://help.aliyun.com/zh/apsaramq-for-rocketmq/cloud-message-queue-rocketmq-5-x-series/product-overview/usage-limits)、
[5.5.0 LiteTopic 深度解读](https://www.cnblogs.com/alisystemsoftware/p/20189542);5.5.0 源码 tag:
[LiteEventDispatcher](https://github.com/apache/rocketmq/blob/rocketmq-all-5.5.0/broker/src/main/java/org/apache/rocketmq/broker/lite/LiteEventDispatcher.java#L107-L162)、
[PopLiteMessageProcessor](https://github.com/apache/rocketmq/blob/rocketmq-all-5.5.0/broker/src/main/java/org/apache/rocketmq/broker/processor/PopLiteMessageProcessor.java#L285-L328)、
[AckMessageProcessor](https://github.com/apache/rocketmq/blob/rocketmq-all-5.5.0/broker/src/main/java/org/apache/rocketmq/broker/processor/AckMessageProcessor.java#L539-L558)。

1. **投递保证:at-least-once。** RocketMQ 核心模型即 at-least-once(「每条消息
   至少被成功投递一次」),失败按消费重试策略再投递、超过重试上限进 DLQ;阿里云
   LiteTopic 参考文档写明客户端确认机制给出 at-least-once 语义;有序通道的固定
   间隔重试来自腾讯云 TDMQ 商业文档(snippet 级证据——开源页面未写明间隔)。
   broker 侧持久化位点(见下)使消费者重启后从已提交水位续投。消费者必须幂等
   ——正是本设计的不变式 5。
2. **排序:按 LiteTopic FIFO。** 官方领域模型页:每个 LiteTopic 默认一个队列,
   队列内消息按序存储与消费;消费模式仅有序,每个 LiteTopic 由单线程消费。
3. **消费模型、位点、生命周期、配额。** 订阅注册按客户端(ClientID)而非按组
   锁定:同组内各消费者可订阅不同 LiteTopic 集合,运行时可动态增删(每消费者
   千量级)。但**派发在组内共享**:一次派发恰好选择组内一个客户端
   ——5.5.0 的 `LiteEventDispatcher` 按组把订阅者分桶、首个成功客户端即停,锁、
   FIFO 状态与位点均以 `(group, LiteTopic, 0)` 为键。若 ACK 丢失或客户端失活,
   未完成的消息会重新派发且可能换到另一成员(5.5.0 的失活路径重派并避开先前
   客户端),因此不提供每节点独立副本;消费者幂等(不变式 5)与激活围栏吸收
   这一点。跨节点唤醒扇出因此需要每节点一个消费组(派发器
   会遍历所有组);这并入 §11 的路由决策。位点存于 broker 侧——内存快照加
   RocksDB 增量持久化。LiteTopic 首次发送/订阅自动创建,TTL 内无写入则自动删除
   并释放 LiteTopic 个数——但只要消费者未取消订阅,该订阅关系仍计入订阅总数
   (阿里云特殊规则)。RIP-83 点名配额控制(每客户端/总量上限、就绪集合溢出
   控制),但 Apache 参数限制页未公布 LiteTopic 数字;阿里云公布了具体上限:
   每消费者 2,000 订阅(可工单调整)、每 LiteTopic 200 消费 TPS、按实例规格的
   创建/订阅配额表——最大铂金规格 `rmq.u2.1000xlarge` 达 2,320 万;100 万对应的
   是 `rmq.u2.30xlarge`。
4. **客户端可用性。** 官方要求:服务端 ≥ 5.5.0、gRPC SDK ≥ 5.1.0;
   `LitePushConsumer`/`LiteProducer` 示例在 apache/rocketmq-clients 仓库。
   `subscribeLite()` 会做配额校验且可能失败——适配器必须把订阅当作可失败操作。
   阿里云计费为实例规格制,无公开固定的 LiteTopic 单价。
5. **经典语义迁移:消费侧不成立。** 订阅按客户端而非按组共享;消费仅有序、
   每 LiteTopic 单线程;派发为事件驱动(Ready Set)而非长轮询 Pop。与经典共享
   的是 CommitLog 写入路径与 at-least-once/重试/DLQ 机制。RocksDB 路径的 broker
   配置为 `enableLmq=true`、`enableMultiDispatch=true`、
   `storeType=defaultRocksDB`;注意 5.5.0 也支持不经 RocksDB 迁移的
   CombineConsumeQueueStore LMQ(发布说明,PR #10174)——存储选型属 MQ2 启动
   核实范围。已知运维注意事项:rocketmq-dashboard issue #2777(LiteTopic 配额
   计数为负),仅影响 dashboard 侧。

Redis Streams 方面，标准且有文档的语义适用（在本表中按已核实处理）：每 stream
FIFO；`XREADGROUP` + `XACK` 消费组；未 ACK 条目经 pending entries list
（`XPENDING`/`XCLAIM`/`XAUTOCLAIM`）再投递；显式保留（`XTRIM`）。部署关注点
（AOF 配置下的持久性、百万 stream 的内存代价、集群扩展）被列作特征，而非针对某个
具体 Redis 部署核实过的保证。

### 5.2 能力表

| 能力                                            | RocketMQ LiteTopic                                                                                                                                                                  | Redis Streams                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 按 Session 寻址（每 Session 一个 topic/stream） | 为之设计（百万级、按会话）                                                                                                                                                          | 可行；每 key 一条 stream，内存开销随在线 stream 数增长 |
| at-least-once 投递                              | 是——at-least-once 加重试与 DLQ;有序通道的固定间隔重试仅有商业文档证据,开源页面未写明(2026-10-12 核实,§5.1)                                                                          | 是，经消费组 + PEL 再投递                              |
| 按 key 排序                                     | 是——每 LiteTopic 一个有序队列、单消费线程（2026-10-12 核实，§5.1）；本设计仍不要求（§2）                                                                                            | 是，每 stream FIFO                                     |
| 消费者再投递 / 崩溃恢复                         | 是——broker 侧持久化位点（内存快照 + RocksDB 增量）从已提交水位续投（2026-10-12 核实，§5.1）                                                                                         | 是，超时后经 `XAUTOCLAIM`/`XCLAIM`                     |
| 消费组（多节点 worker、唤醒汇聚）               | 组内共享——一次派发恰好选择组内一个客户端,重投可能换节点(5.5.0 源码核实,§5.1);跨节点扇出需每节点一个消费组(§11)                                                                      | 一等公民                                               |
| 按 Session Suspend/Resume（背压、隔离）         | 有文档（按 topic 的消费端级）                                                                                                                                                       | 手工（停止读取该 key 的组）                            |
| 百万级队列的保留与生命周期                      | 首次使用自动创建;TTL 删除释放 LiteTopic 个数(订阅关系仍计入订阅总数直至取消订阅);OSS 未公布数值上限——阿里云公布每消费者 2,000 订阅、每 LiteTopic 200 消费 TPS(2026-10-12 核实,§5.1) | 运维管理（`XTRIM`、key 过期）；存在无界增长风险        |
| broker 成为 Session 真相的风险                  | 两种方案架构风险相同；不变式 1–3 一律禁止                                                                                                                                           | 相同                                                   |
| 运维形态                                        | broker 集群；Java 客户端                                                                                                                                                            | 单 Redis / 集群；许多部署已有                          |
| #12380 是否点名                                 | 是（"RocketMQ or Redis Streams"）                                                                                                                                                   | 是                                                     |

### 5.3 选型

**候选生产实现：RocketMQ LiteTopic。** 其已文档化的模型（按 Session 的轻量 topic、
无状态应用服务器、断点恢复、按 Session Suspend/Resume）与唤醒分发形态（每个 Session
一条活跃路由、数百万基本空闲的 Session）的契合度远高于为每个 Session 跑一条 Redis
stream。**Redis Streams 保留为 #12380 点名的备选**：若 MQ2 启动前的核实（§7）在投递
或排序语义上否掉 LiteTopic，则改用 Redis Streams。本选型遵循 2026-09-20 存储与事件
设计的运维指引：优先使用既有的 RocketMQ 平台，而不是仅为 SSE 部署 MQ；无 MQ 时物化
路径保持 SQL 批扫描；且绝不让 Redis 成为与 RocketMQ 并存的第二个默认消息依赖。
由于 §2 不要求排序、§4 禁止真相落在 broker 上，最终选型可以在同一接缝后互换，
而不触碰 Session 语义。

## 6. 投递与消费者幂等——设计预留·未交付

生产者路径（设计预留）：Session 的 SQL 事务提交后，store 现有的 after-commit 扇出
同时把已提交信封交给已配置的传输生产者。发布失败或延迟永不阻塞本地 post-commit
SSE（#12380 约束）；SQL 中的持久 delivery 行保持完整，任何漏发的通知都由 SQL 侧
扫描恢复——与今天进程内 `SessionEventHub` 漏发后的处理完全相同（溢出 → 重读）。
（MQ2d 落地情况：漏掉的公开通知由定时物化扫描覆盖，但漏掉的唤醒没有通用扫描——
它通过提交该输入的那个来源的账本恢复（如果该来源有账本）；见 MQ2 设计的「丢失或
被烧掉的唤醒靠什么恢复」。）

消费者路径（设计预留）：每台 Java 节点上，唤醒消费者经由 Session Authority 尝试
Session 激活——由 activation fence 与租约代际决定；信封只是加速这次尝试。物化
消费者触发的物化与进程内路径一致（今天的 `MessageMaterializer`，单节点）。每个消费者：

- 以 `(tenantId, sessionId, stream, sequence)` 对照从 SQL 重读的持久水位去重——`stream` 名来源（`public_event` 由 `last_sequence`、`authoritative_journal` 由 journal 提交序），两个计数器绝不在流间比较；
- 出现序列缺口时，先把 Snapshot+tail 从 SQL 重读，再应用任何更新的消息
  （`SessionEventHub` 溢出纪律的推广）；
- 不写任何持久性依赖 broker 的恢复相关状态；
- 把指向已结算、已改路由或 fence 不同的 Session 的唤醒当作无操作。

## 7. 阶段计划与门禁

| 阶段                            | 内容                                                                                                                                                 | 前提                                                                                    | 退出检查                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **MQ0（现在）**                 | 本设计；概念信封；经核实的选型矩阵；在 #12380 跟踪单上备案范围认领                                                                                   | 无；与 H 各 lane 并行                                                                   | 双语设计合入；跟踪 issue 记录认领切片；零代码改动                                                                |
| **MQ1——引入接缝**               | 在现有 after-commit 钩子之后命名并抽出 `EventTransport` 适配器；默认组合保持今天进程内 `SessionEventHub` 扇出；最小 diff、零行为变化、无 broker 依赖 | #13300（H0c 评审跟进项）合入；#13265（H3）的持久任务事件/取消语义落定，使信封键最终定型 | 现有提交路径与 SSE 测试不变且全绿；无新增运行时依赖；带接缝部署行为完全一致                                      |
| **MQ2——Java 生产者/消费者接线** | outbox drain → MQ 生产者；唤醒 + 物化消费者；按已提交序列去重；默认关闭的配置开关（`qwen.managed-agent.event-transport.*`）                          | MQ1；按 §5.1 台账完成 broker 语义核实（LiteTopic 未核实项闭环，否则用 Redis Streams）   | CI/云环境单 broker E2E：注入重复与乱序均为无操作；post-commit SSE 延迟 p95 无回退；flag 关闭时部署行为逐字节一致 |
| **MQ3——部署故障矩阵**           | 在双节点控制面 + broker 上执行 §8 矩阵（CI 或云环境；本机无容器运行时）                                                                              | MQ2                                                                                     | 矩阵全部行绿，含 flag 回滚；结果附到跟踪 issue                                                                   |

固定信封 schema 的独立 TypeScript 契约切片落入 MQ1（门禁测试 + Java fixture
消费者），保持契约先行的本仓惯例。**§5.1 中所选 broker 存在未闭环的未核实项时，
MQ2 及以后不得启动。**

## 8. 部署故障矩阵——设计预留·未交付

| 故障                                 | 要求的行为                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 同一信封重复投递                     | 消费者以 `(tenantId, sessionId, sequence)` 对照 SQL 水位去重；重复件为无操作。activation 入队保持幂等。                                                |
| 单 Session 内乱序投递                | 序列水位 + 缺口检测；消费者先重读 SQL 的 Snapshot+tail，再应用任何更新的消息。仅凭 MQ，较新的记录永不先于未见过的更早记录落地。                        |
| 处理完但 ACK 丢失后的 broker 再投递  | 同重复投递。                                                                                                                                           |
| 消费者处理前崩溃                     | broker 再投递（按所选 broker 的 at-least-once 路径——已于 2026-10-12 文档级核实(§5.1),MQ2 启动时再做预发复核）；Session 被晚唤醒，但永远源自 SQL 真相。 |
| 消费者本地生效后、ACK 前崩溃         | 重启后走重复路径；每个本地生效动作都以已提交身份幂等。                                                                                                 |
| SQL commit 与 publish 之间生产者崩溃 | 消息根本未发出；SQL 中已提交的 delivery 行仍完整。恢复来自 SQL 侧扫描（溢出/重读纪律），与今天 `SessionEventHub` 相同。MQ 不被重建为真相 outbox。      |
| broker 短时故障                      | 生产者以有界缓冲重试；本地 post-commit SSE 不受影响；仅唤醒延迟变差。                                                                                  |
| broker 长时故障                      | 传输消费者空转；Session 仍可由 SQL 扫描与租约 fencing 发现；无能力数据丢失，因为真相从不落在 broker 上。                                               |
| Java 节点间时钟偏移                  | fencing 与租约使用数据库时钟（本仓租约惯例）；信封 `committedAt` 仅供参考。                                                                            |
| Session 改路由或代际变更后的过期唤醒 | activation fence 拒绝；无操作。                                                                                                                        |

MQ2d 落地情况：上表各行中的「SQL 侧扫描」「SQL 扫描」，对公开通知而言是定时物化
扫描；对唤醒而言是提交该输入的那个来源的账本（如果有）——不存在通用的唤醒扫描。
MQ2 设计的「丢失或被烧掉的唤醒靠什么恢复」列出了这些账本及其早已存在的缺口。

MQ3 实测情况：各行在两个控制面节点、一个 MySQL 数据库和一个 RocketMQ 集群上运行，
见 [2026-10-14-managed-agent-event-transport-mq3](2026-10-14-managed-agent-event-transport-mq3.zh-CN.md)
（公开事件通道的重复与乱序仍归 MQ2d 的门禁；唤醒不携带 epoch，过期唤醒行也就没有代际可变）；
该文档同时记录了现有实现与上表「要求的行为」的出入：节点在处理唤醒时崩溃，会让共享的
bootstrap 通道停顿约两分钟；没有生产者重试缓冲，broker 离开期间发出的信封会被丢弃；
故障期间重启的节点要关掉开关才能启动；Turn 调度租约用的是 JVM 时钟。

## 9. 约束与风险

- **此处任何内容不得出现在同步前端路径上。** SQL 故障以有界背压呈现（#12380）；
  MQ 故障只能表现为唤醒/物化延迟。
- **不得让 broker 成为浏览器游标。** SSE 回放游标与持久 replay floor 保持基于 SQL
  （V14 `managed_event_replay` 模式）。
- **LiteTopic 语义风险。** §5.1 的文档级核实已于 2026-10-12 解决投递/排序项;残余
  敞口是 MQ2 启动时的预发复核——若其失败,MQ2 在同一接缝
  后回退到 Redis Streams,而不是放松不变式。
- **唤醒意图载体。** 2026-10-12 已决（§11）：载体是已提交的 `wake.requested`
  记录，随 #13300 落地；另造 WakeIntent 记录会把同一事实存两份，本条取代
  #12827 问题 3。
- **范围自律。** 每个阶段在跟踪单上记录自己的切片与排除项，遵守 #12380 的认领规则。

## 10. 验证计划与验收标准

本切片的验证仅针对文档：

- [x] 权威不变式从固定的 `6891216` 设计原文照录，并重述为约束性规则（§2）。
- [x] 每条「现状」陈述都有 `5ddfacc9d4` 上实际读过的仓库路径背书（§3、附录 A）；
      接缝结论基于证据。
- [x] broker 能力主张拆分为已核实与未核实，附抓取来源与日期（§5.1）。
- [x] 双语版本保持结构对齐（README 规则）。
- [ ] 双语设计合入；跟踪 issue（草稿位于
      `.qwen/issues/managed-agent-event-transport-mq.md`）由其 owner 提交，
      并在 #12380 快照上记录认领切片。

## 11. 提交给跟踪 issue 的开放问题

1. 唤醒意图载体——**2026-10-12 已决**：沿用已提交的 `wake.requested` 记录作为
   唤醒信封来源。它与其 Session 输入在同一事务提交于权威 journal 流，且已在信封
   v1 词表与 fixtures 中；另造 WakeIntent 记录会把同一事实存两份，违背单一提交
   载体纪律（§2）。#13300 已落地，本条取代 #12827 问题 3。
2. Session 信封的消费路由——**2026-10-12 已决**：共享 bootstrap 通道 + owner 侧
   动态订阅。2026-10-12 核实的派发证据（§5.1）：LiteTopic 派发在组内共享——一次
   派发恰好选择组内一个客户端，ACK 丢失或客户端失活时重投可能换节点。「按
   Session 建消费组」是错误轴（每 Session 一个组意味着百万级组；LiteTopic 本身
   已提供按 Session 寻址）；「每节点一个消费组做扇出」不必要，因为决定哪个节点
   可以行动的是激活围栏而非 broker。因此：待激活唤醒走一条共享 bootstrap 组
   （任一 worker 抢到后过激活围栏，SQL 扫描兜底）；赢得激活的节点动态订阅该
   Session 的 LiteTopic（按客户端），释放时退订——此后该 Session 的 owner 是唯一
   订阅者，派发恰好落在它身上。这是稳态而非交接窗口的保证：租约到期而未干净
   退订时，旧订阅会短暂共存，派发器可能选中它，其被围栏拒绝的空操作 ACK 仍会
   推进组位点，新 owner 可能错过这次通知——由 SQL 对账（上述兜底）覆盖；交接
   场景列入 MQ2 核实清单。（MQ2d 落地情况：交接行已对着真实 broker 运行；所谓
   「SQL 扫描」兜底是各输入来源自己的账本，而不是通用扫描——见 MQ2 设计的「丢失
   或被烧掉的唤醒靠什么恢复」。）
3. §5.1 LiteTopic 核实项：broker 文档核实已于 2026-10-12 完成,结果固定在
   §5.1 的核销块;剩余的是 MQ2 启动时对真实 5.5.0+ 集群的预发复核。
4. 信封命名/字段：归入独立的 TypeScript 契约切片；本文 §4 是其输入而不是输出。

## 附录 A. 代码清单（接缝结论的证据）

在 `5ddfacc9d4`（2026-10-04）上阅读。每行一条既有职责。

| 路径                                                                                | 既有职责                                                                                                               | 传输接缝？           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `packages/managed-agent-server/.../store/CommittedEventPublisher.java`              | 单方法 after-commit 扇出接口 `publish(List<EventRecord>)`                                                              | **是——这就是接缝**   |
| `packages/managed-agent-server/.../store/ManagedAgentStore.java`（第 2403–2411 行） | 从 `TransactionSynchronization.afterCommit()` 调用 `eventPublisher.publish(events)`                                    | 接缝调用点           |
| `packages/managed-agent-server/.../service/SessionEventHub.java`                    | 唯一实现：进程内按 Session 有界缓冲（容量 512），`overflowed` → 重读 store；服务 Java SSE                              | 仅进程内             |
| `packages/managed-agent-server/.../store/StoreModels.java`（`EventRecord`）         | 已提交事件身份：`tenantId, sessionId, sequence, eventId, turnId, type, …, createdAt, schemaVersion, projectionVersion` | —                    |
| `packages/managed-agent-server/.../store/ManagedExtensionRecordStore.java`          | Stage H 记录持久化；校验 `domain.committed`；每记录 delivery（outbox）行                                               | 否（持久化，无发布） |
| `packages/managed-agent-server/.../db/migration/V18__managed_extension_record.sql`  | `qwen_managed_session_extension_record`，含由提交事务写入的 `delivery_target`/`delivery_state`                         | 否（SQL 真相）       |
| `packages/managed-agent-server/.../db/migration/V14__managed_event_replay.sql`      | 支撑 SSE 游标恢复的持久 replay floor                                                                                   | 否                   |
| `packages/managed-agent-server/.../service/MessageMaterializer.java`                | 异步 Item/Snapshot 物化（"物化"消费端的现行进程内形态）                                                                | 否                   |
| `packages/core/src/managed-runtime/managed-session-inbox.ts`                        | 持久 Session inbox（`tenantId/sessionId/messageId`，状态 admitted/processing/finished）                                | 否                   |
| `packages/core/src/managed-runtime/managed-session-records.ts`                      | 已提交记录索引，含 `wake.requested` 与 `domain.committed` 类型                                                         | 否                   |
| `packages/core/src/managed-runtime/managed-session-authority.ts`                    | 把 Session 输入 + 唤醒意图在同一事务提交；读取任务投影                                                                 | 否                   |
| `packages/core/src/managed-runtime/embedded-harness-scheduler.ts`                   | 基于文件租约的单进程激活泵；进程内 `scheduleRecoveryWake()` 定时器                                                     | 否（按设计进程内）   |
| `packages/core/src/managed-runtime/managed-activation-store.ts`                     | activation 描述体、租约、fence、代际                                                                                   | 否                   |
| `packages/core/src/managed-runtime/managed-extension-projection.ts`                 | `ManagedSessionTaskView` 投影，含 outbox/delivery 状态                                                                 | 否                   |

**结论:部分存在(PARTIAL,基线 `5ddfacc9d4`,2026-10-04 读取)。** Java 的
after-commit 接缝存在(`CommittedEventPublisher`,基线时恰好只有一个进程内
实现);专用的 `EventTransport`/唤醒抽象在基线时的代码中不存在(代码搜索零
匹配;2026-09-20 的设计勾勒是文档而不是代码),按计划须在 MQ1 于该接缝之后
引入——MQ1 此后已完成
([2026-10-11-managed-agent-event-transport-seam](2026-10-11-managed-agent-event-transport-seam.zh-CN.md):
接口加组合体,无实现)。TypeScript 内嵌调度器按设计进程内运行,本地切片不给它
增加 broker 依赖。
