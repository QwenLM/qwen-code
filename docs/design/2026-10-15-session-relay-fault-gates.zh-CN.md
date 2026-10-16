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
- mint-未-relay 窗口的取消：`answerCommandByJournal`
  （`hosted-workspace-tool-turn.ts:5843-5903`）把 `planned` 条目结算为
  `cancelled`（`settle` 只从 `planned` 出发，
  `hosted-session-command-session.ts:392-412`）；恢复侧给出同一答案
  （`sessionCommandJournalAnswer`，
  `packages/cli/src/serve/hosted-runtime-recovery.ts:1180-1225`）。
- SSE：公开流按 `Last-Event-ID` / `after` 续传
  （`PublicAgentController.java:195-218`），WebShell 流按 `afterSequence`
  （`WebShellAgentController.java:125-134`）。
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

   | 切片 | 字母           | 等待                                                                                        | 原因                                                                                                                                                              |
   | ---- | -------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 1    | **FG9a, FG9f** | 无                                                                                          | 本轮欠的语义 —— 应答丢失下的探测后再发送与答案诚实 —— 没有在飞 PR 触碰。                                                                                          |
   | 2    | **FG9d, FG9e** | 无；排在第二只为控制切片体量                                                                | 取消与 SSE 断流字母原样复用切片 1 夹具与 FG8e 观察者。                                                                                                            |
   | 3    | **FG9b, FG9c** | **#13918**（InnoDB 锁守卫护卫）与 **#13986**（重启证明 held-Runtime drain）—— 今天均为 OPEN | FG9b 的 marker 断言 #13918 正在重写的存储故障错误码分类；FG9c 的 member/lead 重启臂钉住 held-Runtime 回填（#13986）正在重塑的冷载恢复。与 FG8 切片 3 同批等待者。 |

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
   在此都不修，也都不被掩盖。

5. **#13339 纪律。** 车道没有隔离或重试机制。FG9 因此：(a) 只新增
   `Hosted*IT` 类，绝不动 `HostedWorkspaceToolTurnIT`；(b) 每个用例都先
   断言其故障确实点火（丢弃计数、`FG9B_*` marker、kill marker、断流的
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
proxy 计数与 commit 日志（FG9a、FG9d、FG9f）、`FG9B_<case>`
SQLException marker（FG9b）、从 producer 自身进度读到的 kill marker
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

### FG9d —— 取消（切片 2）

| 用例                     | 注入                                                                                                                        | 期望                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-after-mint`      | 在 alice 的 outbound `session_command` 已提交 `planned`、relay 尚未 handover 时取消她的 Turn（公开 `agent.session.cancel`） | 被取消的发送不产生投递：零 `msgc_` 行、零收件人 journal 行；发送方条目结算 `cancelled`（`answerCommandByJournal`，`settle` 只从 `planned` 出发）；relay 把台账行分类为 `done` 且不 execute；发送方 Turn 以 cancelled 结束，无伪造 reply |
| `cancel-reply-lost`      | 在取消已提交后毁掉 cancel POST 的应答；客户端重发同一取消                                                                   | 重发的取消应答同一已提交状态 —— 一条取消 journal 条目、一个结算终态；无重复取消事件；条目保持未投递                                                                                                                                     |
| `cancel-during-handover` | 在 relay 的 handover 尝试在途时取消（handover 动词的应答被 proxy 扣住，取消落地后再放行）                                   | 只有物理上已结算的 relay 产生终态：要么 handover 竞赢取消、已提交回执诚实应答，要么被取消的条目挡住 relay 不执行 —— 绝不两者兼得，绝不在被取消了的发送上出现投递；journal 持有的结局是二者之一，门禁证明是哪一个                        |

### FG9e —— SSE 断流（切片 2）

公开与 WebShell 流由 in-JVM Spring 提供；客户端断开与续传就是注入，所以
本字母不需要 proxy。一次在途的 `*` 广播提供 relay 流量。每个用例在 relay
中途断流，让 relay 在断线期间继续推进 —— JDBC 见证续传前已有行提交在
游标之后 —— 然后才重连，所以重放绝不是空洞的。

| 用例                        | 注入                                              | 期望                                                                                                         |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `public-sender-resume`      | 扇出中途断开发送方公开流；按 `Last-Event-ID` 续传 | 从游标起重放序列无重复、无缺口；回执与铸出的消息在断线期间提交到游标之后（JDBC）；终态 Turn 事件恰好出现一次 |
| `webshell-sender-resume`    | 扇出中途断开 WebShell 流；按 `afterSequence` 续传 | 对 WebShell 信封做同样的连续性断言                                                                           |
| `public-recipient-resume`   | 在铸造与投递之间断开一名收件人的公开流；续传      | 被铸消息的投影按序重放，不丢失、不重复；收件人的消费事件恰好出现一次                                         |
| `webshell-recipient-resume` | 同上，走收件人的 WebShell 流                      | 同样的断言                                                                                                   |

### FG9b —— 存储故障（切片 3，#13918 之后）

测试专用 SQL trigger，限定 tenant 与 scope，每用例安装与卸载，像
FG7b/FG6f 一样，`SIGNAL SQLSTATE` 文本 `FG9B_<case>` 在捕获的 Spring
输出中断言。这些用例断言的错误码是 #13918 之后的分类，切片落地时重钉。

| 用例                      | 注入                                                      | 期望                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbound-commit-refused` | 一次性 trigger 拒绝成员的 outbound `session_command` 提交 | 零下游效果：无 `ma_delivery` 行、无 execute、无 `msgc_` 行；发送方 park 的等待保持可恢复状态；Harness 重载后无重复 journal 行（铸造只经原调用自己的重放重驱，绝不另铸新条目） |
| `receipt-commit-refused`  | 一次性 trigger 拒绝 lead 的入站回执提交                   | execute 无回执失败；trigger 卸载后 relay 重驱一次，重跑经探测应答（已提交位置报 `sent.`），绝不重发；收件人视图不因失败的回执推进 —— 恰好一次投递，无重复                     |
| `answered-commit-refused` | 一次性 trigger 拒绝成员 journal 上 `answered` 回写提交    | relay 重试 `answered` 动词；恰好一次 `accepted` revision 携带 reply；成员 park 的等待恰好消费一次；journal 上无重复 reply 字节                                                |

### FG9c —— 进程崩溃（切片 3，#13986 之后）

仅 POSIX。driver 持有 Harness 子进程并发信号；冷载断言按 #13361 的
branch-tagged 409 arm 名称书写，切片落地时对照已合入的 #13986 表面重钉。
此处杀 Harness 会同时杀掉它托管的所有 team session —— 两个用例的差别
只在 kill 落在哪个 relay 窗口。

| 用例                     | 注入                                                                                      | 期望                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead-kill-mid-fanout`   | 在第一个 `msgc_` 铸造提交（在 store proxy 见证）之后、回执提交之前 SIGKILL Harness        | 重启：未结算的命令绝不重铸（一行 `session_command`）；重执行探测到位置 1 已提交 —— 报 `sent.`、绝不重发 —— 且位置 2 恰好发送一次；回执诚实提交；两名收件人各投递一次                                            |
| `member-kill-after-mint` | 在 alice 的 outbound `session_command` 提交之后、她的等待第一个检查点之前 SIGKILL Harness | 重开：已铸但未等待的条目不变成不可见重复 —— 一行 `session_command`，等待从 journal 恢复（`sessionCommandJournalAnswer` 臂，`hosted-runtime-recovery.ts:1180-1225`）；relay 完成该命令；发送方 Turn 恰好应答一次 |

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
mint 快速逼出 relay 侧超时加重试。

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
**顶层**读 `childSessionId`（放宽后的记录契约之形）；
`settleAndCheckDelivered` 只按 `delivery_kind = 'SESSION_MESSAGE'` 拉
终态集合，因为三条 child-launch 的 `<childRunId>` delivery 在脚本化的
lead 先于被闩成员完结的顺序下本来就停在 `delivered` —— 那是编排簿记，
不是用例欠缴的 relay 活。

**存储故障 trigger**（切片 3，FG9b）拷贝 FG7b DDL 形态，
`SIGNAL SQLSTATE` 文本 `FG9B_<case>`，限定用例 tenant 与记录 id
前缀，在捕获的 Spring 输出中断言，拆卸放 teardown。

**杀伤臂**（切片 3，FG9c）逐字复用 H4e-b3 重启机制：
`harness.destroyForcibly()`，换一个 `startHarness()`（每个用例新的
`HOME`/`QWEN_HOME` = 真冷），writer generation 接管见证，以及前后
各一次 relay 闩锁保证 kill 落在在飞段。仅 POSIX；两个切片都保持每
字母 `@Timeout(600)`。

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

## 变异检查

每个变异先应用、证明恰好其门禁变红、再还原，沿用 FG6/FG7/FG8 的文档化
手工流程。以下切片 1 变异随本设计提交；切片 2/3 的变异随字母落地时
细化。

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

计划项，切片落地时细化：FG9d —— 取消结算接受从非 `planned` 状态出发
的 settle（`cancel-after-mint` 在第二次 settle 冲突处红）；FG9e ——
FG8e 变异中的按字母重放边界 off-by-one 一对，重施加到 relay 台账投影
上；FG9b —— 被拒的 outbound 提交继续铸出 delivery 行
（`outbound-commit-refused` 在零投递断言处红）；FG9c —— 冷载把 park
的命令等待当成干净（`member-kill-after-mint` 在从 journal 恢复的断言
处红）。

## 验证与验收

- `npm run build && npm run typecheck`；driver 的 ESLint 干净；
  `hosted-relay-headers.test.ts` 带新名单条目全绿。
- 模块 surefire 套件、Checkstyle、SpotBugs 全绿。
- 新类在本地 MySQL/MariaDB 上全绿（CI 车道是 MySQL 8.4）：每个用例的
  声明故障都点火 —— 每个丢弃计数、扣留计数、`FG9B_*` marker 与 kill
  marker 都被观察到 —— 按字母选择子可用，且快乐路径（无注入的一次
  广播）全绿、每个 roster 位置恰好一行 `msgc_`。
- 以上切片 1 变异每个单独变红；源码还原；门禁复绿。切片 2/3 对其变异
  重复同一流程。
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
3. FG9e 是否需要 FG8e 切片延期的过期游标 `resync_required` 臂 —— 留给
   切片 2 落地，同属重放地板机制问题。
