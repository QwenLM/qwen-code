# EventTransport MQ3：部署故障矩阵

[English](2026-10-14-managed-agent-event-transport-mq3.md) | [简体中文](2026-10-14-managed-agent-event-transport-mq3.zh-CN.md)

> **状态：** 已作为门禁实现。这是跨节点 EventTransport 设计
> （[2026-10-04-managed-agent-event-transport](2026-10-04-managed-agent-event-transport.zh-CN.md)
> §7）的 **MQ3** 阶段，由 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 跟踪。
> 它的前置阶段 MQ2 已分四个切片落地
> （[2026-10-12-managed-agent-event-transport-mq2](2026-10-12-managed-agent-event-transport-mq2.zh-CN.md)）：
> MQ2a [#13940](https://github.com/QwenLM/qwen-code/pull/13940)、MQ2b
> [#14029](https://github.com/QwenLM/qwen-code/pull/14029)、MQ2c
> [#14080](https://github.com/QwenLM/qwen-code/pull/14080) 与 MQ2d
> [#14109](https://github.com/QwenLM/qwen-code/pull/14109)。MQ3 不改任何生产代码。
> 它的各行断言的是现有实现的行为；与 §8「要求的行为」不一致的地方，由下文的「发现」记录。

## 问题

MQ2 列出的每一行都是对着单个应用跑的：H2 数据库，Harness 用替身。父设计 §8 的矩阵讲的是部署：不止一个控制面节点、进程在尴尬的时刻死掉、broker 不再应答、时钟彼此不一致、开关需要关掉。这些行只有对着真实进程跑才有意义。MQ3 用两个控制面节点来跑它们：每个节点各带一个打包好的 Hosted Harness，共用一个 MySQL 数据库和一个 RocketMQ 5.5 LiteTopic 集群。它逐行记录现有 transport 的实际行为，包括与 §8「要求的行为」文字不一致的地方。

## 现状

2026-10-14 在 `a6af39188a` 上核对。

- **拓扑。** 每个节点都加入共享的唤醒 bootstrap 组，订阅唯一的 bootstrap lite topic；也都加入共享的 owner 组，订阅自己 Harness 写入的每个 Session 的 lite topic。监听器在完成 SQL 检查与认领之后返回（客户端随即确认），加载则排进一个小线程池。
- **生产者。** 两条线都异步发送，并捕获一切失败。唯一的重试是客户端自带的（总共三次尝试，请求超时三秒）；没有应用层重试，也没有故障期缓冲。journal 的交接在提交线程上执行；公开事件的交接把批次复制进一个 1024 批的队列，同样在提交线程上。
- **启动。** 能力探针、发送探针、owner 消费者和 bootstrap 订阅都需要可达的 broker；任何一项失败都会让 Spring 上下文启动失败。
- **时钟。** 唤醒判断与 journal writer 租约读数据库时钟。Turn 调度租约与各 relay 账本的租约用 JVM 时钟打时间戳。
- **围栏。** 唤醒不携带 epoch。在每个唤醒都要过的检查（Session 存在、workspace 与 journal 一致、序号已提交、Session 与 journal 未终结）之后，过期唤醒只会被活着的 writer 或认领水位拒绝。

## 设计：门禁

`EventTransportMultiNodeGate`（profile `event-transport-multi-node-gates`，SDK Java 任务「EventTransport multi-node gates / RocketMQ 5.5.1 + MySQL 8.4 / Java 21」，failsafe 家族 `event-transport-multi-node`）。

- **节点**：一个打包好的 Hosted Harness（CLI 的 hosted-harness serve profile，模型用假实现），加上在独立 JVM 里运行的完整应用，经 `EventTransportNodeMain` 启动。每一行都起自己的节点，writer 租约 6 秒、Turn 调度租约 6 秒，让死掉节点的占有在本行之内就过期。同一个类的所有节点共用一个隔离的 MySQL 数据库；每一行用全新的 tenant。崩溃即用 SIGKILL 杀掉该节点的 JVM 与 Harness；重启时节点保留原地址。
- **故障点**：节点 JVM 用仅供测试的子类替换生产 bean：唤醒激活器（收到唤醒即停机；认领之后、监听器返回之前停机）、journal 线（带唤醒的记录提交之后、交给 broker 之前停机）、公开事件线（携带 `turn.completed` 的那一批提交之后、交接之前停机）。故障按 Session 由一个文件布防，在两个节点之间只触发一次；触发即调用 `Runtime.halt`，因此不会确认、不会刷盘、也不会走关闭流程。hold-load 故障则不同：它在每个节点上压住该 Session 的所有加载，直到门禁放行。broker 故障用 SIGSTOP 冻结 gRPC proxy，冻结前先核实记录的 pid 正是监听该端点的进程。时钟偏差这一行用 libfaketime（Linux，CI）平移应用 JVM 的墙钟，并检查它确实平移了；节点的 Harness 仍用宿主时钟。没有 libfaketime 时该行跳过：唤醒路径不读任何 Clock bean，除了 JVM 自己的时钟，没有别的办法测它。
- **取证**：每个节点把自己做出的每个唤醒判断、加载结果和交接追加写入各自的证据文件。门禁对它、对 SQL（`ma_session_head` 的 writer、代数与租约，`ma_event_stream` 的水位，已提交的 journal）和对公开 API 做断言，并通过自己的 oracle 组读取到达 bootstrap 通道的内容——某一行需要时，也读该 Session 自己的通道。每一行的日志与证据随测试报告上传。每次等待都会在本行超时触发时立即失败，各行的超时之和也在 fork 的超时之内。broker 必须由这一次运行独占。

## 各行

| §8 故障                                          | 注入方式                                                                                                                                   | 门禁断言                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 重复投递、乱序、ACK 丢失后的再投递               | 两个节点都在 bootstrap 组里；某 Session 的 writer 过期后，把它已提交的唤醒重新发出：较新的两次，然后较旧的一次；加载被压住，直到三份都判完 | 无论落在哪个节点，都是 `SCHEDULED`、`DUPLICATE`、`DUPLICATE`；水位 = 较新的序号；随后经真实 Harness 加载一次 `ACTIVATED`；writer 代数 +1，writer 是激活节点的 Harness                                                                                      |
| 消费者处理前崩溃                                 | 收到唤醒的节点在读任何东西之前停机                                                                                                         | 没有认领；broker 把唤醒交给另一个节点，由它把 Session 激活一次                                                                                                                                                                                             |
| 消费者本地生效后、ACK 前崩溃                     | 收到唤醒的节点完成认领，并在监听器返回之前停机                                                                                             | 水位保留这次认领；再投递到达另一个节点，结果为 `DUPLICATE`；那里不加载；新的输入仍在那里正常执行                                                                                                                                                           |
| SQL commit 与 publish 之间生产者崩溃（journal）  | Harness 提交 Turn 输入的那个节点在提交之后、发出唤醒之前停机                                                                               | 唤醒已提交，却既没到达 bootstrap 通道也没到达 Session 的通道，也从未被认领；Turn 调度器在另一个节点上把 Turn 推进到终态，只一次                                                                                                                            |
| SQL commit 与 publish 之间生产者崩溃（公开事件） | 记录 Turn 最后一批事件的节点在提交它之后、交接之前停机                                                                                     | 之后不会再有通知，只有另一个节点的定时扫描能投影它：已提交的 `turn.completed` 照常可读，日志没有缺口，`covered_sequence = last_sequence`，items 里有输入与回复                                                                                             |
| broker 短时故障                                  | 在一个 Turn 运行期间冻结 proxy                                                                                                             | Turn 正常完成；提交线程上的两种交接都保持在 250 ms 以内；proxy 恢复后，下一个 Turn 的唤醒到达 broker                                                                                                                                                       |
| broker 长时故障                                  | 在冻结 proxy 期间重启一个节点                                                                                                              | 确认发送已经开始失败之后，运行中的节点仍在服务 Turn——既有已持有 Session 的，也有新 Session 的第一个 Turn——两种交接都在 250 ms 以内；开关开着重启的节点拒绝启动；同一节点（此时只剩它）关着开关重启后能启动并服务；故障结束后，开着开关重启，它重新承载唤醒 |
| Java 节点间时钟偏移                              | 一个节点的 JVM 墙钟快 10 分钟，随后另一个节点慢 10 分钟                                                                                    | 快的节点仍把另一个节点的活 writer 判为 `OWNED`，不认领；慢的节点仍把过期的 writer 判为过期，在本节点激活 Session，且它得到的租约按数据库时间仍然有效                                                                                                       |
| Session 改路由后的过期唤醒                       | Session 转到另一个节点的 Harness；重发它的旧唤醒                                                                                           | 无论落在哪个节点都是 `OWNED`；水位始终为空，不加载，writer 不变                                                                                                                                                                                            |
| 开关回滚                                         | 两个节点先以开关关闭重启，再以开关打开重启                                                                                                 | 关闭时：Turn 照常执行，两条通道都收不到任何内容，期间发出的唤醒也无人消费；重新打开后：那个唤醒被消费，下一个唤醒照常发布                                                                                                                                  |

## 发现

发现 1–3、5 与 6 是现有实现与 §8 文字不一致的地方；4 与 7 是各行所依赖的现有特性。

1. **节点在处理唤醒时崩溃，会让 bootstrap 通道停顿约两分钟。** LiteTopic 只有在 broker 让死掉的客户端过期（它的连接过期时限，默认两分钟）之后，才把崩溃成员未确认的消息交给另一个成员，而该 lite topic 后续的消息都按顺序排在它后面。本机用同组两个成员的探针实测：被占住的消息 124 秒后才到达另一个成员，崩溃 5 秒后发出的消息与它一起到达；门禁两条崩溃行的各次本机运行中，唤醒在 121–129 秒后转移。在共享的 bootstrap 通道上，这意味着全集群所有 Session 的唤醒。没有消息丢失——每个唤醒只是晚到——也没有任何输入账本依赖这条通道。被杀时手上没有未确认消息的节点不会占住通道：下一个唤醒在该行的等待时限内就到达了另一个节点。（§8：「broker 再投递；Session 被晚唤醒」——属实，但晚是以分钟计，而且是所有 Session。）
2. **没有生产者重试缓冲。** 面对挂住的 proxy（用 SIGSTOP 冻结），客户端自带的尝试（每次三秒）能扛过几秒钟的停顿——本机的短时故障运行中（冻结持续一个 Turn）一条都没丢——但 proxy 离开更久时发出的信封会被丢弃，并打一条注明事件的 `WARN`，之后也不会补发（本机一次长时故障行的运行中丢了 13 条 journal 信封和 4 条公开信封）。提交路径不受影响：冻结期间，提交线程上的两种交接都只有个位数毫秒。（§8：「生产者以有界缓冲重试」——未实现；故障期间丢失的唤醒靠它的账本恢复。）
3. **启动依赖 broker。** broker 不可用时重启的节点在能力探针上拒绝启动，而报错开头讲的是 LITE group 与 topic 的要求，端点配置项只在最后才提到；回退的办法是开关。长时故障行断言了这次拒绝，修好之后要反过来改。（§8：「传输消费者空转」只对已经在运行的节点成立。）
4. **认领从不回滚。** 认领之后崩溃会烧掉这条通知；Session 靠其输入来源的账本恢复，各来源的缺口记录在 [#14116](https://github.com/QwenLM/qwen-code/issues/14116)。
5. **没有 epoch 围栏。** 过期唤醒被活 writer 或水位拒绝；落在空闲 Session 上且序号更高时会加载它——无害，因为唤醒泵只执行 journal 里已有的内容。
6. **Turn 调度租约用的是 JVM 时钟。** 时钟快出超过一个调度租约时长的节点会把活着的占有读成已过期并接管 Turn；本机一次节点快 10 分钟的运行中，它接管了一个活着的 Turn，每次尝试都撞上持有 Harness 的 writer 租约，重试耗尽后把这个 Turn 判为失败。这不在 transport 范围内——时钟偏差行让 Turn 不经过偏差节点——之所以记在这里，是因为 §8 声称所有租约都沿用本仓的租约惯例。
7. **Harness 停在模型调用处的 Turn 不会被接管。** journal 生产者崩溃行的各次运行中，Turn 在另一个节点上被判为失败（`managed_runtime_recovery_blocked`，原因 `model_start`）：这是 Harness 根据 journal 做出的拒绝，transport 不参与。该行只断言 Turn 被推进到终态且只一次。

## 范围边界

- 不改生产代码。发现 1–3 与 6 记录在此，留待后续；发现 4 的各来源缺口仍归 #14116。
- 本阶段不对 bootstrap 通道分片，不缩短 broker 的连接过期时限，也不加生产者缓冲。
- 不覆盖绑定 Workspace 的 Session、工具与 runtime broker：各行用普通公开 Session，让门禁保持可移植。公开事件通道的重复与乱序行仍归 MQ2d 的单节点门禁，并发认领竞争仍归 `EventTransportConsumerSqlTest`。

## 验证

- `EventTransportMultiNodeGate` 在本机（macOS、MySQL 8.4.7、RocketMQ 5.5.1）运行，其中时钟偏差行因缺少 libfaketime 而跳过；SDK Java 工作流中的新任务（ubuntu-latest、MySQL 8.4.6 服务、libfaketime）运行每一行，任何一行被跳过都会失败。与该工作流的其余任务一样，它每天定时运行，也可手动触发，不随每个 PR 运行（#14205）。提出本变更之前，该任务的定义已在 fork 上借 GitHub 托管的 ubuntu-latest runner 跑过一次：十行全部通过，时钟偏差行也在内。
- 变异检查：每一行都要对着一个故意改坏的构建运行并失败——时钟偏差行的变异在那台 Linux runner 上跑；PR 列出各变异体及其结果。
- `scripts/tests/event-transport-multi-node-ci.test.js` 把任务、profile、broker 准备工作、门禁所需的属性及其超时预算彼此钉住；failsafe 报告检查的 `event-transport-multi-node` 家族在门禁类没有完整运行时让任务失败。
