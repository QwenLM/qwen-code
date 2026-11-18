# Managed Runtime 持有 MCP/Hook 连接生命周期（第二阶段）

[English](2026-11-18-managed-runtime-owned-connections.md) | [简体中文](2026-11-18-managed-runtime-owned-connections.zh-CN.md)

状态：调研 + 详细设计提案，未实现。日期：2026-11-18。本文是[无状态 Hosted Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)（#17527）第二阶段的实现前设计，基于已合并的第一阶段 PR #17690（merge `7150c58a01`，验证 head `5dd947afe5d`）的代码逐行核实。父设计第二阶段"只定义边界；实现前另写设计"，本文承接该边界并给出方案、成本模型、与第一阶段的交互、测量计划与可行性结论。结论中的成本占比是**代码级解析估算，尚未实测**；实测是实现门槛（父设计："其占比必须测量"）。

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
2. **mount 持有**：MCP owner 持有 workspace 的独占执行 mount，挂起时交还。
3. **重装**：下一次 load 重新提交配置、重连、重新发现。

### 1.2 owner 身份与重连/复用路径

- **durable owner id**：`hostedDurableMcpOwnerId(sessionKey, configurationIdsDigest)` = `mcp-` + sha256，每次 load 由非 released 配置行重算（`hosted-mcp-session.ts`）。Hook 用 config-scoped owner（`hosted-hook-session.ts`，`isHostedConfigScopedOwner`）。非终态 close 不留 RELEASED tombstone，owner 保持可重获取。
- **建立（冷打开或首个 prompt）**：tool turn 声明工具前调 `mcp.refresh(signal)`（`hosted-workspace-tool-turn.ts`）→ `ensureReady()`（memoized）→ `initialize()` → **逐 server 串行** `install()`：
  1. 若前一行 `drained`/`released`：先 drained→released 提交，再在**同一 owner** 下开新 active 行（提交）；
  2. `acquireOwner()`：`broker.acquire()`（HTTP）+ 对每个有 catalogRef 的非 released 配置做 grant 续租提交（`commitConfiguration(record, renew=true)` 推进持久修订）；
  3. 提交 `dispatch_started`；派发 `mcp-configure`（worker：spawn stdio / 连 HTTP + initialize + tools/resources/prompts list，≤25s）；
  4. publish catalog 资源 + 提交 settled + 把同 owner 的兄弟 drained 行推进 released。
- **每 turn**：`refresh()` → `ensureReady`（已 memoize）+ `acquireOwner` + 对每个 catalog 派发 `mcp-discover`（在活连接上的廉价状态检查；仅当目录 digest 变化才 reconfigure）。**resident turn 与 cold turn 都付这部分**。
- **挂起 teardown 第 2 步**（`hosted-harness-session.ts` `attemptSuspend`）：`hooks.close({terminal:false})` + `mcp.close({terminal:false})`。`mcp.close` = `reconcileEffects()`（结算所有未决 operation/configuration）+ `closeResources()`：逐配置 `drainConfigurations`（提交 releasing → 派发 `mcp-release` → worker 物理关闭 → 提交 drained）+ `broker.releaseMount()`（交还 mount，owner 仍可重获取）。
- **复用路径已存在**：`install()` 遇到 `previous.releaseState === 'active'` 且 settled 的行时，**只读已存 catalog、校验 digest，不派发 mcp-configure**；`acquireOwner` 重获取 mount + 续租 grant。今天这条路径用于崩溃重载（行仍 active）。**第二阶段就是让挂起也留下 active 行，从而走这条复用路径。**

### 1.3 Hook 的现状

Hook 没有持久 transport——它是按事件派发到 worker 的执行，与 MCP 共享 broker/mount（`HostedHookSession`）。非终态 `close()`（`hosted-hook-session.ts`）= `drain()`（结算未决执行）+ `releaseEarlierOwners`（释放被取代的旧 config-scoped owner）+ 回收 recovered broker + 重试 fenced owner，最后对当前 deterministic owner **只交还 mount**（不 terminal release）。所以 Hook 的"连接成本"主要是 owner 身份/mount 共享，而非持久连接；第二阶段对 Hook 的改动很小。

## 2. 目标与范围

**目标**：挂起/重开不再 drain、重连、重新发现 MCP 连接。Runtime 在多次 attach 之间保留连接，按自己的空闲时长回收；Harness 凭 durable owner 身份 + 签发给新写者的 grant 重新获取。

**范围（本提案，第一增量）**：

- 挂起把 MCP owner 置为 **parked**（连接存活、mount 保持、grant 自然过期），而非 drain。
- 重开走既有 active-row 复用路径；检测被 Runtime 回收的连接并重装。
- Runtime 新增**空闲回收**：parked 连接按空闲时长物理关闭，留下持久回收回执。
- 恢复视图契约措辞更新 + parked owner 可观测性。
- Hook 随 MCP 共享 mount 的 parked 语义微调。

**范围外（后续增量）**：

- **连接寿命与存储所有权解耦**（H1 遗留开放问题）：允许 parked 连接存活时交还 mount。需要 fence stdio server 对 workspace 的写入，是更大的安全工程，本提案不做（见 §5.4）。
- journal 恢复成本（随历史增长的部分）——父设计明确第二阶段不消除它。
- 第三/四阶段（wake 调度、审批停靠）。

## 3. 成本模型（解析估算，未实测）

### 3.1 基线重述

WP3 测量（`.qwen/investigations/2026-11-18-wp3-suspension-cost-measurement.md`）：冷打开 overhead **~91 statements 平坦**（1/40/200 turn），边际 idle 节省 46/min/session，收支平衡 ~2min。**该测量是纯文本 Turn、无 Runtime worker、无 MCP**。所以 ~91 是**无 MCP 的地板**，MCP 重连成本完全在其之上，不是"~91 的一小部分"。这重构了交接简报的质疑：问题不是"MCP 占 ~91 多少"，而是"MCP 在 ~91 之上加多少"。

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

parked 复用后，重开 MCP 路径退化为：`acquireOwner`（1 broker HTTP + ~K grant 续租提交）+ 每 turn refresh discover（resident 本就付）。**消除**：挂起 drain（~2K 提交 + K 关闭）+ 冷开 reinstall（~5K 提交 + K publish + **K 次串行重连/发现**）。冷开 MCP 增量从 ~7K 提交 + K 重连 降到 ~K 提交 + 1 acquire。

收益随 K 与重连延迟放大；K=1 快本地 stdio 时 SQL 收益 modest（数十 statements），但延迟收益仍在。

### 3.4 重连见证（最易观测的测量）

IT fixture `hosted-mcp-fault-process.mjs` 在每次进程启动记 `mcp.start`、退出记 `mcp.exit`。第一阶段每次冷开 +K 个 `mcp.start`；第二阶段 parked 复用应为 0（直到空闲回收）。这是不依赖 SQL digest 窗口的直接重连见证。

## 4. 方案

### 4.1 parked owner 状态

引入 owner 的 **parked** 语义：连接存活、mount 保持、journal 配置行保持 `active` + `run.state = settled`、grant 自然过期（`leaseDurationMs = 300_000`）。parked 不是新的 journal `releaseState`——行仍是 `active`，复用路径据此识别。parked 是 **Broker/worker 侧**的状态（"无 Harness 持有，开始空闲倒计时"）。

**为什么不需要新 journal 状态**：`ManagedExtensionProjection.runtimeState`（`contracts/.../ManagedExtensionProjection.java`）由 `run.state` 推导——`settled` 属 TERMINAL → `runtime_state = null`，**与 `releaseState` 无关**。所以 parked（active+settled）配置行已满足恢复视图的"无活 Runtime 执行"判据（§6.3）。新增 journal 状态会破坏既有投影/恢复证明，无必要。

### 4.2 挂起路径改动

teardown 第 2 步对 MCP 从 drain 改为 park：

1. **仍调 `reconcileEffects()`**：结算所有未决 operation/configuration。未决副作用仍阻止挂起（与今天一致， eligibility 谓词也独立拦截 `mcpBusy`/`mcpRecovering`）。parked 连接都是 settled、无未知结果，故 park 期间无 unknown-outcome 配额占用。
2. **不 drain、不交还 mount**：跳过 `drainConfigurations` 与 `releaseMount`。连接留在 worker，mount 保持持有。
3. **park 通知**：Harness → Broker 一个 park 动词（建议 `mcp-park` control kind 或 session 级 park），Broker → worker 对该 owner 的连接启动空闲计时器。通知失败在 seal 前可回退（rearm），与今天 drain 失败同形（§6.2）。

Hook 第 2 步：`drain()` + `releaseEarlierOwners`（被取代的旧 owner）保留，但当前 deterministic owner **跳过 mount 交还**（与 MCP 共享 mount 保持）。

teardown 第 3 步 `releaseLeaseNow` 不变：对 MCP-owned lease 本就返回 false（"MCP configurations own their Runtime until their own drain completes"——park 后仍由 MCP owner 持有）。

### 4.3 重开复用路径

冷打开构造 `HostedMcpSession`（同一 durable owner）→ 首个 prompt `install()` 见 active+settled 行 → **读已存 catalog、不重连**；`acquireOwner` 重获取 mount（已持有则 no-op）+ 续租 grant。这条路径今天已存在（崩溃重载），第二阶段让它成为挂起重开的常规路径。

**回收检测**：若 worker 已空闲回收该连接（或 worker 重启 generation 变化），复用必须能检测并重装，而非 recovery-block：

- `acquireOwner` 今天对 generation 不匹配抛 `HostedMcpRecoveryRequiredError`。第二阶段区分两种情形：
  - **worker generation 变化**（重启）：仍 recovery-required（原 Runtime 丢失，按既有崩溃恢复对账）。
  - **同 generation、连接被回收**：worker 在 acquire/status 回执中报告该 connectionGeneration 已 retired + 持久回收回执。`install()` 据此把 active 行推进 released（以回收回执为 drain 证明）→ 开新行重装（重连）。这复用既有 drained→released→reinstall 机制，只是触发源从 Harness drain 变为 Runtime 回收。

### 4.4 Runtime 空闲回收

worker 新增 per-owner 空闲计时器（park 通知启动，grant 续租/任何 control 重置）。到期：

1. 物理关闭该 owner 的连接（同 `drainSession` 的 `closeConnection`，但无未决工作——park 前已 reconcile）。
2. 记录**持久回收回执**（connectionGeneration retired + 时间），经 Broker 持久化（Broker 重启后仍可查询）。
3. 释放配额与 mount（mount 交还使其他 Session 可获取该 workspace）。
4. journal 行**不变**（Harness 已挂起，不能写）；由下一次 load 的 Harness 凭回执对账（§4.3）。

**谁回收、何时回收**（父设计待定义接口）：Runtime（worker）按自己的空闲时长回收，Broker 持久化回执，后继 Harness 写者对账 journal。空闲时长是发布常量，测量选定（§7）。

### 4.5 配额

parked 连接计入 worker 的 16 连接共享配额（跨 Session）。需要：

- **parked 预算**：每 owner 或全局 parked 连接上限，防止大量挂起 Session 耗尽共享 worker 配额。超限时挂起回退到 drain（优雅降级，第一阶段行为）。
- 空闲回收释放配额，bound 占用时长。
- unknown-outcome 占用：park 前 `reconcileEffects` 已结算，故 parked 无 unknown 占用；若结算失败则不 park（回退 drain 或保持 resident）。

## 5. 设计决策与理由

### 5.1 显式 park 动词 vs 隐式 grant 过期

选**显式 park 通知**（§4.2）。理由：父设计明确要求"Broker 上'挂起 owner'和'释放 owner'的区分"；显式动词让空闲计时起点确定、可观测、可在 seal 前回退。隐式（worker 跟踪 last-grant-renewal 推导空闲）把空闲耦合到 grant lease（300s），起点模糊且需 worker 额外跟踪，作为后续优化候选。

### 5.2 不新增 journal releaseState

parked 行保持 `active`+`settled`（§4.1）。理由：复用路径据 `active` 识别；投影 `runtime_state` 由 `run.state` 推导已为 null；新增状态会破坏恢复视图证明与既有 drained/released 状态机，无收益。

### 5.3 回收回执持久化在 Broker

理由：Harness 挂起期间不能写 journal；worker 回执是代内的（H1："Runtime 的代内回执不能跨物理 Runtime 丢失持久保留"）。Broker 持久化回收回执使后继 load（甚至 Broker 重启后）能对账。这与 H1 的 release 回执持久化同形。

### 5.4 mount 保持持有（第一增量），解耦延后

parked 期间 mount 保持持有。理由：H1 明确"stdio server 仍能访问 Workspace 时提前释放租约会允许并发写入；连接寿命与存储所有权解耦属于生产启用前的后续工作"。保持 mount 避免并发写入，且与 H1"每 tenant/storage lease 仅一个 attached MCP owner"限制一致。

**代价**：挂起的 MCP Session 在 park 期间继续独占 workspace storage mount，阻止同 storage 的其他 Session，直到空闲回收。对空闲 Session（挂起目标）可接受——其 workspace 少有竞争，且空闲回收 bound 时长。**这是明确的产品权衡，须评审**。解耦（允许 park 时交还 mount + fence stdio 写入）是后续增量，若 park 期间 workspace 竞争成为问题再做。

### 5.5 挂起仍释放 Harness 资源

mount 是 Broker 侧 claim，不是 Harness 资源。park 保持 mount 不妨碍 Harness seal 写者、释放 activation、drop resident、停续约——第一阶段的核心收益（内存/端口/续约 SQL）全部保留。park 只影响其他 Session 对同 workspace 的访问。

## 6. 与第一阶段的交互

### 6.1 资格谓词

`suspensionLiveWork`（`hosted-harness-session.ts`）拦截 `mcpBusy`/`hooksBusy`/`mcpRecovering > 0`、`heldRuntimeTurns`、活 monitor loop、未结算 child/monitor run、`clientFiles`、`streams`、public-shell MCP 无 lifecycle v2。**不因"有 MCP 配置"本身拦截**私有 `hosted-workspace-mcp/1` Session。第二阶段保留这些：未决工作仍阻止挂起；parked 空闲连接不是"live work"。新增：parked 预算超限 → 回退 drain（§4.5）。

### 6.2 teardown 顺序与 #8 有界恢复证明

teardown 顺序：wake → owners（第 2 步）→ lease（第 3 步）→ publishers → writer seal（第 5 步）→ stopLocal。第二阶段把第 2 步从 drain 改为 park（reconcile + 通知），仍在 seal 前的可回退边界。park 通知失败 → rearm（与今天 drain 失败同形）。

**#8 证明保持**（`.qwen/investigations/2026-11-18-open-question-8-bounded-recovery-proof.md`）：该证明依赖**写者围栏**（租约过期 → 任何 acquire generation+1），**不依赖 SEALED ⟹ 资源已释放**。资源义务由后继冷打开经既有 takeover/cleanup 路径对账。park 把资源留给 Runtime 照管，后继冷打开复用或重装——正好落在证明已声明的"既有崩溃恢复同形"分支。证明结构不变；只需确保 parked owner 的对账走既有 takeover/cleanup 路径。

### 6.3 恢复视图

恢复视图（[补篇](2026-11-18-managed-suspension-recovery-view.zh-CN.md)）`ready` 判据要求 `ma_session_record.runtime_state` 为空。已核实：`mcp_configuration` 投影 `runtimeState` 由 `run.state` 推导，settled → null，**与 releaseState 无关**。故 parked（active+settled）配置行**已满足**该判据，无需改投影。需要：

- 契约措辞："重新安装 owner" → "复用或重新安装 parked owner"。
- "无未结算工作"仍须成立（无未决 `mcp_operation`）——park 前 reconcile 保证。
- 被回收但 journal 仍 active 的连接：视图可保持 ready，load 做对账（§4.3）。
- 可选：parked owner 计数纳入可观测性。

### 6.4 cleanup debt

`hasHostedCleanupDebt`（`hosted-turn-cleanup.ts`）跟踪 `hosted.cleanup` owed 事件（turn 级 Runtime 租约）。parked MCP owner 是否引入新债务类？若 park 是"reconcile + 保持 + 通知"，唯一失败是 reconcile 结算不了未决操作——那已阻止挂起（recovery-required），与今天一致。park 通知失败在 seal 前回退；seal 后由后继对账。故**不引入新的持久 cleanup debt 类**，parked owner 的对账走 §4.3 的 load 路径而非 cleanup debt 扫描器。须在实现中验证此点（§8）。

## 7. 测量计划（实现门槛）

父设计："其占比必须测量"。本文 §3 是解析估算，**实测是启用门槛**。两条路径：

### 7.1 扩展 WP3 rig（TS，推荐）

rig = `.qwen/scripts/measure-suspension-cost.ts`（MySQL8.4 + Spring exec jar + hosted-harness bundle + fake model，performance_schema digest 窗口法）。扩展为 MCP：

1. **MCP fixture server**：复用 `packages/managed-agent-server/verification/src/test/resources/hosted-mcp-fault-process.mjs`（自包含 stdio MCP，记 `mcp.start`/`mcp.exit`）。
2. **manifest + worker wrapper**：写 `mcp.json`（stdio，command=node，args=[fixture,'mcp',evidence,'1']，definitionDigest 与 session pin 一致）+ `worker.mjs`（设 `QWEN_MANAGED_MCP_CONFIG` 后 import dist/cli.js，仿 IT）。Spring 设 `QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY` 指向 wrapper。
3. **profile + workspace**：Spring 设 `QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES=hosted-workspace-mcp/1`。workspace 需 IT 式注册（`ma_workspace` 用 `WorkspaceExecutionProfile.CONFIG_REF` + `ma_workspace_access` + storage guard register），使 broker scope capabilityDigest = `WORKSPACE_CAPABILITY_DIGEST`（TS broker `readRuntime` 接受）。**注意**：IT 用 Java bean（`guard.register`、`store.insertWorkspaceSessionCommand`）建栈，TS rig 需找 HTTP/SQL 等价步骤——这是主要工程难点。
4. **agent definition + session**：POST `/v1/agents`（`tools:[{type:hosted_profile,profile:hosted-workspace-mcp/1}]` + `mcp_servers` pin + `permission_policy:{approval_mode:yolo}`），再 POST `/v1/agents/sessions`。
5. **测量**：同 rig（resident-turn 基线 → 等挂起 → cold-open turn），digest 窗口取 SQL 差；额外数 evidence 文件 `mcp.start` 事件（重连见证）。对比 K=1/4/16。

### 7.2 新增 Java IT（备选）

在 verification 模块新增 IT，仿 `HostedMcpRestartFaultGatesIT` 建栈（真实 Harness + worker + MySQL），但测挂起/重开的 SQL + 计时 + `mcp.start` 计数。需 Maven 隔离仓库 + sibling SDK 安装（见记忆 managed-agent-maven-isolated-verify）+ `mysql.url` 系统属性。优点：建栈步骤已被 IT 解决；缺点：Maven 验证链重。

### 7.3 测量产出

- 冷开 MCP 增量 statements（K=1/4/16）vs §3.2 估算。
- 冷开 MCP 增量 wall-clock（串行重连延迟）。
- 挂起 drain 增量 statements。
- `mcp.start` 重连计数（第一阶段 +K/冷开）。
- 据此选定空闲时长发布常量与 parked 预算，并确认收益值得（§9）。

## 8. 约束与风险

- **mount 独占延长**（§5.4）：parked Session 继续独占 workspace storage 直到空闲回收。须产品评审；空闲回收 bound 时长。
- **回收对账正确性**：被回收连接的 journal 行仍 active，load 必须凭持久回执重装而非误复用旧 catalog。实现须验证：worker 重启（generation 变）vs 连接回收（同 generation）两条路径分别正确（recovery-required vs reinstall）。
- **配额耗尽**：大量挂起 Session 的 parked 连接耗尽共享 worker 16 配额 → 新 Session 配置失败（`managed_mcp_connection_quota`）。parked 预算 + 空闲回收 + 超限回退 drain 缓解。
- **park 通知与 seal 竞争**：通知失败须在 seal 前回退；seal 后通知丢失由后继 load 对账（worker 未见 park 通知则连接仍活，复用照常；空闲计时未启动则连接长存——需 worker 侧 grant 过期兜底空闲判定，避免通知丢失导致永不回收）。
- **stdio 长存进程的资源**：parked stdio server 是 worker 里的长存进程，占内存/FD。空闲回收 bound；H1 已列"stdio HOME/USERPROFILE 为 Workspace"等部署约束沿用。
- **与 detach 路径耦合**：挂起复用 detach 的 close 路径一部分；第二阶段改 park 须用测试固定"close 路径审查"每一行（父设计风险项）。
- **测量未做**：§3 是估算；收益结论待 §7 实测确认。

## 9. 验证与验收

- **复用见证**：parked Session 重开后 `mcp.start` 计数不增（连接未重连）；catalog 与 connectionGeneration pin 不变；grant 续租给新写者。
- **回收对账**：空闲回收后 load 凭回执重装，原 operation 不重发；worker 重启走 recovery-required 而非误复用。
- **挂起正确性**：park 后写者 seal、activation 释放、resident drop、续约停；恢复视图判 ready；#8 有界恢复证明仍成立。
- **未决工作拦截**：有未决 MCP operation 的 Session 不 park（reconcile 失败 → 不挂起或回退 drain）。
- **配额**：parked 预算超限回退 drain；空闲回收释放配额。
- **mount 语义**：park 期间 mount 保持；空闲回收交还 mount 后其他 Session 可获取。
- **真实进程/MySQL IT**：仿第一阶段验收，在要求的 CI 层级跑真实 Harness+worker+MySQL 的 park/复用/回收/故障矩阵；跳过 Hosted/MySQL 门禁不算验收。
- **测量**：§7 实测证明发布常量合理、收益值得。
- **回归**：第一阶段既有测试不变（未空闲满一个空闲时长的 Session 行为相同）；非 MCP Session 挂起路径不变。

## 10. 待解决问题

1. park 动词形态：`mcp-park` control kind vs session 级 park；与既有 `managed-runtime-provider/1` 控制端点的关系。
2. 空闲时长发布常量与 parked 预算上限（测量选定）。
3. park 通知丢失的 worker 侧兜底：grant 过期推导空闲 vs 显式心跳（§8）。
4. 回收回执的 Broker 持久化形态与 schema 影响（H1 release 回执同形，尽量不改 schema）。
5. mount 独占延长的产品接受度；是否需要提前做存储所有权解耦（§5.4 后续增量）。
6. Hook 与 MCP 共享 mount 的 park 语义边界（Hook 无持久连接，是否只需保持 owner 可重获取）。
7. 多 workspace 共享 storage 时 parked mount 的跨 workspace 影响（H1 限制沿用）。

## 11. 可行性结论

**值得做，有先决条件，测量是实现门槛。**

- **收益真实且主要是延迟**：第二阶段消除冷开侧 K 次**串行**物理重连/发现（每次 ≤25s）+ ~7K journal 提交 + K 资源 publish，以及挂起侧 ~2K 提交 + K 次物理关闭。对配置 MCP 的 Session，wake 延迟收益显著（尤其 K 大或 server 慢）；SQL 收益随 K 放大。~91 是无 MCP 地板，MCP 成本完全在其之上（§3.1）。
- **基础设施大部分已就位**：worker 跨 attach 存活、durable owner 可重获取、active-row 复用路径已存在、投影 runtime_state 已兼容 parked。新增主要是：park 语义、Runtime 空闲回收 + 持久回执、load 回收对账、配额预算。
- **先决条件**：mount 保持持有的产品权衡评审（§5.4）；Runtime 空闲回收与回收对账的正确性证明；配额预算。存储所有权解耦延后（不阻塞第一增量）。
- **与第一阶段兼容**：资格谓词、#8 有界恢复证明、恢复视图判据均保持（§6）；不引入新 journal 状态、不引入新 cleanup debt 类。
- **门槛**：§7 实测确认收益占比与发布常量；真实进程/MySQL 故障验收。估算不能替代实测（父设计明确要求）。

**建议切片**：(1) 测量 rig 扩展 + 实测（门槛）；(2) park 语义 + 复用路径 + 恢复视图措辞（最小可观测增量，先不做空闲回收，park 连接长存但验证复用正确）；(3) Runtime 空闲回收 + 持久回执 + load 对账 + 配额预算；(4) 真实进程/MySQL 故障矩阵 + 发布常量选定。存储所有权解耦作为独立后续设计。
