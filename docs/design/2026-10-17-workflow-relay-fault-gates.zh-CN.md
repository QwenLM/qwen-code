# workflow child_run relay 故障门禁 FG10b–FG10f

[English](2026-10-17-workflow-relay-fault-gates.md) | [简体中文](2026-10-17-workflow-relay-fault-gates.zh-CN.md)

## 问题与范围

Issue #14165 是 #12380 Stage F 的 FG10 轮（伞形 issue #14054）：为 #13858
启用的 `child_run` `workflow` kind 补上故障门禁。FG10a（摘要完整性）已随
#14390 落地，见 [a+d 设计](2026-10-16-workflow-fault-gates-ad.zh-CN.md)。FG10d
（进程崩溃）在那里被延后，并带出了它抓到的生产问题 #14387：Harness 被杀后，恢复
流程会重新驱动一个未结算的 workflow Turn。它的修复 #14461 让协调器对已绑定、且
不在取消中的 workflow Turn 保持未结算，不再重新驱动。本设计覆盖剩下的五个字母：
**FG10b（应答丢失）、FG10c（存储故障）、FG10e（取消）和 FG10f（通知与输出投递）**，
以及在 #14461 合入后作为第 3 片加入的 **FG10d（进程崩溃）**（见下文）。

a+d 设计说前四个"大体与 kind 无关"。但它们并不能白拿：每一个都落在记录的
**relay 驱动的结算**上，也就是从启动到父 Session 收到通知的整条流程。FG10a 由
driver 持有父 Session，走不到这里：它的父 attach 和 relay 的操作冲突，而由协调器
持有父 Session 的方案需要 workspace 执行，macOS 本地跑不了。在 Linux 上，协调器
持有的父 Session 就是 FG9 夹具里的 team lead。在它上面做的探测，大约十秒就能把一个
后台 workflow 子运行完整跑完：

1. lead 的 `workflow` 调用被受理；
2. relay 创建并绑定子 Session；
3. 子 Turn 执行脚本及其进程内的 `agent()` 派发；
4. 结果 revision 让记录结算；
5. 通知以 `<task-notification>` 输入的形式落到 lead 上，lead 的唤醒 Turn 读取它。

FG10b、c、e、f 钉住的，是这条流程在故障下的 workflow 专属承诺：

- **每次启动至多一个 workflow 实例**：一个子 Session、脚本只执行一次、每次调用
  只派发一次 `agent()`，无论流程中哪一个应答丢失（FG10b）；
- 被拒的提交**让记录保持阻塞，绝不被静默推进**，通知也绝不会在记录毫无痕迹的
  情况下丢失（FG10c）；
- 子 agent 在飞时取消，**记录结算为 cancelled，其下不留任何仍在运行的东西**，
  子 agent 的回答永远不会落地；而丢失的取消应答和结算之后的取消都诚实地解决
  （FG10e）；
- 通知**至多投递一次**，workflow 中途被切断的流续传时不缺失、不重复（FG10f）。

FG10d（进程崩溃）在 #14461 合入后作为第 3 片加入。它放在这里，而不是 a+d 设计里由
driver 持有 parent 的那个类，原因同上：kill 之后它要钉住的东西（记录的阻断结算、
ledger 以及 lead 收到的通知）都在 relay 驱动的流程里。在这条流程下，Harness 死在
其上的运行**绝不会被重新执行，也绝不会被当作结果已被观察到而结算**（FG10d）。

第 1、2 片**不改任何生产代码**。第 3 片修复了它的门禁发现的两个缺陷，以及评审发现的
第三个（见 FG10d 的"随门禁修复的问题"）。

## 现状

于 `main` = `3547398d2b`（2026-10-17）核实，依据源码阅读，以及在 FG9 夹具上的一次
探测（一个后台 workflow，含一次 `agent()` 调用）。

- **启动。** `workflow` 会提供给顶层 Session，条件是它有子 agent funnel，并且有
  shell 或后台通道（`packages/cli/src/serve/hosted-workspace-tool-turn.ts:1855-1862`）；
  协调器持有的 team lead 满足条件。`acceptChildWorkflow`（`:5802`）pin 住定义，经
  `childLaunchAdmission` 受理启动，再经 `admitWorkflow` 提交（`startChildRun`，
  revision 1，`admitted`）。默认在后台运行：调用立即应答（"started in the
  background as `task_…`"），结果稍后以通知到达；"失败或被取消的子运行不产生通知"
  （`:1483`）。
- **relay 流程。** `ChildResultRelay`
  （`packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/service/ChildResultRelay.java`）
  依次驱动 `create`（`:464`）→ `bind`（`:851`）→ `watch`（`:887`）→ `complete`
  （`:1062`）→ `accept`（`:1148`）→ `deliver`（`:1261`）。每一步都从已提交状态
  对账，`defer`（`:1385`）在 `MAX_ATTEMPTS = 64` 内按 `1 s << attempts` 退避，
  封顶 300 s。停止走 `stopChild`（`:299`）。
- **一次流程产生的提交**，读自 store proxy 的 `op=` 日志：
  - lead：`startChildRun`；relay 的 `commitChildRunRecord` ×2（dispatch、attach）；
    结果那一次 `commitChildRunRecord`；`acceptChildResult`（通知输入）；唤醒
    Turn 的各次提交；再两次 `commitChildRunRecord`（delivered、consumed）；
  - 子 Session：`session.create`、`installActivation`、`submitInput`、
    `commitCheckpoint`、`commitMessage` ×2、`settleTurn`。进程内的子 agent 自己
    不提交任何东西，它的回答只以 workflow Turn 消息的形式进入 journal。

  记录依次走过 revision 1 `admitted` → 3 `running`（子 Session 已挂上）→ 6
  `settled` / `completed`，投递状态 `consumed`。relay 台账（`ma_delivery`）里有
  一行 `CHILD_RESULT`，`delivered`/`accepted`/`consumed`。

- **取消。** `workflow` 在 `CANCELLABLE_TASK_KINDS` 里
  （`store/ManagedExtensionProjection.java:133`；动作见 `:244`），所以公开的
  `POST /v1/agents/sessions/{id}/tasks/{taskId}/cancel` 会受理一个 `TASK_CANCEL`
  操作。在模型处扣住 `agent()` 请求时探测到：
  - 子 Turn 在三秒内结束为 `CANCELLED`，记录结算为 revision 5
    `cancelled` / `stop_requested`；
  - `agent()` 派发次数保持为一，`CHILD_RESULT` 行的接收状态保持 `pending`
    （被取消的子运行不发通知）；
  - 子 Session 的关闭作为欠账留下；
  - 结算之后的取消返回 409 `task_action_unavailable`，以同一 `Idempotency-Key`
    重发返回 202 `replayed: true`。
- **通知应答丢失。** lead 第一次 `acceptChildResult` 的应答在提交后被丢弃时，
  重试重放原事务，lead 上恰好只有一份 `<task-notification>` 输入，由一次唤醒轮
  读取。
- **沿用自 FG9**（#14164）的机制：
  - 挡在 store 前、可丢弃或扣住应答的 proxy，按提交记录 `op=`/`status=`
    （`journalCommits`）；
  - trigger 加 `fg9b_fire` 的存储拒绝及其机制：store 客户端对不确定的 5xx 会重试
    三次，之后 Session 锁存写入，只有冷启动 Harness 能治愈；
  - 冷重启及其 writer generation 见证；
  - 挡在公开 API 前、模拟客户端应答丢失的 proxy；
  - in-JVM 的 SSE 观察者。

## 范围决策

1. **五个字母，三片。** 第 1 片 = **FG10b + FG10f**：应答的丢失与延迟，以及流的
   连续性，不重启。第 2 片 = **FG10c + FG10e**：带冷重启的存储拒绝，以及取消。
   第 3 片 = **FG10d**：在 #14387 的修复（#14461）合入之后，Harness 在运行中的
   workflow Turn 下被 kill。每片各自一个 PR，并在 #14165 上标记其字母已交付。
2. **在 FG9 夹具上新建一个类。** 这些字母放在 `HostedWorkflowRelayFaultGatesIT`
   里：纯 Java、协调器持有的 lead、in-JVM Spring、打包的 Harness、脚本化模型，
   选择子为 `-Dqwen.fg10b.case` … `-Dqwen.fg10f.case`，证据放在
   `target/fg10-cases/<letter>/` 下。

   它们不并入 `HostedWorkflowFaultGatesIT`。FG10a 由 driver 持有父 Session，按设计
   在子 Turn 处钉住摘要；而这些字母断言的是记录的结算，需要协调器持有的父
   Session。类名命中已有的 `hosted-workflow-gates` 聚焦 profile。

   夹具是私有副本，沿用 FG8/FG9 遵循的 #14147 约定；而
   `HostedSessionRelayForwardingProxy` 原样复用，因为它是通用的 store/API proxy，
   不带 FG9 语义。协调器持有的 workspace 执行把这个类限定在 Linux 上，和车道一致。

3. **重启只发生在子 Turn 结算之后。** 跨越运行中 workflow Turn 的冷重启属于 FG10d
   的地盘：它的恢复行为正是 #14387 发现、#14461 改变的（Turn 保持未结算，不再被
   重新驱动），由 FG10d 门禁来钉住。所以 FG10c 只拒绝子 Turn 完成之后的提交，即
   结果 revision 和通知，它的重启也只重载 lead。第 1、2 片没有任何一处会在运行中的
   workflow Turn 上布防 kill 或重启，那是第 3 片 FG10d 的事。
4. **钉住结果，不钉错误码。** 和 FG9 一样，门禁断言的是记录、journal 和模型看到了
   什么，并用各自的见证给每次故障归因：丢弃计数、点火计数、被扣住的请求。中间的
   错误码只记进机制说明，不做断言，所以修正一个误标（#14419 那类）永远不会让门禁
   变红。
5. **#13339 纪律。** 只新增类；每个用例在断言期望之前先证明其故障确实点火；JDBC
   变更都限定在用例 tenant 内；任何拒绝写入或重启的布防之前，lead 自己的 Turn
   都已结束（FG9 第 3 片的教训）。
6. **可关闭性。** 第 2 片之后，#14165 上只剩 FG10d，阻塞在 #14387 上。第 3 片之后
   FG10 的每个字母都已交付；是否关闭跟踪 issue 由其负责人决定。

## 门禁总账

Ground truth 是 JDBC：

- lead 的 `child_run` 记录（`ma_session_record` 及其资源体）；
- `ma_delivery` 里的 `CHILD_RESULT` 行；
- `ma_operation` 行；
- 子 Session 的 journal 与 `ma_turn`；
- lead 的输入；
- FG10f 各条流的公开事件台账。

脚本化模型的请求日志统计 workflow 的 `agent()` 派发：子 agent 请求是系统提示里写着
"由 workflow 编排脚本派生"的那一个。它同时也是 FG10e 的在飞见证。每个用例都断言
其故障确实点火了。

共享的编排：每个用例一个全新的 tenant 和 team lead；lead 的第一轮调用 `workflow`，
脚本里做一次 `agent()` 调用并返回其回答；之后各轮以文本收尾。第 1 片的用例在启动
前布防，因为它们的注入既不会锁存 Session，也不会重启 Harness。第 2 片的拒绝与
重启布防，要先等 lead 自己的 Turn 结束。

### FG10b —— 应答丢失（第 1 片，已交付）

relay 在 lead 上的每一步都是 Harness 的子操作（`runChildOperation`，每次尝试都用
新的 `operationId`）。所以"原身份"指的是 Harness funnel 按 revision 生成的
command id（`<promptId>:<callId>:<revision>`），在此之前还有 relay 自己按已提交
状态的对账。

store 客户端在一次提交调用内部重驱的丢弃，根本到不了 relay，那是 FG9a 已经钉住的、
与 kind 无关的重放。所以两个 relay 步骤的用例改为把提交的应答**扣住**，扣住的时间
超过 relay 的请求超时（本字母的 `qwen.managed-agent.harness.request-timeout` 设为
3 s，与 FG9f 相同）。过程是：

1. 提交已在上游落地；
2. relay 的调用超时，relay defer 这一步；
3. 这之后才放开扣住的应答。

这样这一步确实跑了两遍。见证是 relay 的创建行在本次扣住开始时读到的计数之上再多
消耗一次 attempt：这个计数是整个创建过程累计的（之前的 bind 可能已经 defer 过），
而在调用被扣住期间，relay 唯一的扫描线程阻塞在这次调用里，这一行不会有别的东西
消耗那次 attempt —— 即 FG9f 的「基线加一」。子 Turn 自己的 journal 提交不涉及 relay 步骤，保持丢弃。

| 用例                  | 注入                                                                                                      | 期望                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-reply`      | 扣住 lead 上 `dispatch_started` revision（`commitChildRunRecord`，revision 2）的应答，直到 relay 已 defer | 一个子 Session，一个 `CHILD_SESSION_START` 操作，一次 workflow 运行：模型处只有一次 `agent()` 派发。记录只走一遍，到 `settled` / `completed` / `consumed`，revision 6，`kind` 为 `workflow`。relay 的五个 revision 各提交一次，被扣住的那一次绝不重新提交。一行 `CHILD_RESULT`，`delivered`/`accepted`/`consumed`；一份携带脚本返回值的通知；lead 上一次唤醒轮 |
| `child-message-reply` | 丢弃子 Session 第一次 `commitMessage`（workflow Turn 自己的 journal）提交后的应答                         | 被丢弃的确实是子 Session 的应答。store 客户端的重放让这条消息只落地一次，子 Turn 只完成一次，脚本只执行一次。`dispatch-reply` 的每条期望都成立                                                                                                                                                                                                                 |
| `result-reply`        | 扣住 lead 上 `commit_result` revision（revision 4）的应答，直到 relay 已 defer                            | 记录只结算一次，绝没有第二个终态 revision，仍是 revision 6；只通知一次，由一次唤醒轮读取；脚本绝不重跑。`dispatch-reply` 的每条期望都成立                                                                                                                                                                                                                      |

### FG10f —— 通知与输出投递（第 1 片，已交付）

| 用例                  | 注入                                                                                                                                  | 期望                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification-reply`  | 扣住 lead 第一次 `acceptChildResult`（落地通知输入的那次提交）的应答，直到 relay 已 defer 这次 acceptance                             | lead 上恰好一份 `<task-notification>` 输入，由一次唤醒轮读取。记录只一次结束于 `consumed`（revision 6），`CHILD_RESULT` 行为 `delivered`/`accepted`/`consumed`                                               |
| `child-stream-resume` | 扣住 `agent()` 请求；打开子 Session 的公开流与 WebShell 流，追平后同时切断，放开请求，再分别按 `Last-Event-ID` / `afterSequence` 续传 | 子 agent 的回答、Turn 的输出及其终态，都在两个客户端断开期间提交，续传前由 JDBC 证明。每个续传后的视图都是从 1 起的一条序列，不缺失、不重复，逐帧等于该表面所提供的台账，并且恰好带一次 workflow Turn 的终态 |

落地时记录的机制说明：

- **重驱步骤上的纵深防御。** 重驱的 `commit_result` 根本到不了 Harness：relay
  先读已提交的记录（`settledAlready`，`ChildResultRelay.java:1035`），发现结果已在，
  就直接去做 acceptance。在它后面，Harness funnel 会用已提交的副本回答重放的结果
  （`settleCompleted`，逐字节比对，`hosted-child-agent-session.ts:1362`）。

  重驱的 acceptance 会到达 Harness，遇到 funnel 的深比较检查（`accept`，`:1505`）。
  再往后，记录契约会拒绝第二次 acceptance 提交：即使这个检查和 `:accept` command
  key 都被去掉，也不会落地第二份通知。

  在这些窗口上，单独中和其中任何一层都是等价变异，所以本片的变异一次去掉全部
  防线（见「变异检查」）。

- `CHILD_RESULT` 台账行在记录的 consumed revision 落地之后才被归类，所以门禁两者
  都要等。
- lead 的唤醒 Turn 不投影到它的公开流（与 FG9e 对成员唤醒 Turn 的发现一致）；
  workflow 子 Session 的 Turn 会投影，从 `turn.accepted` 到 `turn.completed`。所以
  FG10f 切断的是子 Session 的流，而不是 lead 的流：lead 的台账在启动 Turn 之后就
  没有新事件了。
- `child-stream-resume` 也断言没有多出的通知，因此除了流之外，还会跑一遍
  `assertOneWorkflowInstance` 的全部期望。

### FG10c —— 存储故障（第 2 片，已交付）

在 `ma_session_record` 上建测试专用 trigger，限定到用例 tenant、lead 和一种记录形态，
在用例拆掉它之前拒绝每一次匹配的写入：沿用 FG9b 的形态，用 MyISAM 表
`fg10c_fire` 计数，每次拒绝恰好点火三次（store 客户端的有界重试）。子 agent 被扣住，
直到 lead 自己的 Turn 结束，之后才布防 trigger 并放开子 agent。所以这次拒绝锁存的是
一个空闲的 lead，并且发生在子 Turn 完成之后，绝不跨越运行中的 workflow Turn
（决策 3）；之后用例拆掉 trigger 并冷启动 Harness。

| 用例                      | 注入                                                                                           | 期望                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result-revision-refused` | 在子 Turn 完成之后，拒绝把 lead 的 `child_run` 记录更新到结果 revision（revision 4）           | 点火三次；子 Turn 读到 `COMPLETED`。锁存期间记录停在 revision 3 `running`，绝不被静默推进；没有通知、没有唤醒，也没有已接受的 `CHILD_RESULT` 行。拆掉 trigger 并冷重启之后（新的 writer generation 持有 lead），relay 的重试让记录只结算一次、整条流程走完：`assertOneWorkflowInstance` 的每条期望都成立，整个用例只有一次 `agent()` 派发，脚本没有重跑 |
| `notification-refused`    | 在子运行完成之后，拒绝 lead 上 `child_acceptance` 记录的插入，即连同通知输入一起落地的那次提交 | 点火三次。锁存期间记录已结算（结果已提交），但投递状态绝不读到 `consumed`；没有通知、没有唤醒，也没有已接受的 `CHILD_RESULT` 行 —— 欠着的通知在记录里看得见。治愈之后恰好一份通知、一次唤醒轮，`assertOneWorkflowInstance` 的每条期望都成立                                                                                                             |

### FG10e —— 取消（第 2 片，已交付）

取消是 lead 上的公开任务取消（`POST /v1/agents/sessions/{lead}/tasks/{taskId}/cancel`，
任务 id 为 `task_` 加上该 `child_run` 的 record key）。在飞窗口是脚本化模型处被扣住的
`agent()` 请求，直到用例读到取消的结果之后才放开。被扣住的请求是一条活的流：响应头
立即发出，之后每 250 ms 写一条 SSE 注释。运行结算为 `cancelled` 并不说明子 agent 停了
—— sandbox 的中止竞速会在派发仍在飞时就结算运行 —— 所以用例有自己的见证：在扣留仍未
放开时，keepalive 写入失败。只有亲自中止了子 agent 请求的 Harness 才会造成这种失败。

| 用例                        | 注入                                                                                         | 期望                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-subagent-in-flight` | 在 `agent()` 请求被扣住时取消 workflow 任务                                                  | 返回 202，随后子 Turn 结束为 `CANCELLED`，记录结算为 `cancelled` / `stop_requested`。一个 `TASK_CANCEL` 操作，该 key 下只有一行受理。被取消的记录下不留任何仍在运行的东西：被扣住的 `agent()` 请求在扣留期间就被中止，派发次数保持为一，没有任何回答进入子 journal。没有通知、没有唤醒：`CHILD_RESULT` 的接收状态绝不读到 `accepted`。任务视图读到 `cancelled` |
| `cancel-reply-lost`         | 同一窗口，取消的 POST 经过挡在公开 API 前的 proxy，提交后其应答被丢弃；客户端以同一 key 重发 | 丢失的那次 POST 在客户端失败，丢弃被见证一次。重发对同一任务返回 202 `replayed: true`，`cancel-subagent-in-flight` 的每条期望都成立 —— 仍是一个 `TASK_CANCEL` 操作、该 key 下一行受理                                                                                                                                                                          |
| `cancel-after-settlement`   | 取消一个运行早已完成并被消费的 workflow 任务                                                 | 409 `task_action_unavailable`。没有 `TASK_CANCEL` 操作；记录的 revision 不变；`assertOneWorkflowInstance` 的每条期望仍然成立（一份通知、一次唤醒轮）                                                                                                                                                                                                           |

落地时记录的机制说明：

- 通知就是 `child_acceptance` 记录自己的那次提交：它的第一个 revision 在携带通知输入的
  同一事务里插入（开放问题 2）。
- 被拒的 relay 写入会锁存 lead（FG9b 的机制）；relay 按退避持续重驱，直到冷重启重新
  加载 lead，然后从已提交状态继续。
- 任务取消把幂等键记在 `ma_operation` 里它的 `TASK_CANCEL` 受理行上（不同于 FG9d 的
  会话事件取消，那个写 `ma_request_receipt`），所以"一份请求回执"就是该 key 下的一行
  受理。
- workflow Turn 通过两条路径响应停止：交给 `WorkflowRunner.start` 的 Turn 中止信号，
  以及调用 `handle.abort()` 的中止监听（`hosted-workflow-turn.ts:261-278`）。任一路径
  单独都能停下这次运行。
- 运行的停止只经由交给 `createProductionDispatch` 的运行控制器信号
  （`workflow-runner.ts:519-523`）到达在飞的 `agent()` 派发。没有它，运行照样结算为
  `cancelled`、子 Turn 照样为 `CANCELLED`，之后放开的回答也无处落地；只有"请求被中止"
  这个见证能区分两者（变异 9）。
- #14456（第 1 片评审期间合入）改了 `TaskCancelCoordinator` 对停放行的对账；这些用例
  驱动的在线取消路径在它之上全绿。

### FG10d —— 进程崩溃（第 3 片，已交付）

在 lead 自己的 Turn 结算之后、运行处于 **attached** 状态时（记录读到
`running_attached`），SIGKILL 打包 Harness，并在同一端口上冷启动一个新的。两个窗口：

- 运行的 `agent()` 请求被扣在模型处。它被中止（keepalive 写入失败，即 FG10e 的
  见证），说明 kill 把在飞的子 agent 一并带走了；
- 运行的工作已经做完（回答已在子 journal 里），子 Turn 的结算提交在 store 处被吞掉、
  从不转发，所以 kill 落在这次提交离开网络之前。这种吞掉是 a+d 设计中
  "观察到结算即 kill"的确定性形式。

| 用例                                         | 注入                                                                                                            | 期望                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill-mid-workflow-subagents-in-flight`      | 在运行的 `agent()` 请求被扣住时 SIGKILL Harness；冷启动一个新的                                                 | kill 中止了被扣住的请求。没有 Harness 运行期间，没有任何东西结算这个 Turn。重启之后 Turn 保持 `RUNNING`，带 `hosted_workflow_recovery_blocked` 标记，从未结算；重启后的 Harness 对子 Session 的加载回答 `hosted_turn_recovery_required`。记录结算为 `recovery_blocked` / `outcome_unknown` / `runtime_lost`，没有停止原因、没有结果，其 `definitionDigest` 仍是脚本的 sha256。绝不重新执行：一次 `agent()` 派发，子 journal 里没有回答，也没有任何 Turn 结果读作 `completed`。`CHILD_RESULT` 行读到 `unknown/pending/pending`，流程的 ledger 行为 `unknown`。lead 收到一条 `<status>blocked</status>` 通知，其结果行说明运行被恢复阻断（结果未知），由一次唤醒轮读取 |
| `kill-after-last-subagent-before-settlement` | 让子 agent 作答，在 store 处吞掉子 Turn 的 `settleTurn` 提交；Harness 等待这次提交时 SIGKILL 它；冷启动一个新的 | 吞掉被见证一次，被吞的命令从未被转发。运行的回答在子 journal 里恰好一次，并保持如此。`kill-mid-workflow-subagents-in-flight` 的其余每条期望都成立：已经完成的工作不会被当作已观察到的结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

落地时记录的机制说明：

- coordinator 对子 Turn 的在飞驱动随 Harness 一起失败，按退避重试（1、2、4、8 s）。
  针对冷 Harness 的第一次驱动走恢复路径（Session 已绑定）。重启后的 Harness 的
  takeover 加载先撞上已死的 writer（`managed_session_writer_conflict`），随后以
  `hosted_turn_recovery_required` / `takeover_unrecovered` 拒绝，coordinator 的
  takeover 拒绝分支把 Turn 停放为阻断。relay 在下一次扫描时结算记录，两个窗口下都在
  重启后约 20 s。这个原因是机制事实，不是期望（决策 4）；门禁断言的是拒绝本身和标记。
- 拒绝之前，takeover 先把子 journal 里的 Turn 关闭为中断（`cancelled` /
  `harness_interruption`，一个 journal 事实），而托管的 Turn 行保持 `RUNNING` 并带
  标记。这次提交是一个新命令，绝不是被吞掉的那个。
- 被阻断的后台子运行要给 parent 一条通知（`settleRecoveryBlocked` 随记录一起提交它，
  并踢醒空闲的 lead），所以 FG10d 期望恰好一条通知、一次唤醒，而不是没有。
- 重启之后 relay 是这条流程唯一的写入者：lead 本身空闲，按需重载。

**随门禁修复的问题。** 最初几次运行时，门禁在两个生产缺陷上变红。两者都在 #14461
新增的诚实结算路径里，第 3 片修复了它们：

1. **close debt 改写了流程的归类。** 本夹具的 host 无法关闭 Workspace Session，所以
   每个结算分支都会保留一笔 close debt。`ChildResultRelayStore.advance(close_debt)`
   不管该分支证明了什么，都把流程写成 `done`、把 `CHILD_RESULT` 行写成 `delivered`。
   于是凡是 close 不能立即受理的地方，恢复阻断分支（#14461）和 relay 放弃链路想要的
   `unknown`，都读成了一个已投递的结果。现在 debt 以流程自己的归类停放
   （`retainCloseDebt`），与已关闭分支的 `classify` 完全一致。单测钉住了两种归类
   （`ChildResultRelayStoreTest`），以及阻断分支传入的是 `unknown`
   （`ChildResultRelayTest`）。
2. **阻断通知描述的是运行中的 revision。** `settleRecoveryBlocked` 用它所替换的记录
   生成 parent 的通知，所以在 `<status>blocked</status>` 之下，结果行写着
   "Workflow child run running (unknown)."。现在它用自己提交的阻断 revision 生成，
   由 `hosted-child-agent-session.test.ts` 里的一条单测钉住。

评审发现了第三个，修复 1 扩大了它的范围：

3. **`unknown` 的子启动永久扣住父 Session 的资源回收。**
   `SessionResourceCollectionCollector` 在 `CHILD_SESSION_START` 流程不是 `done` 或
   `orphaned` 时扣住已退役父 Session 的资源。但 `unknown` 同样是终态：relay 的发现查询
   和 claim 都排除它，也没有任何代码会再改写它。所以凡是 close 能立即受理的地方，
   `unknown` 流程都会无释放口地扣住回收，而修复 1 又把这个扣住带到了没有 close 能力的
   host 上。现在 collector 把 `unknown` 当作终态。欠下的 close 走它自己的
   `CHILD_SESSION_CLOSE` 行，不读父 Session 的任何资源，所以和以前一样也不扣住回收。
   `SessionResourceCollectionCollectorTest` 对三种归类钉住了扣住与释放。

## 夹具设计

**形态。** `HostedWorkflowRelayFaultGatesIT` 是 FG9 类的夹具，按一个父 Session 加
一个子 Session 重新裁剪：

- 每个字母一个 in-JVM `ManagedAgentServerApplication`，MySQL 属性必填，Spring 与
  内嵌 broker 使用临时端口、启动后读回；
- 打包的 Harness 使用预选端口，日志在重启之间追加；
- 每个用例一个全新 tenant、一个预置的 workspace，以及一个经
  `insertInternalTeamLeadSessionCommand` 和公开输入路由创建的 team lead。

**脚本化模型。** 它识别三种请求：lead 的请求（带用例标记）；唤醒轮的请求（同一
标记，历史里带着通知）；子 agent 的请求（看系统提示）。lead 的计划是带用例脚本的
`workflow` 调用，然后以文本收尾。子 agent 回答一段固定文本；在 FG10e 和 FG10f 中则
停在用例的闩锁上，作为在飞见证。脚本都是纯 ASCII，含一次 `agent()` 调用，用例断言
它返回的结果文本。

**proxy。** store proxy 挡在每个 Session（lead 和子 Session）的 Session-Store 边界
前。它的规则按提交 operation 和 command id 里的 child_run revision 布防；日志现在
在 operation 和状态码旁边记下每次提交的 command id，以区分重放和新的一步。FG10b 与
FG10f 运行时把 Harness 请求超时设为 3 s，这样超过它被扣住的应答比 relay 的调用活得
更久。另一个实例挡在公开 API 前，用于 FG10e 的取消应答丢失。

**拒绝与重启**（第 2 片）沿用 FG9b 的 `refuse`/`dropRefusals`、点火表，以及带
writer generation 见证的 `restartHarness`，只在子 Turn 结算之后使用。

**kill**（第 3 片）复用 `killHarness`，即 `restartHarness` 的 kill 那一半。store proxy
新增 `SWALLOW` 处置：从不转发，被释放后回 503。proxy 在它唯一的 dispatcher 线程上
执行每个 handler，所以一次吞掉（和扣住一样）在等待期间会让所有 store 流量停滞。
因此 FG10d 一确认 kill 就释放它，赶在冷 Harness 需要 store 之前；这时的 503 只会打到
一个已关闭的连接上。

**CI。** 类名把它放进 `hosted-harness-mysql` 车道（`Hosted*IT`；
`check-failsafe-reports.js hosted` 强制它必须跑过），已有的 `hosted-workflow-gates`
profile 用于本地运行。每片重新推导共享 fork 预算时，都要把自己实测的开销与期间
兄弟轮次的改动**叠加**，绝不覆盖那个字面值（#14420 评审的教训），并在
`scripts/tests/hosted-process-ci.test.js` 里补上 per-class 上限断言。
`target/fg10-cases/` 已在上传的报告路径里。

第 1 片在本地重测三次，本类健康用时 81.6–81.7 s（FG10b 约 44 s、FG10f 约 38 s），
与 FG10a 一样按 2× 预算约 165 s。叠加到 FG9 第 3 片（#14420）之后 main 的配额上：
3380 + 165 ≈ 3545 s。一个 600 s 上限加上它，需要至少 4145 s 的 fork，于是 fork
3990→4155 s。Verify 步骤要在其 600 s 之外包住 fork，改为 80→85 分钟（余量 345 s；
80 分钟只剩 45 s）。job 上限 325→330，以保持在各 step 上限之和（315）加未设上限
的准备步骤之上。此后每字母余量只剩 10 s（600 + 3545 = 4145，对 4155），所以在同一个类
上的第 2 片要重新测量整个类，并以同样方式叠加自己的开销，而不是沿用第 1 片的数字。

第 2 片在本地重测三次，四字母全类健康用时 181.2–181.6 s（FG10c 约 64 s、FG10e 约 47 s，
第 1 片的字母不变），按同样的 2× 预算约 363 s，比第 1 片的 165 s 多 198 s。叠加到第 1 片
之后 main 的配额上：3545 + 198 ≈ 3743 s。一个 600 s 上限加上它需要至少 4343 s 的 fork，
于是 fork 4155→4353 s。Verify 步骤 85→90 分钟（余量 447 s；85 分钟只剩 147 s），job 上限
330→335，以保持在各 step 上限之和（320）加未设上限的准备步骤之上。

第 3 片在本地三次运行中重新测得五字母类健康时长 246.1–246.8 s（FG10d 约 65 s，其余
字母不变），按同样的 2× 预算约 494 s，比第 2 片的 363 s 多 131 s。叠加到第 2 片之后
main 的配额上：3743 + 131 = 3874 s。一个 600 s 上限加上它，需要至少 4474 s 的 fork，
于是 fork 4353→4484 s。Verify 步骤的 90 分钟仍能包住 fork 加其 600 s（余量 316 s），
所以 Verify 步骤和 job 上限（#14467 把 failover 用例挪进独立 job 之后为 185）保持不变。

## 变异检查

每个变异先应用、证明恰好让其用例变红、再还原。Harness 侧的变异原地修补打包 bundle
的 chunk，并逐字节还原；Java 侧的变异修补源码。

第 1 片，每个只对其目标用例运行（`-Dqwen.fg10b.case` / `-Dqwen.fg10f.case`）：

1. FG10b —— 相同的 `dispatch_started` 重述变成冲突，而不是被解决（去掉
   `dispatchStarted` 的 no-op 分支）：`dispatch-reply` 红；重驱的 dispatch 永远失败，
   记录永远离不开 `running`。
2. FG10b —— store 客户端重试时铸出新的事务身份：`child-message-reply` 红；重放的
   消息被当作排在已落地那次之后的新事务而遭拒，流程永远走不完。
3. FG10b —— relay 重新提交一个已结算的结果，Harness 也把它当作新的结算（同时去掉
   `settledAlready` 的结果分支和 `settleCompleted` 的重放检查）：`result-reply` 红；
   第二个终态 revision 被拒，记录永远离不开 `accepting`。单独去掉任何一层在这里都是
   等价变异。
4. FG10f —— 重驱的 acceptance 既不检查，也不按其 run 取键（去掉 `accept` 的重放
   检查，并让它的 command id 每次调用都加盐）：`notification-reply` 红。记录契约仍会
   拒绝第二次 acceptance，所以不会落地第二份通知，但 relay 永远不会归类它的台账行。
   单独做其中任何一个改动都是等价变异。
5. FG10f —— 公开 `Last-Event-ID` 游标少读一位：`child-stream-resume` 红，续传边界
   出现一处重复。

第 2 片，每个只对其目标用例运行（`-Dqwen.fg10c.case` / `-Dqwen.fg10e.case`）：

6. FG10c —— store 恢复后，被 defer 的 relay 步骤不再重试（退避失控到一天）：
   `result-revision-refused` 红。拆掉 trigger 之后没有任何东西重驱被拒的那一步，
   所以没有新的 writer 接管 lead，流程永远恢复不了。两个更窄的变异在这里是等价的：
   - Harness 把被拒的结果提交答成已提交：relay 的下一步撞上已锁存的 lead，重启后它对账
     发现记录仍在 revision 3，自己提交结果；
   - relay 在第一次失败时就放弃（attempt 上限被压到一）：放弃链路按已提交的事实（子 Turn
     已完成）结算，落地的是同一个结果。
7. FG10c —— Harness 把被拒的 acceptance 答成已提交：`notification-refused` 红；relay
   继续往下走，流程永远到不了 `consumed`。
8. FG10e —— 子运行的停止到不了进程内运行（交给 `WorkflowRunner.start` 的中止信号和
   `handle.abort()` 监听都被去掉）：`cancel-subagent-in-flight` 红；子 Turn 永远离不开
   `CANCELLING`。任一路径单独都能停下运行。
9. FG10e —— 运行的停止没有转发给它的 `agent()` 派发（交给 `createProductionDispatch`
   的是一个新信号而不是运行控制器的信号；workflow 自身的取消完好）：
   `cancel-subagent-in-flight` 红在"请求被中止"见证上。运行照样先结算为 `cancelled`、
   子 Turn 照样为 `CANCELLED`，所以没有这个见证时该用例是绿的。
10. FG10e —— 任务取消的请求摘要在重试间不稳定（每次调用带 nonce）：`cancel-reply-lost`
    红；重发的取消返回 409，而不是重放已提交的受理。
11. FG10e —— 已结算的任务仍然提供并受理取消（把 `completed` 加进可取消状态）：
    `cancel-after-settlement` 红；取消被以 202 受理，而不是 409 `task_action_unavailable`。

第 3 片，每个只对其用例运行（`-Dqwen.fg10d.case`）；Harness 侧的变异原地修补
打包 bundle 的 chunk 并逐字节还原，其余修补 Java 源码：

12. FG10d —— coordinator 不再识别 workflow Turn（`isWorkflowLaunchTurn` 恒为
    false），#14461 的每个拒绝分支都失效：`kill-mid-workflow-subagents-in-flight`
    红在标记上。takeover 的拒绝让这次驱动停留在通用重试路径上（到用例放弃时已重试
    五次），Turn 从未被停放，记录也从未结算。
13. FG10d —— relay 忽略 Turn 行上的恢复阻断标记：
    `kill-mid-workflow-subagents-in-flight` 红；Turn 被停放并带标记，但记录停在
    `running`。
14. FG10d —— close debt 把每条流程都写成 `done`（撤掉第 3 片的 relay 修复）：
    `kill-after-last-subagent-before-settlement` 红在 ledger 上，其 `CHILD_RESULT`
    行读到 `delivered/pending/pending`。
15. FG10d —— 阻断通知用它所替换的运行中 revision 生成（撤掉第 3 片的 Harness 修复）：
    `kill-after-last-subagent-before-settlement` 红在通知上，其结果行写着
    "Workflow child run running (unknown)."。

两处修复的单测在撤掉对应修复后都会变红：relay 一侧是
`ChildResultRelayStoreTest.retainsACloseDebtUnderTheWalksOwnClassification`，以及
`ChildResultRelayTest` 里的 `aBlockedRunWithoutCloseRetainsTheDebtUnderUnknown`、
`aGiveUpWithoutCloseSupportRetainsItsCloseDebt`（放弃分支改传 `done` 时变红）和
`aHostWithoutCloseSettlesAndRetainsTheCloseDebt`；Harness 一侧是
`hosted-child-agent-session.test.ts` 里的
`tells a background child's parent the run is blocked, not running`；collector 一侧是
`SessionResourceCollectionCollectorTest.aChildStartHoldsCollectionOnlyUntilTheRelayClassifiesIt`
（其 `unknown` 用例）。

## 验证与验收

- 新类在本地 MySQL 8.4 上全绿，每片连续三次全类运行，每个用例的故障都有见证；按
  字母的选择子可用。
- 每片的变异各自单独变红，源码还原后门禁复绿。
- 模块 `mvn verify`（surefire、Checkstyle、SpotBugs）以及 workflow/pom 元测试，在
  叠加后的预算下全绿。
- 本设计随第 1 片以中英文落地；每片都在 #14165 上记录其字母。
- 第 3 片的三处修复连同各自的单测一起交付，每条单测都在撤掉对应修复后被证明会变红。

## 开放问题

1. 第 1 片已解决：lead 的唤醒 Turn 不投影，子 Session 的 workflow Turn 会投影，所以
   FG10f 切断子 Session 的流（见 FG10f 的机制说明）。
2. 第 2 片已解决：`acceptChildResult` 在一个事务里插入 `child_acceptance` 记录和通知
   输入，所以 FG10c 的 `notification-refused` trigger 拒绝的就是这次插入。
3. kind 门禁在每次 revision 提交时的重查，即 a+d 设计的开放问题 1。这些门禁断言
   每个 revision 上 `kind` 都是 `workflow`。它们无法断言重查本身：kind 全程都是启用
   的，没有任何故障能在运行中途把它禁用。重查仍由 `managed-session-authority.ts` 的
   功能测试负责。
