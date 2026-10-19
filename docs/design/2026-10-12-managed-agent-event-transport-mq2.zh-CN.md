# EventTransport MQ2:Java 生产者/消费者接线

[English](2026-10-12-managed-agent-event-transport-mq2.md) | [简体中文](2026-10-12-managed-agent-event-transport-mq2.zh-CN.md)

> **Wake 恢复更新（2026-10-19）：** 本文早期仅依赖来源账本的兜底描述已由
> [Hosted SQL wake 扫描](2026-10-18-hosted-wake-recovery.zh-CN.md)取代。writer 丢失后，
> 它发现已提交、未消费的 monitor/后台 Shell、channel、child/workflow、automation
> 和 Session message 输入。公共前台 Turn 仍归 dispatcher；私有 CSI 和其他来源保留
> 原有恢复路径。真实 MQ 开启、部署及跨平台扫描验收仍未验证。下方历史 MQ 门禁不证明
> 这一新扫描；其故障验收见链接设计。

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

扩展已冻结的信封词表,加入 `public_event` 流(MQ1 seam 所在通道所需的、有跟踪的契约扩展),然后由第二个 `EventTransport` 实现把公开 `managed_agent_event` 流(MQ1 seam 所在通道)以 `public_event` 信封承载;两个消费者角色落地:唤醒消费者经 Session Authority 围栏尝试激活,物化消费者触发现有 `MessageMaterializer` 路径。消费者拓扑遵循 §11 路由决策:待激活唤醒走共享 bootstrap 组,加 owner 侧按 Session 动态订阅。每个消费者以 `(tenantId, sessionId, stream, sequence)` 对照 SQL 水位去重。交接窗口期旧订阅可能短暂共存(租约到期而未干净退订);旧订阅者被围栏拒绝的空操作 ACK 仍会推进组位点,新 owner 可能错过该次通知,必须靠 SQL 对账恢复该待办——绝不能假设 MQ 已送达。(原 MQ2d 的账本兜底对符合条件的唤醒已由 Hosted SQL 扫描取代;见 MQ2d 下的「丢失或被烧掉的唤醒靠什么恢复」。)

**落地情况。** 契约扩展记录在 [2026-10-06-managed-event-envelope](2026-10-06-managed-event-envelope.zh-CN.md)(v1 内增量扩展;`public_event` 的 kind 即公开事件类型,按形状校验;digest 绑定九字段的行;`workspaceId` 取 Session 的绑定,未绑定时取其 journal 的 workspace)。接线如下:

- **生产者。** `LiteTopicPublicEventTransport` 是 MQ1 seam 上的 `EventTransport`:把借来的批次拷贝进有界单线程队列(队列满则丢弃该批并记录其身份),查到 Session 的 workspace 后即缓存(两个来源都只写入一次、从不更新),发往该 Session 自己的 LiteTopic——与 journal 信封共用,由 `stream` 区分。journal 生产者另把每个 `wake.requested` 信封发往唤醒 bootstrap LiteTopic。两个生产者共用一个 RocketMQ producer,并隔离同步被拒的发送。
- **通道。** 两个绑定到该 topic 的 LITE 组:唤醒 bootstrap 组——每个节点都订阅同一个 bootstrap LiteTopic(它按序、同一时刻只由一个成员消费);owner 组——每个节点只订阅其 Harness 正在写入的 Session:连接器的 attachment 经 SQL 收窄为 writer 是本节点 Harness、租约未过期的 `ACTIVE` journal,因为 attachment 会在租约失效或被接管后依然留存(`OwnerSubscriptions` 每隔 `owner-reconcile-interval`(默认 1 秒)对账该集合,唤醒激活成功后立即订阅)。两个通道共用一个监听器,对每条消息都 ACK:LiteTopic 按序消费,FAILURE 会把后续通知全部压在重试之后,而且任何结果都与恢复无关。
- **唤醒消费者。** journal 的 `wake.requested` 只有在 SQL 能证明时才尝试:Session 与其 journal 存在、信封的 workspace 与 journal 一致、序号已提交、Session 为 `ACTIVE` 且 journal 为 `ACTIVE` 或 `SEALED`、且没有 writer 持有它——即与 `hasLiveWriter` 的判定相同:`ACTIVE` journal 且租约未过期(按数据库时间),因此已封存 journal 残留的租约不算数。随后在 Session 事件流的唤醒水位(`ma_event_stream.wake_covered_sequence`)上认领该唤醒——重投、重复或更旧的唤醒即使两个节点竞争也会被拒。上述检查与认领在监听器上执行,加载交给一个小的有界线程池,慢加载因此不会堵住有序的 bootstrap 通道。加载走 relay 类操作的 new-work 准入(先 Workspace 检查,再对其他控制面进程 attach 过的 Session 走接管加载),Harness 的 writer 获取即激活围栏;加载失败时,只有 SQL 随后显示另有活 writer 才判为被围栏。本节点已持有的 Session 不会重新加载。
- **物化消费者。** 序号不高于消息投影已覆盖序号的 `public_event` 是空操作。高于时,该 Session 在单个物化线程上排入一个批次——排队期间到达的通知并入该批次——由 `MessageMaterializer.materializeNotified` 以与定时扫描相同的 store 调用执行,且绝不绕过该扫描的退避。
- **配置。** `qwen.managed-agent.event-transport.*` 新增 `wake-bootstrap-lite-topic`、`wake-bootstrap-group`、`owner-group`、`owner-reconcile-interval`;整个配置类以 `enabled` 为条件,flag 关闭的部署仍不产生任何 transport bean。

MQ2c 不包含:真实 broker 故障行(MQ2d)、接收侧对 journal 事实的 digest 校验(消费者依据 SQL 行事,不依据正文),以及新的通用 SQL 唤醒扫描(现有中继扫描与被加载 Session 自身的唤醒泵仍是兜底)。

### MQ2d——CI 中的真实 broker E2E

新增 failsafe profile + 带 RocketMQ 5.5.1 service 容器的 CI 作业,跑 MQ2 退出检查点名的 §8 故障注入行:重复与乱序注入均为无操作,post-commit SSE 延迟 p95 不回退,flag 关闭的部署字节级一致。其中一条验收行是 owner 交接窗口:旧订阅与新 owner 共存时,旧 owner 不执行副作用且 ACK,新 owner 在未收到该 MQ 通知的情况下仍由 SQL 对账发现并处理待办。本机无容器运行时,因此本切片按构造只属于 CI/云环境。(落地情况见下:broker 原生运行,因此 gate 在本地也能跑;交接行证明旧订阅者的 ACK 在 SQL 中什么也没消费——此后由什么恢复该唤醒,见「丢失或被烧掉的唤醒靠什么恢复」。)

**落地情况。** 没有使用 service 容器:`scripts/rocketmq-lite-broker.sh` 原生运行 5.5.1 二进制发行包(NameServer、开启 `enableLmq`、`enableMultiDispatch` 与 RocksDB 存储的 broker、gRPC proxy),用钉死的 SHA-512 校验下载,并建好 LITE topic 以及服务端与 gate 订阅用到的全部 LITE 组——同一个脚本在笔记本(Linux 或 macOS)与 CI 上都能跑,因此 gate 也能在本地复现。`event-transport-broker-gates` profile 只跑 `EventTransportBrokerGate`(各 `*IT` 家族仍归各自的作业),SDK Java 作业 `EventTransport broker gates / RocketMQ 5.5.1 / Java 21` 启动 broker、运行该 profile、检查 failsafe 报告(`event-transport` 家族),并把报告连同 broker 自身的日志与延迟记录一起上传。在工作站上,proxy 与 broker 的 HA 端口会监听所有网卡(RocketMQ 没有为它们提供绑定选项),因此脚本提示只在可信网络中运行。应用整体运行——两个生产者、两条通道、owner 对账——数据库用 H2,只替身了 Harness。各行如下:

- **回路。** journal 与公开信封以契约的规范字节到达该 Session 的 LiteTopic,唤醒也同时走 bootstrap 通道。
- **重复与乱序注入。** 发两次的唤醒,或先新后旧的唤醒,只激活一次;水位保持较高的序号。在 owner 通道上,重复或更旧的公开通知会到达消费者,但不会触发物化批次。
- **owner 通道。** 本节点持有 attachment 的两个 Session 中,只有 journal 由本节点 Harness 写入的那一个会被订阅。
- **owner 交接。** owner 组里的旧订阅者(其 writer 已失效、另一 writer 持有 journal)收到唤醒,不加载、不认领、直接 ACK。它退订之后,新 owner 订阅,永远收不到这条通知——那次 ACK 推进了组位点——而在它订阅之前发往同一 lite topic、无人 ACK 的通知会作为积压到达它,之后的通知也会到达它,所以收不到确是 ACK 所致。该唤醒在 SQL 中保持未认领,journal 空出后,后来的通知仍能激活它。在新 owner 持有的 Session 上,由其 Harness 从 journal 执行该唤醒输入——通知从来不是承载者。
- **提交后延迟。** 已部署的 composite(先 hub、后公开 transport)与关闭开关的 composite(只有 hub)交替发布同样的批次:提交线程的 publish 耗时与 hub 订阅者的投递耗时在本地 p95 上增加不得超过 1 毫秒。共享 CI runner 使用 20 毫秒容差以容纳调度噪声,仍记录原始测量结果;journal 线的 after-commit 交接 p95 须低于 20 毫秒。三次本地运行(macOS,各 300 轮)中,transport 在 p95 上增加 13–186 微秒,journal 交接为 0.35–1.5 毫秒;CI 会把自己的数据写到 `target/event-transport-latency.json`。
  诊断在无采样的延迟门禁完成后另跑 300 轮，门禁失败时也会执行。保持开启路径先于关闭路径的顺序，不逐轮排空 broker；门禁保留现有本地 1 ms、CI 20 ms 容差及原聚合报告。`event-transport-latency-diagnostics.json` 保存带采样的聚合值，`event-transport-latency-samples.json` 保存 publish、hub 读取和 journal 的墙钟/CPU 样本，包含序号 1–75 的预热轮次；`event-transport-latency-stages.json` 保存生产 publisher 内的 hub 与 transport 耗时，通过 Session、序号、线程及 transport 数量关联；`event-transport-latency.jfr` 保存上述事件、执行栈、锁等待和 GC 暂停。生产事件默认关闭。带采样的数据只用于诊断，不参与延迟断言；订阅者投递包括完整 publish 和随后读取，并非 hub 首次就绪时刻，不能将独立 p95 相减归因。门禁失败仍保留采证，采证异常不覆盖原门禁异常。workflow 每日运行或手动选择分支运行，创建 PR 不会执行此套件。
- **配错即启动失败。** NORMAL(非 LITE)topic 能骗过单纯的订阅探针,现在由新增的发送探针拒绝——向探针自己的 lite topic 同步发一条消息——赶在任何信封被丢弃之前;没人预建的探针组会让订阅探针失败。探针组现在是可配置属性(`capability-probe-group`),代码里打印的每条 `mqadmin` 命令都写明了集群;既不写集群也不写 broker 的话,mqadmin 什么也不建。
- **开关关闭。** 以结构方式而非经 broker 钉住:`EventTransportConfigurationTest` 证明开关关闭的上下文里不存在任何生产者、消费者、transport 或消费者 store,模块其余测试集也都在开关关闭下运行。

**丢失或被烧掉的唤醒靠什么恢复。** 原 MQ2d 实现依靠各输入来源的账本或之后的 Session 加载，因此 channel、Monitor/后台 Shell 和来源 relay 已结束的输入存在缺口。[Hosted SQL wake 扫描](2026-10-18-hosted-wake-recovery.zh-CN.md)在 writer 丢失后，为其准入的六个来源取代这一兜底，且独立于 MQ 认领水位。扫描不会重新准入从未提交的输入，不延长来源投递重试上限，也不恢复私有 CSI 和公共前台 Turn；后两者仍使用来源账本或 dispatcher。现有 MQ2d 交接门禁证明通知可能丢失；无需后续通知的自动扫描恢复，仍需按链接设计完成真实 MQ 故障验收。

## 关键决策

1. **broker 生产者挂在权威 journal 提交路径,而非 MQ1 hub seam。** 父设计 §3 明确两条线不同、MQ2 接第二条;信封 v1 的 stream 词表(仅 `authoritative_journal`)指向同一方向。MQ1 的 `EventTransport` seam 承载公开事件流,由 MQ2c 以 `public_event` 信封扩展接入。
2. **Java 镜像先于任何 broker 客户端落地。** 没有被钉住契约的生产者不可评审;fixture 消费方使「Java 匹配冻结信封」成为测试而非断言。
3. **结构性默认关闭。** flag-off 不产生任何 `EventTransport` bean,组合体的 transport 列表为空,部署字节级一致——MQ2 退出检查由此成为可检查属性。
4. **消费者去重键对照 SQL 水位,绝不用 broker。** 按不变式,MQ offset 绝不是恢复凭据;消费者从 SQL 重读持久水位。

## 范围边界

- 任何交付配置都不默认启用;flag 在所有交付配置中关闭。
- 不含多节点故障矩阵(那是 MQ3:[2026-10-14-managed-agent-event-transport-mq3](2026-10-14-managed-agent-event-transport-mq3.zh-CN.md))。
- 不改提交路径的事务形态;发布点仅 after-commit,且发布失败永不阻塞本地 post-commit SSE(#12380 约束)。
- 不重新标称:不主张 MQ1 hub seam 覆盖 journal 线。

## 验证

- MQ2a:fixture 文件中某个信封键被重命名、或某个禁用字段反例被接受时,Java fixture 消费方必须变红。
- MQ2b:flag 关闭的部署字节级一致;flag 开启时真实 broker 能收到信封(单 broker,预发或 CI)。
- MQ2c:消费者去重使重投递的信封成为无操作;对已围栏 Session 的过期唤醒是无操作。
- MQ2d:MQ2 退出检查点名的 §8 故障行在 CI 中全绿,含 owner 交接恢复行——旧 owner 的空操作 ACK 推进组位点,新 owner 在未收到该 MQ 通知的情况下仍由 SQL 对账发现并处理待办。落地后,该行证明新 owner 永远收不到这条通知,且该唤醒在 SQL 中保持未认领,后来的通知仍能激活它。应扩展验收，证明符合条件的已提交唤醒在 writer 到期后无需另一条通知即可由独立 Hosted SQL 扫描恢复；真实 MQ 下该扩展仍未验证（见 MQ2d）。
