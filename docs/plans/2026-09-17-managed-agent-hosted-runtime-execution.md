# Managed Agent Hosted Runtime 可执行技术方案

状态：执行中

更新日期：2026-09-18

设计依据：[Java Runtime Broker MVP](../design/2026-09-17-managed-agent-java-runtime-broker-mvp.zh-CN.md)

当前完成范围：P1、P2、P4、P5a 和 P5b；Hosted Harness、Java Broker 以及冷启动、幂等、取消、多 Session 隔离、独立 worker 文件握手和 Java 自有本地 Runtime 生命周期均已有实现与测试证据。

## 1. 结论

采用“Java 产品服务 + 常驻多租户 Harness + 按需 Tool Runtime”的三层结构：

```text
Client
  -> Java Agent API / Session / public Items / SSE
      -> qwen serve Hosted Harness（模型循环，常驻，多 Session）
          -> Java Runtime Broker（鉴权、绑定、幂等、调度）
              -> Tool Runtime（Workspace、Tool、MCP、Skill、副作用）
```

关键原则如下：

- Java 在收到第一条 Prompt 后立即持久化输入，同时并行启动 Runtime 预热和 Harness 模型请求，不等待 Runtime ready。
- Harness 常驻并服务多个 Session；模型上下文按 Session 隔离，不为每个请求创建 Harness 进程或 Pod。
- Tool Runtime 可以是进程、容器或 Pod。Broker 只依赖 `RuntimeProvisioner` 接口，不把 Kubernetes 写进协议。
- 没有 Tool Call 的 Turn 不访问 Runtime；发生 Tool Call 时，同一轮模型循环等待原 Runtime ready 后继续。
- Harness 不直接接收 tenant、Runtime endpoint 或调度凭证。Java 根据已认证的 `harnessSessionId` 解析权威 scope。
- Managed 失败不得把同一 Turn 切到 Legacy 重跑，避免重复副作用和上下文分叉。
- 现有 `qwen serve` Legacy 链路继续保留；仅新建且通过能力检查的 Session 固定使用 Managed。

## 2. 首个可上线范围

首个可上线版本只覆盖普通交互式 Agent Session：

- Java 创建 Session、接受 Prompt、提供 SSE 和取消接口；
- qwen Hosted Harness 完成模型调用、工具编排和 Session 恢复；
- Java Runtime Broker 完成 Runtime 预热、绑定、执行幂等、查询、取消和释放；
- Tool Runtime 执行本地文件与 Shell 等现有 Managed Tool v2 能力；
- 支持 Runtime 冷启动慢于模型首 token；
- 支持一个 Harness 进程承载多个租户 Session，但所有状态访问都必须带 Session 所属身份并由 Java 校验。

以下能力延期，继续走 Legacy：MCP、Hooks、Channels、定时任务、Worktree、跨 Harness Session Authority、Legacy 会话在线迁移、完整 OpenAI Agents API 字段兼容。

## 3. 组件职责和部署形态

| 组件           | 部署                                | 是否常驻     | 主要职责                                                               | 禁止持有                            |
| -------------- | ----------------------------------- | ------------ | ---------------------------------------------------------------------- | ----------------------------------- |
| Java 产品服务  | 现有 Java 管控面进程                | 是           | 公共 API、租户鉴权、Session/Turn/Item、SSE、Runtime Broker、配额和调度 | Harness 模型上下文、工具语义        |
| Hosted Harness | 与 Java 同机 Sidecar 或独立内网服务 | 是           | 模型调用、Context、Agent Loop、工具调用编排、checkpoint                | K8s 凭证、Runtime token 对外暴露    |
| Tool Runtime   | 进程、容器或 Pod                    | 按需并可复用 | Workspace、副作用、Tool、后续 MCP/Skill                                | 用户 Prompt、模型密钥、公共 Session |

首阶段推荐同机部署 Java 与 Hosted Harness，通过 loopback HTTP/SSE 通信。这样不要求新增独立 Harness 集群，也不要求为每个请求分配 Harness worker。后续只有当单机容量或故障域需要拆分时，才把相同私有协议切换到内网服务发现。

首阶段的 Harness 是“常驻、多 Session、可恢复”，不是严格无状态：一个活跃 Session 在 Turn 期间固定到原 Harness，进程内保留模型循环所需状态，同时把 transcript/checkpoint 落到现有 Session Authority。跨 Harness 的任意实例恢复和无状态负载均衡要等共享 Session Authority 完成后再开放，当前不得在 Turn 中途漂移实例。

## 4. 第一条 Prompt 的执行时序

```text
T0  Client -> Java: POST Prompt
T1  Java: 鉴权、固定 executionEngine/agentRevision、写 Input 与 Turn
T2  Java: 异步 broker.warm(harnessSessionId)
T3  Java -> Harness: submit Prompt
T4  Harness -> Model: 发起模型流式请求
T5  Harness -> Java: model.delta；Java 写 eventSequence 并转发 SSE
T6a 无 Tool Call：Harness 完成 Turn；Runtime 是否 ready 不影响 TTFT
T6b 有 Tool Call：Harness -> Broker acquire/createExecution
T7  Broker 等待 T2 的同一个 binding ready，派发一次 physical execution
T8  Runtime -> Broker -> Harness: Tool Result
T9  Harness 继续同一个模型循环并完成 Turn
```

TTFT 的关键路径只有 `Java admission -> Harness -> Model`。Runtime provisioning 不在关键路径上。工具首响时间单独统计为 `tool_wait_runtime_ms`，不得混入 TTFT。

## 5. 私有协议冻结

### 5.1 Java 到 Harness

首阶段复用普通 `/session` Managed 链路，不扩展实验 `/managed/sessions*`：

- 创建或加载 Harness Session；
- 提交带稳定 `turnId` / `promptId` 的 Prompt；
- 订阅带序号的 Harness 事件；
- 取消 Turn；
- 查询 transcript/checkpoint 用于恢复。

请求必须包含服务鉴权和 Java 分配的内部 Session ID。浏览器不能直连 Harness。

### 5.2 Harness 到 Java Runtime Broker

冻结以下 `/internal/runtime-broker/v1` 路由：

```text
POST /tool-sessions:acquire
POST /tool-sessions/{runtimeSessionId}/control
POST /executions
GET  /executions/{executionCallId}
GET  /executions/{executionCallId}/events
POST /executions/{executionCallId}:cancel
POST /tool-sessions/{runtimeSessionId}:release
```

P2 的 qwen client 先通过 `GET /executions/{executionCallId}` 轮询状态；`/events` 在 P3/P4 接入真实事件存储时实现，路由和事件序号语义在此阶段先冻结。

约束：

- Bearer 只用于服务到服务认证；tenant/workspace 不从请求体采信。
- `control.kind` 使用封闭枚举，不提供任意 URL 或方法透传。
- 每条命令有稳定 `requestId`；执行另外使用稳定 `idempotencyKey`。
- Broker 响应不包含 Runtime endpoint、token、Pod 名、lease 或调度信息。
- 请求失败必须返回稳定错误码和 `retryable`，Harness 不自行切换 Runtime。

### 5.3 Java 到 Tool Runtime

首阶段复用已有 Managed Runtime v1/v2 HTTP 协议，并增加 fencing header：

```text
Authorization: Bearer <runtime-token>
X-Qwen-Managed-Lease-Id: <lease-id>
X-Qwen-Managed-Lease-Epoch: <epoch>
```

只有 Java Broker 持有 endpoint、token 和 lease。Runtime 必须校验 lease 与 epoch，旧 lease 的请求一律拒绝。

Runtime 不主动连接 Java。Local Process 场景只在启动阶段通过独立 ready record 告知 endpoint；进入 ready 后，所有 control、execute、status、cancel 和 release 都由 Java 主动发起 HTTP 请求。远端容器或 Pod 则由 `RuntimeProvisioner` 直接返回经过校验的 `RuntimeLease`。

## 6. 权威数据与持久化表

产品接入阶段至少需要四个 Repository；当前内存实现只用于契约与 E2E：

| Repository                        | 主键                                      | 必须字段                                                                       | 恢复用途                         |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| `SessionBackendBindingRepository` | `publicSessionId`                         | tenant、workspace、harnessSessionId、engine、agentRevision、generation、status | 恢复固定 owner，禁止换引擎       |
| `RuntimeBindingRepository`        | reuse key / `runtimeBindingId`            | scope、state、runtimeInstanceId、leaseId、epoch、idleDeadline                  | 找回原 Runtime，防止跨代请求     |
| `ToolExecutionRepository`         | `executionCallId` 和唯一 `idempotencyKey` | requestDigest、binding、state、resultRef、errorCode                            | 去重、查询原回执、阻止不确定重放 |
| `PublicEventStore`                | `publicSessionId + eventSequence`         | turnId、itemId、type、payloadRef、createdAt                                    | SSE 重连和公共 Item 投影         |

数据库事务边界：Prompt admission 必须在同一事务中写入 Input、Turn 和 Session owner；提交后才异步调用 `warm()` 和 Harness。工具执行必须先插入 `accepted`，成功取得唯一键后才能向 Runtime 派发。

## 7. 状态机

### 7.1 RuntimeBinding

```text
ABSENT -> PROVISIONING -> READY -> DRAINING -> RELEASED
                       `-> FAILED
```

- 相同 reuse key 的并发 `warm/acquire` 共享一个 provisioning future。
- `isolationClass=workspace` 按 scope 复用；`isolationClass=session` 的 key 额外包含 `harnessSessionId`，且 provisioner 必须返回独立 Runtime。
- `FAILED` 可以按退避策略重新 provision；已经 `DISPATCHED` 的 execution 不得换 Runtime 重放。
- `DRAINING` 不接受新 execution，但允许在途 execution 查询和取消。

### 7.2 ToolExecution

```text
ACCEPTED -> WAITING_RUNTIME -> DISPATCHED -> STARTED
                                             |-> SUCCEEDED
                                             |-> FAILED
                                             |-> CANCELLED
                                             `-> RECOVERY_BLOCKED
```

- 同一 `idempotencyKey + requestDigest` 返回原 `executionCallId`。
- 同一 key 不同 digest 返回 `409`。
- Java 重启后只查询原 Runtime 和原 execution ID；无法证明终态时进入 `RECOVERY_BLOCKED`。
- `CANCELLED` 是终态；迟到的 success/failure 不得覆盖取消结果。

## 8. 分阶段施工计划

### P0：边界与契约冻结（已完成）

产物：

- Hosted Harness / Java Broker / Tool Runtime 三层责任；
- 身份、状态机、私有 API、失败关闭规则；
- Legacy 与 Managed 并存策略。

完成门槛：设计文档中不再存在“Java 直接转发工具字节流”“每请求 Harness Pod”或“Managed 失败回落 Legacy”的歧义。

### P1：qwen Hosted Harness（已完成，`65a6adf882`）

改动范围：`packages/cli` 与现有 Managed Runtime Provider 接缝。

产物：

- `qwen serve --profile hosted-harness`；
- loopback、API-only、Bearer、Broker 配置启动校验；
- `BrokerManagedRuntimeProvider` 和 Session 身份传播；
- Broker 懒 acquire，无 Tool Turn 不访问 Broker；
- Hosted 模式禁用 Local Runtime 和 Legacy fallback。

验收：Provider 契约、身份隔离、失败关闭、普通 REST Managed 入口测试通过。

### P2：可嵌入 Java Runtime Broker（已完成，`eca8c0a8f7`）

改动范围：`packages/sdk-java/runtime-broker`、Java CI、设计与计划文档。

产物：

- Java 11 `RuntimeBrokerService`；
- `HarnessSessionResolver`、`RuntimeProvisioner`、`RuntimeTransport`；
- `StaticRuntimeProvisioner` 和 `HttpRuntimeTransport`；
- `/internal/runtime-broker/v1` 参考 HTTP Adapter；
- 进程内 binding 合并与 execution ledger；
- 取消竞争、释放栅栏、跨 Harness 访问拒绝、provision 失败重试。

完成门槛：

- Maven test、Checkstyle、package 在 Java 11 通过；
- 相同 scope 只 provision 一次；
- 相同幂等键只派发一次；
- Runtime ready 前取消不会产生 execute/cancel 副作用；
- Java 模块不依赖 Spring、Kubernetes SDK 或具体数据库。

### P3：接入真实 Java Prompt 服务（产品接入关键路径）

Java 产品仓改动：

1. 增加 `ManagedAgentCoordinator`，组合 Session repository、`HarnessClient`、`RuntimeBrokerService` 和 `PublicEventStore`。
2. Session 创建时固定 `executionEngine=managed`、`agentRevision`、`workspaceGeneration` 和 `capabilityDigest`。
3. Prompt admission 事务提交后同时调用 `runtimeBroker.warm(harnessSessionId)` 与 `harnessClient.submitPrompt(...)`。
4. `warm()` 失败只记录 Runtime 状态；在模型尚未产生 Tool Call 时不终止模型流。
5. Harness 事件由 Java 分配单调 `eventSequence`，通过 SSE 输出；支持 `Last-Event-ID`。
6. Client 断开只关闭订阅，不取消 Turn；显式 cancel 才同时取消 Harness Turn 和 Broker execution。

新增接口建议：

```text
POST /v1/agent-sessions
POST /v1/agent-sessions/{sessionId}/turns
GET  /v1/agent-sessions/{sessionId}/events
POST /v1/agent-sessions/{sessionId}/turns/{turnId}:cancel
GET  /v1/agent-sessions/{sessionId}/turns/{turnId}
```

完成门槛：真实产品服务中第一条 Prompt 会触发一次异步 `warm()`；SSE 首事件不等待 `warm()` 完成；无 Tool Turn 可以在 Runtime 未 ready 时完成。

### P4：15 秒冷启动进程 E2E（已完成）

测试拓扑：Fake OpenAI Server + 真实 Hosted Harness 进程 + 真实 Java Broker 进程 + 真实 Managed Runtime worker 进程。进程边界不使用类内 mock。

P4 已自动化并接入 Java CI：

1. Broker 进入 provisioning 后等待 15 秒，再真正启动 Runtime worker 并取得 lease。
2. 模型立即流出文本，然后发 Tool Call。
3. 断言首个 model event 在 Runtime ready 前到达。
4. 断言 Tool Call 等待原 binding，ready 后只执行一次并在同一 Turn 继续。
5. 断言真实 Runtime 写入目标文件，Broker 只发生一次 provision 和一次 physical execute。
6. Broker 接受 execution 后主动丢弃首次 HTTP 响应；Harness 使用相同 `requestId + idempotencyKey` 重试，仍只发生一次 physical execute。
7. Tool Call 已出现但 Runtime 尚未启动时取消 Turn；Runtime 随后仍完成启动，断言 physical execute 为 0 且文件不存在。
8. physical execute 启动根进程和子进程后取消 Turn；断言 Broker 完成一次 physical cancel、两级进程均退出，且子进程的延迟写入未发生。
9. 一个常驻 Harness 并发运行两个 Java Session，在同一个 workspace-isolated Runtime 上分别写入不同文件并返回不同答案；断言两套 Harness 身份、Context、Tool Result 和事件不串流。

2026-09-17 本机证据：Prompt accepted 23 ms，首个模型事件 350 ms，Runtime 冷启动并 ready 17,403 ms，工具等待 Runtime 17,053 ms，Turn 完成 20,790 ms；首次 execution 响应被丢弃并恢复，physical execute count 仍为 1。

取消场景本机证据：首个模型事件 258 ms，262 ms 发出取消，Runtime 16,851 ms 才 ready；Runtime Session 随后已真实 acquire，但最终 physical execute count 为 0，Workspace 无目标文件。

执行中取消本机证据：5,043 ms 观察到根进程和子进程已启动，5,087 ms 发出取消；physical execute 与 physical cancel 均为 1，两级 PID 均退出，4 秒延迟写入未发生。

多 Session 本机证据：两个逻辑 Session 共享一次 physical provision，分别完成两次 acquire 和两次 execute；Broker 观察到两个不同 Harness Session ID，两个模型上下文、最终文本和文件内容均保持隔离。

必须输出指标：`prompt_accepted_ms`、`first_model_event_ms`、`runtime_ready_ms`、`tool_wait_runtime_ms`、`turn_completed_ms`、physical execute count。

### P5：Java 自有 Runtime 生命周期

详细执行方案：[Managed Agent Java 自有 Runtime 生命周期执行方案](./2026-09-17-managed-agent-java-owned-runtime-lifecycle.md)

先实现 `LocalProcessRuntimeProvisioner`，稳定后再实现 Kubernetes 版本：

- Java 创建 boot config 文件并以独立参数启动 worker；
- worker 在独立 ready channel 输出一条有界 ready record；
- stdout/stderr 只用于日志，不用于协议；
- Java 持有进程树、endpoint、token、lease 和 epoch；
- health、idle deadline、drain、release 都由 Broker 控制；
- cancel 必须验证工具根进程和后代退出，并观察取消后无新增写入。

完成门槛：Runtime 崩溃、启动超时、ready record 损坏、Java 取消、Java shutdown 五类测试都有可观察终态；macOS/Linux 使用进程组或等价机制，Windows 未证明前不得进入支持矩阵。

### P6：持久化与重启恢复

- 将 P2 内存 map 替换为 P6 章节定义的 Repository；
- 用数据库唯一索引保证 idempotency，而不是 JVM 锁；
- Java 重启后恢复 binding、execution 和 SSE sequence；
- Harness 重连后按 `executionCallId` 查询原 execution；
- Runtime 不可达且 execution 已可能开始时写 `recovery_blocked`，不自动重放。

完成门槛：注入 Java 重启、Harness 重启、响应丢失、Runtime 退出，证明无重复副作用并能给出明确终态。

### P7：Agent API 兼容层

在 Java 公共对象层提供 Agent、Session/Thread、Turn/Run、Item/Message、Artifact 和 Event 映射。外部 API 可以兼容 GPT/Claude 风格，但内部仍使用稳定的公共 ID 映射到 Harness/Runtime ID，不把供应商字段写入核心执行协议。

完成门槛：同一个底层 Turn 可以被现有 DataAgent API 和新的 Agent API Adapter 读取；Adapter 不绕过 admission、事件、取消和权限控制。

### P8：灰度、回滚与旧控制面收敛

- 灰度只影响新 Session，旧 Session 保持原 execution owner；
- 按 tenant/workspace/capability digest 控制 Managed admission；
- 回滚停止创建新的 Managed Session，不切换已有 Session；
- 新链路覆盖 create/prompt/events/cancel/recovery 后，才移除实验 `/managed/sessions*`；
- MCP/Hooks/Channels 等每项单独验收后再从 Legacy 白名单移出。

完成门槛：灰度和回滚演练无 Session owner 漂移、无同 Turn 双执行、无 Runtime 凭证泄漏。

## 9. PR 拆分建议

为避免核心改动过大，按以下边界提交：

1. `feat(java): add embeddable runtime broker`：P2，仅 Java Broker、CI 和文档。
2. 产品服务 PR：P3 的 Prompt admission、HarnessClient、事件投影和 SSE。
3. `test(managed): prove cold runtime hosted flow`：P4a 真实进程链路，只包含 E2E 所需的最小协议修正。
4. `fix(managed): retry ambiguous broker execution`：P4b 响应丢失幂等恢复。
5. `test(managed): prove cold runtime cancellation`：P4b Runtime ready 前取消。
6. `test(managed): prove active cancellation and isolation`：完成 P4b 物理进程树取消和多 Session 隔离。
7. `feat(cli): add standalone managed runtime boot protocol`：P5a 文件握手。
8. `feat(java): own local runtime lifecycle`：P5b Java 进程生命周期。
9. `test(managed): verify java-owned runtime lifecycle`：P5c 故障与真实进程验收。
10. 产品服务 PR：P6 持久化与恢复。
11. API PR：P7 公共 Agent API Adapter。
12. 收敛 PR：P8 灰度默认与旧实验面删除。

每个 PR 都必须可以独立回滚，不能同时修改公共 API、Runtime 生命周期和持久化 schema。

## 10. 观测指标与告警

必须按 Session、Turn、binding 和 execution 四个维度记录：

- `managed_prompt_admission_ms`
- `managed_first_model_event_ms`
- `managed_runtime_provision_ms`
- `managed_tool_wait_runtime_ms`
- `managed_tool_execution_ms`
- `managed_turn_total_ms`
- `managed_runtime_reuse_total`
- `managed_execution_deduplicated_total`
- `managed_execution_recovery_blocked_total`
- `managed_cancel_process_tree_ms`

日志只记录 ID、状态和耗时；Runtime token、模型密钥、Prompt 正文和完整工具输出不得进入普通日志。

## 11. 发布前硬门槛

- 15 秒 Runtime 冷启动不延迟首个模型事件。
- 无 Tool Turn 不访问 Runtime 或等待 Runtime。
- 同一 Turn 的 Tool Call 等待原 Runtime 并继续，不重建模型上下文。
- 一个幂等键最多一次 physical execution。
- Java/Harness/Runtime 任一连接断开都不会触发 Legacy fallback。
- 取消证明完整进程树退出且之后无写入。
- Java 重启恢复不重复执行可能已经开始的工具。
- 多租户并发下 Session scope、Workspace、事件和权限无串扰。
- 对外响应和日志均不暴露 Runtime endpoint、token、lease、Pod 名或 Harness instance ID。
- Legacy 会话仍可按原链路使用；Managed 只对新且兼容的 Session 生效。

## 12. 紧接着执行的工作

P1、P2、P4、P5a 和 P5b 已经闭环。下一条产品关键路径是 P3，同时在 qwen-code 内完成 P5c：

1. 在真实 Java 产品服务定位 Prompt admission 事务、Session owner 表和 SSE event store 接缝。
2. 实现 `ManagedAgentCoordinator`：事务提交后并行调用 `runtimeBroker.warm()` 与 `harnessClient.submitPrompt()`，禁止串行等待 Runtime。
3. 把 Harness event 投影为带单调 `eventSequence` 的公共事件，并实现 `Last-Event-ID` 重连。
4. 将真实 E2E 改为由 Java `LocalProcessRuntimeProvisioner` 直接启动 Runtime，并闭环 timeout、invalid ready、ready 后 crash 和 shutdown。
5. P3/P5 通过后再进入持久化恢复；Kubernetes provisioner、共享 Session Authority 和 Agent API Adapter 继续后置。

P3 的最小上线判断只有三个：首个模型事件不等待 Runtime、同 Turn 的工具只执行一次、Java/Harness/Runtime 任一失败都不回落 Legacy。持久化 schema、Kubernetes 调度和完整 Agent API 兼容不能阻塞这三个判断的第一次产品验证。
