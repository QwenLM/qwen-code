# Managed child Session 运行时(H4b)

[English](2026-10-07-managed-child-session-runtime.md) | [简体中文](2026-10-07-managed-child-session-runtime.zh-CN.md)

状态:设计提案;本文档在实现开始前钉死各项决策,文中所述内容尚未实现。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4b** 切片,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) H 阶段的 child Session 运行时。它紧随 H4a([记录契约](2026-10-06-managed-child-agent-runtime.md),PR #13505)——H4a 交付了 `managed-child_run` 的 `child_agent` 记录体 kind 与 `managed-child_acceptance` 记录体,并发布了六片式 H4 交付地图;本切片承接 H0b([记录契约](2026-09-27-managed-extension-record-contract.md))、H0c([authority](2026-09-27-managed-extension-authority.md))与 H3([后台 Shell 与 Monitor](2026-10-03-managed-shell-monitor-runtime.md))的义务。下文中,"参考设计"指 [extension runtime 设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md) 第 3、8、12、13、14 节,"自动化设计"指 [automation、Channels 与 child 交付设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md) 第 5 节,"恢复设计"指 #12827 所 pin 提交上的[恢复操作设计](https://github.com/doudouOUC/code_agent/commit/689121646cc25ca08a34508a5f5555ae15308833)(其 `child_run` 相位名——`launch`、`attach`、`cancel`、`drain`——为本文档沿用)。更早的 [H4 问题框架](2026-10-04-managed-child-agents.md) 仍是本切片的背景;凡它与 H4a 契约冲突之处,以 H4a 契约为准(其"决策"一节记录了各项取代关系)。

## 问题与范围

H4a 钉住的是*什么可以被提交*:`child_agent` run 记录体与 acceptance 记录体、它们的转移规则、跨记录提交检查,并在 TypeScript 与 Java 双侧一致重放。*生产者*尚不存在:任何 Session 都不可提交这两个 domain,没有调用方构造记录体,参考设计的流水线——父提交 launch → 控制面幂等创建 child Session → child Harness 提交终态结果 → 结果跨界 → 父 accepted(而后 consumed)——没有任何实现组件。#12380 的 H4 行就是本切片的目标出口:"独立 child Session、父 acceptance/consumption、持久消息与 close 级联。共享 record 名称不是可执行 domain。"

H4b 交付该流水线的 child-agent 部分:

- **child 操作**,作为父 authority 命令:`startChildRun`(由 hosted 工具轮中的 Agent 工具准入)、`queryChildRun`(只读,控制面)、`commitChildResult`、`acceptChildResult`、`cancelChildRun` 与 `closeChildScope`(控制面,由 relay 与级联驱动)。`continueChildRun` 在本切片*不*实现(决策 12)。
- **Java lineage 存储与幂等 child 创建**(V51):`managed_agent_session` 增加 lineage 列;服务级创建入口的幂等键派生自父方已提交的 launch(H4a 决策 3),使一次结果不明的创建绝不会造出第二个 Session。
- **第一个跨 Session dispatcher——child result relay**:`managed-agent-server` 中的 worker,发现待创建或待交付的 `child_agent` run,驱动创建,盯守 child Session 至终态,把已发布的结果与回执复制进父 Session,并提交 acceptance;对送达已关闭父方的结果,将其分类为 orphaned 而不是复活父方。
- **两条完成路径。** 前台 child(`completion: "tool"`)以 child 结果应答原工具调用,并把 `accepted` 交付步骤折叠进 tool-result 提交;后台 child(`completion: "sent"`)以持久 notification input 及其生成的 wake 交付结果,与 acceptance 同一事务。两路绝不并返(参考设计第 8 节)。
- **close 级联**:关闭父方会级联取消每个未终态 child(恢复设计的 `cancel`/`drain` 相位),递归进行,遵循参考设计第 12 节的关闭顺序;迟到结果成为 orphan。
- **配额**:depth、并发与输入界限,在准入处以 H0b 共用措辞拒绝。
- **按 server-first 部署顺序的启用**,且按 kind 选择性放行,H3 的 shell 保持禁用(决策 10)。

仍旧延期(不在本切片):`workflow` kind(H4c)、持久 peer 消息(H4d)、teams(H4e)、公开任务取消(H4f)、detach 到独立 durable owner、`snapshot`/`worktree` 工作区模式、depth 大于 1、与父不同的自定义 subagent 定义,以及任何生产 AgentBundle 启用——与 H4a 交付地图的分配一致。

## 现状

以下事实取自本切片基点(H4a 分支头 `3261e4d452`,其与 `main` 的 merge-base 为 `ac81c07dc8`)。

- **记录。** `managed-child-run-record.ts` 定义了封闭的 `child_agent` 记录体(17 个键,链以 `childRunId` 为键,delivery 目标 `session`,`resultVersion` 恰为 1,result 与 receipt 引用只在 settling revision 中成对出现);`managed-child-acceptance-record.ts` 定义 acceptance 记录体(以 `settled`+delivery `accepted` 开启,唯一允许的后继是一步到 `consumed`,不投影 task)。authority 的提交路径会把 acceptance 对照已提交的 child run 校验(`managed-session-authority.ts` 的 `assertExtensionRevision` 中 `child_acceptance` 分支),`verifyExtensionResources` 对两个记录体的引用做 Session 自有 store 闭包检查。`MANAGED_EXTENSION_RECORD_BODIES` 已含两个记录体;`child_run` 按记录体 kind 投影 `child_agent` 任务,`child_acceptance` 不投影。
- **启用。** `MANAGED_SESSION_ENABLED_DOMAINS` 启用了四个 envelope domain 加 H1/H2。`child_run` 与 `child_acceptance` 已注册但未启用;H3 有意让 `child_run`(其 `shell` kind)与 `monitor_run` 保持禁用,等待其自身启用闸门,且启用列表是唯一的 domain 闸门——其下没有别的运行时准入开关(H3 设计"Reader compatibility"一节)。hosted 工具轮的 background-shell 准入读的就是同一闸门(`childRunAdmissionsEnabled()`),因此照原样启用该 domain 会连带唤醒 H3 的 shell 生产者。
- **authority 机制。** `LocalManagedSessionAuthority.commitExtensionRecord` 每个事务恰好提交一条记录 revision,可选地打包一条 notification input——其 wake 由 authority 在同一事务中生成;重试的命令返回其已提交回执。`assertDomainAdmittable` 查询启用列表。`close()` 只封存 journal——生命周期关闭(包括任何级联)在 Java 控制面。actor 类别含 `trusted_entry`,即控制面操作(H3 的 maintenance 与 runtime-outcome 路径)提交时所用的类别。
- **跨 Session 结果回投的既有样式。** legacy 已有 relay 样式:daemon 的 `create_sub_session`(`completion: 'sent' | 'first-turn'`,depth 上限 1,按 caller 与全局并发上限)会重试结果通知直到父方持久受理;`agents/workspace-agents/` 维护一个事务化 reconcile 的 JSON outbox(`reconcileThreadOutbox`、`deliverParentReports`)。二者都不感知 managed;它们的恢复凭据(回调、PID、best-effort 文件)正是参考设计在 Managed 路径上禁止的东西。
- **Hosted 轮与工具。** 私有 Hosted profile 准入 file/Shell(/glob)工具集加 MCP 工具;`agent`、`workflow`、`create_sub_session`、`send_message` 不在声明集内,准入即拒(`prepareRequests`)。一次工具调用经历 `prepare → execute → tool_result 提交 → Broker acknowledge`;harness 提交先落 journal 再回执。`run_shell_command` 的 `is_background` 与 `monitor` 工具只在各自 domain 闸门后准入——H4b 的 Agent 工具准入沿用同一形制。
- **通知与 wake。** notification input 以 `input.accepted`(+ 生成的 `wake.requested`)提交;embedded harness scheduler 在空闲时把它作为普通文本轮运行、繁忙时排队;消费在 journal 侧派生——"input 被消费 ⟺ 同 turnId 的某轮已 settle"(`pendingSessionInputs`)。Monitor 切片用这条通道承载 `monitor_run` 通知;尚无任何东西把一条 input 映射到某个 _child_ acceptance 的消费。
- **Java 控制面。** `ManagedAgentService.createSession`/`createWorkspaceSession` 以 `Idempotency-Key` 与语义请求摘要准入创建(replay 返回原受理);`SessionLifecycleCoordinator.settle` 按 claim → workspace close → Harness close(仅原持有者确认)→ live-writer 检查 → Runtime drain 执行关闭,带操作重试与 blocked 分类,`@Scheduled recoverOperations` 接续在飞操作。`SessionEventHub` 把已提交 store 事件桥到 SSE。任何 lineage 都不存在:`parentSessionId`/`rootSessionId`/`child_session` 在 `packages/sdk-java` 全仓零命中,`managed_agent_session` 无层级列。`qwen_managed_session_extension_record`(V18;task 列自 V23 可空)按最新 revision 物化 `domain`、`delivery_target` 与 `delivery_state`,无 delivery-pending 索引。Flyway 处于 V47(`V45__managed_session_task_journal` 为后来的 task-view outbox 保留了名字 `qwen_managed_session_task_event`;H4b 不得占用)。公开 OpenAPI 契约为 1.33.0,`TaskKind.child_agent` 已是 `partial`;H4b 不需要公开契约变更。
- **Profile。** 私有 Hosted Workspace profile(`hosted-workspace-files|shell/1..2`)存于 `tool_profile` 列;生产 AgentBundle 启用保持独立,与 H1–H3 相同。

## 决策

1. **一个生产者平面、两条调用路径。** 全部六个 child 操作都是 Session authority 层(TypeScript)上的方法——父 journal 的唯一写方,且一律以 actor `trusted_entry` 提交——它是 `domain.committed` 唯一许可的 actor 类别,也是 H3 进程内 result/maintenance 提交已在用的类别。Agent 工具的准入在进程内调用 `startChildRun`;Java 控制面经嵌入式 session-command 表面调用其余操作。journal 不存在第二条写路径(H0c 不变量),relay 只能经这些操作触碰父 store。
2. **launch 提交先于任何副作用完成。** `startChildRun` 先发布 launch-input 资源(决策 11 的 envelope),再提交 revision 1:run `admitted`、execution `intent`、delivery `planned`,携带 launch 身份(`childRunId`、`ownerScopeId`、`rootSessionId`、`depth`、`completion`、`workspaceMode`、`workingDirectory`、`predecessorChildRunId`、`resultVersion = 1`)、definition pin 与发起调用的 `executionCallId`。与 H4a 决策 3 一致,跨 Session 创建幂等键派生自已提交的记录键(`sha256(父 session key | child_run | childRunId)`),因此记录体的 launch 身份与创建命令不可能分叉;一次结果不明的创建以 replay 对账,绝不盲重发。
3. **`workspaceMode`:仅准入 `shared`。** 参考设计的默认(写入型 child 使用独立 worktree)需要 Workspace 各阶段尚未交付的 Runtime 能力——worktree 生命周期、配额与关闭时合并均未交付——而只读 snapshot 需要尚无任何 provider 实现的冻结视图。`shared` 不需要任何新能力:child 与第二个创建者 Session 一样绑定父方 Workspace,继承既有 Workspace 租约/结算纪律(共享同一 Workspace 的多个 Session 本就经它串行化)。指名 `snapshot` 或 `worktree` 的 launch 在准入处以工具错误拒绝并报明不支持的模式;契约词表为其切片保留。这把此前 H4 框架的"只读 snapshot 优先"进一步收窄,是有意的:第一个运行时切片证明的是 Session、relay 与级联,而不是隔离。
4. **depth 与并发是 launch 时拒绝,不产生记录。** 超过 depth 1(契约上限 8;嵌套运行时支持随其自身证据落地)或超出按 scope 的活动 child 上限(4,另在 serve 既有租户在飞界限之上)的 launch,由 Agent 工具准入以工具错误拒绝并报明 H0b 配额原因(`depth_limit`/`count_limit`);不提交任何记录,与 legacy spawn 守卫在任何注册表条目前拒绝的做法一致。而到达 _relay_ 的控制面拒绝(例如创建时撞租户 Session 上限)则结算为一个 failed run(`quota_exceeded`、execution `not_started_proven`、`childSessionId` 为 null)——父模型可消费的证据——绝不静默重试成越界。
5. **前台与后台在 acceptance 之前共用一条流水线。** 创建、lineage、relay 盯守与结果复制完全相同。两臂只在 accept 事务分组上不同(参考设计第 8 节,自动化设计第 5 节):
   - `"tool"`——Agent 工具调用保持挂起,跨任意多轮模型往返与重启。relay 提交结果时,父方依次提交:(a) `commitChildResult`——child-run settling revision,携带父持有的结果与回执副本,delivery 进 `accepting`;(b) `acceptChildResult`——只提交 acceptance 记录(不产 input,不产 wake,永远不);(c) 原工具调用的结果提交,紧随其后再提交 `accepting → accepted` 后继。模型可见应答与 delivered 事实是两个有序提交,而不是一次折叠事务——消息 sink 不是 authority 提交面——且等待者的应答永远可重推导:任何崩溃之后它重读自己的 journal(settled run + acceptance)并从已提交副本构造 tool result,因此 (b) 与 (c) 之间的崩溃按证据应答,绝不按 relay 内存,这对提交也绝不可能持久地"答了一半却没有回到答案的已提交路径"。运转中途被取消时,被放弃的只是应答:child 继续跑完其 settled 结果与 `accepted`,consumption 保持未提交——呈现为 accepted-未-consumed,绝不放宽。
   - `"sent"`——launch 立即返回任务句柄。accept 事务把 acceptance 记录与 notification input 及其 authority 生成的 wake 打包在同一事务(既有的 `commitExtensionRecord` input 打包);通知携带已接受结果的**有界**摘要——转义后按远低于本 input 与后续 wake 信息封套的内嵌上限做限长,截断时明确标记并指向 acceptance 记录的 `contentRef`——全文字节随 acceptance 走。child-run delivery 推进到 `accepted` 是 H4a 决策 4 允许滞后的独立 relay 提交——绝不致腐,因为 acceptance 记录已经阻止重投。
6. **consumption 是进度证据,与 acceptance 分离,两臂皆然。** 当消费了该结果的父轮——由 notification input 启动的 wake 轮(`"sent"`),或收到折叠 tool result 的轮(`"tool"`)——提交其 `turn.settled` 时,Harness 提交两个 consumed revision(`child_acceptance` delivery `accepted → consumed`,然后 `child_run` delivery `accepted → consumed`)。acceptance 后继规则(一步、不可回退,H4a 决策 9)使过急的消费无法提交;消费提交前的崩溃保持 `accepted` 原样——重读仍为 accepted-未-consumed,绝不放宽(参考设计第 14 节第 7 条)。
7. **acceptance 记录是权威(欠下的 delivery 方向决策)。** H4a 的 follow-up 注记要求 H4b 裁决:`child_run` delivery 今天可以在没有 acceptance 记录时推进到 `consumed`,或在已有 acceptance 后回退到 `unknown`/`rejected`。本切片在 authority 与 Java store 双侧增加反向提交检查:delivery 进入 `accepted` 或 `consumed` 的 `child_run` revision 所指 `childRunId` 必须在本 Session 已有 acceptance 链(处于 `accepted` 或更远);一旦该链已存在任何 acceptance revision,拒绝 delivery 进入 `unknown` 或 `rejected` 的 `child_run` revision。不存在 acceptance 时,`planned → accepting` 与 `accepting → unknown` 仍合法(relay 的重试词表)。
8. **relay 位于 `managed-agent-server`,受其自有台账约束。** 一个定时 worker 扫描 `qwen_managed_session_extension_record` 中 `delivery_state IN ('planned','accepting','unknown')` 的 `child_run` 行(V51 增加配套索引),逐行对照 child Session 的已提交状态对账——创建应答、Session 状态、已 settled 的轮。其自有表 `qwen_managed_child_result_relay`(V51;*不取*保留的 task-event 名)为每个已认领 child run 存一行:认领租约与心跳、幂等创建键、已知后的 child Session id、尝试/退避计数,以及持久分类——`orphaned`(父方关闭中/已关闭)与 `unknown`(双向皆不可证的结果)——这些分类在 worker 重启后仍存活,且绝不可被呈现为 consumed 或触发重执行。行在创建认领时铸造,因此 relay 重启后从自己的已提交认领恢复并重新查询原 occurrence,与生命周期协调器的 recover-operations 样式一致。relay 端到端幂等:二次认领(或持过期租约的第二个 worker)会 replay 创建、重读结算、重提 acceptance;每个 authority 操作对重试返回原回执。已答的 acceptance 不短路任何欠步:`accept` 已提交但 `delivering` 前进丢失的 `watching` 行经同一条幂等走法对账——重放结果、重放 acceptance、再前进——台账的 mark_accepted 步与完成绝不卡死在非 delivery 的早退里。
9. **child 的终态结果与回执是父方持有的副本,按 digest 绑定**(H4a 决策 6)。relay 读取 child Session 自己的发布物(其 settled 末轮内容与轮结算证据),随 `commitChildResult` 提交字节;父侧先把它们存为*自己的*资源,settling revision 才能指名;acceptance 的 `contentDigest` 与两个引用把副本绑到原件,因此同记录不同内容的重投是冲突——以 `409 managed_session_extension_record_rejected` 拒绝——而非第二次接受。回执是有界结构化摘要(turn id、settle 序列、终态分类),不是 child 的 journal。
10. **启用按 kind 选择性放行,因为一个 domain 现在承载两项独立的启用闸门。** 按 domain 启用 `child_run` 会经由同一闸门唤醒 H3 的 background-shell 生产者(`childRunAdmissionsEnabled()` 读 domain 列表),而 H3 的启用明确在等待其 H3 闸门。本切片因此不把 `child_run` 放进 `MANAGED_SESSION_ENABLED_DOMAINS`,转而在其旁引入按 kind 的闸门:`MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS`,初始为 `['child_agent']`,由 authority 对该 domain 的准入与工具轮准入共同检查(`agent` 按 kind 闸门准入;`is_background` 的 shell 准入继续读 domain 列表并保持关闭)。`child_acceptance` 只有一种形状,直接进入普通启用列表。H3 闸门过线时,`shell` 加入 kind 闸门(或进 domain 列表并退掉 kind 闸门)——那是 H3 的决定,不是本切片的。server-first 顺序与 H4a 的安排完全一致:Java store 自 H4a 发布起就会校验两个记录体,因此携带这些写者的发布先部署 server,任何写者此后才能提交;H3 的 reader 兼容性论证不变(记录体在每个 managed-session/1 reader 上可解析;新形状对旧写者 fail-stop,且尚无任何 Session 持有这些记录)。
11. **child 是普通绑定 Session 加 lineage 印记——v1 克隆父方定义。** `createChildSession`(`createWorkspaceSession` 的服务级兄弟,只允许 relay 调用)在父方租户与 Workspace 绑定内创建 Session,沿用父方 tool profile,把谱系写进 V51 列(`parent_session_id`、`root_session_id`、`parent_child_run_id`、`child_depth`),并以 launch input 驱动其首轮。launch input envelope(`inputRef` 内容,有界 JSON)携带 `{ description, prompt }` 与 definition pin。v1 中 pin 指名*父方自己的* agent 定义(launch 时的 id、revision、digest):自定义 `subagent_type`——其 prompt/工具组合属于 D8b/D8c 的"将定义字段应用到执行"范畴——在准入处以工具错误拒绝并报明该范畴,本切片绝不半截应用一个定义。Agent 工具的 managed 参数为 `description`、`prompt`、`run_in_background`(v1 没有 `name`:teammate 路由是 H4e 的域,一个不起作用的 name 就是死开关);`fork_*`、`working_dir`、`isolation`、profile 与 type 选择器保持 legacy 专属。child 不与父共享模型上下文或权限视图(参考设计第 8 节):其初始上下文经由普通 Hosted Session 准入路径,由共享 agent 定义加 envelope 组合。
12. **`continueChildRun` 与 `queryChildRun` 在 v1 没有提交面,不作为操作实现。** 延续槽位(`predecessorChildRunId`)已在记录体内;它真正的生产者是 peer 消息与 revive 路径(自动化设计第 5.1 节,"paused/completed 沿 continueChildRun 的新运行身份继续"),属 H4d;_失败_ child 之后的诚实恢复是一个新的独立 run,绝不是重放不可知的工作(参考设计第 14 节第 10 条)。`query` 不需要 journal 写入:relay 在 SQL 投影(`qwen_managed_session_extension_record` 最新行加 Session lineage)上对账,TypeScript 侧消费方(级联、工具轮等待者)直接读 authority 重建出的记录——投影已能回答的事不为它另造操作。`cancelChildRun`/`closeChildScope` 会实现,级联是其 v1 唯一调用方(公开取消属 H4f)。
13. **close 级联:先取消后关闭 Harness;父侧不可达时物理优先;证不明绝不改写。** 在 `SessionLifecycleCoordinator.settle` 中,准入屏障(既有)之后、Harness 关闭之前,协调器要求父侧对每个未终态 `child_agent` run 执行 `cancelChildRun`(提交停止请求:`stopRequested` 置位,run 不变——请求不是终态),然后经 **child 自己的 Session 生命周期**逐个关闭 child Session——级联准入 child 的幂等 close 操作(run 的稳定键、从父方绑定克隆的 child actor),派发它,并等待 child 的 Session 终态,递归级联;Turn 仍活跃的 child Session 拒绝该准入,整个 close 重整直到该 Turn 由自身机制结束——再提交每个 child 的终态 revision(`stop_requested` 所致 `cancelled`;child 的 Session 状态达到终态可证时 execution 为 `settled`,child Session 从未受理时为 `not_started_proven`;delivery `cancelled`)。launch 记录体从未习得 child Session id 的 run(create→attach 窗口)按 relay 台账、**再到已提交的 lineage 行**定位 child——创建管线在 insert 时即印记它自己的 lineage,因此记录体与台账都缺 id 的窗口里 child 仍可被定位,台账缺 id 永远不是 `not_started_proven` 的证据。这类 child 的 `dispatch_started`/`attach` 按其已证证据(其自身已提交的 dispatch 事实,或它 warm 起来的物理 Runtime 绑定)经合法记录转移重放,再提交 settling revision——记录体解析器只在 attach 已提交的链上接受 `settled`,relay 自身 attach 前丢失回复不再把父方 close 卡死在对一条无人能读的 revision 的永远重试里。若父方写者不可达(Harness 崩溃、`qwen serve` 无活写者),stop 请求与终态 revision 保持欠账:关闭操作在协调器既有的 retry/blocked 分类中重试它们,且绝不凭猜测把 run 改写成 cancelled(第 12 节:观察超时只限定 API 等待,绝不释放物理 owner)。此类 child 的迟到结果即决策 8 的 orphaned 分类。不实现 detach:对未接管 child 的 detach 请求一律拒绝,与 H3 拒绝其未接管进程的做法一致。
14. **公开契约面不动;v1 仅准入 Shell-lane profile。** OpenAPI 保持 1.33.0(`TaskKind.child_agent` 已是 `partial`;任务列表会显示投影早已会映射的 `child_agent` 任务);不动路由、不动 Flyway 之外的 schema、不动 WebShell 类型。V51 是唯一迁移,承载 lineage 列、relay 台账与扫描索引。零缺口的 `contract-known-gaps.txt` 逐字节不变。Agent 工具恰好在 Session 拥有其 child 编排面(经已证明的 Shell lane,`hosted-workspace-shell/1..2`)时广告;`hosted-workspace-files/*`——包括公开 files/1 会话流——逐字节保持其现有工具词表与行为。files profile 与公开流的 child 准入是其各自独立的闸门,与公开前台 Shell 准入(#13271)同一方式,而不是本切片的伴随效应。

## 流水线逐 revision 展开

父 Session(authority 在 `qwen serve` 上;全部提交单写者):

| 步骤 | 提交               | 内容                                                                                                                                                            |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | launch(rev 1)      | run `admitted`、execution `intent`、delivery `planned`、pin、诸身份(§D2)——`startChildRun`                                                                       |
| 2    | dispatch(rev 2)    | execution `dispatch_started`、`dispatchId`、`run.runtime`(被受理的创建所分配的 binding;run 契约要求 binding 在 dispatch 时登记,此后不可补)——控制面受理创建之后  |
| 3    | attach(rev 3)      | `childSessionId`、execution `running_attached`,child Session 的 Harness 确认存活之后(记录体不允许 Session 出现在更早的执行态)                                   |
| 4a   | settle(rev)        | execution `settled`、run `settled`/`completed`、`resultRef`+`terminalReceiptRef`(副本)、delivery `accepting`——`commitChildResult`                               |
| 4b   | 失败终局           | run `failed`/`creation_failed`·`child_failed`·`quota_exceeded` 或 `cancelled`/`stop_requested`,execution `settled` 或 `not_started_proven`,delivery `cancelled` |
| 5    | accept             | acceptance 记录 rev 1(`settled`,`accepted`)(`"sent"` 臂 + notification input + wake)——`acceptChildResult`                                                       |
| 6    | accepted(rev)      | child-run delivery `accepting → accepted`——折叠进 tool-result 提交(`"tool"`)或独立 relay 提交(`"sent"`)                                                         |
| 7    | consumed(两个 rev) | acceptance `accepted → consumed`,然后 child-run delivery `accepted → consumed`,随消费轮的 settle                                                                |

每个提交让每条状态线至多前进一格(H0b 后继规则),因此任意两行之间的崩溃都从最后一个已提交行对账。Java relay(控制面):认领 launch,驱动创建直到被受理(rev 2),确认 child 的物理 Runtime 绑定存活(rev 3——绑定自 child 首个 Hosted 工具轮的 warm 起就存在,纯文本作答的 child 同样可证),盯守 child 至终,复制结果/回执,提交步骤 4–6;父方 `close` 经 `cancelChildRun`/`closeChildScope` 走步骤 4b;发现父方已关闭的结果在台账标记 `orphaned`。relay 在创建已受理(Session 已物理存在)与 rev 3 之间崩溃时,以派生键 replay 创建——lineage 列与幂等键指名同一个 Session——然后 attach;父 journal 在 attach 时才知道该 Session,绝不靠推断。

## 配额

| 界限                       | 取值                                                                                                                                                        | 拒绝方式                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Depth                      | 1(契约上限 8)                                                                                                                                               | launch 工具错误,`depth_limit`        |
| 每 owner scope 活动 child  | 4                                                                                                                                                           | launch 工具错误,`count_limit`        |
| Launch envelope            | ≤ 32 KiB UTF-8(description ≤ 512 字节)                                                                                                                      | launch 工具错误,`byte_limit`         |
| 每 child run 的 relay 尝试 | 有界退避,然后 `unknown`                                                                                                                                     | 台账分类,绝不重跑                    |
| 结果复制                   | ≤ 64 KiB,与父 Session 持久内联上限钉齐(更大结果以 `byte_limit` 拒绝,run 记 `failed/quota_exceeded`——更大输出的 Artifact 暂存属后续 O 切片工作,不在此处内联) | `commitChildResult` 在 settle 前拒绝 |
| 通知内联拷贝               | ≤ 64 KiB(先转义再带标记截断;全文字节留在 acceptance 记录上)                                                                                                 | 截断,绝不拒绝                        |

## 非目标

- **`snapshot`/`worktree` 工作区模式**、**depth > 1**、**自定义 subagent 定义**——准入处拒绝(决策 3、4、11)。
- **`continueChildRun`、detach、公开取消、workflow/peer/team kind、orphan GC 策略**——H4c–H4f 及后续,按交付地图。
- **生产启用**:仅私有 Hosted profile;AgentBundle 能力清单与 §13 H4 闸门的真实栈验收(含 §14 第 2、7 条)保持已记录的跟进闸门——本切片提供实现与 store/authority 证据供其核验。
- **任何 Legacy 路径变更**:进程内 Agent 工具、`create_sub_session`、`send_message`、workflow 与 team 保持现状;参考设计禁止运行中切换引擎。

## 涉及文件(计划)

- `packages/core/src/managed-runtime/`:`managed-session-records.ts`(kind 闸门与断言)、`managed-session-authority.ts`(按 kind 选择性准入与反向 acceptance 检查)、新增 `managed-child-operations.ts`(六个操作记录体——launch/attach/dispatch/settle/fail/cancel 与 acceptance——以及 launch envelope 编码与幂等命令构建)、`managed-extension-projection.ts`(不动——`child_agent` 任务映射已存在;测试钉住),外加与 H4a 套件对应的并置测试。
- `packages/core/src/tools/` 或 `packages/cli/src/serve/hosted-workspace-tool-turn.ts` 的工具轮接线:managed `agent` 工具准入(kind 闸门 + profile)、挂起结算等待者与重启重推导;在 `hosted-child-run-session.ts` 旁新增 `hosted-child-agent-session.ts` 动词漏斗(admit/dispatchStarted/attach/settle/settleFailed/requestStop 与 acceptance 动作及 delivery 推进——深等短路、`${id}:${rev}` 命令 id、`trusted_entry`、单条串行写链,完全照 H3 的漏斗纪律);通知写入对照 `hosted-monitor-notification.ts`;wake 调度复用 embedded scheduler 与 `pendingSessionInputs`;consumption 提交随 wake 轮/工具轮 settle 路径;重开 verifier 的 `domain.committed` 白名单纳入 `child_acceptance`(H3 已纳入 `child_run`),关闭时 pending input 结算覆盖 child 通知。
- `packages/sdk-java/managed-agent-server`:`V51__managed_child_lineage_relay.sql`(lineage 列、`qwen_managed_child_result_relay`、扫描索引)、session 实体/创建路径的 lineage 字段、`ManagedAgentService` 的 `createChildSession`、`ChildResultRelay` worker、`SessionLifecycleCoordinator.settle` 的级联步骤、`ManagedExtensionRecordStore` 的反向 acceptance 检查、面向 `qwen serve` 的嵌入式 session-command 表面上的 child 操作端点,以及与 TypeScript 对应的 store/契约测试。
- 反向 acceptance 闸由双语言的 authority 与 store 测试钉住(它是 authority 提交规则,非记录体文法属性——共享 fixture 不覆盖);authority 操作套件沿用 `managed-session-authority.child-agent.test.ts` 形制。
- 双语设计文档;`.qwen/e2e-tests/` 下的 E2E 计划。

## 验证计划

- **TypeScript**:每个操作的 authority 套件——launch 拒绝矩阵(closing、depth、上限、模式、envelope)、每条命令的幂等 replay、cancel/close revision、反向 acceptance 检查、放行 `child_agent` 同时拒绝 `shell` 记录体的 kind 闸门、重开重建一致性;工具轮套件覆盖准入、挂起结算、崩溃重推导与 settle 时的 consumed 提交;`pendingSessionInputs` 的 wake 消费套件。
- **Java**:store 套件覆盖 lineage 持久化、幂等创建 replay(同键同 Session;同键不同摘要即冲突)、反向检查答复 `409`、relay 台账认领/过期与 orphan 标记;协调器套件覆盖级联顺序与证不明 child 的分类;relay 对假 child Session 生命周期的端到中段。
- **双语言**:fixture 重放在两侧增加反向检查后继;既有 H3/H4a 语料原样重放。
- **启用契约测试**:kind 闸门放行 `child_agent`、拒绝 `shell`,`child_acceptance` 进入普通列表——与接入生产者同一改动;启用保持显式,零缺口契约文件不动。
- **故障注入(store/authority 级)**:launch 提交前崩溃;launch 与创建之间;创建应答与 attach 提交之间;settle 与 accept 之间;accept 与 delivery 推进之间;accepted 与 consumed 之间——每次运行恰好一个 child Session、至多一次结果送达,或落得可见的 `unknown`/`recovery_blocked` 分类;orphan 结果绝不复活已关闭父方。§13/§14 的产品栈运行(多实例 fencing、第二主机)保持 #12380 记录的独立验收闸门。
- **变异检查**:逐条使新增校验规则、转移与幂等检查失效,各语言都有测试变红,与 H0b 的既定做法一致。

## 验收标准

- 三个事实分别可观察:child terminal(child-run settle)、父 accepted(acceptance revision + child-run delivery `accepted`)、父 consumed(两条 delivery `consumed`)——两条完成臂皆然。
- 重启后的 relay 只重投未 `accepted` 的原结果,绝不为同一已提交 launch 创建第二个 child;创建与 accept 之间崩溃的 relay 从已提交 occurrence 对账;相同的重复 acceptance 返回其已记 revision。
- 关闭中的父方拒绝新 launch,经普通流水线取消其未终态 child,且绝不被 orphan 结果复活;证不明的 child 使关闭进入 retry/blocked,不被改写。
- 按 kind 选择性启用:`shell` 记录体保持被拒而 `child_agent` 可提交;反向 acceptance 检查在双语言拒绝 H4a 指认的矛盾;`child_run` 不进普通启用列表。
- 全部既有套件保持绿——每个 H1–H3/H4a 契约重放、authority、store、工具轮与生命周期测试,`npm run typecheck && npm run lint && npm run build && npm run bundle`,以及 `managed-agent-server` 全套 surefire。

## 开放问题

1. **`unknown` delivery 的运维故事**留给 H4f(取消切片),由其决定运维如何关闭一条永久证不明的 delivery;本切片的台账持久记录 `unknown` 并拒绝猜断。
2. **更大结果的暂存位置。** 256 KiB 复制界限会把大输出推向 Artifact 暂存(O 切片规则);`resultRef` 能否在后续 revision 引用 Artifact manifest,随 child 输出的跟进工作定,不在此处。
3. **`"tool"` 臂的挂起等待者是否需要除已提交记录外的自有持久行**——现有证据(settled run + acceptance 恒足以应答)表明不需要;真实栈发现可以再加,不构成契约变更。
4. **relay 表生命周期**:orphaned/已闭台账行的保留与删除,随 Session 归档/删除工作(#13135/#13194 跟进)处理;本切片只铸造与更新行。

## 后续工作

| 切片   | 范围                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| H4c    | `workflow` 记录体 kind 与 Workflow 工具作为 child run 的准入(definition pin 指名 workflow revision)。                 |
| H4d    | `session_message` 记录体,`continueChildRun` 的第一个诚实生产者,以新链复活已完成 child。                               |
| H4e    | team 各 domain 与七个 team 工具、plan 决议、成员关停、legacy 导入。                                                   |
| H4f    | 公开任务取消路由,结清 #12847 A6/A7 与 B12;`unknown` delivery 的运维故事(开放问题 1)。                                 |
| Detach | 把显式 detach 的 child 迁往独立 durable owner,跨父方关闭。                                                            |
| 隔离   | `snapshot` 与 `worktree` 模式及其 Runtime 能力;depth > 1;与 D8b/D8c 协调的自定义定义应用;经 Artifact 暂存的更大结果。 |
