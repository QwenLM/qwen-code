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
- Broker 进程重启后接管或协调 Runtime。
- 使用 JDBC 持久化 Tool execution 状态。
- 排空空闲 Runtime binding 或释放物理 Runtime 进程。
- 实现 Hosted Harness 回调或 Qwen CLI 集成。

## Adapter 边界

`HarnessSessionResolver` 返回 Harness Session 的权威 `RuntimeScope`。其结果必须在该 scope 下创建的所有 Runtime Session 生命周期内保持稳定；真实的 scope 变更必须使用新的 Runtime Session 标识。服务由此生成 `RuntimeProvisionRequest`：workspace isolation 不包含 isolation key，因此在完整 scope 内共享 binding；session isolation 使用 Harness Session 标识，因此不能跨 Harness Session 共享。

`RuntimeProvisioner` 执行外部供应并返回已证明的 `RuntimeLease`。对于完全相同的 placement request，重复调用必须收敛到同一个 live resource，包括发生不确定失败之后。服务负责围绕该调用持有 repository claim，但不规定如何创建进程或容器。

`RuntimeTransport` 针对一个 lease 实现 acquire、control、execute、cancel 和 release。它接收有类型的 Runtime 与 Session 身份；后续 HTTP adapter 可以把这些调用投影到私有协议，而无需改变服务状态语义。

## Binding 生命周期

服务针对准确 placement request 调用 `findOrCreate`，并按 binding 标识合并同一进程中的并发工作。调用 provisioner 前，必须通过 `claimOperation` 取得 `PROVISIONING` 记录。供应期间服务持续续租该 operation claim，并只使用最新 claim 版本写入 `READY`。供应失败且 claim 仍有效时写入 `FAILED`。claim 丢失或过期时绝不发布返回的 lease。

`READY` 行只是持久化控制面证据，不能证明 endpoint 仍然存活，也不能证明重启后的 Broker 进程拥有凭据和本地资源。服务只在进程内记录由本进程成功供应并证明的 lease。当 repository 返回 `READY` 但进程内不存在匹配 lease 时，服务以 `runtime_reconciliation_required` 失败；绝不会静默复用 endpoint，也不会创建内存替代物。

## Runtime Session 生命周期

`acquire` 在构建 Session 身份前解析 scope。同一 Runtime Session 标识的调用会在进程内收敛，并且必须重复相同的 Harness Session 和 turn kind，而 resolver 必须返回相同的 scope。服务确保存在 live binding，持久化 `ACQUIRING`，调用 transport acquire，再通过 compare-and-set 将 Session 更新为 `READY`。Runtime acquire 操作必须按 Runtime Session 标识幂等，才能安全处理 adapter 边界上的不确定重试。acquire transport 失败时，持久化 Session 保持 `ACQUIRING`，服务只移除失败的进程内尝试，从而允许同一身份安全重试，而不会在缺少权威失败证据时进入终态。

控制操作限定为现有私有 Runtime kind：`bind-history`、`checkpoint`、`history`、`manifest`、`begin-turn`、`prepare`、`confirmation`、`confirm` 和 `preflight`，并要求进程内 Session 对应的 repository 记录仍为 `READY`。

释放操作首先拒绝仍有未结算 execution 的 Session。服务持久化 `RELEASING`，调用 Runtime transport，并仅在收到肯定的释放确认后持久化 `RELEASED`。不确定或否定的释放结果保留为 `RELEASING`，调用方可以重试幂等 Runtime release，而不是重新打开 Session。一旦 `RELEASED` 已持久化，重复 release 无需依赖已移除的进程内路由，也不会再次调用 Runtime，而是直接返回成功。

## Tool execution 生命周期

创建操作保存 `PREPARED` 记录，其不可变身份包含 binding generation、Harness Session、Runtime Session、prompt、Tool call、参数摘要以及 invocation reference。`findOrCreate` 通过 idempotency key 收敛；同一 key 对应的请求内容变化会在再次物理分发前被拒绝。

dispatcher 取得记录 claim，在调用 Runtime 前持久化 `EXECUTING`，并在调用结束前持续续租 dispatch lease。有效结果会结算当前已 claim 的记录。物理分发可能已经开始，因此 transport 失败、缺少结果或无效结果均属于不确定状态；服务会尝试把 execution 转为 `UNKNOWN`，而不是制造 error result 或重放 Tool call。同一幂等键的重试会重新驱动尚未发送的 `DISPATCHING` 记录，并通过 repository takeover 把已过期的 `EXECUTING` 或 `CANCEL_REQUESTED` claim 隔离为 `UNKNOWN`；dispatch lease 仍有效时绝不会重放 Tool call。如果 claim 过期或被其他 owner 接管，repository fencing 仍是最终权威。

取消操作首先使用开放的 repository 路径。尚未分发的 execution 会直接结算为 cancelled；`DISPATCHING` execution 为 owner 保留粘性取消意图；`EXECUTING` execution 会在服务发送物理取消信号前变为 `CANCEL_REQUESTED`。只有取消响应同时提供 Runtime 的 `state: settled` 证据和有效终态结果时，服务才结算记录；非终态确认会保留粘性请求，等待 dispatch result 或后续 reconciliation。

## 并发与所有权

服务只使用进程内 future 合并同一 Broker 实例中的重复供应、Session acquire 和 dispatch 工作。repository version 和 lease 仍是状态变更的权威依据。`brokerOwnerId` 必须标识一个存活 Broker 进程；外部工作活跃期间，operation claim 和 dispatch claim 按配置租期的三分之一间隔续租。

关闭服务后会拒绝新工作、取消内部等待者，并停止服务自身持有的续租 scheduler。关闭并不声明进行中的外部工作已经停止；过期的 repository claim 会保留 fail-closed 的接管语义。

## 错误与安全

`RuntimeBrokerException` 携带稳定 code、retryable 标记以及供 adapter 使用的状态码。参数校验和身份冲突不可重试；供应、scope 解析、transport 失败、claim 丢失以及缺少 reconciliation 属于可重试的服务不可用情况。

Runtime token 保留在 `RuntimeLease` 中。服务会把 lease 交给 binding repository 和 Runtime transport，并且 `warm` 返回的 binding record 会把 lease 交给嵌入调用方。JDBC binding repository 会将 token 持久化到 `runtime_token`；因此 binding 行及其备份都属于机密数据，需要收紧访问权限，并采用适当的加密和轮换控制。嵌入 adapter 不得把 lease 或 token 序列化给不可信调用方。服务不记录 token、invocation reference 或 Tool result。嵌入 adapter 仍负责认证调用方，并把调用方映射到传给本服务的 Harness Session 标识。

## 验证

- Workspace isolation Session 共享一个已供应 binding；session isolation 的不同 Harness Session 获得不同 binding。
- 同一 Runtime Session 的并发 acquire 在进程内只调用一次 Runtime acquire。
- 没有进程内证明的持久化 `READY` binding 会 fail closed。
- 重复 execution 创建收敛到同一记录和一次 dispatch；同一 idempotency key 对应不同内容时冲突。
- 取消意图先于 Runtime cancel 调用持久化，并一直保留到物理结果完成结算。
- 不确定的 execution transport 失败进入 `UNKNOWN`。
- 活跃 execution 阻止 Session release；成功释放后 Session 进入 `RELEASED` 并移除进程内路由。
- 超过一个租期间隔的 execution 仍持续续租 dispatch claim。
- Java 21 下 Maven 单元测试和 Checkstyle 通过。

## 验收标准

- 没有对应 repository 身份以及适用场景下的 live claim 时，不启动外部操作。
- 过期的 provisioning owner 不能发布 Runtime lease。
- 过期的 dispatch owner 不能结算或变更 Tool execution。
- 在一个 Broker 进程内，同一 idempotency key 不会造成两次物理 dispatch。
- 不确定的物理 dispatch 永远不会被转换为可重放的 error result。
- 进程重启后，持久化 readiness 永远不会被当作 liveness。
- Runtime Session release 不能与未结算 Tool execution 竞争。
- 不引入 Spring、HTTP server、Hosted Harness 或具体 Runtime provider 依赖。

## 后续工作

在启用重启恢复前增加显式进程接管和 reconciliation；增加 JDBC Tool execution 持久化以支持多实例 dispatch 收敛；随后通过私有 HTTP adapter 暴露本服务核心。物理 Runtime drain、Hosted Harness 集成和 Qwen 侧 Broker client 继续作为独立可评审切片。
