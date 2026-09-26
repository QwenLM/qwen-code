# Managed Runtime：持久回执、平台与运行验收

[English](managed-agent-recovery-operations.md) | [简体中文](managed-agent-recovery-operations.zh-CN.md)

更新日期：2026-09-23。原 2026-09-10 设计采用源码基线 `a836081466`；其 worker/daemon 重启、远端执行、平台及容量约束继续保留。本文配合[存储契约](managed-agent-session-storage.zh-CN.md)、[私有门禁](managed-agent-control-protocol.zh-CN.md)及 [coordinator](managed-agent-coordinator.md)。首版恢复覆盖原 coordinator/worker 存活时替换 Harness，扩展保证需要各自实现与证据。

| 参考                                                                                                                                                                          | 状态与用途                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [code_agent@1478e7b632eb237bc3f40ea574ce90782e1cf4c3](https://github.com/doudouOUC/code_agent/tree/1478e7b632eb237bc3f40ea574ce90782e1cf4c3/qwen-code/feature/managed-agents) | 固定补充设计源，不是实现或验证声明。                |
| `bad721f22fcd8cfad9ec22e98f69fec75b20b6f0`                                                                                                                                    | draft 集成参考，不假定全部合入或与本地文件一致。    |
| `f5088d2e`                                                                                                                                                                    | 本次核对的本地实现基线；§1、§3.1 标明具体恢复差距。 |

本轮只改文档，不改代码、schema、配置、计划、部署或远程，不运行真实验证或测试。下述 UNKNOWN 案件生命周期、证据化收紧、离线只读分离、可信计时/Hosted 保证仍是待实现要求。补充第5项配额/计费排除，原容量及性能契约保留。强隔离与租户信任选型暂缓，不默认租户可信。

## 1. 当前事实与选定后端

原基线的 ManagedToolRuntime invocation/started prompt 在内存中，最多 1024 个 invocation、1 MiB 进度；worker 在父 IPC 丢失后退出，activator 清理 outputRoot。此类 status/Map 不能证明跨 worker 重启执行结论。参数、确认、Hook、history bind/checkpoint 都可能产生工作，不能只记录 execute。本地 `f5088d2e` 还已有持久 Broker 执行记录及 provider 专用恢复（见 [Endpoint 恢复](2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md)），但不等于通用逐 phase Runtime 账本，也不证明所有未决效果。不能把原“内存状态”观察扩写成当前全部 Broker 状态均不持久。

全量设计新增 `RuntimeReceiptStore`，由原执行环境持有，在可信 runtimeBaseDir 下 `managed-runtime/receipts/<bindingId>/`，不放临时 outputRoot，由 binding owner 独占写。它只记录物理调用事实，不成为 Session/turn 第二权威。所有资源保留原 invocation、phase、digest、retention pin。authority acceptance ACK 存为交付收件证明：Session scope 使用 CommitReceipt；无 Session workspace scope 使用工作区控制 receipt。

Runtime 生命周期分 worker（执行/服务）、持久 receipt store（历史）、process owner（实际命令）。默认本地 daemon 重启可停止 worker，结果仍从 receipt store 读；保全已完成结果不要求旧 worker 活着。真正保活的环境按下述认证 attach 接管，旧进程存活须实际核验。

## 2. 操作账本与恢复分类

工具 phase 使用稳定 `phaseOperationId=(InvocationBinding, phase, effectRevision)`；内容摘要包含原 args/capability/policy/media/Hook revision。effectRevision 冻结效果输入，不是重领 gate 的 operationRevision。工具顶层 phase 限 begin_turn/history_bind/checkpoint/prepare/confirm/pre_hook/execute/post_hook/model_bridge/result_publish。模型 bridge 的模型事实由 Harness 提交，Runtime 仅记录请求/答复接受。

| 持久记录             | 内容与写入时机                                                                         | 崩溃后的解释                                                                           |
| -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| intent               | phaseOperationId、input ref、原 lease/generation、gate revision                        | 任何可能 phase 效果前同步；仅 intent 无 dispatch 且有完整账本/owner 证据才可证明未开始 |
| dispatch_started     | 原生开始标记、process owner ref 或本地执行序号                                         | 可能产生效果的 native 入口前同步；记录后实际开始前崩溃仍 unknown，不推定未执行         |
| phase_settled        | native status、原错误/Hook 结果、输出/备份 refs、实际进程结算证明                      | 先保全资源/结果再同步；可幂等重交付，不重跑 phase                                      |
| accepted             | 按 scope 的 Session CommitReceipt 或工作区控制 receipt、已接收资源/父 history revision | 单独保存，丢 ACK 查原 Session；接收一个结果不释放仍有 child 的整个 binding             |
| released / tombstone | 已结算 phase、最终资源 pin、关闭原因、owner 证明                                       | 引用闭包安全才 release；调用 ID/输入摘要留在 Session 可恢复历史，不因 cache TTL 重用   |

接口为 `recordIntent`、`markDispatched`、`commitPhysicalResult`、`readOriginal`、`ackAccepted`、`releasePins`、`sealBinding`。ackAccepted 核验原 scope、收件者和 receipt 类型，Session/工作区回执不能混用。readOriginal 返回封闭 union：`not_started_proven`（完整前缀与原 owner 隔离证明）、`running_attached`、`settled`、`unknown`、`corrupt`。404、Map 空、日志缺失绝不等于 not_started_proven。账本 accepted 是持久交付收件，不是 §3.1 的业务结案原因 accepted_unresolved。

模型外维护/领域发送使用 [OperationGrant](managed-agent-control-protocol.zh-CN.md)，物理 key 为 `(SessionKey,effectId,phase,effectRevision)`，不虚构 ManagedToolInvocationReference。重领不换 phaseOperationId；已持久效果只重交付，未知不重跑。Runtime 账本和外部 I/O 领域发送器共用 intent/dispatch/settled 分类，各自保留实际 owner。

无 Session 工作区维护用 WorkspaceOperationGrant，物理 key 为 `(WorkspaceKey,generation,effectId,phase,effectRevision)`。workspace 控制 owner 持久化操作元数据并拥有恢复入口，不造假 Session 日志。与 Session operation 共用 scope 分型账本、限额、pin、撤权规则；读者不能混 key。

prepare/build、确认和 Hook 遵守相同 phase 规则，不能用一个“工具执行过”布尔值表示所有阶段。改参要新 revision，旧确认不批准新参数。结果保留原 toolUseId、缓存更新、Hook 事实。重复 pre/post Hook 默认只查询；远端无幂等能力时不自动补跑 unknown。

### 领域 phase 的注册与身份

工具顶层枚举不限制无工具领域调用。domain/version 选择固定 phase schema；Runtime/领域发送器仅接受注册 phase 及输入类型，不允许任意字符串。领域 `effectId` 标识真实单次效果（hookExecutionId、delivery segmentId、MCP request operationId、维护步骤 ID），可反查父 operationId。`effectRevision` 固定参数/目标/前置证明，`operationRevision` 控制 authority CAS/gate 领取；重领不改变 effectId/effectRevision。改参必须有明确新效果意图，不覆盖未知原效果。

| 注册域                                    | v1 phase 与结果                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| config_install / workspace_initialization | source_read（只读）、stage_view、install_view、enable_view、retire_view；初始化固定 filesystem/registry/context/curator/watch component 分型，每项有原 config/root revision 和完整 receipt             |
| skill_activation                          | args_write、args_clear；正文/permission/Hook/model selector 逻辑事实走 Session domain，不伪造 Runtime phase                                                                                            |
| mcp_configuration / mcp_operation         | connect、discover_tools、discover_resources、discover_prompts、resource_read、prompt_get、subscribe、unsubscribe、disconnect；tool_call 仍是工具 invoke execute，transport 重建不换原请求 ID           |
| hook_execution                            | command、http、prompt_bridge、registered_handler；固定 hookExecutionId/ordinal/inputRevision，合资格 Harness 提交模型事实                                                                              |
| channel_delivery                          | send_segment、edit_segment、query_receipt、revoke_message；adapter 不支持则拒绝，不用重发代替查询                                                                                                      |
| child_run / memory_job                    | launch、attach、cancel、drain；memory scaffold、write、index、cursor、metadata 单独记结果，工具写仍引用原 invocation，不重复派发                                                                       |
| 历史/产物/工作区维护                      | prepare_backup、stage_file、apply_file、undo_file、copy_resource、publish_manifest、delete_owned、git_command、publish_artifact；已提交计划的封闭 action union 固定路径/步骤，按文件/分段稳定 effectId |

纯逻辑 schedule/Goal/parent acceptance 不造物理 phase；派发 child/工具/发送器时引用原效果 ID。混合阶段是 `execute` 下声明的 segment（例如 fetch/model_bridge/file_publish），有独立 effectId/输入摘要，汇总成一个原 tool receipt。新工具版本须注册封闭 stage schema，Harness 不得自报阶段绕过实际 owner。这项保留的全量领域设计不启用未验收 Hosted Hooks/MCP/后台工作，仍受[控制 profile 限制](managed-agent-control-protocol.zh-CN.md)。

## 3. 重启和接管流程

1. daemon 启动取得 authority writer，读取未结算 binding/phase/原 process refs，暂停相应 Session 新 activation；扫描完成前不启动 cron/Goal/通知。
2. 原 worker 仍服务时，认证 endpoint、binding incarnation、lease、cwd/root/config 摘要、私有 capability，安装 gate 高水位，接管原 status/cancel/结果；旧端口或 PID 不足以授权 attach。
3. worker 已退出时，新 reader 只开原 receipt store，核验独占/封存、资源完整性；settled 重交付 Session。仅无 dispatch 且有完整未开始证明的 phase 才可在之后获得独立授权的受控派发，查询本身绝不派发；started 无终态保持 unknown。
4. 工具专用 reconciler 可核验原文件前像/后像、备份、持久事务阶段，只返回有证据的成功/未开始/可修复；文件存在不能证明任意 Shell 成功。修复是另行授权效果，不是读取的隐蔽副作用。
5. 外部 API/MCP/Shell 等非事务结果不明提交 recovery_blocked。有当前权限的用户可查询/取消原工作、导出诊断、关闭待处理 Session 或显式另开任务。“重跑”用新命令/调用 ID，并提示原未知操作仍可能生效；不得绕过旧卷屏障。人工确认不能把原成功/未知覆盖为未执行。
6. 结算和资源恢复先于模型下一步，且仍要求当前授权和开放生命周期。迟到结果始终核验原 binding；同 cwd 的新 worker 不替换原结果归属。

新进程启动不证明旧进程停止。未知工作保留持久风险，已证退出 worker 不永久占活进程槽。容量与未决事实分开计数，两者均不释放 Workspace 占用。管理员移除 workspace 不在受控保留/删除生命周期之外删除原受限收件/恢复记录。

<a id="unknown-reconciliation"></a>

### 3.1 UNKNOWN 对账案件（设计中，尚未实现）

保持三个独立维度：

| 维度      | 权威与允许变化                                                                          | 禁止推导                              |
| --------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| 物理执行  | 原可信回执或合格 reconciler 可补充 UNKNOWN 的确定结论，保留既有观察                     | 人工选择、超时、结案或删 Pod 不是结果 |
| 业务案件  | Java 记录 `OPEN → INVESTIGATING → CLOSED`，结案原因 `verified` 或 `accepted_unresolved` | 两者不是物理状态，不自动转 SETTLED    |
| 资源/恢复 | 独立核验进程停止/隔离、结果/history 交付及 Workspace 占用                               | 结案不释放 pin/卷，不授权原模型继续   |

`accepted_unresolved` 只表示接受未决业务风险：物理状态仍 **UNKNOWN**，绝不 SETTLED；不生成 success/error/not_started 工具结果、不解锁 Workspace、不继续原模型上下文。显式新任务仍遵守原物理卷屏障。`verified` 也仅是结案原因：物理结论必须先独立通过证据验证及原回执收件，之后合法继续还需 lifecycle/ACL、结果/history/checkpoint 和资源门槛；结案本身不推进任何一项。发生冲突可经审计 CAS 从 CLOSED 重开到 INVESTIGATING，并保留结案历史。

**证据绑定与验证。** case 绑定原 executionCallId/invocation、phaseOperationId/phase/effectRevision、args/input digest、runtimeBindingId/incarnation、lease、workspace/runtime generation、原 operation/scope。保存不可变证据引用和内容摘要、验证器身份及规则版本、材料提交者和有权验证 actor、case/CAS revision、验证决定/原因及审计时间。配置的验证器必须核验原 owner 来源、完整身份/输入匹配、完整性与内容校验，以及注册的工具/phase 专属规则。模型或上传者不能任挑验证器或设置物理结果。人工备注、截图、上传只是未验证材料，不是证明；owner/admin 上传的原始诊断也不会自动可信。

`not_started_proven` 要求截至对应封存/准入边界的完整已验证账本前缀，证明原 phase 无 dispatch，**并有旧 owner 被隔离、不能再产生效果的证明**。缺行、部分/恢复日志、Map 空、超时、404、Pod 退出或文件存在都不足够。dispatch_started 无终态即使进程后来停止也仍未知；停止/隔离不证明外部效果从未发生。

**授权与提交。** 基于真实产品 ACL 分别授权案件创建/调查/关闭/风险接受、证据验证、原 ID 取消和原始诊断读取。owner/admin 不自动成为物理结果认证者。默认诊断脱敏，回执内容及导出遵守当前读权限。复用 operation/Action 的授权、幂等、查询、受控领域记录，通过 case revision 条件更新并保留审计；不跨 Runtime RPC 持 DB 事务，不建立平行执行账本。当前公共 Command union 没有 case 命令；未来封闭 schema/capability 必须显式注册允许的操作/状态转换及生产消费校验，不允许任意 JSON、任意 append 或人工改工具终态。

**迟到证据。** 相同原身份及结果 digest 幂等返回原 acceptance receipt，包括业务结案后。同一原效果出现不同 digest 或相互矛盾证据时，两份不可变候选及来源都保存，记录冲突并 blocked，不使用最后写入覆盖。错 binding/generation 不能结算原调用。有权调查可以重开 case，不能抹原事实。关闭/删除 Session 仍可经受限系统入口接收原可信结果用于记账/清理，但迟到不得唤醒模型或恢复撤权用户读权，见[动态授权](managed-agent-control-protocol.zh-CN.md#dynamic-authorization)。

**原执行查询/取消。** 目标查询路径必须可离线读取原持久 execution/phase 账本，不依赖存活 Runtime Session，并明确返回 unknown/corrupt/incomplete。它是只读：不得为回答查询创建/provision Runtime、重新获取 Workspace 写占用、重跑 prepare 或调用 execute。可选在线观察只联系认证后的原 owner，只用只读 status 入口。取消请求持久绑定同一原 executionCallId/phase/binding/generation；原 owner 可达才发送原 ID cancel，否则保留 pending/unknown，不报取消成功。取消不创建 replacement Runtime 或新执行。存储不可用则阻塞观察，不构造空的成功快照；回执接收是单独授权写，不是查询副作用。

**本地实现差距，不是已修复。** `f5088d2e` 的 [RuntimeBrokerService](../../packages/sdk-java/runtime-broker/src/main/java/com/alibaba/qwen/code/runtimebroker/RuntimeBrokerService.java) 提供 `resolveUnknownExecution`：`CONFIRMED_NOT_EXECUTED` 构造 not_started 结果，另一枚举路径构造带 accepted_unknown 的 error，再交 repository resolution；[执行记录](../../packages/sdk-java/runtime-broker/src/main/java/com/alibaba/qwen/code/runtimebroker/ToolExecutionRecord.java)允许结算为 SETTLED。这条人工枚举路径要在未来实现中收紧，不包装成通用运维成功接口。当前 getExecution/cancelExecution 经 requireExecution，后者拒绝 UNKNOWN，依赖 requireSession/execution.start；上述持久离线只读/取消分离是目标，不声称当前已实现。本轮不改这些方法或 schema。

| 检查          | 必须有的接受路径                                                   | 必须有的拒绝路径                                                                |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 证据          | 原认证终态回执或注册 reconciler 证据可形成其范围内物理结论         | 人工上传/admin 选择、错 digest/binding/generation、不完整前缀、404 不证明未开始 |
| 结案          | 有权 accepted_unresolved 只结业务案件，verified 结案在证据验证之后 | 两种结案均不自行生成结果、SETTLED、解卷或原模型继续                             |
| 迟到回执      | 原 ID/digest 一致返原 receipt；合法迟到结果仍可供授权系统结算      | 冲突双方保留并 blocked，不结新 generation，不唤醒已关闭 Session                 |
| 离线查询/取消 | Runtime 离线仍可读原持久记录，可达原工作收到原 ID cancel           | 不 provision/prepare/execute，不向撤权用户开放诊断；不可达取消不宣称已停        |

这些是未来正反验收用例，本轮未运行测试或真实对账。

## 4. 原进程所有权与平台

`ProcessOwnerRef` 包含 backend、hostId、boot/incarnation、ownerId、PID+startIdentity、scope、执行 phase、原生句柄/组身份摘要；PID 单独不是取消目标。接口 `spawnOwned`、`cancelOwned`、`inspectOwned`、`waitExited`；结果区分 exited/no_effect_proven/running/unknown/unsupported。

| 平台/profile   | 目标后端                                                                                                                | 允许保证                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| macOS 本地     | 保留 detached 进程组、PID 开始身份、组观测；原生工具共用 owned-command                                                  | 仅证明观测到所属组退出；ps 失败、PID 复用、脱离组不明保持 unknown，不是恶意进程沙箱                                 |
| Linux 普通本地 | 同进程组后端；有委派权限时用 cgroup v2 owner，后代启动即入组                                                            | cgroup.kill 后验证 cgroup.events populated=0 及实际输出关闭；无权限保留明确进程组 profile，不宣称 cgroup 隔离       |
| Windows 本地   | 受控 native launcher：CreateProcess 挂起→加入禁止 breakaway 的 Job Object→登记 owner→恢复；Job 取消、实际成员及管道核验 | KILL_ON_JOB_CLOSE，不只靠 Node AbortError/根 PID；Job 分配/嵌套失败在恢复前拒绝，helper 未安装/未验收仍 unsupported |
| 远端/容器      | 环境 worker 提供同等 receipt/gate/process owner 能力并声明 backend                                                      | 只承诺有证据 profile，容器不自动证明本地文件持久或外部请求已撤                                                      |

Windows 方案基于 Job 归属/关闭语义。通知可能丢失，须结合查询与管道关闭，不能只等一条通知；部分外部建进程方式不自动入 Job，须专用适配或 unsupported。[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。

Linux 使用内核层级存活计数及终止接口；首版 Managed 不要求普通用户取得管理员权限。[Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)。

首版存储 profile 为可验证文件身份及文件/目录同步的本地文件系统。macOS/Linux 围绕原 writer 加强事务验证。Windows 采用待实现 native `openIdentity/flushFile/publishNoReplace/replaceOwned/verifySealed`：卷/文件 ID、独占句柄核身份，staging/目标同卷，完整写入后 FlushFileBuffers；MoveFileExW 带 WRITE_THROUGH 发布，no-replace 不设 REPLACE_EXISTING；受控替换持原锁并查旧目标身份。不得跨卷 COPY_ALLOWED 模拟原子提交。目录项/重命名耐久性须在实际 NTFS 配置取得故障证据，flag 不证明任意设备断电安全；不满足则强耐久 profile 整体 unsupported，不降 ACK 语义。网络盘、FUSE、缺 identity/sync 的挂载拒绝该 profile，不按平台名猜保证。

Windows flush/move 按 native API 能力使用，身份/发布适配仍须实现及故障核验。[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)、[MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)。

### 4.1 停止证明不等于 Workspace 释放

保留原 process owner/cgroup/receipt 机制，不换成“Pod 已删”布尔值。目标 Linux/Kubernetes、Session 独占 Runtime Pod 和 CSI Workspace profile 中，Pod API delete 成功、force-delete、NotReady、lease 到期、VolumeAttachment 消失**单独均不证明旧 writer 已停止**，见 [Kubernetes 强制终止](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination-forced)。新 DB epoch 或同 cwd 的另一 Pod 不会停止旧 Shell 后代。

正常交接须有原进程/cgroup 退出与输出关闭的可信证据、结果/资源收件、history/checkpoint 结算，再正常卸载和完成必要存储交接后才能 CAS 释放/转授 Workspace 占用。停止证据单独不结算外部效果、不解卷。分区时保留原 holder 与 blocked，除非可信原节点物理 fencing 或后端可靠撤销旧写通道证明隔离；此后仍核验卷/history 才转授。隔离证据另报作用域，不伪造成进程退出。占用 lease 用来协调控制者，不是物理卷自动释放计时器。身份及交接详见[工具与历史](managed-agent-tools-history.zh-CN.md)，备份/保留/删除详见[存储](managed-agent-session-storage.zh-CN.md)，运行环境加固详见 [Endpoint 恢复 §17](2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md)。

| 检查     | 必须有的接受路径                                                     | 必须有的拒绝路径                                               |
| -------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| 正常交接 | 原 cgroup/owner 退出、输出关闭、history/资源收件、卸载核验后条件转授 | 单凭 Pod API delete 或 lease 到期不能释放占用                  |
| 分区     | 旧写通道隔离证明及后续卷/history 核验仅允许证据覆盖的交接            | 旧 writer 不明保留 holder/blocked，停止证明不把 UNKNOWN 变成功 |

这是未来平台验收条件，不是真实集群结果。

## 5. 远端协议与凭据

**交付阶段：** 原 daemon 路线中 remote Runtime/跨主机 challenge 仍属 R5/F8，不是本地默认切换前置。R2～R4 用本地 profile；未启 remote provider 时不装配此握手，缺少它不影响本地准入/恢复。本文使本地 gate 时窗/身份兼容后续跨主机，不暗扩本地交付范围；补充 Hosted 目标须独立满足严格门槛后才开放。

复用 RemoteManagedRuntimeProvider 可信 endpoint/token 入口并新增私有 capability 协商，不给模型地址。endpoint 由服务端配置绑定，禁止带凭据跨 origin 重定向；默认 TLS 校验，HTTP 仅明确 loopback/受控开发配置。参数、Hook 输出、网页内容不能更换 endpoint、tenant、凭据。复用[控制协议](managed-agent-control-protocol.zh-CN.md)的 SecretHandle 作用域和 Hosted 限制；本地 tenant 分区不等于产品 ACL 身份。

跨主机 gate 不直接比两边墙钟。Runtime 生成一次性 install/renew challenge，**创建时**启动本地单调倒计时；authority 按 challenge 条件提交 grant/renewal，经认证私有连接返回 challengeId/runtimeIncarnation/SessionKey/grantRevision/commitDigest。Runtime 核身份及剩余窗口后 enable/renew，迟到不能从接收时重起期限。下一 epoch 仍须原 Runtime revoke/stage 屏障，联系不上不派新工作；到期本身不结束旧效果。同 challenge 重复只返原 ACK，binding 重启旧 challenge 失效；authority/Runtime 单调版本共同约束资格。

本地保留60秒 lease/20秒 renew；远端同上限扣除 challenge 已消耗时间。10秒 control deadline 未完成 challenge 则失效重申请，renew 不重开已撤 epoch。分区可停新派发并限权收原结果，不换 Runtime 重跑。challenge 消息须版本化 control envelope/capability 协商，Tool v2、InvocationContextV1、attestation v2 不变，旧 peer 拒绝，不往严格 attestation 塞 challenge。

既有同进程 Session client 与完整 Harness 仍适用。未来独立 authority 后端须有同等 CAS、单 writer、幂等及持久 ACK；两个 authority 不得各用本地文件授同一 Session。Kubernetes/VM 模板、调度产品、SaaS 多租户平台仍不属原 daemon 替换交付，适配器须实现已声明接口。Hosted 补充定义验收义务，不宣称部署或生产多租户安全已完成。

<a id="trusted-control-timing"></a>

### 5.1 可信控制计时与离线撤权

60/20/10 是准入上限及续租/期限配置，不是进程终止保证。严格 profile 须证明与 Runtime incarnation 绑定的可信经过时间，覆盖 suspend/resume、VM 暂停、时钟回拨、重启。使用已验证包含挂起时间的单调时源，或无法确定经过时间时在任何恢复后准入之前失效 gate。仅使用墙钟、Node timer、挂起时暂停的单调钟不是证据。异步等待后在实际 native 准入重验剩余时限及当前 gate/权限依据；timer 回调晚执行不延长资格。计时/gate 状态丢失则失败关闭。

challenge 响应只能使用其原始最多60秒窗口的剩余部分；10秒 challenge deadline 在接受响应时核验，不能只依赖 timeout 回调。20秒 renew 节奏不授权跨过已过期 lease。新 challenge 不复活已撤 epoch、不丢已 staged 高水位；成功续租须真实当前 ACL authority、匹配原 binding/generation、仍合法 gate。

**有条件离线上界：** 只有陈旧 ACL 无法续出权限且经过时间行为已验证时，离线旧权利新派发最多到原 gate 剩余期限，绝不超过60秒；否则不能声称此上界，严格 profile 保持关闭/blocked。失联不是即时全局撤权：拿到原 gate 屏障 ACK 或有效到期证据前，控制面仍报执行撤权 pending。按[动态授权](managed-agent-control-protocol.zh-CN.md#dynamic-authorization)区分 `ACL committed`、`dispatch fenced`、`process stopped`。准入到期不证明已准入进程停止、外部效果撤回或 Workspace 可解卷。

| 检查      | 必须有的接受路径                           | 必须有的拒绝路径                                              |
| --------- | ------------------------------------------ | ------------------------------------------------------------- |
| 及时续租  | 当前 ACL 的10秒内响应仅用原窗口剩余时间    | 过 deadline 或 revoke 后响应不续租，不从到达重计              |
| 挂起/重启 | 可信经过时间或恢复准入前关门禁阻止陈旧准入 | timer 暂停、回拨、incarnation 丢失不保留旧权利                |
| 离线上界  | 原有效未过期 gate 仅用合资格剩余窗口       | 不允许陈旧 ACL 续租、新 Runtime 重跑、停止 SLA 声明或到期解卷 |

计时/分区证据须后续实现验收取得，本轮未做此类实验。

## 6. 容量、观测和性能门槛

沿用 daemon/Bridge 容量配置，分记 workspace、Session、activation、host、Runtime、未决 phase、临时/持久资源。coordinator 在全局共享预算预留，不为 legacy/Managed 分开限额；provider 惰性 prepare，实际退出后才归还活容量；不自动扩 workspace 上限。这是保留原运行契约，不是补充排除的配额/计费设计。

`ManagedExecutionMetrics` 用固定低基数字段 engine、entry kind、phase、outcome、platform/profile；session/prompt/activation/invocation ID 仅放结构化 trace。记录 admission/commit/queue/TTFT/model/tool/approval wait/recovery/drain 耗时、活对象数、保留 bytes、失败原因、late/duplicate receipt、blocked。缺测量写 unknown，不用0。日志不记 prompt 正文、参数、密钥、完整路径、原始输出或模型思考；诊断业务数据即使无模型凭据也仍须授权。

以下仍是待验收默认切换门槛，不是实测 SLO：同机/构建/自有模型响应夹具对比 legacy，20次预热，至少200正式轮次并重复3组。排除供应商波动，Managed 入口/编排 TTFT p95 额外开销不超 max(100ms,legacy 的20%)；无工具吞吐至少 legacy 的90%，同并发稳态 RSS 不超125%。分测1/8/32 Session；实际上限不足32按许可上限测并披露范围，不为通过升限额。

恢复读10,000事件（正文用 refs）目标 p95 ≤2s，小耐久事务 p95 ≤50ms 仅适用于满足磁盘 profile 的测试机。30分钟稳定运行及100次 create/close、reload、故障循环后，owner 回基线，无自有子进程/端口残留；静默10分钟后 RSS 对首稳态增长 ≤10%。超出要分析，不用加 timeout 掩盖；报告附硬件/OS/fs/Node、trace、误差。未达标默认关闭，按测量修实现或明确修订设计门槛。

## 7. 运行验收矩阵

| 编号 | 必测动作与判断                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| O01  | 每个物理 phase 在 intent/dispatch/settled/Session ACK 窗口中断；完成不重跑，未知 blocked，未开始有证据                 |
| O02  | 分别杀 Harness/worker/daemon，保留/删临时 outputRoot；持久已提交资源可恢复，唯一资源丢失不报成功                       |
| O03  | 新旧 epoch 并发、墙钟偏差、迟到 renew、challenge 重放、分区；无新越权派发，原 receipt 仍可结算                         |
| O04  | macOS/Linux 组、Linux 委派 cgroup、Windows Job 独立验证孙进程、根退出、ID 复用、观测失败，不互借通过结果               |
| O05  | shared host 与多 workspace generation 混合关闭；只清自有资源，旧 generation 不碰新代                                   |
| O06  | 1/8/32 Session、性能/循环、慢订阅、大媒体、磁盘压力；核对物理进程、authority、客户端，不以单个 active Map 证明全局空闲 |
| O07  | 不支持 profile、旧 worker 协议、错信任/凭据、重定向、错 tenant；创建/派发前拒绝，不降级重跑                            |

§3.1/§4.1/§5.1 补充矩阵增加案件、停止、计时的成对成功/拒绝路径，全部 blocked 不算通过。H2 或 fake Kubernetes 不能替代真实 MySQL/Kubernetes/CSI 语义。本轮文档修改未运行验收测试或性能测量。

## 8. 具体施工接缝

Core ManagedToolRuntime/owned-command/owned-process-group、managed-tool-file-history、Invocation 引用/gate；CLI managed-tool-session、Runtime provider/worker routes、worker launcher/activator、registry drain；Session authority/coordinator 恢复/cleanup；平台 native helper/夹具；既有 telemetry/tracing。先有持久 phase/strict reader，再做重启读取和专用 reconciler，最后开放 profile；内存 Map 落盘不代表全部效果可恢复。

未来补充实现复用 RuntimeBrokerService、execution/binding repository、KubernetesRuntimeProvisioner，完成原 ID 离线观察、case CAS/审计、证据化停止/交接。须收紧人工 resolveUnknownExecution 路径，Runtime revoke/最终准入串行并在 await 后重验，注册版本化 control schema 而不改严格 v2 payload。产品 ACL 在[控制协议](managed-agent-control-protocol.zh-CN.md#dynamic-authorization)，Workspace 占用/history 在[工具与历史](managed-agent-tools-history.zh-CN.md)，备份/保留/删除在[存储](managed-agent-session-storage.zh-CN.md)。这是实现义务，不是修改交付计划或声称已集成。
