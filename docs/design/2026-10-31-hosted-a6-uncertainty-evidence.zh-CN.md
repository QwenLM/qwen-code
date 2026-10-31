# Hosted A6 — 不确定的 producer 证据必须阻塞

状态：已实现。Issue #14481（G3 Step 3 恢复矩阵）的 **A6** 行切片
（「MCP/Hook/child 不确定性」）。按父设计 §9.1，A6 属定向或集成证据：本切片
补充定向行为化证据并加一处小的恢复守卫。不新增 CI 臂、不新增续接支持、不改
Hook/MCP 拒绝策略本身。

父文档：[G3 Step 3 恢复](2026-10-09-hosted-g3-step3-recovery.zh-CN.md)。
English: [2026-10-31-hosted-a6-uncertainty-evidence.md](2026-10-31-hosted-a6-uncertainty-evidence.md).

## 问题

A6 要求三个观察：缺失或未知的 producer 证据必须阻塞；不重建外部调用；不静默
释放 Workspace 租约。对 main `35daec35ea` 的调查（两路并行代码调研，关键主张
已手工复核）表明：第二、三子句已有厚实守卫与测试，第一子句存在三个具体证据
缺口：

- **G1 — Hook/MCP 保存批次拒绝臂零测试。** `resumeSavedNativeBatch` 对
  Hook/MCP 会话拥有的非 commandStep 计划抛
  `HostedToolRecoveryRequiredError('Unsupported saved batch owner.')`
  （`hosted-workspace-tool-turn.ts:3508-3517`）。该字符串在任何测试中都不出现；
  approval-continuation 夹具从不构造 hooks/mcp 的 resume。预计删掉该子句后所有
  套件仍绿。
- **G2 — extensions 开启的入口组合未钉。** 接管续接入口
  （`hosted-harness-session.ts:7124-7129`）在 `session.extensions?.enabled` 时
  即使 `session.hooks || session.mcp` 也放行；非 commandStep 计划的唯一兜底就是
  G1 那条未测子句。（解决范围：本切片双向钉住 tool-turn 兜底；入口的
  `extensions?.enabled` 子句本身是路由级表面，记录为下方后续工作——定向夹具
  无法在不构造完整 hooks 会话接管的情况下触达它，而一个无法失败的用例比没有
  更糟。）
- **G3 — 不可得的 child 账本被当作「证明缺席」应答。**
  `fillParkedRoundAgentGaps` 在 `children === undefined || admitted === undefined`
  时对滞留调用折叠 `gapText`（`hosted-runtime-recovery.ts:1505-1517`）。两臂的
  证据语义不同：账本在场时，无 `child_run` 记录是「从未启动」的肯定证据
  （`admitLaunch` 先提交记录再 `dispatchStarted`，
  `hosted-child-agent-session.ts:1383-1415`）；账本缺席时一无所知——折叠却断言
  「the call never ran」（`HOSTED_AGENT_CALL_NOT_REACHED_TEXT`，
  `hosted-workspace-tool-turn.ts:1660-1661`）。账本家族是 `agent` 与 `workflow`
  两者：本模块其他读取点已把两个名字视为一家
  （`hosted-runtime-recovery.ts:790, 1913`、`JOURNAL_ONLY_ANSWERABLE_TOOLS`），
  且 workflow 准入要求 child funnel。`session.childAgents` 在加载时由
  持久会话配置确定性重建（`hosted-harness-session.ts:6265-6307`），因此对从未
  拥有 agent 工具的稳定配置，缺席臂不可达——但在崩溃代与恢复代之间发生
  child 通道配置/版本漂移时可达（路由级可用 version-0 通道上的
  `suppressChildAgents` 复现），而那恰恰可能有一个已 admit 的 child 仍在运行。
  没有测试区分这两臂。

## 已核实的代码事实（main 35daec35ea）

- 三类 producer 的证据都是持久且先于 dispatch 的：Hook `hook_execution` 与 MCP
  `mcp_operation` 记录走
  `intent → dispatch_started → settled | outcome_unknown | not_started_proven`，
  `dispatch_started` 在物理 dispatch 之前提交
  （`hosted-hook-session.ts:1187-1193, 1362-1378`；
  `hosted-mcp-session.ts:865-882`）；child run 先提交 `child_run` 再 dispatch。
- 不确定的 Hook/MCP 结果只走 lookup（`hook-status`/状态轮询）；非 settled 的
  lookup 提交 `recovery_blocked / outcome_unknown` 并抛家族恢复错误。未发现任何
  重建不确定外部调用的路径（dispatch 仅从 `intent`；`reconcileEffects` 只取消
  intent、绝不重发；child admission 证据幂等）。
- 第三子句由持久证据而非工具列表守卫：Java 释放在任何执行行非终态时拒绝
  （`JdbcToolExecutionRepository.hasActiveByRuntimeSession`）；后代半证据阻塞
  退役（`ManagedRuntimeRetentionGuard.childRunUnsettled`）；CLI 快速结清要求
  非空且全 settled 的列表。已有测试见证包括
  `hosted-mcp-session.test.ts:846, 1762`（未知结果保留 owner/阻断替换）、
  `hosted-hook-session.test.ts:892`（未知结果保留 mount）、
  `HostedMonitorRunFaultGatesIT`（不确定 worker → `runtime_session_held`，
  binding 保持 READY）。

## 改动

- **G1/G2（仅测试）。** 在 `hosted-approval-continuation.test.ts` 增加四行
  owner 门矩阵：hooks 拥有与 mcp 拥有的 turn 恢复非 commandStep 保存计划时以
  `'Unsupported saved batch owner.'` cause 拒绝；`configRevision` 与 turn 的
  `extensionConfig.revision` 不再匹配的 commandStep 计划由门的第二臂拒绝；
  版本匹配的 commandStep 计划在 hooks owner 下越过该门（其拒绝是被包装的
  传输失败，绝非 owner cause）——钉住保住 A3 commandStep 后续可用的过度阻塞
  方向。先实证缺口：删除 owner 门子句后改动前的套件仍绿。
- **G3（一处守卫 + 测试）。** 在 `fillParkedRoundAgentGaps` 中，仍欠折叠
  （`foldOwed`）的账本家族调用（`agent` 或 `workflow`）在
  `input.children === undefined` 且信号存活（未中止）时抛
  `HostedToolRecoveryRequiredError` 而非折叠。三条边界保守卫诚实：已入日志的
  缺口保持静默重放；cancel 路由与中断回合结算漏斗对该填充**预中止**以求立刻
  终止，它们的丢弃折叠保留 pre-A6 故事（在那里抛错会把 cancel 楔进确定性
  503 循环、把唤醒楔进 busy 重试——只有 continue 路由阻塞，其 catch 把该家族
  映射为可重试恢复阻塞）；非家族滞留调用保留既有应答。见证：
  `hosted-child-wait-recovery.test.ts` 的 agent 臂、workflow 臂、非 agent 臂、
  重放静默与预中止豁免五个 fill 级用例，加上
  `hosted-harness-session.test.ts` 的两个路由级用例——把漂移建进加载
  （orphan 停靠形状 + `suppressChildAgents`）：continue 以可重试 409
  `hosted_turn_recovery_required` 阻塞且无伪造折叠，cancel 仍以其 pre-A6
  丢弃折叠结算。每个子句都有已验证的单子句删除对照。

## 设计决定

- **账本不可得时阻塞而非折叠。** A6 第一子句是证据语义问题：「未知」不得被
  洗成「证明缺席」。折叠是持久的、要回答模型的；错误的 never-ran 断言会让一个
  存活 child 的效果搁浅且无人欠它应答。
- **账本家族，不止 `agent`。** `workflow` 启动走同一本 child-run 账本（本模块
  其他读取点已把两个名字视为一家），因此同一不可得证据阻塞覆盖两者。其他
  滞留调用保留既有缺口应答，守卫不会回归合法没有 child funnel 的会话。
- **终止路由的 abort 豁免。** cancel 与中断结算漏斗刻意预中止该填充
  （「立刻结算……而不是把 cancel 扣为人质」）；守卫豁免已中止信号，使这两条
  路径保留 pre-A6 丢弃折叠并永远可终止。残余权衡是明确的：漂移下这两条路径
  仍折叠近似的丢弃应答而非阻塞——阻塞它们会把被取消的 Turn 永远楔死，比那个
  近似故事更糟，而自带账本的 child 仍可自行恢复。
- **不打包臂、不加续接支持。** §9.1 把 A6 归为定向或集成证据，且 native
  continuation 按设计拒绝 Hook/MCP 会话（commandStep 后续是 A3 的另一半）。
  打包 Hook/MCP 崩溃臂需要新的 e2e 夹具，属独立切片。
- **租约侧观察留在范围外。** Hook/MCP profile 的 Turn 不入 HOSTED_CLEANUP 债务
  协议（`!hooks && !mcp` 门），C3 扫描器不代还其租约；这是清理覆盖问题
  （租约卡住不等于静默释放），在此记录为未来 C3 切片的相邻观察，而非 A6 缺陷。

## 涉及文件

- `packages/cli/src/serve/hosted-runtime-recovery.ts`（G3 守卫）
- `packages/cli/src/serve/hosted-child-wait-recovery.test.ts`（G3 fill 级用例）
- `packages/cli/src/serve/hosted-harness-session.test.ts`（G3 路由级用例）
- `packages/cli/src/serve/hosted-approval-continuation.test.ts`（G1/G2 矩阵）
- 本设计文档（双语）；定向证据落地时同步更新父文档 §9.1 状态注记。

## 验收标准

- G1/G2：owner 门删除在改动前的套件中存活（已实证的缺口），改动后使拒绝行
  变红；移除 `!plan.commandStep &&` 恰好使版本匹配接受行变红；移除第二
  （版本）臂恰好使版本过期行变红。不声称钉住 harness 入口的
  `extensions?.enabled` 子句（见下方后续工作）。
- G3：缺席账本反例在守卫前折叠「never ran」，守卫后对 `agent` 与 `workflow`
  均抛错且不写任何折叠；账本在场/无记录臂仍折叠诚实应答；非家族缺口调用
  不变；已入日志缺口静默重放；预中止填充保留其丢弃折叠。路由级内建漂移下：
  continue 可重试地阻塞（409）且无伪造折叠，cancel 仍结算。守卫的每个合取项
  （家族、foldOwed、abort 豁免）都有恰好使其命名用例变红的删除对照。
- 定向套件在净化环境（剥离 agent 会话环境变量）下绿；typecheck/ESLint/Prettier
  绿；唯一的生产改动就是那一处守卫。

## 开放问题

- 在路由级钉住 harness 接管入口的 `session.extensions?.enabled` 子句（需要
  带持久 v3 续接的 hooks 会话接管夹具；它所把守的 tool-turn 兜底已双向钉住）。
- 待 Hook/MCP e2e 夹具存在后，是否由后续切片打包 A6 故障臂（此处范围外）。
- Hook/MCP profile Turn 的租约是否应加入清理债务协议（上文相邻 C3 范围观察）。

## R2 评审轮（4 条建议——全部修复）

- **兄弟写入点（R2-1）**：同一 never-ran 伪造在恢复路径的两个兄弟写入点上仍然存活。`answerAbandonedTurnCalls`（hosted 模式，即 continue 路由的 resumed-turn 应答）现在对无账本家族调用直接拒绝——调用方的家族 catch 把拒绝映射为可重试阻塞；终止性的 `'all'` 结算继续折叠，但使用诚实措辞（见下）。从不读账本的 `fillParkedRoundCommandGaps` 在存活信号下拒绝同一形状；其 continue 调用方传存活信号，cancel 与 settle 调用方预中止。
- **诚实的豁免措辞（R2-3）**：被豁免（预中止）的折叠与 `'all'` 结算对无账本家族调用改用新的专用 `HOSTED_CHILD_LEDGER_UNKNOWN_TEXT`——「结果未知……记录保留」、`executionStatus: 'unknown'`——绝不写「never ran」也绝不写「cancelled」。漏斗仍不抛错、照常终止。
- **家族单一事实源（R2-4）**：`CHILD_LEDGER_TOOL_NAMES = new Set(['agent', 'workflow'])` 定义在 `hosted-workspace-tool-turn.ts` 的应答常量旁；原先六处内联双名字字面量（recovery 四处、tool-turn 挂载校验两处）全部改读 `.has(name)`。不复用 `JOURNAL_ONLY_ANSWERABLE_TOOLS`——那套还包含团队名，其缺口应答是各自的 funnel。
- **extensions 行（R2-2）**：owner 门矩阵补上了注释所声称的那一行——Hook owner + `extensionConfig` + 无 `commandStep` 被第一臂拒绝；向门里偷运 `&& !this.extensionConfig` 恰好使该行变红。

R2 删除对照（安静树、完整失败清单判定）：把家族常量在守卫处挖空为仅 `agent`；移除 resumed-answer 拒绝；把 `'all'` 结算的 unknown 措辞改回；移除 command-gaps 拒绝；向门里偷运 extensions 豁免——每行恰好杀于命名用例，还原逐字节一致。
