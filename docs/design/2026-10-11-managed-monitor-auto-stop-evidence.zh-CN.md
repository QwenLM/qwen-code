# Managed Agent Monitor 自动停止：远端退出证据

[English](2026-10-11-managed-monitor-auto-stop-evidence.md) | [简体中文](2026-10-11-managed-monitor-auto-stop-evidence.zh-CN.md)

状态：已实现（2026-10-11）。在 H3 启用（#13856、#13889）之上实现
#13896。相关：
[H3 启用](2026-10-11-managed-h3-enablement.zh-CN.md)（持有行，以及本改动
取代的过渡 park）、
[H3 Shell/Monitor 运行时](2026-10-03-managed-shell-monitor-runtime.zh-CN.md)
（worker 的 `monitor-status`/`monitor-stop` 路由）。

## 1. 问题

Monitor watch 跑在 worker 里，而持有其配额（`max_events`）与空闲窗口
（`idle_timeout_ms`）的 loop 跑在 Harness 里。只有 Runtime 的维护路由能在
物理上停下 watch，而在本改动之前只有 Broker 自己的 release sweep 能到达
它：面向客户端的 control 路由只接纳 MCP 与 Hook 操作。远端 watch 句柄的
terminate 因此什么也停不下。

H3 启用的过渡方案（#13889）让 loop 不再声称它无法证明的结算：自动停止把
记录 park 在 `recovery_blocked` / `runtime_lost` / `outcome_unknown` 线上，
而不是结算成 `max_events` 或 `idle_timeout`。watch 继续运行，其
`background_v3_monitor` 持有行保持存活，其 Runtime Session 一直被持有，
直到 Session close 的 drain 结束它。

## 2. 现状（已在 `1bbaf93e8d`，即 #13889 合入后核实）

- `RuntimeBrokerService.control` 把任何不是 MCP 或 Hook 的操作交给
  `ProviderRuntimeProtocol.control`，其默认分支以
  `runtime_control_operation_invalid` 拒绝 `monitor-*` kind。
- `HostedMonitorRemoteExecutor` 的句柄不询问任何人，直接以 `false` 应答
  `terminate()`。
- `HostedMonitorLoop.settle(reason, true)` 只在 `terminate()` 证明停止时
  结算 `max_events` / `idle_timeout`，否则 park 记录（#13889）。park 结束
  loop 的观测，但让记录保持打开：watch 之后的退出或 close 已证明的停止
  仍会结算它。
- worker 的 `ManagedMonitorRuntime.control` 从其注册表应答
  `monitor-stop`：watch 的 unit 被证明已空时应答带证据的 `exited`，否则
  应答 `unknown`。注册表的 terminate 以 watch 的 completion 解析，而
  completion 会在应答返回之前把 capture 的 finalize 送达 Harness
  publisher。
- Broker 的 transport（`HttpRuntimeTransport`、
  `WorkspaceRuntimeTransport`）已为 sweep 转发并校验 `monitor-*` 操作；
  `ManagedMonitorProtocol.response` 已要求 `exited` 携带证据。

## 3. 范围

范围内：#13896 的四项 —— Broker 在客户端 control 路由上接纳 Monitor
操作、CLI 的 `monitorControl()` 包装、等待 worker 退出证据的远端
terminate，以及关于 worker 侧界的决定（§5.3）。

范围外：在客户端路由上接纳 Shell 维护 kind（没有 Harness 侧调用方需要
它们）；在最后一个持有结束时提前释放被持有的 Runtime Session（仍由 close
的 drain 释放，与自行退出的后台 Shell 相同）。已 park 的记录在其 watch
稍后退出时结算，属于 #13889，不属于本改动。

## 4. 设计

### D1. 客户端 control 路由接纳 Monitor 操作（Broker）

`control()` 在 MCP 与 Hook 之外接纳 `ManagedMonitorProtocol` 操作：
`validateSession` 用已获取的 Session 校验 `sessionKey`，且两个 kind 都是
recovery kind，因此即便新准入已关闭（Harness 正在 drain），停止仍能到达
它的 watch。在协议自身的校验之上，操作必须指向本 Runtime Session 自己的
某个 watch：

- `operationId` 是启动该 watch 的 execution。Broker 从账本读取它的持有行
  （`<operationId>:process`）。
- 该行必须属于 `MONITOR` 持有族，属于本 Harness Session、Runtime
  Session、binding 与 generation，并以 `targetOperationId` 作为其
  `callId` —— 即 worker 据以派生 watch unit 的 Runtime call。

其余一切 —— 别的 Session 的 key、别的 Session 的 watch、后台 Shell 的
行、不配对的组合、不存在的行、任何持有行都不可能带有的 id（含 NUL，或加
后缀后超长）—— 都在 worker 看到之前以协议的形状拒绝
（400 `runtime_control_operation_invalid`）。

Monitor control 在 control 栅栏（release 的忙检查所读的活跃 control 计数）
之外运行，与重新获取时 scan 的 status 询问一致（#13830）。在 watch 可能仍在
运行期间，阻止 Runtime Session 释放的是 watch 的持有行而不是栅栏：对非终态
行的 routine release 应答 `runtime_session_held`，drain 则发出自己的停止。
若计入栅栏，watch 自己的 turn 结束时仍在等待 worker 的自动停止会把该 turn
的 routine release 变成 `runtime_session_busy`，从而阻塞整个 Session。

### D2. 被证明的退出在路由上结算持有行

worker 应答 `exited` 时，Broker 以该证据结算 watch 的持有行，与 release
sweep 的做法完全相同（`settleBackgroundProcess`）。`running` 与
`unknown` 保留该行。持有因此随自动停止结束：Broker 不再计入该 watch，
因此对该 Runtime Session 的 routine release 不再因它应答 held。Harness
自身仍在 Session close 时释放被持有的 Runtime Session（§3）。

### D3. `monitorControl()` 与远端句柄的证明（CLI）

`HostedWorkspaceBroker.monitorControl()` 与 `control()`、`hookControl()`
投递到同一 control 路由，但按 watch 的词表校验：应答指名
`targetOperationId`，状态是 `running`、`exited` 或 `unknown`（绝不是
Hook/MCP 的 `settled`/`outcome_unknown`），且 `exited` 携带证据。

`HostedMonitorRemoteExecutor` 现在接收 turn 的 broker、Session key、启动
execution 的 id 与 Runtime call 的 id。它的 terminate 发出
`monitor-stop`，只对 `exited` 应答 `true`。`running` 或 `unknown` 应答、
Broker 拒绝、丢失的 Runtime Session 或传输失败都应答 `false`。

### D4. loop 只凭证明结算，且同一时间只有一个停止

自 #13889 起，loop 的配额与空闲停止只在 terminate 证明停止时结算
`max_events` / `idle_timeout`，否则 park。有了 D3，证明现在存在了，而一次
停止现在要到 worker 往返一次。在等待期间，loop 遵守三条规则：

- 只有仍在观测的 loop 才发起自动停止。另一个停止进行中时触发的窗口或
  空闲计时器什么也不停。
- Session close 的 `loop.stop()` 先等待仍在途的自动停止。已证明的自动
  停止结算记录；其最终输出始终未落地时，close 以停止的原因结算记录，且不
  发出第二次停止（D5）。只有它的 park 才把记录留给 close 自己的停止。
- 一个停止的退出在该停止自己的应答返回之前已结算了记录时，保留该结算
  （D5）。

close 的 `loop.stop()` 对仍存活的 loop 也会到达 worker（通常 drain 已先
结束它）；其结算选择不变。

### D5. 最终输出先于结算落地

worker 只在 watch 的 completion 之后应答 `monitor-stop`，而 completion
包含 capture 向 Harness publisher 的 finalize。publisher 先把记录的输出
manifest 推进到其封口修订，再在自动停止仍在等待时把退出交给 loop。该退出
就是这次停止自己的证据：loop 在 finalize 链内以停止的配额或空闲原因结算，
finalize 的 `stopRequested` 标记不会覆盖它。随后到达的 worker 应答发现
记录已结算；应答丢失也不改变什么，因为退出已经证明了结束。结算之后，记录
契约只允许 `notifiedThrough` 变化。

已证明的停止仍可能先于其退出到达。publisher 拒绝该 finalize 时（例如
最终输出推进遇到短暂的存储故障），worker 的 completion 记录投递失败但
保留证据，因此 `monitor-stop` 仍应答 `exited`。此时没有任何退出到达
loop，记录的输出也尚未封口。loop 于是让记录保持打开，并保留停止的原因，
既不 park 也不做终态结算：终态记录会拒绝 publisher 对同一 finalize 的有界
重驱仍需写入的输出修订。重驱送达退出后，记录以停止的原因结算，并带着封口
的 manifest。若重驱始终未能落地，Session close 以该原因结算记录，且不发出
第二次停止，因为停止已获证明。在此之前，watch 已经结束、其持有行也已结算，
记录却仍显示 `running`。

退出链本身从不发出停止。当 watch 自行结束（或经 drain 结束），而其
finalize 冲刷的最后一个窗口达到配额时，该窗口照常提交，但不触发配额：
物理结束优先于配额，记录以退出结算（#13856 R1-30）。从该 finalize 内部
发出的停止会等待它自己，因为 worker 只在同一个 finalize 返回之后才应答
停止。

## 5. 决定

1. **watch 以其启动 execution 与其 Runtime call 指名。** Harness 两者都
   知道，持有行派生自前者，worker 的 unit 派生自后者，Broker 通过账本把
   二者绑定。查找按行 id 而不是遍历存活行，因此对已结束 watch 的 stop 或
   status 仍能到达 worker 保留的回执（幂等）。
2. **停止未获证明后，Harness 侧不重询。** worker 的停止已在其宽限内从
   SIGTERM 升级到 cgroup kill，只在 unit 拒绝清空时应答 `unknown`。短暂
   重询不会改变该应答。记录 park，Session close 的 drain 仍是兜底。拒绝或
   传输失败同样 park 且不重试：park 让记录保持打开（#13889），因此 watch
   自己的结束或 close 的 drain 仍会结算它。
3. **本改动不加 worker 侧的配额或空闲界（#13896 第 4 项）。** 记录的
   `max_events` 要求 `observationSequence == maxEvents`，按 Harness 的
   去抖观测窗口计数，worker 无法从原始行复现：worker 侧配额会在不同的点
   结束 watch，并投影为 `stop_requested` 或 `exited`，永远不是配额。空闲
   界可以近似镜像，但那样两个时钟会为同一个原因竞争。剩下的暴露面 ——
   Harness 死亡且再也不重开其 Session —— 与后台 Shell 共有，因此它属于
   与族无关的孤儿策略（例如由 Harness 续约的持有租约），记为后续工作，
   而不是在这里按族各加一份。

## 6. 约束与风险

- **混合版本保持诚实。** 新 Harness 对旧 Broker 得到旧的拒绝，terminate
  应答 `false`，记录如 #13889 那样 park。旧 Harness 从不发送 Monitor
  操作。
- **丢失 Runtime Session 的 Broker**（重启）应答
  `runtime_session_not_found`；停止未获证明，记录 park。Harness 不会为了
  停止而重新获取 Runtime Session。
- **publisher 在停止时拒绝的 finalize** 仍会得到 `exited`（worker 的
  completion 记录投递失败但保留证据）。记录以停止的原因保持打开，直到该
  finalize 的重驱落地（D5）。有界重驱耗尽时，或 Session close 在待触发的
  重驱之前结算记录时，记录结算后输出 manifest 仍为 pending。任何先于被拒
  finalize 运行的终态结算都有相同的暴露面。
- **未证明的自动停止可能以 `stop_requested` 结束。** worker 在尝试 kill
  之前就把停止标记为已请求。该停止未获证明而 watch 稍后结束时，其
  finalize 带着这个标记，打开的 park 按 #13889 对 park 之后的停止的规则
  结算为请求的停止。worker 无法把这个标记与 drain 的标记区分开。
- **落在窗口 flush 之内的空闲停止。** 窗口与空闲计时器不串行。空闲计时器
  在某次窗口 flush 仍在提交其观测时触发、且停止的结算先提交时，记录契约
  会拒绝那条迟到的观测。远端停止要到 worker 往返一次，因此本地的观测提交
  通常先落地。这种形状并非远端停止特有：任何在并发 flush 提交之前结算的
  停止都会遇到它。消除它需要一种不等待退出链（D5）的窗口/结算顺序。

## 7. 验证

- Broker（`RuntimeBrokerServiceTest`）：接纳 `monitor-status` 与
  `monitor-stop`，在 `unknown` 时保留、在 `exited` 时结算持有行，以及之后不再发出任何维护调用
  的 routine release；停止仍在途时 routine release 应答 held 而不是 busy；
  完成的 Monitor control 不结束任何 control 栅栏，因此仍在途的计入栅栏的
  control 让 release 保持 busy；Harness drain 期间的停止；拒绝别的 Session 的 key、恰在一个归属字段
  （Harness Session、Runtime Session、binding、generation）上与本 Session
  的 watch 不同的 watch、Shell 行、不配对的组合、不存在的行与任何持有行都
  不可能带有的 id，且都不转发。
- CLI：`monitorControl()` 的转发、对 `running` 与 `unknown` 的接纳与应答
  校验，以及拒绝以 rejection 浮现
  （`hosted-workspace-broker.test.ts`）；句柄的证明映射
  （`hosted-monitor-remote-executor.test.ts`）；turn 对 Runtime call 的
  接线（`hosted-workspace-tool-turn.test.ts`）；`max_events` 与
  `idle_timeout` 只在最终输出落地之后经真实 publisher 结算（包括存储两次
  拒绝最终推进、由重驱在记录结算之前落地封口输出的情形），以及越过配额的
  自然退出不经停止即结算（`hosted-shell-publisher.background.test.ts`、
  `hosted-monitor-loop.test.ts`）。loop 还钉住在途的停止
  （`hosted-monitor-loop.test.ts`）：先于 worker 应答落地的退出以停止的
  原因结算，无论该应答被证明还是丢失；不带证据的结束结算为
  `watch_failed`；close 的停止等待自动停止，只在其
  park 时才行动；close 的停止保留其退出造成的结算；在配额 flush 之内触发
  的空闲计时器不发出第二次停止；没有退出的已证明停止让记录保持打开、不
  park，直到退出到达，或在 close 时以其原因结算。
- 变异轮（在与 main 合并后的代码上运行）：覆盖 Broker 门禁、行结算、逐一
  的各项归属校验、id 筛查、`unknown` 保留、control 栅栏、包装的校验与接纳
  状态、证明映射、退出链、turn 接线与在途停止的每条规则的 27 个变异体，
  全部被杀死。第二轮评审又增加 5 个：completion 的栅栏结束，以及针对被拒
  finalize 保持打开的 4 个（凭证明结算、凭证明 park、丢弃保留的原因、close
  以该原因结算），全部被杀死。拒绝路径上的栅栏结束没有可观测的变异体：它
  唯一的抛出来源是 Runtime 进程已死，而这会先让 binding 丢失；丢失的
  binding 永不重新激活，死进程不会重新可用，release 对栅栏的两处检查都只在
  lease 证明可用之后才运行。
- `npm run build && npm run typecheck`、被触及的 CLI 套件，以及
  `runtime-broker` 的 `mvn test` / `checkstyle:check`。
- 物理：本改动未运行。H3 rig 的 Monitor 臂是加入自动停止走查的位置
  （一个 `max_events` 较小的 watch，在 close 之前其持有行已结算且
  routine release 成功）。

## 8. 验收判据

1. 达到 `max_events` 的 watch 在其记录结算之前被证明已在 worker 中停止
   （`monitor-stop` 应答 `exited`），其持有行无需 Session close 即结算。
2. `idle_timeout_ms` 同样成立。
3. worker 无法证明的停止仍 park 记录；不会在运行中的 watch 上声称结算。
4. Java 与 CLI 测试既钉住 Monitor control 操作的接纳，也钉住对指向别的
   Session 的此类操作的拒绝。

## 9. 开放问题

1. 针对 Harness 再也不回来的持有的、与族无关的孤儿策略（§5.3）。
2. 被持有的 Runtime Session 是否应在其最后一个持有结束时立即释放，而不是
   在 close 的 drain 时释放。
3. 一种既保留迟到观测、又不等待退出链的窗口 flush 与空闲停止之间的顺序
   （§6）。
