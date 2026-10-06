# Managed Workspace W2:同 Workspace 内受控 cwd 切换

[English](2026-10-02-managed-workspace-w2-cwd-change.md) | [简体中文](2026-10-02-managed-workspace-w2-cwd-change.zh-CN.md)

状态:已在本次变更中实现。属于 [proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380)(2026-10-02 交付快照中的"W2 同 Workspace 内 cwd 变更:受控目录变更准入与结算;公开/WebShell 路由仍为 `planned`")。
调研基线:main `d5c22d336b`(2026-10-02);随后合入 #13138(W1b,V31)、#13135 + #13223(绑定 close,V32)、#13142(D8a,契约 v1.29.0,V33)、#13194(绑定 archive/delete)与 #13112(绑定会话后续 Turn)之上——PR 并入的 origin/main 已越过以上全部;V34 被 #13090 占用、V35 被会话工具画像占用、V36–V39 被会话 journal 链占用(`V36` activation、`V37` event-type index、`V38` deferral marker、`V39` sequence index),V40–V44 又被会话创建者记录与 CSI 链占用、V45 被任务 journal 占用,迁移号改为 V46。
目标契约是 [Workspace v1.12 第 4 节](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.en.md),以及仓库内已评审的 OpenAPI 契约 v1.27.0——后者已固定两条 `planned` 路由及其 schema。

## 问题

绑定了 Workspace 的 Managed Session 在创建时固定 `cwdRelative` 与 `contextRevision=1`(W0b)。此后没有任何途径变更目录:W1 契约禁止变更,且所有 legacy 变更路由对绑定会话一律抛 `workspace_unavailable`。今天唯一的出路是放弃该会话并新建,代价是丢失整段对话。W2 在同一授权 Workspace 内提供受控、持久的目录变更:操作者的 actor 请求新的相对目录,控制面把该请求与 Turn 及生命周期操作串行化,校验目标,然后提交一次原子的 revision 递增,后续工具轮次据此执行。

## 已核实的现状

以下路径未特别说明时位于 `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/` 之下。

- **绑定。** `V7__managed_workspace_binding.sql` 新增八列绑定集合(`workspace_id`、`workspace_generation`、`workspace_storage_id`、`cwd_relative`、`context_config_ref`、`context_revision`、`workspace_config_ref`、`workspace_policy_ref`),以全空或全非空为整体,承载七字段的 `ContextBinding` 模型,含 `cwd_relative` 与 `context_revision`(创建时硬编码为 `1`,见 `store/ManagedWorkspaceRegistry.java:212`)。不存在 `context_state` 列,本切片也不需要:一个未关闭的 cwd operation 本身就是闸门。
- **operation 账本。** `V17__managed_session_operation.sql` 的 `managed_agent_operation` 是持久的 202 + Idempotency-Key 底座:按 (tenant, session, kind, actor, key) 唯一;PENDING/RUNNING/COMPLETED 状态;lease/claim/retry 列;以及带 `@Scheduled recoverOperations()` 的协调器(`service/SessionLifecycleCoordinator.java`)。kind 各自专属(`store/StoreModels.java:84` 的 `CLOSE/ARCHIVE/DELETE/ACTION_RESPONSE`);V24 增加了按 kind 的专有列,正是 cwd 列的模板。`findDeliverableOperations`、`claimOperation` 与 `retryOperation` 与 kind 无关可复用;`beginOperation`/`completeOperation` 不可复用(它们断言生命周期状态机,且拒绝绑定会话)。
- **准入屏障。** `insertTurnCommand` 在存在 ACCEPTED/RUNNING/CANCELLING Turn 时拒绝 `turn_active`,并自本切片合并接入起,对存在未关闭"上下文变更型"operation 的绑定会话拒绝 `session_context_busy`(其专属收窄谓词——PENDING 展示变更与 `ACTION_RESPONSE` operation 不上 Turn 屏障;见[并发与竞态](#并发与竞态))。`requireNoOpenOperation`(`:2035`)在存在未关闭 operation 或 PENDING 变更命令时拒绝 `session_operation_active`,`beginOperation` 与 `beginSessionMutation` 都会调用它,cwd 准入并排保留更宽的屏障。以上均在会话行锁内运行(`requireSessionForUpdate`,`SELECT ... FOR UPDATE`),竞争的准入由此串行化。
- **执行枢轴。** `WorkspaceRuntimeResolver.resolve()` 每次调用都重读持久化绑定并重建 scope(`service/WorkspaceRuntimeResolver.java` 的 `resolve()`,合并提交时在第 62–75 行);每个工具轮次由 `WorkspaceRuntimeTransport.acquire` 在**新的 Runtime Session** 上安装并激活**该**绑定(`service/WorkspaceRuntimeTransport.java` 的 `acquire`,合并提交时在第 53–78 行)。worker 按 Runtime Session ID 记录安装(`packages/cli/src/serve/managed-context-envelope.ts:347-453`),每次工具调用都从已安装绑定重新解析有效目录,且从不使用 `process.chdir`。**因此提交新的 `cwd_relative`/`context_revision` 到会话行是唯一的枢轴;下一轮的生产 acquire 路径会用完整的 worker 回执安装新上下文,不需要任何 TypeScript 或 worker 协议改动。**
- **授权。** `WorkspaceExecutionStore.authorizePassiveAttachment`(`store/WorkspaceExecutionStore.java:63-116`)联接会话、Registry、创建命令与访问授权行,要求 workspace/generation/storage 精确一致、Registry 为 `ACTIVE`、创建者持有 read/create 授权以及冻结 profile 引用。`WorkspaceRuntimeResolver` 还复核管理员挂载(规范路径 + `fileKey`)。
- **契约。** `managed-agent-public-api.openapi.json` v1.27.0 在第 1341/1479 行固定了 `planned` 路由 `POST /v1/agents/sessions/{sessionId}/cwd`(`changeSessionCwd`,Idempotency-Key 头)与 `POST /api/agent/web-shell/v1/sessions/cwd/change`(`webShellChangeCwd`),以及 `planned` schema `ChangeCwdRequest`、`PublicCwdOperation`、`WebShellChangeCwdRequest`、`WebShellCwdOperation` 和 `CwdOperationStatus`(`pending/installing/completed/failed/recovery_blocked`),契约文字写明:"W2: same-workspace only. Replay the original operation before revision/busy checks. Reject active or queued input and context holds. Poll the operation or await session.context.changed; do not treat 202 as activation." `ManagedAgentApiContractTest` 把"路由已映射但 spec 状态仍为 `planned`"视为漂移,因此路由与状态翻转必须同一 PR 落地。
- **需要补齐的契约空隙。** `session_context_busy` 在契约与代码中都不存在;`session.context.changed` 不在事件词汇中;`failure_code` 字段没有固定取值集合。
- **开关。** `qwen.managed-agent.harness.workspace-files-enabled`(`QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED`)控制可执行的绑定会话(`ManagedAgentStore.java:237`,部署形态由 `ManagedAgentProperties.validateWorkspaceFiles` 校验)。
- **变动中的边界。** 本切片在途期间绑定生命周期已合入(close #13135、archive/delete #13194),W1b(#13138)与 D8a(#13142,契约 v1.29.0)也先于它落地,随后 #13112 合入了绑定会话的后续 Turn/cancel/rename——本切片为其准入补上文档记录的繁忙屏障衔接(见[并发与竞态](#并发与竞态))。创建时每个绑定会话仍至多放行一次初始文件工具 Turn(G0 #12955);后续 Turn 现经 #13112 的路径准入。

## 本切片范围

一个 PR,四个部分:

1. **契约 v1.32.0。** 把两条路由与五个 planned schema 翻转为 `implemented`;在冲突词汇固定处补上 `session_context_busy`;在自由形态的 `PublicEvent.data` 上记录 `session.context.changed` 事件类型;版本号递增。(#13112 在此期间合入并在上游头信息中把后续 Turn 记为 v1.28,随后 #13210 以网关免鉴权签名认证占用 v1.30.0、#13265 以 H3 后台任务章节占用 v1.31.0;本切片发布 v1.32.0。)
2. **存储层。** `V46__managed_cwd_operation.sql` 为 `managed_agent_operation` 增加可空列 `target_cwd_relative VARCHAR(2048)`、`expected_context_revision BIGINT`、`result_context_revision BIGINT`(调研基线为 V30;其间 V31–V33 先后合入——W1b 恢复包(#13138)、绑定 close(#13135,经 #13223 重编号)与 agent 定义(#13142);#13090 随后占用 V34,V35\_\_managed_session_tool_profile 又占用 V35,会话 journal 链占用 V36–V39,会话创建者记录与 CSI 链又占 V40–V44、任务 journal 占 V45,因此本切片发布 V46。V15/V29 以 Java 迁移形式存在于 `src/main/java/db/migration`)。新增 `OperationKind.CWD_CHANGE` 及其专属准入、结算与失败方法;不改动生命周期状态机与 `ACTION_RESPONSE`。
3. **服务/协调器/路由。** 两个 API 面的准入服务、`SessionLifecycleCoordinator.deliver` 的 kind 分支、结算方法、两个路由处理器,以及按 kind 的 operation 读取(`ACTION_RESPONSE` 分支是先例)。
4. **测试与文档。** store/coordinator/controller/contract 测试、设计文档双语版、README 说明。

本切片的非目标(逐条记录于[边界与后续](#边界与后续)):

- 不改 TypeScript worker、Harness、envelope 或 fixtures。
- 不做 WebShell 前端控件;BFF 路由先就位,供其后续消费;不新增能力通告(capability advertisement)。
- 不做会话读模型中的 `WorkspaceContext.state` 派生(仍返回 `ready`;契约中该 schema 保持 `partial`)。客户端按契约文字通过 operation 与事件观察变更。
- 不向模型上下文注入新目录说明。模型今天本就不知道物理或逻辑目录(Harness 没有 `contextRevision` 概念),没有内容会因此过期。把可信目录变更说明注入对话属于后续 Harness 契约工作。
- operation 结算阶段不取 worker 安装回执。结算执行确定性的 Java 侧目标校验(见下);提交后的首个 Turn 会在任何工具运行前经由生产路径完成安装并拿到 worker 自己的回执。见[确定性结算探针](#确定性结算探针)。
- 跨 Workspace 移动、worktree/clone 流程、迁移会话存储。按设计这些应新建会话。

## 准入

`beginCwdChangeOperation` 在会话行锁内的一个事务中按以下固定顺序执行:

| #   | 检查                                                                                                                                                                                                                                                                                                                         | 失败                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | 参数解析(缺少 Idempotency-Key 头、JSON 畸形或字段为空,由请求绑定在方法执行前作答);随后必须存在可信 actor——先于键检查,由服务自身强制                                                                                                                                                                                          | 400 `invalid_request`;401 `actor_required`                |
| 2   | 键形态:键缺失仍属第 1 行的 400;形如非法的 `Idempotency-Key`(非 1..128 个可见字符)是独立的错误码。表面差异:WebShell 请求体字段另带 `@NotBlank @Size(max = 128)`,超长键在该面被 bean 校验拒为第 1 行的 `invalid_request`,公开头路径则答 `invalid_idempotency_key`——已在 WebShell 路由描述中披露                                | 400 `invalid_request`;400 `invalid_idempotency_key`       |
| 3   | `WorkspaceRelativePath.normalize` 接受 `cwd_relative`;归一化形态写入 operation 并进入摘要——与第 4 行同为服务侧检查                                                                                                                                                                                                           | 400 `invalid_request`;400 `invalid_cwd`                   |
| 4   | `expected_context_revision` 为 ≥1 的整数                                                                                                                                                                                                                                                                                     | 400 `invalid_request`                                     |
| 5   | 会话存在(`requireSessionForUpdate`)                                                                                                                                                                                                                                                                                          | 404 `session_not_found`                                   |
| 6   | 会话已绑定(legacy/未绑定会话没有 Workspace 上下文)                                                                                                                                                                                                                                                                           | 400 `unsupported_feature`                                 |
| 7   | 调用者持有读授权;调用者是该会话的创建者(`managed_workspace_create_command` 的 actor)——最先执行,使无读授权的调用者既无法探测会话/键的存在,也无法触及之后的任何一步,与兄弟 `beginLifecycle` 的纪律一致。无读授权的调用者不可见(404);有读授权的非创建者得到兄弟拒绝的 403——后续的 409 对两类调用者都不会泄露状态或当前 revision | 404 `session_not_found`;403 `session_operation_forbidden` |
| 8   | 按 `(kind, actorDigest, key)` 查重放:摘要相同返回原 operation 且 `replayed=true`;摘要不同则冲突——先于部署开关门槛,即使执行随后被禁用,丢失的 202 也能经原 operation 解析                                                                                                                                                      | 409 `idempotency_conflict`                                |
| 9   | 部署开关 `workspace-files-enabled`                                                                                                                                                                                                                                                                                           | 409 `workspace_unavailable`                               |
| 10  | 会话非 `DELETED`                                                                                                                                                                                                                                                                                                             | 404 `session_not_found`                                   |
| 11  | 会话状态为 `ACTIVE`                                                                                                                                                                                                                                                                                                          | 409 `session_state_conflict`                              |
| 12  | Registry 行仍与绑定的 workspace、generation、storage 一致且为 `ACTIVE`                                                                                                                                                                                                                                                       | 409 `workspace_unavailable`                               |
| 13  | `expected_context_revision` 等于持久化的 `context_revision`                                                                                                                                                                                                                                                                  | 409 `context_revision_conflict`                           |
| 14  | 无活动 Turn,无未关闭 operation 或 PENDING 变更命令(共享的 `hasOpenOperation` 谓词;生命周期准入以 `session_operation_active` 抛出同一条屏障),且无待决的权限 Action(`hasDecidableAction`——生命周期兄弟在完全相同状态下答 409 turn_active)                                                                                      | 409 `session_context_busy`                                |
| 15  | 插入 PENDING operation 并异步派发;返回 202。                                                                                                                                                                                                                                                                                 | —                                                         |

关于顺序与语义的说明:

- 第 2–4 行在准入服务中先于存储事务执行(与 G0 的"先解析后摘要"先例一致)——词法检查不读取任何会话事实,其错误不会泄露会话存在性,而它所喂养的摘要已固定第 8 行的重放语义。
- 请求摘要覆盖 `sessionId`、固定操作名、**归一化**目标目录与期望 revision(`RequestDigests` 规范化 SHA-256)。提交完成后的重试会重放出已完成的 operation,即使此刻第 13 行必然失败。
- 第 5 行起在会话行锁内运行;重放保持先于 revision 与繁忙检查,沿用 V17 的二进制安全键比较(契约文字的要求);第 6–9 行与 `beginLifecycle` 的调用者不可见与重放优先纪律一致。
- 仅创建者,与 #13112 为后续 Turn 宣布的策略及执行层自己的创建者授权复核一致(`authorizePassiveAttachment` 按创建 actor 联接)。开放给非创建者的 Workspace 写作者是另一个独立的准入决策。有读授权非创建者的拒绝词汇为 `403 session_operation_forbidden`——与已合入的绑定生命周期(#13135 的 close、#13194 的 archive/delete)发布的形态完全一致;本设计第一版对非创建者一律答 404,在集成时对齐了兄弟语义。结算在提交时仍经 `hasCwdChangeRegistryFacts` 复核完整授权集(创建 actor 的 `can_read` + `can_create`),准入之后授权被撤仍能阻止变更。
- 目标与当前目录相同的请求也会被接纳并正常完成,revision 递增。这是合法的再校验转移;拒绝它只会增加一个不保护任何东西的分支。
- 准入时不追加事件。契约唯一的 cwd 事件是完成时的 `session.context.changed`;pending 状态由 202 响应体与 operation 查询承载。

`admission_stage` 为 `JAVA_DURABLE`,`delivery_state` 从 `PENDING` 且 `available_at = now` 开始,因此现有的 claim 与恢复扫描会接管该 operation。`session_status_before` 记录 `ACTIVE`,但结算不读取它。

## 结算

`SessionLifecycleCoordinator.deliver` 增加 `CWD_CHANGE` 分支:

1. **认领**:走现有通用 `claimOperation`(RUNNING、LEASED、claim generation)。认领竞争失败时静默返回,与生命周期 operation 一致。
2. **确定性结算探针**。新增 `WorkspaceRuntimeResolver.verifyInstallable(binding, targetCwdRelative)`:
   - 经管理员挂载表按 `(tenant, storageId)` 解析挂载,映射缺失即拒绝;
   - 复核挂载的规范路径与 `fileKey`,并在已启用验证恢复时对**候选**绑定(目标目录)执行存储守卫的挂载校验——与 `resolve()` 对该目标的真实获取所做的完全一致;
   - 以探测专用的孪生形态执行目录规则:acquire 路径保持长期以来的谓词式 `requireDirectory`(任何 I/O 异常皆为终态——ENOTDIR 形态的 cwd 立即以准确错误码使 Turn 失败,绝不误报为可重试错误),探测孪生 `requireDirectoryForProbe` 一律用会抛异常的调用——`NOFOLLOW_LINKS` 的 `readAttributes`、`toRealPath` 恒等,以及取代 `Files.is*` 谓词的 `checkAccess(READ, EXECUTE)`——由 catch 分支按判定分类:目标消失、权限拒绝与 ENOTDIR/ELOOP 结构性形态均为终态(后两者在某些 JDK 上只现身为裸 `FileSystemException`,因此残余分支改为上溯祖先链——链上出现普通文件或悬空/成环符号链接即为结构性),只有不透明抖动(`ESTALE`/`EIO`、`ENAMETOOLONG`)经预算重试。
   - 结构性失败对该 operation 是终态:`failCwdChangeOperation` 记录 `failure_code=workspace_unavailable`,会话保持原 revision。探针运行在**与 worker 相同的主机与挂载快照**之上:其守卫经**探测专用入口**校验**候选**绑定(共享的 acquire 路径保持原有的终态语义;离开一个已被摧毁的当前目录仍可达——这正是本特性存在的理由),共享目录规则还带上 worker 自己的 `access(R_OK|X_OK)` 检查,probe 不会放过任何 worker 随后才以无类型化楔死呈现的目标。结构性探针拒绝折入类型化终态判定(调用方可重发),拒绝日志带 broker 错误码、异常类、消息与保留的异常因;一时的 I/O 失败保留异常因,经交付机械退避重试,而不是把一次从未发生的校验判定成终态——**以 8 次尝试为界**的封顶退避,用尽后以类型化终态结算:已接纳的 operation 必然以类型化状态终止,行离开可投递集合,两道准入屏障重新放行,会话不变且可执行。
3. **提交**,单事务:锁会话行;复核 `ACTIVE`、期望 revision、无活动 Turn、无其他未关闭 operation,以及与绑定匹配的 Registry 事实加上创建者仍存的授权(`hasCwdChangeRegistryFacts`——即 passive-attachment 的子集;含冻结 profile 引用的完整执行期集合仍由下一轮的 acquire 准入把关);随后更新 `cwd_relative` 与 `context_revision = expected + 1` 并常规递增 `version`,把 operation 标记为 COMPLETED 并写入 `result_context_revision = expected + 1` 与 `receipt_id`,追加 `session.context.changed`(`data: {sessionId, operationId, workspaceId, cwdRelative, contextRevision}`,按 store 事件 data 的 camelCase 惯例,source 为 `operation:<id>:completed`)。committed-event publisher 在提交后经现有 SSE hub 推送。
   - 若复核事实不再成立——revision 已变动为 `context_revision_conflict`、出现 Turn 或其他 operation 为 `session_context_busy`、授权/Registry 事实变化为 `workspace_unavailable`——operation 以对应 `failure_code` 进入 `failed`;由于该事务之前没有任何写入,会话行可证明地保持原上下文。
   - 其他 `RuntimeException`(传输、SQL、时钟)走现有 `retryOperation` 退避重试,不设上限,与生命周期契约一致:已接纳的 operation 不会悄悄死掉。
4. **租约回收**:属主挂掉的 LEASED operation 重新进入同一分支——探针只读且判定确定,重跑幂等。防二次结算的不是那个 CAS,而是交付状态机本身:已结算的行是 `CONFIRMED`、不可再认领,陈旧属主的完成或失败写入都被租约/属主/代际/活租约谓词拦下——竞争失败时 complete 返回 `null`、失败写入被跳过(`failCwdChangeOperation` 报告 `false`)。探针不留任何 ownership 或 worker 痕迹(不 claim、不接触 worker),崩溃不会遗留任何东西——这与 Turn 路径不同,后者按设计可能在崩溃歧义时保留存储租约,留待 W0e 恢复。

`recovery_blocked` 从已实现(implemented)的 `CwdOperationStatus` 枚举中移除:本切片没有任何路径能发出它——每个终态都可由构造证明原上下文完好,且本切片不引入任何能观察到"半安装会话"的路径。向生成的客户端通告一个永不可达的状态,等于许诺了不会触发的恢复处理;首个拥有产生者的切片届时再加回该值(该枚举在本切片之前从未以 `implemented` 形态发布过)。

### 确定性结算探针

参考设计要求在提交前取得 Runtime 与 Harness 的安装回执。本切片有意收窄这一点,而能安全收窄是因为已验证的合入架构性质:

- 每个工具轮次都在任何工具运行前获取**新的** Runtime Session 并安装当时的绑定(安装按 Runtime Session ID 记账;同一会话以不同 digest 重装会被拒绝)。新上下文的生产回执因此必然先于首次变更后的工具执行存在;缺失时该轮次以 `managed_context_unavailable` 受阻——类型化受阻,永远不会静默落在错误目录。
- worker 与控制面同主机、同 UID、同一挂载快照(由 `validateWorkspaceFiles` 与 resolver 构造期挂载检查保证),且共享的 `requireDirectory` 带上了 worker 自己的 `access(R_OK|X_OK)` 检查,因此 Java 探针判定与 worker 安装判定在同一快照上完全一致;其后的分歧只可能来自提交之后文件系统的变化,届时仍在首个 Turn 以类型化暴露,不会错向。
- 只在 Java 侧确定性检查之后提交,使结算真实可信,同时无需发明一条绕过所有权访问 worker 安装路由的通道(该路由今天只存在于 `acquire()` 的 claim→install→activate 链内,其 ownership claim 按设计可能在崩溃歧义时留置存储——探针绝不该引入这种风险)。

当部署演进到跨主机或容器化 Runtime 时,探针必须升级为真正的关闭门安装(独立传输序列、不占用存储),并重新审视本设计的[边界与后续](#边界与后续)。

## 契约与 DTO 面

`PublicCwdOperation` / `WebShellCwdOperation` 与 `PublicCommandOperation` 不同(无 `admission_stage`/`delivery_state`/`receipt_id`;新增 revision/target/failure 字段),因此新 DTO record 落在现有定义旁,而不是拉伸生命周期 record。operation 读取(`GET /{sessionId}/operations/{operationId}`、`POST /api/agent/web-shell/v1/operations/query`)按 kind 分支——沿用 `ACTION_RESPONSE` 先例——`CWD_CHANGE` 返回 cwd 形态;store 的 `CWD_CHANGE` 小写化后恰为契约的 `cwd_change` 类型常量。store 的 RUNNING 状态映射为公开 `installing`;`PENDING→pending`、`COMPLETED→completed`、终态拒绝→`failed`。

WebShell 请求体携带 `sessionId`、`idempotencyKey`、`cwdRelative`、`expectedContextRevision`(camelCase,与该控制器现有 DTO 惯例一致);公开路由用 Idempotency-Key 头 + snake_case 请求体,按契约固定。

## 并发与竞态

- **准入 vs 准入**(两个 cwd 变更,或 cwd vs close):由会话行锁串行化;落败的 cwd 准入命中第 8 步重放或第 14 步 `session_context_busy`,落败的生命周期准入命中 `requireNoOpenOperation` 的 `session_operation_active`。
- **准入 vs Turn**:第 14 步的 `hasActiveTurn` 覆盖活动 Turn,且 operation 侧把 PENDING 变更命令也视为繁忙。反向上,本切片为已合入的 #13112 补上所需的衔接:绑定会话后续 Turn 准入(`insertTurnCommand`)在同一把会话行锁内只统计未关闭的**上下文变更型** operation(仅 operation 行、排除 `ACTION_RESPONSE`)并拒绝 `session_context_busy`,Turn 绝无可能滑入其中之一——而卡死的展示变更(被杀的 rename)或在途的权限 Action 永远不会楔死 Turn 准入这条唯一的重获通道。cwd 准入与结算复核特意保留更宽的 `hasOpenOperation` 屏障:一个未了结的变更或一个待决的权限 Action 都会让『当前上下文』处于争议中,在争议消除前提交等于替不存在的确定性作证。代价也如实记录:卡死的 PENDING rename 行没有任何定时扫描能清走它(唯一能结束它的是同键重放与 `abandonSessionMutation`),因此它会永远挡住这条屏障——这是刻意做的取舍,而 Turn 屏障不做同样的保留,因为 Turn 准入是会话唯一的重获通道。
- **准入 vs cancel**:cancel 只在存在活动 Turn 时才有真实效果(否则 `commandEffect` 为 false),而未关闭 operation 会挡住一切 Turn,因此在 cwd operation 未关闭期间放行的 cancel 只是一行已完成的空插入——它扰动不了提交,因为提交事务随后会重核全部事实。本要点较早的版本曾许诺此种 cancel 会引出类型化拒绝;实际交付并被测试钉住的机制是良性的一种。
- **探针 vs 提交**:探针只读,不需要存储租约;提交事务在行锁内复核全部事实,因此探针与提交之间撤销授权或准入 Turn 只会让 operation 干净失败,而不会错误提交。
- **崩溃窗口**:准入插入是单事务;探针+提交没有可遗留的痕迹;提交与其事件同事务;回收会幂等地重跑分支。
- **提交后执行**:下一轮的 `acquire` 重新解析绑定、claim 存储,在新的 Runtime Session 上安装并激活新上下文并随后断言 ownership。泄漏的提交前 Runtime Session 无法执行——执行要求 ACQUIRING/READY 的记录状态,release 会关闭它;未结算的执行让其所属 Turn 保持 `RUNNING`,进而在第 14 步挡住准入。

## 涉及文件

- `…/db/migration/V46__managed_cwd_operation.sql`(新增)。
- `…/openapi/managed-agent-public-api.openapi.json`(状态翻转、`session_context_busy`、事件说明、版本 1.32.0)。
- `store/StoreModels.java`(kind、新列的 record 字段)、`store/ManagedAgentStore.java`(准入/结算/失败方法、事件常量、`insertTurnCommand` 的绑定会话后续 Turn 繁忙屏障、对增量列宽容的 operation 读取)、`store/AgentStateStore.java`(接口)、`store/WorkspaceExecutionStore.java`(`verifyMount`)与 `service/WorkspaceRuntimeResolver.java`(`verifyInstallable`、共享的 `requireDirectory`)。
- `service/SessionLifecycleService.java`(公开/WebShell 准入与读取分支)、`service/SessionLifecycleCoordinator.java`(kind 分支及其限定化的类契约)、`service/RuntimeWarmer.java`(探针接口及其抛出默认实现)、`service/EmbeddedRuntimeBroker.java`(委托 resolver 的探针 override)、`service/WorkspaceRuntimeTransport.java`(`requireDirectory` 上移至 resolver)。
- `api/PublicAgentController.java`、`api/WebShellAgentController.java`、`api/ApiModels.java`(路由与 DTO record)。
- 测试:store 准入矩阵、coordinator 结算/回收、H2+临时挂载的传输探针、controller 测试、`ManagedAgentApiContractTest` 与 planned schema 钉、Hosted 集成套件的 cwd 组(H2;MySQL CI 车道与现有套件并列)。
- `packages/web-shell` 按更新后的契约重新生成 `managed-agent-api.ts`(机械变更,与以往契约升级相同)。
- 本设计双语文档;`packages/sdk-java/managed-agent-server/README.md`(路由行为与门禁)。

不改 `packages/cli/src/serve/**`、`packages/core/**`、worker、envelope 或共享 fixtures。

## 验证计划

- **Java**:JDK 21 下 `packages/sdk-java/managed-agent-server` 的 `mvn test` 与 `mvn checkstyle:check`;聚焦的 store/coordinator/controller/contract 测试。
- **store 准入矩阵**:准入表每一行,含 CAS 前的重放顺序、摘要冲突、跨租户不可见、无读授权 404 `session_not_found` 与有读授权非创建者 403 `session_operation_forbidden`、授权被撤、Registry draining/removed、generation 漂移、期望 revision 不符、G0 初始 Turn 期间的 busy,以及同目录空变更。
- **结算**:探针失败时会话原样保留且 `failure_code=workspace_unavailable`;外部 revision 变动后提交以 `context_revision_conflict` 失败;提交时出现新活动 Turn 以 `session_context_busy` 失败;瞬时错误重试后成功一次;永不停歇的瞬时失败在 8 次尝试预算用尽后以类型化终态结算——可投递集合清空、两道准入屏障重新放行;消失的挂载根或目标判为终态(对照真实删除的目录钉住),一时的 I/O 形态判为可重试(以确定性的 ENAMETOOLONG 探测钉住);属主死亡的 LEASED 行回收后恰好完成一次;legacy 生命周期 operation 与 `ACTION_RESPONSE` 不受影响(其测试保持绿色)。
- **契约**:映射 vs planned 漂移测试、六个触及 schema 的钉、WebShell 孪生、事件文档一致性。
- **Hosted 集成(H2,镜像 G0 套件;加入 MySQL CI 车道)**:在目录 A 以初始文件 Turn 创建绑定会话(为后续 Turn 准备一次真实的变更前安装),等待该 Turn 完成,再经两侧 API 变更目录并做归一化重放,轮询 operation 到 `completed` 并断言会话行 revision/cwd 与公开流上的 `session.context.changed` 事件及 `/operations/query` 读取——随后经已合入的 #13112 提交一个绑定后续 Turn,断言其文件写入落在已提交的目录,而初始 Turn 自己的文件保持完整。负向组:开关关闭、legacy 会话、busy、CAS 冲突、幂等重放与冲突,以及 WebShell 失败投影携带 `failureCode`;store 层双向钉住后续 Turn 繁忙屏障(op 未关闭挡 Turn;完成后放行)与两面在终态失败后的释放。
- **E2E 计划**:`.qwen/e2e-tests/managed-workspace-w2-cwd-change.md`,先用全局 `qwen` CLI 基线做干跑(该路由今天未映射)。
- 构建、typecheck、bundle、两轮干净自审,然后 `/review`。

## 验收标准

- 202 接纳是持久的:Java 在任意窗口重启都经由原 operation 解决——完成至多被观察到一次,丢失响应按原 operation 标识重试。
- 指向缺失/别名目标目录的变更使 operation 失败(`failure_code=workspace_unavailable`),会话绑定与 revision 不变且仍可执行。
- 提交是原子的:提交前的读取看到旧的 `(cwd_relative, context_revision)` 对,之后看到新对;提交后的工具轮次获取在新的 Runtime Session 上恰好安装新绑定(store/传输层与端到端双重证明:Hosted IT 中变更后的绑定后续 Turn 只把文件写进已提交的目录)。
- 输入/cwd 竞态恰好接纳一侧(行锁串行化),每个可达方向均有钉:cwd vs cwd 恰接纳一侧;输入 Turn 活动时准入拒绝(`session_context_busy`);在途出现时由结算的提交复核拒绝;operation 未关闭时绑定后续 Turn 被拒(#13112 衔接)。
- 契约的 planned 路由与 schema 变为 implemented,无漂移测试或钉回归,现有生命周期/权限 operation 行为逐字节不变。

## 边界与后续

- **会话读取中的 `WorkspaceContext.state` 派生**(cwd operation 未关闭时为 `changing`),并重新审视其 `partial` 契约标注。
- **跨主机/容器部署的 worker 回执探针**(不占存储 claim 的关闭门安装),以及当未来切片能观察到部分安装时的 `recovery_blocked` 产生者。
- **可信目录变更的模型上下文**(Harness 对话说明),有待 Harness 的 context revision 契约。
- **该路由的 WebShell UI** 及任何能力通告;BFF 先留待消费。
- **跟踪台账**:#12380 快照中的 W2 行从"无对应实现 PR"更新为本 PR 及上述剩余边界;认领评论记录确切切片、负责人与排除项。

## 待决问题

1. 有读授权的非创建者如何拒绝:第一版按 404 处理(403 保留给租户过滤器的 `actor_scope_mismatch`),在已合入的绑定生命周期对同一 actor 形态采用 `403 session_operation_forbidden`(#13135 的 close、#13194 的 archive/delete)后重新打开,**并决定跟随兄弟语义**:无读授权 → 404 `session_not_found`,有读授权非创建者 → 403 `session_operation_forbidden`。两条路由描述都在各自的错误枚举中写明该码(WebShell 侧枚举自己的 camelCase 名单);提交时仍会复核完整授权集。
2. 同目录变更会递增 revision。无害,但评审可能更倾向 400;在此公开记录而非擅自决定。
