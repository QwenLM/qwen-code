# Managed Agent 会话查询（D2 阶段）

[English](2026-09-27-managed-agent-session-query.md) | [简体中文](2026-09-27-managed-agent-session-query.zh-CN.md)

状态：已在本次变更中实现
日期：2026-09-27
Issue：[#12793](https://github.com/QwenLM/qwen-code/issues/12793)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
前置：[Managed Agent API 契约（D1 阶段）](2026-09-27-managed-agent-api-contract.zh-CN.md)

## 1. 问题

D1 把评审过的 OpenAPI 放进本仓库，并把它与服务端之间的每处差异记为预期失败。
两个入口上的 Session 创建、列表与查询路由仍有以下差异：

- `PublicSession` 缺少 schema 必填的 `agent_revision` 与 `capabilities`，也缺少
  `replay_floor_sequence` 与 `snapshot_through_sequence` 两个水位。`PublicTurn`
  缺少 `input_item_id`。
- 错误信封没有 `request_id`，任何响应都不带 `X-Request-Id`。WebShell 的
  `requestId` 被接收但从未读取。
- `WebShellStreamRequest` 仍带有契约已删除的 `limit`。
- 契约把输入块命名为 `input_text`；服务端只接受 `text`，WebShell 客户端发送的也
  是 `text`。
- 已归档的 Session 读回时 `status` 为 `"archived"`，而契约的状态枚举没有该值。
- 若干 operation 没有声明服务端实际返回的错误状态码，契约测试因此从未校验过这些
  错误信封。
- W0d（[#12797](https://github.com/QwenLM/qwen-code/pull/12797)）把空 Session
  绑定到 Workspace。已绑定 Session 的 `workspace` 缺少必填的 `context_revision`
  与 `state`，W0d 把它们记为创建与查询路由上的差异。

issue 为 D2 规定的验收条件是：这六条路由改为 `implemented`；同一个 Session 在两个
入口返回相同的身份、状态与 sequence；跨租户读取返回 `404 session_not_found`。

## 2. 目标

- 关闭 D1 记录的所有 D2 差异，且不新增差异行。
- 把 `createSession`、`listSessions`、`getSession`、`webShellListSessions`、
  `webShellGetSession` 与 `webShellCreateSession` 改为 `implemented`。
- 为每个响应分配仅用于追踪的 request id，并写入每个错误信封和日志。
- 证明同一个 Session 在两个入口上一致。

## 3. 非目标

- 事件版本、顶层 Item 与 Part 身份、真实的 `has_more`、最大为 1000 的事件
  limit、持久化的回放下限、`cursor_expired` 与 resync。这些属于 D3。
- 持久化的归档与删除 operation（生命周期工作），以及上下文变更（W2）：它会提升
  `context_revision`，并报告 `state` 的其他取值。
- AgentDefinition。D8a 已存储定义 revision；在 D8b 让会话固定已存储的
  revision 之前，会话仍使用配置的 revision。

## 4. 决策

### 4.1 契约 v1.15

- Session 与 Turn 的状态枚举加入服务端已经在返回的值。Session 在归档后读回
  `archived`；在 Harness 不可用、归档或删除等待重试期间读回 `archiving` 或
  `deleting`。Turn 在取消被受理到结算之间读回 `cancelling`。计划中的
  `archived_at` 字段不变。如果生命周期工作以后改用 `closed` 加 `archived_at`
  表示归档，那将是一次单独的契约变更。
- `ErrorEnvelope.error.request_id` 改为必填，与 D1 设计文档所链接的
  [公共 API 契约][contract]第 3 节的表述一致。
- 新增两个共享响应：`Unauthorized`（401）与 `Unavailable`（503）。已实现的
  operation 声明服务端自身处理器为其返回的每个状态码。两个入口的 Session 创建新增
  `401 actor_required`（指定了 Workspace 但没有可信 actor）与 `503`（Hosted
  Harness 不可用）。Session 查询新增 `400 invalid_tenant`，WebShell 会话列表与
  查询新增 `400`。两个入口的 Session 查询与列表新增租户过滤器返回的
  `403 actor_scope_mismatch`。`405`、`415` 等框架响应仍未声明，不接受 JSON 的
  客户端会得到不带响应体的 `406`。部分实现的 operation 新增新探测所覆盖的 `400`
  与 `404`：事件查询与 Items 列表的 `400`，以及 WebShell transcript、事件流、提交与
  取消的 `400` 与 `404`。
- 上述六条 Session 路由改为 `implemented`。`implemented` 覆盖的是 operation 中
  未标为 `planned` 的部分，因此包括标为 `partial` 的 `workspace` 字段，由 4.4 节
  补齐。

### 4.2 `agent_revision`

revision 来自新配置 `qwen.managed-agent.agent-revision`（环境变量
`QWEN_MANAGED_AGENT_REVISION`，默认 `1`）。它在准入时写入 Session 行，因此以后修改
配置不会改写已有 Session。Flyway V13 新增该列，已有行取 `1`。

创建请求可以指定 `agent_revision`。新的准入如果指定了与当前 revision 不同的值，
会被拒绝并返回 `400 unsupported_feature`。store 在查找幂等重放之后、预留创建或
解析 Workspace 之前做这项检查，因此配置变更后，对已准入创建的重试仍会返回原来的
Session。显式 revision 计入幂等摘要，省略则不计入，因此省略该字段的请求摘要不变。重试时
增加、去掉或修改该字段属于不同的请求，返回 `409 idempotency_conflict`。在本次变更
之前就指定了该字段的请求同样如此，因为它当时的摘要忽略了该字段；本仓库中没有
客户端发送该字段。

### 4.3 能力与水位

- `capabilities` 报告 `items: true`，`snapshots`、`resync` 与 `artifacts` 为
  `false`。Snapshot 重置与 resync 随 D3 到来，契约禁止在服务端能兑现之前声明它们。
  计划中的可选标志不返回；schema 规定其默认值为 `false`。
- `replay_floor_sequence` 为 `0`。事件目前从不清理；D3 负责持久化下限。
- `snapshot_through_sequence` 是该 Session 的 Snapshot 已覆盖的 sequence，与 Items
  列表返回的值相同；首次物化之前为 `0`。读取时按主键查询，不加载 Snapshot 的
  Item；每个 Session 一次查询，与活动 Turn 已有的查询方式相同。Session 行与
  Snapshot 分别读取，因此在事件物化期间，该水位可能短暂领先于 `last_event_id`。
  流重整会丢弃 Snapshot，因此在 Item 重建之前，该水位也可能回落到 `0`。
- `input_item_id` 为 `item_<turnId>_input`，即输入 Item 物化时使用的 id。

### 4.4 Session workspace

已绑定 Session 的 `workspace` 现在在两个入口上都带有 `context_revision` 与
`state`。`context_revision` 是自 V7 起随绑定存储的 revision，创建时为 `1`。
`state` 始终为 `ready`：在 W2 之前没有任何操作能改变上下文，W2 会加入 `changing`
与 `recovery_blocked`。在那之前，`WorkspaceContext` schema 保持 `partial`。
WebShell 客户端原先省略这两个字段的本地类型，现在改用生成的类型。

### 4.5 Request id

一个在租户解析之前运行的过滤器为每个请求分配 id。如果传入的 `X-Request-Id` 是
不超过 128 个字符的可见 ASCII，就使用它，否则生成随机 UUID。在 WebShell 的创建、
提交与取消中，处理器运行后，请求体里的 `requestId` 会替换它。契约允许该字段是
任意不超过 128 个字符的字符串，因此不适合放进 header 的值会被忽略而不是拒绝；更长
的值会因校验失败返回 `400`。在处理器运行之前就失败的请求（例如缺少租户或请求体
不合法）保留过滤器分配的 id。该 id 会在每个响应的 `X-Request-Id` 中返回，写入
`error.request_id`，并放入日志 MDC，由 `logging.pattern.correlation` 配置输出。
WebShell 客户端现在为每次创建（包括绑定 Workspace 的空创建）、提交与取消生成新的
`requestId`，不再复用幂等键；契约的 `RequestId` header 说明禁止这种用法。因此重试
保留幂等键，但使用新的 `requestId`。

### 4.6 输入类型

服务端接受 `input_text`，并继续接受旧客户端发送的 `text`。两者归一化为相同的
Harness 输入，因此请求摘要与幂等重放都不变。WebShell 客户端现在发送
`input_text`，这意味着新版客户端需要包含本次变更的服务端。

### 4.7 SSE 路由上的 JSON 错误

新增的错误探测发现，只发送 `Accept: text/event-stream` 的客户端（WebShell 客户端
正是如此）遇到的是未处理的异常，而不是 `404` 或 `400` 错误信封，因为 JSON 信封不是
可接受的表示；servlet 容器会把这种异常变成 500。错误响应现在预设
`Content-Type: application/json`，内容协商不再丢弃它们。事件流一旦开始，响应就
已提交，错误无法再变成信封，因此处理器不再触碰这样的响应，而不是把 JSON 追加到
事件流中。`Accept` header 不包含 JSON 的请求会得到不带响应体的 `406`，与预设内容
类型之前的行为相同。

## 5. 契约测试

- 场景发送 `input_text`，并分别指定当前与其他 agent revision。它探测本次变更
  声明的每个状态码，包括缺少租户的请求、来自其他租户的已认证 actor、没有 actor
  的 Workspace 选择以及 Harness 被停用的情况。只有期望成功的调用才对照 schema
  校验请求体，因为错误探测会故意发送不合法的请求体。
- 场景在 Turn 取消中、以及归档等待重试时读取 Session，检查 `cancelling`、
  `input_item_id` 与 `archiving`。它还在两个入口读取已绑定的 Session，检查
  `context_revision` 为 `1`、`state` 为 `ready`。
- 每个响应都必须带 `X-Request-Id`，错误的 `request_id` 必须与之相等，WebShell 的
  `requestId` 必须被原样回传。另一个测试发送安全与不安全的 `X-Request-Id`，以及
  不安全的请求体 `requestId`。
- request 或 response 差异行不得指向 `implemented` 的 operation。
- 一致性测试通过 WebShell 适配层创建一个 Session，把公共入口的查询与列表同
  WebShell 的查询与列表对照：身份、agent、状态与最后 sequence 必须一致。它还校验
  revision、capabilities、回放下限，以及与 Items 列表一致的快照水位，并检查两个
  入口的跨租户读取都返回 `404 session_not_found`。
- 差异文件从 57 行（D1 的 51 行加上 W0d 新增的 6 行）减少到 17 行；剩下的是 D3
  与生命周期工作。

## 6. 兼容性

- 公共 Session 与 Turn 响应、Session workspace 以及错误信封只新增字段，没有
  删除。
- 服务端早已返回的状态值（`archived`、`archiving`、`deleting`、`cancelling`）现在
  属于契约。
- 服务端接受两种输入写法。WebShell 客户端发送 `input_text`，需要包含本次变更的
  服务端。
- 超过 128 个字符的 WebShell `requestId` 现在按契约 schema 的要求返回 `400`。
- 生成的 `@qwen-code/web-shell` 类型现在要求错误信封带 `request_id`，客户端的创建
  与提交请求使用 `input_text` 输入块。客户端的 Session 类型要求 Session workspace
  带 `contextRevision` 与 `state`。
- Flyway V13 新增一个带默认值的列，不改写任何数据。

## 7. 验证

- Managed Agent 服务的完整测试与 Checkstyle 通过，包括契约测试与一致性测试。
- 以下变更分别使对应检查失败：去掉 WebShell `requestId` 的回传、从错误信封中去掉
  `request_id`、让某个入口返回不同的状态、为 `implemented` 的 operation 登记差异、
  拒绝 `input_text`。
- 配置变更后，指定已准入 revision 的重试会重放原来的 Session；跳过重放查询会使
  该测试失败。
- 在修复 JSON 内容类型之前，SSE 错误探测失败，抛出的正是 WebShell 客户端会看到的
  500 所对应的异常。
- 一个单元测试检查：已提交的事件流上发生错误时不写入任何内容。
- MySQL 升级测试（CI 在 MariaDB 上运行）从 V13 之前创建的 Session 读回 revision
  `1`；本地在 H2 的 MySQL 模式下复现了同样的升级。
- revision 测试覆盖两条创建路径，并通过配置了另一个 revision 的 service 读回已存储
  的 revision。一个 `406` 测试覆盖不可接受的媒体类型。
- WebShell 的 typecheck、managed 组件测试与 managed-progress e2e 用例在重新生成的
  类型下通过。W0d 浏览器用例在 `WorkspaceBrowserFixtureMain` 上通过，其中包括创建
  响应被丢弃后的重试。

## 8. 后续工作

- D3：差异文件中剩余的事件重放差异。
- 生命周期工作：持久化的归档与删除，以及归档是否改为 `closed` 加 `archived_at`。
- W2：上下文变更会提升 `context_revision`，报告 `changing` 与
  `recovery_blocked`，并让 `WorkspaceContext` schema 不再是 `partial`。

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
