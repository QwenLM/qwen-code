# Managed 审批停靠（无状态 Harness 第四阶段）

[English](2026-11-21-managed-action-parking.md) | [简体中文](2026-11-21-managed-action-parking.zh-CN.md)

状态：提案，实现前设计。日期：2026-11-21。本文是[无状态 Hosted Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)第四阶段的实现前设计，对照 `main` 的 `5ab25731e4` 核实，该提交包含已合并的第一阶段（#17690）、第二阶段（#17749）与 3a wake 戳（#17908）。3b（#17953）尚未合入；本文不依赖它，只沿用它的 seal 证书做法。下文的收益与成本都是代码级估算，未经实测；测量是启用门槛。

## 1. 问题与现状

### 1.1 Harness：等待中的 Turn 挂在进程内存里

工具审批与 `ask_user_question` 都先在一个 journal 事务里提交持久等待（`commitDurableWait`，checkpoint 进入 `await_action`），然后在进程内等待：

- **审批。** `hosted-workspace-tool-turn.ts` 的审批分支和 `ask()` 调用 `HostedApprovalWaiters.wait`，带 `expiresAt` 定时器，以及可选的 `hostedLiveApprovalPoll`（`hosted-tool-approval.ts:636`）。后者轮询控制面的审批模式（`createHostedLiveApprovalReader` 读 `session.stores.approvalSelection()`），模式切换到不再询问时代用户放行。
- **提问。** `waitForHostedQuestion`（`hosted-question-wait.ts`）在单问题批次且 provisioner 为 `local-process` 时，于等待期间交还 Workspace mount（`releaseQuestionMount`，`hosted-workspace-tool-turn.ts:5854`），决定后再以原 binding/generation 重新获取（`acquireHostedQuestionRuntime`）。
- **等待之后。** 同一段代码按 `signal.aborted ? 'cancelled' : 'expired'` 结束仍为 `requested` 的 Action，再调用 `resolveDurableWait()`。

等待期间 `session.active` 有值，该 Turn 的 `input.accepted` 尚未结算，它通常还欠着一条 `hosted.cleanup`。因此第一阶段的资格谓词（`hosted-harness-session.ts:5062`）一直拒绝挂起。审批默认超时 `HOSTED_APPROVAL_TIMEOUT_MS` 为 10 分钟，definition 的 `approvalTimeoutMs` 最长可设 24 小时（`hosted-tool-approval.ts:33-35`）。Turn 另有一个绝对 deadline（`input.accepted.deadline`，定时器见 `hosted-harness-session.ts:3833-3855`），控制面默认 30 分钟（`turn-deadline`，`application.yml:95`）。

### 1.2 控制面：等待期间也占着一个 Turn

`HarnessCoordinator.coordinate` 认领 `ma_turn` 行后按固定频率续约派发租约，并在 `consumeStream` 中一直读 Harness 事件流，直到终态。审批等待期间它也一直在读，占用一个执行线程、一条 SSE 连接，每个续约周期还要执行一次 SQL。这条流本身就是第一阶段谓词中的 `session.streams.size > 0`。

流在终态之前结束时，`consumeStream` 抛出 `IllegalStateException`，它被归为 `transientFailure`：消耗重试预算，随后重新 attach。因此如果只改 Harness、让它在等待中挂起，协调器会把这当成故障并立即重新加载 Session。

### 1.3 已有基础：从 `await_action` 冷恢复已经实现并通过故障验证

[G3 第三步](2026-10-09-hosted-g3-step3-recovery.zh-CN.md)已经能让替代 Harness 接手"死在审批等待里"的 Turn：

- 发布等待前保存不可变的 `hosted-approval-continuation/1`，由 Action options v3（审批）或 v4（提问）的 `continuationRef` 引用。超过 64 KiB 内联上限的计划，以及批次中存在未捕获计划（`uncaptured`）的等待，都不具备恢复保证。
- takeover load 在 checkpoint 处于 `before_model`、`await_action` 或 `model_output_committed` 时，用 `findHostedApprovalContinuation` 恢复：保留原 Action ID 与 deadline，重新注册 waiter 与过期处理，决定后执行原批次一次（`hosted-harness-session.ts:8385-8420`）。该恢复臂要求 Session 没有 Hooks、没有 MCP；extension command-step 审批另有一臂。
- 打包故障门禁覆盖多条支路：审批为 requested 时崩溃、决定落库后崩溃、prepare 中崩溃、决定或 load 回复丢失、混合兄弟审批中途崩溃。

也就是说，"在等待点放下进程内的 Turn，之后由任意 Harness 凭持久证据接上"已经成立，只是目前只在崩溃后才发生。第四阶段把它变成一次有意的、干净的停靠。

父设计把恢复路径写作"现有的 Managed Runtime continue 路径"。那是 G1 Runtime 执行的 report/continue/cancel 协议，并不处理审批等待；真正承担恢复的是上面的审批续跑 driver。本文按此修正。

### 1.4 默认配置下的收益很小

停靠沿用第一阶段的空闲定时器，而提交等待本身就是一次活动。默认值下，审批 10 分钟后过期，空闲挂起要在 10 分钟加最多 10% 抖动后才触发，过期总是先到，所以停靠几乎不会发生。即使调长 `approvalTimeoutMs`，30 分钟的 Turn deadline 也把单次停靠限制在约 20 分钟以内。

收益只在两种情况下出现：部署调长了 Turn deadline 与审批超时；或者空闲时长按父设计逐步缩短。第四阶段的主要价值是去掉通往"空闲时长为零"终态的最后一个常见阻塞，而不是在今天的默认值下省资源。是否为停靠单设一个更短的延迟，列为开放问题，由测量决定。

## 2. 目标与范围

目标：

- 满足资格的、等待审批或提问的 Turn，随 Session 一起挂起：Harness 不再持有该 Session，控制面不再持有该 Turn 的派发租约和事件流。
- 决定、取消、审批模式变更或到期时，任意池成员都能经已有的审批续跑 driver 接上原 Turn。原 Action、Prompt、批次与副作用身份保持不变，不重复询问，不重复执行。
- 停靠失败与 teardown 失败沿用第一阶段的闸门与有界恢复语义。无法证明可恢复的等待保持常驻。

第一增量的范围：只停靠冷恢复臂今天已经接受的等待。

- Session 没有 Hooks、没有 MCP（与 takeover 恢复臂相同），且不是 extension command-step 审批。
- 等待的 options 带 `continuationRef`，所在批次没有标记 `uncaptured`，批次中也没有 v1/v2 审批。
- Turn 由控制面派发，即其 `input.accepted` 不是 wake 来源（`isWakeOwnedInput` 为假）。monitor、channel、automation、loop 等 wake 输入触发的 Turn 保持常驻。
- 根 Session（没有 lineage）。子 Session 保持常驻。
- 除该 Turn 自身的输入外没有其他待处理输入，第一阶段的其余条件全部满足。

非目标：

- 扩展冷恢复本身，包括 Hooks、MCP、子 Session、wake 触发的 Turn 与团队计划审批。这些要先在 G3 一侧证明可恢复，再纳入停靠资格。
- 新的公开 API、Action 字段或审批语义。Web Shell 与公开 API 看到的仍是一个 `RUNNING` 的 Turn 和一个 `requested` 的 Action。
- 停靠期间释放 Turn 的 Runtime 成员资格（见 §5 决定 4）。

## 3. 总览

1. Turn 提交持久等待，进入进程内等待。空闲定时器照常计时。
2. 定时器到点后，Harness 按第一阶段流程升起闸门并检查资格：除了一个"可停靠的等待中 Turn"之外，没有其他活工作。
3. Harness **冻结**这个 Turn：撤销等待的定时器、轮询与注册，既不唤醒它，也不 abort 它。之后的 teardown 与第一阶段相同，只是 seal 额外写入一份停靠证书（Prompt ID、唤醒时间与审批修订），并在最后切断事件流。
4. 协调器看到流在终态前结束，读到与自己的 Turn 匹配的证书，就用一次 CAS 停靠 `ma_turn` 行：释放派发租约，把 `retry_after` 设为唤醒时间。
5. 决定、取消或审批模式变更在各自的事务里解除停靠；到期则由已有的派发扫描按 `retry_after` 触发。
6. 派发重新 attach：Harness 冷打开 Session，takeover 恢复臂重建 waiter，Turn 按决定、取消或过期继续执行；协调器从已消费的水位重放事件，直到终态。

## 4. 机制

### 4.1 停靠资格：与恢复臂共用一个谓词

只有当冷恢复会接受同一状态时，停靠才是安全的。因此把今天 takeover 恢复臂（`hosted-harness-session.ts:8385-8420`）的接受条件抽成一个函数，停靠与恢复都调用它，并用测试断言两者对同一 journal 状态给出相同答案。不另外复制一份"看起来一样"的条件。首个增量共用的是 journal 状态条件：审批 continuation 查找，以及两个审批恢复臂恢复时所依赖的原始 Prompt 文本。Session 形态条件（Hooks、MCP、lineage、wake 拥有的输入）仍然对照 takeover 臂的守卫编写；把它们并入共用函数需要重构 load 路径，留到后续处理。

在第一阶段谓词的基础上，Harness 只放宽以下各项：

| 第一阶段条件                                        | 第四阶段放宽                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `session.active !== undefined`                      | 允许，当且仅当它是唯一一个处于可停靠等待中的 Turn（见下）           |
| `unsettledInputs` 非空；`pendingSessionInputs` 非空 | 只豁免该 Turn 自己的 `turnId`                                       |
| `hasHostedCleanupDebt`                              | 只豁免描述符指向该 Turn `promptId` 的债务，由恢复后的 Turn 负责结算 |
| `session.streams.size > 0`                          | 允许；teardown 会切断这些流，它们唯一的读者是协调器（§4.5）         |

"可停靠的等待"由等待代码维护一个进程内标记：`commitDurableWait` 成功且 waiter 注册后置位，等待返回前清除。资格检查要求：

- 标记已置位，持久 Action 仍为 `requested`，且存在可恢复的 continuation（即上面的共享谓词成立）；
- 没有正在执行的 live poll 调用，也没有正在执行的 `resolveHostedAction`；
- 如果是交还过 mount 的提问等待，交还已经完成（`waitForHostedQuestion` 的重试链不在运行）；
- 带 live poll 的等待：在闸门下再读一次审批选择。若新模式会代用户放行，本次尝试回退，由正常路径放行；否则把读到的修订号写进证书（§4.4）；
- writer grant 同时声明了 `wakeDispatch` 与 `actionParking`（§9）：停靠证书挂在只有 wake dispatch 开启时才发送的 wake 戳上（§4.4）。

### 4.2 冻结，而不是展开

进程内 Turn 的调用栈从模型循环一直延伸到 `waiters.wait`。如果用 abort 展开它，等待之后的代码会把 Action 结算为 `cancelled` 或 `expired`、写取消终态并释放 Runtime。要让每一个 abort 消费者都区分"停靠"与"取消"，需要审查的范围太大。

冻结让调用栈停在 `await` 处，等待之后的代码永远不再运行：

- `HostedApprovalWaiters` 新增 `park(requestId)`：清除 `expiresAt` 定时器与轮询定时器，从 map 中移除 resolver，但**不**调用它，等待的 promise 保持 pending。
- 清除该 Turn 的 deadline 定时器；永不调用该 Turn 的 `abort`。
- 撤销该等待在实例级集合中的注册，例如提问等待登记在 `brokerOptions.mountHandbacks` 中的回调。冻结后不再有实例级结构引用这条调用链，Session 被移除后整条链随之被回收。
- 实现时须逐项审查等待调用链持有的定时器与回调，要求与第一阶段的定时器审查相同。

冻结后的状态，对 journal 而言与"进程在此处被 SIGKILL"完全相同，而这正是 G3 故障门禁已经证明可恢复的状态。冻结是挂起中第一个不可回退的步骤：此后不能再把这个 Turn 放回进程内服务，只能经冷恢复接上它。

### 4.3 对第一阶段挂起流程的增量

第一阶段的流程不变，只有三处变化：

1. 第 2 步（关闭 wake 调度器）之前先冻结停靠的 Turn。冻结之前的失败可回退：清除闸门，重新计时。
2. 第 4 步（释放 Runtime 租约并对账 hosted cleanup debt）不处理该 Turn 持有的 Runtime，它保持与常驻等待相同的状态（§5 决定 4）；对账时也跳过描述符指向该 Turn 的债务，因为它由恢复后的 Turn 结算。其余 owner、租约与债务照常处理。
3. 第 6 步的 seal 额外携带停靠证书（§4.4）。证书与 seal 一起得到确认，才计为一次干净停靠。之后切断事件流，移除 resident。

teardown 失败与结果未知，沿用第一阶段与[有界恢复补篇](2026-11-18-managed-suspension-bounded-recovery.zh-CN.md)：闸门保持关闭，被冻结的 Turn 不会复活，Session 恢复后经冷恢复接上它。

### 4.4 seal 证书

沿用 3a 的[seal 时 wake 戳](2026-11-19-managed-control-plane-wake-seal-stamp.zh-CN.md)：`/writers:seal` 的可选 `wake` 对象新增 `parkedTurn: {promptId, wakeAt, approvalRevision}`，只有带停靠 Turn 的挂起 teardown 才发送。今天的挂起 teardown 只在 `supportsWakeDispatch()` 为真时才发送 wake 对象（`hosted-harness-session.ts:5211`），停靠 CAS 也依赖它写下的 `wake_seal_revision`，因此第四阶段依赖 3a 已开启。`wakeAt` 取 Action 的 `expiresAt` 与 Turn deadline 中较早的一个，由 Harness 计算，因为这两个值都只存在于 Harness 的持久记录里。`approvalRevision` 是 §4.1 在闸门下读到的审批选择修订号；不带 live poll 的等待省略它，因为模式变更不会影响这类等待。

`ma_session_head` 新增三个可空列 `wake_seal_parked_prompt_id`、`wake_seal_parked_until` 与 `wake_seal_parked_approval_revision`。它们与 `wake_seal_revision` 在同一条 seal UPDATE 中写入，该语句受 writer token、generation 与 `journal_revision = revision` 围栏保护；任何递增 generation 的 writer 获取都会清空它们。按本模块规则直接修改 V1 基线，不新增迁移。

同一次 seal 的 `wake.pending` 不把该 Turn 的输入算作 wake 输入。由于 §4.1 要求没有其他待处理输入，它的值为 `false`。

为什么不从"干净的 wake 戳 + 有未结算 Turn"推断出停靠：这种推断依赖"挂起时绝不会留下其他未结算 Turn"这条隐含规则，以后的资格放宽（例如 3b 的后台证书）会悄悄破坏它。显式证书与 3b 的 `wake_seal_background` 是同一种做法。

### 4.5 控制面：停靠 Turn 行

`consumeStream` 遇到流在终态前结束时，先刷出已读的批次，再检查停靠证书；没有证书时，保持今天的 `transientFailure` 路径。

停靠是一次 CAS。按现有锁序先锁住 `ma_turn` 行，只有以下条件全部成立才写入：

- 本协调器仍持有派发租约，Turn 状态为 `RUNNING`（不是 `CANCELLING`）；
- head 的 `wake_seal_parked_prompt_id` 等于该 Turn 的 `prompt_id`，且 `wake_seal_revision` 非空，即证书仍是当前的；
- 证书带审批修订时，Session 当前的审批选择修订号（`approvalSelection()` 返回的 `revision`）与它相等；
- 该 Session 没有未完成的 `ACTION_RESPONSE` 操作；
- `ma_session_record` 中该 Prompt 的 Action 投影仍为 `requested`。

写入内容：`error_code = 'hosted_action_parked'`，`retry_after = wake_seal_parked_until`，`dispatch_owner` 与 `dispatch_lease_until` 置空；不计入重试预算，也不计入连续失败次数。这个标记是派发簿记，不是 Turn 错误：公开与 Web Shell 的 Turn 读取不返回它。CAS 失败时按今天的 `transientFailure` 处理。

`findDispatchable` 不用改：它本来就跳过 `retry_after` 未到的行，也不排除这个错误码，所以到期后已有的扫描（默认每秒一次）会重新派发。`claimTurn` 在认领停靠行时，于同一条 UPDATE 中清除该错误码，使这个标记只表示"无人持有、等待唤醒"，不会留在一个正在派发的 Turn 上。`runClaimed` 中按错误码分支的逻辑（`HARNESS_RECOVERY_BLOCKED`、`RUNTIME_RECOVERY_BLOCKED`、`WORKFLOW_RECOVERY_BLOCKED`）都只匹配各自的码，不受这个新码影响。`JdbcHostedCleanupDebtStore.OWED` 已经跳过带 `RUNNING` Turn 的 Session，所以停靠 Turn 欠下的清理不会触发 cleanup-only load。

Harness 事件流只由 `HarnessCoordinator` 读取（`stream` 与 `observeStream`）；公开 SSE 来自控制面自己的事件存储。因此 Harness 切断流不会影响其他消费者。

### 4.6 解除停靠

新增一个 store 方法，清除该 Session 所有 `hosted_action_parked` 行的 `error_code` 与 `retry_after`。它在以下事务里与各自的主写入一起执行，同样先锁住 Turn 行：

- `ACTION_RESPONSE` 准入（`JdbcManagedActionStore`）；
- Turn 取消准入：状态变为 `CANCELLING`，而 `findDispatchable` 对 `CANCELLING` 同样要求 `retry_after` 已到，所以必须清除；
- 审批模式变更（今天的入口是 `ManagedAgentService.changeWebShellSessionApproval`），因为模式切换可能让 live poll 代用户放行；
- 会取消该 Turn 的 lifecycle 操作，它们经取消准入完成。

提交后可以立即触发一次派发以降低延迟，但正确性只依赖扫描。

竞争由 Turn 行锁串行化。解除停靠先提交，停靠 CAS 就会看到未完成的 `ACTION_RESPONSE`、`CANCELLING` 状态或更新的审批修订号，从而失败；停靠先提交，随后的事务就会把它清除。审批模式变更不留下未完成的操作，所以证书必须携带审批修订号，否则模式变更若先于停靠 CAS 提交，CAS 仍会成功，代用户放行的效果会一直丢到过期。不存在"决定、取消或模式变更已提交，Turn 却一直停到到期"的窗口。

到期不需要解除停靠：`retry_after` 一到，扫描就照常派发。时钟偏差只影响重新加载的时机，不影响结果：恢复后的 driver 按 Harness 自己的时钟判断是否过期，提前到达时就常驻等待剩余的时间。

### 4.7 重新打开

派发进入 `runClaimed` 的恢复路径（Turn 已有 `submission_attempted` 与事件 epoch）：

- **决定。** 决定投递（`QwenHostedHarnessConnector.doResolveAction`）在缓存缺失时先加载 Session 再 resolve，同时协调器的派发做一次 drive load。两次加载按 #17521 的 attachment 规则收敛到同一个 resident。该加载必须走 takeover 恢复臂，而不是得到停靠 Session 的 409。对 Workspace Session，已有测试确认这一点（[覆盖面设计](2026-11-22-managed-action-parking-coverage.zh-CN.md) §4.7）；没有 Workspace 的 Session 从不停靠，因为它没有审批策略（该设计 §3）。恢复臂先注册 waiter 再读 Action，从而覆盖在注册前就已胜出的决定（G3 §4.2 第 3 步）。
- **取消。** 沿用 G3：恢复后的 Turn 看到 `cancel.requested`，关闭等待，按取消结算。
- **审批模式变更。** 恢复后的 driver 重建 live poll，按新模式代用户放行或继续等待。恢复臂今天是否重建 live poll 必须用测试确认；如果没有，这是第四阶段需要补上的。
- **到期或 deadline。** 恢复后的 driver 立即以 `expired` 结束 Action，或因 deadline 而 abort，然后写取消终态。

协调器从已消费的水位重放，停靠期间和恢复之后提交的事件都不会丢失。在混合兄弟审批中，下一个兄弟的新 Action 在恢复后的 Turn 里正常提交，之后可以再次停靠。

如果决定投递迟迟未到，恢复后的 Session 可能在一个空闲周期后再次挂起。此时停靠 CAS 因存在未完成的 `ACTION_RESPONSE` 而失败，协调器走普通重试，投递到达后收敛。这是有界的抖动，不是正确性问题，但需要测量其频率。

### 4.8 恢复视图与状态

停靠 Session 的 head 是 `SEALED` + `released`，但它有一个 `RUNNING` 的 Turn。[恢复视图补篇](2026-11-18-managed-suspension-recovery-view.zh-CN.md)的"干净挂起 → `ready`"分支本来就要求没有未结算 Turn，因此不会把它报成就绪。另一侧不需要新增分支：现有的活跃 Turn 分支排在 `recovery_evidence_unavailable` 与运维分支之前，无论停靠证书是否仍然有效，都报告"Turn 进行中"。之后的任何 writer 获取都会清除证书，而 Turn 行在重新派发前一直保持 `hosted_action_parked`，所以视图根本不应读取证书。公开 Session、Web Shell Session 与 Turn 读取都经过这个视图，需要用测试固定。

### 4.9 生命周期细化（第二轮评审）

第二轮评审用实跑探针核验了六个生命周期细节，现均由回归测试固定：

1. **resolution 互斥按重叠计数（§4.2）。** 冻结拒绝标记是按 Action 的计数，而非存在位：同一 Action 的两个重叠 resolution 在最后一个结束前始终拒绝停靠。
2. **cleanup 排除复核 journal 序号（§4.3）。** 债务快照取自某个已提交序号；若读取 descriptor 期间序号前进，检查保守地报告有债务，而不是基于过期快照放行挂起。
3. **staged wake 不是客户端矛盾（§4.4）。** 只有客户端自己声明的 `wake.pending()` 才拒绝停靠证书。Broker 在证书之后写入的 wake-worthy staged 行走既有 staged-wake 路径盖章，保留证书但让它立即到期。这两点都由[覆盖面设计](2026-11-22-managed-action-parking-coverage.zh-CN.md)的 S2 修改：首个增量还会拒绝 background 证书，其 staged-wake 路径会清空停靠字段。
4. **审批模式变更接纳全匹配的停靠证书（§4.6）。** 停靠 head 是 `SEALED`/`released`，忙碌准入本会在解除停靠之前拒绝变更。只有全匹配证书——seal revision、停靠 prompt、approval revision，且停靠 Turn 是 Session 唯一的活跃工作——获得窄豁免；任何不匹配保持拒绝。
5. **冷恢复的等待可以再次停靠（§4.7）。** 恢复臂安装与原始等待相同的停靠注册、freeze 覆盖与 finally 注销生命周期，保留原 Action 身份与过期时间；下一次 idle 第二次停靠，之后单次 Allow 仍只执行工具一次。
6. **digest-match 重放在同事务内解除停靠（§4.6）。** 两条失败投递修复路径（delivery-failed 与 decision-expired）在条件修复 UPDATE 后清除停靠标记，用户已作出的决定不再等到原唤醒期限。

## 5. 决定与理由

1. **复用 G3 冷恢复，而不是另写一套 park/resume 协议。** G3 已覆盖决定、取消、过期、丢回复与崩溃的各种组合，并有打包故障门禁。第四阶段只新增"有意放下"这一个入口。
2. **冻结，而不是 abort。** abort 的每个消费者都会结算点什么；冻结把状态限定为已被证明可恢复的"崩溃在等待点"。
3. **控制面停靠以 Harness 证书为前提。** 只有 Harness 知道一个等待能否恢复；控制面只做 CAS 和计时，不做推断。
4. **第一增量不交还 Turn 的 Runtime 成员资格。** 常驻等待今天就一直持有它，所以停靠不会比现状更差，恢复臂也已经按原 Runtime owner 接上。交还 mount 只在提问路径上实现过，且仅限单问题批次与 `local-process`；把它推广到审批会扩大冷恢复需要证明的范围。长时间停靠对 `LOCAL` 维护与 `EXTERNAL` 存储竞争的影响列为开放问题，由测量决定。
5. **唤醒时间放在证书里，计时放在 `ma_turn.retry_after`。** deadline 只存在于 journal 中；派发扫描本来就按 `retry_after` 工作，不需要新的调度器。不复用 `wake_retry_at`，因为它属于 wake 恢复扫描。
6. **有开关，默认关闭。** 与 3a、3b 相同：控制面在 writer grant 中声明 `actionParking`，Harness 只在声明存在时停靠。控制面只在 wake dispatch 也开启时才声明它，因为证书依赖 wake 戳。旧控制面会把被切断的流当作故障并重新加载，所以 Harness 不能单方面启用。

## 6. 与第一到第三阶段的交互

- **第一阶段。** 停靠就是一次带额外证书的挂起，使用同一个空闲定时器、闸门、teardown、重试上限与有界恢复。冷打开名额（`hosted_session_open_busy`）同样作用于停靠 Turn 的重新打开，协调器已经把它当作等待处理。
- **第二阶段。** 第一增量排除带 MCP 的 Session，与 MCP park 没有交集。冷恢复支持 MCP 之后，停靠 Turn 重新打开时可以借助 parked MCP 连接免去重连。
- **3a。** 第四阶段依赖 3a：wake dispatch 关闭时挂起不发送 wake 戳，也就没有停靠证书。停靠 seal 的 wake 戳为 `pending = false`，wake 恢复扫描不会因为停靠 Session 而加载它。带待处理 wake 输入的 Session 不停靠。
- **3b（#17953）。** 两者都在 seal 上写证书。一个 Session 同时有后台 hold 与停靠 Turn 时，第一增量不停靠，因为 §4.1 要求停靠 Turn 是唯一的活工作。合并两种证书留到 3b 合入之后。

## 7. 测量（启用门槛）

启用前需要记录：

- 停靠率与停靠时长的分布，按审批超时、Turn deadline 与空闲时长分组，用来验证 §1.4 的估算。
- 停靠 Turn 重新打开的成本：从决定到工具开始执行的延迟，拆分为派发扫描延迟、冷打开（journal 恢复）与恢复 driver 启动三段。
- 停靠期间节省的资源：Harness 内存、writer 与 activation 续约的 SQL，以及协调器的线程、连接与续约 SQL。
- 决定投递延迟引起的二次挂起与普通重试次数。
- 长时间停靠时，Turn 持有的 Runtime 成员资格给 `LOCAL` 维护与 `EXTERNAL` 竞争带来的等待。

## 8. 故障模式

- **冻结之前失败。** 可回退：清除闸门，重新计时，Turn 继续常驻等待。
- **冻结之后、seal 之前失败或崩溃。** 按第一阶段规则，闸门保持关闭，经有界恢复收敛。head 可能仍为 `ACTIVE` 且没有证书，协调器按普通故障重新 attach，冷恢复接上 Turn。
- **seal 成功，但协调器在 CAS 之前崩溃。** 派发租约过期后，扫描重新派发并冷打开 Session，Turn 恢复常驻等待，之后可以再次停靠。代价是多一次加载，不丢状态。
- **证书过期。** 任何 writer 获取都会清空证书，停靠 CAS 也会检查证书是否仍是当前的。
- **决定、取消或审批模式变更与停靠竞争。** 由 Turn 行锁与证书中的审批修订号串行化（§4.6）。
- **控制面在停靠期间重启，或有多个实例。** 停靠状态全部在 SQL 中；派发租约与 CAS 防止两个协调器同时持有一个 Turn。
- **恢复失败。** 冷恢复的类型化拒绝与阻塞保持不变（G3 §3），不会因为是停靠后的恢复就放宽。

## 9. 上线方式

- 控制面新增设置 `qwen.managed-agent.action-parking.enabled`（默认 `false`）。它要求 `qwen.managed-agent.wake-dispatch.enabled` 同时开启：两者都开启时，才在 writer grant 中声明 `actionParking`，机制与 `wakeDispatch`、`runtimeObservation` 相同；只开启前者时，启动即报出明确的配置错误，不静默忽略。
- 控制面改动（证书列、停靠 CAS、解除停靠、恢复视图）先于 Harness 改动合入，或与它在同一版本中发布。与其他 Managed Agent 改动一样，不支持新旧版本混跑。
- 关闭开关后，Harness 不再停靠；已停靠的 Turn 照常在到期或解除停靠时被重新派发。回滚不能丢弃证书，也不能把停靠的 Turn 当作失败处理。

## 10. 切片

1. **控制面。** 证书列与 seal 写入、停靠 CAS 与 `consumeStream` 分支、`claimTurn` 清除错误码、解除停靠、恢复视图、开关。在 Harness 发送证书之前完全惰性。
2. **Harness。** 共享的资格谓词、可停靠等待标记、`HostedApprovalWaiters.park` 与冻结、seal 证书、资格豁免。
3. **验收与测量。** 真实进程与 MySQL 8.4 用例、§7 的测量，并决定是否需要单独的停靠延迟。

## 11. 验证计划

- **共享谓词。** 对同一 journal 状态，停靠资格与 takeover 恢复臂给出相同答案；覆盖 Hooks、MCP、`uncaptured`、v1/v2 混合批次、wake 触发的 Turn、子 Session 与 plan mode 拒绝。
- **冻结。** 冻结之后没有任何 journal 写入、Broker 调用或定时器回调，等待之后的代码不运行，实例级注册已撤销；Session 移除后调用链可被回收（用弱引用或堆快照断言）。
- **teardown。** 在冻结前后、seal 前后注入失败，验证只有冻结之前可以回退，冻结后的 Turn 只能经冷恢复接上。
- **控制面 CAS。** 覆盖停靠与 `ACTION_RESPONSE` 准入、取消准入、审批模式变更（包括先于停靠 CAS 提交的情况）、证书过期、租约丢失的每一种交错；停靠不消耗重试预算；`CANCELLING` 的 Turn 不会被停靠；认领停靠行后错误码已清除，Turn 走普通恢复路径。
- **重新打开。** Allow、Deny、取消、模式切换后代为放行、过期、deadline；决定投递与协调器派发的双重加载能收敛；决定投递时的加载走 takeover 恢复臂；混合兄弟审批的第二次停靠；决定投递延迟引起的二次挂起最终收敛。
- **视图。** 停靠 Session 的公开、Web Shell 与恢复视图都报告"Turn 进行中，等待 Action"。
- **真实进程与 MySQL 8.4。** 停靠后杀掉 Harness，在另一代 Harness 上做决定；停靠期间重启控制面；Allow 路径上每个调用恰好执行一次、文件效果一次、终态一次；Turn 行锁下的竞争在 MySQL 上复现并通过。H2 的结果不能替代这些用例。

## 12. 验收标准

- 不满足资格的等待，行为与现在完全相同。
- 满足资格的等待，在一个空闲周期后被干净停靠：Session 移出 `attachedSessions` 并停止续约；`ma_turn` 行释放派发租约，`retry_after` 等于证书中的唤醒时间。
- 停靠后的决定、取消、模式变更与到期，各自经一次冷恢复完成原 Turn：Action、Prompt 与批次身份不变，不重复询问，Allow 恰好执行一次，Deny 零次。
- 完成的停靠从不消耗 Turn 的重试预算。因决定、取消或审批模式变更与之竞争而被 CAS 拒绝的停靠，退回为一次普通重试，Turn 下一次有 journal 进展时该计数即清零。任何已提交的决定、取消或审批模式变更都不会让 Turn 一直停到到期。
- 停靠 Session 的所有状态读取都如实报告进行中的 Turn。
- §11 要求的真实进程、MySQL 与故障用例在 CI 中通过，且 §7 的测量完成之后，才打开开关。

## 13. 开放问题

1. 是否为停靠单设一个更短的延迟。默认值下停靠几乎不发生（§1.4），而更短的延迟会把更多决定变成冷打开。由 §7 决定。
2. 长时间停靠期间，是否像提问等待那样交还 Turn 的 Runtime 成员资格。
3. 冷恢复扩展后再纳入的范围：Hooks、MCP、子 Session、wake 触发的 Turn、团队计划审批。除团队计划审批外，其余各项的方案见[覆盖面设计](2026-11-22-managed-action-parking-coverage.zh-CN.md)。
4. 与 3b 后台 hold 同时存在时，两种证书如何合并。方案见[覆盖面设计](2026-11-22-managed-action-parking-coverage.zh-CN.md)的 S2 切片。
5. 已离开池的成员上停靠 Session 的 placement 回收，与父设计的待解决问题 1 相同。
