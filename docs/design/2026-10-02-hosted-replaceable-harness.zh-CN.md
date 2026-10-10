# Hosted 可替换 Harness —— 取消 owner 粘性（G3）

[English](2026-10-02-hosted-replaceable-harness.md) | [简体中文](2026-10-02-hosted-replaceable-harness.zh-CN.md)

状态：Step 1 与 Step 2 已在本 PR 实现（D1-D9）；D10 的 Step 3 各行是
点名的后续。跟踪 issue：#12952（Stage G）。代码引用以 `main` @
`728c13de21` 为准，除非某个决策注明了更晚的修正。本设计按 issue 评论
中的提案回答了 #12952 的 Q2 与 Q3，并修正了该提案中一处机制描述
（见「现状」第 1 条）。

## 问题与范围

Stage G 已把权威 Session 历史外置，并证明了 writer fencing 与 takeover。
剩下的 G3：Hosted Session 不得钉死在第一个服务它的 Harness
进程代上。今天只重启 Hosted Harness 会让每个绑定的 Session 持续报
generation error，直到 Java 控制面也重启
（`managed-agent-server/README.md:185`）。G3 去掉这个粘性：活着的控制面
接纳下一代 Harness，Turn 继续跑。

范围（按 issue 已定）：

- **只做 Hosted。** 普通路径保留本地存储与 owner 粘性。
  `session_execution_engine_unavailable`（`acpAgent.ts:1120`）与
  「Managed 失败不回放到 Legacy」保持原样，由现有测试守护。
- **「任意 Harness」指同一个控制面能连到的任意一代 Harness
  进程，先后接手（Q3）。** connector 只有一个 Harness
  地址。两对 owner 同时在线、优雅交接、跨主机接管需要 lease
  交接与路由，目前没有任何已合入的实现；它们另开 tracker。
- **「正确引擎」指 capability digest 相同，且能读前任写下的
  journal。** digest 变了仍是终态。
- **Q2 是 G3 的交付物，不是前置：** 用一个现有 failover
  场景的冻结变体，以门禁形式证明*并发存活*的前 owner 被
  fence（D7）。

不在范围内：公开 Shell 的 opt-in（相对 G0 尾巴另行跟踪）、超出 D5/D6
所需的 Step 3 模型轮重发与 `await_action` 结算（下方点名的后续切片）、
以及任何多实例控制面工作。

## 现状

粘性所在（全部于 `728c13de21` 核实）：

1. **控制面钉死一代 Harness 进程。** `HostedHarnessClient`
   在构造时协商一次并保留那个 boot ID（`HostedHarnessClient.java:107`）。
   connector 只建一次 client（`QwenHostedHarnessConnector.java:395-410`）；
   `close()` 不置空字段，**没有任何代码路径重建它**。coordinator 把
   `HostedHarnessGenerationException` 当终态
   （`HarnessCoordinator.java:178-180`）；`bindHarness` 在 Turn 带
   `submission_attempted` 或事件 epoch 后拒绝换绑
   （`ManagedAgentStore.java:1240-1244`）。
   修正 issue 提案的措辞：代数不一致是从
   `X-Qwen-Harness-Boot-Id` **响应头**检测的
   （`HostedHarnessClient.validateGeneration`，1067-1086 行），或对缓存
   session ref 的本地检查（`requireSessionRef`，977-991 行），从来不靠
   解析 409 body。Java 在任何地方都不解析错误体 code；daemon 的 409
   （`hosted_session_already_attached`、`hosted_turn_recovery_required`）
   到达时是无法辨别 code 的 `DaemonHttpException`，并在准入后变成无限
   重试（`HarnessCoordinator.java:184-193`；一旦 `submissionAttempted`
   为真，预算检查被旁路，582-590 行）。connector 的 `create()` 甚至把
   _任何_ 409 吞成静默 load 兜底（301-305 行）。
2. **Session 行绑定一个 Harness boot ID。** 已提交或已准入的 Turn
   只能经恢复 CAS 换绑（`bindRecoveredHarness`，
   `ManagedAgentStore.java:1270-1281`）。没有任何方法清除
   `submission_attempted` 或单 Turn 的 epoch；只有会话生命周期完成时
   清除（CLOSE/ARCHIVE/DELETE，719-731 行）。
3. **journal writer lease 在有效期内独占**，持有者在半程续约
   （`http-managed-session-store.ts:889-902`；
   `ManagedSessionStore.java:197-210`）。继任者等它过期（默认 60 秒，
   `application.yml` 的 `session-store.writer-lease-duration`）或被
   seal。store 层面的 fencing 已被证明
   （`ManagedSessionStoreIntegrationTest.fencesWritersAndReplaysExactTransactions`）。

第 2、3 条是 G3 必须保留的 fencing。第 1 条是 G3 要去除的粘性。

已经可用的（G3 的机制大半已存在）：

- coordinator 已有接管 load 分支：带 `harness_boot_id` 的 Session 行经
  `recoverManagedRuntime` 附着，发出 #13083 的接管 load
  （`HarnessCoordinator.java:231-239`）。
- `bindRecoveredHarness` 正是接纳所需的比较并交换；
  `recordRecoveryAdmission` 重新键入 epoch。
- TS 接管 load 能结算 `await_runtime` / `results_ready`
  停靠并拒绝其余（`recoverHostedRuntimeTurn`，
  `hosted-runtime-recovery.ts:218`）。
- 事件流按 journal 序号读（`hosted-harness-session.ts:2240-2245`），
  保存的事件游标对任意一代都有效。
- 三个 failover E2E 模式证明了在运维刻意杀掉两棵进程树时的先后替换；
  2026-09-30 的设计记录了 G3 现在解决的三个 follow-up（丢回复的接管
  load、30 秒超时对 120 秒 load、`message.delta` 回滚）。

两个不同事件现在共用一个 code
`hosted_harness_generation_mismatch`（`HarnessCoordinator.java:178` 的
client 异常与 325 行的 DB 拒绝绑定）。只有第一个可以触发接纳；本设计
下文把它们分别称为「线上不一致」与「绑定拒绝」。

## 决策

### D1 —— 接纳集中在 connector，只发生在重试边界

任何 `HostedHarnessGenerationException` 到来时，connector 执行一次
接纳：monitor 只用于 client 交接，缓存清理在 monitor 之外做
（`computeIfAbsent` 的 bin 锁会跨一次在飞 load 持有，所以在 monitor
里动 map 会反转锁序）。**缓存的 Attachment 按 boot 身份淘汰——只留下
在当前服务的那一代下铸造的条目——每个 `pendingRecovery` 标记跟随它的
attachment。** 它们可按需重建，一个在其他线程完成重建之后被用出去的
过期 ref 不会对着自己空转重试，而并发重建已经在新代下铸造的条目会
保留。当异常携带的实际 boot ID 与当前 client 不同时，再关闭旧
client 并清空字段，下一次调用重建（重新协商即应用 digest 门禁，D2）。随后把异常重新抛出，让调用方走既有的重试机制。
流中途不接纳：`consumeStream` 把附着时的 boot ID 编进每条事件
source key（`HarnessCoordinator.java:398-401`），撕裂的流以异常结束，
Turn 在下一次派发时被接纳。`HostedHarnessClient` 在本切片里新增了：
只用于恢复 load 的超时（D9b）、journal 契约的 feature 检查（D9c）、
D5 解析用的错误体访问器，以及记在「边界与开放问题」里的无 boot 头
404 归类。

### D2 —— digest 门禁保持终态

重新协商得到的 capability digest 与配置不同，仍抛
`HostedHarnessCapabilityMismatchException`（code
`managed_capability_mismatch`），coordinator 仍让 Turn 终态失败。
「可替换」永不跨越引擎边界。

### D3 —— coordinator 不再因线上不一致失败

`HarnessCoordinator.coordinate()` 中对 `HostedHarnessGenerationException`
的 catch 从终态 `fail` 改为 `transientFailure`。下一次派发走既有的恢复
附着：`session.harnessBootId() != null` 选择 `recoverManagedRuntime`
（接管 load），用重建后的 client；成功后
`bindRecoveredHarness(expected = 旧 boot ID)` 把行 CAS 到新代。
`bindHarness` 拒绝与准入后的 Turn 仍只走恢复分支。「绑定拒绝」这条
路径形状不变，而且仍然会被走到——它正是 D4 的触发条件：一个已标记但
从未准入的 Turn 在拒绝时撤回标记并重绑；终态的
`hosted_harness_generation_mismatch` 保留给重绑也失败、或撤回 CAS
输掉的情形。有一处刻意的绕行：没有恢复可回绑时，plain attach 上的
`CANCELLING` Turn 直接在 bind **之前** 用 `harness.cancel` 终局——
bind 只为提交存在，一次取消绝不能以其指向的 Turn 尚未被取消为名被
打成 `hosted_harness_generation_mismatch`（它留下的 blocked 状态会把
后续的一切都楔死）。cancel 路由对「能中止什么」是诚实的（R10-3）：
进程内没有活体执行而 journal 仍持有未结算 Turn 时（owner 随旧代
消亡的停靠审批），它回答 409 `hosted_turn_recovery_required`；
coordinator 随之改采 attachment 的 epoch 并开流，而不是再发一次
必然空转的 cancel——重放把停靠的 Action 送到用户面前，其耐久落笔
由后续重派以 cancel 的形式结算。

### D4 —— 已标记但从未准入的 Turn 撤回提交标记

新 store 原语 `withdrawSubmissionAttempted`，仿
`bindRecoveredHarness` 的 CAS：owner + 派发 lease 有效 + 状态窗口
`IN ('ACCEPTED','RUNNING','CANCELLING')` +
`submission_attempted = TRUE AND harness_event_epoch IS NULL` → 置
`submission_attempted = FALSE`。不加列，不需要 Flyway 迁移。

位置：`runClaimed` 的 fresh 分支里，`bindHarness` 因 Session 行指着旧代
而拒绝、且该 Turn 没有 epoch（从未准入）时，coordinator 撤回标记，
然后对着接管 load 刚产出的 attachment 重试绑定。

安全条件，精确表述（这修正了提案「409 证明未准入」的简化说法）：撤回
安全是因为**重新提交在 journal 层幂等**。`submitInput` 以
`commandId = promptId` 提交（`hosted-harness-session.ts:1481-1491`），
所以旧代在回复丢失前确实发生过的准入，会在 Turn 于新代重新提交时按
完全同一事务重放（精确重放已由
`ManagedSessionStoreIntegrationTest.fencesWritersAndReplaysExactTransactions`
覆盖）。boot-ID 中间件在任何 Session 路由之前拒绝
（`hosted-harness-contract.ts:68-83`）是常见情形，不是不变量；journal
`commandId` 才是不变量。

该幂等的边界（R10-4）：只有已结算 Turn 的准入才有重放。仍未结算的
准入对重新提交回答编码化 409 `hosted_prompt_recovery_required`——
而 epoch 为 null 从来只证明准入**回复**丢了，不证明准入没发生。
因此撤回臂只重提交一次：遇到该编码拒绝时（且仅当本 Turn 的提交
标记已经立着——否则这个 code 指向的是**另一个** Turn 停靠的输入，
就必须保持为吃重试预算的 fail-closed 准入前失败），它把 attachment
的 epoch 通过 `recordRecoveryAdmission` 采纳进来、**保持已消费
水位不动**，然后开流。重放随之把停靠 Turn 送到用户面前（待决
Action 可耐久落笔，后续重派驱动它所解锁的继续），而不是像旧撤回臂
那样无限重复打标记。

保留水位这条规则同样适用于两个 plain-attach 的 epoch 迁移臂
（R10-3）：epoch 迁到新附着的代时，`harness_last_event_id`
**不**跟随跳到 attach 的 journal 尾部。旧代已提交但从未送达的一切
——包括该 Turn 自己的 `turn.settled`——仍须从已消费游标重放；
plain-attach 路径上再没有任何动作能产生终态事件，把游标推进到尾部
只会让 Turn 永远 RUNNING、其结算已提交却不可见。

### D5 —— 「接不了」类型化并终态；「稍后重试」保持可重试

TS：`recoverHostedRuntimeTurn` 对确定性拒绝状态返回可判别结果，不再
返回 `undefined`，每种都是 journal 的稳定函数——`await_action`
（存在 `requested` 状态的审批组）、`model_start`（还没有 checkpoint，
或 checkpoint 停在另一模型起始相位；也是 load 路由对无工具
Session 停靠 Turn 的回答——同一形状的纯取消 load 在**每条**臂上
都保持基线可重试 409，首次 load 与已附着重发一致，因为无工具路径
根本没有内核可问，铸出 plain attach 只会让 coordinator 的 cancel
空转楔死（R10-1））、`shell_in_flight`（一个 Shell 执行在
飞行中——仅由 drive 恢复 load 产出，因为 drive 无法重建；passive
load 会把同样的 journal 状态原地停靠）、`batch_not_durable`（批次停在
`await_runtime` 之前且参数不耐久）、`checkpoint_blocked`（checkpoint
已无法解析回可运行状态）、`unresolved_after_settle`（checkpoint 指向
另一个 Turn，或结算后仍不可运行）、`turn_settled`（journal 中已结算
但终态记录尚未投影——换绑续读归 Step 3；其间路由对两种 load 形态都
按普通 attach 作答：写了 turn_settled 的 Turn 已完成，绝不能被盖成
终态失败——普通 attach 被接纳后，daemon 自己的投影会补写终态记录）。

`checkpoint_blocked` 只对耐久判定触发（`opaque_state`、
`invalid_state`、`identity_mismatch`）。被 authorization 层抹平成
`missing_state` / `missing_checkpoint` 的瞬时 Managed Session Store
失败会作为瞬态重新抛出，永不 decline：这条边界刻意收窄，接管 load
期间的一次 store 抖动不能把 journal 完好的 Turn 终态掉。load 路由的
restore 守卫在接管分支之前做同一次判读，因为 restore bundle 会把两种
判定折叠成一个 `blocked` 位——耐久 reason 在那里对 drive 接管变成
类型化 decline，而裸 load 与一切纯取消 load 保持可重试的 409。plain
attach 绝不会让 journal 的未结算状态变成可写：无论接管回答了什么，
prompt 路由自身都会在**任一**输入未结算时拒绝新的 promptId
（`hosted_turn_recovery_required`——**会话级**楔死码：prompt 级
`hosted_prompt_recovery_required` 只指名所请 promptId 自身未结算的
重复，coordinator 靠它证明丢失回复的采纳；会话范围的拒绝绝不能铸出
那份证明（R11-1）），任何准入都不可能叠上停靠
Turn 的飞行中 checkpoint（R10-2）。

R11 随即收窄了 `inapplicable` 本身：只在 plain attach 真正付得起的
两处存活——被请求的审批（resolve 路由把决定耐久落笔）与
`turn_settled`（checkpoint 称已结算而 journal 从未落记录）。裸分支的
结算条件从未在 takeover 两条臂上运行过，所以两臂现在就地算同一份
投影：缺失的终态记录由本次 load 自己写入；投影也付不起时，则保留
基线可重试 409 而不是铸出外观健康的 attach（R11-2）。其余一切停靠
状态（`initial`、耐久 `blocked`、model-start 或未知相位、指向另一个
Turn 的 checkpoint）在取消侧一律改成抛入同一可重试 409——takeover
铸出的 attach 于是只剩有结算路由真正能付的。经 createOrLoad 的
passive 重附着与恢复 load 一样携带恢复快照，所以 connector 在那里
恢复 `pendingRecovery` 标记——否则一次按 boot 身份的接纳先驱逐旧
boot 条目、再在活 boot 下放入携快照的 attachment，而下一次派发的
缓存分支会对着它回答「没有停靠」（R11-3）。

残余的无工具取消楔死（Arm B）按同一结算原则关闭，只是这次喂它的是
**意图**而不是状态：没有 Runtime 工作的 Turn 在其 Harness 代死后
再也无法被驱动，所以它的取消终态只能是 journal 里的一条记录——而
只有**显式的取消**才有资格写它。`LoadHarnessSession` 因此增加布尔
`cancellationTakeover`（只由 `recoverManagedRuntime` 的取消臂设
置；普通 passive 重附着共享 passive 线型却绝不能代它铸任何记录）。
带旗信号时，load 自己把停靠写进 journal——经过一道把**工具配置**
与 **Turn 未付的 Runtime 工作**分开判读的分离面（无 checkpoint、
bootstrap checkpoint 指名为空、工具项全部结算并被消费、或 durable
审批记录已经结束的——无论用户选了哪一边的结束态，只有带旗信号才
结算）。不带旗信号时该臂保持基线：取消侧可重试 409、drive 侧类型化
`model_start` decline；有未付 Runtime 工作时，内核报告的
recovery-cancel 才是忠实的结算。这次写入之所以安全，正是同一次
load 自带的 writer fence：它证明生产代再也写不了一字（P1-1）。

审批的陈旧 checkpoint 副本在现实中更不是权威：恢复内核越过
`authority.action(requestId)` 读取 durable 记录。记录仍 requested
时，takeover 继续 inapplicable plain attach（resolve 路由付得起这次
等待）；记录已结束时，内核绝不把这份结束态塞回可恢复的
continuation——expired/cancelled 保持瞬态（路由的可重试 409），
而 decided 的等待只在 **drive** load 下经 durability-wait 自身的
闸门推进，取消侧 load 绝不越过它（P1-2）。

第九轮在真实栈上实测了这套分离，并收紧了其中两处读法（R9）：

- 「欠着未付的 Runtime 工作」只看工作本身，不看 checkpoint 写的是
  不是这一轮。checkpoint 写的是更早一轮、且那一轮的工具项全部
  settled 并被消费时，对一个从没走到工具调用的被取消轮次没有任何
  欠账——「第 1 轮已完成」正是这个形状。无工具 Session 按定义也
  不可能欠 Runtime 工作，所以它的取消臂无条件结算：若用
  授权状态去卡它（blocked 的恢复基座恰是有历史无工具 Session 的
  常态），第一轮之后每一轮取消都会重新卡死。
- plain cancel 的 coded 拒绝不是要重试的判决，而是要升级的信号：
  存活的 plain-attach 协调上 `harness.cancel` 回答 409
  `hosted_turn_recovery_required` 时，coordinator 就沿同一挂接
  发出取消接管 load（`recoverManagedCancellation`）。线上
  connector 的健康挂接捷径绝不能吞掉这次调用，否则 load 根本
  出不了进程；load 若报告一个恢复的 Runtime 驻留，就经其
  checkpoint 入场把它取消，纯结算的驻留不需要入场——两种情况
  都由协调已经在跑的那条流落定结算（R9-P1-2）。
- 取消旗标在每一种 load 形状下偿付同一语义（R9-2）：被强打到
  本 daemon 内已附着 Session 的接管 load，过去会落进 passive
  内核——内核在 passive 下永不推进 durable 等待，于是挂接之后才
  结束的审批驻留被当成未知相位抛回。挂接分支现在跑与首次 load
  相同的一套分离（旗标 + 无工具臂 + 欠账闸 + durable 交叉读），
  经 `settleCancelledHarnessTurn` 写入已在跑的那条流会读到的
  journal。第十轮真实栈复现——审批 requested 时先 plain attach、
  挂接后写入决定、再带取消旗 load——就是它的见证形状。
- 因审批等待驻留的取消终态，必须先合拢这道等待再落终态记录
  （R9-3）：record sink 只在 model-start 一族相位推进下一轮的
  checkpoint；只写 `turn_result` 会让 checkpoint 死在
  `await_action`，下一个 prompt 的 harness 以「不是 model-start
  相位」拒跑——旧轮收得干净，Session 却再也跑不起来。结算现在
  先经等待自身的 durable 闸门推进已结束的等待
  （`resolveDurableWait` → `model_output_committed`，属 model-start
  一族）；决定是用户本人的，没有东西续跑——Turn 之后立即死亡。
  只有已结束的记录能过这道闸，正是调用方闸门已经做过的那次
  交叉读。
- 取消结算的资格读与偿付读一样诚实（R9-5）：等待处的就地重读
  不允许降级成「无从判断等待状态」。调用方闸门与结算自身的等待
  检查之间冲出来的瞬时 store 故障，过去会被吞成 `undefined`、把
  终态写在它隐身掩护的开放等待上——Session 的下一个 prompt 随后
  就撞上它留下的陈旧 checkpoint，而这恰是第十一轮探针用一次真实
  transport 故障注入搭出来的形状。helper 现在把故障顺势抛给调用
  方的 try-catch：由基线可重试拒绝回答，store 自己的重试阶梯负责
  重试，故障过后同一形状照常结算。
- 同一类 store 故障也会被权威就地改写成判定（R9-5'）：
  TransportError 落成 `blocked/missing_state` 返回值、绝不抛出——
  所以「顺势抛出」仍会从它身边走过。故障形判定
  （`missing_state` / `opaque_state` / `invalid_state`）同样按不可证
  拒付处理；只有表示「无 checkpoint 本来就合法」的
  `missing_checkpoint` 保留偿付资格（Arm B 驻留的正确形态）。
- 升级本身需要步距（R9-4）：对一道还不能结算的等待按 ~500ms
  lease-续期节奏强制发出取消接管 load，买到的只是每秒约 4 次
  请求的 daemon 开销——coordinator 现在按 Turn 为该 load 定步距
  （最短 5 秒），间歇里由廉价 plain-cancel 重试扛着等待。取消
  结算写入前也先回读 journal 自己的终态：落在事件流归途窗口
  内的重发 load 是 re-answer，绝不是撞上 event-id CAS 的第二条
  `turn_result`（`turn:<id> is already committed`）。

抛出的错误保持瞬时，与今天完全一致。load 路由对 decline 回答新的
409 code `hosted_turn_recovery_declined` 并带 `reason` 字段；在接管
分支内部，`hosted_turn_recovery_required` 此后只为瞬态发出（路由上
更早的拒绝——restore bundle 非 ok、workspace 发布无法核实——早于
这套分类学，保持不变）。`hosted-tool-approval.ts:247` 的用法是瞬态，
不改。

Java：除一个调用点外保持 code 不可辨别。connector 的
`recoverManagedRuntime` 解析自己 load 响应的 409 body；遇到
`hosted_turn_recovery_declined` 时抛出带 reason 的类型化
`HostedHarnessRecoveryDeclinedException`，coordinator 以
`managed_runtime_recovery_blocked` 结束 Turn——已有 code 的新生产者，
也正是 #13054 要求的可观察范式。不引入全局 HTTP code 表。

### D6 —— 接管 load 幂等

回复丢失的 takeover load 叠重发到已附着的 session 上：路由当场重算
恢复，并从附着状态重新作答。没有任何东西会被消费——未确认的
continue/cancel 不破坏下一次重答：丢回复家族按构造闭合，不再需要
快照（也无需对称回滚）。重答重新验明正身：调用方必须报出附着时使
用的 tenant/workspace（该键就放在附着 session 自己的 sessionKey
上）——光有 harness token 不再能驱动陌生人的 session。回复正是丢失
的那一份的 continue/cancel 仍然处于未消费态：它重跑而非回放。判定
逐字复用：drive 叠重发遇上不可驱动 Turn 照旧 typed decline；无工具
或取消侧的叠重发则按 plain attach 作答（kernel 的 inapplicable 形
态）。2026-09-30 设计记录的丢回复 follow-up 就此关闭——包括
drive 回复丢失后落入取消那一格：重发时按取消形态重算，无需再放宽
什么回放。`opening.has(sessionId)` 的拒绝（一次接管正在进行中）不
变，仍可重试。

### D7 —— Q2 门禁：冻结变体（纯测试，除非测出缺陷）

`scripts/run-managed-agent-server-e2e.ts` 里 continuation
场景的一个支路：对原 Harness（journal writer）发 SIGSTOP、对原
Spring JVM 按 continuation 模式同款方式 SIGKILL（`crashProcess`），保留
Harness 的 home，等 lease 过期（现有 SQL 等待对冻结的 writer 照常
工作），让 replacement 把 Turn 续完，再对被冻结的 Harness 发
SIGCONT 并断言：

- 苏醒后**旧 writer 代数零新增事务**（直接数
  `qwen_managed_session_journal_tx` 的行；lease 续期只改
  `writer_lease_until`，heartbeat 路由什么都不写，所以 head 的
  revision 只随真实提交移动——fencing 的度量是 writer 身份，而不是
  head 的 revision）；
- 公开 transcript 仍然只有 replacement 的回答和一个终态事件；
- `managed_agent_session.harness_boot_id` 仍是 replacement 的。

Spring 为什么必须真死（本支路首轮 CI 暴露后修正的点）：回收
workspace 绑定时需要通过可信宿主身份从 `/proc` 存活取证，而
SIGSTOP 的 JVM 在那里仍然读作活着——所以只冻结 Spring 时 replacement
的 reconcile 会超时（`runtime_broker_reconcile_timeout`），Turn 永远
完不成。也就是说，资源级（Broker/worker）的「前 owner 还活着」
接管今天在结构上不可达；本支路因此在 journal writer 层面做
fencing 断言。这履行了退出检查的 journal 半边——被 fence 的前
writer 无法改动 journal——但不是 binding 半边：
`managed_agent_session` 只能由 Spring 写，而本支路的前任 Spring 按
构造必死，所以「无法改动更新的绑定」不由本门禁证明（见「边界与
开放问题」）。replacement Spring 继承原来的端口，因为被冻结
Harness 的 journal store URL 在 load 时已经固定：苏醒后它的 store
调用遇到的是活着的、会 fence 的控制面，而不是死 socket——否则
苏醒后的断言靠断连成立，而不是靠 fencing 成立。teardown 在停止子进程清单之前，
先按子进程注册表里的启动名唤醒被冻结的
Harness（注册键与唤醒查找共用同一个常量；查不到就直接让运行失败，
而不是留下卡死的 writer）。同一个 PR 把
`npm run test:e2e:managed-session-failover` 接进 `hosted-harness-mysql`
CI 任务——2026-09-26 的 fault-gates 设计曾明确把它放在 scope 外；本条
接入 CI 相当于撤销那笔旧决定，让它随门禁运行。

### D8 —— E2E：只重启 Harness 的支路

runner 加一个开关，叠在三个场景上：只杀 Harness（在现有 crash 块
1130-1135 行处 `crashChild(harness.child, …)`），在**同一端口**重启一个
全新 Harness（SIGKILL 后端口已释放；活着的 Spring 的
`HARNESS_BASE_URL` 在 JVM 启动时固定），保留原 Spring、Broker 与
`runtimeHome`，删除 `harnessHome`（journal 在远端；新进程必须证明它不
需要任何本地状态），并复用现有 lease 过期等待。重启后断言：空闲
Session 的下一个 Turn 完成，且在模型边界看到第一个 Turn 的 prompt 与
回答；`managed_agent_session.harness_boot_id` 在 **Spring 不重启**的
情况下移到新代；in-flight 与 continuation 支路保持现有断言。before
画面由同一支路在 `main` 上产出：必须以 README 记录的 generation
error 失败。README `:185` 那句随之删除。Spring 与其 Broker 都活着时
worker 不会成孤儿，不需要 W0e reclaim，所以代码里对 workspace-turns
场景解除了 Linux 门禁；杀两棵树的模式保留门禁。这些支路还钉住
它们之所以是「只重启 Harness」而非变相 kill-both 的本体事实：存活的
Spring、Broker 与耐久 Worker 持续服务同一个
`runtime_session_id`，活着的 Broker 在其已持有的代际上重派发（恰为
`'0'` 或 `'1'`——不再是只允许 `'1'`，也不接受无界值）。但运行这些
支路的所有 lane 都是 Linux（`hosted-harness-mysql` 仅 ubuntu），所以
darwin 是一个未被验证的预期，而不是等待首个不可能发生的运行来拍板
的门禁。

### D9 —— 生产默认值改到自洽（按 issue 的拍板项）

- **D9a，重试预算对 writer lease。** 已绑定 Session 的恢复附着路径
  上，一个 body 带 lease 自己的 code（`managed_session_writer_conflict`）
  的 409 豁免于准入前上限——该拒绝在受防 writer lease 失效时必然终结。
  豁免绑定在 lease 本身而非 code 家族：`hosted_turn_recovery_required`
  覆盖任意接管失败（含重试不可改变的 durable 拒绝），豁免它会把
  durable 拒绝卡进无上限重试（R6-1）。
  `hosted_prompt_recovery_required` 刻意缺席：它只可能在 submission
  标记设置之后到达，那时豁免门已无作用，列入它不可能改变任何结果。
  其余一律计入预算，其中也包括
  `hosted_session_already_attached`：它看着像瞬时冲突，实际是永久的——
  daemon 只在显式 detach 或 delete 时才丢弃 attachment，而本控制面从不
  detach，所以豁免它会让「Spring 重启而 Harness 存活」无限空转。这条
  保证只覆盖它约束的窗口：Harness 永久缺席时，准入前（submission 标记
  未设置）的 Turn 仍以 `hosted_harness_unavailable` 终结；而带有
  submission 标记的 Turn 无论 code 如何都沿自身路径重试——预算本来就
  不看这些 Turn（那是 `transientFailure` 的既有约定，不是豁免）。
- **D9b，请求超时对接管 load。** `HostedHarnessClient.loadSession`
  只在请求带恢复标志（`passiveManagedRuntimeRecovery` 或
  `driveRuntimeRecovery`）时使用独立的 `load-timeout`（默认 120 秒，
  与其他旋钮一样可用环境变量覆盖）；普通 attach load 保持
  `request-timeout`（30 秒），因为它们同时跑在 connector 的
  `ConcurrentHashMap` bin 锁之下。
- **D9c，journal 契约标记。** capability 协商要求一个命名 journal
  契约的 `features` token：`managed_session_journal_delta_v1`。
  老到读不了 `message.delta` journal 的 Harness 在（重新）协商时一次
  被拒——在 coordinator 的派发路径上落地为终态 Turn code
  `hosted_harness_protocol_error`——而不是让每个 Session 的
  open 都以 `managed_session_open_failed` 失败。

### D10 —— Step 3 保留为点名后续，去掉其中便宜的一行

D4 已经交付提案表格的第一行（尝试过提交但从未准入 → 撤回后重新
提交）。其余各行——带半截文本回撤的模型轮重发（`before_model`；机制
已由 `--continuation-failover` 证明，它回撤死 owner 已发布的前缀）、
`await_action` 按取消结算并释放 Runtime Session（
`managed-harness-factory.ts:541-547` 保证其安全；依赖前须核实 MCP
profile）、以及 `turn_settled` 的换绑续读——是架在 D5 类型化 decline
契约之上的后续切片。Shell 停靠保持带类型化结局的拒绝；真正的 Shell
接管归 Shell 工作项。G3 的功能范围是 Step 1+2（D1-D9），但 issue 不
因模型轮切片落地就关闭：「边界与开放问题」一节让 #12952 的 Q2 半边
保持开放，留待一个独立的多实例控制面 tracker 证明——关闭须两边同时
成立。

## 改动与属主

| 层                        | 文件                                                                                        | 改动                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Java qwencode             | `HostedHarnessClient.java`、`DaemonHttpException.java`                                      | 按请求 load 超时；错误体 code 访问器（无全局 code 表）                                                |
| Java managed-agent-server | `QwenHostedHarnessConnector.java`、新增 `HostedHarnessRecoveryDeclinedException.java`       | D1 接纳（client 重建 + 缓存失效），D5 在 `recoverManagedRuntime` 单点解析 409 code 并抛类型化异常     |
| Java managed-agent-server | `HarnessCoordinator.java`                                                                   | D3 catch 改动、D4 撤回的使用、D9a 豁免                                                                |
| Java managed-agent-server | `ManagedAgentStore.java`、`AgentStateStore.java`                                            | `withdrawSubmissionAttempted` CAS 及其 store 接口签名（D4）                                           |
| Java managed-agent-server | `ActionResponseCoordinator.java`                                                            | capability 不匹配的终态 catch：action outbox 记为带 code 的 FAILED（诚实终态，区别于生命周期 outbox） |
| Java managed-agent-server | `SessionLifecycleCoordinator.java`                                                          | 仅注释：capability 不匹配为何继续重试而不终结（生命周期 outbox 没有 FAILED 词表）                     |
| Java qwencode             | `LoadHarnessSession.java`                                                                   | `isRuntimeRecoveryLoad()` 标志访问器（D9b）                                                           |
| Java managed-agent-server | `ManagedAgentProperties.java`、`application.yml`                                            | `load-timeout`（D9b）                                                                                 |
| TS CLI                    | `hosted-harness-session.ts`                                                                 | decline code 映射（D5）、基于附着 Session 的重算重答幂等叠重发（D6）                                  |
| TS CLI                    | `hosted-runtime-recovery.ts`                                                                | 可判别的 decline 结果（D5），复用 core 的 `HARNESS_MODEL_START_PHASES`                                |
| TS CLI                    | `capabilities.ts`、`routes/capabilities.ts`、`qwen-serve-protocol.md`                       | `managed_session_journal_delta_v1` feature token（D9c）                                               |
| Java qwencode             | `HostedHarnessClient.java`（协商处）                                                        | 硬编码的 `managed_session_journal_delta_v1` feature 检查（D9c）——刻意不设配置旋钮                     |
| TS core                   | `managed-harness-checkpoint.ts`                                                             | 不改；D5 的命名复用 `HARNESS_MODEL_START_PHASES`                                                      |
| Runner + CI               | `scripts/run-managed-agent-server-e2e.ts`、`package.json`、`.github/workflows/sdk-java.yml` | D7 冻结支路、D8 只重启 Harness 支路、 `--session-failover` 步骤                                       |
| 文档                      | `managed-agent-server/README.md`                                                            | 删除 generation error 那句；记录接纳行为                                                              |
| 单元测试                  | 上述各文件的 collocated `*.test.*`                                                          | 按决策覆盖；见验证                                                                                    |

属主沿共享 bean 结构走：`HarnessCoordinator`、
`SessionLifecycleCoordinator`、`ActionResponseCoordinator` 与
`ManagedAgentService` 注入的是同一个 connector bean，D1 不需要逐调用方
改动；三个 coordinator 的重试机制完成剩余部分。`ManagedAgentService`
不同：它唯一的同步 Harness attach（rename）没有重试机制，所以调用
中途换代——以及同一 attach 顺带观测到的 capability digest 不匹配——
都会表现为客户端可见的 `hosted_harness_unavailable`（503）；重试的
客户端下一次尝试会落到已接纳（或已对齐）的新代上。

## 验证与验收

单元测试（collocated）：

- connector：并发不一致下过期 client 恰好被关闭一次，且竞态期间不会
  构建真实 client（replacement 是注入的）；boot 相同的不一致只淘汰在
  另一 boot 下铸造的条目，并保留活着的 client 的恢复标记；
  `recoverManagedRuntime` 把 `hosted_turn_recovery_declined` + reason
  映射为类型化异常，其余 409 保持 code 不可辨别。digest 门禁在它真正
  所在处被钉住——client 构造时的协商检查（`HostedHarnessClientTest`）；
  各 coordinator 针对它的终态 catch 没有测试，connector 也没有添加
  第三道门禁。
- coordinator：线上不一致排重试而非失败；已绑定 Session 的恢复附着在
  除 lease 形态 code 的 409 之外都计入准入前预算，未绑定 Session 的
  409 一律不豁免；decline → `managed_runtime_recovery_blocked`。
- store：coordinator 层钉住 拒绝→撤回→重绑→标记→提交 的顺序，第二次
  撤回输掉 CAS（CAS 本身的真 MySQL 守卫测试留作 store IT 家族的后续）。
- TS：除 `await_action` 外每种 decline reason 都有从 journal 状态产出的
  测试（`await_action` 夹具与路由级 202-replay 水印的测试钉同属
  Step 3 欠账）；瞬时 blocked 的 authorization（`missing_state`）抛出
  而非 decline，耐久判定（`opaque_state`）走终态；叠重发的接管 load
  从附着状态重新作答（200 + 重算报告，普通重复 load 依旧
  `hosted_session_already_attached`），丢回复的取消报告也无法再楔住
  下一次重答（没有任何东西被消费）。

E2E（runner 支路，全部对着打包后的栈）：

1. `main` 上的 baseline：D8 支路必须以本 PR 删掉那句之前 README 所
   记录的 generation error 失败，证明测试承重。
2. D8 只重启 Harness × 三个场景：空闲 Session 下一 Turn 的上下文、
   in-flight、continuation —— 现有断言成立，`harness_boot_id` 在
   Spring 不重启下移动。
3. D7 冻结支路：SIGCONT 后的断言如上。删掉任一断言该支路必须失败。
4. CI：`hosted-harness-mysql` 增加 D7 支路、D8 各支路与
   `--session-failover`，任务上限随之从 60 分钟放宽到 120 分钟，让
   步骤上限之和达到 104（12 + 8×10 + 12——workspace 产出门禁又占了一条 12 分钟步骤）加上不设上限的安装准备步骤
   保留余量。

D4 背后的丢回复竞态（旧代准入、202 回复被丢、Harness 重启后 Turn 必须
完成且其 `promptId` 的 `command_id` 在 journal 中恰好一次准入）需要在
Spring 与 Harness 之间挂一个丢 submit 回复的代理，runner 目前还没有这个
夹具。它是后续测试支路，不属于本切片；它要演练的兜底已由
`ManagedSessionStoreIntegrationTest` 的精确重放覆盖。

验收 = #12952 的 G3 退出检查：两个先后接手的 owner 代数服务同一个
Session 且不依赖运维选定粘性（D8 各支路）；被 fence 的前 owner 无法
改动其 journal（D7 支路——binding 半边已划入「边界与开放问题」）；
没有可运行引擎的 Session 仍 fail closed，且 Managed 失败仍不导致
Legacy 重放（既有测试不变）。

## 边界与开放问题

- 只支持先后接手的代数。两对 owner 同时在线、优雅交接、跨主机接管 →
  另开 tracker（多实例控制面）。
- Q2 退出检查的 binding 半边不被 D7 证明：
  `managed_agent_session.harness_boot_id` 只能经 Spring 移动，而 D7
  的前任 Spring 必须死（D7 里的 `/proc` 存活取证原因），所以目前
  没有任何门禁演练「仍存活的前控制面试图夺回旧绑定」。与多实例
  工作同一个后续 tracker；#12952 的 Q2 在这一半边保持开放。
- Harness 返回不带 boot-ID 响应头的 404 表示 bootstrap 委托应用还没
  有 runtime，`HostedHarnessClient` 因此把它归类为传输层（瞬态），
  而不是协议缺陷。于是 runtime 永久不起时，准入前的 Turn 耗完重试
  预算并以 `hosted_harness_unavailable` 终结；已准入的 Session 保持
  既有的传输重试语义。
- 被冻结前 owner 的 Broker 一侧：归 #12964 测试与 Broker fault
  gates，不在 D7。
- `#13054`：D5 的范式（类型化 decline → 类型化终态 Turn
  结局）正是其 bound-Turn Workspace 拒绝场景应复用的答案；本设计不
  改动 Workspace 拒绝处理本身。
- Step 3 的模型轮切片：G1 设计记录了*同一代*内首个流式 chunk 之后的
  重试保持终态（`cannot retract a published model attempt`）；回撤只在
  跨代存在。该切片不得弱化这一点。
- `await_action` 结算依赖 MCP profile 的审批接线；依赖
  `managed-harness-factory.ts:541` 之前先核实。
- darwin 上的只重启 Harness 支路：代码里已解除 Linux 门禁且预期不经
  W0e reclaim 即可通过，但运行它的所有 lane 都是 Linux，所以 darwin
  未经验证——作为留白记录于此，不做任何门禁。
- 映射时发现的 nit（不做 G3 工作）：runner 的 Linux 门禁文案说
  「死掉的 worker」，而 reclaim 实际退的是一个仍活着的孤儿 worker 的
  归属权。（另一条 nit——`sdk-java.yml` 里陈旧的步骤分解——已不适用：
  本 PR 重写了那段注释。）
