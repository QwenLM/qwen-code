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
  G1 那条未测子句。
- **G3 — 不可得的 child 账本被当作「证明缺席」应答。**
  `fillParkedRoundAgentGaps` 在 `children === undefined || admitted === undefined`
  时对滞留调用折叠 `gapText`（`hosted-runtime-recovery.ts:1505-1517`）。两臂的
  证据语义不同：账本在场时，无 `child_run` 记录是「从未启动」的肯定证据
  （`admitLaunch` 先提交记录再 `dispatchStarted`，
  `hosted-child-agent-session.ts:1383-1415`）；账本缺席时一无所知——折叠却断言
  「the call never ran」（`HOSTED_AGENT_CALL_NOT_REACHED_TEXT`，
  `hosted-workspace-tool-turn.ts:1660-1661`）。`session.childAgents` 在加载时由
  持久会话配置确定性重建（`hosted-harness-session.ts:6265-6307`），因此对从未
  拥有 agent 工具的稳定配置，缺席臂不可达——但在崩溃代与恢复代之间发生
  child 通道配置/版本漂移时可达，而那恰恰可能有一个已 admit 的 child 仍在运行。
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

- **G1/G2（仅测试）。** 在 `hosted-approval-continuation.test.ts` 增加行为化
  用例：hooks 拥有与 mcp 拥有的 tool turn 恢复非 commandStep 保存计划时必须抛
  `HostedToolRecoveryRequiredError('Unsupported saved batch owner.')`，含
  extensions 开启的组合。先实证缺口：删除 owner 门子句后现有套件仍绿；新增
  用例后，同一删除必须使它们变红。
- **G3（一处守卫 + 测试）。** 在 `fillParkedRoundAgentGaps` 中，当滞留调用是
  child-agent 工具（`name === 'agent'`）且 `input.children === undefined` 时，
  抛 `HostedToolRecoveryRequiredError` 而非折叠：不可得的 producer 证据必须
  阻塞（continue 路由已把该家族映射为可重试的 409
  `hosted_turn_recovery_required`）。账本在场/无记录臂保留诚实的 never-admitted
  折叠；非 agent 滞留调用保留既有应答。先反例（今天缺席账本 + agent 缺口会
  折叠「never ran」），再加守卫，然后在
  `hosted-child-wait-recovery.test.ts` 为三臂各补行为化用例，逐个删除对照验证。

## 设计决定

- **账本不可得时阻塞而非折叠。** A6 第一子句是证据语义问题：「未知」不得被
  洗成「证明缺席」。折叠是持久的、要回答模型的；错误的 never-ran 断言会让一个
  存活 child 的效果搁浅且无人欠它应答。
- **只改 `agent` 调用。** 它们的「从未启动」证明就是 child 账本本身；其他滞留
  调用保留既有缺口应答，因此守卫不会回归合法没有 child funnel 的会话。
- **不打包臂、不加续接支持。** §9.1 把 A6 归为定向或集成证据，且 native
  continuation 按设计拒绝 Hook/MCP 会话（commandStep 后续是 A3 的另一半）。
  打包 Hook/MCP 崩溃臂需要新的 e2e 夹具，属独立切片。
- **租约侧观察留在范围外。** Hook/MCP profile 的 Turn 不入 HOSTED_CLEANUP 债务
  协议（`!hooks && !mcp` 门），C3 扫描器不代还其租约；这是清理覆盖问题
  （租约卡住不等于静默释放），在此记录为未来 C3 切片的相邻观察，而非 A6 缺陷。

## 涉及文件

- `packages/cli/src/serve/hosted-runtime-recovery.ts`（G3 守卫）
- `packages/cli/src/serve/hosted-child-wait-recovery.test.ts`（G3 用例）
- `packages/cli/src/serve/hosted-approval-continuation.test.ts`（G1/G2 用例）
- 本设计文档（双语）；定向证据落地时同步更新父文档 §9.1 状态注记。

## 验收标准

- G1/G2：owner 门删除在改动前的套件中存活（已实证的缺口），改动后使新用例
  变红；覆盖 extensions 开启组合，不止普通 hooks/mcp 臂。
- G3：缺席账本反例在守卫前折叠「never ran」，守卫后抛
  `HostedToolRecoveryRequiredError` 且不写任何折叠；账本在场/无记录臂仍折叠
  诚实的 never-admitted 应答；缺席账本下的非 agent 缺口调用行为不变；删除守卫
  恰好使新用例变红。
- 定向套件在净化环境（剥离 agent 会话环境变量）下绿；typecheck/ESLint/Prettier
  绿；唯一的生产改动就是那一处守卫。

## 开放问题

- 待 Hook/MCP e2e 夹具存在后，是否由后续切片打包 A6 故障臂（此处范围外）。
- Hook/MCP profile Turn 的租约是否应加入清理债务协议（上文相邻 C3 范围观察）。
