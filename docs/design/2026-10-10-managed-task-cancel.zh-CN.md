# Managed 公开任务取消（H4f）

[English](2026-10-10-managed-task-cancel.md) | [简体中文](2026-10-10-managed-task-cancel.zh-CN.md)

状态：本变更为 `child_agent` 任务实现。`cancelSessionTask` 与 `cancelWebShellTask` 在契约 `1.40.0` 中由 `planned` 变为 `partial`（暂定编号：已有开放 PR 占用 `1.39.0`）。

已落地：

- 按任务契约规定顺序进行的持久 `task_cancel` 准入；
- 一切结果都从任务已提交记录读取的投递；
- 有界重试，超出后停放而不长期占住 Session；
- child 结果中继在物理上停止 child 的停止分支；
- 任务视图上的 `cancel` 动作；
- WebShell 请求中仅用于追踪的 `requestId`。

仍未完成：其余任务类型的取消路径、child 任务的输出事件，以及 channel delivery 那一半（见"后续工作"）。

这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4f** 切片，即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段，由 [#13746](https://github.com/QwenLM/qwen-code/issues/13746) 跟踪。它实现的是 [#12847](https://github.com/QwenLM/qwen-code/issues/12847) A6/A7 所要求、并由 #12998 在契约 v1.23 中定下的取消语义（[任务契约](2026-09-27-managed-agent-task-contract.zh-CN.md) 第 4.4、4.5 节）。它还补上了 #12847 B12，并回答了 [H4b](2026-10-07-managed-child-session-runtime.zh-CN.md) 的未决问题 1：运维如何关闭一个 `unknown` 投递。

## 问题

调用者能列出任务（v1.19）、读取任务并观察其事件（v1.31），却无法停止它。自 H4b 起，`child_agent` 类型会产生真实任务：每个任务都是一个在父 Workspace 中做模型工作的 child Session。今天要停止它，只能关闭整个父 Session，因为 child run 的停止请求只有关闭级联这一个调用方。

契约早已钉住语义。下面三个事实必须彼此分开：

- Java 已持久接纳该命令（`202`）；
- 任务 authority 已记录这次取消（`completed`，附回执）；
- 任务在物理上以 `cancelled` 结算。

本切片要避免两种失效：authority 尚未记录就报告成功的取消，以及重放成第二次取消。

## 现状

以下事实来自 `main` 的 `ba8615f4c4`（Flyway V60，契约 `1.38.0`），在只新增了 TypeScript 与文档提交的 `1f4484d34a` 上依然成立。

- **契约。**
  - 两条取消路由都是 `planned`，并带有 v1.23 定下的检查顺序（A6）与结果（A7）文本。
  - `PublicCommandOperation.task_id`、`WebShellCommandOperation.taskId` 以及 `task_cancel` 结果条件都是 `planned`。
  - `WebShellTaskCancelRequest` 是 `planned`，且没有 `requestId`（#12847 B12）。
  - `TaskActionCapability` 为 `partial`。
- **operation 表。** `managed_agent_operation`（V17）承载生命周期、cwd 与动作响应操作。
  - 失败码存于 `error_code`（V24），没有 `task_id` 列。
  - "每个 Session 一个开放操作"由 `ManagedAgentStore.hasOpenOperation` 实现：它统计处于 `PENDING`、`RUNNING`、`RECOVERY_BLOCKED` 的操作，以及待处理的变更命令。
  - 生命周期协调器的扫描（`findDeliverableOperations`）会取走除 `ACTION_RESPONSE` 外的所有类型。
- **任务视图。** `ManagedTaskService` 的 `action_capabilities` 恒为空列表。每个会投影任务的记录（包括 `child_run`）在每次视图变化时，都会向 H3 的每任务日志追加一条 `state_changed` 事件（`ManagedExtensionRecordStore` → `ManagedTaskEventStore.appendStateChange`）。
- **停止原语（H4b）。**
  - Hosted Harness 的 `POST /session/:id/children/operations` 接受 `kind: "cancel"`，经 `requestStop` 在 `child_run` 记录上提交 `stopRequested: true`。该标志只设一次、永不清除，run 结束后被冻结（`isChildRunSuccessor`）。
  - `kind: "close_scope"` 把 run 以 `stop_requested` 结算为 `cancelled`。
  - 二者唯一的调用方是 `SessionLifecycleCoordinator` 中的关闭级联，它会等待 child 的活跃 Turn 自行结束。
  - child 结果中继盯着 child 的 Turn；Turn 为 `CANCELLED`/`FAILED` 时，run 以 `child_failed` 结算为 `failed`。
- **其余任务类型。**
  - `background_shell` 与 `monitor` 被 H3 验收门禁（#13532/#13533）挡住，仍未启用。Shell 发布器在 `stopRequested` 之后仍结算为 `exited`，`monitor_run` 没有停止标志。
  - `workflow` 没有运行时（H4c 只登记了禁用的类型）。
  - `automation_run` 根本没有停止请求。
- **channel 投递。** `channel_delivery` 不投影任务，所以一次投递不是任务。H5 的公开 channel 路由只读；变更路由（重发）被推迟，Hosted 的 `cancel_delivery` 动词只在内部使用。

## 决策

1. **v1 只取消 `child_agent` 任务，并在任务视图中如实声明。**
   - `ManagedExtensionProjection.taskActions(kind, state)` 是唯一规则：只有处于 `pending`、`running`、`waiting`、`degraded` 的 `child_agent` 任务才公布 `cancel`。
   - 其余类型，以及任何终态或 `recovery_blocked` 的任务，不公布任何动作；对它们的新取消请求得到 `409 task_action_unavailable`。
   - 任务视图与准入复查读同一个函数，且 Session 不处于 `ACTIVE` 时视图不公布任何动作，所以公布的动作与路由的任务检查、Session 检查一致。与另一个开放操作的争用（`409 session_operation_active`）以及 Workspace 存储迁移栅栏（`409 workspace_unavailable`）都是暂时的，不反映在视图中。
   - 契约第 4.2 节允许 `recovery_blocked` 的任务公布 `cancel`；v1 有意不这样做，因为等待恢复对账的 run 尚无定义好的停止路径。
   - 已记录停止请求的任务仍公布 `cancel`：请求可以合并（契约第 4.4 节），且每个操作各自得到结果。

2. **准入按 A6 顺序执行，授权在此确定。**
   - 检查依次为：
     1. key：缺失为 `400 invalid_request`，格式错误为 `400 invalid_idempotency_key`；
     2. 当前访问权：`404 session_not_found`，然后 `404 task_not_found`，然后 `403 task_forbidden`；
     3. 在 Session 锁下查找保留的 key，作用域为租户、Session、类型、actor 与 key；
     4. 仅对新请求依次检查：`409 session_not_active`；`409 task_action_unavailable`（对任务自身投影行做加锁读取，与可能结算它的状态变化串行）；绑定 Session 的 Workspace 存储迁移栅栏（`409 workspace_unavailable`，与所有同类绑定准入的答复一致）；`409 session_operation_active`；
     5. 插入。
   - `capabilities.tasks` 恒为 true，所以 `400 unsupported_feature` 不可达。
   - 摘要覆盖 Session、类型与任务 ID，不含仅用于追踪的 request id。
   - 授权与 Turn 取消一致：调用者需要绑定 Session 所在 Workspace 的 OPERATOR 及以上；可读但低于此级别的调用者得到 `403 task_forbidden`。
   - 与 Turn 取消不同，Session 是否可执行不是授权事实：投递只是在父会话自己的日志上记录停止请求，不运行新工作。因此一个停止服务的 Session 由新请求检查来回答。
   - 未绑定的 Session 除读权限外没有角色模型。
   - 与 cwd 和生命周期准入不同，角色检查在重放之前，因为 A6 规定保留的 key 永远不能绕过当前访问权。

3. **存储：一列与两处排除。**
   - V62 为 `managed_agent_operation` 增加 `task_id`；失败码沿用 `error_code`。
   - `TASK_CANCEL` 不进入生命周期协调器的扫描，因为它有自己的协调器。
   - 它也不计入绑定 Session 的后续 Turn 屏障（`hasOpenExecutionOperation`）：停止一个任务不改变 Session 上下文。
   - `recovery_blocked` 的任务取消不算开放操作。它的接受结果靠记录来对账，所以绝不能借此卡住 close、archive 或 delete。其他类型的 `RECOVERY_BLOCKED` 仍照旧计入。
   - 迁移与恢复的空闲检查仍计入停放的取消，在它对账前保持保守；父会话关闭会结束该 run，从而让它完成对账。

4. **一切结果都从已提交记录读取，绝不看线上应答。** `TaskCancelCoordinator` 通过共享租约认领操作，然后读取任务最新的已提交记录。Java 存储在 authority 的提交事务中镜像这份记录，所以它就是 authority 自己的持久陈述。

   | 已提交记录               | 操作结果                                                   |
   | ------------------------ | ---------------------------------------------------------- |
   | 已有 `stopRequested`     | `completed`：`harness_confirmed`、`confirmed`、回执        |
   | run 已结束且没有停止请求 | `failed` `task_already_settled`：`java_durable`、`blocked` |
   | 任务类型没有取消路径     | `failed` `task_action_unavailable`                         |
   | 任务已不存在             | `failed` `task_not_found`                                  |
   | run 存活且没有请求       | 经 child 操作路由发送 `kind: "cancel"`，然后重读记录       |
   - 终态 run 除投递行外全部冻结，所以"结束时没有停止请求"就证明该请求以后再也不可能落地。这是唯一的确定性拒绝。
   - Harness 的拒绝或丢失的应答本身不证明任何事，一律重读记录判断。
   - 回执是记录证明请求成立时铸造的不透明 `rcpt_` 句柄，不是日志引用，符合契约要求。
   - TypeScript 无需改动：现有的 `requestStop` 可安全重放（标志已设时为空操作），终态 run 会拒绝该请求。

5. **有界投递会停放；停放的取消只做对账。**
   - run 存活而请求仍不可见时，按调度退避重试，最多 16 次。默认 1 秒到 1 分钟的退避下，15 次等待合计约十分钟。
   - 预算按认领次数（操作的 claim generation）计算，而不是按已完成的重试计算；投递运行期间每过租约的三分之一续租一次。因此一次超过租约的挂起尝试（例如 Harness 冷加载）既不会在自己运行时被重新认领，也逃不出预算；超出预算的认领只按记录停放，不再发送。
   - 之后操作变为 `recovery_blocked`，附 `task_cancel_unconfirmed`，`java_durable`、`blocked`。
   - Harness 自身的拒绝（父会话等待恢复时的 `hosted_turn_recovery_required`、`hosted_children_unavailable`）同样不能证明任何一方，因此也消耗同一份预算；在此期间开放的取消占住 Session 的操作槽位，与契约对开放取消的规定一致。
   - `failed` 的取消是终态，但保留契约规定的 `blocked` 投递状态，因此其 `available_at` 移到最大值：任何对 blocked 索引区间的扫描都不会再读到它。
   - 停放的取消每五分钟重读一次记录：
     - 此后记录到了停止请求（另一个取消或关闭级联），则完成；
     - run 结束且没有请求，则失败；
     - 否则继续停放。
   - 它永不重新发送：契约禁止重新执行接受结果未知的操作。由于停放的取消不算开放操作，调用者随时可以发起新的取消。
   - 读不到记录的对账会把操作再停放一整个复查周期，所以一条读不出的记录不会钉在停放扫描的队首；该扫描走 `(delivery_state, available_at)` 索引。

6. **中继负责物理停止 child。**
   - 对已提交记录带有 `stopRequested` 且尚未结束的 run，新的停止分支在中继的“父会话关闭中”与“记录已结算”两个提前出口之后、在创建、绑定、观察或判失败 child 的分支之前执行。中继本就负责 child 的整条流程，所以不会有第二个驱动者争抢其账本行。
   - 停止分支按 child 的情况处理：

     | child                                                           | 停止分支                                                                                                                                                                                          |
     | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | 尚未铸造 child（账本与谱系都为空）                              | 不创建 child，直接以 `close_scope` `started: false` 结算。若创建先落地，判定/铸造提交门会拒绝该结算，重试时就会写出 child 的名字。                                                                |
     | child 的 Turn 为 `ACCEPTED` 或 `RUNNING`                        | 通过 child 自己的持久 Turn 取消（`ManagedAgentService.cancelChildTurn`，以父会话、run 与 Turn 为键）取消该 Turn，然后在心跳时再看。                                                               |
     | child 的 Turn 为 `CANCELLING`                                   | 在心跳时等待：该 Turn 自己掌握结果，再驱动取消也不会生效。                                                                                                                                        |
     | child 的 Turn 为 `CANCELLED`，或在取消已对其生效之后为 `FAILED` | 从已提交证据得出启动配对（`reconcileAttach`，会重放丢失的 dispatch 或 attach），先接纳 child 的关闭，再以 `close_scope` 结算。已铸造但从未启动的 child 具名结束；无法关闭的主机照旧保留关闭债务。 |
     | child 的 Turn 先 `COMPLETED`，或没有任何取消到达而 `FAILED`     | child 的自然结果优先（契约第 4.4 节）：走普通流程交付结果，或以 `child_failed` 结算为 `failed`。已结算的 run 保留已记录的请求。                                                                   |

   - 持有 session message 的 child 还会运行不成为 Turn 的消息 turn（[H4d-b 决策 15](2026-10-10-managed-session-message-runtime.zh-CN.md)）。只要还有消息 input 在等待或运行，上表每一行都会同时向 child 的消息路由发送 `stop` 并在心跳时等待，`CANCELLED` 那一行也不例外；结果是最新已结算的 turn（Turn 或消息 turn），所以即使 Turn 已 `COMPLETED`，被停止取消的消息 turn 也会让 run 成为 `cancelled`。
   - 落在恢复中的 Turn 上的取消可能让它以 `FAILED` 而非 `CANCELLED` 结束。停止分支凭“取消已对该 Turn 生效”的持久证据区分两种 `FAILED`：该 Turn 进入过 `CANCELLING`，且 child Session 在同一事务中记录了 `turn.cancel.requested`。在已结束的 Turn 上接纳的取消命令不会记录任何东西，所以抢在停止之前的自然失败仍为 `child_failed`。停止分支自己的取消命令以父会话、run 与 Turn 为键，键中的空格使其不会被调用者在租户级共享命令命名空间里的可见 ASCII key 抢占。
   - 中继在有限次尝试内无法完成的停止（无法证明的 attach 链、反复失败的关闭）会走中继既有的放弃链：结算为 `failed`，账本行归为 `unknown`，与中继无法完成的任何 run 相同。这条路径属于 H4b，本次未改。
   - 请求停止后才完成的 run 保留该请求，因此 H4d 的续接拒绝把它作为前驱（`continueChildRun` 不接受已请求停止的前驱）。
   - 只有这次结算才会让任务变为 `cancelled`。在此之前任务状态不变，child 处于预配或已挂接时其 runtime 显示为 `draining`（未绑定的 pending run 仍为 `unbound`）。正在等待该 child 的前台父会话，会由现有等待器答复 "Child agent run cancelled (stop_requested)"。

7. **`unknown` 投递的运维方案（H4b 未决问题 1）。**
   - `child_run` 记录的投递只会在中继领取到结果之后才变为 `unknown`；而被归为 `unknown` 的中继账本行属于已终态的 run（放弃链与“记录已结算”路径都会先提交或发现终态 revision）。无论哪种情况，任务都已是终态，没有 `cancel`。
   - H4f 不为它新增运维动词：投递保持可见的 `unknown`，永不喂给模型、永不重新执行，父 Session 关闭时会把其账本行归为 `orphaned`。
   - 存活的 run 不会被困在 `unknown` 账本行后面：中继的放弃链总是先提交终态 `fail`，再做归类。
   - 运维在各种情况下的手段：
     - 存活但卡住的 child：取消该任务；
     - 停放的取消：发起新的取消，或关闭 Session；
     - 无法证实的投递：关闭 Session。

8. **B12：WebShell 请求携带仅用于追踪的 `requestId`。**
   - 字段可选、可为 null，最长 128 字符，且不进入摘要。可放入请求头的值（可见 ASCII）经 `RequestIdFilter.useClientId` 成为 `202` 的 `X-Request-Id`（规约现已声明该响应头）；其他值会像其他 WebShell 命令一样被替换为服务端生成的 id。
   - `WebShellLifecycleRequest` 的同类缺口按 B12 的说法，留给让客户端发送生命周期命令的那次变更。

9. **child 任务的流（#13746 F2）不需要新日志。**
   - child 任务的视图变化（包括停止请求带来的 `draining`）已经走 H3 的每任务日志，带保留下限与游标；其 `output_cursor` 就是日志尾部。本变更用一个真实记录测试把这一点钉住。
   - child 任务不公布 `read_output`，所以按契约它不产生 `output` 事件。
   - child 自己的对话记录在 child Session 中。把任务关联到该 Session，或把其输出作为任务事件转发，是另一项决策（见"后续工作"）。

10. **channel 投递（#13746 F3）不是任务。**
    - `channel_delivery` 不投影任务，所以 `cancelSessionTask` 永远不会指向一次投递。
    - H5 的投递取消归入其推迟的公开变更路由（先是重发）。它应复用本切片的模型，而不是另起一套词汇：
      - 共享 operation 表；
      - A6 准入顺序；
      - A7 结果；
      - 以记录为准的判定，由投递的 `cancelRequested` 扮演停止请求的角色。

## 契约变化（1.40.0）

- `cancelSessionTask` 与 `cancelWebShellTask`：`planned` → `partial`。
- 操作上的 `task_id`/`taskId` 属性与 `task_cancel` 结果条件：已提供（去掉标记）。
- `WebShellTaskCancelRequest`：已提供，并新增 `requestId`；WebShell 的 `202` 声明 `X-Request-Id`。
- `TaskActionCapability` 的描述写明哪些类型会公布 `cancel`，`info.description` 增加 v1.40 段落。
- 生成的 WebShell 类型新增该路由、该请求以及 `taskId`。

## 验证

- **存储，基于 H2 与 Flyway**（`ManagedTaskCancelOperationTest`，10 个测试）：
  - 准入、重放与摘要冲突，包括跨 actor 的情形；
  - 保留的 key 在 Session 变为 `CLOSING` 后仍能重放；
  - 存储迁移栅栏拒绝新的取消，而保留的 key 仍能重放；
  - 各状态下的动作规则；
  - 双向的"每个 Session 一个开放操作"（取消会挡住关闭），以及两个竞争的 key 恰好只准入一个；
  - 停放的取消不会被再次认领、不算开放，且只在停放状态下对账；
  - 认领下每种结果写入契约规定的状态字段，且失败的取消永久离开 blocked 扫描区间；
  - 真实 SQL 上的中继证据：只有对 Turn 生效的取消才留下 `turn.cancel.requested`，在已结束的 Turn 上接纳的取消不留任何东西，带空格的内部 key 可正常往返；
  - 停止状态按记录主键从已提交记录体读取。
- **投递**（`TaskCancelCoordinatorTest`，10 个测试）：
  - 从记录得出完成，以及无需发送的合并；
  - 不发送即得出 `task_already_settled`；
  - 拒绝与丢失应答都按记录判定；
  - 有预算的重试，之后停放；超出预算的认领不发送即停放；
  - 慢投递会续租；
  - 没有取消路径的类型；
  - 停放对账永不重发；读不到记录的对账等待一整个复查周期。
- **中继**（`ChildResultRelayTest`，新增 9 个测试）：
  - 不创建即以未启动结算；
  - 先取消 Turn、对 `CANCELLING` 的 Turn 只等待，再在接纳关闭后以 `close_scope` `started: true` 结算；
  - 抢先完成的情形，以及保持 `child_failed` 的自然失败；
  - 取消生效之后以 `FAILED` 结束的 Turn 结算为 `cancelled`，`ACCEPTED` 的 Turn 像运行中的一样被取消；
  - 已铸造但从未 dispatch 的 child 具名结束；
  - 被拒绝的结算会延后而不是归类；
  - 已结束的 run 永不再次停止。
- **真实记录**（`ManagedExtensionRecordStoreTest`）：一条经 Session 存储提交的 `child_agent` 链，经历停止请求与取消。检查：
  - 每一步公布的动作，以及 Session 非 `ACTIVE` 时不公布任何动作；
  - `draining`；
  - 投递读取的目标；
  - 写入日志的五条 `state_changed` 事件与输出游标（F2）。
- **契约：**
  - `ManagedAgentApiContractTest` 覆盖两条路由：`202`、重放、跨面重放、冲突、动作拒绝、`400`（包括 WebShell 的未知字段，以及答复 `invalid_idempotency_key` 的超长 key）、`404`、租户过滤器的 `403`，以及带 `task_id` 的操作回读。
  - `PlannedTaskContractTest` 现在把两条路由钉为 `partial`，并校验 `requestId` 实例。
  - `SurfaceRegistry` 以新的规则类 `TASK_OPERATOR` 登记两条路由，`SurfaceAdmissionAcceptanceTest` 在两个面上探测：读权限之下为 `404`，reader 得 `403 task_forbidden`，OPERATOR 与 owner 级调用者被准入并得到路由自身的 `409`。同一套件还钉住保留的 key 永远不能绕过当前访问权：准入它的 OPERATOR 可以重放，降为 reader 后得到 `403 task_forbidden`，Session 删除后得到 `404 session_not_found`。
- **未运行：**
  - 带真实 Hosted Harness 与真实 child Session 的产品栈运行；
  - #12380 F 阶段针对该类型的故障轮次（取消应答丢失、结算过程中取消、与父会话关闭竞争的取消、所有者消失后取消）。上述单元套件对照录制的控制面调用覆盖了这些时序，但并非在真实栈上。
- **与中继共享、本次未改：** 投递经由 child 结果中继所用的同一个 Hosted 挂接到达父会话。凡是阻断这条路径的情况（父会话的创建者失去了执行所需的 Workspace 授权，或该 Session 仍被另一个进程挂接），都会以同样方式阻断中继自己的提交，此时取消在预算用尽后停放。

## 后续工作

| 项               | 范围                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3 类型          | `background_shell` 与 `monitor` 启用时：Shell 在请求后以 `stop_requested` 结算（发布器目前结算为 `exited`），Monitor 增加停止请求，二者带上投递分支加入 `CANCELLABLE_TASK_KINDS`。 |
| workflow、自动化 | 随 workflow 运行时（#13803）与 H6 per_run：先在各自记录上加停止请求，再复用相同的投递与停止分支。                                                                                  |
| channel 投递取消 | 随 H5 的公开变更路由：复用本切片的操作模型（决策 10）。                                                                                                                            |
| child 输出       | 把 child 任务关联到其 child Session，或在 `read_output` 之后把其输出作为任务事件转发。                                                                                             |
| WebShell         | 带取消控件的任务面板，以及任务路由的客户端方法。                                                                                                                                   |
| F 阶段           | "验证"中列出的产品栈故障轮次。                                                                                                                                                     |
