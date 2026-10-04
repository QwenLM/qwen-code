# Managed Agent 任务契约（H0a 阶段）

[English](2026-09-27-managed-agent-task-contract.md) | [简体中文](2026-09-27-managed-agent-task-contract.zh-CN.md)

状态：H0a 已实现，仅限契约（它新增的每个路由和 schema，以及它加到现有 schema 的每个属性，当时均为 `planned`）；H0b 已合入；H0c 把四条任务读取路由及其 schema 标记为 `partial`，并去掉 `capabilities.tasks` 上的标记，提供任务列表与详情并宣告任务变化（[设计](2026-09-27-managed-extension-authority.zh-CN.md)）；任务事件、取消和 H1～H6 待实现
日期：2026-09-27；契约后续修订：2026-09-29
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
- 保持 D1 的验收条件：不映射任何 `planned` 路由，生成的 WebShell 类型不变。此后 H0c（#12855）已映射四条读取路由并相应改变了生成的类型；事件与取消仍为 `planned`。

## 3. 非目标

- 不改服务端、Harness、Broker 或 worker。不映射任何路由，也没有状态变为 `partial` 或
  `implemented`。
- 不定义 MCP、hook、自动化和 channel 资源的响应结构，由 H1、H2、H5 和 H6 定义。
- 不把任务变化投影到 Session 事件流，由 H0c 定义事件类型。`PublicEvent.type` 和
  `WebShellEvent.type` 都是开放字符串，所以这里不需要改 schema。
- 不包含共用记录 schema（`OperationGrant`、三条状态线、`monitor_run`），那是 H0b。

## 4. 决定

2026-09-29 的后续修订在契约 v1.23.0 中确定 [#12847](https://github.com/QwenLM/qwen-code/issues/12847) 的 A1–A8。事件和取消仍为 `planned`，不增加运行时行为。A9 与 A10 的任务路由部分已由 #12966 合入。下文原 H0a 的范围与验证仍作为历史记录保留。

### 4.1 新增内容均为 `planned`

这里新增的每个路由和 schema 都带 `x-qwen-implementation-status: planned`，加到现有 schema
（`PublicCommandOperation`、`WebShellCommandOperation`、`SessionCapabilities` 和
`WebShellSession.capabilities`）的每个属性也带。新 schema 内部的属性和两个新参数不需要单独标记：
只有 planned 的 operation 会引用它们。生成器会去掉这些内容；服务端若映射其中任何路由，
Java 契约测试就会失败。版本升为 `1.16.0`：新增了路由，而 W0d（#12797）和 D2（#12822）已经分别使用了 `1.14.0` 和 `1.15.0`。此后 H0c（#12855）已把四条读取操作及其返回的十个任务 schema 翻为 `partial`，新增已提供的 `WebShellSessionCapabilities` schema，并让 `capabilities.tasks` 变为已提供且必填；事件、取消与命令中的 `task_id`/`taskId` 字段仍为 `planned`。因此下文各段应读作 H0c 之前的状态，而非当前状态。

枚举值无法携带这个标记，而取消复用了命令 operation（见第 4.4 节）。因此新增的 `task_cancel`
命令类型在公共规范中已经可见，因为 `partial` 的归档与删除路由声明以 `PublicCommandOperation`
作为 `202` 响应，与 planned 类型 `action_response` 和 `close` 相同。只有生成的 WebShell
类型不受影响，直到任何返回 `WebShellCommandOperation` 的 WebShell 路由变为 `partial`。
单独建一个 planned 的 operation schema 可以把这个值挡在外面，代价是为一个命令多出第二套
operation 模型；本变更选择接受它可见。此后 D4 已把共用命令 operation 暴露在生成类型中，包括 `task_cancel`。本次修订把新增的任务取消专属条件整体标为 `planned`，避免生成器留下对已过滤字段的要求。取消切片提供路由时，必须连同 `task_id`/`taskId`、`failure_code`/`failureCode` 一起去掉这个标记；不收窄任何共用状态枚举。取消切片还必须持久化这两个字段：`managed_agent_operation` 没有 `task_id` 和 `failure_code`
列，需要一次迁移加入两列，worker 在与 `FAILED` 状态转换的同一事务中写入
`failure_code`，使失败原因在重新租约和重启后仍然保留（见第 7 节）。

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
所以 `PlannedTaskContractTest` 用其实例同时校验两者，只有仅限公共形状的 `object` 检查除外（见第 5 节）。

与设计中的结构相比有五处变化：

- **`id`。** `PublicSession`、`PublicAction`、`PublicArtifact` 和 `PublicCommandOperation`
  都把自身标识命名为 `id`；WebShell 保留 `taskId`，与它保留 `actionId` 和 `operationId` 一致。
- **`object`。** Session、Turn、Item、Artifact 和 Workspace 资源都带 `object` 判别字段，
  它们的列表带 `object: "list"`；operation、事件条目和 planned 的 Action 家族不带。`PublicTask`、
  `PublicTaskList` 和 `PublicTaskEventList` 也带上它，因为以后再加必填字段会破坏客户端。
- **时间戳。** 公共 API 统一用 `int64` epoch 毫秒（`created_at`、`expires_at`），
  服务端由 `clock.millis()` 填写。
- **`created_at`。** 列表按创建顺序排列，而 `pending` 任务没有 `started_at`，所以视图需要创建时间。
- **`artifact_refs` 有上限。** 视图列出最新的 100 个，按从旧到新排列。在能够枚举更早的
  Artifact 并追溯到任务之前（见第 4.7 节和第 7 节），任务不得轮转出超过该上限的条目：
  被逐出的 Artifact 仍可按 id 通过 Session 的 artifact 路由读取，但无法再按任务发现。

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

条件约束禁止一种已知类型带另一种类型的字段。类型集合保持开放。同一主版本内，客户端忽略未知可选字段和未知任务事件类型，但仍保存其游标。任务事件没有终态标志。封闭 schema 校验服务端按自身契约版本发出的响应；不支持用旧 minor 版本严格校验新版本响应。允许新增可选字段，但不能在已知类型上复用原本禁止的字段。这遵循 API 契约第 5 节，并保留现有扁平事件结构（A8）。

每个事件都带 `schema_version` 和 `projection_version`。其身份、位置、载荷和接受时的版本在投影重建、重启和归档后保持不变。即使用 Artifact 偏移实现，游标也绝不重新分配给别的事件；归档必须保留其逻辑位置（A5）。稳定性不排除正常的保留过期。

每个任务的事件以已提交前缀发布：任何事件、分页或 `output_cursor` 位置一旦返回，就不能再有事件出现在它之前或同一位置。提交前分配递增序号并不够；并发写入必须串行发布，或让读取等待未完成的写入。这不要求不同任务之间全局排序，也不要求内部序号连续（A2）。

每个事件都带 `cursor`，即该事件之后的不透明位置，同时作为其身份。消费方原子地应用事件并保存游标，才能在崩溃后避免重复应用同一段输出。一页的 `next_cursor` 是最后一个事件的游标，因此 `limit` 不会越过事件。空页时，它是请求的位置；省略 `after` 时则是保留下限。即使已无保留事件，它仍必填且不为 `null`。

持久化保留下限是最新已过期事件之后的位置；若从未有事件过期，则为流的初始位置。只允许最旧的前缀过期。严格早于下限的游标返回 `409 cursor_expired`，等于下限则合法。保留集为空、重启或投影重建都不能丢掉下限。例如事件 1 到 10 过期后，事件 10 之后的游标合法，事件 9 之后的游标已过期，即使保留集为空也一样。这些是逻辑位置，客户端不能比较游标字符串（A1）。

`after` 接受事件游标、分页游标或任务的 `output_cursor`；省略时从下限开始读取。`output_cursor` 是读取视图时的已提交末尾，刻意跳过更早的输出。恢复必须保留事件分页的检查点，不能用随后任务视图中的末尾替换它。

高频日志和 Monitor 原始行进入 Artifact 或这个单段有上限的分页流，绝不逐行写入 Session 事件。按时间保留是正常归档时的目标，不是无条件删除期限。任何产生输出的任务都要求 `capabilities.artifacts`，包括只向 Artifact 输出的任务。输出事件只有在完整文本已持久归档，并且能按第 4.7 节通过任务 Artifact 发现机制读取后，才允许自身以及后续事件过期（A3–A4）。归档失败不能让下限越过该输出。H3 必须限制持久积压量，并在容量耗尽之前定义生产端背压与准入阻塞；不能在该策略下保全已接受输出的适配器，不得启用产生输出的任务。不能为了达到保留时间目标静默丢弃输出。这些运行时机制属于 H3 的验收门槛，本次契约变更并未实现它们。

这个事件流与 API 契约第 4 节中的 Session 事件历史不同。后者使用公开的整数 `sequence`，
读取严格大于它的事件，`limit` 最大 1000、默认 100：

- 游标与设计中的 `outputCursor` 一样不透明，服务端可以用事件序号、Artifact 偏移或两者组合实现。
- `limit` 使用共用的 `ListLimit`（1～100，默认 20），因为一个事件可带 16384 个字符，
  而 Session 事件只带很小的增量。一页最多 100 段。
- 格式错误或属于另一个任务的 `after` 返回 `400 invalid_event_cursor`，与 Session 事件历史已使用的错误码相同。

`action_capabilities` 描述的是任务而不是调用方：它列出任务当前支持的操作，对每个调用方都相同。
调用方能否取消是另一项授权检查（取消路由上的 `403`）；读取输出只需要读权限。`read_output` 表示该路由会返回这个任务的
`output` 事件。它在任务生命周期内不会改变；没有它的任务不产生输出事件，其输出只进入 Artifact。因此该路由从不过滤掉已存在的事件，
本节和第 4.7 节的保证对每个任务都成立。

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

可信 tenant/actor 过滤器与请求解码之后，取消按以下顺序检查（A6）：

1. 校验键：缺失返回 `400 invalid_request`，格式错误返回 `400 invalid_idempotency_key`。
2. 检查当前访问权：Session 或任务不可读时返回 `404`；可读但无权取消时返回 `403 task_forbidden`。
3. 在 tenant/Session/operation-kind/actor/key 域内查找保留的幂等记录。请求摘要包含任务 ID，排除仅用于 trace 的请求 ID。摘要不同返回 `409 idempotency_conflict`；相同则返回同一 operation ID、其最新持久状态及 `replayed: true`。
4. 仅对新请求依次检查任务支持（`400 unsupported_feature`）、Session 是否为 `active`（否则 `409 session_not_active`，包括 `closing`、`closed`、`archived` 和 `deleting`），最后检查 `action_capabilities` 是否含 `cancel`（否则 `409 task_action_unavailable`）。
5. 原子地复核新请求准入条件并创建 operation，让竞争请求与 Session/任务状态转换串行化。同键并发中已有请求先成功时，按第 3 步处理，不作为新请求。准入还要求该 Session 上没有其他未完成（`pending` 或 `running`）的 operation：取消 operation 与生命周期命令共用同一张持久 operation 表，后者每个 Session 只允许一个未完成的 operation，因此任何未完成的 operation 都会返回 `409 session_operation_active`，而一个未完成的取消同样会阻塞 close、archive 和 delete。

因此，保留的键可以跨越能力和状态变化，但绝不绕过当前访问权检查。资源缺失/已删除或权限撤销仍可返回 `404` 或 `403`；重放承诺以访问权和记录仍保留为前提。合法同键重试不会仅因支持被关闭或任务已结算，就变成新请求的 `400` 或 `409`。

取消 operation 的结果如下（A7）：

| 结果                  | 含义                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| HTTP `202`            | Java 已持久受理命令并承担投递责任，不证明 owner 已接受或物理执行已停止。                          |
| `pending` / `running` | 投递或确认尚未完成；可重试的传输故障保持在这里。                                                  |
| `completed`           | 任务 authority 已持久记录取消并返回该 operation 的回执，不证明物理执行已停止。                    |
| `failed`              | 能确定命令未被接受且不会再投递，`failure_code` 解释原因。                                         |
| `recovery_blocked`    | 恢复无法确定 authority 是否接受了命令；在对账之前不得报告成功或自动重新执行。                     |
| `cancelled`           | `task_cancel` 不产生此状态：本契约没有撤回取消命令的机制。共用状态仍可供其他 operation 类型使用。 |

`task_cancel` operation 的其余状态字段随其结果确定。`pending` 和 `running` 携带
`admission_stage: java_durable`，`delivery_state` 在两次尝试之间为 `pending`、尝试进行中为
`leased`，不带 `receipt_id`。`completed` 携带 `admission_stage: harness_confirmed`、
`delivery_state: confirmed` 和任务权威方签发的 `receipt_id`。`failed` 和 `recovery_blocked`
携带 `admission_stage: java_durable` 和 `delivery_state: blocked` —— 投递已经停止，
确定未被接受或尚未对账的命令不会再被认领和驱动 —— 且不带 `receipt_id`；`failed` 另带
`failure_code`。`blocked` 表示在对账之前不再尝试投递；目前没有其他 operation 类型产生该值。

任务只有在取消使物理执行结算后才变为 `cancelled`。自然完成若在竞争中胜出，保留自身的终态；命令受理不能覆盖它。物理结果未知会使任务成为 `recovery_blocked`，这与 operation 的受理结果相互独立。

不同键分别通过准入（包括第 5 步要求的 Session 上无其他未完成
operation）时，创建不同 operation。它们的物理停止请求可以合并或安全重复，但每个 operation 都必须有自己的记录结果。后到请求若已无 `cancel` 能力，则返回 `409 task_action_unavailable`；两个不同键不保证两次受理。不新增取消 operation 的路由。

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
`WebShellSession.capabilities.tasks` 加入时为 `planned`、默认 `false`；H0c 已让二者变为已提供且必填，因此客户端总能读到 Session 是否提供任务路由。与 Action 家族一样，公共列表命名为 `…List`，WebShell 分页命名为 `…Page`。

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
`CursorExpired` 响应。错误码包括 API 契约已冻结的那些、幂等路由已在返回的 `invalid_idempotency_key`、
租户过滤器的 `invalid_tenant` 与 `actor_scope_mismatch`，以及三个新增的任务错误码：

| 状态  | 错误码                     | 何时返回                                                                                                                                                   |
| ----- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400` | `invalid_tenant`           | 缺少 `X-Qwen-Tenant-Id` 或格式错误（租户过滤器）。                                                                                                         |
| `400` | `invalid_cursor`           | 任务列表游标格式错误。                                                                                                                                     |
| `400` | `invalid_event_cursor`     | `after` 格式错误或属于另一个任务。                                                                                                                         |
| `400` | `invalid_limit`            | `limit` 不在 1～100 之间。                                                                                                                                 |
| `400` | `invalid_request`          | 缺少 `Idempotency-Key`。                                                                                                                                   |
| `400` | `invalid_idempotency_key`  | `Idempotency-Key` 格式错误，与其他幂等路由相同。                                                                                                           |
| `400` | `unsupported_feature`      | 该 Session 不提供任务（`capabilities.tasks` 为 `false`）。只有仍为 `planned` 的事件与取消路由会返回它；已提供的读取路由永不会返回，因为该标志恒为 `true`。 |
| `403` | `task_forbidden`           | 调用方可以读取该任务，但无权取消它。新增。                                                                                                                 |
| `403` | `actor_scope_mismatch`     | 已认证的 actor 属于其他租户或其 ID 非法（租户过滤器）。                                                                                                    |
| `404` | `session_not_found`        | Session 不存在或不在调用方范围内。                                                                                                                         |
| `404` | `task_not_found`           | 任务不存在或不在调用方范围内。新增。                                                                                                                       |
| `409` | `cursor_expired`           | `after` 严格早于持久保留下限，保留集为空也一样。                                                                                                           |
| `409` | `task_action_unavailable`  | 使用新键时 `action_capabilities` 不含 `cancel`，包括已结算的任务。新增。                                                                                   |
| `409` | `session_not_active`       | 新取消请求指向非 active 的 Session。                                                                                                                       |
| `409` | `session_operation_active` | 新取消请求到达时 Session 上有另一个未完成的 operation，与生命周期路由相同。                                                                                |
| `409` | `idempotency_conflict`     | 同一个键用于不同的请求。                                                                                                                                   |

按 API 契约第 10 节，无权读取任务的调用方收到 `404`，而不是 `403`。只读路由唯一会返回的 `403` 是租户过滤器的
`actor_scope_mismatch`，针对来自其他租户或 ID 非法的已认证 actor。过滤器覆盖每条 `/v1/agents/` 与 WebShell 路由；任务只读路由从
`1.21.0` 起声明它，与 Session 和 Turn 的读取路由一致，取消路由另有 `task_forbidden`。`cursor_expired`
的错误封装中 `replay_floor_sequence` 和 `snapshot_through_sequence` 保持缺省，因为任务游标是不透明的。
`cursor_expired` 后按以下顺序恢复（A3）：

1. 省略 `after` 从下限读取一页保留事件，保存其 `next_cursor`。不要等待 `has_more` 变成 false：活跃的生产者可能不断增加事件。
2. 在这些事件读取**之后**读取新的任务视图，再发现并读取其 Artifact。不能复用事件读取之前缓存的 `artifact_refs`。
3. 从保存的分页游标继续读取事件，包括第一页因上限未返回的事件。若下限追过读者，则重新恢复；不能把再次出现的 `409` 当作空页。H3 定义稳定的输出段身份/范围，用于无重叠地衔接 Artifact 与事件。

输出事件过期之前，其完整文本必须能从持久 Artifact 读取，且恢复读取必须能发现该 Artifact。仅写入 blob，或更新了投影但随后读取仍可能落后，都不够。服务端必须在推进下限之前保证这种可见性。截断事件同样要求完整输出在发布时已经持久可读、可被发现。

在能够枚举更早的 Artifact 并追溯到任务之前，任务不得轮转出超过 `artifact_refs` 的 100 个条目。H3 必须执行这个上限，或者与 O2/O4 一起落地归属机制后才允许超限轮转。该机制存在后，恢复必须同时枚举更早的 Artifact 与最新引用；有上限的视图本身并不完整。这些保证以任务及其 Artifact 按资源保留和授权规则仍可读取为前提，不承诺资源删除后的恢复。并发清理可能需要再次恢复，但绝不能静默越过尚未归档的输出。

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
除仅限公共形状的 `object` 检查外，再改名为 camelCase 后针对 WebShell 镜像校验一遍，因此条件约束在某一个接口面抄错时测试会失败。
WebShell 的取消请求和事件查询请求也在校验之列。从 `1.21.0` 起，它还要求四条 `planned` 任务路由声明租户过滤器的
`403`，因为 `ManagedAgentApiContractTest` 无法探测它们。

## 6. 验证

### 6.1 契约后续修订验收

本次修订增加空事件页、类型集合开放但对象封闭的事件，以及两个接口面和 operation union 中任务取消结果的 schema 实例。重新生成类型不能暴露 planned 路由或字段；共用 operation 的描述可以变化。Schema 测试不能证明上述运行时保证。在 H3 或取消切片把路由标为 `partial` 前，必须证明：

- 游标低于/等于下限时的过期边界，包括保留集为空；
- 并发延迟提交不能出现在已返回游标之前；
- 游标与接受时的事件身份在重启、重建和归档后保持不变；
- Artifact 投影延迟、归档失败和 100 个引用上限不能静默丢输出，恢复衔接输出段时不重复；
- 声明 `capabilities.tasks` 但未声明 `capabilities.artifacts` 的 Session
  不能接纳产生输出的任务，包括输出只写入 Artifact 的任务；
- 能力/Session/任务变化后的重放、撤销访问权、摘要冲突以及同键/不同键并发都遵循第 4.4 节；
- 丢失的取消回执通过对账处理，不能报告为确定失败或任务物理结算。

### 6.2 H0a 历史验证

- 在 `packages/web-shell` 中运行 `npm run generate:managed-agent-api`，
  `client/components/managed/generated/managed-agent-api.ts` 没有变化，`managed-agent-api.test.ts` 通过。
- `ManagedAgentApiContractTest`（5 个测试）、`PlannedTaskContractTest`（5 个测试，103 次校验：
  50 次公共形状、49 次 WebShell 镜像、4 次 WebShell 请求；`1.21.0` 增加了第六个测试，见第 5 节）和
  `ManagedSessionStoreContractFixtureTest`（3 个测试）通过，没有新增 gap 行。
  自 H0c 起分工有所不同：`ManagedAgentApiContractTest` 验证四条已提供的读取路由，事件与取消仍由 `PlannedTaskContractTest` 承担。
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

- **版本顺序。** W0d（#12797）以 `1.14.0`、D2（#12822）以 `1.15.0` 先于本变更合入，因此本变更为 `1.16.0`。在它之前合入的任何规范改动都会使它再取下一个 minor 版本。
- **H0b。** 共用记录 schema，包括 `monitor_run`、三条状态线和 `OperationGrant`，即 #12837。它把
  `monitor_run` 加入封闭的 v1 领域索引，回答了 issue 中的问题 1，并且仍不开放该 domain 的提交。
- **H0c。** 实现任务投影，把这些路由标为 `partial`，并定义宣告任务变化的 Session 事件。
  只标记路由还不够：`PublicCommandOperation.task_id`、`WebShellCommandOperation.taskId`
  和两个 `capabilities.tasks` 标志都是独立的 `planned` 属性，承载其中一个标志的
  `WebShellSession.capabilities` 对象本身也是 planned。此后两个 `capabilities.tasks`
  标志已随 H0c（#12855）变为已提供且必填，该对象则已提供但非必填；本变更把该对象加入
  `WebShellSession.required`，与早已要求它的公开 `Session` 对齐，生成的 WebShell 类型
  由此不再带 `?`。`task_id` 与 `taskId` 按 H0c 决策 9 随取消保持 `planned`。
- **输出恢复。** H3 定义输出分段，并随之定义 `cursor_expired` 之后调用方如何无重叠地衔接任务的
  Artifact 与保留的事件。
- **Artifact 归属。** `PublicArtifact` 没有任务引用，artifact 列表也没有按任务过滤，
  所以 `artifact_refs` 中最新 100 个之外的 Artifact 无法追溯到其任务。Artifact 切片（O2、O4）
  必须在任务能轮转出这么多 Artifact 之前落地两者之一。
- **取消 operation 存储。** `managed_agent_operation`（V17）没有 `task_id` 和
  `failure_code` 列。取消切片通过迁移加入两列，并在与 `FAILED` 状态转换的同一事务中写入
  `failure_code`，使已租约 worker 得知的失败原因在重新租约和重启后仍然保留（见第 4.1 节）。
- **Legacy 状态。** daemon 的任务状态包括 `paused`，workflow 运行还有 `pausing`；`TaskState`
  两者都没有。已在 #12847（A9）决定：适配切片（H3 或 H4）把两者都映射为 `waiting`，`TaskState`
  不增加状态。H0c 已把 `TaskState` 连同其八个值标为 `partial`，按 API 契约第 5 节，此后再增加
  一个值就是破坏性变更。
- **后续新增。** 查询过滤（`kind`、`state`）、`send_input` 路由以及显示标签都是增量的 `planned`
  变更。`SessionTaskView` 没有标题；第一个在 WebShell 中渲染任务的切片应决定是否需要它。

[design]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md
[api]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
