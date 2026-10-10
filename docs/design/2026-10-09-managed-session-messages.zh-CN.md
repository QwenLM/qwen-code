# Managed Session 消息与 child 续跑(H4d-a)

[English](2026-10-09-managed-session-messages.md) | [简体中文](2026-10-09-managed-session-messages.zh-CN.md)

状态:已在本变更中实现。已落地:`managed-session_message` 记录体,在 TypeScript 与 Java 中均已登记并校验,但不开放提交;以及 `child_run` 的续跑规则(`continueChildRun`),在两种语言中均做检查,并由门禁关闭提交。仍为设计:发送、中继、投递、消费消息并复活已完成 child 的运行时(H4d-b,见"后续工作")。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4d** 切片中记录契约的那一半,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段,由 [#13744](https://github.com/QwenLM/qwen-code/issues/13744) 跟踪。它承接 H4a([记录契约](2026-10-06-managed-child-agent-runtime.zh-CN.md),#13505)、H4b([child Session 运行时](2026-10-07-managed-child-session-runtime.zh-CN.md),#13550)与 H4c([workflow kind](2026-10-09-managed-workflow-child-kind.zh-CN.md),#13754)。下文"自动化设计"指 #12827 所固定提交上的 [automation、Channels 与 child 投递设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md) 第 5 节与第 5.1 节。

## 问题与范围

H4b 让 child 的结果持久、让其 acceptance 可观察,但通信仍是单向且终态的:父发起,child 运行,child 的结果被复制回来并被接受。父无法向运行中的 child 补充信息,child 无法向父询问任何事,已完成的 child 也无法被续跑。H4b 是有意停在这里的。它的决策 12 指出 `continueChildRun` "没有诚实的 v1 生产者",其真正的生产者是 H4d 的 peer 消息与复活路径。H4a 的交付地图把"`session_message` 记录体与无团队的持久 `send_message` 路由"交给 H4d,出口为"持久送达,每个收件方各有 accepted 与 consumed,跨重启与重连"。

Issue #13744 提出了三项交付。维护者于 2026-10-09 裁定了范围。D1 的收窄与 D3 的移出采纳了 issue 上的分诊意见。D2 一分为二、`queryChildRun` 不实现这两项分诊意见留待定夺,是维护者的决定,记录于此:

- **D1(操作)收窄为 `continueChildRun`。** `queryChildRun` 不作为操作实现。H4b 决策 12 依然成立:查询不需要写 journal,relay 与工具轮已经读取已提交的记录或其 SQL 投影(见下文决策 12)。
- **D2(持久投递)一分为二。** 本变更落地记录这一半:投递所需的每个事实都是已提交的记录,并在两种语言中有提交时规则。运行时那一半属于 H4d-b:managed `send_message` 工具、消息 relay、投递边界、消费与复活。
- **D3(mailbox)移到 H4e**([#13745](https://github.com/QwenLM/qwen-code/issues/13745))。mailbox 是团队构造(Legacy 的 `agents/team/mailbox.ts`,持久侧的 `team_message`)。H4d 的路由是无团队路由。

这沿用 H4a → H4b、H5a → H5b/H5c 与 H6a 的节奏:记录契约先落地,在任何写入方之前完成校验,启用随生产者一起交付。

## 现状

以下事实取自 `main` 的 `f20ed558e3`。

- **Domain。** `session_message` 在封闭的 v1 domain 索引(`MANAGED_SESSION_DOMAINS`)与 Java 的 `ManagedExtensionRecords.DOMAINS` 中。它在两种语言中都没有记录体、没有 store 规则、没有 task kind,也没有启用。唯一提到它的 fixture 是 `managed-extension-record-v1.fixtures.json` 中的一条 operation grant 用例。
- **续跑。** `child_agent` 与 `workflow` 记录体带有 `predecessorChildRunId`(固定字段,在 launch 时设置),但除 id 形状外没有任何规则读取它。一个指向任意前驱(哪怕不存在)的 launch 在两种语言中都会提交成功。`childLaunchBody` 总是写 `null`。不存在续跑的生产者。
- **操作。** `continueChildRun`、`queryChildRun` 与 `mailbox` 在 `packages/core/src/managed-runtime`、`packages/cli/src/serve` 与 `managed-agent-server/src/main` 中均无出现。
- **血缘。** 父的 journal 通过各自的 `child_run` 记录命名每个 child(`childRunId`,自 attach 起还有 `childSessionId`)。child 的 journal 不含血缘。child 的祖先关系只在 Java 中:`managed_agent_session` 的 V54 列 `parent_session_id` 与 `parent_child_run_id`,在创建时写入,此后不变。TypeScript 的 Hosted Session 也把它存进自己的定义,但 authority 不读取它。
- **Input。** `commitExtensionRecord` 可以在提交一个记录修订的同一事务中,提交一个 input 及其由 authority 生成的 wake。H4b 的 `"sent"` acceptance 就是这样用的。Java store 能看到整个事务(`apply` 遍历每一行事件),因此可以把 input 与随它同行的记录对照检查。
- **Legacy。** `send_message` 可以路由到后台 `task_id`(内存队列,在工具轮边界取出;暂停或已完成的 agent 会被恢复或复活)、teammate,或经 socket 路由到命名的 peer Session。这些路径都不持久,而且 Hosted profile 没有声明 `send_message`。

## 决策

1. **一个 domain、两个方向、两个 journal。** 一条消息提交两次,每个 Session 的 journal 各一次,每次都由该 journal 自己的单一写入方提交(H0c:没有第二条写入路径)。发送方的记录(`direction: "outbound"`)是持久的 outbox 条目。目标方的记录(`direction: "inbound"`)是回执。两条链都以同一个 `messageId` 为键,各在自己的 journal 中。一个 journal 把自己的 outbox 条目和来自其 child 的回执放在同一个键空间里,所以 `messageId` 必须跨 Session 唯一:由发送方生成,例如 UUID。`managed-session_message` 为 schema version 1,两个方向共用一个封闭键集,并有按方向的规则。
2. **v1 的路由沿血缘进行。** `route` 为 `to_child`(父到子)或 `to_parent`(子到父)。`childRunId` 命名血缘边:父 journal 中的那条 child run。血缘之外的命名 peer 需要一份授权证明(自动化设计的 `routeProofRef`),而它没有已设计的生产者。它们在 v1 中无法表达,以后可以通过新增 route 取值来增量加入。
3. **发送是一次已结算的行为,之后只有投递在推进。** 发送消息时什么都不执行。内容一旦提交,这个行为就完成了。outbound 的 run 除了 `executionCallId`(发送的工具调用)外是纯逻辑的,并以 `settled`、投递 `planned` 开启。通用开启规则(reserved 或 admitted)无法表达这一点,原因与它无法表达 H4a 的 acceptance 相同(H4a 决策 9)。此后只有 session 投递线在推进,每次走一个共享步骤:
   - `planned → accepting → accepted → consumed`
   - `planned → cancelled`:从未交出
   - `accepting → unknown | rejected`
   - `unknown → accepted | rejected`
4. **目标在交接时固定,所以发给尚未启动的 child 的消息会被持有。** `targetSessionId` 只设置一次,并从 `accepting` 起必填:真正的目标在消息被认领时固定,而不是在发送时。发给 Session 尚不存在的 child 的消息会保持 `planned`,直到该 child attach。它既不会被拒绝,也不会丢失。这就是 D3 的出口规则"按明确规则持有或拒绝",以 H4d 所拥有的形式落地。反方向同样持有:来自尚未 attach 的 child 的消息,父方以单独的消息("arrives only once its run attached")拒绝,因此 relay 会持有它,而不会把它当作伪造。
5. **发送方记下承载其消息的 input。** outbound 记录恰在投递为 `accepted` 或 `consumed` 时带 `inputId`,且只设置一次。它命名目标 journal 中承载这条消息的 input。因此每个收件方的 accepted 与 consumed 在两侧都可见,每个事实都指明它所依据的证据。
6. **回执以 accepted 开启,并与其 input 在同一事务中提交。** inbound 记录遵循 H4a 决策 9:以 `settled`、投递 `accepted` 开启,之后唯一的一步是 `consumed`。它的开启修订必须与其 `inputId` 所命名的那个 input 恰好一起提交,外加该 input 生成的 wake。其他任何 `session_message` 修订都不得携带 input。由此得到四项保证:
   - "accepted"与"input 已提交"是同一个原子事实,所以崩溃后要么两者都在,要么都不在。
   - 同一 `messageId` 下的重投递会找到这条链,无法再次开启。它不能创建第二个 input,所以消息恰好恢复一次。
   - 第二条消息有新的 `messageId`,所以重投递与第二条消息可以区分。
   - 绝不会把两条消息合并到同一个 id 下。其他任何开启已占用 `messageId` 的尝试,都在发布任何东西之前被拒绝:携带 input 时由该 input 自身的事件 id 或 input 规则拒绝,改动消息时由固定键规则拒绝。因此 relay 靠重放其开启命令来识别重投递,而不是去解读拒绝:同一命令、同一消息会得到已提交的回执,同一命令换了内容会被判为冲突。
7. **内容有界并以摘要绑定。** `contentRef` 是指向持有方 Session 自己副本的持久引用,至多 64 KiB(65536 字节),在父方持久内联上限之内。这个上限按字节计,而 Legacy `send_message` 的上限是 65536 个字符,所以生产者要在提交前按字节约束内容。在目标方承载消息的 input 是一条有界通知,与 H4b `"sent"` acceptance 的 input 完全一样(H4b 决策 5):先转义,再在 input 及其 wake 轮消息的内联上限内截断并加标记。完整内容是回执的 `contentRef`,由摘要绑定。`contentDigest` 必须等于 `contentRef.digest`。因此 inbound 副本以摘要绑定到 outbound 原件,就像 H4a 决策 6 绑定结果副本那样。
8. **提交时规则检查各自 journal 能证明的事。** authority 检查其 journal 持有的内容,Java store 另外检查只有它持有的血缘:

   | 规则                                                                                                             | TypeScript authority | Java store |
   | ---------------------------------------------------------------------------------------------------------------- | -------------------- | ---------- |
   | outbound 记录由本 Session 发送;inbound 记录寄给本 Session                                                        | 是                   | 是         |
   | `to_child` outbound 命名本 Session 的一个 child Session run,且消息开启时该 run 尚未结束                          | 是                   | 是         |
   | `to_child` outbound 的目标恰是其 child run 所 attach 的 Session                                                  | 是                   | 是         |
   | `to_parent` inbound 命名本 Session 的一个 child Session run,并来自该 run 所 attach 的 Session;该 run 可已结束    | 是                   | 是         |
   | `to_parent` outbound 与 `to_child` inbound 遵循本 Session 自身的血缘(`parent_child_run_id`、`parent_session_id`) | 不持有血缘           | 是         |
   | inbound 开启恰好携带其 input;其他修订都不携带                                                                    | 提交时               | 是         |

   血缘违例只有 store 能拒绝,所以它以自己的错误码 `session_message_lineage_refused`(409)作答。HTTP Session store 把它映射为可回滚的未提交,与映射 H4b 的 `child_run_lineage_minted` 一样:authority 无法先行拒绝这条记录,child 的日志应保持可写,而不是锁定为写入失败。

   inbound `to_parent` 消息可以命名一个已经结束的 run,因为 child 在结束前发出的消息可能在结束后才到达。outbound `to_child` 消息不能命名已结束的 run。已完成的 child 改为续跑(决策 9),而失败或取消的 child 永不续跑:参考设计对失败后的诚实恢复是一次新的独立 run。

9. **`continueChildRun` 是一次续跑 launch。** 续跑是一条 child Session kind 的 `child_run`,其 `predecessorChildRunId` 已设置。它有新的 `childRunId`、`resultVersion` 为 1(H4a 决策 7),以及自己的 launch input。它的开启修订必须满足以下全部条件:
   - 前驱是本 Session 的一条同 kind 的 child run。
   - 前驱以 `settled`、停止原因 `completed` 结束,即其结果已提交,且未被请求停止:父方或用户要求停止的 run 永不复活。
   - 续跑保持前驱的 `ownerScopeId`、`rootSessionId`、`depth`、`workspaceMode` 与 `workingDirectory`,并从开启修订起固定前驱的定义。
   - 没有其他 run 续跑同一个前驱。链是线性的:发给已完成 child 的第二条消息走向续跑那条 run,绝不会从前驱分叉。执行被证明从未启动(`not_started_proven`:创建失败、配额拒绝、启动前取消)的续跑没有动过前驱,所以它把前驱释放给下一次续跑。

   构造器 `childContinuationBody` 恰好推导出这些字段,包括 kind。completion 不受约束:由 `send_message` 发起的续跑通常是 `"sent"`。续跑也是一次 launch,所以和其他 launch 一样计入 H4b 的活跃上限与 H4c 的预算;其生产者在提交前同样要做 launch 准入(关闭中、配额),因为 authority 与 store 在提交时都不检查配额。

10. **两项能力都保持禁用。**
    - `session_message` 不进入 `MANAGED_SESSION_ENABLED_DOMAINS`。
    - 续跑有自己的门禁 `MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED = false`,由 authority 的提交路径检查。仅靠 kind 检查不够,因为 `child_agent` 已启用。没有这道门禁,H4b 的 relay 会把一条已提交的续跑当作没有历史的全新 child 来运行,而父会把这次运行误认为续跑。门禁只拒绝提交,从不拒绝读取。
    - Java store 在任何写入方之前校验二者,沿用 H1 至 H4c 的 server-first 顺序。Java 的生命周期门禁不把 `session_message` 列入处于 close 或 delete 声明下的 Session 可提交的 domain。outbox 的取消是否必须在关闭期间提交,由 H4d-b 决定(开放问题 3)。
11. **没有任务投影。** 消息不是任务。`session_message` 以空 task kind 登记,其 Java 行的 task 列为空,与 `child_acceptance` 的行一样。
12. **不实现 `queryChildRun`。** H4b 决策 12 依然成立。发送方需要的 child 状态(运行中、已完成、已结束)就是已提交的 `child_run` 记录,authority 已经在读取它,Java 侧则读取其 SQL 投影。"绝不伪造 child 未提交的结果"由构造保证:结果只经由 `commitChildResult` 流动,而续跑要求前驱已提交其结果。

## 记录

### `managed-session_message`

Schema version 1。链以 `messageId` 为键。所有键都必填;可空的键取 `null`。

| 键                | 规则                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `direction`       | `"outbound"`(发送方的 outbox 条目)或 `"inbound"`(目标方的回执)                                                  |
| `messageId`       | id:这条消息,由发送方生成;同一 id 作为两条记录的键                                                               |
| `route`           | `"to_child"` 或 `"to_parent"`                                                                                   |
| `childRunId`      | id:血缘边,即父 journal 中的 child run                                                                           |
| `senderSessionId` | id:发送方 Session                                                                                               |
| `targetSessionId` | null 或 id,绝不等于发送方。outbound:只设置一次,投递越过 `planned` 后必填(`cancelled` 除外)。inbound:必填        |
| `contentRef`      | 指向持有方 Session 中这条消息副本的持久引用,至多 65536 字节                                                     |
| `contentDigest`   | 摘要:必须等于 `contentRef.digest`                                                                               |
| `inputId`         | null 或 id:在目标方承载这条消息的 input。outbound:只设置一次,恰在 `accepted` 与 `consumed` 时存在。inbound:必填 |
| `run`             | run 块:已结算且纯逻辑,带 `session` 投递。outbound 在 `executionCallId` 中命名其发送调用;inbound 不命名任何调用  |

- **固定键。** `direction`、`messageId`、`route`、`childRunId`、`senderSessionId`、`contentRef` 与 `contentDigest` 永不改变。`targetSessionId` 与 `inputId` 只设置一次。
- **开启。** outbound 记录以投递 `planned` 开启(不带 `inputId`)。inbound 记录以 `accepted` 开启。
- **后继。** run 遵循共享后继规则,对已结束的 run 只推进投递。inbound 记录只能从 `accepted` 推进到 `consumed`。

### `managed-child_run` 的续跑

没有任何键变化。决策 9 的规则是 authority 与 Java store 中的提交时检查,而不是记录体语法,所以没有共享 fixture 承载它们。这与 H4b 固定其反向 acceptance 检查的方式一致。

## 非目标

- **运行时(H4d-b):** managed `send_message` 工具的准入及其路由选择(运行中的 child 收到消息,已完成的 child 得到续跑);`managed-agent-server` 中的消息 relay;notification input 来源及其 wake pump;消费提交;带前驱历史的续跑复活;以及启用。
- **`queryChildRun`**(决策 12)、**团队 mailbox**(H4e)、**血缘之外的命名 peer**(决策 2),以及**轮中投递**。
- **任何公开契约变更。** OpenAPI 契约、路由与 Flyway 迁移保持不变;`contract-known-gaps.txt` 不变。

## 受影响的文件

- `packages/core/src/managed-runtime/managed-session-message-record.ts`(新增):记录体及其开启与后继规则。
- `packages/core/src/managed-runtime/contracts/managed-session-message-record-v1.fixtures.json`(新增):共享用例。`managed-extension-projection-v1.fixtures.json` 增加 `session_message → null`。
- `packages/core/src/managed-runtime/managed-extension-projection.ts`:记录体登记。
- `packages/core/src/managed-runtime/managed-session-authority.ts`:资源闭包、决策 8 的跨记录规则、input 绑定、续跑规则与门禁,以及续跑索引。
- `packages/core/src/managed-runtime/managed-session-records.ts`:续跑门禁。
- `packages/core/src/managed-runtime/managed-child-operations.ts`:`childContinuationBody`。
- `packages/core/src/managed-runtime/http-managed-session-store.ts`:`session_message_lineage_refused` 是可回滚的未提交。
- `packages/sdk-java/managed-agent-server`:
  - `ManagedSessionMessageRecords`(新增):校验器。
  - `ManagedExtensionProjection`:记录体登记。
  - `ManagedExtensionRecordStore`:闭包、跨记录与血缘规则、事务内的 input 绑定,以及续跑规则。
- 两种语言中与各文件并列的测试:TypeScript fixture 重放、`managed-session-authority.session-message.test.ts`、操作测试、`ManagedSessionMessageRecordContractTest` 与 `ManagedSessionMessageStoreTest`(复用 store 套件的 child run 辅助方法;测试 journal 新增一种把 input 及其 wake 打包在一起的请求)。
- 本设计的两种语言版本,以及从 H4a 与 H4b 设计指向本文的说明。

## 验证

- **Fixture 一致性。** 共享用例与后继在两种语言中重放,每个无效用例都写明两个校验器必须报告的条款。
- **Authority。** 套件解除两道门禁来植入记录,测试门禁本身的用例除外:
  - 真实门禁拒绝 `session_message` 提交与续跑,且不发布任何东西。
  - 父的 outbound 链从 `planned` 走到 `consumed`,对象是一个尚在运行、随后 attach 的 child run。
  - child 的消息作为 inbound 链到达父方,与其 input 一同提交,并生成该 input 的 wake。
  - 决策 8 中由 authority 负责的每条规则都以具名消息拒绝其违例。
  - 重投递不会开启任何东西,也不会新增 input。
  - 重新打开的日志会重建每一条链。
  - 续跑在前驱已完成后提交成功;前驱缺失、失败、未结束、被请求停止、改了 scope 或已被续跑时被拒绝;从未启动的续跑会释放前驱,已启动的不会。
  - HTTP Session store 把血缘拒绝当作可回滚的未提交,日志保持可写。
- **Java store。** 同样的链在 H2 的 MySQL 模式上提交成功。血缘规则以自己的错误码拒绝不遵循 `managed_agent_session` 血缘的消息。事务级 input 绑定拒绝不带 input 或多带一个 input 的 inbound 开启(多带的 input 即使 id 相同也拒绝),也拒绝携带 input 的其他修订。续跑规则与 TypeScript 一致。`session_message` 行不投影任务。
- **变异检查。** 依次禁用每个新守卫,其见证测试在各自语言中变红。

## 验收标准

- TypeScript 与 Java 依据共享 fixture 接受和拒绝完全相同的 `session_message` 记录与后继,并且每个既有契约语料都原样重放。
- `session_message` 不进入启用列表;续跑在其门禁关闭时以"registered but not enabled"被拒绝。两种拒绝都发生在发布任何东西之前。
- 在两种语言中,决策 8 的每条跨记录规则与决策 9 的每条续跑规则都拒绝其违例,合法的链能提交并重建。
- 没有公开 API 或迁移变更,所有既有 H1–H4c 套件保持通过。

## 开放问题

1. **续跑如何保留历史。** 本契约假定链上每条 run 都有自己的 child Session 与血缘边,所以 H4d-b 用前驱的 transcript 为续跑的新 child Session 播种(`history_copy`)。若改为让已完成的 child Session 保持打开来承载续跑,就需要修改契约:它的血缘边(`parent_child_run_id`)仍指向前驱,决策 8 中 child 侧的血缘规则会拒绝续跑的每一条消息。
2. **繁忙目标上的投递边界。** Hosted wake pump 会把 input 排队到 Session 空闲为止。Legacy 路径正在走向带 opt-in 的工具轮投递(#13428)。managed 消息必须在回收后存活,所以 H4d-b 只能基于已提交的 input 选择投递边界。
3. **发送方关闭时的 outbox。** 未投递的 outbound 消息可以在关闭期间被取消(这需要生命周期门禁放行它们),也可以保持 `planned`,由 relay 分类。
4. **命名 peer。** 血缘之外的 peer 需要授权证明与自己的 route 取值。
5. **relay 在记录之外还要证明什么。** 有三项绑定属于生产者而不属于契约:input 的文本与回执的 `contentDigest` 是否一致(input 是 relay 的有界包装,所以它绑定的是内容的前缀,而非全部);inbound 回执与另一个 journal 中发送方的 outbound 记录是否对应;以及 child 在自己的 run 结束后是否还能发起消息(父方回执对在途消息是放行的)。

## 后续工作

| 切片  | 范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H4d-b | 已在 [H4d-b 设计](2026-10-10-managed-session-message-runtime.zh-CN.md) 中完成,该设计也回答了开放问题 1–3 与 5。managed `send_message` 工具(路由:运行中的 child 收到消息,已完成的 child 得到续跑,已结束的 child 得到具名拒绝);Java 消息 relay(认领、目标解析、带 input 与 wake 的 inbound 回执、推进发送方、崩溃恢复);消费;复活;启用。同样归它:H4b 的 relay 依据 child 最新的 API Turn 结算并随后关闭它,会让排在该 Turn 之后的消息搁浅,所以它的完成判据必须考虑未投递与未消费的消息;Hosted 恢复的 domain 白名单要放行 `session_message`;续跑要经过 launch 准入;`send_message` 按两条承载路径中较小的上限约束消息(64 KiB 内容上限与续跑 32 KiB 的 launch 信封),所以 child 是否已完成永远不会改变答复。 |
| H4e   | 团队与 mailbox([#13745](https://github.com/QwenLM/qwen-code/issues/13745));记录契约见 [H4e-a 设计](2026-10-10-managed-agent-teams.zh-CN.md)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
