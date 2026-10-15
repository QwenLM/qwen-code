# 按 Workspace 常驻的 Managed Tool Runtime

[English](2026-10-15-managed-workspace-resident-runtime.md) | [简体中文](2026-10-15-managed-workspace-resident-runtime.zh-CN.md)

状态：4.1 节已由 PR1 实现，其余各节仍是提案。修订 1 已作为 PR0 合入。跟踪 issue：
[#14211](https://github.com/QwenLM/qwen-code/issues/14211)。属于 Managed Agent 提案
[#12380](https://github.com/QwenLM/qwen-code/issues/12380)。
代码引用基于 `main` @ `f87698b8c6`。`main` 上的 Java 格式化改动之后，行号已在该版本上重新核对。

修订 2（根据 [#14214](https://github.com/QwenLM/qwen-code/pull/14214) 的 review）：

- PR1 复用已有的 provisioner 能力方法，并保留 kind 身份判断。
- 空闲回收提前到 workspace isolation 之前。
- workspace isolation 现在与一个硬性的 generation 预算一起交付。
- 依赖 isolation key 推导 Harness 归属的路径被列入 PR3 范围。
- keep-warm 推后。

## 1. 问题

Managed Tool Runtime（`qwen managed-runtime-worker`）由 Runtime Broker 按 binding
generation 放置。绑定 Workspace 的 Session 要求部署使用 `local-process`
provisioner 加 `session` isolation，所以每个 Hosted Session 都有自己的 worker。这个
worker 能跨该 Session 的多个 Turn 存活，Broker 重启后也能被接管，但是：

- 同一 storage 上的第二个 Session 无法复用它，每个新 Session 都要启动自己的 worker，
  第一次工具调用要等待冷启动中未被并行模型推理遮掉的那部分时间；
- 没有任何机制在 Turn 需要之前启动 worker；
- 没有任何机制停止空闲的 worker。从未关闭的 Session 会一直占着自己的 worker，
  server README 要求运维为由此带来的进程、内存和 state 目录增长预留预算。

本设计让 Tool Runtime **按 Workspace storage 常驻**：每个 `(tenant, storage)`
一个长期运行的 worker，由该 storage 上所有绑定 Workspace 的 Session 共享，按需提前启动，
空闲时带停止证据退役。

## 2. 现状

在 `main` @ `f87698b8c6` 上核实：

| 方面                                 | 行为                                                                                                                                                                                                                                                                                                                                          | 引用                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 绑定 Workspace 的 Session 的隔离方式 | Workspace files 要求 Session 隔离的 `local-process` Broker 并配置 Workspace mounts；child Workspaces 还要求 durable local worker。`isolation-class` 默认为 `session`。                                                                                                                                                                        | `ManagedAgentProperties.java:154-169`、`:200-210`、`:892`；`WorkspaceRuntimeResolver.java:35-38`                                                                                    |
| 放置身份                             | workspace isolation 没有 isolation key，一个 binding 服务完整 scope（tenant、Workspace、generation、挂载根、capability digest、kind、storage）。session isolation 按 Harness Session ID 划分 binding。`cwdRelative` 不属于放置身份。                                                                                                          | `managed-runtime-broker-service-core.md`；`JdbcRepositorySupport` 的 request key                                                                                                    |
| Harness 归属                         | 多条路径根据 binding 的 isolation key 推导"这属于哪个 Harness Session"，因此只适用于 session isolation：<br>• Harness 准入封锁会跳过非 Session 的 scope。<br>• close 只枚举 isolation key 等于正在关闭的 Session 的 binding 上的执行。<br>• Hook、MCP 和后台任务的原 owner 恢复与释放依赖它。<br>• 恢复维护按 isolation key 检查 close 封锁。 | `JdbcRuntimeBindingRepository.java:912`；`JdbcToolExecutionRepository.java:110`；`RuntimeBrokerService.java:681`、`:1989`、`:3754`、`:3785`                                         |
| 一个 worker、多个 Runtime Session    | boot v2 worker 为每个 Runtime Session 安装一份 context，每个 Session 在自己的有效目录里运行。后续的 tool turn 使用新的 Runtime Session ID。                                                                                                                                                                                                   | `2026-09-26-managed-context-worker.md`；`2026-09-26-managed-workspace-execution.md`                                                                                                 |
| Warm                                 | 只有按需 warm。Java 在 Turn dispatch 时 warm 该 Session 的 Runtime，与模型推理并行。Harness 在为 tool turn、Hook 执行或文件回退 acquire Runtime Session 之前调用 Broker 的 `/runtimes:warm`。没有任何机制提前 warm。                                                                                                                          | `HarnessCoordinator.java:349`、`:863`；`RuntimeBrokerHttpServer.java:158`；`hosted-workspace-tool-turn.ts:1599`                                                                     |
| Session close                        | `SessionLifecycleCoordinator` 调用 `closeWorkspace`，再执行 `drainHarnessSession`。它只枚举 `isolation_class = 'session' AND isolation_key = <harness session>` 的 binding，对其 drain，并在 `RELEASED` 之前要求 `stopDrained` 证据。                                                                                                         | `SessionLifecycleCoordinator.java:410`、`:441`；`EmbeddedRuntimeBroker.java:298`；`RuntimeBrokerService.java:303`、`:379`、`:416`、`:438`；`JdbcRuntimeBindingRepository.java:1117` |
| 停止 worker                          | `LocalProcessRuntimeProvisioner.stopDrained` 只停止 Workspace profile 下已 drain、带 managed-context、Session 隔离的 binding。持久模式下 `release` 什么都不做。                                                                                                                                                                               | `LocalProcessRuntimeProvisioner.java:292`、`:309`                                                                                                                                   |
| 停止准入                             | `WorkspaceExecutionStore.canStopDrained` 和 `RuntimeAdmission.requireStoppedRelease` 要求 `local-process` 加 Session 隔离，并按 binding 的 isolation key 匹配 storage holder。                                                                                                                                                                | `WorkspaceExecutionStore.java:442`；`RuntimeAdmission.java:42-48`                                                                                                                   |
| drain 期间的放置                     | `requireRecoverablePlacement` 把同 tenant、同 storage/目录/Workspace 上的 `DRAINING` binding 视为阻塞，以不可重试的 `409 runtime_placement_recovery_required` 拒绝新的 generation。                                                                                                                                                           | `JdbcRuntimeBindingRepository.java:1964`；`RuntimeBindingRecord.java:368`                                                                                                           |
| binding 级 drain                     | `retireStorageBinding` 在 storage fence 下 drain 一个确定的 binding generation（Workspace 迁移在用）。                                                                                                                                                                                                                                        | `RuntimeBrokerService.java:393`                                                                                                                                                     |
| 空闲回收                             | 对存活的 binding 没有。retention 只清理过期的 `FAILED`/`RELEASED` 行。                                                                                                                                                                                                                                                                        | `runtime-broker-jdbc-retention.md`                                                                                                                                                  |
| worker 侧保留                        | context installation 在 worker 生命周期内一直保留。executor 的 `closedSessions` 和 provider 的已释放 Session 占位记录每个 Runtime Session 各增长一小条；provider 让 8 个已释放 Session 保持可答。                                                                                                                                             | `managed-context-envelope.ts:353`；`managed-runtime-tool-executor.ts:354`；`managed-runtime-provider-worker.ts:124`                                                                 |
| close 证据                           | reliable close 只有在准入已封住、原写入者、Session、worker 和 holder 都已结算后才算完成。目前这意味着原 worker 进程已停止。                                                                                                                                                                                                                   | `workspace-session-reliable-close.md`                                                                                                                                               |
| Provisioner 能力                     | `RuntimeProvisioner` 上已经有 `kind()`、`supportsDrainedStop()` 和 `supportsStartupRecovery(handle)`。kind 还以字符串字面量 `"local-process"` 出现在 14 个生产代码位置，其中 13 个在 `managed-agent-server`，它看不到包私有的 `LocalProcessRuntimeProvisioner.KIND`。                                                                         | `RuntimeProvisioner.java:16`、`:90`、`:100`；`LocalProcessRuntimeProvisioner.java:37`                                                                                               |
| Java CI                              | `sdk-java.yml` 只在定时任务和手动 dispatch 时运行，修改 `packages/sdk-java` 的 pull request 不会跑 Java 矩阵。                                                                                                                                                                                                                                | `.github/workflows/sdk-java.yml`                                                                                                                                                    |

## 3. 目标与非目标

目标：

- 空闲 worker 退役时，带与今天 reliable close 相同的停止证据。
- 绑定 Workspace 的 Session 可以放在 workspace isolation 的 binding 上，
  同一 storage 上的所有这类 Session 共享一个 worker generation，且每个 generation
  准入的 Runtime Session 数量有上限。
- worker 可以在第一次工具调用需要之前启动。
- 每项改动都在配置开关之后，默认配置保持现有行为。

非目标：

- 改变"一个 worker 进程就是一个 binding generation"这一不变量。
  attestation、seed、incarnation、内存调用记录和 `UNKNOWN` 规则全部保持不变。
- 远端放置（SSH、反向连接的 worker），或替代 `static` 的注册型常驻 worker。
  两者都需要 worker 侧支持 lease 注册，并各自单独设计。
- 改变默认隔离类别，或改变 session isolation 的 close 语义。
  session isolation 仍是默认值，它唯一的变化是可选开启的空闲回收（4.2）。
- 同一 storage 上并发执行 tool turn。`ma_storage_owner` 继续串行化。

## 4. 设计

"常驻"是 binding 生命周期的属性，不是进程身份的属性。
workspace isolation 的 binding generation 只创建一次，被共享，比任何单个 Session 活得更久，
只有通过显式的、带证据的退役才结束。它指向的 worker 仍然是恰好一个进程，
对应一个 seed、一个 lease 和一份内存调用记录。

### 4.1 Kind 身份与隔离策略（PR1）

PR1 是不改变任何行为的重构，不新增 provisioner 能力方法：
已有的 `kind()`、`supportsDrainedStop()` 和 `supportsStartupRecovery(handle)`
已经能回答本工作需要的能力问题，再加平行的方法只会重复。

**Kind 身份**。询问"这个 binding 是哪个 provisioner 放置的"或"配置的是哪个 provisioner"
的判断保持为身份判断。PR1 把 `LocalProcessRuntimeProvisioner.KIND` 改为 public，
并用它替换以下位置的 `"local-process"` 字面量：

- `ManagedAgentProperties`（`:158`、`:204`、`:885`）；
- `EmbeddedRuntimeBroker`（`:391`、`:405`、`:485`、`:501`）；
- `RuntimeRecoveryCoordinator:31`、`WorkspaceRecoveryCommand:53`、
  `WorkspaceRuntimeResolver:36`、`WorkspaceRuntimeTransport:295`、
  `WorkspaceExecutionStore:445`、`WorkspaceOperatorRecoveryStore:254`；
- `RuntimeAdmission:46`。

已经使用常量的比较（`RuntimeBindingRecord.java:375`、
`JdbcRuntimeBindingRepository.java:1987`、`LocalRuntimeStore`）保持不变。

**隔离策略**。"Workspace 执行使用 session isolation"这条规则被独立写在 5 个地方：

| 位置                                      | 决定的事情               |
| ----------------------------------------- | ------------------------ |
| `ManagedAgentProperties.java:159`         | Workspace files 配置准入 |
| `WorkspaceRuntimeResolver.java:37`        | Workspace mount 解析     |
| `WorkspaceExecutionStore.java:446`        | drained stop 准入        |
| `RuntimeAdmission.java:47`                | stopped release          |
| `LocalProcessRuntimeProvisioner.java:311` | `stopDrained`            |

PR1 让它们都经过同一个策略 `WorkspaceExecutionProfile.admitsIsolationClass`，
该策略仍然只允许 `session`，这样 PR3 只需在一处修改规则。
child Workspaces（`ManagedAgentProperties.java:205`）保留自己显式的 Session 要求（4.3）。
按 isolation key 推导 Harness 归属的检查不属于这个策略，PR1 不碰它们，由 PR3 重新建立归属关系。

### 4.2 空闲回收（PR2）

`RuntimeIdleReaper` 退役 provisioner 支持 drained stop 的空闲 managed-context binding。
交付时这指的是 session isolation 的 Workspace binding；workspace isolation 的 binding 在 PR3
落地后加入。它不依赖 PR3，也不依赖待确认问题 1，并且修复了今天每个 Session 的空闲 worker
无限增长的问题。它默认关闭（`idle-retirement.enabled=false`），所以默认配置保持现有行为。

回收器用轮转游标分页扫描 `READY` binding，形态与 `RuntimeRecoveryCoordinator` 相同，
并取同一个 binding 操作 claim，因此在同一个 binding 上永远不会与恢复并发运行。

**回收条件**。按数据库时间判断，以下全部满足：

- 没有活跃的 Runtime Session；
- 没有未结算的执行，包括后台任务的 `:process` 行；
- 本 generation 没有 storage holder；
- 没有 drain 请求；
- 没有后续恢复可能需要的 Harness 侧 pin。PR2 先枚举所有会 pin 住某个 binding
  generation 的记录（Hook 原 owner pin、MCP 连接记录、后台 `child_run` 与 Monitor 记录、
  publication 引用），任何未结算的 pin 都视为不可回收；
- 空闲至少 `idle-ttl`。PR2 先核实 `ma_runtime_binding.last_active_at`
  是否在 Runtime Session 释放和执行结算时维护；如果没有，就在这些状态迁移时维护该列，
  而不是另加第二个时钟。

**与准入的竞态**。检查"没有活跃 Runtime Session"和设置退役 fence 必须在同一个事务中，
在 Runtime Session 准入已经会取的 binding 行锁下完成。此后该 binding 上的准入以可重试错误码拒绝。
因此回收器永远不会释放 Turn 正在使用的 Runtime Session，也就不需要中止路径。

**退役 fence 与可重试应答**。PR2 记录 binding 退役的原因（`idle`，PR3 再加上 `budget`），
与现有的 close、丢失和人工恢复路径分开。这需要改表结构，按 managed schema 合并的规则进行。
在 fence 已设置期间，以及 binding 因这些原因处于 `DRAINING` 期间：

- 在该 binding 上 acquire，以及在同一 storage 上的新放置，都返回可重试的
  `503 runtime_placement_retiring`，而不是今天不可重试的
  `409 runtime_placement_recovery_required`；
- Java 和 Harness 两侧的 warm、acquire 调用方在现有期限内对该错误码带退避重试；
- drain 回执提交 `RELEASED` 之后，下一次 warm 创建 generation + 1。

close、丢失、人工恢复和停止失败的 drain 仍返回不可重试的错误。

**停止**。退役复用 `drainBinding` → `stopDrained` → drain 回执 → `RELEASED`。
停止失败或未确认时，binding 保持 `DRAINING` 并带退避重试，与 reliable close 一致。
发现 worker 已不存在时转入现有的丢失路径。退役本身从不制造丢失证据，
也从不在原 generation 未结算时启动替代进程。

**session isolation**。在现有规则下，退役一个仍未关闭的 Session 的空闲 worker 是安全的：

- 该 Session 的下一个 Turn 通过普通 warm 路径创建 generation + 1；
- 它之后的 close 会枚举到两个 generation，而被退役的那个已经带有 drain 回执。

### 4.3 workspace isolation 与 generation 预算（PR3）

PR3 只在待确认问题 1 获得维护者认可后才开始。

#### 配置

在同时满足以下条件时，`qwen.managed-agent.runtime-broker.isolation-class=workspace`
（`QWEN_MANAGED_AGENT_RUNTIME_ISOLATION`）可以与 Workspace files 一起使用：

- provisioner 为 `local-process`，且 `durable-local-process=true`、支持 `supportsDrainedStop()`；
- 已开启空闲回收并配置了 generation 预算。配置校验会拒绝没有它们的 workspace isolation，
  因此不会有部署在 worker 侧增长无上限的情况下运行共享 worker。
- `child-workspaces-enabled=false`。child Workspace 的 merge 依赖已关闭的 child
  停止它自己的 worker，所以二者保持互斥。

默认值仍是 `session`。该设置只对新的放置生效。
已有的 session isolation binding 保留其保存的请求，在各自 Session close 时或通过空闲回收退役。
如果某个 Session 的下一个 Turn 解析出新的 scope，它会在共享 binding 上拿到一个新的 Runtime Session。
resolver 契约本来就允许这样做，因为 scope 变化本就要求新的 Runtime Session 身份。

#### 放置与 storage 占用

resolver 为同一 storage 上每个绑定 Workspace 的 Session 构造相同的请求，
所以 `findOrCreate` 会把它们收敛到同一个 binding generation。storage 占用不变：
`ma_storage_owner` holder 仍按 Runtime Session 持有，同一 storage 上的第二个 Session
会收到可重试的 `workspace_busy`，直到第一个 Runtime Session 释放。
这就是今天的串行化方式，只是 worker 现在被共享了。

#### 没有 isolation key 时的 Harness 归属

workspace isolation 的 binding 没有 isolation key，所以每条从 isolation key 推导所属
Harness Session 的路径，都必须改为从 Runtime Session 或执行记录推导：

| 路径                                                                                           | 修改                                                                                   |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Harness 准入封锁（`JdbcRuntimeBindingRepository.java:912`）                                    | 检查 Runtime Session 所属 Harness Session 的 close 封锁，而不是跳过非 Session 的 scope |
| close 时枚举执行（`JdbcToolExecutionRepository.java:110`）                                     | 在 workspace isolation binding 上按 `harness_session_id` 枚举，而不是拒绝              |
| Hook/MCP/后台任务的原 owner 恢复与释放（`RuntimeBrokerService.java:681`、`:1989`）             | 通过 Runtime Session 记录匹配 owner，而不是 binding 的 isolation key                   |
| 恢复维护的 close 封锁（`RuntimeBrokerService.java:3754`、`:3785`）                             | 按 Runtime Session 应用                                                                |
| 停止准入（`WorkspaceExecutionStore.canStopDrained`、`RuntimeAdmission.requireStoppedRelease`） | 按 `(binding, generation, runtimeSessionId)` 匹配 holder 和 Runtime Session            |

PR3 同时让 4.1 的隔离策略在该配置下允许 `workspace`。

#### Session close 拆成释放与退役

关闭一个 Session 不能停掉其他 Session 正在用的 worker。PR3 把今天的 close 拆成两个操作：

1. **Session 释放**。在现有的永久 tenant/Harness Session drain fence 下运行，
   该 fence 通过上面重新建立归属的准入路径生效。它枚举正在关闭的 Session 在
   workspace isolation binding 上的 Runtime Session（在 `ma_runtime_session`
   上新增一个按 Harness Session 查询的接口），对每个活跃的 Runtime Session：
   1. 发送 provider release；
   2. 发送 activation release，并等待原 worker 确认。worker 会 drain 该 Session 的后台任务，
      并报告已没有已准入的调用；
   3. 有条件地清除原 storage holder；
   4. 记录 `RELEASED`。

   该 Session 有未结算或 `UNKNOWN` 的执行时，与今天一样阻塞完成。binding 保持 `READY`，供其他 Session 使用。

2. **binding 退役**。即 PR2 的退役路径。只有空闲回收、generation 预算或显式的
   storage 退役会走到这里，单个 Session 的 close 永远不会。

session isolation 的 binding 保持今天的 close 不变。

**close 证据（决策，待确认问题 1）**。对于 workspace isolation 的 Session，
reliable close 以原 worker 的 activation release 确认加上 holder 释放作为完成条件，
而不是以 worker 进程停止为条件。理由：

- W0c-3 已经把同一个确认当作释放 storage holder 的条件。
- worker 进程死亡也同样不能证明逃逸的子孙进程已停止（W0e-2/W0e-3）。

如果原 worker 无法确认（binding `LOST`、lease 不可用），Session close 回退到今天的规则：
等待 binding 级的停止或丢失证据，否则保持 `recovery_blocked`。
需要按 Session 取得进程停止证据的部署继续使用 `session` isolation。
archive、delete 和 unarchive 继承该 Session 隔离方式所提供的 close 证据。

#### Generation 预算

共享 worker 会累积按 Runtime Session 计的状态：installation、已关闭 Session 的占位记录和
`closedSessions` 每个 tool turn 各增长一条。只在空闲点退役，在持续使用下无法限制这种增长，
因为急切到来的后继准入可以让该 generation 永远等不到空闲。

因此预算在准入时强制执行。满足以下任一条件时，generation 达到预算：

- 已准入 `generation-budget.max-runtime-sessions` 个 Runtime Session；
- 存活时间超过 `generation-budget.max-age`。

此时立即设置 PR2 的退役 fence，原因为 `budget`，即使仍有活跃的 Runtime Session。之后：

- 该 generation 不再准入新的 Runtime Session，调用方收到可重试的 `runtime_placement_retiring`；
- 已准入的工作按现有的不中止和 `UNKNOWN` 规则完成；
- 最后一个活跃 Runtime Session 释放后，退役流程执行 drain、带回执停止并提交 `RELEASED`；
- 下一次准入创建 generation + 1。

这样，worker 侧的增长受每个 generation 的准入预算约束。

存活时长上限不是进程寿命上限。永不释放的 Runtime Session（例如一直存活的后台任务）
会让它的 generation 存活超过 `max-age`。这种情况需要显式的运维或资源压力策略
（待确认问题 2），而不是宣称有内存上限。由于 storage holder 本来就串行化同一 storage
上的各个 Session，等待退役最多只比等待 `workspace_busy` 多一次冷启动。

### 4.4 Session 创建时 warm（PR4）

绑定 Workspace 的 Session 创建提交后，控制面通过现有 resolver 异步调用现有的
`warm(sessionId)`。它只做放置：从不 acquire Runtime Session、不安装 context、不执行任何操作，
所以 actor 授权仍像今天一样在 acquire 时检查。

- 在 session isolation 下，它会在第一个 Turn 之前启动该 Session 的 worker。
- 在 workspace isolation 下，如果该 storage 的 binding 已经 `READY`，它什么都不做。

此时还没有 Turn，所以不发公开事件。Turn 时的 warm 及其 `environment.*` 事件保持不变。

keep-warm（运维按 storage 固定的常驻 worker）推到后续工作（第 11 节）：
在没有测量数据之前，它只是把 README 的预算负担变成一个开关，而不是消除它。

### 4.5 配置汇总

所有配置项均为提案，所有行为变化默认关闭。

| 配置项（`qwen.managed-agent.runtime-broker.`）             | 默认值                                                  | 切片 |
| ---------------------------------------------------------- | ------------------------------------------------------- | ---- |
| `idle-retirement.enabled`                                  | `false`                                                 | PR2  |
| `idle-retirement.idle-ttl`                                 | 待测量                                                  | PR2  |
| `idle-retirement.scan-delay`、`idle-retirement.batch-size` | 与恢复扫描同样有界（5 s，8）                            | PR2  |
| `isolation-class`（已有）                                  | `session`；新增允许 `workspace` 与 Workspace files 同用 | PR3  |
| `generation-budget.max-runtime-sessions`                   | 未设置；使用 workspace isolation 时必填                 | PR3  |
| `generation-budget.max-age`                                | 未设置；使用 workspace isolation 时必填                 | PR3  |
| `session-create-warm`                                      | `false`                                                 | PR4  |

时长遵循现有的单位规则，必须写后缀。

## 5. 决策与理由

| 决策                                                             | 理由                                                                                                             | 被否决的方案                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 让 binding 常驻，而不是让进程常驻                                | 保留 seed、attestation、incarnation 和 `UNKNOWN` 规则，这些已经过 W0e 物理验证。                                 | 一个长期进程接受多个 lease 并持久化调用记录：要重写恢复模型，还需要持久回执存储。             |
| 复用已有能力方法；kind 判断保持为身份判断                        | `supportsDrainedStop()` 和 `supportsStartupRecovery()` 已经存在；其余判断问的是哪个 provisioner 放置了 binding。 | 新增平行的能力方法：与已有方法重复，且不带来任何行为。                                        |
| 空闲回收先于 workspace isolation 交付                            | 它修复今天默认模式下的增长，不必等待有争议的 close 证据决策。                                                    | 在 workspace isolation 之后才做回收：没有争议的修复要等待待确认问题 1。                       |
| 通过 workspace isolation 按 `(tenant, storage)` 共享             | 复用现有隔离类别和放置 key；storage holder 本来就串行化 turn。                                                   | 预先启动一池 session isolation worker：Session 存在之前无法知道 isolation key。               |
| 在准入时强制 generation 预算                                     | 只在空闲时换代，在持续使用下不构成上限。                                                                         | 只在空闲点换代：急切的后继准入会使其失效。                                                    |
| workspace isolation 必须同时开启预算和回收                       | 不会有部署在没有上限的情况下运行共享 worker。                                                                    | 先于预算交付 workspace isolation：会打开一个无上限的窗口。                                    |
| Session close 只释放，只有退役才停 worker                        | 关闭一个 Session 不能停掉其他 Session 在用的 worker。                                                            | 最后一个 Session 关闭时停 worker：恰好在最需要常驻的时候失去常驻，还会与下一个 Session 竞态。 |
| 以 activation release 确认作为 workspace isolation 的 close 证据 | holder 释放已经信任这一证据；对逃逸的子孙进程，进程死亡并不是更强的证据。                                        | 每个 Session 都要求进程死亡：与共享不兼容。                                                   |
| 只对 idle 与 budget 退役返回可重试错误                           | Turn 不能因为平台退役了 worker 而失败。丢失和 close 继续 fail closed。                                           | 所有 `DRAINING` 都可重试：会掩盖真正需要恢复的情况。                                          |
| 排除 child Workspaces                                            | 它们的 merge 依赖已关闭的 child 停止自己的 worker。                                                              | 在本工作中一并泛化 child close：那是另一项设计。                                              |
| 推后 keep-warm                                                   | Session 创建时 warm 已解决用户可见的冷启动；keep-warm 需要测量数据。                                             | 现在交付 keep-warm：在退役机制和测量数据就绪之前增加常驻成本。                                |

## 6. 交付切片

| PR  | 范围                                          | 依赖              | 行为变化   |
| --- | --------------------------------------------- | ----------------- | ---------- |
| PR0 | 本中英文设计文档                              | —                 | 无         |
| PR1 | Kind 身份与隔离策略（4.1）                    | —                 | 无         |
| PR2 | 空闲回收（4.2）                               | PR1               | 需显式开启 |
| PR3 | workspace isolation 与 generation 预算（4.3） | PR2、待确认问题 1 | 需显式开启 |
| PR4 | Session 创建时 warm（4.4）                    | —                 | 需显式开启 |

PR4 可以与 PR2、PR3 并行。PR3 如果超过约 1000 行生产代码，就拆成 Harness 归属重建，
以及 close/预算/配置两部分。每个切片都要同时更新本文档的中英文版本。

由于 `sdk-java.yml` 不在 pull request 上运行，每个 Java 切片都要在其 head commit 上
dispatch `SDK Java` workflow，并在 pull request 正文中附上运行链接。

## 7. 失败语义

| 事件                                                 | 行为                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 空闲退役期间有 Turn 到达                             | 返回可重试的 `runtime_placement_retiring`；drain 回执提交后在 generation + 1 上成功。 |
| 空闲停止失败或未确认                                 | binding 保持 `DRAINING`；带退避重试停止；不启动替代进程。                             |
| worker 在空闲时死亡                                  | 走现有丢失路径。同一 boot 内的死亡会保留 holder 等待恢复。                            |
| 回收器与准入竞态                                     | 在 binding 行锁下串行：准入先到则回收器跳过，否则准入看到 fence 并得到可重试拒绝。    |
| Session 仍未关闭时其 session isolation worker 被退役 | 下一个 Turn 创建 generation + 1；之后的 close 找到被退役 generation 的 drain 回执。   |
| 仍有活跃 Runtime Session 时达到预算                  | 新准入得到可重试拒绝；活跃工作继续完成；最后一次释放之后进行退役。                    |
| B 正在使用共享 worker 时 Session A 关闭              | A 的 Runtime Session 通过原 worker 释放；binding 保持 `READY`；B 不受影响。           |
| A 的 close 遇到 A 的 `UNKNOWN` 执行                  | A 的 close 保持 `recovery_blocked`；binding 和 B 不受影响。                           |
| 原 worker 无法确认 A 的释放                          | A 的 close 等待 binding 级停止或丢失证据（今天的规则）。                              |
| 有常驻 worker 时 Broker 重启                         | 现有持久接管流程重新 attest 原 worker。                                               |

## 8. 风险与约束

- **close 证据变弱**。workspace isolation 的 Session close 依赖 worker 自己声明的释放。
  这是需显式开启的，有文档说明，session isolation 仍是默认值。
- **影响范围**。共享 worker 崩溃会影响该 storage 上的所有 Session。storage 级的影响与今天相同：
  - 无论哪个 Session 的 worker 崩溃，`LOST` 的 managed-context binding
    本来就会阻塞同一 storage 上的新放置，直到恢复完成（`RuntimeBindingRecord.java:368`）；
  - storage holder 本来就只允许每个 storage 有一个活跃 Runtime Session，
    所以一次崩溃最多中断那一个 Session 的工作。

  变化在于：原本在该 storage 上空闲的 Session，现在也会失去一个已预热的 worker。

- **PR3 的广度**。Harness 归属在多条相互独立的路径里从 isolation key 推导（4.3）。
  漏掉任何一条，都会让正在关闭的 Session 的封锁或恢复作用到错误的 owner 上，
  所以 PR3 把它们逐条列为验收项。
- **保留**。持久模式仍然从不清理注册文件和锁文件。退役减少的是存活进程，不是 state 目录条目。
- **未测量的默认值**。TTL 和预算值需要先在目标部署上测量，才能提出默认值。
- **仅限 Linux**。持久 local worker 和 drained stop 都要求 Linux，本功能也一样。
- **CI 覆盖**。Java 检查只在被 dispatch 时运行；没有附上 dispatch 运行链接的切片就没有 Java 证据。

## 9. 验证计划

- **PR1**：
  - 现有 Java 和 TypeScript 测试保持通过；
  - 单元测试钉住隔离策略只允许 `session`；
  - provisioner 之外不再有 `"local-process"` 字面量比较。
- **PR2**：在 Linux 上用持久 local worker 和 MySQL 做真实进程测试：
  - 空闲的 session isolation worker 被退役，带 drain 回执进入 `RELEASED`；
  - 未关闭 Session 的下一个 Turn 在 generation + 1 上运行，其 close 成功；
  - 退役期间到达的 Turn 重试后成功；
  - SQL 并发测试覆盖回收器与准入的竞态；
  - 被 Hook、MCP 或后台记录 pin 住的 binding 不会被退役；
  - 停止失败和空闲时 worker 死亡各自走对应路径。
- **PR3**：
  - 两个 Session 共享同一个 binding ID、generation 和 worker PID；
  - 同一 storage 上的 turn 以 `workspace_busy` 串行；
  - 关闭 A 之后 B 的下一个 Turn 仍在同一个 worker 上；
  - A 的后台 Shell 任务随 A 的 close 停止，B 的任务继续；
  - 4.3 中每条重建归属的 Harness 路径都有拒绝外来 Session 的测试；
  - 跨越预算阈值的急切后继准入无法在旧 generation 上被准入，退役后落在 generation + 1 上；
  - Broker 被 `SIGKILL` 后接管共享 worker；
  - session isolation 的 close 行为不变。
- **PR4**：Session 创建时 warm 在第一次工具调用之前达到 `READY`，
  对已经 `READY` 的 Workspace binding 不做任何事。
- **全部**：build、typecheck、bundle、一次 dispatch 的 `SDK Java` 运行，以及连续两遍干净的全 diff 自审。

## 10. 验收标准

- 使用默认配置时，行为和 SQL 状态与今天完全一致。
- 空闲或预算退役从不释放活跃的 Runtime Session，也没有 Turn 因此不可重试地失败。
- 使用 workspace isolation 时：
  - 同一 storage 上的所有绑定 Workspace 的 Session 同一时刻只使用一个存活的 generation；
  - 关闭单个 Session 永远不会停掉该 generation；
  - 没有 generation 准入超过其预算的 Runtime Session。
- 每个进入 `RELEASED` 的常驻 binding 都带有 drain 回执，或者丢失加写入者已停止的证据。
- 没有任何路径会重放 `UNKNOWN` 执行，或在原 generation 未结算时启动替代进程。
- 本文档的两种语言版本都反映每个已落地的切片。

## 11. 范围外与后续工作

- keep-warm：运维按 storage 固定的常驻 worker，等退役机制交付且测量数据支持后再做。
- 持久的、经过 attestation 的注册型常驻 worker，用于替代 `static`。
  它需要 worker 侧的 lease 注册与轮换，以及单独的设计。
- 通过 SSH 的远端放置和反向连接的 worker。
- 把 child Workspace close 泛化到共享 worker。
- 清理持久模式的注册文件和锁文件。

## 12. 待确认问题

1. 原 worker 的 activation release 确认能否作为 workspace isolation Session 的
   reliable close 证据（4.3）？该问题决定 PR3 能否开工。
2. 当某个 generation 因永不释放的 Runtime Session 而超出预算继续存活时（4.3），
   适用什么运维或资源压力策略？
3. 空闲 TTL 和 generation 预算的默认值由哪些部署测量来确定？

修订 2 中已解决：

- 空闲回收先覆盖 session isolation 的 binding，默认关闭。
- 预热只做 Session 创建时 warm；keep-warm 推后。
