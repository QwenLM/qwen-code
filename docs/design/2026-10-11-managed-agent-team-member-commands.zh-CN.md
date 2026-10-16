# Managed agent 团队:成员命令、计划审批与 shutdown(H4e-b3)

[English](2026-10-11-managed-agent-team-member-commands.md) | [简体中文](2026-10-11-managed-agent-team-member-commands.zh-CN.md)

状态:设计。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4e** 中第三个、也是最后一个运行时切片,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段,由 [#13745](https://github.com/QwenLM/qwen-code/issues/13745) 跟踪。

它建立在以下工作之上:

- H4e-a:[团队记录契约](2026-10-10-managed-agent-teams.zh-CN.md),#13811;
- H4e-b1:[lead 一侧的团队运行时](2026-10-10-managed-agent-team-lead-runtime.zh-CN.md),#13824,由 #13846 启用;
- H4e-b2:[lead 的 mailbox](2026-10-11-managed-agent-team-mailbox.zh-CN.md),#13879 与 #13892;
- H4d-b:[Session 消息运行时](2026-10-10-managed-session-message-runtime.zh-CN.md),#13822;
- H4b:child Session 与[前台 child 等待](2026-10-09-foreground-child-wait-continuation.zh-CN.md)。

它回答 H4e-b2 的开放问题 1 及其决策 8,以及 H4e-a 留给"H4e-b"的事项:`team_plan_approval`、`request_shutdown`、旧团队导入与启用。一份设计覆盖整个切片;实现按决策 13 的四个批次落地。

## 问题与范围

H4e-b2 之后,Hosted 团队的 lead 可以启动具名成员、维护任务板、按名字给任一成员或一次给全体成员发消息,并续跑已完成的成员。一切都由 lead 发起。成员对它的团队只能做一件事:用 H4d-b 发往 `"parent"` 的 `send_message` 给它的父发消息,这条消息作为 lead 的下一条输入到达。成员不能:

- 读取或修改团队的任务板;
- 给另一个成员发消息;
- 递交计划,并在行动前等待 leader 的批准。

lead 也无法停止它不再需要的成员:有成员运行时 `team_delete` 拒绝,而 lead 的模型没有办法停止成员(用户的 H4f 取消与关闭级联可以)。

Legacy 团队这四项都有。本切片把它们带到 Hosted 团队。成员对任务板的读写、它发给另一个成员的消息,以及它的计划递交,都是请 lead 的 journal 代它行事,而目前没有任何东西能承载这样的请求:

- 没有任何路由能让一个 Session 的工具调用在另一个 Session 的 journal 中提交;
- 每个跨 Session 的效果都是一条持久记录,由 Java relay 经私有 Harness 路由驱动到另一个 Session 中;
- H4d-b 的 `to_parent` 条目不是合适的载体,因为它的回执会提交一条唤醒 lead 模型的 input,而任务板读取必须在没有这样一条 input 的情况下作答。

因此本切片为这些调用建一条成员到 lead 的**命令通道**。计划的决定与 shutdown 不需要命令:lead 作用于它自己的 child,正如 H4e-b2 的续跑与 H4f 的停止已经做的那样。

## 现状

- **团队记录。** lead 的 journal 持有全部团队记录:`team_state`(名册与生命周期)、`team_task`(任务板),以及处于关闭状态的 `team_message` 与 `team_plan`。每个修订都是 lead 的 `trusted_entry` 提交。成员的 journal 一条也不持有,这仅仅是因为团队工具只在 child depth 为 0 时声明。
- **身份。** 成员就是它的续跑链(H4e-b2 决策 2):名册指向链上的第一个 run,成员的状态就是其链头的状态。lead 经由链根找到一个 run 所属的成员,lead 一侧关于成员的每条记录都指向 lead 自己 `child_run` domain 中的一个 run。
- **成员的视角。** 成员的 Session 有血缘(`parentSessionId`、`parentChildRunId`),没有团队记录。它只能从前言得知自己的名字与团队,前言位于其链上每个 run 的指令开头(H4e-b2 决策 5)。run 的首条输入由 Java 拼装:launch 的首条输入是 `[description]`、一个空行与 launch 提示词;续跑的首条输入是它的历史(其中每条较早的指令与结果都经过 XML 转义),然后是 `Your next instruction:` 与新指令。description 是 lead 自己的文本,不经转义。因此,除去 description 中可能含有的内容,run 自己的前言是其首条输入中唯一未转义的前言。历史保留每个较早 run 的指令与最终答复,不保留它的工具调用。
- **Session 消息。** H4d-b 的 relay 每 2 秒扫描一次 outbound 条目,逐条交接,让目标接收,再把回执记录回发送方。它的 ledger(`qwen_managed_session_message_relay`,V64)以发送方 Session 与记录 id 为键,没有 domain 列,它的查询在 SQL 中写死了 `session_message` domain。
- **让调用停放等待另一个 Session。** 只有 H4b 的前台 child 等待这样做,并能在重启后存活:父提交一个 `await_agent` checkpoint,轮询自己的 journal,由 child result relay 把答复提交到这个 journal 中。它依赖两条拒绝:只含 agent 调用的批次不占用 Workspace 挂载,而持有挂载的 Turn 不得在前台等待,因为持有共享 Workspace 挂载的等待可能与它所等待的 Session 死锁。
- **等待与截止时间。** API Turn 在其 30 分钟截止时间到达时以 `deadline_exceeded` 结束,随后 child result relay 把它的 run 结算为 `child_failed`:该成员就此永久结束。消息(wake)回合没有截止时间;在欠着一条消息 input 期间,journal 已 30 分钟没有任何事件的 child 会被 relay 判为失败。
- **Action。** 目前 D6 Action 只是 `tool_call` 权限票据。Java 的 action store 拒绝其他任何来源,公开的 `ActionSource` 与 `PermissionAction` 形状也不适合计划请求(#13785 的 A1 点)。
- **Plan mode。** Hosted Session 没有 plan mode:审批模式是 `yolo`、`default` 与 `auto-edit`,`plan` 被拒绝,也没有 `exit_plan_mode`。`plan_mode_required` 在 Agent 准入时被拒绝,H4e-b1 的加入写入 `planModeRequired: false`。封闭的 domain 索引登记了 `plan_mode`,但没有记录体,也没有规则。
- **停止。** 用户的 H4f 任务取消与关闭级联,会在 lead journal 中的 child run 上提交 `stopRequested`。lead 处于活跃状态时,child result relay 的停止分支会处理任何已提交的停止:它停止 child 的消息回合,取消其 Turn,并结算该 run。lead 的模型无法请求停止。

## 决策

1. **一条命令通道,一个新 domain `session_command`。**
   - **为何要新 domain。** `session_message` v1 已启用,它有封闭的键集合、封闭的 `route` 枚举,以及一条规则:inbound 回执开启时恰好带着唤醒其目标的那条 input。命令有回复而没有 input。扩展 v1 还会让命令受制于消息预算、child result relay 的消息规则(Session 消息会让它读取成员的整个 journal,欠着的消息会挡住成员的结算与关闭),以及 `receive` 的 Workspace 准入。封闭的 domain 索引以前也接纳过新增项(`file_history`、`session_source`、`monitor_run`)。
   - **每次写入两条记录。** 成员 journal 中的一条 **outbound** 命令,以及(对会改变任何东西的命令)lead journal 中的一条 **inbound** 回执,二者使用同一个 `commandId`:

     | 键                        | Outbound(成员)                                                                 | Inbound(lead)                         |
     | ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
     | `commandId`               | `cmd_` + `sha256(senderSessionId \0 promptKey \0 callId)` 的 32 个十六进制字符 | 相同                                  |
     | `direction`               | `outbound`                                                                     | `inbound`                             |
     | `route`                   | `to_parent`,唯一取值                                                           | `to_parent`                           |
     | `kind`                    | `board_read`、`board_write`、`member_message`、`plan_submit`                   | 相同,但绝不是 `board_read`            |
     | `childRunId`              | 成员自己的 run,取自其血缘                                                      | 成员 Session 所 attach 的 lead 的 run |
     | `senderSessionId`         | 成员                                                                           | 成员                                  |
     | `targetSessionId`         | 在交接时设置一次                                                               | lead                                  |
     | `argsRef`、`argsDigest`   | 调用的参数,≤ 64 KiB                                                            | 相同的摘要                            |
     | `replyRef`、`replyDigest` | 在 `accepted` 修订上设置一次                                                   | 开启时设置                            |

     `promptKey` 是成员 Turn 的 prompt id,按 H4e-b2 调用键的方式折叠,因此该 id 重放稳定。

   - **回复。** 回复是一个小 JSON 文档:`{ "outcome": "answered" | "refused", "text": "…" }`。`answered` 是调用的结果;`refused` 以工具错误结束调用。拒绝仍然是回复:只有 lead 完全无法接受的记录(血缘或摘要不匹配)才是 `rejected`。回复从不携带 Harness 据以行动的决定;计划的决定作为指令传递(决策 9)。
   - **投递状态线。** 两者都使用共享的扩展投递状态:
     - outbound:`planned` → `accepting`(已交接)→ `accepted`(回复随之复制回来)→ `consumed`(调用已读取它);或者 `cancelled`(在交接前被撤回或放弃)、`rejected`(lead 拒绝了该记录)与 `unknown`(relay 在交接后放弃,且没有回复);
     - inbound:以 `consumed` 开启并带着回复,因为 lead 当即就知道回复。
   - **没有 input。** 任何 `session_command` 记录都不携带 input,也不唤醒模型。
   - **身份。** Java 的记录规则对照成员的血缘检查它的 outbound,与 H4d-b 对 `to_parent` 的做法一样;TypeScript funnel 写入它从成员定义中读到的血缘 run。两种语言都检查 lead 的 inbound 指向 lead 自己 `child_run` domain 中、由发送方 attach 的一个 run。lead 的团队 funnel 随后经由链根与开启中团队的名册,把该 run 映射到一个成员。命令从不在其参数中指名它的成员。

2. **relay 就是 H4d-b 的 relay,让它感知新 domain。**
   - **发现**读取两个 domain。ledger 保留它的键(发送方 Session,记录 id);`cmd_` id 永远不会与 `msg_`、`msgb_` 或 `msgc_` id 相撞,因此不需要迁移。写死 `session_message` 的 SQL 改为以 domain 为参数,V54 的(domain,投递状态)索引已经覆盖该扫描。
   - **每条命令走一遍:**
     1. 成员上的 `handover` 固定目标(血缘中的父),并把 outbound 条目移到 `accepting`;
     2. lead 上的 `execute` 运行该命令(决策 3),并在响应中返回它的回复。对会改变任何东西的命令,它此前已先提交 inbound 回执。Harness 客户端与 connector 的消息操作返回该响应体;目前它们什么也不返回;
     3. 成员上的 `answered` 提交带回复的 `accepted`。成员的调用读取回复时再提交 `consumed`(决策 4)。
   - **一个发送方,一次一条命令。** relay 按提交顺序交接并执行一个发送方 Session 的命令;同一发送方较早的一条命令尚未完成时(它的 outbound 为 `planned` 或 `accepting`,无论它是否已有 ledger 行),不接手该发送方的任何命令。outbound 为 `accepted`、`consumed`、`cancelled`、`rejected` 或 `unknown` 的命令已完成,无论它的 ledger 行如何;命令处理流程从不执行它发现为 `unknown` 的条目,只对其 ledger 行做分类。因此重试的命令永远不会落到更晚的命令之后,而在较早命令等待期间超时的更晚调用,会发现自己的条目仍为 `planned` 并取消它(决策 4)。
   - **没有等待步骤。** `execute` 返回时每个回复都已知。停留在 `accepted` 的命令条目对 relay 而言已经完成:它的派发从不把命令送到 H4d-b 的 `consume` 步骤。
   - **失败。**
     - lead 拒绝该记录(血缘、摘要)时,outbound 变为 `rejected`。路由以它自己的错误码答复这种拒绝,relay 只把这个错误码映射为 `rejected`;消息路由的通用冲突答复从不被当作这种拒绝。
     - 成员的 Session 在交接前正在关闭或已不存在时,ledger 行为 `orphaned`,与消息相同;outbound 停留在 `planned`,它的调用已随其 Turn 结束。
     - 64 次尝试后 relay 放弃。交接前放弃时,outbound 变为 `cancelled`,与 H4d-b 的放弃一样。交接后放弃时,若 lead 持有回执,放弃会像 `answered` 那样复制它的回复;否则 outbound 变为 `unknown`。
     - 在 `execute` 已提交任何东西之后遇到的、lead 的 authority 作出的确定性拒绝,是其回复的一部分(决策 3),绝不是 relay 会重试的错误。
     - 每一步都凭命令 id 保证重放安全,正如 H4d-b 的各步凭消息 id 保证。
   - **关闭挡板。** 欠着的命令从不挡住成员的结算或关闭:child result relay 对欠交接 outbox 的检查只读取 `session_message`,并保持如此。
   - **延迟。** 一条命令需要 relay 走一遍:一次扫描延迟(2 秒)与三次 Harness 调用。在 outbound 提交时立即触发一次(kick),就像 `ActionResponseCoordinator.dispatch` 那样,可以消除扫描延迟;这留给开放问题 2。

3. **lead 在它的 funnel 上执行命令,从不在它的模型中执行。**
   - **在哪里。** `execute` 在 lead 的 Harness 上运行,不经模型回合。connector 像对 `receive` 那样加载 lead,而加载一个未 attach 的 lead 会启动它的 wake pump,后者可能运行 lead 已欠着的 input;`execute` 本身不启动任何东西。lead 因恢复而被阻塞或正在关闭时,它像 `receive` 一样被拒绝,由 relay 重试。没有哪种类型需要 lead 的新工作准入:`execute` 不启动 Turn,也不改变任何 Workspace。成员消息的投递在收件方一侧采用 H4d-b 自己的准入。
   - **检查顺序。** `execute`:
     1. 若 lead 已为该命令提交回执,就返回该回执的回复;
     2. 否则查找已在该 `commandId` 下提交的一切:以从它派生的命令 id 提交的任务板写入(H4e-b1 的已提交命令查询)、`requestId` 为该 `commandId` 的 `team_plan`、在该 `commandId` 下对该成员较早的等待中计划所做的取消,以及每个名册位置的 `msgc_` 消息。找到的 `team_plan` 按其现状答复该递交,不做取代;找到取消而没有其新 `team_plan` 时,不再次运行准入即完成该递交。其余任务板写入按成员规则与任务板当前的状态重新检查;仍然成立的那些被提交,答复说明哪些已提交、哪些没有。其余成员消息按决策 8 发送;
     3. 否则把命令作为新命令准入:发送的 run 必须是开启中团队某个成员的链头,正在运行,且未请求停止。否则回复为 `refused`:
        - 对任何开启中团队都未列出的 run,回复 `This Session is not a member of an open team.`,这包括在其命令等待期间团队被删除的成员;
        - 对不是其成员链头、已结算或正在停止的 run,回复 `Your run has ended or is being stopped; it takes no more team commands.`。
   - **计划取代的部分提交恢复。** 只有键为 `supersede:<commandId>:<oldRequestId>` 的精确 `withdrawTeamPlan` 回执可以绕过新 run 准入。替代计划的修订号为被取消计划的修订号加一，而不是恢复时的最大修订号。如果另一提交已经占用该修订号或更高修订号，恢复回复旧提交已被取代并给出新请求标识，不开启竞争计划，也不取消任何计划；inbound 命令回执保存该结果。否则，即使原 run 已结算，也开启欠下的计划。新提交保留初始及撤回前的链头检查；取消一旦提交，run 结算不得使欠下的后继计划变成拒绝。域回滚不授权新写入：缺失后继计划时，命令保持可重试且不写入 refused 回执，直到重新启用。现有 authority 约束仍要求团队为 active 且成员需要计划模式。
   - **读取不提交任何东西。** `board_read` 自己检查发送方的血缘与 attach,因为没有记录规则做这件事,然后返回任务板当前的状态。它不提交回执:它不改变任何东西,重新运行时可能以更新的任务板作答。只有成员的 journal 保留它的回复。
   - **funnel 之间的顺序。** 团队 funnel 与 child funnel 各有一条写入链,任一方都从不在自己的链内等待另一方(H4e-b2 决策 10)。`execute` 在团队链上读取并校验,离开它,然后才为消息调用 child funnel(决策 8)。任务板写入在团队链上运行,位于 lead 自己的两次调用之间,从不在某次调用的中途。
   - **正在关闭的团队**遵循 H4e-b1:团队关闭期间 `task_create` 被拒绝,`task_update` 被允许。`plan_submit` 被拒绝,因为 `team_plan` 只在 active 的团队中开启。
   - **面向成员的文本。** 每个回复都对成员说话。lead 的提示与 owner 规则拒绝都是写给 lead 的,它们都不会原样到达成员。

4. **成员的调用停放到回复到达为止,且为时很短。**
   - **停放。** 在含有命令调用的批次的第一个调用运行之前,Turn 先提交一个新的 checkpoint 阶段 `await_command`,写明该批次的每个命令调用及其命令 id。随后每个命令调用提交它的 outbound 条目,并轮询自己的 journal 等待该条目的回复,正如 `await_agent` 等待 child 的 acceptance。等待读取 journal 时不占用成员的 funnel 链,relay 的 `handover` 与 `answered` 就在这条链上提交。
   - **被中断的批次。** 在批次任意位置被中断的 Turn 都会找到该 checkpoint。没有 outbound 条目的命令调用答为未发送;有条目的按决策 14 作答;批次中的其他调用(发往 `"parent"` 的 `send_message`)从 journal 补齐,正如前台等待的停放轮次那样。因此批次中没有任何调用会把它的 Turn 困在 `model_output_committed`。
   - **取消与停止。** 取消路由与被中断回合的流程像结算 `await_agent` Turn 那样结算 `await_command` Turn,按已提交的内容答复每个调用,因此对停放在命令上的成员执行 H4f 停止或 `request_shutdown`,会结束它的 Turn。
   - **checkpoint。** `await_command` 携带一个形如 `agentWait` 的 `commandWait` 组:每个调用一项,包括 `commandId`、function call id、工具名、模型消息 id,以及回复是否已折回;另外还记录 Turn 是否持有 Workspace 挂载。null 组不编码,与 `agentWait` 一样。该阶段加入 TypeScript 与 qwencode Harness 恢复线路中的封闭阶段列表,恢复线路把它报告为已知结果;Java 的 `HarnessCoordinator` 与 `ToolPublicationStore` 要针对新阶段做审计,前台 child 等待设计把这一点列为需要留意的漂移。不认识该阶段的 Harness 把这样的 checkpoint 读作 `checkpoint_blocked`。
   - **批次。** 命令调用只与其他命令调用,以及只在成员自己 journal 中提交的调用(发往 `"parent"` 的 `send_message`)共享批次。把命令调用与 Workspace 或 Runtime 调用混在一起的批次,在任何东西运行之前就被拒绝,正如 H4b 拒绝与非 agent 调用并列的前台 agent。因此命令批次自己不占用挂载,它的审批在它运行之前就已解决。它的命令调用按调用顺序一个接一个停放,因此写入在下一个调用读取之前就已得到答复。
   - **挂载。** 在更早的批次中取得 Workspace 挂载的 Turn,在命令停放期间仍持有它。这不会死锁:`execute` 从不占用挂载,也从不等待成员。checkpoint 表明 Turn 持有 Runtime 租约时,恢复的等待会取回该租约,使 Turn 结束时释放它。
   - **上限。** 等待在 outbound 提交后 2 分钟结束,远在 Turn 截止时间与 relay 的无活动上限之内,或在成员被 H4f 停止时结束。一个 Turn 的某个命令调用一旦超时,该 Turn 之后的每个命令调用都会立即被拒绝(`The leader is not answering; end your turn.`),因此 Turn 永远不会在一连串等待中一直持有挂载。Turn 中是否已有调用超时,从该 Turn 自己的 journal 读取,因此恢复的 Turn 仍保持该拒绝。
   - **超时。** 超时的调用若其 outbound 条目仍为 `planned`,就取消该条目,并把调用答为未发送。若条目已交接,答复说明命令已到达 leader、回复没有到达,且写入可能已生效:模型结束它的回合并在结果中说明这一点,之后的回合或 leader 在重复写入之前先读取任务板。调用结束后才到达的回复永远不会被读取;它所描述的写入依然有效。relay 按发送方的顺序(决策 2)让该写入排在该成员之后的任何命令之前。

5. **成员从前言得知自己的工具;由 lead 决定。**
   - 成员 Session 不持有团队记录,因此它的 Harness 读取 run 的首条输入;只有带血缘的 Session 才这样做,因此根 Session 的用户提示词永远不会使其成为成员。当该输入的指令部分以一段格式正确的成员前言块开头时,run 声明成员工具(决策 6):这与 H4e-b2 决策 5 的重放使用同样的格式检查,对 launch 施加在 `[description]` 及其空行之后,对续跑施加在 `Your next instruction:` 之后。续跑历史中较早的指令经过转义,因此只有 run 自己的前言算数。plan-mode 属性的读取范围更宽(决策 9):任何带有它的未转义块都会限制该 run。没有前言的 run(包括 `team_delete` 之后被续跑的前成员)不声明任何成员工具。
   - 声明只是一种便利,而不是授权:lead 依据链头与名册答复每条命令(决策 3)。提示词恰好带有前言形状块的普通 child 会得到这些工具,并被告知它不是成员。
   - **门禁。** 只有 `session_command` 已启用时才声明成员工具;`exit_plan_mode` 还需要 `team_plan`,并且只在处于 plan mode 的 run 中声明(决策 9)。
   - **前言的措辞跟随成员能做什么**,而不是跟随交付它的批次:`session_command` 启用后,它不再说成员不能编辑任务板;构建带有成员消息(b3c)且 `session_command` 已启用后,它不再说成员不能给其他成员发消息。
   - **plan-mode 属性。** 开始标签接受一个可选的 `plan-mode="required"` 属性,此时正文说明成员在 leader 批准其计划之前处于 plan mode;按格式要求,正文从不包含 `<`。b3a 先于使用交付放宽的格式检查、plan mode 拒绝,以及决策 9 在拼装成员前言的两处(具名 launch 与续跑)所用的拼装规则;它们都不需要命令通道。b3d 之前没有成员能被要求 plan mode,因此没有任何东西写入该属性。从 b3d 回滚到任何带有 b3a 且仍能加载该会话的构建时(见决策 13 中 plan mode 的下限),要求 plan mode 的成员都保持在 plan mode(fail-closed),在构建再次带上 b3d 之前没有 `exit_plan_mode` 可以离开它;在这样的构建中,plan mode 拒绝说明该 run 只能读取,且不提及 `exit_plan_mode`。不带 b3a 的构建会忽略该属性,因此决策 13 把 b3a 定为下限,低于它就不再保持 plan mode。

6. **成员的任务板工具。** 它们都是命令,它们的答复就是回复。

   | 工具          | 类型          | 参数                                                     | 答复                          |
   | ------------- | ------------- | -------------------------------------------------------- | ----------------------------- |
   | `task_list`   | `board_read`  | 与 H4e-b1 相同:可选的 `status`、`owner`、`blockedBy`     | 任务板,以及名册中的名字与状态 |
   | `task_create` | `board_write` | `subject`、`description`,可选的 `activeForm`、`metadata` | 新任务的编号                  |
   | `task_update` | `board_write` | `taskId` 与 H4e-b1 的字段                                | 修订后的任务,或拒绝           |
   - **成员看到什么。** 成员的 `task_list` 显示任务板(带任务编号)以及每个成员的名字与状态,不带成员的 child task id(`task_…`)、lead 的提示,也不带任何计划。
   - **成员作为撰写者的规则**,来自 Legacy:
     - 它只能在自己拥有或没有 owner 的任务上修改状态、owner、subject 与 description;
     - 它只能给自己拥有或没有 owner 的任务添加 `addBlockedBy` 边;`addBlocks` 会写入它指名的每个任务,因此这些任务也都必须是它自己的或没有 owner。Hosted 只在被阻塞的任务上存储边(H4e-a 决策 5),Legacy 只检查被更新的任务,因此这条规则有意比 Legacy 更严:成员从不写入另一个成员持有的任务;
     - 它可以在任何任务上设置 `activeForm` 与 `metadata`;
     - 它只能删除自己拥有或没有 owner 的任务;
     - 它只能把 owner 设为自己或 `""`:给另一个成员的工作以消息传递,从不以任务板写入传递(H4e-b2 决策 7);
     - 把没有 owner 的任务移到 `in_progress`,会让该成员成为它的 owner。
   - lead 的 owner 规则(H4e-b1、H4e-b2 决策 7)仍守护每次 owner 变更:以自己身份写入的成员正在运行,因此它可以拥有开放工作。
   - H4e-b1 任务板规则的其余部分都成立:编号、边、阻塞方上限、`in_progress` 需要 owner、`deleted` 冻结任务。
   - **审批。** 成员的工具调用遵循它自己 Session 的审批模式。`task_list` 保持预批准,因为它只读取其团队的任务板。`task_create` 与 `task_update` 已在两种语言的输入预览列表中(H4e-b1)。
   - **Legacy 的自动认领**不纳入:完成的成员结束它的 run,由 lead 交付下一项工作。

7. **成员发给 lead 的消息保持 H4d-b 的方式。** 发往 `"parent"` 的 `send_message` 不变。加入时保留名字 `parent`,与保留 `leader` 一样,因此不会有成员能以成员称呼其 leader 的那个词被寻址。已经名为 `parent` 的成员保留它的名字,但其他成员无法给它发消息。成员发往 `"leader"` 的 `send_message` 在本地被拒绝,并提示改用 `"parent"`。

8. **成员之间的消息经由 lead 传递,且只发给运行中的成员。**
   - **工具。** 成员的 `send_message` 接收 `to`:`"parent"`、成员名或 `"*"`。成员名或 `"*"` 会发送一条 `member_message` 命令。发送方自己的名字在本地被拒绝,早于任何发送。
   - **只发给运行中的成员。** 对每个收件方,lead 的 child funnel 采用一种新的**仅限运行中的发送**:它在自己的写入链上检查收件方的链头正在运行且未请求停止,然后提交 H4d-b 的 outbound `to_child` 条目;它从不路由到续跑。链头已完成、已结束或正在停止的收件方不会被触达,答复中它那一行会说明这一点:已完成的成员从 leader 那里获得更多工作,而不是从同伴那里。因此无论收件方的状态在团队链的检查与 child 链的提交之间如何变化,成员消息都从不启动续跑,也从不消耗 H4b 的活跃上限或 H4c 的 launch 预算。
   - **收件方。** `"*"` 表示其他每个成员;发送方与 leader 从不是收件方。不在名册上的名字在回复中被拒绝。
   - **id。** 每个收件方的消息 id 为 `msgc_` + `sha256(leadSessionId \0 commandId \0 position)` 的 32 个十六进制字符,其中 `position` 是收件方在名册中从 1 开始的位置。它既不会与 lead 调用的 id 相撞,也不会与广播的 id 相撞。每条消息都以 `commandId` 作为其 `executionCallId`,因此都不算作 lead 在它某个 Turn 中交付的工作(H4e-b2 决策 7)。重新运行的 `execute` 先探查每个位置的 `msgc_` id,与 H4e-b2 的广播恢复一样,因此第一次运行时已触达的收件方会被报告为已触达,也不会有任何东西被发送两次。
   - **收件方看到什么。** 内容以一行固定的头行 `<member-message from="alice">` 开头,然后是文本,再是 `</member-message>`。在收件方一侧,id 以 `msgc_` 开头的消息呈现为 `<from>member alice</from>`,名字取自锚定在内容开头的头行,且限于成员名字符;头行与尾行被去掉,回复提示为 `send_message with to "alice"`;处于 plan mode 的收件方则被告知改经 `"parent"` 回复。只有 lead 生成 `msgc_` id,头行中的名字是 lead 的说法,而不是发送成员的说法。
   - **收件方的结果。** H4d-b 让运行中成员对其最新消息的答复成为它的全部结果(H4e-b2 开放问题 3),这也包括成员消息。包装文本会说明这一点:先用 `send_message` 回复发送方,再完整答复 leader 的最后一条指令。
   - **上限。** 每个收件方的消息就是 H4d-b 发给运行中 child 的消息,受其续跑信封约束(≤ 32 KiB)。成员消息与 lead 自己的消息共享 H4d-b 在收件方链头上的在途 8 条与每个 run 64 条,并且每个接收方 run 至多在途 4 条、共 16 条,因此 lead 总能为自己的消息保留余量。H4e-b2 关于从未启动的说明会让 lead 再次发送一些消息,成员消息不计入其中:它们的发送方是另一个成员。
   - **答复**列出每个收件方的结果,与 H4e-b2 的广播答复一样。

9. **计划审批:成员递交,lead 的模型用工具作出决定,决定作为指令到达。**
   - **要求 plan mode 的成员。** lead 的具名 `agent` launch 接受 `plan_mode_required: true`;不具名的 launch 仍拒绝它。加入时在名册条目上记录 `planModeRequired: true`,它与每个名册条目一样永不改变。
   - **每个 run 的 plan mode 只有一条规则。** 要求 plan mode 的成员,其链上的每个 run(它的 launch,以及无论以何种方式产生的每个续跑:按名发送、按 task id 发送、广播、决定),在 lead 持有该团队中该成员已批准的计划(以团队 id 与成员名为键)之前,都在前言中带有 `plan-mode="required"`。首次批准之后,该成员之后的 run 都不再带它,正如 Legacy 的 teammate 一经批准就永久离开 plan mode。唯一的例外是批准自身的续跑,它在决定之后才拼装,因此不带该属性。这条规则位于拼装成员前言的两处,因此没有任何路由能跳过它,并在 b3a 中交付(决策 5)。
   - **plan mode 是开启中团队的规则。** 没有任何开启中团队列出的链运行时不带前言,因此也不处于 plan mode:`team_delete` 之后被续跑的前成员,以及加入从未提交、之后作为普通 child 被续跑的要求 plan mode 的 launch。launch 自己的 run 保留它 launch 时带有的属性。
   - **Hosted 上的 plan mode。** 首条输入带有未转义、含 `plan-mode="required"` 的前言的 run,在整个 run 期间都处于 plan mode。它的批次只准入 `read_file`、声明了它的搜索 profile 上的 `glob`、`task_list`、发往 `"parent"` 的 `send_message`,以及 `exit_plan_mode`;其他每个调用(包括 shell 命令与发往某个成员的 `send_message`)都在运行之前被拒绝,拒绝文本指向 `exit_plan_mode`。只读 shell 见开放问题 6。Legacy 还允许等待批准的 teammate 认领空闲任务;处于 plan mode 的 run 不向任务板写入任何东西。该属性是 lead 的决定,成员自己 journal 中的任何东西都无法解除它。
   - **递交。** `exit_plan_mode({plan})` 发送一条 `plan_submit` 命令,不等待决定。一个 run 只有一次被接受的递交:该 run 较早的一次递交仍在途中时,或在一次回复为 `answered` 的递交之后,再次调用会在本地被拒绝(`Your plan is already submitted; end your turn.`)。被答复 `refused`(例如 `byte_limit`)、在交接之前被取消或为 `rejected` 的递交未被接受,因此该 run 可以发送一份更正后的计划。lead 的 funnel:
     - 检查计划的大小(见下);
     - 取消该成员等待中的计划(如有):每个成员只有一个等待中的计划,更新的计划取代它(Legacy 则拒绝第二个待定计划);
     - 提交一个 `waiting` 的 `team_plan` 修订,`requestId` = `commandId`,`planRevision` 比该成员上一个计划多 1;
     - 答复 `Your plan was submitted as revision N. End your turn now; the leader's decision arrives as your next instruction.`
   - **计划的上限。** 决定会引用计划,因此计划经 XML 转义后,必须连同前言、决定的固定文本以及经转义的 4 KiB 反馈的余量,一起放入该成员的续跑信封(≤ 32 KiB,其中还容纳 launch 的 description 与定义)。只有 lead 知道该信封,因此由 `execute` 检查它,对更长的计划答复 `refused`,`byte_limit`。
   - **lead 从成员的结果中得知它。** 成员的 run 结算时,lead 收到的结果通知会在结果文本之前带一个 `<plan-approval-request request="…" revision="N">` 块,其中是该 run 递交的计划(若它仍在等待中),经 XML 转义。通知超出其上限时,先截断结果文本;计划块凭上面的上限放得下。lead 的 `task_list` 按成员、request id、修订号与大小列出每个等待中的计划,而带 `action: "show"` 的 `team_plan_approval` 按 request id 返回该团队任一计划的文本(无论等待中还是已决定),连同它的状态与决定;它不提交任何东西,且预批准。因此请求永远不会因上下文被压缩而丢失,也不会因递交在通知拼装之后才落地而丢失,lead 也从不盲目决定。
   - **决定。** lead 的模型调用 `team_plan_approval({request_id, action: "approve" | "reject" | "show", message?})`,反馈至多 4 KiB。被重新驱动的调用先凭该调用的 id 找到它已提交的结算与续跑。然后:
     1. 它检查决定能否送达:
        - 该计划是成员最新的且仍在等待中;已作出决定的计划答复它的决定;
        - 成员的链头已完成且未请求停止。链头运行期间,或它的续跑等待启动期间,答复为 `decide after alice's run settles`。链头已结束或在请求停止后才完成时,撤回该计划(一次写入),答复说明这一点;
        - 团队处于 active,续跑能通过其 launch 准入(H4b 的活跃上限、H4c 的 launch 预算、信封上限)。

        否则,除了上述撤回,它不提交任何东西,计划保持等待,答复说明原因以及何时再试;

     2. 它以决定与反馈结算该 `team_plan`;
     3. 它像 H4e-b2 的 `send_message` 那样,以该调用自己的 id 续跑该成员,指令引用经转义的计划与反馈:批准时,执行该计划;驳回时,修改计划并再次调用 `exit_plan_mode`。前言遵循上面的规则。

   - **已记录但未送达的决定。** 在第 2 步与第 3 步之间被中断的 Turn,或第 3 步当即被拒绝时,依据记录作答:`The decision on alice's plan revision N was recorded (approved). The call stopped before alice was continued; send her the decision with send_message, quoting the plan (team_plan_approval with action "show" returns it).` 该成员之后的任何续跑都按上面的规则遵循已记录的决定,因此在驳回之后重发永远无法解除 plan mode。若某个决定的续跑从未启动,H4e-b2 关于从未启动的说明会请 lead 再次发送该工作;对决定,它会说明要引用计划。
   - **代价。** 每个决定都会续跑成员,因此会用掉 H4c 每个 Session 64 次 launch 中的一次,用掉的 launch 永不恢复;漫长的驳回再修改循环会很快耗尽它们。一个 run 只有一次被接受的递交,因此陷入循环的模型耗用它们的速度不会快于它的 run。
   - **撤回。** 等待中的计划只在本来就会写入的路径上被取消:成员更新的递交、`team_plan_approval` 发现成员的链头已结束或在请求停止后才完成、`request_shutdown`,以及 `team_delete`。lead 的 `task_list` 只标记成员已结束的等待中计划。
   - **契约。** `team_plan.requestId` 是递交的 `commandId`,而不是 D6 Action。两种语言中 H4e-a 的文本改为这样说明;没有记录规则读取它。`team_plan` 开启时对要求 plan mode 的检查在两种语言中都已存在。D6 action 来源 `team_plan` 保持保留且无人产出。
   - **没有 D6 卡片,没有 OpenAPI 变更。** 在本切片中,用户看不到作为 Action 的计划请求;#13785 以后可以从已提交的记录投影出它们。`exit_plan_mode` 与 `team_plan_approval` 在 `default` 与 `auto-edit` 中预批准,因此 lead 的决定从不等待用户的卡片,与 Legacy 一样。两者还加入输入预览列表(该列表在两种语言中保持一致),以备某个 hook 请求审批。
   - **`plan_mode` 保持不用。** 该 domain 表示 Session 自身的 plan mode。成员的 plan mode 按 run 计,由它的前言携带。

10. **shutdown 就是 lead 请求的停止。**
    - `request_shutdown({to})` 是 lead 的工具。对链头正在运行的成员,它在链头上提交 `stopRequested`,child result relay 的停止分支随后取消成员的 Turn 并结算该 run,与用户的 H4f 取消一样。无论哪种情况,它都会撤回该成员等待中的计划。
    - **答复读取链头的状态:**
      - 运行中的成员:`alice is being stopped. Delete the team once task_list shows it ended.`;
      - 尚未启动的续跑:它可能未启动就结束,成员随后回到它的前驱,因此答复说明这一点,而不是说该成员已结束;
      - 链头已完成的成员,除非 lead 给它发送工作,否则不接收工作:答复说明这一点,链头不受影响;
      - 已在停止中或已结束的成员:答复它的状态。
    - 不征询成员。Legacy 的协作式回复到达不了 Hosted 成员:成员空闲时已经结算,而 run 中途的答复会取代它的结果。
    - **`team_delete`** 在有成员运行时(包括正在停止的成员)仍然拒绝,它的拒绝现在指向 `request_shutdown`。这取代了 H4e-b1 的"成员停止"后续工作(H4e-b2 沿用了它),在那项工作中 `team_delete` 会自己请求停止。
    - 该工具在 `default` 与 `auto-edit` 模式下请求审批,与 Legacy 一样,并加入两种语言的输入预览列表,使审批卡片写明成员。

11. **`team_message` 与 `task_assignment` 保持已登记、关闭且无人产出。**
    - lead 到成员的流量是 Session 消息(H4e-b2),成员到 lead 的流量是命令与 `to_parent` 消息,成员之间的流量是 lead 的消息,任务分配就是消息(H4e-b2 决策 7)。没有任何东西需要该 domain。
    - 它的规则保持原样,包括把成员绑定到其第一个 run 的目标规则。H4e-a 设计把该 domain 及其 `task_assignment` 类型标为保留;把它们从封闭索引中移除留给一次契约修订。

12. **不导入 Legacy 团队。**
    - Legacy 团队文件位于 CLI 主机的 home 目录下,任何 Hosted Harness 都读不到。它的名册列出的是存活的 teammate,而 Hosted 名册条目需要 lead 的一个存活 child run。成员名上限为 64 个字符,Legacy 的名字没有这个上限。Legacy 的任务 id 在删除后会被复用;Hosted 的编号不会。
    - 想在 Hosted Session 中使用 Legacy 团队任务板的用户,请 lead 用 `task_create` 重建它。导入是 H4e 的非目标,而不是推迟的部分。

13. **四个批次,每个批次启用它自己新增的内容。**

    | 批次 | 范围                                                                                                                               | 启用                               |
    | ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
    | b3a  | `request_shutdown` 与 `team_delete` 的拒绝(决策 10);放宽的前言格式、plan mode 拒绝与 plan mode 拼装规则(决策 5 与 9)               | 无新增                             |
    | b3b  | 两种语言中的 `session_command` 记录与规则、relay 的命令处理流程、`execute`、`await_command`、成员任务板工具、保留名 `parent`、恢复 | `session_command`,在其实机验收之后 |
    | b3c  | 成员之间的消息与仅限运行中的发送(决策 8)                                                                                           | 无新增;在其实机验收之后合入        |
    | b3d  | 要求 plan mode 的 launch、`exit_plan_mode`、`team_plan_approval`、`team_plan` 记录与撤回                                           | `team_plan`,在其实机验收之后       |
    - b3a 不需要通道,最先落地。每个批次在启用任何新东西或合入之前,都要在真实 Hosted 栈上做一次实机验收,与 H4e-b1 和 H4e-b2 一样。
    - **plan mode 的下限。** 只有当部署的回滚下限及为其服务的每个 Harness 都带有 b3a 时,b3d 才接受 `plan_mode_required`。不带 b3a 的构建在拼装要求 plan mode 的成员的续跑时不带该属性,并准入所有工具,因此只要存在要求 plan mode 的成员,就不支持回滚到该下限以下。后续批次提交的记录会抬高持有它们的会话的下限,即使该批次的 domain 仍关闭:所有可能重开持有 `session_command` 记录的会话的 Harness 以及回滚下限都必须包含 b3b;对提交过 `team_plan` 记录的 lead,它们必须包含 b3d。低于该下限的 Harness 会拒绝加载该会话(见[团队计划设计](2026-10-12-managed-agent-team-plans.zh-CN.md))。
    - 每个批次把它启用的 domain 加入 Hosted 重开白名单。

14. **被中断的回合按已提交的内容作答(扩展 H4e-b2 决策 9)。**
    - **成员的命令调用。** 恢复与 PostToolUse 派发证据在其 `commandId` 下查找调用;对成员的 `send_message`,则同时在它的 `msg_` 与 `cmd_` id 下查找,因为 hook 可能改写了 `to`:
      - `accepted` 或 `consumed`,带回复:答复该回复;
      - `accepting`,尚无回复:在会恢复 Turn 的路由上,等待以其上限的剩余部分恢复(从 outbound 的提交起算);在会结算 Turn 的路由上,答复说明命令已到达 leader、回复没有到达,且写入可能已生效,因此在重复写入之前要先读取任务板;
      - `planned`:取消该条目,并把调用答为未发送;在竞争中胜出的交接则按 `accepting` 条目的情形作答;
      - checkpoint 写明了命令调用但没有 outbound 条目:答为未发送,批次中的其他调用从 journal 补齐(决策 4);
      - `rejected`、`cancelled`、`unknown`:如实说明,`unknown` 绝不呈现为已完成。
      - 对处于 `accepting` 或 `unknown` 的 `member_message`,答复说明部分收件人可能已经收到消息或稍后收到,并禁止重发。任务板无法证明消息是否送达。实时等待、续跑及被中断回合的答复使用 journal 中已提交的命令类型;任务板命令与 `plan_submit` 保留原有文案。
    - **lead 的调用**(`team_plan_approval`、`request_shutdown`)依据其已提交的记录作答,与 H4e-b1 的团队调用一样;对已记录但未送达的决定,使用决策 9 的两段式答复。

## 工具

| 工具                 | 使用者                | 提交                                                            | 与 Legacy 的差异                                                                                |
| -------------------- | --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `task_list`          | 成员                  | 一条 outbound `board_read` 命令                                 | 经由 lead 读取                                                                                  |
| `task_create`        | 成员                  | 一条 outbound `board_write` 命令;lead 提交任务                  | 没有自动认领                                                                                    |
| `task_update`        | 成员                  | 一条 outbound `board_write` 命令;lead 提交修订                  | owner 只能是自己或 `""`;不发送任务分配                                                          |
| `send_message`       | 成员                  | 发给成员或 `*`:一条 `member_message` 命令;发给 `"parent"`:H4d-b | 由 lead 转发,且只发给运行中的成员;带发送方标签                                                  |
| `exit_plan_mode`     | 处于 plan mode 的成员 | 一条 `plan_submit` 命令;lead 提交一个 `team_plan`               | 不等待;每个 run 一次被接受的递交;更新的计划取代等待中的计划;决定作为下一条指令到达;没有目标模式 |
| `team_plan_approval` | lead                  | `team_plan` 的决定;该成员的一次续跑;`show` 不提交任何东西       | 只在成员的 run 结算之后;`show` 读取该团队的任一计划                                             |
| `request_shutdown`   | lead                  | 成员链头上的 `stopRequested`;撤回等待中的计划                   | 是停止,而不是成员可以拒绝的请求                                                                 |
| 带 `name` 的 `agent` | lead                  | 不变,另加 `plan_mode_required`                                  | 不变                                                                                            |

## 一条命令的路径

成员 `alice` 对任务 3 运行 `task_update`:

| 步骤 | Journal | 提交                                                                                        | 执行者                        |
| ---- | ------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| 1    | alice   | 写明批次中命令调用的 `await_command` checkpoint;然后是 outbound `session_command` `planned` | `task_update`                 |
| 2    | alice   | outbound `accepting`,目标 = lead                                                            | relay(`handover`)             |
| 3    | lead    | 任务 3 的 `team_task` 修订;然后是带回复的 inbound `consumed`                                | relay(`execute`)→ 团队 funnel |
| 4    | alice   | 带回复的 outbound `accepted`                                                                | relay(`answered`)             |
| 5    | alice   | outbound `consumed`;调用的工具结果,取自回复                                                 | 停放的调用                    |

`board_read` 在第 3 步不提交任何东西。`member_message` 在第 3 步于 lead 上为每个运行中的收件方提交一条 outbound `session_message`,再提交回执,由 H4d-b 的管线逐条投递。

## 上限

| 上限                | 取值                                                                            | 拒绝方式                              |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------- |
| 命令参数            | ≤ 64 KiB                                                                        | 工具错误,`byte_limit`                 |
| 回复                | ≤ 64 KiB;更长的 `task_list` 带标记截断                                          | 截断,绝不拒绝                         |
| 每个成员 run 的命令 | 256 条,含读取                                                                   | 工具错误,`budget_exhausted`           |
| 命令的等待          | 自 outbound 提交起 2 分钟,或 H4f 停止                                           | 调用结束;按已提交的内容作答           |
| 超时之后            | 该 Turn 之后的每个命令调用                                                      | 工具错误,立即                         |
| 计划文本            | 转义后,连同前言、决定的文本与 4 KiB 反馈能放入续跑信封;由 lead 检查             | `refused`,`byte_limit`                |
| 反馈                | ≤ 4 KiB                                                                         | 工具错误,`byte_limit`                 |
| 等待中的计划        | 每个成员一个;更新的取代它                                                       | 较早的被取消                          |
| 计划递交            | 每个 run 一次被接受的递交;被拒绝、被取消或被拒收的递交可以再次发送              | 在本地被拒绝                          |
| 计划决定            | 每个决定用掉 H4c 每个 Session 64 次 launch 中的一次                             | `team_plan_approval` 在提交之前被拒绝 |
| 成员消息            | 每个收件方 ≤ 32 KiB;每个接收方 run 在途 4 条、共 16 条,在 H4d-b 的 8 与 64 之内 | 逐个收件方,在答复中报告               |
| 同一发送方的命令    | 一次一条,按提交顺序                                                             | 较晚的排在较早的之后等待              |

## 非目标

- **计划的用户审批卡片**,以及对 D6 Action、Java 的 action store 或公开 OpenAPI 的任何变更(公开投影归 #13785)。Java 的输入预览列表确实会变。
- 成员可以接受或拒绝的**协作式 shutdown**。
- **Legacy 团队导入**(决策 12)。
- **绕过 lead 的成员之间的消息**,血缘之外的 peer 路由(H4d-a 开放问题 4),以及续跑已完成成员的成员消息。
- **Legacy 的自动认领**,空闲通知,以及只读或换类型的成员。
- **释放名册名额:** 已结束的成员仍占用 10 个名额中的一个。
- **产出 `team_message`**(决策 11)。
- **改变 H4d-b 的结果规则:** 成员对成员消息的答复仍可能成为它的结果(决策 8)。

## 受影响的文件

- **契约(两种语言):**
  - `packages/core/src/managed-runtime/managed-session-records.ts`:封闭 domain 索引中的 `session_command`,以及各项启用;
  - `managed-session-command-record.ts` 与 `managed-session-command-operations.ts`(新增):记录、其后继规则、id 与记录体;
  - `managed-session-authority.ts`:inbound 的血缘规则与无 input 规则;
  - `managed-extension-projection.ts`、`contracts/managed-extension-record-v1.schema.json`、共享的记录与投影 fixture,以及新的命令 fixture;
  - `managed-harness-checkpoint.ts` 与 `managed-harness-factory.ts`:`await_command` 阶段及其 `commandWait` 组;
  - `managed-team-record.ts` 的注释:`team_plan.requestId` 是某次递交的命令 id;
  - Java:`ManagedExtensionRecords.DOMAINS`、`ManagedExtensionProjection`、一个 `session_command` 校验器、`ManagedExtensionRecordStore` 的血缘与无 input 规则、`ManagedTeamRecords` 的注释,以及 `ContractTest`。
- **Relay(Java):**
  - `SessionMessageRelay` 与 `SessionMessageRelayStore`:以 domain 为参数、命令处理流程及其放弃;
  - `QwenHostedHarnessConnector`、`HarnessConnector` 与 qwencode 的 `HostedHarnessClient.runMessageOperation`:`execute` 与 `answered` 动词,以及 `execute` 的响应体;
  - qwencode 的 Harness 恢复线路:`await_command`;
  - `HarnessCoordinator` 与 `ToolPublicationStore`:阶段审计;
  - `ManagedActionService.PREVIEW_TOOLS`:`request_shutdown`、`exit_plan_mode` 与 `team_plan_approval`,与 `HOSTED_INPUT_PREVIEW_TOOLS` 中一致。
- **Harness(TypeScript):**
  - `hosted-member-chain.ts`:按门禁区分的前言措辞、放宽的格式、`plan-mode` 属性,以及从未启动说明中列出的丢失消息不含 `msgc_` 消息;
  - `hosted-session-command-session.ts`(新增):成员的 outbox 与等待,以及 lead 的 `execute`;
  - `hosted-team-session.ts`:成员撰写的任务板写入与面向成员的文本、保留名 `parent`、`member_message` 路由、`team_plan_approval`、`request_shutdown`、计划撤回、lead 的 `task_list` 中等待中的计划,以及 `planModeRequired` 加入;
  - `hosted-child-agent-session.ts`:仅限运行中的发送、成员结果通知中的计划块,以及拼装续跑前言处的 plan mode 规则;
  - `hosted-session-message-session.ts`:收件方一侧对 `msgc_` 的呈现;
  - `hosted-workspace-tool-turn.ts`:成员工具声明、命令批次规则、plan mode 准入、`await_command`、lead 的工具、具名 `agent` launch 的 schema 与准入中的 `plan_mode_required`、拼装 launch 前言处的 plan mode 规则,以及 `HOSTED_INPUT_PREVIEW_TOOLS`;
  - `hosted-runtime-recovery.ts`:决策 14、批次的补齐、`await_command` 的取消与结算路由,以及恢复的等待的租约;
  - `hosted-harness-session.ts`:消息操作路由上的 `execute` 与 `answered` 动词、`execute` 对记录拒绝使用的专用错误码,以及重开白名单;
  - `hosted-tool-approval.ts`:预批准列表。
- **翻转的测试:** 前言措辞测试、`team_delete` 的拒绝文本,以及成员 `send_message` 对成员名的拒绝。
- **设计:** 本文档、其中文版本,以及 H4e-a、H4e-b1、H4e-b2 与 H4d-b 设计和 H4a、H4b 交付地图中的指引;每次实机验收在 `.qwen/e2e-tests/` 下有一份 E2E 计划。

没有 Flyway 迁移:relay 的 ledger 与索引被复用。

## 验证计划

- **记录,两种语言。** 在共享 fixture 上验证 `session_command` 的解析、后继与血缘规则;任何修订都不带 input;回复只在 `accepted` 上设置一次;`cmd_` 与 `msgc_` id 永远不与其他命名空间相撞;`team_plan` 只为要求 plan mode 的成员开启。
- **Relay(Java)。** 两个 domain 的发现;命令处理流程与 `execute` 的响应体;一个发送方的命令一次一条、按提交顺序处理,重试退避期间亦然;`rejected`、`orphaned`、`cancelled` 与 `unknown` 结果,以及复制已提交回复的放弃;重投递的 `execute` 与 `answered`;被阻塞、正在关闭或未加载的 lead;停留在 `accepted` 的命令条目从不被送到 `consume`。
- **团队 funnel。**
  - 成员作为撰写者时的每条 Legacy 任务板规则,包括跨两个任务的边;成员认领自己时的 owner 规则;面向成员的文本;成员的 `task_list` 隐藏的内容。
  - 非成员的命令,已停止、已结算或非链头 run 的命令,正在关闭的团队,返回已提交回复的重新运行的 `execute`、对照期间已变化的任务板重新检查的部分应用写入,以及找到自己 `team_plan` 的重新运行的 `plan_submit`。
  - `member_message` 发给运行中的成员、已完成的成员、在两条链之间结算的成员、`"*"`、发送方自己、`leader`、`parent` 与陌生名字;上限;收件方一侧在 plan mode 内外的呈现;重新运行时的 id 与探查。
  - 计划:一次递交、同一 run 中的第二次递交、`byte_limit` 之后以及一次什么都没发出的超时之后的更正递交、一次取代、在取消与新计划之间被中断的递交、`execute` 处的大小检查、处于上限的结果通知中的计划块、对等待中计划与已决定计划的 `show`、引用计划的批准与驳回、续跑的每条路由都遵循 plan mode 规则、没有开启中团队列出的链、`team_plan_approval` 在提交之前的每种拒绝、已作出的决定、续跑被中断或被拒绝后的两段式答复,以及每种撤回。
  - `request_shutdown` 作用于运行中的成员、尚未启动的续跑、已完成的成员与已结束的成员,每种情况都撤回等待中的计划,以及停止结算之后的 `team_delete`。
- **工具回合。** 成员工具只在有未转义前言时、只在带血缘的 Session 中、且只在已启用时才声明;命令批次规则;plan mode run 以及之后不带该属性的 run 中的 plan mode 准入;跨 Harness 重启的 `await_command`,持有与不持有挂载两种情况;2 分钟上限与超时之后的拒绝,包括跨重启;checkpoint 先于批次的第一个调用提交,以及它的补齐;停放在命令上的 Turn 被停止与被取消;决策 14 的每种答复。
- **实机验收**,在真实 Hosted 栈上用脚本化模型进行,经由公开 API 驱动:
  - b3a:lead 停止一个运行中的成员,停止结算后删除团队;
  - b3b:两个成员读写任务板,lead 读取它,一个成员的写入与 lead 的某次写入竞争,并在一个成员的命令等待期间重启它的 Harness;
  - b3c:发给运行中成员与 `"*"` 的成员之间消息、被拒绝的已完成收件方,以及收件方对发送方的回复;
  - b3d:要求 plan mode 的成员被驳回、修改、获批准,然后才编辑文件;批准之前 lead 发给它的消息让它保持在 plan mode;回滚到关闭 `team_plan` domain 的 b3d 时它仍保持在 plan mode,因为低于 b3d 的构建无法加载持有 `team_plan` 记录的 lead(决策 13);
  - 每次启用之前,用真实模型跑一次,经用户批准。

## 验收标准

- 成员按 Legacy 的规则读写任务板,每次写入都作为 lead 的提交落入 lead 的 journal。
- 成员可以给一个运行中的成员或全体成员发消息,每个收件方都能看到是谁写的并能回复发送方,且没有成员消息会启动续跑。
- 要求 plan mode 的成员在 lead 的模型批准其计划之前不编辑任何东西,无论哪条路由续跑它;批准作为一个不处于 plan mode、引用该计划的 run 到达。
- lead 用 `request_shutdown` 停止运行中的成员,停止结算后删除团队。
- 成员撰写的命令绝不会被应用两次,结果未知的被中断调用绝不会被答为已完成。
- `team_message` 保持无人产出,也没有任何东西读取 Legacy 团队的文件。

## 开放问题

1. **命令与被阻塞的 Session。** 被 #13847 卡住的 lead 不答复任何命令,因此每个成员的命令调用都在 2 分钟后超时,其 Turn 中其余的命令调用都被拒绝。修复归 #13847。成员自己只写 journal 的窗口,通过在批次的第一个调用之前提交 checkpoint 而收窄(决策 4),收窄的程度与前台 child 等待对它自己窗口的收窄相同。
2. **命令延迟。** relay 走一遍要付出一次扫描延迟与三次 Harness 调用。在 outbound 提交时立即触发(kick)可以消除扫描延迟;这是对 store 追加路径的 Java 改动。
3. **成员在自己 Session 中的身份。** 从首条输入读取前言属于带内方式。在 child 的 launch 上放一个有类型的标记会更干净,但这是对 launch 信封或血缘的契约变更。在带内方式下,plan mode 是 fail-closed 的:带该属性的块只要未转义,无论在哪里都会限制该 run,而没有可读块的 run 得不到成员工具。
4. **成员对成员消息的答复会成为它的结果**(H4d-b 的结果规则)。child result relay 选取结果时跳过成员消息回合,就能为 lead 保住成员的汇报;这是对 Java 完成规则的改动。
5. **计划的公开视图**(#13785):把等待中的 `team_plan` 记录投影为 Action,并带有 agent 身份来源。
6. **plan mode 中的只读 shell。** 处于 plan mode 的 run 除了 `read_file` 以及(在搜索 profile 上的)`glob` 之外,无法列出或搜索 Workspace。限于读取的 shell 有助于它制定计划,但需要一种尚不存在的只读 Runtime 模式。

## 后续工作

| 切片   | 范围                                                               |
| ------ | ------------------------------------------------------------------ |
| #13847 | 只写 journal 的批次崩溃后被阻塞的 lead,它也会让其成员的命令停滞。  |
| #13901 | H4e-b2 的措辞与效率缺口;本切片复用了其中若干文本。                 |
| #13785 | 公开的 agent 身份维度,以及作为公开 Action 的计划。                 |
| 契约   | 把 `team_message` 与 `task_assignment` 从封闭索引中退役(决策 11)。 |
