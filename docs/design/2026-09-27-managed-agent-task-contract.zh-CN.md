# Managed Agent 任务契约（H0a 阶段）

[English](2026-09-27-managed-agent-task-contract.md) | [简体中文](2026-09-27-managed-agent-task-contract.zh-CN.md)

状态：H0a 已在本次变更中实现，仅限契约（所有新增内容均为 `planned`）；H0b、H0c 和 H1～H6 待实现
日期：2026-09-27
Issue：[#12827](https://github.com/QwenLM/qwen-code/issues/12827)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)

## 1. 问题

阶段 H 把 MCP、Hooks、后台 Shell 与 Monitor、子 Agent、workflow、team、Channels
和自动化接入 Managed 路径。[扩展运行时设计][design]为每项异步能力提供同一个只读任务投影
`SessionTaskView`，并在第 11 节列出公共资源。[API 契约][api]第 6 节要求在实现 H0
之前，先在 OpenAPI 中冻结任务视图、任务查询与取消、幂等命令和错误。

[#12808](https://github.com/QwenLM/qwen-code/pull/12808) 引入的仓库内 OpenAPI
没有这些资源。目前唯一的任务接口是 daemon 路由（`GET /session/:id/tasks`、
`GET /session/:id/hooks`、`/workspace/mcp`、`/scheduled-tasks`）。设计把它们视为内部适配来源，
而不是租户级契约。没有冻结的公共结构，WebShell 和 SDK 的工作就只能以这些 daemon 路由为依据。

## 2. 目标

- 把 `SessionTaskView` 以 `PublicTask` 和 `WebShellTask` 加入 OpenAPI。
- 在公共 API 和 WebShell 适配层加入任务列表、详情、事件（输出游标）和取消。取消使用
  `Idempotency-Key`，返回 `202` 加命令 operation。
- 记录任务错误码。
- 为 MCP catalog、hook catalog、自动化和 channel 资源命名，让后续切片只补结构，不另起路径。
- 保持 D1 的验收条件：不映射任何 `planned` 路由，生成的 WebShell 类型不变。

## 3. 非目标

- 不改服务端、Harness、Broker 或 worker。不映射任何路由，也没有状态变为 `partial` 或
  `implemented`。
- 不定义 MCP、hook、自动化和 channel 资源的响应结构，由 H1、H2、H5 和 H6 定义。
- 不把任务变化投影到 Session 事件流，由 H0c 定义事件类型。`PublicEvent.type`
  是开放字符串，所以这里不需要改 schema。
- 不包含共用记录 schema（`OperationGrant`、三条状态线、`monitor_run`），那是 H0b。

## 4. 决定

### 4.1 所有新增内容均为 `planned`

这里新增的每个路由、schema 和新属性都带 `x-qwen-implementation-status: planned`，
包括加到现有 `PublicCommandOperation`、`WebShellCommandOperation`、`SessionCapabilities`
和 `WebShellSession.capabilities` 中的属性。生成器会去掉它们；服务端若映射其中任何路由，
Java 契约测试就会失败。因为新增了路由，版本升为 `1.14.0`。

### 4.2 `PublicTask`

`PublicTask` 就是按公共 API 约定表达的 `SessionTaskView`：

| `SessionTaskView`    | `PublicTask`          | `WebShellTask`       | 说明                                      |
| -------------------- | --------------------- | -------------------- | ----------------------------------------- |
| `taskId`             | `id`                  | `taskId`             | 与 `PublicSession`、`PublicAction` 一致。 |
| `sessionId`          | `session_id`          | `sessionId`          |                                           |
| `kind`               | `kind`                | `kind`               | `TaskKind`，同样五个值。                  |
| `state`              | `state`               | `state`              | `TaskState`，同样八个值。                 |
| `definitionRevision` | `definition_revision` | `definitionRevision` | `int64`，至少为 1。                       |
| `runtimeState`       | `runtime_state`       | `runtimeState`       | `TaskRuntimeState`，同样五个值。          |
| （无）               | `created_at`          | `createdAt`          | 新增，必填。                              |
| `startedAt`          | `started_at`          | `startedAt`          | epoch 毫秒，不是 ISO 字符串。             |
| `settledAt`          | `settled_at`          | `settledAt`          | epoch 毫秒，不是 ISO 字符串。             |
| `outputCursor`       | `output_cursor`       | `outputCursor`       | 不透明，最多 512 个字符。                 |
| `artifactRefs`       | `artifact_refs`       | `artifactRefs`       | 最多 100 个不重复的 Artifact ID。         |
| `actionCapabilities` | `action_capabilities` | `actionCapabilities` | `TaskActionCapability`，值不重复。        |

枚举都是共用组件（`TaskKind`、`TaskState`、`TaskRuntimeState`、`TaskActionCapability`），
与已有的 `CwdOperationStatus` 做法相同，两个接口面因此不会各自漂移。

与设计中的结构相比有四处变化：

- **`id`。** `PublicSession`、`PublicAction`、`PublicArtifact` 和 `PublicCommandOperation`
  都把自身标识命名为 `id`；WebShell 保留 `taskId`，与它保留 `actionId` 和 `operationId` 一致。
- **时间戳。** 公共 API 统一用 `int64` epoch 毫秒（`created_at`、`expires_at`），
  服务端由 `clock.millis()` 填写。
- **`created_at`。** 列表按创建顺序排列，而 `pending` 任务没有 `started_at`，所以视图需要创建时间。
- **`artifact_refs` 有上限。** 长时间运行的 Monitor 可能轮转出很多 Artifact。视图最多列出 100 个，
  Session 的 artifact 路由仍能读取全部 Artifact。

`additionalProperties: false` 拒绝设计禁止的所有字段：Runtime binding ID、generation、
Runtime endpoint、Pod、绝对路径、原始 PID、SecretHandle 和本地 sidecar。

以下三条不变式直接来自状态定义，写成 schema 条件：

- `completed`、`failed` 和 `cancelled` 是终态。终态任务有 `settled_at`，且不提供
  `cancel` 和 `send_input`。其他状态（包括 `recovery_blocked`）都没有 `settled_at`。
- `running`、`waiting` 和 `degraded` 有 `started_at`。
- `pending` 没有 `started_at`。在启动前被取消的任务结算时也没有它。

### 4.3 任务事件与输出游标

`GET /v1/agents/sessions/{sessionId}/tasks/{taskId}/events?after=` 按从旧到新的顺序返回一页
`PublicTaskEvent`。每个事件是以下之一：

- `state_changed`，带 `state`，可带 `runtime_state`；
- `output`，`text` 中是最多 16384 个字符的一段输出；若该段被截断、完整输出在 Artifact 中，
  则带 `truncated`；
- `artifact`，收到任务输出的 Artifact 的 `artifact_id`。

条件约束禁止一种类型带另一种类型的字段。按设计第 11 节的要求，高频日志和 Monitor
原始行进入 Artifact，绝不每行一个事件。

游标与 `output_cursor` 一样不透明，服务端可以用事件序号、Artifact 偏移或两者组合实现。
`after` 接受某页的 `next_cursor` 或任务的 `output_cursor`；不带 `after` 时从最早保留的事件开始。
与列表页不同，`next_cursor` 必填且不为 `null`：运行中的任务还会产生事件，读到末尾的调用方仍需要一个继续轮询的位置。
空页返回请求时的位置。`limit` 使用共用的 `ListLimit`（1～100，默认 20），因此一页最多 100 段、每段最多 16384 个字符。

`action_capabilities` 中的 `read_output` 表示该路由会返回这个任务的 `output` 事件。
没有它时，路由只返回状态和 Artifact 事件。

### 4.4 取消

取消使用 `POST /v1/agents/sessions/{sessionId}/tasks/{taskId}/cancel`，而不是设计中的
`tasks/{taskId}:cancel`。契约中的其他命令都是子路径（`/close`、`/archive`、`/unarchive`、
`/actions/{actionId}/responses`），任务取消沿用同一风格。

取消复用命令 operation 模型，不另建新模型：

- `PublicCommandOperation.type` 增加 `task_cancel`，operation 增加 `task_id`：`task_cancel`
  必须带它，其他类型都不能带。`task_cancel` 绝不带 `action_resolution`。WebShell
  镜像以同样方式增加 `taskId`。
- 通过已有的 `GET .../operations/{operationId}` 和 WebShell `operations/query` 读回该 operation。
- `202` 和 `completed` 的 operation 表示 authority 已记录这次取消，不表示任务已停止。
  任务只有在物理执行结算后才变为 `cancelled`，结果未知时变为 `recovery_blocked`。
  这遵循设计第 3.2 节：逻辑结算不能覆盖尚未 drain 的进程。
- 只有 `action_capabilities` 含 `cancel` 时路由才受理取消。已结算的任务从不提供它，
  所以同一条规则覆盖两种情况。

### 4.5 WebShell 适配层

适配层沿用现有的 `POST …/query|get|动词` 风格镜像公共路由：

| 路由                                              | 请求                            | 响应                           |
| ------------------------------------------------- | ------------------------------- | ------------------------------ |
| `POST /api/agent/web-shell/v1/tasks/query`        | `WebShellTaskQueryRequest`      | `200 WebShellTaskPage`         |
| `POST /api/agent/web-shell/v1/tasks/get`          | `WebShellTaskGetRequest`        | `200 WebShellTask`             |
| `POST /api/agent/web-shell/v1/tasks/events/query` | `WebShellTaskEventQueryRequest` | `200 WebShellTaskEventPage`    |
| `POST /api/agent/web-shell/v1/tasks/cancel`       | `WebShellTaskCancelRequest`     | `202 WebShellCommandOperation` |

取消请求在请求体中携带 `idempotencyKey`，与 `WebShellActionRespondRequest` 和
`WebShellLifecycleRequest` 相同。`SessionCapabilities.tasks` 和
`WebShellSession.capabilities.tasks`（都为 `planned`，默认 `false`）让客户端得知 Session
是否提供任务路由。

### 4.6 为后续切片命名的资源

每个资源各有一个 `planned` 的 `GET`，其 `200` 只有描述、没有响应体，后续切片补结构时无需改路径：

| 路由                                               | 切片 |
| -------------------------------------------------- | ---- |
| `GET /v1/agents/sessions/{sessionId}/mcp-catalog`  | H1   |
| `GET /v1/agents/sessions/{sessionId}/hook-catalog` | H2   |
| `GET /v1/agent-channels`                           | H5   |
| `GET /v1/agent-channels/{channelId}/deliveries`    | H5   |
| `GET /v1/agent-automations`                        | H6   |
| `GET /v1/agent-automations/{automationId}/runs`    | H6   |

变更操作、workspace MCP 管理和手动运行自动化留给这些切片。

### 4.7 错误

错误沿用 `ErrorEnvelope` 以及共用的 `BadRequest`、`Forbidden`、`NotFound`、`Conflict` 和
`CursorExpired` 响应。错误码是 API 契约已冻结的那些，另加两个任务错误码：

| 状态  | 错误码                    | 何时返回                                                      |
| ----- | ------------------------- | ------------------------------------------------------------- |
| `400` | `invalid_cursor`          | 列表游标或 `after` 格式错误，或属于另一个任务。               |
| `400` | `invalid_limit`           | `limit` 不在 1～100 之间。                                    |
| `404` | `session_not_found`       | Session 不存在或不在调用方范围内。                            |
| `404` | `task_not_found`          | 任务不存在或不在调用方范围内。新增。                          |
| `409` | `cursor_expired`          | `after` 早于保留的事件。                                      |
| `409` | `task_action_unavailable` | `action_capabilities` 不含 `cancel`，包括已结算的任务。新增。 |
| `409` | `idempotency_conflict`    | 同一个键用于不同的请求。                                      |

遇到 `cursor_expired` 后，调用方读取任务的 Artifact，再从任务当前的 `output_cursor` 继续。

## 5. 契约测试变更

`ManagedAgentApiContractTest` 只在 `API_PREFIXES` 范围内比较已映射路由与规范。
`/v1/agent-channels` 和 `/v1/agent-automations` 不以 `/v1/agents` 开头，服务端即使映射了它们也不会被发现。
两者都已加入 `API_PREFIXES`。`contract-known-gaps.txt` 没有新增任何行。

## 6. 验证

- 在 `packages/web-shell` 中运行 `npm run generate:managed-agent-api`，
  `client/components/managed/generated/managed-agent-api.ts` 没有变化，`managed-agent-api.test.ts` 通过。
- `ManagedAgentApiContractTest`（3 个测试）和 `ManagedSessionStoreContractFixtureTest`（3 个测试）
  通过，没有新增 gap 行。
- 针对规范中 schema 的 55 个 Ajv 2020-12 探针全部通过。它们覆盖每个不变式分支下的合法任务，
  并拒绝：每一种违反不变式的情形、禁止字段（`runtime_binding_id`、`generation`、`pid`）、
  未知的 kind 和状态、重复的 capability、跨类型的事件字段、超长输出、`null` 事件游标、
  缺少 `task_id` 的 `task_cancel`、其他命令类型带 `task_id`，以及带 `action_resolution` 的
  `task_cancel`（用合法的 resolution 确认是被预期的条件拒绝）。
- 变异都会使对应门禁失败：
  - 把 `cancelWebShellTask` 标为 `partial`，路由检查和场景检查失败（"is partial but not mapped"），
    生成的类型多出 75 行。
  - 探针 controller 映射 `GET /v1/agent-automations` 时报 "is mapped but planned"；
    换回旧的 `API_PREFIXES` 则静默通过。
- `openapi-typescript` 能解析包括公共路由在内的完整规范。

## 7. 后续工作

- **版本顺序。** #12822（D2）和 #12797（W0d）也把规范升为 `1.14.0`。三者中后合入的取下一个 minor 版本。
- **H0b。** 共用记录 schema，包括 `monitor_run`、三条状态线和 `OperationGrant`。它取决于 issue
  中的问题 1（`monitor_run` 是否加入封闭的 v1 领域索引）。
- **H0c。** 实现任务投影，把这些路由标为 `partial`，并定义宣告任务变化的 Session 事件。
- **后续新增。** 查询过滤（`kind`、`state`）、`send_input` 路由以及显示标签都是增量的 `planned`
  变更。`SessionTaskView` 没有标题；第一个在 WebShell 中渲染任务的切片应决定是否需要它。

[design]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md
[api]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
