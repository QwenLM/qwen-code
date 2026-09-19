# Managed Agent 产品 Tool Runtime 接入执行方案

状态：可执行；R0 镜像/Java lifecycle 已落代码但待真实环境探针，R1、R2、R3 已完成代码和目标测试，R4 已完成本地跨进程联合 E2E、待产品内网真实 DataAgent 验收，R5a/R5b 与产品 durable Repository/创建幂等核心已落代码，R5d 已完成同进程完整生命周期竞争和跨 JVM/H2 TCP 的 UNKNOWN CAS 验证，并已提供专用 MySQL 测试库 opt-in 运行入口，R5e 已完成 UNKNOWN 核心门禁和显式处置 API，真实 MySQL/负载均衡/Runtime 故障注入仍待执行

日期：2026-09-18

上游方案：[Managed Agent P3 Java Prompt 服务接入执行方案](./2026-09-18-managed-agent-p3-product-integration.md)

后续方案：[Managed Agent 公共 Agent API 适配层执行方案](./2026-09-18-managed-agent-public-api-adapter.md)

## 1. 冻结结论

本阶段采用下面的部署和调用方式：

```text
用户请求
   |
   v
Java Prompt 服务 -----------------------> 常驻 Hosted Harness
  |  Session/Turn/Event 权威状态              | 模型、Context、Agent Loop
  |  submit 前立即异步 warm                   |
  |                                           | 需要本地 Tool 时
  |                                           v
  +-- 内嵌 Runtime Broker <-------------------+
          |
          | Java 主动 HTTP 调用
          v
     DataAgent Tool Runtime
     qwen managed worker --boot-env
```

具体决策：

1. Runtime Broker 首版是 Java 管控面内的模块，不单独部署一套服务；它使用独立的内网 HTTP 入口供 Hosted Harness 调用。
2. Tool Runtime 不主动连接 Java。Java 创建或复用 DataAgent 实例，并主动调用 Runtime 的 `prepare/control/execute/cancel/release` 路由。
3. Tool Runtime 使用专用启动模式，不复用普通 `qwen serve` Pod。普通 daemon 没有 Java Broker 所需的 owned Runtime v2 路由。
4. 首版使用 Session 级隔离：一个 Managed Session 最多绑定一个 DataAgent Tool Runtime；后续有真实容量数据后再增加 workspace 级复用。
5. Prompt 主链路只触发 `warmAsync`，不等待 Runtime ready。只有 Harness 产生 Tool Call 时才等待原 binding。
6. Legacy、`QWEN_CODE`、`QWEN_DAEMON_REST` 与 `QWEN_HOSTED_HARNESS` 并存；任何活动 Managed Session 都不得故障回落到 Legacy。
7. WebShell 产品模式通过显式 `JavaAgentProvider` 只访问 Java Session/Prompt/SSE API；浏览器不直连 Hosted Harness、Runtime Broker 或 Tool Runtime，也不要求 Java 实现 daemon-compatible 网关。
8. 本阶段只维护 Markdown 方案和代码，不生成或更新 HTML。

## 1.1 当前执行看板

| 批次                  | 状态     | 已完成                                                                                                       | 下一验收门槛                                            |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| R0 网络和镜像         | 部分完成 | 专用镜像/entrypoint、Java `/health` 探活和内部 STARTED/HEARTBEAT 已落代码                                    | Java 服务 Pod 能调用真实 Runtime `/health` 和 `prepare` |
| R1 qwen worker        | 已完成   | `--boot-env`、严格校验、真实子进程 E2E                                                                       | 专用镜像内复验 lifecycle 和 SIGTERM                     |
| R2 产品 scope         | 已完成   | Hosted binding 反查、resourceGroup 持久化、scope hash、默认关闭配置                                          | 目标环境配置审计通过                                    |
| R3a provision/warm    | 已完成   | tool-only create、DataAgent provision、健康探针、Prompt submit 前异步 warm                                   | 真实 DataAgent 冷启动联调                               |
| R3b 生命周期          | 代码完成 | close/delete drain、删除重试、Java 重启后的 heartbeat reaper 自动删除                                        | 真实环境注入 delete 失败与 Java 重启                    |
| R4 Broker 联合链路    | 部分完成 | 本地跨进程 Hosted Harness → Java Broker → owned Runtime Tool Turn、响应丢失恢复、取消和双 Session 隔离均通过 | 产品内网入口连接真实 DataAgent Tool Runtime             |
| R5a/R5b Broker 持久化 | 代码完成 | Repository SPI、三类持久状态机、dispatch claim、响应丢失恢复                                                 | 产品数据库与双 Java 实例联合验证                        |
| R5c 产品 durable 接入 | 部分完成 | 三张表/MyBatis Repository、DataAgent 幂等 request、generation fencing、加密 token                            | ACS 真实 provision 重启注入，确认物理实例唯一           |
| R5d 双实例竞争        | 部分完成 | 两个独立 Spring Context 覆盖完整生命周期；两个独立 JVM 通过 H2 TCP 验证数据库 CAS 竞争                       | 两个 JVM + MySQL + 普通负载均衡复验                     |
| R5e UNKNOWN 恢复      | 部分完成 | generation 丢失转 UNKNOWN、禁止重新 claim、Java API、受审计 console 入口、跨 JVM 相反处置竞争                | owner crash、DB 不可用、Runtime 不可达的真实故障注入    |
| R6 灰度               | 未开始   | 灰度与回滚原则已冻结                                                                                         | 故障注入、容量和安全门禁全部通过                        |

## 2. 为什么不能直接复用现有 DataAgent daemon

Java Runtime Broker 当前调用以下协议：

```text
POST /internal/managed-runtime/v1/prepare
POST /internal/managed-runtime/v2/{control-kind}
POST /internal/managed-runtime/v2/execute
POST /internal/managed-runtime/v2/status
POST /internal/managed-runtime/v2/cancel
POST /internal/managed-runtime/v2/release

X-Qwen-Managed-Lease-Id: <leaseId>
X-Qwen-Managed-Lease-Epoch: <epoch>
```

这些 v2 路由只在 qwen worker 以 owned Managed Runtime 身份启动时存在。现有普通 DataAgent Pod 的 `qwen serve` 不具备该 owner、lease 和 epoch，因此把它的 endpoint 直接交给 Broker 会在协议层失败，也无法证明工具副作用只执行一次。

产品 Runtime 镜像必须包含一个专用 entrypoint，但不能把现有依赖 BFF token 的 lifecycle reporter 一起带入 Tool Runtime。Tool Runtime 不持有 BFF、模型或 Hosted Harness 凭据；DataAgent lifecycle 由 Java Broker 在已有内部 Service 边界内驱动：

```text
/etc/dsw/entrypoint_qwen_managed_runtime
  -> 校验 QWEN_MANAGED_RUNTIME_BOOT 和固定 worker 产物
  -> exec node /opt/qwen-code/dist/managed-runtime-worker.js --boot-env
  -> worker 自己处理 SIGTERM，停止接单并关闭 owned Runtime

Java DataAgentRuntimeProvisioner
  -> createManagedRuntime 返回 STARTING + private domain
  -> bearer 请求 Runtime /health
  -> 探活成功后内部调用 DataAgentInstanceService.handleReport(STARTED)
  -> 每 30 秒先探活，再内部调用 handleReport(HEARTBEAT)
  -> release/close 先取消 heartbeat，再 delete DataAgent instance
```

专用镜像使用 `docker/qwen-sandbox/Dockerfile.managed-runtime` 构建。构建时必须显式传入不可变的 `QWEN_CODE_VERSION`，并在镜像层验证 `dist/cli.js` 与 `dist/managed-runtime-worker.js` 都存在；禁止 `latest/next/beta`。镜像把已验证的包链接到 `/opt/qwen-code`，所以 Java 的 `cli-entry` 与 entrypoint 不依赖 npm 全局目录布局。

Java 通过容器环境变量传递一次性 boot document：

```json
{
  "type": "boot",
  "version": 1,
  "runtimeInstanceId": "<dataAgentInstanceId-or-provision-id>",
  "gatewayIncarnation": "<java-deployment-generation>",
  "leaseId": "<uuid>",
  "epoch": 1,
  "tenantId": "<tenantId>",
  "workspaceId": "<sha256(canonical-workspace-cwd)[0:16]>",
  "workspaceCwd": "/workspace",
  "token": "<runtime-bearer-token>",
  "outputRoot": "/tmp/qwen-managed-runtime",
  "cliEntry": "<absolute-qwen-cli-entry>",
  "listenHostname": "0.0.0.0",
  "listenPort": 4096
}
```

环境变量名固定为 `QWEN_MANAGED_RUNTIME_BOOT`。worker 读取后立即从进程环境删除，拒绝未知字段、非 `0.0.0.0` listener、越界端口、非 canonical 的 `workspaceCwd`，以及不等于 `sha256(workspaceCwd).hex[0:16]` 的 Runtime `workspaceId`。

DataAgent provision 不继承 Java 或部署平台的整套环境。当前首版只显式传
`QWEN_MANAGED_RUNTIME_BOOT`，DataAgent Service 只补充自身的
`DATA_AGENT_INSTANCE_ID`。它不会获取或注入 BFF token、BFF endpoint、MCP token、模型 catalog 或 qwen model settings。后续 Tool/MCP 凭据必须逐项进入 allowlist，不得把模型 Provider、Hosted Harness、Gateway、IDE、Runtime Broker 或 BFF bearer/token 注入 Tool Runtime。

## 3. 组件和代码边界

### 3.1 qwen-code

负责：

- 解析文件、本地 IPC 和远程环境三种 owned worker boot；
- 对远程 listener 做严格 schema 校验；
- 启动 Managed Runtime v1/v2 路由；
- 校验 bearer、leaseId、epoch、tenant、workspace、cwd；
- 执行 Tool 并返回稳定的执行结果。

不负责：

- DataAgent 实例创建、资源组选择和计费；
- 公共 Session/Turn/Event；
- 跨 Java 重启的 Runtime binding 和 execution ledger。

### 3.2 Java Prompt 服务

新增或装配以下产品类：

```text
ManagedRuntimeBrokerConfiguration
ManagedRuntimeBrokerProperties
ManagedHarnessSessionResolver implements HarnessSessionResolver
DataAgentRuntimeProvisioner implements RuntimeProvisioner
ManagedRuntimeWarmService
ManagedRuntimeWarmServiceImpl
```

职责：

- 从已提交的 Hosted Harness binding 解析可信 tenant、产品 workspace/project 和 resourceGroup；
- 创建、启动、等待或复用 DataAgent Tool Runtime；
- 生成和持有 runtime token、leaseId、epoch；
- 通过 SDK `HttpRuntimeTransport` 主动调用 Runtime HTTP 协议；
- 向 Hosted Harness 暴露 Runtime Broker 私有协议；
- 在 Prompt admission 持久化后、submit Hosted Harness 前异步 warm。

Controller、`PromptExecutor` 和 Hosted Harness Connector 不直接创建 Pod，也不直接转发 Tool payload。

### 3.3 Hosted Harness

保持现有 `BrokerManagedRuntimeProvider`：

- acquire 一个逻辑 Runtime Session；
- 使用 `executionCallId` 查询、等待和取消 Tool execution；
- 不接收 Runtime endpoint、token、Pod ID 或资源组；
- 不决定 tenant/workspace scope。

### 3.4 WebShell

WebShell 不属于 Tool Runtime 数据路径。产品模式由 `JavaAgentProvider` 将 Java Session create/load、Prompt submit、Managed SSE replay 和 cancel 映射为 WebShell 会话与 transcript；本地 `qwen serve` 仍使用现有 Daemon Provider。

浏览器请求终止于 Java/BFF。Runtime endpoint、Broker endpoint、Harness/Runtime/Broker bearer、lease、Pod ID 和本地 workspace path 均不得进入前端。Tool payload 的内部链路仍是 Hosted Harness → Java Runtime Broker → Tool Runtime，不经过 WebShell。

## 4. 产品持久化

### 4.1 Hosted binding 扩展

首版继续复用 `agent_cli_runtime_session` 的 `QWEN_HOSTED_HARNESS` current row，并新增 nullable 字段：

```sql
ALTER TABLE agent_cli_runtime_session
    ADD COLUMN managed_resource_group_id varchar(128) DEFAULT NULL
        COMMENT 'Managed Tool Runtime 使用的资源组 ID';
```

同时增加反向查询：

```text
selectCurrentByCliSessionId(
  cliCode = QWEN_HOSTED_HARNESS,
  cliSessionId = harnessSessionId
)
```

该查询必须限定 `is_current=1 AND is_deleted=0`，且返回 tenant、creator、public session、产品 workspace/project、resourceGroup 和 Harness capability。Broker 不信任 Harness 请求体里自报的 scope。

`ManagedSessionCommandService.ensureSession` 增加可选 `resourceGroupId` 参数：

- 新 Session 从请求 `meta` 提取并写入 Hosted binding；
- 后续 Prompt/恢复不传时保留 DB 原值；
- 同一 Session 再次传入不同非空资源组时 fail closed；
- 公共云需要资源组但 binding 缺失时，warm 标记为不可 provision，不影响无 Tool Turn 的模型输出。

### 4.2 Tool Runtime binding

验证阶段仍可使用 in-memory Repository，但产品默认装配已切换为 durable Repository。不能把 in-memory 实现当作多实例生产状态。

生产最小表不是两张，而是三张。Runtime binding、逻辑 Runtime Session 和 Tool execution 的生命周期不同，不能把逻辑 Session 再藏回 Java 进程内 Map：

```text
agent_managed_runtime_binding
  binding_id
  tenant_id
  session_code
  harness_session_id
  isolation_class
  isolation_key
  scope_digest
  data_agent_instance_id
  runtime_generation
  lease_id
  lease_epoch
  encrypted_runtime_token
  token_key_version
  runtime_endpoint
  boot_digest
  state = PROVISIONING / READY / DRAINING / RELEASED / FAILED
  active_slot = 1 / NULL
  operation_owner
  operation_lease_until
  drain_requested
  version
  last_health_at
  last_active_at

agent_managed_runtime_session
  runtime_session_id
  binding_id
  runtime_generation
  tenant_id
  harness_session_id
  turn_kind
  scope_digest
  state = ACQUIRING / READY / RELEASING / RELEASED / FAILED
  version
  last_active_at

agent_managed_tool_execution
  execution_call_id
  idempotency_key
  binding_id
  runtime_generation
  harness_session_id
  runtime_session_id
  turn_id
  tool_call_id
  request_digest
  reference_payload
  state = PREPARED / DISPATCHING / EXECUTING / CANCEL_REQUESTED / SETTLED / UNKNOWN
  execution_status = NOT_STARTED / SUCCESS / ERROR / CANCELLED / NULL
  result_payload
  last_sequence
  cancel_requested
  dispatch_owner
  dispatch_lease_until
  dispatch_generation
  version
  settled_at
  retain_until
```

唯一约束：

```text
(tenant_id, harness_session_id, active_slot)
(runtime_session_id)
(idempotency_key)
(execution_call_id)
```

MySQL 没有通用 partial unique index，活动 binding 使用 `active_slot=1`，终态行把它更新为 `NULL`；唯一键 `(tenant_id, harness_session_id, active_slot)` 因而只约束一条活动 generation，同时允许保留历史 generation。`runtime_generation` 由 Repository 在创建新活动 binding 时单调递增，旧 generation 的写入必须同时匹配 `binding_id + runtime_generation + version`。

`encrypted_runtime_token` 只能由产品 Repository 使用 KMS/现有密钥服务加解密。qwen Repository SPI 可以接收已还原的 `RuntimeLease`，但日志、异常、指标、SQL 参数审计和普通查询对象都不得暴露明文 token。若目标环境暂时没有合规的 secret persistence，本阶段只能保持单 Java 实例，不能通过把 token 明文写库来绕过门禁。

当前代码已实现三个 Repository SPI、in-memory 实现、产品 MyBatis 实现、三张表的 H2/生产 migration，以及基于数据库 CAS/claim 的 Broker 状态推进。以下条件是“多副本生产开流”门禁：

- binding、逻辑 Runtime Session 和 execution ledger 已持久化；
- provision、execute、cancel、release 使用数据库 CAS 和有期限 ownership claim；
- Java 重启后能恢复原 lease/epoch 或明确 fencing 旧 generation；
- 同一 idempotencyKey 在不同 Java 实例仍只产生一次物理 execute。

实现方式固定为给 qwen `runtime-broker` 模块增加最小 Repository SPI，并保留 in-memory 默认实现供单测和单进程 E2E 使用；产品 Java 提供 MyBatis 实现。不要在产品层复制一份 Broker 状态机。

Repository SPI 固定拆成三个接口：

```java
interface RuntimeBindingRepository {
  RuntimeBindingRecord findOrCreate(RuntimeBindingSpec spec);
  OperationClaim claimOperation(String bindingId, long generation,
      String owner, Instant leaseUntil);
  RuntimeBindingRecord compareAndSet(RuntimeBindingMutation mutation);
  RuntimeBindingRecord findActive(String tenantId, String harnessSessionId);
}

interface RuntimeSessionRepository {
  RuntimeSessionRecord findOrCreate(RuntimeSessionSpec spec);
  RuntimeSessionRecord compareAndSet(RuntimeSessionMutation mutation);
  long countActiveByBinding(String bindingId, long runtimeGeneration);
}

interface ToolExecutionRepository {
  ToolExecutionRecord findOrCreate(ToolExecutionSpec spec);
  DispatchClaim claimDispatch(String executionCallId, String owner,
      Instant leaseUntil);
  ToolExecutionRecord compareAndSet(ToolExecutionMutation mutation);
  ToolExecutionRecord findByExecutionCallId(String executionCallId);
  boolean hasActiveByRuntimeSession(String runtimeSessionId);
}
```

SPI 返回值必须是只包含稳定字段的 immutable value object，不允许持久化 `CompletableFuture`、HTTP client、scheduler 或 `RuntimeBinding` 内部对象。`RuntimeBrokerService` 仍拥有状态机；Repository 只负责原子 create/load/CAS/claim。默认构造函数装配 in-memory Repository，产品构造函数显式注入三个 Repository、稳定的 `brokerOwnerId` 和 lease duration；in-memory Repository 可注入 `Clock` 以验证 claim 过期。

进程内 Map 只允许保留两类优化缓存：当前进程的 in-flight future，以及已建立的 HTTP client/Runtime handle。所有身份冲突判断、generation、terminal state、cancel intent 和 dispatch owner 都必须从 Repository 读取；请求落到另一台 Java 时必须能仅凭数据库记录重建本地 handle。

产品 MyBatis 实现使用数据库时间判断 claim 是否过期，避免多 Java 主机时钟偏差。推荐默认值为 operation lease 30 秒、dispatch lease 30 秒、每 10 秒续约；实际值进入 `ManagedRuntimeBrokerProperties`，且 `renewInterval < leaseDuration / 2`。Repository 在 `READ_COMMITTED` 下使用唯一键加条件 UPDATE，不依赖 JVM 锁：

```sql
UPDATE agent_managed_tool_execution
SET state = CASE
      WHEN cancel_requested = 1
           AND state IN ('EXECUTING', 'CANCEL_REQUESTED')
        THEN 'CANCEL_REQUESTED'
      ELSE 'DISPATCHING'
    END,
    dispatch_generation = CASE
      WHEN dispatch_owner = :owner
           AND dispatch_lease_until > CURRENT_TIMESTAMP(3)
        THEN dispatch_generation
      ELSE dispatch_generation + 1
    END,
    dispatch_owner = :owner,
    dispatch_lease_until = TIMESTAMPADD(MICROSECOND, :leaseMicros, CURRENT_TIMESTAMP(3)),
    version = version + 1
WHERE execution_call_id = :executionCallId
  AND state IN ('PREPARED', 'DISPATCHING', 'EXECUTING', 'CANCEL_REQUESTED')
  AND (dispatch_owner IS NULL
       OR dispatch_owner = :owner
       OR dispatch_lease_until <= CURRENT_TIMESTAMP(3))
  AND is_deleted = 0;

UPDATE agent_managed_tool_execution
SET dispatch_lease_until = TIMESTAMPADD(MICROSECOND, :leaseMicros, CURRENT_TIMESTAMP(3)),
    version = version + 1
WHERE execution_call_id = :executionCallId
  AND dispatch_owner = :owner
  AND dispatch_generation = :dispatchGeneration
  AND dispatch_lease_until > CURRENT_TIMESTAMP(3)
  AND state IN ('DISPATCHING', 'EXECUTING', 'CANCEL_REQUESTED')
  AND is_deleted = 0;
```

第一条语句只负责首次 claim、同 owner 重入或过期接管；只有换 owner/过期接管时递增 `dispatch_generation`。第二条只给同一 owner、同一 generation 的未过期 lease 续约，不能借续约改变 state 或 generation。claim/renew 本身通过 owner、lease、state 和 generation 条件原子竞争并递增 `version`，不依赖先读出的 expected version；普通状态 CAS 和所有终态 UPDATE 则同时校验 `dispatch_generation` 与 `version`，防止旧 owner 的迟到响应写回。实际 MySQL 语句可按数据库方言改写时间加法，但受影响行数必须为 1 才算获得 claim/续约，0 表示重新读取并重试或作为 follower 返回当前状态。

### 4.3 durable execution 状态机

同一 Tool Call 的唯一身份是：

```text
idempotencyKey
harnessSessionId
runtimeSessionId
turnId
toolCallId
requestDigest
referencePayload
bindingId
runtimeGeneration
```

`findOrCreate` 在 `idempotency_key` 唯一键上原子竞争。已经存在时必须逐字段核对上述身份；任何变化都返回 `runtime_broker_execution_conflict`，不能覆盖旧记录，也不能生成第二个 `executionCallId`。

物理执行采用有期限的 dispatch claim：

```text
PREPARED
  -> CAS claimDispatch(owner, leaseUntil, dispatchGeneration + 1)
  -> DISPATCHING
  -> Runtime status(reference)
       settled          -> SETTLED，持久化原结果
       executing        -> EXECUTING，只接管轮询，不再次 execute
       cancel_requested -> CANCEL_REQUESTED，只接管轮询/取消
       prepared         -> Runtime execute(reference)
  -> EXECUTING
  -> SETTLED
```

首次 claim 也先查询 Runtime status。这样“HTTP execute 已到 Runtime，但 Java 在收到响应前退出”与“Java 在发 execute 前退出”可以由原 Runtime 判定。Runtime 现有 V2 `status(reference)` 和 `execute(reference)` 以同一 reference 复用同一个执行 promise，因此重复 HTTP 请求不会产生第二次物理副作用；Java 仍必须通过 claim 避免无意义并发调用。

claim owner 在调用 Runtime 前后都要校验 `bindingId + runtimeGeneration + dispatchGeneration`。claim 过期后其他 Java 可以接管，但只能查询同一 Runtime generation。若原 Runtime 不可达或 binding generation 已变化，execution 转为 `UNKNOWN`/recovery blocked，清除 dispatch owner/lease，并禁止把可能已经执行过的有副作用 Tool 自动投递到新 Runtime。

UNKNOWN 只能由产品管控面显式处置，不能通过 Hosted Harness bearer 接口直接修改。qwen Broker 暴露 Java API `resolveUnknownExecution(...)`，上层在完成审计或人工确认后只能做两种决定：

- `CONFIRMED_NOT_EXECUTED`：将原 execution 终结为 `not_started`，上层随后必须使用新的 idempotencyKey 显式发起新调用；
- `ACCEPTED_UNKNOWN`：将原 execution 终结为带 `runtime_broker_execution_unknown` 的 error，不再执行。

相同处置重复提交幂等，不同处置返回冲突；处置动作自身绝不调用 Runtime execute。

产品首个管理入口固定为 `POST /api/bff-console/v1/managed-runtime/executions/{executionCallId}/resolve`。它复用现有 console 的 region、源租户和 operator allowlist 三重门；应用命令的操作者只从 `EnvContext` 获取。审计日志记录 execution/Harness/Runtime Session、decision、operator 和 reason SHA-256，不记录 reason 原文，也不向 Hosted Harness 暴露该路由。

取消先持久化 `cancel_requested=true`，再由持有有效 dispatch claim 的实例调用 Runtime `cancel(reference)`。cancel 和 execute 的终态都使用 CAS 写回；迟到的旧 owner 因 generation/dispatchGeneration 不匹配不能覆盖新状态。

`RuntimeTransport` 增加 `status(RuntimeLease, RuntimeSession, reference, afterSequence)`。它调用现有 `/internal/managed-runtime/v2/status`，不是新增 Runtime 协议。Broker 的 `getExecution` 每次读取 durable record；只有持有 claim 的后台任务负责同步 Runtime status 和推进状态。

### 4.4 durable binding 和逻辑 Session 状态机

binding 的物理 provision 同样使用 operation claim，但它与 Tool dispatch claim 分开，避免长时间 Tool 执行阻塞 lifecycle：

```text
NONE -> PROVISIONING -> READY -> DRAINING -> RELEASED
             |            |
             +-> FAILED <-+
```

`PROVISIONING` owner 必须先把本 generation 的 leaseId、epoch、加密 token、bootDigest 和确定性的 `provisionRequestId=<bindingId>:<generation>` 持久化，再调用 DataAgent create。DataAgent create 必须支持该 request ID 的幂等创建或按 request ID 查询；否则 Java 在“物理实例已创建、instanceId 尚未写库”之间崩溃会产生无法认领的重复 Pod，R5 不成立。

创建返回后先 CAS 写入 `dataAgentInstanceId`，再等待 domain 和 `/health`。接管过期 `PROVISIONING` 的 Java 先按 `provisionRequestId`/已写入的 instanceId 查询已有实例，只有明确不存在时才创建。READY 的 heartbeat owner 也通过短 operation lease 选主；Java 正常滚动重启只交出 ownership，不删除仍被 Session 使用的 Runtime。当前 `DataAgentRuntimeProvisioner.close()` 的“删除本进程所有 Runtime”行为必须在 durable 模式下移除。

逻辑 Runtime Session 单独持久化。`acquire` 对 `runtime_session_id` 执行 find-or-create 并核对 Harness、scope、turnKind 和 binding generation；任意 Java 都可以对同一 Runtime 重放幂等 `prepare` 并重建本地 handle。`release` 只有在 durable execution ledger 证明没有非终态 execution 时才能进入 RELEASING。binding 表不维护易错的冗余 Session 计数；`drain_requested=true` 且 `RuntimeSessionRepository.countActiveByBinding(...) = 0` 时，持有 binding operation claim 的实例执行物理 drain/release。

Hosted Harness close 通过 durable binding 写入 `drain_requested`，不再依赖进程内无限增长的 `retiredHarnessSessions`。晚到的 warm/acquire 查询到 drain 或终态 generation 后 fail closed，不能重新 provision。

## 5. Runtime scope 解析

`ManagedHarnessSessionResolver.resolve(harnessSessionId)` 的产品身份唯一数据源是已提交的 Hosted binding，但 Runtime 协议的 `workspaceId` 不是产品 workspace/project ID。两类身份必须分开：

```text
tenantId                = binding.tenantId
publicWorkspaceId       = binding.workspaceId
publicProjectId         = binding.workspaceId，用于 DataAgent placement
resourceGroupId         = binding.managedResourceGroupId
runtimeWorkspaceCwd     = canonical properties.workspaceCwd，例如 /workspace
runtimeWorkspaceId      = sha256(runtimeWorkspaceCwd).hex[0:16]
workspaceGeneration     = binding.harnessSessionId
capabilityDigest        = binding.harnessCapabilityDigest
isolationClass          = session
```

传给 qwen `RuntimeScope.workspaceId` 和 boot document 的只能是 `runtimeWorkspaceId`；传给 `DataAgentCreateRequest.projectId` 的才是 `publicProjectId`。如果把产品 workspace ID 直接传进 Runtime 协议，worker 必须在启动阶段 fail closed，而不是等到第一次 Tool Call 才返回 503。

Java 和 qwen 不各自维护一套含糊的 workspace 规则。Java Broker 模块提供一个明确命名的 `runtimeWorkspaceId(canonicalCwd)` helper，并用 qwen 固定测试向量验证：相同 UTF-8 canonical path 必须产生相同的 16 位小写十六进制 ID。

以下情况全部返回稳定的 scope unavailable，不创建 Runtime：

- 找不到 current Hosted binding；
- binding 非 RUNNING；
- Harness Session、tenant、creator 或 capability 不完整；
- Managed resourceGroupId 缺失、非正整数或不是稳定 ID；
- Session 已关闭、删除或进入 recovery blocked；
- 请求 capability 与当前部署策略不一致。

## 6. DataAgent provision

### 6.1 配置

新增默认关闭配置：

```yaml
copilot:
  agent:
    managed-runtime-broker:
      enabled: false
      bind-host: 0.0.0.0
      bind-port: 0
      bearer-token: ${MANAGED_RUNTIME_BROKER_TOKEN:}
      runtime-image: ''
      runtime-kind: ACS_SANDBOX
      runtime-entrypoint: /etc/dsw/entrypoint_qwen_managed_runtime
      runtime-port: 4096
      workspace-cwd: /workspace
      output-root: /tmp/qwen-managed-runtime
      cli-entry: /opt/qwen-code/dist/cli.js
      ready-timeout: 3m
      poll-interval: 1s
      heartbeat-interval: 30s
      release-retry-interval: 5s
      idle-timeout-minutes: 30
```

`bind-port=0` 只允许本地测试动态分配。部署环境 `enabled=true` 时 token、固定 bindPort、image、entrypoint、cliEntry 和 Hosted Harness Broker base URL 任一缺失都启动失败。当前生产门禁要求 `runtime-kind=ACS_SANDBOX`；`ALISA` 在“供应方已创建但 Java 未收到 submit 响应”的崩溃窗口内没有已验证的 request-id 查询/幂等契约，所以开启 Broker 时配成 `ALISA` 会直接启动失败。

### 6.2 创建请求

`DataAgentRuntimeProvisioner` 使用现有 `DataAgentInstanceService.createManagedRuntime` 内部入口。该入口与用户创建实例复用配额、资源组、launch 和生命周期落库，但显式跳过模型/BFF/MCP 初始化：

```text
name               = managed-runtime-<harnessSessionId-prefix>
creationSource     = MANAGED_AGENT
sessionCode        = public sessionCode
provisionRequestId = <bindingId>:<runtimeGeneration>
projectId          = binding.workspaceId，仅用于产品 placement
resourceGroupId    = binding.managedResourceGroupId
image              = configured runtime image
runtimeKind        = ACS_SANDBOX
entrypoint         = configured managed runtime entrypoint
idleTimeoutMinutes = configured idle timeout
extraEnvs:
  QWEN_MANAGED_RUNTIME_BOOT = exact boot JSON
Service-added env:
  DATA_AGENT_INSTANCE_ID = created DataAgent instance ID
```

`provisionRequestId` 是 R5 新增的内部幂等字段，不是用户可传字段。`DataAgentInstanceService.createManagedRuntime` 已通过 `(tenant_id, provision_request_id)` 唯一键、请求 identity digest 和 CREATING 接管保证重试复用同一个 DataAgent 记录。底层 `ACS_SANDBOX` 使用稳定的 `agentName=da<dataAgentInstanceId>` 和 resourceGroup 形成平台幂等键，因此即使 Java 在物理 create 返回前崩溃，重启后仍以同一 DataAgent ID 接管，不产生第二个物理 sandbox。

ACS 的 resourceGroupId 必须是稳定的正整数 ID，不允许空值、identifier/code 或由供应方每次自动选组。`ManagedHarnessSessionResolver` 和 `DataAgentRuntimeProvisioner` 都会在物理创建前校验该值，否则返回 scope unavailable，以保证幂等键在所有重试中不变。

`extraEnvs` 禁止透传当前 Java 进程环境，也禁止包含模型、Hosted Harness、Gateway、IDE、Broker 或 BFF 的凭据。`createManagedRuntime` 不读取 runtime profile，只使用 Managed Runtime 专属配置里的 image、entrypoint 和 runtimeKind。若 Runtime router 未找到 ACS leaf 而回退到 ALISA/SANDBOX_POD，Service 会校验返回 handle 的实际 runtime type，立即 stop 误创建的 Runtime 并使创建失败，禁止静默降级。Runtime bearer 只存在于 boot document和合规加密后的 binding 字段；日志、异常和 lifecycle 上报必须做字段级脱敏。

同一 Session provision 在 R3 单实例验证中可以使用独立的 `ManagedRuntimeProvisionLock`，R5 多实例必须切换到 durable binding CAS 和 operation claim。不能直接复用 Prompt 的 `SessionOperationLock`：Prompt 流期间该锁可能一直被持有，而 warm 必须与模型流并行。

1. 查询 durable binding；
2. 若原 DataAgent instance 为 RUNNING 且健康，复用；
3. STOPPED 时调用 `startInstance`；
4. STARTING 时只等待，不再创建；
5. FAILED/DELETED 或 generation 不一致时 fencing 旧 binding，再创建新 generation；
6. 等待 `dataAgentInstanceDomain` 非空并通过 bearer `/health`；若实例仍为 STARTING，由 Java 内部提交 STARTED，使其进入 RUNNING；
7. 返回包含 `runtimeInstanceId/endpoint/token/leaseId/epoch` 的 `RuntimeLease`。

Provision 成功后，Java 使用独立的 daemon scheduler 按配置间隔执行生命周期心跳：只有 `/health` 成功才调用内部 `handleReport(HEARTBEAT)`，从而续 DataAgent runtime TTL。探活失败时不伪造心跳，交给现有 heartbeat timeout/reaper 回收。Runtime Broker 的 `health()` 同样执行探活和 lifecycle renew；release/close 先取消定时任务，再调用 `deleteInstance`。删除调用失败时按 `release-retry-interval` 在本进程持续重试；`deleteInstance` 一旦受理会持久化 `deleteRequested`，由 DataAgent STOPPING convergence 完成删除。如果 Java 在删除受理前退出，心跳停止后由默认开启的 DataAgent heartbeat timeout reaper 停止物理 Runtime，并把 `creationSource=MANAGED_AGENT` 的 STOPPED 记录自动推进到 DELETED。

`provision()` 在 Broker 异步线程执行，禁止占用 Prompt 请求线程。重复 warm 必须复用同一个 future/binding。

## 7. Java 到 Runtime 的网络路径

目标路径是 Java 主动访问 Runtime 私网 endpoint：

```text
http://<dataAgentInstanceDomain>:4096
```

优先复用 SDK 的 `HttpRuntimeTransport`，这样 bearer 和 lease headers 不经过 Prompt Controller 或浏览器。

在目标环境启用 Broker 前，先完成一个只读网络探针：

1. Java 创建一台专用 Runtime；
2. 从 Java 服务 Pod 直接请求 `/internal/managed-runtime/v1/prepare`；
3. 验证私网 DNS、端口、Authorization 和 lease headers；
4. 验证弹内、弹外预发所需的安全组和 VPC 路由。

如果 Java 服务到 private domain 在某环境不可达，才实现 `DataAgentRuntimeTransport` 的 BFF 代理版本。BFF 版本必须先证明：

- `X-Qwen-Managed-Lease-Id` 和 `X-Qwen-Managed-Lease-Epoch` 不被剥离；
- BFF 鉴权和 Runtime bearer 可以同时表达，不能用一个 token 冒充两种身份；
- body 和响应保持二进制透明；
- 5xx/IO 重试不会把非幂等 execute 变成第二次物理执行。

没有上述证据前，不把现有通用 `DaemonHttpClient.forwardPost` 直接用于 Runtime execute。

## 8. Warm 接入点和首轮时序

`HostedHarnessConnector.openTurn` 的顺序固定为：

```text
ensureSession()
persist prompt admission
schedule ManagedRuntimeWarmService.warmAsync(harnessSessionId)
submit to Hosted Harness
stream Harness events
```

`warmAsync` 的语义：

- fire-and-observe，不阻塞 submit 或 SSE；
- 连 scope 解析和数据库反查也必须在独立 executor 中执行，不能只把 DataAgent create 异步化；
- 相同 harnessSessionId 重复调用只触发一次 provision；
- 失败写指标和 binding 状态，不立即终止无 Tool Turn；
- 当 Tool Call 真正 acquire 时，Broker 等待同一个 warm future；
- Session close/delete 触发 drain/release，不能让 reaper 与活跃 execute 并发回收。

精确验收时序：

```text
T0 prompt admitted
T1 runtime warm scheduled
T2 Hosted Harness accepted and may start model generation
T3 first model delta
T4 runtime ready
T5 first tool execute
T6 turn completed
```

必须满足 `T1 < T2 <= T3 < T4`，即 Runtime 调度先于模型提交完成，首个模型 delta 不等待 Runtime ready；同时 physical provision = 1、physical execute = 1。

## 9. 实施批次

### R0：网络和镜像探针

产物：

- 专用 Runtime 镜像/entrypoint，固定 qwen 包版本并校验 worker 产物；
- Java `/health` 探活后内部提交 STARTED，定时内部提交 HEARTBEAT；
- entrypoint 使用 `exec` 交付 SIGTERM，worker 完成 owned Runtime 关闭；
- Java 到 private domain 的 prepare 探针；
- lease header、token 和安全组验证记录。

完成门槛：Java 可以主动调用真实 Runtime；若失败，明确是 DNS、VPC、端口、BFF header 还是双重鉴权问题。

执行顺序：

```bash
# 1. 先发布包含 dist/managed-runtime-worker.js 的 qwen-code 不可变版本。

# 2. 将 com.alibaba:qwen-managed-runtime-broker:0.1.2-alpha 发布到产品构建可访问的 Maven 仓库。

# 3. 构建专用 Tool Runtime 镜像；禁止把 QWEN_CODE_VERSION 设为 latest/next/beta。
docker build \
  -f docker/qwen-sandbox/Dockerfile.managed-runtime \
  --build-arg BASE_IMAGE=<dataworks-python-base-image> \
  --build-arg QWEN_CODE_VERSION=<immutable-qwen-version> \
  -t <registry>/qwen-managed-runtime:<image-version> \
  docker/qwen-sandbox

# 4. 将镜像和固定 Broker 配置写入目标环境，并仅对测试 tenant 开启。
```

目标环境至少设置 `enabled=true`、固定 `bind-port`、Broker bearer、`runtime-image` 和 Hosted Harness 可访问的 Broker base URL。先启动单 Java 实例完成 R0/R4；R5 前不允许普通负载均衡把同一 Managed Session 分发给多 Java 实例。

### R1：qwen 远程 owned worker

状态：本地完成。

产物：

- `QWEN_MANAGED_RUNTIME_BOOT`；
- `--boot-env`；
- `0.0.0.0 + fixed port` 严格 schema；
- canonical workspace path 与 qwen workspace hash 的启动前校验；
- 真实子进程启动测试。

完成门槛：环境值消费后被删除，错误 schema 和错误 workspace 身份 fail closed，prepare/control/execute/cancel/release 都带 fencing。

当前证据：真实 bundle 启动 `managed-runtime-worker.js --boot-env` 后，`prepare` 返回 ready；错误 lease 返回 `409 managed_runtime_identity_conflict`。该 E2E 固化为 `npm run test:e2e:managed-runtime-worker-env`。

### R2：产品 scope 和配置

状态：代码完成，待目标环境配置审计。

产物：

- `managed_resource_group_id` migration；
- Hosted binding 反向查询；
- `ManagedHarnessSessionResolver`；
- `ManagedRuntimeBrokerProperties`；
- 默认关闭装配。

完成门槛：Harness 伪造 tenant/workspace/resourceGroup 无效；老 Session 和旧链路行为不变。

当前证据：Java 已从 current `QWEN_HOSTED_HARNESS` binding 反查 scope，产品 project 与 Runtime workspace hash 分离；缺失、非 RUNNING、capability 不匹配和 scope 伪造均 fail closed。

### R3：DataAgent provision 和 warm

状态：R3a、R3b 代码完成；真实环境冷启动、delete 失败和 Java 重启故障注入待验证。

产物：

- `DataAgentRuntimeProvisioner`；
- `ManagedRuntimeWarmService`；
- Prompt submit 前立即异步 warm；
- close/delete 的 drain/release。

完成门槛：15 秒冷启动期间先有模型 delta；无 Tool Turn 不等待 Runtime；重复 warm 只创建一台实例。

当前证据：Java 目标测试验证了 tool-only create 不访问 BFF/MCP/model catalog/profile，Prompt submit 前只投递一次异步 warm，Provisioner 创建 DataAgent、携带 bearer 探测 `/health`、内部提交 STARTED/HEARTBEAT，并返回 fenced lease。Managed Session close 先持久化 Hosted binding 终态，再异步 drain Runtime，因此晚到 warm 在 Java 重启后也会 fail closed；释放路径在 Hosted binding 已终态时可从持久化 DataAgent 身份恢复 tenant/user 并继续删除。DataAgent 删除瞬态失败会持续重试；Java 重启或崩溃后，停止更新的 heartbeat 触发现有 durable reaper，MANAGED_AGENT Runtime 在物理停止后自动标记 DELETED。该 API 使用独立制品 `com.alibaba:qwen-managed-runtime-broker:0.1.2-alpha`。真实 DataAgent 冷启动时序和故障注入尚未验证。

### R4：Runtime transport 和 Broker endpoint

状态：单进程装配完成，Hosted Harness 到真实 Broker/Runtime 的网络 E2E 待完成。

产物：

- 内嵌 `RuntimeBrokerService`；
- Harness 可访问的内网 Broker endpoint；
- direct `HttpRuntimeTransport` 或通过 R0 证明后的 BFF transport；
- token、lease 和 epoch 全链路。

完成门槛：Tool Turn 的 physical execute = 1；丢失一次 execute 响应后查询原 execution，不重新产生副作用。

R4 的进程内 Broker 只用于单实例 E2E，不进入多副本生产灰度。Hosted Harness 到 Broker 的服务发现必须固定到该测试实例；R5c、R5d、R5e 的生产门禁全部通过后，才允许经过普通负载均衡访问多实例 Java 服务。

2026-09-18 本地跨进程联合 E2E 已通过四个场景：

- 默认冷启动：首个模型事件 374 ms，Runtime ready 15.648 s，Tool 在同一 Turn 内等待并继续完成；注入一次 execute 响应丢失后通过 status 恢复，physical execute = 1；
- Runtime ready 前取消：首个模型事件 492 ms，取消发生在 496 ms，Runtime ready 16.896 s，physical execute = 0；
- physical execute 后取消：执行开始 2.273 s，取消发生在 2.324 s，physical execute = 1、physical cancel = 1，Runtime 进程树退出且没有迟到文件副作用；
- 双 Session：logical session = 2，共享同一个物理 Runtime provision，physical provision = 1、acquire = 2、execute = 2，Session 结果互不串线。

以上证据证明本地真实子进程链路成立，但 Broker 仍是测试进程内 fixture，不能替代产品 Java 内网入口、真实 DataAgent 网络和 durable 多实例验收。

### R5：durable Broker

状态：R5a、R5b 已落代码；R5c 的产品表/Repository/DataAgent 幂等与 fencing 已落代码，真实 ACS 重启注入待验收；R5d 已完成同进程双 Spring Context 的完整生命周期竞争，以及两个独立 JVM 通过 H2 TCP 共享执行账本的 UNKNOWN CAS 竞争；R5e 已完成 UNKNOWN 核心门禁与 Java 显式处置 API。真实 MySQL、普通负载均衡、owner crash 和网络故障注入仍是上线门禁。

#### R5a：Repository SPI 与单实例行为等价（代码完成）

qwen `runtime-broker`：

- 新增 `RuntimeBindingRepository`、`RuntimeSessionRepository`、`ToolExecutionRepository` 和 immutable record/spec/mutation/claim 类型；
- 把当前 Map 封装为三个 in-memory 默认实现；
- `RuntimeBrokerService` 只通过 SPI 判断身份和状态，本地 Map 仅保留 in-flight future；
- 增加可注入的 `brokerOwnerId`、operation lease 和 dispatch lease；in-memory Repository 可注入 `Clock` 以验证 claim 过期；
- 制品已升级为不可变坐标 `0.1.2-alpha`，产品依赖已同步，禁止覆盖已发布坐标。

验收：现有 Runtime Broker 测试全部不变通过；同一 Service 的 duplicate warm/acquire/execute/release 行为与改造前一致。

#### R5b：durable execution 与响应丢失恢复（代码完成）

qwen `runtime-broker`：

- `RuntimeTransport` 增加 V2 status；
- create/get/cancel/release 改读 execution Repository；
- 实现 dispatch claim、过期接管、cancel intent 和 generation fencing；
- 两个 `RuntimeBrokerService` 共享同一 Repository 和同一 fake Runtime，并发提交相同 idempotencyKey，只允许一个 executionCallId 和一次物理执行；
- 注入“Runtime 已执行但 Java 响应丢失”，接管者必须先 status 并返回原结果，physical execute 仍为 1。

验收：跨两个 Service 实例的并发单测稳定重复 100 次，物理 execute 计数始终为 1；旧 owner 的迟到结果不能覆盖接管后的终态。

#### R5c：durable binding、Session 和 DataAgent 幂等 provision（部分完成）

产品 Java：

- [x] 增加 `provisionRequestId` 及 DataAgent 唯一键/查询能力；
- [x] 建立三张表、DO、Mapper XML、Repository 实现和 H2/MySQL migration；
- [x] Broker 以 durable binding/session/execution Repository 为身份、generation 和终态权威；
- [x] 支持 PROVISIONING 接管所需的稳定 seed、READY health 恢复、drain/release retry；
- [x] Java shutdown 停止本进程 heartbeat/future，不主动删除共享 Runtime；
- [x] Runtime token 通过产品加密组件落库，不允许明文 fallback；
- [x] Managed Runtime 固定 `ACS_SANDBOX` 幂等底座，并校验实际 handle runtime type 防止路由静默回退；
- [ ] 真实 ACS 环境在 create 返回前、instanceId 落库后、READY 后三个崩溃点的故障注入。

验收：Java 在 create 返回前、instanceId 落库后、READY 后三个点分别重启，均不产生第二个 DataAgent 记录或 ACS sandbox；旧 generation 无法通过 health/execute/release fencing。本项只能由真实 ACS 或供应方官方幂等契约验收，不能用 Mockito 单测替代。

#### R5d：产品装配和双实例数据库竞争（部分完成）

- [x] `ManagedRuntimeBrokerConfiguration` 注入 MyBatis Repository 和稳定的实例 owner ID；
- [x] 默认使用 durable Repository；in-memory 只用于 qwen SDK 单测和单进程测试；
- [x] 两个独立 `GenericApplicationContext`、两套 MyBatis Repository、两个 Broker owner 连接同一 H2 库；
- [x] 覆盖并发 warm、跨 owner acquire、相同 idempotencyKey create、跨 owner cancel、release 和并发 drain；
- [x] 验证 physical provision = 1、physical execute = 1、physical cancel = 1、physical drain = 1、physical release = 1；
- [x] 两个独立 JVM 通过 H2 TCP 连接同一执行账本，并在同步起跑后提交相反 UNKNOWN 决策，数据库 CAS 只允许一个决定落库；
- [x] 提供受 `dedicated-test-schema` 显式确认保护的 MySQL 双 JVM UNKNOWN 竞争用例，凭据不进入命令行，测试只删除本次 UUID 创建的记录；
- [ ] 两个独立 JVM 连接同一 MySQL 测试库复验；
- [ ] Hosted Harness 通过普通负载均衡交替访问两个测试 Java 实例。

验收：同一 Session 的请求逐次落到不同 Java，Tool Turn 完成且 physical provision = 1、physical execute = 1、physical release = 1。

#### R5e：重启与 UNKNOWN 门禁（部分完成）

- [x] 同 generation 的 execute 响应丢失通过 Runtime status 接管，physical execute 保持 1；
- [x] binding/generation 丢失时将非终态 execution CAS 持久化为 UNKNOWN；
- [x] UNKNOWN 清除 dispatch owner/lease，后续 owner 不能再次 claim 或 execute；
- [x] 提供 Java 上层恢复 API，只允许“确认未执行后重试”或“接受未知并终止”；相同决定幂等，不同决定冲突；
- [x] 产品 console 管控面提供受 region、源租户、operator allowlist 保护的恢复入口，并记录不含 reason 原文的审计日志；
- [x] 两个独立 Spring/MyBatis Context 并发提交相反 UNKNOWN 决策时，数据库 CAS 只允许一个决定落库，另一请求稳定返回冲突，且 physical execute 保持 0；
- [x] 两个独立 JVM 通过共享 H2 TCP 数据库提交相反 UNKNOWN 决策时，一个进程成功、另一个稳定返回 `runtime_broker_resolution_conflict`；
- [ ] 注入真实 Java owner crash、数据库短暂不可用和 Runtime 短暂不可达；
- [ ] 在两个 JVM + MySQL 下验证 claim 过期接管、旧 owner 迟到写入和 UNKNOWN 处置竞争；

验收：所有故障场景都能明确归类为完成、可接管或 UNKNOWN；不存在自动投递到新 Runtime 的模糊路径。

最终产物：

- Runtime binding repository；
- Runtime Session repository；
- execution ledger repository；
- qwen Runtime Broker Repository SPI 与 in-memory 默认实现；
- 产品 Java MyBatis Repository 实现；
- 数据库 CAS 和有期限 ownership claim；首版不再额外引入独立分布式锁服务；
- Java 重启恢复和旧 generation fencing。

完成门槛：两台 Java 实例并发处理同一 idempotencyKey/executionCallId 时，物理 Tool 仍只执行一次；任一 owner 崩溃后能从原 Runtime 查询并恢复原 execution，或明确进入 UNKNOWN，绝不向新 generation 自动重放。

#### R5 代码改动边界

qwen-code：

```text
packages/sdk-java/runtime-broker/src/main/java/.../
  RuntimeBrokerService.java
  RuntimeTransport.java
  HttpRuntimeTransport.java
  RuntimeBindingRepository.java
  RuntimeSessionRepository.java
  ToolExecutionRepository.java
  InMemoryRuntimeBindingRepository.java
  InMemoryRuntimeSessionRepository.java
  InMemoryToolExecutionRepository.java
  *Record.java / *Spec.java / *Mutation.java / *Claim.java

packages/sdk-java/runtime-broker/src/test/java/.../
  Repository contract tests
  two-broker concurrency tests
  response-loss and owner-takeover tests
```

DataWorks Java：

```text
copilot/agent/src/main/java/.../repo/managed/
  runtime binding/session/execution entity、DO、mapper、repository

copilot/agent/src/main/java/.../infra/managed/
  MyBatis Repository 实现
  DataAgentRuntimeProvisioner durable takeover
  ManagedRuntimeBrokerConfiguration durable 装配

copilot/agent/src/main/resources/mybatis/managed/mapper/
  三个 Mapper XML

copilot/agent/src/main/resources/h2-init/table_init/
  三张测试表

数据库 migration
  三张生产表
  DataAgent provision_request_id 字段和唯一键
```

每个批次完成后执行：

```bash
# qwen Repository/Transport/Service
mvn -f packages/sdk-java/runtime-broker/pom.xml test
mvn -f packages/sdk-java/runtime-broker/pom.xml checkstyle:check

# 产品 Java，具体类名随实现补入，不运行整库无关测试
mvn -s /tmp/codex-lsp-maven-settings.xml test \
  -pl copilot/agent -am \
  -Dtest='ManagedRuntime*Test,DataAgentRuntimeProvisionerTest,*Managed*Repository*Test' \
  -DfailIfNoTests=false \
  -Dsurefire.failIfNoSpecifiedTests=false
```

R5d 已增加双 Spring Context + 独立 MyBatis Repository 的完整生命周期 H2 集成测试，并增加两个独立 JVM 通过 H2 TCP 竞争同一 UNKNOWN 记录的 CAS 测试。后者证明处置正确性不依赖同进程锁或共享内存，但尚未覆盖 MySQL 方言、连接池/事务行为、普通负载均衡和完整 Tool 生命周期；上线前仍必须补两个独立 JVM + MySQL + 负载均衡验证，不能把当前 H2 结果当成完整多实例生产证据。

### R6：联合真实 E2E 和灰度

覆盖：

1. 冷 Runtime 首 delta 早于 ready；
2. 无 Tool Turn 在 Runtime 未 ready 时完成；
3. Tool Turn 等待原 binding；
4. cancel before ready，physical execute = 0；
5. cancel during execute，physical cancel = 1；
6. Java、Harness、Runtime 分别重启；
7. 两租户并发无 workspace、event、token 串扰；
8. Legacy 和 Managed 同时运行；
9. Runtime provision 失败时无 Tool Turn 正常，Tool Turn 稳定失败且不回落；
10. delete/close 后 Runtime 最终释放。

完成门槛：默认关闭构建通过，真实进程 E2E 全绿，具备 tenant allowlist、指标、告警和一键关闭开关。

## 10. 测试矩阵

| 层级          | 必测内容                                                                                |
| ------------- | --------------------------------------------------------------------------------------- |
| qwen 单测     | env boot schema、secret 删除、listener、workspace hash、lease/epoch、错误响应           |
| qwen 进程测试 | 固定端口 worker、prepare、execute、cancel、release                                      |
| Java 单测     | scope 解析、资源组冲突、provision 状态机、lifecycle heartbeat、重复 warm、close/release |
| Java DB 集成  | reverse lookup、binding/Session/execution 唯一键、CAS、claim 和 fencing                 |
| 网络探针      | Java Pod 到 Runtime domain、DNS/VPC/auth/header                                         |
| 联合 E2E      | Hosted Harness + Broker + 冷 DataAgent Runtime + Fake Model                             |
| 故障注入      | submit/execute 响应丢失、Java/Harness/Runtime 重启、双实例竞争                          |

当前 Java 验证命令：

```bash
mvn -s /tmp/codex-lsp-maven-settings.xml test \
  -pl copilot/agent -am \
  -Dtest='DataAgentInstanceServiceImplTest,DataAgentRuntimeProvisionerTest,ManagedHarnessSessionResolverTest,ManagedSessionLifecycleServiceImplTest,ManagedRuntimeBrokerPropertiesTest,ManagedRuntimeRepositoryIntegrationTest,DataAgentInstanceMapperIntegrationTest,ManagedRuntimeRecoveryCommandServiceImplTest' \
  -Dsurefire.failIfNoSpecifiedTests=false \
  -Djacoco.skip=true
```

MySQL 双 JVM UNKNOWN 竞争必须只对已完成 migration 的专用测试 schema 运行。数据库连接参数由
CI secret/environment 注入，不写入仓库或命令行；执行入口为：

```bash
MANAGED_RUNTIME_MYSQL_TEST_SCHEMA_ACK=dedicated-test-schema \
MANAGED_RUNTIME_MYSQL_JDBC_URL="$MANAGED_RUNTIME_MYSQL_JDBC_URL" \
MANAGED_RUNTIME_MYSQL_USERNAME="$MANAGED_RUNTIME_MYSQL_USERNAME" \
MANAGED_RUNTIME_MYSQL_PASSWORD="$MANAGED_RUNTIME_MYSQL_PASSWORD" \
mvn -s /tmp/codex-lsp-maven-settings.xml test \
  -pl copilot/agent -am \
  -Dtest='ManagedRuntimeRepositoryIntegrationTest#twoJvmBrokers_shouldResolveUnknownExecutionExactlyOnceOnMysql' \
  -Dsurefire.failIfNoSpecifiedTests=false \
  -Djacoco.skip=true
```

不设置 ACK 时该用例必须 skip，不能隐式连接开发、预发或生产库。该入口只验证 MySQL 方言、
连接池/事务边界和 UNKNOWN CAS；claim 过期接管、旧 owner 迟到写入、普通负载均衡和真实 Runtime
不可达仍由 R5d/R5e 的环境故障注入验收。

2026-09-18 最新本地结果：qwen Runtime Broker 51 tests，且 Checkstyle 0 violations；Java Managed Runtime/DataAgent/Repository/Mapper/Recovery 相同集合共 331 tests，其中包含 7 个 durable Repository H2 集成测试和 3 个 UNKNOWN 管控面恢复测试；新增测试启动两个独立 JVM，通过 H2 TCP 共享同一执行账本并同步提交相反 UNKNOWN 决策，验证一个成功、一个稳定冲突。Managed Hosted Runtime 四个跨进程 E2E 场景分别通过。构建使用与 `origin/main` 一致的 4096 MB Node heap，`npm run build && npm run bundle` 成功。以上只能证明本地子进程、跨 JVM 数据库 CAS 与 H2 集成边界，不替代 R0、R5c 真实 ACS 崩溃注入、R5d/R5e MySQL/负载均衡故障注入和产品内网联合验收。

## 11. 指标和告警

至少输出：

```text
managed_runtime_warm_started_total
managed_runtime_warm_reused_total
managed_runtime_provision_ms
managed_runtime_ready_ms
managed_runtime_warm_failed_total{reason}
managed_runtime_acquire_wait_ms
managed_runtime_execute_total{state}
managed_runtime_physical_execute_total
managed_runtime_duplicate_prevented_total
managed_runtime_generation_mismatch_total
managed_runtime_release_total{state}
```

Trace 至少关联：

```text
publicSessionId
publicTurnId
harnessSessionId
runtimeSessionId
executionCallId
dataAgentInstanceId
leaseId hash
leaseEpoch
```

日志和公共响应不得输出 runtime bearer、Broker bearer、BFF token 或 boot document 全文。

## 12. 灰度和回滚

灰度顺序：

1. 开发环境单 tenant；
2. 预发 allowlist，仅无副作用 Tool；
3. 预发开启 shell/file Tool，注入响应丢失和重启；
4. 小流量生产，Session 级隔离；
5. durable Broker 和容量证据稳定后再评估 workspace 级共享。

回滚只关闭新 Session admission 和 Runtime warm：

- 既有 Managed Session 继续按原 binding 服务或明确进入 recovery blocked；
- 不把既有 Managed Session 改走 Legacy；
- 已创建的 Runtime 由 reaper/drain 回收；
- Legacy 路径不依赖 Broker 开关。

## 13. 当前最先执行的四件事

1. 完成 R0：发布 `0.1.2-alpha`，构建不可变的 Managed Runtime 镜像，在真实 ACS DataAgent 中验证 Java 到 private domain 的 DNS、VPC、端口、bearer、lease headers 和 STARTED/HEARTBEAT。
2. 完成 R5c 崩溃注入：在 ACS create 返回前、DataAgent instanceId 落库后、READY 后分别 kill Java owner，核对 DataAgent 记录数、ACS sandbox 数和 generation，三者都必须保持唯一。
3. 完成 R5d/R5e 真实分布式验收：启动两个独立 JVM 连接同一 MySQL，经普通负载均衡交替请求，注入 owner crash、DB 短暂不可用和 Runtime 不可达，验证 claim 接管、旧 owner fencing、UNKNOWN 与显式处置竞争。
4. 完成 R4/R6 联合 E2E：Hosted Harness 使用 Java Broker endpoint，验证 `first model delta < runtime ready`、真实 Tool Turn、cancel、delete 失败、owner 重启和 UNKNOWN 门禁。

上线执行顺序固定为：数据库 migration → 发布 Broker 制品 → 发布 Managed Runtime 镜像 → Java `enabled=false` 部署 → 运行网络/崩溃探针 → 单 tenant allowlist 开启 → 双 Java 实例故障注入 → 小流量灰度。任一门禁失败都只关闭新 Session admission/warm，不把活动 Managed Session 降级到 Legacy。

在 R0、R3b 和 R4 通过前，不接真实用户 Tool 流量；在 R5c/R5d/R5e 的真实底座与双实例验收通过前，不经普通负载均衡把 Hosted Harness 流量分发到多个 Java 实例。
