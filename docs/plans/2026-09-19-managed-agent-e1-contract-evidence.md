# Managed Agent E1 官方 SDK 契约冻结证据

状态：通过

验证日期：2026-09-19（Asia/Shanghai）

关联方案：[Managed Agent 公共 Agent API 适配层执行方案](./2026-09-18-managed-agent-public-api-adapter.md)

## 1. 结论

E1 契约冻结已经通过。验证使用官方 TypeScript SDK `openai@7.18.0`，由 SDK 直接访问随机真实端口上的
Spring Boot 3.4.5 + Tomcat 服务，不经过 MockMvc，也不复制 SDK 的请求编码逻辑。

一次门禁执行包含：

- 13 条已实现 HTTP 路由的 16 次成功调用；
- `POST /agents/sessions` 的非流式和 `stream=true` 两种返回；
- `{type:"none"}` 与 `openai_hosted + environment_template_id` 两种 Environment 正向映射；
- 独立 `GET /agents/sessions/{id}/events` SSE；
- message 与 cancel 两种 Session input event；
- 11 个已知不支持能力的稳定错误断言；
- 固定时间、固定 ID、固定数据的日期化 JSON 响应和 SSE fixture 比对。

门禁首次运行发现 `ResponseEntity<Flux<ServerSentEvent<...>>>` 在当前 Servlet MVC/Tomcat 部署中会返回
HTTP 500。实现已改为 `SseEmitter` 桥接，并验证 create-stream 与独立 event-stream 都能被官方 SDK
完整消费到终态。

这项证据只证明 Adapter 与官方 SDK 的 HTTP、JSON、SSE 契约。真实鉴权、跨租户隔离、BFF/反向代理、
双 JVM/MySQL、Hosted Harness 和 ACS 不属于 E1，仍分别由 E2、E3、E4 验收。

## 2. 冻结基线

| 项目         | 冻结值                                                      |
| ------------ | ----------------------------------------------------------- |
| 上游文档     | OpenAI Managed Agents Sessions，2026-09-19 读取             |
| 官方客户端   | `openai@7.18.0`                                             |
| Node.js      | v26.0.0                                                     |
| Java         | JDK 21.0.8                                                  |
| HTTP 容器    | Spring Boot 3.4.5 + Tomcat 10.1.40，随机真实 TCP 端口       |
| Adapter 前缀 | `/v1/agents/sessions`                                       |
| Beta header  | SDK 自动发送 `OpenAI-Beta: agents=v1`                       |
| 开关         | 测试内显式开启 `enabled` 和 `write-enabled`；生产默认仍关闭 |

上游依据：

- [Sessions API 总览](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions)
- [Create session](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/create)
- [Submit session events](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/create)
- [Stream session events](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/stream)

## 3. 路由兼容矩阵

### 3.1 已实现并由官方 SDK 黑盒通过

| SDK 方法                      | HTTP 路由                                                         | 本轮证据                               |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `sessions.create`             | `POST /agents/sessions`                                           | none/hosted 非流式 + `stream=true` SSE |
| `sessions.retrieve`           | `GET /agents/sessions/{sessionId}`                                | Session 完整响应                       |
| `sessions.list`               | `GET /agents/sessions`                                            | cursor page，`limit=20`、`order=desc`  |
| `sessions.update`             | `POST /agents/sessions/{sessionId}`                               | 替换 `metadata.title`                  |
| `sessions.delete`             | `DELETE /agents/sessions/{sessionId}`                             | deletion confirmation                  |
| `sessions.events.create`      | `POST /agents/sessions/{sessionId}/events`                        | message、cancel，HTTP 202              |
| `sessions.events.stream`      | `GET /agents/sessions/{sessionId}/events`                         | created、delta、completed              |
| `sessions.turns.list`         | `GET /agents/sessions/{sessionId}/turns`                          | cursor page                            |
| `sessions.turns.retrieve`     | `GET /agents/sessions/{sessionId}/turns/{turnId}`                 | Turn 完整响应                          |
| `sessions.items.list`         | `GET /agents/sessions/{sessionId}/items`                          | assistant message item                 |
| `sessions.artifacts.list`     | `GET /agents/sessions/{sessionId}/artifacts`                      | cursor page                            |
| `sessions.artifacts.retrieve` | `GET /agents/sessions/{sessionId}/artifacts/{artifactId}`         | Artifact metadata                      |
| `sessions.artifacts.content`  | `GET /agents/sessions/{sessionId}/artifacts/{artifactId}/content` | content type 与字节内容                |

### 3.2 官方 SDK 存在但首版未实现

| 能力                                     | 当前行为 | 首版决策             |
| ---------------------------------------- | -------- | -------------------- |
| `sessions.artifacts.delete`              | 无路由   | 不开放 Artifact 删除 |
| `sessions.subagents.list/retrieve`       | 无路由   | 不开放 Subagent API  |
| `sessions.subagents.items.list`          | 无路由   | 不开放 Subagent Item |
| `sessions.subagents.turns.list/retrieve` | 无路由   | 不开放 Subagent Turn |

以上 6 个官方方法不计入 13 条已实现路由。升级 SDK 时必须重新核对 Sessions 子树；不得因 SDK 新增方法而
自动扩大服务端承诺。

## 4. 请求字段矩阵

| 请求面        | 支持子集                                                                                     | 明确不支持                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Create agent  | 仅 `agent_id=dataworks_data_agent`                                                           | inline `agent`、任何模型/推理/工具 override、其他 saved agent                                                           |
| Environment   | `{type:"none"}`；`openai_hosted` 仅允许已授权 `environment_template_id` 引用                 | `self_hosted`；hosted 的 env/files/network/packages/plugins/setup_commands/skills/capability_directories 等 inline 配置 |
| Initial input | 字符串；user message 数组中的 `input_text`                                                   | `input_image`                                                                                                           |
| Metadata      | 最多 16 项的官方长度限制，但首版语义只接受 `title`                                           | 其他 metadata key                                                                                                       |
| Vault         | 缺省、null 或空数组                                                                          | 非空 `vault_ids`                                                                                                        |
| Stream        | `false`/缺省返回 Session；`true` 返回 SSE                                                    | 无                                                                                                                      |
| Update        | `metadata.title`，null 或空对象用于清空                                                      | `agent.model/reasoning/service_tier`                                                                                    |
| Events        | 每个请求恰好一个 message 或 cancel；message 只接收 user + `input_text`                       | tool-result、同请求多 event                                                                                             |
| Pagination    | `after`、`limit`、`order=desc`；Session 的 `agent_id` 与 Artifact 的 `environment_id` filter | `before`、`order=asc`                                                                                                   |

所有“明确不支持”的官方可表达能力在已映射路由上返回：

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "agent_api_unsupported_feature"
  }
}
```

HTTP 状态为 400。结构错误、缺失必填值或非法值使用 `agent_api_invalid_command`，两类错误不混用。

本轮 fixture 对 inline agent、vault、self-hosted、inline hosted 配置、input image、agent update、
tool-result、event batch、before cursor、ascending order 和未知 metadata key 共 11 项逐一断言。

## 5. 响应和 SSE 冻结

- `agent.session.created` 数据只包含 `event_id`、`session`、`type`。
- Event Stream 的 SSE `id` 使用 durable public sequence；`event` 使用公开事件类型。
- 心跳使用 SSE comment，不进入 SDK 返回的事件数组，也不消耗 public sequence。
- create-stream 在被本次 create admission 的 Turn 达到 completed、failed 或 cancelled 时结束。
- 无初始 input 的 create-stream 在第一个非心跳 Session 事件后结束。
- Artifact 公共路径为脱敏逻辑路径，不返回 Runtime workspace 绝对路径。
- 响应不包含 Harness endpoint、Runtime ID/token/lease、Pod 或内部 event epoch。

保存的完整固定响应在 Java 仓库：

```text
copilot/agent/src/test/resources/agent-api/openai/2026-09-19/sdk-evidence.json
```

可执行请求 fixture 在：

```text
copilot/agent/src/test/resources/agent-api/openai/2026-09-19/sdk-contract.mjs
```

## 6. 可重复执行

从产品 Java 仓库 `dataworks/app/lsp-server` 执行：

```bash
bash scripts/run-openai-managed-agent-contract.sh
```

脚本固定 SDK 版本，首次运行从 npm 公共 registry 安装到 Git 忽略的
`.qwen/openai-sdk-7.18.0`，随后用 JDK 21、真实 Spring HTTP 端口执行。默认使用本机 Maven 缓存离线
运行；CI 或新环境通过 `MAVEN_SETTINGS=/absolute/path/to/settings.xml` 指定内部 Maven settings。
测试还会把本次实际结果写到：

```text
copilot/agent/target/managed-agent-contract/sdk-evidence.json
```

实际结果必须与签入的日期化 fixture 完全相等。任何 SDK schema、HTTP 路由、错误码、JSON 字段或 SSE
事件变化都会使门禁失败。

## 7. 相邻回归与 E2 前置检查

E1 通过后补跑了 14 个 Adapter/Query/Event/Tenant/WebShell/Command Ledger 相关测试类，共 67 个用例：

```text
Tests run: 67, Failures: 0, Errors: 0, Skipped: 1
BUILD SUCCESS
```

唯一 skip 是默认不携带专用数据库凭证时主动跳过的真实 MySQL 用例。随后使用专用临时 schema 运行
E2 MySQL 门禁：

```text
Tests run: 14, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

该门禁包含两个独立 JVM 竞争 UNKNOWN Tool execution、两个独立 Spring 事务代理/连接池竞争 Command
Ledger，以及两个最小产品 Command Slice HTTP JVM 的同/异 digest、tenant/operator 隔离和三个进程
kill window。详细 SQL 快照、HTTP 结果和剩余边界见
[E2 本地 MySQL 阶段证据](./2026-09-19-managed-agent-e2-mysql-evidence.md)。这仍不能替代完整
`LspApplication`、负载均衡、真实鉴权以及 Turn/Item/Artifact/cursor 的全资源租户隔离证据。

## 8. E1 之外的剩余生产门禁

| 工作包        | 当前状态 | 下一项真实输入                                                |
| ------------- | -------- | ------------------------------------------------------------- |
| E2 数据与租户 | 部分通过 | 两个完整产品 Java 实例、负载均衡、全资源 tenant/operator 隔离 |
| E3 HTTP/SSE   | 未通过   | 测试域名、真实鉴权、BFF/反向代理、代理 timeout 配置           |
| E4 运行链路   | 部分通过 | 产品 Java、真实鉴权与 DataAgent/ACS Tool Runtime              |
| E5 Shadow     | 未通过   | 白名单真实流量和约定观察窗口                                  |
| E6 灰度/回滚  | 未开始   | E1 到 E5 全部证据                                             |

因此 E1 通过不改变生产开关默认值，也不授权开放公共流量。
