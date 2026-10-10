# Managed session message 运行时(H4d-b)

[English](2026-10-10-managed-session-message-runtime.md) | [简体中文](2026-10-10-managed-session-message-runtime.zh-CN.md)

状态:已在本变更中实现。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4d** 切片中运行时那一半,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段,由 [#13744](https://github.com/QwenLM/qwen-code/issues/13744) 跟踪。它生产 [H4d-a 契约](2026-10-09-managed-session-messages.zh-CN.md) 固定下来的记录:managed `send_message` 工具、控制面的消息 relay、投递边界、消费、已完成 child 的复活,以及启用。凡是消息会改变"child 何时算完成"的地方,它修订 H4b 的 [child Session 运行时](2026-10-07-managed-child-session-runtime.zh-CN.md)。下文"契约"指 H4d-a 设计,"自动化设计"指 #12827 所固定提交上的 [automation、Channels 与 child 投递设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md) 第 5.1 节。

## 问题与范围

H4d-a 让投递所需的每个事实都成为已提交的记录,并在两种语言中给出提交时规则;由于没有生产者,两项能力都保持禁用。本切片就是这些生产者:

- **managed `send_message` 工具**,位于 Hosted 的 Shell 车道:父向它启动的 child 任务发消息(`task_id`),child 向它的父发消息(`to: "parent"`)。运行中的 child 收到消息,已完成的 child 得到续跑,其他结局得到具名拒绝(契约的后续工作行)。
- **`managed-agent-server` 中的消息 relay**:认领、目标解析、带 input 与 wake 的回执、推进发送方,以及崩溃恢复。
- 读取回执的 turn 结算后对回执的**消费**,以及发送方对应的最后一步。
- **复活**:续跑启动一个新的 child Session,并带上其链的历史。
- **契约为本切片列出的义务**:H4b 的完成判据必须考虑未投递与未消费的消息;Hosted 恢复白名单必须放行 `session_message`;续跑要经过 launch 准入;无论 child 是否已完成,发送都适用同一个上限。
- `session_message` 与续跑的**启用**。

## 现状

以下事实来自 `main` 的 `ba8615f4c4`。

- **记录。** `managed-session_message` 已在 TypeScript 与 Java 中登记并校验,但不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中;`MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED` 为 `false`。`childContinuationBody` 已存在,但无人调用。
- **Hosted turn。** 私有 Hosted profile 不声明 `send_message`;未声明的工具在准入时被拒绝。Agent 工具存在于 Shell 车道(`hosted-workspace-shell/1..2`),受 `child_agent` kind 门禁控制。
- **Wake pump。** 通知类 input(`monitor`、`automation`、`child_agent`、`channel`)在 Session 空闲时作为 wake turn 运行;wake turn 是 Hosted 内部的,永远不会成为 API Turn(`managed_agent_turn`),所以它的输出只出现在该 Session 自己的 journal 中。
- **H4b relay。** `ChildResultRelay` 依据 child 最新的 API Turn 结算它,随后关闭它。排在该 Turn 之后投递的消息会在结算之后才运行,其结果丢失,而 child 的关闭也会与它竞争。
- **恢复。** `verifyWorkspaceRestore` 会拒绝持有白名单之外 domain 的 `domain.committed` 的 journal,而白名单中没有 `session_message`。
- **Java。** 没有任何 worker 读取 `session_message` 行;V54 的 `(domain, delivery_state)` 索引已存在。Flyway 处于 V60。

## 决策

1. **一个工具、两种形式,沿血缘发送。** `send_message` 有父形式(`task_id`、`message`)与子形式(`to: "parent"`、`message`)。Session 在可以启动 child 的地方(Shell 车道的根,受 `child_agent` kind 门禁控制)声明父形式,在其定义记录了血缘的地方声明子形式。二者都位于 `session_message` domain 门禁之后。team 收件方属于 H4e,具名 peer 属于以后的路由(契约决策 2);它们的参数以具名范围拒绝。该工具不需要 Runtime:只含消息的批次不占用 Workspace 挂载,也不做 Broker 预留,与 Agent launch 完全一样。
2. **父方的路由在它的 child funnel 写入链上决定。** `task_id` 指向任意一代的 child run;路由沿其链走到链头,即最新的、未被证明从未启动的续跑(契约决策 9 会释放这样的前驱)。尚未结束的链头收到消息;以 `completed` 结束且从未请求停止的链头被续跑;请求过停止或以其他方式结束的链头被具名拒绝。决定及其提交与 H4b 的结算运行在同一条写入链上,所以一条消息要么在 run 结算之前开启(随后挡住该结算,见决策 8),要么发现 run 已结束而成为续跑。被重新驱动的调用会按证据比较并重放已提交的消息或续跑,绝不会路由两次。
3. **两条路径共用一个发送上限。** 发往某个任务的消息,必须能放入以该任务自己的 launch 描述与定义构造的续跑 launch 信封(≤ 32 KiB,即 H4b 的信封上限),无论链头在运行还是已完成。该信封不依赖任何后来的状态,所以 child 的状态永远不会改变答复。child 发往父的消息受 64 KiB 内容上限约束。在每条边的每个方向上,发送方同时在途的消息(尚未交接,即 `planned` 或 `accepting`;消息一经交接即离开该计数,无论读取它的 turn 是否完成,所以失败的 turn 永远不会卡住这条边)至多 8 条,总共至多发送 64 条,这限定了 relay 要轮询的量,也限定了父子之间来回发消息的代价;正在关闭的父不再发送消息。拒绝是工具错误,且不提交任何东西。
4. **身份由发送方生成,且重放稳定。** `messageId` 为 `msg_` 加上 `sha256(senderSessionId | turnId | callId)` 的 32 个十六进制字符:跨 Session 唯一(契约决策 1),且被重新驱动的调用得到同一个值。续跑的 `childRunId` 就是 Agent launch 会使用的那个调用键。在目标中承载消息的 input 与 wake turn 为 `<messageId>:message`;发送方拒绝把其他任何 id 当作承载 input。
5. **消息 relay 位于 `managed-agent-server`,受它自己的 ledger 约束。** `SessionMessageRelay` 分页处理两类工作:仍欠交接的 `session_message` 行(`planned`、`accepting` 或 `unknown`;只有 outbox 条目会进入这些状态,所以 V54 索引服务于该扫描),以及条目已交接、正等待被读取的 ledger 行——后者按 ledger 自己的 `(state, next_retry_at)` 索引分页,所以永远不会再变化的条目不消耗任何代价,等待中的条目也不会把新的交接挤出页面。V64 新增 `qwen_managed_session_message_relay`:每个已认领的 outbox 条目一行,记录认领租约、退避与持久分类;另加一个 `(tenant_id, session_id, domain)` 索引,服务于下文的按 Session 读取。每一步都依据条目当前已提交的投递状态与正文作决定,绝不依据分页时的快照,并依据两个 journal 的已提交记录对账:
   - **交接。** 此时固定目标(契约决策 4):`to_child` 取该 run 所 attach 的 Session,run 尚未 attach 时持有,attach 之后仍持有到 Harness 准入了 child 的任务为止(run 在其 Runtime 绑定一出现就 attach,早于任务的提交;更早送达的消息会唤醒一个没有任务的 turn,并让任务撞上忙碌的 Session;任务未获准入就已结束时,改为取消该条目,因为已没有任务可供它跟随;唯一的例外是准入尚未得到证实时被取消的任务,它会沿用 attach 的 epoch,因此其消息会交接给一个本来就要结束的任务);`to_parent` 取发送方血缘行所记录的父。交接前 run 已结束或正在被停止,或目标已不再活跃,则取消该条目(`planned → cancelled`,从未交出)。否则发送方提交带目标的 `planned → accepting`。
   - **回执。** relay 把发送方的内容字节复制给目标,目标发布自己的副本,按发送方的摘要校验它,并在同一事务中提交回执及其 input 与 wake(契约决策 6)。重投递会重放已提交的回执。父方对其 run 尚未 attach 的 child 消息以 `session_message_not_ready` 作答,relay 持有该消息。目标规则的拒绝(`session_message_record` 或 `session_message_conflict`)会拒绝该条目(`accepting → rejected`);目标 store 的故障以 `503 session_message_failed` 作答并重试,绝不拒绝。已经提交的回执直接跳到发送方的那一步。回执准入一条 input 并唤醒一个 turn,`consume` 也可能重新加载目标、让其 wake pump 运行一个 turn,所以两者都走与 submit 或 automation fire 相同的 Workspace 准入;发送方自己的那几步只是 journal 写入。每个动词都通过 Turn 使用的接管加载重新 attach 由更早的控制面进程 attach 的 Session,因为 ledger 比那个进程活得久。
   - **接受与消费。** 发送方提交带 input id 的 `accepting → accepted`。等待期间,relay 请目标对账其回执(`consume`,见决策 7);一旦回执为 `consumed`,发送方提交 `accepted → consumed`。读取回执的 turn 未完成就结束时,等待结束,条目停留在 `accepted`。
   - **分类。** 目标收到条目之前就正在关闭或已不存在的发送方不再得到任何东西,该行为 `orphaned`。失败 64 次的步骤会放弃:relay 先在发送方结束该条目——从未交接的为 `cancelled`,回执已存在的为 `accepted`,否则为 `unknown`——让任何地方都不再把它读作仍欠交接,然后才把该行分类为 `unknown`(发送方那一步失败时,放弃仍欠着并重试)。这两种分类都绝不会被呈现为已投递。目标已收到的条目在任一侧于消费前关闭时为 `done`:发送方的条目保持已提交的样子(`accepted`,或发送方在回执与它自己那一步之间关闭时的 `accepting`),目标的回执才是消费的事实依据。H4b 会在 child 结算后立即关闭它,所以 child 发往父的消息通常以这种方式结束。
6. **投递边界是目标的 wake pump,只基于已提交的 input(契约开放问题 2)。** 消息等待目标当前的 turn 结束,并以带契约决策 7 有界通知文本的独立 wake turn 运行。它的 input 在 journal 中,所以能在 Runtime 被回收、Harness 被替换后存活。轮中投递仍是非目标。
7. **消费跟随 wake turn 的真实结算。** 消息的 wake turn 以 `completed` 结算时,目标提交其回执 `accepted → consumed`。以其他方式结束的 turn 让回执停留在 `accepted`:这是欠下的证据,绝不扩大(H4b 决策 6)。relay 的 `consume` 对账停留在 accepted 的回执:其 turn 以 `completed` 结算时提交 consumed(turn 之后的那次提交可能已丢失),尚未结算时回答尚未就绪,turn 以其他方式结束时拒绝。该调用也经过 Harness 的 attachment,所以被替换的 Harness 已不再持有的 Session 会被重新加载,其 wake pump 会运行等待中的 input。关闭的 Session 会像取消其他 wake input 一样取消其待处理的消息 input。关闭一旦开始,消息路由就像 channel 与 automation 路由一样以 `409 hosted_session_closing` 拒绝每个动词,而关闭会先等已通过该检查的操作结束,再取消待处理的 input,因此不会有回执落在那一遍之后;relay 会重试被拒绝的那一步。
8. **消息结束了,child 才算结束(修订 H4b 决策 8)。** child 最新的 API Turn 终止后,relay 先读 child 的 journal,再读边:向父发消息的 turn 会在结算之前提交那条 outbox 条目,所以在 journal 之后读取的边不会漏掉已结算 turn 发出的任何消息。只有当 journal 中没有已投递、仍在等待读取它的 turn 的消息(其他 wake input——Monitor 的、automation 的——既不阻挡也不决定),且边上没有仍欠交接的消息(`planned` 或 `accepting`:父发往该 run 的,以及 child 仍处于活动状态时发出的每一条——已关闭 child 的条目被分类为 orphaned,永远不会再移动)时,relay 才结算。child 在 journal 读取之后才收到的父消息,从未被那次读取看到处于等待状态,所以边的读取会指明每条已收到消息的 input,对 journal 读取未见过的任何一条,relay 都会再次观察。不持有任何会话消息的 child 的 journal 永远不会被读取:那里没有运行过消息 turn。等待其 turn 的消息只在 child 的 journal 30 分钟内提交过除租约续期之外的任何事件时阻挡结算(运行中的 turn 会随进度提交其模型尝试、工具步骤与消息,而常驻 Session 无论做什么都会续租),所以被阻塞的 child 无法永远阻挡它;超过这段时间 child 失败(`child_failed`),绝不依据更早 turn 的结果结算,那会把这条消息报告成已被处理。在繁忙的共享挂载后排队这么久的消息 turn 也以同样方式失败。child 的结果是其最新的已结算 API 或消息 turn——完成与失败都一样:最后运行的是消息 wake turn 时,从 child 自己的 journal 读取(该 turn 最新的 assistant 记录,分块存储的 body 按字节拼接),否则仍是 H4b 的 API Turn 结果,不变。以其他方式结束的消息 wake turn 即使在更早的 API Turn 已完成之后也会让 child 失败:父的消息要的就是那个 turn 的工作,交回更早的结果会把这条消息报告成已被处理。持有消息的 child 的 journal 被压缩时无法证明其 turn,会被拒绝,绝不猜测。结算会指明 relay 读取时父发往该 run 的消息数(`commit_result` 与 relay 的 `fail` 上的 `messageCount`):只要有一条仍欠交接,或消息数多于 relay 所见,父就以 `409 child_messages_pending` 拒绝,这封住了 relay 读取与提交之间的窗口;relay 随后再次观察,不消耗尝试次数。已提交的结算绝不重新计算:acceptance 跟随已提交的结果,已提交的失败只欠关闭。在失败分支中,child 在 fail 提交之前关闭(H4b 的顺序),所以在这个窗口中开启的消息会被取消而不是被读取。活动 child 自己仍欠交接的 outbox 条目会挡住它的关闭,所以它在结算读取之后(由后来的 wake turn)发出的消息会先到达父。消息 relay 的放弃为 child 自己条目上的这两处挡板都设了上界:ledger 行已被分类或已超过尝试上限的条目不再阻挡,即使放弃自己那一步发送方提交在一个无法再接受任何 revision 的 child 上(恢复被拒)无法落地也是如此。放弃不指明消息数,也永不被阻挡。
9. **复活启动一个带链历史的新 child Session(契约开放问题 1)。** 续跑是新的链节点,有自己的 child Session 与血缘边,所以契约的血缘规则成立。它的第一条输入由 relay 依据父方的已提交记录组成:每个更早 run 的指令(launch 信封的 prompt)与结果(父方的结果副本),由旧到新,然后是新指令。更早的指令与结果作为数据经过 XML 转义后放进历史的标记中,所以任何更早的结果都无法闭合其块,也无法伪造下一条指令。组合受 Hosted prompt 上限约束(48 KiB 的 JSON 文本),超出时先略去最旧的 run;若最新的更早 run 单独都放不下,则带标记截断其文本。它只读取已提交记录,所以重放的创建给出同一条输入,创建保持幂等。这里携带的是父方看到的对话,而不是 child 的工具历史:transcript 导入(带恢复证明的 `history_copy`)需要 authority 尚不支持的 header 级导入,属于后续工作。
10. **发送方关闭时的 outbox 保持已提交的样子(契约开放问题 3)。** 生命周期门禁继续在关闭声明下拒绝 `session_message`;relay 把正在关闭的发送方的条目分类为 `orphaned`。没有任何东西在 journal 内取消它们,也没有任何东西投递它们。被 H4f 停止的 run 以同样的方式关闭其 child(决策 15)。
11. **relay 在记录之外证明了什么(契约开放问题 5)。** input 的文本绑定目标自己的副本,目标在提交之前按发送方的摘要校验该副本;回执以 `messageId` 与摘要指名发送方的消息;父方接受来自其 run 已结束的 child 的消息,所以结束之前发出的消息仍能到达。
12. **审批与预览。** `send_message` 在 Agent 工具需要审批的模式下同样请求审批,并在两种语言中加入封闭的输入预览集合(`HOSTED_INPUT_PREVIEW_TOOLS`、Java `PREVIEW_TOOLS`),所以审批卡片会显示正在批准的消息。
13. **启用,server 优先。** `session_message` 加入 `MANAGED_SESSION_ENABLED_DOMAINS`,续跑门禁打开。Java store 自 H4d-a 发布起就校验二者,relay 与写入方在同一个版本中发布,所以 H1–H4c 的 server 优先顺序成立:不运行该 relay 的 server 永远不会遇到生产这些记录的写入方。
14. **不改公开契约。** OpenAPI 契约、其路由与 `contract-known-gaps.txt` 都不变。新的 Hosted 路由 `POST /session/:id/messages/operations` 是控制面与 `qwen serve` 之间的私有路由,与 H4b 的 `/children/operations` 相同。V64 是唯一的迁移。
15. **被停止的 run 连同其 child 的消息工作一起停止(H4f)。** H4f 的停止分支依据 child 的 API Turn 作决定,但消息 turn 从不成为 API Turn(决策 8),所以对持有 session message 的 child,它还会读取该 child 的 journal。只要还有消息 input 在等待或运行,停止就向 child 的消息路由发送 `stop`:此后 child 的 wake pump 不再启动它的任何消息 input,运行中的消息 turn 被中止(由它自己的结束结算为 cancelled),等到没有 turn 在运行时,等待中的消息 input 以 `stop_requested` 结算为 cancelled,其间 Session 像关闭时一样被占住。本控制面已不再持有的 child,会在加载时就带上停止(被动加载上的 `stopMessages`),所以连这次加载触发的第一轮也不会启动任何消息 input。该加载与已持久化的取消一样,由停止分支读到的已提交停止请求授权,只校验 Session 自身的绑定:消息工作不会留下 `CANCELLING` 的 Turn,事后变更的授权也不能撤销一次停止。停止先于停止分支对 Turn 的取消发出,因为后者自己的加载不会带上停止;在停止仍在结算 child 的消息工作期间,消息 relay 也不会为该 child 的任何步骤 attach 它:其中的 consume 对账与 child 自己的 outbox 步骤都会等待。一旦不再欠消息工作,它们就继续进行,因为这时加载不会启动任何东西,而自然结算可能正在等待 child 的 outbox。在更早进程中崩溃的消息 turn 不是等待中的 input;wake pump 不会再为已停止的 Session 挑选它,由停止执行其善后。停止分支在心跳时重复发送 `stop`,只有在不再欠任何东西时才结算该 run;正在等待恢复或正在关闭的 child 会拒绝 `stop`,这不消耗尝试次数;在决策 8 的 30 分钟上限内没有 turn 接手的消息 input 不再挡住停止,于是 run 得以结算,剩下的由 child 的关闭取消。胜过停止的自然结果,是决策 8 所说的最新已结算 turn(API 或消息):先完成的消息 turn 交付其结果,自行失败的以 `child_failed` 结算,被取消的则归于停止。中止失败而进入恢复的消息 turn(其工具的取消失败)会以 error 结算,run 随之以 `child_failed` 结算:journal 中没有任何东西能把这种结束与 child 自身的失败区分开。停止之前已交接、尚未收到的消息会被拒绝而不是被收下(`accepting → rejected`),正如交接本就会取消仍处于 planned 的消息,所以不会唤醒一个正在离开的 child。停止关闭 child 时不经过其自身 outbox 的关闭挡板:与任何正在关闭的发送方一样(决策 10),其仍欠交接的条目会成为 orphaned,所以 child 发往父的最后几条消息会随取消一起丢失。
16. **被中断的 `send_message` 按其已提交的内容作答。** 与 team 调用或后台启动一样,`send_message` 在作答之前只写入 journal。每条结算或恢复被中断 turn 的路由(包括停放轮的补答)都依据记录回答它:outbox 条目答为已排队投递,续跑答为已续跑;在恢复该 turn 的路由上,什么都没提交的答为从未运行。模型永远不会再次发送已提交的消息,恢复的那一轮也是完整的。

## 流水线

父发往运行中 child 的一条消息:

| 步骤 | Journal | 提交                                                                     | 执行者             |
| ---- | ------- | ------------------------------------------------------------------------ | ------------------ |
| 1    | 父      | outbound `planned`,目标未定                                              | `send_message`     |
| 2    | 父      | outbound `accepting`,目标 = 该 run 所 attach 的 child,在其任务获准入之后 | relay(交接)        |
| 3    | child   | inbound `accepted` + input + wake                                        | relay(receive)     |
| 4    | 父      | outbound `accepted`,`inputId`                                            | relay              |
| 5    | child   | wake turn 运行并结算;inbound `consumed`                                  | child 的 wake pump |
| 6    | 父      | outbound `consumed`                                                      | relay              |
| 7    | 父      | child run 依据 child 最新的 turn 结算(决策 8)                            | H4b relay          |

child 发往父的消息走同样的步骤,只是两个 journal 互换;其第 2 步从 child 的血缘取得目标,父方的第 3 步等到该 run attach 之后。发往已完成 child 的消息则是一次续跑 launch:第 1 步提交一个指名前驱的 `child_run`,由 H4b 的流水线以决策 9 组成的第一条输入运行它。

## 上限

| 上限                  | 取值                                          | 拒绝方式                      |
| --------------------- | --------------------------------------------- | ----------------------------- |
| 发往 child 任务的消息 | 能放入该任务的续跑信封(≤ 32 KiB)              | 工具错误,`byte_limit`         |
| 发往父的消息          | ≤ 64 KiB UTF-8                                | 工具错误                      |
| 每条边在途的消息      | 每个方向 8 条(尚未交接)                       | 工具错误,`count_limit`        |
| 每个 child run 的消息 | 每个方向 64 条                                | 工具错误,`budget_exhausted`   |
| 等待消息 turn         | child journal 30 分钟无租约续期以外的任何事件 | child 失败,`child_failed`     |
| 承载通知              | 序列化后 ≤ 48 KiB,先转义再带标记截断          | 截断,绝不拒绝                 |
| 续跑的第一条输入      | ≤ 48 KiB 的 JSON 文本;略去最旧的 run          | 截断,绝不拒绝                 |
| 每条消息的 relay 尝试 | 64 次,带退避                                  | ledger `unknown`,绝不二次投递 |
| 续跑的 launch 准入    | H4b/H4c:关闭中、活跃上限 4、launch 预算 64    | 指名原因的工具错误            |

## 非目标

- team 收件方与 mailbox(H4e,[#13745](https://github.com/QwenLM/qwen-code/issues/13745))、血缘之外的具名 peer(契约决策 2),以及轮中投递。
- 续跑的 transcript 导入(决策 9)。
- `queryChildRun`,契约规定不实现它。
- 任何公开契约变更,以及对 Legacy `send_message` 的任何改动。

## 涉及文件

- `packages/core/src/managed-runtime/managed-session-message-operations.ts`(新增):消息 id 与每个修订体。
- `packages/core/src/managed-runtime/managed-session-records.ts`:启用 `session_message` 与续跑。
- `packages/cli/src/serve/hosted-child-agent-session.ts`:父方路由(`sendToChild`)、链头、结算挡板、共用的有界通知构造器。
- `packages/cli/src/serve/hosted-session-message-session.ts`(新增):child 的发送、relay 的发送方与目标方动词、消费、通知文本。
- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`:两个 `send_message` 声明及其准入与执行。
- `packages/cli/src/serve/hosted-harness-session.ts`:funnel 接线、wake 来源、wake turn 之后的消费、关闭时的结算、恢复白名单,以及 `/messages/operations` 路由。
- `packages/sdk-java/qwencode`:`HostedHarnessClient.runMessageOperation`。
- `packages/sdk-java/managed-agent-server`:`V64__managed_session_message_relay.sql`、`SessionMessageRelayStore`、`SessionMessageRelay`、其调度器、`HarnessConnector.runMessageOperation`、`ChildResultRelay` 中的完成判据与续跑组合、`ChildResultRelayStore` 中的 journal 读取,以及 `PREVIEW_TOOLS`。
- 两种语言中各文件旁的测试;两种语言的本设计;H4d-a 与 H4b 设计中的指引。

## 验证

- **TypeScript。** funnel 测试套件驱动两个真实的 managed Session:outbox 条目及其重放、结算挡板、续跑及其信封与链头、从未启动的续跑释放其前驱、每种具名拒绝、上限以及在途与每 run 的限额、每个 relay 步骤及其步骤感知、只提交一次的带 input 与 wake 的回执、摘要校验、血缘校验、指向未知 run 的回执在发布任何东西之前即被拒绝、消费及其对账(`consume`),以及结算的 `messageCount` 水位。tool-turn 测试套件覆盖两个声明、参数拒绝、两条路由,以及不占用任何挂载。Hosted 测试套件重新打开一个 journal 中持有 child 消息的 Session,运行其 wake turn 并消费它,并映射该路由的各种拒绝,包括 `child_messages_pending` 以及以可重试 503 作答的 store 故障;关闭开始后以 `hosted_session_closing` 拒绝消息,而关闭会等已通过该检查的回执完成,使该回执的 input 与其他待处理 input 一起被取消;其 `stop` 中止运行中的消息 turn,不让等待中的消息 input 启动(带着停止的加载所触发的第一轮也不例外),并在没有 turn 运行时以 `stop_requested` 结算它们。恢复测试套件依据被中断的 `send_message` 已提交的内容作答(发往 child、发往父、续跑,以及停放轮的补答),在恢复该 turn 的地方把什么都没提交的答为从未运行。H4d-a 的门禁测试现在固定门禁为打开,并通过 mock 关闭它们,以固定 authority 在发布任何东西之前先检查门禁。
- **Java。** relay 测试套件让一条消息走完交接、回执与接受,以及 attach 之前与任务获准入之前的持有、任务未获准入即结束时消息的取消、已结束、正在停止或不活跃目标的取消、子到父的路由、not-ready 持有、拒绝、重试的 store 故障、绝不投递没有目标的正文、重放的回执、消费对账(已读取、尚未读取、以其他方式结束)、已关闭发送方的 orphaned 与已投递两种分类,先在发送方结束条目的放弃(该步失败时仍欠着),发往已停止 run 的已交接消息被拒绝,以及以带停止的被动加载载入其 Session 的消息停止。H4b relay 测试套件增加完成判据:边上的持有、journal 的持有及其上限、依据消息 turn 结算(完成与未完成)、结算上的 `messageCount`、父方的 `child_messages_pending` 否决、不重新计算即接受已提交的结果、续跑组合及其上限与转义,以及 H4f 停止分支对消息 turn 的处理(在 run 结算前停止,已取消的任务仍等待其所欠的消息,先完成或先失败的消息 turn 作为自然结果,被取消的归于停止,被拒绝的 `stop` 不消耗尝试次数,以及 30 分钟上限)。H2 store 测试套件覆盖两种分页与租约、ledger 推进丢失的已接受条目、边计数与不可读的正文、血缘读取、journal 读取(只计消息 input、活动时间、最新已结算 API 或消息 turn、assistant 文本、在字符中间切开的分块 body),以及被压缩 journal 的拒绝。`WorkspaceMigrationMySqlIT` 的已应用版本列表加入 V64。
- **所有既有测试套件保持通过**:H1–H4c 与 H4d-a 的契约重放、authority、store、tool-turn 与生命周期测试套件,以及完整的 `managed-agent-server` surefire 测试套件。

## 验收标准

- 父发往运行中 child 的消息恰好送达一次,即使 relay 重启也如此,且 child 的结果反映读取了它的那个 turn。
- child 发往父的消息恰好送达一次,在 run attach 之前被持有。
- 发往已完成 child 的消息把它续跑为一个新 run,其第一条输入携带链的历史;失败或已取消的 child 被具名拒绝。
- accepted 与 consumed 在两侧都可见,各自指名所依据的 input;没有完成的 turn 不会消费任何东西。
- 正在关闭的发送方的消息永远不会被投递;child 永远不会在仍有发给它的消息欠着时被结算。
- 两道门禁都已打开,恢复白名单放行 `session_message`,公开契约不变。

## 开放问题

1. **续跑的 transcript 导入。** 复活是否应通过带恢复证明的 header 级导入复制前驱的完整 transcript(包括工具调用),还是保持决策 9 的有界"指令与结果"历史。
2. **发往忙碌前台父的消息。** 前台 child 发往正等待其结果的父的消息会立即被接受,并在父的 turn 之后才被读取,而那时父已收到结果。是否应改为拒绝前台 child 的 `send_message`,留待产品证据决定。
3. **与回执竞争的放弃。** relay 放弃一条已交接的消息时,若其 receive 已超时但仍在目标中运行,回执可能在发送方提交 `unknown` 之后才落地。契约允许 `unknown → accepted`,但 relay 已分类该行且不会再访问它,所以目标读取了消息而发送方停留在 `unknown`。这需要第 64 次尝试恰好与一次在途的 receive 重合;ledger 是否应为迟到的回执复查 `unknown` 行仍然开放:H4f 的运维处置(其决策 7)只覆盖 child-run ledger。

## 后续工作

| 切片    | 范围                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------- |
| H4e     | team 与 mailbox;`send_message` 的 team 路由。                                                       |
| Unknown | 被分类为 `unknown` 的消息 ledger 行的运维处置(开放问题 3);H4f 的处置只覆盖 child-run ledger。       |
| 导入    | 续跑的 transcript 导入(开放问题 1)。                                                                |
| Peer    | 血缘之外的具名 peer,及其授权证明与路由值。                                                          |
| 规模    | 为每次结算的边读取设上界(按 resource id 缓存 body),并让已分类的 outbox 条目离开交接扫描的索引范围。 |
