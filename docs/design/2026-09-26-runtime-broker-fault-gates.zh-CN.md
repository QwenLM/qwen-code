# Runtime Broker 故障门禁

[English](2026-09-26-runtime-broker-fault-gates.md) | [简体中文](2026-09-26-runtime-broker-fault-gates.zh-CN.md)

状态：以测试形式实现于 `packages/sdk-java/runtime-broker`；没有修改生产代码

相关：#12748（本工作）、#12380 的 Stage F，以及本工作所检验的设计：
[进程收养](2026-09-23-managed-runtime-process-adoption.zh-CN.md)、
[绑定对账](2026-09-24-runtime-binding-reconciliation.zh-CN.md)与
[工具契约](2026-09-24-managed-runtime-tool-contract.zh-CN.md)。

## 1. 问题

#12380 的 Stage F 要求每项已启用的能力都通过 ACK 丢失、进程崩溃、取消和存储故障测试。Broker ↔ Runtime 工具链路（收养与验证、v2 execute/status/cancel 传输、worker 处理器、租约 fence、`UNKNOWN` 对账）此前只在单个进程里、针对假 transport 和内存仓库测试过，没有任何测试证明真实进程死亡、真实响应丢失时这些规则依然成立。

## 2. 范围

范围内：#12748 中针对工具链路的 FG1–FG4 门禁，运行在真实服务、真实打包的 worker、真实 HTTP、真实数据库和真实进程死亡之上。

范围外：Hosted Harness 的会话与 SSE 门禁、输出捕获与投递门禁（等 O1b–O3 之后）、W0c 上下文安装故障、Kubernetes 供给，以及 Stage G 故障转移。`scripts/run-managed-agent-server-e2e.ts` 的故障转移模式仍不进 CI。

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

- `FaultGateBroker` 在独立 JVM 中运行生产的 `RuntimeBrokerService`，搭配 `JdbcRuntimeBindingRepository`、`JdbcRuntimeSessionRepository` 和 `JdbcToolExecutionRepository`。门禁把它作为子进程（`BrokerProcess`）启动，通过标准输入驱动 `warm`、`acquire`、`create`、`get`、`cancel`、`reconcile` 和 `release`。可以单独 SIGKILL Broker，此时它的 worker 继续运行，与 JVM 崩溃时一样；也可以用 SIGSTOP 和 SIGCONT 冻结、解冻它。
- Broker 的 `HttpRuntimeTransport` 构建在一个以 `FaultProxy` 为代理的 `HttpClient` 上，所以每个 attest、execute、status 和 cancel 请求都经过它。代理转发每个请求，再对该操作施加下一个预定的故障：`DROP` 静默关闭，`RESET` 重置套接字，`DELAY` 延迟应答，`HOLD_REQUEST` 在放行前不转发，`HOLD_RESPONSE` 扣住 worker 的应答直到放行。代理在请求到达时记录它，门禁据此统计 Broker 发出的 transport 调用数。
- worker 由生产的 `LocalProcessRuntimeProvisioner` 以 `node dist/cli.js managed-runtime-worker` 启动。工具调用是向工作区中标记文件追加内容的 `run_shell_command`，副作用次数以工具自己写入的内容计数。
- 所有 Broker 共用一个文件型 H2 数据库，它位于测试 JVM 中的 TCP server 之后，因此重启的或第二个 Broker 看到的是相同记录，门禁也直接读取这些记录。前面的 `TcpRelay` 可以被切断：已打开的连接被重置，新连接被拒绝。
- 没有任何生产类增加故障钩子。故障只存在于网络、数据库链路或进程表中。

两个测试适配器补上了生产代码的缺口：

- `FaultGateTransport`。v2 worker 契约没有 Session 动词，`HttpRuntimeTransport` 对 `acquire` 和 `release` 返回 501（`runtime_session_verb_unsupported`），所以只用生产 transport 时服务无法走到派发。适配器在本地应答这两个动词，把 attest、execute、status 和 cancel 交给 `HttpRuntimeTransport`。工具契约设计把 Session 动词列为后续工作。
- `RecoverableProcessProvisioner`。`LocalProcessRuntimeProvisioner` 把 worker 归属保存在内存中，所以其他进程里的 Broker 永远观测不到这个 worker。适配器包装生产 provisioner（worker 仍由它启动、验证并持有），只增加一份记录：每个 worker 的 pid、启动时间和 endpoint。对本进程不持有的租约：记录中的进程存活且重新验证通过即为 `READY`，记录中的进程已消失即为 `NOT_FOUND`，没有记录则为 `UNKNOWN`。它代替了对账设计中列为后续工作的"可恢复本地进程供给"，让门禁能在真实 worker 上驱动服务的收养（#12627）和接管（#12477）路径。

门禁只在 Maven profile `fault-gates`（JUnit 标签 `fault-gate`）中运行，默认的 `mvn test` 会排除它们。缺少前置条件时明确失败：打包产物（`-Dqwen.cli.entry`，默认 `<仓库>/dist/cli.js`）、`PATH` 上的 Node.js，以及 POSIX 系统。门禁结束时，测试台会杀掉所有 worker，包括被杀 Broker 留下的孤儿进程。

### 3.2 不变量

每个门禁在适用处断言：

- 副作用至多执行一次：以工具写入的标记计数，且代理对该调用至多看到一次 execute；
- 没发生的完成不会被报告：没有 Runtime 的应答时，任何回复和记录都不会显示已结算或已取消；
- `UNKNOWN` 执行保持 `UNKNOWN`，直到原 Runtime 给出终态证据；
- 按原始身份查询返回原始结果：记录中的结果等于 worker 按 reference 应答 `status` 的结果。

### 3.3 门禁

| 门禁                         | 故障                                                                                                                                                      | 断言的结果                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FG1 对照                     | 无                                                                                                                                                        | warm 验证两次（provisioner，然后服务），acquire 再验证一次，调用结算为 `success`，标记只有一行，代理看到一次 execute，按 reference 的 `status` 返回已存储的结果。                                                                                                        |
| FG2 execute 丢失             | worker 执行调用后，`DROP`、`RESET` 或 `DELAY` 超过 10 s 请求超时                                                                                          | 记录变为 `UNKNOWN`。相同 key 的重试返回该记录，不派发任何东西。直接发给 worker 的同一 reference 的 execute 并入原调用。`status` 返回已结算结果，`reconcileExecution` 据此解决记录。标记一行，execute 一次。                                                              |
| FG2 status 丢失              | 对账查询先 `DROP`、再 `RESET`                                                                                                                             | 每次对账都以 `managed_runtime_unavailable` 可重试地失败，记录保持 `UNKNOWN` 且没有结果。下一次查询将其解决。                                                                                                                                                             |
| FG2 cancel 丢失              | 在 `sleep 5` 命令期间 `DROP` cancel 应答                                                                                                                  | cancel 调用失败。worker 确实中止了命令，所以记录依据 execute 应答结算为 `cancelled`。命令尾部从未执行，`status` 返回相同结果。                                                                                                                                           |
| FG2 attestation 丢失         | `DROP` provisioner 的验证，或服务的验证                                                                                                                   | warm 可重试地失败。绑定保持 `PROVISIONING` 且没有租约，未通过验证的 worker 被回收。下一次 warm 在同一绑定上达到 `READY`。                                                                                                                                                |
| FG3 worker 被杀              | 在 `sleep 3` 期间 SIGKILL worker 进程树                                                                                                                   | 记录变为 `UNKNOWN`，对账回答 `409 runtime_execution_evidence_unavailable`。绑定为 `FAILED`，新一代服务下一次 warm，但不会结算旧调用。命令尾部从未执行。                                                                                                                  |
| FG3 Broker 被杀              | 在认领后（execute 在到达 worker 前被扣住）、发送后（worker 正在执行）或提交前（worker 的应答被扣住）SIGKILL Broker JVM；然后使用可恢复适配器启动新 Broker | 新 Broker 收养同一绑定代与租约，不启动自己的 worker。dispatch 租约过期后，相同 key 的重试把记录 fence 为 `UNKNOWN`，不发送 execute。认领后的情形：对账保持 `UNRESOLVED`（`unknown`），没有标记。发送后或提交前的情形：依据 worker 证据解决为 `success`，命令只执行一次。 |
| FG3 钉住：生产重启           | 只用 `LocalProcessRuntimeProvisioner` 的 Broker 被 SIGKILL                                                                                                | 新 Broker 的 warm 以 `runtime_broker_reconcile_timeout` 失败。绑定保持 `READY` 与旧租约，既未被收养也未被退役。孤儿 worker 独自把调用执行完一次。对账回答 `IN_FLIGHT`，记录保持 `EXECUTING`。                                                                            |
| FG3 钉住：宿主崩溃（#12670） | SIGKILL Broker 及其 worker                                                                                                                                | 新 Broker 观测到 `NOT_FOUND`，把绑定标为 `LOST`。未结算调用钉住它：`acquire` 和 `warm` 以 `runtime_broker_runtime_lost` 失败，`release` 以 `runtime_reconciliation_required` 失败。对账回答 `IN_FLIGHT`，记录保持 `EXECUTING`。                                          |
| FG4 接管                     | Broker A 在两次数据库调用之间被冻结（SIGSTOP），worker 应答被扣住；Broker B 共用数据库                                                                    | A 的 dispatch 租约过期后，B 收养 worker 并把记录 fence 为 `UNKNOWN`。A 解冻并收到它的应答：记录保持 `UNKNOWN`，直到 B 依据证据解决它。此后 A 对相同 key 的重试、cancel、get 和对账都只依据已结算记录应答，解冻后向其 Runtime 发出的请求为零。                            |
| FG4 存储丢失                 | Broker 提交 worker 应答时切断数据库中继                                                                                                                   | Broker 只做少数几次连接尝试便停止，`get` 失败而不是报告结果。数据库恢复后，记录仍为 `EXECUTING` 且没有结果。认领过期后，相同 key 的重试将其 fence，对账依据 worker 将其解决。标记一行，execute 一次。                                                                    |

### 3.4 钉住的现状

有两个门禁钉住的是当前行为，而不是目标：

- **重启后的 Broker 无法收养 `LocalProcessRuntimeProvisioner` 启动的 worker。** 它的 `reconcile` 对不属于自己的进程一律返回 `UNKNOWN`，对账因此一直重试到 `runtime_broker_reconcile_timeout`。worker 没有父进程监视，于是成为孤儿。可恢复适配器表明，只要 provisioner 能观测到 worker，服务就能正确收养。持久化本地进程供给落地后，这个钉子翻转为收养。
- **#12670。** 一个被证明 `LOST` 且带有未结算执行的代，既不能回收也不能释放。#12670 定案后更新这个钉子。

FG4 存储门禁还钉住：数据库恢复后，没有任何东西重试失败的提交。有上限的重试同样满足 #12748；若将来加入，该断言从 `EXECUTING` 改为已提交的结果。

### 3.5 对开放问题的取舍

1. **CI 位置。** 门禁运行在 `sdk-java.yml` 的 `Hosted no-tool processes / MySQL 8.4 / Java 21` 任务中（#12733）。这条 Java 21 线已经为 Hosted 进程门禁安装、构建并打包 CLI。在那些门禁之后新增一步，在 `packages/sdk-java/runtime-broker` 中以 `-Dqwen.cli.entry=$GITHUB_WORKSPACE/dist/cli.js` 运行 `mvn -Pfault-gates test`，上限 10 分钟。
2. **数据库。** 使用 TCP server 之后的文件型 H2，所有 Broker 进程共用。门禁暂不在 MySQL 或 MariaDB 上运行；它们所在的线已经带有 MySQL 8.4 服务，这项后续工作因此很小。
3. **测试台语言。** 围绕 Broker 服务用 Java 实现，让每个故障都有确定的注入点。TypeScript 故障转移脚本保持独立。
4. **#12670。** 按 §3.4 钉住。

## 4. 验证

在仓库根目录构建好打包产物（`npm run build && npm run bundle`）后，在 `packages/sdk-java/runtime-broker` 中运行：

```bash
mvn -Pfault-gates test   # 16 个门禁，约 1.5 分钟
mvn test                 # 默认测试集，不含门禁
mvn checkstyle:check
```

门禁经过了针对生产代码的变异检验。下表每个变异单独施加，所列门禁均失败：

| 变异                                            | 失败的门禁                        |
| ----------------------------------------------- | --------------------------------- |
| execute 失败时结算为 `error` 而不是 `UNKNOWN`   | FG2 execute 丢失、FG3 worker 被杀 |
| execute 失败后再发送一次                        | FG2 execute 丢失                  |
| status 查询失败按 `not_started` 处理            | FG2 status 丢失                   |
| cancel 失败按 `cancelled` 处理                  | FG2 cancel 丢失                   |
| 服务忽略验证失败                                | FG2 attestation 丢失              |
| provisioner 忽略验证失败                        | FG2 attestation 丢失              |
| `claimDispatch` 重新授予过期的 `EXECUTING` 认领 | FG3 Broker 被杀                   |
| Runtime 的 `unknown` 按 `not_started` 处理      | FG3 Broker 被杀（认领后）         |
| 被 fence 的派发者提交其迟到的应答               | FG4 接管                          |
| 失败的提交被循环重试                            | FG4 存储丢失                      |
| 已死 worker 的 `UNKNOWN` 调用被结算为 `error`   | FG3 worker 被杀                   |
| 对账也查询已结算的记录                          | FG4 接管                          |

## 5. 局限与后续工作

- 信号无法可靠地让 Broker 停在 `claimDispatch` 与 execute 调用之间，即 #12477 修复的那个窗口；该窗口仍由它的单元测试覆盖。FG4 覆盖的是围绕它的进程级接管。
- 门禁需要 POSIX 信号，在 CI 中运行于 Linux。
- 收养期间 attestation 应答丢失，以及 Session 动词上的响应丢失，均未覆盖；Session 动词本身尚不存在。
- 后续：在 MySQL 上运行崩溃与接管门禁；持久化本地收养与 #12670 落地后翻转两个钉子；`HttpRuntimeTransport` 实现 Session 动词后移除 `FaultGateTransport`。
