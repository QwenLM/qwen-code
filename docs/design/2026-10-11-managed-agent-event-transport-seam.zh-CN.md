# EventTransport MQ1:after-commit seam 组合

[English](2026-10-11-managed-agent-event-transport-seam.md) | [简体中文](2026-10-11-managed-agent-event-transport-seam.zh-CN.md)

> **状态:** 提案切片。这是跨节点 EventTransport 设计
> ([2026-10-04-managed-agent-event-transport](2026-10-04-managed-agent-event-transport.zh-CN.md)
> §7)的 **MQ1** 阶段,由 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 跟踪。
> MQ1 只引入命名的 seam:无 broker 依赖、无配置、无行为变化。信封契约已随
> [#13498](https://github.com/QwenLM/qwen-code/pull/13498) 落地;P2 候选选型
> (RocketMQ LiteTopic 5.5.0+)由
> [#13200](https://github.com/QwenLM/qwen-code/issues/13200) 钉定。

## 问题

MQ2 要把一个基于 broker 的生产者接到 after-commit 发布点。如果不先落地一个命名的组合点,MQ2 就不得不在同一个 diff 里既改 commit 路径与装配、又引入 broker 客户端,使其「flag 关闭时部署行为逐字节一致」的退出检查无法证明。MQ1 单独落地这个组合点,默认组合等于今天的进程内扇出,使 MQ2 的 diff 纯粹是默认关闭 flag 之后的增量。

MQ1 声明的前置已满足:[#13300](https://github.com/QwenLM/qwen-code/issues/13300)(H0c 评审后续)已关闭、[#13265](https://github.com/QwenLM/qwen-code/issues/13265)(H3)已合并。对「信封键已定稿」作一点限定:冻结的 v1 信封只把
`authoritative_journal` 列为流取值,而本 seam 承载的是公开的
`managed_agent_event` 流——为 MQ2 增补 `public_event` 取值是一项有跟踪的契约
扩展,不是重新打开已冻结的键。

## 现状

2026-10-11 在 `e6ed740eb1` 上核对。

- after-commit seam 已存在:`CommittedEventPublisher`(单方法 `publish(List<EventRecord>)`)被注入 `ManagedAgentStore`,并在 Spring `TransactionSynchronization.afterCommit()` 钩子(`ManagedAgentStore.publishAfterCommit`)中调用。其唯一实现是 `SessionEventHub`——按 Session 的进程内有界缓冲,供 Java SSE 路径消费。代码中不存在任何 `EventTransport` 类型。
- `SessionEventHub` 同时被 `ManagedEventStreamService` 按具体类注入;该耦合不受本切片影响。
- 生产代码不构造 store;53 处测试调用点构造 `ManagedAgentStore`,其中 52
  处传 `CommittedEventPublisher` lambda,余下一处 fixture
  (`Issue13181QueryBudgetTest`)把真实的 `SessionEventHub` 当作
  publisher 传入。

## 设计

1. **`EventTransport` 接口**(放在 `store/` 包,紧邻 `CommittedEventPublisher`,遵循「端口放 store/」的仓库惯例):单方法 `void publish(List<EventRecord> events)`。这是父设计要求命名的适配点;MQ2 的 broker 生产者实现它。MQ1 不交付任何实现。
2. **`CompositeCommittedEventPublisher`**(`service/` 包):一个 `@Component`,是**唯一**的 `CommittedEventPublisher` bean。构造注入 `SessionEventHub` 与 `List<EventTransport>`(默认为空)。`publish` 对空列表直接返回;先调用 hub,语义与今天完全一致(异常照旧传播);随后按注入顺序逐个调用 transport,对每个 transport 的 `RuntimeException` 做隔离(记录日志并继续),使失败的适配器永远不能阻塞或破坏本地 post-commit SSE 扇出——即父设计 §9「MQ 故障只表现为唤醒/物化延迟」的约束。
3. **`SessionEventHub` 不再实现 `CommittedEventPublisher`。** 保留其 public `publish` 方法与 `@Component` 注解;唯一把 hub 当 publisher 传入的测试 fixture 改为传 `hub::publish` lambda。其余测试构造(lambda)一律不动。
4. **无配置、无 flag、无新依赖。** `qwen.managed-agent.event-transport.*` 属性按父设计随 MQ2 的适配器到来。

### 为什么用单 bean 组合而不是 `@Primary`

保留 `SessionEventHub implements CommittedEventPublisher` 再给组合体加 `@Primary`,会让容器里永久存在两个 `CommittedEventPublisher` bean;任何未来对该接口的集合注入都会双扇出。一个角色一个 bean 才是诚实的组合,而全部修改成本只是一个 `implements` 子句加一处测试 fixture lambda。

### 为什么 hub 调用不包隔离

try/catch 只包住新增的、默认为空的 transport 一侧。hub 调用保持今天精确的故障语义,这使「部署带 seam 后行为一致」成为 diff 的可检查属性,而不是一句断言。

## 范围边界

- 无 broker 客户端、生产者、消费者或配置接线(MQ2)。
- 不接权威 journal 事实的第二条线(`ManagedSessionStore.commit`);父设计把它划给 MQ2,并禁止把本 seam 重新标榜为覆盖它。
- 不做信封契约的 Java 镜像。父设计阶段表(§7)原本把 Java fixture 消费方划给
  落入 MQ1 的契约切片;已合入的契约切片 [#13498](https://github.com/QwenLM/qwen-code/pull/13498)
  将其推迟到 transport 切片(交付台账 #13498 行),本切片维持该排除。
- 不改 `ManagedAgentStore`、commit 路径、SSE 端点或 TypeScript 侧。

## 验证

- 新增 `CompositeCommittedEventPublisherTest`:默认组合精确投递到 hub;整批
  原样到达每个 transport;hub 先于 transport 调用;抛异常的 transport 既不传播
  也不妨碍 hub 与后续 transport 的投递;hub 故障会传播并跳过 transport;
  transport 的 `Error` 不被隔离;空列表无操作;多 transport 按序调用;丢弃日志
  携带 tenant/session/序号身份;Spring 上下文把 `EventTransport` bean 收集进
  组合体,且组合体是唯一的 `CommittedEventPublisher` bean。
- 既有测试套件不改且保持绿色:`SessionEventHubTest`、`SessionEventHubPinningTest`、`ManagedEventStreamServiceTest`、`ManagedEventReplayTest`、`ReplayFloorRetractionTest` 与 `ManagedAgentServerIntegrationTest`——最后一个经真实 Spring 上下文断言 commit 到 hub 的投递,可证明组合体被装配为 store 的 publisher。
- 模块的 `mvn verify` 门禁(checkstyle、spotbugs)通过。
