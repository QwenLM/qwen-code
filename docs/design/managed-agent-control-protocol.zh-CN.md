# Session / Harness / Runtime 私有协议

[English](managed-agent-control-protocol.md) | [简体中文](managed-agent-control-protocol.zh-CN.md)

更新日期：2026-09-23。原 2026-09-11 契约采用源码基线 `a8360814668b3dfdff72ad3d99cbcaf26dd009a9`，其约束继续保留。普通 HTTP/ACP/SDK 的旧接口与错误时机继续按[兼容方案](managed-agent-session-compatibility.md)适配。本文规定 [Harness](managed-agent-harness.md) 与 [coordinator](managed-agent-coordinator.md) 之间的消息、提交和原调用接管；不能仅因已有 Tool v2 就宣称 activation 隔离或跨 worker 重启恢复已通过验收。

| 参考                                                                                                                                                                          | 状态与用途                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [code_agent@1478e7b632eb237bc3f40ea574ce90782e1cf4c3](https://github.com/doudouOUC/code_agent/tree/1478e7b632eb237bc3f40ea574ce90782e1cf4c3/qwen-code/feature/managed-agents) | 固定补充设计源，不是实现或验证声明。                               |
| `bad721f22fcd8cfad9ec22e98f69fec75b20b6f0`                                                                                                                                    | draft 集成参考，不假定与本地工作树相同。                           |
| `f5088d2e`                                                                                                                                                                    | 本次核对的本地源码基线；已有组件不能证明补充 Hosted/ACL 保证成立。 |

本轮仅改文档。下述严格 Hosted profile 和动态撤权要求仍待实现、验收；本轮未运行真实环境验证或测试。补充第5项配额/计费排除，既有协议限额保留。强隔离运行时及租户信任选型暂缓，不默认租户可信。

## 1. 传输、版本与可信调用方

首版 Session authority 由 daemon 承载，Harness 使用受控 Session client。当前 in-memory ACP host 可以使用同进程适配器；跨进程时经已有私有 ACP 连接安装同一 typed dispatcher，不增加公网 Session RPC。两种适配执行相同验证与条件提交逻辑，同进程实现不能直接访问文件绕过契约。

设计中的 `managed-session/1` 与 `managed-runtime-control/1` 通过私有握手显式协商；名称和版本属于新协议设计，不冒充已有能力。普通调用者无权调用 grant、工具结算、writer 或 gate 操作。真实身份由已认证连接、workspace generation 和服务端绑定解析；请求里的 tenant/session/epoch 只用于一致性比较，不产生授权。

严格 owned Tool v2、InvocationContextV1 和 attestation v2 均不原地加字段。版本化 Runtime control envelope 可以嵌入不变的 v2 operation/payload，复用原 validator/native 方法。新增 storage/context/ACL 依据及跨主机 challenge 消息必须使用显式协商的控制 capability、封闭 schema 和成对 TS/Java 校验，不能把字段硬塞进 v2 payload 或 attestation。不支持的版本、capability 或旧 peer 在副作用前拒绝，不降级执行。已有 attestation 只证明其声明的身份，不证明当前产品 ACL 或进程退出。

已开启 activation 门禁的 binding 只能经受控 dispatcher 进入。Runtime 核心入口必须拒绝本地 raw client 或旧 v2 直连绕过。未开启增强的本地 legacy/实验 binding 保留旧协议，但这项兼容规则不是 Hosted fallback。

### 1.1 Hosted 安全边界（设计中，尚未实现）

严格 Hosted profile 在传输/工作负载身份及本地分区校验之外，还要求真实产品 ACL authority。Java 拥有产品 ACL、Workspace 与 Broker 事实；qwen 拥有模型 Session 历史/checkpoint；Runtime 生产物理执行证据。不引入第二套执行 authority、通用工作流服务或 MQ。

Harness 不挂 Workspace，也没有 Workspace 本地旁读路径。启动配置来自不可变 Bundle；compaction 附件来自已提交结果或已授权 Runtime 读取。Harness 自有状态仍经既定存储接口访问，不把 Runtime 路径解释为 Harness 本地路径。首版只可启用已验收的 Read/Write/Edit/foreground Shell；Hosted 明确拒绝 Legacy/auto-local fallback、未验收 Hooks、MCP、后台任务和 client callback，不能静默换位置执行。在更广的本地设计中注册能力不代表在 Hosted 中启用。

复用 [SecretHandle](managed-agent-config-extensions.md)：scope、purpose、audience、credentialGeneration、期限及当前授权均须匹配已认证消费者和原 binding/generation。handle 是引用而非 bearer 凭据，持有它或 tenantId 相同不能授权兑换。Runtime 不得获得模型/服务管理员凭据，也不得把自身服务身份继承给用户 Shell；无法满足凭据边界的工具保持关闭。详细运行环境约束和未解决的隔离证据由 [Endpoint 恢复 §17](2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md) 统一规定，本文不重复展开。

| 检查            | 必须有的接受路径                              | 必须有的拒绝路径                                               |
| --------------- | --------------------------------------------- | -------------------------------------------------------------- |
| 版本/capability | 协商一致的控制 schema，v2 payload 不变        | 旧 peer、额外 attestation 字段或 raw client 绕过在工作前拒绝   |
| Workspace/凭据  | 已授权 Runtime 读取及限定作用域的 handle 解析 | 拒绝 Harness 同路径旁读、handle 充当 bearer 或 Hosted fallback |

以上是后续验收条件，不是本轮结果。

## 2. 公共数据结构

精确编码、ChatRecord subtype/lock schema、事件字段分型及数值限额以[存储规范](managed-agent-session-storage.zh-CN.md)为准；配置、领域与平台契约从[全量覆盖表](managed-agent-full-design.md)索引。首版恢复范围不限制后续专项设计覆盖。

以下是字段契约；实现明确的 TypeScript discriminated union 与对应 validator，禁止以任意 JSON 代替已知记录类型。继续复用内容 union、模型历史、权限 DTO 和工具结果。

| 结构                | 必需字段与约束                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionKey`        | `tenantId, workspaceId, sessionId`；沿用服务端规范化身份，存储位置不依赖端口或 host 启动 ID                                                                                                                                                                                                 |
| `CommandMeta`       | `v:1, commandId, sessionKey`；写命令有稳定操作内容摘要，执行提交有 `expectedSequence`。连接 actor 不放入模型可改 payload                                                                                                                                                                    |
| `ActivationGrant`   | `activationId, epoch, workerId, subject, definitionRevision, leaseDurationMs, expiresAt, installationState`；绑定完整 SessionKey 与 workspace generation；authority 按 Session 单调颁发 epoch；状态 installing/active；交给 Harness 的 RunnableGrant 还须引用全部必要 enable ACK 的核对结果 |
| `CommitReceipt`     | `commandId, firstSequence, lastSequence, eventIds, duplicate`；逻辑提交后才 ACK；重复请求返回原位置，不造新事件                                                                                                                                                                             |
| `EventEnvelope`     | `v:1, sequence, eventId, sessionKey, kind, occurredAt, payload`；执行事实另含 turn/scope/activation；sequence 由 authority 分配，客户端不可覆盖                                                                                                                                             |
| `DurableRef`        | `resourceId, kind, schemaVersion, byteLength, digest`；由所属 Session 解析、授权、验证；不接受任意绝对路径、URL 或将回收的临时文件作为恢复引用                                                                                                                                              |
| `InvocationBinding` | 完整 `ManagedToolInvocationReference`、逻辑 session/turn/scope、稳定 `runtimeBindingId`、原 Runtime Session ID、lease/generation、媒体/权限快照摘要；工具参数不能改写                                                                                                                       |
| `ToolOutcomeRef`    | 按来源分型：runtime 含已接收 InvocationBinding/receipt；domain 含 action/Goal/Todo 等领域回执；orchestration 含注册编排结果或 child 结算引用。三者共享稳定 executionCallId、输入摘要、批次位置，不能伪造另一来源回执                                                                        |
| `WakeIntent`        | `wakeId, reason, subject, sourceEventId, requiredSequence`；reason 为 input/action_resolved/tool_settled/recovery；定时与子任务扩展按用途验收后启用；不授权重放副作用                                                                                                                       |

**v1 的 `tenantId` 仍固定为本地分区键，不是多租户能力。** 它由已解析 workspace 派生，用于身份规范化及路径/索引分区，不代表已认证租户主体，不承担隔离、配额、计费或跨租户授权。真实多租户平台仍在[全量覆盖表 §1](managed-agent-full-design.md)之外。既有“per-tenant 公平轮转/上限”在本地设计中退化为 workspace 级公平与上限；保留字段是为了避免将来改记录格式，不是租户隔离声明。禁止据此设计跨租户信任、配额或数据可见性；真实租户身份必须先有认证控制面并另行定义来源/校验契约。严格 Hosted profile 增加产品授权层，不把本地键或启动随机 UUID 重新解释为主体。

`ActivationSubject` 是封闭 union：`{kind:'turn',turnId}` 或 `{kind:'hook_operation',operationId,occurrenceId,event,phase,originTurnId?}`。旧 turn DTO 仍从前者投影原 turnId，不添加假用户轮次。WakeIntent 与执行事件携带同一 subject。无活 turn 的 prompt Hook 用后者，仍共享同 Session 单调 epoch、唯一模型推进者、Harness 槽位和模型预算；OperationGrant 本身不授予模型调用权。

hook-purpose claim 仅接受已持久 Hook occurrence 与固定 plan/input/model policy。关闭/删除封普通 activation 后，仅可领取原已受理维护操作内的生命周期 Hook activation，不能借此接新输入或启动主 Agent、工具/Goal/cron。复用 PromptHookRunner，提交 model.attempt 与 hook_execution 结果，以 hook_complete 释放，不生成 turn.settled 或任务完成通知。模型请求不明保留独立 attempt/费用不确定事实，不自动重放。writer、模型凭据及必要 Runtime 资源保留到 Hook phase 实际结算；无合法恢复能力明确 blocked，不能跳过 Hook。这项更广的本地契约不启用未验收 Hosted Hooks。

commandId 的幂等范围为 SessionKey + operation + commandId；同 ID 不同内容冲突。expectedSequence 是并发前置条件，不因重试换值形成新业务内容。同一已认证且当前仍有权的 actor 重复查询先返原提交，再考虑当前执行 fence/sequence；无历史命中才进入执行检查。所有读取包括重复回执仍检查当前读权限。旧 epoch 的已提交重复请求最多返原 receipt，不恢复推进权。

读取不要求 activation grant，但要求当前读取授权。Harness 不能伪造用户输入、最终审批票或原生结果；用户不能提交模型执行事实。跨 workspace、错 generation/scope、未知字段、不支持 schema 在副作用前拒绝。密钥、完整环境及认证 token 不进入日志、checkpoint 或错误详情。

## 3. Session 命令与读取

| 方法                                              | 允许 actor                             | 请求/响应与原子边界                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readRestore`                                     | 已授权所属入口或绑定 Harness           | 读取已提交 sequence 的 RestoreBundle：projection、checkpointRef、restoreBasis/restoreProofRef、tail、待处理命令；合法 null 组合按存储 §2.2，checkpoint 失败不降级为新建；旧 live replay 不等于模型恢复包                                                                            |
| `readEvents` / `subscribe`                        | 已授权客户端适配器/Harness/coordinator | `session-events/1` 有界 cursor；仅正式提交事件；snapshot→增量按序补齐，按 eventId 去重；过旧 cursor 明确重读                                                                                                                                                                        |
| `submitInput`                                     | 已认证且有权的入口/可信内部来源        | 规范化内容、稳定 turn/input ID、用途、期限；输入与 WakeIntent 一次逻辑提交；返回 CommitReceipt + turnId，不等模型完成                                                                                                                                                               |
| `appendExecution`                                 | 当前有效 activation 的 Harness         | typed 批次及 expectedSequence，仅限 `model.attempt`/`message.committed`/`tool.intent`/`context.compacted` 和 tool_call 来源的 `action.changed(requested)`；ToolOutcomeRef 引用已提交回执；物理工作区 tool.receipt 只经 acceptRuntimeReceipt，Harness 不改物理结果或用户票           |
| `commitCheckpoint`                                | 当前 activation 的 Harness             | 内容/ref、覆盖 sequence、上一 checkpoint、boundary；authority 校验引用/fence，coordinator 不代交；合法恢复起点首个 before_model 用 boundary=null，不释放或终结；turn_complete 校验终态并同事务提交 turn.settled/checkpoint 后才返 boundary receipt；durable_wait 必须有完整恢复状态 |
| `requestAction`                                   | 注册非工具确认适配器                   | CommandMeta、requestId、source、inputRevision、optionsRef、policyRevision、期限；source 限 automation_run/team_plan/user_operation；核验原操作及真实 Session 权限后 requested，遵守存储 §3 来源矩阵；返回原 CommitReceipt，不启动 Harness、不授决定权                               |
| `resolveAction`                                   | 原权限/用户问答仲裁入口                | requestId、action kind、原 invocation/input/policy 版本和合法结果；同决策幂等，冲突/迟到按原协议；最终决定提交后且当前授权仍成立才能推动调用                                                                                                                                        |
| `requestCancel`                                   | 已授权用户入口或受控生命周期 owner     | 精确 turn/scope/invocation 及原因；先持久再取消；区别于队列撤销、物理退出和最终 turn settlement                                                                                                                                                                                     |
| `claimActivation` / `renewActivation`             | coordinator/scheduler                  | 按候选状态条件领取/续租；初始 installing，核对门禁回执后才能发布有效 grant；同 Session 仅一个有效推进者                                                                                                                                                                             |
| `completeActivationInstall` / `releaseActivation` | coordinator                            | 前者提交全部安装证明；后者提交 waiting/turn_settled/hook_complete/blocked 原因与边界引用；释放不自动完成 turn                                                                                                                                                                       |
| `acceptRuntimeReceipt`                            | 原 binding 的可信 coordinator 收件入口 | 原 InvocationBinding、原生结果/进度终态、输出 refs、history revision；验证去重后追加；仅生命周期和当前授权允许推进时才生成 WakeIntent                                                                                                                                               |

不新增通用 `executeMethod(name, args)` 或绕过 actor 的任意 append API。领域可共用内部 transaction helper，不向用户/Harness 暴露无限写权。当前公共 Command union 没有案件命令。未来 [UNKNOWN 案件操作](managed-agent-recovery-operations.zh-CN.md#unknown-reconciliation)复用 operation/Action 授权、幂等和查询，但必须显式注册封闭 schema/capability，不能变成通用工具终态修改接口。

领域 payload 按注册的 domain/version 校验，唯一正式事件为 `domain.committed {domain,version,operationId,recordRef}`，recordRef 受控资源保存领域状态。对已提交 delivery outbox、配置安装、历史维护等，authority 核验原 operation revision、lifecycle、trust、资源范围后可签发 `OperationGrant {sessionKey,operationId,domain,operationRevision,ownerId,workspaceGeneration,resourceScope,leaseDurationMs,expiresAt}`。只允许原计划明确 phase，不授模型推进或任意新业务权，不是第二个 Session activation/epoch；模型首次意图仍需 ActivationGrant。

物理 OperationGrant 在所属 Runtime 安装独立 per-operation 单调 gate。安装/撤销按 operation revision 幂等，撤销同 revision 不重开；下一 revision 先封旧准入、核验原 phase。新操作受 maintenance barrier、共享容量及生命周期约束。原系统 status/cancel/结算资格不随模型 turn 结束而丢失，但不恢复撤权用户读权。effectId/effectRevision 固定一次性 phase 参数；operationRevision 仅控制 CAS/门禁；重领 grant 不换 phaseOperationId、不重跑 unknown。Channels 由持目标凭据的领域适配器发送，workspace 文件/命令仍进 Runtime。

无 Session 的 workspace Git/PR/目录管理使用 `WorkspaceOperationGrant {workspaceKey:{tenantId,workspaceId},workspaceGeneration,operationId,domain,operationRevision,ownerId,resourceScope,leaseDurationMs,expiresAt}`。**交付阶段为 R5 历史/维护 F7，不是 R2；R2 仍走已有 workspace 服务路径。** 只有两个版本维度：workspaceGeneration 选择有效工作区代，operationRevision 控制维护 CAS/门禁；不增加第三层，不与 Session activation epoch 换算。workspace 控制 owner 存意图/结果，Runtime 存物理回执，不捏造 Session、模型 activation 或 primary Session 归属。这些记录是无 Session 操作的权威，不复制 Session 事实。遵守相同 per-operation gate、共享预算、信任与维护 barrier；与 Session 写冲突时在声明范围内先拒绝或排空，不后台跨 owner 改文件。

可信工具定义与注册适配器决定结果来源，不接受 Harness 自报“本地成功”。AskUserQuestion 从 actionRequest/最终 decision 得答案，不伪造 Runtime prepare；Todo/Goal 变更要有领域提交；Agent/child 结算引用原 scope/result。不能持久接管的编排保持驻留或阻塞 detach。各类保留原 ToolResult/错误语义、稳定调用 ID；工作区工具不能经 orchestration 绕过 Runtime。

输入/正式模型消息、工具关联、取消/审批、等待及终态使用版本化 ChatRecord。多行逻辑事务用事务 ID、条数/摘要及最终 commit marker 决定可见性，读者只暴露完整提交。未知 subtype、不完整事务不得容错执行为旧会话；展示与严格恢复各自映射。交接物理 writer 前核验兼容 reader，旧 host 不直接追加新格式。

本地首版成功提交要求完整事务与文件同步，以及首次创建/必要生命周期变更时父目录同步；任一步失败不回成功 ACK。结合既有 writer/文件身份保护核验平台语义，不保证所有硬件故障下绝不丢失。存储失败先停推进，再严格查原 commandId 提交；已提交丢 ACK 返回原 receipt，损坏/不确定不补造完成。单机后端不承诺分布式事务。

## 4. Runtime 的 activation 门禁

Runtime lease 只证明原工具环境身份，现有 `ManagedToolCallIdentity` 不包含 Harness activation。新控制协议按以下步骤安装；coordinator 保留原 binding，Harness 自报更大 epoch 无效。

1. authority claim 创建 installing activation。coordinator 向全部相关 root/child binding 幂等发送 `stageGate`：封旧 activation 新派发，登记新 epoch，不开放执行。Runtime 在实际准入锁内返回 closed/installed 及已准入 invocation 清单。
2. 核对全部必要 ACK 后，authority 条件提交 completeActivationInstall。coordinator 持 grant 提交证明调用 `enableGate`，Runtime 确认新 epoch 生效后才给 Harness runnable grant。部分成功/丢 ACK 按原安装 ID 查询重试，不提前推进。
3. 首次惰性 Runtime 创建也先装门禁再开放工具。child binding 创建与 Session 激活/关闭串行，全量屏障后不能偷挂未受控 child。
4. 每次副作用准入重新验证 Session/scope、Runtime lease、activation、参数/能力/权限版本；覆盖 beginTurn、history bind/checkpoint、prepare/build、confirm、preflight/Hook、execute 及所有本地工作入口，不只 execute。只读 manifest/status 仍校验身份授权。
5. `revokeGate` 只封新工作，不取消已准入 invocation；coordinator 保留窄范围 status/cancel/settlement/history。已开始可能完成，gate ACK 不等于进程退出或物理结果。

Runtime 在 SessionKey + binding incarnation 内保留单调 gate revision、最大 epoch、撤销状态。stage/enable/renew/revoke 条件更新并幂等返原 ACK。enable 只能开启同安装 ID 未撤销 staged gate；renew 只延长仍 active 的同一 gate；撤销 epoch 不重开，stage 下一 epoch 后拒绝旧 epoch 迟到 enable/renew，重复查询不恢复权利。丢门禁状态则原 binding 判 lost 并拒绝工作，不得空状态重启后接受旧 grant。

expiry 来自 authority，Harness 不可延长；coordinator 续租先于 gate 续租。首版本地保留同主机计时与逐次期限检查；分区、超期或时间不可信停止新派发。跨主机采用[恢复专项的挑战时限](managed-agent-recovery-operations.zh-CN.md#trusted-control-timing)与原 binding 屏障；实现验收前不开放，不照搬本地时间假设。

Config 工厂随机 Runtime Session ID、文件历史 owner、执行引用 Map、未决 Promise 要移交 coordinator。新 Harness 通过持久 binding 查原 Runtime，不用新 factory UUID 充当恢复。Config shutdown 与 runTool finally 在可恢复 detach 时不得 terminal release 已转交调用。

<a id="dynamic-authorization"></a>

### 4.1 动态授权与撤权（设计中）

权限来自真实产品 ACL authority 及认证主体/资源关系，不来自 tenantId、随机 UUID 或本地分区键。policyRevision 绑定真实 ACL revision 和资源范围，不接受 actor 自报数字。输入或审批受理不构成永久执行授权。

| 权限变化                  | 必须行为                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有效 reader/read 权限撤销 | Java 停后续 SSE、历史、Range、export 和回执内容交付；已有流与新请求都重验。已发字节无法追回；任务主体若同时失去执行访问该资源资格，则封后续执行并请求取消。 |
| operator 撤销             | 阻断该主体排队 Prompt、未派发工具、后续模型推进，请求取消运行工作；保留独立有效 reader 权利。                                                               |
| 仅 owner/admin 降级       | 按剩余权利拒绝无权管理操作，不自动终止仍合法的普通任务。                                                                                                    |
| 审批资格撤销              | 派发前重验依赖该资格的批准；必要时通过原仲裁产生新请求，不覆写旧票；已派发事实不追溯改成未执行。                                                            |

1. Java 持久提交 ACL revision 后，按当前权限处理新请求、持续交付及 grant 续租。陈旧 ACL 缓存不得续出旧权利；凡开放 ACL 管理入口即须满足，不等公共管理 UI 上线。
2. Runtime revoke 与**最终 native 操作准入共用串行器**。核对最终参数、当前有效权限依据、gate、ContextBinding，持久记录 dispatch 再进入 native 工作。任何异步等待（审批、preflight、账本 I/O 等）后均在 native 入口前重验；await 前检查不是未来权利预留。
3. revoke 在准入顺序中先到则不得新派发；准入先到则保留原 ID 取消/结算。dispatch 已持久后，崩溃或交接中断即使无法确认 native 已进入也可能 UNKNOWN，不推定 not_started。串行区不得在仍有未经复验 continuation 能进入 native 时确认撤权屏障完成。
4. 数据库 ACL 检查后发 RPC 不是分布式原子事务。通过既有受控记录分别报告下列事实，绑定原 operation/binding/generation、revision、证据引用及审计时间。

| 对外事实          | 含义                                                                                             | 不能证明                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `ACL committed`   | 产品 authority 已持久提交新权限                                                                  | 全部 Runtime 已封门禁或全部进程已停                           |
| `dispatch fenced` | 全部相关原 gate 已确认关闭，或有效失效证据证明准入资格到期                                       | 已准入进程退出、外部效果回滚或 Workspace 可交接               |
| `process stopped` | 原可信 process owner/监督者证明声明范围内退出；storage/node fencing 另记隔离证据，不伪造进程退出 | 单凭此事实不能证明物理结果、history 结算或 Workspace 占用释放 |

采用既有 **60秒 lease / 20秒 renew / 10秒 challenge control deadline**，遵守[可信计时](managed-agent-recovery-operations.zh-CN.md#trusted-control-timing)。无陈旧 ACL 续租且计时已验证包含挂起/恢复风险时，离线旧权限新派发窗口不超过原 gate 剩余期限，最多60秒；迟到响应不重新起满额 lease。这不是即时撤权或进程停止 SLA。没有屏障/有效失效证据时，执行撤权仍报 pending/unknown，不报完成；grant 到期绝不释放物理 Workspace 卷。

系统查询、原 ID 取消、回执收件及资源结算只保留原操作和 purpose/scope 绑定窄资格，不授新 prepare/execute、模型调用或撤权用户内容访问权，包括重复回执读取与导出。已关闭/删除 Session 可以收可信迟到回执用于记账/清理，但不产生模型唤醒。停止与 Workspace 交接仍分离，见[工具与历史](managed-agent-tools-history.zh-CN.md)及[恢复案件](managed-agent-recovery-operations.zh-CN.md#unknown-reconciliation)。

| 检查          | 必须有的接受路径                                           | 必须有的拒绝路径                                              |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| ACL/角色      | operator 撤销后独立 reader 可读；仅降 admin 不影响合法任务 | reader 撤销后无后续流/Range/export/回执字节交付               |
| 竞态/审批     | 派发先到按原 ID 取消/结算；当前有效审批正常执行            | revoke 先到、陈旧审批或异步旧 continuation 不进 native        |
| 离线/迟到     | 有效未过期依据仅用剩余窗口；保留原迟到回执                 | 迟到续租、陈旧 ACL、不可信计时、已撤 epoch 不延权；到期不解卷 |
| 关闭/系统资格 | 关闭后限权系统结算成功但不唤醒模型                         | 系统恢复资格不恢复用户读/执行权                               |

矩阵是未来正反验收条件，本轮均未执行。

## 5. 回执、资源和恢复保证

| 场景                                        | 首版保证与边界                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness 替换，coordinator 与原 Runtime 存活 | 按原 invocation/status 取结果，结果/持久资源提交 Session 且当前授权允许后才推进模型；不重发 execute、不取消已转交工作                                                |
| 工具完成但 Session ACK 丢失                 | 原 digest/commandId 查询重交付得到同 receipt，保留成功及原 toolUseId/Hook 结果，不重跑工具/Hook                                                                      |
| 原 worker 丢失，Session 已持久接受结果      | 恢复 Session 已提交结果，不依赖 worker Map 或临时目录                                                                                                                |
| 原 worker/daemon 丢失，副作用未决           | 缺失/404/Map 空/IPC 断开不证明未执行，保持 recovery_blocked；新接口本身不保证重建进程或跨 worker 自动续跑                                                            |
| 全量 worker 重启后结果恢复                  | 需[恢复专项](managed-agent-recovery-operations.zh-CN.md)独立持久 RuntimeReceiptStore、phase 账本及旧 owner 核验；started 无终态仍未知，不承诺外部副作用 exactly-once |

精确交付保证是：**原 coordinator 与 Runtime binding 存活范围内，一个 invocation 至多派发一次，已派发结果按原引用幂等取回。** 不等于外部副作用 exactly-once。稳定 executionCallId、门禁、回执去重可以证明派发次数；协议无法观测外部效果是否发生、发生几次（网络发送、Channels 交付、非幂等远端 API），所以 started 无终态保持未知。Harness H04 指前者，本表指后者，不冲突；不得将 at-most-once 派发写成 exactly-once 副作用。

首版先分离可恢复 Harness；worker 重启未决仍保守拒绝。“worker 丢失不丢 Session”不代表所有操作可重放。原 worker 生命周期在父 IPC 丢失后退出，activator 退出后清 outputRoot，daemon 重启不得假定仍可接管 worker。更新 provider 的专用接管只限其独立实现验收的 profile。

按引用保留：Session 接受结果、接收必要媒体/备份并提交关联 checkpoint 前，不主动删除/terminal release 原 Runtime 结果或唯一输出。之后仍有未结算 child/wait 引用则继续保留。Session receipt ID/digest/引用随可恢复历史保留，Runtime cache TTL 不删幂等依据。首版不新增自动 TTL 清未决记录；删除/归档仍遵守维护规则。

原父 owner 产生 history revision。coordinator 先持久提交 snapshot/ref，再推进已接收 revision；失败不更新内存镜像为成功。清理可读原 history，不推进新 checkpoint。原生回执可带候选资源，authority 确认持久引用可读后才 ACK；Runtime 绝对路径不是 Harness 本地路径。

## 6. 错误、限额与取消时序

内部错误使用有界 `{code, message, retryable, commandId?, currentSequence?, recoveryRef?}`，不含栈、密钥、任意文件内容。首版类别为 unsupported_version/capability、invalid_payload、scope_mismatch、idempotency_conflict、sequence_conflict、stale_activation、runtime_unavailable、storage_unavailable、recovery_blocked、resource_limit；适配器保留旧外部错误及同步/异步时机。

sequence_conflict 重读后核对同业务 ID，不自动重做副作用；stale_activation 停推进；storage_unavailable 先查提交；Runtime unknown 保持恢复阻塞。retryable 只允许协议查询或同 ID 命令重试，不授工具重执行权。

Session control 请求、分页、事件批次须有字节/条数/深度限制，并在初始握手公布。复用已有内容协议限额/预算，新增 envelope 开销单计，不扩大工具/媒体/文件历史预算。大 checkpoint/模型历史/输出用 DurableRef 和有界分页，不截断后声称可恢复。数值及兼容性见[存储 §5](managed-agent-session-storage.zh-CN.md)，须落实 validator/预算检查，不做无人消费的 limits 开关；超限不返成功 ACK。保留这些协议/资源限额不代表加入排除的配额/计费专项。

用户 cancel、lease loss、transport EOF、deadline、Harness detach、Session close 使用不同 reason。cancel ACK 仅表示请求提交；模型未提交 delta 不进入正式历史，工具迟到成功保留成功 receipt。deadline 可结束客户端等待，未决执行和不安全后续屏障仍保留，详见兼容方案。新模型 attempt 有独立 ID，不承诺精确续流或单次计费。

## 7. 协议验收与实现门槛

| 编号 | 必须验证                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01  | 同进程与私有 ACP client 对非法字段、actor、sequence、重复 ID 一致；保留旧公开 DTO、同步 throw、optional Bridge                                                                    |
| P02  | 每行事务、commit marker、文件/目录同步和 ACK 前后中断；仅完整提交可见，重启无重复输入/终态，不改旧用户文件                                                                        |
| P03  | stage/enable/revoke 丢 ACK、部分 child 安装、撤后迟到 enable/renew、下一 epoch 后旧请求、旧 v2 raw 绕过；未授权 beginTurn/prepare/confirm/preflight/checkpoint/execute 均无副作用 |
| P04  | Runtime 完成/Session 接受/资源转存/checkpoint 各窗口丢 ACK；原引用恢复，不重跑工具/Hook，不提前删唯一资源                                                                         |
| P05  | 区分杀 Harness 与 worker/daemon；前者可接管，后者未决则 blocked；当前授权下原已提交结果仍可读                                                                                     |
| P06  | cursor 过期、批次/媒体/深度超限、坏 digest、跨 Session ref；不静默截断恢复状态、不越权读                                                                                          |

本文与存储规范确定命令族、字段分型、限额、可见性、安装屏障及恢复范围。R2.S1/S2/S3 须有编译通过 schema/validator、成对生产消费接线，再取得平台同步、崩溃及进程证据；设计决定不代表已通过。OperationGrant、跨 worker 回执、remote profile 分阶段实现验收。§1.1、§4.1 新增矩阵同样是未来门槛，本轮文档修改既未实现也未验证。
