# Managed Agent 公共 Agent API 适配层执行方案

状态：执行中；Managed 在线主链路、Tool Runtime warm/durable Broker、本地完整进程 E2E、A1/A2 只读 View 与影子校验、A2.5 私有 Command Core/幂等账本/WebShell Gateway、A3 `JavaAgentProvider`，以及默认关闭的 A4/A5 OpenAI Managed Agents 读写 Adapter 均已完成本地实现与定向验证；E1 真实 Spring HTTP + 官方 SDK 7.18.0 契约冻结已于 2026-09-19 通过；E2 的真实 MySQL Tool UNKNOWN、Command Ledger 竞争、最小产品双 HTTP JVM 并发和三个进程退出窗口已通过，E4 的本地 Harness/Broker/Runtime 四场景完整进程门禁也已通过；两个完整 `LspApplication` JVM + 共享 MySQL + 真实 Hosted Harness/Broker/Runtime 的本地公开 API 验收已通过；真实负载均衡、全资源跨租户、真实流量影子、产品 Java + ACS、签名 BFF/反向代理与灰度开放仍待完成

更新日期：2026-09-19

上游方案：[Managed Agent Hosted Runtime 可执行技术方案](./2026-09-17-managed-agent-hosted-runtime-execution.md)

相关实现阶段：[Managed Agent Java 自有 Runtime 生命周期执行方案](./2026-09-17-managed-agent-java-owned-runtime-lifecycle.md)

产品接入阶段：[Managed Agent P3 Java Prompt 服务接入执行方案](./2026-09-18-managed-agent-p3-product-integration.md)

Tool Runtime 阶段：[Managed Agent 产品 Tool Runtime 接入执行方案](./2026-09-18-managed-agent-product-tool-runtime-integration.md)

## 0. 本次冻结决策

本方案以 Markdown 为权威交付物，不生成或同步 HTML。OpenAI Controller 已在供应商无关内核完成后按
A4/A5 最小子集落地，但读取由 `copilot.agent.agent-api.openai.enabled=false` 默认关闭，写入还要求
`copilot.agent.agent-api.openai.write-enabled=true`；完成真实环境门禁前不得开放流量。

当前采用“先内核、后 Adapter”的最小改动路线：

1. 先让现有 DataAgent API 通过 `QWEN_HOSTED_HARNESS` 完成 Prompt、事件、取消、恢复和异步 Runtime warm；
2. Java 内部增加供应商无关、符合产品 CQRS 约束的 Command/Query Service 和只读 View，但首阶段复用现有
   `chat_session`、`chat_history`、`agent_cli_runtime_session`、`agent_managed_event` 和 Artifact 存储；
3. WebShell 通过显式 `JavaAgentProvider` 调用 Java Session/Prompt/SSE API，不把 Java 伪装成 qwen daemon，也不允许浏览器直连 Hosted Harness、Runtime Broker 或 Tool Runtime；
4. 先做影子投影和只读 API，证明现有 DataAgent API、WebShell 与新 View 一致；
5. OpenAI Managed Agents Adapter 只做 schema 映射，创建、提交、流式、取消、更新和删除全部复用同一
   Query/Event/Command Core；
6. Responses API 只作为第二个 Adapter，不另建执行内核。

这意味着首个公共 API PR 不新建一整套 Session/Turn/Item 表，也不复制 Harness 调用链。只有当现有表无法满足已验证的查询、保留期或性能要求时，才在后续阶段物化独立表。

OpenAI 官方文档当前把 Managed Agents 暴露为 Session 资源：Session 可携带初始 input，后续通过 Session Events 提交 message、cancellation 或 tool-result，并提供事件流、Turn、Item 和 Artifact 查询。因此本方案的内部对象仍使用 `Session / Turn / Item / Artifact / Event`，但不让 beta DTO 成为数据库结构。

## 1. 结论

公共 Agent API 放在 Java 产品服务，不放进 Hosted Harness，也不放进 Runtime Broker。Java 先建立一套供应商无关的 `Agent / Session / Turn / Item / Artifact / Event` 应用模型，再在其上提供不同 HTTP Adapter：

```text
WebShell -> JavaAgentProvider ─┐
DataAgent API ─────────────────┤
OpenAI Managed Agents API ─────┼─> Java AgentSessionCommandService
Responses API（后续）──────────┤       + AgentSessionQueryService
Claude Session API（后续）─────┘       + AgentEventStreamService
                                        -> ManagedAgentCoordinator
                                             -> HarnessClient
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

以 qwen-code 已提交基线 `056e4dc61f6a`、两仓当前工作树和已通过的定向测试为基线：

- Hosted Harness 已有 `qwen serve --profile hosted-harness`，通过私有 `/session` 链路运行完整模型循环；
- 私有协议 v1 已具备 capability handshake、boot fencing、caller-owned session/prompt UUID、payload digest、SSE epoch/sequence、status 和 transcript；
- qwen Java SDK 已提供 create/load/submit/stream/cancel/status/transcript/detach/close transport；
- 产品 Java 已增加 `QWEN_HOSTED_HARNESS`、Hosted binding fencing 字段、Managed Event Store、Gateway 和 Session binding service；
- 新 Managed Session 已不再同步创建用户 Pod，Prompt 路由根据 DB binding 固定，开关关闭不会把活动 Session 切回 Legacy；
- 产品 Java 已完成确定性 Prompt admission、Hosted Harness Connector、Harness 事件两段投影、ACCEPTED watermark 持久化和 Managed cancel 分流；
- submit 响应未知时，产品 Java 已能用 status/transcript 对账，并用持久化 retry token 保证相同 admission 最多自动补发一次；
- 产品 Java 已实现后台 `ManagedTurnReconciler`：扫描超时 RUNNING Turn，在同一 Session 锁内用 durable terminal、status/transcript 或原 admission 收敛；
- Managed load 已能先重新 attach，再按 `agent_managed_event.publicSequence` 重放并即时触发 reconcile；Redis `lastEventId` 与 Managed durable sequence 已在服务端分离；
- Java 输出事件已统一携带 `_meta.managedSequence`；前端在同一 SSE 调用的断线重连中保存并回传 `managedLastSequence`，且不污染 Legacy `beginLogOffset`；
- 现有 DataAgent 删除入口已先关闭远端 Hosted Session；close 结果未知时先用 status 对账，确认关闭后才写 binding `DELETED`、释放 Session 锁并删除本地会话；
- permission 入口已按 DB Hosted binding 优先识别 Managed Session；在 v1 权限 mutation 落地前稳定返回 `managed_permission_unsupported`，不进入 Legacy executor；
- attachment idle reaper 已用本地 operation lease 隔离 submit/status/transcript/cancel/SSE，并在 detach 前二次确认远端没有 active prompt；shutdown 只回收无活跃 lease 的 attachment，不 close Session；
- qwen daemon 已保留首次 admission 的 `lastEventId + eventEpoch`，同一 prompt 重试不会从新的游标跳过首次提交后产生的事件；
- 本地完整进程 E2E 已验证 Hosted Harness 在 Runtime 冷启动 `15518 ms` 时于 `278 ms` 产生首个模型事件，同一轮随后继续执行 Tool；同一 Tool 只物理执行一次，并能从一次丢失的 execution 响应恢复。Runtime ready 前取消为 0 次物理执行，Tool 启动后取消会清理进程树，两个 logical Session 可共享一次 provision 但独立 acquire/execute；证据见 [本地完整进程报告](./2026-09-19-managed-agent-local-process-evidence.md)；
- 产品 Java、前端 ACP、qwen prompt ledger、admission-watermark 和 Runtime Broker 的相关定向测试及本地完整进程 E2E 已通过；WebShell A3 的 6 个测试文件共 32 个用例、package typecheck 和 package build 已通过；qwen-code 全量 `npm run typecheck` 与 4 GB 构建已通过；默认 3 GB heap 构建在 `packages/cli` 的 `tsc --build` 阶段以 `SIGABRT` 退出，不能作为当前生产资源基线；产品 Java `copilot/agent` 及其 18 个 reactor 模块的 package 门禁已通过，A2/A2.5/A3 的 15 个测试类共 47 个用例通过；A4/A5 的 6 个测试类共 38 个用例、相邻 Query/Event/WebShell/Projector 的 6 个回归测试类共 21 个用例通过。E1 已用官方 TypeScript SDK 7.18.0 经真实 Spring HTTP/Tomcat 端口冻结 13 条路由、两条 SSE 路径和 11 个 unsupported sentinel，证据见 [E1 契约冻结报告](./2026-09-19-managed-agent-e1-contract-evidence.md)。E2 的真实 MySQL 门禁现为 14/14，并覆盖最小产品双 HTTP JVM 与三个确定性退出窗口。两个完整 `LspApplication` JVM + 共享 MySQL + 真实 Hosted Harness/Broker/Runtime 的本地公开 API 验收也已通过，证据见 [完整应用本地生产级证明](./2026-09-19-managed-agent-full-application-evidence.md)；SDK 发布到内部 Maven 仓库、真实负载均衡、全资源租户隔离、产品 Java + DataAgent/ACS 联合 E2E、签名 BFF/反向代理和真实流量 Shadow 验收仍是集成门禁。

当前还不能称为公共 Agent API，缺口是：

1. Tool Runtime 的异步 warm、lease/epoch、durable Repository 和 `executionCallId` 幂等已落代码并通过本地 E2E；真实 MySQL 上的双 JVM UNKNOWN 竞争子门禁已通过，但真实 ACS 崩溃注入尚未完成；
2. 本地 Hosted Harness 四场景完整进程 E2E 已通过，但产品 Java + DataAgent/ACS 的真实网络、鉴权和部署 E2E 尚未完成，SDK 也仍需发布到产品 CI 可解析的内部 Maven 仓库；
3. WebShell 已增加供应商无关的 `ManagedAgentProvider`、daemon 适配、真实 Java HTTP/SSE client、
   canonical Event projector 和不装配 daemon context 的独立 `ManagedAgentWebShell`；真实浏览器到
   Java/BFF 的鉴权、POST SSE、刷新/断流 E2E 尚未完成；
4. 供应商无关的 `AgentSessionQueryService`、`AgentEventStreamService`、只读 View、
   `AgentSessionCommandService`、Command Ledger 和私有 WebShell Gateway 已落代码；最小产品双 HTTP JVM
   已通过相同/冲突请求、Session tenant/operator 隔离和三个进程退出窗口；完整 `LspApplication` 双 JVM
   的本地 create/read/SSE/replay/Tool 验收也已通过，但真实数据影子一致性、真实负载均衡以及
   Turn/Item/Artifact/cursor 全资源隔离仍未验收；
5. OpenAI Adapter 已落在 Java 产品服务并默认关闭；本地 JSON/控制器测试和官方 SDK 真实 HTTP/SSE
   黑盒已经通过，尚未完成真实鉴权、租户隔离、BFF/反向代理和生产灰度验证；
6. Agent revision 注册表和 environment 生产白名单尚未冻结；首个带日期的 Adapter 契约 fixture 已冻结，
   后续 beta 版本仍需逐版执行同一门禁。

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
- WebShell 通过 Java 完成 Session create/load、Prompt submit、SSE replay 和 cancel；
- 现有 DataAgent API 与新 Adapter 读取同一份 Session/Turn/Item 数据。

### 3.2 首版明确不做

- 不让外部请求直接指定 Runtime URL、Pod、容器、token、lease 或本地路径；
- 不承诺 OpenAI 或 Claude 所有 beta 字段均可用；不支持的字段明确返回稳定错误；
- 不在 Adapter 内实现模型循环、工具执行或 Session 恢复；
- 不实现 Java daemon-compatible 网关，不让 WebShell 的 daemon `baseUrl` 直接指向 Java；
- 不把旧 Legacy Session 自动切换成 Managed；
- 不在首版开放客户端自定义 Function Tool 回调；
- 不实现跨供应商 ID 互换，例如把外部 OpenAI Session ID 当作内部 Harness ID；
- 不实现 Responses API 的所有 built-in tools、conversation storage 和 background mode；
- 不把 Kubernetes Provisioner 作为公共 API 上线前置条件。

## 4. 组件边界

| 组件                         | 职责                                               | 不负责                                   |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `JavaAgentProvider`          | WebShell 到 Java Session/Prompt/SSE 的前端适配     | daemon 协议、Harness/Runtime 凭证        |
| HTTP Adapter                 | 供应商 schema、路径、错误和 SSE frame 映射         | Session 权威状态、Harness/Runtime 调度   |
| `AgentSessionCommandService` | Session 创建/修改/删除、输入/取消命令和事务边界    | HTTP schema、模型循环、工具执行          |
| `AgentSessionQueryService`   | Session/Turn/Item/Artifact 的鉴权查询和统一分页    | 写入、副作用、Harness transport          |
| `AgentEventStreamService`    | durable event replay、直播拼接和慢消费者边界       | 分配 Harness/Runtime 凭证                |
| `ManagedAgentCoordinator`    | 创建/恢复 Harness、并行 warm、提交、取消、事件投影 | HTTP schema、Runtime 传输细节            |
| `HarnessClient`              | 调用 Hosted Harness 私有协议                       | 租户鉴权、公共 ID、数据库事务            |
| `PublicEventProjector`       | Harness 事件到公共 Item/Event 的确定性转换         | 直接订阅浏览器、执行 Tool                |
| `RuntimeBrokerService`       | Runtime binding、执行幂等、取消、生命周期          | 公共 Agent/Session API                   |
| Hosted Harness               | 模型 Context、Agent Loop、工具编排                 | 公共租户鉴权、Runtime 调度凭证           |
| Tool Runtime                 | Workspace 副作用和本地能力                         | 用户 Prompt、公共 Session 状态、模型凭证 |

`packages/sdk-java/runtime-broker` 保持 Runtime 专用，不加入 Agent API DTO。公共 API 应位于真实 Java 产品服务；qwen-code 仓库只维护 Harness 私有契约、参考客户端、契约测试和端到端夹具。

### 4.1 WebShell `JavaAgentProvider`

WebShell 产品接入选择前端 Provider 适配，不要求 Java 实现 qwen daemon REST/SSE 协议。现有 `DaemonWorkspaceProvider` 和 `DaemonSessionProvider` 保持不变，继续服务本地 `qwen serve`；只有宿主显式选择 Managed 产品模式时才装配 `JavaAgentProvider`。

第一阶段 Provider 只覆盖完整会话所需的最小能力：

```text
createSession / loadSession
submitPrompt
subscribeEvents(managedLastSequence)
cancelTurn
```

Provider 将 Java 的公共 Session、Turn、Item 和 Event 投影为 WebShell transcript blocks，不直接读取 Hosted Harness transcript。SSE 断线后只向 Java 回传 `managedLastSequence`；Java 从 `agent_managed_event.publicSequence` replay，前端不得直接使用 Harness `eventEpoch/sequence` 补流。

浏览器只持有现有 Java/BFF 用户登录态或面向 Java API 的短期凭证。Hosted Harness bearer、Runtime Broker bearer、Runtime token、lease、endpoint、Pod 和本地 workspace path 都不能进入 WebShell。跨域部署时由 Java/BFF 统一处理 CORS、Cookie/Bearer 和 SSE keepalive，不能通过允许浏览器访问 Broker 私网端口来绕过。

第一阶段不把完整 daemon workspace 功能搬到 Java：MCP/Skill 管理、终端、文件树、daemon capabilities、动态 workspace 注册和 permission mutation 均保持关闭或由宿主隐藏。Artifact、approval 和这些扩展能力只有在 Java 公共契约明确后才逐项加入 Provider。

验收标准：同一 Managed Session 在 WebShell 刷新或 SSE 重连后不重复 Turn/Item；取消只调用 Java；现有 daemon 模式零行为变化；浏览器网络请求中不存在 Harness、Broker 或 Runtime 凭证。

现有 `/api/agent/v1` 不能直接当作这个 Provider 的稳定传输契约，必须先补 Java 私有 WebShell
Gateway，原因已经由当前代码核对确认：

1. `DataAgentController.promptSession` 使用服务端 `TraceUtil` 作为 `chat_history.request_code`，浏览器的
   幂等键不能稳定成为公共 Turn ID；
2. `session/prompt` 把命令执行和同一条 HTTP SSE 绑定，无法保证浏览器断开后 Turn 继续运行；
3. `session/list` 不返回 active Turn、Managed phase、Runtime state 或最后 `publicSequence`，前端刷新后
   不能重建权威状态；
4. `session/load` 会重放并跟随活动 Turn，它不是有界 transcript snapshot，不能同时充当
   `getTranscript` 和 live subscription；
5. 当前接口没有写命令账本，同一浏览器重试键不能证明只创建一个 Session/Turn。

因此禁止在 `JavaAgentProvider` 中用内存状态、随机 `promptId` 或扫描 Session 列表来掩盖这些缺口。
Provider 对外统一使用公共 `turnId`；只有 daemon adapter 内部执行
`promptId <-> turnId` 映射，Java/Event/View 不得暴露 Harness prompt ID。

#### 4.1.1 私有 WebShell Agent Gateway

首版增加仅供产品 WebShell/BFF 使用的 `/api/agent/web-shell/v1` Adapter。它不是 OpenAI 兼容层，
不复制业务逻辑：读请求只调用 A2 Query/Event Service，写请求只调用 A2.5 Command Service。
为适配既有 BFF、统一登录态和 POST SSE，冻结以下最小路由：

```text
POST /api/agent/web-shell/v1/sessions/query
POST /api/agent/web-shell/v1/sessions/get
POST /api/agent/web-shell/v1/transcript/query
POST /api/agent/web-shell/v1/events/stream       # text/event-stream
POST /api/agent/web-shell/v1/sessions/create
POST /api/agent/web-shell/v1/turns/submit
POST /api/agent/web-shell/v1/turns/cancel
```

公共请求字段固定为 `sessionId`、`turnId`、`idempotencyKey`、`cursor`、`limit` 和
`afterSequence`；tenant、operator、workspace、Harness/Runtime 标识全部从 `EnvContext` 或服务端
binding 解析。写请求的 `idempotencyKey` 长度限制为 1--128，正文先 canonicalize 再计算 SHA-256
digest；请求和普通日志均不记录 Prompt 正文。

`sessions/query|get` 返回 Session 和 active Turn 的组合 View；`transcript/query` 返回有界
`events + olderCursor + lastSequence`，不得等待正在执行的 Turn；`events/stream` 先 replay
`sequence > afterSequence` 的 durable event，再 follow 新事件。SSE 每帧固定为：

```text
id: <publicSequence>
event: <publicEventType>
data: <AgentEventResult JSON>
```

心跳使用 SSE comment，不占 `publicSequence`。慢消费者、游标过期或投影缺口发送结构化
`stream.reconciled`/snapshot 事件；不得回退到 Harness epoch/sequence。提交接口只返回已持久化的
`sessionId + turnId + status=accepted`，流式输出始终从独立 `events/stream` 获取，浏览器断开不取消
Turn。

三类写请求的 JSON 形状固定如下；`requestId` 只用于 trace，`idempotencyKey` 才参与幂等：

```json
{
  "requestId": "trace-uuid",
  "idempotencyKey": "client-stable-key",
  "agentId": "dataworks_data_agent",
  "environmentId": "authorized-template-id",
  "input": [{ "type": "text", "text": "..." }],
  "metadata": {}
}
```

```json
{
  "requestId": "trace-uuid",
  "idempotencyKey": "client-stable-key",
  "sessionId": "session-public-id",
  "input": [{ "type": "text", "text": "..." }]
}
```

```json
{
  "requestId": "trace-uuid",
  "idempotencyKey": "client-stable-key",
  "sessionId": "session-public-id",
  "turnId": "turn-public-id"
}
```

create/submit 的 HTTP 202 响应统一为：

```json
{
  "sessionId": "session-public-id",
  "turnId": "turn-public-id",
  "status": "accepted",
  "replayed": false
}
```

同 key 重试将 `replayed` 置为 `true` 并返回完全相同的公共 ID。`sessions/query|get` 的单条 Session
View 必须同时返回 `activeTurn`、`environment` 和 `lastSequence`；没有 Turn 时这些字段可为空，但不能
用随机占位 ID。`transcript/query` 统一返回：

```json
{
  "events": [],
  "olderCursor": null,
  "lastSequence": 0
}
```

#### 4.1.2 WebShell 进程边界

产品接入新增独立 `ManagedAgentWebShell` 入口，只装配 Theme/I18n/Brand、
`JavaAgentProvider` 和 Managed transcript，不装配 `DaemonWorkspaceProvider`、
`DaemonSessionProvider` 或 daemon sidebar。这样 workspace/MCP/Skill/terminal/permission 能力按构造
即不可见，而不是靠 CSS 或 capability 假隐藏。现有 `WebShellWithProviders` 和 `qwen serve` 入口保持
原样；`App.managedAgentProvider` 只作为过渡/调试面板，不作为最终产品 Managed-only 入口。

前端文件边界冻结为：

```text
packages/web-shell/client/components/managed/
  managed-agent-provider.ts             # 供应商无关契约 + daemon adapter
  java-managed-agent-client.ts           # fetch/POST SSE、鉴权 header、错误映射
  java-managed-agent-provider.ts         # Java View/Event -> WebShell 状态与事件
  java-managed-agent-event-projector.ts  # 纯函数、确定性 turn/item 映射
  ManagedSessionsPage.tsx
packages/web-shell/client/
  ManagedAgentWebShell.tsx               # 无 daemon context 的独立入口
```

Java client 只接受 `baseUrl`、`getHeaders()`、`credentials` 和可替换 `fetch`；`storageKey` 必须由不含
query/token 的 origin + product scope 生成，不能把 Cookie/Bearer 写入 local/session storage。
create、submit 和 cancel 都必须传 `ManagedAgentCommandOptions.idempotencyKey`。前端把 outcome unknown
命令的 `operation/sessionId/turnId/key` 持久化到 session storage，重试复用原 key；Java 对 cancel 还需按
Turn terminal state 保证幂等，因此即使用户在新页面再次发出不同 key，也不能产生第二个取消副作用。

canonical Java event 到 WebShell event 的映射固定为：

| Java public event          | WebShell event                                                 |
| -------------------------- | -------------------------------------------------------------- |
| `turn.accepted`            | `accepted`                                                     |
| `environment.provisioning` | `runtime_starting`                                             |
| `environment.ready`        | `runtime_ready`                                                |
| `environment.failed`       | `runtime_failed`                                               |
| `turn.started`             | `agent_started`                                                |
| `item.output_text.delta`   | `assistant_delta`                                              |
| `item.reasoning.delta`     | `assistant_thought`                                            |
| `item.tool_call.updated`   | 按 canonical `status` 映射 requested/started/completed         |
| `turn.completed`           | `completed`                                                    |
| `turn.failed`              | `failed`                                                       |
| `turn.cancel.requested`    | `cancelling`                                                   |
| `turn.cancelled`           | `cancelled`                                                    |
| `stream.reconciled`        | snapshot 合并；无法连续时才产生 `stream_gap` 并重新拉 snapshot |

### 4.2 Hosted Harness 部署拓扑

当前 Hosted Harness 是“一个进程承载多个 Session”的常驻服务，但还不是可以在普通负载均衡后随机转发的无状态实例池：

- `qwen serve --profile hosted-harness` 强制监听 loopback；
- 产品 Java 当前按部署配置持有一个 `endpointId/baseUrl` 和一个 capability handshake 客户端；
- Session binding 固定 `endpointId/baseUrl/harnessBootId`；
- Harness 重启或请求漂移到另一个 boot 时会触发 generation mismatch，而不是自动迁移 Session。

因此首个试点拓扑固定为一个常驻、多租户、多 Session 的 Harness shard：

```text
Java replicas -> internal Service/VIP -> reverse proxy -> 127.0.0.1 Hosted Harness
                                              same Pod / same host
```

Kubernetes 中由同一 Pod 的 Envoy/nginx/Service Mesh sidecar 暴露 mTLS 内网入口，Harness 仍只监听 loopback；非 Kubernetes 环境使用 systemd/supervisor 管理 Harness，并由同机反向代理接入内网 VIP/DNS。代理只负责网络暴露、鉴权和连接保活，不解析或改写 Session 协议。

首版不在一个 Service 后放多个独立 Harness replica。需要水平扩容时先增加 `HarnessEndpointRegistry + HarnessShardSelector`：只为新 Session 选择健康 shard，并把稳定 endpoint、boot 和 capability 写入 binding；后续 submit、stream、cancel、reconcile 和 close 必须回到同一 shard。只有共享 Session Authority 或显式迁移协议完成后，才允许跨 shard 恢复。

试点容量不足时先增加单 shard 的进程资源和 Session 上限告警；达到阈值后拒绝新的 Managed admission 或路由到已登记的新 shard，不能把已绑定 Session 随机切走，也不能回落到 Legacy。

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
sessionId
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

`sessionId` 是所有外部 Adapter、Java 持久化、Hosted Harness 和 Runtime Broker 共用的 RFC UUID。内部协议为兼容现有实现仍可把该字段命名为 `harnessSessionId`，但其值必须等于 `sessionId`，不得再创建或持久化第二套 Session ID。Harness owner、boot generation、Runtime Session 和 execution ID 仍位于单独的 backend binding 中，不得返回给客户端。

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
sessionId
executionEngine = managed
harnessOwnerId
harnessGeneration
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
sessionId
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
sessionId
publicTurnId
type
status
contentRef / payload
createdAt
completedAt
sourceRef
```

`sourceRef` 只用于 Java 内部去重，例如 `harnessBootId + harnessEventEpoch + harnessEventSequence`，公共响应不得暴露它。

### 5.6 Artifact

首版只暴露完成 Turn 已发布的不可变 Artifact：

```text
publicArtifactId
sessionId
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

### 6.1 首阶段复用现有权威存储

首阶段通过 Repository/View 适配现有表，不立即复制一套公共模型表：

| 内部对象                | 首阶段真相源                             | 说明                                                                        |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `AgentSession`          | `chat_session` + 当前 Hosted binding     | `sessionCode` 继续作为公共 Session ID；execution engine 从 binding 判定     |
| `SessionBackendBinding` | `agent_cli_runtime_session`              | 按同一 `sessionId` 保存 Harness client/boot/protocol/digest，不进入公共响应 |
| `Turn`                  | `chat_history`                           | `requestCode` 作为公共 Turn ID；Managed admission 元数据保存在 `expands`    |
| `Item`                  | `agent_managed_event` 的完整事件 payload | A1/A2 先按 event 形成 View；出现真实查询瓶颈后再物化 Item 表                |
| `Artifact`              | 现有 Artifact Repository/OSS             | Adapter 只做权限校验和 DTO 投影                                             |
| `PublicEventStore`      | `agent_managed_event`                    | Java 分配 `publicSequence`，支持 SSE replay                                 |

应用层新增的是稳定接口，不是立即新增表。产品代码必须遵循 CQRS，不能实现一个同时读写的
`AgentSessionApplicationService` 上帝接口：

```java
interface AgentSessionReadRepository {
    Optional<AgentSessionProjection> findSession(AuthorizedSessionRef ref);
    Page<AgentTurnProjection> listTurns(AuthorizedSessionRef ref, PageCursor cursor);
    Page<AgentItemProjection> listItems(AuthorizedSessionRef ref, PageCursor cursor);
    Page<AgentArtifactProjection> listArtifacts(AuthorizedSessionRef ref, PageCursor cursor);
    List<PublicAgentEvent> listEventsAfter(AuthorizedSessionRef ref, long sequence, int limit);
}
```

### 6.2 Prompt admission 事务

现有 DataAgent Prompt 在调用 Hosted Harness 前必须先完成：

1. 解析并固定 tenant、workspace、Session 和 Agent revision；
2. 生成稳定 `promptId`；
3. 原始请求继续写入 `chat_history.question.finalQuestion`，并把 `promptId`、`payloadDigest`、payload version、deadline 和 `executionEngine=MANAGED` 写入 `chat_history.expands`；
4. 提交事务后并行触发 Harness submit 和 Runtime warm；
5. submit 响应不确定时只使用同一 `promptId + payloadDigest` 对账或重试。

A2.5 在公开写 Adapter 之前增加最小 `CommandLedger`，以
`tenantId + operatorId + operation + scopeId + idempotencyKey` 唯一约束 WebShell 的
create/submit/cancel。第一版不为内部 DataAgent 链路先造通用 Outbox；P3c-2 继续通过
`chat_history` 中的 RUNNING 状态和 Managed admission 元数据做崩溃恢复。A5 公网写入口直接复用
同一 Command Service/ledger；只有跨进程故障注入证明存在不可发现窗口时，才增加最小 Outbox，
而不是预先引入完整任务平台。

## 7. Java 应用接口

内部接口不使用 OpenAI 或 Claude DTO，并按产品仓库约束拆成 Command、Query 和 Stream 三个边界：

```java
interface AgentSessionCommandService {
    CreateSessionResult createSession(CreateAgentSessionCommand command);
    SubmitEventsResult submitEvents(SubmitAgentSessionEventsCommand command);
    UpdateSessionResult updateSession(UpdateAgentSessionCommand command);
    void deleteSession(DeleteAgentSessionCommand command);
}

interface AgentSessionQueryService {
    AgentSessionResult getSession(GetAgentSessionQuery query);
    AgentCursorPageResult<AgentSessionResult> listSessions(ListAgentSessionsQuery query);
    AgentCursorPageResult<AgentTurnResult> listTurns(ListAgentTurnsQuery query);
    AgentTurnResult getTurn(GetAgentTurnQuery query);
    AgentCursorPageResult<AgentItemResult> listItems(ListAgentItemsQuery query);
    AgentCursorPageResult<AgentArtifactResult> listArtifacts(ListAgentArtifactsQuery query);
    ArtifactContentResult openArtifact(GetAgentArtifactContentQuery query);
}

interface AgentEventStreamService {
    AgentEventStream open(OpenAgentEventStreamQuery query);
}
```

所有 application `*Command` 必须继承 `BaseCommand`，所有 `*Query` 必须继承
`BaseQuery`；操作者、tenant 和 workspace 只从 `EnvContext` 获取。Adapter 传入的
tenant、workspace、cwd、Harness ID 和 Runtime ID 一律不作为权限依据。

## 8. HarnessClient 私有契约

Java 通过一个稳定客户端封装现有 Hosted Harness `/session` 能力：

```java
interface HarnessClient {
    CompletionStage<HarnessSessionRef> createSession(
            CreateHarnessSession command);
    CompletionStage<HarnessSessionRef> loadSession(
            LoadHarnessSession command);
    CompletionStage<PromptReceipt> submitTurn(SubmitHarnessTurn command);
    HarnessEventStream streamEvents(StreamHarnessEvents query);
    CompletionStage<Void> cancelTurn(CancelHarnessTurn command);
    CompletionStage<Void> heartbeat(HeartbeatHarnessSession command);
    CompletionStage<HarnessSnapshot> getSnapshot(GetHarnessSnapshot query);
    CompletionStage<Void> closeSession(CloseHarnessSession command);
}
```

产品 Java 生成一个 RFC UUID `sessionId`，并把同一个值用于公共 API、Hosted Harness create/load、JSONL 和 Runtime Broker。数据库不得保存公共 ID 到 Harness ID 的映射。首版不要求把 `publicTurnId` 发送给 Harness；Java 通过持久化的 `(sessionId, promptId) -> publicTurnId` 映射完成事件投影。

首版 Hosted Harness 使用部署级固定 capability，Java 在 Session binding 中固定 `agentRevision` 和握手获得的 `capabilityDigest`；它们不要求在每个请求中重复发送。未来支持一个 Harness 上的动态 AgentDefinition 时，通过新私有协议版本扩展，不能改变 v1 的含义。

私有请求至少带：

- `protocolVersion`；
- `harnessBootId` fencing token 和 `sessionId`；现有私有协议字段名 `harnessSessionId` 仅为兼容别名；
- create/load 后的请求还必须带当前 attachment 的 `harnessClientId`；
- 稳定的 `promptId`；
- 服务身份 token；
- 可选 deadline。

Harness 事件至少带 `harnessEventEpoch`、`harnessEventSequence`、`promptId`、稳定 Item/call ID、事件类型和 payload。Java 使用 `harnessBootId + harnessEventEpoch + harnessEventSequence` 作为 `sourceRef`，再通过 `(sessionId, promptId)` 映射公共 Turn，去重后分配公共 `eventSequence`。Session UUID 由 Java 在 admission 时分配；Harness 不另行分配 Session/Turn ID，也不根据请求体决定 tenant/workspace。

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
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
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

2026-09-18 已按 OpenAI 官方 beta Agents Session API 复核：创建 Session 可以同时提交
initial input 并在 `stream=true` 时直接返回事件流；Session Event 写入口接受 message、
cancellation 或 tool-result，HTTP 202 只表示 accepted，不表示 Turn 已持久完成；查询面包含
Session、Turn、Item、Artifact 与 Artifact content。首版路径保持同构：

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

- `environment` 省略或 `environment.type=none` 表示本轮不声明 Tool Runtime 环境；需要 Tool Runtime
  时只接受 `type=openai_hosted + environment_template_id`，且 template 必须在服务端解析为产品已授权
  environment，禁止接收 self-hosted endpoint、任意 `workspace_directory` 或宿主机路径；
- Workspace 环境使用产品侧模板或资源 ID 解析，禁止接收任意 `cwd`。
- A4/A5 MVP 只接受可解析的 `agent_id`；inline `agent` 覆盖、`vault_ids` 和 subagent 延后；
- `stream=true` 在创建 Session 的同一个响应上输出 SSE；其内部仍先提交事务，再从同一 durable event
  stream 输出 `agent.session.created` 和首轮 Turn 事件。有 initial input 时流在该 Turn 的 completed、failed
  或 cancelled 终态结束；无 initial input 时在 created 事件后结束，heartbeat 不能提前截断响应；
- `POST /events` 首版接受 `agent.session.input.message` 和 cancellation；tool-result 只在
  `client_function` required-action 生命周期完成后开放；成功返回 202，客户端通过事件流观察终态；
- `POST /sessions/{id}` 首版只允许 metadata 更新。官方允许的 agent 更新在 Session revision
  切换规则落地前返回 `unsupported_feature`，不能静默替换当前 Agent revision；
- metadata 先执行官方当前上限校验：最多 16 个字符串键值，key 最长 64，value 最长 512；MVP 只持久化
  `title`，其他合法键返回 `unsupported_feature`，不静默丢弃；省略 metadata 表示不修改，`null` 或空对象
  表示清空 title；
- 未实现的字段或环境类型返回 `unsupported_feature`，不能静默忽略；
- `GET /events` 以官方事件名输出；`Last-Event-ID` 是本实现用于 durable replay 的兼容扩展，
  值只解释为 Java `publicSequence`，不暴露 Harness epoch/sequence；
- Adapter 返回 OpenAI 风格对象和事件名，但内部错误码保留在结构化 error 字段中。

当前实现还固定以下安全边界：公共 environment ID 由 Session ID 派生，Artifact 只返回安全虚拟路径；
Harness endpoint、boot ID、Runtime URL/token/lease、environment template ID 和宿主机路径均不进入公共响应。
只读路由只有在显式打开 OpenAI Adapter 开关时才注册；写路由还要求额外打开 `write-enabled`，并把
Managed Command Core 作为强依赖。显式打开写开关但 Command Core 未装配时应用启动失败，不能静默暴露
残缺路由；两级配置保证可以先灰度只读、后灰度写入。

## 11. Responses API Adapter（第二阶段）

Responses 兼容不新建执行内核：

```text
POST /v1/responses
GET  /v1/responses/{responseId}
POST /v1/responses/{responseId}/cancel
GET  /v1/responses/{responseId}/input_items
```

映射：

- `conversation` 映射到 `sessionId`；
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
  create/update authoritative Session + Turn + input Item + command ledger
Java -> Client: open SSE and emit turn.accepted
Java after commit (parallel; existing Reconciler handles unknown submit outcome):
  A. runtimeBroker.warm(sessionId)
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
| Java 重启                            | 从 admission 记录、Session binding、Turn 和 PublicEventStore 恢复    |
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

### A0：完成 Managed 执行内核（核心代码和本地 E2E 已完成）

产物：

- Hosted Harness Prompt submit、SSE stream、cancel、status/transcript reconciliation；
- `agent_managed_event` 投影与 replay；
- Java 重启后按同一 promptId 恢复；
- Tool Runtime 异步 warm 和 execution 幂等。

验收：现有 DataAgent API 已能在 Runtime 冷启动期间先返回模型 delta，且进程重启不重复 Turn 或 Tool 副作用。

当前完成度：在线 Prompt submit、SSE 投影、submit outcome unknown 即时对账、cancel、后台 Reconciler、Managed load durable replay、端到端 durable cursor、删除/关闭生命周期、permission fail-closed、attachment detach、Runtime warm、durable Broker 和 UNKNOWN 门禁均已落代码。本地 Hosted Harness + Java Broker fixture + 冷 Runtime/取消/双 Session 完整进程 E2E，以及本地真实 MySQL 双 JVM UNKNOWN、Command Ledger 竞争、最小产品双 HTTP JVM 和三个命令退出窗口均已通过；两个完整 `LspApplication` JVM + 共享 MySQL + 真实 Hosted Harness/Broker/Runtime 的本地公开 API 验收也已通过。剩余真实负载均衡、真实 DataAgent/ACS 和网络/调度崩溃窗口故障注入。

### A1：冻结内部 Agent API 契约

产物：

- 上述六个权威对象和状态机；
- `AgentSessionQueryService`、`AgentEventStreamService` 和只读 Repository/View 接口；
- A5 写入命令的字段、幂等语义和错误契约；A5 复用已落地的 `AgentSessionCommandService`；
- OpenAI/Claude/Responses 字段映射表；
- JSON fixture 和契约测试，不开公网路由。

验收：供应商 DTO 不出 Adapter 包；Runtime Broker 不依赖公共 API 类型；同一内部 Session 可被两个只读 Adapter 投影。

### A2：供应商无关 Application Facade

产物：

- `AgentSessionQueryService` 和 `AgentEventStreamService` 的首批实现；
- 基于现有表的 Session/Turn/Item/Event/Artifact View；
- tenant/workspace 权限和统一 cursor；
- 影子投影，不开放公网写路由。

验收：现有 DataAgent API 与内部 Facade 读取到相同 Session、Turn 终态、Item 和事件顺序。

当前完成度：产品 Java 已增加供应商无关状态与结果模型、`AgentSessionQueryService`、
`AgentEventStreamService`、签名 opaque cursor，以及复用现有 chat/binding/event/artifact 真相源的
只读 Repository/View；DataAgent `ChatQueryService` 已接入默认关闭、fail-open 的影子比较，逐 Turn
检查状态、输入、最终输出、Item ID/顺序和最后 `publicSequence`，并记录
`agent_api_shadow_comparison_total{outcome}`。durable transcript 已改为按 `publicSequence` keyset anchor
读取固定事件快照，避免分页期间新事件导致 offset 漂移；`copilot/agent` 及其 18 个 reactor 模块的
package 门禁成功。
尚未在真实流量启用影子开关，因此 A2 仍不视为生产验收完成，不开放公共 Controller。

### A1/A2：第一批可直接开工的代码清单

第一批只做内部契约和只读 View，不新增 Controller、不新增数据库表、不修改 qwen 私有协议，
实现范围固定在产品 Java `copilot/agent`：

```text
src/main/java/com/aliyun/dataworks/lsp/copilot/agent/
  domain/agentapi/model/
    AgentSessionStatus.java
    AgentTurnStatus.java
    AgentItemType.java
  application/agentapi/query/model/request/
    GetAgentSessionQuery.java
    ListAgentSessionsQuery.java
    GetAgentTurnQuery.java
    ListAgentTurnsQuery.java
    ListAgentItemsQuery.java
    ListAgentArtifactsQuery.java
    GetAgentArtifactContentQuery.java
    OpenAgentEventStreamQuery.java
  application/agentapi/query/model/result/
    AgentSessionResult.java
    AgentTurnResult.java
    AgentItemResult.java
    AgentArtifactResult.java
    AgentEventResult.java
    AgentCursorPageResult.java
    AgentArtifactContentResult.java
    AgentProjectionComparisonResult.java
  application/agentapi/query/
    AgentApiCursorCodec.java
  application/agentapi/query/service/
    AgentSessionQueryService.java
    AgentEventStreamService.java
    AgentProjectionShadowService.java
  application/agentapi/query/service/impl/
    AgentSessionQueryServiceImpl.java
    AgentEventStreamServiceImpl.java
    AgentProjectionShadowServiceImpl.java
  repo/agentapi/
    AgentSessionReadRepository.java
  repo/agentapi/model/
    AuthorizedSessionRef.java
    AgentReadCursor.java
    AgentReadPage.java
    AgentSessionProjection.java
    AgentTurnProjection.java
    AgentItemProjection.java
    AgentArtifactProjection.java
    AgentArtifactAccess.java
    AgentEventProjection.java
  domain/agentapi/exception/
    AgentApiErrorCode.java
    AgentApiException.java
  infra/agentapi/
    AgentSessionReadRepositoryImpl.java
    AgentApiShadowProperties.java
```

实现约束：

1. 所有 Query 继承 `BaseQuery`；实现只从 `query.getEnvContext()` 读取 tenant、workspace 和操作者；
2. Repository 复用 `chat_session`、`chat_history`、`agent_cli_runtime_session`、
   `agent_managed_event` 和现有 Artifact Repository，不增加 Mapper SQL，除非现有查询不能限定 tenant；
3. Session 只有存在 current `QWEN_HOSTED_HARNESS` binding 时才投影为 Managed；Legacy Session
   不伪装成 Agent Session；
4. Item 首版由 `chat_history` 快照与 `agent_managed_event` 确定性投影，同一
   `publicSequence/sourceRef` 不得生成两个 Item；
5. 分页 cursor 使用服务端签名的 opaque cursor，绑定 tenant、operator、session、资源类型、排序、
   page size、底层页位置和诊断 anchor；A1/A2 允许复用现有 Repository 的 offset 分页，但开放公共路由前
   必须通过真实并发写入验证，若出现漂移则增加 keyset 查询，不能把 offset cursor 宣称为稳定快照；
6. 结果对象不包含 `bridgeEndpoint`、Harness/Runtime ID、bootId、token、lease、Pod 或本地路径；
7. A1/A2 不引入 OpenAI SDK 生产依赖。官方 JSON 形状只作为测试 fixture，供应商 DTO 留到 A4 Web Adapter。
8. 影子比较由 `copilot.agent.agent-api.shadow.enabled` 控制，默认关闭；只处理已绑定 Managed Harness
   的 Session，比较异常只记录 `error` 指标和无内容错误日志，不改变 DataAgent 查询响应。

首批测试固定为：

```text
AgentSessionQueryServiceImplTest
AgentEventStreamServiceImplTest
AgentSessionReadRepositoryImplTest
AgentApiProjectionContractTest
AgentApiTenantIsolationTest
AgentProjectionShadowServiceImplTest
ChatQueryServiceImplShadowTest
```

必须覆盖：Managed/Legacy 过滤、跨 tenant 猜 ID、Turn 终态、Item 顺序、空 Artifact、cursor
篡改、事件 replay 无重复、内部字段不泄漏。完成后运行：

```bash
MAVEN_SETTINGS=/absolute/path/to/internal-maven-settings.xml \
mvn -s "$MAVEN_SETTINGS" test \
  -pl copilot/agent -am \
  -Dtest='AgentSessionQueryServiceImplTest,AgentEventStreamServiceImplTest,AgentSessionReadRepositoryImplTest,AgentApiProjectionContractTest,AgentApiTenantIsolationTest,AgentProjectionShadowServiceImplTest,ChatQueryServiceImplShadowTest' \
  -Dsurefire.failIfNoSpecifiedTests=false \
  -Djacoco.skip=true
```

A1/A2 的 Definition of Done：同一组测试数据经现有 DataAgent 查询和新 Query Service 读取时，
Session ID、Turn ID/终态、Item 类型/顺序和最后 `publicSequence` 全部一致；不一致即阻断 A3/A4。

### A2.5：私有 Command Core、WebShell Gateway 与幂等账本

A3 需要可与浏览器 SSE 解耦的持久写入口，因此 Command Core 不能再推迟到公开写 Adapter。A2.5
只建立供应商无关的内部命令、账本和恢复语义，不开放 OpenAI 路由：

```text
application/agentapi/command/model/request/
  CreateAgentSessionCommand extends BaseCommand
  SubmitAgentTurnCommand extends BaseCommand
  CancelAgentTurnCommand extends BaseCommand
application/agentapi/command/model/result/
  AgentCommandAdmissionResult
application/agentapi/command/service/
  AgentSessionCommandService
application/agentapi/command/service/impl/
  AgentSessionCommandServiceImpl
application/managed/command/
  ManagedSessionAdmissionService
  ManagedTurnAdmissionService
  ManagedTurnDispatchService
repo/agentapi/
  AgentApiCommandLedgerRepository
repo/agentapi/model/
  AgentApiCommandRecord
infra/agentapi/
  AgentApiCommandLedgerRepositoryImpl
web/agentapi/webshell/
  WebShellAgentController
```

账本表 `agent_api_command_ledger` 的唯一键固定为
`(tenant_id, operator_id, operation, scope_id, idempotency_key)`；字段只保存
`request_digest`、`command_state`、公共 `session_id/turn_id`、稳定错误码、创建/修改时间和乐观锁版本，
不保存 Prompt、模型输出、token、endpoint、lease 或 Pod 信息。首版 DDL 固定为：

```sql
CREATE TABLE agent_api_command_ledger (
  id BIGINT NOT NULL AUTO_INCREMENT,
  tenant_id VARCHAR(128) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  operation VARCHAR(32) NOT NULL,
  scope_id VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_digest CHAR(64) NOT NULL,
  command_state VARCHAR(32) NOT NULL,
  session_id VARCHAR(128) NULL,
  turn_id VARCHAR(128) NULL,
  error_code VARCHAR(64) NULL,
  version BIGINT NOT NULL DEFAULT 0,
  gmt_create DATETIME(3) NOT NULL,
  gmt_modified DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_agent_api_command
    (tenant_id, operator_id, operation, scope_id, idempotency_key),
  KEY idx_agent_api_command_recovery (command_state, gmt_modified)
);
```

`scope_id` 的规则不能由 Adapter 自由决定：`CREATE_SESSION` 固定为 `-`，`SUBMIT_TURN` 为
`sessionId`，`CANCEL_TURN` 为 `sessionId/turnId`；digest 覆盖 agent revision、environment、input
和所有会改变执行语义的 metadata，但排除 trace、时间戳和鉴权 header。

状态机固定为：

```text
RECEIVED -> ADMITTED -> DISPATCHED -> TERMINAL
RECEIVED -> ADMITTED -> OUTCOME_UNKNOWN -> RECONCILING
                                      -> DISPATCHED|TERMINAL|RECOVERY_BLOCKED
RECEIVED|ADMITTED -> REJECTED
```

事务和恢复顺序固定如下：

1. 校验 `EnvContext`、Session owner、Agent/environment 白名单和请求大小；
2. 以唯一键锁定或创建 ledger，比较 canonical request digest；同 key 不同 digest 返回 409；
3. 服务端在 ledger 唯一键锁内只分配一次公共 Session/Turn ID，并在同一事务写 Session binding、RUNNING
   `chat_history` Managed admission 和 ledger `ADMITTED`；
4. 事务提交后触发 Hosted submit 与 Runtime warm，HTTP 立即返回原公共 ID；
5. Java 在提交前或提交后崩溃时，现有 `ManagedTurnReconciler` 从 RUNNING chat/admission 恢复；ledger
   只记录命令结果，不成为第二个 Turn 真相源；
6. 相同 key + 相同 digest 的重试只返回原 ID/状态并触发对账，不能再创建 chat row 或第二个 Harness
   Turn；cancel 重试同理；
7. 只有故障注入证明“ledger/chat 已提交但 Reconciler 无法发现”时才增加最小 Outbox，不预建通用任务
   平台。

实现时不能从新 Controller 反向调用 `DataAgentController`，也不能在数据库事务内订阅现有
`session/prompt` Flux。需要把当前 `ChatAcpCommandServiceImpl.newSession` 的 Managed Session
admission，以及 `PromptExecutor.prepareManagedAdmission + savePromptRequestToChatHistory` 的同步部分，
提取到上面的 Admission Service；两条现有 DataAgent Managed 路径和新 Command Service 共同调用它们。
`ManagedTurnDispatchService` 只在事务提交后调用现有 `ManagedPromptSubmissionService` 和 Runtime warm，
网络 I/O 不占数据库事务。可用 `TransactionSynchronization.afterCommit` 或
`@TransactionalEventListener(AFTER_COMMIT)`，但只能选一种；首版采用前者以减少新的消息抽象。

`AgentSessionCommandService` 的同步边界只到 durable admission：create/submit 返回 202 前，ledger、
Session/binding、chat/admission 必须已提交；模型完成不在 HTTP 请求内等待。现有 DataAgent SSE 仍可在
admission 后订阅 Java 公共事件并保持兼容，但执行 owner 已从浏览器连接中解耦。

A2.5 验收：两线程和两 JVM 并发提交相同 key 只得到一个 Turn；不同 digest 稳定 409；在 admission
事务提交前、提交后/dispatch 前、Harness 响应丢失三个窗口杀进程，恢复后模型 Turn 和 Tool 副作用都
最多一次；浏览器请求生命周期不拥有 Turn 生命周期。

当前完成度：A2.5 已完成本地实现。Command Ledger 使用数据库唯一键/CAS claim；submit/cancel 在
Session 行锁内串行化，同一 Session 同时只允许一个活动 Managed Turn；同 key 同 digest 返回原公共
ID，不同 digest 稳定 409；cancel 通过 durable `turn.cancel.requested` 事件跨不同幂等键去重；HTTP
202 只等待 durable admission，dispatch 使用事务提交后的回调。私有 WebShell Gateway 已提供有界
durable transcript、独立 SSE replay/follow、create/submit/cancel，浏览器连接不拥有 Turn 生命周期。
本地单元/组件测试已通过；真实 MySQL 的 ledger 快照竞争与 UNKNOWN Tool execution 双 JVM 子门禁已
通过，最小产品 Command Slice 也已通过双 HTTP JVM、Session tenant/operator 隔离和三个进程退出窗口。
完整 `LspApplication` 双 JVM 的本地直接切换验收已通过；真实负载均衡、签名鉴权和 Turn/Item/Artifact/cursor 全资源跨租户仍是生产验收门禁。

A3 开始前还要把 A2 `AgentEventResult.data` 收敛为公共 canonical payload，不能让 TypeScript 解析
ACP `sessionUpdate` 原始结构：

| `AgentEventResult.type`    | canonical `data`                                                 |
| -------------------------- | ---------------------------------------------------------------- |
| `turn.accepted`            | `{input:[ContentBlock]}`                                         |
| `item.output_text.delta`   | `{text:string}`                                                  |
| `item.reasoning.delta`     | `{text:string}`                                                  |
| `item.tool_call.updated`   | `{toolCallId,toolName,status,input?,output?,failed?,truncated?}` |
| `turn.completed`           | `{stopReason,usage?}`                                            |
| `turn.failed`              | `{code,message}`                                                 |
| `turn.cancelled`           | `{reason?}`                                                      |
| `environment.provisioning` | `{state:"starting"}`                                             |
| `environment.ready`        | `{state:"ready"}`                                                |
| `environment.failed`       | `{state:"failed",code,message}`                                  |

这个归一化在 Java `PublicEventProjector`/read View 完成并做契约测试；`JavaAgentProvider` 只做事件名到
UI event 的一对一映射，不兼容性猜测多种 ACP payload。

### A3：WebShell `JavaAgentProvider` MVP

产物：

- 已完成的 A3a：供应商无关 Provider 契约、daemon adapter、公共 `turnId` 映射，以及显式 Provider
  不读取 daemon workspace hook；
- 已完成的 A3b：`java-managed-agent-client`、Java Event projector 和独立
  `ManagedAgentWebShell`；
- Java Session create/get、Prompt submit、Managed SSE replay 和 cancel 映射；
- Java Event 到 transcript blocks 的确定性投影；
- Managed-only 入口不装配 daemon workspace/MCP/Skill/terminal/permission 能力。

验收：浏览器只访问 Java/BFF；刷新和 SSE 重连不重复 Turn/Item；取消不绕过 Java；在浏览器关闭或
SSE 断开后 Turn 继续；现有 `qwen serve` WebShell 行为不变。

当前完成度：Java client 支持 BFF POST JSON 与分片 SSE 解码，Provider 支持 create/load/submit/
subscribe/cancel，event projector 对 `publicSequence` 去重并处理 gap reconcile，Managed-only Shell
不装配 daemon Provider。6 个 WebShell 测试文件共 32 个用例、package typecheck/build 已通过；真实
浏览器 Network、登录态/CORS 和 Java 服务断流 E2E 仍待产品环境验证。

A2.5/A3 的定向测试清单固定为：

```text
AgentApiCommandLedgerRepositoryIntegrationTest
AgentSessionCommandServiceImplTest
AgentSessionCommandConcurrencyIT
AgentSessionCommandRecoveryIT
WebShellAgentControllerTest
WebShellAgentTenantIsolationTest
WebShellAgentSseReplayTest

managed-agent-provider.test.ts
java-managed-agent-client.test.ts
java-managed-agent-provider.test.ts
java-managed-agent-event-projector.test.ts
ManagedSessionsPage.test.tsx
ManagedAgentWebShell.test.tsx
```

必须覆盖：同 key 同/异 digest、两线程/两 JVM claim、三处 crash window、跨 tenant 猜 ID、有界
snapshot、POST SSE 分片解析、心跳、重复 sequence、gap reconcile、刷新、取消、浏览器 abort 不取消
Turn、显式 Java Provider 零 daemon 请求。产品 Java 定向测试通过后再执行 `copilot/agent` package；
WebShell 执行上述 vitest、package typecheck/build，最后用浏览器 E2E 检查 Network 中只有
`/api/agent/web-shell/v1/*`，不存在 Harness/Broker/Runtime URL 或凭证。

### A4：只读 OpenAI Managed Agents Adapter

状态：本地代码完成，默认关闭；单元/控制器契约及官方 SDK 7.18.0 真实 Spring HTTP/SSE 黑盒已通过，
真实租户隔离、鉴权和 BFF/反向代理待验收。

产物：

- Session retrieve/list；
- Turn、Item 和 Artifact 查询；
- Events replay/stream；
- 官方 HTTP/TypeScript SDK JSON fixture 的黑盒契约测试。

验收：只读 Adapter 不产生 Harness/Runtime 副作用，且不能跨 tenant 读取数据。

A4 的 Web 层固定落在 `web/agentapi/openai/`，只负责 snake_case DTO、参数校验、错误码和
SSE frame 映射。Controller 不直接访问 Repository、Hosted Harness 或 Runtime Broker。A4 不需要
数据库 migration，且先实现以下只读路由：

```text
GET /v1/agents/sessions
GET /v1/agents/sessions/{sessionId}
GET /v1/agents/sessions/{sessionId}/events
GET /v1/agents/sessions/{sessionId}/turns
GET /v1/agents/sessions/{sessionId}/turns/{turnId}
GET /v1/agents/sessions/{sessionId}/items
GET /v1/agents/sessions/{sessionId}/artifacts
GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}
GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}/content
```

实现已落在产品 Java 的 `web/agentapi/openai/`，通过 `AgentSessionQueryService` 和
`AgentEventStreamService` 读取现有权威数据。当前测试以官方路径和 JSON 形状验证 cursor envelope、
Session/Turn/Item/Artifact 投影、durable replay、内部事件过滤和错误外壳。官方 SDK 黑盒证据与明确的
supported/unsupported 矩阵见 [E1 契约冻结报告](./2026-09-19-managed-agent-e1-contract-evidence.md)；
测试只校验本方案明确支持的子集，beta 新字段不能被无条件落到内部模型。

### A5：OpenAI Managed Agents 写入 Adapter MVP

状态：本地代码完成，默认关闭；create/update/delete/message/cancel/stream 已复用 A2.5 Command Core，
官方 SDK 7.18.0 的真实本地 HTTP/SSE 已通过；真实网络、鉴权、两 JVM 幂等和故障恢复待验收。

产物：

- Session create/get/list/update/delete；
- input message、cancel、events stream；
- Turn/Item 查询；
- 使用官方 HTTP/TypeScript SDK 形状的黑盒兼容测试。

验收：现有 DataAgent API 和 OpenAI Adapter 对同一 Session 观察到相同 Turn 终态和 Item 内容；Adapter 不绕过 admission、权限、取消和事件存储。

A5 不再新建第二套写入内核，而是把 OpenAI schema 映射到 A2.5 已验证的 Command Core：

```text
application/agentapi/command/model/request/
  UpdateAgentSessionCommand extends BaseCommand
  DeleteAgentSessionCommand extends BaseCommand
web/agentapi/openai/
  OpenAiManagedAgentWriteController
  OpenAiManagedAgentWriteMapper
```

`POST /events` 不增加供应商专用 Command：message 映射到既有 `SubmitAgentTurnCommand`，cancellation
映射到既有 `CancelAgentTurnCommand`。update 当前只映射 `metadata.title`；delete 复用现有
`ChatSessionCommandService` 的 Hosted close/drain/delete 生命周期。创建时先在 admission 事务中写入
durable `session.created`，再由同一个 Event Stream 投影官方 `agent.session.created`；`stream=true` 不另起
模型调用，也不读取 Harness 私有 transcript。

OpenAI `Idempotency-Key` 进入同一 ledger namespace，但 `adapter=openai` 必须参与 operation/scope
归一，避免 WebShell 和 OpenAI 两种请求形状意外共用 key。相同语义最终调用同一
`AgentSessionCommandService`，Controller 不直接访问 Repository、Harness 或 Runtime。

A4/A5 当前定向验证为 6 个测试类、38 个用例；额外执行 Query/Event/WebShell/Projector 6 个测试类、
21 个回归用例。代码完成不等于可上线，生产开关保持关闭，直到第 22 节门禁全部取得证据。

### A6：Artifact 发布门禁与 required action

状态：A4 已能查询 Artifact metadata 并下载现有文本内容；不可变发布协议、二进制流和 required action
尚未实现，不阻塞纯文本 Artifact 的只读试点。

产物：

- Artifact `created` 事件、不可变 digest/retention 和二进制流式下载；
- approval required action；
- 如业务需要，再实现 `client_function` call/result 生命周期。

验收：Artifact 不能越权；同一 tool-result 幂等；Runtime-owned Tool 不错误暴露成 client required action。

### A7：Responses Adapter

产物：

- `/v1/responses` create/get/cancel/input-items；
- Response/Turn 和 output/Item 投影；
- streaming event 映射。

验收：一个 Turn 只执行一次；Managed Agents 与 Responses Adapter 查询结果来自同一内部记录。

### A8：Claude Adapter 与 Subagent

在 Subagent thread、资源和持久事件具备真实需求后再实施，不作为首版上线门槛。

## 17. PR 拆分

1. 产品 Java PR：`feat(agent): submit and recover hosted harness turns`
2. 产品 Java PR：`feat(agent): project managed harness events`
3. 产品 Java PR：`feat(agent): warm managed tool runtimes asynchronously`
4. 联合 E2E PR：`test(managed): verify cold runtime and recovery flow`
5. 产品 Java PR：`feat(agent): expose managed session application views`
6. WebShell PR：`refactor(web-shell): add managed agent provider seam`
7. 产品 Java PR：`feat(agent): add idempotent agent command core`
8. 产品 Java PR：`feat(agent): add WebShell agent gateway`
9. WebShell PR：`feat(web-shell): add Java managed agent provider`
10. 产品 Java PR：`feat(api): add managed agents read adapter`
11. 产品 Java PR：`feat(api): add managed agents write adapter`
12. 后续 PR：`feat(api): add responses compatibility adapter`

每个 PR 必须可单独回滚。公共 HTTP schema、Harness 私有协议、Runtime 生命周期和数据库 schema 不放在同一个大 PR 中。

## 18. 测试矩阵

| 场景                        | 必须断言                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| create + initial input      | 一个 Session、一个 Turn、一个 input Item；只提交一次 Harness Prompt |
| create 请求重试             | 相同 key 返回原 Session；不同 digest 返回 409                       |
| submit message 重试         | 相同 idempotency key 只产生一个公共 Turn/Harness prompt             |
| 15 秒 Runtime 冷启动        | 首模型 delta 早于 environment.ready                                 |
| 无 Tool Turn                | Runtime 未 ready 也能完成；不产生 execution                         |
| Tool Turn                   | 等原 binding；physical execute = 1                                  |
| Broker 响应丢失             | 重试查询原 execution；不重复副作用                                  |
| SSE 重连                    | 无重复 durable event；预览缺口用 snapshot 对账                      |
| Java 重启                   | admission 可恢复；事件 sequence 不回退                              |
| Harness 重启                | 从原 Session/cursor 恢复；不创建第二个 Turn                         |
| Harness event epoch 改变    | snapshot 对账后无丢失/重复 Item；公共 sequence 不回退               |
| cancel before Runtime ready | physical execute = 0                                                |
| cancel during Tool          | 完整进程树退出；迟到结果不覆盖 cancel                               |
| 两租户同 Session ID 猜测    | 404/403；无 metadata、Item 或 Artifact 泄漏                         |
| 两 Adapter 读取             | Session、Turn、Item 终态一致                                        |
| WebShell 初次连接           | 只访问 Java；create/load 后 transcript 与 Java View 一致            |
| WebShell SSE 重连           | 回传 managedLastSequence；Turn/Item 不重复、不回退                  |
| WebShell 关闭/刷新          | Turn 继续执行；重新进入只从 Java durable View/sequence 恢复         |
| WebShell cancel             | 只调用 Java cancel；不访问 Harness/Broker/Runtime                   |
| WebShell daemon 回归        | 原 Daemon Provider、workspace 和本地 `qwen serve` 行为不变          |
| 相同写 key 两 JVM 并发      | 一个 ledger、一个公共 Turn、一个 Harness admission                  |
| 相同写 key 不同 digest      | HTTP 409；不修改原 Session/Turn                                     |
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
agent_api_shadow_comparison_total{outcome}
agent_command_retry_total{operation,outcome}
agent_recovery_blocked_total
```

Trace 至少关联 `sessionId`、`publicTurnId`、`publicItemId` 和 `executionCallId`；不再记录第二套 Harness Session ID。`executionCallId` 只进入受控内部观测，不进入公共响应。

## 20. 上线与回滚

1. 先影子投影：现有 DataAgent 请求照常执行，同时只生成内部 Session/Turn/Item 投影，不开放新路由。
2. 对比现有 transcript 与公共 Item，连续验证无丢失、重复和顺序漂移。
3. 对白名单租户设置 `copilot.agent.agent-api.openai.enabled=true`，只开放 Session/Turn/Item/Artifact
   查询和 Event stream；保持 `write-enabled=false`。
4. 只读门禁通过后，再设置 `copilot.agent.agent-api.openai.write-enabled=true`，开放新建 Session 和
   message/cancel/update/delete；只影响新进入公共 Adapter 的请求。
5. 按白名单租户从单用户、1%、10% 到目标比例逐级放量；每级观察完整 Session 生命周期后再扩大。
6. 最后将 OpenAI-compatible SDK 接入声明为受支持能力。

写入回滚先关闭 `write-enabled`，保留只读查询和事件观察；全量回滚再关闭 `enabled`。已经创建的
Managed Session 继续由原 coordinator/Harness owner 完成，不得把活动 Turn 切回 Legacy。

## 21. 开放公共流量前的硬门槛

- [x] 产品 Java 已确认 Prompt admission 事务、Session 表、SSE 和鉴权接缝；
- [x] `AgentSessionQueryService`、`AgentEventStreamService`、Command Core 和本地 Repository/View
      契约已落地；
- [x] Hosted Harness 私有协议带版本、capability digest、boot fencing 和 durable event cursor；
- [x] A4/A5 默认关闭，并能独立控制只读与写入；
- [ ] 冻结首版 Agent revision 与 environment template 生产白名单；
- [ ] 冻结公共事件保留期、最大 payload、分页和 SSE 慢消费者生产参数；
- [x] 完成官方 SDK 7.18.0 对真实 Spring HTTP/SSE 的黑盒契约冻结；
- [ ] 完成真实租户隔离、BFF/反向代理 SSE、鉴权和限流验证；
- [ ] 完成产品 Java + Hosted Harness + DataAgent/ACS E2E，以及 timeout、invalid ready、crash、shutdown
      和三个 provision crash window；
- [x] 在两个完整 `LspApplication` JVM + 共享 MySQL 上完成跨节点 create/read/SSE/replay、单次 Tool 副作用和 Session tenant 隔离的本地验收；
- [ ] 在真实负载均衡上继续复验 command claim、owner crash、UNKNOWN 和 Turn/Item/Artifact/cursor 全资源隔离；
- [ ] 真实流量 Shadow 达到约定窗口内零未解释 mismatch，并形成可审计报告。

## 22. 立即执行顺序

OpenAI A4/A5 Controller 已本地完成；下一步不继续扩展 Responses、Claude、client function 或更多
beta 字段，而是冻结契约并完成真实环境门禁。两个生产开关继续保持关闭。

轨道 B（Agent API 内核，可立即开始）：

1. 已增加供应商无关的 `AgentSessionQueryService`、`AgentEventStreamService` 和现有表只读 View；
2. 影子比较代码已接入 DataAgent 历史查询；下一步对白名单实例启用
   `copilot.agent.agent-api.shadow.enabled=true`，采集真实 match/mismatch/error 指标并核对 mismatch 日志；
3. A2.5 私有 Command Core、幂等账本和 WebShell Gateway 已完成本地实现，不开放公网写流量；
4. A3b `JavaAgentProvider`、事件 projector 和无 daemon context 的
   `ManagedAgentWebShell` 已完成本地实现；
5. A4 只读 Adapter 已完成本地实现；完成真实浏览器、租户隔离、SDK 黑盒和两 JVM/MySQL 门禁后，
   只对白名单开启 `enabled`；
6. A5 写 Adapter 已复用 A2.5 Command Core；A4 观察窗口通过后才对白名单开启 `write-enabled`。

轨道 G（生产运行门禁，与轨道 B 并行）：

1. qwen-code 全量 typecheck 与 4 GB heap 构建已通过；默认 3 GB heap 构建在 `packages/cli` 的 `tsc --build` 阶段以 `SIGABRT` 退出，当前生产构建内存下限按 4 GB 管理，并建立独立减内存任务；产品 Maven package 已通过，下一步发布 `com.alibaba:qwencode-sdk:0.1.0-alpha` 到产品 CI 可解析的内部 Maven 仓库；
2. 用产品 Java + 真实 Hosted Harness 进程验证 create -> submit -> SSE -> complete、断流续传、Java 重建、cancel、idle detach/reattach 和 delete/close；
3. 在真实 DataAgent/ACS 完成网络、鉴权、冷启动和三个 provision 崩溃窗口验证；
4. 两个完整 `LspApplication` JVM + MySQL 的本地跨节点 create/read/SSE/replay 已通过；下一步在真实负载均衡上复验 durable claim、owner crash、Runtime 不可达、UNKNOWN 和全资源租户隔离；
5. 以单 Harness shard + 同机/同 Pod 反向代理完成产品试点；在实现稳定 shard registry 前不把多个 Harness replica 放到普通负载均衡后。

A5 create/message/cancel/stream 代码已存在但不等于已开放。只有在轨道 B 的影子一致性、租户隔离和
只读契约通过，且轨道 G 的真实运行门禁全部通过后，才能设置 `write-enabled=true`。稳定后再决定
Responses Adapter，不同时开放两套公网写入口。

### 22.1 下一批产品 Java 提交

| 顺序 | 状态                         | 提交                                             | 主要代码落点                                                                             | 完成门槛                                    |
| ---- | ---------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1    | 本地完成                     | `feat(agent): submit hosted harness turns`       | `domain/managed/gateway`、`infra/managed`、`application/acp/managed`                     | 同 promptId 相同 payload 只 admission 一次  |
| 2    | 本地完成                     | `feat(agent): project hosted harness events`     | `ManagedEventProjector`、`ManagedHarnessEventTranslator`、`agent_managed_event` 查询扩展 | source 重放无重复 publicSequence            |
| 3    | 本地完成                     | `feat(agent): recover managed turns`             | `ManagedTurnReconciler`、`chat_history.expands`                                          | Java 重启后不产生第二个模型 Turn            |
| 4    | 本地完成                     | `feat(agent): replay managed turns durably`      | Managed load、`agent_managed_event`、Managed durable cursor                              | 重连按 durable sequence 精确续传            |
| 5    | 本地完成                     | `feat(agent): complete managed lifecycle`        | Managed cancel、delete/close、permission fail-closed、attachment idle/shutdown detach    | cancel/恢复/关闭/权限均不进入 Legacy 路径   |
| 6    | 本地完成                     | `feat(agent): warm tool runtimes asynchronously` | Runtime Broker、warm service                                                             | 本地 E2E 已通过；真实 ACS 仍待验收          |
| 7    | 影子代码完成，待真实流量验收 | `feat(agent): expose managed session views`      | Query/Event Service、read repositories、DataAgent shadow comparator                      | 真实流量与现有 DataAgent 查询结果一致       |
| 8    | 本地完成                     | `refactor(web-shell): add agent provider seam`   | 供应商无关 Provider、daemon adapter、Managed 页面解耦                                    | daemon 回归；显式 Provider 不读 daemon hook |
| 9    | 本地 Command Slice 门禁通过  | `feat(agent): add idempotent command core`       | Command Service、ledger、Session 行锁、恢复/并发门禁                                     | 完整产品 + LB 与全资源租户隔离验收          |
| 10   | 本地完成，待真实 HTTP E2E    | `feat(agent): add WebShell agent gateway`        | 私有 Query/Command/SSE Adapter、durable snapshot                                         | 命令与浏览器流生命周期解耦                  |
| 11   | 本地完成，待浏览器 E2E       | `feat(web-shell): add Java agent provider`       | Java API client、event projector、Managed-only shell                                     | WebShell 只访问 Java，重连无重复            |
| 12   | E1 契约通过，默认关闭        | `feat(api): add managed agents read adapter`     | 独立 Adapter/Web 包                                                                      | 只读、无副作用、租户隔离                    |
| 13   | E1 契约通过，默认关闭        | `feat(api): add managed agents write adapter`    | OpenAI 写 DTO/Controller，复用 Command Core                                              | 官方形状且不分叉执行语义                    |

### 22.2 每批交付的统一完成门槛

每一批都必须同时满足以下条件，不能只以代码合入判定完成：

1. 默认配置关闭时，Legacy、`QWEN_CODE` 和 `QWEN_DAEMON_REST` 路径零行为变化；
2. Managed Session 的 owner、generation、promptId、event epoch 或 Runtime lease 任一无法证明一致时 fail-closed；
3. 同一公共 Turn 最多产生一次 Harness admission，同一 `executionCallId` 最多产生一次物理 Tool 副作用；
4. 定向单测、数据库集成测试、真实 HTTP/进程 E2E、构建和格式检查全部通过；
5. 观测中使用同一个 Session UUID 关联公共 Session、Harness/prompt 和 Tool execution，但公共响应不暴露内部 endpoint、token、lease 或 Pod 身份；
6. 提交内包含对应数据库迁移、配置默认值、灰度策略、回滚方式和故障注入结果。

最小产品验证只看四项：

1. 第一条 Prompt 的模型首 delta 不等待 Runtime ready；
2. 同一 Turn 的工具物理执行最多一次；
3. Java/Harness/Runtime/Client 任一断线都不导致 Legacy fallback 或 Session owner 漂移；
4. 现有 DataAgent API 与新 Adapter 读取同一份权威 Session/Turn/Item。

### 22.3 下一步可执行工作包

后续严格按 E1 到 E6 顺序推进；E1 已于 2026-09-19 形成
[可审计证据](./2026-09-19-managed-agent-e1-contract-evidence.md)。E2 的本地真实 MySQL/双 JVM Command
Slice 已形成 [阶段证据](./2026-09-19-managed-agent-e2-mysql-evidence.md)，E4 本地四场景进程链路也已形成
[阶段证据](./2026-09-19-managed-agent-local-process-evidence.md)，完整产品双 JVM本地链路见
[本地生产级证明](./2026-09-19-managed-agent-full-application-evidence.md)，但 E2–E4 的真实环境部分仍在进行中。前一工作包没有
形成完整可审计证据时不得打开下一阶段生产开关。

| 工作包                              | 输入                                                       | 执行动作                                                                                                                                                                    | 必须产物                                                                                                                                                                                                                | 通过条件                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| E1 契约冻结（已通过）               | 当前官方 beta 文档、13 条已实现路由、A4/A5 DTO             | 用真实 Spring HTTP 端口运行 create/get/list/update/delete、events、turns、items、artifacts；以官方 TypeScript SDK 7.18.0 可表达的请求和保存的 JSON fixture 做双向序列化校验 | [2026-09-19 兼容矩阵与证据](./2026-09-19-managed-agent-e1-contract-evidence.md)、请求脚本、响应/SSE fixture、unsupported 字段表                                                                                         | 13 条路由零未解释差异；`agent.session.created` 只有 `event_id/session/type`；11 个不支持能力稳定返回 `agent_api_unsupported_feature` |
| E2 数据与租户门禁（部分通过）       | MySQL、两个 Java 实例、两个 tenant/operator                | 并发执行相同 key 同/异 digest、跨租户猜测 Session/Turn/Artifact、进程在 claim/admit/dispatch 窗口退出后重启                                                                 | [本地 MySQL/Command Slice 阶段证据](./2026-09-19-managed-agent-e2-mysql-evidence.md)、[完整应用本地证明](./2026-09-19-managed-agent-full-application-evidence.md)、SQL 前后快照、ledger/Session/Turn 数量、故障注入日志 | 同 key 同 digest 只有一个 Session/Turn；异 digest 为 409；跨租户无数据泄漏；恢复不产生第二次 admission                               |
| E3 HTTP/SSE 门禁（本地子门禁通过）  | 测试域名、真实鉴权、BFF/网关、单 Harness shard             | 验证 create `stream=true`、独立 GET events、`Last-Event-ID` 续传、heartbeat、客户端 abort、代理 idle timeout、慢消费者                                                      | [完整应用本地证明](./2026-09-19-managed-agent-full-application-evidence.md)、真实 BFF 抓包、事件序列、断流重连报告                                                                                                      | 首事件为 created；sequence 单调且不重复；abort 不取消 Turn；公共包中无 Harness/Runtime 凭证                                          |
| E4 运行链路门禁（本地产品链路通过） | 产品 Java、真实 Hosted Harness、DataAgent/ACS Tool Runtime | 执行冷启动、无 Tool、Tool、cancel、Java/Harness/Runtime crash、UNKNOWN execute、delete/close                                                                                | [本地四场景进程证据](./2026-09-19-managed-agent-local-process-evidence.md)、[完整应用本地证明](./2026-09-19-managed-agent-full-application-evidence.md)、每个真实环境场景的 trace、binding/lease/进程残留证据           | 首 delta 不等 Runtime；物理 Tool 副作用最多一次；owner 不漂移；删除后资源最终收敛                                                    |
| E5 Shadow 验收                      | 白名单真实 DataAgent 流量                                  | 保持公共路由关闭，只启用 shadow；按 Session 对比 ID、Turn 终态、Item 顺序和 lastSequence                                                                                    | 按原因归类的 match/mismatch/error 报告                                                                                                                                                                                  | 约定观察窗口内零未解释 mismatch，error 均有处置结论                                                                                  |
| E6 灰度与回滚                       | E1--E5 全部证据                                            | 先只开 `enabled`，观察只读；再开 `write-enabled`，按单用户、1%、10% 放量；分别演练关闭写和关闭全部                                                                          | 灰度看板、阈值、回滚记录                                                                                                                                                                                                | 错误率/延迟/重连/重复副作用均低于阈值；关闭写不影响既有 Turn 完成和只读观察                                                          |

本地每次改动至少重复执行 A4/A5 六个测试类、相邻 Query/Event/WebShell/Projector 六个回归测试类，
再执行 `copilot/agent` 及依赖模块的 Maven package。E1 之后所有 fixture 必须带上游文档日期；上游 beta
变化只允许修改 Adapter 和 fixture，不允许直接改数据库对象语义。

## 23. 外部契约参考

- [OpenAI Managed Agents Sessions](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions)
- [OpenAI create agent session](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/create)
- [OpenAI update agent session](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/update)
- [OpenAI delete agent session](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/delete)
- [OpenAI submit agent session events](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/create)
- [OpenAI stream agent session events](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/stream)
- [OpenAI list session artifacts](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/artifacts/methods/list)
- [OpenAI Responses create](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Claude Managed Agents session event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)

这些外部 API 当前均包含 beta 能力，具体字段可能变化。实现时应固定本系统 Adapter 版本，并通过契约 fixture 跟踪上游变化，不能让上游 beta schema 直接成为内部数据库 schema。
