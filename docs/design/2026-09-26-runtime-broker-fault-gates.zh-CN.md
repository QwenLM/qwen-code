# Runtime Broker 故障门禁

[English](2026-09-26-runtime-broker-fault-gates.md) | [简体中文](2026-09-26-runtime-broker-fault-gates.zh-CN.md)

状态：以测试形式实现于 `packages/sdk-java/runtime-broker`；没有修改生产代码

相关：#12748（FG1–FG4）、#12380 的 Stage F，以及门禁所检验的设计：
[进程收养](2026-09-23-managed-runtime-process-adoption.zh-CN.md)、
[绑定对账](2026-09-24-runtime-binding-reconciliation.zh-CN.md)、
[工具契约](2026-09-24-managed-runtime-tool-contract.zh-CN.md)，以及 FG5 所检验的
[managed context 信封](2026-09-25-managed-context-envelope.zh-CN.md)、
[managed context worker](2026-09-26-managed-context-worker.zh-CN.md)与
[Workspace 执行](2026-09-26-managed-workspace-execution.zh-CN.md)。

## 1. 问题

#12380 的 Stage F 要求每项已启用的能力都通过 ACK 丢失、进程崩溃、取消和存储故障测试。Broker ↔ Runtime 工具链路（收养与验证、v2 execute/status/cancel 传输、worker 处理器、租约 fence、`UNKNOWN` 对账）此前只在单个进程里、针对假 transport 和内存仓库测试过，没有任何测试证明真实进程死亡、真实响应丢失时这些规则依然成立。

W0c 上下文安装也有同样的缺口。Broker 的 managed-context/1 链路（boot v2、attestation v3、对无法证明的启动做持久阻断，以及带回执校验的安装与激活；#12730 与 #12754）只针对假 provisioner、测试内的对端和 mock 的 transport 测试过，worker 的安装也只在单个进程内测试过。#12748 把这些故障推迟到 #12730 合入之后；FG5 覆盖它们。

## 2. 范围

范围内：#12748 中针对工具链路的 FG1–FG4 门禁，以及针对 W0c 上下文安装的 FG5 门禁，运行在真实服务、真实打包的 worker、真实 HTTP、真实数据库和真实进程死亡之上。

范围外：Hosted Harness 的会话与 SSE 门禁、输出捕获与投递门禁（等 O1b–O3 之后）、managed agent server 在 W0c-3 中的存储所有权行与授权复核（由 `WorkspaceRuntimeTest` 单元测试覆盖）、Kubernetes 供给，以及 Stage G 故障转移。`scripts/run-managed-agent-server-e2e.ts` 的三个故障转移模式（`--session-failover`、`--inflight-failover`、`--continuation-failover`）以及 `--big-output` 长回答与冷恢复模式都在 `hosted-harness-mysql` 任务中运行（#13258)；只有真实模型检查仍不进 CI（见[ Hosted Turn failover E2E](2026-09-30-hosted-turn-failover-e2e.zh-CN.md)）。

## 3. 设计

### 3.1 测试台（FG1）

```
 门禁（JUnit，测试 JVM）
   │  stdin 上每行一条 JSON 命令
   ▼
 Broker JVM ── FaultGateBroker：RuntimeBrokerService + JDBC 仓库
   │   HttpRuntimeTransport，其 HttpClient 代理到 ──► FaultProxy（测试 JVM）
   │   LocalProcessRuntimeProvisioner                     │ 先转发，再丢弃、
   │     └─ node dist/cli.js managed-runtime-worker ◄─────┘ 重置、延迟或扣住应答
   │
   └─ JDBC ─► [TcpRelay，可按需切断] ─► H2 TCP server，文件型（测试 JVM）
```

- `FaultGateBroker` 在独立 JVM 中运行生产的 `RuntimeBrokerService`，搭配 `JdbcRuntimeBindingRepository`、`JdbcRuntimeSessionRepository` 和 `JdbcToolExecutionRepository`。门禁把它作为子进程（`BrokerProcess`）启动，通过标准输入驱动 `warm`、`acquire`、`create`（预留后启动）、`createImmediate`（立即派发的 `POST /executions` 路由）、`get`、`cancel`、`reconcile` 和 `release`。可以单独 SIGKILL Broker，此时它的 worker 继续运行，与 JVM 崩溃时一样；也可以用 SIGSTOP 和 SIGCONT 冻结、解冻它。门禁杀掉 Broker 时，挂在它上面的命令会在 JVM 退出后立即失败。
- Broker 的 `HttpRuntimeTransport` 构建在一个以 `FaultProxy` 为代理的 `HttpClient` 上，所以发往 worker 的每个请求都经过它。代理转发每个请求，再对该操作施加下一个预定的故障：`DROP` 静默关闭，`RESET` 重置套接字，`DELAY` 延迟应答，`HOLD_REQUEST` 在放行前不转发，`HOLD_RESPONSE` 扣住 worker 的应答直到放行。代理在请求到达时记录它，门禁据此统计 Broker 发出的 transport 调用数。
- worker 由生产的 `LocalProcessRuntimeProvisioner` 以 `node dist/cli.js managed-runtime-worker` 启动。工具调用是向工作区中标记文件追加内容的 `run_shell_command`，副作用次数以工具自己写入的内容计数。
- 所有 Broker 共用一个文件型 H2 数据库，它位于测试 JVM 中的 TCP server 之后，因此重启的或第二个 Broker 看到的是相同记录，门禁也直接读取这些记录。前面的 `TcpRelay` 可以被切断：已打开的连接被重置，新连接被拒绝。
- 没有任何生产类增加故障钩子。故障只存在于网络、数据库链路或进程表中。

两个测试适配器补上了生产代码的缺口：

- `FaultGateTransport`。`HttpRuntimeTransport` 已实现 Session 动词（acquire 在 Broker 本地应答；release 走 provider control 路由），适配器把两个动词都委托给生产 transport。在下文的 `MANAGED` placement 下，它的 acquire 还会通过 `HttpRuntimeTransport` 执行 W0c-3 式的上下文安装与激活。
- `RecoverableProcessProvisioner`。`LocalProcessRuntimeProvisioner` 把 worker 归属保存在内存中，所以其他进程里的 Broker 永远观测不到这个 worker。适配器包装生产 provisioner（worker 仍由它启动、验证并持有），只增加一份记录：每个 worker 的 pid、启动时间和 endpoint。对本进程不持有的租约：记录中的进程存活且重新验证通过即为 `READY`，记录中的进程已消失即为 `NOT_FOUND`，没有记录则为 `UNKNOWN`。它代替了对账设计中列为后续工作的"可恢复本地进程供给"，让门禁能在真实 worker 上驱动服务的收养（#12627）和接管（#12477）路径。

FG5 的门禁以 `MANAGED` placement 打开测试台：

- 生产 provisioner 获得一个存储解析器，于是每个 placement 都选择 managed-context/1：worker 以 boot v2 启动，应答 ready v2，并通过 attestation v3 验证。scope 使用 Workspace 执行 profile 的 capability digest 与 Session 隔离。Workspace 目录是挂载根，它的子目录 `project` 是 Session 的上下文目录。
- `FaultGateTransport.acquire` 做的事情，与 managed agent server 的 Workspace transport（W0c-3）在完成授权和存储所有权检查之后所做的相同：通过生产的 `HttpRuntimeTransport.installContext`，以由 Runtime Session ID 派生的 operation ID 安装 Session 的上下文，再通过 `activateWorkspace` 激活 Session 的门。release 关闭这道门。两个调用都会校验 worker 的回执。
- `RecoverableProcessProvisioner` 转发 `createRequest`，因此重启后的 Broker 放置并收养的是同一个托管绑定。
- 工具把自己的工作目录追加到所有 Workspace 之外的一个文件中，门禁据此看到工具是否执行、在哪里执行：上下文目录、挂载根，还是 worker 自己的目录。

门禁只在 Maven profile `fault-gates`（JUnit 标签 `fault-gate`）中运行，默认的 `mvn test` 会排除它们。缺少前置条件时明确失败：打包产物（`-Dqwen.cli.entry`，默认 `<仓库>/dist/cli.js`）、`PATH` 上的 Node.js，以及 POSIX 系统。门禁结束时，测试台会杀掉所有 worker，包括被杀 Broker 留下的孤儿进程。

### 3.2 不变量

每个门禁在适用处断言：

- 副作用至多执行一次：以工具写入的标记计数，且代理对该调用至多看到一次 execute；
- 没发生的完成不会被报告：没有 Runtime 的应答时，任何回复和记录都不会显示已结算或已取消；
- `UNKNOWN` 执行保持 `UNKNOWN`，直到原 Runtime 给出终态证据；
- 按原始身份查询返回原始结果：记录中的结果等于 worker 按 reference 应答 `status` 的结果。

FG5 针对 W0c 上下文安装再加上：

- 安装和激活都得到应答之前，不执行任何工具：acquire 失败后 Session 不可用，代理看不到 execute，worker 自己也拒绝已安装但从未激活的 Session；
- 重试安装是对 worker 已记录 operation 的重放：即使上下文目录被移走也会成功，而为另一个 Runtime Session 做的全新安装会被拒绝；
- 工具只在 Session 的上下文目录中执行，绝不在挂载根或 worker 自己的目录中执行；
- Broker 无法证明的托管启动被阻断，而不是被重新拉起。

### 3.3 门禁

| 门禁                         | 故障                                                                                                                                                      | 断言的结果                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FG1 对照                     | 无                                                                                                                                                        | warm 验证两次（provisioner，然后服务），acquire 再验证一次，调用结算为 `success`，标记只有一行，代理看到一次 execute，按 reference 的 `status` 返回已存储的结果。                                                                                                                                                                          |
| FG2 execute 丢失             | worker 执行调用后，`DROP`、`RESET` 或 `DELAY` 超过 10 s 请求超时                                                                                          | 记录变为 `UNKNOWN`。相同 key 的重试返回该记录，不派发任何东西。直接发给 worker 的同一 reference 的 execute 并入原调用。`status` 返回已结算结果，`reconcileExecution` 据此解决记录。标记一行，execute 一次。预留后启动与立即派发两条路径都跑。                                                                                              |
| FG2 status 丢失              | 对账查询先 `DROP`、再 `RESET`                                                                                                                             | 每次对账都以 `managed_runtime_unavailable` 可重试地失败，记录保持 `UNKNOWN` 且没有结果。下一次查询将其解决。                                                                                                                                                                                                                               |
| FG2 cancel 丢失              | 在 `sleep 5` 命令期间 `DROP` cancel 应答                                                                                                                  | cancel 调用失败。worker 确实中止了命令，所以记录依据 execute 应答结算为 `cancelled`。命令尾部从未执行，`status` 返回相同结果。                                                                                                                                                                                                             |
| FG2 attestation 丢失         | `DROP` provisioner 的验证，或服务的验证                                                                                                                   | warm 可重试地失败。绑定保持 `PROVISIONING` 且没有租约，未通过验证的 worker 被回收。下一次 warm 在同一绑定上达到 `READY`。                                                                                                                                                                                                                  |
| FG3 worker 被杀              | 在 `sleep 3` 期间 SIGKILL worker 进程树                                                                                                                   | 记录变为 `UNKNOWN`，对账回答 `409 runtime_execution_evidence_unavailable`。绑定为 `FAILED`，新一代服务下一次 warm，但不会结算旧调用。命令尾部从未执行。                                                                                                                                                                                    |
| FG3 Broker 被杀              | 在认领后（execute 在到达 worker 前被扣住）、发送后（worker 正在执行）或提交前（worker 的应答被扣住）SIGKILL Broker JVM；然后使用可恢复适配器启动新 Broker | 新 Broker 先对 worker 重新验证两次（provisioner 观测一次、服务收养一次），再收养同一绑定代与租约，不启动自己的 worker。dispatch 租约过期后，相同 key 的重试把记录 fence 为 `UNKNOWN`，不发送 execute。认领后的情形：对账保持 `UNRESOLVED`（`unknown`），没有标记。发送后或提交前的情形：依据 worker 证据解决为 `success`，命令只执行一次。 |
| FG3 钉住：生产重启           | 只用 `LocalProcessRuntimeProvisioner` 的 Broker 被 SIGKILL                                                                                                | 新 Broker 的 warm 以 `runtime_broker_reconcile_timeout` 失败。绑定保持 `READY` 与旧租约，既未被收养也未被退役。孤儿 worker 独自把调用执行完一次。对账回答 `IN_FLIGHT`，记录保持 `EXECUTING`。                                                                                                                                              |
| FG3 钉住：宿主崩溃（#12670） | SIGKILL Broker 及其 worker                                                                                                                                | 新 Broker 观测到 `NOT_FOUND`，把绑定标为 `LOST`。未结算调用钉住它：`acquire` 和 `warm` 以 `runtime_broker_runtime_lost` 失败，`release` 以 `runtime_reconciliation_required` 失败。对账回答 `IN_FLIGHT`，记录保持 `EXECUTING`。                                                                                                            |
| FG4 接管                     | Broker A 在两次数据库调用之间被冻结（SIGSTOP），worker 应答被扣住；Broker B 共用数据库                                                                    | A 的 dispatch 租约过期后，B 对 worker 重新验证两次、收养它，并把记录 fence 为 `UNKNOWN`。A 的请求超时长于整个接管过程，它解冻后收到自己的应答：记录保持 `UNKNOWN`，直到 B 依据证据解决它。此后 A 对相同 key 的重试、cancel、get 和对账都只依据已结算记录应答，解冻后向其 Runtime 发出的请求为零。                                          |
| FG4 存储丢失                 | Broker 提交 worker 应答时切断数据库中继                                                                                                                   | Broker 只做少数几次连接尝试便停止，`get` 失败而不是报告结果。数据库恢复后，记录仍为 `EXECUTING` 且没有结果。认领过期后，相同 key 的重试将其 fence，对账依据 worker 将其解决。标记一行，execute 一次。                                                                                                                                      |
| FG5 对照                     | 无                                                                                                                                                        | warm 以 attestation v3 验证 worker 两次，acquire 再验证一次。acquire 安装一次上下文、激活一次，调用结算为 `success`，在上下文目录中执行一次。                                                                                                                                                                                              |
| FG5 安装应答丢失             | 安装应答被 `DROP`、`RESET`，或 `DELAY` 超过请求超时                                                                                                       | acquire 在任何激活之前以 `managed_runtime_unavailable` 可重试地失败。Session 不能执行工具，代理看不到 execute。上下文目录被移走时，重试仍然成功，而为另一个 Runtime Session 做的全新安装以 `409 managed_context_unavailable` 被拒绝，说明重试重放的是 worker 已记录的 operation；随后 Session 被激活。目录移回后，调用在其中执行一次。     |
| FG5 激活应答丢失             | `DROP` 激活应答                                                                                                                                           | acquire 可重试地失败。重试同样在上下文目录被移走、全新安装在那里被拒绝时进行：它重放安装，并重复幂等的激活；调用在上下文目录中执行一次。                                                                                                                                                                                                   |
| FG5 托管 attestation 丢失    | `DROP` provisioner 的验证，或服务的验证                                                                                                                   | 与 FG2 不同，warm 不可重试：以 `runtime_provision_failed`（provisioner）或 `409 runtime_broker_recovery_blocked`（服务）失败。绑定变为 `RECOVERY_BLOCKED` 且没有租约，worker 被停止。此后的 warm 和 acquire 都回答 `409 runtime_broker_recovery_blocked`，不做任何验证或安装。                                                             |
| FG5 启动期间 Broker 被杀     | 扣住 provisioner 的验证应答时 SIGKILL Broker JVM；然后启动新 Broker                                                                                       | 死去的 Broker 的启动认领过期之后，新 Broker 发现拉起进程之前已持久化的资源句柄，于是阻断绑定：每次 warm 和 acquire 都回答 `409 runtime_broker_recovery_blocked`，没有验证，也没有 worker。第一个 worker 成为孤儿，与 FG3 的钉子相同。                                                                                                      |
| FG5 安装后 worker 被杀       | acquire 之后 SIGKILL worker                                                                                                                               | 已死的代被退役，下一次 warm 启动一个新 worker，它不持有任何安装。新的 Runtime Session 在那里安装自己的上下文，其调用执行一次。旧 Session 的调用被直接发给新 worker 时，以 `409 managed_context_unavailable` 被拒绝，在任何地方都没有执行。                                                                                                 |
| FG5 安装后 Broker 被杀       | 在激活请求被扣住（已安装）或激活应答被扣住（已激活）时 SIGKILL Broker JVM；然后使用可恢复适配器启动新 Broker                                              | 在已安装的窗口中，worker 以 `409 managed_context_unavailable` 拒绝它已安装但从未激活的 Session 的调用。新 Broker 对 worker 重新验证两次，收养同一代与租约，不启动 worker。上下文目录被移走时，它的 acquire 重放已记录的安装并激活一次，而全新的安装被拒绝；目录移回后，调用在其中执行一次。                                                |
| FG5 钉住：上下文目录被删     | acquire 之后删除上下文目录                                                                                                                                | worker 在调用开始前拒绝它，也从不记录它；直接发给它的调用得到 `409 managed_context_unavailable`。Broker 把记录记为 `UNKNOWN`，对账回答 `UNRESOLVED`（`unknown`）；工具在任何地方都没有执行。Session 保持开放：目录恢复后，它的下一次调用照常执行。                                                                                         |

### 3.4 钉住的现状

有三个门禁钉住的是当前行为，而不是目标：

- **重启后的 Broker 无法收养 `LocalProcessRuntimeProvisioner` 启动的 worker。** 它的 `reconcile` 对不属于自己的进程一律返回 `UNKNOWN`，对账因此一直重试到 `runtime_broker_reconcile_timeout`。worker 没有父进程监视，于是成为孤儿。可恢复适配器表明，只要 provisioner 能观测到 worker，服务就能正确收养。持久化本地进程供给落地后，这个钉子翻转为收养。
- **#12670。** 一个被证明 `LOST` 且带有未结算执行的代，既不能回收也不能释放。#12670 定案后更新这个钉子。
- **worker 的上下文拒绝被记为 `UNKNOWN`，且 Session 保持开放。** 上下文目录不存在时，worker 在调用开始前以 `409 managed_context_unavailable` 应答 execute，且从不记录这次调用。transport 报告了这个错误码，但派发把每个失败的 execute 都记为 `UNKNOWN`，因此尽管 worker 证明了它从未执行该调用，也没有证据能结算这条记录。Session 也没有被关闭：目录恢复后，它的下一次调用照常执行。[信封](2026-09-25-managed-context-envelope.zh-CN.md)与 [worker](2026-09-26-managed-context-worker.zh-CN.md) 设计写的是：这种拒绝会保持该 Session 的工具门关闭，并把它的上下文标记为 `recovery_blocked`；Broker 做到这一点，或把这种拒绝结算为 `not_started` 时，钉子随之翻转。在生产中，managed agent server 的 Workspace transport 会在派发前拒绝未授权的 Session，但不会复查目录。

FG4 存储门禁还钉住：数据库恢复后，没有任何东西重试失败的提交。有上限的重试同样满足 #12748；若将来加入，该断言从 `EXECUTING` 改为已提交的结果。

### 3.5 对开放问题的取舍

1. **CI 位置。** 门禁运行在 `sdk-java.yml` 的 `Hosted no-tool processes / MySQL 8.4 / Java 21` 任务中（#12733）。这条 Java 21 线已经为 Hosted 进程门禁安装、构建并打包 CLI。在那些门禁之后新增一步，在 `packages/sdk-java/runtime-broker` 中以 `-Dqwen.cli.entry=$GITHUB_WORKSPACE/dist/cli.js` 运行 `mvn -Pfault-gates test`，上限 10 分钟。
2. **数据库。** 使用 TCP server 之后的文件型 H2，所有 Broker 进程共用。门禁暂不在 MySQL 或 MariaDB 上运行；它们所在的线已经带有 MySQL 8.4 服务，这项后续工作因此很小。
3. **测试台语言。** 围绕 Broker 服务用 Java 实现，让每个故障都有确定的注入点。TypeScript 故障转移脚本保持独立。
4. **#12670。** 按 §3.4 钉住。

## 4. 验证

在仓库根目录构建好打包产物（`npm run build && npm run bundle`）后，在 `packages/sdk-java/runtime-broker` 中运行：

```bash
mvn -Pfault-gates test   # 全部门禁（目前 44 个），约 4 分钟
mvn test                 # 默认测试集，不含门禁
mvn checkstyle:check
```

门禁经过了针对生产代码的变异检验。下表每个变异单独施加，所列门禁均失败。最后五行修改的是打包的 worker，而不是 Java 代码：

| 变异                                                                   | 失败的门禁                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| execute 失败时结算为 `error` 而不是 `UNKNOWN`                          | FG2 execute 丢失、FG3 worker 被杀                                                  |
| execute 失败后再发送一次                                               | FG2 execute 丢失                                                                   |
| status 查询失败按 `not_started` 处理                                   | FG2 status 丢失                                                                    |
| cancel 失败按 `cancelled` 处理                                         | FG2 cancel 丢失                                                                    |
| 服务忽略验证失败                                                       | FG2 attestation 丢失                                                               |
| provisioner 忽略验证失败                                               | FG2 attestation 丢失                                                               |
| `claimDispatch` 重新授予过期的 `EXECUTING` 认领                        | FG3 Broker 被杀                                                                    |
| Runtime 的 `unknown` 按 `not_started` 处理                             | FG3 Broker 被杀（认领后）                                                          |
| 被 fence 的派发者提交其迟到的应答                                      | FG4 接管                                                                           |
| 失败的提交被循环重试                                                   | FG4 存储丢失                                                                       |
| 已死 worker 的 `UNKNOWN` 调用被结算为 `error`                          | FG3 worker 被杀                                                                    |
| 对账也查询已结算的记录                                                 | FG4 接管                                                                           |
| 服务收养 worker 时不重新验证                                           | FG3 Broker 被杀、FG4 接管                                                          |
| transport 的 acquire 失败后仍把 Session 标为 `READY`                   | FG5 安装应答丢失、FG5 激活应答丢失                                                 |
| `installContext` 把丢失的应答当作已安装                                | FG5 安装应答丢失                                                                   |
| `activateWorkspace` 忽略失败的交换                                     | FG5 激活应答丢失                                                                   |
| 托管启动遇到可重试的失败时不阻断                                       | FG5 托管 attestation 丢失（服务）                                                  |
| 已持久化的托管资源句柄不再阻断重启                                     | FG5 启动期间 Broker 被杀                                                           |
| worker 为没有已安装、已激活上下文的 Session 执行工具，并在挂载根中执行 | FG5 安装后 worker 被杀、FG5 安装后 Broker 被杀（已安装）、FG5 钉住：上下文目录被删 |
| worker 把每个 Session 都当作已激活                                     | FG5 安装后 Broker 被杀（已安装）                                                   |
| worker 对每次安装都重新校验，而不是重放已记录的 operation              | FG5 安装应答丢失、FG5 激活应答丢失、FG5 安装后 Broker 被杀                         |
| worker 安装时不校验上下文目录                                          | FG5 安装应答丢失、FG5 激活应答丢失、FG5 安装后 Broker 被杀                         |
| worker 以另一个 409 错误码拒绝工具                                     | FG5 安装后 worker 被杀、FG5 安装后 Broker 被杀（已安装）、FG5 钉住：上下文目录被删 |

## 5. 局限与后续工作

- 信号无法可靠地让 Broker 停在 `claimDispatch` 与 execute 调用之间，即 #12477 修复的那个窗口；该窗口仍由它的单元测试覆盖。FG4 覆盖的是围绕它的进程级接管。
- 门禁需要 POSIX 信号，在 CI 中运行于 Linux。
- 收养期间 attestation 应答丢失未覆盖。Session 动词走 provider control 路由；FG5 只覆盖托管 acquire 所做的安装与激活。
- FG5 检验的是 Broker 的 W0c-2 链路和 worker，而不是 managed agent server。`FaultGateTransport` 只模仿 W0c-3 的安装与激活调用；W0c-3 的存储所有权、授权复核和目录预检仍由 `WorkspaceRuntimeTest` 覆盖。
- Broker 不为安装持久化任何东西，因此 FG5 没有存储故障门禁，围绕一次安装的双 Broker 接管也未覆盖。release（关闭这道门）的应答丢失同样未覆盖。
- 重放得到的回执与原回执逐字节相同，所以回执无法区分重放和全新安装；FG5 通过把上下文目录移走来证明重放，因为全新安装在那里会被拒绝。安装与激活回执的校验由单元测试（`HttpRuntimeTransportTest`）覆盖；门禁从不篡改回执。
- worker 关闭时仍停在激活门的调用继续推迟，与 worker 设计的记录一致。
- 后续：在 MySQL 上运行崩溃与接管门禁；持久化本地收养与 #12670 落地后翻转两个钉子。`FaultGateTransport` 现已把两个 Session 动词委托给 `HttpRuntimeTransport`（它仅剩的职责是 MANAGED placement 的安装与激活），此前"transport 实现 Session 动词后移除该适配器"的前提已经满足；适配器仅为该 placement 保留。Broker 在上下文拒绝时关闭 Session，或把这种拒绝结算为 `not_started` 时，翻转上下文目录的钉子。
