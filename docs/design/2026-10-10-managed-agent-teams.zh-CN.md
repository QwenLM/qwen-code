# Managed agent 团队:记录契约(H4e-a)

[English](2026-10-10-managed-agent-teams.md) | [简体中文](2026-10-10-managed-agent-teams.zh-CN.md)

状态:已在本变更中实现。已落地:`managed-team_state`、`managed-team_task`、`managed-team_message` 与 `managed-team_plan` 四个记录体,在 TypeScript 与 Java 中均已登记并校验,并带有把每条团队记录绑定到其 lead Session 的提交时规则。本变更未开放四个 domain 中任何一个的提交。仍为设计:中继 mailbox、裁决计划与关停成员的运行时(H4e-b2 与 H4e-b3,见"后续工作")。其 lead 一侧负责创建团队与拉起成员的一半,已由 [H4e-b1 设计](2026-10-10-managed-agent-team-lead-runtime.zh-CN.md)实现,并在其实机验收之后启用了 `team_state` 与 `team_task`;`team_message` 与 `team_plan` 保持关闭。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4e** 切片中记录契约的那一半,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段,由 [#13745](https://github.com/QwenLM/qwen-code/issues/13745) 跟踪。它承接 H4a([记录契约](2026-10-06-managed-child-agent-runtime.zh-CN.md),#13505)、H4b([child Session 运行时](2026-10-07-managed-child-session-runtime.zh-CN.md),#13550)、H4c([workflow kind](2026-10-09-managed-workflow-child-kind.zh-CN.md),#13754)与 H4d-a([Session 消息](2026-10-09-managed-session-messages.zh-CN.md),#13786)。下文"自动化设计"指 #12827 所固定提交上的 [automation、Channels 与 child 投递设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md) 第 5.1 节。

## 问题与范围

H4b 运行的 child agent 只对其父负责。团队是让多个 child 协同工作的构造:一个 lead Session、具名成员、共享任务板、成员之间的 mailbox,以及对必须先出计划再行动的成员的计划审批。Managed 路径上这些都不存在。四个团队 domain 只是没有记录体的已登记名字,因此团队的任何事实都无法提交、重建或检查。

Issue #13745 提出了三项:E1(团队记录 domain)、E2(detach 到独立的持久所有者)与 E3(团队下的关闭级联)。其分诊留下了三个需要人来定的问题:已 detach 的 child 采用哪个持久所有者;H4b 留给 H4e 的 teammate 路由放在哪里;团队 domain 是 Legacy 团队模型的投影,还是与之并列的另一套。本设计把范围定为:

- **H4e 像 H4d 一样一分为二。** 本变更把 E1 作为记录那一半落地:运行时将需要的每个团队事实都是已提交的记录,并在两种语言中有提交时规则。运行时那一半是 H4e-b。H4a 交付地图在记录之外分给 H4e 的内容也归它:七个团队工具、`resolveTeamPlan`、`requestMemberShutdown`、旧团队导入、H4d-a 移到这里的 mailbox 中继,以及 H4b 决策 11 留给 teammate 路由的 managed Agent 工具 `name` 参数。E3(团队下的关闭级联)同样需要运行时,因此归 H4e-b。
- **E2(detach)不属于 H4e。** H4a 交付地图给 detach 单列了一行后续工作("Detach"),H4b 与 H4c 的设计都沿用了这一划分。已 detach 的 child 采用哪个持久所有者的问题随之移走。[H4 设计](2026-10-04-managed-child-agents.zh-CN.md)曾把这个问题交给 H4c,现已改为指向 Detach 后续工作。
- **团队 domain 是 Legacy 团队模型的持久形态,而不是并列的另一套。** 自动化设计要求迁移复用 `agents/team/TeamManager.ts` 及其任务、mailbox 与身份的规则。H4a 地图也把旧团队导入交给了 H4e。因此记录沿用 Legacy 的词汇:经过清洗的团队名与成员名、保留名 `leader`、任务板状态、mailbox 消息类型与计划审批。凡是 Legacy 模型为维持一个事实而改写两个文件的地方,记录只保存一次该事实(决策 5)。

这沿用 H4a → H4b、H4d-a → H4d-b 与 H6a → H6b 的节奏:记录契约先落地,在任何写入方之前完成校验,启用随生产者一起交付。

## 现状

以下事实取自 `main` 的 `9ec44d45c4`。

- **Domain。** `team_state`、`team_task`、`team_message` 与 `team_plan` 在封闭的 v1 domain 索引(`MANAGED_SESSION_DOMAINS`)与 Java 的 `ManagedExtensionRecords.DOMAINS` 中。它们在两种语言中都没有记录体、没有 store 规则、没有 task kind,也没有启用。`team_plan` 同时是 `MANAGED_SESSION_ACTION_SOURCES` 的一个取值,因此 D6 action 已经可以把团队计划作为来源。
- **Legacy 模型。** `packages/core/src/agents/team/` 把团队保存在 `~/.qwen/teams/{team}` 与 `~/.qwen/tasks/{team}` 下的文件中。`TeamFile` 保存 lead 和一个只追加的成员列表,最多 `MAX_TEAMMATES`(10)个成员。成员只有在自身拉起回滚时才会被移除。名字被清洗为 `[a-z0-9-]`,`leader` 指 lead。`SwarmTask` 有正整数 id、`subject`、`description`、`activeForm`、`owner`、状态 `pending | in_progress | completed`、两个方向的依赖(`blocks` 与 `blockedBy`),以及最多 32 KiB 的 `metadata`。`task_update` 以 `status: 'deleted'` 删除任务,合并 metadata,只增加边。它把每条边镜像到另一个任务中,把已完成或已删除的任务从其依赖方的 `blockedBy` 中移除,并在 `in_progress` 任务没有 owner 时把调用方设为 owner。mailbox 承载 `shutdown_request`、`shutdown_approved`、`shutdown_rejected`、`plan_approval_request`、`plan_approval_response` 与 `task_assignment`。纯文本走各 agent 的内存队列。这一切都只存在于 lead 的进程及其本地文件中,Managed 路径上一样也没有。
- **七个团队工具。** `team_create`、`team_delete`、`task_create`、`task_update`、`task_list`、`team_plan_approval` 与 `request_shutdown` 作用于这一模型。

## 决策

1. **四个 domain 都位于 lead Session 的 journal 中。** 团队是 lead Session 权威下的持久 domain 资源(自动化设计 §5.1)。每条团队记录都由 lead Session 的单一写入方提交,并写明其 `teamId`。`team_state` 记录以 `leadSessionId` 写明 lead,authority 要求它就是自己的 Session。成员自己的 Session 不保存任何团队记录。成员通过身份受检的命令作用于 lead,消息则作为成员自己 journal 中的 input 到达(开放问题 1)。与 H4d 的两个 journal 不同,这里一个 journal 就够了,因为每个团队事实都由 lead 授权。
2. **名字沿用 Legacy 形式。** 团队名与成员名是 Legacy `sanitizeName` 的输出:由短横线分隔的小写字母与数字段组成,最多 64 个字符。成员不会被命名为 `leader`。凡记录中指名参与者(任务 owner、消息的发送方或接收方)之处,`leader` 指 lead,其他名字指团队的某个成员。
3. **`team_state` 是名册与生命周期。** 成员只追加,且只能在团队为 `active` 时追加。每个修订最多追加一个,因此每个成员关系事实都单独提交。`membershipRevision` 计数成员关系事实:它在没有成员时从 1 开始,始终比成员数多 1。每个成员写明其在 lead journal 中的 child run(`childRunId`),以及它是否必须先出计划再行动。生命周期沿用自动化设计:`active → closing → deleted`,每次一步。run 块是纯逻辑的生命周期:团队存续期间为 `admitted`,删除后为 `cancelled`,记录随之冻结。
4. **成员是 lead 的一个存活的 child Session run,且只属于一个团队。** 成员加入时,其 `childRunId` 必须指向 lead journal 中一个尚未结束的 child Session run(`child_agent` 或 `workflow`)。lead 的其他团队都不得列出这个 run。成员的 run 结束后,其条目仍然保留,就像 Legacy 成员在文件中保留其条目一样,因此名册就是团队的历史。成员是否存活由其 run 的状态决定。
5. **`team_task` 把一个事实只保存一次。** 任务的身份是 `taskId`,在 journal 中唯一。`number` 是任务板上的 `#N`,在团队内唯一且永不复用。subject、description、active form、metadata、owner 与 status 沿用 `task_update`。`in_progress` 需要 owner;`deleted` 是终态:run 从 `admitted` 变为 `cancelled`,任务随之冻结。依赖只按一个方向保存为 `blockedBy`,且只增不减。Legacy 的每条边总会落到依赖方的 `blockedBy` 中,因此 `blocks` 是反向索引,而不是第二份副本。依赖是否仍在阻塞,由阻塞方的状态读出:已完成或已删除的阻塞方不再阻塞。于是一次写入只提交一条记录,而 Legacy 需要改写一条边两端的任务,以及已完成任务的每个依赖方。新边必须指向同一团队的任务,且不得形成环。任务记录的修订号即其 `expectedTaskRevision`。任务分配是一条 kind 为 `task_assignment` 的 `team_message`(决策 6)。任务本身不带投递线,因为一个任务会被反复分配,而投递线会走到终点。
6. **`team_message` 就是 mailbox。** 每条记录是发给一个接收方的一条消息,因此每个接收方都有自己的投递、接受与消费。广播是每个接收方一条记录,部分失败的广播绝不会重发给已经接受的成员。记录沿用 H4d-a 的 outbox 条目:从第一个修订起就是 settled,写明其发送调用,带一条 `session` 投递线(`planned → accepting → accepted → consumed`,外加 `cancelled`、`unknown` 与 `rejected`),目标 Session 在交接时固定一次,且恰在 accepted 之后写明目标的 `inputId`。内容最多 64 KiB,并与其摘要绑定。`kind` 是普通的 `message`,或六种 Legacy mailbox 类型之一,每种都有固定的方向:

   | Kind                                                              | 发送方   | 接收方       |
   | ----------------------------------------------------------------- | -------- | ------------ |
   | `message`                                                         | 任何一方 | 其他任何一方 |
   | `task_assignment`                                                 | 任何一方 | 某个成员     |
   | `plan_approval_request`、`shutdown_approved`、`shutdown_rejected` | 某个成员 | `leader`     |
   | `plan_approval_response`、`shutdown_request`                      | `leader` | 某个成员     |

   发给 `leader` 的消息以 lead Session 为目标。发给成员的消息以该成员 child run 所 attach 的 Session 为目标,因此发给一个其 run 尚未 attach 的成员的消息停留在 `planned`。

7. **`team_plan` 是审批状态,不是其传输。** 计划请求以 `requestId` 为键,即请 leader 做决定的那个 D6 action 的 id(来源为 `team_plan`)。它写明成员、成员的 `planRevision` 与计划内容。其 run 以 `waiting` 开启,等待决定,并以 `settled` 结束,带 `decision: approved | rejected` 与可选的反馈。计划被撤回或被取代时,它以 `cancelled` 结束且没有决定:修改后的计划以更新的修订开启新请求,因此一个决定绝不会作用于它没有看过的计划。请求与决定分别以 `plan_approval_request` 与 `plan_approval_response` 消息传递,决定本身先经 D6 action(`resolveAction`)裁决,再由 H4e-b 提交到这里。计划请求只能来自要求 plan mode 的成员。
8. **提交时规则检查 lead journal 所持有的内容。** TypeScript authority 与 Java store 都检查:

   | 规则                                                                                            | Domain                                   |
   | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
   | 团队由本 Session 领导                                                                           | `team_state`                             |
   | 加入的成员指向本 Session 一个尚未结束、且没有其他团队列出的 child Session run                   | `team_state`                             |
   | 记录只能在本 Session 一个 `active` 的团队中开启                                                 | `team_task`、`team_message`、`team_plan` |
   | 任务编号在其团队内唯一                                                                          | `team_task`                              |
   | 任务 owner 每次变化时,都是 `leader` 或团队成员                                                  | `team_task`                              |
   | 新依赖指向同一团队的任务,且不形成环                                                             | `team_task`                              |
   | 消息在 `leader` 与本团队成员之间传递,并以 lead Session 或该成员 run 所 attach 的 Session 为目标 | `team_message`                           |
   | 计划请求来自本团队中要求 plan mode 的成员                                                       | `team_plan`                              |

   处于 closing 或已删除团队中的记录仍然可以提交其后续修订:在途消息仍会送达,待决的计划请求仍可撤回,任务仍可更新。只有新记录会被拒绝,因此处于 `closing` 的团队在收尾期间不再接收新工作。

9. **四个 domain 保持禁用,且不投影 task。** 在本切片中它们都不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中(H4e-b1 后来在其实机验收之后启用了 `team_state` 与 `team_task`),提交会在任何内容发布之前以"registered but not enabled"被拒绝。Java store 先于任何写入方校验全部四个 domain,遵循 H1 至 H4d-a 的 server 先行顺序。它们都不在 Java 生命周期门禁为处于 close 或 delete 认领下的 Session 所放行的 domain 列表中,closing 中的 lead 还能提交什么由 H4e-b 决定(开放问题 3)。团队任务是任务板条目,不是运行时 task,因此四者都登记为空 task kind,其 Java 行的 task 列为空。

## 记录

四者都是 schema version 1。所有键都必填,可空的键写 `null`。每个 run 块都是纯逻辑的:没有定义 pin、effect、dispatch、Channel 投递、执行或 Runtime 绑定。只有 `team_message` 写明 `executionCallId` 并带有投递。

### `managed-team_state`

链身份:`teamId`。

| 键                   | 规则                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `teamId`             | id:团队,由 lead 生成                                                                                   |
| `name`               | 团队名(决策 2)                                                                                         |
| `leadSessionId`      | id:lead Session                                                                                        |
| `lifecycle`          | `active`、`closing` 或 `deleted`                                                                       |
| `membershipRevision` | 整数,恰好比成员数多 1                                                                                  |
| `members`            | 最多 10 个 `{ name, childRunId, planModeRequired }` 条目;名字与 child run 各不相同;没有成员叫 `leader` |
| `run`                | `active` 或 `closing` 时为 `admitted`,`deleted` 后为 `cancelled`                                       |

- **开启。** `active`,没有成员,run 为 `admitted`。
- **后继。** `teamId`、`name` 与 `leadSessionId` 永不改变。生命周期保持不变或前进一步。一个修订的成员是上一修订的成员再加至多一个,且只有保持 `active` 的 `active` 团队才能新增成员。已删除的团队被冻结。

### `managed-team_task`

链身份:`taskId`。

| 键               | 规则                                                     |
| ---------------- | -------------------------------------------------------- |
| `teamId`         | id:团队                                                  |
| `taskId`         | id:任务,在 journal 中唯一                                |
| `number`         | 从 1 开始的整数:任务板上的 `#N`                          |
| `subject`        | 有界文本                                                 |
| `descriptionRef` | 持久引用,最多 65536 字节                                 |
| `activeForm`     | null 或有界文本                                          |
| `metadataRef`    | null 或持久引用,最多 32768 字节(Legacy 的 metadata 上限) |
| `owner`          | null 或参与者名;`in_progress` 期间必填                   |
| `status`         | `pending`、`in_progress`、`completed` 或 `deleted`       |
| `blockedBy`      | 最多 64 个互不相同的任务 id,绝不包含本任务自己           |
| `run`            | 未删除时为 `admitted`,`deleted` 后为 `cancelled`         |

- **开启。** 除 `deleted` 外的任何状态,因此导入时可以直接开启一个已完成的任务。
- **后继。** `teamId`、`taskId` 与 `number` 永不改变。`blockedBy` 按顺序保留之前的每一项,并可追加更多。其他字段在任务被删除之前都可以改变,删除后冻结。

### `managed-team_message`

链身份:`messageId`。

| 键                | 规则                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| `teamId`          | id:团队                                                                             |
| `messageId`       | id:发给一个接收方的消息,由发送方生成                                                |
| `kind`            | `message` 或一种 Legacy mailbox 类型,方向由决策 6 固定                              |
| `from`、`to`      | 参与者名,二者不相同                                                                 |
| `contentRef`      | 持久引用,最多 65536 字节                                                            |
| `contentDigest`   | 摘要:必须等于 `contentRef.digest`                                                   |
| `targetSessionId` | null 或 id:只设一次;投递越过 `planned` 后必填,`cancelled` 除外                      |
| `inputId`         | null 或 id:在目标中承载该消息的 input;只设一次,恰在 `accepted` 与 `consumed` 时存在 |
| `run`             | settled,在 `executionCallId` 中写明其发送调用,带 `session` 投递                     |

- **开启。** 投递为 `planned`。
- **后继。** 除 `targetSessionId`、`inputId` 与 run 外的每个键都固定。目标与 input 只设一次。投递每次按共享状态线前进一步。

### `managed-team_plan`

链身份:`requestId`。

| 键             | 规则                                                        |
| -------------- | ----------------------------------------------------------- |
| `teamId`       | id:团队                                                     |
| `requestId`    | id:请 leader 做决定的那个 D6 action                         |
| `member`       | 成员名:计划所属的成员                                       |
| `planRevision` | 从 1 开始的整数                                             |
| `planRef`      | 持久引用,最多 65536 字节                                    |
| `decision`     | null、`approved` 或 `rejected`;恰在 run 为 `settled` 时设置 |
| `feedbackRef`  | null 或最多 65536 字节的持久引用;只能与决定一起出现         |
| `run`          | `waiting`,随后为 `settled` 或 `cancelled`                   |

- **开启。** run 为 `waiting`,没有决定,也没有反馈。
- **后继。** `teamId`、`requestId`、`member`、`planRevision` 与 `planRef` 永不改变。run 只结束一次,这同时固定了决定与反馈。

## 非目标

- **运行时(H4e-b):** managed 路径上的七个团队工具、managed Agent 工具的 `name` 与 teammate 路由、mailbox 中继与成员一侧的投递、经由 D6 action 的计划裁决、成员关停、团队成员关系上的关闭级联、旧团队导入,以及启用。
- **Detach**(H4a 地图中的 Detach 后续工作)与**跨工作区团队**。
- **任何公共契约变更。** OpenAPI 契约、路由与 Flyway 迁移保持不变。公共接口上的团队资源属于 #13785。

## 受影响的文件

- `packages/core/src/managed-runtime/managed-team-record.ts`(新增):四个记录体及其开启与后继规则。
- `packages/core/src/managed-runtime/contracts/managed-team-record-v1.fixtures.json`(新增):共享用例。`managed-extension-projection-v1.fixtures.json` 新增四个 domain,task kind 为空。
- `packages/core/src/managed-runtime/managed-extension-projection.ts`:记录体登记。
- `packages/core/src/managed-runtime/managed-session-authority.ts`:资源闭包与决策 8 的规则。
- `packages/sdk-java/managed-agent-server`:
  - `ManagedTeamRecords`(新增):校验器。
  - `ManagedExtensionProjection`:记录体登记。
  - `ManagedExtensionRecordStore`:资源闭包与决策 8 的规则。
- 两种语言的测试:TypeScript 的 fixture 回放与 `managed-session-authority.team.test.ts`,以及 `ManagedTeamRecordContractTest` 与 `ManagedTeamStoreTest`。
- 本设计的两种语言版本,以及 H4 与 H4a 设计中指向它的链接。

## 验证

- **Fixture 一致性。** 共享用例与后继对在两种语言中回放,每个无效用例都写明两个校验器必须报告的子句。
- **Authority。** 测试套件放开 domain 门禁来写入记录,测试门禁本身的用例除外:
  - 在本切片中,真实的门禁拒绝四个 domain 中的每一个,且不发布任何内容。
  - 团队开启、逐个加入成员、进入 closing 并被删除。其任务、消息与计划请求的链各自走到终点,重新打开的日志会重建每条链。
  - 决策 8 的每条规则都以其指名的消息拒绝相应的违规。
- **Java store。** 同样的链在 MySQL 模式的 H2 上提交,同样的规则以 `managed_session_extension_record_rejected` 拒绝,团队行不投影 task。
- **变异检查。** 依次禁用每个新增的守卫,其见证测试在各自的语言中变红。

## 验收标准

- TypeScript 与 Java 对共享 fixture 中的团队记录与后继对给出完全相同的接受与拒绝,现有的每个契约语料都原样回放通过。
- 在本切片中,四个 domain 不进入启用列表,并在任何内容发布之前被拒绝。
- 在两种语言中,决策 8 的每条规则都拒绝相应的违规,合法的团队、任务、消息与计划请求都能提交并重建。
- 不改动公共 API 与迁移,现有的 H1–H4d-a 测试套件全部保持通过。

## 开放问题

1. **成员一侧的回执。** 发给成员的消息会成为成员 journal 中的一个 input,该 journal 需要自己的记录来识别重投。H4d-a 的 `session_message` 回执适用于同时是成员之父的 lead,但成员 Session 中没有团队记录。是复用该回执还是新增一种,由 H4e-b 决定。
2. **发给 leader 的消息的 input。** 发给 `leader` 的消息在 lead 自己的 journal 中被接受,因此其 input 可以随 `accepted` 修订一起提交,就像 H4b 的 `sent` acceptance 那样。本契约尚未绑定二者。H4e-b 的 relay 用到时再加上这一绑定。
3. **closing 中的 lead 提交什么。** 团队下的关闭级联(issue E3)经由 child-run 漏斗取消成员的 run。lead Session 处于 closing 时团队记录是否也必须提交(那样生命周期门禁就得放行它们),由 H4e-b 决定。已由 [H4e-b1 设计](2026-10-10-managed-agent-team-lead-runtime.zh-CN.md)决策 8 回答:关闭期间不提交任何团队记录,团队的生命以其 lead Session 的生命为界。
4. **run 被续跑的成员。** 续跑(H4d-a)是一个新的 child run,而名册条目永远只指向一个 run。被续跑的成员是以新条目重新加入,还是让名册跟随续跑,由 H4e-b 决定。

## 后续工作

| 切片   | 范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H4e-b  | managed 路径上的七个团队工具;managed Agent 工具的 `name` 与 teammate 路由(H4b 决策 11);mailbox 中继与成员一侧的投递(开放问题 1 与 2);经由 D6 action 的计划裁决;`requestMemberShutdown`;团队成员关系上的关闭级联(#13745 E3,开放问题 3);旧团队导入;经过与 H3 相同的实机验收(#13532)后启用。已拆为 H4e-b1(lead 一侧的团队与 E3,见 [H4e-b1 设计](2026-10-10-managed-agent-team-lead-runtime.zh-CN.md))、H4e-b2(mailbox,在 H4d-b 之后)与 H4e-b3(计划审批、关停与旧团队导入)。 |
| Detach | 把显式 detach 的 child 跨父关闭迁移到独立的持久所有者(#13745 E2),以及 [H4 设计](2026-10-04-managed-child-agents.zh-CN.md) 留下的所有者问题。                                                                                                                                                                                                                                                                                                                             |
