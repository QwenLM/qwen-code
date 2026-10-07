# Managed child Session 与 child 记录契约(H4)

[English](2026-10-06-managed-child-agent-runtime.md) | [简体中文](2026-10-06-managed-child-agent-runtime.zh-CN.md)

状态:契约在本次变更中定义;不启用任何 domain,不改变任何运行时路径。本次落地的内容:H4 交付地图、`managed-child_run` 的 `kind: "child_agent"` 记录体、`managed-child_acceptance` 记录体、它们的提交时一致性与引用闭包规则,以及双语言共享 fixtures。以下内容仍是设计,未实现:「后续工作」一节列出的全部运行时义务——child Session 生命周期、首个跨 Session dispatcher、血缘存储、完成模式、关闭级联、配额、workflow、peer 消息、团队与公开任务取消。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H4 切片,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段,承接 H1([MCP](2026-09-28-managed-mcp-runtime.zh-CN.md))、H2([Hooks](2026-09-30-managed-hooks-runtime.zh-CN.md))与 H3([后台 Shell 与 Monitor](2026-10-03-managed-shell-monitor-runtime.zh-CN.md))。下文中,"参考设计"指[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)第 3、8、12、13、14 节,"自动化设计"指[自动任务、Channels 与子任务交付设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md)第 5 与 5.1 节,"恢复设计"指[恢复运维设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-recovery-operations.md),"存储设计"指[Session 存储设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-session-storage.md),均为提案仓库中以 #12827 固定的提交;另有仓内 H0b([记录契约](2026-09-27-managed-extension-record-contract.zh-CN.md))与 H0c([authority](2026-09-27-managed-extension-authority.zh-CN.md))两份设计,本文扩展它们承担的义务。

## 问题与范围

issue #12380 对 H4 的表述很明确:"独立 child Session、父 acceptance/consumption、持久消息与 close 级联。共享 record 名称不是可执行 domain。"参考设计 §13 给出 H4 门槛:独立 child Session、worktree 隔离、父 accept/consume,以及可恢复的消息与关闭级联。参考设计 §8 固定了语义:

- 父 Session 提交 `child_run` launch 与 outbox;控制面幂等创建 child Session;child Harness 提交唯一终态结果;结果经 child result outbox 传递;父提交 `acceptChildResult`(accepted),并同事务提交工具结果或 notification input 及其 wake;随后父模型消费(consumed)。
- child terminal、父 accepted、父 consumed 是三个独立事实。relay 只重投未 accepted 的原结果;到达已关闭父的结果保存为 orphaned,绝不复活父模型。
- 前台 child(`completion: "tool"`)只经原工具结果返回;后台 child(`completion: "sent"`)只经持久 notification input 返回。绝不两路并行。
- 父关闭默认级联取消每个未显式 detach 的 child;已 detach 的 child 迁移到独立 durable owner。

main 上没有任何代码为 child agent 或 workflow 承载这些语义。`child_run` 与 `child_acceptance` 两个名称虽在封闭 v1 领域索引中,但除 H3 的 `kind: "shell"` 外没有任何记录体;自动化设计的字段级契约(`startChildRun`、`commitChildResult`、`acceptChildResult`、`cancelChildRun`)也没有可实现的记录形态。

### 切片

H4 分六个切片交付,如同 H0 分为 H0a/H0b/H0c。本次变更是第一个。

| 切片                               | 交付                                                                                                                                                                                                                                                                                 | 验收                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **H4a — child 记录契约(本次变更)** | `managed-child_run` 的 `child_agent` 记录体与 `managed-child_acceptance` 记录体,含提交时一致性、引用闭包与双语言 fixtures。不启用、不改运行时路径。                                                                                                                                  | 两种语言下,fixtures 中每一种畸形结构与非法迁移都被拒绝,每一个有效用例都被接受,且 authority 与 Java store 能在启用前提交并重建这些链。 |
| H4b — child Session 运行时         | `startChildRun` / `queryChildRun` / `continueChildRun` / `commitChildResult` / `acceptChildResult` / `cancelChildRun` / `closeChildScope`;Java 血缘存储与幂等 child 创建;首个跨 Session dispatcher(child 结果 relay);前台与后台完成路径;关闭级联;配额;按 server-first 部署顺序启用。 | 参考设计 §13 的 child agent 门槛与 §14.7 各项,在真实栈上验证。                                                                        |
| H4c — workflow kind                | `workflow` 记录体 kind 与 Workflow 工具的 Managed 准入。                                                                                                                                                                                                                             | workflow child 复用同一生命周期;其 definition pin 指向 workflow 修订。                                                                |
| H4d — peer 消息                    | `session_message` 记录体与无团队的持久 `send_message` 路由(自动化 §5.1 的 background `task_id` 与命名 peer 两条路径)。                                                                                                                                                               | 持久送达;每个收件方各有 accepted 与 consumed;跨重启与重连可恢复。                                                                     |
| H4e — 团队                         | `team_state` / `team_task` / `team_message` / `team_plan` 记录体、七个团队工具、`resolveTeamPlan`、`requestMemberShutdown` 与旧团队导入。                                                                                                                                            | 自动化 §8 的 A06 团队矩阵。                                                                                                           |
| H4f — 公开任务取消(与 H5 共享)     | `cancelSessionTask` / `cancelWebShellTask` 路由,带持久命令存储,见 H3 的 follow-up 表与 #12847 A6/A7、B12。                                                                                                                                                                           | 契约项 A6/A7 落定;对 H4 child 的 cancel 作用于其记录。                                                                                |

H4a 不扩大任何 profile 可运行的范围:`child_run` 与 `child_acceptance` 保持禁用提交,如同 `monitor_run` 在 H0b 与 H3 之间的状态。

## 现状

以下事实取自 `main` 的 `ac81c07dc8`。

- **领域索引。** `managed-session-records.ts:78-127` 持有封闭 v1 索引共 33 个名称,包括 `child_run`、`child_acceptance`、四个 `team_*` 与 `session_message`。已启用提交的:四个 envelope domain 加 H1、H2 的 domain。`child_run` 与 `child_acceptance` 已注册但未启用;H3 刻意让自己的 domain 保持禁用,直到能保持 server-first 部署顺序(`2026-10-03-managed-shell-monitor-runtime.md` 的 "Reader compatibility" 一节)。
- **`child_run` 记录体。** `managed-child-run-record.ts:25` 定义了 schema version 1,`kind` 仅支持 `"shell"`,并注明 "H4 extends the domain to the other child kinds under its own body version"(H4 在其自身 body version 下把该 domain 扩展到其他 child kind)。该记录体是以 `shellId` 为键的封闭对象,不携带 delivery 行(`managed-child-run-record.ts:51`),Java 侧由 `managed-agent-server` 的 `ManagedExtensionRecords` 镜像,由 `contracts/managed-child-run-record-v1.fixtures.json`(49 个用例、21 组后继)在两种语言下固定并重放。
- **authority 机制。** `LocalManagedSessionAuthority.commitExtensionRecord`(`managed-session-authority.ts:1404`)每个事务恰好提交一条记录修订,可选携带 notification input 及其生成的 wake。重试命令返回其已提交的修订(第 1429 行)。`assertDomainAdmittable`(1323)使启用列表成为唯一门禁。`verifyExtensionResources`(2006)按 domain 对每个记录体引用的资源做闭包校验。`applyExtensionRevision`(1825)按记录体自身身份键控链;Hook 的按域准入索引(1738-1772)是 child 规则的式样。authority 中不存在 `parentSessionId`、`rootSessionId` 或 `childSessionId`;`close()`(690)只封存 journal,没有级联。
- **outbox 与投影。** 待交付 = 已提交 run 的 delivery 行:`isExtensionDeliveryPending`(TypeScript 在 `managed-extension-projection.ts:295`);Java 为 `isDeliveryPending`(`ManagedExtensionProjection.java:157`)。`MANAGED_TASK_KINDS`(projection:50)已命名 `child_agent` 与 `workflow`,但没有生产者;`child_run` 无条件映射到任务 kind `background_shell`(projection:152)。Java 的 `qwen_managed_session_extension_record` 表(V18)保存最新修订、任务列(可空;V23 已把 MCP 这类非任务记录的任务列置空)与 `delivery_target` / `delivery_state` 列——没有 delivery-pending 索引,而 dispatcher 需要它。V45 迁移头注释把 `qwen_managed_session_task_event` 这个表名预留给了未来的 task-view outbox,H4 不得重用该名。
- **Java 控制面。** 没有任何血缘:在 `packages/sdk-java` 全仓搜索 `parentSessionId` / `rootSessionId` / `child_session` 均为零命中,`managed_agent_session`(V1)没有血缘列(V40 的 `creator_actor_key` 是创建者授权,不是层级)。Session 创建是 `POST /v1/agents/sessions`,带 `Idempotency-Key`,返回 202(`PublicAgentController.java:55`)。关闭走 `SessionLifecycleCoordinator`:准入 operation、关闭 Harness、等待 journal writer 退出、drain Runtime binding(V32)。OpenAPI 契约现为 `1.33.0`;`TaskKind` 枚举含 `child_agent` 与 `workflow`,其 schema 标记为 `partial`;`ActionSource` 已有 `team_plan`,任务取消路由为 `planned`。
- **待适配的 Legacy 实现。** 均无 Managed 感知:`SubagentManager`(`packages/core/src/subagents/`)、Agent 工具(`tools/agent/agent.ts:777`)、Workflow 工具(`tools/workflow/workflow.ts:1769`)、`TeamManager`(`agents/team/TeamManager.ts`)、daemon 的 `create_sub_session`(带深度与并发上限及父 relay,`cli/src/serve/create-sub-session.ts:138`)、`BackgroundTaskRegistry`(`agents/background-tasks.ts`),以及 `agents/workspace-agents/`——现存最接近持久独立 child 的实现,带 JSON store、outbox 对账与 `parent_report` 事件(`agents/workspace-agents/store.ts:2055`、`run-lifecycle.ts`)。父子链接只存在于 legacy transcript(`chatRecordingService.ts:3177`)。
- **恢复设计**已注册 `child_run` 的 phase——`launch`、`attach`、`cancel`、`drain`——面向 wire 的维护操作在 `OperationGrant` 下已有可用的 phase 名。

## 决策

1. **一个 domain、一个 body 版本、按 kind 划分的封闭形态。** `child_run` 保持 recordRef `managed-child_run` schema version 1,由记录体自身的 `kind` 字段分发封闭键集:`shell`(H3)与本次新增的 `child_agent`。存储设计 §3.1 把 v1 索引的 `recordRef.schemaVersion = 1` 钉死, `domain.committed` 也强制它(`managed-session-records.ts:30`,1146-1157),所以新 kind 是新的记录体形态,不是新的 envelope 版本;H3 所说的 "its own body version" 因此读作 v1 envelope 内各 kind 自身的记录体形态。旧 reader 会拒绝 `child_agent` 记录体——缺该 body 的 writer 根本不会提交它,缺该 body 的 reader 无法重新打开——这正是 H3 为新记录形态确立的 fail-stop 立场。由于任何已部署 profile 中的 Session 都还不持有 `child_run` 记录(该 domain 处处禁用),不存在混版窗口;启用 `child_run` 与 `child_acceptance` 仍是 H4b 中显式的、server 先部署的一步,与 H1/H2 的顺序以及 H3 为其自身待启用项记录的方式同类。
2. **链身份按 kind 定。** `shell` 链以 `shellId` 键控;`child_agent` 链以 `childRunId` 键控。H0c 的键控规则不变(决策 3:domain 加记录体自身身份),任务 ID 推导也不变。
3. **launch 身份就是开启命令。** 自动化设计的 `launchId` 就是开启 `child_run` 记录的 operation:H0c 已强制一个开启命令最多开启一条记录,authority 对重试命令重放其已提交记录,Java store 保存开启命令的 hash。H4b 从 record key 推导跨 Session 创建的幂等键,所以记录体不携带与 envelope 重复的字段——"创建与首次输入使用原 `launchId`" 由推导满足,不明确的创建绝不另铸第二条记录。
4. **child agent 的交付走 run block,acceptance 自成记录。** `child_agent` 的 run 携带 `session` 目标的 delivery 行(`planned → accepting → accepted → consumed`,另有 `unknown`、`rejected`、`cancelled`),outbox 投影与任何 dispatcher 扫描读的就是它。它不承载 acceptance 证据:去重、内容绑定与消费跟踪都在 `managed-child_acceptance` 里——§3.1 为此命名的独立 domain——因为三个事实(child terminal、父 accepted、父 consumed)必须各自独立提交、各自可被 kill(自动化 §8 A06)。一个 `commitExtensionRecord` 事务只携带一条记录修订,所以 acceptance 动作 = acceptance 记录 + 其 input 与 wake 在一个事务内;推进 `child_run` 的 delivery 行是另一个由 relay 驱动的提交——崩溃可以延后它,但绝不会破坏它(acceptance 记录已使重投停止)。
5. **不设 orphaned 字段。** orphan 结果——到达正在关闭或已关闭的父的结果——不是 acceptance:不准入任何 input,不触发 wake,因此不存在对应的 `child_acceptance` 记录。relay 在自己一侧保存 orphan 分型(H4b),按自动化 §5:回执收件保留原结果,绝不将其呈现为 consumed,绝不复活父模型。因此记录体对 orphan 无可陈述。
6. **跨 Session 引用一律是父持有的副本。** acceptance 的 `contentRef` 与 `terminalReceiptRef`,以及 child run 的 `resultRef` 与 `terminalReceiptRef`,都指向父 Session 自己 store 中的资源。父 authority 在接受前先把 child 已发布的结果与回执复制过来;`contentDigest` 与这些 ref 把副本绑定到 child 的原件;以同一记录名携带不同内容的重投是冲突,不是第二次接受。任何引用都不跨 Session,与存储设计"事务所引资源必须属于该 Session"的规则一致。
7. **v1 中 `resultVersion` 固定为 1。** 一个 child 恰有一个逻辑终态结果;继续一个已完成的 child 以新 `childRunId` 创建并设置 `predecessorChildRunId`(自动化 §5)。迟到的物理回执是原 operation 的结算更新,不是结果的新版本。
8. **depth 与树根显式记录,预算分配暂不记录。** 记录体携带 `depth` 与 `rootSessionId`,使嵌套树在其所在处可审计(每个 child 的记录保存在其直系父的 journal 中),且 depth 为 1 的提交时规则把该树绑定到本 journal:第一层 child 的 `rootSessionId` 必须就是本 Session,两侧一致。自动化 §5 的 `budgetRef` 不进入 v1:预算记账随其运行时切片落地(参考设计 §12 的 child 行),depth 的契约上限不等待它。上限取 8 是托管契约自己的选择,与 legacy `--max-subagent-depth` 用户设置(上限 100,默认 5)无关——那一设置只管 legacy subagent 嵌套;H4b 的 dispatcher 对记录体无法承载的托管 launch 必须显式拒绝而不是截断——截断会写下一个该 launch 并不具有的 `depth`。
9. **acceptance 开启即 settled、即 accepted。** H0c 的通用开启规则要求首修订以 `reserved`/`admitted` 开启、delivery 至多为 `planned`。`managed-child_acceptance` 无法照此办理:共享 run 解析器拒绝非终态 run 携带越过 `planned` 的 `session` delivery,因为在 run 结束前接受结果正是 H0b 禁止的混淆。但该记录本就不是一段有生命周期的 run——它是一件刚刚发生之事的回执,所以首个修订以 run 已 `settled`、delivery `accepted` 开启,`settled` 是唯一描述一次成功完成的 acceptance 的终态。唯一允许的后续迁移是 run 保持 settled、delivery 一步推进到 `consumed`,这正是共享后继规则允许终态 run 做的唯一改动。因此 `accepted` 绝不可能冒充 `consumed`,任何额外提交也不能撤销一次消费。
10. **workflow 是一个 kind,不是第二个 domain——留待后续。** H4c 在同一按-kind 分发下增加 `workflow` 记录体 kind,其 definition pin 指向 workflow 定义修订。将其推迟使本次变更恰好只含 child 运行时消费的两个记录体;日后增加 kind 与本次增加 `child_agent` 同为 additive、对旧 reader fail-stop 的操作。
11. **Java 控制面先于任何 writer 获得两个记录体及 Java 侧重放。** 这是决策 1 的 server-first 一半:`managed-agent-server` 自本变更落地起就能校验 `child_agent` 与 `child_acceptance`,因此当 H4b 启用提交时,任何已部署的 store 都不会拒绝新 writer 可能提交的内容。`child_acceptance` 不投影任务——其行的任务列为空,与 MCP 记录自 V23 起的处理相同——而 `child_agent` 映射已有的 `TaskKind.child_agent`,无需契约变更。

## 记录

### `managed-child_run`,kind `child_agent`

Schema version 1。链以 `childRunId` 键控。所有键都是必需的;可空键持 `null`。

| 键                      | 规则                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                  | `"child_agent"`                                                                                                                                                                  |
| `childRunId`            | id                                                                                                                                                                               |
| `ownerScopeId`          | id:拥有该 child 并接收其结果的父 activation scope(自动化 §5 的 `parentScopeId`)                                                                                                  |
| `rootSessionId`         | id:嵌套树的根;对于第一层 child,它就是本 journal 所属 Session                                                                                                                     |
| `depth`                 | 1 到 8 的 count                                                                                                                                                                  |
| `completion`            | `"tool"` 或 `"sent"`(决策:前台只经原工具结果返回,后台只经持久 notification input 返回)                                                                                           |
| `inputRef`              | durable ref:launch 输入——child 的首个 prompt——由父 Session 持有                                                                                                                  |
| `workspaceMode`         | `"shared"`、`"snapshot"` 或 `"worktree"`:launch 时固定的隔离策略(参考设计 §8);v1 运行时只准入它能证明的模式(H4b)                                                                 |
| `workingDirectory`      | 绑定 Workspace 内的 id 安全相对目录文本,根目录为 `.`:NFC 规范化、无前导或结尾 `/`、不含反斜杠、无空段或 `.` 段或 `..` 段、无盘符前缀、至多 512 UTF-8 字节                        |
| `childSessionId`        | null 或 id:与控制面准入创建的那次 dispatch 一起设置一次;幂等创建指向同一 Session。执行为 null、intent、dispatch 在途或已证未开始时为 null——Session 只存在于 dispatch attach 之后 |
| `predecessorChildRunId` | null 或 id:continued 时在 launch 设置,不再改变                                                                                                                                   |
| `resultVersion`         | count,v1 恰为 1(决策 7)                                                                                                                                                          |
| `resultRef`             | null 或 durable ref:父持有的终态结果内容副本                                                                                                                                     |
| `terminalReceiptRef`    | null 或 durable ref:父持有的 child 终态回执副本                                                                                                                                  |
| `stopReason`            | null,或符合 run 终止状态的封闭原因,见下                                                                                                                                          |
| `stopRequested`         | boolean:只设置、从不清除——取消请求,包括关闭级联的请求                                                                                                                            |
| `run`                   | run block                                                                                                                                                                        |

- **Run。** v1 中 run 引用启动调用的 `executionCallId`(child 由工具调用启动;自动化触发的 child 属 H6,使用 `effectId`)。`dispatchId` 随跨 Session 创建 dispatch 设置,不再改变。`deliveryId` 为 null:`session` 交付不需要它。`definition` 固定实际启动的定义(`definitionId`、`definitionRevision`、`definitionDigest`——实际使用的 subagent 或 AgentBundle 修订),不晚于 dispatch。`runtime` 在 dispatch 时记录 child Session 的 Runtime binding,并遵循共享的 re-attach 规则。`delivery` 是 `session` 目标的行,自首个修订起以 `planned` 出现。
- **Delivery 状态。** 开启时为 `planned`;relay 领取终态结果后为 `accepting`;父提交 `child_acceptance` 记录时为 `accepted`;父的消费提交后为 `consumed`;relay 已领取终态结果后、其 acceptance 结果无法证明时为 `unknown`——dispatch 结果无法证明的 run 在结束前保持 `planned`,而无结果的结束携带 `cancelled`;run 在没有结果的情况下结束时(为 `failed`,或在结果存在前为 `cancelled`)恰为 `cancelled`;父确定性拒绝接受时为 `rejected`。已结束的 run 只能再改其 delivery,按共享规则。
- **Result refs。** `resultRef` 与 `terminalReceiptRef` 只成对变化,且只出现在 run 携带结果 settled 的修订中:settled 的 run 必须两者俱在,其余任何状态的 run 必须两者皆空——半边结果绝不可能提前提交,否则该链的交付将永久楔死。
- **停止原因。** `settled` 对应 `completed`;`failed` 对应 `creation_failed`、`child_failed` 或 `quota_exceeded`;`cancelled` 对应 `stop_requested`。`stop_requested` 结尾要求 `stopRequested`。`creation_failed` 要求执行从未产出 child Session(`childSessionId` 为 null)。`quota_exceeded` 恰在 run 携带 quota 原因时为该原因(与 Shell 规则镜像)。`completed` 要求 `resultRef` 与 `terminalReceiptRef`。
- **修订。** 后续修订保持 `kind`、`childRunId`、`ownerScopeId`、`rootSessionId`、`depth`、`completion`、`inputRef`、`workspaceMode`、`workingDirectory` 与 `predecessorChildRunId`;`childSessionId`、`dispatchId` 与 `definition` 只设置一次,且执行为 `running_attached` 或 `settled` 时 `childSessionId` 是**必需**而非仅被允许——因为创建此时已被证明;child 所在 Session 由 Runtime binding 承载,随 `childSessionId` 一同成为必需,`definition` pin 最迟在 dispatch 时必需;`resultVersion` 不变;`resultRef` 与 `terminalReceiptRef` 只可出现,不可改变或消失——已 settled 的 child 绝不重述其结果;`stopRequested` 只设不清。run 一旦终态,run 之外的一切不得变化,run 自身也只能推进 delivery——终态证据上绝不可补加停止请求,result refs 按构造冻结。
- **引用闭包。** `inputRef`、`resultRef` 与 `terminalReceiptRef` 在提交时对父 Session 的资源闭包,两侧一致,如同 H3 为 `commandRef`/`startReceiptRef`/`outputRef` 固定的做法。同时两侧把树绑定到本 journal:第一层 child 的 `rootSessionId` 必须等于本 Session,按决策 8。

### `managed-child_acceptance`

Schema version 1。链以 `childRunId` 键控——每个 child run 一条 acceptance 链。该记录保存在父 Session 的 journal 中;它不投影任务。

| 键                      | 规则                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `childRunId`            | id:必须指向同一 Session 中一个 `child_agent` 的 `child_run` 记录,其 run 携带结果结束,且 `resultVersion` 与本记录相等    |
| `parentScopeId`         | id:必须等于该 child run 的 `ownerScopeId`——去重键为 Session + scope + run + 结果版本(自动化 §5)                         |
| `parentExecutionCallId` | null,或结果所附着的父工具调用:`completion: "tool"` 时必需,`"sent"` 时为 null——恰为该 child run 的 `run.executionCallId` |
| `resultVersion`         | count,v1 恰为 1                                                                                                         |
| `contentRef`            | durable ref:父持有的已接受结果内容副本                                                                                  |
| `contentDigest`         | digest:必须等于 `contentRef.digest`;把副本绑定到 child 已提交的结果;以同一记录名携带不同 digest 的重投是冲突            |
| `terminalReceiptRef`    | durable ref:父持有的 child 终态回执副本                                                                                 |
| `run`                   | run block                                                                                                               |

- **Run。** acceptance 是纯逻辑的(恢复设计:父 acceptance 不产生物理 phase),所以 `executionCallId`、`effectId`、`dispatchId`、`deliveryId`、`runtime` 与 `execution` 恒为 null。`delivery` 是 `session` 目标的行。
- **开启即 settled、即 accepted**(决策 9)。首个修订以 `run.state = "settled"` 与 `delivery = "accepted"` 开启;后续修订只可在 run 保持 settled 的前提下把 delivery 推进到 `consumed`,此后记录冻结。首修订即显示 `consumed`,或任何改动 delivery 以外内容的后续修订,都被拒绝。
- **一致性。** 两侧的提交时检查都依据 journal 重建出的记录强制执行上述跨记录规则:被引用的 child run 必须作为本 Session 的记录存在、携带结果结束、scope 与结果版本匹配,且——对于 `"tool"` 完成——启动调用相同。身份相同但内容不同的重投,或对以 `failed`、`cancelled` 结束且无结果的 run 的 acceptance,在 Java 侧答案为 `409 managed_session_extension_record_rejected`,authority 侧为等价冲突。child run 的 delivery 行由决策 4 的独立提交推进;acceptance 绝不等待它。
- **引用闭包。** `contentRef` 与 `terminalReceiptRef` 在提交时对父 Session 的资源闭包,按决策 6 的要求。

### 任务投影

`child_agent` 投影 kind 为 `child_agent` 的任务(公开契约已把该枚举值列为 `partial`,所以 H4a 无需改动 OpenAPI);其 Runtime 状态映射走共享规则,`draining` 的适用方式与 Shell 相同(有停止请求而执行未结算)。因此 body 注册表的任务 kind 不再是 `child_run` domain 的常量,而成为记录体自身 `kind` 的函数:`shell → background_shell`、`child_agent → child_agent`。`child_acceptance` 不投影任务;其 Java 行的任务列为空,与 MCP 记录自 V23 起的处理相同。

## 非目标

- **启用。** 两个 domain 保持禁用提交;启用是 H4b 按部署顺序进行的一步。
- **运行时路径。** 不改 Harness 循环、dispatcher、Broker、worker、路由、OpenAPI 或 Flyway。任务列表路由已枚举 `child_agent`;不映射任何 `planned` 路由。
- **child Session 创建与血缘存储。** H4b 设计 Java 血缘列(V48+)、内部创建路由与 relay。
- **完成机制。** `"tool"` 的 acceptance 如何结算原工具调用,以及哪种完成模式先交付,是 H4b 的决策;两个记录体在两种模式间保持中立。
- **关闭级联与 detach。** 级联是 `stopRequested` 加共享关闭顺序(H4b);迁移到独立 durable owner 的 detach 仍是后续工作,与 H3 对其进程的处理相同。
- **workflow、peer 消息、团队、公开取消。** 各自切片见"切片"一节;其记录体尚不存在。
- **Legacy 迁移。** 把 legacy subagent/team 状态作为证据导入是 H4e 与自动化设计 §7 的事;本次不变迁移任何东西。

## 受影响文件

- `packages/core/src/managed-runtime/managed-child-run-record.ts` 与 `managed-child-run-record.test.ts`:按-kind 分发与 `child_agent` 记录体。union 类型为 `AnyChildRun`;`ChildRun` 保持 H3 交付时的含义(background Shell),只处理 shell 的调用方改用新的 `parseChildShellRun`。
- `packages/core/src/managed-runtime/managed-child-acceptance-record.ts` 及其测试(新)。
- `packages/core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json`:用例可增加可选 `template`(默认 `child_run`)、`child_agent` 模板与常量,以及新用例与后继对。
- `packages/core/src/managed-runtime/contracts/managed-child-acceptance-record-v1.fixtures.json`(新),以及 `contracts/managed-extension-projection-v1.fixtures.json`(`recordBodies` 钉住项对 `child_run` 改为按-kind,并增加 `child_acceptance`)。
- `packages/core/src/managed-runtime/managed-extension-projection.ts` 及其测试:记录体注册的静态 `taskKind` 改为 `taskKindOf(record)`——`child_acceptance` 注册为 null 任务 kind——hook 与 MCP 记录测试随之一并改名。
- `packages/core/src/managed-runtime/managed-session-authority.ts`:两个记录体的引用闭包与提交路径上的 acceptance 跨记录检查,由新的 `managed-session-authority.child-agent.test.ts` 沿用 H3 child-run 套件所用的 `assertManagedSessionDomainEnabled` mock 模式在启用前演练。
- `packages/cli/src/serve/hosted-child-run-session.ts`、`hosted-child-run-session.test.ts`、`hosted-shell-publisher.background.test.ts`、`local-shell-stream-result-session.ts` 与其测试:只处理 shell 的消费方从 `parseChildRun` 迁至 `parseChildShellRun`(行为不变),最后一处配有断言 `Child run kind must be 'shell' for this consumer` 的新见证。
- `packages/cli/src/serve/hosted-harness-session.ts` 与 `hosted-harness-session.test.ts`:工作区恢复枚举保留返回联合类型的 `parseChildRun`,遇到 `child_agent` 记录即跳过——child agent 没有 output manifest——而不是让整个 Session 打不开;回归用例把一条 child agent 提交放在已结算 Shell 谱系旁验证恢复。
- `packages/sdk-java/managed-agent-server` 中:`ManagedExtensionRecords`(按-kind 分发、`requireChildAgent`、`requireChildAcceptance` 及其 start/successor 检查)、`ManagedExtensionProjection`(记录体的 `taskKind` 改为记录的函数;`child_acceptance` 注册为无任务)、`ManagedExtensionRecordStore`(acceptance 的提交时跨记录检查与两个记录体的引用闭包),以及重放共享 fixtures 的 `ManagedChildRunRecordContractTest`、新的 `ManagedChildAcceptanceRecordContractTest` 与 `ManagedExtensionProjectionContractTest`,另有 `ManagedExtensionRecordStoreTest` 中与 TypeScript 套件对应的 store 级链测试。
- 本设计的双语版本。

## 验证计划

- **TypeScript:** 重放每个用例,含 start 与 successor;Shell 链与 child agent 链的任务投影;authority 套件(`managed-session-authority.child-agent.test.ts`)覆盖提交、重建、引用闭包、跨记录规则、禁用 domain 拒绝,以及重试命令返回原修订——全部以 mock 启用 domain 的方式进行,与 H3 套件相同。
- **Java:** 经 `ManagedExtensionRecords` 重放每个用例;两种 kind 的投影;`ManagedExtensionRecordStore` 在 H2(MySQL 模式)上提交并重建 fixture 链,拒绝跨记录违规、开启命令复用与越界资源;CI 的 MySQL 车道跑的是未变更的集成套件——目前没有任何车道在真实 MySQL 上提交这些链。
- **变异检查:** 对本切片新增或修改的每一处守卫,用同语言套件逐一变异并确认只经其指名的见证变红——dispatch 的 Runtime 绑定与 definition pin 守卫、盘符子句(含共享语料抓出的 Java 整段匹配回归)、跨记录检查、successor 的停止与终态冻结子句,以及 acceptance 绑定。第二轮评审指出的十处无见证子句,已在共享语料或 store 套件中各自补齐见证。

## 验收标准

- 两种语言下,fixtures 中每一种畸形结构与非法迁移都被拒绝,每一个有效用例都被接受。
- H3 的 shell fixtures 除 `kind-unknown` 外重放不变;该用例由 `kind: "child_agent"` 改指 `kind: "workflow"`,继续承担未知 kind 见证。
- authority 与 Java store 在启用前提交并重建 `child_agent` 链与 acceptance 链,且 `child_acceptance` 行不投影任务。
- 跨租户与缺资源的提交保持 store 既有答案;一致性违规答案为 `409 managed_session_extension_record_rejected`。
- `child_run` 与 `child_acceptance` 保持拒绝提交;新校验器之外,唯一的行为变化是工作区恢复的 detached-lineage 枚举对 child agent 记录跳过而非拒开整个 Session。
- 其余行为不变,包括全部 H1/H2/H3 契约测试与零条目的 `contract-known-gaps.txt`。

## 待决问题

1. **H4b 先交付哪种完成模式。** `"sent"` 复用现有的 input+wake 捆绑;`"tool"` 需要一条对原调用原子完成 acceptance 与结算的路径。记录体已定;顺序由 H4b 决定。
2. **orphan 留存落地后 relay 的交付台账放在哪**——V48+ 的独立表,还是复用现有台账;由 H4b 决定,且不得占用已预留的 `qwen_managed_session_task_event` 名称。
3. **首个运行时切片准入哪些 `workspaceMode` 值**——仅 `shared`,还是有证据的 `snapshot`;`worktree` 需要 Workspace 各阶段尚未交付的 Runtime 能力。
4. **首个运行时切片是否准入 `depth` 大于 1**;契约上限为 8,嵌套 child(自动化 §8 A06)可跟在运行时嵌套能力身后落地。
5. **`unknown` 交付的运维出口**——长期无法解决的交付接近 `recovery_blocked` 但不是 run block;取消切片(H4f)连同 #12847 A7 决定操作员如何关闭它。

## 后续工作

| 切片   | 范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H4b    | 六个 child 操作;Java 血缘存储(V48+)、内部幂等创建路由与结果 relay;完成路径;关闭级联;配额;按部署顺序启用;关闭时的 `drain` phase 接线。另欠真栈评审暴露的交付方向决策:当前 `child_run` 的 delivery 可在没有 acceptance 记录时推进到 `consumed`,也可在 acceptance 已存在后改到 `unknown`/`rejected`——按决策 4 两者是独立事实,因此 run 标 `rejected` 而 acceptance 写着 `accepted` 是矛盾态。H4b 要么把这类反向迁移门到 acceptance 记录(反向检查),要么在其设计中声明 acceptance 记录为准。 |
| H4c    | `workflow` 记录体 kind;Workflow 工具作为带 definition pin 的 child run 准入。                                                                                                                                                                                                                                                                                                                                                                                                          |
| H4d    | `session_message` 记录体与无团队的持久 `send_message` 路由。                                                                                                                                                                                                                                                                                                                                                                                                                           |
| H4e    | `team_state` / `team_task` / `team_message` / `team_plan` 记录体与运行时;七个团队工具;plan resolution;成员关停;旧团队导入。                                                                                                                                                                                                                                                                                                                                                            |
| H4f    | 公开任务取消路由,带持久命令存储,落定 #12847 A6/A7 与 B12,与 H5 共享。                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Detach | 把显式 detach 的 child 迁移到独立 durable owner,跨越父关闭。                                                                                                                                                                                                                                                                                                                                                                                                                           |
