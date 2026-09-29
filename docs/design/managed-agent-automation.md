# Managed 自动任务、Channels 与子任务交付

更新日期：2026-09-11；生产源码基线 `a836081466`，前版设计 `4cacfbd0ed`。本文定义[全量设计](managed-agent-full-design.md)的 C10/C11/C12：Channels 入站和交付，定时与内部继续，child/background/memory。以下新增协议、持久记录和恢复流程均待实现，已有实验或限定场景验证不证明本稿完成。首阶段仍延期这些能力的完整迁移；全量设计在本文给出，不延期决定其职责和失败语义。

记录采用[Session 存储](managed-agent-session-storage.md)，执行与关闭采用[coordinator](managed-agent-coordinator.md)和[私有控制协议](managed-agent-control-protocol.md)。worker/daemon 重启与平台保证采用[恢复规范](managed-agent-recovery-operations.md)，不由领域账本推断物理成功。

## 1. 当前实现与迁移接缝

源码位置均相对仓库根；本表描述当前事实，后续各节定义目标契约。

| 链路                   | 当前事实及源码位置                                                                                                                                                                                                                                                                                                                                                   | 迁移必须覆盖的差异                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Channel 路由           | `packages/channels/base/src/SessionRouter.ts:116` 支持 user、thread、chat_thread、single；`:156` 同路由共享创建 Promise。`ChannelBase.ts:5958` 使用实例名、sender/chat/thread/cwd，命名任务另有选中绑定。                                                                                                                                                            | 保留原 scope 和过期 route token 隔离；建立可恢复路由，展示身份不替代认证实例身份。                     |
| Channel 附件和回答     | `ChannelBase.ts:6088` 图片传 bridge，其他落盘附件把路径写入 prompt。`DaemonChannelBridge.ts:527,627,651` 上传后准入，仅确定未准入回滚；`:668` 发 stopReason 事件，prompt 返回聚合 string。                                                                                                                                                                           | 远端使用资源引用；完整正式内容不能再压成字符串；未知准入保留附件并查询。                               |
| Channel 取消和发送     | `ChannelBase.ts:6404,6453` 记录 sender owner，pending cancel 暂存 chunks；`:6519,6544` 正常发送后不把已发结果改为 cancelled；`:6612` 等 block sends drain 后清本 turn 状态。                                                                                                                                                                                         | 分开计算终态、外部交付及清理；迟到旧 turn 不影响新路由和发送。                                         |
| 主动交付               | `packages/cli/src/runtime/channel-delivery-ipc.ts:44` 为 deliveryId/channelName/user或chat/text；`commands/channel/daemon-worker.ts:760,1067` 使用 IPC id 和内存 Map；`serve/channel-delivery-authorization.ts:56,112` 一次 consume 授权，scheduled 身份为 taskId:firedAt。                                                                                          | 当前没有重启后强 receipt/dedupe；改成持久授权消费、outbox 和逐段发送结果。                             |
| 手动定时               | `serve/routes/scheduled-tasks.ts:1667` persistent `/run` 只登记，per_run 由 daemon 创建并等准入。`packages/web-shell/client/components/dialogs/ScheduledTasksDialog.tsx:1148,1164` recurring 先 enqueue 后记 run，one-shot 先 consume 后 enqueue。                                                                                                                   | 新 server-owned 执行必须提前协商，旧客户端不能在服务端派发后再发一次 prompt。                          |
| 自动定时               | ACP `packages/cli/src/acp-integration/session/Session.ts:8336–8383` 按 missed、per_run、wakeup、delivery、自主续轮分支；`:8407–8476` fresh child 失败当前回父队列。                                                                                                                                                                                                  | 保留分支；目标只有原派发确定封闭且未准入才允许回父，不能把超时当失败重发。                             |
| 锁与生命周期           | Core `services/cronScheduler.ts:1419` bound task 仅自身 Session fire，unbound 才依项目 lock；`cronTasksLock.ts:69,168` 按 pid/sessionId/lockId 认 owner。CLI `scheduled-task-keepalive.ts:298` 超时后仍等真实 settlement 才清 revive/spawn guard；`scheduled-task-session-lifecycle.ts:40,74,127` archive/unarchive/delete 保留人工 disabled 区别和时间锚点。        | 迁移锁、执行授权和容量分别处理；未知状态不能清账后重复唤醒。                                           |
| Channel loop/webhook   | `ChannelLoopScheduler.ts:102` 启动清 stale runningSince；`:183–220` fire 前重查 enabled，再标记 running 并执行；`ChannelBase.ts:1650,1992` 使用现 Session 队列。                                                                                                                                                                                                     | 这两类触发也进入持久 run；不能清 running 后假定上次没有执行。                                          |
| Goal/Live/队列         | Core `goals/goal-runtime.ts:120,184,1359` 区分 enqueue、模型已见和恢复激活。ACP `Session.ts:2210,8550` 的 goal/cron/notification 队列按用户和 Todo guard 串行。CLI `live-session-coordinator.ts:1289` mid-turn 未消费时转下一 turn，`:1668,1720` 使用 promptId/deadline/call 和 socket generation。                                                                  | 保存原优先级、permit、预算和因果身份；mid-turn 与下一 turn 只能消费一次；音频连接不可假称可恢复。      |
| daemon 子 Session      | `serve/create-sub-session.ts:797,820` 认证 caller、持久父链、深度 1 和并发上限；`:944,994` sent 后内存 drain，超时可释放逻辑 slot 但 child 可能还跑；`:375,428,492` 重试父持久接受并可恢复父。                                                                                                                                                                       | daemon 重启丢 drain；目标持久 relay 和实际占用，父接受与父处理独立。                                   |
| Agent/background/shell | Core `agents/background-tasks.ts:280,974,1710,1736` 前台结果/后台通知、取消竞态、shutdown sidecar running、先置 notified 再 callback；`background-agent-resume.ts:437–610,915` 恢复 running 为 paused、completed 默认 notified，校验 transcript/cwd/isolation/fork，再建新 child scope；`backgroundShellRegistry.ts:406,551` sidecar best-effort、取消等待实际退出。 | 当前 Map/notified/sidecar 不是父接受或原调用结算证明；沿用独立 scope，增强强状态和接收。               |
| memory                 | Core `memory/manager.ts:430,608` project 内存队列合并 trailing extract；`:971,1174` Dream 锁和仅 Dream 取消。`memory/extract.ts:145,162,197,225,249` 本地 scaffold/cursor，fork 工具写入，project index 必需、user index best-effort，再推进 cursor。                                                                                                                | 全量迁移包含模型之外的 scaffold/index/cursor/Dream metadata I/O，不能以类名 managed 声称已归 Runtime。 |

## 2. 领域记录、授权与共用限制

所有 Session 业务事实只通过所属 authority 的单 writer 条件事务提交，领域事件固定为 `domain.committed {domain,version:1,operationId,recordRef}`。recordRef 的内容按下表封闭 schema 验证，不提供任意 append 或任意方法调用。

本表以及 §5 的 Goal/Todo/plan、§6.1 的 team/session_message 共 15 个 domain，均按[存储 §3.1](managed-agent-session-storage.md#31-domain-注册索引)注册，正文使用 `kind=managed-<domain>, schemaVersion=1`。不把 goal_state/child_run/memory_job 改写为未定义的同义名；各阶段只启用已验收的用途和 schema。

| domain           | authority 内的权威内容                                | 生产者与消费者                                 |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------- |
| channel_route    | 已绑定 route key/revision、实例、目标和后继绑定引用   | 可信路由适配；入站与交付读取固定绑定           |
| channel_delivery | 授权消费、正式内容、outbox、每段发送 phase 和 receipt | 可信 Channel 接入/发送 owner；状态查询和恢复   |
| schedule         | 定义修订、enabled/归档状态、时间锚点、one-shot 消费   | 定时 CRUD/扫描适配；workspace 查询索引         |
| automation_run   | trigger、occurrence、冻结目标、派发和 fallback 状态   | 扫描者、手动入口、Goal/Live 等受控内部来源     |
| child_run        | launch/父链/scope/运行/终态、结果 outbox              | 原子任务编排 owner；父工具结果与背景任务投影   |
| child_acceptance | 父接受 receipt、对应工具结果或输入、消费位置          | 父 authority；relay、父 Harness 与资源回收     |
| memory_job       | 源事件区间、目标 store、维护阶段、cursor 和结果       | MemoryManager 适配；Runtime 回执、记忆状态投影 |

命令沿用 `CommandMeta`、`SessionKey`、`DurableRef`、`CommitReceipt`、错误和限额。响应在 CommitReceipt 外返回 `{operationId,state,throughSequence,receiptRef?}`；查询返回已提交事实，不能把 Map 空、404 或超时映射成未执行。幂等范围为 SessionKey+operation+commandId，同 ID 不同业务摘要冲突；expectedSequence 是可重读后更新的前置条件。旧 epoch 的重复成功请求只返回原 receipt，不恢复新派发权。

输入、资源接纳、领域意图与 wake 在同一 Session 内可以同事务提交。跨 Session 必须先发方 outbox，再接收方按原逻辑 ID 提交 input+wake 或结果接受，最后发方保存 ACK；不能宣称跨文件原子。引用在必要接收方持久接受、资源闭包迁移和关联 checkpoint 提交前保留。已接受输入不会因投影队列满消失，容量不足在 ACK 前拒绝；沿原 Bridge、子任务、model、workspace 的有效限额，不给每个新执行器重复一份预算。

Harness 创建新的领域意图仍需有效 activation fence。计算结束后的 Channel 发送及已受理维护计划使用控制协议的 `OperationGrant`：authority 按 operation 状态和 revision、lifecycle、workspace generation、资源及目标授权条件签发，只允许该 outbox/计划指定的 phase，不授予模型推进权。进入 Runtime 同样安装、核验 operation gate；撤权、乱序 ACK 和旧 generation 不能重开。status/cancel/原回执接收保留原 owner，不要求重新取得新派发权。

workspace route/task catalog 只负责身份定位、创建 reservation 和可重建索引，不保存第二份 Session 执行事实或执行 epoch。首次创建 reservation 记录稳定目标 SessionKey；目标 authority 提交 header 和领域绑定后才发布 catalog。中断按原 key 对账，不能换 ID 再创建。清理失败保留原 reservation、binding 和记录；实际已退出进程不永久计入活进程数，但未决副作用风险和资源 pin 继续单独统计。

## 3. C10：Channel 入站与交付

### 3.1 路由、附件与准入

| 命令                   | 必需业务字段；标 `?` 的字段可缺省                                                                                                        | 返回和状态契约                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resolveChannelRoute    | channelInstanceId、accountBindingRevision、scope、senderId/chatId、threadId?、selectedTaskId?、routeRevision                             | 可信连接补 tenant/workspace；结构化 route key 保留旧 scope 语义。catalog reserved→目标 Session 提交 route→bound；返回 SessionKey/routeRevision。创建不明保留原 reservation。 |
| stageChannelAttachment | uploadId、inputId、ordinal、mediaKind、mimeType、byteLength、digest、受控 sourceHandle                                                   | bytes 完整发布后返回 DurableRef；uploadId 重传不变。ready→owned 与 input 接纳同事务；只在确定未受理后回收。                                                                  |
| submitChannelInput     | inputId、platformEventId、eventRevision、routeBindingRef、actorRef、contentRef、displayRef、attachmentRefs、dispatchMode、replyTargetRef | policy/pairing/group/mention、trust、scope、附件验证后，input+资源 ownership+reply intent+wake 同事务。返回原 inputId/turnId/sequence；不等待模型。                          |

route 身份来自认证 channel instance/account，`identity.id`、senderName、模型文本均不授予权限。inputId 绑定实例+平台消息+语义版本，不能使用文本 hash 把用户重复发的相同内容吞掉。平台没有稳定事件 ID 时，adapter 必须在确认接收前持久生成并维护可关联的 ingress ID；不能关联平台重投的 adapter 明确不支持端到端入站去重，不能启用声称该保证的 profile。

附件通过 DurableRef 和受控资源传输进入所属 Runtime，不把 channel worker 的绝对路径当 Harness/远端路径。图片、音频、视频、PDF、文件和 resource 保留类型、顺序、完整内容与 display/model 差异；实际支持范围仍受媒体和 adapter 能力控制。未知 admission 查询原 inputId 并保留上传，不删除或重新分配 ownership；确定 rejected 才清自身 staged 上传。

queue/steer/collect 保持原产品语义。collect 提交有序 inputIds、内容清单和消费位置；steer 先持久取消原 turn，再等待可安全交接，未获原取消权限的共享 Session sender 仍降级 queue。`/clear` 原 Session 记录后继 route intent，再提交新 Session 绑定；catalog 发布新 revision 后新输入使用新 Session。旧回调只能引用原 immutable reply target，不能从当前选中任务重算目标。

### 3.2 计算终态与网络交付

| 命令                                        | 核心字段                                                                                                                                           | 状态和失败语义                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| planChannelDelivery                         | deliveryId、source:reply/prompt/schedule/background、sourceReceiptRef、replyTargetRef、routeRevision、authorizationRef、contentRef、segmentPlanRef | 来源为已提交正式消息或终态；同源结果+目标+ordinal 唯一。提交授权消费和 planned outbox，再允许发送；不从 preview delta 制造正式结果。             |
| dispatchChannelDelivery                     | deliveryId、attemptId、payloadDigest、targetBindingRef、adapterVersion、providerIdempotencyKey?、OperationGrant                                    | 每个 part/segment 先提交发送 intent 和 dispatch_started，再调用平台；未知重复请求只查询同 operation。                                            |
| queryChannelDelivery / acceptChannelReceipt | deliveryId；receipt 含 status、providerMessageIds、ackAt、deliveredPartOrdinals、proofRef                                                          | planned→sending→delivered/definitively_rejected/delivery_unknown；分段已部分发送另记 delivery_partial 和每段事实。ACK 丢失不改变消息是否已外发。 |
| cancelChannelDelivery                       | deliveryId、expectedRevision、reason                                                                                                               | 未派发 outbox 可取消；sending 只记录 cancel requested，核对原发送；delivered 不改成取消成功。真正撤回必须独立 capability、operation 和 receipt。 |

普通 reply 只能使用原已验证 envelope 的 chat/thread/replyTo；proactive 需要明确授权目标。scheduled delivery 授权绑定 scheduleRevision+runId，不能用一个新 timestamp 伪造新的授权。重复同 delivery 返回原 receipt，不再次 consume。计算终态和 delivery 终态各自唯一；计算完成后发送失败不能重跑模型。

adapter 必须声明 `{contentKinds,reply,thread,providerIdempotency,queryReceipt,revoke}`，由实现和故障验收决定支持值。拆分段、编辑卡片和流式外发保存稳定 segmentId、ordinal、外部 ID 和内容摘要；只能补确定未发送的段或使用平台原幂等 key 重试。无图片/文件能力返回明确 unsupported，不能悄悄删除正式 blocks；部分已发送则返回 delivery_partial。所有已经实际外发的流式片段也纳入发送账本，不能因后续模型流取消而假称未交付。

网络超时、连接断开或发送后 worker 崩溃均可能为 delivery_unknown。没有 provider query/幂等证明时不自动重试；用户显式重发创建新 deliveryId，保留原未知操作及可能重复提示。Channel instance/account generation 更换时先对原 outbox 对账；旧 generation 只保留原 query/cancel/drain，不把旧授权迁到新账号。

## 4. C11：定时、Goal/Live 与内部队列

### 4.1 Schedule 与 run

| 命令                                                                    | 核心字段                                                                                                                                                      | 提交和状态契约                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| registerSchedule / updateSchedule / setScheduleEnabled / removeSchedule | scheduleId、ownerSessionKey、revision、cron、scheduleContextRef、recurring、enabled、sessionMode、promptRef、deliveryRef?、source、missedPolicy、legacyGuard? | owner Session 内保存定义；context 固定解析时区/时钟策略。revision 条件更新，不回写历史 run；已有 legacy guarded 任务拒绝执行。                                                                                              |
| claimScheduledRun                                                       | scheduleId、revision、trigger、occurrenceKey、scheduledAt、triggeredAt、runId                                                                                 | trigger 为 scheduled/manual/catchup/wakeup/channel_loop/webhook。authority 复查当前定义、owner、enabled、时隙和额度，原子提交 run intent+one-shot 消费+dispatch outbox。                                                    |
| dispatchAutomationRun / queryAutomationRun                              | runId、targetMode:existing/fresh_child/confirmation、parentSessionKey、promptRef、deadline、sourceMetadata、goalPermitRef?、todoWorkChainId?                  | 目标在 intent 中冻结；created→dispatch_pending→admitted→running/waiting→settled；另有 awaiting_confirmation、dispatch_unknown、recovery_blocked 和 cancelled_before_admission。返回实际 SessionKey/inputId 或准确未决状态。 |
| resolveAutomationFallback                                               | runId、originalDispatchId、definiteNonAdmissionProofRef、fallback:parent、expectedRevision                                                                    | 原派发已封闭且能证明永不迟到受理，才 CAS 创建父 outbox。一次 not_found/超时/不完整成功响应不是此证明。                                                                                                                      |
| cancelAutomationRun                                                     | runId、reason、scope:pending_input/active_turn/descendants                                                                                                    | 未执行输入撤销；已准入用 Session cancel 和原 Runtime drain。schedule disable 停未来 fire，不隐式取消已运行一轮。                                                                                                            |

scheduled 唯一键为 scheduleId+revision+slot；manual 使用客户端 commandId；wakeup 使用原 wakeId；webhook 使用已验证 eventId。不同 trigger key 不能绕过 one-shot 的同一消费状态。claim 还要检查已提交 lastFiredAt/covered occurrence，定义更新继承覆盖水位；显式重设 anchor 才改变后续时隙。manual 保留实际毫秒时间，不按分钟取整。

新 Managed schedule 固定绑定 task Session，扫描者只负责发现候选，由该 Session authority 受理 run 和 wake；无活 Harness 也可受理。不能同时启用旧 ACP Session CronScheduler 对同一 Managed task fire。Channel loop/webhook 使用相同 run 账本和自己的 trigger/source，不把 startup 清 runningSince 当未执行证明。

### 4.2 精确派发分支与客户端兼容

| 入口/条件                                                          | 目标                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手动 per_run                                                       | fresh child；登记 run 与子输入准入可查询                                                                                                                                  |
| 手动 persistent                                                    | 既有绑定 task Session；未迁移 unbound 任务沿 legacy 选择行为                                                                                                              |
| 自动 token 限制停用；missed autonomous                             | 保留现停用/跳过策略，不形成执行原 prompt 的新输入                                                                                                                         |
| 自动非 missed + per_run + 非 @wakeup + 无 delivery + 非 autonomous | fresh child                                                                                                                                                               |
| 其他已接纳自动任务，包括 @wakeup、delivery、autonomous             | 现 task Session 队列                                                                                                                                                      |
| missed one-shot                                                    | 调度适配器对原 run/occurrence 经 requestAction 在实际控制 Session 提交 automation_run 确认；无活 Harness 也可等待并重连。合法最终决定提交后才产生有因果引用的新执行 input |
| 自动 fresh child 确定无法受理                                      | 原子封闭派发后允许既有父队列 fallback；unknown 保留原 run 查询                                                                                                            |

公开能力固定为 `scheduled_task_server_run_v1`，它只表示服务器理解新调用；每个目标 task/workspace 仍校验实际支持。新 Web/SDK **在呈现或调用 Run 之前**完成协商，并在该次请求带 `runProtocol:'server_owned_v1'` 与稳定 commandId。返回 `{dispatchOwner:'server',runId,state,sessionId?,inputId?}`，客户端不再调用 onRunPrompt。轮询和网络重试继续使用同 commandId，不生成新 fire。

缺省协议保持 legacy persistent 的“仅登记”契约及 per_run 的既有服务端行为，只用于原 legacy task。Managed task 不接受旧仅登记请求，也不转 legacy 执行。真正旧 Web 会先 generic prompt 再 `/run`，因此不能等 `/run` 返回才拦截：未经协商的客户端不能取得新 Managed task 的旧可执行列表视图；包含这种新任务且无法表达只读的旧列表请求明确 unsupported，不能静默隐藏任务或伪造 enabled=false。按已解析目标访问 legacy task 的旧行为保留；普通历史和可表达的只读查询仍可用。用户独立手动发送文本不等于成功登记 scheduled run。

one-shot consume 后保留 run tombstone/outbox，schedule 从列表移除不删除原 run 的查询与恢复依据。确定未派发可按记录的 retry policy 重新 arm；dispatch_unknown 不恢复为可再次触发的任务。归档只停未来 fire，保存 disabledByArchive；unarchive 不恢复原人工 disabled，按新 anchor 跳过 archived 区间；delete 先 tombstone/revoke 再清索引，保留未决 child/delivery/invocation 的结算。

### 4.3 内部继续与队列

`submitInternalContinuation` 的字段为 inputId、source:goal/todo/background/live/loop、causalEventId、ownerScopeRef、contentRef、deadline、deliveryPolicy，另按来源包含 permitRef。它是 `submitInput` 的可信来源适配，同事务提交 input+wake；不直接调用新模型循环。

队列投影保存原 user/Goal/cron/notification 优先级和 Todo stop guard，持久字段为 input position、priority、blockedReason、consumption state。合并 wake 不合并掉业务输入；对允许替换的 trailing/collect 项，显式提交 supersededBy、被替代输入及消费范围。已 ACK 项不因 MAX_QUEUE 或投影丢失静默 evict。后续自动工作不越过未决原调用的安全屏障。

原 get_goal/update_goal、todo_write、enter_plan_mode/exit_plan_mode 也有明确领域载体：注册 `goal_state`、`todo_state`、`plan_mode`（version=1，资源 kind=managed-<domain>）。Goal正文包含原完整Goal状态、revision、permit与预算/证据cursor；Todo正文包含原完整条目、稳定itemId/状态和revision；plan_mode正文包含原模式、申请actionId、决定及policyRevision。它们复用原工具参数validator和完整输出，不引入宽泛setState。只读get不追加事件；更新以executionCallId/operationId、expectedRevision和当前activation资格条件提交；UI模式切换通过已认证命令，不能模型自批退出计划模式。Todo validation Hook在状态提交前，postWrite在提交后；Hook失败不重写已提交Todo。状态更新、对应领域ToolOutcomeRef与必要继续意图经同一authority关联，恢复不重置预算或重复触发完成Hook；schema与权限策略版本绑定原Config视图。

Goal 身份为 goalId/revision/permit.turnId；startGoalTurn 接受、markTurnDelivered、finishTurn、预算/wind-down 和证据 cursor 各自保留。激活换代不分配新 Goal permit；旧 epoch 的迟到 finish 不消耗新 permit。prepareRestore 与 activateRestoredWork 分开，恢复依赖未核对前不自动续轮。

Live 输入身份为 callId/delegateId/inputRevision，绑定 callEpoch/socketGeneration、coordinator SessionKey 和原 deadline。mid-turn accepted 与下一 turn fallback 使用同 inputId，authority CAS `queued_mid_turn→drained` 或 `queued_mid_turn→promoted`，只能一支成功。通话断开不删除已确认文字输入/child 结果；已记录的 deliveryPolicy 决定是否继续后台，不能靠旧 socket 回调重建新工作。音频连接不可恢复为旧实例，继续通话须新绑定；旧 generation 不再播报。

## 5. C12：child、后台执行与父接收

| 命令                             | 核心字段                                                                                                                                                                                                                                                                | 契约                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startChildRun                    | launchId、childRunId、kind:session/agent/shell/memory、parentSessionKey、parentScopeId、parentExecutionCallId?、parentAgentId?、depth、completion:tool/sent、definitionRef、configSnapshotRef、inputRef、workingDirectoryRef、isolationRef?、historyOwnerRef、budgetRef | 父先提交 launch+reservation+outbox；独立 Session 子类才有新的 authority，其他为父 Session 下独立 scope。创建和首次输入使用原 launchId，不明不另建。                                                                                           |
| queryChildRun / continueChildRun | childRunId、expectedRevision、inputId、contentRef、configSnapshotRef                                                                                                                                                                                                    | reserved→starting→running/awaiting_action/awaiting_runtime→completed/failed/cancelled；paused/recovery_blocked 保留原状态和原因。completed agent 再继续产生新 childRunId 和 predecessor，不复用终态身份。                                     |
| commitChildResult                | childRunId、resultVersion、terminalReceiptRef、contentRef、usageRef、historyRevision、resourceRefs、outputCursor、pendingOwnersRef                                                                                                                                      | 提交唯一逻辑终态及正式结果；晚物理回执单独补原 operation，不改该终态。原 Runtime/domain outcomes 或明确 physical holds 必须可核验。                                                                                                           |
| acceptChildResult                | childRunId、resultVersion、parentScopeId、parentExecutionCallId?、contentDigest、terminalReceiptRef、contentRef                                                                                                                                                         | 父以 parentSessionKey+parentScopeId+childRunId+resultVersion 去重，同键不同内容冲突；open 父同事务提交 acceptance 和工具结果或 notification input+wake，返回 acceptanceRef/sequence。已关闭父只走原回执收件/孤儿结果路径，不创建输入或 wake。 |
| markChildResultConsumed          | acceptanceRef、parentTurnId、consumedThroughSequence，另按来源带 parentExecutionCallId 或 notification inputId                                                                                                                                                          | 只在父的相应工具结果/模型输入处理进度已提交后推进消费；父处理失败可续同输入，不能再次接受为另一通知。                                                                                                                                         |
| cancelChildRun / closeChildScope | childRunId、expectedRevision、reason、descendants                                                                                                                                                                                                                       | 封新派发、处理 pending actions，原 invocation cancel/status/receipt 和 history drain 后释放；超时不证明物理结束。                                                                                                                             |

严格区分三个状态：**子任务 terminal**表示子逻辑结果已持久；**父 accepted**表示父已保存结果及后续工作；**父 consumed**表示父已提交对应消费进度。跨 Session relay 只以 accepted ACK 停止重投，同 Session 的子 scope 也使用同一去重身份。foreground 通过父原工具结果返回，不额外发背景通知；sent/background 通过持久通知输入返回。前台转后台必须先提交 delivery mode 与父工具关联的变更，不能两条结果路径都生效。

resultVersion 在 v1 每个 childRunId 固定为 1；终态不能通过提高版本重新通知父。晚物理结果属于原 operation 的结算更新，另一次业务继续必须有新的 childRunId。关闭父的收件 ACK 仅表示原结果已保存，不表示父已受理新的自动继续；relay 保存此分型，不能把 orphaned 当 consumed。

parentAgentId/显示 agentId 可以跨继续保留，childRunId 不能把两次完成混成同一通知。approval、send_message、monitor 和进度都带 ownerScopeId；原父已关闭/删除时，结果保留在原收件/子 outbox 并标 pending/orphaned，不自动恢复父模型。父只是 Harness 不驻留而 Session 仍 open 时，accepted+wake 可正常激活并处理。

AgentTool、cold resume、fork、SubagentManager、MemoryManager 复用已有 scope-before-registry 顺序与权限/工具配置。hot continue 沿原活 scope；cold 先确认原 scope 已结算或移交，才创建新绑定并安装 gate。daemon create_sub_session 的 depth=1 与 AgentTool 的 nested depth 是不同限制，分别保留；per caller/workspace/model 并发、父链和 cwd/worktree 也分别校验。缺 bootstrap、cwd/isolation 不符或无法序列化的等待进入 blocked/保持驻留，不能从头执行冒充恢复。

root history owner 由 coordinator 保留，长于 parent turn/Harness；child 只有受限引用，不抢普通 transcript writer。物理备份和 history revision 由原 Runtime owner 产生，父 authority 持久接受后才推进镜像。child 从 P1 延续到 P2 的修改按真实 history turn 边界归属，保留最初备份；root close 先 child drain，再 history 持久接受，最后 root release。逻辑 deadline/cancel 终态可以仍有 physical holds，不能提前删除唯一结果或备份。

后台 shell 由 Runtime invocation/process owner 执行；启动前持久 childRunId→原调用 intent，后台 handle 返回后仍保留绑定、输出 cursor、receipt 和资源。原 worker 活着走认证 query；worker 退出后走 RuntimeReceiptStore 的 settled/not_started_proven/running_attached/unknown/corrupt 分类。PID、空输出、best-effort status 文件均不证明可重跑。detach 不杀已移交进程；close 走真实 cancel/drain，失败保留原清理 owner。

### 5.1 团队、任务板与信箱

当前 `packages/core/src/tools/team-create.ts:85` 用 team name、leadSessionId/leadPid 持久归属；`task-update.ts:470–567` 先写任务再派发分配，可能出现“更新成功、派发失败”，未变 owner/status 不重复派发；`team-plan-approval.ts` 和 `request-shutdown.ts` 校验 leader；`task-list.ts` 还会消费 leader 未读信箱。全量迁移复用 `agents/team/TeamManager.ts`、tasks、mailbox 与 identity 的规则，不把这七项工具仅映射成内存服务。

新增四种注册 domain（version=1，recordRef.kind=managed-<domain>）：`team_state` 保存 leader、成员/childRunId、membershipRevision 和生命周期；`team_task` 保存任务字段、依赖图 revision 和 assignment outbox；`team_message` 保存原 sender/recipient 绑定、每个收件/消费位置；`team_plan` 保存 plan 请求、目标 child/plan revision 与决定。团队 domain 的权威在 leadSessionKey 的单一 Session 事务中，其他子 Session 通过身份受控命令和跨 Session outbox 串联。send_message 的无团队路由另按下面的 recipient 分型选择发送方 authority，不借用或创建 team。成员不能因共享 team name、workspace 或模型自报 leader 获得管理权限。

team_plan 确认由可信团队计划适配器依据原已提交计划经 requestAction 创建，仍校验 child/planRevision 和真实 leader 路由；跨 Session 使用原接收去重。它不能伪造模型计划或自动批准。最终决定走 resolveAction 的原仲裁，resolveTeamPlan 只在有效决定持久后交付原 child；不为恢复确认界面启动新 Harness。

| 受控命令                                                    | 固定输入与返回                                                                                                                                                                                                               | 提交、消费与恢复                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| createTeam / deleteTeam                                     | teamId/name、leadSessionKey、operationId、expectedMembershipRevision；返回原 teamRef/revision                                                                                                                                | 名称 reservation 后提交 team_state；active→closing→deleted。旧 active/无法核验 owner 不回收；delete 只限 leader，先封成员/消息准入并 drain 原子执行，之后释放自有工作区投影，不能删仍被用户修改的 worktree                                    |
| createTeamTask / updateTeamTask / listTeamTasks             | 原 subject/description/activeForm/metadata、taskId、status=pending/in_progress/completed/deleted、owner、addBlocks/addBlockedBy，另带 teamRef/expectedTaskRevision/expectedGraphRevision                                     | 复用 sanitizeName、caller ownership、plan guard、循环依赖和 reciprocal edges 规则；在 authority 同事务更新任务及两向依赖，避免只更新一边。任务新分配或转 in_progress 时原子保存 assignment outbox，自认领/leader自己/未变 owner+status 不派发 |
| submitTeamMessage / receiveTeamMessage / consumeTeamMessage | messageId、真实 sender、recipient union（team:teamRef/membershipRevision/member或broadcastRecipients；background:parentSessionKey/ownerScopeId/childRunId；peer:targetSessionKey/routeProofRef）、完整 contentRef/summaryRef | `to` 的团队/leader/命名Session、task_id 路径仍按原解析；歧义准确拒绝。每个目标有独立 delivery/accepted/consumed，广播部分失败不重发已收成员；显式消息记录 input，不让 task_list 轮询多次消费或重新启动已关闭成员                              |
| resolveTeamPlan                                             | requestId、planRevision、childRunId、action=approve/reject、messageRef?                                                                                                                                                      | leader 且自身已退出 plan mode，原 pending 请求与完整plan/input版本匹配才提交最终决定；修改计划旧票失效，恢复不再次批准。决定送原 child，不能转授后续任意工具权限                                                                              |
| requestMemberShutdown                                       | requestId、teamRef、membershipRevision、targetChildRunId、reason                                                                                                                                                             | 保持 leader-only；发送原请求与成员实际 stopped 分开。成员确认、拒绝、失联/unknown分别记录，不能以消息已发释放进程或删成员原回执                                                                                                               |

send_message 在无 team 时仍支持两类原合法路径：task_id 由发送方/原父 scope 核验 BackgroundRegistry 对应 childRunId，paused/completed 继续沿 continueChildRun 的新运行身份；命名 peer Session 由发送 Session 持久 outbox、目标 Session input+wake 接受，不能要求 leadSessionKey。team 收件进入 team_message；background 消息固定使用 child_run/child_acceptance，peer 消息固定使用新增注册 `session_message`（version=1、kind=managed-session_message，正文为 sender/target/inputId/contentRef、outbox/accepted/consumed 与 receipt），真实 target 在受理时固定且分开 accepted/consumed。源码 `send-message.ts:222–225,439–445` 在要求 TeamManager 前就支持这两支，不能迁移后强制用户先建团队。

任务分配 outbox 的 dedupe key 为 teamId/taskId/assignmentRevision/recipientChildRunId；任务字段提交成功后发送失败，只续原分配收件，不重新执行 task_update 或重复改依赖图。任务完成影响依赖解锁，同事务记录下一候选，不直接在 TeamManager 回调里启动新模型。task_list 的返回形状和 leader 未读消息行为保留，消费游标经幂等领域命令提交；只读REST任务视图不触发消费。

旧 team 文件、tasks 和 mailbox 在各自原锁/owner保护下取一致快照，再导入lead Session。只迁移可验证的已完成事实；active成员需先结算或认证接管，旧 notified/read标记不是新accepted凭证。旧格式文件若仍给兼容reader使用只能是带revision的只读投影，旧写入口必须关闭；leader Session销毁后仍可从authority读团队/任务历史，不以PID失效自动重开同名团队。客户端文件/脚本必须物理读取投影时，由所属 Runtime 在 WorkspaceOperationGrant/OperationGrant下生成，不能另造可写团队事实日志。

## 6. Memory 的物理归属与维护阶段

`scheduleMemoryJob` 固定字段为 jobId、kind:extract/dream/skill_review、sourceSessionKey、sourceRange:{from,to,digest}、memoryStoreRef、baseStoreRevision、configSnapshotRef、policyRef。幂等身份包括源已提交区间、工作种类和目标 store；捕获不可变内容，不把活 Config/Promise 当 checkpoint。extract trailing 替换提交 supersededBy 和合并范围，Dream/skill review 的节流、权限和锁决策记录在 job intent。

`commitMemoryJob/reconcileMemoryJob` 使用 jobId、phase、invocationRefs、changedResourceRefs、indexReceiptRef、cursorRef、metadataReceiptRef、expectedStoreRevision。阶段固定为 `planned→running→writes_settled→index_settled→cursor_committed→completed`；必需索引失败为 needs_index。恢复先查询原调用，只补确定未完成的阶段，不重新运行已经写完的模型。Optional 维护失败另记 degraded，不覆盖已完成物理事实。

保留现有 skippedReason 和节流返回语义，无需模型或物理工作的 job 可提交 skipped 与 policyDecisionRef；若只需推进 cursor，仍完成该维护调用后才提交结果。failed/cancelled 与真实已完成阶段分别记录，不因跳过模型省略已经发生的维护效果。

| 工作                                   | 逻辑 owner                 | 物理执行与完成证据                                                                  |
| -------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| 提取/合并/skill-review 模型判断        | 完整 Harness 的子 scope    | 源内容/config/definition 与模型 attempt；本身不能声称文件已写                       |
| memory 文件写入、scaffold、目录与索引  | 所属 job + MemoryStoreRef  | Runtime 原生工具或受 OperationGrant 的维护调用；原调用 phase、文件版本与 receipt    |
| extraction cursor、Dream 调度 metadata | job authority 决定何时推进 | Runtime 写对应控制文件并返回 receipt；authority 保存引用，不自行 fs 写 Runtime 文件 |
| pending skill accept/reject            | action 仲裁及所属 job      | 决定提交后由 Runtime 执行被批准的文件变更；内存 pendingSkills 不是重启凭据          |
| UI task status/父通知                  | Session authority 投影     | 使用已提交 job/acceptance，不能把 Promise resolve 当物理持久完成                    |

project store 排他以真实存储身份+tenant/workspace 为键，user store 以认证 principal+namespace 跨 workspace 共享；MemoryStoreRef 同时约束允许根、读写范围和版本。每次写校验 contentVersion/jobId，防两 Session extract、Dream 与手动 memory_edit 覆盖。冲突先读新版本重算计划，已发生写入不重复派发。用户/team/Dream 的根权限由对应配置/Runtime profile 证明，不能从项目权限推导。

保留 project index 必需、user index best-effort 的行为：必需 index 成功前不推进 cursor；可选失败可继续 project 部分，记录 degraded 及独立修复 operation。新 cursor 引用已提交事件区间和 digest，不能依赖压缩后变化的 history 下标。Dream 写完但 gating metadata/release 失败分别报告，不重跑已完成写入。cancel 先封后续维护 phase并请求原调用取消，仍收已准入工作的真实回执；取消 ACK 不承诺尚未退出的 native 进程无效果。

## 7. 迁移、关闭与实现顺序

新能力使用 `automation-domains/1` 协商上述 domain/schema，数值限制复用存储规范；schedule server-owned 和 Channel adapter 能力分别协商。未通过对应配置/用途/platform 验收的新建仍选 legacy；既有 Managed 不在恢复失败时切 legacy。Windows owned-v2 当前 unsupported；全量目标采用恢复规范的 Job/native storage profile，未安装或未验收时仍不启用。

legacy schedule/route 迁移先在原 writer/catalog/cron 互斥下冻结旧新建与 fire，记录 sourceDigest、稳定目标 SessionKey 和迁移 intent。legacy Session 不原地改 engine，需迁移则创建独立 Managed task Session并保留原来源/父链。marker 为 staged→authority_registered→index_switched；目标 authority ACK 后才切 catalog/调度。中断查询原 marker，不重复创建，不同时启动旧 ACP scheduler 和新扫描者；未决旧 fire 必须先结算或有隔离证明。保留 taskId、历史 runs、人工 disabled、disabledByArchive、锚点和旧 guarded 拒绝语义。

旧 AgentMeta/JSONL、shell status、notified 作为导入证据，不能升级成强 receipt。仅在身份、完整 transcript、cwd/isolation/config 和终态可验证时导入结果；completed+notified 缺父接受证明时为 legacy_acceptance_unknown，不盲重通知或重跑。用户明确继续生成新 childRunId。旧 memory offset 只在封存前缀 proof 可映射时转换为事件区间，不能映射则保留 legacy checkpoint，不推进未证明覆盖的位置。

Session close 先封输入和领域新派发，保留原 status/cancel/receipt 接收、父结果、history 和资源直至收敛；关闭后的新结果不产生 wake。Harness detach 保留 schedule/outbox/原 invocation，workspace generation drain 保留原精确 cleanup，daemon 最后关闭共享 registry。观察超时与占用释放分开，未知 owner不由同 cwd 的新 runtime或primary替换。

首个恢复交付只保证 coordinator/原 worker 活着时替换 Harness；全量 worker/daemon 重启按 RuntimeReceiptStore 恢复已知结果和有证明的阶段，started 无终态仍 blocked。领域恢复先于 cron/Goal/通知新激活。R5 实现按全量设计拆片，F3 完成调度和子/记忆领域，F6 完成 Channels；本稿的设计完成不扩大当前默认允许范围。

## 8. 验收 A01–A07

下表是待执行的产品/故障计划，未在本轮运行。每组保留独立断点和观测，不以一个顺序成功样例覆盖所有分支。

| 编号                              | 必须实施的场景                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 通过条件                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 Channels 入站/路由/附件       | 同平台事件并发重投、不同用户同文本；clear 后迟到 create/回复、账号重绑；上传前后和 input commit 前后断连/kill；混合 image/audio/video/PDF/resource；route 迁移阶段中断及未知 schema。                                                                                                                                                                                                                                                                                                   | 同原事件一个 input，真实重复内容独立；原目标不被新路由替换；只在确定未接纳回滚，unknown 保留；类型/顺序/内容完整，unsupported 可见；路由 reservation 不重复创建。                                   |
| A02 Channels 发送/取消            | 第 N 段发送后丢 ACK/worker 重启；provider 有/无幂等和 query；cancel 在 held chunks、首 send、provider ACK 三个时刻；clear/stop 与旧 drain并发；daemon重启、旧generation、能力缺失。                                                                                                                                                                                                                                                                                                     | 已知段不双发，未知不盲发；原 key 可证明时补齐，模型不重跑；发送事实不伪改 cancelled，旧 cleanup 不清新 turn；部分/unknown交付可查且不提前GC。                                                       |
| A03 手动 schedule 协议            | persistent/per_run × recurring/one-shot × 新旧 Web/SDK；协商前入口、list/run和实际generic prompt顺序；登记/child create/input ACK处kill；manual/scheduled同分钟；迁移各marker中断。                                                                                                                                                                                                                                                                                                     | server-owned 单派发，旧调用不触发新第二次发送；无未协商可执行Managed视图；one-shot消费唯一、原run可查，unknown不重新arm或child+父双发；legacy任务契约保持。                                         |
| A04 自动 schedule 与生命周期      | 精确自动分支表、missed确认、autonomous/@wakeup/delivery；两扫描者、bound/unbound owner切换；fresh child ACK丢失/父fallback/迟到创建；archive/unarchive/人工disable/delete；loop/webhook stale running和旧guarded输入。                                                                                                                                                                                                                                                                  | 每occurrence一个run，missed确认不直接执行、autonomous不补；原dispatch未封闭不得fallback；归档锚点和人工disabled保持；坏配置不新派发，无双scheduler，无未知清账。                                    |
| A05 Goal/Live/内部队列            | cron/Goal/Live/background与用户prompt、Todo guard竞争；容量满/合并/替换；受理与消费间H替换；Goal permit/预算/wind-down和验证恢复；Live mid-turn/drain/promote、旧socket/stop竞争。                                                                                                                                                                                                                                                                                                      | 已ACK输入可重建，无静默evict；同因果输入只消费一次；Goal资格/费用/证据不重复；Live不双轮、不复活旧音频连接，自动工作不越过原未决调用。                                                              |
| A06 child/background/shell/父接受 | foreground/background/转后台、hot/cold/nested Agent、不同cwd/worktree；无team的background task_id及peer Session消息/重连去重/paused和completed继续；团队leader权限/plan改版/双向依赖与循环拒绝/任务写成后分配ACK丢失/broadcast部分成功/task_list消费/关停未知/旧team迁移；父P1→P2时child写；子terminal、outbox、父accept、父consume各断点kill；同agent连续两次完成；parent close/delete；cancel超时/迟到exit/PID复用、旧generation清理失败；旧sidecar/notified迁移、worker/daemon丢失。 | 原工具结果/通知不双交付，两个childRunId各接收一次；冷恢复scope独立，非法状态blocked；P2归属和原backup正确；关闭父不自动复活；真实未决保留，查询凭原receipt，未知不重执行、资源不提前release。       |
| A07 memory/维护/恢复profile       | 两Session同store extract、trailing替换、Dream/手工写竞争；写成功index失败、cursor ACK丢失、Dream cancel/metadata/release失败；旧offset迁移、坏/未知记录；关闭/撤信任/daemon重启；USER/team权限、Windows未支持/已实现profile。                                                                                                                                                                                                                                                           | 已写只查询，确定未完阶段才续；版本冲突可见，project必需/user可选准确；cursor不越未完成索引；物理I/O属于Runtime并有原phase receipt，旧OperationGrant不能开新phase；未知blocked，无错误平台默认启用。 |

每组记录冻结源码、协议请求/receipt、Session commit sequence 和真实文件/进程/平台消息证据。实现复用第 1 节的实际消费者并逐项接线；不以文档表、内存状态或实验页面通过代替普通入口验收。
