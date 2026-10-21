# Hosted 事件流存活检测（#14135）

[English](2026-10-18-hosted-event-stream-liveness.md) | [简体中文](2026-10-18-hosted-event-stream-liveness.zh-CN.md)

状态：本次变更已实现。交付 [#14135](https://github.com/QwenLM/qwen-code/issues/14135)，即 [#13302 第 2 项](https://github.com/QwenLM/qwen-code/issues/13302#issuecomment-6117110640)（#12380 决策 3）的心跳那一半，也是 [H4f](2026-10-10-managed-task-cancel.zh-CN.md) 真实栈验收的发现 1。模型、工具与 Turn 的操作预算仍归 #13302 第 2 项。

## 问题

Hosted Harness 的事件流一旦半开，就会被一直读下去。Harness 在网络分区后死掉，或者 pod 被换到另一节点时，都会出现这种情况。Java 的 Turn 读线程（`HarnessCoordinator.readStream`）阻塞在 `HarnessEventStream.next`，除了本地关闭，没有任何东西能结束这次读。#13877 让关闭不再需要锁，所以只要后续有调用发现了代际变化，接管就能结束这次读。但没有代际变化的分区，或者没有其他调用碰到的重启，仍会让读线程停住，Turn 的 coordinator 等待也随之停住。

## 本次变更前的状态

#13314 已于 2026-10-16 落地了这套机制的两端：

- **Harness：** `GET /session/:id/events` 每 15 秒写一条 `: keepalive` 注释，所以没有提交任何事件的 Turn 也会有字节上线。该路由还会发送 `X-Accel-Buffering: no`，避免带缓冲的代理把这些字节扣住。
- **Java：** `HarnessEventStream` 带一个空闲看门狗，上限是 builder 的 `sseIdleTimeout`（默认 45 秒；`Duration.ZERO` 关闭它）。它只在消费方停在 `next()` 时计入静默，读线程读到的每个字节（包括 keepalive 注释）都会重置它。

还缺四样东西：

- 客户端对任何 Harness 都启用上限。早于 keepalive 的 Harness 在健康 Turn 的每个安静阶段都不发字节，所以滚动升级期间，上限会一次次中止这些流。
- 中止抛出的是笼统的 `DaemonTransportException`，只能靠消息文本把它和被重置的连接区分开。
- 看门狗每半个上限检查一次，中止可能落在最后一个字节之后 67.5 秒。
- 打包链路上没有跑过任何探针。

## 决策

1. **数值。**
   - Harness keepalive 保持 15 秒，与主路由的周期一致。
   - 客户端上限保持 45 秒，即三个 keepalive 周期。所以可以连续丢两个 keepalive，第三个间隔仍有一整个周期的余量。
   - 看门狗改为每十分之一个上限检查一次（默认 4.5 秒，最频繁不超过每 100 ms 一次）。因此中止落在最后一个字节之后 45 到 49.5 秒。
   - 打包链路上的实测见"验证"。
2. **Capability。**
   - Harness 在 `GET /capabilities` 的 `hostedHarness.features` 中以 `event-keepalive/1` 声明 keepalive。
   - 只有该项存在时客户端才启用看门狗。对没有它的 Harness，无论 `sseIdleTimeout` 怎么设，读取都保持无上限，与 keepalive 之前一致。
   - 滚动升级的另一个方向本来就没问题：旧客户端的 SSE 读取器会跳过注释帧。
   - 与 `model-selection/1` 一样，`event-keepalive/1` 只是声明，不进入运维设置的 capability digest。
3. **存活结果。**
   - 中止抛出 `HostedHarnessStreamIdleException`，它是携带上限值的 `DaemonTransportException`。上限到期时停在读上的线程收到它，之后到来的调用方也收到它。
   - `HarnessCoordinator` 把它当作普通的暂时性流失败。Turn 被安排重试，重试经由现有恢复 load 重新挂接，并从记录的游标续读事件流。
   - 静默永远不会结算或取消 Turn。与准入后的所有失败一样，没有日志进展的重试计入 `max-post-admission-retries`，只有用完时 Turn 才以 `hosted_harness_unavailable_after_admission` 结束。
   - 运维通过 `Managed Turn coordination will retry …` 中的 `failure=` 标签区分各种结果：

     | 标签                               | 含义                                                                |
     | ---------------------------------- | ------------------------------------------------------------------- |
     | `HostedHarnessStreamIdleException` | 存活超时。                                                          |
     | `IllegalStateException`            | Harness 在终止事件之前结束了流。                                    |
     | `DaemonTransportException`         | 连接被重置或被拒绝。                                                |
     | `DaemonProtocolException`          | 协议错误。这一种会让 Turn 以 `hosted_harness_protocol_error` 失败。 |

4. **其他 Hosted 流。** 都不需要同样的处理：
   - **Java 到 Harness：** 事件路由是唯一的长连接流。`HostedHarnessClient` 的其他调用都是请求，受 `request-timeout`（30 秒）或 `load-timeout`（120 秒）约束。
   - **Harness 到 Spring Store：** 每次调用都是请求，各次尝试有自己的截止时间（`http-managed-session-store.ts` 中的 `AbortSignal.timeout`）。
   - **Spring 的公开 SSE：** 已经在写 `keepalive` 注释（`ManagedEventStreamService`）。给它的静默设上限是各公开客户端自己的事。
   - **Harness 的模型流：** 有自己的空闲上限（`QWEN_STREAM_IDLE_TIMEOUT_MS`，240 秒），属于 #13302 的模型预算之一。

## 边界

- 没有公开 REST API、契约版本或 schema 变更。Java SDK 新增一个公开类 `HostedHarnessStreamIdleException`。
- 存活超时只证明流静默了，从不证明工作已停，也从不授权重放。重新挂接从记录的游标续读，结果含糊的恢复仍保持 recovery-blocked，与之前一致。
- 非 Hosted 的 `DaemonSessionClient` 保留自己的看门狗，不变。
- Spring 服务端沿用 SDK 默认上限，没有新增属性。如果部署在某个空闲超时短于 15 秒的中间层之后，应调整那个中间层，而不是上限。

## 验证

- **SDK 单元测试**（`HostedHarnessClientTest`、`HarnessEventStreamCloseTest`）：
  - 空闲的对端以类型化结果及其上限失败。
  - 只发 keepalive 的对端能撑过上限（针对假对端的探针 1）。
  - 两次读之间的消费方停顿不计入（探针 3 中容忍范围内的延迟）。
  - 中止落在公布的时间窗内（探针 3 中超出容忍的延迟）。
  - 不带 `event-keepalive/1` 的 Harness 读取保持无上限（探针 6）。
  - 每项检查都做过变异验证：去掉门控、改回半个上限的检查间隔，以及三个抛出点各自改回非类型化异常，每个变异都恰好让点名它的那个测试失败。
- **Coordinator 单元测试**（`HarnessCoordinatorTest.anIdleStreamRetriesTheAdmittedTurnWithoutSettlingIt`）：固定该结果会安排重试，从不让 Turn 失败或被取消，并记录类型化标签。
- **打包链路**（`HostedEventStreamLivenessIT`）：MySQL 8.4 上的 Spring、打包的 Hosted Harness，以及二者之间一个能让事件连接保持半开或停滞的 TCP relay。使用发布时的数值。

  四次运行（JDK 25 三次、JDK 21 一次；MySQL 8.4.6，Linux x86_64）的实测：
  - **安静的 Turn（探针 1）。** 55 秒的安静阶段中，relay 处的 keepalive 间隔为 14,999 到 15,000 ms。没有触发空闲重试，Turn 始终只有一条流，模型只运行一次。
  - **半开 relay 后 SIGKILL（探针 2）。** 最后一个字节到达 Spring 之后 48.0 秒（48,017 到 48,044 ms）触发空闲重试，落在 45 到 49.5 秒的窗口内。读线程被释放，Turn 进入重试。
  - **安静读取期间取消（探针 4）。** Turn 经由取消命令结算为 `CANCELLED`，没有空闲重试。
  - **Harness 存活但流停滞（探针 5）。** 流超时一次、重新挂接一次。模型只运行一次，Turn 只完成一次。
  - **整个类**耗时 214.4 到 215.0 秒。
  - **负对照。** 看门狗永不启用时，探针 2 以 `idle retry timed out` 失败，复现了原始问题。

## 后续工作

本项没有。操作预算仍归 #13302 第 2 项。
