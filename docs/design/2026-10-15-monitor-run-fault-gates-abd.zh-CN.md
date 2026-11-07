# Monitor run 故障门禁 FG8a/FG8b/FG8d

[English](2026-10-15-monitor-run-fault-gates-abd.md) | [简体中文](2026-10-15-monitor-run-fault-gates-abd.zh-CN.md)

## 问题与范围

Issue #14163 跟踪 FG8 为 `monitor_run` 与 `child_run` 的 `shell` kind 剩余的故障门禁。第一片（FG8e/FG8f）已由 #14120 落地（见 `docs/design/2026-10-13-monitor-run-fault-gates.md`，即本轮设计文档——本文沿用的形状、夹具纪律与门禁账本均出自它）。本文是第二/三片的设计：**FG8a（应答丢失）、FG8b（存储故障）、FG8d（取消与 drain）**——issue 账本上列的 case 全部保留，一处不删。**FG8c 不在范围内**：它钉的是 #13986 在改的重启行为（写本文时 #13986 处于 CHANGES_REQUESTED），继续由 issue 跟踪到那个 PR 落地为止。

本轮设计里记录过的分片决策已经有两条失效：#14021（FG8a 的前置）已以 `7b95cfcb88` 合入；#13918（当时的存储失败错误码谱系）与 #13986（当时的冷加载回填）尚未合入，而 issue 与 triage 用一句话回答了他们引出的排序问题——门禁钉在**物理 / OS / 存储真相**上：每次派发一个进程、进程启动前失败不产生 OS 副作用、重驱幂等、持久前缀逐字节一致、终态诚实。错误码措辞与冷加载臂属于 #13918/#13986 的地盘，本片刻意不去断言。

本片**不改任何生产代码**。装备就是 #14120 的那一套：一个 IT 类（`HostedMonitorRunFaultGatesIT`）、一个 probe（`HostedMonitorRunProbe`）、一个按 case 驱动的 TypeScript driver（`integration-tests/helpers/hosted-monitor-run-fault-driver.ts`）、真实打包 Harness、真实 MySQL/MariaDB、JDBC 地面真相，以及每门一条具名变异见证。

## 新字母与第一片共用的部分

`runLetter` 已经拥有：MySQL/Harness/node 属性门、`-Dqwen.<letter>.case` 选择子、按字母在 `target/fg8-cases/<letter>/` 重建的证据目录、一个带嵌入式 broker 的 in-JVM Spring、按 case 的 workspace mount 加 JDBC 播种的 registry/access 行、`HostedMonitorRunProbe` gate server，以及 driver 启动/回读协议（`FG8_CASE_OK`、字母终态标记、`results.json`）。每个字母共用的 `assertCase` 前半——`ma_tool_execution` 里恰好一条 `<id>:process` 行（能力的「至多一个物理进程」证明）——原样保留。新字母driver 侧复用 `extensionRecord`、`loadOutputRows`/`verifyOutputChain`（FG8f 的输出链走查）与 observer/probe 客户端 helper。每字母 `@Timeout(600)`：host fork 预算关系钉着「每个 ceiling 加 healthy 余量不超过 1800 s fork」，详见 CI 节。

## 范围决策

1. **FG8c 等 #13986 落地再写。** 它压的正是 #13986 在改写的冷加载/重铸平面，现在写等于写两遍。IT 类注释将改记为 a-d 分两片落地（本片 a+b+d，c 后续）。

2. **门禁断言物理真相，不分支逻辑。** triage 在 #14163 上唯一一处实质性更正仍然成立：`HostedMonitorRemoteExecutor.stop` 的 `proven=false` 收敛、routine/drain 两臂的选择、`settleStopRequested` 投影，今天都被 vitest 钉着（`hosted-monitor-remote-executor.test.ts`、`hosted-harness-session.test.ts`、`hosted-child-run-session.test.ts`）。这些单测结构上钉不住的——恰好一个物理进程、零 OS 副作用、真实丢应答后恰好一条 journal 行、真实事务回滚——恰恰是本片每个 case 通过 JDBC、捕获日志与 case 目录证据断言的东西。只会复述 vitest 断言的期望措辞从门禁里剔除；一个 case 的自然结局存在两种诚实变体时（例如启动前取消结算成 `cancelled` 还是 `start_failed`/`not_started_proven`），门禁断言行级不变量并记录实测到的结算形态，不赌措辞。

3. **broker 代理长出真注入。** FG8a 的 dispatch/monitor-stop 臂与 FG8d 的 `cancel-reply-lost` 是 broker 前置代理的第一批故障原语：一个 lose-once 臂——转发请求、消费已提交的上游响应、然后毁掉客户端 socket（Harness 无法把这次丢失误读成 HTTP 拒绝）。判别按路径后缀操作名（`:start`、`:cancel`），或针对 monitor-stop 按解析后的 POST body（`operation.kind === 'monitor-stop'`），因为所有 control 调用共享同一条路径。`#13896` 的 control 家族在本夹具里只有 monitor 一个 kind，body 判别无歧义。

4. **driver 为 FG8d 的 release 臂直接对 broker 发言。** 没有任何 daemon 路由暴露 routine/drain release；`cli.close()` 会走 drain 臂但会毁掉夹具。driver 因此对 Harness 已信任的 broker 基址自行发 `:release`，用 `protocolVersion: 1` 与 broker 代理从派犯流量里捕获到的 `harnessSessionId`/`runtimeSessionId` 身份。这条 wire 与 Harness 自己会产出的一样——driver 的角色是触发 + 见证注入，被 gate 的生产代码是 broker 的两臂分叉（`RuntimeBrokerService.releaseSessionAfterSweep`）。

5. **FG8b 的触发器设施沿用 FG7B，按 case 划定。** 每案一道触发器，tenant 与 case 双重 scope，在该案 driver 工作开始前安装、在字母的 `finally` 里拆除，`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT` 为 `FG8B_<case>`。触发器**永久**拒绝该案的提交类型：火一次就解除的臂会让 publisher 的重驱把 issue 要 gate 的阻塞（「manifest 提交失败会阻塞该 run 而不重执行」）直接自愈掉，因此不设 latch、不解除。每次点火另写一行 `fg8b_fire`——MyISAM，行在被 SIGNAL 的回滚后存活，是点火证据唯一能存活的位置——计数即本案归因：broker 把这条 SQLException 压平成 `runtime_broker_internal_error`，与 FG7B 服务器侧提交不同，marker 文本到不了被捕获输出，对它挂 `OutputCaptureExtension` 断言在架构上是死的。

## 门禁账本

每个 case 的地面真相是 JDBC——`ma_tool_execution`（含 `:process` 后缀行）、`ma_session_record` 记录体、输出表（`ma_resource`、捕获的 manifest/page envelope）——外加 broker 代理操作日志、store 代理 commit 日志、被捕获的 Spring 输出与 case 目录证据（producer 标记、gate FIFO、progress 文件）。每个 case 先断言自己的故障真的点了火：代理 drop 计数、`FG8_DROPPED` 行、`fg8b_fire` 点火计数，或 cancel/release 应答的标志位。

### FG8a — 应答丢失（4 案）

driver 让每个 case 的 Session 同时穿过**两个**代理（broker 调用始终走 broker 代理；Session 的 `managedSessionStore.baseUrl` 指向 store 代理）。lose-once 臂点火后即解除，重试的请求正常通过。

| Case                        | 注入                                                                                                                | 期望（JDBC / 证据）                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-reply`            | 在 broker 已提交准入后，丢掉一次 `:start` 应答                                                                      | 重试经原 `executionCallId` 解决：`ma_tool_execution` 里恰好一条 `:process` 行、恰好一个物理进程；run 跑完；child_run 记录按真实退出证据结算（`stopReason: 'exited'`、exit code 0）——绝无编造的结算；drop 计数 = 1。Broker 在 `beginDispatch` 提交后就回 `:start`，此时 worker 未必已写出 producer 标记，所以 driver 先等到 run 要么已启动（标记出现）、要么已按未启动结算，再决定是否打开 gate |
| `monitor-stop-reply`        | 在 stop 已提交后，丢掉一次 `monitor-stop` control 应答                                                              | 重驱（自动停止路径先泊车，再以同一操作身份重问）命中 broker 的终态短路：记录按真实退出证据以配额停止结算（`stopReason: 'max_events'`），`observationSequence == maxEvents == notifiedThrough`；恰好一条 `:process` 行；drop 计数 = 1                                                                                                                                                           |
| `capture-commit-reply`      | 丢掉那条其融合 `resources` 数组携带 `managed-tool-result-page` envelope 的 journal commit 的应答——envelope 本身落库 | publisher 重驱幂等：`verifyOutputChain` 走查里每个被命名 page 恰好一次、段逐字节一致、无重复 content 行；drop 计数 = 1                                                                                                                                                                                                                                                                         |
| `observation-advance-reply` | 在提交落库后，丢掉一次 `commitMonitorRun` journal commit 应答                                                       | `observationSequence`/`notifiedThrough` 绝不跳前：被丢的那次推进停在后面，直到重驱把它落到已提交的位置；最终记录为 `observationSequence == maxEvents == notifiedThrough`；drop 计数 = 1                                                                                                                                                                                                        |

### FG8b — 存储故障（4 案）

触发器 DDL 按 FG7B 形状，名字 `fg8b_<hex>`，message 文本 `FG8B_<CASE>`（`INVOCATION_COMMIT` / `PROCESS_LEDGER_COMMIT` / `MANIFEST_COMMIT` / `PAGE_ENVELOPE_COMMIT`），每次点火另写一行 `fg8b_fire`。触发器按 case tenant 与 case session 双重 scope，对该案余下时间永久拒绝其提交类型，在该 case 的 driver 工作开始前安装、在 `finally` 里拆除。每个 case 先经 `fg8b_fire` 计数断言自己的触发器真的点过火——一门悄悄没点火的 gate 会红在点火计数上，而不是红在某个结局上。

| Case                    | 注入                                                                                                                                                                | 期望（JDBC / 证据）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invocation-commit`     | `BEFORE INSERT ON ma_tool_execution`（`NEW.harness_session_id = <session>` 且 call-id 无 `:process` 后缀）                                                          | 零 OS 副作用：无调用行、无 `:process` 行、无 capture 注册（`ma_output_capture`/capture 资源缺席）、从未有物理进程（case 目录无 `bg-started.txt`）；会话轮不编造后台启动就结束——实测到的 blocked/阻塞结算形态在 gate 侧记录在案                                                                                                                                                                                                                                                                                                                                       |
| `process-ledger-commit` | 同表，call-id 带 `:process` 后缀                                                                                                                                    | 调用行存在，`:process` 行缺席；run 阻塞且不发起二次准入（至多 1 条调用行，broker 操作日志无第二次 dispatch）；无物理进程                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `manifest-commit`       | `BEFORE INSERT ON ma_resource`，`kind = 'managed-tool-result-manifest'` 且携带 `executionStatus: 'success'`（capture 的初始空 manifest 必须落库，否则进程不会启动） | 一条 `:process` 行、一次 start 尝试，结算 manifest 的提交绝不落库——且由于结算提交把 envelope 融合进 `commitChildRunRecord`，拒绝会把 run 阻塞（即 issue 案文的 blocks）：producer 以 0 退出后证据永远写不回家，记录永远开着（`running`、无停止证据、`stopRequested: false`、绝不重执行）；点火计数 ≥ 1                                                                                                                                                                                                                                                               |
| `page-envelope-commit`  | 同表，`kind = 'managed-tool-result-page'`，永久                                                                                                                     | 与 `manifest-commit` 同一种阻塞形态：24 块的 capture 在 finish 前填不满一页（一页 512 段），它唯一的 page envelope 在流封口时暂存，搭下一条输出推进 `commitChildRunRecord` 提交；page 被拒使这次推进回滚，之后每次重试也一样，因为之后的每个 manifest（包括 finalize 的 success manifest）都仍命名这个暂存的 page——零条 page 行、结算 manifest 不落库、每个已提交 manifest 的 page 引用都可解析（落库的只有初始空 manifest），记录保持开着（`running`、无停止证据、`stopRequested: false`、绝不重执行）；见证是一条携带 page envelope 且被拒的推进提交；点火计数 ≥ 1 |

### FG8d — 取消与 drain（6 案）

门禁驱动的生产取消面：turn 级 daemon cancel（`POST /session/:id/cancel`，中止在飞 turn 并驱动该 turn 的 `broker.cancel` 批量），以及 driver 以捕获到的 Harness 身份直发的 broker `:release` 维护路由（带 `drain: true`，shell `child_run` 唯一应答的停止面——child-agent 的 `children/operations` cancel 家族直接拒绝 shell 记录，本字母不走它）。被 gate 的结算投影是 `hosted-shell-publisher.ts`：sink 侧停标先到 `requestStop` 再到 `settleStopRequested`，契约次序，绝不 `exited`。driver 的每次 release（routine 或 drain）都只在派发它的那一轮把 Runtime Session 交还之后才发——所有调用行已终态，且 Harness 自己在轮末发的 routine release 已得到应答。更早发的话，Broker 要么因前台工作答 `runtime_session_busy`，要么把这次 release 并入 Harness 在飞的 routine 尝试、连 drain 也一并答 `runtime_session_held`（Linux rig 上实测到）；这两种都不是本字母要 gate 的格。

| Case                        | 注入                                                                                                                                                                                                                                              | 期望（JDBC / 证据）                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-before-start`       | 在 broker 代理上把 `:start` 请求**转发前** hold；broker 操作日志出现工具准入后，发 daemon cancel；随后毁掉被 hold 的请求，永不转发                                                                                                                | 零 OS 副作用：无 `:process` 行、无 `bg-started.txt`、无 capture 行；调用行经 broker 的 cancel 路径结算（`CANCEL_REQUESTED` → 终态）；child_run 记录终态，绝不 `exited`                                                                                                                                                                                                                        |
| `cancel-during-capture`     | capture 进行中（≥3 个完整段已提交），武装 drain `:release`——shell `child_run` 唯一应答的停止面                                                                                                                                                    | drain 携带停止命令：`stopRequested: true` 随停止证据落库，run 结算为 `cancelled` / `stop_requested`，绝不 `exited`；一条 `:process` 行                                                                                                                                                                                                                                                        |
| `cancel-status-unavailable` | 在 broker 代理上 hold 全部 Harness→Broker 维护/状态请求，outage 期间武装 drain（Broker 自己发往 worker 的 `shell-status` 维护不经过这个代理——见悬而未决第 1 条）                                                                                  | hold 有正向见证——driver 经同一代理发出 Harness 自己会发的那条状态读取（`GET /executions/<call>:process`，Broker 的真实路由），代理日志点名它被泊住（安静的 Harness 不会自发轮询 status，泊它的调用会死锁），释放后必须以同一 `executionCallId` 应答 200；outage 期间不编造终态——记录保持 running，JDBC 不出现结算真相；drain 照常应答，释放后证据把 run 结算为 `cancelled` / `stop_requested` |
| `cancel-reply-lost`         | 在 drain 驱动的停止修订已提交后，丢掉它的 store-commit 应答——即其 shell 记录首次置 `stopRequested: true`、尚无停止原因的那条 `commitChildRunRecord`；按内容匹配，因为每个 shell 修订（admit、dispatch、attach、每次输出推进、结算）共用这个操作名 | 已提交的记录照常携带 `stopRequested: true`；恰好一条已提交 stop 修订——只有一个不同的 journal `commandId` 置过停止标记（重驱重发同一条命令），绝无第二修订或重复记录行；drop 计数 = 1                                                                                                                                                                                                          |
| `routine-release-refusal`   | run 活着且该轮已交还（见上），driver 发不带 `drain` 的 broker `:release`                                                                                                                                                                          | 应答 409 且 `code: 'runtime_session_held'`；什么都不停——没有 stop kind 到达 worker（维护 wire 上无 `shell-terminate`/`monitor-stop` 转发），producer 照常写完它的块，gate 打开后自行退出（`settled`/`exited`/exit 0）；在此之前 `:process` 行保持 `PREPARED`                                                                                                                                  |
| `drain-release`             | 同样等该轮交还后，driver 发带 `drain: true` 的 broker `:release`                                                                                                                                                                                  | drain 臂发出停止（维护 wire 上见到 `shell-terminate`）；run 结算为 `cancelled` / `stop_requested` 且 `stopRequested: true`，绝不 `exited`；release 以 routine 臂被拒时所用的同一捕获身份应答 `released: true`                                                                                                                                                                                 |

## Driver 设计

driver 保留现有三个 arming 原语并新增：

- **Broker lose-once 臂。** `dropNextStart` / `dropNextCancel` / `dropNextMonitorStop` 按 case 武装；broker 代理消费上游应答后 `req.socket.destroy()`（照 store 代理 lose-once commit 臂的形状）。专门的 `holdStart` 臂把请求**转发前**泊住（`cancel-before-start` 的编排），有一个与 `heldReplies` 同形的有界释放；被泊 socket 在 cancel 结算后毁掉，永不转发。
- **Store 臂。** `dropNextPagePublish`（`resources` 数组携带 page envelope 的那条 journal commit）、`commitMonitorRun` 的操作名过滤，以及 `dropNextStopRevision`（其 shell 记录首次置 `stopRequested` 的那条 `commitChildRunRecord`，从提交的 record bytes 里读出）。臂只对 store 已接受的提交生效：被拒的提交从未落库，照常转发，臂保持待命。各臂与各 case 读取的 commit 日志与所有臂一样按 case 重置。
- **Broker 身份捕获。** broker 代理从每个 POST body 记下 `harnessSessionId` / `runtimeSessionId` 对，FG8d 的 release driver 复用生产身份而不是猜测（FG6 的 reply-loss driver 断言同一对）。
- **Broker control 通道观测。** control 调用连同 body 的 `operation.kind` 一起记录，让 FG8d 能把「routine 臂什么都没停」断言为维护 wire 上的**缺席**，而不是时序赛跑。
- **`brokerRequest` helper**，用于 `:release`（routine 与 drain），用捕获的身份与 `protocolVersion: 1`；应答以 `{status, code}` 回给 case 做标志位断言。

FG8d 的 Session 使用 10 s writer lease（`CANCEL_DRAIN_LEASE_MS`），与 FG8c 崩溃 Session 的 lease 等长（`CRASH_LEASE_MS`，已由 #14407 合入）。FG8d 的六个 case 共用一个 tenant，夹具只允许四个活跃 capture（`active-captures=4`）。一个 case 留下的 OPEN capture，其过期时间由最后一次 grant 续约设定（取 writer lease 与 activation 中先到期的那个），而发起该 run 的工具调用一返回，grant 续约就停止，所以默认 60 s lease 下，case 结束后这个 capture 还会占着名额最长约一分钟。快机器跑到 `drain-release` 时，四个名额全被占着：它的 reservation 被拒（store 报 "Publication capacity exhausted"，Harness 日志里当时只记为 "The request is invalid."），run 根本没有启动。10 s lease 下，capture 在最后一次续约后十秒以内就不再计入名额。FG8d 唯一的 store 臂 `dropNextStopRevision` 只匹配一条 stop revision 提交，多出来的 writer 与 activation 续约不会误触发它。

step/diagnose/FIFO 纪律不变；每个新等待都是状态而不是 sleep；producer 提供 `bg-started.txt`、`progress.txt` 与 gate FIFO；每 case 目录仍是冷加载证据基件（一个后来才启动的 case，其文件必须缺席，而不仅是读不出）。

## Probe 设计

不需要新增 probe 相位。FG8a 的记录/断言读现有 `state`（含 `:process` 行的 executions、monitors、childRuns、resources）与 `ledger` 相位；FG8b 的零 OS 副作用断言走 IT 内 JDBC（probe 的表与 IT 查询的是同一批）；FG8d 的身份捕获经 driver 侧 broker 代理到达。

## IT 设计

`HostedMonitorRunFaultGatesIT` 增加三个字母，各为一个调 `runLetter` 的 `@Test @Timeout(600)` 方法，复用 `assertCase` 并点名各字母的期望：

- `fg8aLostRepliesResolveThroughTheOriginalIdentityOnMySql`
- `fg8bStoreFailuresLeaveNoOsEffectsOnMySql`
- `fg8dCancellationAndDrainSettleHonestlyOnMySql`

FG8b 的触发器按 case 经 `JdbcTemplate` 安装，在该 case 的 driver 工作开始前——字母按顺序跑 case，与 FG7B 按字母顺序播种一致——在 `finally` 里拆掉所有已装触发器与 `fg8b_fire` 计数表，失败的 case 不会把臂漏进 fork 余下时间。monitor 相关断言调用现有 helper；零 OS 副作用与阻塞发布断言是同一批表上的小型新 JDBC 查询，外加 `fg8b_fire` 点火计数归因，按案列在上文账本。

## 发现的环境约束：cgroup v2

在 macOS 上，每个会 spawn 受监管进程的 H3 工具都会被 `HookCommandIsolationUnavailableError`（"requires a delegated Linux cgroup v2 root on this Runtime"）拒掉：`monitor` 与 `is_background:true` 的后台 shell 都在 `packages/cli/src/serve/managed-runtime-tool-executor.ts:1105/1331`（`spawnBackground`/`runMonitor`）内被挡下。后果是 `run.execute` 落为 `not_started`，工具回执报 `start_failed`，且没有任何 OS 副作用落进 JDBC（无 `:process` 行、无审放行行、无 capture 注册）。另以 #14120 合入的 fg8e/fg8f 字母在本机失败为独立佐证，形态完全一致。

这道墙界定了本地验证边界：物理真相需要真实进程的案例（所有 monitor、所有 pattern producer）在没有生产代码或 Linux+cgroup 的前提下无法在本机验证。而结算点落在物理启动**之前**的案例——被丢的 `:start`、spawn 前被拒的 commit、cancel-before-start——无论 runtime 有没有 cgroup，物理真相一致，可以在本地验证。CI（`hosted-harness-mysql`，Linux）上字母带着 cgroup v2 跑，`settled`/`exited` 形态作为 gate 生效。

## 变异见证

施加、证明恰好让它那门变红、再还原（用备份副本做变异，不用 `git checkout` 压未提交工作），沿用轮次设计的第二/三片清单，并在读完落地后的 #14021 平面后精化如下：

1. FG8a——后台重准入用新身份而非原 `executionCallId`（如重驱铸造新 call id）：`dispatch-reply` 红在两条 `:process` 行。
2. FG8b——invocation commit 在没有 `:process` 行的情况下照走（跳过 `admitBackgroundProcess`）：`process-ledger-commit`（或 `invocation-commit`，取决于落地代码给这个 skip 的语义）红在它的零 OS 副作用断言。
3. FG8d——routine release 臂变成 drain 而不是拒绝：`routine-release-refusal` 红（没有 409，producer 停了）。
4. FG8d——结算投影把平台停机映射成 `exited`：`cancel-during-capture` 红在 `cancelled`/`stop_requested` 断言。

## CI 接线与预算

类名让新字母留在 `hosted-harness-mysql` 车道，workflow 无需改动；`check-failsafe-reports.js hosted` 强制其执行；每字母选择子无 pom 接线即可用（同一 `-Dqwen.<letter>.case` 契约）。本地跑用 `hosted-monitor-run-gates` profile 对一个一次性 MariaDB datadir（与 FG6b/FG7b 同样需要 trigger 权限）。

`scripts/tests/hosted-process-ci.test.js` 钉着：fork 字面量 1800 s、healthy 余量 `hostedForkHealthySeconds = 1100`、证据路径与 cgroup 钉桩，以及 per-ceiling 关系（ceiling + 1100 ≤ fork）。FG8e/FG8f 两字母在车道实测 ~310 s。三个新字母带来的墙上时间必须在本 PR 里实测，任何预算移动**同 PR 落地**——pom fork 预算、`hostedForkHealthySeconds` 字面量连同其来源注释、fork 移动时 Verify 步上限，以及 `hosted-process-ci.test.js`，按 AGENTS.md 的 workflow meta-test 规则。每字母 `@Timeout(600)` 保持不变，per-ceiling 关系依旧可证。

## 验证与验收

- `npm run build && npm run typecheck && npm run bundle`；driver ESLint 干净；本文双语版本 prettier 干净。
- 兄弟模块先装（`../qwencode`、`../runtime-broker`）后 `mvn verify` managed-agent-server（单测/H2 + Checkstyle + SpotBugs）。
- 每个新字母对本地 MariaDB（`mysqld`、一次性 datadir，需要 trigger 权限）跑绿；每案故障见证（drop 计数、`fg8b_fire` 点火计数、标志位）正向可见；字母的 happy path（不武装）跑绿；每字母选择子可用。
- 四条变异逐一变红；源码还原；字母复绿。
- `hosted-process-ci.test.js` 带移动后的预算跑绿；`check-failsafe-reports.js hosted` 满足（整车道跑在 CI 侧，结构性检查本地跑）。
- 按 AGENTS.md 做两轮连续干净的无向 + 反向审计。

## 悬而未决

1. `cancel-status-unavailable` 的 hold 点取 broker 侧维护代理臂（上文所选）还是 worker 侧拥堵——前者是夹具不改生产代码就能支持的形状；落地时判定：lane run 38868090681 显示安静的 Harness 不会自发发出 status 读取（六十秒的持械静默），所以正向 hold 见证是 driver 自己经同一臂发出的一条 captive status 读取；被 hold 的面仍是 broker 侧维护代理臂。#14334 的评审把两点说得更清楚：captive 读取必须走 Broker 真有的路由（Harness 的 `GET /executions/<call>:process`），并在恢复后应答 200，否则一个 404 也会被当作恢复成功；Broker 自己的后台维护（`RuntimeBrokerService` 发往 worker 的 `shell-status`/`shell-terminate`）从不经过这个代理。给那条链路注入故障需要在生产代码里为 worker 端点留一个注入点，因此不在本纯测试切片内，作为后续项跟踪。
2. FG8b 的 `manifest-commit`/`page-envelope-commit` 用 24 块 producer（FG8f 重路径）还是更短的 4 块变体以省墙钟——由本地实测决定；账本期望与块数无关。
