# Managed Agent P3 Java Prompt 服务接入执行方案

状态：可开工

日期：2026-09-18

上游方案：[Managed Agent Hosted Runtime 可执行技术方案](./2026-09-17-managed-agent-hosted-runtime-execution.md)

后续方案：[Managed Agent 公共 Agent API 适配层执行方案](./2026-09-18-managed-agent-public-api-adapter.md)

## 1. 本阶段结论

P3 不先实现 OpenAI、Claude 或 Responses 公网 API，也不把模型循环迁入 Java。它只完成一条真实产品链路：

```text
现有 DataAgent API / 后续 Agent API
                |
                v
Java Prompt 服务
  - 鉴权与租户隔离
  - Session / Turn 权威状态
  - admission、幂等、事件投影、SSE
  - 异步触发 Runtime warm
                |
                | loopback HTTP + SSE，私有协议 v1
                v
常驻 Hosted Harness（qwen serve，TypeScript）
  - 多 Session 模型循环
  - Context、模型调用、Tool Call 编排
                |
                | HTTP
                v
Java Runtime Broker
                |
                | HTTP
                v
按需 Tool Runtime
```

用户第一条 Prompt 到达时，Hosted Harness 已经常驻。Java 在提交 Harness Prompt 的同时异步调用 `RuntimeBrokerService.warm()`，模型输出不等待 Tool Runtime。只有模型真的产生 Tool Call 时，Harness 才等待该 Session 已绑定的 Runtime。

P3 的目标不是一次性完成整套 Managed Agents 平台，而是证明下面四件事能够在真实 Java 产品服务成立：

1. 首个模型 delta 不等待 Runtime ready；
2. 相同 Turn 的 Harness admission 和物理 Tool execution 都最多一次；
3. Java、Harness、Broker 或 Runtime 失败时不把活动 Managed Session 回落到 Legacy；
4. 现有 DataAgent API 与未来 Agent API 可以读取同一份 Java 权威 Session、Turn 和 Event。

## 2. 已有代码与本阶段缺口

### 2.1 已有能力

qwen-code 当前已经具备：

- `--profile hosted-harness` 常驻模式；
- 普通 `/session`、`/session/:id/prompt`、`/session/:id/events`、`/session/:id/cancel`、status 和 transcript 路由；
- 调用方指定 `sessionId` 和 `promptId`；
- 相同 `promptId + 相同 payload` 的 Prompt admission 幂等；
- SSE `Last-Event-ID + X-Qwen-Event-Epoch` 重连；
- Hosted Harness 到 Java Runtime Broker 的 Tool execution 链路；
- Java 自有 Local Process Runtime 生命周期；
- 冷启动、响应丢失、取消、多 Session 隔离和 Runtime 故障的真实进程 E2E；
- Java `DaemonClient` / `DaemonSessionClient`，可以 create、prompt、observe、cancel、detach 和 destroy。

### 2.2 必须补齐的缺口

| 缺口                                                    | 当前风险                                          | P3 处理方式                                                 |
| ------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Hosted Harness 没有独立的私有协议握手                   | Java 可能连接到普通 daemon 或不兼容版本           | 增加 Hosted Harness contract v1 capability 和请求头         |
| Java 不校验 Harness 进程代际                            | 活动 Session 可能被路由到重启后的新进程或错误实例 | capability 返回 `bootId`，每个 Session 请求携带并校验       |
| Java SDK 不能传 caller `promptId`                       | admission 响应丢失后无法用同一键安全重试          | 给 `PromptRequest` 增加 caller-supplied UUID，并校验响应 ID |
| Java SDK 没有 load/status/transcript 抽象               | create outcome unknown 和 Java 重启后不能重新附着 | 增加 Hosted Harness 专用 transport API                      |
| 现有 `startPrompt` 把 submit 和观察绑在一个进程内对象中 | 不适合作为产品 Repository 和恢复边界              | 产品 `HarnessClient` 拆成 submit、stream、snapshot、cancel  |
| 产品 Java 还没有 Coordinator                            | warm、submit、事件、取消缺少单一所有者            | 增加 `ManagedAgentCoordinator`                              |
| Harness 事件不是公共事件                                | 对外序号、权限和重连会泄漏实现细节                | Java 投影为公共事件并分配自己的 sequence                    |

P3 不补 Runtime Broker 数据库恢复；那是 P6。P3 可以复用产品已有的 Session、Turn、SSE 和 Outbox 存储，但不得继续使用仅 JVM 内存保存的公共 Session 权威状态。

## 3. 冻结的所有权边界

| 对象                                          | 唯一所有者          | 不允许承担的职责                           |
| --------------------------------------------- | ------------------- | ------------------------------------------ |
| 公共 Session、Turn、Item、Event、租户权限     | Java Prompt 服务    | 不保存 Runtime token、endpoint 或进程句柄  |
| 模型循环、对话 Context、Tool Call 编排        | Hosted Harness      | 不鉴权公共 tenant/workspace，不分配公共 ID |
| Runtime binding、lease、epoch、execution 幂等 | Java Runtime Broker | 不生成模型内容，不投影公共事件             |
| 文件、MCP、Skill、Shell 等本地副作用          | Tool Runtime        | 不主动连接 Java，不访问公共数据库          |

Tool Runtime 的请求和结果不经过 Java Prompt Controller。Harness 直接访问 Runtime Broker；Broker 再访问 Runtime。Java Prompt 服务只观察环境状态和公共事件，避免成为工具数据转发瓶颈。

活动 Session 一旦写入 `executionEngine=MANAGED`，直到关闭都不能切换到 Legacy。灰度或故障回滚只影响尚未创建的新 Session。

## 4. ID 与 fencing 规则

Java 必须保存四层 ID 的显式映射：

| 层级            | ID                       | 生成方              | 用途                                            |
| --------------- | ------------------------ | ------------------- | ----------------------------------------------- |
| 公共 Session    | `publicSessionId`        | Java                | 对外资源和权限边界                              |
| Harness Session | `harnessSessionId`，UUID | Java                | `/session/:id`，create outcome unknown 时可恢复 |
| Harness attach  | `harnessClientId`        | Harness             | 当前 Java attachment 的 mutation / SSE 身份     |
| 公共 Turn       | `publicTurnId`           | Java                | 对外 Turn / Run / Response 映射                 |
| Harness Prompt  | `promptId`，UUID         | Java                | Prompt admission 幂等和 Harness 事件关联        |
| Tool execution  | `executionCallId`        | Harness/Broker 协议 | 物理工具幂等                                    |

第一版不要求 `publicTurnId` 出现在 Harness 请求体中。Java 用数据库中的 `(harnessSessionId, promptId) -> publicTurnId` 映射完成事件投影，避免把公共 API 结构耦合到 qwen 私有协议。

一个 Harness Session 同时绑定：

- `harnessEndpointId`：Java 配置中的逻辑 endpoint 名；
- `harnessBootId`：Harness 进程启动时生成的 UUID；
- `harnessClientId`：create/load 返回的 attachment ID；
- `harnessProtocolVersion`：首版固定为 `1`；
- `capabilityDigest`：该 Harness 部署可提供的模型、工具和策略集合摘要。

`harnessBootId` 是 fencing token，不是展示字段。Java 每次访问活动 Session 都携带创建时记录的 boot ID。请求落到另一个实例或原实例已重启时必须失败并进入恢复流程，不能静默创建另一个 Session。

首版 `capabilityDigest` 由部署系统根据 agent 配置、模型路由、Tool 白名单和策略版本生成 canonical JSON 的 SHA-256，并通过 `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST=sha256:<64-hex>` 注入 Harness。qwen-code 只校验格式并回显，不读取 canonical 配置，也不把 secret 纳入 digest。`bootId` 则由 Harness 每次进程启动时随机生成，不落盘、不允许外部覆盖。

## 5. Hosted Harness 私有协议 v1

### 5.1 握手

Java 先用已有 bearer token 调用：

```http
GET /capabilities
Authorization: Bearer <service-token>
```

Hosted Harness profile 额外返回：

```json
{
  "v": 1,
  "features": ["hosted_harness_private_v1"],
  "hostedHarness": {
    "protocolVersions": {
      "current": 1,
      "supported": [1]
    },
    "bootId": "c3ea0f85-7c21-43c0-9705-ce127416587a",
    "capabilityDigest": "sha256:..."
  }
}
```

普通 `qwen serve` 不返回 `hostedHarness`。Java 产品接入必须同时验证 feature、版本、boot ID 和期望的 capability digest；任一不匹配都不创建 Managed Session。

P3 的 Hosted Harness 是部署级固定 agent capability；`agentRevision` 和预期 `capabilityDigest` 由 Java 写入 Session binding。未来需要一个 Harness 同时承载多种动态 AgentDefinition 时，再在新协议版本增加 per-Session agent config，不把未实现的动态配置伪装进 v1。

`bootId` 和 capability digest 必须在 TCP listener 开放前确定。`run-qwen-serve` 的 bootstrap `/capabilities` 与完整 runtime `/capabilities` 返回完全相同的 Hosted Harness contract，避免 Java 在启动窗口把同一进程误判为两个 generation。直接嵌入 `createServeApp` 的路径也必须生成一次并复用同一个 boot ID。

### 5.2 请求 fencing

除 `/health` 和 `/capabilities` 外，Hosted Harness profile 下所有 `/session` 请求必须带：

```http
X-Qwen-Harness-Protocol-Version: 1
X-Qwen-Harness-Boot-Id: c3ea0f85-7c21-43c0-9705-ce127416587a
X-Qwen-Client-Id: <create-or-load-response-client-id>
```

`POST /session` 本身还没有 client ID；Harness 在 create 响应中签发。`POST /session/:id/load` 可以不携带旧 client ID 并获得新的 attachment。Prompt、cancel、detach、close 和 SSE 必须使用 binding 当前记录的 `harnessClientId`，不能由请求调用方自行指定；status/transcript 是内部只读对账接口，客户端仍应携带该 ID，但权限边界继续由 bearer、boot fencing 和 Java 侧公共 ID 鉴权保证。

稳定失败：

| 场景                                         | HTTP          | code                                 |
| -------------------------------------------- | ------------- | ------------------------------------ |
| 缺失或不支持协议版本                         | 426           | `hosted_harness_protocol_required`   |
| boot ID 格式非法                             | 400           | `invalid_hosted_harness_boot_id`     |
| boot ID 与当前进程不一致                     | 409           | `hosted_harness_generation_mismatch` |
| capability digest 不符合 Java admission 策略 | Java 本地拒绝 | `managed_capability_mismatch`        |

426 响应同时返回 `Upgrade: qwen-hosted-harness/1`。

SSE 200 响应也返回当前 boot ID。Java 同时校验 boot ID、event epoch 和 event sequence：

- boot ID 改变：Harness 进程代际改变；
- event epoch 改变：该 Session 的事件总线代际改变；
- sequence 回退或冲突：协议错误。

三者都不能通过把 cursor 清零后继续直播来掩盖，必须先进入 snapshot/transcript 对账。

### 5.3 v1 操作集合

P3 使用现有路由，不复制第二套模型循环入口：

| 操作       | 路由                          | v1 语义                                         |
| ---------- | ----------------------------- | ----------------------------------------------- |
| create     | `POST /session`               | caller 提供 `sessionId`，scope 固定 `thread`    |
| load       | `POST /session/:id/load`      | 重新附着已持久化 Harness Session                |
| submit     | `POST /session/:id/prompt`    | caller 提供 `promptId`，相同 payload 可幂等重试 |
| events     | `GET /session/:id/events`     | `Last-Event-ID + event epoch` 重放和直播        |
| cancel     | `POST /session/:id/cancel`    | 首版仍是 Session 当前 Turn cancel               |
| heartbeat  | `POST /session/:id/heartbeat` | 保持当前 Java attachment 存活                   |
| status     | `GET /session/:id/status`     | 查询 live Session 和 pending Prompt             |
| transcript | `GET /session/:id/transcript` | 分页读取持久记录，用于对账                      |
| detach     | `POST /session/:id/detach`    | 只释放 Java client attachment                   |
| close      | `DELETE /session/:id`         | 销毁 Harness Session                            |

P3 不新增 `/managed/sessions*` 依赖。实验路由继续存在但不进入产品链路。

## 6. qwen-code Java 参考客户端

在 `packages/sdk-java/qwencode` 增加 Hosted Harness 专用 transport，不把公共 Agent API DTO 放入该包。

建议公开接口：

```java
interface HostedHarnessClient extends AutoCloseable {
    HostedHarnessCapabilities capabilities();

    HarnessSessionRef createSession(CreateHarnessSession request);

    HarnessSessionRef loadSession(LoadHarnessSession request);

    PromptReceipt submitTurn(SubmitHarnessTurn request);

    HarnessEventStream streamEvents(StreamHarnessEvents request);

    void cancelTurn(CancelHarnessTurn request);

    HarnessHeartbeat heartbeat(HeartbeatHarnessSession request);

    HarnessSessionStatus getStatus(GetHarnessStatus request);

    HarnessTranscriptPage getTranscript(GetHarnessTranscript request);

    void detachSession(DetachHarnessSession request);

    void closeSession(CloseHarnessSession request);
}
```

v1 DTO 最小字段：

```text
CreateHarnessSession
  harnessSessionId
  approvalMode

LoadHarnessSession
  harnessSessionId

HarnessSessionRef
  harnessSessionId
  harnessClientId
  harnessBootId
  harnessControlCwd

SubmitHarnessTurn
  HarnessSessionRef
  promptId
  promptContent
  payloadDigest
  optionalDeadline

PromptReceipt
  promptId
  lastEventId
  eventEpoch

StreamHarnessEvents
  HarnessSessionRef
  lastEventId
  eventEpoch
  optionalSnapshot
```

P3 的 Harness 使用启动时固定的、无租户业务文件的 `harnessControlCwd`。create/load 不接收公共 workspace path，也不把 Java 业务 workspace 映射成本机 cwd。Java 在自己的 Session binding 中保存 `workspaceId`，`HarnessSessionResolver` 再用 `harnessSessionId` 把它解析为 Runtime Broker 的 `RuntimeScope`。`sessionScope` 在 transport 内固定为 `thread`，不开放给产品调用方选择。

实现要求：

1. 复用 `HttpSupport`、`JsonSupport` 和 `SseReader`，不引入 Spring；
2. 客户端创建时完成 capability negotiation，并固定 boot ID；
3. 所有 Session 请求自动附加 protocol 和 boot fencing header；
4. create/load 返回并校验 `harnessClientId`，其余 Session 请求自动携带；
5. `SubmitHarnessTurn` 必须携带 caller `promptId` 和 payload digest；
6. daemon 返回不同 prompt ID 时按 outcome unknown 处理；
7. mutation 遇到 408/5xx 仍按 outcome unknown 处理，不自动换 ID；
8. SSE 暴露原始 `DaemonEvent`、event ID 和 epoch，不分配公共 sequence；
9. 对已 attach 的 Session 提供 bounded 自动 heartbeat：同一 attachment 最多一个 in-flight heartbeat，失败不重试同一 mutation，下一周期是新 keepalive；
10. `close()` 只关闭 Java transport 和 heartbeat 资源，不隐式销毁全部远端 Session；
11. 单 Session 同时只允许一个 running Turn，跨 Session 可以并发；
12. Java 11、Maven test 和 Checkstyle 必须通过。

现有 `DaemonClient` 保持通用 daemon SDK；Hosted Harness 客户端可以在同一个 artifact 内复用它的 package-private transport，但不能要求普通 daemon 用户发送私有 header。

### 6.1 create outcome unknown

Java 先生成 `harnessSessionId`，再发送 create。出现响应丢失时执行：

```text
create(harnessSessionId)
  -> success: 保存 binding
  -> outcome unknown:
       load(harnessSessionId)
         -> found: 保存 binding
         -> not found: 用同一 harnessSessionId 重试 create 一次
         -> generation mismatch: 进入 RECOVERY_REQUIRED
```

重试不能生成新 Session ID。

### 6.2 Prompt admission outcome unknown

Java 先持久化 `promptId + payloadDigest`，再发送 submit。相同 Prompt 重试必须携带完全相同的 prompt content 和 deadline：

```text
submit(promptId, payloadDigest)
  -> 202: 保存 admission watermark
  -> outcome unknown: 用同一 promptId 和相同 payload 重试
  -> 202: 视为原 Turn
  -> 409 prompt_id_conflict: fail closed，禁止生成新 promptId 补发
```

Harness 已具备同 prompt ID、同 payload 的 admission 复用语义；qwen-code Java SDK 需要把 caller prompt ID 暴露出来并补齐契约测试。

## 7. Java 产品服务组件

### 7.1 ManagedAgentCoordinator

产品 Java 新增一个应用服务，Controller 不直接调用 Harness 或 Broker：

```java
interface ManagedAgentCoordinator {
    ManagedSession createSession(CreateManagedSession command);

    ManagedTurn submitTurn(SubmitManagedTurn command);

    void cancelTurn(CancelManagedTurn command);

    ManagedSessionView getSession(AuthorizedSessionRef session);

    EventStream streamEvents(OpenManagedEventStream query);

    void closeSession(CloseManagedSession command);
}
```

它只组合以下依赖：

```text
AgentSessionRepository
AgentTurnRepository
SessionBackendBindingRepository
PublicEventStore
ManagedOutbox
HarnessClient
RuntimeBrokerService
TenantWorkspaceAuthorizer
```

Controller 只接收公共 ID。Coordinator 在鉴权后解析 Harness ID，任何来自请求体的 tenant、workspace、cwd、Harness endpoint 或 Runtime ID 都不能成为权限依据。

`HarnessSessionResolver` 由产品 Java 实现，只按已提交的 `harnessSessionId` 查询 `SessionBackendBinding + AgentSession`，返回 tenant、workspace、capability 和隔离策略组成的 `RuntimeScope`。找不到、未提交、已关闭或 capability 不匹配时必须 fail closed；不能采用 Harness 请求中自报的 scope。

### 7.2 最小持久字段

产品已有表可以扩字段，不要求为 P3 重建整套 schema。至少保存：

```text
AgentSession
  publicSessionId
  tenantId
  workspaceId
  executionEngine = MANAGED
  agentRevision
  capabilityDigest
  status

SessionBackendBinding
  publicSessionId
  harnessEndpointId
  harnessBootId
  harnessClientId
  harnessProtocolVersion
  harnessSessionId
  state
  lastHeartbeatAt

AgentTurn
  publicTurnId
  publicSessionId
  clientIdempotencyKey
  promptId
  promptPayloadDigest
  status
  terminalReason

PublicEvent
  publicSessionId
  eventSequence
  sourceRef
  publicTurnId
  type
  payload

ManagedOutbox
  outboxId
  aggregateId
  kind
  idempotencyKey
  payload
  status
  nextAttemptAt
```

唯一约束：

```text
(tenantId, clientSessionIdempotencyKey)
(publicSessionId, clientTurnIdempotencyKey)
(harnessSessionId, promptId)
(publicSessionId, eventSequence)
(sourceRef, publicEventType)
(outbox.kind, outbox.idempotencyKey)
```

Runtime binding、lease、endpoint 和 token 仍由 Runtime Broker 管理，不复制到产品表。

## 8. 第一条 Prompt 的精确时序

### 8.1 Session 尚未绑定 Harness

```text
T0  Java 完成鉴权，生成 publicSessionId / harnessSessionId / publicTurnId / promptId
T1  单个事务写入 Session、Binding(CREATING)、Turn(ADMITTED)、input Item、两个 Outbox
T2  事务提交，HTTP 立即返回 Session/Turn ID，SSE 可以建立
T3  after-commit dispatcher 并行启动：
      A. ensure Harness Session -> submit Prompt
      B. RuntimeBroker.warm(harnessSessionId)
T4  Harness 调用模型，Java 接收并投影首个 delta
T5  如果没有 Tool Call，Turn 可在 Runtime 未 ready 时完成
T6  如果出现 Tool Call，Harness 通过 Broker 等待原 binding
T7  Runtime ready 后只执行一次，Tool Result 回到同一 Harness Turn
T8  Java 投影 terminal，Turn 完成
```

Harness create 和 submit 在同一分支内顺序执行；Runtime warm 与这条分支并行。不得先等待 warm 再 create/submit。

### 8.2 Session 已绑定 Harness

后续 Turn 不再 create/load Session：

```text
transaction(admit Turn + outbox)
  -> parallel after commit
       Harness submit(promptId)
       Broker warm(harnessSessionId)  // 幂等，通常立即复用
```

### 8.3 Outbox 派发策略

网络调用不能放在数据库事务中。事务提交后使用两层派发：

1. in-process after-commit 立即调度，保证低延迟；
2. durable outbox dispatcher 兜底，保证进程在提交后崩溃仍能恢复。

两层使用相同 idempotency key。立即调度成功后更新 outbox；与后台 dispatcher 竞争时依赖唯一键和 Harness/Broker 幂等，而不是 JVM 锁。

## 9. 事件投影与 SSE

Java 不把 Harness SSE 原样透传给用户。每个 Session 使用一个串行 projector：

```text
Harness event
  -> 校验 bootId / eventEpoch / eventId / promptId
  -> sourceRef = harnessBootId:eventEpoch:eventId
  -> 用 promptId 查 publicTurnId
  -> 幂等投影 Item / Turn 状态
  -> 分配 public eventSequence
  -> 持久化 durable event
  -> 发布 Java SSE
```

首版映射：

| Harness 事件             | 公共事件                                                |
| ------------------------ | ------------------------------------------------------- |
| Prompt 202               | `turn.accepted`                                         |
| assistant text delta     | `item.output_text.delta`                                |
| thought delta            | 内部诊断；默认不公开                                    |
| tool call created/update | `item.created` / `item.tool_output.delta`               |
| permission request       | `turn.requires_action`                                  |
| turn complete            | `item.completed` + `turn.completed` 或 `turn.cancelled` |
| turn error               | `turn.failed`                                           |
| snapshot 对账            | `stream.reconciled`                                     |

规则：

- public `eventSequence` 在单 Session 内严格单调，由 Java 分配；
- `sourceRef` 唯一，Harness 重连不会重复生成公共事件；
- preview delta 可以有界保留，完整 Item 和 terminal 必须持久化；
- SSE `id` 使用 public `eventSequence`，支持 `Last-Event-ID`；
- Client 断开只取消订阅，不取消 Turn；
- terminal 之后到达的非终态 Harness 事件只记诊断，不修改权威状态。

## 10. 取消与故障语义

### 10.1 显式取消

`cancelTurn` 顺序：

1. 鉴权并锁定 public Turn；
2. terminal Turn 直接幂等返回；
3. 写入 `CANCEL_REQUESTED` 和 cancel outbox；
4. after commit 调用 Harness cancel；
5. Harness 使用自己持有的 `runtimeSessionId + executionCallId` 取消精确的 Broker execution；
6. Java 以最终 Harness terminal 对账，Broker/Runtime cancel 结果由 Harness 事件和内部观测关联；
7. 迟到的 tool result 不能覆盖 `CANCELLED`。

Java Prompt 服务不在工具数据路径上，也不持有 `runtimeSessionId` 或 `executionCallId`，因此 P3 不从产品 Controller 直接调用 Broker cancel。Harness 不可达时 cancel 保持 `CANCEL_REQUESTED` 并用相同操作重试，不能猜测 execution ID。P3 仍复用 Session 当前 Turn cancel，因此 Coordinator 必须验证目标 `publicTurnId` 正是该 Session 当前活动 Turn。真正的 prompt-targeted cancel 可以作为后续私有协议版本新增，不能在 v1 假装已支持。

### 10.2 故障决策表

| 故障                              | Java 行为                                               | 禁止行为                       |
| --------------------------------- | ------------------------------------------------------- | ------------------------------ |
| Harness 未连接                    | 新 Managed Session admission 失败或不进入灰度           | 创建后回落 Legacy              |
| Harness boot ID 改变              | binding 标记 `RECOVERY_REQUIRED`，先 load/snapshot 对账 | 直接清 cursor 继续             |
| Prompt submit outcome unknown     | 同 prompt ID、同 payload 重试                           | 生成新 prompt ID               |
| Runtime warm 失败、尚无 Tool Call | 记录 environment failure，模型流继续                    | 提前终止无工具 Turn            |
| Tool Call 时 Runtime 不可用       | Turn 失败或等待明确恢复策略                             | 换 Runtime generation 自动重放 |
| Broker execute outcome unknown    | 查询原 executionCallId                                  | 新建 executionCallId           |
| Java SSE client 断开              | 保持 Turn 运行                                          | 隐式 cancel                    |
| Java 重启                         | P3 标记恢复中；P6 完成自动恢复                          | 假设 in-memory 状态仍可靠      |

## 11. 多租户与部署

第一阶段推荐每个 Java 产品实例同机运行一个 Hosted Harness 进程：

```text
Java instance 1 <-> Harness process 1
Java instance 2 <-> Harness process 2
```

每个 Harness 是常驻、多 Session 的进程，不是每请求一个进程，也不是每 Session 一个 Pod。Session 隔离由 Java binding、Harness Session ID、独立 Context 和 Runtime workspace scope 保证。

Harness 的 primary workspace 是部署级 control workspace，只放共享 agent 配置和 Session 持久化元数据，不放任何租户代码或业务文件。业务 tenant/workspace 路径只存在于 Java 权威映射和 Tool Runtime scope 中。P3 不开放 Hosted Harness 的动态 workspace 注册接口；需要不同 agent capability 的租户使用不同 capability digest 的 Harness pool。

如果以后拆成共享 Harness 集群，仍使用相同协议，但调度器必须按 `harnessEndpointId + bootId` 做粘性路由。共享 Session Authority 和 snapshot 恢复完成前，不能把活动 Turn 在 Harness 实例之间任意负载均衡。

容量模型不是“每个请求一个 Harness worker”，而是“每个 Java 实例一个或少量常驻 Harness 进程，每个进程承载多个 Session”。部署必须设置 `maxSessions`、`maxPendingPromptsPerSession` 和 Java 侧 admission 水位。容量不足时只对尚未创建的新 Session 返回 capacity unavailable，或在 owner 决策前选择 Legacy；已经绑定的 Managed Session 保持原 endpoint，不能为了腾容量迁移活动 Turn。该模型既可由 systemd/本地 supervisor 管理，也可运行在 Pod 内，不依赖 Kubernetes 才成立。

安全要求：

- P3 Hosted Harness 严格绑定 loopback；未来拆成共享集群时才单独设计受控内网认证和服务发现；
- profile 强制 bearer auth；
- service token、Runtime token、endpoint、boot ID 不进入公共响应；
- 日志不记录 Prompt 正文、完整 Tool 输出或凭证；
- Java 每次从公共 ID 重新解析 tenant/workspace；
- Harness create/load 不接收请求体中的 tenant/workspace/cwd；
- Runtime 只接受 Broker 签发的 scope、lease 和 fencing epoch。

## 12. 实施切片

### P3a：qwen-code 私有协议 fencing

改动范围：

- `packages/cli/src/serve/capabilities.ts`
- `packages/cli/src/serve/types.ts`
- `packages/cli/src/serve/hosted-harness-profile.ts`
- `packages/cli/src/serve/routes/capabilities.ts`
- 新增 `packages/cli/src/serve/hosted-harness-contract.ts`
- `packages/cli/src/serve/server.ts`
- `packages/cli/src/serve/run-qwen-serve.ts`
- 对应 collocated tests

产物：

- `hosted_harness_private_v1` capability；
- `hostedHarness.protocolVersions / bootId / capabilityDigest`；
- Hosted Harness profile 缺失或非法 capability digest 时启动失败；
- `/session*` protocol 和 boot fencing middleware；
- 稳定错误码；
- ordinary daemon 行为完全不变。

验收：普通 profile 不要求私有 header；Hosted Harness 缺 header、错版本、错 boot ID 分别稳定失败；bootstrap 与 steady-state capability 的 boot ID 相同；正确 header 的 create/prompt/events/cancel 全部通过。

### P3b：qwen-code Java Hosted Harness client

改动范围：

- `packages/sdk-java/qwencode/src/main/java/com/alibaba/qwen/code/daemon/`
- `packages/sdk-java/qwencode/src/test/java/com/alibaba/qwen/code/daemon/`
- `packages/sdk-java/qwencode/README.md`

产物：

- Hosted Harness capability negotiation；
- caller-supplied prompt ID；
- create/load/submit/events/cancel/heartbeat/status/transcript/detach/close；
- protocol 和 boot header 自动附加；
- mutation outcome unknown 和 SSE epoch 契约测试。

验收：Java 11 `mvn clean test checkstyle:check`；in-process HTTP fixture 验证每条 header、ID、cursor 和错误映射。

### P3c：产品 Java Coordinator

改动范围在真实 Java 产品仓，不放进 qwen-code Runtime Broker 包：

- `ManagedAgentCoordinator`；
- Session/Turn/Binding/Event/Outbox Repository 接缝；
- `HarnessClient` 产品接口和 qwen transport adapter；
- per-Session event projector；
- existing DataAgent Controller 接入；
- feature flag 和 admission policy。

验收：真实产品请求可以创建 Managed Session、提交 Prompt、流式返回、取消和查询终态；Controller 中不存在直接 Harness/Broker 调用。

### P3d：联合真实进程 E2E

拓扑：

```text
Java Prompt fixture
  + Fake Model Server
  + 真实 Hosted Harness
  + 真实 Java Runtime Broker
  + 真实 Tool Runtime worker
```

必须覆盖：

1. 15 秒 Runtime 冷启动，首模型 delta 先到；
2. 无 Tool Turn 在 Runtime 未 ready 时完成；
3. Tool Turn 等待原 binding，physical execute = 1；
4. Prompt 202 响应丢失，同 prompt ID 重试只产生一个 Turn；
5. Harness boot ID mismatch fail closed；
6. SSE 重连无重复公共事件；
7. cancel before Runtime ready，physical execute = 0；
8. cancel during Tool，完整进程树退出；
9. 两租户并发，Context、事件、workspace 和文件不串扰；
10. Legacy Session 继续走旧链路，不能被 Managed API 隐式升级。

## 13. 提交顺序

严格按以下顺序，不并行扩面：

1. `feat(serve): version hosted harness private contract`
2. `feat(java): add hosted harness transport`
3. 产品 Java：`feat(agent): coordinate managed harness turns`
4. 联合 E2E：`test(managed): verify product hosted runtime flow`
5. 产品灰度和观测
6. P3 稳定后进入 P6 Runtime Broker 持久化与 Java 重启恢复
7. P6 完成后再进入 P7 OpenAI Managed Agents Adapter

每个提交必须可独立回滚。私有协议、产品 Coordinator、数据库迁移和公网 API 不能合并成一个大 PR。

## 14. 测试与观测门槛

必须输出：

```text
managed_prompt_admission_ms
managed_harness_session_ready_ms
managed_first_model_event_ms
managed_runtime_ready_ms
managed_tool_wait_runtime_ms
managed_turn_total_ms
managed_prompt_deduplicated_total
managed_event_deduplicated_total
managed_harness_generation_mismatch_total
managed_execution_deduplicated_total
managed_cancel_process_tree_ms
```

发布门槛：

- P95 `first_model_event_ms` 不随 Runtime 冷启动时长增加；
- 相同 prompt ID 的 admission count = 1；
- 相同 executionCallId 的 physical execute count <= 1；
- Java/Harness/Broker/Runtime 任一失败都没有 Legacy fallback；
- Harness 代际改变不会造成 Session owner 漂移；
- SSE 重连公共事件无重复、无 sequence 回退；
- 多租户隔离测试无 Context、事件、Artifact 或 workspace 泄漏；
- 旧 `qwen serve` 和 Legacy Session 回归测试通过。

## 15. 灰度与回滚

灰度 admission 在创建 Session 之前决定：

```text
tenant allowlist
AND workspace eligible
AND Harness capability compatible
AND product feature flag enabled
=> executionEngine = MANAGED
```

否则新 Session 仍可选择 Legacy。Session 创建并写入 `MANAGED` 后，任何故障都只能在 Managed 链路恢复或失败，不能切换 owner。

推荐灰度顺序：

1. shadow：仅建立内部对象和事件投影，不改变外部响应；
2. 白名单 tenant 的新 Session；
3. 只开放无 Tool 场景；
4. 开放受控 Tool 集合；
5. 扩租户和 workspace；
6. P6 恢复验证后提高流量。

回滚只关闭新的 Managed admission。已有 Managed Session 继续由原 Harness binding 完成；如果原 Harness 不可恢复，给出明确失败，不把 Turn 交给 Legacy 重做。

## 16. 开工前确认清单

产品 Java 仓只需补充以下事实，不再重新讨论总体架构：

- Prompt admission 的事务入口和现有 Session 表；
- 现有 SSE event store 是否支持单 Session 单调 sequence；
- after-commit executor 和 durable outbox 的现成实现；
- tenant/workspace 鉴权入口；
- Harness endpoint 的部署和服务 token 注入方式；
- 首批允许的 tenant、workspace、模型和 Tool 白名单；
- capability digest 的生成来源；
- preview event 保留期、最大 payload 和慢消费者策略。

如果产品仓暂时没有 durable outbox，首个联调可以用 in-process after-commit dispatcher，但只能作为开发验证，不能进入生产灰度。

## 17. 下一步

当前直接执行 P3a。P3a 合入后执行 P3b，并用现有 Managed Hosted Runtime E2E 替换成带协议 fencing 的 Java client。产品 Java 团队可同时只做代码接缝确认和 Repository 映射，不要提前实现 OpenAI Controller。

P3a + P3b 完成的判断不是“新增了几个类”，而是 Java 能用一个版本化、带 Harness generation fencing、caller prompt ID 可重试的私有客户端完整操作现有 `/session` 链路。
