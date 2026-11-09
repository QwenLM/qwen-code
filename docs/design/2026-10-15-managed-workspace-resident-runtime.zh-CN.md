# 按 Workspace 常驻的 Managed Tool Runtime

[English](2026-10-15-managed-workspace-resident-runtime.md) | [简体中文](2026-10-15-managed-workspace-resident-runtime.zh-CN.md)

状态：4.1 节已由 PR1（[#14254](https://github.com/QwenLM/qwen-code/pull/14254)）实现，
4.2 节由 PR2（[#14339](https://github.com/QwenLM/qwen-code/pull/14339)）实现，
4.3 节由 PR3（[#14435](https://github.com/QwenLM/qwen-code/pull/14435)）实现，
4.4 节（Session 创建时 warm）由 PR4 实现。4.5 节仍是提案。跟踪 issue：
[#14211](https://github.com/QwenLM/qwen-code/issues/14211)。属于 Managed Agent 提案
[#12380](https://github.com/QwenLM/qwen-code/issues/12380)。代码引用基于 PR2 之前的
`main` @ `c3012a523f`。

修订记录：

- 修订 1 作为 PR0（[#14214](https://github.com/QwenLM/qwen-code/pull/14214)）合入。
- 修订 2（根据 #14214 的 review）：PR1 复用已有的 provisioner 能力方法；列出依赖
  isolation key 推导 Harness 归属的路径；generation 预算改为准入时强制；keep-warm 推后。
- 修订 3（维护者决定，2026-10-16）：
  - 接受 workspace 隔离下的 close 证据（原待确认问题 1）；
  - 推后空闲回收和 generation 预算（见 4.5 节）；
  - 切片重新排序：PR2 重建 Harness 归属，PR3 开启 Workspace 常驻，PR4 增加 Session 创建时 warm。
- 修订 4（PR3，[#14435](https://github.com/QwenLM/qwen-code/pull/14435)）：
  - close/恢复侧落地：正在关闭的 Session 在共享 binding 上只释放自己的 Runtime Session
    （worker 与 binding 保持 `READY`），两个 close 协议都覆盖；v2 cleanup authority 由
    Runtime Session 自己的 Harness Session 认领 fence；丢失的共享 worker 让 close 失败关闭，
    而不是退役 binding；storage 退役仍会停掉共享 worker；恢复维护与 retention 放行共享 binding；
  - 新发现：旧 close 在共享 binding 上失败开放——协议 v0/v1 只枚举 session 隔离的 binding，
    带活跃共享 Runtime Session 的 Session 不释放它们就能进入 `CLOSED`（v2 会拒绝）。在策略允许
    workspace 隔离之前不可达；v2 的 never-initialized 回执现在额外要求该 Session 从未有过
    放置在共享 binding 上的 Runtime Session；
  - 开启侧落地：`bound-session-isolation-class`（默认 `session`，可选 `workspace`）把绑定
    Session 的放置切换到 workspace 隔离的 binding；共享 binding 上的生命周期 authority 由
    Runtime Session 自己的 Harness Session 认领 fence，因此正在关闭的 Session 的生命周期 Hook
    在常驻 worker 上放置并运行；
  - 修正：枚举索引是 `V9` 迁移，单列 `harness_session_id` 索引——两个列都是
    VARBINARY(2048)，4.3 节原先勾勒的 `(tenant_id, harness_session_id)` 组合超过 InnoDB
    的 3072 字节键长（本 PR 原先的 `V7` 因 `main` 在评审期间占用 `V7`、`V8` 而改号）；
  - 与 #14340 的关系：私有 Kubernetes CSI 的常驻 Workspace close 单独交付，其语义不变；
  - 验证范围：本切片只有单元/H2 与变异证据；第 9 节的真实进程 Linux 场景留作后续。
- 修订 5（PR4）：
  - Session 创建时 warm 只在 workspace 隔离下生效：`session-create-warm=true` 要求
    `bound-session-isolation-class=workspace` 且未配置 SSH 节点，否则启动失败。在 session
    隔离下（SSH 绑定的 Session 总是使用 session 隔离），它会让每个创建了但从未使用的
    Session 各占一个 worker，而且它建出的 session 隔离 binding 会让该 Session 失去 v2 的
    never-initialized 回执（见 4.4 节）；
  - 只有不带输入的创建才 warm：带输入的创建会立刻 dispatch 第一个 Turn，那个 Turn 本来就会 warm。

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
一个长期运行的 worker，由该 storage 上所有绑定 Workspace 的 Session 共享，并按需提前启动。
仅共享本身就把存活 worker 的数量从"Session 数"降到"storage 数"。
空闲 worker 的退役推后（见 4.5 节）。

## 2. 现状

在 `main` @ `c3012a523f` 上核实：

| 方面                                 | 行为                                                                                                                                                                                                                                                                                                                                          | 引用                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 绑定 Workspace 的 Session 的隔离方式 | Workspace files 要求 `local-process` Broker 加 Workspace mounts，且其隔离类别必须被 Workspace 执行策略允许，目前只有 `session`。child Workspaces 还要求 durable local worker。`isolation-class` 默认为 `session`，Workspace resolver 也只构造 session 隔离的 scope。                                                                          | `ManagedAgentProperties.java:157`、`:203`、`:895`；`WorkspaceRuntimeResolver.java:36`、`:95`                                                                                        |
| unbound Session 的隔离               | unbound Session 使用同一个全局 `isolation-class`。                                                                                                                                                                                                                                                                                            | `EmbeddedRuntimeBroker.java:196`                                                                                                                                                    |
| 放置身份                             | workspace isolation 没有 isolation key，一个 binding 服务完整 scope（tenant、Workspace、generation、挂载根、capability digest、kind、storage）。session isolation 按 Harness Session ID 划分 binding。`cwdRelative` 不属于放置身份。                                                                                                          | `managed-runtime-broker-service-core.md`；`JdbcRepositorySupport` 的 request key                                                                                                    |
| Harness 归属                         | 多条路径根据 binding 的 isolation key 推导"这属于哪个 Harness Session"，因此只适用于 session isolation：<br>• Harness 准入封锁会跳过非 Session 的 scope。<br>• close 只枚举 isolation key 等于正在关闭的 Session 的 binding 上的执行。<br>• Hook、MCP 和后台任务的原 owner 恢复与释放依赖它。<br>• 恢复维护按 isolation key 检查 close 封锁。 | `JdbcRuntimeBindingRepository.java:909`；`JdbcToolExecutionRepository.java:109`；`RuntimeBrokerService.java:680`、`:2001`、`:3812`、`:3846`                                         |
| 一个 worker、多个 Runtime Session    | boot v2 worker 为每个 Runtime Session 安装一份 context，每个 Session 在自己的有效目录里运行。后续的 tool turn 使用新的 Runtime Session ID。                                                                                                                                                                                                   | `2026-09-26-managed-context-worker.md`；`2026-09-26-managed-workspace-execution.md`                                                                                                 |
| Warm                                 | 只有按需 warm。Java 在 Turn dispatch 时 warm 该 Session 的 Runtime，与模型推理并行。Harness 在为 tool turn、Hook 执行或文件回退 acquire Runtime Session 之前调用 Broker 的 `/runtimes:warm`。没有任何机制提前 warm。                                                                                                                          | `HarnessCoordinator.java:359`、`:873`；`RuntimeBrokerHttpServer.java:158`；`hosted-workspace-tool-turn.ts:1625`                                                                     |
| Session close                        | `SessionLifecycleCoordinator` 调用 `closeWorkspace`，再执行 `drainHarnessSession`。它只枚举 `isolation_class = 'session' AND isolation_key = <harness session>` 的 binding，对其 drain，并在 `RELEASED` 之前要求 `stopDrained` 证据。                                                                                                         | `SessionLifecycleCoordinator.java:415`、`:446`；`EmbeddedRuntimeBroker.java:297`；`RuntimeBrokerService.java:303`、`:379`、`:416`、`:438`；`JdbcRuntimeBindingRepository.java:1110` |
| 停止 worker                          | `LocalProcessRuntimeProvisioner.stopDrained` 只停止 Workspace profile 下已 drain、带 managed-context、且隔离类别被策略允许的 binding。持久模式下 `release` 什么都不做。                                                                                                                                                                       | `LocalProcessRuntimeProvisioner.java:292`、`:309`                                                                                                                                   |
| 停止准入                             | `WorkspaceExecutionStore.canStopDrained` 和 `RuntimeAdmission.requireStoppedRelease` 要求 `local-process` 加被允许的隔离类别，并按 binding 的 isolation key 匹配 storage holder。                                                                                                                                                             | `WorkspaceExecutionStore.java:441`；`RuntimeAdmission.java:42`                                                                                                                      |
| drain 期间的放置                     | `requireRecoverablePlacement` 把同 tenant、同 storage/目录/Workspace 上的 `DRAINING` binding 视为阻塞，以不可重试的 `409 runtime_placement_recovery_required` 拒绝新的 generation。                                                                                                                                                           | `JdbcRuntimeBindingRepository.java:1957`；`RuntimeBindingRecord.java:368`                                                                                                           |
| binding 级 drain                     | `retireStorageBinding` 在 storage fence 下 drain 一个确定的 binding generation（Workspace 迁移在用）。                                                                                                                                                                                                                                        | `RuntimeBrokerService.java:393`                                                                                                                                                     |
| 空闲回收                             | 对存活的 binding 没有。retention 只清理过期的 `FAILED`/`RELEASED` 行。                                                                                                                                                                                                                                                                        | `runtime-broker-jdbc-retention.md`                                                                                                                                                  |
| worker 侧保留                        | context installation 在 worker 生命周期内一直保留。executor 的 `closedSessions` 和 provider 的已释放 Session 占位记录每个 Runtime Session 各增长一小条；provider 让 8 个已释放 Session 保持可答。                                                                                                                                             | `managed-context-envelope.ts:353`；`managed-runtime-tool-executor.ts:354`；`managed-runtime-provider-worker.ts:124`                                                                 |
| close 证据                           | reliable close 只有在准入已封住、原写入者、Session、worker 和 holder 都已结算后才算完成。目前这意味着原 worker 进程已停止。                                                                                                                                                                                                                   | `workspace-session-reliable-close.md`                                                                                                                                               |
| Java CI                              | `sdk-java.yml` 只在定时任务和手动 dispatch 时运行，修改 `packages/managed-agent-server` 的 pull request 不会跑 Java 矩阵。                                                                                                                                                                                                                    | `.github/workflows/sdk-java.yml`                                                                                                                                                    |

## 3. 目标与非目标

目标：

- 绑定 Workspace 的 Session 可以放在 workspace isolation 的 binding 上，
  同一 storage 上的所有这类 Session 共享一个 worker generation。
- 关闭单个 Session 永远不会停掉其他 Session 在用的 worker，同时仍留下 reliable close 证据。
- worker 可以在第一次工具调用需要之前启动。
- 每项改动都在配置开关之后，默认配置保持现有行为。

非目标：

- 改变"一个 worker 进程就是一个 binding generation"这一不变量。
  attestation、seed、incarnation、内存调用记录和 `UNKNOWN` 规则全部保持不变。
- 本次交付不做空闲回收和 generation 预算（见 4.5 节）。
- 远端放置（SSH、反向连接的 worker），或替代 `static` 的注册型常驻 worker。
  两者都需要 worker 侧支持 lease 注册，并各自单独设计。
- 改变默认隔离类别，或改变 session isolation 的 close 语义。
- 同一 storage 上并发执行 tool turn。`ma_storage_owner` 继续串行化。

## 4. 设计

"常驻"是 binding 生命周期的属性，不是进程身份的属性。
workspace isolation 的 binding generation 只创建一次，被共享，比任何单个 Session 活得更久。
它指向的 worker 仍然是恰好一个进程，对应一个 seed、一个 lease 和一份内存调用记录。

### 4.1 Kind 身份与隔离策略（PR1，已实现）

PR1 没有改变任何行为。它没有新增 provisioner 能力方法，因为已有的 `kind()`、
`supportsDrainedStop()` 和 `supportsStartupRecovery(handle)` 已经能回答这些能力问题。

- **Kind 身份**：`LocalProcessRuntimeProvisioner.KIND` 改为 public，替换了 14 处生产代码中
  对 `"local-process"` 字面量的比较。这些判断问的是"哪个 provisioner 放置了 binding"或
  "配置的是哪个 provisioner"，因此保持为身份判断。
- **隔离策略**：表达"Workspace 执行使用 session isolation"的 5 处判断，统一询问
  `WorkspaceExecutionProfile.admitsIsolationClass`，它仍然只允许 `session`。
  child Workspaces 保留自己显式的 Session 要求。

### 4.2 共享 binding 上的 Harness 归属（PR2）

PR2 不改变今天可达的任何行为。它为 Broker 做准备：让一个被多个 Harness Session
共享的 binding，能按每个 Runtime Session 自己的 Harness Session 做封锁和恢复。

**一个判定**：`HarnessOwnership.sharesRuntimeSessions(request)`。只有同时满足以下条件的
binding 才为真：workspace 隔离、managed-context、`local-process`、Workspace 执行 profile。

**只加分支**：每处改动都写成
`共享 ? <按 Runtime Session 的判断> : <今天的表达式，原样不动>`。
对所有非共享 binding，原代码按原样执行，所以 session 隔离和 legacy 的行为在写法上就保证等价。

**今天为什么不存在共享 binding：**

- managed-context 的 `local-process` 请求只由 Workspace provisioner 构造，而它的 resolver
  只构造 session 隔离的 scope，配置校验也拒绝策略不允许的隔离类别。
- `legacy` 和 `static` 请求不可能是 managed-context。
- 私有 Kubernetes Workspace binding 也使用 workspace 隔离加 Workspace profile digest，
  但 `local-process` 的 kind 判定把它们排除了。

**PR2 重建归属的位置：**

| 位置                                                                  | 共享 binding 上的行为                                                                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness 准入核心（`JdbcRuntimeBindingRepository`）                    | 新增的 owner 标志按给定 Runtime Session 的 Harness Session 做封锁，而不是跳过非 Session 的 scope。共享 binding 上的生命周期 authority 仍被拒绝。               |
| `admitSession`、Session tombstone、`admitExecution`                   | 按 Runtime Session 或执行自己的 Harness Session 封锁；storage fence 和物理 storage 准入不变。                                                                  |
| 带 binding 请求参数的仓库重载                                         | `requireHarnessAdmission`、`requireHookAdmission`、`requireHarnessRecovery`；接口默认实现委托给只带 scope 的方法，其他仓库的行为保持不变。                     |
| Broker 调用点（acquire、control、dispatch、生命周期 release）         | 把 binding 请求传给上述重载。                                                                                                                                  |
| `acquireRecovery`、`releaseOriginal`（Hook、MCP、后台任务的原 owner） | 由保存的 Runtime Session 记录证明 owner。共享 binding 上，`releaseOriginal` 拒绝为未知的 Runtime Session id 写 tombstone，因为没有任何东西能证明调用方拥有它。 |
| `releaseSavedSession`、`HttpRuntimeTransport.activateWorkspace`       | 改为匹配 Runtime Session 记录，而不是 isolation key。                                                                                                          |
| 内存仓库                                                              | 同样的封锁逻辑，供同时跑两种仓库的测试使用。                                                                                                                   |
| `WorkspaceRuntimeTransport` 的 context 校验（server）                 | 匹配 Runtime Session 记录的 Harness Session。                                                                                                                  |
| 人工恢复（server）                                                    | 把被持有的 Runtime Session 的 Harness Session 记为 owner。                                                                                                     |

**保持不变**：CSI 专用代码；warm 放置（共享 binding 没有单一 owner，warm 也不准入任何工作）。
要求生命周期 authority 的路径在 PR2 中于共享 binding 上拒绝；PR3 起由 Runtime Session 自己的
Harness Session 认领 fence 放行（见 4.3 节）。

**已在 PR3 交付**（策略允许 workspace 隔离后即可触达）：close 与生命周期证据
（`findHarnessExecutions`、`verifyHarnessResources`、`verifyHarnessStopped`）、
stopped release 与 `canStopDrained`、恢复维护的封锁、共享 binding 的 retention，
以及 provisioning 的 scope 解析。

### 4.3 workspace 隔离（PR3）

#### 配置

绑定 Workspace 的 Session 使用独立的隔离配置项。否则 unbound Session 会沿用全局
`isolation-class`，同一租户的所有 unbound Session 都会共用一个 legacy worker。
绑定 Workspace 的 Session 可以使用 workspace 隔离的条件：

- provisioner 为 `local-process`，且 `durable-local-process=true`、支持 `supportsDrainedStop()`；
- `child-workspaces-enabled=false`。child Workspace 的 merge 依赖已关闭的 child
  停止它自己的 worker，而 child relay 按 Harness Session 查找 child 的 binding，
  共享 binding 不记录这一点。

默认值仍是 `session`。该设置只对新的放置生效。
已有的 session isolation binding 保留其保存的请求，在各自 Session close 时退役。
如果某个 Session 的下一个 Turn 解析出新的 scope，它会在共享 binding 上拿到一个新的 Runtime Session。
resolver 契约本来就允许这样做，因为 scope 变化本就要求新的 Runtime Session 身份。

#### 放置、provisioning 与 storage 占用

- **放置会收敛**：解析出的 scope 包含 tenant、Workspace、Workspace generation、挂载根、
  digest 和隔离类别，但不包含 `cwdRelative`。所以同一 storage、同一 Workspace generation
  上的所有绑定 Workspace 的 Session 都会构造出相同的请求，`findOrCreate` 会把它们收敛到同一个
  binding generation。
- **provisioning**：需要把 Harness id 透传进 `RuntimeProvisioner.createRequest`，
  因为 workspace 隔离的请求没有 isolation key 可用来解析。就绪检查按 `(tenant, storageId)`
  解析 storage mount。
- **storage 占用不变**：`ma_storage_owner` holder 仍按 Runtime Session 持有，同一 storage
  上的第二个 Session 会收到可重试的 `workspace_busy`，直到第一个 Runtime Session 释放。
  这就是今天的串行化方式，只是 worker 现在被共享了。

#### Session close 拆成释放与退役

关闭一个 Session 不能停掉其他 Session 正在用的 worker。PR3 把今天的 close 拆成两个操作：

1. **Session 释放**。在现有的永久 tenant/Harness Session drain fence 下运行，
   该 fence 通过 PR2 重建的准入在共享 binding 上生效。它枚举正在关闭的 Session 在
   workspace isolation binding 上的 Runtime Session，对每个活跃的 Runtime Session：
   1. 发送 provider release；
   2. 发送 activation release，并等待原 worker 确认。worker 会 drain 该 Session 的后台任务，
      并报告已没有已准入的调用；
   3. 有条件地清除原 storage holder；
   4. 记录 `RELEASED`。

   按 Harness Session 枚举需要在 `ma_runtime_session` 上新增索引，以 `V9` 迁移的形式加入。
   它是单列 `harness_session_id` 索引：两个列都是 VARBINARY(2048)，原先勾勒的
   `(tenant_id, harness_session_id)` 组合超过 InnoDB 的 3072 字节键长，tenant 改在查询里过滤。
   该 Session 有未结算或 `UNKNOWN` 的执行时，与今天一样阻塞完成。
   binding 保持 `READY`，供其他 Session 使用。

2. **binding 退役**。即现有的 `drainBinding` 路径：drain、释放剩余 Session、`stopDrained`、
   持久化 drain 回执，然后 `RELEASED`。本次交付中，只有显式的 storage 退役
   （`retireStorageBinding`，Workspace 迁移在用）会走到这里。PR3 让 `canStopDrained`
   和 stopped release 按 `(binding, generation, runtimeSessionId)` 匹配 holder 和 Runtime Session。

session isolation 的 binding 保持今天的 close 不变。

**close 证据（维护者已决定，2026-10-16）**。对于 workspace isolation 的 Session，
reliable close 以原 worker 的 activation release 确认加上 holder 释放作为完成条件，
而不是以 worker 进程停止为条件。理由：

- W0c-3 已经把同一个确认当作释放 storage holder 的条件。
- worker 进程死亡也同样不能证明逃逸的子孙进程已停止（W0e-2/W0e-3）。

如果原 worker 无法确认（binding `LOST`、lease 不可用），Session close 回退到今天的规则：
等待 binding 级的停止或丢失证据，否则保持 `recovery_blocked`。
需要按 Session 取得进程停止证据的部署继续使用 `session` isolation。
archive、delete 和 unarchive 继承该 Session 隔离方式所提供的 close 证据。

#### worker 侧的增长

常驻 worker 会累积按 Runtime Session 计的状态：installation、已关闭 Session 的占位记录和
`closedSessions` 每个 tool turn 各增长一小条。没有推后的 generation 预算，这种增长不受时间约束。
第一次交付接受它并写入文档。目前只有 Workspace 迁移的 storage 退役路径会退役某个 storage 的 binding，
之后的下一次放置会开始一个新的 generation；是否把它开放成运维操作，由 PR3 决定。
4.5 节的预算之后会限制这种增长。

### 4.4 Session 创建时 warm（PR4）

`session-create-warm=true` 时，绑定 Workspace 的 Session 以不带输入的方式创建并提交后，
控制面通过现有 resolver 异步调用现有的 `warm(sessionId)`。与 Turn 时的 warm 一样，Runtime
Broker 未开启或 Workspace files 不可用时跳过。它只做放置：从不 acquire Runtime Session、
不安装 context、不执行任何操作。resolver 像 Turn 时的 warm 一样对该 Session 做授权，
actor 授权仍在 acquire 时检查。

- **只在 workspace 隔离下生效**。该配置要求 `bound-session-isolation-class=workspace`
  且未配置 SSH 节点，因为 SSH 绑定的 Session 总是解析出 session 隔离的 scope；其他组合
  启动即失败。storage 上还没有存活的 binding 时，warm 会启动共享 worker；binding
  已经 `READY` 时，它只确认 worker，不启动任何进程。如果在 session 隔离下创建时 warm，会：
  - 让每个创建出来的 Session 各占一个 worker，直到该 Session 关闭，包括从未跑过 Turn 的
    Session，因为持久模式下 `release` 什么都不做，空闲回收也已推后；
  - 建出一个以该 Session 为 key 的 session 隔离 binding。这会让该 Session 失去 v2 的
    never-initialized 回执，于是关闭一个从未使用的 Session 需要 Harness settle，
    而不是由 store 合成回执。
- **只对不带输入的创建生效**。带输入的创建会立刻 dispatch 第一个 Turn，该 Turn 的 warm
  本来就与模型推理并行进行。Web Shell 的空 Session 创建和 channel 建路由时的创建都不带输入。
- **不在请求线程上执行**。resolver 和 `findOrCreate` 会在调用方线程上同步执行数据库和文件系统
  检查，所以这次调用投递到执行 Turn 时 warm 的同一个 dispatch executor 上。
- **失败**。warm 失败只记日志，从不让创建失败。没有任何机制重试它；第一个 Turn 会再次 warm。
  此时还没有 Turn，所以不发公开事件。Turn 时的 warm 及其 `environment.*` 事件保持不变。
- **close 不变**。warm 不写 `ma_runtime_session` 行，也不建 session 隔离的 binding，所以
  从未跑过 Turn 的 Session 仍以 never-initialized 回执关闭。与 close 并发的 warm 最多只会启动
  或确认其他 Session 也在用的共享 worker。

### 4.5 推后：空闲回收与 generation 预算

两者都推后，等常驻交付并有测量数据表明需要时再做。修订 2 的调研发现了它们将来要处理的问题：

- **空闲时钟**：`ma_runtime_binding.last_active_at` 不能当空闲时钟：恢复维护每次扫描都会刷新它，
  Runtime Session 释放却不更新它。可用的是 `ma_runtime_session.last_active_at` 上的最后释放时间，
  以及执行的结算时间。
- **恢复**：恢复维护会把已停止、正在退役的 binding 误判为调用记录丢失，除非它跳过正在退役的 binding。
- **Turn 竞态**：在 Session 仍打开时退役 generation，会引出好几个竞态：
  - Harness 先 warm 拿到 generation G，欠下对 G 的清理，之后才 acquire；
  - 对已退役 G 欠下的清理会永久失败；
  - 重新 acquire 已释放的 Runtime Session id，会先起一个冷的 G + 1 再拒绝；
  - child relay 只认 `READY` 的 binding。
- **可重试应答**：退役期间的拒绝今天有 4 种不同错误码，Java 和 TypeScript 的调用方
  都不看 `retryable` 标志。
- **准入时预算**：只在空闲点执行的预算，在持续使用下不构成上限。达到预算的 generation
  必须停止准入新的 Runtime Session，让已准入的工作完成，然后退役。
- **可回收的 Session**：Hook、MCP 和后台任务在两个 Turn 之间也占着 Runtime Session，
  所以只有普通 Session 会被判为空闲。

### 4.6 配置汇总

所有行为变化默认关闭。

| 配置项（`qwen.managed-agent.runtime-broker.`）                                              | 默认值    | 切片 |
| ------------------------------------------------------------------------------------------- | --------- | ---- |
| `bound-session-isolation-class`（仅绑定 Workspace 的 Session；全局 `isolation-class` 不变） | `session` | PR3  |
| `session-create-warm`（要求 `bound-session-isolation-class=workspace` 且未配置 SSH 节点）   | `false`   | PR4  |

时长遵循现有的单位规则，必须写后缀。

## 5. 决策与理由

| 决策                                                                       | 理由                                                                                                             | 被否决的方案                                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 让 binding 常驻，而不是让进程常驻                                          | 保留 seed、attestation、incarnation 和 `UNKNOWN` 规则，这些已经过 W0e 物理验证。                                 | 一个长期进程接受多个 lease 并持久化调用记录：要重写恢复模型，还需要持久回执存储。             |
| 复用已有能力方法；kind 判断保持为身份判断                                  | `supportsDrainedStop()` 和 `supportsStartupRecovery()` 已经存在；其余判断问的是哪个 provisioner 放置了 binding。 | 新增平行的能力方法：与已有方法重复，且不带来任何行为。                                        |
| 先常驻，后回收                                                             | 共享把 worker 数限制为 storage 数，并避开了"在打开的 Session 下切换 generation"带来的所有竞态。                  | 先做空闲回收：它的竞态比它要解决的问题更难。                                                  |
| 用只加分支的方式重建归属                                                   | session 隔离下的等价性在写法上就成立；共享分支在可达之前就能被测试。                                             | 把每处都改为读取 Runtime Session 记录：结果正确，但等价性论证要依赖一个仓库并不强制的不变量。 |
| 通过 workspace isolation 按 `(tenant, storage)` 共享                       | 复用现有隔离类别和放置 key；storage holder 本来就串行化 turn。                                                   | 预先启动一池 session isolation worker：Session 存在之前无法知道 isolation key。               |
| 绑定 Workspace 的 Session 使用独立的隔离配置                               | 否则 unbound Session 会按租户共用一个 legacy worker。                                                            | 复用全局 `isolation-class`：会连带改变 unbound 的放置。                                       |
| Session close 只释放，只有退役才停 worker                                  | 关闭一个 Session 不能停掉其他 Session 在用的 worker。                                                            | 最后一个 Session 关闭时停 worker：恰好在最需要常驻的时候失去常驻，还会与下一个 Session 竞态。 |
| 以 activation release 确认作为 workspace isolation 的 close 证据（已决定） | holder 释放已经信任这一证据；对逃逸的子孙进程，进程死亡并不是更强的证据。                                        | 每个 Session 都要求进程死亡：与共享不兼容。                                                   |
| 第一次交付接受 worker 按 turn 的增长                                       | 每条都很小，退役该 storage 的 binding 即可重置。                                                                 | 先交付预算：它依赖被推后的退役机制。                                                          |
| 排除 child Workspaces                                                      | 它们的 merge 需要已关闭的 child 停止自己的 worker，relay 也按 child 自己的 binding 定位它。                      | 在本工作中一并泛化 child close：那是另一项设计。                                              |
| 推后 keep-warm                                                             | Session 创建时 warm 已解决用户可见的冷启动；keep-warm 需要测量数据。                                             | 现在交付 keep-warm：在测量数据就绪之前增加常驻成本。                                          |
| Session 创建时 warm 只在 workspace 隔离下做                                | 每个 storage 最多启动一个 worker，且 close 不变。                                                                | session 隔离下也做：每个未用的 Session 常驻一个 worker，其关闭失去 never-initialized 回执。   |

## 6. 交付切片

| PR   | 范围                                                                                                                | 依赖     | 行为变化   |
| ---- | ------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| PR0  | 中英文设计文档（#14214）                                                                                            | —        | 无         |
| PR1  | Kind 身份与隔离策略（4.1，#14254）                                                                                  | —        | 无         |
| PR2  | 共享 binding 上的 Harness 归属（4.2）                                                                               | PR1      | 无         |
| PR3  | 绑定 Workspace 的 Session 使用 workspace isolation（4.3，[#14435](https://github.com/QwenLM/qwen-code/pull/14435)） | PR2      | 需显式开启 |
| PR4  | Session 创建时 warm（4.4）                                                                                          | —        | 需显式开启 |
| 之后 | 空闲回收与 generation 预算（4.5）、keep-warm                                                                        | 测量数据 | 需显式开启 |

PR3 如果超过约 1000 行生产代码，就拆成"provisioning 与放置"和"close 拆分与证据"两部分。
每个切片都要同时更新本文档的中英文版本。由于 `sdk-java.yml` 不在 pull request 上运行，
每个 Java 切片都要在其 head commit 上 dispatch `SDK Java` workflow，并在 pull request 正文中附上运行链接。

## 7. 失败语义

| 事件                                                       | 行为                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| B 正在使用共享 worker 时 Session A 关闭                    | A 的 Runtime Session 通过原 worker 释放；binding 保持 `READY`；B 不受影响。                                 |
| A 的 close 遇到 A 的 `UNKNOWN` 执行                        | A 的 close 保持 `recovery_blocked`；binding 和 B 不受影响。                                                 |
| 原 worker 无法确认 A 的释放                                | A 的 close 等待 binding 级停止或丢失证据（今天的规则）。                                                    |
| 正在关闭的 Session 试图在共享 binding 上做新工作           | PR2 重建后的准入以 `runtime_admission_closed` 拒绝；其他 Session 照常准入。                                 |
| 另一个 Harness Session 要求恢复或释放 A 的 Runtime Session | 被拒绝：保存的 Runtime Session 记录写的是 A。                                                               |
| 共享 worker 死亡                                           | 走现有丢失路径；与今天任何 managed binding 一样，`LOST` binding 会阻塞该 storage 上的新放置，直到恢复完成。 |
| 有常驻 worker 时 Broker 重启                               | 现有持久接管流程重新 attest 原 worker。                                                                     |

## 8. 风险与约束

- **close 证据变弱**。workspace isolation 的 Session close 依赖 worker 自己声明的释放。
  维护者已接受；它需显式开启，session isolation 仍是默认值。
- **影响范围**。共享 worker 崩溃会影响该 storage 上的所有 Session。storage 级的影响与今天相同：
  - 无论哪个 Session 的 worker 崩溃，`LOST` 的 managed-context binding
    本来就会阻塞同一 storage 上的新放置，直到恢复完成（`RuntimeBindingRecord.java:368`）；
  - storage holder 本来就只允许每个 storage 有一个活跃 Runtime Session，
    所以一次崩溃最多中断那一个 Session 的工作。

  变化在于：原本在该 storage 上空闲的 Session，现在也会失去一个已预热的 worker。

- **按 turn 增长无上限**。常驻 worker 每个 tool turn 增长一小条，直到它的 storage 被退役（见 4.3 节）。
- **PR3 的广度**。close 证据、provisioning、retention 和恢复都需要 4.2 节留到 PR3 的那些位置；
  漏掉任何一处都会 fail closed，而不会放行。
- **仅限 Linux**。持久 local worker 和 drained stop 都要求 Linux，本功能也一样。
- **CI 覆盖**。Java 检查只在被 dispatch 时运行；没有附上 dispatch 运行链接的切片就没有 Java 证据。

## 9. 验证计划

- **PR1（已完成）**：
  - 现有测试保持通过；
  - 单元测试钉住隔离策略和持久化的 kind 取值。
- **PR2**：
  - `HarnessOwnershipTest` 钉住判定的真值表；
  - `SharedHarnessOwnershipTest` 覆盖：按 Harness Session 封锁的 JDBC Session 与执行准入、
    drain 期间的 tombstone、生命周期 authority 被拒绝、legacy 与私有 Kubernetes Workspace binding
    行为不变、内存仓库对齐，以及原 owner 的恢复与释放；
  - server 测试覆盖共享 binding 上的 transport context 校验和人工恢复；
  - 关掉判定后，每个新测试都会失败；
  - 现有测试保持通过。
- **PR3**（已落地）：单元/H2 套件钉住共享 binding 上的 close 拆分（两个 close 协议）、
  cleanup 认领 fence、丢失共享 worker 的失败关闭分支、never-initialized 失败开放修复、
  配置闸门与 resolver 切换；每个新分支在定向变异下都会失败。下面的真实进程场景
  （Linux、持久 local worker、MySQL）留作后续，在 #14211 跟踪：
  - 两个 Session 共享同一个 binding ID、generation 和 worker PID；
  - 同一 storage 上的 turn 以 `workspace_busy` 串行；
  - 关闭 A 之后 B 的下一个 Turn 仍在同一个 worker 上；
  - A 的后台 Shell 任务随 A 的 close 停止，B 的任务继续；
  - Broker 被 `SIGKILL` 后接管共享 worker；
  - storage 退役带 drain 回执停掉共享 worker；
  - session isolation 的 close 行为不变；
  - unbound Session 保持原有隔离。
- **PR4**：单元测试钉住配置闸门（要求 workspace 隔离且未配置 SSH 节点）、warm 的闸门
  （配置开启、Runtime warmer 已启用、Workspace files 可用）、投递到 dispatch executor、
  只有不带输入的创建才 warm，以及 warm 失败既不让创建失败也不发事件；每一项在定向变异下
  都会失败。真实进程场景并入 #14211 中 PR3 的后续：
  - 空 Session 的共享 worker 在第一次工具调用之前达到 `READY`；
  - 同一 storage 上的第二个空 Session 不启动任何进程。
- **全部**：build、typecheck、bundle、一次 dispatch 的 `SDK Java` 运行，以及连续两遍干净的全 diff 自审。

## 10. 验收标准

- 使用默认配置时，行为和 SQL 状态与今天完全一致。
- 在共享 binding 上，任何 Harness Session 都无法通过另一个 Harness Session 的 Runtime Session
  被准入、恢复或释放。
- 使用 workspace isolation 时：
  - 同一 storage 上的所有绑定 Workspace 的 Session 同一时刻只使用一个存活的 generation；
  - 关闭单个 Session 永远不会停掉该 generation；
  - Session close 以已决定的 activation release 证据完成。
- 每个进入 `RELEASED` 的常驻 binding 都带有 drain 回执，或者丢失加写入者已停止的证据。
- 没有任何路径会重放 `UNKNOWN` 执行，或在原 generation 未结算时启动替代进程。
- 本文档的两种语言版本都反映每个已落地的切片。

## 11. 范围外与后续工作

- 空闲回收与 generation 预算（见 4.5 节）。
- keep-warm：运维按 storage 固定的常驻 worker。
- 持久的、经过 attestation 的注册型常驻 worker，用于替代 `static`。
  它需要 worker 侧的 lease 注册与轮换，以及单独的设计。
- 通过 SSH 的远端放置和反向连接的 worker。
- 把 child Workspace close 和 child relay 泛化到共享 worker。
- 清理持久模式的注册文件和锁文件。

## 12. 待确认问题

1. 用哪些测量数据来判断 worker 按 turn 的增长何时需要 generation 预算？

已解决：

- 绑定 Workspace 的 Session 的隔离配置项：`bound-session-isolation-class`（PR3）；
  本次交付不提供按 Workspace 覆盖。

- workspace 隔离下的 close 证据：原 worker 的 activation release 确认加上 holder 释放（维护者，2026-10-16）。
- 空闲回收与 generation 预算：推后（维护者，2026-10-16）。
- 预热：只做 Session 创建时 warm；keep-warm 推后。
- Session 创建时 warm 的范围：只在 workspace 隔离下、只对不带输入的创建（PR4）。
