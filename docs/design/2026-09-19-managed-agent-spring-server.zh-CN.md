# 独立 Managed Agent Spring 服务

[English](2026-09-19-managed-agent-spring-server.md) | [简体中文](2026-09-19-managed-agent-spring-server.zh-CN.md)

> PR #12692 范围修正（2026-09-25）：下文的实现与验证记录来自完整集成预览，不是本次拆分的验收证据。当前能力、修复与未完成门禁以[评审修正](2026-09-25-managed-agent-review-corrections.zh-CN.md)为准。

状态：Phase 1 已实现；生产门禁仍未关闭
日期：2026-09-19

## 1. 问题

Qwen Code 已经具备 Hosted Harness Profile，以及访问其私有 HTTP/SSE 协议和 Runtime Broker 的 Java 库，但仓库内还没有一个可运行、与具体产品无关的 Java 控制面。现有产品接入依赖 DataWorks 的身份、存储和部署代码，无法直接作为独立 Qwen Code 服务使用。

新服务需要在 TypeScript Hosted Harness 继续拥有模型循环的前提下，提供低延迟、多租户 Session API。它必须不依赖 DataWorks，接收上游传入的租户身份，在 MySQL 中持久化权威公共状态，并保证 Harness 和 Tool Runtime 凭证只存在于服务端。

## 2. 目标

- 在 `packages/sdk-java/managed-agent-server` 增加可独立运行的 Spring Boot 应用。
- Agent API 请求必须携带 `X-Qwen-Tenant-Id`，并将其作为数据库资源归属边界。
- 不实现终端用户鉴权，也不解释公共 API 的 `Authorization`。
- 在 MySQL 中持久化 Session、Turn、命令幂等、Harness generation fencing 和公共 Event 状态。
- 不等待 Tool Runtime ready，直接把模型工作提交给现有 Hosted Harness。
- 从 Java 自有的持久事件提供 SSE replay，不把 Harness stream 直接代理给客户端。
- 在同一应用内同时提供 `/v1/agents/sessions/**` 和当前 WebShell 使用的 `/api/agent/web-shell/v1/**` Adapter。
- 允许现有 Java Runtime Broker 在同一个控制面进程中通过独立私有 listener 运行。

## 3. 非目标

- 不复制 DataWorks Controller、鉴权、部署或持久化类。
- 不用 Java 重写 TypeScript Agent Loop、MCP、Skill 或工具实现。
- 不把 `tenantId`、Runtime endpoint、凭证或 lease 放入模型 Prompt 内容。
- Phase 1 不实现完整 OpenAI Managed Agents API 兼容；不支持的字段和路由必须显式报错，不能静默忽略。
- 不实现 Kubernetes 专属 Provisioner。首个嵌入 Broker 接入只用于单节点开发；Broker 的多副本持久 Repository 是独立生产门禁。
- 不自动把 Legacy Session 转换为 Managed Session。

## 4. 架构

```text
Client / WebShell
       |
       | X-Qwen-Tenant-Id
       v
Spring Managed Agent Server（一个逻辑多租户服务）
  |-- 租户边界 + 公共/WebShell Adapter
  |-- 命令账本 + Session/Turn/Event 存储 ----> MySQL
  |-- 异步 Harness Coordinator
  |-- 私有 Runtime Broker listener（可选）
  |
  +---- HTTP/SSE ----> qwen serve --profile hosted-harness
  |                         |-- 模型循环与上下文
  |                         `-- BrokerManagedRuntimeProvider
  |                                      |
  +<--- 私有 HTTP -----------------------+
  |
  `---- HTTP ----------> Tool Runtime
                              `-- Workspace 副作用与工具
```

除进程内的在线 attachment 和 SSE subscriber 外，Spring 副本在逻辑上无状态；MySQL 持有可恢复的公共状态。Hosted Harness 进程是常驻、多 Session 的执行 shard；一个 Session binding 必须固定到一个 Harness boot generation。

## 5. 信任与租户边界

服务刻意不依赖公共鉴权组件，假设可信上游或私网已经完成调用方鉴权。但每个 Agent API 请求仍必须携带符合 `[A-Za-z0-9._:-]{1,128}` 的 `X-Qwen-Tenant-Id`。

该 Header 本身不是安全凭证，而是贯穿命令、查询、事件和 Runtime placement 的基础设施作用域。每次资源查询都必须包含 `tenant_id`；不能只依赖随机 ID 做隔离。该值不会追加到 Prompt，也不会作为调用方声明直接发送给 Hosted Harness。

私有 Runtime Broker listener 仍使用独立 bearer token。这是 Harness 到 Broker 流量的机器间 fencing，不是终端用户鉴权，因此不与公共 API 的“无鉴权”目标冲突。

## 6. 持久数据模型

Phase 1 自有以下表：

| 表                      | 作用                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `managed_agent_session` | 租户所有的 Session UUID、Harness generation fence、状态和公共序号           |
| `managed_agent_turn`    | 一次已受理用户输入、稳定 Harness prompt 身份、digest、dispatch lease 和终态 |
| `managed_agent_command` | `(tenant, operation, idempotency key)` claim 和语义请求 digest              |
| `managed_agent_event`   | Session 内公共序号、源事件去重、replay payload 和终态标记                   |

一个 RFC UUID `sessionId` 贯穿公共 API、Java 存储、Hosted Harness、JSONL transcript 和 Runtime Broker。内部协议中的 `harnessSessionId` 字段只作为兼容别名传递同一个值，不再代表第二套身份，也不在数据库中保存映射。`turnId` 仍是公共 Turn 身份，`promptId` 仍是 Harness 幂等提交使用的私有身份。公共响应不得包含 Harness endpoint、boot ID、client ID、Runtime token 或本地路径。

Session 行持有 `last_sequence`。插入 Event 时锁定该行，在同一事务内分配下一序号并写入事件。唯一 source key 防止 Harness 重连产生重复公共事件。

## 7. 命令与恢复语义

所有写请求必须携带 `Idempotency-Key`（或 WebShell 对应请求字段），长度限制为 1--128 个可见字符。服务对语义请求做 canonicalize，并在 dispatch 前保存 SHA-256 digest。

- 同一 tenant、operation、key 和 digest 返回原 ID，并设置 `replayed=true`。
- 相同 key 对应不同内容时返回 HTTP 409。
- 在任何 Harness 调用前，先提交 Session、Turn、command 和初始公共事件。
- 客户端断开不会取消 Turn。
- Harness 提交响应不确定时，继续复用已持久化的 `promptId` 和 payload digest。
- 持久化的 submission-attempt 标记用于区分“尚未 dispatch、可直接取消”和
  “提交结果不确定”两种 Turn；后一种必须先幂等 reconcile，再执行取消，避免留下
  孤儿模型任务。
- dispatch lease 防止两个 Spring 副本同时协调同一 Turn；lease 过期后可由其他副本恢复。
- 每个已受理 Harness 事件后都持久化源 cursor 和 epoch。

Coordinator 使用同一个 Session UUID attach 或 load Harness Session，提交原 Prompt，消费带 fencing 的 SSE，并投影到公共事件存储。`turn_complete` 和 `turn_error` 负责持久结算 Turn。定时恢复扫描会重新 claim dispatch lease 已过期的 admitted/running Turn。

## 8. API 切片

Phase 1 实现：

```text
POST /v1/agents/sessions
GET  /v1/agents/sessions
GET  /v1/agents/sessions/{sessionId}
POST /v1/agents/sessions/{sessionId}/events
GET  /v1/agents/sessions/{sessionId}/events
```

事件写入口接受 input message 或 cancellation。创建 Session 时可以包含首条文本输入。公共 SSE 的 `id` 使用 Java `publicSequence` 并支持 `Last-Event-ID`；不得暴露 Harness event epoch 或源 sequence。

WebShell Adapter 实现现有七条路由：

```text
POST /api/agent/web-shell/v1/sessions/query
POST /api/agent/web-shell/v1/sessions/get
POST /api/agent/web-shell/v1/transcript/query
POST /api/agent/web-shell/v1/events/stream
POST /api/agent/web-shell/v1/sessions/create
POST /api/agent/web-shell/v1/turns/submit
POST /api/agent/web-shell/v1/turns/cancel
```

两个 Adapter 调用相同的 Command/Query/Event Service；WebShell Adapter 不是第二条执行链路。
Transcript 首屏按升序返回最新的有界事件页，`olderCursor` 用于向前翻页，且不改变
实时订阅使用的 `lastSequence` 游标。

## 9. Hosted Harness 与 Runtime 时序

创建持久 Turn 和开始模型推理不依赖 Tool Runtime ready。启用嵌入 Runtime Broker 后，服务在 admission 后异步调用 `warm(sessionId)`，同时独立提交 Prompt。无工具 Turn 可以在不等待 warmup 的情况下完成；发生 Tool Call 时，由 `BrokerManagedRuntimeProvider` 等待原 Runtime binding。

Hosted Harness Client 校验 capability digest、protocol version、boot ID、SSE epoch 和源 sequence。fence 不匹配时 Turn 失败关闭；不得回退到 Legacy 或其他 Runtime。

## 10. 配置

生产必需配置：

```text
SPRING_DATASOURCE_URL
SPRING_DATASOURCE_USERNAME
SPRING_DATASOURCE_PASSWORD
QWEN_MANAGED_AGENT_HARNESS_ENABLED=true
QWEN_MANAGED_AGENT_HARNESS_BASE_URL
QWEN_MANAGED_AGENT_HARNESS_TOKEN
QWEN_MANAGED_AGENT_CAPABILITY_DIGEST
```

Runtime Broker 使用独立配置；只有显式提供私有 listener、bearer token 和 Provisioner 输入时才启用。公共 HTTP Server 与私有 Broker listener 不能使用相同暴露策略。
使用 local-process Provisioner 时，如果没有配置 workspace ID，服务会从 canonical workspace 路径派生与 Qwen 一致的 ID；如果显式配置，则必须等于 SHA-256 的前 16 位，否则应用启动失败。

Flyway 在应用启动时执行版本化 migration。生产使用 MySQL；H2 MySQL mode 只用于测试。

## 11. 失败行为

| 失败                                    | 行为                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| tenant Header 缺失或非法                | Controller dispatch 前返回 HTTP 400                           |
| 使用其他 tenant 的资源 ID               | HTTP 404                                                      |
| 相同幂等 key 对应不同正文               | HTTP 409                                                      |
| admission 前 Harness 未启用             | 返回 HTTP 503，不受理 command                                 |
| admission 后 Harness 传输不可用         | Turn 保持 durable admitted，由恢复任务重试                    |
| Harness capability 或 generation 不匹配 | Turn 失败关闭                                                 |
| Client SSE 断开                         | 仅结束订阅；Turn 继续                                         |
| Spring 进程退出                         | 其他副本可在 dispatch lease 过期后接管                        |
| 本地 Runtime workspace ID 不匹配        | 接收流量前应用启动失败                                        |
| Tool Call 前 Runtime warm 失败          | 产生公共 environment failure；模型流不被同步阻塞              |
| Tool 执行结果不确定                     | Broker 返回 recovery-blocked/unknown；不得在其他 Runtime 重放 |

## 12. 验证计划

- 单测 tenant 解析、canonical digest、事件投影和错误映射。
- 用 H2 MySQL mode 启动真实 Spring Context 和 Flyway。
- 验证公共 Session UUID 与传给 Harness、Runtime Broker 的 ID 完全一致，数据库不保存第二套 Session ID。
- 验证相同 key replay、不同正文冲突和跨 tenant 404。
- 验证持久 Event 顺序与 `Last-Event-ID` replay。
- 对接确定性 Hosted Harness fixture，证明 create、Prompt admission、SSE 投影、终态结算和 retry 都使用稳定身份。
- 在 Java 21 上执行模块测试与 Checkstyle。
- 在生产门禁完成前，用 MySQL 和真实 `qwen serve --profile hosted-harness` 构建并启动 executable jar。

仓库内的确定性 fixture 现已覆盖 13 个测试：tenant 强制校验、跨 tenant
404、串行与并发命令重放（包括原 Turn 仍活跃时的重放）、事件续传、异步
Harness 事件投影、提交结果不确定后的取消恢复、错误详情脱敏、Runtime
Broker 的条件装配和 tenant 解析、Broker 私有鉴权、workspace identity 自动派生，
以及显式 workspace ID 不匹配拒绝。Java SDK 工作流已包含 Checkstyle 与
executable jar 打包。

本地真实进程门禁现已启动隔离 MySQL、可执行 Spring jar、真实 Hosted Harness、
嵌入 Broker、独立 Runtime worker 和 `moonshot/kimi-k3`。最终一轮受控 30 秒
Runtime 冷启动中，公共 admission 为 114 ms，首个真实模型事件为 6,629 ms，
Runtime ready 为 31,141 ms，Turn 在 39,237 ms 完成；同一轮还验证了精确的
`write_file` 副作用、同 Session 幂等重放、跨 tenant 404、持久 Event sequence
无重复且仅有一个 terminal Event。这些时延只是一次本地观测，不是 SLO。
确定性模型 fixture 继续作为 CI 的时序证明；最近一次结果为首模型事件 300 ms，
Runtime ready 15,565 ms。

生产 ACS/Pod 调度、多节点 Broker 持久 Repository、进程丢失恢复、真实负载均衡
和完整租户隔离矩阵仍是生产门禁，不能算作 Phase 1 已证明的能力。

## 13. 验收标准

Phase 1 完成条件：

1. 应用在 classpath 中没有任何 DataWorks artifact 或 class 的情况下启动。
2. 所有公共和 WebShell 查询都按 tenant 限定，跨 tenant ID 返回 404。
3. 重复 create/submit 命令返回原 ID，且不会创建第二个 Turn。
4. 客户端可以从公共 Event sequence 重连，且不会收到重复事件。
5. 确定性 Harness fixture 可以完成一个真实异步 Turn。
6. 任何公共响应或日志都不包含 Harness、Broker 或 Runtime secret。
7. 现有 TypeScript Hosted Harness 和 Legacy `qwen serve` 路由行为不变。

生产多副本门禁还要求：真实 MySQL 并发、使用持久 Repository 的嵌入 Broker、生产 Hosted Harness 与 ACS/Pod Runtime 部署、进程丢失恢复，以及负载均衡下的租户隔离测试。同时还需要 attachment 空闲淘汰/容量策略，避免长期运行的 Java 进程持续为所有历史 Session 保留 heartbeat。
