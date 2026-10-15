# 按 Workspace 常驻的 Managed Tool Runtime

[English](2026-10-15-managed-workspace-resident-runtime.md) | [简体中文](2026-10-15-managed-workspace-resident-runtime.zh-CN.md)

状态：提案（PR0），以下内容均未实现。跟踪 issue：
[#14211](https://github.com/QwenLM/qwen-code/issues/14211)。属于 Managed Agent 提案
[#12380](https://github.com/QwenLM/qwen-code/issues/12380)。
代码引用基于 `main` @ `355ac8032d`。

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

在 `main` @ `355ac8032d` 上核实：

| 方面                                 | 行为                                                                                                                                                                                                                                  | 引用                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 绑定 Workspace 的 Session 的隔离方式 | Workspace files 要求 Session 隔离的 `local-process` Broker 并配置 Workspace mounts；child Workspaces 还要求 durable local worker。`isolation-class` 默认为 `session`。                                                                | `ManagedAgentProperties.java:153-168`、`:199-209`、`:891`；`WorkspaceRuntimeResolver.java:34-38`                                                                                    |
| 放置身份                             | workspace isolation 没有 isolation key，一个 binding 服务完整 scope（tenant、Workspace、generation、挂载根、capability digest、kind、storage）。session isolation 按 Harness Session ID 划分 binding。`cwdRelative` 不属于放置身份。  | `managed-runtime-broker-service-core.md`；`JdbcRepositorySupport` 的 request key                                                                                                    |
| 一个 worker、多个 Runtime Session    | boot v2 worker 为每个 Runtime Session 安装一份 context，每个 Session 在自己的有效目录里运行。后续的 tool turn 使用新的 Runtime Session ID。                                                                                           | `2026-09-26-managed-context-worker.md`；`2026-09-26-managed-workspace-execution.md`                                                                                                 |
| Warm                                 | 只有按需 warm。Java 在 Turn dispatch 时 warm 该 Session 的 Runtime，与模型推理并行。Harness 在为 tool turn、Hook 执行或文件回退 acquire Runtime Session 之前调用 Broker 的 `/runtimes:warm`。没有任何机制提前 warm。                  | `HarnessCoordinator.java:348`、`:862`；`RuntimeBrokerHttpServer.java:158`；`hosted-workspace-tool-turn.ts:1599`                                                                     |
| Session close                        | `SessionLifecycleCoordinator` 调用 `closeWorkspace`，再执行 `drainHarnessSession`。它只枚举 `isolation_class = 'session' AND isolation_key = <harness session>` 的 binding，对其 drain，并在 `RELEASED` 之前要求 `stopDrained` 证据。 | `SessionLifecycleCoordinator.java:409`、`:440`；`EmbeddedRuntimeBroker.java:297`；`RuntimeBrokerService.java:303`、`:379`、`:416`、`:438`；`JdbcRuntimeBindingRepository.java:1117` |
| 停止 worker                          | `LocalProcessRuntimeProvisioner.stopDrained` 只停止 Workspace profile 下已 drain、带 managed-context、Session 隔离的 binding。持久模式下 `release` 什么都不做。                                                                       | `LocalProcessRuntimeProvisioner.java:292`、`:309`                                                                                                                                   |
| 停止准入                             | `WorkspaceExecutionStore.canStopDrained` 和 `RuntimeAdmission.requireStoppedRelease` 要求 `local-process` 加 Session 隔离，并按 binding 的 isolation key 匹配 storage holder。                                                        | `WorkspaceExecutionStore.java:441`；`RuntimeAdmission.java:42-46`                                                                                                                   |
| drain 期间的放置                     | `requireRecoverablePlacement` 把同 tenant、同 storage/目录/Workspace 上的 `DRAINING` binding 视为阻塞，以不可重试的 `409 runtime_placement_recovery_required` 拒绝新的 generation。                                                   | `JdbcRuntimeBindingRepository.java:1964`；`RuntimeBindingRecord.java:368`                                                                                                           |
| binding 级 drain                     | `retireStorageBinding` 在 storage fence 下 drain 一个确定的 binding generation（Workspace 迁移在用）。                                                                                                                                | `RuntimeBrokerService.java:393`                                                                                                                                                     |
| 空闲回收                             | 对存活的 binding 没有。retention 只清理过期的 `FAILED`/`RELEASED` 行。                                                                                                                                                                | `runtime-broker-jdbc-retention.md`                                                                                                                                                  |
| worker 侧保留                        | context installation 在 worker 生命周期内一直保留。executor 的 `closedSessions` 和 provider 的已释放 Session 占位记录每个 Runtime Session 各增长一小条；provider 让 8 个已释放 Session 保持可答。                                     | `managed-context-envelope.ts:353`；`managed-runtime-tool-executor.ts:354`；`managed-runtime-provider-worker.ts:124`                                                                 |
| close 证据                           | reliable close 只有在准入已封住、原写入者、Session、worker 和 holder 都已结算后才算完成。目前这意味着原 worker 进程已停止。                                                                                                           | `workspace-session-reliable-close.md`                                                                                                                                               |
| kind 字面量                          | 多处能力判断把 provisioner kind 和 `"local-process"` 比较（见 4.1）。                                                                                                                                                                 | 4.1 节                                                                                                                                                                              |

## 3. 目标与非目标

目标：

- 绑定 Workspace 的 Session 可以放在 workspace isolation 的 binding 上，
  同一 storage 上的所有这类 Session 共享一个 worker generation。
- worker 可以在第一次工具调用需要之前启动。
- 空闲 worker 退役时，带与今天 reliable close 相同的停止证据。长期运行的 worker 到一定规模后被替换。
- 能力判断不再依赖 `"local-process"` 字面量。
- 每项改动都在配置开关之后，默认配置保持现有行为。

非目标：

- 改变"一个 worker 进程就是一个 binding generation"这一不变量。
  attestation、seed、incarnation、内存调用记录和 `UNKNOWN` 规则全部保持不变。
- 远端放置（SSH、反向连接的 worker），或替代 `static` 的注册型常驻 worker。
  两者都需要 worker 侧支持 lease 注册，并各自单独设计。
- 改变默认隔离类别，或改变 session isolation 的 close 语义。
  session isolation 仍是默认值，它唯一的变化是可选开启的空闲回收（4.4）。
- 同一 storage 上并发执行 tool turn。`ma_storage_owner` 继续串行化。

## 4. 设计

"常驻"是 binding 生命周期的属性，不是进程身份的属性。
workspace isolation 的 binding generation 只创建一次，被共享，比任何单个 Session 活得更久，
只有通过显式的、带证据的退役才结束。它指向的 worker 仍然是恰好一个进程，
对应一个 seed、一个 lease 和一份内存调用记录。

### 4.1 Provisioner 能力（PR1）

PR1 在 `RuntimeProvisioner` 上（或其旁边一个小的策略对象上）引入能力方法，
并转换能力型的 kind 判断。它不改变任何行为：对 `local-process`，
每个能力方法的返回值与今天字面量判断的结果完全一致。

| 位置                                                                                               | 现在的判断                                                            | 分类                     | PR1 处理                                                                    |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `WorkspaceRuntimeTransport.java:293-297`                                                           | v3 capture/publisher 只允许 `local-process`                           | 能力：同主机 capture     | `supportsLocalCapture()`                                                    |
| `WorkspaceExecutionStore.java:441-445`                                                             | 停止准入只允许 `local-process` + Session                              | 能力 + 隔离策略          | `supportsDrainedStop()` 加上一个 `drainedStopIsolation()` 策略，由 PR2 放宽 |
| `RuntimeAdmission.java:42-46`                                                                      | stopped release 只允许 `local-process` + Session                      | 能力 + 隔离策略          | 同上                                                                        |
| `RuntimeBindingRecord.java:368-376`、`JdbcRuntimeBindingRepository.java:1964-1987`                 | 未取得 lease 的 `RECOVERY_BLOCKED` `local-process` binding 不阻塞放置 | 能力：启动失败不留下资源 | `unattestedFailureLeavesNoResource()`；SQL 保留由它推导出的 kind 列表       |
| `RuntimeRecoveryCoordinator.java:30`、`JdbcRuntimeBindingRepository.java:1461`                     | 恢复扫描只查 `local-process` handle v2                                | 能力：启动恢复           | 按所配置 provisioner 的 kind 和 handle 版本扫描                             |
| `ManagedAgentProperties.java:157`、`:203`；`WorkspaceRuntimeResolver.java:35`                      | Workspace 执行只允许 `local-process`                                  | 能力：Workspace 执行     | `supportsWorkspaceExecution()`；隔离在 PR2 之前保持 `session`               |
| `EmbeddedRuntimeBroker.java:390`、`:404`、`:484`、`:500`                                           | provisioner 选择、本地路径和 ID 推导                                  | 身份                     | 不改                                                                        |
| `WorkspaceRecoveryCommand.java:51`、`WorkspaceOperatorRecoveryStore.java:253`、`LocalRuntimeStore` | 针对本地注册记录的人工恢复                                            | 身份                     | 不改                                                                        |

### 4.2 绑定 Workspace 的 Session 使用 workspace isolation（PR2）

#### 配置

在同时满足以下条件时，`qwen.managed-agent.runtime-broker.isolation-class=workspace`
（`QWEN_MANAGED_AGENT_RUNTIME_ISOLATION`）可以与 Workspace files 一起使用：

- provisioner 报告 `supportsWorkspaceExecution()` 且支持持久 drained stop；
- `durable-local-process=true`；
- `child-workspaces-enabled=false`。child Workspace 的 merge 依赖已关闭的 child
  停止它自己的 worker，所以二者保持互斥。

默认值仍是 `session`。该设置只对新的放置生效。
已有的 session isolation binding 保留其保存的请求，在各自 Session close 时（或通过 PR4）退役。
如果某个 Session 的下一个 Turn 解析出新的 scope，它会在共享 binding 上拿到一个新的 Runtime Session。
resolver 契约本来就允许这样做，因为 scope 变化本就要求新的 Runtime Session 身份。

#### 放置与 storage 占用

resolver 为同一 storage 上每个绑定 Workspace 的 Session 构造相同的请求，
所以 `findOrCreate` 会把它们收敛到同一个 binding generation。storage 占用不变：
`ma_storage_owner` holder 仍按 Runtime Session 持有，同一 storage 上的第二个 Session
会收到可重试的 `workspace_busy`，直到第一个 Runtime Session 释放。
这就是今天的串行化方式，只是 worker 现在被共享了。

`canStopDrained` 和 `requireStoppedRelease` 改为按 `(binding, generation, runtimeSessionId)`
把 holder 和 Runtime Session 关联到 binding，而不是要求 holder 的 Harness Session
等于 binding 的 isolation key。workspace isolation 没有 isolation key。

#### Session close 拆成释放与退役

关闭一个 Session 不能停掉其他 Session 正在用的 worker。PR2 把今天的 close 拆成两个操作：

1. **Session 释放**。在现有的永久 tenant/Harness Session drain fence 下运行。
   它枚举正在关闭的 Session 在 workspace isolation binding 上的 Runtime Session
   （在 `ma_runtime_session` 上新增一个按 Harness Session 查询的接口），对每个活跃的 Runtime Session：
   1. 发送 provider release；
   2. 发送 activation release，并等待原 worker 确认。worker 会 drain 该 Session 的后台任务，
      并报告已没有已准入的调用；
   3. 有条件地清除原 storage holder；
   4. 记录 `RELEASED`。

   该 Session 有未结算或 `UNKNOWN` 的执行时，与今天一样阻塞完成。binding 保持 `READY`，供其他 Session 使用。

2. **binding 退役**。即现有的 `drainBinding` 路径：drain、释放剩余 Session、`stopDrained`、
   持久化 drain 回执，然后 `RELEASED`。只有 PR4 的空闲回收或显式的 storage 退役会走到这里，
   单个 Session 的 close 永远不会。

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

#### worker 侧的上限

workspace isolation 把按 Runtime Session 的增长变成了一个长期进程内的增长：
installation、已关闭 Session 的占位记录和 `closedSessions` 每个 tool turn 各增长一条。
PR2 不改动 worker。PR4 的 generation 换代限制了一代 worker 的寿命，
因此这些结构在不改变其保留规则的前提下保持有界。

### 4.3 预热（PR3）

有两种触发方式，都只做放置。它们从不 acquire Runtime Session、不安装 context、不执行任何操作，
所以 actor 授权仍像今天一样在 acquire 时检查。

- **Session 创建时 warm**。绑定 Workspace 的 Session 创建提交后，通过现有 resolver
  异步调用现有的 `warm(sessionId)`。在 workspace isolation 下，如果该 storage 的 binding
  已经 `READY`，这一步什么都不做。此时还没有 Turn，所以不发公开事件。
  Turn 时的 warm 及其 `environment.*` 事件保持不变。
- **Keep-warm**。`qwen.managed-agent.runtime-broker.keep-warm` 列出若干
  `{tenant-id, storage-id}` 条目，这些条目必须同时出现在 `workspace-mounts` 中。
  一个定时协调器调用新的 Broker `warmPlacement` 入口，其请求由 Workspace resolver
  所用的同一个函数构造。测试会钉住：同一 storage 的 keep-warm 请求和绑定 Workspace
  的 Session 请求逐字节相同；否则预热的 worker 会落到一个没人用的 slot 上。
  该入口遵守 storage fence、drain fence 和放置阻塞，并跳过 Registry Workspace 不是
  `ACTIVE` 的 storage。keep-warm 要求 workspace isolation，因为 Session 存在之前无法知道
  Session isolation key。

### 4.4 空闲回收与 generation 换代（PR4）

`RuntimeIdleReaper` 用轮转游标分页扫描 provisioner 支持 drained stop 的 `READY`
managed-context binding，形态与 `RuntimeRecoveryCoordinator` 相同。

**回收条件**。按数据库时间判断，以下全部满足：

- 没有活跃的 Runtime Session；
- 没有未结算的执行，包括后台任务的 `:process` 行；
- 本 generation 没有 storage holder；
- 没有 drain 请求；
- 空闲至少 `idle-ttl`。PR4 先核实 `ma_runtime_binding.last_active_at`
  是否在 Runtime Session 释放和执行结算时维护；如果没有，就在这些状态迁移时维护该列，
  而不是另加第二个时钟。

keep-warm 的 binding 不受 `idle-ttl` 约束。

**换代**。服务过的 Runtime Session 数达到 `max-sessions-per-generation`，
或存活时间超过 `max-generation-age` 的 generation，会在下一个空闲点变为可回收，
不受 `idle-ttl` 或 keep-warm 限制。这就限制了 4.2 中 worker 侧的增长。

**与准入的竞态**。检查"没有活跃 Runtime Session"和设置 drain 请求必须在同一个事务中，
在 Runtime Session 准入已经会取的 binding 行锁下完成。此后该 binding 上的准入以可重试错误码拒绝。
因此回收器永远不会释放 Turn 正在使用的 Runtime Session，也就不需要中止路径。

**退役期间的放置**。今天 `DRAINING` 的 binding 会让同一 storage 上的新放置以不可重试的
`runtime_placement_recovery_required` 失败，空闲回收期间到达的 Turn 因此会直接失败。
PR4 记录 binding 处于 drain 的原因（在现有的 close/丢失路径之外，新增 `idle` 或 `recycle`），
仅对这两种原因返回可重试的 `503 runtime_placement_retiring`。PR4 让 Java 和 Harness
两侧的 warm、acquire 调用方在现有期限内对该错误码带退避重试。
drain 回执提交 `RELEASED` 之后，下一次 warm 创建 generation + 1。
close、丢失、人工恢复和停止失败的 drain 仍返回不可重试的错误。
记录原因需要改表结构，按 managed schema 合并的规则进行。

**停止**。退役复用 `drainBinding` → `stopDrained` → drain 回执 → `RELEASED`。
停止失败或未确认时，binding 保持 `DRAINING` 并带退避重试，与 reliable close 一致。
发现 worker 已不存在时转入现有的丢失路径。退役本身从不制造丢失证据，
也从不在原 generation 未结算时启动替代进程。

**session isolation（待确认问题 2）**。当 `idle-retirement.include-session-isolated=true` 时，
回收器也会退役仍未关闭的 Session 的空闲 session isolation binding。
该 Session 的下一个 Turn 通过普通 warm 路径创建 generation + 1。
这解决了今天每个 Session 的空闲 worker 无限增长的问题。

### 4.5 配置汇总

所有配置项均为提案，所有行为变化默认关闭。

| 配置项（`qwen.managed-agent.runtime-broker.`）             | 默认值                                                  | 切片 |
| ---------------------------------------------------------- | ------------------------------------------------------- | ---- |
| `isolation-class`（已有）                                  | `session`；新增允许 `workspace` 与 Workspace files 同用 | PR2  |
| `keep-warm`                                                | 空列表                                                  | PR3  |
| `session-create-warm`                                      | `false`                                                 | PR3  |
| `idle-retirement.enabled`                                  | `false`                                                 | PR4  |
| `idle-retirement.idle-ttl`                                 | 待测量                                                  | PR4  |
| `idle-retirement.max-sessions-per-generation`              | 待测量                                                  | PR4  |
| `idle-retirement.max-generation-age`                       | 待测量                                                  | PR4  |
| `idle-retirement.include-session-isolated`                 | `false`                                                 | PR4  |
| `idle-retirement.scan-delay`、`idle-retirement.batch-size` | 与恢复扫描同样有界（5 s，8）                            | PR4  |

时长遵循现有的单位规则，必须写后缀。

## 5. 决策与理由

| 决策                                                             | 理由                                                                             | 被否决的方案                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 让 binding 常驻，而不是让进程常驻                                | 保留 seed、attestation、incarnation 和 `UNKNOWN` 规则，这些已经过 W0e 物理验证。 | 一个长期进程接受多个 lease 并持久化调用记录：要重写恢复模型，还需要持久回执存储。             |
| 通过 workspace isolation 按 `(tenant, storage)` 共享             | 复用现有隔离类别和放置 key；storage holder 本来就串行化 turn。                   | 预先启动一池 session isolation worker：Session 存在之前无法知道 isolation key。               |
| Session close 只释放，只有退役才停 worker                        | 关闭一个 Session 不能停掉其他 Session 在用的 worker。                            | 最后一个 Session 关闭时停 worker：恰好在最需要常驻的时候失去常驻，还会与下一个 Session 竞态。 |
| 以 activation release 确认作为 workspace isolation 的 close 证据 | holder 释放已经信任这一证据；对逃逸的子孙进程，进程死亡并不是更强的证据。        | 每个 Session 都要求进程死亡：与共享不兼容。                                                   |
| 只对 idle/recycle drain 返回可重试错误                           | Turn 不能因为平台回收了空闲 worker 而失败。丢失和 close 继续 fail closed。       | 所有 `DRAINING` 都可重试：会掩盖真正需要恢复的情况。                                          |
| 排除 child Workspaces                                            | 它们的 merge 依赖已关闭的 child 停止自己的 worker。                              | 在本工作中一并泛化 child close：那是另一项设计。                                              |

## 6. 交付切片

| PR  | 范围                                                      | 依赖 | 行为变化   |
| --- | --------------------------------------------------------- | ---- | ---------- |
| PR0 | 本中英文设计文档                                          | —    | 无         |
| PR1 | Provisioner 能力（4.1）                                   | —    | 无         |
| PR2 | 绑定 Workspace 的 Session 使用 workspace isolation（4.2） | PR1  | 需显式开启 |
| PR3 | 预热（4.3）                                               | PR2  | 需显式开启 |
| PR4 | 空闲回收与换代（4.4）                                     | PR2  | 需显式开启 |

PR3 和 PR4 可以并行。PR2 如果超过约 1000 行生产代码，就拆成 Broker 侧的释放/退役拆分，
以及控制面配置加端到端测试两部分。每个切片都要同时更新本文档的中英文版本。

## 7. 失败语义

| 事件                                    | 行为                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| B 正在使用共享 worker 时 Session A 关闭 | A 的 Runtime Session 通过原 worker 释放；binding 保持 `READY`；B 不受影响。            |
| A 的 close 遇到 A 的 `UNKNOWN` 执行     | A 的 close 保持 `recovery_blocked`；binding 和 B 不受影响。                            |
| 原 worker 无法确认 A 的释放             | A 的 close 等待 binding 级停止或丢失证据（今天的规则）。                               |
| 空闲退役期间有 Turn 到达                | 返回可重试的 `runtime_placement_retiring`；drain 回执提交后在 generation + 1 上成功。  |
| 空闲停止失败或未确认                    | binding 保持 `DRAINING`；带退避重试停止；不启动替代进程。                              |
| worker 在空闲时死亡                     | 走现有丢失路径。同一 boot 内的死亡会保留 holder 等待恢复。                             |
| 有常驻 worker 时 Broker 重启            | 现有持久接管流程重新 attest 原 worker。                                                |
| 回收器与准入竞态                        | 在 binding 行锁下串行：准入先到则回收器跳过，否则准入看到 drain 请求并得到可重试拒绝。 |

## 8. 风险与约束

- **close 证据变弱**。workspace isolation 的 Session close 依赖 worker 自己声明的释放。
  这是需显式开启的，有文档说明，session isolation 仍是默认值。
- **影响范围**。共享 worker 崩溃会影响该 storage 上的所有 Session。storage 级的影响与今天相同：
  - 无论哪个 Session 的 worker 崩溃，`LOST` 的 managed-context binding
    本来就会阻塞同一 storage 上的新放置，直到恢复完成（`RuntimeBindingRecord.java:368`）；
  - storage holder 本来就只允许每个 storage 有一个活跃 Runtime Session，
    所以一次崩溃最多中断那一个 Session 的工作。

  变化在于：原本在该 storage 上空闲的 Session，现在也会失去一个已预热的 worker。

- **保留**。持久模式仍然从不清理注册文件和锁文件。退役减少的是存活进程，不是 state 目录条目。
- **未测量的默认值**。TTL、换代阈值和 keep-warm 成本需要先在目标部署上测量，才能提出默认值。
- **仅限 Linux**。持久 local worker 和 drained stop 都要求 Linux，本功能也一样。

## 9. 验证计划

- **PR1**：现有 Java 和 TypeScript 测试保持通过。新增单元测试，
  为每种 provisioner kind 把每个新能力钉到旧字面量判断的结果上。
- **PR2**：在 Linux 上用持久 local worker 和 MySQL 做真实进程 E2E：
  - 两个 Session 共享同一个 binding ID、generation 和 worker PID；
  - 同一 storage 上的 turn 以 `workspace_busy` 串行；
  - 关闭 A 之后 B 的下一个 Turn 仍在同一个 worker 上；
  - A 的后台 Shell 任务随 A 的 close 停止，B 的任务继续；
  - Broker 被 `SIGKILL` 后接管共享 worker；
  - 丢失确认后对同一个已关闭的 gate 重试；
  - session isolation 的 close 行为不变。
- **PR3**：keep-warm 和 Session 创建时 warm 在第一次工具调用之前达到 `READY`。
  钉住测试证明请求与 resolver 逐字节相同。被 fence 或不活跃的 storage 会被跳过。
- **PR4**：
  - 空闲退役产生 drain 回执并进入 `RELEASED`；
  - 退役期间到达的 Turn 重试后在 generation + 1 上成功；
  - 服务 N 个 Session 后发生换代；
  - SQL 并发测试覆盖回收器与准入的竞态；
  - 停止失败和空闲时 worker 死亡各自走对应路径；
  - 打开 session isolation 覆盖后，未关闭的 Session 在新 generation 上继续。
- **全部**：build、typecheck、bundle、Java 测试与 Checkstyle，以及连续两遍干净的全 diff 自审。

## 10. 验收标准

- 使用默认配置时，行为和 SQL 状态与今天完全一致。
- 使用 workspace isolation 时，同一 storage 上的所有绑定 Workspace 的 Session
  同一时刻只使用一个存活的 generation，关闭单个 Session 永远不会停掉它。
- 空闲退役从不释放活跃的 Runtime Session，也没有 Turn 因 idle 或 recycle drain 而不可重试地失败。
- 每个进入 `RELEASED` 的常驻 binding 都带有 drain 回执，或者丢失加写入者已停止的证据。
- 没有任何路径会重放 `UNKNOWN` 执行，或在原 generation 未结算时启动替代进程。
- 本文档的两种语言版本都反映每个已落地的切片。

## 11. 范围外与后续工作

- 持久的、经过 attestation 的注册型常驻 worker，用于替代 `static`。
  它需要 worker 侧的 lease 注册与轮换，以及单独的设计。
- 通过 SSH 的远端放置和反向连接的 worker。
- 把 child Workspace close 泛化到共享 worker。
- 清理持久模式的注册文件和锁文件。

## 12. 待确认问题

1. 原 worker 的 activation release 确认能否作为 workspace isolation Session 的
   reliable close 证据（4.2）？
2. 空闲回收是否也应覆盖未关闭 Session 的空闲 session isolation binding（4.4）？
3. 第一次交付是否需要 keep-warm，还是只做 Session 创建时 warm 就够了（4.3）？
4. TTL、换代和 keep-warm 的默认值由哪些部署测量来确定？
