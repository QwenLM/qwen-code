# Managed 自动化运行时（H6b 与 H6c 的 persistent 分支）

[English](2026-10-07-managed-automation-runtime.md) | [简体中文](2026-10-07-managed-automation-runtime.zh-CN.md)

状态：本变更已实现 `persistent` 目标模式；`per_run` 目标（H4 child Session）与交付策略（H5 channel delivery）在各自运行时切片落地前继续拒绝，生产启用仍在部署级开关之后。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)（Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段）H6 切片的运行时部分：[H6 设计](2026-10-04-managed-automation.zh-CN.md)中的 **H6b**（定义、手动 run、单一 claim 扫描者、run 台账、overlap 与 catch-up）与 **H6c** 的 `persistent` 分支。它接在 H6a（`managed-schedule` 与 `managed-automation_run` 记录契约，PR #13536）之后，并延续 H0b（[记录契约](2026-09-27-managed-extension-record-contract.zh-CN.md)）、H0c（[authority](2026-09-27-managed-extension-authority.zh-CN.md)）与 H3（[后台 Shell 与 Monitor](2026-10-03-managed-shell-monitor-runtime.zh-CN.md)，本切片复用其内嵌唤醒调度器）的义务。下文的“参考设计”指[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)第 1、7、11、12、14 节，“自动化设计”指[自动任务、Channels 与子任务交付设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md)第 4 节，均以 #12827 固定的提交为准。本文与 H6 设计不一致之处，以本文“决策”一节记录的取代为准。

## 问题与范围

H6a 钉住了*什么可以提交*：以 `scheduleId` 为键、只增修订的定义链，以及以 `automationRunId` 为键、带封闭 occurrence 身份的 run 链。但没有任何东西*生产*它们：没有 Session 能提交这两个 domain，没有公开路由创建定义，没有扫描者推导 slot 或 claim occurrence，两条 planned 路由不返回任何内容。#12380 的 H6 行是本切片努力达到的出口：“持久 schedule/run claim、重叠/catch-up、persistent/per-run 执行和不重跑模型的投递。”

本切片端到端交付 `persistent` 纵切：

- **定义（H6b）。** 公开路由创建、修订、退役与列出定义。每个变更由控制面转发给目标 Session 的 Hosted Harness，由其 authority 提交定义修订——先把 prompt 发布为 Session 资源——并按 `Idempotency-Key` 重放。
- **Occurrence（H6b）。** 控制面扫描者在固定的 tz 数据库上为每个已布防的定义推导到期 slot，在带代数（fence）的租约下 claim 每个定义，把每次 occurrence 决定（fired、skipped、missed）记入自己的台账，执行 overlap 与 catch-up 策略，并以一次幂等的 Harness 操作点火。手动 run 是以其 `Idempotency-Key` 为键的同一操作。
- **执行（H6c，persistent）。** 点火提交 run 的 claim 修订，再在一个日志事务中提交其 dispatch 修订、run 的通知输入与 authority 生成的唤醒；Session 的内嵌唤醒调度器把该输入当作普通文本 turn 运行；turn 结算后在结算路径上结算 run，并在下次打开时再做一次。
- **公开读取。** `GET /v1/agent-automations` 与 `GET /v1/agent-automations/{automationId}/runs` 从 `planned` 转为 `partial`，并新增变更路由与定义详情读取；定义与 occurrence 分开分页。
- **开放。** 两个 domain 开放提交，按目标模式门控：只接纳 `persistent` 定义。

仍然推迟（不在本切片内）：经 H4 child Session 流水线的 `per_run` 目标（#13550）；交付策略及其到 H5 `channel_delivery` 的投影（#13572）；webhook 触发；Goal/Live/channel loop 迁移；新的预算种类；WebShell 镜像路由；生产 AgentBundle 启用。

## 现状

以下事实来自本切片的基线 `main` `e92b60a282`。

- **记录。** `managed-automation-record.ts` 与 Java 镜像 `ManagedExtensionRecords` 定义两个封闭正文并回放共享的 `managed-automation-record-v1` fixture。两个 domain 都不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中；`commitExtensionRecord` 拒绝它们。authority 的 `verifyExtensionResources` 不闭合任何 `schedule` 引用，于是 Session 之外的 `promptRef` 在本地存储能提交、在 HTTP 存储发布后才被拒（H6a 验证的发现 F1）。没有跨记录检查把 run 绑到定义；同一 `occurrenceKey` 换一个新的 `automationRunId` 可以再次提交。
- **公开契约。** 两条自动化路由在 1.33.0 为 `planned` 且没有响应形状；H0a 把定义 CRUD、手动 run 与 run 查询分配给了 H6。
- **Harness 侧。** `hosted-harness-session.ts` 持有各能力的 funnel 与每个能力一条控制面操作路由；H3 的内嵌唤醒调度器把来源为 `monitor` 的待处理通知输入当作文本 turn 运行，待处理集合从日志推导（`pendingSessionInputs`），关闭路径无模型地结算待处理的 monitor 输入。
- **控制面。** `HarnessConnector`/`HostedHarnessClient` 每个能力一个动词；`@Scheduled` 工作者从已提交的行对账；公开变更校验 `Idempotency-Key`、返回 `202`，并用 `X-Qwen-Idempotent-Replay` 标记重放（AgentDefinition 路由，D8a）。Flyway 位于 V47；开放分支占用 V48–V52。
- **Legacy 调度器。** `packages/core/src/utils/cronParser.ts` 以 daemon 宿主本地时间、Vixie 日语义求值五字段 cron；其状态只在 daemon 本地，节点替换后没有可对账的事实存活。

## 决策

1. **定义的家在其目标 Session。** `persistent` 定义的 `schedule` 链以及它点火的每个 `automation_run` 都在目标 Session 的日志里，authority 与 Java 存储都拒绝 `targetSessionId` 不是提交 Session 的 `persistent` 正文。prompt 在定义修订提交前发布到该 Session（`managed-automation-prompt`），`verifyExtensionResources` 与 Java 存储在 Session 自己的存储上闭合 `promptRef`——H6a 验证的 F1 以 Session 作用域定案。自动化设计的规则随之成立：扫描者只发现候选；目标 Session 的 authority 受理 run 与唤醒，无论是否有活的 Harness 挂载（由控制面加载）。
2. **身份只派生一次，两种语言一致。** `automationRunId = arun_<sha256(scheduleId NUL occurrenceKey)>`。authority 与 Java 存储拒绝 id 不是自身 `scheduleId` 与 `occurrenceKey` 派生值的首个 `automation_run` 修订，于是同一 occurrence 的两次 claim 在记录键上相撞，第二个 claim 方读取已提交的 run——这正是 H6a 验证要求 H6b 补上的结构性去重。run 的输入是 `<automationRunId>:input`（turn id 相同），run 的命令 id 为 `<automationRunId>:<revision>`，控制面以 `asch_<sha256(tenantId NUL Idempotency-Key)[0:32]>` 派生 `scheduleId`，因此在 Harness 答复与命令行之间崩溃后重试的 create 会遇到同一个定义，而不是铸造第二个。每个定义变更都在控制面从同一 `Idempotency-Key` 派生（基于名字的 UUID）并随 relay 传递的操作 id 下提交，于是被重新驱动的 relay 会重发同一个操作 id：authority 从日志重放该操作最初提交的修订——无论此后链如何前进——而不是把重试内容提交到更新的修订之上；控制面把重放答复记为该操作的结果，其镜像也绝不回退到已跟踪修订之前。内容与已提交定义完全一致、因而不追加修订的变更，会提交一条 `operation.replayed` 标记并记录所应答的修订，于是其答复丢失后的重试应答该已受理的结果，而不是把旧内容重新应用到已前进的链上。每次重放都校验操作的目标，以及 define 的请求内容；同一操作 id 指向另一个目标或另一份内容的重试以 `409 automation_operation_conflict` 拒绝，绝不拿别的请求的结果作答。
3. **run 以当前修订绑定活的定义。** 首个 `automation_run` 修订必须命名同一 Session 内已提交、非终态、且恰好处于其当前 `definitionRevision` 的 `schedule`，并带相同的 `sessionMode` 与 `targetSessionId`。从旧修订推导出 slot 的扫描者会被拒并重新读取；每定义水位（决策 7）使 slot 是否已覆盖与读它的修订无关。
4. **run 的修订链，persistent 分支。** 修订 1（`claim`）：run `admitted`、execution `intent`、`dispatchId = automationRunId`，无 runtime、无 delivery。修订 2（`dispatch`）：run `running`、execution `dispatch_started`，与 `input.accepted`（来源 `automation`，封装资源携带 turn 文本）及生成的 `wake.requested` 同一事务提交。修订 3（`settle`）：run `settled`（turn 完成）、`failed`（turn 出错）或 `cancelled`（turn 取消），execution `settled`；被关闭路径无模型结算的输入以 `cancelled` 结束，execution 为 `not_started_proven`。每一步在每条状态线上至多移动一个允许的步（H0b），因此任意两步之间崩溃留下的链都能被下一步补全：没有 dispatch 的 claim 由扫描者的 `firing` 行重新驱动，没有结算修订的已结算 turn 在 Session 打开时对账。turn 内部*发生*的崩溃从日志侧无从取证：该 run 恰结算一次为 `failed` 且 execution `outcome_unknown`（H0b 配对在此恰放行这一对，自仅限 recovery_blocked 放宽）——可见地停在定义旁，而不是永远 `running`，名额立即释放。
5. **一次 Harness 操作点火；它在任何副作用前完整，且可安全重放。** `POST /session/:id/automations/operations` 的 `kind: fire_run` 在 funnel 的串行链中提交修订 1 与 2 并返回已提交的 run；重放返回同一个 run，并补上缺失的修订 2。扫描者在调用前把 occurrence 行写为 `firing`，只在收到答复后标为 `fired`，于是在此之前任何位置崩溃都会重新驱动同一操作，而绝不是第二个 run。每次 occurrence 写入都携带写入者持有的租约（owner 与 fence），租约过期的扫描者无法记录或结算任何行；手动运行持有同一租约（tick 一直持有时返回 `409 automation_busy`）。丢失的答复以退避方式重新驱动（2 秒起倍增、位移钳制在 256 秒——约 64 次的总窗口接近四小时，而不是每次尝试限 5 分钟），64 次后该行记为 `unknown`：可见、不再重驱、不计入 active。run 已 dispatch 的 occurrence 被重放时，即使定义已修订或退役也返回该 run；定义在 dispatch 前结束的 claim 以 `cancelled`、execution `not_started_proven` 结算。`revision_stale` 答复会先从已提交记录刷新镜像，并把 claim 重新钉到当前修订重试一次，仍失败才记为 `skipped(revision_stale)`。其他确定性 4xx 答复一律以软路由的类型化错误码把 occurrence 记为 `skipped`、原因即该码——单凭请求自身即可判决的拒答就此了结本档，存储与传输故障应答的可重试 503 则由退避重新驱动；记入的原因就是应答自己的码，`hosted_session_blocked` 也不例外。run 依据其输入在日志中的 `turn.settled` 事件结算。`define_schedule` 与 `retire_schedule` 以同样方式提交定义修订，按 relay 传递的操作 id 重放（决策 2）。动词路由的 connector 在每次 relay 前重新执行与 `submit` 相同的 Workspace 准入校验，无论 attachment 是否已缓存，因此 Session 挂载后才被撤销的授权会同时挡住点火与定义变更。缓存未命中而 Session 此前已挂接（其记录携带 `harnessBootId`）时，relay 经由与 Turn 相同的 takeover load 重新挂接，控制面的每次重发版不会让全部自动化 Session 卡在 `hosted_session_already_attached` 上。
6. **恰有一个扫描者 claim，代数守护台账。** 每个定义有一行台账（`qwen_managed_automation_schedule`），带租约（`lease_owner`、`lease_until`）与单调的 `fence`；扫描者只在租约空闲或过期时 claim，递增 fence，之后每一步台账写入都带 `WHERE lease_owner = ? AND fence = ?`。因此失去租约的扫描者无法推进水位或记录 occurrence，至多重新驱动一次按派生 run id 幂等的 Harness 操作——副作用由日志守护，台账由代数守护。扫描者跑在独立的 `managedAutomationScheduler` 线程池上，不占用也承载消息物化、Turn 重试派发与恢复 tick 的单线程默认调度器，否则每次被阻塞的 Harness 调用都会按请求超时拖慢与之无关的工作。
7. **slot、水位、迟到 slot 与 catch-up。** 一次 tick 推导定义在窗口 `(from, now]` 内的 slot，其中 `from` 是已覆盖水位与布防时刻中较大者，且不早于回看地平线（`qwen.managed-agent.automation.lookback`，默认 24 小时）。`now − slot ≤ late-tolerance`（默认 5 分钟）的 slot 为*及时*，否则为*迟到*。及时 slot 点火。迟到 slot 在 `none` 下记为 missed；在 `latest` 下最新的一个迟到 slot 作为 catch-up run 点火、其余记为 missed；在 `bounded: N` 下最新的 N 个由旧到新点火。窗口内每个 slot 都有一行台账，水位推进到最新，因此后续修订——或后续 tick——绝不会重新布防已覆盖的 slot（H6 决策 2）。返回集有界（`max-slots-per-tick`，默认 1,000）——逐分钟的遍历本身跟随回看地平线，因此放大回看会扩大每 tick 的工作量而不是削减排程；窗口超出返回上界时从最旧一端截断并记录日志——这里不存在无限补跑的路径。
8. **overlap 是 Session 输入队列的准入。** `persistent` 目标一次运行一个 turn，因此重叠的 occurrence 只是日志里多一个待处理输入。`active` 统计该定义中 run 非终态的 occurrence（含 `firing` 行）。`skip` 仅在 `active = 0` 时点火，`queue_one` 仅在 `active ≤ 1` 时（一个在跑、一个在日志中等待），`allow` 最多到并发配额（默认 4）；被丢弃的 occurrence 以原因 `overlap` 或 `count_limit` 记为 `skipped`，绝不记为 run。目标 Session 不是 `ACTIVE` 时记为 `skipped`，原因 `session_not_active`。目标上有未结束的公开 Turn 时，在任意 overlap 策略下一律记 `skipped`、原因 `overlap`：Session 一空闲，唤醒泵立即启动排队的自动化输入，而派发器以退避重试该 Turn——周期性定义可以因此把该 Turn 饿死；Turn 先行，结束后 slot 再点火。该计数关联托管 Session 存储的记录投影，因此只有 `qwen.managed-agent.automation.enabled` 与 `qwen.managed-agent.session-store.enabled` 同时开启时，变更类请求才不会返回 `409 automation_unavailable`。
9. **cron 求值由共享 fixture 钉住。** 两种语言都按 UTC 枚举分钟时刻，在定义的时区读取其墙上时间，并按 H6a 文法在 Vixie 日语义下匹配（两个日字段都不是 `*` 时任一匹配即可）、`7` 为周日、`N/step` 为 `N..max/step`。落在 DST 空隙内的墙上分钟在空隙后的第一个时刻点火一次；被 DST 折叠重复的分钟只在其第一个时刻点火一次。`managed-automation-slots-v1.fixtures.json` 钉住这些表——包括七个 H6a 锚点时区中的空隙与折叠见证——TypeScript 与 Java 都回放。Java 扫描者是生产求值器；TypeScript 孪生的存在是为了让语义成为契约而非实现细节。
10. **时区在准入时于固定数据库上解析。** H6a 契约只检查名字形状；控制面拒绝宿主 tz 数据库无法解析的时区（`400 automation_timezone_unknown`），扫描者把时区不再解析的定义停靠（`blocked_reason`）而不是凭猜测点火。
11. **定义是 Session 创建者的变更，以 `202` 同步应答。** `POST /v1/agent-automations` 为调用者创建的 Workspace 绑定 Session 创建定义（与后续 Turn 和 cwd 变更相同的授权）；`POST /v1/agent-automations/{automationId}` 修订它；`DELETE` 退役它（链以 `cancelled` 结束并冻结）；`POST /v1/agent-automations/{automationId}/runs` 点火一次手动 run。每个变更都带 `Idempotency-Key`，同步转发给 Harness，以 `202` 返回资源，并通过控制面的命令台账按 key 重放（`X-Qwen-Idempotent-Replay: true`）；同一 key 下不同正文返回 `409 idempotency_conflict`。参考设计的 `202 + operationId` 按 D8a 的方式兑现：应答就是已提交的资源，控制面从不持有半提交的操作，因为 Harness 只在日志提交后才应答。
12. **三个台账，一个 authority。** 日志中的 `schedule` 与 `automation_run` 链是唯一的业务事实。控制面保有三个可重建的索引：定义行（扫描者对最新修订的视图，在镜像修订落后时从记录刷新，外加租约与水位）、occurrence 行（每次决定一行，以 `occurrenceKey` 为键，携带派生 run id、触发方式、结果及其原因）、命令行（公开幂等）。它们都不保存日志不结算的第二份事实。
13. **开放按模式门控并由部署开关把守。** `schedule` 与 `automation_run` 加入 `MANAGED_SESSION_ENABLED_DOMAINS`；旁边的新门禁 `MANAGED_SESSION_ENABLED_SCHEDULE_SESSION_MODES = ['persistent']` 由 authority 在每个 `schedule` 修订上检查（模式不是链的固定键，只查首个修订会让后续修订取一个首个修订不许开启的模式），run 经决策 3 继承它。除非 `qwen.managed-agent.automation.enabled` 为 true（默认 false），控制面的扫描者与变更路由保持静默；读取路由始终应答。服务器优先的顺序成立：Java 存储自 H6a 起已校验两个正文，并在此获得跨记录检查。
14. **没有 WebShell 面，不改 Legacy。** daemon 的 `/scheduled-tasks` 路由、`cronScheduler.ts` 与 `cronParser.ts` 保持原行为；Managed 定义绝不经它们点火。
15. **崩溃的 wake turn 只有一份善后账，一直重试到能证明做完。** 在 Harness 崩溃中死去的 wake turn（分类为 `recovery`，绝不重驱）按同一个幂等序列收尾，序列的键是日志与 checkpoint 而不是之前跑过哪一步结算：run 以 execution `outcome_unknown` 失败；若其 checkpoint 持有 in-progress 的 Runtime 执行，则驱至终止并以 cancelled 结算——每个 cancelled 的 `tool_result` 只提交一次，checkpoint 由此离开 `await_runtime`、历史保持形态——然后 wake 会话交回 Broker 租约，且每次尝试都补发 release，因为日志说不出上一次尝试是否落地；然后才由崩溃输入自己的 `turn_result` 把它消费掉，瞬时的日志冲突会重试——因为消费未被证明时输入保持待处理，之后每次加载与每次被 block 的泵 pass 都重跑同一套结算——绝不丢弃，否则"反复被 block"的回路就会回来。被 block 的泵循环在死掉的 pass 之后自行重新点火，瞬时故障不会连带提醒一起消亡。崩溃的 run 若一直占着 overlap 计数，就可能再也没有任何东西加载这个 Session（没有 slot 点火、没有 Turn 到来）：扫描者对计数值造成的拒绝——绝不是开放 Turn 的那一个——先向 Harness 发第四个动词 `reconcile_run` 询问那些阻塞的 occurrence（不提交任何新事实）；该动词自身的加载会分类并结算崩溃的 wake turn、返回其 run，本次决定按这些应答而不是滞后的镜像定价准入。在这样的 park 未结清时到来的 prompt 在准入前以 `409 hosted_turn_recovery_in_progress` 拒绝——协调器会在准入前预算之外一直重试到泵把 park 结清，因为只有这一种拒绝会在守护自己的恢复通道里自行消解，而 durable 的 `hosted_turn_recovery_required` 仍然计入预算；准入之后恰是任何重试都到不了的地方。以无应答结束的 turn（`error` 或 `cancelled`）的提示词绝不进入后续任何 turn 的模型历史，在两个历史构造点都按日志过滤，崩溃的指令永远不合进无关 turn 里——即无 toolProfile 路径的旧规则，如今对每种 profile 都是结构性的。已结清的 run 按镜像自身的真相定价重试，绝不在旁边另算：reconcile 的结算与答复的正是同一提交，镜像行同请求落盘，于是重新计数只减读出仍阻塞的而不再把被答复的再减一遍；只有被询问 occurrence 自己的 run 答了终态才算 resolved——绝不只凭 route 的 `repaired` 旗标：该旗标是 Session 级善后，可能已经结清了更早的邻居而被询问的 run 仍活；与定义或其 Session 的终了相遇的 reconcile 按 refresh-retire 处理镜像并把该档记为 `skipped(definition_retired)`，不再永久站到那里；每次决定的 reconcile 扇出按配置的 allow 上限走，最小为 2。

## 流水线，逐修订

| 步骤 | 位置                   | 提交                                                                                                                                          |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 控制面 `create`        | 命令行；Harness `define_schedule` → prompt 资源 + `schedule` 修订 1（`admitted`，`definitionRevision 1`）；定义行镜像                         |
| 2    | 控制面 `update`        | Harness `define_schedule` → `schedule` 修订 n（`definitionRevision n`，run 不变）；定义行刷新                                                 |
| 3    | 扫描者 tick            | claim 该行（租约 + fence）；推导 slot；窗口内每个 slot 一行 occurrence（`firing`、`skipped` 或 `missed`；重驱的 claim 可能以 `unknown` 结束） |
| 4    | Harness `fire_run`     | `automation_run` 修订 1（`admitted`/`intent`），随后修订 2（`running`/`dispatch_started`）+ `input.accepted` + `wake.requested` 同一事务      |
| 5    | 扫描者                 | occurrence 行 `fired`；在 fence 下推进水位；释放租约                                                                                          |
| 6    | Harness（唤醒）        | 自动化 turn 运行；`turn.settled`                                                                                                              |
| 7    | Harness（结算 / 打开） | `automation_run` 修订 3（`settled`、`failed` 或 `cancelled`，execution `settled`）                                                            |
| 8    | Harness（关闭）        | 待处理的自动化输入无模型结算；其 run 以 `cancelled` 结束，execution `not_started_proven`                                                      |
| 9    | 控制面 `retire`        | Harness `retire_schedule` → `schedule` 终态修订（`cancelled`）；定义行 `retired`                                                              |

每次提交在每条状态线上至多移动一个允许的步；每个控制面动词在行动前重新读取已提交的记录，把“已经在了”当作自己的重放。

## 配额与配置

| 上界                 | 取值                                                                                                                                                                                            | 拒绝 / 效果                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| prompt               | ≤ 64 KiB UTF-8，且封装后的执行输入——turn 文本加封装，取路由许可的最大身份字段并按真实 JSON 转义计——不超过 65,536 字节内联资源上界；准入时精确计算，因此绝不会提交一个 `fire` 发布不出输入的定义 | relay 前 `400 invalid_automation`；funnel 处 `400 invalid_automation_operation` |
| goal                 | ≤ 4,096 UTF-8 字节，无控制字符（H6a 契约）                                                                                                                                                      | `400 invalid_automation`                                                        |
| `allow` 下的并发 run | 4（`qwen.managed-agent.automation.concurrency`）                                                                                                                                                | occurrence `skipped`，原因 `count_limit`                                        |
| 迟到容忍             | 5 分钟（`late-tolerance`）                                                                                                                                                                      | 更早的 slot 按 catch-up 策略处理                                                |
| 回看地平线           | 24 小时（`lookback`）                                                                                                                                                                           | 更早的 slot 既不点火也不记录                                                    |
| 每 tick 的 slot 数   | 1,000（`max-slots-per-tick`）                                                                                                                                                                   | 窗口从最旧一端截断，记录日志                                                    |
| 扫描周期 / 租约      | 10 秒（`scan-delay`）/ 60 秒（`lease`）                                                                                                                                                         | 停摆的扫描者让出其行                                                            |
| 每 Session 的定义数  | 32                                                                                                                                                                                              | `409 automation_count_limit`                                                    |

## 涉及文件

- `packages/core/src/managed-runtime/`：`managed-session-records.ts`（开放与模式门禁）、`managed-automation-operations.ts`（新增：身份、摘要、封装、turn 文本、正文构造器、最终输入预算）、`managed-automation-slots.ts`（新增：cron slot 求值器）、`managed-session-authority.ts`（模式门禁、run→定义跨记录检查、派生 id 检查、`promptRef` 闭合、已提交操作的读取）、共享 slot fixture、同目录测试。
- `packages/cli/src/serve/`：`hosted-automation-session.ts`（新增 funnel）、`hosted-harness-session.ts`（funnel 接线、带 `reconcile_run` 的操作路由、`automation` 输入的唤醒准入、唤醒路径与打开时崩溃 wake turn 的善后账、关闭时的结算、prompt 路由的 wake-park 拒绝、按日志的历史剔除、恢复校验器的 domain 列表）、`hosted-monitor-wake.ts`（关闭时的 turn 来源、被 block 循环的重新点火与跨死 pass 存活）、`hosted-harness-model.ts`（历史组装消费构造点过滤后的记录）。
- `packages/sdk-java/managed-agent-server`：`V54__managed_automation_ledger.sql`、`AutomationLedgerStore`（另加阻塞 run 的读法）、`CronSlots`、`AutomationScanner`（计数值拒绝前的 reconcile 扇出）、`ManagedAutomationService`、`ManagedAutomationController`、`HarnessConnector.runAutomationOperation` 及其连接器实现、`ManagedExtensionRecordStore` 中的跨记录检查、`ManagedExtensionRecords` 的 H0b 配对规则（`failed` + `outcome_unknown` 配对的放行）、`PublicSurface`、properties 与 `application.yml`、OpenAPI 路由与 schema、`ApiModels` 记录，以及测试（slot、台账、扫描者、服务、存储、契约）。
- `packages/sdk-java/qwencode`：`HostedHarnessClient.runAutomationOperation`。
- 本设计的两种语言版本；H6 设计的状态行与切片表（两种语言）；H0b 记录契约的共享 fixture（`managed-extension-record-v1.fixtures.json`：`failed-with-unknown-outcome` 随 F3 配对落地翻转为合法）；actor-roles 设计双语版本中 `/v1/agent-automations` 的表面矩阵行。

## 验证计划

- **TypeScript**：构造器套件（每个正文都被 H6a 解析器接受、每个后继都被规则接纳、派生身份、摘要、turn 文本）；authority 套件覆盖显式开放、模式门禁、run→定义绑定（缺失、已退役、修订过期、其他目标、其他模式）、派生 id 拒绝、结构性 occurrence 去重、`promptRef` 闭合与重开重建；funnel 套件覆盖 define/revise/retire 及其重放、答复丢失后重试的变更应答其已提交修订而已移动的链保持不动（含重开后）、封装输入无法发布的定义在准入被拒、`fire_run` 在一个事务中提交修订 2 与唤醒、仅有修订 1 的崩溃后重放、由 turn 结果结算、打开时与关闭时结算后的对账；slot fixture 回放。崩溃 wake turn 的善后账：未清 park 时 block 保持、泵循环把它做完（cancelled 的 `tool_result`、租约交回、消费重试）、`reconcile_run` 修复被 block 的 Session 而只对已消费者做汇报、消费对瞬时日志冲突的重试、park 未结清时 prompt 路由的准入前拒绝、无应答 turn 的提示词不出现在下一 turn 的模型历史里。
- **Java**：slot fixture 回放；台账套件覆盖 claim 竞争（两个 owner，一个 claim 方）、租约过期接管、失去 fence 后写入被拒、occurrence 唯一；扫描者套件覆盖策略矩阵（每一对 overlap × catch-up 对脚本化的及时、迟到与重叠窗口，断言确切的 occurrence 总体与结果）、模拟崩溃后的 `firing` 重新驱动、非活跃目标、楔死的 run 经 reconcile 让提问的那一档点火、未应答的 reconcile 保持拒绝待下一档重试、开放 Turn 绝不触发 reconcile；服务套件覆盖 create/update/retire/manual 的重放与冲突，以及答复丢失后重试的变更应答其已提交结果而镜像保留更新修订；connector 套件钉住缓存 attachment 之上的 Workspace 准入门禁；存储套件覆盖跨记录检查；契约测试覆盖每条新路由与响应。
- **故障注入（存储/authority 层）**：occurrence 行之前崩溃；行与 Harness 答复之间；修订 1 与修订 2 之间；turn 结算与结算修订之间；Harness 答复与水位之间——每种情况以每个 occurrence 至多一个 run、每个 run 至多一个模型 turn 结束。
- **变异检查**：派生、绑定检查、模式门禁、各策略分支、fence 守护与 DST 规则逐个禁用时，两种语言各有测试失败。

## 验收标准

- 参考设计第 14 节第 6 条：两个扫描者对每个 occurrence 只 claim 一个 run；模型完成后 Channel 发送失败绝不重跑模型（本切片没有交付，因此无从重跑）。
- 第 14 节第 10 条：每个 occurrence 都归为 `fired`、`skipped` 或 `missed` 之一，每个点火的 run 都以带已证明 execution 的 `settled`、`failed` 或 `cancelled` 结束；答复丢失的 claim 被重新驱动而不是猜测。
- 第 11 节：定义与 occurrence 在公开路由上分开分页；变更基于 `Idempotency-Key` 并返回 `202`。
- 两个 domain 只对 `persistent` 模式开放提交；契约测试证明门禁显式且按模式。
- 所有既有套件保持绿色——H1–H5a/H6a 的每个契约回放、authority、存储、tool-turn 与生命周期测试，`npm run typecheck && npm run lint && npm run build`，以及 `managed-agent-server` 的 surefire 套件。
- 仍属分开验收：真实多实例控制面、#12380 记录的 §13 产品栈验收，以及 `per_run` 与交付分支。

## 未决问题

1. **catch-up 的年龄上界**（H6 未决问题 2）：回看地平线以年龄与数量两方面约束 `bounded: N`；定义是否应携带自己的地平线留给使用情况决定。
2. **租约与扫描周期的取值**（H6 未决问题 3）：上述默认值是部署配置；实测值先于启用。
3. **手动 run 的范围**（H6 未决问题 4）：所有变更都定为 Session 创建者；reader 角色等待 actor 角色工作。
4. **两端相等的 cron 区间**：H6a 契约拒绝 `5-5`；求值器继承这一点，fixture 钉住它。

## 后续工作

| 切片    | 范围                                                              |
| ------- | ----------------------------------------------------------------- |
| H6c-run | 经 H4b child Session 流水线的 `per_run` 目标，待 #13550 合入。    |
| H6c-dlv | 交付策略及其到 H5 `channel_delivery` 条目的投影，待 #13572 合入。 |
| Webhook | 带已验证入口面的 `webhook:<eventId>` 触发。                       |
| API     | WebShell 镜像路由；若客户端需要，为自动化变更提供公开操作查询。   |
