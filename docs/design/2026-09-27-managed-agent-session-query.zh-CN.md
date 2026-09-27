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
- 持久化的归档与删除 operation（生命周期工作），以及 Session workspace 的
  `context_revision` 与 `state`（Workspace 上下文工作）。
- AgentDefinition。在它落地之前只存在一个 agent revision。

## 4. 决策

### 4.1 契约 v1.14

- `PublicSession.status` 加入 `archived`，即服务端一直为已归档 Session 返回的值。
  计划中的 `archived_at` 字段不变。如果生命周期工作以后改用 `closed` 加
  `archived_at` 表示归档，那将是一次单独的契约变更。
- `ErrorEnvelope.error.request_id` 改为必填，与契约第 3 节的表述一致。
- 声明服务端实际返回的错误响应：事件查询、Items 列表、WebShell 会话列表与查询的
  `400`；WebShell transcript、事件流、提交与取消的 `400` 与 `404`。
- 上述六条 Session 路由改为 `implemented`。

### 4.2 `agent_revision`

revision 来自新配置 `qwen.managed-agent.agent-revision`（环境变量
`QWEN_MANAGED_AGENT_REVISION`，默认 `1`）。它在准入时写入 Session 行，因此以后修改
配置不会改写已有 Session。Flyway V13 新增该列，已有行取 `1`。

创建请求可以指定 `agent_revision`。与当前 revision 不同的值会被拒绝，返回
`400 unsupported_feature`。由于唯一可接受的显式值等于省略时解析出的值，该字段不
计入幂等摘要；等 AgentDefinition 支持多个 revision 时再调整。

### 4.3 能力与水位

- `capabilities` 报告 `items: true`，`snapshots`、`resync` 与 `artifacts` 为
  `false`。Snapshot 重置与 resync 随 D3 到来，契约禁止在服务端能兑现之前声明它们。
  计划中的可选标志不返回；schema 规定其默认值为 `false`。
- `replay_floor_sequence` 为 `0`。事件目前从不清理；D3 负责持久化下限。
- `snapshot_through_sequence` 是该 Session 的 Snapshot 已覆盖的 sequence，与 Items
  列表返回的值相同；首次物化之前为 `0`。读取时不加载 Snapshot 的 Item。
- `input_item_id` 为 `item_<turnId>_input`，即输入 Item 物化时使用的 id。

### 4.4 Request id

一个在租户解析之前运行的过滤器为每个请求分配 id。如果传入的 `X-Request-Id` 是
不超过 128 个字符的可见 ASCII，就使用它，否则生成随机 UUID。在 WebShell 的创建、
提交与取消中，请求体里的 `requestId` 会替换它。契约允许该字段是任意不超过 128
个字符的字符串，因此不适合放进 header 的值会被忽略而不是拒绝。该 id 会在每个
响应的 `X-Request-Id` 中返回，写入 `error.request_id`，并放入日志 MDC，由
`logging.pattern.correlation` 配置输出。

### 4.5 输入类型

服务端接受 `input_text`，并继续接受旧客户端发送的 `text`。两者归一化为相同的
Harness 输入，因此请求摘要与幂等重放都不变。WebShell 客户端现在发送
`input_text`，这意味着新版客户端需要包含本次变更的服务端。

### 4.6 SSE 路由上的 JSON 错误

新增的错误探测发现，只发送 `Accept: text/event-stream` 的客户端（WebShell 客户端
正是如此）收到的是 500，而不是 `404` 或 `400` 错误信封，因为 JSON 信封不是可接受
的表示。错误响应现在预设 `Content-Type: application/json`，内容协商不再丢弃它们。

## 5. 契约测试

- 场景发送 `input_text`，分别指定当前与其他 agent revision，并探测每个新声明的
  错误状态码。只有期望成功的调用才对照 schema 校验请求体，因为错误探测会故意发送
  不合法的请求体。
- 每个响应都必须带 `X-Request-Id`，错误的 `request_id` 必须与之相等，WebShell 的
  `requestId` 必须被原样回传。
- 差异行不得指向 `implemented` 的 operation。
- 一致性测试通过 WebShell 适配层创建一个 Session，把公共入口的查询与列表同
  WebShell 的查询与列表对照：身份、agent、状态与最后 sequence 必须一致。两个入口的
  跨租户读取都返回 `404 session_not_found`。
- 差异文件从 51 行减少到 21 行；剩下的是 D3、生命周期与 Workspace 上下文工作。

## 6. 兼容性

- 公共 Session 与 Turn 响应以及错误信封只新增字段，没有删除。
- 已归档的 Session 仍返回 `status: "archived"`，该值现在属于契约。
- 服务端接受两种输入写法。WebShell 客户端发送 `input_text`，需要包含本次变更的
  服务端。
- 生成的 `@qwen-code/web-shell` 类型现在要求错误信封带 `request_id`，客户端的创建
  与提交请求使用 `input_text` 输入块。
- Flyway V13 新增一个带默认值的列，不改写任何数据。

## 7. 验证

- Managed Agent 服务的完整测试与 Checkstyle 通过，包括契约测试与一致性测试。
- 以下变更分别使对应检查失败：去掉 WebShell `requestId` 的回传、从错误信封中去掉
  `request_id`、让某个入口返回不同的状态、为 `implemented` 的 operation 登记差异、
  拒绝 `input_text`。
- 在修复 JSON 内容类型之前，SSE 错误探测失败，抛出的正是 WebShell 客户端会看到的
  500 所对应的异常。
- WebShell 的 typecheck、managed 组件测试与 managed-progress e2e 用例在重新生成的
  类型下通过。

## 8. 后续工作

- D3：差异文件中剩余的事件重放差异。
- 生命周期工作：持久化的归档与删除，以及归档是否改为 `closed` 加 `archived_at`。
- Workspace 上下文工作：Session workspace 的 `context_revision` 与 `state`，以及在
  场景中读取已绑定的 Session。
