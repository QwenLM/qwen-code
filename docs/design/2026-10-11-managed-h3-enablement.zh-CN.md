# Managed Agent H3 启用：Runtime 持有、停止投影与门禁抬开

[English](2026-10-11-managed-h3-enablement.md) | [简体中文](2026-10-11-managed-h3-enablement.zh-CN.md)

状态：已实现并已通过物理验收（2026-10-11）。实现 #13856。验收在 H3 rig 上于 `e64ee1fbeb` 运行，使用生产门禁列表、不带任何准入臂：六项行为全部观测到，含此前被阻塞的「输出作为 Artifact」臂（逐字节读回）与 Monitor watch 跨 turn 存活；本次走查需要——也得到了——本改动携带的 page 闭包修复。记录见 `.qwen/e2e-tests/2026-10-11-h3-enablement.md`。相关：
[H3 Shell/Monitor 运行时](2026-10-03-managed-shell-monitor-runtime.zh-CN.md)
（被启用的运行时）、#13532（物理验收）、#13533（B1/B2 与两个设计调用）、
#13789（A1 修复）、#13830（B1）、#13834（B2 见证）、#13846（本片沿用的启用
形状）、#12872（Stage F 跟踪）。

## 1. 问题

H3 于 2026-10-06 合入，此后没有交付任何可用能力：
`MANAGED_SESSION_ENABLED_DOMAINS` 不含 `monitor_run`，
`MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 是 `['child_agent']` 且不含
`shell`，因此没有 Session 能通过生产配置提交这两者中的任何一个（已在
`9763580b84` 经真实 authority 提交路径复现：两者都以 "registered but not
enabled for submission" 被拒，而 `child_agent` 对照正常提交）。#13533 点名
的每一项前置都已结清，且 #13532 的物理验收已在 `c3a6e43554` 不带任何 fix
patch 跑过：六项行为中五项 observed，外加 Monitor arm。

唯一被阻塞的行为 —— **2，输出作为 Artifact** —— 是真实的冲突而非缺陷：
H3 设计的 hold 文本（「a run holds its Runtime for as long as it needs
it」、「Session release with `runtime_session_busy`」）与已落地的 release
sweep 相矛盾，后者在 turn 结算的同一秒内停止仍存活的后台 run，因此任何
输出资源行都无法落地。#13533 把该裁决记为设计所有者的调用，旁边还有一个
更小的调用（A8：平台驱动的停止如何投影）。

## 2. 裁决（设计所有者，2026-10-11）

1. **release 在 run 可证明存活时拒绝 busy。** 后台 run 活过它的 turn，其
   Runtime Session 保持绑定，其输出在退出时作为 Artifact 落地。
   drain-on-release 被否决：它抹掉了后台 Shell 区别于前台 Shell 的那个
   性质。
2. **A8：平台驱动的停止投影为 `cancelled`/`stop_requested`**，记录上带
   `stopRequested: true`，使模型与公开任务视图能区分「平台停掉了这个
   run」与「它自己退出了」。

两个答案都是 H3 设计文本早已描述的形态；本片让实现与之相符。

## 3. 现状（已在 `9763580b84` 核实）

- **turn 结算无条件 release。**
  `HostedWorkspaceToolTurn.finish()`（hosted-workspace-tool-turn.ts:4357）
  在每个 turn 结束时调用 `broker.release()`。任何拒绝都会变成
  `HostedToolRecoveryRequiredError` 并把整个 Session 停成
  recovery-blocked（hosted-harness-session.ts:4702）。这个 park 正是钉住
  的故障门禁所断言的诚实契约：在被拒的 release 之上关闭的 Session 把它的
  Monitor 停成 `runtime_lost`，而不是为一个没人停止过的进程铸
  `stop_requested`（hosted-harness-session.test.ts:6715）。
- **broker release sweep 会 drain。** `settleUnprovenBackgroundRows`
  （RuntimeBrokerService.java:1911）对每个存活的 `:process` 行执行
  status → `shell-terminate` → status，而 `releaseSessionAfterSweep`
  （:2122）只对 sweep 无法证明已停止的行拒绝 `runtime_session_busy`。
  `shell-terminate` 没有别的发行点。
- **worker activation 门禁再 drain 一次。** `transport.release` 终于
  `activateWorkspace(false)`，其门禁在应答前先以 5 秒宽限停止该 Session
  的后台 Shell 与 Monitor（managed-workspace-activation.ts:103，
  managed-runtime-tool-executor.ts:1870 `stopBackgroundSession`）。因此
  Monitor 今天同样活不过它的 turn —— 尽管它的工具结果文本已经向模型
  承诺「it keeps running after this result and holds its Runtime until
  it exits」。
- **Monitor 的持有不在 broker 视野内。** broker 只为 `is_background`
  payload 接纳 `:process` 持有行（RuntimeBrokerService.java:787）；
  Monitor payload 携带 `is_monitor`，得不到行，所以 sweep 与 busy 检查
  都看不见 watch。worker 侧的 `monitor-status`/`monitor-stop` 维护路由已
  建好（managed-monitor-runtime.ts:90）但没有 broker 调用方，Java 侧也
  没有对应协议模块。
- **A8 的投影点。** child_run 记录由 harness 侧 publisher 在捕获 finalize
  时结算（hosted-shell-publisher.ts:853）：退出证据映射为
  `settleExited`（`stopReason: 'exited'`，无 `stopRequested`），即使该
  退出是 sweep 驱动的 SIGTERM。记录契约只在先置 `stopRequested: true`
  时接纳 `stop_requested`（managed-child-run-record.ts:332）；
  `HostedChildRunSession.requestStop`/`settleStopRequested` 存在但没有
  生产调用方。Monitor 车道已经经 close 路径的 `loop.stop(stopSettle)`
  投影 `stop_requested`。
- **退出观测已落地。** B1（#13830）在 Session 重新获取时观测后台退出
  （scan 臂，fire-and-forget）；B2 的捕获上界已在 main（16 MiB 暂停 /
  4 MiB 恢复水位，逐块再断言，#13834 的 launcher-exit 见证）。

## 4. 范围

范围内：

1. 实现裁决 1 的 Runtime 持有语义，覆盖两个 H3 族（后台 Shell 与
   Monitor watch）。
2. A8 投影（裁决 2）。
3. 门禁抬开本身：`monitor_run` 加入 `MANAGED_SESSION_ENABLED_DOMAINS`，
   `shell` 加入 `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS`，并按 #13846
   的做法有意翻转测试（经真实门禁提交；需要门禁关闭的测试逐测试关闭）。
4. 退役 rig 的准入开关两臂（`QWEN_H3_ACCEPT_ADMIT`/
   `QWEN_H3_ACCEPT_ADMIT_KINDS`）：门禁成为生产行为后，这两臂已无物可
   放行。
5. 在 H3 rig 上记录一次物理验收走查，含本次启用欠下的 Stage F 故障轮
   （#12380 的验收判据写的是「for each enabled capability」）。

范围外：`workflow` kind（#13803）；`send_input`、detach 与跨 boot attach
（#13265 的具名后续）；A7 重建驱动（被持有的 Runtime 会把 workspace mount
钉到 close —— 见风险）；公开任务取消与 children 的 task-event/
output-cursor 流（#13746）；macOS 进程组剖面；跨宿主双重持有。

## 5. 设计

### D1. release 分为 routine 与 drain（broker）

`RuntimeBrokerService.releaseSession` 获得两个调用方早已点名的区分：

- **routine release**（公开 `:release` 路由的默认）：sweep 变为仅观测
  —— 每个非终态持有行向其物理所有者询问一次，已证明退出的行就此结算，
  其余保持。永不发行 terminate。观测后仍非终态的行使 release 以
  **409 `runtime_session_held`**（新 code）拒绝：hold 是被设计的状态，
  可与 `runtime_session_busy` 区分，后者保持其精确的现有含义（一个活跃
  control 或 sweep 无法清算的非后台执行）及其在 harness 上的精确现有
  后果（Session park）。
- **drain release**（控制面的 `drainHarnessSession` 路径，以及为下面的
  Session close 准备的公开路由 `"drain": true`）：sweep 保持今天的
  status → terminate → status 语义；无法证明已停止的仍以
  `runtime_session_busy` 拒绝；完全证明的 drain 完成 release。

busy 检查的顺序不变：活跃 control 与非后台执行先以
`runtime_session_busy` 拒绝；持有行经既有的排除集单独计数。公开路由的
`drain` 字段是可选且追加的；今天任何能 release 的调用方本来就能 drain，
因此该标志不授予任何新能力。

### D2. Monitor watch 像后台 Shell 一样在 broker 持有

H3 设计的「one execution for the life of the watch, holding the Runtime」
落地为 broker 侧持有行，形状与 shell 族相同：

- `admitBackgroundProcess` 也为 `is_monitor` payload 接纳持有行，列入兄弟
  dispatch 族（`background_v3_monitor` 与 `background_v3_process` 并列）。
  start 执行仍然以 detached 结算；watch 行在 watch 存活期间保持非终态。
- 新增 Java `ManagedMonitorProtocol`，镜像 `ManagedShellProtocol`（kind
  注册表、Session 校验、recovery 标记），使 broker 能驱动 worker 已建好
  的 `monitor-status`/`monitor-stop` 路由（managed-monitor-protocol.ts
  已在 worker 侧定义它们）。
- 仅观测 sweep 询问 `monitor-status`；drain sweep 发行 `monitor-stop`。
  重新获取时的 scan（#13830）同样观测 monitor 行，因此在 Harness 缺席
  期间结束的 watch 在下一次 acquire 时从证据结算。
- 两族都在 broker 持有后，routine release 在 `transport.release` 运行
  之前拒绝，因此 worker activation 门禁的「deactivate 即停止」只会从
  drain release 到达（那里停止才是目的）或从无存活持有的 release 到达
  （那里它是空操作）。门禁本身与 transport 接口不变。

自行结束的 watch —— 即它的进程退出 —— 在下一次观测时结算其行，并经既有
publisher finalize 结算其 monitor_run 记录；持有结束，下一次 routine
release 成功。而两个 Harness 侧的界（`idle_timeout_ms`、`max_events`）
经客户端 control 路由的 `monitor-stop` 停下 worker 里的 watch，只凭 worker
的退出证据结算记录，同时结算持有行；worker 无法证明的停止把记录 park，
直到 watch 自己的结束或 Session close 的 drain 结算它（§6，#13896）。

### D3. turn 结算把 `runtime_session_held` 视为被设计的持有

`finish()` 保持无条件调用 release —— 拒绝路径对诚实性仍然承重 —— 并
对答案分类：

- 409 `runtime_session_held`：turn 正常结算。被持有的 Runtime Session
  记录在 Session 上（`runtimeLeaseHeld` 机制变为集合形状，每个持有中的
  turn 的 Runtime Session 一项），close 路径据此承接。Session **不**
  blocked：没有任何东西丢失，Runtime 可验证地存活并持有，block 会把一
  个健康的 Session 停掉。
- 409 `runtime_session_busy` 或任何其它失败：不变 ——
  `HostedToolRecoveryRequiredError`，Session block，此后的 close 把
  Monitor 停成 `runtime_lost`。钉住的故障门禁（「parks a Monitor on
  runtime_lost when the Session closes over a refused release」，它 stub
  的是 `runtime_session_busy` 拒绝）不改动、保持绿。

被持有 turn 的 Runtime Session 由后续 turn 按名重新获取，或由下面的
close 释放；broker 侧的行独立于两者持有，因此 Harness 重启不丢失任何东西
（下一次 acquire 时 scan 观测）。

### D4. Session close 有界地 drain 被持有的 Runtime

close 处理器获得 H3 close 序列点名的那一步，位于 publisher close 之前，
使 drain 的 finalize RPC 仍能落地：

1. 在 monitor loop 停止之后，每个被持有的 Runtime Session 经公开路由
   （`"drain": true`）drain-release。sweep 终止该 Session 存活的后台
   Shell 与 Monitor watch（平台驱动的停止），worker 的 finalize 经仍
   开放的 publisher 流入，broker 行从退出证据结算。
2. close 在有界窗口内等待 publisher 跟踪的每个后台捕获到达其终态写。
   无法在窗口内证明其停止的 drain 使 close 诚实地失败（503，Session
   保持可重开，持有持续）—— close 绝不留下存活进程，也绝不铸造无法
   证明的结算。
3. 之后publisher close、待定输入结算与 `session.managed.close(...)`
   按今天的顺序运行。

`releaseLeaseNow`（close 处对恢复收养 lease 的交还）出于同一原因以
drain 语义释放；取消路径的 fire-and-forget 交还保持 routine 语义（取消
路由绝不能停止存活 run；持有保持亏欠直至 close）。

### D5. A8：平台驱动的停止投影为 `cancelled`/`stop_requested`

标记在物理请求停止的地方产生，随既有 finalize 证据上行：

- worker 注册表给它被要求停止的 run 打标（后台 Shell 注册表的
  `terminate`/`stopSession`/`stopAll`；monitor 的对应物），且当退出跟随
  该请求时，捕获 finalize 的进程证据获得可选的 `stopRequested: true`。
  自然退出不带标记。
- harness publisher 的 `finalizeBackground` 对带标记的 run 以
  `requestStop` + `settleStopRequested` 结算（记录：`stopRequested:
true`、`stopReason: 'stop_requested'`、状态 `cancelled`），满足记录
  契约「`stop_requested` 要求先置标记」的规则
  （managed-child-run-record.ts:332）。无标记的退出照今天以
  `settleExited` 结算。Monitor 车道经其自身结算路径镜像；停止来自
  Session close 的 `loop.stop(stopSettle)` 的 watch 已经以同样方式投影。
- publication 契约的封闭 payload 形状（managed-tool-publication.ts /
  ToolPublicationContract.java 及共享 fixtures）接纳可选的
  `stopRequested` 证据字段，两种语言，随本变更加入。

### D6. 门禁抬开

- `MANAGED_SESSION_ENABLED_DOMAINS` 加入 `monitor_run`；
  `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 在 `child_agent` 旁加入
  `shell`。Java store 不需要 enablement 列表（自 H1 起它先于任何写入
  方校验记录体）；server-first 顺序已经成立。
- 有意地翻转测试：钉住禁用态的测试（managed-child-run-record.test.ts
  的 per-kind 门禁测试、managed-extension-record.test.ts 的
  `monitor_run` 钉）翻转为断言启用态；用 `vi.mock` 抬门的 authority
  套件（managed-session-authority.extension.test.ts、
  managed-session-authority.child-run.test.ts）移除抬门、经真实门禁提交；
  需要关闭门禁的套件逐测试关闭。tool-turn 准入测试的故意拒绝臂
  （hosted-workspace-tool-turn.test.ts）变为准入臂。
- 声明工具表重查而非假设：生产的 `HOSTED_WORKSPACE_SHELL_TOOLS` 与集成
  driver 已声明 `monitor`；Java Harness IT 的 model mock 列的是 files
  车道集合，除非该 IT 换道否则不动。写着「Background jobs are
  unavailable.」的 `run_shell_command` 声明文本更新为描述已启用的能力。
- rig 的准入开关两臂退役：rig 的 `rig-up.sh` 去掉
  `QWEN_H3_ACCEPT_ADMIT`/`QWEN_H3_ACCEPT_ADMIT_KINDS` 导出，bundle 以无
  补丁重建，验收对着生产列表跑。

### D7. 物理验收，重跑

rig 走查（`/root/h3-accept-rig`，`final-pass.sh` + `swap-and-verify.sh`）
按新语义更新，并对着合入构建、不带任何准入臂重跑：

- **B1/B3**（所有者身份、跨 Broker 重启的持有）：不变，外加 0.25 秒存活
  窗口轮询。
- **B2，此前被阻塞的臂**：一个活过其 turn 的生产者（`printf` 第一段、
  `sleep`、`printf` 第二段、退出）—— turn 在 run 存活时结算且 Session
  **不** recovery-blocked；退出后输出经 Session-store 资源 GET 读回，与
  其 manifest 摘要逐字节一致。
- **B4，拆分**：对存活 run 的裸 `release` 现在应答 409
  `runtime_session_held` 且不停止任何东西；drain `release` 应答 200，
  run 以 `stopRequested: true` 与信号证据结算 `cancelled`/
  `stop_requested`（A8），cgroup unit 排空。
- **B5**（worker SIGKILL → 准确 409 `runtime_admission_closed`，绝不静默
  重铸）：不变。
- **Monitor arm，扩展**：watch 现在可证明地活过其起始 turn —— 在该
  turn 结算后 `observationSequence`/`notifiedThrough` 仍推进，通知唤醒
  后续 turn，Session close 把记录结算为 `stop_requested` 且其输出
  manifest 已持久化。
- **A8 断言**：走查中每个平台驱动的停止都带 `stopRequested: true`；
  每个自然退出都不带。

### D8. 两项能力的 Stage F 故障轮

本片启用的每项能力都欠 #12380 的 Stage F 验收判据。对一次后台 Shell run
与对一个 Monitor watch，本轮覆盖：

| 故障     | 门禁                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| ACK 丢失 | 被丢弃的 finalize 应答被 redrive 且恰好落地一次（publisher 的有界 redrive），绝不重复结算                  |
| 观测缺口 | run 中途 Broker 重启不丢失任何东西：重新获取的 scan 从证据观测退出（B1 的臂），且任何 acquire 都不等待观测 |
| 进程崩溃 | run 中途 worker SIGKILL：持有保持，重新获取以原始身份挂接或准确阻塞（B5 的臂）                             |
| 取消     | drain release 停止该 run 并投影 `stop_requested`；routine release 拒绝 held 且不停止任何东西               |
| 输出投递 | finalize 时 publisher 端点拒绝使记录诚实地保持非终态且 redrive 有界，绝不静默丢弃                          |
| 存储故障 | 结算期间的 store 故障被重试，或记录保持可证明地未结算；没有任何已提交修订声称存储了并未存储的字节          |

broker 级臂落为 runtime-broker 故障门禁测试（`fault-gates` Maven profile
的既有 rig）；harness 级臂落为既有的 Monitor park 门禁旁的 hosted 故障
门禁测试；物理臂在 D7 走查中运行。每个门禁在持有或投影被移除时都会变红
（经变异检验）。

## 6. 约束与风险

- **A7 成为稳态。** 存活的后台 run 钉住其 Runtime，而 Runtime 钉住
  workspace mount：需要该 mount 的后续 Session 的 turn 会等待，并可能以
  `runtime_provision_failed` recovery-block。这是被设计持有的代价，已在
  #13533 记为 A7；re-release/重建驱动仍是声明的后续工作。本片绝不能
  让钉住不可见：持有状态记录在 Session 上并在其状态中可见。
- **混合版本容忍。** 旧 Harness 对新 broker 把 `runtime_session_held`
  拒绝读作未知失败并 park（降级但诚实）；新 Harness 对旧 broker 看到旧
  drain 并照今天行为。两者都不伪造结算。
- **诚实契约承重。** `runtime_session_busy` 路径 —— 拒绝、park、close
  时 `runtime_lost` —— 被故障门禁钉住，不受 D1/D3 触碰；新增
  `runtime_session_held` code 的存在正是为了让被设计的持有永不搭上那条
  路径。
- **Monitor 的自动停止只凭 worker 的退出证据结算。** 配额与空闲窗口跑在
  Harness 里，watch 跑在 worker 里。自 #13896 起，客户端 control 路由为
  Session 自己的 watch 接纳 `monitor-status` / `monitor-stop`，自动停止只在
  worker 应答 `exited` 时结算 `max_events` 或 `idle_timeout`，并同时结算
  watch 的持有行。worker 无法证明的停止把记录 park 在 `runtime_lost` 线上，
  直到 watch 自己的结束或 Session close 的 drain 结算它。见
  [Monitor 自动停止的远端退出证据](2026-10-11-managed-monitor-auto-stop-evidence.zh-CN.md)。
- **#13846 在飞**，同样编辑 `managed-session-records.ts`；后合入的一方
  绕开另一方改号。

## 7. 验证

- 单元：`packages/core` managed-runtime 套件（记录契约的
  `stopRequested` 规则、投影划分、门禁翻转）、`packages/cli` serve 套件
  （turn 结算的持有分类、close drain 顺序、publisher 的 A8 投影、worker
  注册表标记）、`packages/sdk-java` runtime-broker（routine/drain
  release、monitor 持有行、sweep 族）与 managed-agent-server
  （publication 契约形状），共享 payload fixtures 驱动两种语言。
- 故障门禁：D8 表的 CI 臂，外加既有钉住门禁不变。
- 物理：D7 的 rig 走查在打包链路上运行，记录于本文档与
  `.qwen/e2e-tests/2026-10-11-h3-enablement.md`。
- `npm run build && npm run typecheck`、每个被触及包的包级测试运行，
  以及提交前的多轮审计。

## 8. 验收判据

1. 生产配置可提交 `monitor_run` 记录与 `child_run`/`shell` 记录；
   `child_agent` 对照不受影响。
2. 后台 Shell 在物理走查中活过其 turn；其输出在退出后作为 Artifact
   读回（行为 2，此前被阻塞）。
3. 对存活 run 的 routine release 应答 409 `runtime_session_held` 且不
   停止任何东西；turn 结算且 Session 不 blocked。
4. drain release 停止该 run，记录以 `stopReason: 'stop_requested'` 与
   `stopRequested: true` 结算 `cancelled`；自然退出以 `exited` 结算且
   无标记。
5. Monitor watch 活过其起始 turn，跨 turn 通知，并在 Session close 时
   投影 `stop_requested`。
6. Stage F 表的门禁对两项能力全绿。
7. rig 不带准入臂运行；走查已记录。
8. 钉住的诚实门禁（含 Monitor `runtime_lost` park）不变通过。

## 9. 开放问题

1. close drain 窗口的精确界（注册表既有的每族 5 秒宽限加 sweep 的往返
   是起点；实现钉住该数字及其见证）。
2. 长期持有的 Runtime 是否应超出当前字段进入 Session 的公开状态（今天
   持有经任务表面可见；专用字段是产品调用，此处不需要）。
3. A7 重建驱动的时间安排随 W 系列 mount 工作。
4. 已由 #13896 解决：Monitor 的自动停止经客户端 control 路由取得自己的
   远端退出证据；见
   [Monitor 自动停止的远端退出证据](2026-10-11-managed-monitor-auto-stop-evidence.zh-CN.md)。
