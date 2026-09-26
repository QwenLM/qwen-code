# Runtime Broker 故障门禁

[English](2026-09-26-runtime-broker-fault-gates.md) | [简体中文](2026-09-26-runtime-broker-fault-gates.zh-CN.md)

状态：以测试形式实现于 `packages/sdk-java/runtime-broker`。在 managed agent 分支上，门禁针对该分支自己的 Broker 服务、worker 和本地进程 provisioner 运行，并发现了两处派发器缺陷，已在 `RuntimeBrokerService` 中修复（§3.4）。

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
   │   HttpRuntimeTransport 与 provisioner 的健康探测，共用一个
   │   代理到 FaultProxy 的 HttpClient ─────────────────► FaultProxy（测试 JVM）
   │   LocalProcessRuntimeProvisioner（共享状态目录）      │ 先转发，再丢弃、
   │     └─ node dist/managed-runtime-worker.js ◄──────────┘ 重置或扣住应答
   │
   └─ JDBC ─► [TcpRelay，可按需切断] ─► H2 TCP server，文件型（测试 JVM）
```

- `FaultGateBroker` 在独立 JVM 中运行生产的 `RuntimeBrokerService`，搭配 `JdbcRuntimeBindingRepository`、`JdbcRuntimeSessionRepository` 和 `JdbcToolExecutionRepository`。门禁把它作为子进程（`BrokerProcess`）启动，通过标准输入驱动 `warm`、`acquire`、`prepare`、`create`、`get`、`cancel`、`reconcile`、`resolve` 和 `release`。可以单独 SIGKILL Broker，此时它的 worker 继续运行，与 JVM 崩溃时一样；也可以用 SIGSTOP 和 SIGCONT 冻结、解冻它。
- Broker 的 `HttpRuntimeTransport` 与其 provisioner 共用一个以 `FaultProxy` 为代理的 `HttpClient`，所以每个健康探测、attest、Session 动词、Tool v2 控制动词、execute、status 和 cancel 请求都经过它。代理转发每个请求，再对该操作施加下一个预定的故障：`DROP` 静默关闭，`RESET` 重置套接字，`HOLD_REQUEST` 在放行前不转发，`HOLD_RESPONSE` 扣住 worker 的应答直到放行。代理在请求到达时记录它，门禁据此统计 Broker 发出的 transport 调用数。
- worker 是 `node dist/managed-runtime-worker.js`，由生产的 `LocalProcessRuntimeProvisioner` 启动。同一测试台的所有 Broker 共用一个状态目录，就像同一台主机上的 Broker 一样，所以重启的或第二个 Broker 能通过进程记录找到正在运行的 worker 并收养它。scope 中的工作区 ID 取守护进程根据规范化工作区路径推导出的值，worker 会校验这一点。
- 门禁按 Hosted Harness 的方式准备每个工具调用：经由 Broker 的控制动词读取 manifest、开启轮次、准备一个前台 `run_shell_command` 调用并运行其 pre-tool hook。返回的调用 reference 就是随后执行的对象。命令向工作区中的标记文件追加内容，副作用次数以工具自己写入的内容计数。
- 所有 Broker 共用一个文件型 H2 数据库，它位于测试 JVM 中的 TCP server 之后，因此重启的或第二个 Broker 看到的是相同记录，门禁也直接读取这些记录。前面的 `TcpRelay` 可以被切断：已打开的连接被重置，新连接被拒绝。
- 没有任何生产类增加故障钩子。故障只存在于网络、数据库链路或进程表中。

门禁不需要测试适配器：transport 实现了 Session 动词，provisioner 能跨 Broker 进程收养 worker。worker 的标准错误写入测试台目录下的 `workers.log`，门禁失败时会连同 Broker 日志一起报告。

测试台的 operation 租约为 10 s：worker 是完整的 serve runtime，而恢复在四个 operation 租约后放弃。dispatch 租约为 2 s。工具请求会一直等到工具运行结束，最长十分钟，因此只有 attestation 设了短超时。

门禁只在 Maven profile `fault-gates`（JUnit 标签 `fault-gate`）中运行，默认的 `mvn test` 会排除它们。缺少前置条件时明确失败：打包产物（`-Dqwen.cli.entry`，默认 `<仓库>/dist/cli.js`，其旁需有 `managed-runtime-worker.js`）、`PATH` 上的 Node.js，以及 POSIX 系统。门禁结束时，测试台会杀掉所有 worker，包括被杀 Broker 留下的孤儿进程。

### 3.2 不变量

每个门禁在适用处断言：

- 副作用至多执行一次：以工具写入的标记计数，且代理对该调用至多看到一次 execute；
- 没发生的完成不会被报告：没有 Runtime 的应答时，任何回复和记录都不会显示已结算或已取消；
- 丢失的应答只依据 Runtime 自己对该调用的记录（按 reference 查询）恢复；`UNKNOWN` 执行保持 `UNKNOWN`，直到原 Runtime 给出终态证据或由运维决定；
- 按原始身份查询返回原始结果：记录中的结果等于 worker 按 reference 应答 `status` 的结果。

### 3.3 门禁

| 门禁                         | 故障                                                                                                                                                  | 断言的结果                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FG1 对照                     | 无                                                                                                                                                    | provisioner 确认 worker 健康，服务在绑定变为 `READY` 前对其验证一次。acquire 的 Session 动词携带租约的 token、ID 和 epoch，worker 对每个请求都校验它们，所以复用无需再次验证。调用结算为 `success`，标记只有一行，代理看到一次 execute，按 reference 的 `status` 返回已存储的结果。                                                                |
| FG2 execute 丢失             | worker 执行调用后，`DROP` 或 `RESET` execute 应答                                                                                                     | 派发器再次查询该调用，依据 Runtime 的记录将其结算为 `success`，而不会变成 `UNKNOWN`。相同 key 的重试依据已结算记录应答，不派发任何东西。直接发给 worker 的同一 reference 的 execute 并入原调用，`status` 返回已存储的结果。标记一行，execute 一次。                                                                                                |
| FG2 status 丢失              | execute 应答被丢弃，随后用于恢复的查询应答先被扣住、再被丢弃、再被重置                                                                                | 应答被扣住期间，记录为 `EXECUTING` 且没有结果。被丢弃和被重置的查询不结算任何东西；下一次得到应答的查询将其结算为 `success`。标记一行，execute 一次。                                                                                                                                                                                              |
| FG2 cancel 丢失              | 在 `sleep 5` 命令期间 `DROP` cancel 应答                                                                                                              | cancel 调用失败。worker 确实中止了命令，所以记录依据 execute 应答结算为 `cancelled`。命令尾部从未执行，`status` 返回相同结果。                                                                                                                                                                                                                     |
| FG2 attestation 丢失         | `DROP` 一次验证，或在恢复期限内（3 s operation 租约）`DROP` 全部验证                                                                                  | 一次丢失的应答会被重新证明：同一 worker 第二次验证通过后才 `READY`。全部应答丢失时，warm 可重试地失败，绑定始终没有租约；一旦有应答到达，下一次 warm 证明同一 worker 与同一绑定，而不是另起一个。                                                                                                                                                  |
| FG3 worker 被杀              | 在 `sleep 3` 期间 SIGKILL worker 进程树                                                                                                               | 派发器的存活检查发现 worker 已消失：这一代被标为 `LOST`，记录变为 `UNKNOWN`，对账回答 `409 runtime_broker_execution_evidence_unavailable`。未知调用钉住该放置（#12670），warm 以 `runtime_broker_runtime_lost` 失败。运维决定该调用并释放 Session 后，新一代服务下一次 warm。命令尾部从未执行，只发出过一次 execute。                              |
| FG3 Broker 被杀              | 在认领后（execute 在到达 worker 前被扣住）、发送后（worker 正在执行）或提交前（worker 的应答被扣住）SIGKILL Broker JVM；然后在同一状态上启动新 Broker | 新 Broker 通过状态目录找到 worker，验证一次后收养同一绑定代与租约，不启动自己的 worker。dispatch 租约过期后，相同 key 的重试把记录 fence 为 `UNKNOWN`（`runtime_broker_execution_unknown`），不发送 execute。认领后的情形：对账保持 `UNRESOLVED`（`prepared`），没有标记。发送后或提交前的情形：依据 worker 证据解决为 `success`，命令只执行一次。 |
| FG3 钉住：宿主崩溃（#12670） | SIGKILL Broker 及其 worker                                                                                                                            | 新 Broker 观测到 `NOT_FOUND`，把绑定标为 `LOST`。未结算调用钉住它：`warm` 和 `acquire` 以 `runtime_broker_runtime_lost` 失败，`release` 以 `runtime_broker_execution_active` 失败。对账回答 `IN_FLIGHT`，记录保持 `EXECUTING`。                                                                                                                    |
| FG4 接管                     | Broker A 在两次数据库调用之间被冻结（SIGSTOP），worker 应答被扣住；Broker B 共用数据库与状态                                                          | A 的 dispatch 租约过期后，B 对 worker 验证一次、收养它，并把记录 fence 为 `UNKNOWN`。A 解冻后收到自己的应答：记录保持 `UNKNOWN`，直到 B 依据证据解决它。此后 A 对相同 key 的重试、cancel、get 和对账都只依据已结算记录应答，解冻后向其 Runtime 发出的请求为零。                                                                                    |
| FG4 存储丢失                 | Broker 提交 worker 应答时切断数据库中继                                                                                                               | Broker 只做少数几次连接尝试便停止，`get` 失败而不是报告结果。数据库恢复后，记录仍为 `EXECUTING` 且没有结果。认领过期后，相同 key 的重试将其 fence，对账依据 worker 将其解决。标记一行，execute 一次。                                                                                                                                              |

### 3.4 发现的缺陷与钉住的现状

在分支上首次运行时，FG3 worker 被杀和 FG4 存储丢失失败。两者都是派发器缺陷，现已在 `RuntimeBrokerService` 中修复：

- **已死的 worker 让调用一直处于执行中。** 派发器对每次失败的查询都在 25 ms 后再查一次，并无限期续约认领，因此执行途中死掉的 worker 会让记录一直停在 `EXECUTING`，Broker 则一直轮询一个已死的端点。现在 execute 或查询失败后，派发器会立即检查绑定的存活状态（不论上次检查结果如何），并在应答持续失败时逐步退避到每秒一次。该检查询问 provisioner，后者发现 worker 进程已消失，于是这一代被标为 `LOST`，派发器随即让调用保持 `UNKNOWN`：只有 `READY` 或正在 drain 的代能为调用作答，而 `LOST` 的代对其 Session 仍算活跃。
- **写入失败让派发悬空。** 存储拒绝一次写入时，派发器的回调会静默终止，认领续约也随之停止，但该调用在进程内仍处于已启动状态，所以重试或之后的 start 什么都不做，记录一直停在 `EXECUTING`。更糟的是，写入 Runtime 应答失败一次后，兜底逻辑会写入 `error` 结果，存储的一次抖动就可能把成功的调用记成失败。现在派发器遇到存储故障时会停止续约，交由下一次 start 认领该调用：存活的认领继续执行，过期的认领被 fence 为 `UNKNOWN`。后台不会重试失败的写入。

仍钉住一项现状：

- **#12670。** 一个被证明 `LOST` 且带有未结算执行的代，在该执行被解决之前既不能回收也不能释放。宿主崩溃门禁钉住它，FG3 worker 被杀则展示了出路：运维做出决定，然后启用新一代。#12670 定案后更新这个钉子。

本组门禁初版中的"生产重启"钉子已不复存在：分支的 provisioner 把每个 worker 记录在状态目录中，重启的 Broker 会收养它，FG3 Broker 被杀即为证明。

FG4 存储门禁还钉住：数据库恢复后，没有任何东西重试失败的提交。有上限的重试同样满足 #12748；若将来加入，该断言从 `EXECUTING` 改为已提交的结果。

### 3.5 对开放问题的取舍

1. **CI 位置。** 门禁运行在 `sdk-java.yml` 的 `Hosted no-tool processes / MySQL 8.4 / Java 21` 任务中（#12733）。这条 Java 21 线已经为 Hosted 进程门禁安装、构建并打包 CLI。在那些门禁之后新增一步，在 `packages/sdk-java/runtime-broker` 中以 `-Dqwen.cli.entry=$GITHUB_WORKSPACE/dist/cli.js` 运行 `mvn -Pfault-gates test`，上限 10 分钟。
2. **数据库。** 使用 TCP server 之后的文件型 H2，所有 Broker 进程共用。门禁暂不在 MySQL 或 MariaDB 上运行；它们所在的线已经带有 MySQL 8.4 服务，这项后续工作因此很小。
3. **测试台语言。** 围绕 Broker 服务用 Java 实现，让每个故障都有确定的注入点。TypeScript 故障转移脚本保持独立。
4. **#12670。** 按 §3.4 钉住。

## 4. 验证

在仓库根目录构建好打包产物（`npm run build && npm run bundle`）后，在 `packages/sdk-java/runtime-broker` 中运行：

```bash
mvn -Pfault-gates test   # 14 个门禁，约 1.5 分钟
mvn test                 # 默认测试集，不含门禁
mvn checkstyle:check
```

门禁在分支上经过了针对生产代码的变异检验。下表每个变异单独施加，所列测试均失败：

| 变异                                              | 失败的测试                                                     |
| ------------------------------------------------- | -------------------------------------------------------------- |
| 丢失的 execute 应答直接结算为 `error`，而不再查询 | FG2 execute 丢失                                               |
| 查询失败后派发器跳过存活检查                      | FG3 worker 被杀                                                |
| `LOST` 的代仍被视为能够作答                       | FG3 worker 被杀                                                |
| `claimDispatch` 重新授予过期的 `EXECUTING` 认领   | FG3 Broker 被杀                                                |
| Runtime 应答写入失败后改写为 `error`              | `aFailedResultWriteIsNeverRecordedAsAnError`（单元测试）       |
| 认领续约失败后派发仍保持已启动状态                | `aFailedDispatchRenewalHandsTheCallToTheNextStart`（单元测试） |
| 以上两项同时存在（修复前的代码）                  | FG4 存储丢失                                                   |

## 5. 局限与后续工作

- 信号无法可靠地让 Broker 停在 `claimDispatch` 与 execute 调用之间，即 #12477 修复的那个窗口；该窗口仍由它的单元测试覆盖。FG4 覆盖的是围绕它的进程级接管。
- 门禁需要 POSIX 信号，在 CI 中运行于 Linux。
- 慢应答不等于丢失的应答：工具请求最长等待十分钟，所以门禁不会把应答延迟到超时之后。
- 收养期间 attestation 应答丢失，以及 Session 动词和控制动词上的响应丢失，均未覆盖。
- 后续：在 MySQL 上运行崩溃与接管门禁；#12670 定案后更新钉子。
