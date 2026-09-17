# Managed Agent Java 自有 Runtime 生命周期执行方案

状态：执行中（P5a、P5b 已完成，下一步 P5c）

更新日期：2026-09-18

上游方案：[Managed Agent Hosted Runtime 可执行技术方案](./2026-09-17-managed-agent-hosted-runtime-execution.md)

## 1. 目标

P5 将本地 Tool Runtime 的物理生命周期从测试脚本和 Hosted Harness 中移到 Java Runtime Broker：

```text
Java Runtime Broker
  -> 创建独占 generation 目录和 boot config
  -> 启动 managed-runtime-worker 独立进程
  -> 从独立 ready record 获得并校验 endpoint
  -> 主动执行 health / acquire / execute / cancel / release
  -> 空闲 drain 后终止完整进程树并清理 generation 目录
```

完成后，Hosted Harness 仍只访问 Java Broker，不持有 Runtime endpoint、token、lease 或进程句柄。Runtime 不主动连接 Java；除启动阶段写入一次 ready record 外，后续通信全部由 Java 通过 HTTP 发起。

本阶段只实现 Local Process Provisioner。Kubernetes、数据库恢复、跨机器迁移和 Windows 支持不进入 P5。

## 2. P5 开工时差距

P5 开工时已经具备 Hosted Harness、Java Broker、Runtime HTTP transport、执行幂等和真实进程 E2E，但物理 Runtime 仍由 `scripts/run-managed-hosted-runtime-e2e.ts` 手工启动并通过测试控制接口注入 endpoint。

P5 必须补齐的差距：

1. `managed-runtime-worker` 只接受 Node IPC boot message，Java 无法使用稳定的独立进程协议启动它。
2. `RuntimeProvisioner` 只接收 `RuntimeScope`。当 `isolationClass=session` 时，不包含 Harness Session 隔离键，真实 Provisioner 可能错误复用进程。
3. Broker 只缓存 `CompletableFuture<RuntimeLease>`，没有物理 binding 状态、Session 引用计数和 idle deadline。
4. Provisioner 没有 drain、release、health 和 shutdown 契约。
5. Runtime crash、启动超时、ready 损坏和 Java shutdown 还没有真实进程验收。

## 3. 冻结的进程启动协议

### 3.1 命令行

Java 使用绝对路径启动与 Harness 同版本的 worker 和 CLI bundle：

```text
node /absolute/managed-runtime-worker.js \
  --boot-config /owned/generation/boot.json \
  --ready-record /owned/generation/ready.json
```

约束：

- 两个路径都必须是绝对路径，并位于 Java 为当前 generation 创建的独占目录中。
- boot config 最大 32 KiB；ready record 最大 8 KiB。
- stdout/stderr 只承载日志并由 Java 持续消费，不得承载握手协议。
- Node IPC 模式继续供现有 `LocalProcessRuntimeActivator` 使用；IPC 与文件模式互斥，不能同时启用。
- 文件模式不接收模型、Gateway、IDE 或 Broker 环境变量，只继承明确 allowlist。

### 3.2 Boot config v1

```json
{
  "type": "boot",
  "version": 1,
  "runtimeInstanceId": "runtime UUID",
  "gatewayIncarnation": "Java Broker incarnation UUID",
  "leaseId": "lease UUID",
  "epoch": 1,
  "tenantId": "authoritative tenant",
  "workspaceId": "authoritative workspace",
  "workspaceCwd": "/canonical/workspace",
  "token": "random 256-bit bearer",
  "outputRoot": "/owned/generation/output",
  "cliEntry": "/absolute/cli.js"
}
```

`gatewayIncarnation` 在 v1 中表示 Runtime owner incarnation；Java 模式填写 Broker incarnation，保留字段名是为了与现有 IPC worker 契约兼容。boot config 包含 Runtime token，Java 必须使用 owner-only 权限创建，worker 读取后不得复制到日志或 ready record。

Java 在 ready record 校验和首次 health 均成功后立即删除 boot config；启动失败路径由 generation cleanup 删除。磁盘上不能保留已经进入 READY 状态的明文 token 文件。

### 3.3 Ready record v1

```json
{
  "type": "ready",
  "version": 1,
  "runtimeInstanceId": "same runtime UUID",
  "gatewayIncarnation": "same owner incarnation UUID",
  "leaseId": "same lease UUID",
  "epoch": 1,
  "tenantId": "same tenant",
  "workspaceId": "same workspace",
  "workspaceCwd": "/same/canonical/workspace",
  "url": "http://127.0.0.1:4183"
}
```

worker 先写同目录临时文件，再原子 rename 为 `ready.json`。Java 只接受普通文件和完整 JSON，并逐字段匹配 boot config；endpoint 必须是无 user-info、path、query、fragment 的 `http://127.0.0.1:<port>` origin。任何缺字段、额外字段、身份不匹配、超长内容或非法 endpoint 都进入 `FAILED`，随后终止 worker 进程树。

## 4. Java 组件与接口

### 4.1 RuntimeProvisionRequest

新增不可变类型，替代 Provisioner 只接收 `RuntimeScope`：

```java
final class RuntimeProvisionRequest {
    RuntimeScope scope;
    String isolationKey; // workspace: null; session: harnessSessionId
}
```

其 equality/hash 必须覆盖完整 `RuntimeScope` 和 `isolationKey`。Broker 是唯一构造者：

- `workspace` 隔离：`isolationKey = null`；
- `session` 隔离：`isolationKey = harnessSessionId`。

这样 Local Process 和后续 Kubernetes Provisioner 使用同一 reuse key，不会把两个 Session-isolated Harness Session 放到同一 Runtime。

### 4.2 RuntimeProvisioner

保持一个抽象方法，以免破坏现有 lambda/测试替身；生命周期方法提供默认 no-op：

```java
interface RuntimeProvisioner extends AutoCloseable {
    CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request);
    default CompletionStage<Void> drain(
            RuntimeProvisionRequest request, RuntimeLease lease) { ... }
    default CompletionStage<Void> release(
            RuntimeProvisionRequest request, RuntimeLease lease) { ... }
    default CompletionStage<Boolean> health(RuntimeLease lease) { ... }
    default void close() { }
}
```

`StaticRuntimeProvisioner` 继续用于单测和外部预置 Runtime；`LocalProcessRuntimeProvisioner` 实现全部生命周期方法。

首版默认值由 Java 构造参数注入，产品默认固定为：最大 4 个本地 Runtime、启动超时 60 秒、health 请求超时 2 秒、health 新鲜度 30 秒、空闲回收 5 分钟、SIGTERM 宽限 5 秒、强制终止宽限 5 秒。单测使用更短时长，不新增环境变量配置面。

### 4.3 RuntimeBinding

Broker 将当前 `Map<BindingKey, CompletableFuture<RuntimeLease>>` 收敛为显式 binding 对象：

```text
ABSENT -> PROVISIONING -> READY -> DRAINING -> RELEASED
                       `-> FAILED
```

每个 binding 至少保存：

- `RuntimeProvisionRequest request`
- `CompletableFuture<RuntimeLease> ready`
- `state`
- `activeSessions`
- `idleDeadline`
- `drainFuture`

规则：

1. 相同 request 的并发 `warm/acquire` 共享一个 provisioning future。
2. `warm()` 不增加 `activeSessions`；Runtime ready 后如果仍为 0，立即设置 idle deadline，避免无 Tool Turn 永久占用进程。
3. 首个 logical Session acquire 在派发 Runtime `/prepare` 前增加引用并取消 idle timer；失败时回滚引用。
4. logical Session release 成功后减少引用；降到 0 时重新设置 idle deadline。
5. idle deadline 到达后先原子切到 `DRAINING` 并从可分配集合移除，再调用 `provisioner.drain()` 和 `release()`。
6. `DRAINING` 不接受新 acquire。调用方等待该 generation 完成释放后创建下一 epoch，不把请求发给旧 lease。
7. Runtime crash 或 health failure 将 binding 置为 `FAILED`。已经可能派发的 execution 只能失败或进入后续 P6 的 `recovery_blocked`，不得自动换 Runtime 重放。

## 5. LocalProcessRuntimeProvisioner

### 5.1 所有权

Provisioner 以 `RuntimeProvisionRequest` 为 key 管理 generation，并持有：

- `Process` 和根 `ProcessHandle`；
- generation 目录、boot config、ready record、output root；
- runtimeInstanceId、leaseId、epoch、token、Broker incarnation；
- bounded stdout/stderr 尾部日志；
- start future、exit future 和单例 stop future；
- health failure count 和最后成功时间。

相同 request 的并发 provision 只启动一次。旧 generation 完成 `RELEASED/FAILED` 后，同一 request 的下一次启动使用严格递增 epoch。

### 5.2 启动

启动顺序固定为：

1. 校验平台、绝对路径、canonical workspace 和容量。
2. 在 Broker state directory 下创建 owner-only generation 目录。
3. 生成 runtimeInstanceId、leaseId、token 和 epoch。
4. 原子写入 owner-only boot config。
5. 使用清洗后的 allowlist 环境启动 worker，并立即并行消费 stdout/stderr。
6. 在 startup timeout 内竞争：合法 ready record、进程退出、Broker shutdown、超时。
7. ready 合法后使用 bearer token 请求 `/health`；只有 health 成功才发布 `RuntimeLease`。

任一步失败都必须调用同一个幂等 stop 流程，证明进程树退出后再删除 generation 目录。

### 5.3 Health

- Provisioner 发布 lease 前执行一次强制 health。
- READY binding 在新 logical Session acquire 前，如果距上次 health 超过阈值，则由 Broker 调用 `health()`。
- health 请求 `GET /health`，携带 Runtime bearer 和 lease fencing header；只接受超时内的 HTTP 200 与 `{ "status": "ok" }`。
- 连续失败直接使 binding 进入 `FAILED` 并 drain，不在同一 execution 内切换 generation。

### 5.4 Drain、release 与 shutdown

- `drain()` 关闭新分配，不中断已在途的 execution。
- 每个 logical Session 先由 Broker 通过 `RuntimeTransport.release()` 完成 Runtime v2 release；activeSessions 降到 0 且 idle deadline 到达后，Provisioner 的 physical `release()` 才发送 SIGTERM/`Process.destroy()`。
- Java 使用 `ProcessHandle.descendants()` 反复快照并按后代优先终止；宽限期后升级为 `destroyForcibly()`，最后等待根进程与所有已观察后代退出。
- 只有证明进程树退出后才删除 generation 目录并进入 `RELEASED`。
- `LocalProcessRuntimeProvisioner.close()` 拒绝新 provision，并并发终止所有 generation；产品服务必须在 shutdown hook 中调用 Broker close。
- Windows 在完成独立进程树验收前由构造器返回明确 unsupported 错误，不进入支持矩阵。

## 6. Broker 关闭语义

`RuntimeBrokerService` 增加幂等 `close()`：

1. 拒绝新的 warm/acquire/createExecution；
2. 对未结算 execution 发出 cancel intent，并等待有界时间；
3. release 已无 active execution 的 logical Session；
4. 将所有 binding 切到 `DRAINING`；
5. 调用 Provisioner close 并等待物理进程树退出。

如果关闭期间无法证明某个已派发 execution 的终态，当前内存版记录明确失败并输出 executionCallId；P6 引入持久化后映射为 `recovery_blocked`。关闭不能通过启动新 Runtime 来“补偿”未确认执行。

## 7. 实施切片与提交边界

### P5a：独立 worker boot 协议（已完成）

改动：

- `packages/cli/src/serve/managed-runtime-worker-entry.ts`
- 新增纯解析/文件握手模块及其单测
- 保持现有 LocalProcessRuntimeActivator IPC 契约，并用回归测试证明兼容

验收：IPC 模式无回归；合法文件 boot 能启动真实 worker；boot 超长、字段不符、ready 写入失败均 fail closed；ready record 不含 token。

2026-09-18 证据：新增精确字段、大小、owner-only 权限、loopback endpoint 和身份匹配校验；超长 boot config 的真实 worker 进程以 code 1 退出且不生成 ready record；四个 Java/Harness/Runtime E2E 均已改走文件握手并通过，最终产物复验的正常冷启动首模型事件 272 ms、Runtime ready 15,781 ms、physical execute 1。

提交：`feat(cli): add standalone managed runtime boot protocol`

### P5b：Java LocalProcessRuntimeProvisioner（已完成）

改动：

- 新增 `RuntimeProvisionRequest`
- 扩展 `RuntimeProvisioner` 默认生命周期方法
- 新增 `LocalProcessRuntimeProvisioner`
- 新增 `OwnedRuntimeProcess` 进程树终止器
- `RuntimeBrokerService` 改用显式 RuntimeBinding

验收：并发 provision 单启动；workspace 复用；session 隔离；epoch 递增；ready 后 health；无 Tool warm 可在 idle deadline 后回收。

2026-09-18 证据：Java Broker 已使用显式 `RuntimeBinding` 管理并发复用、Session 引用、单飞 health 和 idle drain；Local Process Provisioner 已实现容量限制、文件握手、主动 health、epoch fencing、进程树终止和 generation 清理。`mvn clean test checkstyle:check` 共 21 个测试通过；CLI worker boot 单测 5 个通过，CLI typecheck 通过。

提交：`feat(java): own local runtime lifecycle`

### P5c：故障与真实进程 E2E

改动：

- E2E 不再手工 fork Runtime，也不再调用 `/fixture/runtime-ready`
- Java fixture 直接构造 LocalProcessRuntimeProvisioner
- CI 增加 crash、timeout、invalid-ready、shutdown 场景

验收：

1. 正常冷启动仍满足首模型事件早于 Runtime ready。
2. startup timeout 后 worker 根进程和后代均退出，下一次启动 epoch 递增。
3. invalid ready 不发布 lease、不执行 Tool、不留下 generation 目录。
4. ready 后 Runtime crash 使原 execution 明确失败，不创建替代 Runtime 重放。
5. Java shutdown 后 worker 与后代均退出，取消后无延迟写入。

提交：`test(managed): verify java-owned runtime lifecycle`

## 8. 可执行测试矩阵

| 场景                         | 必须断言                                                           |
| ---------------------------- | ------------------------------------------------------------------ |
| concurrent warm + acquire    | physical start = 1；同一 lease/epoch                               |
| workspace 两 Session         | physical start = 1；logical acquire = 2；事件与 Tool Result 不串流 |
| session isolation 两 Session | physical start = 2；runtimeInstanceId 不同                         |
| 无 Tool Turn                 | TTFT 不等 Runtime；idle deadline 后进程退出                        |
| startup timeout              | provision future 失败；完整进程树退出；目录清理                    |
| invalid ready                | lease 不发布；稳定错误码；进程退出                                 |
| crash after ready            | health/operation 失败；同 execution 不重放                         |
| cancel after execute         | physical cancel = 1；工具根进程和后代退出；无迟到写入              |
| last Session release         | READY -> DRAINING -> RELEASED；新 acquire 使用更高 epoch           |
| Java close                   | 拒绝新请求；全部 Runtime 进程树退出                                |

每个真实进程用例输出：`runtime_start_ms`、`runtime_health_ms`、`runtime_instance_id`、`lease_epoch`、`physical_start_count`、`physical_stop_count` 和仍存活 PID 列表。CI 只允许仍存活 PID 列表为空时通过。

## 9. 稳定错误码

| 错误码                                | retryable | 含义                                  |
| ------------------------------------- | --------- | ------------------------------------- |
| `runtime_broker_platform_unsupported` | false     | 当前平台没有通过进程树验收            |
| `runtime_broker_capacity_exhausted`   | true      | 没有可复用或可回收的本地 Runtime 容量 |
| `runtime_broker_start_timeout`        | true      | worker 未在期限内发布合法 ready       |
| `runtime_broker_invalid_ready`        | false     | ready record 损坏或身份不匹配         |
| `runtime_broker_health_failed`        | true      | ready endpoint 未通过主动 health      |
| `runtime_broker_process_exited`       | true      | worker 在预期外退出                   |
| `runtime_broker_release_failed`       | true      | 无法证明进程树已退出或目录已清理      |
| `runtime_broker_closed`               | false     | Broker 已进入 shutdown                |

错误响应不得包含 token、boot config 内容、完整环境变量或任意 Runtime 响应正文。

## 10. 不在 P5 的内容

- 不实现 Kubernetes Provisioner；但 `RuntimeProvisionRequest` 和生命周期接口必须可复用。
- 不实现数据库 Repository 和 Java 重启恢复；属于 P6。
- 不改变公共 Agent API；P5 只改变 Java Broker 到 Runtime 的内部实现。
- 不迁移 MCP、Hooks、Channels 或定时任务。
- 不让 Harness 直接启动、发现或回退到本地 Runtime。
- 不宣称 Windows 支持。

## 11. 执行与发布顺序

严格按 P5a -> P5b -> P5c 执行。P5a 合入前不写 Java ProcessBuilder；P5b 的单测和假 worker 全绿前不改真实 E2E；五类故障 E2E 未闭环前，不进入 Kubernetes 或 P6 持久化。

当前只执行 P5c，顺序固定为：

1. Java E2E fixture 改为直接构造 `LocalProcessRuntimeProvisioner`，删除 Runtime endpoint 测试注入。
2. 正常链路证明模型首事件不等待 Runtime ready，并记录启动、health 和物理进程计数。
3. 依次加入 startup timeout、invalid ready、ready 后 crash、Broker shutdown；每类故障先证明进程和目录收敛，再检查错误码。
4. 最后运行 Java Broker 全量测试、CLI build/typecheck、Managed Agent 四条真实 E2E，并做两轮 clean diff 审计。
5. P5c 全绿后才允许产品 Java 服务接入构造参数；灰度期保留 Static Provisioner 回退，但单次 execution 禁止跨 generation 自动重放。
