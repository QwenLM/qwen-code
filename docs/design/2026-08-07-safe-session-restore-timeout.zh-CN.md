# 安全且可观测的大会话恢复超时

[English](2026-08-07-safe-session-restore-timeout.md) | [简体中文](2026-08-07-safe-session-restore-timeout.zh-CN.md)

[ACP 启动与会话恢复预算设计](acp-startup-restore-budgets.zh-CN.md)（[English](acp-startup-restore-budgets.md)）已取代本记录最初关于准备阶段计时与超时响应适用范围的约定。当前行为以该设计中的共享单调截止时间和准备阶段过期契约为准；下文关于已派发请求的隔离锁与清理设计仍然适用。

## 背景

Issue #8678 表明，会话恢复必须先重建持久化的 JSONL 对话记录，才能返回 ACP `loadSession` 或 `unstable_resumeSession` 响应。因此，大型对话记录可能超过 bridge 原先共享的 10 秒初始化超时。当前 SDK 不暴露 JSON-RPC 请求 ID 或取消操作，所以 bridge 无法取消底层 ACP 请求。

原有超时路径只停止等待，子进程仍继续恢复。通道清理可能随后杀掉仍承载其他存活会话的复用子进程，也可能在调用方收到错误后，由迟到的恢复创建会话和写入租约。错误还被归类为普通初始化超时或一般 500，无法说明受影响的会话与恢复阶段。

8 MiB 的 live journal 和 4 MiB 的 compacted replay 限制无法约束这些工作。它们约束的是重建之后的客户端回放，而不是磁盘上的对话记录读取。

## 目标与非目标

本改动为恢复提供独立且可配置的截止时间，使超时错误结构化，将不可取消的迟到工作隔离到结算完成，并在 daemon 和 ACP 子进程之间提供阶段级跟踪。

本改动不实现流式 JSONL 解析器，不添加对话记录索引或快照，不保证所有大型对话记录都在 60 秒内恢复，也不改变 WebUI 先 detach 后 load 的事务。这些属于后续工作。

以下两个缺口是有意保留的，需要明确记录。

**对话记录的物化成本尚不能单独归因。** 子进程把 `config_setup` 记录为一个阶段，完整 JSONL 读取与活动链重建都在其中发生。JSONL 读取由 `loadCliConfig` 通过 `argv.resume` 执行，load 和 resume 处理器都会设置该参数；启用聊天记录和写入租约时，`config.initialize()` 还会额外执行一次权威重载。因此，恢复再次超过预算时，跟踪只会显示 `config_setup_ms ≈ budget`，无法告诉运维人员耗时来自对话记录还是运行时设置的回归，P1/P2 工作也无法仅凭这些跟踪为待优化阶段建立基线。Issue #8678 的 P0 要求将对话记录索引/读取与活动链重建拆成不同阶段；本改动提供它所声明的较粗划分（对话记录/配置、认证、注册和回放），不提供更细划分。补齐这个缺口需要在 core 会话加载器内部埋点，而那也是 P1/P2 将重构的代码，因此随该工作安排。如需提前实施一个局部版本，可由加载器在恢复的会话数据上记录读取耗时，再由子进程 profiler 在现有属性前缀下以 `transcript_read` 阶段上报。

**大型恢复期间的同通道会话延迟尚未测量。** 已断言同通道的其他会话仍然存在且在逻辑上可用，但尚无证据表明，共享子进程的事件循环重建数百 MiB 对话记录时，这些会话仍能及时响应。子进程已有事件循环延迟监控，快照包含 mean、p50、p99 和 max；只需一个足够慢、能跨过截止时间的 fixture，即可同时补齐这项测量和未测试的空通道预算增加场景。

## 超时契约

服务端恢复预算按以下优先级解析：

1. `sessionRestoreTimeoutMs` / `--session-restore-timeout-ms` 无条件优先，包括低于默认值的配置，以支持希望恢复快速失败的部署；
2. 否则使用 60,000 ms；如果显式提供的 `initializeTimeoutMs` / `--initialize-timeout-ms` 更大，则提高到该值。

启动预算可以提高恢复预算，但不能降低它。两者衡量不同工作；收紧子进程初始化检查的部署不应默默继承低于默认值的恢复截止时间，因为本改动正是要消除这种行为。

服务端值必须为不大于 `2^31-1` 的正整数。Daemon 在 bootstrap 与 runtime capabilities 中均通过可选 v1 字段 `limits.sessionRestoreTimeoutMs` 公布实际值。

TypeScript SDK 按以下顺序选择恢复超时：单次请求的 `timeoutMs`、显式全局 `fetchTimeoutMs`、缓存的服务端 capability 加 10 秒、最后为 70 秒。单次请求设为零会禁用客户端定时器，该值不被序列化。调用 `capabilities()` 会刷新缓存的静态预算；恢复本身不会隐式请求 capability。

WebUI 向 SDK load/resume 传递服务端预算加 10 秒，并将服务端预算加 15 秒用于自身看门狗。缺少 capability 值时分别回退为 70 秒和 75 秒。Attach 保持现有 30 秒看门狗。推导出的延迟超过 JavaScript 定时器上限时，禁用该客户端定时器，以免 Node 将其压缩到约一毫秒。

## 恢复归属与终态仲裁

准备阶段过期时不会派发 ACP 恢复。它释放准入名额与 in-flight 条目，不建立已放弃恢复的隔离锁，并允许同一 ID 立即重试。下述放弃生命周期仅适用于已经派发 ACP 请求的情况。

`inFlightRestores` 持有两个 Promise：返回给调用方的 public Promise，以及表示真实 ACP 请求及其清理过程的 settlement Promise。它还持有会话 ID 的隔离锁并计入恢复容量。正常成功时，注册过程将容量转移到存活会话，并可释放准入；放弃后，隔离锁、准入名额和 in-flight 容量一直保留到真实结算完成。

显式生命周期标志对截止时间与 ACP 结果进行仲裁。首先观察到 `active` 的一方改变公共终态，从而不依赖同一时刻边界上的 `Promise.race` 回调顺序。

| 状态        | 含义与允许的转换                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`    | 相同 action、相同请求形状的调用合并等待。ACP 成功可以注册会话；失败可以正常返回。                                                                                                                                                                   |
| `abandoned` | 截止时间先到。公共调用方收到结构化超时。该 ID 从待处理恢复事件中移除，并隔离迟到的子进程通知。同一 ID 的重试收到 `restore_in_progress`，`reason: awaiting_abandoned_cleanup`，以及按恢复预算推导、下限 5 秒上限 120 秒的重试提示，而不是固定 5 秒。 |
| overdue     | 又过了一个完整恢复预算，仍未结算。既有会话与工作区控制仍可用，但新的 spawn/load/resume/branch 工作会被拒绝，让通道排空；关闭传输是释放永久挂起请求的唯一手段。只要同通道还有存活会话，就不会强制杀掉该通道。                                        |
| cleanup     | 迟到的 ACP 成功或失败触发恰好一次子进程 `qwen/control/session/close`。Resource-not-found 表示已经清理完成。                                                                                                                                         |
| quarantined | 清理结果不确定。既有会话与工作区控制仍可用，但新的 spawn/load/resume/branch 工作会被拒绝，直到通道排空。                                                                                                                                            |
| settled     | Close 成功、资源不存在，或传输已关闭。恢复准入名额、容量槽位和 in-flight 条目被释放。通知隔离锁保留到该 ID 的新注册尝试接管归属，或通道退出。                                                                                                       |

放弃会保留归属，但并非无限期保留。`overdue` 限定了挂起的恢复可以占有准入名额、in-flight 条目以及无法通过其他方式释放的会话 ID 隔离锁的时间窗口：宽限期后，通道不再接受新工作，普通排空路径随后回收子进程。隐藏工作仍运行时释放容量会允许无界超额占用，而强杀仍有其他存活会话的通道会重新引入本改动要消除的故障，因此两者都不会执行。

已放弃恢复的通知隔离锁没有 TTL，一直保留到通道退出，或该 ID 的新注册尝试显式接管归属。调用方指定 ID 的 spawn 与 restore 都会在等待通道设置之前同步预留归属，因此不同方向的竞态不能为同一 ID 发起两个 ACP 注册。归属转移发生在 ACP 注册调用之前，以便缓冲合法的启动通知；失败的尝试会清除这些帧，并恢复普通的 60 秒已关闭会话 tombstone。

## 通道安全

已派发请求超时时，bridge 从 `pendingRestoreIds` 中移除该 ID、清除其早期事件，并把它记录到通道的 `unsettledAbandonedRestores`。如果通道没有存活会话、待处理 spawn、其他 restore 或工作区控制操作，就同步标记为 dying，并异步终止子进程；504 响应不等待 TERM/KILL 升级过程。外层 `qwen serve` 进程继续运行。

只要存在同通道的其他工作，子进程就保持存活。迟到清理失败会设置独立的 quarantine 位，而不设置 `isDying`，因此其他会话的 attach、prompt、close 及工作区控制可继续。新工作在容量检查之前被拒绝，从而稳定返回 `acp_channel_unavailable`，而不是偶然的会话数量上限响应。可见工作排空后，子进程被回收，后续请求可以创建干净通道。

通道是否应被回收是**根据当前状态推导的，而不是永久标记**。当可见工作排空，且普通的 pending empty reap、非空 `unsettledAbandonedRestores` 或 quarantine 中任一条件仍成立时，通道会被回收。真实结算会从集合中移除该 ID，因此迟到恢复完成且被干净关闭的通道会重新遵循配置的空闲通道策略，而不会因为已经恢复的超时被强迫冷启动。只要恢复确实仍未完成，排空就是关闭传输的途径，而关闭传输是打破永久挂起请求的唯一手段。

Shutdown 等待每个真实 settlement Promise，但每个 ACP 请求都会与 `channel.exited` 竞速。因此，即使 SDK 请求 Promise 永远不完成，终止通道也能释放 shutdown。所有处理已放弃请求结果的逻辑都安全处理 rejection。

## 错误契约

`SessionRestoreTimeoutError` 继承 `BridgeTimeoutError`，但会优先归类为 `restore_timeout`。两个超时阶段都返回 REST HTTP 504，包含 `code`、`errorKind`、`retryable: true`、`sessionId`、`action` 和配置的 `timeoutMs`。准备阶段过期会额外携带 `dispatched: false`，不含 `Retry-After`，也不建立已放弃恢复的隔离锁，因此同一 ID 可以立即重试。ACP 派发之后，响应保留按预算推导并钳制为 5–120 秒的 `Retry-After`，同时该 ID 保持隔离，直到请求和清理结算。ACP HTTP 与 WebSocket 返回 JSON-RPC `-32603`，携带相同数据及 `httpStatus: 504`；仅已派发情形包含 `retryAfterSeconds`。

通道停止接受新工作时，以 HTTP/ACP 状态 503 拒绝，code 和 error kind 均为 `acp_channel_unavailable`。`reason` 区分两种原因：`restore_cleanup_failed`（超时恢复清理失败，子进程状态不明）与 `restore_settlement_overdue`（已放弃恢复在截止时间之后又经过一个恢复预算仍未结算）。

## 可观测性

对于已派发的请求，Bridge 创建恢复 span，并始终把 trace context 注入 ACP load/resume metadata。它记录 action、通道 ID、会话 ID、配置预算、公共结果、迟到结果以及清理或 quarantine 结果，不包含对话记录内容。

子进程在 `qwen-code.daemon.session_restore` 中延续该 context，并记录设置加载、存活恢复或持久化存在性检查、配置设置、认证、文件系统设置、会话注册/回放以及响应构建的耗时。首先失败的阶段记录为 `failed_stage`。

## 验证

单元测试使用确定性延迟子进程与假定时器，覆盖空通道回收、同通道其他会话存活、同一 ID 的隔离、恰好一次迟到 close、quarantine 排空与恢复、容量保留、传输关闭仲裁，以及请求挂起时的 shutdown。REST 与 ACP 映射、capability 传播、SDK 传输 abort 行为、WebUI 定时器推导、trace 传播和失败阶段归因均独立断言。

E2E 计划使用延迟子进程验证公共截止时间与进程存活。约 80 MiB 的对话记录仅作为手工基准测试和 trace fixture；CI 不断言依赖机器性能的延迟。
