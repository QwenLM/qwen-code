# Session relay 故障门禁（FG9）

[English](2026-10-15-session-relay-fault-gates.md) | [简体中文](2026-10-15-session-relay-fault-gates.zh-CN.md)

## 问题与范围

Issue #14164 是 #12380 F 阶段的 FG9 切片，从伞形 #14054 拆出：为 FG7
之后启用的两个承担 relay 的域补 FG6/FG7/FG8 形态的多进程故障门禁 ——
`session_message`（#13822，记录契约 #13786）与 `session_command`
（#13928 / #13955 / #13974）。它们的风险形态是新的：**没有 OS 进程，
但副作用会跨 Session 边界落进另一个参与者的持久 journal。** 一条重复的
成员消息是用户可见且无法撤回的；一份对从未被送达的收件人声称「已送达」
的回执，是记录之后无法更正的谎言。relay 的重放稳定规则（#13955）正是
一个故障门禁题目 —— 三个重放稳定步骤，各有一种失效形态，今天只有功能
测试在证明：

1. 一份已提交的入站回执逐字节地再次应答；
2. 在 command id 下每个已提交的 roster 位置的消息先被探测（`msgc_` =
   `sha256(lead \0 commandId \0 position)`），早先某次运行已送达的收件人
   被报为已送达，绝不二次发送；
3. 只有在此之后，新的准入门禁才适用（团队成员资格、发送方链上
   running 且未 stopping 的 head）。

本切片按 FG8 形态落地门禁：一个 in-JVM Spring 的 Java IT 类、一个为
driver 提供 JDBC ground truth 的 probe、一个持有打包 Harness 与故障注入
proxy 的 TypeScript fault driver、每用例一个「故障确实点火」的见证、每
字母一个具名变异检查。**不改任何生产代码。**

被钉住的语义及其承重金属行，在 `main` = `37f8e851c7`（2026-10-15
核实）：

- 成员的 `send_message` 走 `session_command`：成员自己的 journal 先落
  outbound 条目（`planned`），然后 Turn 才 park ——
  `acceptSessionCommand`
  （`packages/cli/src/serve/hosted-workspace-tool-turn.ts:5670-5730`，
  `commands.runCommand` 在 `:5723-5730`）；command id 为
  `sessionCommandId` = `sha256(senderSessionId \0 promptKey \0 callId)`
  （`packages/core/src/managed-runtime/managed-session-command-operations.ts:32-40`）。
  park 后的等待每 250 ms 轮询，`COMMAND_WAIT_MS` 从条目自身提交起算 2
  分钟，decision 4 的超时锁是持久的（`harnessCommandLocked` 跨重启重新
  武装）。
- Java relay `SessionMessageRelay.workCommand`
  （`packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/service/SessionMessageRelay.java:487-598`）
  把命令按 `planned → handover → execute → answered` 传递：lead 的
  Harness 运行 `execute` / `executeMemberMessage`
  （`packages/cli/src/serve/hosted-session-command-session.ts:556-930`），
  它先从已提交回执再答（`existingReply`，`:509-528`），再探测每个
  roster 位置的 `msgc_` 记录（`:753-768`），把每次发送经
  `sendToRunningMember` 铸到收件人 journal 上，`memberMessageId`
  （`packages/cli/src/serve/hosted-member-chain.ts:96-110`）以原
  `executionCallId` = commandId 为键（`:887-907`），然后像 board write
  一样提交它的入站回执（`commitInboundReceipt`，`:462-507`）。
- 同一发送方的命令严格有序通过（`olderOpenCommand`，
  `SessionMessageRelayStore.java:199+`）；发送方已把某命令结算为终态
  时，relay 只做分类、绝不二次执行 —— `SessionMessageRelay.java:535-542`
  的 decision 2。
- 发送循环的诚实文案：`committed` 位置报 `sent.` 且不重发
  （`hosted-session-command-session.ts:885-890`）；不可达位置点名原因
  （`notReachedText`，`:859-881`）；heading 统计 N 中已送达数
  （`:895-902`）；一个都没送达时回执以 refused 提交。
- mint-未-relay 窗口的取消（切片 2 在 `main` = `5af87595f3` 上重验）：
  park 等待的 abort 臂（`hosted-workspace-tool-turn.ts:5976-5984`）经
  `answerCommandByJournal`（`:6047-6117`）作答，它把 `planned` 条目结算
  为 `cancelled`、把 `accepting` 条目结算为 `unknown`，settle 输掉竞态时
  重读 journal（`settle` 的出发状态表，
  `hosted-session-command-session.ts:403-422`：`cancelled` 只从
  `planned` 出发）；relay 只发现 `planned`、`accepting`、`unknown` 条目
  （`HANDOVER_SQL`，`SessionMessageRelayStore.java:73-90`），已认领、而
  发送方已把它结算为终态的条目只做分类、不 execute（决策 2，
  `SessionMessageRelay.java:539-549`）。恢复侧给出同一答案
  （`sessionCommandJournalAnswer`，
  `packages/cli/src/serve/hosted-runtime-recovery.ts:1180-1225`）。
- SSE：公开流按 `Last-Event-ID` / `after` 续传
  （`PublicAgentController.java:198-218`，`parseSequence` `:291`），
  WebShell 流按 `afterSequence`（`WebShellAgentController.java:131-140`）；
  两者都经同一个 `streamEvents` 读取重放
  （`ManagedAgentService.java:1621-1624`），然后接 live hub 尾流。
- ground-truth 表：`ma_session_record`（journal：`domain`、
  `record_id` = `cmd_`/`msgc_`、`revision`、`delivery_state`、
  `record_resource_id`）与 `ma_delivery`（relay 台账：
  `transport_state`、`claim_generation`、`attempt_count`、
  `available_at`、`last_error`），均在
  `packages/managed-agent-server/src/main/resources/db/managed-schema/V1__managed_schema.sql:285-325`、
  `:943-981`。

## 现状

- `MANAGED_SESSION_ENABLED_DOMAINS` 带着启用注释持有两个被门禁的域：
  `session_message` ——「H4d-b: produced by send_message and the
  control plane's relay」—— 与 `session_command` ——「H4e-b3: produced
  by member board tools and the control plane's relay」
  （`packages/core/src/managed-runtime/managed-session-records.ts:141-146`）。
  `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS` 为
  `Object.freeze(['email'])`（`:265-267`），此处不假设存在第二个
  provider；`MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED` 为 `true`
  （`:241`），所以续接是一次被 relay 的 run 的合法形态。
- 今天存在的域级故障覆盖只有 channel（FG7）加 `monitor_run`/后台
  Shell（FG8）。五个 hosted 故障门禁套件中 `session_command` /
  `session_message` 的重放/扇出注入为零（#14054 的关键词核查，此处按
  `37f8e851c7` 复现）。
- 各字母要钉的重放稳定语义，今天只由功能测试证明：
  `packages/cli/src/serve/hosted-session-command-session.test.ts` ——
  回执再答（`:1002`）、回执冲突（`:1033`）、探测后再发送
  （`:1350`）、roster 变化后的再执行（`:1376`）、`*` 扇出（`:1100`）、
  reached/unreached 文案（`:1122-1191`）；
  `HostedTeamMemberCommandMySqlIT` 在 MySQL 上端到端覆盖 board command
  传递，包括一名 member park 后 Harness 死亡、新 worker 唤醒其等待的
  场景。
- FG9 复用的车道机关（全部由 FG8 #14120 交付）：in-JVM Spring + 打包
  Harness 夹具与 `target/fgN-cases/` 下的每用例证据、`-Dqwen.fgNa.case`
  按字母选择子、probe 提供 JDBC 的纪律、store 前置 lose-once/hold
  proxy（FG8f）、双表面 SSE `Observer`（FG8e）、用于存储故障的 FG7b
  SQL trigger DDL 形态、`hosted-relay-headers.test.ts` 的名单见证、
  `check-failsafe-reports.js hosted`，以及 `hosted-harness-mysql` 车道与
  `scripts/tests/hosted-process-ci.test.js` 中的预算钉。

## 范围决策

1. **只做 FG9；三个落地切片。** 兄弟轮次（#14163 上 FG8 的剩余切片、
   #14165 上 FG10）、折进 `HostedTeamLeadMySqlIT` /
   `HostedTeamMemberCommandMySqlIT` 的 `team_state` / `team_task` 存储
   故障用例、以及被刻意禁用的 `team_message`/`team_plan` 记录体，全部
   排除（由 #14054 跟踪）。切片按此顺序落地，各自独立 PR，FG8 形态：

   | 切片 | 字母           | 等待                                                                                                                     | 原因                                                                                                                                                              |
   | ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 1    | **FG9a, FG9f** | 无                                                                                                                       | 本轮欠的语义 —— 应答丢失下的探测后再发送与答案诚实 —— 没有在飞 PR 触碰。                                                                                          |
   | 2    | **FG9d, FG9e** | 无；排在第二只为控制切片体量                                                                                             | 取消与 SSE 断流字母复用切片 1 夹具，新增 H4e-b3 的 relay 闩锁、公开 API 前的第二个 proxy，以及 FG8e 观察者的 in-JVM 移植（见*夹具设计*）。                        |
   | 3    | **FG9b, FG9c** | **#13918**（InnoDB 锁守卫护卫）与 **#13986**（重启证明 held-Runtime drain）—— 之后均已合入（`53a24a5ddf`、`c24e99e9cb`） | FG9b 的 marker 断言 #13918 正在重写的存储故障错误码分类；FG9c 的 member/lead 重启臂钉住 held-Runtime 回填（#13986）正在重塑的冷载恢复。与 FG8 切片 3 同批等待者。 |

   下面的门禁总账写全六个字母，使整轮可作为一份设计评审；每个切片的 PR
   实现其字母并在 tracker 上标记已交付。每个字母的注入点与断言在其切片
   落地时按已合入的前置重验。

2. **一个 IT 类；不杀 Spring；按字母选择子。** 六个字母全部放在
   `HostedSessionRelayFaultGatesIT`，in-JVM Spring，
   `-Dqwen.fg9a.case` … `-Dqwen.fg9f.case`，共享
   `HostedSessionRelayProbe`，证据在 `target/fg9-cases/<letter>/<case>/`
   按方法重建。FG9c 只杀打包 Harness —— 绝不杀 Spring 控制面 —— 其
   POSIX 信号把它限制在 Linux/macOS，与 FG6c/FG7c/FG8c 相同。

3. **按类私有拷贝，由 #14147 日后统一清扫。** 车道的刻意惯例（FG6e、
   FG7 各驱动、FG8 #14120）是 observer/proxy/authentication helper 按类
   私有拷贝；#14147（`status/blocked`）承担把所有门禁类一起迁移的一
   PR 清扫。FG9 跟随该惯例 —— 新增的私有拷贝一并进清扫名单 —— 因为
   #14147 自己的备注认为半吊子抽取比拷贝更糟，且清扫刻意等到没有新拷
   贝在写时再做。#14164 正文中「排在 #14147 之后」的注记在此记录为被
   此顺序覆盖，与 #14120 当时拍板相同。

4. **#14062 / #14063 作为夹具约束钉住，不得回归。** #14062
   （`encodeToolInput` 溢出是抛出而非拒绝）：所有脚本化 relay 消息保持
   在 `maxBytes` 之内，无任何臂触发溢出抛异常路径。#14063（在*后续*
   Turn 重发会铸出新 command id 而重复）：FG9f 各臂只重驱*同一*
   command id（同 prompt key、同 call id，跨故障与重启）；绝不编排
   「新 command id 重复」形态，且无断言与那里的现状行为冲突。两个 bug
   在此都不修，也都不被掩盖。#14063 之后已随 #14296（`9280ef9845`）关闭，
   该 PR 修正了 member-message 超时提示；FG9d 逐字断言修正后的答案文案，
   「新 command id」形态仍不编排。#14062 仍为 OPEN。

5. **#13339 纪律。** 车道没有隔离或重试机制。FG9 因此：(a) 只新增
   `Hosted*IT` 类，绝不动 `HostedWorkspaceToolTurnIT`；(b) 每个用例都先
   断言其故障确实点火（丢弃计数、`fg9b_fire` 计数、被扣住的 kill 点、断流的
   未读证明、超过续传游标的 JDBC 已提交行），门禁绝不无声变绿；(c) 所有
   JDBC 变更（种子、trigger）限定在用例 tenant；(d) 保留 FG8 的夹具教训
   —— watch 的 idle 窗口必须长于 60 s 事件 poll，且被断言停止方式的
   producer 绝不自行退出。

6. **可关闭性写进 tracker。** 一切片一 PR；#14164 随切片 3 关闭。这正是
   triage 线程要求的声明（#12872 的 tracker 活得比它的交付还久）；每个
   切片 PR 在 #14164 评论中记录其字母的交付。

## 门禁总账

Ground truth 是 JDBC：`ma_session_record` 的 journal 行
（`session_command` 与 `session_message` 两个域）、`ma_delivery` 的
relay 台账、FG9e 的公开事件台账，以及捕获的 Spring 与 Harness 日志。
每个用例都断言其故障确实点火：`FG9_DROPPED <what>` / `FG9_HELD <what>`
proxy 计数与 commit 日志（FG9a、FG9d、FG9f）、trigger 自身在
`fg9b_fire` 里的点火计数（FG9b）、kill 所落的那次被扣住的提交
（FG9c）、或续传游标的 JDBC 见证（FG9e）。「一行」始终指 journal 恰好
持有一条该 id、预期 revision 的记录；发送方视图与已提交回执逐字节比对
（`sessionCommandReplyBytes`，
`managed-session-command-operations.ts:205-208`）。

共享夹具（所有字母）：脚本化模型驱的 lead 创建一个 team 并在打包
Harness 上启动三名成员 —— alice、bob、carol；alice 的脚本化
`send_message` 调用就是 relay 流量。具名发送给 bob；`*` 广播扇出到 bob
与 carol（alice 永远不是自己的收件人，
`hosted-session-command-session.ts:815-855`）。

### FG9a —— 应答丢失（切片 1）

一个 lose-once **store proxy** 挡在 Session-Store base URL 前；
Harness 的连接保持直连 —— 落地时拍板的 axis 直连决定（见*夹具设计*）。
proxy 是 in-JVM 夹具，默认透传，按用例以提交形状在
`/transactions:commit[-v2]` 端点上武装 —— journal 事务的 operation
名（`sendSessionCommand` / `commitSessionCommandReceipt` /
`sendSessionMessage`）；原本挂在 Harness 边界的 drop 点已删除，因为
探针证明经 proxy 的 warm/createOrLoad 链只会换来 resident-vs-attach
冲突，而切片 1 没有任何用例需要 Harness 侧的注入点。
应答丢失＝把请求转发、消费掉上游已提交的响应、再毁掉应答；客户端的
有限不确定错误重试按原事务身份重驱。每次重试都通过原 command id 与
roster 位置解决。

| 用例                     | 注入                                                                     | 期望                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admission-commit-reply` | 在 alice 的 outbound `session_command` 提交（`planned`）落库后毁掉其应答 | 该 command id 恰好一行 `session_command`（绝不二次铸造）、一行 `ma_delivery`；relay handover，扇出完成，答案返回；成员 Turn 恰好结算一次                                           |
| `receipt-commit-reply`   | 在 lead 的入站回执提交落库后毁掉其应答                                   | lead journal 上恰好一份回执、revision 1；relay 抄回的 `answered` 副本与回执 `replyRef` 字节逐字节相同；成员 consumed 的答案等于已提交 reply，绝不是转述                            |
| `fanout-step-reply`      | `*` 广播中，在某一 roster 位置的 `msgc_` 铸造提交落库后毁掉其应答        | 每个位置恰好一行 `msgc_`（无二次铸造）；两名收件人各恰好投递一次（各自 journal 上一次 `accepted` + 一次 `consumed`）；回执点名每个位置的结果；发送循环的 `sent` 计数与已提交行一致 |

第四个草稿用例 `execute-reply-lost`（挂在 Harness 边界的 `execute`
响应 drop）已在落地时移除：它是唯一需要 Harness 侧 proxy 的用例，而
axis 探针把经 proxy 的 warm/createOrLoad 链的 resident-vs-attach 冲突
钉死了；它要的 durable identity 断言已由三个 store 边界用例覆盖 ——
每一次丢答都落在必须按原事务身份重驱的提交上（admission mint 应答、
回执提交应答、扇出 mint 应答）。步骤 2（探测后再发送）留给切片 3 的
真实 kill（`lead-kill-mid-fanout`）演练，因为仅靠应答操纵无法把一条
命令搁浅在「已铸造未回执」态 —— relay 重试总是先撞上步骤 1；切片
记录这条机制注记，而不是摆一场假戏。

### FG9f —— 部分广播（切片 1）

`*` 扇出是这个能力里唯一一处「一条命令产生 N 个跨 Session 效果」的地方，
所以它也是唯一一处「每收件人最多一次」可能被违反、而每一个单独步骤看
起来仍然正确的地方。以下用例按 issue 点名的三种方式让扇出的答案变得
含糊，全部在切片 1 夹具上。

| 用例                 | 注入                                                                                                                                            | 期望                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `partial-timeout`    | 扣住第二个 `sendSessionMessage` 提交（carol 的 `msgc_` 铸造提交），直到 relay 该次尝试失败，见证重试痕迹（`attempt_count` ≥ 1）后放行           | 早一次尝试中已铸造的位置报 `sent.` 且不二次发送 —— 每位置恰好一行 `msgc_`；被扣位置在重跑中发送且投递一次；发送方结算的答案逐字节等于已提交回执；attempt 计数与 `holding carol-mint` 代理见证共同证明回落形状                            |
| `roster-changed`     | 一名收件人的 member run 在 execute 尝试与 relay 投递之间结束（脚本化 DONE 的 carol），活位 bob 保持 attached                                    | 恰好一行 `msgc_`（bob 的；carol 在任何铸造之前就被准入拒绝）；回执为 `1 of 2`：`- bob: sent.` 与 `- carol: not reached: it has finished; the leader may give it more work, a peer cannot.`，绝不静默跳过；发送方视图与已提交回执逐条对应 |
| `recipient-stopping` | 一名收件人在 attached run 上被 `stopRequested`（carol 以 WAIT 闩停驻；脚本化 `request_shutdown` 由 `stophit` 闩把守到她的首次模型接触）后再发送 | 恰好一行 `msgc_`（bob 的）；头节点 stopping 的位置应答 `- carol: not reached: it is being stopped.`，绝不静默跳过；被停的 run 零伪造投递；重跑不重铸                                                                                     |

`roster-changed` 与 `recipient-stopping` 钉住过期 roster 与 stopping
头下*答案文案*的诚实 —— 这是「未送达却报已送达」和「把位置从报告里静默
丢掉」两类 bug 的所在。

### FG9d —— 取消（切片 2，已交付）

取消是对 alice 自己的 Session 发公开 `agent.session.cancel`：先以
`CANCELLING` 持久受理并写一条 `turn.cancel.requested`，再由 coordinator
送到 Harness，后者中止她 park 的等待；等待的 journal 作答
（`answerCommandByJournal`）决定这次调用被告知什么、条目变成什么。用例钉住
这个作答可能出错的两个窗口：relay 首次认领之前（用 H4e-b3 的 relay 闩锁
扣住），以及 handover 提交在途时。

| 用例                     | 注入                                                                                                                                                          | 期望                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cancel-after-mint`      | alice 发送前扣住 relay；她的命令提交 `planned` 后取消她的 Turn                                                                                                | 发送从未离开：条目在 revision 2 结算 `cancelled`、无 reply；alice 的调用恰好应答一次，为「未发送」文案；lead 上无回执、无 `msgc_`，bob 的 journal 上什么都没有；Turn 以 `CANCELLED` 结束，恰好一条 `turn.cancel.requested`、一条 `turn.cancelled`；relay 从未认领这条命令 —— 用例其余投递全部落账后，它的台账行为零，因为 relay 的发现只读 `planned`、`accepting`、`unknown` 条目                                                                                                                                                                                                                                                                |
| `cancel-reply-lost`      | 同一窗口，只是 cancel POST 经公开 API 前的第二个 lose-once proxy 发出，proxy 在取消提交后毁掉应答；客户端以同一 `Idempotency-Key` 直连重发同一取消            | 重发应答 `202`、`replayed: true`、同一 Turn；该 key 恰好一条请求回执；恰好一条 `turn.cancel.requested`、一条 `turn.cancelled` —— 无重复取消；以及 `cancel-after-mint` 的全部期望                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cancel-during-handover` | 在 store proxy 扣住 relay 的 handover 提交（`commitSessionCommand`，alice journal 上的 revision 2）的应答；取消她的 Turn；在持久的 `CANCELLING` 之后 2 s 放行 | Harness 只在被扣的提交之后才应答取消（其 cancel 路由的耗时覆盖了扣留期），所以 abort 读到的是已 handover 的条目、无法再撤回 —— 绝不同时出现「未发送」与投递：条目绝不读到 `cancelled`，而是走 planned → accepting → unknown（取消的 settle）→ accepted（回执抄回），revision 4；alice 的调用恰好应答一次，为「已到达 leader」文案；恰好一份 revision 1 的回执，alice 逐字节持有其 reply。relay 的 execute 与 alice 的 run 在取消后的结算竞跑，回执说明走了哪条臂：answered `Message sent to bob.`、一行 `msgc_` 且恰好投递并消费一次，或 refused `Your run has ended or is being stopped; …`、零 `msgc_` —— 两者都诚实，门禁按回执所指的那条断言 |

落地时记下的机制注记：

- 在 relay 首次认领之前就被撤回的命令根本不进台账：切片 1 草稿里「relay
  把台账行分类为 `done`」只对 relay 已认领的命令成立（决策 2），而这个
  窗口里任何应答操纵都造不出那种形态。门禁断言零行形态，并在用例其余投递
  全部落账之后才读。
- Harness 把取消排在该 Session 在途的 store 提交之后：它的 cancel 路由
  直到被扣的 handover 应答放行才返回（各次落地运行为 2.3–3.3 s，都覆盖了
  用例在取消之后继续扣住应答的那一拍）。所以 handover 提交在途时，abort
  总是读到已 handover 的条目，其 journal 作答结算为 `unknown`；门禁用
  Harness 自己的请求日志见证这段重叠（cancel 路由的 `durationMs` ≥
  1.5 s）。反方向的窗口 —— 取消的 settle 在途时 relay 到来 —— 在 store 边界
  上造不出来：settle 的提交先于其应答被扣而落库，relay 又按已提交状态决定
  （它只发现 `planned`、`accepting`、`unknown` 条目，并在认领后立即重读记录），
  所以在途的 settle 就是 `cancel-after-mint` 的零认领形态。

### FG9e —— SSE 断流（切片 2，已交付）

用两个用例取代草稿的四个：每个用例在一个表面上从两端观察同一次 `*`
广播 —— 发送方（alice）与一名收件人（bob）—— 因为两端搭的是同一个 relay、
同一次团队引导，而 fork 预算（#14148）为每次团队引导付费。公开流与
WebShell 流由 in-JVM Spring 提供；注入就是客户端自己的断开（其
HttpClient 的 `shutdownNow`）与续传，所以本字母不需要 proxy。每条流只在
客户端已持有全部已提交事件后才切断，只在 JDBC 证明游标之后已有事件提交后才
续传，客户端的完整视图（切断前的帧加续传后的帧）必须是从 1 起无缺口、无
重复的一条序列，逐帧等于该表面所提供的已提交行。

| 用例              | 注入                                                                                                                                                                                                                       | 期望                                                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-resume`   | 扣住 relay；打开 alice 与 bob 的公开流；alice 的命令 `planned` 后切断她的流，再放行 relay，使整个 relay 在她断线期间运行；两个 `msgc_` 都铸出后、bob 的投递之前切断他的流；等全部投递落账；两条流都按 `Last-Event-ID` 续传 | alice 切断时尚无任何 relay（无 `msgc_`），bob 切断时他的 journal 上什么都没有；两个 Session 都在断线期间提交了游标之后的事件；两份续传视图都连续且恰为台账（snake_case、秒级 `created_at`）；alice 的 Turn 终态一次、她 relay 之后的回答一次；bob 的启动 Turn 终态一次 |
| `webshell-resume` | 同上，走 WebShell 流，按 `afterSequence` 续传                                                                                                                                                                              | 对 WebShell 信封做同样断言（camelCase、毫秒级 `createdAt`）                                                                                                                                                                                                            |

落地时记下的机制注记：

- 读取 relay 消息的那个 Turn 是 Harness 自己的唤醒 Turn，不投影到公开台账，
  所以收件人的流里没有消息本身的投影：bob 的尾流是他的闩锁放开后启动 Turn
  的结束，而他的投递与消费（JDBC）在切断期间落地。草稿里「收件人的消费事件
  恰好出现一次」无事件可数；收件人这一端改为钉住：一条跨过其投递而被切断的流
  续传后无缺口、无重复，逐帧等于它的台账。发送方一端才是依赖 relay
  的那端：她的 Turn 尾部只在 relay 应答之后才提交。
- 过期游标 `resync_required` 臂（开放问题 3）不武装：resync 应答属于
  Session 流的重放地板，与事件由哪个能力产生无关，FG8 的跟踪 issue
  （#14163）拥有那唯一的用例（`cursor-expired-resync`）—— 它的设计把该用例
  延后，其切片 2（#14334）尚未交付。

### FG9b —— 存储故障（切片 3，已交付）

故障源是 `ma_session_record` 上的测试专用 trigger，限定用例 tenant、一个
Session 和一种记录形态，在用例拆掉它之前拒绝每一次匹配的写入 —— 即 FG8b
的形态。每次点火还会记进一张 MyISAM 旁表：Spring 把 `SIGNAL` 压成一个
500 `internal_error`，`FG9B_<CASE>` 文本出不了它自己的日志。草稿里的一次性
trigger 根本到不了 Session：store 客户端对不确定错误的有界重试（三次，间隔
250 ms）会在提交调用内部把它治愈。第三次被拒之后，该 Session 的 authority
锁存写入（`writesStopped` —— 被拒事务的序号可能已落盘），而锁存的 writer
不接受任何重试：拆掉 trigger 什么也治不好。所以每个用例都会拆掉 trigger
并冷启动 Harness，钉住的是冷加载的治愈 —— 经由原命令完成，绝不出现第二个
条目、第二次铸造或第二份回执。每次布防前 lead 自己的 Turn 都已结束，bob 与
carol 在整个窗口内都停在模型闩锁上（见「夹具设计」）。

| 用例                      | 注入                                                            | 期望                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbound-commit-refused` | 拒绝 alice 出站 `session_command`（`planned`）的插入            | 锁存期间：trigger 恰好点火三次；Harness 日志记下她的 Turn `recovery blocked: ManagedSessionWritesStoppedError`；没有条目、没有台账行、没有应答，Turn 停在 `RUNNING`，不会越过她的调用去结算。拆掉 trigger 并冷启动之后（新的 writer generation 持有她的 Session）：她 park 的调用从 journal 得到恰好一次「未发送」应答；她的 journal 仍没有 `session_command`，store 也从未接受过她的任何 `sendSessionCommand` 提交 —— 是应答，绝非另铸；没有回执、没有 `msgc_`，bob 的 journal 上什么都没有 |
| `receipt-commit-refused`  | 拒绝 lead 入站回执的插入                                        | execute 在回执之前已探测并铸出 bob 的位置，于是 Harness 记下 execute `failed in its store`（503 `session_command_failed`），一条 `msgc_`、没有回执；alice 的条目停在 `accepting`、未应答。lead 冷加载之后 relay 的重试重新 execute：探测找到已铸位置 —— 整个用例里 lead 上只有一次 `sendSessionMessage` 提交 —— 唯一的回执应答 `Message sent to bob.\n- bob: sent.`，alice 持有它；bob 恰好一次投递                                                                                          |
| `answered-commit-refused` | 拒绝 alice 条目上 `accepted` 的写入 —— relay 的 `answered` 回写 | lead 这一半已持久（它的回执与 bob 的 `msgc_`），alice 的条目停在 `accepting`、未应答。她冷加载之后 relay 的重试重新 execute，落到已存的回执上 —— 没有第二次回执提交、没有第二次铸造 —— 并回写一次：她的条目走 planned → accepting → accepted → consumed（revision 4），逐字节持有回执的 reply，她的调用恰好应答一次                                                                                                                                                                          |

落地时记录的机制说明：

- 一次被拒的 journal 提交锁存的是整个 Session 的 authority，不只是这次调用
  （「停止的 writer 不接受任何重试；被阻塞的 Session 不会自己恢复」）。relay
  里没有任何东西能治愈它；草稿里的「Harness 重载之后」是唯一的治愈途径，
  receipt 用例的「trigger 卸载后 relay 重驱」也只发生在它之后。期间 relay
  仍按退避重试：消息 relay 每遇到一次 `writes_stopped` 拒绝都会消耗一次
  attempt（1 s 起翻倍，封顶 300 s），所以放着一分钟不管的锁存会把下一次重试
  推到几分钟之后。每个用例都在第三次点火后数秒内重启。
- `answered` 动词会误标存储故障。`runCommandOperation` 的 `answered` 分支把
  `ManagedSessionRecordError` 当成非法请求，而 store 的
  `ManagedSessionStoreHttpError` 与锁存的 `ManagedSessionWritesStoppedError`
  都继承它 —— 所以 relay 读到的是 400 `invalid_command_operation`（且无
  stderr 行），而 `execute` 在同样情形下回 503 `session_command_failed`。
  relay 对两者的 defer 方式相同，投递不受影响；门禁钉住结果而非错误码，
  误标另行跟踪（#14419）。
- lead 的 Session 锁存或其 Harness 死掉时若 lead 还有未结束的 Turn，这个
  Turn 持有的 workspace 会留在死去的持有者手里：探测中冷启动的 lead 一直在
  `workspace_unavailable` 与 `hosted_session_already_attached` 上打转（两分钟内
  writer generation 从 2 涨到 12），什么也没执行，alice 的等待最终超时成
  `unknown`。夹具里的 lead 原先在收尾轮回空文本，模型客户端会对空响应重试
  约 20 s，所以布防时它的 Turn 仍开着；修法与结束等待见「夹具设计」。

### FG9c —— 进程崩溃（切片 3，已交付）

仅 POSIX。用例 SIGKILL 打包的 Harness 及其子孙进程 —— 它托管的每个 team
Session 随之一起死掉 —— 并在同一端口冷启动一个新的（新的
`HOME`/`QWEN_HOME`）；被测 Session 上出现新的 writer generation 即为接管
见证。每次 kill 都落在一次 store 已接受、但应答被 store proxy 扣住的提交上，
所以死去的进程从未得知它已落地：这是每一步最尖锐的窗口。bob 与 carol 在
kill 前后都停在模型闩锁上，算数的是它们被重驱的那一轮。

| 用例                     | 注入                                                                                                                                           | 期望                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead-kill-mid-fanout`   | 向 bob 与 carol 的 `*` 广播；扣住 lead 第一次 `sendSessionMessage` 提交的应答；扣住期间 SIGKILL Harness；冷启动                                | kill 时已提交一条 `msgc_`、没有回执。lead 冷加载之后 relay 的重试重新 execute：探测从 journal 把第一个位置报为 `sent.`，只铸第二个 —— 整个用例两次 `sendSessionMessage` 提交，每个位置一次 —— 唯一的回执应答 `Message sent to every other member of team "review".\n- bob: sent.\n- carol: sent.`，alice 持有它；每名收件人恰好投递并消费一次 |
| `member-kill-after-mint` | 扣住 relay；扣住 alice `sendSessionCommand` 提交的应答；扣住期间 SIGKILL Harness；冷启动；新的 writer generation 持有她的 Session 后放开 relay | 死去的进程从未确认的那个条目就是唯一的命令：同一个 id，整个用例一次 `sendSessionCommand` 提交，revision 4（planned → accepting → accepted → consumed）。接管从 journal 恢复她 park 的等待，她的调用恰好应答一次 `Message sent to bob.\n- bob: sent.`；一条 `msgc_`，一次投递                                                                  |

落地时记录的机制说明：

- H4e-b3 的重启用例（`memberHarnessRestartDuringCommandWait`）在 planned 条目
  已被确认、等待已 park 之后才 kill；`member-kill-after-mint` 把 kill 挪进
  该提交自己的应答里 —— 只有 journal 知道该条目存在的那个窗口。park 先于出站
  提交，所以接管经 `resumeCommandWaitRuns` 恢复它：它读 journal，绝不再调用
  `runCommand`；出站从未提交的 park 会走该函数的「从未提交」分支，FG9b 的
  `outbound-commit-refused` 走的正是这个分支。
- 在模型轮中途被杀的成员不会丢：协调器在新的 generation 上重驱它们这一轮，
  被杀那一轮的连接在闩锁放开后写进一个死连接，模型夹具按 Harness generation
  忽略它。

## 夹具设计

**形态决策：走 H4e-b3 的 Java IT 形态，不走 FG8 的 driver+probe 分拆。**
FG9 的流量就是 relay 本身 —— 脚本化模型的 tool call、JDBC 播种、
公开 API 的取消与输入、Harness 的杀伤与重启 —— 而这整套编排在 Java
里已经存在：`HostedTeamMemberCommandMySqlIT`（团队引导、脚本化成员、
relay 闩锁、Harness 被杀后的接管）与 `HostedTeamLeadMySqlIT`。FG7/FG8
的 driver 之所以存在，是因为那两轮需要 Java 做不好的东西 —— 真实的
`node -e` 后台 producer、FIFO、对 OS worker 的 SIGSTOP、channel 适配
器录制。FG9 一样都不需要；它必须做假的唯一外部世界是两个 HTTP 边界，
而这两个都能在门禁 JVM 内做假。纯 Java 夹具让所有防陈旧闩锁留在同
一进程，并消掉整套 driver↔probe 结果协议（driver.json、
`FG9_CASE_OK` marker、results 文件）—— 没有 `hosted-…-driver.ts`，
所以 `hosted-relay-headers.test.ts` 的名单见证不被触动，#14147 的
清扫清单也不增长。

`HostedSessionRelayFaultGatesIT` 按 H4e 系列 IT 的方式为每个字母起
一个 in-JVM `ManagedAgentServerApplication`（MySQL 属性强制 —— 缺席
即失败绝不跳过；内嵌 broker 用钉死端口；runtime state 目录在
`temporary` 下）。Spring 每字母起一次；同一字母的用例在这套栈上按序
运行，每个用例换一个 tenant、一支新团队（lead + alice + bob + carol）
与 `target/fg9-cases/<letter>/<case>/` 下的新用例目录（FG7 教训：
`@TempDir` 里的证据会蒸发）—— harness 日志、proxy 日志与用例武装
计划都落在那里。按字母选择子 `-Dqwen.fg9a.case` …（FG8 形态）。

**脚本化模型**是 H4e-b3 的编排练上 FG9 的调用集：lead 的计划 ——
`team_create`，然后按出生序为 alice、bob、carol 发 `agent` 启动（一
次与 team create 同批的成员启动就是它自己的批律拒绝），除非用例要求
否则不作别的；每个成员的计划由成员启动提示里的 marker 驱动 ——
alice 的计划携带用例的 `send_message` 调用（具名 bob，或广播用例的
`"*"`；需要二次发送的用例安排第二次调用），bob 全部按 WAIT 闩停驻
在首个模型响应前，carol 携带按用例的剖面 —— 快速完成（`_DONE`，仅
roster-changed）、按 WAIT 见证后释放（partial-timeout 与终止/broadcast
用例）、经脚本化 lead 的 `request_shutdown` 由 `stophit` 闩把守到其
首次模型接触后关停（recipient-stopping）。在忙碌 Turn 旁到达的唤醒乘
它的 followUp，所以成员报告按 H4e-b3 javadoc 记录的方式定序。

**一个 in-JVM lose-once/hold HTTP proxy** 挡住字母们唯一需要的边界 ——
Session-Store；Harness 的连接保持直连（落地拍板的 axis-A 决定）：

- **store proxy** 挡在 Session-Store 前：每个 harness 托管 Session 的
  `managedSessionStore` 连接经 Spring 属性
  `--qwen.managed-agent.session-store.base-url` 指向它，proxy 再转发到
  真实 Spring 端口。它解析每个请求（方法、路径、JSON 体），在
  `/transactions:commit[-v2]` 提交端点上按 journal 事务的 operation
  名（`sendSessionCommand`、`commitSessionCommandReceipt`、
  `sendSessionMessage`）武装，命中次数由规则自身计数（DROP 在前 N 次
  匹配点火，HOLD 只在第 N 次点火）。
- **harness 的连接是直连的**：探针已把挂 Harness 边界的 proxy 钉死 ——
  proxied warm/createOrLoad 链只会换来 resident-vs-attach 冲突
  （`hosted_session_already_attached` / `managed_session_writer_conflict`），
  Harness 直连才能跑完每支队伍；切片 1 没有任何用例需要 Harness 侧的
  drop 点。

proxy 把每次武装的操作按规则名记入用例目录（`PROXY passthru|armed|
dropped|holding|release|released <rule>`）；那几行就是字母们经
`countOps` 断言的故障点火见证。生产超时保持默认值；FG9f 的
`partial-timeout` 只把该字母的
`qwen.managed-agent.harness.request-timeout` 降到 3 s，让扣住的
mint 快速逼出 relay 侧超时加重试；另有 FG9e 的流心跳（见下）。

**切片 2 的新增。** 五件，全部在门禁 JVM 内：

- **relay 闩锁**沿用 H4e-b3：`SchedulerHold` 在单线程的
  `messageRelayScheduler` 上停放一个任务，于是在用例放行之前不会跑任何
  scan —— 也就没有认领、没有 handover；FG9d 的 `cancel-after-mint` /
  `cancel-reply-lost` 与两个 FG9e 用例都在 alice 发送前拿到它；
- **第二个 proxy 实例**只为 `cancel-reply-lost` 里客户端自己的 cancel
  POST 挡在公开 API 前（其余一律直连 Spring），处置同为提交后丢答；
- **观察者**是 FG8e 观察者的 in-JVM 移植：每条流一个 HttpClient
  （HTTP/1.1），切断即该客户端的 `shutdownNow`；它把每帧的 SSE
  `id`/`event` 与载荷的 `sequence`/`type` 对照，比对时把每个台账行按表面
  的提供方式映射（公开为 snake_case 与秒，WebShell 为 camelCase 与毫秒，
  省略 null）。认证 filter 现在也覆盖 `/api/agent/web-shell/v1/*` 与
  async 派发，与 FG8 的一致；
- FG9e 的流心跳设为 2 s。被客户端切断的流在服务端要到下一次写失败才关闭，
  而一条打开的流会把 Spring 的优雅停机拖满整个 30 s 窗口；不沿用 FG8e 的
  60 s 事件 poll/心跳，因为这里的续传视图几乎全是重放，长心跳只会让被切断
  的流多活一阵；
- Spring 与内嵌 broker 绑定临时端口、启动后再读回，两个 proxy 也只在那之后
  才设定上游：第一次全类运行中，Spring 预选的端口到它自己绑定时已被占用
  （`PortInUseException`）—— 预选与 Spring 绑定之间的任何临时绑定或连接都可能
  占走它，第二个 proxy 又多加了一个。Harness
  端口仍按 H4e 系列 IT 的做法预选，因为 Spring 的 connector 在 Harness
  启动前就按它配置。

**先见证、后释放的编排。** 切片在拒收语义上学到并在落地记下的排序课，
各花掉它自己的一轮探针：向已完结成员发 peer 消息会在任何铸造之前被拒
（广播时为 `not reached: it has finished; the leader may give it more
work, a peer cannot.`）；停在脚本化模型闩锁上的成员仍可被铸造，只是其
投递会以 `session_message_not_ready` 反复重试。编排因此把 bob/carol 以
WAIT 闩卡在用例自己的铸造见证（`awaitMsgcMinted` 读 `msgc_` 行）之后、
链结算之前才释放，让每个位置在活着时被铸造而链仍能落账；
`recipient-stopping` 的脚本化 `request_shutdown` 由 `stophit` 闩把守到
目标的首次模型接触 —— 取消一个尚未开始的 run 是诚实数据但不是接触，
用例的 roster 门会永久等它；成员 session 的查取在 child_run 记录体
**顶层**读 `childSessionId`（放宽后的记录契约之形），而切片 2 在任何 relay
动作之前就要读成员 Session，于是先等那次 attach 落地 —— 它可能晚于成员的
首次模型调用；
`settleAndCheckDelivered` 只按 `delivery_kind = 'SESSION_MESSAGE'` 拉
终态集合，因为三条 child-launch 的 `<childRunId>` delivery 在脚本化的
lead 先于被闩成员完结的顺序下本来就停在 `delivered` —— 那是编排簿记，
不是用例欠缴的 relay 活。

**存储故障 trigger**（切片 3，FG9b）沿用 FG8b 而非 FG7b：在
`ma_session_record` 上建 `BEFORE INSERT` 或 `BEFORE UPDATE` trigger，条件写明
用例 tenant、Session、`session_command` 域，回写那一例再加
`NEW.delivery_state = 'accepted'`；它先把用例名插进 MyISAM 表 `fg9b_fire`，
再 `SIGNAL SQLSTATE '45000'`，文本 `FG9B_<CASE>`。Spring 给 store 客户端回
500（`internal_error`），所以点火计数就是归因。用例在重启前拆掉自己的
trigger；teardown 再拆掉残留的 trigger 与旁表。

**杀伤臂**（切片 3，FG9c，以及 FG9b 的冷重启）沿用 H4e-b3 的重启机制：先对
Harness 的子孙进程、再对 Harness 本身 `destroyForcibly()`，在同一端口换一个
`startHarness()`（新的 `HOME`/`QWEN_HOME` —— 真冷），并在被测 Session 上做
writer generation 接管见证。`member-kill-after-mint` 和 H4e-b3 一样在 kill
前后都扣住 relay，接管之后才放开。仅 POSIX；每个字母保持 `@Timeout(600)`。

**切片 3 的新增。** 四件，全部在门禁 JVM 内：

- lead 的**收尾轮回文本**（`LEAD_REPORT done`），不再回空响应 —— 模型客户端
  会对空响应重试四次（间隔 2.5–8.2 s，共约 20 s）才结算 Turn，所以 lead 的
  Turn（以及每个读成员结果的唤醒 Turn）过去都要开着这么久。切片 1、2 从未
  依赖这一点；全类在此改动下重新测得全绿；
- FG9b 与 FG9c 在布防前**等 lead 的 Turn 结束**（`awaitLeadSettled`），并让
  bob 与 carol 在整个布防期间保持 WAIT，故障窗口内 lead 不会有开着的 Turn；
- store proxy 现在记录每次提交的 `op=<operation>` 与上游 `status=`，
  `journalCommits(session, operation)` 数 store 接受了的提交。它是「绝不铸两次」
  的见证：`ma_session_record` 每个记录 id 只保留一行，同 id 的重铸不会留下
  第二行；
- Harness 日志在重启之间追加，每次重启递增一个 generation，模型夹具据此忽略
  被 kill 打断那一轮的死连接。

**CI。** 类名把它放进 `hosted-harness-mysql` 车道（`Hosted*IT`
include；`check-failsafe-reports.js hosted` 强制它必须跑过）。每
切片的更新集，同一次提交：

- `.github/workflows/sdk-java.yml` —— `target/fg9-cases/` 加入报告
  上传路径，紧挨 `fg7-cases/` 与 `fg8-cases/`。
- `scripts/tests/hosted-process-ci.test.js` —— 新类的按方法
  `@Timeout` 预算按 FG8 先例钉住（`@Timeout` + 健康时长 ≤ fork
  预算），任何移动的车道预算（fork / Verify 步骤 / job）与 yaml 在
  同一 diff 变更，按新类全绿重测。
- `packages/managed-agent-server/pom.xml` —— 加
  `hosted-session-relay-gates` 聚焦 profile，拷贝
  `hosted-monitor-run-gates` 用于本地运行。

切片 2 只移健康配额，按四字母全类全绿重测（本地三次健康 308–314 s，按同样的
1.7× 预算约 534 s，切片 1 时约 300 s）：2400→2640 s。#14334 为五个 FG8 字母
已把 hosted fork 提到 3600 s，它已覆盖一个 600 s 上限加这份健康时长（3240 s），
所以 fork、Verify 步骤与 job 上限都保持 #14334 留下的值。

切片 3 把六字母全类在本地重测三次，健康 528–557 s（FG9b 129–137 s、FG9c
100–109 s；此前四个字母仍约 310 s，与 lane run 38957583765 一致，该次运行中本类
用时 310 s），按同样的 1.7× 预算约 950 s，比切片 2 的约 534 s 多约 416 s。
配额要与本片开发期间改动过它的字母叠加 —— FG8c 崩溃字母（#14407，2640→2930 s）
与 FG10a 工作流摘要字母（#14390，2930→2963 s）：2963 − 534 + 950 ≈ 3380 s。
一个 600 s 上限加上它已放不进 3600 s 的 fork，于是 fork 3600→3990 s；Verify
步骤必须在其 600 s 之外包住 fork，改为 75→80 分钟（余量 210 s）；job 上限
320→325，以保持在各 step 上限之和（310）加未设上限的准备步骤之上。

## 变异检查

每个变异先应用、证明恰好其门禁变红、再还原，沿用 FG6/FG7/FG8 的文档化
手工流程。以下切片 1 变异随本设计提交；切片 2 与切片 3 的紧随其后。

1. FG9a —— store 客户端的不确定错误重试铸出新事务身份而不是重驱原身
   份：`admission-commit-reply` 红（出现第二行 `session_command`，或
   重复被拒绝）。
2. FG9f —— `executeMemberMessage` 的已提交位置探测被中和（`committed`
   集合恒为空）：`partial-timeout` 红 —— 早前位置被再次铸造（该位置
   出现第二行 `msgc_`，或铸造的幂等冲突在发送循环里浮出）。
3. FG9f —— 回执中省略 not-reached 文案（未达位置被静默从报告中丢掉）：
   `roster-changed` 在点名原因断言处红。
4. FG9a —— `existingReply` 被绕过（`execute` 永远跑全新步骤）：
   `receipt-commit-reply` 红 —— 回执被重复提交（第二次 revision），
   或答案字节逐字节分叉。

切片 2，每个只对其目标用例运行（`-Dqwen.fg9d.case` /
`-Dqwen.fg9e.case`）；两个 Harness 侧变异就地改打包产物的 chunk，事后逐字节
还原：

5. FG9d —— 取消的 journal 作答仍说「未发送」，却把条目留在 `planned`
   （去掉 `planned` 臂的 `settle(…, 'cancelled')`）：`cancel-after-mint`
   红 —— 条目停在 `planned`、永不结算 `cancelled`，放行的 relay 会把它
   handover 出去。
6. FG9d —— 取消的 request digest 在重试间不稳定（每次调用带 nonce）：
   `cancel-reply-lost` 红 —— 重发的取消应答 `409 idempotency_conflict`，
   而不是已提交的受理。
7. FG9d —— 取消告诉一名已 handover 的发送方「消息未发送」（journal 作答的
   `accepting` 臂给出 `planned` 文案，条目仍结算 `unknown`）：
   `cancel-during-handover` 在作答断言处红 —— 被告知重发的发送方会重复一条
   relay 已投递的消息。更强的回归 —— 取消撤回已 handover 的条目本身 —— 被
   三层拒绝：journal 作答结算 `unknown`，`settle` 只允许从 `planned` 到
   `cancelled`，记录契约的投递状态迁移
   （`managed-extension-record.ts:183-187`）从不让 `accepting` 走向
   `cancelled`；前两层被变异后，第三层拒绝每一次 settle，Turn 以
   recovery-blocked 告终、永不离开 `CANCELLING`，本用例在那个等待处红。
8. FG9e —— 公开 `Last-Event-ID` 游标少读一位：`public-resume` 红（续传
   边界上一处重复）。
9. FG9e —— WebShell `afterSequence` 游标在续传时多读一位：
   `webshell-resume` 红（续传边界上一处缺口）。

切片 3，每个只对其目标用例运行（`-Dqwen.fg9b.case` /
`-Dqwen.fg9c.case`）；Harness 侧的变异原地修补 bundle 的 chunk 并逐字节还原，
relay 那一个修补 Java 源码：

10. FG9b —— 冷加载告诉一条从未提交的出站「已到达 leader」
    （`resumeCommandWaitRuns` 的「从未提交」分支给出 `accepting` 文案）：
    `outbound-commit-refused` 在作答断言处红 —— 被告知消息可能已落地的发送方，
    永远不会去重发那条其实没发出去的消息。
11. FG9b —— execute 在没有持久回执的情况下作答（回执提交的失败被吞掉）：
    `receipt-commit-refused` 红 —— execute 回 202，用例等待的存储故障根本不
    出现，alice 将持有的 reply 背后没有回执。
12. FG9b —— `answered` 回写失败时 relay 仍把命令归为 done：
    `answered-commit-refused` 红 —— 她的条目永远得不到应答，她的等待最终
    超时成 `unknown`。
13. FG9c —— 每次执行都派生新的 `msgc_` id（命令 id 每次加盐，id 不再可重放）：
    `lead-kill-mid-fanout` 红 —— 重执行以新 id 再次发送位置 1（两个位置出现
    三条 `msgc_`）。只中和发送循环的已提交位置探测（切片 1 的变异 2）在这个
    kill 点是等价变异：`sendToRunningMember` 对同 id、同内容的重驱发送直接答
    `sent`、不提交，两道防线任一单独都能挡住位置 1 的第二次发送。二者都依赖
    可重放的 id，这个变异破坏的正是它。
14. FG9c —— 冷加载把一个已 park 的条目读成从未提交（记录存在时
    `resumeCommandWaitRuns` 仍走「从未提交」分支）：`member-kill-after-mint`
    红 —— alice 被告知「未发送」而她的条目仍然有效，relay 照样投递它，回写的
    reply 永远不被消费。

## 验证与验收

- `npm run build && npm run typecheck`；driver 的 ESLint 干净；
  `hosted-relay-headers.test.ts` 带新名单条目全绿。
- 模块 surefire 套件、Checkstyle、SpotBugs 全绿。
- 新类在本地 MySQL/MariaDB 上全绿（CI 车道是 MySQL 8.4）：每个用例的
  声明故障都点火 —— 每个丢弃计数、扣留计数、`fg9b_fire` 计数与被扣住的
  kill 点都被观察到 —— 按字母选择子可用，且快乐路径（无注入的一次
  广播）全绿、每个 roster 位置恰好一行 `msgc_`。
- 以上切片 1 与切片 2 变异每个单独变红；源码还原；门禁复绿。切片 3 对其
  变异重复同一流程。
- `hosted-process-ci.test.js` 带任何移动的预算全绿，且全车道跑完后
  `check-failsafe-reports.js hosted` 满足。
- 按 AGENTS.md 做两轮连续干净的无方向审计与反向审计。
- 本设计双语落地；#14164 收到一条记录切片划分与可关闭性声明的评论，
  每个切片 PR 在该处标记其字母已交付（决策 6）。

## 开放问题

1. 落地时已有定论：切片 1 不做任何 `execute` 动词的注入。axis 探针把
   harness 前置 proxy 钉死（proxied warm/createOrLoad 链只会换来
   resident-vs-attach 冲突），Harness 连接因此保持直连；步骤 1 的重放
   稳定断言由三个 store 边界字母承载。
2. 广播 roster 是否扩到四名成员（三个收件人）以让部分臂的判定更锐 ——
   代价是每个用例多一名脚本化成员；实现时定。
3. 切片 2 已定：FG9e 不武装过期游标 `resync_required` 用例。resync 应答
   属于 Session 流的重放地板，与事件由哪个能力产生无关，FG8 的跟踪 issue
   （#14163）仍欠着那唯一的用例。
