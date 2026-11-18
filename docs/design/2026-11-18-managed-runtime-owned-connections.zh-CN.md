# Managed Runtime 持有 MCP/Hook 连接生命周期（第二阶段）

[English](2026-11-18-managed-runtime-owned-connections.md) | [简体中文](2026-11-18-managed-runtime-owned-connections.zh-CN.md)

状态：调研 + 详细设计，正在本 PR 上实现；在 §7 测量门槛通过前，park 默认关闭（`qwen.managed-agent.runtime-broker.mcp-parking.enabled`）。日期：2026-11-18。本文是[无状态 Hosted Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)（#17527）第二阶段的实现前设计，基于 `main` 的 `5381294538` 核实，该提交已包含合并的第一阶段 PR #17690（merge `7150c58a01`）。父设计第二阶段"只定义边界；实现前另写设计"，本文承接该边界并给出方案、成本模型、与第一阶段的交互、测量计划与可行性结论。结论中的成本占比是**代码级解析估算，尚未实测**；实测是实现门槛（父设计："其占比必须测量"）。

## 1. 问题与现状

第一阶段让空闲 Session 挂起：teardown 第 2 步非终态 close Hook/MCP owner，冷打开重新安装。对配置了 MCP 的 Session，这意味着每次挂起/重开都要**物理断开并重连每条 MCP 连接、重新发现目录**。本节核实这部分成本住在哪里、由谁持有。

### 1.1 物理连接已经在 Runtime，生命周期却绑在 Harness attach

三层归属（与 [MCP 运行时设计](2026-09-28-managed-mcp-runtime.zh-CN.md)一致）：

- **Tool Runtime（worker 进程）** 持有物理 transport。`packages/cli/src/serve/managed-mcp-runtime.ts` 的 `ManagedMcpRuntime` 按 `runtimeSessionId` 维护 `connections`/`operations`/`pendingStarts`，stdio 子进程与 HTTP/SSE 连接都在这里。配额 `MANAGED_MCP_MAX_CONNECTIONS = 16`（`packages/core/src/managed-runtime/managed-mcp-protocol.ts`）、`MAX_INFLIGHT = 32`、连接/发现上限 `TIMEOUT_MS = 25_000`。
- **Runtime Broker（Java）** 解析 Session 与原 Runtime、检查 Workspace owner、以原身份转发 MCP control。`RuntimeBrokerService.acquire/release/releaseMount`（`packages/managed-agent-server/runtime-broker/.../RuntimeBrokerService.java`）。
- **Hosted Harness** 持有编排对象 `HostedMcpSession`（`packages/cli/src/serve/hosted-mcp-session.ts`）与 HTTP 客户端 `HostedWorkspaceBroker`（`hosted-workspace-broker.ts`），负责提交 intent/配置记录、派发 control、接受回执。

关键事实：**worker 进程跨 attach 存活**。本地进程 provider + workspace capability + `isolationClass = workspace` 的 binding 是 workspace 共享的（`HarnessOwnership.sharesRuntimeSessions`），一个 worker 承载该 workspace 的多个 Runtime Session。`WorkspaceRuntimeTransport.releaseMount`（`control-plane/.../WorkspaceRuntimeTransport.java`）明确："Only the execution mount … **The worker keeps the installation a re-drive reuses**"——交还 mount 不停 worker，只有完整 `release` 才 `activateWorkspace(..., false)`。`JdbcRuntimeRetention` 只清理"已退休且无引用"的 generation，不按空闲停活 worker。

所以"连接归 Runtime"在物理层**已经成立**；绑在 attach 上的是三件事：

1. **drain 义务**：挂起/detach 时 Harness 必须派发 `mcp-release` 让 worker 物理关闭连接。
2. **mount 成员资格**：MCP owner 是 workspace storage 的执行成员（§1.4），挂起时交还该成员资格。
3. **重装**：下一次 load 重新提交配置、重连、重新发现。

### 1.2 owner 身份与重连/复用路径

- **durable owner id**：`hostedDurableMcpOwnerId(sessionKey, configurationIdsDigest)` = `mcp-` + sha256，每次 load 由非 released 配置行重算（`hosted-mcp-session.ts`）。Hook 用 config-scoped owner（`hosted-hook-session.ts`，`isHostedConfigScopedOwner`）。非终态 close 不留 RELEASED tombstone，owner 保持可重获取。
- **建立（冷打开或首个 prompt）**：tool turn 声明工具前调 `mcp.refresh(signal)`（`hosted-workspace-tool-turn.ts`）→ `ensureReady()`（memoized）→ `initialize()` → **逐 server 串行** `install()`：
  1. 若前一行 `drained`/`released`：先 drained→released 提交，再在**同一 owner** 下开新 active 行（提交）；
  2. `acquireOwner()`：`broker.acquire()`（HTTP）+ 对每个有 catalogRef 的非 released 配置做 grant 续租提交（`commitConfiguration(record, renew=true)` 推进持久修订）；
  3. 提交 `dispatch_started`；派发 `mcp-configure`（worker：spawn stdio / 连 HTTP + initialize + tools/resources/prompts list，≤25s）；
  4. publish catalog 资源 + 提交 settled + 把同 owner 的兄弟 drained 行推进 released。
- **每 turn**：`refresh()` → `ensureReady`（已 memoize）+ `acquireOwner` + 对每个 catalog 派发 `mcp-discover`。除非目录已 stale 或 failed，worker 直接用缓存目录应答，所以**健康的 discover 不产生远端往返，也不能证明远端的任何状态**。**resident turn 与 cold turn 都付这部分**。
- **挂起 teardown 第 2 步**（`hosted-harness-session.ts` `attemptSuspend`）：`hooks.close({terminal:false})` + `mcp.close({terminal:false})`。`mcp.close` = `reconcileEffects()`（结算所有未决 operation/configuration）+ `closeResources()`：逐配置 `drainConfigurations`（提交 releasing → 派发 `mcp-release` → worker 物理关闭 → 提交 drained）+ `broker.releaseMount()`（交还 mount，owner 仍可重获取）。
- **复用路径已存在**：`install()` 遇到 `previous.releaseState === 'active'` 且 settled 的行时，不派发 `mcp-configure`。它对原 configure 操作发一次 `mcp-status` 查询，worker 用内存中的操作记录应答，再用已存 catalog 的 digest 校验结果。今天这条路径用于崩溃重载（行仍 active）。**第二阶段就是让挂起也留下 active 行，从而走这条复用路径。**
- **连接丢失后的替换已存在**：对已关闭连接做 discover 会以 `managed_mcp_binding_conflict` 结算，`refresh()` 随后配置替换连接。worker 从不把已关闭连接移出 map，所以对这类连接的 `mcp-release` 仍能结算。今天被替换的行会一直保持 `active` 到 Session 关闭，每次 load 的 `acquireOwner` 都会为它续租。

### 1.3 Hook 的现状

Hook 没有持久 transport——它是按事件派发到 worker 的执行，与 MCP 共享 broker/mount（`HostedHookSession`）。非终态 `close()`（`hosted-hook-session.ts`）= `drain()`（结算未决执行）+ `releaseEarlierOwners`（释放被取代的旧 config-scoped owner）+ 回收 recovered broker + 重试 fenced owner，最后**仅当 Hook 会话自己持有 broker 时**，才为当前 deterministic owner 交还 mount（不 terminal release）。有 MCP 的 Session 会把 `session.mcp?.broker` 传给 Hook 会话，此时 `ownsBroker` 为 false，Hook close 从不交还共享的 mount。只有 Hook 的 Session 自己持有 broker，必须继续交还 mount。**因此第二阶段不改动 Hook。**

### 1.4 存储 mount 语义

mount 并非一律独占，其影响取决于存储类型：

- **`LOCAL` / `SSH_LOCAL`**：执行是**共享成员资格**。每个声明 mount 的 Runtime Session 都会递增 `ma_storage_owner.member_count` 并记录 `ma_runtime_session.execution_storage_key`（`JdbcWorkspaceExecutionStore`），因此多个 Session 可以同时运行在同一 storage 上。在 `LOCAL` 存储上，成员资格会阻塞物理维护：`holdForMaintenance` 要求 `member_count = 0`，主 Session 的 worktree 准备除外。
- **`EXTERNAL`**：storage 只有**单一持有者**（`JdbcExternalWorkspaceOwnership`），竞争方的 acquire 会收到可重试的 `workspace_busy`。

因此 [MCP 运行时设计](2026-09-28-managed-mcp-runtime.zh-CN.md)中"每 tenant/storage lease 仅一个 attached MCP owner"只符合单一持有者的情形；`LOCAL` / `SSH_LOCAL` 存储允许多个成员。

## 2. 目标与范围

**目标**：连接仍可用时，挂起/重开不再 drain、重连、重新发现 MCP 连接。Runtime 侧在多次 attach 之间保留连接，由 Broker 在空闲一段时间后回收；Harness 凭 durable owner 身份 + 签发给新写者的 grant 重新获取。

**范围（本提案，第一增量）**：

- 在 `LOCAL` / `SSH_LOCAL` 存储上且 Broker 声明支持 park 时，挂起让 MCP owner 进入 **parked**（连接存活、mount 成员资格保持、grant 自然过期），而非 drain。
- 重开走既有 active-row 复用路径，在声明工具前重新校验远程连接，并替换已不可用的连接。
- Broker 新增**空闲回收**：parked 连接在空闲一段时间后被物理关闭，成员资格随之交还。
- worker 在配额压力下驱逐空闲连接。
- 恢复视图契约措辞更新 + parked owner 可观测性。

**范围外（后续增量）**：

- **连接寿命与存储所有权解耦**（H1 遗留开放问题）：允许 parked 连接存活时交还 mount。需要 fence stdio server 对 workspace 的写入，是更大的安全工程，本提案不做（见 §5.4）。
- 在 `EXTERNAL` 存储上 park：parked owner 会排斥所有竞争方（§5.4）。
- worker 丢失后自动重装（§5.7）。
- journal 恢复成本（随历史增长的部分）——父设计明确第二阶段不消除它。
- 第三/四阶段（wake 调度、审批停靠）。

## 3. 成本模型（解析估算，未实测）

### 3.1 基线重述

WP3 测量（本地记录，未提交到本仓库）得出：冷打开 overhead **~91 statements 平坦**（1/40/200 turn），边际 idle 节省 46/min/session，收支平衡 ~2min。**该测量是纯文本 Turn、无 Runtime worker、无 MCP**。所以 ~91 是**无 MCP 的地板**，MCP 重连成本完全在其之上，不是"~91 的一小部分"。问题不是"MCP 占 ~91 多少"，而是"MCP 在 ~91 之上加多少"。

### 3.2 每挂起/重开周期的 MCP 增量（K = server 数）

按 §1.2 逐提交计数（每 `commitExtensionRecord` ≈ journal event + resource + `ma_session_record` 投影 + head 修订更新）：

| 阶段              | 操作                                                                                                                      | 量级                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 挂起 drain        | 逐配置 releasing 提交 + `mcp-release` 派发 + drained 提交                                                                 | ~2K 提交 + K 次 worker 物理关闭 |
| 冷开 reinstall    | 逐 server：released 提交 + active 行提交 + dispatch_started 提交 + catalog publish + settled 提交 + 兄弟 drained→released | ~5K 提交 + K 资源 publish       |
| 冷开 acquireOwner | 1 次 broker.acquire + 逐配置 grant 续租提交                                                                               | ~K 提交 + 1 HTTP                |
| 冷开物理重连      | 逐 server **串行** `mcp-configure`：spawn/连接 + initialize + 3 个 list                                                   | K 次重连+发现（每次 ≤25s）      |

合计冷开 MCP 增量 ≈ **6K–7K journal 提交 + K 资源 publish + K 次串行物理重连/发现**，外加挂起侧 ~2K 提交 + K 次物理关闭。

**延迟由串行物理重连主导**：`initialize()` 是 `for...of` + `await`，K 个 server 顺序重连。本地 stdio 约 100–500ms/server；远端/慢 server 每个可达 25s 上限。K=16 时冷开延迟可加数秒到数十秒。这是用户感知的 wake 延迟，也是第二阶段最大的收益项。

### 3.3 第二阶段消除什么

parked 复用后，重开 MCP 路径退化为：`acquireOwner`（1 broker HTTP + ~K grant 续租提交）+ K 次 `mcp-status` 查询 + 每个远程 server 一次 `ping`（§4.3）+ 每 turn refresh discover（resident 本就付）。**消除**：挂起 drain（~2K 提交 + K 关闭）+ 冷开 reinstall（~5K 提交 + K publish + **K 次串行重连/发现**）。冷开 MCP 增量从 ~7K 提交 + K 重连 降到 ~K 提交 + 1 acquire + K 次 status 往返 + 至多 K 次 ping。

收益随 K 与重连延迟放大；K=1 快本地 stdio 时 SQL 收益 modest（数十 statements），但延迟收益仍在。重开时发现某条连接不可用，只为该 server 付替换成本。

### 3.4 重连见证（最易观测的测量）

IT fixture `hosted-mcp-fault-process.mjs` 在每次进程启动记 `mcp.start`、退出记 `mcp.exit`。第一阶段每次冷开 +K 个 `mcp.start`；第二阶段 parked 复用应为 0（直到空闲回收）。这是不依赖 SQL digest 窗口的直接重连见证。

## 4. 方案

### 4.1 parked owner 状态

**parked** owner 指 Session 的 journal head 已 `SEALED`、而其 Runtime Session 仍持有执行成员资格的 owner：连接存活、journal 配置行为 `active` + `run.state = settled`、grant 自然过期（`leaseDurationMs = 300_000`）。parked **由已有的持久状态推导得出**，既不是新的 journal `releaseState`，也不是新的 Broker 或 worker 状态。

**为什么不需要新 journal 状态**：`ManagedExtensionProjection.runtimeState`（`contracts/.../ManagedExtensionProjection.java`）由 `run.state` 推导——`settled` 属 TERMINAL → `runtime_state = null`，**与 `releaseState` 无关**。所以 parked（active+settled）配置行已满足恢复视图的"无活 Runtime 执行"判据（§6.3）。新增 journal 状态会破坏既有投影/恢复证明，无必要。

### 4.2 挂起路径改动

满足以下全部条件时，teardown 第 2 步对 MCP 从 drain 改为 park：

1. **Broker 声明支持 park。** acquire 回复携带新字段 `mcpParkable`，仅在 `LOCAL` / `SSH_LOCAL` 存储且部署已启用回收时为 true。字段缺失或为 false 时，Harness 照旧执行第一阶段的 drain。
2. **仍调 `reconcileEffects()`**：结算所有未决 operation/configuration。未决副作用仍阻止挂起（与今天一致，eligibility 谓词也独立拦截 `mcpBusy`/`mcpRecovering`）。parked 连接都已 settled，所以 park 不会携带未知结果。
3. **每个 server 只保留最新行为 active。** 被取代的非 released 行通过既有 `drainConfigurations` drain。若剩余行中有任何一行不是 `active` + `settled`，Harness 回退到今天的 drain。

随后 park **对最新行跳过 `drainConfigurations`，并跳过 `releaseMount`**。连接留在 worker，成员资格保持持有。Harness 不发送任何通知：teardown 第 5 步 seal 写者本身就使 owner 成为 parked。

Hook 不变（§1.3）。teardown 第 3 步 `releaseLeaseNow` 不变：对 MCP-owned lease 本就返回 false。

### 4.3 重开复用路径

冷打开构造 `HostedMcpSession`（同一 durable owner），首个 prompt 的 `install()` 见到 active+settled 行：

1. **先 acquire。** 复用分支在 `mcp-status` 查询之前调用 `acquireOwner()`。`lookup` 会把所有失败都报告为 `outcome_unknown`，`install()` 再把它变成 recovery-required；先 acquire 能让可重试的 `workspace_busy` 或 Broker 拒绝按原样暴露，与全新安装路径一致。
2. **查询并校验。** `mcp-status` 返回原 configure 结果，再用已存 catalog 的 digest 校验。不重连。
3. **声明工具前重新校验。** 重开后的首次 `refresh()` 发送带新可选字段 `revalidate: true` 的 `mcp-discover`。对远程 transport，worker 在较短超时内发送 MCP `ping`；JSON-RPC `-32601` 回复视为存活。其他任何失败都由 worker 关闭连接并应答 `managed_mcp_retiring`。stdio 连接跳过 ping，因为进程退出本身就会关闭连接。
4. **先替换不可用连接，再退役旧行。** 遇到 `managed_mcp_binding_conflict`，或重新校验的 discover 返回 `managed_mcp_retiring` 时，`refresh()` 先走既有路径配置替换连接，再通过既有 `drainConfigurations` 退役旧行（已关闭连接的 `mcp-release` 会立即结算）。替换被拒时旧行保持 `active`，Session 不会进入 recovery-blocked，下一次 load 会重试。若替换成功后该 release 未能干净结算，Session 保持 recovery-required。

| 重开时的连接状态                       | 检测方式                          | 结果                                           |
| -------------------------------------- | --------------------------------- | ---------------------------------------------- |
| 存活且被 server 接受                   | 重新校验通过                      | 复用；不发 `mcp-configure`                     |
| 远程会话过期或凭据被拒                 | `ping` 失败                       | 先重配再退役；凭据被拒会在模型 turn 开始前失败 |
| 已被回收、驱逐或进程退出               | `managed_mcp_binding_conflict`    | 先重配再退役                                   |
| worker 丢失（Runtime generation 变化） | `acquireOwner` 的 generation 检查 | recovery-required，不变（§5.7）                |

**为什么必须重新校验**：否则 park 期间过期的远程会话要到第一次工具调用才暴露。此时 `send` 失败，worker 记录 `outcome_unknown`，Session 因一次 server 根本没有执行的调用而进入 `recovery_blocked`。第一阶段每次 wake 都重连，所以不会遇到这个问题。

**重新校验能证明什么**：连接存活，且 server 在那一刻接受其凭据。它不断言逐工具的授权。definition 凭据是 Runtime 持有的静态 header/环境变量，HTTP transport 在每个请求上都会发送，远程 server 自己对每次调用鉴权，因此 park 不会引入缓存的授权。探测之后连接仍可能失败，这与 resident Session 的情况相同。

### 4.4 Broker 空闲回收

Broker 用一个与 `RuntimeRetentionJob` 同形的定时任务回收 parked owner。资格判定是基于现有列的数据库谓词，无需改 schema：

- `ma_runtime_session`：`session_state = 'READY'` 且 `execution_storage_key IS NOT NULL`；
- 匹配的 `ma_session_head`（同 tenant 与 `harness_session_id`，`head_kind = 'MANAGED_SESSION'`）：`state = 'SEALED'` 且 `gmt_modified` 早于空闲时长。

resident Session 的 head 是 `ACTIVE`，永远不符合资格。之后的 head 更新（例如 wake 投影）只会推迟截止时间。对每个符合资格的 owner：

1. **要求活 binding。** 任务只处理当前 Broker 进程持有的活 binding，其他 owner 一律跳过，不做接管。重启后由既有的 `RuntimeRecoveryCoordinator` 恢复已保存的 binding，之后的某一轮再回收其 owner。
2. **关闭连接。** Broker 调用新的 Broker 专用 worker 路由 `/internal/managed-runtime/v3/mcp/reclaim`。`hasPendingWork` 为 true 时 worker 拒绝；否则执行既有 `drainSession`。拒绝不改变任何状态，下一轮重试。Harness 的 control 路由无法到达这个 worker 路由。
3. **交还成员资格。** Broker 在 Session 锁内复查 head 仍为 `SEALED`，读取当前 mount claim，并调用既有的 `releaseMountAfterSweep` 守卫；该守卫会拒绝已被取代的 claim、活跃 control，以及存活或未证实结束的后台执行。

连接先于成员资格交还而关闭，所以 stdio server 不可能写入已不再持有的存储。回收是**非终态**的：完整 release 会在下一次 load 重算出的 id 下留下 RELEASED tombstone，从而卡死 durable owner。journal 行不变；后继 Harness 通过 §4.3 替换连接。

**与重开的竞争**：回收期间 acquire 的后继者会取代 claim，因此第 3 步保留其成员资格。第 2 步关闭的连接都通过 §4.3 替换，打到已关闭连接上的工具调用会在发送任何内容之前以错误结算。

**维护**：当 `holdForMaintenance` 因 parked 成员而返回 `workspace_busy` 时，它请求立即回收这些成员，不受空闲时长限制。维护调用方对这一可重试拒绝的常规重试随后即可继续。

### 4.5 配额

parked 连接计入 worker 共享的 16 连接配额。`mcp-configure` 达到配额时，worker **驱逐**最久未使用的连接，条件是：属于其他 Runtime Session、没有未决请求、且至少在 300s grant 租期内未被使用。没有这样的连接时，configure 照旧以 `managed_mcp_connection_quota` 失败。

驱逐不需要预算常量或 drain 回退，因为被驱逐的连接会通过 §4.3 替换，而已 settled 的连接不携带未知结果。驱逐只关闭连接；成员资格由 §4.4 释放。

### 4.6 对父设计待定义接口的回答

- **挂起 owner 与释放 owner 的区分**：挂起留下已 seal 的 head 和可重获取的 owner；释放是既有的终态 release 及其 tombstone。不需要新动词。
- **谁回收连接、何时回收**：Broker 在空闲时长后回收，维护需要时提前回收；worker 在配额压力下驱逐。
- **unknown-outcome 占用及其配额放在哪里**：不新增位置。带未知结果的 owner 永远不会 park，worker 也拒绝回收有未决工作的 Runtime Session。

## 5. 设计决策与理由

### 5.1 parked 状态由推导得出，不设 park 动词

不采用显式 park 通知。通知丢失时无论如何都需要兜底的空闲信号，而这个兜底本身就足够了。已 seal 的 journal head 本来就是持久的，能跨 Broker 重启，能区分 parked 与 resident Session，也不会丢失。去掉动词还消除了 teardown 的一个失败分支，以及通知与 seal 之间的竞争。

### 5.2 不新增 journal releaseState

parked 行保持 `active`+`settled`（§4.1）。理由：复用路径据 `active` 识别；投影 `runtime_state` 由 `run.state` 推导已为 null；新增状态会破坏恢复视图证明与既有 drained/released 状态机，无收益。

### 5.3 不设持久回收回执

后继者只需要知道连接已经不在。Runtime generation 不变时，关闭连接的那个 worker 仍在运行，会通过 `managed_mcp_binding_conflict` 给出权威应答。generation 变化时，无论有没有回执，Session 都是 recovery-required（§5.7）。持久回执不会决定任何结果，所以不增加，也不需要改 Broker schema。

### 5.4 成员资格保持持有；park 仅限共享成员资格的存储

park 期间成员资格保持持有。理由：H1 明确 stdio server 仍能访问 Workspace 时释放存储会允许并发写入，连接寿命与存储所有权解耦属于后续工作。

**`LOCAL` / `SSH_LOCAL` 上的代价**：其他 Session 不受阻塞，因为成员资格是共享的（§1.4）。在 `LOCAL` 存储上，parked 成员会阻塞要求 `member_count = 0` 的物理维护；§4.4 按需回收，维护最多被延迟一次回收的时间。

**`EXTERNAL` 存储在第一增量不 park**：其单一持有者会排斥所有竞争方直到回收。这些 Session 保持第一阶段的 drain。

### 5.5 挂起仍释放 Harness 资源

mount 是 Broker 侧 claim，不是 Harness 资源。park 保持 mount 不妨碍 Harness seal 写者、释放 activation、drop resident、停续约——第一阶段的核心收益（内存/端口/续约 SQL）全部保留。

### 5.6 由 Broker 声明 park 作为发布控制

父设计记录了挂起没有 kill switch。`mcpParkable` 为第二阶段提供了一个：只要 Broker 不声明支持 park，所有 Session 都保持第一阶段的 drain。Broker 仅在 `qwen.managed-agent.runtime-broker.mcp-parking.enabled` 为 true 时声明，该配置默认关闭。它也保证了没有回收能力的部署永远不会启用 park。

### 5.7 worker 丢失仍为 recovery-required

park 期间 Runtime generation 变化仍为 recovery-required。现有故障门禁 `workerKillWhileIdleNeverMintsAFreshOwnerOnMySql`（`HostedMcpRestartFaultGatesIT`）有意固定了：空闲时被杀的 worker 绝不产生新 owner，也不启动第二个 server。park 不削弱这一契约。是否对已证明 settled 的 owner 放宽，是另一项决策（§10）。

## 6. 与第一阶段的交互

### 6.1 资格谓词

`suspensionLiveWork`（`hosted-harness-session.ts`）拦截 `mcpBusy`/`hooksBusy`/`mcpRecovering > 0`、`heldRuntimeTurns`、活 monitor loop、未结算 child/monitor run、`clientFiles`、`streams`、public-shell MCP 无 lifecycle v2。**不因"有 MCP 配置"本身拦截**私有 `hosted-workspace-mcp/1` Session。第二阶段保留这些：未决工作仍阻止挂起；parked 空闲连接不是"live work"。

### 6.2 teardown 顺序与 #8 有界恢复证明

teardown 顺序：wake → owners（第 2 步）→ lease（第 3 步）→ publishers → writer seal（第 5 步）→ stopLocal。第二阶段把第 2 步从 drain 改为 park（reconcile 并退役被取代的行），仍在 seal 前的可回退边界。此处失败沿用今天 drain 失败的路径。

**#8 证明保持**（[有界恢复补篇](2026-11-18-managed-suspension-bounded-recovery.zh-CN.md)）：该证明依赖**写者围栏**（租约过期 → 任何 acquire generation+1），**不依赖 SEALED ⟹ 资源已释放**。资源义务由后继冷打开经既有 takeover/cleanup 路径对账。park 把资源留给 Runtime 照管，后继冷打开复用或替换——正好落在证明已声明的崩溃恢复同形分支。

### 6.3 恢复视图

恢复视图（[补篇](2026-11-18-managed-suspension-recovery-view.zh-CN.md)）`ready` 判据要求 `ma_session_record.runtime_state` 为空。已核实：`mcp_configuration` 投影 `runtimeState` 由 `run.state` 推导，settled → null，**与 releaseState 无关**。故 parked（active+settled）配置行**已满足**该判据，无需改投影。需要：

- 契约措辞："重新安装 owner" → "复用或重新安装 parked owner"。
- "无未结算工作"仍须成立（无未决 `mcp_operation`）——park 前 reconcile 保证。
- 被回收但 journal 仍 active 的连接：视图可保持 ready，load 负责替换（§4.3）。
- 可观测性：每轮回收记录扫描到、处于 parked 以及已回收的 owner 数量。

### 6.4 cleanup debt

`hasHostedCleanupDebt`（`hosted-turn-cleanup.ts`）跟踪 `hosted.cleanup` owed 事件（turn 级 Runtime 租约）。park 不增加持久义务：唯一的 park 失败是 reconcile 结算不了未决操作，那与今天一样已阻止挂起。**不引入新的持久 cleanup debt 类**；替换被回收的连接走 §4.3 的 load 路径，而非 cleanup debt 扫描器。须在实现中验证此点（§8）。

## 7. 测量计划（实现门槛）

父设计："其占比必须测量"。本文 §3 是解析估算，**实测是启用门槛**。两条路径：

### 7.1 扩展 WP3 rig（TS，推荐）

WP3 rig 是本地脚本（MySQL8.4 + Spring exec jar + hosted-harness bundle + fake model，performance_schema digest 窗口法），未提交到本仓库。扩展为 MCP：

1. **MCP fixture server**：复用 `packages/managed-agent-server/verification/src/test/resources/hosted-mcp-fault-process.mjs`（自包含 stdio MCP，记 `mcp.start`/`mcp.exit`）。
2. **远程 fixture server**：新增 Streamable HTTP fixture，记录 `initialize` 与 `ping` 请求，并能按需让会话过期或拒绝凭据。
3. **manifest + worker wrapper**：写 `mcp.json`（stdio，command=node，args=[fixture,'mcp',evidence,'1']，definitionDigest 与 session pin 一致）+ `worker.mjs`（设 `QWEN_MANAGED_MCP_CONFIG` 后 import dist/cli.js，仿 IT）。Spring 设 `QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY` 指向 wrapper。
4. **profile + workspace**：Spring 设 `QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES=hosted-workspace-mcp/1`。workspace 需 IT 式注册（`ma_workspace` 用 `WorkspaceExecutionProfile.CONFIG_REF` + `ma_workspace_access` + storage guard register），使 broker scope capabilityDigest = `WORKSPACE_CAPABILITY_DIGEST`（TS broker `readRuntime` 接受）。**注意**：IT 用 Java bean（`guard.register`、`store.insertWorkspaceSessionCommand`）建栈，TS rig 需找 HTTP/SQL 等价步骤——这是主要工程难点。
5. **agent definition + session**：POST `/v1/agents`（`tools:[{type:hosted_profile,profile:hosted-workspace-mcp/1}]` + `mcp_servers` pin + `permission_policy:{approval_mode:yolo}`），再 POST `/v1/agents/sessions`。
6. **测量**：同 rig（resident-turn 基线 → 等挂起 → cold-open turn），digest 窗口取 SQL 差；额外数 evidence 文件 `mcp.start` 事件（重连见证）。对比 K=1/4/16。

### 7.2 新增 Java IT（备选）

在 verification 模块新增 IT，仿 `HostedMcpRestartFaultGatesIT` 建栈（真实 Harness + worker + MySQL），但测挂起/重开的 SQL + 计时 + `mcp.start` 计数。需要 `packages/managed-agent-server/AGENTS.md` 所述的隔离 Maven 仓库与 sibling SDK 安装，以及 `mysql.url` 系统属性。优点：建栈步骤已被 IT 解决；缺点：Maven 验证链重。

### 7.3 测量产出

- 冷开 MCP 增量 statements（K=1/4/16）vs §3.2 估算。
- 冷开 MCP 增量 wall-clock（串行重连延迟），分 stdio 与远程 server。
- 每个远程 server 的重新校验延迟，以及重开时发现连接不可用的频率。
- 挂起 drain 增量 statements。
- `mcp.start` 重连计数（第一阶段 +K/冷开）。
- 据此选定空闲时长与重新校验超时，并确认收益值得（§9）。

## 8. 约束与风险

- **parked 成员延迟维护**（§5.4）：`LOCAL` 存储上的物理维护要等 parked 成员被按需回收。
- **远程连接过期**：远程会话可能在 park 期间过期。重新校验（§4.3）覆盖重开时刻；探测之后的失败与 resident Session 的行为相同。
- **替换正确性**：被回收连接的 journal 行仍为 active。load 必须先替换连接再退役该行，且不得重发原操作。worker 丢失（recovery-required）与连接丢失（替换）两条路径都须分别验证。
- **回收竞争**：回收路由与成员资格交还必须在并发重开、两步之间 Broker 重启这些情况下保持安全。
- **配额压力**：驱逐可能关闭 resident Session 的空闲连接；其下一次工具调用会干净地失败，下一次 refresh 会替换连接。
- **stdio 长存进程的资源**：parked stdio server 是 worker 里的长存进程，占内存/FD。空闲回收 bound；H1 已列"stdio HOME/USERPROFILE 为 Workspace"等部署约束沿用。
- **与 detach 路径耦合**：挂起复用 detach 的 close 路径一部分；第二阶段改 park 须用测试固定"close 路径审查"每一行（父设计风险项）。
- **测量未做**：§3 是估算；收益结论待 §7 实测确认。

## 9. 验证与验收

- **复用见证**：parked Session 重开后 `mcp.start` 计数不增（连接未重连）；catalog 与 connectionGeneration pin 不变；grant 续租给新写者。
- **重新校验**：park 期间过期的远程会话在声明工具前被替换，且绝不产生 `outcome_unknown`；park 期间被吊销的凭据使 turn 在模型运行前失败；未变化的远程 server 不发 `mcp-configure` 即被复用；stdio server 不收到 `ping`。
- **回收**：空闲回收后 load 先重配再退役旧行；原 operation 不重发；多次循环后已退役的行不累积。
- **worker 丢失**：park 期间被杀的 worker 走 recovery-required，不产生新 owner，不启动第二个 server（`workerKillWhileIdleNeverMintsAFreshOwnerOnMySql` 契约）。
- **错误分类**：重开期间可重试的 `workspace_busy` 按原样暴露，而不是变成 recovery-required。
- **挂起正确性**：park 后写者 seal、activation 释放、resident drop、续约停；恢复视图判 ready；#8 有界恢复证明仍成立。
- **未决工作拦截**：有未决 MCP operation 的 Session 不 park，且有未决工作时 worker 拒绝回收。
- **配额**：达到连接配额时，其他 Session 的空闲 parked 连接被驱逐，新的 configure 成功；没有可驱逐连接时配额错误不变。
- **mount 语义**：`LOCAL` / `SSH_LOCAL` 上，park 期间其他 Session 可运行在同一 storage；`LOCAL` 上按需回收后维护得以继续；并发重开保留其成员资格；`EXTERNAL` 存储与未声明 `mcpParkable` 的部署保持第一阶段 drain。
- **Hook**：只有 Hook 的 Session 挂起时仍交还 mount。
- **真实进程/MySQL IT**：仿第一阶段验收，在要求的 CI 层级跑真实 Harness+worker+MySQL 的 park/复用/回收/故障矩阵；跳过 Hosted/MySQL 门禁不算验收。
- **测量**：§7 实测证明发布常量合理、收益值得。
- **回归**：第一阶段既有测试不变（未空闲满一个空闲时长的 Session 行为相同）；非 MCP Session 挂起路径不变。

## 10. 待解决问题

1. 空闲时长、回收扫描间隔与重新校验超时（测量选定），以及重新校验是否跨 server 并发执行。
2. `EXTERNAL` 存储后续是否 park；这需要在竞争方 acquire 时抢占 parked 持有者。
3. 已证明 settled 的 owner 在 worker 丢失后能否自动重装；这需要重新审视 §5.7 的故障门禁。
4. 回收是否也应覆盖崩溃的 Harness（head 为 `ACTIVE` 且写者租约已过期）。第一增量只覆盖已 seal 的 head。
5. 实测维护延迟后，是否需要存储所有权解耦（§5.4 后续增量）。

## 11. 可行性结论

**值得做，有先决条件，测量是实现门槛。**

- **收益真实且主要是延迟**：第二阶段消除冷开侧 K 次**串行**物理重连/发现（每次 ≤25s）+ ~7K journal 提交 + K 资源 publish，以及挂起侧 ~2K 提交 + K 次物理关闭。对配置 MCP 的 Session，wake 延迟收益显著（尤其 K 大或 server 慢）；SQL 收益随 K 放大。~91 是无 MCP 地板，MCP 成本完全在其之上（§3.1）。
- **基础设施大部分已就位**：worker 跨 attach 存活、durable owner 可重获取、active-row 复用路径与连接替换已存在、投影 runtime_state 已兼容 parked、已 seal 的 head 已能识别 parked owner。新增主要是：远程重新校验、过期行退役、Broker 空闲回收、配额驱逐、park 声明。
- **先决条件**：回收及其竞争的正确性证明；针对过期与被拒远程会话的重新校验的真实进程证明。存储所有权解耦延后（不阻塞第一增量）。
- **与第一阶段兼容**：资格谓词、#8 有界恢复证明、恢复视图判据均保持（§6）；不引入新 journal 状态、不改 schema、不引入新 cleanup debt 类。
- **门槛**：§7 实测确认收益占比与发布常量；真实进程/MySQL 故障验收。估算不能替代实测（父设计明确要求）。

**建议切片**：(1) 测量 rig 扩展 + 实测（门槛）；(2) 重开加固：lookup 前先 acquire、远程重新校验、过期行退役；(3) Broker 空闲回收 + 维护按需回收 + 配额驱逐；(4) 在 `mcpParkable` 控制下启用 park + 恢复视图措辞，仅在 (2)(3) 落地后启用；(5) 真实进程/MySQL 故障矩阵 + 发布常量选定。存储所有权解耦作为独立后续设计。
