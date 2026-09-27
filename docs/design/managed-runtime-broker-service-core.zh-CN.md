# Managed Runtime Broker 服务核心

[English](managed-runtime-broker-service-core.md) | [简体中文](managed-runtime-broker-service-core.zh-CN.md)

状态：已在不依赖框架的 Java 服务边界实现

## 问题

Runtime Broker repository 已经定义了持久化身份、生命周期状态、compare-and-set 版本以及操作或分发租约，但尚未协调这些记录所代表的外部工作。嵌入服务仍需要一个统一位置解析权威 Runtime scope、供应 Runtime、获取逻辑 Runtime Session、分发和取消 Tool execution，并在不绕过 repository fencing 的前提下释放 Session。

## 目标

- 将现有 Runtime binding、Runtime Session 和 Tool execution repository 组合为一个可嵌入的 Java 服务。
- 将权威 tenant、workspace、generation、root、capability 和 isolation scope 解析留在 Broker 外部，但要求在 placement 前完成解析。
- 每个 placement request 供应一个 Runtime generation，并在供应完成前续租 repository operation lease。
- 幂等获取逻辑 Runtime Session，且仅通过本进程已证明的 Runtime lease 路由操作。
- 同一 idempotency key 的 Tool execution 只分发一次，在物理执行期间续租 dispatch lease，并将不确定结果保留为 `UNKNOWN`。
- 在发送物理取消信号前记录取消意图，并在仍有活跃 execution 时阻止释放 Session。
- 保持独立于 Spring、HTTP、Hosted Harness 内部实现以及任何具体进程或容器 provider。

## 非目标

- 将 Broker 暴露为 HTTP 服务或定义公开 Agent resource。
- 实现本地进程、容器、Kubernetes 或远程 Runtime provisioner。
- Broker 进程重启后接管或协调 legacy binding；具备持久身份的 binding 由
  Broker 自行接管，见
  [Runtime 绑定对账](2026-09-24-runtime-binding-reconciliation.zh-CN.md)。
- 使用 JDBC 持久化 Tool execution 状态。
- 排空空闲 Runtime binding 或释放物理 Runtime 进程。
- 实现 Hosted Harness 回调或 Qwen CLI 集成。

## Adapter 边界

`HarnessSessionResolver` 返回 Harness Session 的权威 `RuntimeScope`。其结果必须在该 scope 下创建的所有 Runtime Session 生命周期内保持稳定；真实的 scope 变更必须使用新的 Runtime Session 标识。服务由此生成 `RuntimeProvisionRequest`：workspace isolation 不包含 isolation key，因此在完整 scope 内共享 binding；session isolation 使用 Harness Session 标识，因此不能跨 Harness Session 共享。

`RuntimeProvisioner` 执行外部供应并返回已证明的 `RuntimeLease`。对于完全相同的 placement request，重复调用必须收敛到同一个 live resource，包括发生不确定失败之后。服务负责围绕该调用持有 repository claim，但不规定如何创建进程或容器。

`RuntimeTransport` 针对一个 lease 实现 acquire、control、execute、cancel、status 和 release。`status` 按原始 `reference` 查询一次调用，且只读；默认实现以不可重试的 `runtime_execution_status_unsupported` fail closed，因此不支持查询的 transport 永远无法结算 execution。它接收有类型的 Runtime 与 Session 身份；后续 HTTP adapter 可以把这些调用投影到私有协议，而无需改变服务状态语义。

## Binding 生命周期

服务针对准确 placement request 调用 `findOrCreate`，并按 binding 标识合并同一进程中的并发工作。调用 provisioner 前，必须通过 `claimOperation` 取得 `PROVISIONING` 记录。供应期间服务持续续租该 operation claim，并只使用最新 claim 版本写入 `READY`。供应失败且 claim 仍有效时写入 `FAILED`。持久 binding 在其调度器资源已知后绝不写入 `FAILED`：不可重试的身份失败写入 `RECOVERY_BLOCKED`，可重试失败保持 `PROVISIONING`，使重试收敛到已确保的资源，而不是铸造替代资源。claim 丢失或过期时绝不发布返回的 lease。

`READY` 行只是持久化控制面证据，不能证明 endpoint 仍然存活，也不能证明重启后的 Broker 进程拥有凭据和本地资源。服务只在进程内记录由本进程成功供应并证明的 lease。当 repository 返回 `READY` 但进程内不存在匹配 lease 时，legacy binding 以 `runtime_reconciliation_required` 失败；具备持久身份的 binding 进入 Broker 侧对账：先由 provisioner 观察物理资源，再由 transport 重新证明 Runtime 身份，之后 Session 才可以使用该 lease。两条路径都不会静默复用 endpoint，也不会创建内存替代物；见 [Runtime 绑定对账](2026-09-24-runtime-binding-reconciliation.zh-CN.md)。

## Runtime Session 生命周期

`acquire` 在构建 Session 身份前解析 scope。同一 Runtime Session 标识的调用会在进程内收敛，并且必须重复相同的 Harness Session 和 turn kind，而 resolver 必须返回相同的 scope。服务确保存在 live binding，持久化 `ACQUIRING`，调用 transport acquire，再通过 compare-and-set 将 Session 更新为 `READY`。Runtime acquire 操作必须按 Runtime Session 标识幂等，才能安全处理 adapter 边界上的不确定重试。acquire transport 失败时，持久化 Session 保持 `ACQUIRING`，服务只移除失败的进程内尝试，从而允许同一身份安全重试，而不会在缺少权威失败证据时进入终态。

控制操作限定为现有私有 Runtime kind：`bind-history`、`checkpoint`、`history`、`manifest`、`begin-turn`、`prepare`、`confirmation`、`confirm` 和 `preflight`，并要求进程内 Session 对应的 repository 记录仍为 `READY`。

释放操作首先拒绝仍有未结算 execution 的 Session。服务持久化 `RELEASING`，调用 Runtime transport，并仅在收到肯定的释放确认后持久化 `RELEASED`。不确定或否定的释放结果保留为 `RELEASING`，调用方可以重试幂等 Runtime release，而不是重新打开 Session。一旦 `RELEASED` 已持久化，重复 release 无需依赖已移除的进程内路由，也不会再次调用 Runtime，而是直接返回成功。

## Tool execution 生命周期

创建操作保存 `PREPARED` 记录，其不可变身份包含 binding generation、Harness Session、Runtime Session、prompt、Tool call、参数摘要以及 invocation reference。`findOrCreate` 通过 idempotency key 收敛；同一 key 对应的请求内容变化会在再次物理分发前被拒绝。

dispatcher 取得记录 claim，在调用 Runtime 前持久化 `EXECUTING`，并在调用结束前持续续租 dispatch lease。有效结果会结算当前已 claim 的记录。物理分发可能已经开始，因此 transport 失败、缺少结果或无效结果均属于不确定状态；服务会尝试把 execution 转为 `UNKNOWN`，而不是制造 error result 或重放 Tool call。同一幂等键的重试会重新驱动尚未发送的 `DISPATCHING` 记录，并通过 repository takeover 把已过期的 `EXECUTING` 或 `CANCEL_REQUESTED` claim 隔离为 `UNKNOWN`；dispatch lease 仍有效时绝不会重放 Tool call。如果 claim 过期或被其他 owner 接管，repository fencing 仍是最终权威。claim 是否过期由 repository 的时钟判断，服务不会用自己的时钟比较租约。如果 dispatch lease 在 Runtime 返回前已过期，结果无法再通过该 claim 写入，dispatcher 会经同一 takeover 路径把记录隔离为 `UNKNOWN`。

取消操作首先使用开放的 repository 路径。尚未分发的 execution 会直接结算为 cancelled；`DISPATCHING` execution 为 owner 保留粘性取消意图；`EXECUTING` execution 会在服务发送物理取消信号前变为 `CANCEL_REQUESTED`。只有取消响应同时提供 Runtime 的 `state: settled` 证据和有效终态结果时，服务才结算记录；非终态确认会保留粘性请求，等待 dispatch result 或后续 reconciliation。dispatch lease 过期后，取消仍能送达本进程正在运行的调用。本进程未在运行、已过期的 `CANCEL_REQUESTED` claim 会改为隔离成 `UNKNOWN`；仍然有效的 claim 无论由哪个 Broker 持有，都会收到物理取消信号。租约过期后才到达的已结算确认同样会把记录隔离为 `UNKNOWN`，而不是报告冲突。

## UNKNOWN 对账

`reconcileExecution` 是 `resolveUnknown` 唯一的调用方。每次调用最多查询一次，内部不重试；轮询由调用方负责，例如每 250 ms 至 2 s 一次并带抖动，调用方还应自行限定轮询总预算。它从不调用 `execute`，从不 claim dispatch，自身也从不推导出"未开始"结果。

- 先读取记录，且记录必须属于调用方的 Harness Session 和 Runtime Session。不处于 `UNKNOWN` 的记录在任何 Session 或存活检查之前就从 repository 作答：`ALREADY_SETTLED` 表示轮询可以结束；`IN_FLIGHT` 表示记录既未结算也不是 `UNKNOWN`，暂无可对账的内容。`IN_FLIGHT` 并不证明仍有 dispatcher 在处理。已过期的 `EXECUTING` 或 `CANCEL_REQUESTED` 记录会停留在这里，直到持有该 Session 的进程用同一幂等键重试或取消，把它隔离为 `UNKNOWN`，或者由接管扫描完成隔离；而同一幂等键的重试会重新分发 `PREPARED` 或已过期的 `DISPATCHING` 记录，这类记录从未到达 Runtime。对账器自身从不隔离也不 claim dispatch。由于这一应答不需要本地 Session，Session release 之后已结算的结果仍可读取；谁可以调用由嵌入 adapter 的鉴权决定。
- 只能由原 Runtime 作答。记录上登记的 binding generation 已不存在、已被取代，或不再处于 `READY` 或 `DRAINING` 时，该 generation 不可用于查询，调用以不可重试的 `runtime_execution_evidence_unavailable` 失败；恢复被 recovery 阻断的 generation 属于本切片之外的运维工作。lease 已失效时，与其他操作一样先让该 binding 退役，然后以同样方式失败；本进程已让其 lease 退役的 Session 也同样失败，因为退役时已释放了 worker，即使因另一个 owner 持有 operation claim 而 binding 行仍是 `READY`。该 generation 仍可能作答、但本进程没有通往它的已证明路由时（Session 不是在本进程 acquire 的、仍在 acquire 中，或本进程中该 id 被另一个 Harness 占用），调用以可重试的 `runtime_reconciliation_required` 失败。只有当某个 Broker 进程接管该 binding、并以相同身份重新 acquire 该 Runtime Session 之后，才可能得到应答；对账器两者都不做。provisioner 不支持接管时则永远不会得到应答，因此调用方需要轮询预算。Session 的 binding 与 execution 不一致属于数据不一致，以不可重试的 `runtime_execution_conflict` 失败；只有 resolver 改变了某个 Harness Session 的 scope 才会出现这种情况，而 Adapter 边界禁止这样做。与其他操作共用的 Session 检查保留各自的错误码：`runtime_session_not_found`、`runtime_session_conflict`、`runtime_session_not_ready` 和 `runtime_scope_resolution_failed`。以上情况都不会发出查询。
- 服务发送记录的 `reference` 与 `lastSequence`。响应是封闭的：只有 `state`，以及仅在 `settled` 时出现的 `result`。`state` 取 `prepared`、`executing`、`cancel_requested`、`settled` 或 `unknown`。本版契约不返回 `lastSequence` 之后的事件。
- `settled` 且结果有效时，用 Runtime 自己的结果经 `resolveUnknown` 结算（结果类别 `RESOLVED`），包括 Runtime 自己上报的 `not_started`。并发的取消会推进 version，服务会重新读取后再次 compare-and-set；期间已被其他写入方结算的记录以 `ALREADY_SETTLED` 返回，不会被覆盖。
- 其他状态一律保持 `UNKNOWN`（结果类别 `UNRESOLVED`）。`unknown` 表示该 Runtime 没有这个 reference 的记录；和超时或 404 一样，它从不构成调用未运行的证据。
- 格式错误的响应返回不可重试的 `runtime_execution_status_invalid`；transport 或 repository 失败、超过 operation lease 时长仍未返回的查询，以及在 compare-and-set 期间持续变化的记录，都返回可重试的 `runtime_execution_reconcile_failed`；transport 自行分类的错误（例如路由不兼容或身份冲突）保留其 code 与可重试性。所有失败情况下记录都保持 `UNKNOWN`。
- 同一 execution 的并发调用共享同一个在途查询。关闭服务会让等待中的调用方失败；之后仍到达的 Runtime 应答可能结算该记录，这符合证据规则。查询超时后才到达的应答则被丢弃，下一次轮询会重新查询。

查询以"一个 `reference` 标识一次调用"为前提，这也是 Runtime 标识调用的方式；同时假定 Runtime 会让已结算调用的结果对 `status` 保持可查，保留期属于随 execute 处理器落地的 Runtime 路由契约。即使在同一进程内这一保留也很重要：本进程仍在运行的调用若在其记录变为 `UNKNOWN` 之后才完成，结果不会经由已过期的 claim 写入，要靠之后的查询来结算记录。对 Runtime 报告仍在运行的 `UNKNOWN` execution 发送物理取消、能证明"未开始"的持久回执存储、运维恢复，以及启动或接管时的扫描，都不在本切片范围内。在这些工作落地之前，原 generation 无法作答的 `UNKNOWN` execution 会一直挡住所在 Runtime Session 的 release。busy 检查只按 Runtime Session id 判断，因此在本进程中另一个 Harness 以相同 id 持有的 Session 也无法 release；该 Harness 同时让原 Harness 无法在本进程 acquire 这个 id，只能由另一个 Broker 进程接管。按 Session 身份判断 busy 属于后续工作。以 `FAILED` 退役的 generation 不会阻塞整个 scope：它不再处于 active，下一次放置会供应新的 generation。但 `LOST` 的 generation 会，而这个状态现在已经存在——只要还有未结算的 execution 或活跃 Session 引用它，它就保持 active，因此已证明 `LOST` 的 generation 上任何未结算的 execution 都会卡住其 scope：`release` 持续返回可重试的 `runtime_reconciliation_required`，该请求之后每次新的放置都得到 `runtime_broker_runtime_lost`。`reconcileExecution` 也无法清除它——`UNKNOWN` 记录得到不可重试的 `runtime_execution_evidence_unavailable`，而崩溃时停留在 `EXECUTING` 或 `DISPATCHING` 的记录只会被答为 `IN_FLIGHT`，因为没有同 key 重试、取消或接管扫描就不会有任何机制把它转成 `UNKNOWN`。结算或隔离这类 execution 需要单独的规则，且该规则必须覆盖所有未结算状态，而不只是 `UNKNOWN`；见 [Runtime 绑定对账](2026-09-24-runtime-binding-reconciliation.zh-CN.md)。

## 并发与所有权

服务只使用进程内 future 合并同一 Broker 实例中的重复供应、Session acquire 和 dispatch 工作。repository version 和 lease 仍是状态变更的权威依据。`brokerOwnerId` 必须标识一个存活 Broker 进程；外部工作活跃期间，operation claim 和 dispatch claim 按配置租期的三分之一间隔续租。

关闭服务后会拒绝新工作、取消内部等待者，并停止服务自身持有的续租 scheduler。关闭并不声明进行中的外部工作已经停止；过期的 repository claim 会保留 fail-closed 的接管语义。

## 错误与安全

`RuntimeBrokerException` 携带稳定 code、retryable 标记以及供 adapter 使用的状态码。参数校验、身份冲突、格式错误的执行查询 status、原 Runtime generation 已无法作答的 execution，以及不支持查询的 transport 都不可重试；供应、scope 解析、transport 失败、claim 丢失以及缺少 reconciliation 属于可重试的服务不可用情况。

Runtime token 保留在 `RuntimeLease` 中。服务会把 lease 交给 binding repository 和 Runtime transport，并且 `warm` 返回的 binding record 会把 lease 交给嵌入调用方。JDBC binding repository 以加密形式持久化机密：持久 binding 的 provision seed（其中携带 lease token）与 legacy binding 的 lease token 都经必需的 `SecretProtector`（模块内含 `AesGcmSecretProtector`）存为密文，schema 中不再有明文 token 列。密钥必须来自嵌入服务自身的持久 secret 存储，并在重启与多实例之间保持一致；binding 行及其备份仍属机密数据，需要收紧访问权限并采用轮换控制。嵌入 adapter 不得把 lease 或 token 序列化给不可信调用方。服务不记录 token、invocation reference 或 Tool result。嵌入 adapter 仍负责认证调用方，并把调用方映射到传给本服务的 Harness Session 标识。

## 验证

- Workspace isolation Session 共享一个已供应 binding；session isolation 的不同 Harness Session 获得不同 binding。
- 同一 Runtime Session 的并发 acquire 在进程内只调用一次 Runtime acquire。
- 没有进程内证明的持久化 `READY` legacy binding 会 fail closed；持久 binding 改为经过对账后接管。
- 重复 execution 创建收敛到同一记录和一次 dispatch；同一 idempotency key 对应不同内容时冲突。
- 取消意图先于 Runtime cancel 调用持久化，并一直保留到物理结果完成结算。
- 不确定的 execution transport 失败进入 `UNKNOWN`。
- 对账只在查询结果为 `settled` 且结果有效时结算 `UNKNOWN` execution。非终态、`unknown`、格式错误的响应和 transport 失败都保持 `UNKNOWN`，任何情况都不会再次调用 `execute`。
- 对账只询问原始的、存活且已 attestation 的 binding generation；已无法作答的 generation 以不可重试错误终止轮询；不处于 `UNKNOWN` 的记录不做存活检查即以 `ALREADY_SETTLED` 或 `IN_FLIGHT` 作答；并发查询共享一次有时限的 Runtime 调用；并发取消会在结算前被重新读取。
- 活跃 execution 阻止 Session release；成功释放后 Session 进入 `RELEASED` 并移除进程内路由。
- 超过一个租期间隔的 execution 仍持续续租 dispatch claim。
- Java 21 下 Maven 单元测试和 Checkstyle 通过。

## 验收标准

- 没有对应 repository 身份以及适用场景下的 live claim 时，不启动外部操作。
- 过期的 provisioning owner 不能发布 Runtime lease。
- 过期的 dispatch owner 不能结算或变更 Tool execution。
- 在一个 Broker 进程内，同一 idempotency key 不会造成两次物理 dispatch。
- 不确定的物理 dispatch 永远不会被转换为可重放的 error result。
- `UNKNOWN` execution 只依据原 Runtime 自己的终态证据结算。
- 进程重启后，持久化 readiness 永远不会被当作 liveness。
- Runtime Session release 不能与未结算 Tool execution 竞争。
- 不引入 Spring、HTTP server、Hosted Harness 或具体 Runtime provider 依赖。

## 后续工作

Broker 重启后对持久 binding 的接管与对账已实现；剩余切片为可恢复的本地进程供应、支持多实例 dispatch 收敛的 JDBC Tool execution 持久化，以及通过私有 HTTP adapter 暴露本服务核心。Java HTTP 工具 transport 已实现，但 worker 路由与服务适配层仍待后续完成。适配层必须从已保存的四字段 reference 之外单独提供 `toolName`/`input`，并在线上校验后将 status 应答投影为 `{state, result}`；参见[工具契约](2026-09-24-managed-runtime-tool-contract.zh-CN.md#41-java-transport)。物理 Runtime drain、Hosted Harness 集成和 Qwen 侧 Broker client 继续作为独立可评审切片。
