# Managed agent 团队:lead 一侧的运行时(H4e-b1)

[English](2026-10-10-managed-agent-team-lead-runtime.md) | [简体中文](2026-10-10-managed-agent-team-lead-runtime.zh-CN.md)

状态:已实现并已启用。#13824 落地了 lead 的团队写入漏斗、Hosted 路径上的五个团队工具与 Agent 工具的 `name`、`<teammate>` 标签、`task_list` 的预批准与输入预览,以及重开白名单,当时两个 domain 仍关闭。启用变更在验证计划所记录的实机验收之后,把 `team_state` 与 `team_task` 加入启用列表,并带上这次验收改动的唯一一条规则(决策 5:已完成的成员可作为已完成任务的 owner)。`team_message` 与 `team_plan` 保持关闭。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4e** 的第一个运行时切片,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段,由 [#13745](https://github.com/QwenLM/qwen-code/issues/13745) 跟踪。它建立在 H4b([child Session 运行时](2026-10-07-managed-child-session-runtime.zh-CN.md),#13550)与 H4e-a([团队记录契约](2026-10-10-managed-agent-teams.zh-CN.md),#13811)之上,首次生产后者的四个团队记录体与 lead Session 规则。

## 问题与范围

H4e-a 固定了团队可以提交什么:名册与生命周期(`team_state`)、任务板(`team_task`)、mailbox(`team_message`)与计划审批(`team_plan`),全部位于 lead Session 的 journal 中,全部禁用。还没有任何东西生产它们。在 Hosted 路径上,lead 可以启动 child agent(H4b),但无法为它们命名、把它们编成组、给它们一块任务板,也无法删除团队;`name` 在准入时作为 legacy 专属参数被拒绝,也没有声明任何团队工具。

H4e-a 设计把整个运行时交给了 "H4e-b"。这一片太大,无法一次落地,其中一部分还要等尚未开始的工作。mailbox 中继、成员一侧的投递以及成员的续跑,都建立在 H4d-b(Session 消息运行时,见 [H4d-a 设计](2026-10-09-managed-session-messages.zh-CN.md))之上,而 H4d-b 尚无实现;计划审批与成员关停都以 mailbox 消息传递。因此 H4e-b 拆为三片:

| 切片               | 范围                                                                                                                                                                                                                                     | 等待     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **H4e-b1**(本设计) | lead 一侧的团队:`team_create` 与 `team_delete`、用于拉起成员的 managed Agent 工具 `name`、lead 的任务板(`task_create`、`task_update`、`task_list`)、带名字的成员汇报,以及团队下的关闭级联(#13745 E3)。启用 `team_state` 与 `team_task`。 | 无新依赖 |
| H4e-b2             | mailbox:`team_message` 中继、`send_message` 的团队路由、成员一侧的投递与回执、成员一侧的团队工具(成员通过发给 lead 的命令读取与更新任务板)、任务分配的投递,以及成员续跑。启用 `team_message`。                                           | H4d-b    |
| H4e-b3             | 计划审批(`team_plan`、`plan_mode_required`,经由 D6 action 的 `team_plan_approval`)、`request_shutdown`、旧团队导入,以及经过实机验收后的最后一次启用。                                                                                    | H4e-b2   |

H4e-b1 不需要任何尚未落地的东西。它的成员就是 H4b 的 child agent,因此创建、relay、配额、结果投递与关闭级联都沿用 H4b,不做改动。H4e-b1 新增的是围绕它们的团队。

## 现状

以下事实取自 `main` 的 `f733ffbd4a`。

- **记录。** 四个团队记录体已在两种语言中登记并校验,带有 H4e-a 的规则:团队由自己的 Session 领导;成员以一个存活的、没有其他团队列出的 child Session run 加入;任务、消息或计划请求只能在 active 的团队中开启;任务编号在团队内唯一;owner 是 `leader` 或成员;依赖留在团队内且不形成环。四个 domain 都不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中。Java 没有启用列表:它的 store 校验每个已登记的记录体,因此这些 domain 的 server 先行顺序已经成立。
- **Hosted Agent 工具。** `HOSTED_AGENT_TOOL` 声明 `description`、`prompt` 与 `run_in_background`,且只在 child depth 为 0、`child_agent` kind 门禁打开时,在 Shell 或后台通道上声明。准入把其他任何参数(包括 `name`)作为属于 legacy Agent 工具的参数拒绝。一次启动经 `HostedChildAgentSession.admit` 以命令 id `childRunId = ${promptKey}:${callId}` 提交 `child_run`,同一调用的重放返回已提交的记录。准入对每个 Session 最多计 4 个活跃 child 与 64 次启动(`MANAGED_CHILD_LIMITS`)。后台 child 立即回答调用;其结果随后作为一个 `<task-notification>` input 到达(`childResultNotificationText`),失败或被取消的 child 不发送通知。
- **relay 与级联。** Java 的 `ChildResultRelay` 创建、绑定、观察并完成每个 `child_agent` run,在结果投递后关闭 child Session:一个 child 运行一轮即结束。`SessionLifecycleCoordinator.settle` 把父关闭级联到每个存活的 `child_agent` run:停止请求、child Session 自己的关闭,然后是 `cancelled`/`stop_requested` 终态修订。开启中的父 Session 的 child 没有其他停止途径;公开的 child 取消属于 H4f(#13746)。
- **生命周期门禁。** 在 close 或 delete 认领下,Java store 只为 `hook_execution`、`hook_registration`、`child_run` 与 `child_acceptance` 放行 `domain.committed`,且不放行任何 input。lead Session 关闭期间,团队记录无法提交。
- **Hosted 工具接线。** 一个工具需要在 `declarations()` 中声明,需要一个 `prepareRequests` 分支、一个执行分支,并且在不触及 Workspace 时(如 `agent`)不参与 Broker acquire 与 Runtime 预留。Hosted Session 提交的每个 domain 都必须在 `verifyWorkspaceRestore` 的重开白名单中,否则重开会以 "Hosted recovery domain is unsupported." 失败。在 `default` 与 `auto-edit` 模式下,预批准列表之外的每个工具都会请求审批,`yolo` 模式下从不请求;`HOSTED_INPUT_PREVIEW_TOOLS` 必须与 Java 的 `ManagedActionService.PREVIEW_TOOLS` 逐字节一致。
- **Legacy。** 一个 Config 最多持有一个团队("A team is already active. Delete it before creating a new one."),且只由 leader 创建。Agent 工具的 `name` 把 teammate 拉起到当前团队中,没有团队时被静默忽略;teammate 总是并发运行,对它们拒绝 `run_in_background: false`,`plan_mode_required`、`read_only` 与 `model` 各有规则。成员从不从名册中移除,因此已结束的 teammate 仍占着名字,并计入 `MAX_TEAMMATES`(10)。teammate 是长驻的:每次进入空闲时把最终文本汇报给 leader,然后等待下一条消息。`team_delete` 强制中止所有 teammate。`task_create` 与 `task_update` 默认请求审批;`task_update` 校验自指边、缺失任务与环,把每条边镜像到两端任务,要求 `in_progress` 有 owner,并向 owner 发送任务分配提示。`task_list` 列出任务板,对 leader 还会清空 leader 的收件箱。

## 决策

1. **每个 lead Session 只有一个开启中的团队,且只由 lead 操作。** 与 Legacy 一样,一个 Session 同一时间最多领导一个开启中(`active` 或 `closing`)的团队。团队工具恰好在 Agent 工具声明的地方声明(child depth 为 0 的 Shell 或后台通道,`child_agent` kind 门禁打开),且只在 `team_state` 与 `team_task` 都已启用时声明。child Session 看不到它们:它的深度为 1,因此成员既不能创建团队,也不能拉起自己的成员。在 H4e-b1 中,每次团队写入都由 lead 完成。成员要随 mailbox(H4e-b2)才能访问任务板,因为成员的写入是从另一个 Session 发往 lead journal 的命令。
2. **`team_create` 以 Legacy 形式的名字开启团队。** 它只有一个参数 `team_name`。名字按 Legacy 规则清洗,然后必须符合 H4e-a 的名字形式(最多 64 个字符);清洗后为空则拒绝。团队 id 是该调用的键 `${promptKey}:${callId}`,因此调用的重放会找到已提交的团队,而不会开启第二个。提交的是 `team_state` 的开启修订:`active`、没有成员、`leadSessionId` 为本 Session。Legacy 的可选 `description` 不保留,因为记录中没有对应字段。Managed 团队没有文件也没有进程,因此 Legacy 的全局名字目录与基于 PID 的陈旧团队回收在这里没有对应物:团队名的作用域是其 lead Session。
3. **成员是具名的、一次性的、后台运行的 child agent。** 团队开启时,managed Agent 工具接受 `name`。带 `name` 的启动是一次 H4b 启动外加一次加入名册:
   - **准入**在 H4b 自身的检查之外加上团队检查,H4b 的检查(父 Session 正在关闭、配额、envelope)保持不变。团队必须是 `active`;清洗后的名字不能为空、不能是 `leader`,且在名册中尚未出现;名册必须少于 10 个成员;`run_in_background` 不能为 `false`。`plan_mode_required`、`read_only`、`model` 与 `subagent_type` 仍被拒绝:计划审批属于 H4e-b3,而只读或换类型的成员需要本切片无法应用的定义(H4b 决策 11)。同一个工具批次内,成员名必须互不相同,拉起成员的批次也不能同时创建或删除团队,或启动前台 child,因为前台 child 被恢复的等待(#13708)会把成员回答成普通的后台启动。
   - **执行**先以 completion `sent` 提交 H4b 启动,再提交加入:下一个 `team_state` 修订,以命令 id `${childRunId}:join` 追加 `{ name, childRunId, planModeRequired: false }`。准入已经检查过加入所执行的每条团队规则,而 lead 自己的写入是串行的,因此加入只会在一种情况下被拒绝:run 已经结束。H4e-a 只允许存活的 run 加入名册,而 relay 是异步工作的,一次创建被拒就可能在启动后几秒内让 run 失败。此时调用以该 run 的失败作答,成员不会加入,其名字仍然空闲。
   - **没有团队时**,`name` 以工具错误被拒绝,而不是像 Legacy 那样被忽略:一个静默失效的参数,正是 H4b 决策 11 拒绝过的死开关。
   - **生命周期。** 成员就是 H4b 的 child:它运行一轮,结果被投递,relay 关闭它的 Session。在成员可以被续跑(H4e-b2)之前,它无法接收更多工作。它结束后名册条目仍然保留,与 Legacy 成员一样,因此 10 的上限计的是团队整个生命周期中的成员,而同时运行的数量由 H4b 的 4 个活跃 child 上限约束,成员与其他 child 共用。
   - **崩溃窗口。** 已执行的调用在崩溃后不会再次运行,因此如果 Session 在启动与加入之间停止,已启动的 child 仍会作为普通后台 child 运行并汇报,既不重复也不丢失,其名字仍然空闲(开放问题 1)。在中断 Turn 的收尾会回答该调用的地方(决策 11),它被回答为已启动,加入已提交时再回答为已加入。只有重新驱动的批次(如果某天会再次运行同一调用,即同一 `childRunId`)才会重放启动,并在 run 仍存活时完成加入。在加入之前结束的 run 以其结束回答该调用:失败回答为失败,完成回答为已结束,其结果以不带标签的形式送达。
4. **成员通过 H4b 的通知汇报,并带上名字。** 成员的结果以与每个后台 child 相同的方式到达 lead:一个随其 acceptance 提交的 input,唤醒 lead。当该 child run 在名册中时,通知带有一个包含成员名的 `<teammate>` 元素。这对应 Legacy 的自动最终汇报。失败或被取消的成员不发送通知,与任何 H4b child 一样;`task_list` 会显示其状态(决策 6)。
5. **任务板属于 lead。** 三个任务板工具沿用其 Legacy 的 schema 与校验,差异列在"工具"一节:
   - **身份。** 任务的记录 id 是 `${teamId}#${number}`。其 `number` 比团队中最大的编号(含已删除任务)多 1,因此编号永不复用。只有尚未提交其任务的调用才会分配编号(决策 11),因此重放会以该调用已经取得的编号作答。模型以编号指称任务,与 Legacy 一样(`3` 或 `#3`)。
   - **内容。** `subject` 是内联文本(最多 200 个字符,与 Legacy 一致)。description 存为一个由 `descriptionRef` 指向的 Session 资源(工具中最多 10,000 个字符,与 Legacy 一致,在记录的 64 KiB 之内)。metadata 是由 `metadataRef` 指向的资源(最多 32 KiB);`task_update` 把键合并进去,值为 `null` 时删除该键,与 Legacy 一致。
   - **依赖。** `addBlockedBy` 追加到被更新任务的 `blockedBy`;`addBlocks: [B]` 把被更新任务追加到 B 的 `blockedBy`,这是 B 的一个修订。因此一次调用可能提交多条记录。在第一次提交之前校验每条边(没有自指边、每个任务都在团队中、不形成环、没有任务超过记录上限的 64 个阻塞方),随后按顺序以命令 id `${callKey}:${n}` 提交。重放会跳过已经落地的提交(决策 11),因此会完成部分提交的调用,且不会重复添加任何东西。一个任务只要其 `blockedBy` 中有任何任务既不是 `completed` 也不是 `deleted`,就处于阻塞状态。因此完成或删除一个阻塞方不需要写入其依赖方,而 Legacy 要逐一改写它们。
   - **owner 与状态。** `in_progress` 需要 owner,与 Legacy 一致;lead 没有隐含的名字,因此必须指名一个。调用设置或更改的 owner 是 `leader` 或一个 run 尚未结束的成员;`""` 取消分配。run 已成功完成的成员,也可以被设为该调用使之处于 `completed` 的任务的 owner,让任务板记下是谁完成的:成员必须先进入名册才能被指名,而实机验收表明一次性成员常常在 lead 的下一次调用到达之前就已完成,原规则下这样的成员永远无法成为其任务的 owner。失败或被取消的成员不能被设为 owner。成员的 run 结束后,任务仍保留原有的 owner,因此 lead 无需重新分配即可完成、修改或删除该任务。这正是常见的流程,因为一次性成员的汇报到达时,它已经结束。
   - **暂不投递任务分配。** 没有 mailbox 时,成员永远不会得知分配。`task_update` 把 owner 作为任务板事实记录下来,其回答会说明该成员没有收到通知。lead 在成员的启动提示中传达工作内容。
   - **删除**即 `status: "deleted"`,它结束任务的 run 并冻结任务。
6. **`task_list` 显示任务板与名册。** 其 schema 沿用 Legacy(`status`、`owner` 与 `blockedBy` 过滤条件),每行为 `#<number> [<status>] @<owner> — <subject>`,并附上尚未解除的阻塞方。由于还没有 mailbox,它不像 Legacy 那样清空 leader 收件箱,而是在回答末尾附上名册:每个成员及其 run 状态(`running`、`completed`、`failed`、`cancelled`),读自其 `child_run` 记录。lead 由此得知成员失败了,或团队可以删除了。
7. **`team_delete` 在有成员运行时拒绝;否则先关闭团队再删除。** Legacy 会强制中止其 teammate。在 Managed 路径上,lead 无法停止一个开启中 Session 的 child:唯一的停止途径是其自身 Session 的关闭级联,而公开的 child 取消属于 H4f。由于成员会自行结束,只要还有任何成员的 run 未结束,`team_delete` 就拒绝,并列出正在运行的成员。没有成员运行时,它以 `${callKey}:closing` 与 `${callKey}:deleted` 先后提交 `closing` 与 `deleted`。重放会完成停在 `closing` 的团队(决策 11),之后的 `team_delete` 也会完成它。一旦 H4f 为 child 取消提供了途径,`team_delete` 就可以请求停止正在运行的成员,而不是拒绝(见后续工作)。
8. **团队下的关闭级联沿用 H4b,关闭期间不写团队记录(#13745 E3)。** 成员是 `child_agent` run,因此关闭 lead Session 已经完成了 E3 要求的全部三件事。它经由 H4b 级联取消每个正在运行的成员(停止请求、成员 Session 自己的关闭、终态 `cancelled`/`stop_requested` 修订)。它绝不会因孤儿结果复活 lead(H4b 决策 8 与 13)。它让每个成员的终态事实都能单独观察到,即该成员自己的 `child_run` 修订。团队自身的记录保持原样。团队的生命以其 lead Session 的生命为界,读者把 lead Session 处于 closing、closed 或 deleted 的团队视为已关闭。这回答了 H4e-a 的开放问题 3。在认领下提交 `closing` 与 `deleted` 只会重复 Session 自身的状态,还会放宽如今只放行 child 与 hook 记录的生命周期门禁。因此 Java 生命周期门禁不做改动。
9. **审批遵循 Hosted 规则,只有一个例外。** `team_create`、`team_delete`、`task_create` 与 `task_update` 在 `default` 与 `auto-edit` 模式下请求审批,与预批准列表之外的每个 Hosted 工具一样,也与 Legacy 的任务板工具一样。`task_list` 只读取 journal,因此加入两种模式的预批准列表,与 `read_file` 和 `glob` 一样。带 `name` 的启动与任何 Agent 启动一样请求审批。`team_create`、`task_create` 与 `task_update` 同时加入 `HOSTED_INPUT_PREVIEW_TOOLS` 与 Java 的 `PREVIEW_TOOLS`,使审批界面显示要批准的团队名、subject、owner 与状态。
10. **按 domain 启用,并在实机验收之后。** 每个团队 domain 恰好承载一项能力。因此与 `child_run`(H4b 决策 10)不同,普通的启用列表就是合适的门禁,不新增按能力的门禁。这回答了 #13745 分诊提出的门禁形态问题。H4e-b1 落地运行时(#13824)时 `team_state` 与 `team_task` 仍保持关闭,测试像 H4e-a 的测试套件那样放开门禁;它的启用变更在真实 Hosted 环境上完成实机验收之后,才把两者加入 `MANAGED_SESSION_ENABLED_DOMAINS`,这是 #13803 在 #13532 之后采用的顺序。`team_message` 与 `team_plan` 保持关闭。`verifyWorkspaceRestore` 的重开白名单放行 `team_state` 与 `team_task`。Java 只需要决策 9 的预览列表:它的 store 自 H4e-a 起就已校验团队记录体,因此 server 先行顺序成立。
11. **重放从其调用已经提交的内容继续。** 每次团队写入都以由其调用派生的命令 id 提交:`team_create` 与 `task_create` 为 `${callKey}`,加入为 `${childRunId}:join`,`task_update` 的各个修订为 `${callKey}:${n}`,`team_delete` 为 `${callKey}:closing` 与 `${callKey}:deleted`。在计算一次写入之前,漏斗先用 authority 的 `committedExtensionOperation` 查询其命令 id。已提交的命令视为完成,由其已提交的记录回答调用。只有尚未提交的命令才按当前状态计算。查询必须放在前面,因为按当前状态重建的记录可能与已提交的不同:`task_create` 会分配下一个编号,而 `task_update` 后面的修订会已经包含同一调用较早添加的边。authority 会把已提交命令 id 下改变了的记录体作为冲突拒绝。这不需要任何记录字段:命令 id 就是该调用自身的持久痕迹。在团队写入与其回答之间中断的 Turn 不会被重放。每条结算或续跑中断 Turn 的路径,都会在模型下次读到这个 Turn 之前回答它遗留的只写 journal 的调用:channel 收尾(无论 checkpoint 是否绑定该 Turn)、用户 Turn 的取消接管、park 中 Turn 的 cancel 与 continue 路径、Hooks 或 publication Session 的 bare load(包括 Hooks Session 的文件历史门),以及崩溃的 wake Turn 的善后。对于命令已提交的团队调用,回答为已全部或部分提交并指引模型查看 `task_list`;对于后台启动,回答为已启动(加入已提交时还回答为已加入),而不会回答为从未运行:否则 core 的 orphan 修复会让下一轮的模型重试该调用,重试会开出第二个任务或成员。续跑 Turn 的路径还会把什么都没提交的团队或 agent 调用回答为从未运行,因为续跑需要这一轮完整(否则待处理的文件历史检查会拒绝它),而没有任何 Runtime 结算会回答这样的调用。只结算 Turn 的路径则让这类调用保持该路径原有的回答。

## 工具

| 工具                 | 参数                                                                                                                 | 提交                                          | 与 Legacy 的差异                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `team_create`        | `team_name`                                                                                                          | `team_state` 开启修订                         | 没有 `description`;名字作用域为 lead Session;没有陈旧团队回收                         |
| `team_delete`        | 无                                                                                                                   | `team_state` 先 `closing`,再 `deleted`        | 有成员运行时拒绝,而不是中止它们                                                       |
| 带 `name` 的 `agent` | `description`、`prompt`、`run_in_background`(不能为 `false`)、`name`                                                 | H4b `child_run` 启动,然后是 `team_state` 加入 | 没有团队时拒绝而不是忽略;一次性成员;没有 `plan_mode_required`、`read_only` 或 `model` |
| `task_create`        | `subject`、`description`、`activeForm?`、`metadata?`                                                                 | `team_task` 开启修订,`pending`                | schema 无差异                                                                         |
| `task_update`        | `taskId`、`status?`、`owner?`、`subject?`、`description?`、`activeForm?`、`metadata?`、`addBlocks?`、`addBlockedBy?` | 每个被改动的任务一个 `team_task` 修订         | 不投递分配;完成时无需写入依赖方;只有 lead 可用                                        |
| `task_list`          | `status?`、`owner?`、`blockedBy?`                                                                                    | 无                                            | 附上名册及 run 状态,而不是清空收件箱                                                  |

## 一个成员的生命周期

| 步骤 | 提交                                          | 由谁                       |
| ---- | --------------------------------------------- | -------------------------- |
| 1    | `child_run` 启动(`sent`)                      | Agent 调用(H4b)            |
| 2    | `team_state` 加入(`membershipRevision + 1`)   | 同一个 Agent 调用          |
| 3–6  | dispatch、attach、settle、带名字通知的 accept | H4b relay,除名字标签外不变 |
| 7    | 消费                                          | lead 的唤醒轮(H4b)         |

第 1 步之后任何一步发生 lead 关闭,都会对该成员的 run 执行 H4b 级联(决策 8)。`team_delete` 等待每个成员走到第 4 步或以失败结束(决策 7)。

## 非目标

- **H4e-b2 与 H4e-b3 负责的一切**:mailbox、发给成员的 `send_message`、任务分配的投递、成员一侧的任务板工具、成员续跑、计划审批与 `plan_mode_required`、`request_shutdown`、旧团队导入,以及 `team_message` 与 `team_plan` 的启用。
- **在成员结束前停止它**(H4f 为 child 取消提供途径)与 **detach**(它自己的后续工作)。
- **只读、换类型或换模型的成员**,它们需要把定义字段应用到执行(D8b/D8c)。
- **任何公共契约变更。** 不改路由、OpenAPI 或 Flyway;公共团队资源属于 #13785。

## 受影响的文件

- `packages/core/src/managed-runtime/managed-team-operations.ts`(新增):团队开启、加入、`closing` 与 `deleted`、任务修订的记录体构造函数,以及派生的阻塞状态。
- `packages/core/src/managed-runtime/managed-session-records.ts`:启用变更在实机验收之后把 `team_state` 与 `team_task` 加入启用列表。
- `packages/cli/src/serve/`:
  - `hosted-workspace-tool-turn.ts`:声明门禁、Agent 工具的 `name` 及其准入与批次规则、在 Broker acquire 与 Runtime 预留之外的执行分支,以及输入预览列表。
  - `hosted-team-session.ts`(新增):五个工具的声明及其参数形状,以及位于 `hosted-child-agent-session.ts` 旁的团队写入漏斗:团队与任务板规则、名册视图与提交,遵循 H3 的漏斗纪律:单一串行写入链、确定性命令 id 与 `trusted_entry`,并在每次写入前执行决策 11 的已提交命令查询。
  - `hosted-child-agent-session.ts`:通知中的 `<teammate>` 标签。
  - `hosted-harness-session.ts`:漏斗接线与重开白名单。
  - `hosted-tool-approval.ts`:`task_list` 预批准。
- `packages/sdk-java/managed-agent-server`:`ManagedActionService.PREVIEW_TOOLS`,一个协调器测试,证明带开启团队的 lead 关闭会取消其成员且不写任何团队记录,以及一个生命周期门禁测试,确保关闭声明下团队记录仍被拒绝。
- 各文件旁的测试,以及 `.qwen/e2e-tests/` 中的 E2E 计划。

## 验证计划

- **工具轮。** 每个工具的准入矩阵,以及决策 2、3、5、7 的每种拒绝,包括批次规则。每个工具调用的重放:重放的调用不会增加团队、成员、任务或边。`task_create` 提交任务之后、工具结果之前的崩溃:重放以相同的编号作答,且不开启第二个任务。启动与加入之间的崩溃,两种结果都覆盖。删除之后的任务编号。完成、修改与删除 owner 的 run 已结束的任务。中途停止后再重放的多记录依赖更新。`task_list` 中的名册视图。`<teammate>` 标签。审批类别与预览。
- **Authority。** 没有新规则,因此 H4e-a 的测试套件照旧成立。重建持有团队记录的 Session 会恢复它们,重开白名单放行它们。
- **Java。** 带开启团队且有成员运行的 lead 关闭,会对成员执行 H4b 级联且不提交任何团队记录,生命周期门禁在认领下仍拒绝团队记录。
- **实机验收**,在启用之前,于真实 Hosted 环境上:
  - lead 创建团队,按名字拉起两个成员,分配任务板任务,收到两个带名字的汇报,把任务标记为完成并删除团队;
  - lead 在仍有成员运行时关闭,该成员被取消,而团队记录保持不变;
  - 在成员启动与加入之间杀掉 Harness:child 作为普通后台 child 继续运行,恰好只有一个 `child_run`,也永远不会出现第二个名册条目。
- **实机验收结果**(2026-10-10,aarch64 Linux 主机;打包的 Spring 服务端(含 Store、Broker、relay 与协调器)、打包的 Hosted Harness、持久本地 worker、MariaDB,以及真实模型 `qwen3.8-max`,审批模式为 `default`;计划与各项结果见 `.qwen/e2e-tests/h4e-b1-team-lead-runtime.md`):
  - 完整的团队流程已观察到。`team_state` 链为开启、两次加入、`closing`、`deleted`。两份汇报都带着 `<teammate>` 标签到达 lead:一次运行中在进行中的 Turn 内被消费,另一次作为唤醒 Turn 到达。第一次运行发现,两个成员都在 lead 用 `task_update` 分配之前就已完成,任务板因此拒绝把它们设为 owner。决策 5 的已完成成员规则解决了这一点,在启用 head 上的复跑把每个成员记为其已完成任务的 owner。
  - lead 在仍有成员运行时关闭,会取消该成员:它的 `child_run` 带着停止请求以 `cancelled` 结束,它的 Session 关闭,团队记录不变,lead 也从未被复活。关闭会等待成员的 Turn 结束(H4b 决策 13),这也包括成员正在等待的审批。
  - 在加入提交之前杀掉 Harness,留下一个 `child_run`、没有名册条目;在加入提交之后杀掉,留下一个 `child_run`、一个名册条目。两种情况下成员 Session 都会运行,但 lead 的 Turn 以 `managed_runtime_recovery_blocked` 失败,因此成员的结果永远到不了 lead(开放问题 5)。不建团队、改用不带名字的后台启动做同样的运行,结局相同。channel 收尾的回答(决策 11)没有覆盖到,因为该环境没有 channel 适配器。
  - 有成员运行时 `team_delete` 被拒绝,点名该成员,且不提交任何修订。`task_list` 不弹审批卡,`team_create`、`task_create`、`task_update` 与 Agent 的审批卡都显示输入预览。只从启用列表中去掉这两个 domain 的对照组不声明任何团队工具,也没有 `name`,且不提交任何团队记录。

## 验收标准

- 启用 `team_state` 与 `team_task` 后,Hosted lead 可以创建团队、拉起具名成员、维护任务板并删除团队,每个成员的结果都带着其名字到达 lead。
- 决策 2、3、5、7 中的每种准入拒绝都以工具错误作答,且不提交任何内容。
- 重放的调用绝不会开启第二个团队、成员、任务或边,重放的 `task_create` 以其已取得的编号作答,中途停止的调用在重放时完成。
- 关闭 lead 会经由 H4b 级联取消其正在运行的成员,绝不因孤儿结果复活 lead,让每个成员的终态事实都可观察,且不写任何团队记录。
- 只要任一 domain 被禁用,就不声明任何团队工具,`name` 仍被拒绝。启用只在实机验收之后翻转,固定禁用状态的测试被有意地翻转。

## 开放问题

1. **补齐未进名册的成员。** 启动与加入之间发生崩溃且再也没有重放,会留下一个没有名册指名的、正在运行的 child。Agent 调用不写 `tool.intent`,但它的参数(包括 `name`)保存在已入 journal 的 assistant 消息中,因此恢复后可以由一个补齐流程完成加入。本切片接受这种降级结果(一个普通后台 child),补齐流程留待后定。在非 channel 的 Turn 上,这次崩溃还会阻塞 lead 本身(开放问题 5),补齐流程要先等它解决。
2. **成员占用的活跃上限。** 成员与其他 child 共用 H4b 每个 Session 4 个活跃 child 的上限,而 Legacy 可同时运行最多 10 个 teammate。团队是否应有自己的活跃上限,待真实团队显示出需要时再定。
3. **让成员第二次派上用场。** 一次性成员无法接收更多工作。成员续跑(H4e-a 开放问题 4)属于 H4e-b2,与承载新工作的 mailbox 一起。
4. **在 Runtime park 之外被中断的 Hooks Session。** 现在每条恢复路径都会回答只写 journal 的调用(决策 11)。但 Hooks Session 从不接管,它的 bare load 只续跑停在 `results_ready` 的 Turn。在没有 Runtime 工作的批次(只有团队调用)中被中断的 Turn,会由 load 作答,但仍处于恢复阻塞,与任何在模型轮中途被中断的 Hooks Session 一样。团队调用扩大了这个窗口。这类 Turn 的恢复属于 Hooks 运行时,启用那一步应在团队于 Hooks Session 上运行之前解决它。
5. **后台启动过程中的崩溃会阻塞 lead。** Harness 若在一次启动提交之后、Turn 的下一个检查点之前死掉,该 Turn 会停在 `model_output_committed`,这是替代 Harness 拒绝接管的模型起步阶段,于是协调器以 `managed_runtime_recovery_blocked` 让该 Turn 失败。lead 的 journal 仍保留这个停住的 Turn,因此之后每次加载 lead 都回答 `hosted_turn_recovery_required`:relay 无法记录正在运行的 child 的 dispatch、attach 或结果,之后的每个 Turn 也以同样方式失败。实机验收在 Shell Session 上有团队与无团队时都遇到了这一点,因此它是 H4b 恢复的限制,而不是团队的限制;开放问题 4 是同一窗口在 Hooks Session 上的形态。团队调用会扩大这个窗口,与在那里一样;启用接受它,正如 H4b 的后台启动已经接受它,因为不声明团队工具也不能为那些后台启动关上这个窗口。

## 后续工作

| 切片   | 范围                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H4e-b2 | 在 H4d-b 之后:`team_message` 中继与 `send_message` 的团队路由、成员一侧的投递与回执(H4e-a 开放问题 1 与 2)、经由发给 lead 的命令实现的成员一侧任务板工具、任务分配的投递、成员续跑(H4e-a 开放问题 4);启用 `team_message`。 |
| H4e-b3 | 经由 D6 action 的计划审批与 `plan_mode_required`、`request_shutdown`、旧团队导入,以及实机验收后启用 `team_plan`。                                                                                                          |
| H4f    | 为开启中的 lead 提供 child 取消;届时 `team_delete` 改为请求停止正在运行的成员,而不是拒绝。                                                                                                                                 |
| Detach | 与 H4a 交付地图一致,不变。                                                                                                                                                                                                 |
