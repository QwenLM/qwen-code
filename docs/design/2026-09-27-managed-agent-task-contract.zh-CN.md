# Managed Agent 任务契约（H0a 阶段）

[English](2026-09-27-managed-agent-task-contract.md) | [简体中文](2026-09-27-managed-agent-task-contract.zh-CN.md)

状态：H0a 已在本次变更中实现，仅限契约（新增的每个路由和 schema，以及加到现有 schema 的每个属性，均为 `planned`）；H0b、H0c 和 H1～H6 待实现
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
- 不把任务变化投影到 Session 事件流，由 H0c 定义事件类型。`PublicEvent.type` 和
  `WebShellEvent.type` 都是开放字符串，所以这里不需要改 schema。
- 不包含共用记录 schema（`OperationGrant`、三条状态线、`monitor_run`），那是 H0b。

## 4. 决定

### 4.1 新增内容均为 `planned`

这里新增的每个路由和 schema 都带 `x-qwen-implementation-status: planned`，加到现有 schema
（`PublicCommandOperation`、`WebShellCommandOperation`、`SessionCapabilities` 和
`WebShellSession.capabilities`）的每个属性也带。新 schema 内部的属性和两个新参数不需要单独标记：
只有 planned 的 operation 会引用它们。生成器会去掉这些内容；服务端若映射其中任何路由，
Java 契约测试就会失败。版本升为 `1.15.0`：新增了路由，而 W0d（#12797）已经使用了 `1.14.0`。

枚举值无法携带这个标记，而取消复用了命令 operation（见第 4.4 节）。因此新增的 `task_cancel`
命令类型在公共规范中已经可见，因为 `partial` 的归档与删除路由声明以 `PublicCommandOperation`
作为 `202` 响应，与 planned 类型 `action_response` 和 `close` 相同。只有生成的 WebShell
类型不受影响，直到任何返回 `WebShellCommandOperation` 的 WebShell 路由变为 `partial`。
单独建一个 planned 的 operation schema 可以把这个值挡在外面，代价是为一个命令多出第二套
operation 模型；本变更选择接受它可见。

### 4.2 `PublicTask`

`PublicTask` 就是按已提供的公共资源约定表达的 `SessionTaskView`：

| `SessionTaskView`    | `PublicTask`          | `WebShellTask`       | 说明                                      |
| -------------------- | --------------------- | -------------------- | ----------------------------------------- |
| `taskId`             | `id`                  | `taskId`             | 与 `PublicSession`、`PublicAction` 一致。 |
| （无）               | `object`              | （无）               | 新增，`agent.task`。                      |
| `sessionId`          | `session_id`          | `sessionId`          |                                           |
| `kind`               | `kind`                | `kind`               | `TaskKind`，同样五个值。                  |
| `state`              | `state`               | `state`              | `TaskState`，同样八个值。                 |
| `definitionRevision` | `definition_revision` | `definitionRevision` | `int64`，至少为 1。                       |
| `runtimeState`       | `runtime_state`       | `runtimeState`       | `TaskRuntimeState`，同样五个值。          |
| （无）               | `created_at`          | `createdAt`          | 新增，必填。                              |
| `startedAt`          | `started_at`          | `startedAt`          | epoch 毫秒，不是 ISO 字符串。             |
| `settledAt`          | `settled_at`          | `settledAt`          | epoch 毫秒，不是 ISO 字符串。             |
| `outputCursor`       | `output_cursor`       | `outputCursor`       | 不透明，最多 512 个字符。                 |
| `artifactRefs`       | `artifact_refs`       | `artifactRefs`       | 最多最新的 100 个，不重复。               |
| `actionCapabilities` | `action_capabilities` | `actionCapabilities` | `TaskActionCapability`，值不重复。        |

枚举都是共用组件（`TaskKind`、`TaskState`、`TaskRuntimeState` 和 `TaskActionCapability`），
与已有的 `CwdOperationStatus` 做法相同，开放的事件类型 `TaskEventType` 也是共用组件。条件约束和上下限在两个接口面各有一份，
所以 `PlannedTaskContractTest` 用每个实例同时校验两者（见第 5 节）。

与设计中的结构相比有五处变化：

- **`id`。** `PublicSession`、`PublicAction`、`PublicArtifact` 和 `PublicCommandOperation`
  都把自身标识命名为 `id`；WebShell 保留 `taskId`，与它保留 `actionId` 和 `operationId` 一致。
- **`object`。** Session、Turn、Item、Artifact 和 Workspace 资源都带 `object` 判别字段，
  它们的列表带 `object: "list"`；operation、事件条目和 planned 的 Action 家族不带。`PublicTask`、
  `PublicTaskList` 和 `PublicTaskEventList` 也带上它，因为以后再加必填字段会破坏客户端。
- **时间戳。** 公共 API 统一用 `int64` epoch 毫秒（`created_at`、`expires_at`），
  服务端由 `clock.millis()` 填写。
- **`created_at`。** 列表按创建顺序排列，而 `pending` 任务没有 `started_at`，所以视图需要创建时间。
- **`artifact_refs` 有上限。** 长时间运行的 Monitor 可能轮转出很多 Artifact。视图列出最新的
  100 个，按从旧到新排列；更早的 Artifact 仍可通过 Session 的 artifact 路由读取。

可选字段缺省时省略，从不为 `null`，与 Action 家族相同；实现该视图的 record 需要
`@JsonInclude(NON_NULL)`，已有若干 API record 这样做。`additionalProperties: false`
拒绝设计禁止的所有字段：Runtime binding ID、generation、Runtime endpoint、Pod、绝对路径、
原始 PID、SecretHandle 和本地 sidecar。

列表按 `created_at`、再按 `id` 降序排列，即最新的在前。这与 API 契约中 Session 列表的顺序相同，
只是用创建时间代替更新时间，因此任务状态变化时不会在分页之间移动。

以下不变式写成 schema 条件：

- `completed`、`failed` 和 `cancelled` 是终态。终态任务有 `settled_at`，且不提供 `cancel`
  和 `send_input`。
- `running`、`waiting`、`degraded` 和 `completed` 有 `started_at`。`pending` 没有。
  在启动前失败或被取消的任务结算时也没有它。
- 按设计第 3.2 节，`recovery_blocked` 是逻辑运行线的一个终点，但它不是结算：恢复无法证明物理结果。
  因此它没有 `settled_at`。它仍可提供 `cancel`，让调用方请求所有者停止可能仍在运行的部分；
  但绝不提供 `send_input`，因为向状态未知的执行发送输入可能导致重复执行。这是一项决定，设计中并未写明。

### 4.3 任务事件与输出游标

`GET /v1/agents/sessions/{sessionId}/tasks/{taskId}/events?after=` 按从旧到新的顺序返回一个
`PublicTaskEventList`。目前定义的事件类型是：

- `state_changed`，带 `state`，可带 `runtime_state`；
- `output`，`text` 中是 1～16384 个字符的一段输出；若该段被截断、完整输出在 Artifact 中，
  则带 `truncated`；
- `artifact`，收到任务输出的 Artifact 的 `artifact_id`。

条件约束禁止一种类型带另一种类型的字段。类型集合是开放的：后续 minor 版本可以增加类型，
连同它需要的可选字段一起加入，客户端忽略不认识的类型，与 API 契约第 5 节的要求一致。按 API 契约第 5 节对公共事件的要求，每个事件都带 `schema_version` 和
`projection_version`。按设计第 11 节的要求，高频日志和 Monitor 原始行进入 Artifact，绝不每行一个事件；
事件只保留有限时间，不会永久保存。

每个事件都带 `cursor`，即该事件之后的位置，它同时也是事件的标识。消费方为每个已应用的事件保存游标，
崩溃后恢复时就不会把同一段输出应用两次。一页的 `next_cursor` 是服务端检查过的最后一个事件之后的位置，
包括该路由不返回的事件，因此即使一页的事件全被过滤掉，游标也会前进；没有检查任何事件时，它是请求时的位置，
不带 `after` 时则是保留事件的起点。与列表页不同，`next_cursor`
必填且不为 `null`：运行中的任务还会产生事件，读到末尾的调用方仍需要一个继续轮询的位置。
`after` 接受事件或分页的游标，或任务的 `output_cursor`；不带 `after` 时从最早保留的事件开始。

这个事件流与 API 契约第 4 节中的 Session 事件历史不同。后者使用公开的整数 `sequence`，
读取严格大于它的事件，`limit` 最大 1000、默认 100：

- 游标与设计中的 `outputCursor` 一样不透明，服务端可以用事件序号、Artifact 偏移或两者组合实现。
- `limit` 使用共用的 `ListLimit`（1～100，默认 20），因为一个事件可带 16384 个字符，
  而 Session 事件只带很小的增量。一页最多 100 段。
- 格式错误或属于另一个任务的 `after` 返回 `400 invalid_event_cursor`，与 Session 事件历史已使用的错误码相同。

`action_capabilities` 描述的是任务而不是调用方：它列出任务当前支持的操作，对每个调用方都相同；
调用方能否使用某个操作是另一项授权检查。`read_output` 表示该路由会返回这个任务的 `output` 事件。
没有它时，路由只返回状态和 Artifact 事件。

### 4.4 取消

取消使用 `POST /v1/agents/sessions/{sessionId}/tasks/{taskId}/cancel`，而不是设计中的
`tasks/{taskId}:cancel`。契约中没有任何路由使用 `:` 后缀；针对已有 Session 的命令使用子路径
（`/close`、`/archive`、`/unarchive`、`/cwd`、`/actions/{actionId}/responses`）、`POST …/events`、
`PATCH` 或 `DELETE`，任务取消采用子路径形式。

取消复用命令 operation 模型，不另建新模型：

- `PublicCommandOperation.type` 增加 `task_cancel`，operation 增加 `task_id`：`task_cancel`
  必须带它，其他类型都不能带。`task_cancel` 绝不带 `action_resolution`。WebShell
  镜像以同样方式增加 `taskId`。
- 通过已有的 `GET .../operations/{operationId}` 和 WebShell `operations/query` 读回该 operation。
- 检查按固定顺序进行：访问权限（调用方无法读取任务时返回 `404`，可以读取但无权取消时返回
  `403 task_forbidden`），然后是幂等重放，最后是任务状态。因此同一 actor 使用同一个
  `Idempotency-Key` 和相同请求的重试，即使任务已经结算也会重放原 operation，与 cwd 切换以及
  API 契约第 3 节和第 10 节的要求一致；丢失的 `202` 绝不会让发起请求的调用方收到 `409`。
- `202` 和 `completed` 的 operation 表示 authority 已记录这次取消，不表示任务已停止。
  任务只有在物理执行结算后才变为 `cancelled`，结果未知时变为 `recovery_blocked`。
  这遵循设计第 3.2 节：逻辑结算不能覆盖尚未 drain 的进程。
- 只有 `action_capabilities` 含 `cancel` 时才受理新的键。已结算的任务从不提供它，
  所以同一条规则覆盖两种情况。

### 4.5 WebShell 适配层

适配层沿用现有风格镜像公共路由，即以 `query`、`get` 或动词结尾的 `POST` 路由：

| 路由                                              | 请求                            | 响应                           |
| ------------------------------------------------- | ------------------------------- | ------------------------------ |
| `POST /api/agent/web-shell/v1/tasks/query`        | `WebShellTaskQueryRequest`      | `200 WebShellTaskPage`         |
| `POST /api/agent/web-shell/v1/tasks/get`          | `WebShellTaskGetRequest`        | `200 WebShellTask`             |
| `POST /api/agent/web-shell/v1/tasks/events/query` | `WebShellTaskEventQueryRequest` | `200 WebShellTaskEventPage`    |
| `POST /api/agent/web-shell/v1/tasks/cancel`       | `WebShellTaskCancelRequest`     | `202 WebShellCommandOperation` |

取消请求在请求体中携带 `idempotencyKey`，与 `WebShellActionRespondRequest` 和
`WebShellLifecycleRequest` 相同。`SessionCapabilities.tasks` 和
`WebShellSession.capabilities.tasks`（都为 `planned`，默认 `false`）让客户端得知 Session
是否提供任务路由。与 Action 家族一样，公共列表命名为 `…List`，WebShell 分页命名为 `…Page`。

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

变更操作、workspace MCP 管理和手动运行自动化留给这些切片，这些路由所声明错误响应的含义也由它们定义。

### 4.7 错误

错误沿用 `ErrorEnvelope` 以及共用的 `BadRequest`、`Forbidden`、`NotFound`、`Conflict` 和
`CursorExpired` 响应。错误码包括 API 契约已冻结的那些、幂等路由已在返回的 `invalid_idempotency_key`，
以及三个新增的任务错误码：

| 状态  | 错误码                    | 何时返回                                                                 |
| ----- | ------------------------- | ------------------------------------------------------------------------ |
| `400` | `invalid_cursor`          | 任务列表游标格式错误。                                                   |
| `400` | `invalid_event_cursor`    | `after` 格式错误或属于另一个任务。                                       |
| `400` | `invalid_limit`           | `limit` 不在 1～100 之间。                                               |
| `400` | `invalid_request`         | 缺少 `Idempotency-Key`。                                                 |
| `400` | `invalid_idempotency_key` | `Idempotency-Key` 格式错误，与其他幂等路由相同。                         |
| `400` | `unsupported_feature`     | 该 Session 不提供任务（`capabilities.tasks` 为 `false`）。               |
| `403` | `task_forbidden`          | 调用方可以读取该任务，但无权取消它。新增。                               |
| `404` | `session_not_found`       | Session 不存在或不在调用方范围内。                                       |
| `404` | `task_not_found`          | 任务不存在或不在调用方范围内。新增。                                     |
| `409` | `cursor_expired`          | `after` 早于保留的事件。                                                 |
| `409` | `task_action_unavailable` | 使用新键时 `action_capabilities` 不含 `cancel`，包括已结算的任务。新增。 |
| `409` | `idempotency_conflict`    | 同一个键用于不同的请求。                                                 |

按 API 契约第 10 节，无权读取任务的调用方收到 `404`，而不是 `403`，所以只读路由不声明 `403`，只有取消声明。`cursor_expired`
的错误封装中 `replay_floor_sequence` 和 `snapshot_through_sequence` 保持缺省，因为任务游标是不透明的。
输出事件只有在其文本已进入 Artifact 后才会过期，因此调用方先读取任务的 Artifact、再从头读取保留的事件，
不会漏掉任何输出。两者之间如何无重叠地衔接取决于输出如何分段，由 H3 定义。

## 5. 契约测试变更

`ManagedAgentApiContractTest` 只在 `API_PREFIXES` 范围内比较已映射路由与规范。
`/v1/agent-channels` 和 `/v1/agent-automations` 不以 `/v1/agents` 开头，服务端即使映射了它们也不会被发现。
前缀改为 `/v1/agent`，它覆盖 `/v1/agents` 以及后续切片新增的每个 `/v1/agent-*` 资源，
[D1 设计](2026-09-27-managed-agent-api-contract.zh-CN.md)第 5.1 节也已相应更新。
`contract-known-gaps.txt` 没有新增任何行。

同一个测试只校验非 `planned` 的 operation，所以在 H0c 映射路由之前，任务 schema 中的条件约束即使写错也无人发现。
新增的 `PlannedTaskContractTest` 使用同一个校验器，用合法与非法实例校验这些 schema：
任务不变式、禁止字段、每种事件类型只有一种结构、事件版本、列表与分页游标，以及 `task_cancel` operation
（包括经由 `PublicOperation` 和 `WebShellOperation` union 的校验）。每个实例按公共形状只写一次，
再改名为 camelCase 后针对 WebShell 镜像校验一遍，因此条件约束在某一个接口面抄错时测试会失败。
WebShell 的取消请求和事件查询请求也在校验之列。

## 6. 验证

- 在 `packages/web-shell` 中运行 `npm run generate:managed-agent-api`，
  `client/components/managed/generated/managed-agent-api.ts` 没有变化，`managed-agent-api.test.ts` 通过。
- `ManagedAgentApiContractTest`（3 个测试）、`PlannedTaskContractTest`（5 个测试，103 次校验：
  50 次公共形状、49 次 WebShell 镜像、4 次 WebShell 请求）和
  `ManagedSessionStoreContractFixtureTest`（3 个测试）通过，没有新增 gap 行。
- 变异都会使对应门禁失败：
  - 在同一个接口面上删除任务、任务事件、任务列表的条件约束、`task_cancel` 规则以及输出最小长度后，
    `PlannedTaskContractTest` 在该接口面的 22 个实例上失败，公共 schema 和 WebShell 镜像都是如此。
  - 删除 `state_changed` 对 `state` 的要求、`artifact` 对 `artifact_id` 的要求，或者从开始时间规则中去掉
    `waiting` 或 `degraded`，都会使它在一个实例上失败。
  - 把 `cancelWebShellTask` 标为 `partial`，路由检查和场景检查失败（"is partial but not mapped"），
    生成的类型多出 75 行，其中包括命令类型中的 `task_cancel`（见第 4.1 节）。
  - 探针 controller 映射 `GET /v1/agent-automations` 时报 "is mapped but planned"；
    换回之前的前缀则静默通过。
- `openapi-typescript` 能解析包括公共路由在内的完整规范。

## 7. 后续工作

- **版本顺序。** W0d（#12797）已先以 `1.14.0` 合入，因此本变更为 `1.15.0`。D2（#12822）也会修改规范；两者中后合入的取下一个 minor 版本。
- **H0b。** 共用记录 schema，包括 `monitor_run`、三条状态线和 `OperationGrant`。它取决于 issue
  中的问题 1（`monitor_run` 是否加入封闭的 v1 领域索引）。
- **H0c。** 实现任务投影，把这些路由标为 `partial`，并定义宣告任务变化的 Session 事件。
  只标记路由还不够：`PublicCommandOperation.task_id`、`WebShellCommandOperation.taskId`
  和两个 `capabilities.tasks` 标志都是独立的 `planned` 属性，承载其中一个标志的
  `WebShellSession.capabilities` 对象本身也是 planned，在它们也被标记之前不会进入生成的类型。
- **输出恢复。** H3 定义输出分段，并随之定义 `cursor_expired` 之后调用方如何无重叠地衔接任务的
  Artifact 与保留的事件。
- **Artifact 归属。** `PublicArtifact` 没有任务引用，artifact 列表也没有按任务过滤，
  所以 `artifact_refs` 中最新 100 个之外的 Artifact 无法追溯到其任务。Artifact 切片（O2、O4）
  应在任务能轮转出这么多 Artifact 之前加上两者之一。
- **Legacy 状态。** daemon 的任务状态包括 `paused`，workflow 运行还有 `pausing`；`TaskState`
  两者都没有。适配切片（H3 或 H4）负责映射它们（最可能映射为 `waiting`），或由设计增加一个状态。
- **后续新增。** 查询过滤（`kind`、`state`）、`send_input` 路由以及显示标签都是增量的 `planned`
  变更。`SessionTaskView` 没有标题；第一个在 WebShell 中渲染任务的切片应决定是否需要它。

[design]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md
[api]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
