# Hosted 可替换 Harness —— 取消 owner 粘性（G3）

[English](2026-10-02-hosted-replaceable-harness.md) | [简体中文](2026-10-02-hosted-replaceable-harness.zh-CN.md)

状态：提案，未实现。跟踪 issue：#12952（Stage G）。代码引用以 `main` @
`728c13de21` 为准。本设计按 issue 评论中的提案回答了 #12952 的 Q2 与 Q3，
并修正了该提案中一处机制描述（见「现状」第 1 条）。

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

任何 `HostedHarnessGenerationException` 到来时，connector 执行一次同步
接纳：**丢弃全部缓存的 Attachment 与全部 `pendingRecovery` 条目**——
它们可按需重建，一个在其他线程完成重建之后被用出去的过期 ref 不得
对着自己空转重试。当异常携带的实际 boot ID 与当前 client 不同时，
再关闭旧 client 并清空字段，下一次调用重建（重新协商即应用
digest 门禁，D2）。随后把异常重新抛出，让调用方走既有的重试机制。
流中途不接纳：`consumeStream` 把附着时的 boot ID 编进每条事件
source key（`HarnessCoordinator.java:398-401`），撕裂的流以异常结束，
Turn 在下一次派发时被接纳。`HostedHarnessClient` 本身除按请求的 load
超时（D9b）外不改动。

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
`bindHarness` 拒绝与准入后的 Turn 仍只走恢复分支——「绑定拒绝」这条
路径形状不变，只是在接纳流程里不再被触发（D4 去掉了它的触发条件）。

### D4 —— 已标记但从未准入的 Turn 撤回提交标记

新 store 原语 `withdrawSubmissionAttempted`，仿
`bindRecoveredHarness` 的 CAS：owner + 派发 lease 有效 + ACTIVE 状态 +
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

### D5 —— 「接不了」类型化并终态；「稍后重试」保持可重试

TS：`recoverHostedRuntimeTurn` 对确定性拒绝状态返回可判别结果，不再
返回 `undefined`，每种都是 journal 的稳定函数——`await_action`
（存在 `requested` 状态的审批组）、`model_start`（还没有 checkpoint，
或 checkpoint 停在另一模型起始相位；也是 load 路由对无工具
Session 停靠 Turn 的回答）、`turn_settled`（journal 中已结算但终态
事件尚未投影）、`shell_in_flight`、`batch_not_durable`（批次停在
`await_runtime` 之前且参数不耐久）、`checkpoint_blocked`（checkpoint
已无法解析回可运行状态）、`unresolved_after_settle`（checkpoint 指向
另一个 Turn，或结算后仍不可运行）。抛出的错误保持瞬时，与今天完全
一致。load 路由对 decline 回答新的 409 code
`hosted_turn_recovery_declined` 并带 `reason` 字段；
`hosted_turn_recovery_required` 此后只为瞬态发出。
`hosted-tool-approval.ts:247` 的用法是瞬态，不改。

Java：除一个调用点外保持 code 不可辨别。connector 的
`recoverManagedRuntime` 解析自己 load 响应的 409 body；遇到
`hosted_turn_recovery_declined` 时抛出带 reason 的类型化
`HostedHarnessRecoveryDeclinedException`，coordinator 以
`managed_runtime_recovery_blocked` 结束 Turn——已有 code 的新生产者，
也正是 #13054 要求的可观察范式。不引入全局 HTTP code 表。

### D6 —— 接管 load 幂等

TS 把恢复报告保留在已附着的 session 上，直到该 prompt 的
continue/cancel 准入把它消费掉。满足以下全部条件的重复 load：(a) 指向已
附着 session，(b) 带 takeover 标志，(c) 恢复仍未完成——返回 200 与
同一份快照，而不是 409 `hosted_session_already_attached`。重复的普通
load 保持 409。这关闭了 2026-09-30 设计记录的丢回复 follow-up；
`opening.has(sessionId)` 的拒绝（一次接管正在进行中）不变，仍可重试。

### D7 —— Q2 门禁：冻结变体（纯测试，除非测出缺陷）

`scripts/run-managed-agent-server-e2e.ts` 里 continuation
场景的一个支路：对原 Spring 与 Harness 进程组发 SIGSTOP 而不是 SIGKILL
（runner 的 `signalProcessTree` 本来就接受任意信号，325-335 行），保留
两个 home（跳过两个 `rmSync`），等 lease 过期（现有 SQL 等待对冻结的
owner 照常工作），让 replacement 把 Turn 续完，再对原进程发 SIGCONT
并断言：

- journal head 显示接管后没有来自旧 writer 代数的新事务（writer
  代数、revision 与 committed sequence 都属于 replacement）；
- 公开 transcript 仍然只有 replacement 的回答和一个终态事件；
- `managed_agent_session.harness_boot_id` 仍是 replacement 的。

被冻结的前 owner 在 Broker 一侧的行为归 #12964 的测试与 Broker fault
gates，不在本支路。teardown 在 `stopChild` 前先 SIGCONT，避免挂起的
SIGTERM 每个子进程白等 10 秒。同一个 PR 把
`npm run test:e2e:managed-session-failover` 接进 `hosted-harness-mysql`
CI 任务——它目前是遗漏而非刻意缺席。

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
worker 不会成孤儿，不需要 W0e reclaim，所以本支路对 workspace-turns
场景去掉 Linux 门禁，由运行结果说明 darwin 是否通过；现有杀两棵树的
模式保留门禁。

### D9 —— 生产默认值改到自洽（按 issue 的拍板项）

- **D9a，重试预算对 writer lease。** 经恢复路径附着的 Turn
  （`session.harnessBootId() != null`）豁免于准入前重试上限：它在等
  另一代的 lease，这个等待本身以 writer lease 为上界。恢复路径的失败
  不再产出 `hosted_harness_unavailable`；Turn 保持排队。
- **D9b，请求超时对接管 load。** `HostedHarnessClient.loadSession`
  使用独立的 `load-timeout`（默认 120 秒，与其他旋钮一样可用环境变量
  覆盖）；通用 `request-timeout` 保持 30 秒。
- **D9c，journal 契约标记。** capability 协商要求一个命名 journal
  契约的 `features` token（如 `managed_session_journal_delta_v1`）。
  老到读不了 `message.delta` journal 的 Harness 在（重新）协商时一次
  被拒——在接纳路径上即 D2 的终态路径——而不是让每个 Session 的
  open 都以 `managed_session_open_failed` 失败。

### D10 —— Step 3 保留为点名后续，去掉其中便宜的一行

D4 已经交付提案表格的第一行（尝试过提交但从未准入 → 撤回后重新
提交）。其余各行——带半截文本回撤的模型轮重发（`before_model`；机制
已由 `--continuation-failover` 证明，它回撤死 owner 已发布的前缀）、
`await_action` 按取消结算并释放 Runtime Session（
`managed-harness-factory.ts:541-547` 保证其安全；依赖前须核实 MCP
profile）、以及 `turn_settled` 的换绑续读——是架在 D5 类型化 decline
契约之上的后续切片。Shell 停靠保持带类型化结局的拒绝；真正的 Shell
接管归 Shell 工作项。G3 的退出检查由 Step 1+2（D1-D9）满足；issue 在
模型轮切片落地时关闭。

## 改动与属主

| 层                        | 文件                                                                                        | 改动                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Java qwencode             | `HostedHarnessClient.java`、`DaemonHttpException.java`                                      | 按请求 load 超时；错误体 code 访问器（无全局 code 表）                                            |
| Java managed-agent-server | `QwenHostedHarnessConnector.java`、新增 `HostedHarnessRecoveryDeclinedException.java`       | D1 接纳（client 重建 + 缓存失效），D5 在 `recoverManagedRuntime` 单点解析 409 code 并抛类型化异常 |
| Java managed-agent-server | `HarnessCoordinator.java`                                                                   | D3 catch 改动、D4 撤回的使用、D9a 豁免                                                            |
| Java managed-agent-server | `ManagedAgentStore.java`                                                                    | `withdrawSubmissionAttempted` CAS（D4）                                                           |
| Java managed-agent-server | `ManagedAgentProperties.java`、`application.yml`                                            | `load-timeout`（D9b）、`features` 标记配置（D9c）                                                 |
| TS CLI                    | `hosted-harness-session.ts`                                                                 | decline code 映射（D5）、快照保留与幂等重复 load（D6）                                            |
| TS CLI                    | `hosted-runtime-recovery.ts`                                                                | 可判别的 decline 结果（D5）                                                                       |
| TS core                   | `managed-harness-checkpoint.ts`                                                             | 不改；D5 的命名复用 `HARNESS_MODEL_START_PHASES`                                                  |
| Runner + CI               | `scripts/run-managed-agent-server-e2e.ts`、`package.json`、`.github/workflows/sdk-java.yml` | D7 冻结支路、D8 只重启 Harness 支路、 `--session-failover` 步骤                                   |
| 文档                      | `managed-agent-server/README.md`                                                            | 删除 generation error 那句；记录接纳行为                                                          |
| 单元测试                  | 上述各文件的 collocated `*.test.*`                                                          | 按决策覆盖；见验证                                                                                |

属主沿共享 bean 结构走：`HarnessCoordinator`、
`SessionLifecycleCoordinator`、`ActionResponseCoordinator` 与
`ManagedAgentService` 注入的是同一个 connector bean，D1 不需要逐调用方
改动；各层的重试机制完成剩余部分。

## 验证与验收

单元测试（collocated）：

- connector：并发不一致下接纳只重建一次；boot 相同的不一致只丢过期
  条目；digest 不一致保持终态；`recoverManagedRuntime` 把
  `hosted_turn_recovery_declined` + reason 映射为类型化异常，其余 409
  保持 code 不可辨别。
- coordinator：线上不一致排重试而非失败；恢复附着失败豁免于准入前
  上限；decline → `managed_runtime_recovery_blocked`。
- store：`withdrawSubmissionAttempted` 只在守卫成立时成功（owner、
  lease 有效、无 epoch、已标记）；第二次撤回输掉 CAS。
- TS：五种 decline 各得其 reason；瞬时恢复失败仍回答
  `hosted_turn_recovery_required`；重复接管 load 在被消费前返回同一
  快照 200，普通重复 load 返回 409 `hosted_session_already_attached`。

E2E（runner 支路，全部对着打包后的栈）：

1. `main` 上的 baseline：D8 支路必须以 README（`:185`）记录的
   generation error 失败，证明测试承重。
2. D8 只重启 Harness × 三个场景：空闲 Session 下一 Turn 的上下文、
   in-flight、continuation —— 现有断言成立，`harness_boot_id` 在
   Spring 不重启下移动。
3. D7 冻结支路：SIGCONT 后的断言如上。删掉任一断言该支路必须失败。
4. CI：`hosted-harness-mysql` 增加 D7 支路、D8 各支路与
   `--session-failover`，任务上限随之从 60 分钟放宽到 90 分钟。

D4 背后的丢回复竞态（旧代准入、202 回复被丢、Harness 重启后 Turn 必须
完成且其 `promptId` 的 `command_id` 在 journal 中恰好一次准入）需要在
Spring 与 Harness 之间挂一个丢 submit 回复的代理，runner 目前还没有这个
夹具。它是后续测试支路，不属于本切片；它要演练的兜底已由
`ManagedSessionStoreIntegrationTest` 的精确重放覆盖。

验收 = #12952 的 G3 退出检查：两个先后接手的 owner 代数服务同一个
Session 且不依赖运维选定粘性（D8 各支路）；被 fence 的前 owner 无法
改动更新的绑定或其 journal（D7 支路）；没有可运行引擎的 Session 仍
fail closed，且 Managed 失败仍不导致 Legacy 重放（既有测试不变）。

## 边界与开放问题

- 只支持先后接手的代数。两对 owner 同时在线、优雅交接、跨主机接管 →
  另开 tracker（多实例控制面）。
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
- darwin 上的只重启 Harness 支路：预期不经 W0e reclaim 即可通过；首个
  绿色运行决定 Linux 门禁是否只对本支路解除。
- 映射时发现的 nit（不做 G3 工作）：`sdk-java.yml:273-274` 的步骤分解
  陈旧（写的是 `12+10+20`，实际 `12+10+10+10`）；runner 的 Linux 门禁
  文案说「死掉的 worker」，而 reclaim 实际退的是一个仍活着的孤儿
  worker 的归属权。
