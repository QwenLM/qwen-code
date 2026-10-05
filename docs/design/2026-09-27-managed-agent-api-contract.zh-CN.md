# Managed Agent API 契约（D1 阶段）

[English](2026-09-27-managed-agent-api-contract.md) | [简体中文](2026-09-27-managed-agent-api-contract.zh-CN.md)

状态：D1 已实现；D2 已在[会话查询](2026-09-27-managed-agent-session-query.zh-CN.md)中实现；D3 已在[事件回放](2026-09-27-managed-agent-event-replay.zh-CN.md)中实现；生命周期工作作为 [#12867](https://github.com/QwenLM/qwen-code/issues/12867) 的 D4 已在[持久生命周期](2026-09-28-managed-agent-durable-lifecycle.zh-CN.md)中实现；D5 已在 [Turn 查询](2026-09-28-managed-agent-turn-queries.zh-CN.md)中实现；D6 已在 [Actions](2026-09-30-managed-agent-actions.zh-CN.md) 中设计，其中 Hosted Harness 部分（D6a）已实现
日期：2026-09-27
Issue：[#12793](https://github.com/QwenLM/qwen-code/issues/12793)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)

## 1. 问题

Managed Agent 服务在 `/v1/agents/sessions` 下提供公共 Session 路由，在
`/api/agent/web-shell/v1` 下提供 WebShell 适配层。它们评审过的契约，即
[公共 API 契约][contract]与 [OpenAPI v1.12][openapi]，只存在于设计仓库。
本仓库里的 `ApiModels.java` 和
`packages/web-shell/client/components/managed/java-managed-agent-client.ts`
中的接口都是手写的，没有任何检查把它们或 Spring 实际映射的路由与 schema
对照。每个新字段（W0b 的 `workspace`，以及计划中的 Artifact、Action）都要手工
添加两遍，且没有校验。

契约第 3–5、7、8 节定义了请求关联、分页、重放、版本与能力、已知实现差异，
并规定路由只有在契约测试通过后才能从 `partial` 改为 `implemented`。D 阶段分三
个切片关闭这些差异；D1 提供契约本身以及 D2、D3 所依赖的检查。

## 2. 目标

- 把评审过的 OpenAPI 放进本仓库，作为 Java 服务、WebShell TypeScript 客户端和
  契约测试的唯一来源。
- 由它生成 WebShell TypeScript 类型，已提交的类型过期时 CI 失败。
- Java record、Spring 映射的路由或 `partial` 路由的真实响应与 spec 不一致时，
  CI 失败。
- 把当前差异记录为显式的预期失败，让 D2、D3 逐条删除；已修复的差异不能继续留在
  清单里。

## 3. 非目标

- 没有路由改为 `implemented`。已上线的生命周期路由（4.3）以及 W0d 的发现与
  绑定能力（4.5）记为 `partial`。
- 不改变服务行为。D1 只记录 D2、D3 必须修复的内容。
- 不为了让当前服务通过而删除 schema 字段。
- 持久准入、Turn、AgentDefinition、Artifact、Workspace 执行与上下文切换、Action 与事件保留策略
  与 issue 一致，不在范围内。

## 4. 决策

### 4.1 spec 的位置与格式

spec 迁入
`packages/sdk-java/managed-agent-server/src/main/resources/openapi/managed-agent-public-api.openapi.json`
并成为唯一来源；设计仓库此后指向这里。

它以 JSON 而不是 YAML 保存。本仓库的 yamllint 规则要求标量使用单引号且使用块
风格，上游 YAML 有 2264 处不符合。JSON 沿用
`docs/developers/daemon-rest-api.openapi.json` 的先例，两端都不需要 YAML 解析
器，并与仓库其余文件一样由 Prettier 格式化。转换保留键顺序，除 4.3 与 4.5 的改动外
无损。

D1 为生命周期路由（4.3）引入了 `1.13.0`。集成 W0d 新增了 Workspace 查询路由，
版本推进到 `1.14.0`（4.5）。

### 4.2 生成 TypeScript，校验 Java

- **TypeScript 由生成得到。** WebShell 类型由 `openapi-typescript` 生成。客户端
  导出的名称（`JavaAgentSession`、`JavaAgentEvent` 等）保留，改为生成类型的
  别名。`JavaAgentEnvironment` 仍为手写，因为契约把 `environment` 定义为开放
  对象。
- **Java record 只校验，不生成。** 它们带有 Bean Validation 与 Jackson 注解，
  生成器需要重新表达这些注解。改为由契约测试把它们与 schema 对照（5.2）。

### 4.3 已上线但与 v1.12 不一致的路由

main 已经提供改名（`PATCH /v1/agents/sessions/{sessionId}`）、`unarchive`、
`archive` 与 `DELETE`。第 8 节禁止映射 `planned` 路由，因此 v1.13 把这四条都
记为 `partial`：

- `archive` 与 `DELETE` 保留评审过的 v1.10 目标（`202` 加
  `PublicCommandOperation`）。当前的 `200` 响应作为生命周期工作的已知差异。
- `updateSession`（改名）与 `unarchiveSession` 没有评审过的目标，按 main 当前
  返回的结构加入：`200`、`PublicSession` 与 `X-Qwen-Idempotent-Replay`。
  `UpdateSessionRequest` 要求 1 到 256 个字符的 `title`。它们是否像 `archive`
  一样改为持久 operation，由生命周期工作决定。

### 4.4 AgentDefinition 之前的 `agent_revision`

`PublicSession.agent_revision` 是必填字段。D2 返回取自服务端 agent 配置的固定
revision，D1 只记录该字段缺失。D8a（v1.29）把 `/v1/agents` 路由实现为已存储、
不可变的 revision；在 D8b 让会话固定已存储的 revision 之前，会话仍使用配置的
revision。参见 [AgentDefinition revision](2026-10-01-managed-agent-definitions.zh-CN.md)。

### 4.5 W0d 发现与空会话绑定

W0d 集成把公共 Workspace 列表与查询、WebShell Workspace 列表与查询，以及
Session 的 Workspace 选择与读回标为 `partial`，补上缺失的 WebShell
`workspaces/get` operation，并重新生成客户端类型。Workspace 列表使用独立的请求
schema：limit 默认 50、上限 100，cursor 最长 2048 个字符。

发现响应中必填的 `workspace_binding` / `workspaceBinding` 能力只表示发现、
空会话创建与绑定读回，不启用 Workspace 执行或上下文切换。既有的
`workspace_context` / `workspaceContext` 能力仍为 false。

发现接口现已返回目标 schema 要求的公共 Workspace `id` 与 `object`，以及
WebShell 的小写状态。绑定 Session 仍只有 Workspace 标识与 cwd，因此真实请求
覆盖把缺少的上下文 revision 与状态记录给 W2。客户端本地覆盖仅用于该 Session
绑定。

## 5. Java 契约测试

`ManagedAgentApiContractTest` 运行在普通的 `mvn test` 中，使用
`ManagedAgentServerIntegrationTest` 的假 Harness 和自己的内存 H2 数据库。两个
测试类加载各自的 Spring 上下文，每个上下文的调度器都会轮询自己的数据库；如果共用
数据库，一个测试的调度器会认领另一个测试的 Turn。它使用 test 作用域的
`com.networknt:json-schema-validator`（1.5.9，与 Spring Boot 3.5 一样基于
Jackson 2），按 JSON Schema 2020-12 校验并开启 format 断言。schema 通过指向
spec 的 JSON Pointer 定位，因此 `$ref` 在同一个文件内解析。

### 5.1 路由

测试从 Spring 的 `RequestMappingHandlerMapping` 读取 `/v1/agent` 与
`/api/agent/web-shell/v1` 下的全部路由，与 spec 对照。第一个前缀覆盖 `/v1/agents` 以及
[H0a 任务契约](2026-09-27-managed-agent-task-contract.zh-CN.md)命名的 `/v1/agent-*` 资源；
D1 只读取 `/v1/agents`。映射了 spec 中不存在或标为 `planned` 的路由会失败；
`partial` 或 `implemented` 的路由没有映射也会失败。4.3 与 4.5 之后没有路由差异。

### 5.2 Record

`ApiModels` 中的每个 record 都必须对应一个 schema，否则测试会报告。对每一对，
由 Jackson 自身的属性解析给出 JSON 名称：

- schema 中未标为 `planned`、而 record 中没有的属性，报告为 `missing`；
- record 中有、而 schema 未定义的属性，报告为 `extra`。

`oneOf` 与 `allOf` 的成员会合并，因此 `SessionEventRequest` 同时与输入事件和取消
事件对照。

### 5.3 真实请求

一个场景通过 MockMvc 在假 Harness 上调用每个非 `planned` 的 operation：公共 API
上的一个已完成 Turn、一次输入与一次取消、改名、归档、对已归档 Session 的一次查询
与一次列表、取消归档与删除；WebShell 适配层上带首条消息与不带首条消息的创建、
列表、查询、transcript、提交、取消与 SSE 流；以及跨租户 `404` 和幂等 `409` 错误。
Workspace 请求覆盖四条发现路由、当前页外的默认 Workspace，以及两个入口的绑定
空会话创建与读回（包括 cwd 规范化）。每次调用检查：

- 测试发送的请求体符合请求 schema；
- 状态码是 spec 对该调用期望的状态码；
- 响应体符合实际状态码所声明的 schema；
- 响应声明的每个 header 都存在；
- 每个 SSE 帧的 `id` 等于事件的 `sequence`，`event` 等于事件类型，`data` 符合
  `PublicEvent` 或 `WebShellEvent`。

如果场景漏掉了 spec 中未标为 `planned` 的 operation，测试同样失败，因此路由改为
`partial` 后必须被调用到。

### 5.4 已知差异

每个失败都归一化为稳定的一行：数组下标写成 `*`，一行包含 operation、状态码、
位置、关键字与属性。三个测试把各自的行与
`src/test/resources/openapi/contract-known-gaps.txt` 对照。文件中没有的行作为新
漂移失败；文件中列出但不再出现的行作为已解决差异失败，必须删除。文件按负责关闭
差异的切片分组。

## 6. TypeScript 类型

`packages/web-shell/scripts/generate-managed-agent-api.mjs` 生成
`client/components/managed/generated/managed-agent-api.ts`。运行
`openapi-typescript` 之前，它会：

- 只保留未标为 `planned` 的 `WebShell` operation；
- 删除 `planned` 参数与属性，并从 `required` 中移除；
- 只保留这些 operation 引用到的 component。

契约规定计划中的接口不得进入生产客户端，因此 `WebShellSession.capabilities`
等字段在实现之前不会出现。带 `default` 的属性保持可选
（`defaultNonNullable: false`）；只有 `required` 会让字段成为必填。

`managed-agent-api.test.ts` 在内存中重新生成该文件，与已提交版本不同时失败，并用
一个小 fixture 覆盖过滤逻辑。

生成类型同时修正了手写接口，其中三处需要改代码：事件的 `turnId` 可能缺失，
`nextCursor` 与 `olderCursor` 可能为 `null`。provider 现在处理这三种情况。事件流请求不再发送
`limit`；v1.6 已删除该字段，服务端也忽略它。输入块通过一个标明已知差异的本地
覆盖类型继续使用 `type: 'text'`，因为服务端仍拒绝契约中的 `input_text`。

`openapi-typescript` 依赖 `supports-color` 10。依赖图中出现第二个更高版本的
`supports-color` 后，pnpm 改写了 lockfile 中每个 `debug` 条目的可选
`supports-color` peer（约 1100 行变化），而 hoisted 目录树并无变化。一个 pnpm
override 把 `openapi-typescript>supports-color` 固定为仓库已在使用的 7.2.0；
生成器只读取 `stdout` 与 `stdout.hasBasic` 来决定日志是否着色，7.2.0 导出结构相同
的 `stdout`（没有 TTY 时为 `false`，此时关闭颜色）。

## 7. D1 记录的差异

| 切片                   | 差异                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2                     | 所有 Session 响应缺 `agent_revision` 与 `capabilities`；record 缺 `replay_floor_sequence`、`snapshot_through_sequence` 与 `PublicTurn.input_item_id`；`CreateSessionRequest` 缺 `agent_revision`；WebShell 命令不回传 `X-Request-Id`；record 中仍有 `WebShellStreamRequest.limit`；输入块只接受 `text`，不接受契约中的 `input_text`。 |
| D3                     | 公共与 WebShell 事件（JSON 与 SSE）缺 `schema_version`、`projection_version`、`item_id` 与 `content_part_id`；事件与 transcript 分页对大于 100 的 `limit` 返回 `400 invalid_limit`。                                                                                                                                                  |
| 生命周期工作           | `archive` 与 `DELETE` 返回 `200`，而不是带命令 operation 的 `202`；`DeletedSession` 没有 schema；已归档的 Session 读回时 `status` 为 `"archived"`，而契约的状态枚举没有该值（v1.10 用计划中的 `archived_at` 表示归档）。                                                                                                              |
| Workspace 上下文（W2） | 两个入口上 Session 的 `workspace` 都缺 `context_revision` 与 `state`，通过 record 和已绑定会话响应校验。                                                                                                                                                                                                                              |

输入类型不一致不在 issue 列出的差异中，是 5.3 的请求校验发现的。服务端的
`input()` 只接受 `text`，WebShell 客户端也发送 `text`，因此两者必须在 D2 中一起
修改。

## 8. 修改契约的流程

1. 修改 JSON spec。
2. 在 `packages/web-shell` 中运行 `npm run generate:managed-agent-api`，类型
   变化时同步修改客户端。
3. 运行 `ManagedAgentApiContractTest`。新漂移在服务端修复；只有由后续切片负责的
   差异，才把对应行加入已知差异文件。修复关闭差异后，删除对应行。
4. 只有路由没有剩余差异且契约测试通过时，才改为 `implemented`。

## 9. 验证

- 在 `packages/sdk-java/managed-agent-server` 中运行 `mvn test`，三个契约测试在
  已记录差异下通过。
- 以下变更分别使对应测试失败：record 新增字段、新增映射路由、删除一行已知差异、
  修改 spec 而不重新生成 TypeScript 类型。
- `packages/web-shell` 的 `npm run typecheck` 与 managed 组件测试在生成类型下
  通过。

## 10. 后续工作

D2 与 D3 可以并行开始。各自关闭第 7 节中属于自己的差异，然后按 issue 的定义把
对应路由改为 `implemented`。差异文件无法记录这些切片必须修复的全部内容：

- **未声明的错误响应（D2）。** 若干 `partial` operation 没有声明服务端实际返回的
  错误状态码：WebShell transcript 与会话列表的 `404 session_not_found` 和
  `400 invalid_limit`，公共事件查询的 `400 invalid_limit`，以及 WebShell 提交与
  取消的 `400`/`404`。spec 未声明的状态码，测试不会校验其响应体，因此 D2 在加入
  `request_id` 时一并补上这些响应。
- **符合 schema 的语义问题（D3）。** 事件分页已满时仍返回 `has_more: false` 与
  `next_cursor: null`。该响应符合 schema，差异文件无法记录，必须由 D3 自己的测试
  覆盖。
- **绑定 Workspace 的 Session（W2）。** 两个入口的创建与读回现在直接覆盖缺失的
  `context_revision` 与 `state`。W2 补齐字段后，移除相应 record 与响应差异。

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
[openapi]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-public-api.openapi.yaml
