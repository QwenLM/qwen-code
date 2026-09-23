# Managed Agent Java Runtime Broker MVP

[English](2026-09-17-managed-agent-java-runtime-broker-mvp.md) | [简体中文](2026-09-17-managed-agent-java-runtime-broker-mvp.zh-CN.md)

可执行计划：[Managed Agent Hosted Runtime](../plans/2026-09-17-managed-agent-hosted-runtime-execution.md)

状态：实施中
日期：2026-09-17
源码基线：`65a6adf882bc8cf543d691ef6850c49b64b3718d`

## 1. 问题

当前 daemon 已经可以选择 Managed 执行引擎、在进程内运行 Agent Loop，并通过 `ManagedRuntimeProvider` 委托工具执行。生产默认的本地 Provider 仍会访问隐藏的 `managed-gateway` ACP Session，实验性的 auto-local Provider 则由 `qwen serve` 自己管理 Node worker 生命周期。

Hosted 目标需要不同的所有权边界：Java 产品服务负责租户身份、Runtime provisioning、绑定、配额和执行回执；`qwen serve` 负责模型循环和可恢复 Harness 状态；Tool Runtime 负责 Workspace 副作用，并且永远不接收用户 Prompt 或模型凭证。

首个实现必须证明 Runtime 冷启动不会延迟模型首 token，同时同一 Turn 内的 Tool Call 可以等待 Runtime 后继续执行，并且不会更改执行引擎或重放结果不确定的副作用。

## 2. 目标

- 为 `qwen serve` 增加 Hosted Harness Profile。
- 增加通过 Java 服务而不是 Runtime endpoint 执行工具的 Broker Provider。
- Java 接受首轮 Prompt 时即开始 Runtime provisioning。
- 在真正发生 Tool Call 前，模型推理不依赖 Runtime ready。
- 在 Java 所有的抽象中持久化 Runtime binding 和工具执行身份。
- 复用现有 Managed Tool v2 行为，不在 Java 重写工具语义。
- 失败时关闭执行，不回退 Local Runtime 或 Legacy。
- 通过物理进程树退出和取消后无新增写入证明取消完成。

## 3. 非目标

- 首个切片不实现 Kubernetes provisioning。
- 不实现完整 Public Agent CRUD 或与 OpenAI Agents API 字段级兼容。
- 不迁移 MCP、Hooks、Channels、定时任务、Worktree 或 Legacy 会话。
- 首个切片不实现跨 Harness 的共享 Session Authority。
- 在替代链路覆盖完整前不删除实验 `/managed/sessions*`。
- 不在 Java 重写 TypeScript Agent Loop。

## 4. 架构

```text
Client
  |
  v
Java 产品服务
  |-- AgentSessionService
  |-- PublicEventStore
  |-- HarnessClient ------------------------------+
  |-- RuntimeBrokerService                        |
  |-- RuntimeBindingRepository                    |
  |-- ExecutionLedger                             |
  `-- RuntimeProvisioner                          |
          |                                       |
          | HTTP/SSE                              | HTTP/SSE
          v                                       v
Tool Runtime                               qwen serve Sidecar
  |-- Workspace                              |-- Managed Harness
  |-- Tools                                  |-- Model Loop
  |-- File History                           |-- Session Authority
  `-- 无模型凭证                             `-- BrokerManagedRuntimeProvider
                                                       |
                                                       `-- HTTP -> Java Broker
```

Java 到 Harness 和 Harness 到 Java 构成一条有意设计的异步回路。公共请求等待 Harness 时不得长期占用阻塞式 Java 请求线程。Java 持久受理输入、调度 Turn，并通过 SSE 暴露进度。

## 5. 权威状态边界

| 状态                                           | 权威持有者             |
| ---------------------------------------------- | ---------------------- |
| 用户、租户和 Workspace 授权                    | Java                   |
| 公共 Agent、Session、Turn、Item 和 Artifact ID | Java                   |
| Session 执行引擎与 Agent revision              | Java 保存，qwen 校验   |
| 模型上下文、checkpoint 和 Harness 恢复         | qwen Session Authority |
| Runtime 生命周期和绑定                         | Java Runtime Broker    |
| 逻辑工具执行状态                               | Java Execution Ledger  |
| 物理执行回执                                   | Tool Runtime           |
| 公共事件序列                                   | Java PublicEventStore  |
| Runtime endpoint、lease 和 token               | 仅 Java                |

Java 可以持久化公共 Item 投影，但本阶段不成为第二套模型历史权威。

## 6. 身份模型

Session 在 Java、Harness 和 Broker 中使用同一个 RFC UUID；其余执行 ID 相互独立：

```text
sessionId         公共 API、qwen Session 与 Broker scope
runtimeSessionId  一次 Managed Tool Session
runtimeBindingId  一个已 provision 的 Workspace Runtime binding
turnId            一轮 Agent Turn
toolCallId        模型生成的 Tool Call
executionCallId   持久化的物理工具执行身份
```

Java 保存以 `sessionId` 为键的 `SessionBackendBinding`，其中包含租户、Workspace generation、固定执行引擎、Agent revision 和 capability digest；不再保存第二套 Harness Session ID。Session 创建后执行引擎和 revision 不可修改。

默认 Runtime 复用键为：

```text
tenantId
+ workspaceId
+ workspaceGeneration
+ canonicalCwd
+ capabilityDigest
+ isolationClass
+ isolationClass=session 时的 sessionIdentity
```

如果可执行能力相同，不同 Agent revision 可以共享 Runtime。强隔离任务使用 `isolationClass=session`；此时 binding key 加入统一 Session ID，并要求 provisioner 返回独立 Runtime。

## 7. 数据模型

### 7.1 SessionBackendBinding

```ts
interface SessionBackendBinding {
  sessionId: string;
  tenantId: string;
  workspaceId: string;
  workspaceGeneration: string;
  executionEngine: 'legacy' | 'managed';
  agentId: string;
  agentRevision: string;
  capabilityDigest: string;
  status: 'active' | 'closing' | 'closed';
}
```

### 7.2 RuntimeBinding

```ts
interface RuntimeBinding {
  runtimeBindingId: string;
  tenantId: string;
  workspaceId: string;
  workspaceGeneration: string;
  canonicalCwd: string;
  capabilityDigest: string;
  isolationClass: 'workspace' | 'session';
  state: 'provisioning' | 'ready' | 'draining' | 'released' | 'failed';
  runtimeInstanceId?: string;
  leaseId?: string;
  leaseEpoch: number;
  idleDeadline?: string;
}
```

```text
ABSENT -> PROVISIONING -> READY -> DRAINING -> RELEASED
                       `-> FAILED
```

### 7.3 ToolExecution

```ts
interface ToolExecution {
  executionCallId: string;
  idempotencyKey: string;
  runtimeBindingId: string;
  sessionId: string;
  runtimeSessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  requestDigest: string;
  state:
    | 'accepted'
    | 'waiting_runtime'
    | 'dispatched'
    | 'started'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'recovery_blocked';
  resultRef?: string;
  errorCode?: string;
}
```

```text
ACCEPTED -> WAITING_RUNTIME -> DISPATCHED -> STARTED
                                             |-> SUCCEEDED
                                             |-> FAILED
                                             |-> CANCELLED
                                             `-> RECOVERY_BLOCKED
```

## 8. Harness 到 Broker 契约

`qwen serve` 新增 `BrokerManagedRuntimeProvider`、`ManagedRuntimeBrokerClient` 和 Hosted Harness Profile。Provider 发送统一 Session ID 和调用身份。Java 从已认证的 `sessionId` 解析租户和 Workspace 范围；现有 `harnessSessionId` 协议字段只是传递同一值的兼容别名。Java 不信任 Harness 提交的 tenant 或 Runtime endpoint 字段。

私有接口为：

```text
POST /internal/runtime-broker/v1/tool-sessions:acquire
POST /internal/runtime-broker/v1/tool-sessions/{runtimeSessionId}/control
POST /internal/runtime-broker/v1/executions:prepare
POST /internal/runtime-broker/v1/executions/{executionCallId}:start
POST /internal/runtime-broker/v1/executions # 兼容 create-and-start
GET  /internal/runtime-broker/v1/executions/{executionCallId}
GET  /internal/runtime-broker/v1/executions/{executionCallId}/events
POST /internal/runtime-broker/v1/executions/{executionCallId}:cancel
POST /internal/runtime-broker/v1/tool-sessions/{runtimeSessionId}:release
```

Harness 使用 `executions:prepare` 预留 durable 身份但不派发，把该身份提交到私有 `await_runtime` checkpoint，提交成功后才调用 `:start`。GET 永远不会启动 `PREPARED` 记录，取消则可以在没有物理副作用时直接结算；原 `/executions` create-and-start 路由继续兼容。P2 客户端轮询 `GET /executions/{executionCallId}`。`/events` 路由及其序号语义在此冻结，并在 P3/P4 接入产品事件存储时实现。

qwen 客户端为现有 Managed Tool v2 操作生成有类型的判别联合：manifest、file-history bind/checkpoint/snapshot、begin-turn、prepare、confirmation、confirm 和 preflight。Java 校验封闭的操作名集合；P2 中字段级 payload 校验仍由 Managed Runtime 完成。它不是任意 URL 或 HTTP 方法代理。

所有命令携带稳定 request ID；物理工具执行额外进入 Java Execution Ledger。

## 9. 首轮 Prompt 流程

Java 接受首轮 Prompt 时：

1. 解析租户和 Workspace 授权。
2. 固定执行引擎、Agent revision 和 Workspace generation。
3. 持久化输入和 Turn。
4. 异步启动 `RuntimeBrokerService.ensureBinding()`。
5. 不等待 Runtime ready，立即通过 `HarnessClient` 提交 Prompt。
6. 返回 `202 Accepted`，客户端通过 Java SSE 观察 Turn。

无 Tool Turn 中，模型推理和完成都不等待 Runtime。Provisioning 可以继续，以便后续 Turn 复用已经预热的 Runtime。

冷启动 Tool Turn 中，Harness prepare 或解析 `ToolExecution`，在任何副作用前提交稳定 Broker 身份，并在私有 checkpoint 成功后启动。Java 将其保持在 `waiting_runtime`，原 binding ready 且完成能力校验后再派发，结果返回 Harness，由同一个模型循环继续执行。

## 10. 幂等与结果不确定

执行幂等键由以下字段生成：

```text
sessionId + turnId + toolCallId + requestDigest
```

- 相同 key 和相同请求返回原 `executionCallId`。
- 相同 key 但请求内容不同返回冲突。
- Java 在派发前记录 `PREPARED` 并返回 durable ID；只有显式 start 命令可以取得 dispatch claim。
- Runtime 按 `executionCallId` 去重，并在 binding 存活期间保留回执。
- 响应丢失后查询原 Runtime 和原 execution ID。
- 执行是否开始不确定时，Java 不得更换 Runtime 后重放。
- 原 Runtime 和持久回执都无法证明终态时，执行进入 `recovery_blocked`。

## 11. 取消

取消是持久请求，不等同 HTTP 断开：

```text
客户端取消
  -> Java记录 cancel intent
  -> HarnessClient取消 Turn
  -> RuntimeBroker取消 execution
  -> Runtime终止工具根进程及后代
  -> Java观察到可证明终态
  -> Java结算 Turn
```

Cancel ACK、请求被 Abort 或信号已发送都不能单独证明取消完成。验收必须证明根进程和后代均退出，并且取消后没有新增写入。

## 12. Hosted Harness Profile

`qwen serve --profile hosted-harness` 必须：

- 只监听 loopback；
- 强制配置 Java Broker origin 和服务凭证；
- 拒绝 Local Runtime fallback；
- 不启动或发现 Runtime 进程；
- 不暴露 Runtime endpoint、lease 或 token；
- 拒绝浏览器直接访问；
- 禁止 Client MCP、CDP 隧道和 Channel 托管；
- 持有模型凭证但不持有 Kubernetes 管理凭证；
- Managed Turn 失败后不通过 Legacy 重试；
- Broker 配置不完整时启动失败。

本地和开源模式继续使用现有 Local Provider。

## 13. Java 到 Runtime 传输

首个切片复用现有带鉴权的 Managed Tool v2 worker 协议。Java 提供：

```text
RuntimeProvisioner
|-- StaticRuntimeProvisioner        最初契约和E2E
|-- LocalProcessRuntimeProvisioner  首个自有生命周期实现
`-- KubernetesRuntimeProvisioner    后续里程碑

RuntimeTransport
`-- HttpRuntimeTransport
```

当前 Node worker 使用 Node IPC 启动，不是适合 Java 的进程契约。本地进程里程碑增加独立 boot 输入和单条有界 ready 记录，例如：

```text
node managed-runtime-worker.js --boot-config /owned/path/boot.json
```

```json
{
  "type": "ready",
  "runtimeInstanceId": "rt_123",
  "endpoint": "http://127.0.0.1:12345",
  "leaseId": "lease_456",
  "epoch": 1
}
```

正常 Runtime 日志不得与 ready 记录共用输出通道。

## 14. 并发与事件

- 一个 Harness 进程服务多个 Session。
- 同一 Session 内的 Turn 串行。
- 兼容 Session 在同一 Workspace 范围内复用 Runtime。
- MVP 中同一 Runtime binding 的工具 execute 串行。
- 公共事件由 Java 分配单调 `eventSequence`。
- Java 将 Harness 事件投影为公共 Items；Broker 事件除非提供唯一的用户可见进度，否则保持内部状态。
- 使用 `executionCallId` 对 Harness 和 Broker 的重叠观测去重。
- SSE 支持 `Last-Event-ID`；客户端断线不取消 Turn。

## 15. 兼容与发布

- 现有普通 `/session` Managed 路径是唯一生产方向 Harness 入口。
- 实验 `/managed/sessions*` 不扩展为公共 Agent API。
- 旧路径保留到新链路覆盖 admission、事件、取消和恢复。
- 发布由 tenant/workspace 兼容策略控制，并且只影响新 Session。
- 回滚时已有 Session 的执行引擎归属不改变。
- Managed 初始化或执行失败不通过 Legacy 重试当前 Turn。

## 16. 实施切片

1. 共享契约类型、validator、状态机、Fake Broker 和延迟 Runtime 测试夹具。
2. qwen Hosted Harness Profile、Broker client、Provider、root Session 身份传播和定向单测。
3. Java 内存 Broker、Static provisioner、HTTP Runtime transport 和 qwen 回调鉴权。
4. Prompt 时并行 `ensureBinding`、Java事件流和15秒冷 Runtime E2E。
5. Java 自有本地进程生命周期、独立 worker boot 协议、status/cancel/release 和进程树验证。
6. 持久化 Repository、公共 Agent/Session/Turn/Item API、Artifact 和旧实验控制面退役。

可嵌入的 Java Broker 位于 `packages/sdk-java/runtime-broker`。产品服务通过接口注入已鉴权的 Session resolver 与 Runtime provisioner，Broker 核心不绑定 Spring 或具体调度系统。

### 16.1 当前 qwen 切片已完成

- 增加 `qwen serve --profile hosted-harness`，启动时强制仅监听 loopback、要求 bearer 鉴权并关闭 Web UI。
- 增加独立的 Broker 地址与凭证输入，并从子 Runtime 环境中清除 Broker 密钥。
- 增加 Broker 驱动的 Managed Tool v2 Provider，覆盖类型化控制、持久执行创建/状态/取消与终态释放。
- 独立传递统一 Session ID 和 Runtime Session ID。
- Hosted 模式下普通会话的引擎选择失败即关闭，并移除 Local Runtime 回退。
- Broker 获取保持懒加载，因此无 Tool 的轮次不会访问或等待 Broker。

产品服务在 Prompt 接收时并行调用 `warm()`、公开事件投影、独立 Runtime 启动协议与持久化仓储仍属于后续切片。

### 16.2 当前 Java 切片已完成

- 增加 Java 11 可嵌入 `RuntimeBrokerService`，由已鉴权的统一 Session 解析权威 scope，并复用兼容 Runtime binding。
- 增加异步 `warm()` 和 acquire，使产品服务可以启动 Runtime provisioning 而不阻塞模型推理。
- 增加内存版执行账本，同一幂等键只返回一个 `executionCallId` 并且只派发一次。
- 覆盖跨 Harness 身份拒绝、取消终态优先、活动执行释放栅栏以及 provisioning 失败后重试。
- 增加 `/internal/runtime-broker/v1` 参考 HTTP 适配器，以及访问现有 Managed Runtime v1/v2 worker 路由的 HTTP transport。
- 为新模块增加 Maven 测试与 CI 覆盖。

真实 Java 产品服务的 Prompt admission 仍需调用 `warm()`。持久化 repository、公共事件、独立 Runtime 进程所有权与物理进程树取消仍属于后续切片。

## 17. 验证计划

- 单测请求校验、scope解析、幂等、状态转换和 fail-closed Provider 选择。
- 使用 Fake Java server 对每个 Broker 操作运行契约测试。
- 运行 Runtime ready 人为延迟15秒的双进程 E2E。
- 注入 execute响应丢失、重复请求、取消竞争、Runtime退出、Java重启和 Harness断开。
- 验证取消后的进程树存活状态和文件写入。
- 验证 Runtime环境不含模型凭证，Harness环境不含 provisioner凭证。
- 分别测量首个模型事件、Runtime ready、首个工具等待、Turn完成和阻止重复执行的计数。

## 18. 验收标准

1. Runtime延迟15秒不延迟首个模型事件。
2. 无 Tool Turn 在 Runtime未就绪时完成。
3. 同一 Turn 的 Tool Call 等待 Runtime 后完成。
4. Runtime不调用模型，也不接收用户 Prompt。
5. Hosted模式无法回退 Local Runtime 或 Legacy执行。
6. 一个幂等键最多产生一次物理执行。
7. Runtime回执仍可访问时，Java可以通过原 `executionCallId` 恢复执行。
8. 无法证明终态的 started执行进入 `recovery_blocked`，且不被重放。
9. 取消证明根进程和后代退出，并且之后无新增写入。
10. tenant、workspace 和 generation不匹配在副作用前被拒绝。
11. 同一 Harness中的多个 Session不共享模型上下文、权限或事件归属。
12. 公共响应不暴露 Runtime endpoint、token、lease、Pod名称、ACP client ID 或 Harness instance ID。
