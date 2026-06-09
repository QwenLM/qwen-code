# ACP Streamable HTTP 协议分析

> 分析日期：2026-06-09
> 协议状态：**Draft RFD（草案）**，尚未正式稳定发布

---

## 目录

- [1. 背景](#1-背景)
- [2. 协议定位](#2-协议定位)
- [3. HTTP 端点设计](#3-http-端点设计)
- [4. 身份模型](#4-身份模型)
- [5. 连接生命周期](#5-连接生命周期)
- [6. Session 生命周期](#6-session-生命周期)
- [7. JSON-RPC 方法清单](#7-json-rpc-方法清单)
- [8. SSE 事件格式](#8-sse-事件格式)
- [9. WebSocket 模式](#9-websocket-模式)
- [10. 错误处理](#10-错误处理)
- [11. 与 MCP Streamable HTTP 的对比](#11-与-mcp-streamable-http-的对比)
- [12. 与自研 REST API 的对比](#12-与自研-rest-api-的对比)
- [13. v1 传输层的局限与 v2 改进](#13-v1-传输层的局限与-v2-改进)
- [14. ACP v1 与 v2 协议差异](#14-acp-v1-与-v2-协议差异)
- [15. 相关链接](#15-相关链接)

---

## 1. 背景

ACP（Agent Client Protocol）是一个标准化 IDE/编辑器与 Coding Agent 通信的协议，类似于 LSP 之于语言服务器。

ACP 目前定义了两种传输方式：

| 传输                | 状态             | 适用场景                               |
| ------------------- | ---------------- | -------------------------------------- |
| **stdio**           | 稳定 (Stable)    | 本地子进程，通过 stdin/stdout 管道通信 |
| **Streamable HTTP** | 草案 (Draft RFD) | 远程/网络场景，HTTP + SSE 组合         |

stdio 是进程间通信（IPC）机制，不涉及网络；Streamable HTTP 是为跨网络、多客户端场景设计的 HTTP 传输层。两者共享相同的 JSON-RPC 消息格式，只是传输管道不同。

---

## 2. 协议定位

### 分层架构

```
┌─────────────────────────────┐
│  ACP 协议（JSON-RPC 2.0）    │  ← 与传输无关的消息格式
├─────────────────────────────┤
│  传输层（可选）               │
│  ┌────────┐ ┌─────────────┐│
│  │ stdio  │ │ Streamable  ││
│  │ (管道) │ │ HTTP + SSE  ││
│  └────────┘ └─────────────┘│
└─────────────────────────────┘
```

### Streamable HTTP 的本质

Streamable HTTP 不是一个新协议，而是用标准 HTTP 能力拼出双向通信的**约定**：

- **Client → Server**：普通 POST 请求（上行通道）
- **Server → Client**：SSE 长连接（下行通道）

SSE 是 Streamable HTTP 的组成部分，负责 Server→Client 方向的推送。

---

## 3. HTTP 端点设计

所有通信发生在**单一端点 `/acp`** 上，通过 HTTP method + Header 区分行为：

### 路由决策

```
POST /acp
├── 无 Acp-Connection-Id → initialize（创建连接）→ 200 JSON
├── 有 Acp-Connection-Id → 转发 JSON-RPC 消息 → 202 Accepted
└── 缺失必要 Header → 400 Bad Request

GET /acp
├── 有 Upgrade: websocket → WebSocket 升级
├── 无 Acp-Connection-Id → 400 Bad Request
├── 有 Acp-Connection-Id only → 连接级 SSE 流
└── 有 Acp-Connection-Id + Acp-Session-Id → Session 级 SSE 流

DELETE /acp
├── 有 Acp-Connection-Id → 终止连接 → 202 Accepted
└── 无 → 400 Bad Request
```

### 传输要求

- **HTTP/2 必须**：用于多路复用并发 POST 和长连接 GET
- **Cookie 支持必须**：Client 必须接受和回传 Cookie，用于会话亲和性
- Client 必须**同时支持** Streamable HTTP 和 WebSocket

---

## 4. 身份模型

采用双 Header 体系：

| Header              | 层级   | 获取时机           | 用途             |
| ------------------- | ------ | ------------------ | ---------------- |
| `Acp-Connection-Id` | 传输级 | `initialize` 响应  | 标识一个逻辑连接 |
| `Acp-Session-Id`    | 业务级 | `session/new` 响应 | 标识一个会话     |

一个 Connection 可承载多个并发 Session：

```
Connection (Acp-Connection-Id: C1)
├── Session S1 (独立 SSE 流)
├── Session S2 (独立 SSE 流)
└── Session S3 (独立 SSE 流)
```

---

## 5. 连接生命周期

### 5.1 Initialize

```http
POST /acp HTTP/2
Content-Type: application/json

{"jsonrpc":"2.0","method":"initialize","id":1,"params":{/* capabilities */}}
```

响应（**唯一返回 JSON body 的 POST**）：

```http
HTTP/2 200 OK
Content-Type: application/json
Acp-Connection-Id: conn_xyz789

{"jsonrpc":"2.0","id":1,"result":{
  "capabilities":{/* 协商后的能力 */},
  "connectionId":"conn_xyz789"
}}
```

### 5.2 Initialized（通知）

```http
POST /acp HTTP/2
Acp-Connection-Id: conn_xyz789
Content-Type: application/json

{"jsonrpc":"2.0","method":"initialized"}
```

响应：`202 Accepted`（notification，无 body）。

### 5.3 打开连接级 SSE 流

```http
GET /acp HTTP/2
Acp-Connection-Id: conn_xyz789
Accept: text/event-stream
```

返回长连接 SSE 流，承载：

- `session/new` 和 `session/load` 的响应
- 不关联特定 Session 的服务端消息

### 5.4 断开连接

```http
DELETE /acp HTTP/2
Acp-Connection-Id: conn_xyz789
```

响应：`202 Accepted`。Server 终止连接及所有关联 Session，关闭所有 SSE 流。

---

## 6. Session 生命周期

### 6.1 创建 Session

```http
POST /acp HTTP/2
Acp-Connection-Id: conn_xyz789
Content-Type: application/json

{"jsonrpc":"2.0","method":"session/new","id":2,"params":{
  "cwd":"/path/to/project",
  "mcpServers":[/* MCP 配置 */]
}}
```

立即响应：`202 Accepted`

实际结果通过**连接级 SSE** 推送：

```
event: message
data: {"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_abc123"}}
```

### 6.2 打开 Session 级 SSE 流

```http
GET /acp HTTP/2
Acp-Connection-Id: conn_xyz789
Acp-Session-Id: sess_abc123
Accept: text/event-stream
```

返回该 Session 专属的 SSE 长连接，承载所有 Session 内的交互消息。

### 6.3 发送 Prompt

```http
POST /acp HTTP/2
Acp-Connection-Id: conn_xyz789
Acp-Session-Id: sess_abc123
Content-Type: application/json

{"jsonrpc":"2.0","method":"session/prompt","id":3,"params":{
  "sessionId":"sess_abc123",
  "prompt":[{"type":"text","text":"帮我读取文件"}]
}}
```

立即响应：`202 Accepted`

流式结果通过 **Session 级 SSE** 推送。

### 6.4 Session 跨连接恢复

Session 在 Server 端独立于 Connection 存活。断线恢复流程：

1. 发送新的 `initialize` → 获得新 `Acp-Connection-Id`
2. 打开新的连接级 SSE
3. 打开已有 `sessionId` 的 Session 级 SSE
4. 发送 `session/load` → Server 回放历史
5. 通过 Cookie 实现负载均衡器的会话亲和

---

## 7. JSON-RPC 方法清单

### Client → Agent（通过 POST /acp）

| method                         | 作用                       | 响应方式             | 所需 Header          |
| ------------------------------ | -------------------------- | -------------------- | -------------------- |
| `initialize`                   | 建立连接、协商能力         | **200 JSON**         | 无                   |
| `initialized`                  | 通知初始化完成             | 202（notification）  | Connection           |
| `session/new`                  | 创建 Session               | 202 → 连接级 SSE     | Connection           |
| `session/load`                 | 加载 Session（带历史回放） | 202 → 连接级 SSE     | Connection + Session |
| `session/resume`               | 恢复 Session（不回放）     | 202 → 连接级 SSE     | Connection + Session |
| `session/close`                | 关闭 Session               | 202 → SSE            | Connection + Session |
| `session/delete`               | 删除 Session               | 202 → SSE            | Connection + Session |
| `session/list`                 | 列出所有 Sessions          | 202 → SSE            | Connection           |
| `session/prompt`               | 发送用户消息               | 202 → Session 级 SSE | Connection + Session |
| `session/cancel`               | 取消当前 Turn              | 202（notification）  | Connection + Session |
| `session/set_config_option`    | 设置配置（模式/模型等）    | 202 → SSE            | Connection + Session |
| 对 `request_permission` 的响应 | 回复权限请求               | 202                  | Connection + Session |

### Agent → Client（通过 SSE 流推送）

| 消息类型                                  | SSE 流     | 说明                                        |
| ----------------------------------------- | ---------- | ------------------------------------------- |
| `session/update` — `agent_message_chunk`  | Session 级 | Agent 文本流式输出                          |
| `session/update` — `agent_thought_chunk`  | Session 级 | 思维链/推理过程                             |
| `session/update` — `user_message_chunk`   | Session 级 | 用户消息回显（多客户端同步）                |
| `session/update` — `tool_call`            | Session 级 | 工具调用开始                                |
| `session/update` — `tool_call_update`     | Session 级 | 工具执行进度/结果                           |
| `session/update` — `plan`                 | Session 级 | 任务计划                                    |
| `session/update` — `usage_update`         | Session 级 | Token 用量/费用                             |
| `session/update` — `config_option_update` | Session 级 | 配置变更推送                                |
| `session/update` — `session_info_update`  | Session 级 | Session 元数据变更                          |
| `session/request_permission`              | Session 级 | 请求用户审批（**request，需 Client 响应**） |
| prompt response                           | Session 级 | Turn 结束（含 stopReason）                  |
| `session/new` response                    | 连接级     | Session 创建结果                            |
| `session/load` response                   | 连接级     | Session 加载结果（含历史回放）              |

---

## 8. SSE 事件格式

所有 SSE 事件使用标准 Server-Sent Events 格式：

```
event: message
data: {"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"sess_abc123",
  "update":{"sessionUpdate":"agent_message_chunk",
    "messageId":"msg_1",
    "content":{"type":"text","text":"Hello"}}
}}

```

消息类型通过 JSON-RPC 区分：

- **响应**：有 `id`，匹配原始请求的 `id`
- **通知**：有 `method`，无 `id`
- **服务端请求**：有 `method` 和 `id`（如 `request_permission`，需 Client 回应）

> **注意：** ACP Streamable HTTP v1 传输层不支持 SSE event id（`Last-Event-ID` 断线恢复推迟到 v2）。

---

## 9. WebSocket 模式

同一个 `/acp` 端点支持 WebSocket 升级：

```http
GET /acp HTTP/1.1
Upgrade: websocket
Connection: Upgrade
```

响应：

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Acp-Connection-Id: conn_ws_001
```

WebSocket 模式特点：

- 全双工双向通信，所有消息复用同一连接
- 消息格式为 WebSocket text frame 中的 JSON-RPC
- 二进制帧被忽略
- 首条消息必须是 `initialize`
- 不需要单独的 GET SSE 流
- 断开时 Server 清理连接及关联 Session

---

## 10. 错误处理

### HTTP 状态码

| 状态码                         | 条件                                               |
| ------------------------------ | -------------------------------------------------- |
| **200 OK**                     | 仅 `initialize` 响应                               |
| **202 Accepted**               | 所有其他有效 POST、DELETE                          |
| **400 Bad Request**            | 缺少必要的 `Acp-Connection-Id` 或 `Acp-Session-Id` |
| **404 Not Found**              | 未知的 Connection-Id 或 Session-Id                 |
| **406 Not Acceptable**         | GET 请求缺少 `text/event-stream` Accept            |
| **415 Unsupported Media Type** | POST 缺少 `application/json` Content-Type          |
| **501 Not Implemented**        | JSON-RPC batch 请求                                |

### JSON-RPC 错误

标准 JSON-RPC 2.0 error 响应通过对应的 SSE 流或 WebSocket 推送，使用请求 `id` 关联。

---

## 11. 与 MCP Streamable HTTP 的对比

| 维度            | MCP Streamable HTTP        | ACP Streamable HTTP               |
| --------------- | -------------------------- | --------------------------------- |
| SSE 流生命期    | 每请求短连接               | 长连接（连接级 + Session 级）     |
| initialize 响应 | 返回 SSE 流                | 返回 JSON（200 OK）               |
| HTTP 版本       | 无要求                     | HTTP/2 必须                       |
| Session 标识    | 单个 `Mcp-Session-Id`      | 双 Header（Connection + Session） |
| WebSocket       | 未定义                     | 一等公民，Client 必须支持         |
| Batch 请求      | 支持                       | 返回 501                          |
| 可恢复性        | 支持 `Last-Event-ID`       | 推迟到 v2                         |
| 多 Session      | N/A（MCP 无 Session 概念） | 单连接多 Session                  |

ACP 偏离 MCP 的核心理由：MCP 的 per-request SSE 模式创建太多长连接，增加负载均衡复杂度。ACP 的持久 GET 流更适合其双向、多 Session 特性。

---

## 12. 与自研 REST API 的对比

以 Qwen Code daemon 为例，对比自研 REST 方案与 ACP Streamable HTTP：

| 维度         | 自研 REST（`/session/*`）             | ACP Streamable HTTP（`/acp`）   |
| ------------ | ------------------------------------- | ------------------------------- |
| 端点数量     | 30+ 个路由                            | **1 个** `/acp`                 |
| 路由方式     | URL path + HTTP method                | JSON-RPC `method` 字段          |
| 创建 Session | `POST /session`                       | `POST /acp {session/new}`       |
| 发送 Prompt  | `POST /session/:id/prompt`            | `POST /acp {session/prompt}`    |
| 事件流       | `GET /session/:id/events`             | `GET /acp` + Header             |
| 权限审批     | `POST /session/:id/permission/:reqId` | `POST /acp` + JSON-RPC response |
| 关闭 Session | `DELETE /session/:id`                 | `POST /acp {session/close}`     |
| 断开连接     | 无显式接口                            | `DELETE /acp`                   |
| 断线恢复     | 自实现 `Last-Event-ID` + Ring Buffer  | v1 传输层不支持（推迟到 v2）    |
| 多客户端     | 自实现 `X-Qwen-Client-Id` + fan-out   | Connection + Session 双层身份   |

本质区别：REST 把每个操作映射成不同的 URL；Streamable HTTP 把所有操作塞进同一个 URL，靠 JSON-RPC 的 method 字段区分。HTTP 本身退化为纯传输管道。

Qwen Code daemon 目前两套并存：

```
WebUI/SDK ──── /session/* (自研 REST) ────┐
                                          ├──► HttpAcpBridge + EventBus ──stdio──► Agent
Zed 等    ──── /acp (标准 ACP HTTP)  ─────┘
```

---

## 13. v1 传输层的局限与 v2 改进

### 当前 v1 传输层已有的保证

- Session 在 Server 端独立存活，可跨连接恢复
- Cookie 实现会话亲和
- 重连/重试由实现方自行处理

### 推迟到 v2 的能力

| 能力                          | 说明                                       |
| ----------------------------- | ------------------------------------------ |
| SSE event id                  | 消息编号（`Last-Event-ID` 断线恢复的前提） |
| 流恢复                        | 标准化的 SSE `Last-Event-ID` 重连机制      |
| Keepalive                     | 传输层和应用层 ping/pong 标准化            |
| Batch JSON-RPC                | 当前返回 501                               |
| `Acp-Protocol-Version` Header | 版本协商 Header 强制化                     |

---

## 14. ACP v1 与 v2 协议差异

除传输层变化外，ACP v2 在协议层面也有重大改动（均处于 RFD 阶段）：

| 维度            | v1（当前稳定）                                      | v2（RFD 阶段）                                          |
| --------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Prompt 生命周期 | 同步：response 在 turn 结束时返回                   | 异步：立即 ACK `{}`，通过 `state_change` 通知 turn 状态 |
| Tool Call       | `tool_call`（创建）+ `tool_call_update`（更新）分离 | 统一为 `tool_call_update`（upsert 语义，三态字段）      |
| Plan            | 扁平 `plan` 结构                                    | 带 ID + 类型标签的 `plan_update`                        |
| Capabilities    | `clientCapabilities` / `agentCapabilities` 分开     | 统一为 `capabilities`，全部用 `{}` 声明                 |
| FS / Terminal   | Client 暴露 `fs/*`、`terminal/*` 方法               | 移除（改用 MCP 暴露）                                   |
| 枚举类型        | 封闭，未知值导致解析失败                            | 开放 + `_` 前缀扩展命名空间                             |
| Session Modes   | 独立 `session/set_mode` API                         | 移除，归入 Config Options                               |
| Agent 主动性    | 被动（必须等 Client prompt）                        | 可主动发起交互                                          |
| Message ID      | 可选                                                | 必须                                                    |

---

## 15. 相关链接

### ACP 协议规范

- [ACP 官网](https://agentclientprotocol.com)
- [ACP v1 协议概览](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP v1 传输层](https://agentclientprotocol.com/protocol/v1/transports)
- [ACP v1 初始化](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP v1 Session 设置](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [ACP v1 Session List](https://agentclientprotocol.com/protocol/v1/session-list)
- [ACP v1 Session Delete](https://agentclientprotocol.com/protocol/v1/session-delete)
- [ACP v1 Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [ACP v1 Schema](https://agentclientprotocol.com/protocol/v1/schema)
- [ACP OpenAPI Spec](https://agentclientprotocol.com/api-reference/openapi.json)

### Streamable HTTP / WebSocket 传输 RFD

- [Streamable HTTP & WebSocket Transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md)

### ACP v2 RFD 提案

- [ACP v2 总体提案](https://agentclientprotocol.com/rfds/v2/overview.md)
- [v2 Prompt 生命周期](https://agentclientprotocol.com/rfds/v2/prompt.md)
- [v2 Tool Call Updates](https://agentclientprotocol.com/rfds/v2/tool-call-updates.md)
- [v2 Plan Variants](https://agentclientprotocol.com/rfds/v2/plan-variants.md)
- [v2 Client FS/Terminal 移除](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities.md)
- [v2 枚举扩展机制](https://agentclientprotocol.com/rfds/v2/enum-variant-extension.md)

### 其他相关 RFD

- [RFD 流程说明](https://agentclientprotocol.com/rfds/about.md)
- [Session Resume RFD](https://agentclientprotocol.com/rfds/session-resume.md)
- [Session Close RFD](https://agentclientprotocol.com/rfds/session-close.md)
- [Request Cancellation RFD](https://agentclientprotocol.com/rfds/request-cancellation.md)
- [MCP over ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp.md)
- [Elicitation RFD](https://agentclientprotocol.com/rfds/elicitation.md)

### Qwen Code 实现

- Daemon ACP-over-HTTP 设计文档：`docs/design/daemon-acp-http/README.md`
- ACP HTTP 传输实现：`packages/cli/src/serve/acpHttp/`
- ACP Bridge：`packages/acp-bridge/src/`
- Daemon 主服务：`packages/cli/src/serve/server.ts`
- SDK DaemonClient：`packages/sdk-typescript/src/daemon/DaemonClient.ts`
- SDK 事件类型定义：`packages/sdk-typescript/src/daemon/events.ts`

### SDK 与库

- [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [Java SDK](https://agentclientprotocol.com/libraries/java)
- [Python SDK](https://agentclientprotocol.com/libraries/python)
- [Rust SDK](https://agentclientprotocol.com/libraries/rust)
- [Kotlin SDK](https://agentclientprotocol.com/libraries/kotlin)
