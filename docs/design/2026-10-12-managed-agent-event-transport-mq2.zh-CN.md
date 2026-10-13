# EventTransport MQ2:Java 生产者/消费者接线

[English](2026-10-12-managed-agent-event-transport-mq2.md) | [简体中文](2026-10-12-managed-agent-event-transport-mq2.zh-CN.md)

> **状态:** 提案阶段计划。这是跨节点 EventTransport 设计
> ([2026-10-04-managed-agent-event-transport](2026-10-04-managed-agent-event-transport.zh-CN.md)
> §7)的 **MQ2** 阶段,由 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 跟踪。
> 父设计为 MQ2 设置的每道门禁现已全部关闭:MQ1 的 seam 已落地
> ([#13909](https://github.com/QwenLM/qwen-code/pull/13909)),§5.1 LiteTopic 核实
> 已在文档级([#13927](https://github.com/QwenLM/qwen-code/pull/13927))与真实
> 5.5.1 预发集群上核销,§11 的路由与唤醒载体决策已落地
> ([#13933](https://github.com/QwenLM/qwen-code/pull/13933))。

## 问题

MQ2 是把命名的 seam 变成接好线的传输的阶段:outbox 排出的 MQ 生产者、唤醒与物化消费者、按已提交序列的消费者去重,全部收在一个默认关闭的配置开关后。若作为一个 diff 交付,它远超一个可评审的 PR——信封契约扩展、冻结契约的 Java 镜像、权威提交路径上的新发布点、引入全新依赖族(gRPC)的 broker 客户端、两个消费者角色,以及真实 broker E2E。本文档把 MQ2 拆成四个子切片,每个独立可评审、独立可回退,且排序保证没有任何切片把未被检验的依赖带进下一切片。

## 现状

2026-10-12 在 `23add5ef9d`(#13933 合入后的 main 顶端)上核对。

- **MQ1 seam(公开事件流)。** `CompositeCommittedEventPublisher` 是唯一的 `CommittedEventPublisher` bean——先 hub、后 `List<EventTransport>`(默认为空)、逐 transport `RuntimeException` 隔离、丢弃日志携带 tenant/session/序号身份。它只挂在公开的 `managed_agent_event` 流上。
- **权威 journal 提交路径。** `ManagedSessionStore.commit`(`@Transactional`)把 journal 事实写入 `qwen_managed_session_journal_tx` 并推进 `qwen_managed_session_journal_head`。这条路径上**没有**任何 after-commit 发布点——设计的第二条线尚不存在,且 MQ1 的范围边界禁止把 hub seam 重新标称为覆盖它。
- **信封契约(#13498)。** 已冻结的 TS 契约(`managed-event-envelope-v1.schema.json` + fixtures):十个字段(`v`、`tenantId`、`workspaceId`、`sessionId`、`stream`、`sequence`、`eventId`、`kind`、`occurredAt`、`payloadRef.digest`)、禁用字段集、封闭对象。v1 的 stream 词表**只**列 `authoritative_journal`。**Java 镜像尚不存在**——一个重命名信封键或改动摘要规范化方式的 Java 生产者会通过现有的每一个测试(#13927 评审 R1-3)。Java fixture 消费方的房屋先例已存在(`ManagedMcpRecordContractTest` 等直接读 `packages/core/src/managed-runtime/contracts/*.fixtures.json`)。
- **全 `sdk-java` 无 RocketMQ/gRPC 依赖。** 要引入的客户端 `org.apache.rocketmq:rocketmq-client-java:5.1.0` 是 **shaded** 制品：其构建把 `io.grpc`、`com.google` relocate 进私有命名空间（其 README 将其与 `noshade` 变体区分开），因此 Spring Boot BOM 绝不会重新对齐这些内嵌类，也没有版本冲突需要证伪。门禁由此是实证的而非版本表驱动的：加入 shaded 制品，证明依赖树与打包保持干净，且服务能启动并对真实 broker 完成一次收发。
- **outbox 先例。** SQL 侧 drain 循环已存在(`SessionMessageRelayStore`、`ChildResultRelayStore`、`ManagedExtensionRecordStore` 的 delivery line)——MQ 生产者是同一纪律上的时延缩短器,绝不是真相。

## 设计:四个子切片

### MQ2a——冻结信封的 Java 镜像(无 broker、不改 TS)

落地已冻结 v1 契约的 Java 镜像:一个从已提交 journal 记录构造出完全相同十字段信封的 Java 推导,加一个读取冻结 TS fixtures、证明 Java 输出与之匹配的 fixture 消费方——契约先行的房屋模式。不改 TS 契约、无 broker 客户端、无配置、无行为变化;镜像只被其测试检验(结构性非启用证明,与 TS 侧镜像)。`public_event` 流扩展**不在**本切片——它属于公开事件线真正落地的 MQ2c。

置首的理由:它是唯一零外部依赖的切片,在任何生产者出现之前先把 Java 侧钉到冻结契约上,并使后续每一切片的评审者读 diff 即可,而不必重新推导规范化规则。

### MQ2b——journal 事实发布点 + LiteTopic 生产者

加权威线:在 `ManagedSessionStore.commit` 上加 after-commit 发布点,把已提交的 journal 事实交给传输方;并实现 `LiteTopicEventTransport`,经 `rocketmq-client-java`(gRPC)发布 `authoritative_journal` 信封,收在 `qwen.managed-agent.event-transport.enabled`(默认关)之后。依赖证明是实证的而非版本表驱动的:shaded 制品的依赖树打包干净,且服务能启动并对真实 broker 完成一次收发。broker 能力校验在启动时运行,不匹配即 fail fast(#13200 硬化)。

### MQ2c——公开事件线 + 唤醒/物化消费者

扩展已冻结的信封词表,加入 `public_event` 流(MQ1 seam 所在通道所需的、有跟踪的契约扩展),然后由第二个 `EventTransport` 实现把公开 `managed_agent_event` 流(MQ1 seam 所在通道)以 `public_event` 信封承载;两个消费者角色落地:唤醒消费者经 Session Authority 围栏尝试激活,物化消费者触发现有 `MessageMaterializer` 路径。消费者拓扑遵循 §11 路由决策:待激活唤醒走共享 bootstrap 组,加 owner 侧按 Session 动态订阅。每个消费者以 `(tenantId, sessionId, stream, sequence)` 对照 SQL 水位去重。交接窗口期旧订阅可能短暂共存(租约到期而未干净退订);旧订阅者被围栏拒绝的空操作 ACK 仍会推进组位点,新 owner 可能错过该次通知,必须靠 SQL 对账恢复该待办——绝不能假设 MQ 已送达。

**落地情况。** 契约扩展记录在 [2026-10-06-managed-event-envelope](2026-10-06-managed-event-envelope.zh-CN.md)(v1 内增量扩展;`public_event` 的 kind 即公开事件类型,按形状校验;digest 绑定九字段的行;`workspaceId` 取 Session 的绑定,未绑定时取其 journal 的 workspace)。接线如下:

- **生产者。** `LiteTopicPublicEventTransport` 是 MQ1 seam 上的 `EventTransport`:把借来的批次拷贝进有界单线程队列(队列满则丢弃该批并记录其身份),查到 Session 的 workspace 后即缓存(两个来源都只写入一次、从不更新),发往该 Session 自己的 LiteTopic——与 journal 信封共用,由 `stream` 区分。journal 生产者另把每个 `wake.requested` 信封发往唤醒 bootstrap LiteTopic。两个生产者共用一个 RocketMQ producer,并隔离同步被拒的发送。
- **通道。** 两个绑定到该 topic 的 LITE 组:唤醒 bootstrap 组——每个节点都订阅同一个 bootstrap LiteTopic(它按序、同一时刻只由一个成员消费);owner 组——每个节点只订阅其 Harness 正在写入的 Session:连接器的 attachment 经 SQL 收窄为 writer 是本节点 Harness、租约未过期的 `ACTIVE` journal,因为 attachment 会在租约失效或被接管后依然留存(`OwnerSubscriptions` 每隔 `owner-reconcile-interval`(默认 1 秒)对账该集合,唤醒激活成功后立即订阅)。两个通道共用一个监听器,对每条消息都 ACK:LiteTopic 按序消费,FAILURE 会把后续通知全部压在重试之后,而且任何结果都与恢复无关。
- **唤醒消费者。** journal 的 `wake.requested` 只有在 SQL 能证明时才尝试:Session 与其 journal 存在、信封的 workspace 与 journal 一致、序号已提交、Session 为 `ACTIVE` 且 journal 为 `ACTIVE` 或 `SEALED`、且没有 writer 持有它——即与 `hasLiveWriter` 的判定相同:`ACTIVE` journal 且租约未过期(按数据库时间),因此已封存 journal 残留的租约不算数。随后在消费进度水位(`journal_wake`)上认领该唤醒——重投、重复或更旧的唤醒即使两个节点竞争也会被拒。上述检查与认领在监听器上执行,加载交给一个小的有界线程池,慢加载因此不会堵住有序的 bootstrap 通道。加载走 relay 类操作的 new-work 准入(先 Workspace 检查,再对其他控制面进程 attach 过的 Session 走接管加载),Harness 的 writer 获取即激活围栏;加载失败时,只有 SQL 随后显示另有活 writer 才判为被围栏。本节点已持有的 Session 不会重新加载。
- **物化消费者。** 序号不高于消息投影已覆盖序号的 `public_event` 是空操作。高于时,该 Session 在单个物化线程上排入一个批次——排队期间到达的通知并入该批次——由 `MessageMaterializer.materializeNotified` 以与定时扫描相同的 store 调用执行,且绝不绕过该扫描的退避。
- **配置。** `qwen.managed-agent.event-transport.*` 新增 `wake-bootstrap-lite-topic`、`wake-bootstrap-group`、`owner-group`、`owner-reconcile-interval`;整个配置类以 `enabled` 为条件,flag 关闭的部署仍不产生任何 transport bean。

MQ2c 不包含:真实 broker 故障行(MQ2d)、接收侧对 journal 事实的 digest 校验(消费者依据 SQL 行事,不依据正文),以及新的通用 SQL 唤醒扫描(现有中继扫描与被加载 Session 自身的唤醒泵仍是兜底)。

### MQ2d——CI 中的真实 broker E2E

新增 failsafe profile + 带 RocketMQ 5.5.1 service 容器的 CI 作业,跑 MQ2 退出检查点名的 §8 故障注入行:重复与乱序注入均为无操作,post-commit SSE 延迟 p95 不回退,flag 关闭的部署字节级一致。其中一条验收行是 owner 交接窗口:旧订阅与新 owner 共存时,旧 owner 不执行副作用且 ACK,新 owner 在未收到该 MQ 通知的情况下仍由 SQL 对账发现并处理待办。本机无容器运行时,因此本切片按构造只属于 CI/云环境。

## 关键决策

1. **broker 生产者挂在权威 journal 提交路径,而非 MQ1 hub seam。** 父设计 §3 明确两条线不同、MQ2 接第二条;信封 v1 的 stream 词表(仅 `authoritative_journal`)指向同一方向。MQ1 的 `EventTransport` seam 承载公开事件流,由 MQ2c 以 `public_event` 信封扩展接入。
2. **Java 镜像先于任何 broker 客户端落地。** 没有被钉住契约的生产者不可评审;fixture 消费方使「Java 匹配冻结信封」成为测试而非断言。
3. **结构性默认关闭。** flag-off 不产生任何 `EventTransport` bean,组合体的 transport 列表为空,部署字节级一致——MQ2 退出检查由此成为可检查属性。
4. **消费者去重键对照 SQL 水位,绝不用 broker。** 按不变式,MQ offset 绝不是恢复凭据;消费者从 SQL 重读持久水位。

## 范围边界

- 任何交付配置都不默认启用;flag 在所有交付配置中关闭。
- 不含多节点故障矩阵(那是 MQ3)。
- 不改提交路径的事务形态;发布点仅 after-commit,且发布失败永不阻塞本地 post-commit SSE(#12380 约束)。
- 不重新标称:不主张 MQ1 hub seam 覆盖 journal 线。

## 验证

- MQ2a:fixture 文件中某个信封键被重命名、或某个禁用字段反例被接受时,Java fixture 消费方必须变红。
- MQ2b:flag 关闭的部署字节级一致;flag 开启时真实 broker 能收到信封(单 broker,预发或 CI)。
- MQ2c:消费者去重使重投递的信封成为无操作;对已围栏 Session 的过期唤醒是无操作。
- MQ2d:MQ2 退出检查点名的 §8 故障行在 CI 中全绿,含 owner 交接恢复行——旧 owner 的空操作 ACK 推进组位点,新 owner 在未收到该 MQ 通知的情况下仍由 SQL 对账发现并处理待办。
