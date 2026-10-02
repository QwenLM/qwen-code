# Managed AgentDefinition revision（Stage D8a）

[English](2026-10-01-managed-agent-definitions.md) | [简体中文](2026-10-01-managed-agent-definitions.zh-CN.md)

状态：本次改动实现
日期：2026-10-01
Issue：[#12867](https://github.com/QwenLM/qwen-code/issues/12867)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
基于：[API 契约（D1）](2026-09-27-managed-agent-api-contract.zh-CN.md) 与 [会话查询（D2）](2026-09-27-managed-agent-session-query.zh-CN.md)

## 1. 问题

契约声明了 `POST /v1/agents`、`GET /v1/agents/{agentId}` 与
`POST /v1/agents/{agentId}`，以及 `AgentDefinitionRequest` 和 `AgentDefinition`
两个 schema，但三条路由都是 `planned`。会话记录的是取自
`QWEN_MANAGED_AGENT_REVISION` 的固定 revision，唯一接受的 agent 是
`qwen-code`，定义及其历史无处保存。

不带结尾斜杠的集合路径还会绕过租户范围：`TenantContextFilter` 只匹配
`/v1/agents/` 前缀，而 `/v1/agents` 没有这个斜杠。

#12867 把 D8 分为三片：D8a 存储定义并提供路由；D8b 让会话固定一个已存储的
revision；D8c 让定义字段影响 Harness 执行，需要单独的设计。

## 2. 目标

- 按契约的请求与响应 schema 提供三条路由。
- revision 只追加、不可变，每个 revision 带其规范化内容的 digest。
- 创建与更新在其 `Idempotency-Key` 下幂等。
- 定义按租户隔离，包括不带斜杠的集合路径。

## 3. 非目标

- 会话仍固定 `qwen-code` 与配置的 revision（D8b）。
- 没有任何定义字段改变模型选择、指令、工具或权限（D8c）。
- 单独的发布步骤、列出定义、删除定义，以及契约第 10 节的角色矩阵。

## 4. 设计

### 4.1 存储

Flyway `V33` 接在主干 `V32` Workspace 会话关闭迁移之后，新增两张表。`managed_agent_definition` 每个 revision 一行，以租户、
agent ID 与 revision 号为键，保存 digest、请求 JSON 与创建时间，只插入不修改。
`managed_agent_definition_command` 按租户与 `Idempotency-Key` 记录每次创建或
更新，保存请求 digest 与该命令应答的 revision。

### 4.2 身份与 digest

agent ID 由服务端生成，格式为 `agent_` 加 32 位十六进制；请求中没有 ID 字段。
`GET`/`POST /v1/agents/{agentId}` 对不符合该形式的 ID 应答 `404 agent_not_found`。
保留名由别的路由应答：Spring 路径匹配中字面路由优先于 `{agentId}`，因此
`/v1/agents/sessions`（GET 与 POST）与 `/v1/agents/workspaces`（GET）走 Session 与
Workspace 路由；而某个方法没有字面兄弟路由的保留名（如 `POST /v1/agents/workspaces`）
仍会到达定义路由并应答 `404`。两种情况下保留名都不会命中已存储的行，带填充或
大小写变化的真实 ID 变体也不会。

内容是去掉缺省与 null 可选字段后的请求；为此契约把 `skills`、`mcp_servers` 与
`metadata` 声明为可为 null。数组元素必须是对象，`null` 元素应答 `400`。digest 是规范化 JSON（每一层键都排序）
的 SHA-256，因此键的顺序不会改变它，顶层可选字段的显式 `null` 也不会。null 剥离只做一层：
`metadata` 这类开放 map 内部嵌套的 `null` 会改变 digest。请求 digest 还包含操作类型，
更新时还包含 agent ID。

### 4.3 语义

- **创建** 存储 revision `1`，应答 `202`。
- **更新** 存储下一个 revision。内容 digest 等于最新 revision 时不存储，并应答
  该 revision。
- **回放。** 相同键与相同请求 digest 应答已记录的 revision，并带
  `X-Qwen-Idempotent-Replay: true`。相同键配不同请求（包括把创建用过的键用于
  更新）应答 `409 idempotency_conflict`。
- **并发。** revision 行与命令在同一事务中提交。并发请求先提交时，落败的写入
  回滚，并读取该键下已提交的命令：相同请求回放其结果。否则，若并发更新先占用了
  revision 号，应答 `409 agent_revision_conflict` 且不记录命令，可以用原键重试；
  同一键下的不同请求应答 `409 idempotency_conflict`。不改变内容的更新可以排在
  与其重叠执行的内容修改之前；即使响应到达时已存在更新版本，该响应和后续回放
  仍返回已记录的 revision。
- **读取** 读取最新 revision，或 `revision` 指定的那个（从 `1` 开始的十进制数）。
  其他值一律应答 `404 agent_not_found`。
- 响应包含 `id`、`object: "agent"`、`revision`、`digest`、`created_at` 以及请求的
  `metadata`，不回显定义内容。

### 4.4 租户范围

`TenantContextFilter` 现在也覆盖精确路径 `/v1/agents`，因此每条路由都要求
`X-Qwen-Tenant-Id`，并以 `403 actor_scope_mismatch` 拒绝不匹配的可信 actor。
在其他租户读取或更新应答 `404`。

### 4.5 契约

三条路由改为 `implemented` 并补充说明，创建与更新声明 `400`，契约版本为
v1.29.0。该版本号假定 #13112 先以 v1.28 合入。

## 5. 留给 D8b 与 D8c 的问题

1. 哪些字段生效，哪些在对应阶段落地前只存储（例如随 Stage H 的 `skills` 与
   `mcp_servers`）？
2. 已存储的 revision 是否立即可用，还是由发布步骤决定新会话使用哪个 revision？
3. `tools` 与 `permission_policy` 如何映射到冻结的 Hosted 工具 profile，以及
   会话当前固定的审批模式？

## 6. 验证

- `ManagedAgentDefinitionTest`：创建与回放、内容不变与变化的更新、revision 读取、
  键冲突、租户范围、服务端生成的 ID、请求校验与规范化 digest。
- `ManagedAgentDefinitionServiceTest`：竞争失败的写入，相同请求回放已提交的
  结果，否则保留冲突。
- `ManagedAgentApiContractTest`：三条路由按 schema 应答，包括 `400`、`404` 与
  `409`，以及不带斜杠的集合路径上的租户过滤拒绝。
- `TenantContextFilterTest`：不带斜杠的路径要求租户，前缀相同的无关路径不被过滤。
