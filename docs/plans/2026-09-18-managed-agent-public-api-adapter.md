# Managed Agent 公共 Agent API 适配层执行方案

状态：待执行

更新日期：2026-09-18

上游方案：[Managed Agent Hosted Runtime 可执行技术方案](./2026-09-17-managed-agent-hosted-runtime-execution.md)

相关实现阶段：[Managed Agent Java 自有 Runtime 生命周期执行方案](./2026-09-17-managed-agent-java-owned-runtime-lifecycle.md)

## 1. 结论

公共 Agent API 放在 Java 产品服务，不放进 Hosted Harness，也不放进 Runtime Broker。Java 先建立一套供应商无关的 `Agent / Session / Turn / Item / Artifact / Event` 应用模型，再在其上提供不同 HTTP Adapter：

```text
DataAgent API ───────────────┐
OpenAI Managed Agents API ──┼─> Java AgentSessionApplicationService
Responses API（后续）───────┤       -> ManagedAgentCoordinator
Claude Session API（后续）──┘           -> HarnessClient
                                          -> RuntimeBrokerService.warm()
                                          -> PublicEventStore

Hosted Harness
  -> 模型循环、上下文、工具编排
  -> Tool Call 通过 Java Runtime Broker 执行

Tool Runtime
  -> Workspace、Tool、MCP、Skill 和副作用
```

首个兼容目标选择 OpenAI Managed Agents Session API，而不是直接实现完整 Responses API，原因是当前架构本身就是长生命周期 Session：

- 创建 Session 时可以同时提交第一条输入；
- 后续输入、取消和工具结果通过 Session Event 提交；
- 输出通过 Session Event 流返回；
- Turn、Item、Artifact 和 Subagent 都是 Session 下的资源；
- Java 可以继续保持 Session、权限、事件和 Runtime binding 的权威所有权。

Responses API 在第二阶段实现为另一个 Adapter：一个 Response 映射为一个 Turn，而不是另建模型循环或复制 Session 状态。

## 2. 当前代码基线与缺口

以当前分支 `f152aa7afd` 为已提交基线：

- Hosted Harness 已有 `qwen serve --profile hosted-harness`，通过私有 `/session` 链路运行完整模型循环。
- Harness 已通过 `BrokerManagedRuntimeProvider` 调用 Java Runtime Broker，不接触 Runtime endpoint、token 和 lease。
- Java `RuntimeBrokerService` 已实现 scope 解析、Runtime binding、执行幂等、取消和释放。
- `LocalProcessRuntimeProvisioner` 已由 Java 持有本地 Runtime 生命周期。
- 现有 daemon 已有创建 Session、提交 Prompt、SSE events、取消、transcript、turn index 和 artifact 等内部能力。

当前还不能称为公共 Agent API，缺口是：

1. Java 侧没有 `ManagedAgentCoordinator` 和权威 Session/Turn/Item 数据模型。
2. Java 侧没有 `HarnessClient`，产品服务还不能稳定创建、恢复、提交和取消 Harness Session。
3. Java 侧没有持久化 `PublicEventStore`，无法保证 SSE 重连、查询和重启恢复。
4. 公共 ID 与 `harnessSessionId`、`runtimeSessionId`、`executionCallId` 尚未分离。
5. 现有 `/session` 和 `/managed/sessions*` 是 Harness/daemon 私有接口，不是对外兼容层。
6. Agent 定义、环境、权限、工具归属和 capability digest 尚未在 Session 创建时冻结。
7. 还没有 OpenAI/Claude 风格对象与内部对象之间的稳定映射和契约测试。

## 3. 范围

### 3.1 首个可上线范围

- 创建、查询、列出和删除 Managed Agent Session；
- 创建 Session 时可选提交第一条用户消息；
- 向已有 Session 提交用户消息或取消事件；
- 查询 Turn 和 Item；
- SSE 流式接收文本、工具进度、Turn 状态和错误；
- 列出和下载已发布的不可变 Artifact；
- `Idempotency-Key`、事件游标和断线重连；
- 第一条 Prompt 同时启动 Harness 推理和 Runtime warm，TTFT 不等待 Runtime；
- 现有 DataAgent API 与新 Adapter 读取同一份 Session/Turn/Item 数据。

### 3.2 首版明确不做

- 不让外部请求直接指定 Runtime URL、Pod、容器、token、lease 或本地路径；
- 不承诺 OpenAI 或 Claude 所有 beta 字段均可用；不支持的字段明确返回稳定错误；
- 不在 Adapter 内实现模型循环、工具执行或 Session 恢复；
- 不把旧 Legacy Session 自动切换成 Managed；
- 不在首版开放客户端自定义 Function Tool 回调；
- 不实现跨供应商 ID 互换，例如把外部 OpenAI Session ID 当作内部 Harness ID；
- 不实现 Responses API 的所有 built-in tools、conversation storage 和 background mode；
- 不把 Kubernetes Provisioner 作为公共 API 上线前置条件。

## 4. 组件边界

| 组件                             | 职责                                               | 不负责                                   |
| -------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| HTTP Adapter                     | 供应商 schema、路径、错误和 SSE frame 映射         | Session 权威状态、Harness/Runtime 调度   |
| `AgentSessionApplicationService` | 公共命令与查询入口、鉴权后的 scope、事务边界       | 模型循环、工具执行                       |
| `ManagedAgentCoordinator`        | 创建/恢复 Harness、并行 warm、提交、取消、事件投影 | HTTP schema、Runtime 传输细节            |
| `HarnessClient`                  | 调用 Hosted Harness 私有协议                       | 租户鉴权、公共 ID、数据库事务            |
| `PublicEventProjector`           | Harness 事件到公共 Item/Event 的确定性转换         | 直接订阅浏览器、执行 Tool                |
| `RuntimeBrokerService`           | Runtime binding、执行幂等、取消、生命周期          | 公共 Agent/Session API                   |
| Hosted Harness                   | 模型 Context、Agent Loop、工具编排                 | 公共租户鉴权、Runtime 调度凭证           |
| Tool Runtime                     | Workspace 副作用和本地能力                         | 用户 Prompt、公共 Session 状态、模型凭证 |

`packages/sdk-java/runtime-broker` 保持 Runtime 专用，不加入 Agent API DTO。公共 API 应位于真实 Java 产品服务；qwen-code 仓库只维护 Harness 私有契约、参考客户端、契约测试和端到端夹具。

## 5. 内部权威对象

### 5.1 AgentDefinitionRevision

Session 必须绑定不可变的 Agent revision：

```text
agentId
agentRevision
modelPolicyRef
instructionsRef
toolPolicyRef
permissionPolicyRef
capabilityDigest
createdAt
```

外部 `agent_id` 解析为 revision；允许 inline agent 时，Java 先把它规范化为一次性的不可变 revision，再创建 Session。Session 创建后不得静默跟随 Agent 配置更新。

### 5.2 AgentSession

```text
publicSessionId
tenantId
workspaceId
agentId
agentRevision
executionEngine = managed
workspaceGeneration
capabilityDigest
status
createdAt
lastActiveAt
metadata
version
```

`publicSessionId` 是所有外部 Adapter 共用的稳定 ID。Harness owner、Harness Session、Runtime Session 和 execution ID 都位于单独的 backend binding 中，不得返回给客户端。

Session 状态：

```text
CREATING -> IDLE <-> IN_PROGRESS
                    |-> REQUIRES_ACTION
                    |-> FAILED
IDLE/FAILED -> DELETING -> DELETED
任意非终态 -> RECOVERY_BLOCKED
```

供应商 Adapter 可以把 `RECOVERY_BLOCKED` 投影为 `failed`，但必须保留稳定错误码 `recovery_blocked`，不能将其伪装成可自动重试。

### 5.3 SessionBackendBinding

```text
publicSessionId
executionEngine = managed
harnessOwnerId
harnessGeneration
harnessSessionId
harnessProtocolVersion
workspaceGeneration
capabilityDigest
status
version
```

`harnessOwnerId` 指向 Java 已配置和认证的 Harness 实例或服务发现记录，不是客户端提供的地址。Session 创建后固定 owner；只有原 Turn 已终止且恢复协议证明可接管时，才能更新 generation/owner。

### 5.4 Turn

```text
publicTurnId
publicSessionId
inputItemIds
status
promptId
submittedAt
startedAt
completedAt
errorCode
usage
```

Turn 状态：

```text
ACCEPTED -> QUEUED -> IN_PROGRESS
                       |-> REQUIRES_ACTION
                       |-> COMPLETED
                       |-> FAILED
                       |-> CANCELLED
                       `-> RECOVERY_BLOCKED
```

同一 Session 首版只允许一个可执行 Turn。用户可以在 `IDLE` 时提交下一轮；中途 steering 作为后续独立能力，不在首版借用普通 message 实现。

### 5.5 Item

内部采用封闭判别联合：

```text
input_message
assistant_message
reasoning_summary
tool_call
tool_result
approval_request
approval_result
artifact_ref
error
```

每个 Item 都有：

```text
publicItemId
publicSessionId
publicTurnId
type
status
contentRef / payload
createdAt
completedAt
sourceRef
```

`sourceRef` 只用于 Java 内部去重，例如 `harnessSessionId + harnessEventSequence`，公共响应不得暴露它。

### 5.6 Artifact

首版只暴露完成 Turn 已发布的不可变 Artifact：

```text
publicArtifactId
publicSessionId
publicTurnId
title
mimeType
sizeBytes
digest
storageRef
createdAt
```

下载必须经过 Java 鉴权和受控内容读取，不允许客户端把 Artifact ID 拼接成 Runtime 文件路径，也不允许 Java 返回 Runtime endpoint。

## 6. Repository 与事务

P6 持久化阶段统一提供以下 Repository，不为每个 Adapter 建独立表：

| Repository                        | 唯一键                                            | 用途                                                 |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `AgentSessionRepository`          | `publicSessionId`                                 | 公共 Session 元数据和状态                            |
| `SessionBackendBindingRepository` | `publicSessionId`                                 | Harness owner/session、generation、协议版本和 engine |
| `TurnRepository`                  | `publicTurnId`、`publicSessionId + promptId`      | Turn 幂等与终态                                      |
| `ItemRepository`                  | `publicItemId`、`sourceRef`                       | 权威 transcript 投影和事件去重                       |
| `ArtifactRepository`              | `publicArtifactId`                                | Artifact 元数据和所有权                              |
| `PublicEventStore`                | `publicSessionId + eventSequence`                 | SSE 重连与审计                                       |
| `CommandLedger`                   | `tenantId + operation + scopeId + idempotencyKey` | create/submit/cancel 批次幂等                        |
| `OutboxRepository`                | `outboxId`                                        | 事务提交后的 Harness/Runtime 派发                    |

P6 已定义的 `RuntimeBindingRepository` 和 `ToolExecutionRepository` 继续由 Runtime Broker 使用。公共 API Repository 只保存对它们的稳定引用，不复制 lease、token、endpoint 或物理执行回执。

Session 创建事务必须同时完成：

1. 校验并固定 tenant、workspace、Agent revision 和 capability digest；
2. 写入 Session 与 backend binding；
3. 如果带初始 input，写入 Turn、input Item 和 `turn.accepted` 公共事件；
4. 仅当请求包含初始 input 时，写入 `WARM_RUNTIME` 和 `SUBMIT_HARNESS_TURN` 两条 outbox；空 Session 不启动 Runtime；
5. 提交事务后并行执行两条 outbox，不能先等待 Runtime 再提交 Harness。

后续 message admission 使用相同事务模式创建 Turn、input Item 和两条 outbox。同一 operation/scope 下，相同 `Idempotency-Key` 与相同规范化请求 digest 返回原结果；同 key 不同 digest 返回 `409 idempotency_conflict`。digest 必须包含已认证 scope 和规范化 payload。数据库唯一索引是最终保证，JVM 锁只用于减少竞争。

## 7. Java 应用接口

内部接口不使用 OpenAI 或 Claude DTO：

```java
interface AgentSessionApplicationService {
    CreateSessionResult createSession(CreateSessionCommand command);
    SessionView getSession(AuthorizedSessionRef session);
    Page<SessionView> listSessions(ListSessionsQuery query);
    SubmitEventsResult submitEvents(SubmitEventsCommand command);
    EventStream openEventStream(OpenEventStreamQuery query);
    Page<TurnView> listTurns(ListTurnsQuery query);
    TurnView getTurn(AuthorizedTurnRef turn);
    Page<ItemView> listItems(ListItemsQuery query);
    Page<ArtifactView> listArtifacts(ListArtifactsQuery query);
    ArtifactContent openArtifact(AuthorizedArtifactRef artifact);
    void deleteSession(DeleteSessionCommand command);
}
```

所有 command/query 必须携带已认证的 `PrincipalScope`，由 Java 根据公共 ID 重新解析 tenant/workspace。Adapter 传入的 tenant、workspace、cwd、Harness ID 和 Runtime ID 一律不作为权限依据。

## 8. HarnessClient 私有契约

Java 通过一个稳定客户端封装现有 Hosted Harness `/session` 能力：

```java
interface HarnessClient {
    CompletionStage<HarnessSessionRef> createSession(
            CreateHarnessSession command);
    CompletionStage<Void> loadSession(LoadHarnessSession command);
    CompletionStage<PromptReceipt> submitTurn(SubmitHarnessTurn command);
    HarnessEventStream streamEvents(StreamHarnessEvents query);
    CompletionStage<Void> cancelTurn(CancelHarnessTurn command);
    CompletionStage<HarnessSnapshot> getSnapshot(GetHarnessSnapshot query);
    CompletionStage<Void> closeSession(CloseHarnessSession command);
}
```

私有请求至少带：

- `protocolVersion`；
- `harnessOwnerId`、`harnessGeneration` 和 `harnessSessionId`；
- 稳定的 `publicTurnId`、`promptId`；
- `agentRevision` 和 `capabilityDigest`；
- 服务身份 token；
- 可选 deadline。

Harness 事件至少带 `harnessEventEpoch`、`harnessEventSequence`、`publicTurnId`、稳定 Item/call ID、事件类型和 payload。Java 使用 `harnessSessionId + harnessEventEpoch + harnessEventSequence` 作为 `sourceRef` 去重后，再分配公共 `eventSequence`。Harness 不分配公共 Session ID，也不根据请求体决定 tenant/workspace。

一个活动 Turn 固定到 `SessionBackendBindingRepository` 中记录的 Harness owner/generation。Harness event epoch 改变时，Java 不得继续使用旧 sequence；必须先读取 snapshot/transcript 完成对账，再从新 epoch 订阅。共享 Session Authority 尚未完成前，不允许在 Turn 中途漂移到任意 Harness 实例。

首阶段可以继续复用现有 `/session`、`/session/:id/prompt`、`/session/:id/events`、`/session/:id/cancel` 和 transcript/status 路由；在接入产品前增加协议版本与契约测试，不新增第二套模型循环入口。

## 9. 公共事件协议

事件分两类：

1. **权威事件**：状态变化、完整 Item、完整 Artifact、错误和 usage；持久化到 `PublicEventStore`，可查询和重放。
2. **预览事件**：文本 delta、工具输出 delta；用于降低 TTFT，可写入有界保留的 replay log，但不作为最终 transcript 权威，过期后必须能通过 Item snapshot 对账。

统一事件信封：

```json
{
  "eventId": "evt_...",
  "eventSequence": 42,
  "sessionId": "sess_...",
  "turnId": "turn_...",
  "itemId": "item_...",
  "type": "item.output_text.delta",
  "createdAt": 1789689600123,
  "data": {}
}
```

规则：

- `eventSequence` 在单 Session 内严格单调，由 Java 分配；
- `(sourceRef, event type)` 唯一，Harness 重连不能重复生成公共事件；
- SSE 使用 `id: <eventSequence>`；客户端通过 `Last-Event-ID` 重连；
- 如果预览 delta 已过期，Java 发送最新 `item.snapshot` 后继续直播；
- `item.completed` 中的完整内容是权威值，客户端必须用它覆盖已累积预览；
- terminal Turn 之后到达的非终态事件只记诊断，不修改权威状态；
- Client 断开只停止订阅，不取消 Turn。

首版公共事件集合：

```text
session.created
session.status.changed
environment.provisioning
environment.ready
turn.accepted
turn.started
item.created
item.output_text.delta
item.tool_output.delta
item.completed
artifact.created
turn.requires_action
turn.completed
turn.failed
turn.cancelled
session.error
stream.reconciled
```

## 10. OpenAI Managed Agents Adapter

首版路径与当前官方 Managed Agents Session 资源保持同构：

```text
POST   /v1/agents/sessions
GET    /v1/agents/sessions
GET    /v1/agents/sessions/{sessionId}
POST   /v1/agents/sessions/{sessionId}
DELETE /v1/agents/sessions/{sessionId}

POST   /v1/agents/sessions/{sessionId}/events
GET    /v1/agents/sessions/{sessionId}/events

GET    /v1/agents/sessions/{sessionId}/turns
GET    /v1/agents/sessions/{sessionId}/turns/{turnId}
GET    /v1/agents/sessions/{sessionId}/items

GET    /v1/agents/sessions/{sessionId}/artifacts
GET    /v1/agents/sessions/{sessionId}/artifacts/{artifactId}
GET    /v1/agents/sessions/{sessionId}/artifacts/{artifactId}/content
```

映射规则：

| OpenAI 对象         | 内部对象                                         |
| ------------------- | ------------------------------------------------ |
| Agent / `agent_id`  | `AgentDefinitionRevision`                        |
| Agent Session       | `AgentSession`                                   |
| input message event | 新 `Turn` + `input_message` Item                 |
| cancellation event  | 当前 Turn 的 cancel command                      |
| tool-result event   | 后续 `client_function` required action；首版拒绝 |
| Turn                | `Turn`                                           |
| AgentSessionItem    | `Item`                                           |
| SessionArtifact     | `Artifact`                                       |
| AgentSessionEvent   | `PublicEvent` 的 Adapter 投影                    |

首版兼容策略：

- `environment.type=none` 只允许不需要本地工具的 Agent；需要 Tool Runtime 时返回 `environment_required`。
- Workspace 环境使用产品侧模板或资源 ID 解析，禁止接收任意 `cwd`。
- `agent_id` 必须可解析；inline agent 仅支持已明确允许的 model、instructions 和 tool policy 字段。
- `stream=true` 在创建 Session 的同一个响应上输出 SSE；其内部仍先提交事务，再异步 warm 和 submit。
- 未实现的 `vault_ids`、client function tools、subagents 或环境类型返回 `unsupported_feature`，不能静默忽略。
- Adapter 返回 OpenAI 风格对象和事件名，但内部错误码保留在结构化 error 字段中。

## 11. Responses API Adapter（第二阶段）

Responses 兼容不新建执行内核：

```text
POST /v1/responses
GET  /v1/responses/{responseId}
POST /v1/responses/{responseId}/cancel
GET  /v1/responses/{responseId}/input_items
```

映射：

- `conversation` 映射到 `publicSessionId`；
- 一个 Response 映射到一个 `publicTurnId`；
- `input` 转为 input Item；
- `output[]` 由完成的 Item 投影；
- `stream=true` 从同一 `PublicEventStore` 投影 Responses streaming events；
- `previous_response_id` 只用于定位同一 Session 的前一 Turn，不能绕过 Session owner；
- `background=true` 映射为客户端断开不取消 Turn，而不是另起任务系统；
- 外部 function call 只有在 `client_function` 生命周期实现后开放。

第一阶段不实现 `/responses`，但内部命名禁止使用 `thread/run` 或 `response` 作为唯一核心术语，确保后续只是 Adapter 映射。

## 12. Claude Session Adapter（后续）

Claude 风格 Adapter 使用同一对象：

- `user.message` -> 新 Turn；
- `user.interrupt` -> cancel command；
- 持久 session/agent events -> 权威公共事件；
- `event_start` / `event_delta` -> 非权威预览；
- Session thread -> 主 Agent 或 Subagent thread；
- resource/output -> Session resource 或 Artifact。

这要求公共事件协议明确区分“预览 delta”和“完成 Item”，但不要求 Harness 感知 Claude schema。

## 13. 第一条 Prompt 时序

```text
Client -> Java Adapter: create Session + initial input, stream=true
Java: authenticate and resolve Agent/workspace
Java transaction:
  create Session + Turn + input Item + command ledger + outbox
Java -> Client: open SSE and emit turn.accepted
Java outbox (parallel):
  A. runtimeBroker.warm(harnessSessionId)
  B. harnessClient.create/load + submitTurn(...)
Harness -> Model: start streaming
Harness -> Java: text delta
Java -> Client: item.output_text.delta       <-- TTFT, does not wait Runtime
Runtime -> Java: ready
Java -> Client: environment.ready
Harness: if Tool Call, waits on original Broker binding
Runtime -> Broker -> Harness: Tool Result
Harness -> Java: completed Items + Turn terminal
Java transaction: persist Items/usage/status/events
Java -> Client: item.completed + turn.completed
```

硬约束：`environment.ready` 不是首个模型 token 的前置事件；发生 Tool Call 时只能等待本 Turn 已绑定的 Runtime generation，不能换 Runtime 后重放。

## 14. 失败、取消与恢复

| 场景                                 | 行为                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| Runtime warm 失败但未发生 Tool Call  | 继续模型流；记录 environment failure，若 Turn 无工具可正常完成       |
| Tool Call 时 Runtime 仍 provisioning | 同一 Turn 等待原 binding                                             |
| Runtime 在执行前失败                 | Tool/Turn 明确失败；可由用户发起新 Turn 重试                         |
| Runtime 在执行后结果不确定           | `RECOVERY_BLOCKED`；不得换 Runtime 重放                              |
| Harness SSE 断开                     | Java 用原 epoch/sequence 重连并以 `sourceRef` 去重                   |
| Harness event epoch 改变             | 先 snapshot/transcript 对账，再订阅新 epoch；不盲接旧 sequence       |
| Java 重启                            | 从 outbox、Session binding、Turn、Item 和 PublicEventStore 恢复      |
| Client SSE 断开                      | Turn 继续；重连后 replay 或 snapshot reconcile                       |
| 显式取消                             | 事务写 `cancel_requested`，并行取消 Harness Turn 和 Broker execution |
| 取消后迟到 success                   | 不覆盖 `CANCELLED`；只记录诊断                                       |
| Managed 创建失败                     | 返回失败；不得把同一请求转发 Legacy                                  |

删除 Session 首版采用异步逻辑删除：先禁止新 Turn，取消或等待活动 Turn，关闭 Harness，释放 Runtime logical Session，最后删除/过期公共资源。不能先删数据库再 best-effort 清理进程。

## 15. 安全与多租户

- 公共 API 只接受用户身份和公共资源 ID；tenant/workspace 由 Java 重新解析。
- Session、Turn、Item、Artifact 每次读取都校验 tenant owner，不能只依赖 ID 随机性。
- Harness bearer、Broker bearer、Runtime bearer 必须是不同凭证和不同受众。
- Adapter 不转发客户端 Authorization 到 Harness 或 Runtime。
- 外部 metadata 需要键数、键长和值长限制，并过滤保留前缀。
- Prompt、完整工具输出、模型密钥、Runtime token、lease、endpoint 和本地路径不得进入普通日志。
- 分页 cursor 必须绑定 tenant、过滤条件和排序方向，防止跨租户复用。
- `environment` 只能引用 Java 已授权的模板/资源，不能直接携带宿主机路径或网络 endpoint。

## 16. 分阶段实施

### A0：冻结内部契约

产物：

- 上述六个权威对象和状态机；
- `AgentSessionApplicationService`、Repository、Outbox、`HarnessClient` 接口；
- OpenAI/Claude/Responses 字段映射表；
- JSON fixture 和契约测试，不开公网路由。

验收：供应商 DTO 不出 Adapter 包；Runtime Broker 不依赖公共 API 类型；同一内部 Session 可被两个只读 Adapter 投影。

### A1：ManagedAgentCoordinator 与 HarnessClient

产物：

- Session 创建/加载、Prompt submit、cancel、snapshot 和 event stream；
- Prompt admission 事务与并行 warm/submit outbox；
- Java `PublicEventProjector` 和按 Session 串行事件提交器。

验收：15 秒 Runtime 冷启动时，公共 SSE 首模型 delta 早于 Runtime ready；无 Tool Turn 不等待 Runtime。

### A2：持久化与恢复

产物：

- Repository 数据库实现与唯一索引；
- outbox dispatcher；
- Harness event cursor、公共 event sequence 和重连；
- Java/Harness 重启后的恢复与 `RECOVERY_BLOCKED`。

验收：注入 Java 重启、Harness 断连和 Broker 响应丢失，无重复 Turn、Item 或物理 Tool execution。

### A3：OpenAI Managed Agents Adapter MVP

产物：

- Session create/get/list/update/delete；
- input message、cancel、events stream；
- Turn/Item 查询；
- 使用官方 Java SDK 形状的黑盒兼容测试。

验收：现有 DataAgent API 和 OpenAI Adapter 对同一 Session 观察到相同 Turn 终态和 Item 内容；Adapter 不绕过 admission、权限、取消和事件存储。

### A4：Artifact 与 required action

产物：

- immutable Artifact metadata/content；
- approval required action；
- 如业务需要，再实现 `client_function` call/result 生命周期。

验收：Artifact 不能越权；同一 tool-result 幂等；Runtime-owned Tool 不错误暴露成 client required action。

### A5：Responses Adapter

产物：

- `/v1/responses` create/get/cancel/input-items；
- Response/Turn 和 output/Item 投影；
- streaming event 映射。

验收：一个 Turn 只执行一次；Managed Agents 与 Responses Adapter 查询结果来自同一内部记录。

### A6：Claude Adapter 与 Subagent

在 Subagent thread、资源和持久事件具备真实需求后再实施，不作为首版上线门槛。

## 17. PR 拆分

1. 产品 Java PR：`feat(agent): define managed session application contracts`
2. 产品 Java PR：`feat(agent): coordinate harness turns and runtime warmup`
3. 产品 Java PR：`feat(agent): persist sessions items and public events`
4. qwen-code PR：`feat(serve): version hosted harness client contract`
5. 联合 E2E PR：`test(managed): verify public api cold runtime flow`
6. 产品 Java PR：`feat(api): add managed agents compatible sessions`
7. 产品 Java PR：`feat(api): expose managed session artifacts`
8. 后续 PR：`feat(api): add responses compatibility adapter`

每个 PR 必须可单独回滚。公共 HTTP schema、Harness 私有协议、Runtime 生命周期和数据库 schema 不放在同一个大 PR 中。

## 18. 测试矩阵

| 场景                        | 必须断言                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| create + initial input      | 一个 Session、一个 Turn、一个 input Item；只提交一次 Harness Prompt |
| create 请求重试             | 相同 key 返回原 Session；不同 digest 返回 409                       |
| submit message 重试         | 相同 promptId 只产生一个 Turn                                       |
| 15 秒 Runtime 冷启动        | 首模型 delta 早于 environment.ready                                 |
| 无 Tool Turn                | Runtime 未 ready 也能完成；不产生 execution                         |
| Tool Turn                   | 等原 binding；physical execute = 1                                  |
| Broker 响应丢失             | 重试查询原 execution；不重复副作用                                  |
| SSE 重连                    | 无重复 durable event；预览缺口用 snapshot 对账                      |
| Java 重启                   | outbox 可恢复；事件 sequence 不回退                                 |
| Harness 重启                | 从原 Session/cursor 恢复；不创建第二个 Turn                         |
| Harness event epoch 改变    | snapshot 对账后无丢失/重复 Item；公共 sequence 不回退               |
| cancel before Runtime ready | physical execute = 0                                                |
| cancel during Tool          | 完整进程树退出；迟到结果不覆盖 cancel                               |
| 两租户同 Session ID 猜测    | 404/403；无 metadata、Item 或 Artifact 泄漏                         |
| 两 Adapter 读取             | Session、Turn、Item 终态一致                                        |
| Legacy Session              | 保持 Legacy owner；不能经新 API 隐式升级                            |

## 19. 观测指标

```text
agent_api_request_total{adapter,operation,status}
agent_session_create_ms
agent_turn_admission_ms
agent_first_preview_event_ms
agent_first_durable_event_ms
agent_runtime_ready_ms
agent_tool_wait_runtime_ms
agent_event_projection_lag_ms
agent_event_deduplicated_total
agent_sse_reconnect_total
agent_stream_reconcile_total
agent_outbox_retry_total
agent_recovery_blocked_total
```

Trace 至少关联 `publicSessionId`、`publicTurnId`、`publicItemId`、`harnessSessionId` 和 `executionCallId`，但后三者只进入受控内部观测，不进入公共响应。

## 20. 上线与回滚

1. 先影子投影：现有 DataAgent 请求照常执行，同时只生成内部 Session/Turn/Item 投影，不开放新路由。
2. 对比现有 transcript 与公共 Item，连续验证无丢失、重复和顺序漂移。
3. 对白名单租户开放只读 Session/Turn/Item API。
4. 开放新建 Session 和 message submit；只影响新 Session。
5. 开放 stream、cancel 和 Artifact。
6. 最后开放 OpenAI-compatible SDK 接入。

回滚只停止新 Session 进入新 Adapter；已经创建的 Managed Session 继续由原 coordinator/Harness owner 完成。不得把活动 Turn 切回 Legacy。

## 21. 进入运行链路实现前的硬门槛

- A0 的接口和 schema 设计可以先行；进入 A1 前，P5c 的 Java 自有 Runtime 故障 E2E 必须完成，能够证明 timeout/crash/shutdown 后资源收敛；
- 产品 Java 仓已确认 Prompt admission 事务、Session 表、SSE 和鉴权接缝；
- `AgentSessionApplicationService` 和 Repository schema 评审通过；
- Hosted Harness 私有协议带版本和 capability digest；
- 明确首版支持的 Agent/environment/tool 字段白名单；
- 确认公共事件的保留期、最大 payload、分页和 SSE 慢消费者策略。

## 22. 立即执行顺序

当前不要先写 OpenAI Controller。按以下顺序开工：

1. 在真实 Java 产品服务定位 Session 创建、Prompt admission、事务、SSE 和 tenant/workspace 鉴权代码，形成接缝清单。
2. 完成 A0：只提交内部对象、接口、状态机、Repository schema 和 Adapter mapping tests。
3. 完成 A1：用现有 Hosted Harness 和 Runtime Broker 跑通 Java Coordinator；证明 TTFT 不等待 Runtime。
4. 完成 A2：持久化、outbox、event cursor 和重启恢复。
5. 再实现 A3 的 OpenAI Managed Agents Adapter。
6. A3 稳定后，根据真实 SDK 接入需求决定是否实施 Responses Adapter；不要同时开两套公网写入口。

最小产品验证只看四项：

1. 第一条 Prompt 的模型首 delta 不等待 Runtime ready；
2. 同一 Turn 的工具物理执行最多一次；
3. Java/Harness/Runtime/Client 任一断线都不导致 Legacy fallback 或 Session owner 漂移；
4. 现有 DataAgent API 与新 Adapter 读取同一份权威 Session/Turn/Item。

## 23. 外部契约参考

- [OpenAI Managed Agents Sessions](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions)
- [OpenAI create agent session](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/create)
- [OpenAI submit agent session events](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/create)
- [OpenAI stream agent session events](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/stream)
- [OpenAI Responses create](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Claude Managed Agents session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)

这些外部 API 当前均包含 beta 能力，具体字段可能变化。实现时应固定本系统 Adapter 版本，并通过契约 fixture 跟踪上游变化，不能让上游 beta schema 直接成为内部数据库 schema。
