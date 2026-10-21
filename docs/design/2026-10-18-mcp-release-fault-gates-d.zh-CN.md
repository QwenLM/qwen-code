# Hosted MCP 故障门禁 FG12d：release 状态格

[English](2026-10-18-mcp-release-fault-gates-d.md) | [简体中文](2026-10-18-mcp-release-fault-gates-d.zh-CN.md)

## 问题与范围

issue #14447 是 #12380 的 Stage F 轮次 FG12：为 Hosted MCP 的两个域 `mcp_configuration` 与 `mcp_operation` 补故障门禁。FG12c 的重启矩阵延后了一格 **`harness-kill-releasing`**，因为继续 `${configurationId}:release` 需要 lifecycle v2 的 close 序列。本切片实现该格。

整仓 Spring/Broker 重启两格仍然拆出。整仓 Spring 重启会替换内存中的 `WorkspaceStorageGuard`，而该守卫在 storage holder 仍被占用时拒绝 `register`；重启后的 Spring 会在到达 Broker release 之前回答 `workspace_unavailable`，无法隔离 owner-release 恢复。FG12d 不新增只替换 Broker 的接缝，也不做可持久恢复的守卫，因此那两格继续阻塞（FG12c 决策 2）。

## 现状

- `HostedMcpRestartFaultGatesIT` 启动打包 Harness、durable worker、真实 stdio MCP server、MySQL、Broker 前置代理与 lifecycle v2；FG12c 的五格已绿。
- lifecycle v2 的 close 序列是 `effects` → `prepare_resources` → `settle_resources`。`HostedMcpSession.closeResources` 在查询或派发 `${configurationId}:release` **之前**提交 `releaseState: releasing`；只有 release settled 之后，它才提交 `drained`、释放 owner 并标记 `released`。
- release 派发合法地先回答 `running`；后续 `mcp-status` 查询把它解析为 `settled`。因此替换 Harness 是通过查询原 operation id 续跑，而不是新造一个 release。

## 门禁账本

| Case                     | 注入                                                                                                | 期望                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-releasing` | 在 `releaseState: releasing` 已提交、且 `mcp-release` 派发被 Broker 代理持住时 SIGKILL 打包 Harness | 替换 Harness 加载同一 `runtimeSessionId` 与同一 lifecycle claim；按原 id 查询并完成 `${configurationId}:release`；恰好一次 `mcp-release`；没有第二次 `mcp-configure` 或 `mcp-invoke`；最终 `releaseState` 只在线上应答 settled 之后才为 `released`，绝不伪造 settled。结论性的 `mcp-status` 应答被持在代理内：它被扣住期间记录保持 `releasing`、`settle_resources` 尚未应答；只有应答交付之后才出现 `drained`/`released`。 |

## 决策

1. **扩展现有类，不新增类。** 该格复用 FG12c 的 boot 与夹具，因此“新增一个类”的 fork 预算六处账目不变。证据按 case 分目录：FG12c 留在 `target/fg12-cases/fg12c/`，FG12d 落在 `target/fg12-cases/fg12d/`。
2. **直接驱动 lifecycle v2。** Java 协调器不是本门禁的主体。测试用 `beginWorkspaceLifecycle(..., protocolVersion = 2)` 准入一个 CLOSE 操作并 claim 它，然后用同一 authority 依次发送三个阶段；在 `effects` 之后，它通过更新 `ma_session_head.phase` 代替协调器完成 DRAINING 迁移；协调器的 effects receipt 与时间戳未覆盖（协调器不在范围内）。
3. **持住 release 派发，在 `releasing` 之后杀进程。** 代理在转发前停住 `mcp-release`；测试先断言数据库记录为 `releasing` 且派发在飞，再 SIGKILL Harness。放开 hold 后，原派发到达 Runtime 并登记该操作，替换 Harness 的查询才有可结算的对象。
4. **带原 claim 重载。** load 携带 `lifecycleProtocolVersion: 2` 与原 `{operationId, claimGeneration}`；替换 Harness 在 release 仍为 `running` 时有界重试 `settle_resources`，settled 查询后提交 `drained`/`released`。
5. **先断言线上序列，再断言状态。** 恰好一次 `${configurationId}:release` 的 `mcp-release`、至少一次同 id 且 settled 的 `mcp-status`（有界重试可能发多次）、基线之后没有 `mcp-configure`/`mcp-invoke`、一次 `mcp.start`、`runtimeSessionId` 不变。只有该序列成立后才断言 `releaseState: released`。若 release 始终不 settle，路由回答 503，记录停在 `releasing`/`drained`；有界重试会失败，而不是接受伪造的 `released`。
6. **结论性应答用 hold 见证，不做事后推断。** 线上出现一次 settled 查询只能说明该应答存在过，不能说明状态等到了它。代理因此在 Broker 产出 settled `mcp-status` 之后扣住这条应答；扣住期间测试断言记录仍为 `releasing`、close 路由尚未应答，放开后才期待 close 完成且记录为 `released`。release 派发本身不能作为见证：它合法地先回答 `running`。

## 夹具设计

- 复用现有 rig：打包 Harness（`hosted-harness` profile、lifecycle v2 环境）、durable worker、`hosted-mcp-fault-process.mjs`、MySQL、Java Broker 代理与 lifecycle v2。
- 测试直接种 session 行，因此在准入 close 前把 `ma_session.tool_profile` 钉成 `hosted-workspace-mcp/1`；生产中的 Harness create 路由做同样的事。
- 代理除 hop-by-hop 头外全量透传，因此 `X-Qwen-Lifecycle-Operation-Id` 与 `X-Qwen-Lifecycle-Claim-Generation` 能到达 Broker；不新增 lifecycle 头白名单。
- 证据：`target/fg12-cases/fg12d/<tenant>/` 下的 `proxy.json`、`wire.json`、`harness.log` 与 `processes.jsonl`。workflow 已上传 `target/fg12-cases/`，新子目录自动包含。

## 预算

不新增类，因此六处 fork 账目不变：类 `@Timeout` 600 s、共享 healthy 与 CI fork（当前值见 `hosted-process-ci.test.js`）及其字面钉点、本地 `hosted-mcp-gates` profile（`**/HostedMcp*IT.java`）、workflow 注释、artifact 根 `target/fg12-cases/`。

JDK 21 实测（加入应答 hold 之后）：六格整类在 MySQL 8.0.46 上 32–37 s（两次）、在 MariaDB 10.11 上 40.5 s，release 格 6.0–7.0 s。FG12c 的 49 s 余量本就按 2×（约 98 s）预算，整类仍在该余量内；共享 healthy 和 CI fork 均不动。当前 `main`（含 #14618）两种 schema 均可校验。artifact 根已覆盖 `fg12d`，无需改上传路径或元测试。

## 验收

- `mvn -q -DskipTests test-compile checkstyle:check` 干净。
- `HostedMcpRestartFaultGatesIT` 在 JDK 21 + MySQL 8.0.46 与 MariaDB 10.11 上 6/6 绿；新格在杀进程前先自证注入（数据库 `releasing` 与在飞的 `mcp-release`）。
- `fg12d` 证据显示一次 `mcp-release`、至少一次同 id 且 settled 的 `mcp-status`、一次 `mcp.start` 与一次 `mcp.exit`、最终 `released`，且没有第二次 configure/invoke。
- settled 的 `mcp-status` 应答被扣住期间，记录仍为 `releasing`、`settle_resources` 尚未应答；两者只在应答交付后才推进。
- 本切片不跑 TS 变异见证（按 FG12d 任务书）。剩余风险：绿依赖 release 在 60×1 s 重试窗口内 settle；更慢的 Runtime 会让门禁变红，而不是带着未结算记录变绿。
- 整仓 Spring/Broker 重启在 `WorkspaceStorageGuard` 拒绝被占用 storage 期间继续拆出，不用第二套 rig 伪造。

## 待决问题

- 在 release 派发到达 Runtime **之前**杀进程，会走“同 operation id 重派发、查询未命中”的分支。本门禁故意让原派发落地以钉住查询路径；pre-dispatch 变体是后续候选。

## 后续格：派发前取消

#14880 第 2 项要求一个派发前取消：取消到达时 `mcp_operation` 处于 `run.execution = intent`，结算为 `not_started_proven` 且零副作用。该项记录说，由于公开路由会直接开始派发，没有种行 helper 就到不了这个窗口。实际上通过受支持的路由就能到达：`invoke()` 先提交 `intent`，再 acquire owner（`POST …/tool-sessions:acquire`），之后才提交 `dispatch_started`。cancel 路由不受在飞 invoke（`mcpBusy`）阻挡，派发前取消分支也从不联系 Broker。

| Case                     | 注入                                                                                                                          | 期望                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-before-dispatch` | 目标 `mcp_operation` 在库中仍为 `intent` 时，代理扣住到达的第一个 owner acquire；测试经 `…/mcp/operations/{id}/cancel` 取消它 | invoke 仍被扣住时，cancel 已回答 `settled` + `managed_mcp_cancelled`；记录为 `cancelled`/`not_started_proven`、`cancelRequested: true`、无 `resultRef`。放开 acquire 后，原 invoke 回答同一视图，同 id 重试与 status 读取亦然。被扣的 acquire 之后没有任何 MCP 控制请求（`mcp-invoke`、`mcp-cancel`、`mcp-status`）到达 Broker，fixture 不记录副作用，也没有第二个 server 启动。 |

决策：

1. **扣 acquire，不种行。** 种一条 `intent` 行会绕过记录写入方与 authority 的 revision 链，而它们正是被测代码。扣 acquire 让每次写入都由 Harness 完成；代理只读取库中记录来决定扣哪一次 acquire。intent 提交之前 `refresh()` 发出的 acquire 会放行；hold 只生效一次，所以（若派发前分支被删）cancel 需要的 acquire 会被转发。
2. **断言被扣 acquire 之后的线上序列。** 即使续跑的 invoke 忽略本地证明、转而询问 Runtime，它仍会回答 `managed_mcp_cancelled`，因为 `accept()` 会先重读记录。只有"被扣 acquire 之后没有 `mcp-status`"能抓住这一点，所以门禁断言其后完全没有 MCP 控制请求。

变异见证，每个都重建进该格实际运行的 bundle（`hosted-mcp-session.ts`）：

| 变异 | 改动                                       | 结果                                                                                                                       |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| M1   | `cancel()` 跳过其 `intent` 分支            | 红：cancel 去 acquire，发出 Runtime 从未登记过的原生 `mcp-cancel`，回答 `outcome_unknown` 而不是 `managed_mcp_cancelled`。 |
| M2   | `invoke()` 在 owner acquire 之后不重读记录 | 红：在已取消记录上提交过期的 `dispatch_started` 被拒，续跑的 invoke 回答 503。                                             |
| M3   | `invoke()` 重读记录但忽略本地证明          | 只在线上序列变红：续跑的 invoke 仍回答 `managed_mcp_cancelled`，但被扣 acquire 之后出现了 `mcp-status`。                   |

每个变异都重建进 `dist/cli.js` 并只跑该格；之后重建的未变异对照为绿。

预算：该格在八格整类运行（94.5 s，JDK 21、MySQL 8.4.6、Linux aarch64）中实测 9.1 s，按 2× 计入共享 healthy 18 s（9871 → 9889 s），因此 `hosted-harness-mysql` fork 移到 10489 s，185 分钟的 Verify step 仍能包住（fork 加包裹共 11089 s）；job 上限保持 288。`hosted-mcp-gates` 的 1200 s profile 与 artifact 根 `target/fg12-cases/fg12d/` 不变。

未覆盖：configuration 的派发前取消（configuration 只在关闭期间由 `reconcileEffects()` 取消）与 MCP 工具调用（工具调用走普通工具生命周期，不经 `mcp_operation`）。

## 后续格：跨 Spring 重启的 R1-1

#14880 第 3 项，也是 #14447 FG12d 行里的 R1-1 那一格：在一次 lifecycle v2 关闭中，drain 回执提交之后，owner 释放在到达 Broker 之前被拒；随后通过重启 Spring 替换 Broker。#13109 的真实栈轮次记录过：此后 detach 每次都回答 503、storage holder 一直保留，因为重启后的 Broker 以 `runtime_reconciliation_required` 拒绝释放。

**记录在案的阻塞点在 rig，而不在守卫。** 上文"问题与范围"和 FG12c 决策 2 记录说：整仓 Spring 重启会重新登记 storage，而 `WorkspaceStorageGuard` 在 holder 仍被占用时拒绝登记。生产环境启动时从不重新登记：`register` 是运维步骤（`WorkspaceStorageRegistrationMain`），登记记录在 `ma_storage_owner` 中，挂载根来自配置。这次拒绝来自 IT 自己的 `startSpring()`，它每次启动都会登记 storage 并插入 Workspace 行。改为只种一次，就能在不改产品代码的前提下做到重启。

**R1-1 在 `main` 上已不再复现。** 被替换后的 Broker 没有该 Session 的本地上下文，所以 Harness 的重试会走到 `releasedSession`。此时 Session 行仍为 READY，binding 仍为 READY 且 generation 相同，lifecycle v2 关闭也已把 Harness 标为 draining。#13673 在这条路径上加的分支（`RuntimeBrokerService` 中 managed-context 的 `releaseSavedSession` 分支）会直接释放已保存的 Session。因此 #13109 评审建议的重试（先 acquire 再 release）对这条路径已无必要。

| Case                              | 注入                                                                                                                                 | 期望                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner-release-refused-restarted` | `prepare_resources` 之后，代理在转发前以 503 拒绝 owner 释放（`POST …/tool-sessions/{id}:release`）；随后重启 Spring 及其内嵌 Broker | 被拒的 `settle_resources` 回答 503 `workspace_lifecycle_resources_unsettled`，此时记录为 `drained`、holder 仍占用、binding 与 Runtime Session 为 READY；重启不改变其中任何一项。之后有界重试 `settle_resources` 成功；重启后代理恰好只看到一次调用，即 owner 释放，回答 200，没有 acquire，也没有任何 MCP 控制。holder 清空，记录为 `released`，Runtime Session 为 RELEASED；`mcp-release`、`mcp.start`、`mcp.exit` 各一次。 |

决策：

1. **在 JVM 内重启，而不是杀掉 JVM。** Broker 的 `close()` 只取消内存中的工作、不写库，durable local provisioner 关闭时也不会终止 worker，所以重启后的 Broker 看到的库状态和存活 worker，与被杀掉的 Broker 留下的完全相同。这正是 R1-1 所需的状态；单独起一个控制面 JVM 只会多一个夹具，不会改变这一点。
2. **只容忍写者租约，其他一律不容忍。** 本格的 Session 写者租约为 3 s，而 Spring 停机约 3 s，所以在 Harness 重新拿到租约之前，第一次重试可能回答 `workspace_lifecycle_resources_unsettled`（写者未激活）。那次尝试不会向 Broker 发送任何请求。循环只接受这个错误码和 `hosted_turn_active`，重启后的线上断言是精确的。

变异见证：关掉 #13673 的分支（`if (false && record.isActive() && …isManagedContext() …)`）后，该格变红：每次重试都会转发 owner 释放，重启后的 Broker 回答 503，holder 一直被占用，正是 #13109 记录的 R1-1 症状。共 3 次运行，全部在恢复断言处变红；恢复后的对照为绿。

预算：该格在九格整类运行（103.4–103.8 s，两次，JDK 21、MySQL 8.4.6、Linux aarch64）中实测 11.4–11.9 s，单独连续运行 5 次均通过。按 2× 计入共享 healthy 24 s（10050 → 10074 s），因此 `hosted-harness-mysql` fork 移到 10674 s，188 分钟的 Verify step 仍能包住（fork 加包裹共 11274 s，余量 6 s）；job 上限保持 291。下一个加入该 fork 的格必须同时提高 Verify step 与 job 上限。

未覆盖：在 owner 释放过程中杀掉 Broker（请求已到达 Broker，但它在应答前死亡）、`drained` 之前的 Spring 重启（FG12c 拆出的 Spring 格；同样的"只种一次"改动可以解开它们）、以及跨主机恢复。
