# Monitor run 故障门禁（FG8）

[English](2026-10-13-monitor-run-fault-gates.md) | [简体中文](2026-10-13-monitor-run-fault-gates.zh-CN.md)

## 问题与范围

Issue #14054 是 #12380 的下一个 F 阶段切片：为 FG7 合入之后被启用提交的能力补 FG6/FG7 式多进程故障门禁 —— `monitor_run` 与 `child_run` 的 `shell` kind（#13889，H3 启用）。这些记录今天之所以还诚实，只是因为两位评审靠人手抓住了反例（#13896，由 #13929 修复）。#14054 的 triage 裁定只接受 **FG8**；FG9（`session_message` / `session_command`）与 FG10（`workflow` kind）在本轮做法被验证后各自开跟踪 issue。

本切片落地这些门禁，沿用 FG6/FG7 的形态：真实打包二进制、注入故障的代理、真实 MySQL/MariaDB、每道门禁一次具名变异检查。**不改任何生产代码**。

被门禁的这些能力拥有会活过自身 turn 的真实操作系统进程，并跨 turn 持有 Runtime：

- 后台 `shell` child run 由 `admitBackgroundProcess` 准入（`RuntimeBrokerService.java:2084-2119`），写入 `<executionCallId>:process` ledger 行（`:2098-2099`）；exactly-once 依赖该身份的唯一性（重复准入答 409 `runtime_execution_conflict`）。
- monitor run 的诚实性字段是 `observationSequence` / `notifiedThrough`（记录契约见 `ManagedExtensionRecords.java` 的 `requireMonitorRun`）；其停止路径是 broker 的 `monitor-stop` 控制（`RuntimeBrokerService.java:733-747`、`:822-846`），背后是 `HostedMonitorRemoteExecutor.stop`（`packages/cli/src/serve/hosted-monitor-remote-executor.ts:25-70`）—— #13929 用它替换了原来的 `Promise.resolve()`，成为真实的 terminate。
- release 拆分（#13889）：例行 release 只做清扫并答 409 `runtime_session_held`，不停任何东西（`RuntimeBrokerService.java:2490`）；只有 drain 臂发出 shell-terminate / monitor-stop，并对无法证明已停的答 409 `runtime_session_busy`（`:2496-2497`）。
- 结算投影（`hosted-shell-publisher.ts:884-925`）：没有物理证据 → `settleFailed`（`watch_failed` / `process_failed` ——「marker 绝不能铸成无人证明的 stop」）；`stopRequested` → 先 `requestStop` 再 `settleStopRequested`，顺序是契约要求；否则 `settleExited`。被平台停掉的 run 绝不能结算成 `exited`。
- 输出投递：Session 级 `HostedShellPublisher` 在每次追加时推进 output manifest 并 finalize；16 MiB in-flight 暂停水位与 4 MiB 恢复水位（`managed-runtime-tool-executor.ts:255-256`）让管道有界；Artifact 读链在提供读取前会对照已持久化的 page envelopes 重验 manifest（`WorkspaceProfileLifecycleVerifier.java:172-190`）。
- SSE：公开流按 `Last-Event-ID` / `after` 续传（`PublicAgentController.java:202`，`:289` 处非法游标答 400 `invalid_event_cursor`），WebShell 流按 `afterSequence`（`WebShellAgentController.java:129-133`）；过期的重放游标答一帧 `agent.session.resync_required` 后关闭。

## 现状

- 这些门禁保护的启用列表（`packages/core/src/managed-runtime/managed-session-records.ts`）：`MANAGED_SESSION_ENABLED_DOMAINS` 有 18 个域，含 `monitor_run`（`:128`）；`MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 为 `['child_agent', 'shell', 'workflow']`（`:199`）；`MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED` 为 `true`（`:241`）。核实于 `main` = `c3c38cf583`。
- 今天存在的域级故障覆盖只有 channel：三个 hosted 故障门禁套件（`HostedChannelFaultGatesIT`、`HostedChannelProcessCrashIT`、`HostedProcessCrashIT`）对 `monitor`、`workflow`、`session_command`、`session_message` 的命中数为零（#14054 的关键词核查，triage 在 `c3c38cf5` 上复现）。
- FG8 复用的 Hosted lane 机制：in-JVM Spring + 内嵌 broker + JDBC 播种 registry 行（`HostedChannelFaultGatesIT` 的 `start()`）、打包 Harness 子进程（`node dist/cli.js serve --profile hosted-harness`）、每 case 一个内嵌 lose-once 反向代理的 TypeScript driver（`integration-tests/helpers/hosted-channel-fault-driver.ts`）、注入存储故障的一次性 SQL trigger（`FG7B_*` marker，在被捕获的 Spring 日志里断言）、拥有 driver/results 协议的共享 gate-support 类（`HostedChannelGateSupport`）、按字母的 case 选择器（`-Dqwen.fg7X.case`）、落在 `target/fg7-cases/` 的证据。`check-failsafe-reports.js hosted` 强制每个 `Hosted*IT` 进入 `hosted-harness-mysql` CI job；`hosted-process-ci.test.js` 钉住该 lane 的三项预算。

## 范围决定

1. **只做 FG8；FG9/FG10 是各自的跟踪 issue。** triage 裁定：FG8 有一个已观测到的缺陷（#13896）和一条书面义务（#13856 的 G6 行）；FG9/FG10 是覆盖驱动的，在本轮做法被验证之后落地。本设计覆盖 FG8a–FG8f，仅此而已。

2. **三片落地，按在飞交叠面排序。** 三个开着的 PR 正在改 FG8 要钉住的语义；现在对着它们写等于钉一个正在动的契约。各片按此顺序落地，各自一个 PR，沿用 FG6 形态：

   | 片  | 字母                 | 等待                                                                                    | 原因                                                                                                   |
   | --- | -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
   | 1   | **FG8e、FG8f**       | 无                                                                                      | SSE 流与 output manifest/capture 投递链不被三个在飞 PR 触碰。                                          |
   | 2   | **FG8a**             | **#14021**（在活 turn 内结算从未启动的后台派发）                                        | background-dispatch 应答丢失臂钉住的正是 #14021 在写的结算语义。#14021 很小（+173/-65），等待成本低。  |
   | 3   | **FG8b、FG8c、FG8d** | **#13986**（held-Runtime drain 义务重启可证）与 **#13918**（租户级 InnoDB 守卫 convoy） | #13986 在改 FG8c/FG8d 要钉的冷加载 held-set 回填；#13918 在重写 FG8b 要断言的存储故障错误码 taxonomy。 |

   下面的门禁账本完整写明六封信，让这一轮可以作为一份设计被评审；每片的 PR 实现自己的字母并在此标记为已交付。各字母的注入点与断言点在其片落地时会对着已合入的前置重新核实。

3. **一个 IT 类；不杀 Spring。** FG8c 杀的是打包 Harness、managed worker 与后台进程自身 —— 从不杀 Spring 控制面 —— 所以 FG7c 的子 JVM fixture（`HostedChannelCrashFixtureMain`）不必要。六封信全部住在 `HostedMonitorRunFaultGatesIT`，in-JVM Spring，按字母选择器 `-Dqwen.fg8a.case` … `-Dqwen.fg8f.case`，共享 `HostedMonitorRunGateSupport`。POSIX 信号把崩溃用例限制在 Linux/macOS，与 FG6c/FG7c 相同。

4. **#13339 隔离。** `HostedWorkspaceToolTurnIT` 在 MySQL 8.4 lane 上已经会 flake（#13339，开着，根因收窄到冷加载 file-history `pendingTurn` 臂，未修；#13361 落了分支标签 409 臂与幂等重试作为诊断半步）。该 lane **没有** quarantine 或重试机制 —— 一次 flake 打红一个 160 分钟的 job。因此 FG8：(a) 只新增 `Hosted*IT` 类，绝不动 `HostedWorkspaceToolTurnIT`；(b) 冷加载断言读 #13361 的分支标签 409 臂名，而不是裸 409，复发时可立即定位；(c) 避开 #13339 会 flake 的 `SHELL_REFUSAL → /title → /detach → javaLoad` 时序；(d) 保持 FG7 的纪律：每个 case 先断言自己的故障确实点火（drop 计数、trigger marker、kill marker），门禁绝不可能假绿。

5. **issue 的范围砍削记录在案，不在此做。** 把一个 `team_state` / `team_task` 存储故障用例折进 `HostedTeamLeadMySqlIT` / `HostedTeamMemberCommandMySqlIT`，以及 `mcp_configuration` / `mcp_operation` / `hook_registration` / `hook_execution` / `schedule` / `automation_run` 的覆盖审计（其产出必须明确地了结或重新命名 #13856 G6 记下的 #13598 automation 义务），是挂在 #14054 上的伴随任务，不属于任何 FG8 片。四个 A/W 阶段记录域保持在外；FG9 与 channel 相邻的用例不会假设 `email` 之外还有第二个 provider。

## 门禁账本

Ground truth 是对执行台账（`:process` 行）、monitor/child-run 记录表、output manifest 与 page-envelope 表、Session Store journal，以及被捕获的 Spring 与 Harness 日志的 JDBC 查询。每个 case 先断言故障确实点火：代理 drop 计数与 `FG8B_<case>` SQLException marker（FG8a/b）、kill marker（FG8c）、cancel 应答的标记位（FG8d）、被中止流的未读证明（FG8e）、publisher 的水位/回执证据（FG8f）。`one process` 始终表示该派发在 OS 上恰好持有一个物理进程 —— `:process` 行的唯一性是 SQL 证明，worker/registry 侧携带进程身份。

### FG8a —— 应答丢失（片 2，待 #14021）

driver 在 broker 与 store 监听器前内嵌反向代理；lose-once 故障转发请求、消费已提交的上游应答、然后销毁该应答。Harness 凭其持久化状态按原执行身份重驱。

| 用例                        | 注入                                               | 期望                                                                                                                                     |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-reply`            | 在 `:process` 行提交后丢弃后台 shell 派发的应答    | 重试经原 `executionCallId` 解决：每次派发最多一个物理进程、一行 `:process`；重复准入答 409 `runtime_execution_conflict` 且不启动任何东西 |
| `monitor-stop-reply`        | 在 stop 提交后丢弃 `monitor-stop` 应答             | 重驱按原 operation 身份解决；worker 恰好收到一次物理 terminate；记录凭真实退出证据结算                                                   |
| `capture-commit-reply`      | 在 envelope 持久化后丢弃一次 capture page 提交应答 | publisher 的重驱幂等：一个 page envelope，manifest 推进一次，无重复字节                                                                  |
| `observation-advance-reply` | 在一次观测推进提交后丢弃其应答                     | `observationSequence` / `notifiedThrough` 落在后面而不是往前跳；重驱把它们落在已提交的值上，绝不越过已观测的尾部                         |

### FG8b —— 存储故障（片 3，待 #13918）

测试专用 SQL trigger，按租户与表限定范围，像 FG6b/FG7b 一样按 case 安装与拆除，`SIGNAL SQLSTATE` 文本 `FG8B_<case>` 在被捕获的 Spring 输出里断言。这些用例断言的错误码是 #13918 之后的 taxonomy。

| 用例                    | 注入                                                | 期望                                                                                              |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `invocation-commit`     | 一次性 trigger 在进程启动前让 invocation 行提交失败 | 零 OS 副作用：无进程、无 `:process` 行、无 capture 注册                                           |
| `process-ledger-commit` | 一次性 trigger 让 `:process` ledger 提交失败        | 该 run 被阻塞而不重执行；不会尝试第二次准入                                                       |
| `manifest-commit`       | 一次性 trigger 让 output manifest 提交失败          | 该 run 阻塞而不重执行；capture 的已持久前缀保持可读且逐字节相同                                   |
| `page-envelope-commit`  | 在 manifest 命名某个 page envelope 后让它的提交失败 | Artifact 读链绝不解析到一个其 page envelopes 未被持久化的 manifest：读取被拒绝，manifest 不被提供 |

### FG8c —— 进程崩溃（片 3，待 #13986）

仅 POSIX。IT 拥有 Harness 子进程，并按 pid 向 worker 与后台进程发信号。冷加载断言读 #13361 的分支标签 409 臂（决定 4b）。

| 用例                    | 注入                                         | 期望                                                                                                                             |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-dispatch` | 在派发提交后、capture 开始前 SIGKILL Harness | 重启：不重复派发，一行 `:process`；未结算的 run 保持阻塞且无终态事件；冷加载拒绝它（带臂标签的 `hosted_turn_recovery_required`） |
| `harness-kill-capture`  | 在 capture 开始后 SIGKILL Harness            | 同上，外加：已持久的输出前缀保持逐字节相同且可读；绝不为恢复而重执行该 run                                                       |
| `worker-kill`           | 在 run 中途 SIGKILL managed worker           | 结果未知的 run 保持阻塞；无终态事件；没有证据不释放 hold                                                                         |
| `worker-stop`           | SIGSTOP worker，放过不确定窗口，SIGCONT      | 该 run 既不结算也不重复；被恢复的 worker 的证据把它诚实地结算                                                                    |
| `process-kill`          | SIGKILL 后台进程自身                         | 记录凭真实退出证据结算（或诚实地保持未知）；绝不伪造 `exited`                                                                    |
| `generation-remint`     | 在一个未结算 run 背后重启 broker generation  | 死掉的 generation 答 `runtime_broker_runtime_lost`；绝不静默重铸；该 run 保持阻塞                                                |

### FG8d —— 取消与 drain（片 3，待 #13986）

| 用例                        | 注入                                     | 期望                                                                                                                                 |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `cancel-before-start`       | 在准入后、进程启动前取消                 | 该 run 结算 `cancelled`；零 OS 副作用                                                                                                |
| `cancel-during-capture`     | 在 capture 中途取消                      | 记录 `stopRequested: true`；只有物理终止能结算该 run，且为 `cancelled` / `stop_requested` —— 绝不为 `exited`                         |
| `cancel-status-unavailable` | 在 worker 状态不可读时取消               | 取消被记录；不伪造终态事件；不确定性凭证据解决，而不是凭取消的乐观                                                                   |
| `cancel-reply-lost`         | 在取消提交后丢弃其应答                   | 重驱的取消原样回答已提交的状态；一条终态记录                                                                                         |
| `routine-release-refusal`   | 对活跃后台 run 做例行（非 drain）release | 409 `runtime_session_held`；不停任何东西；该 run 继续推进                                                                            |
| `drain-release`             | 对同一个 run 做 drain release            | drain 臂发出停止；该 run 结算 `cancelled` / `stop_requested` 且带 `stopRequested: true`；无法证明已停的答 409 `runtime_session_busy` |

### FG8e —— SSE 断流（片 1，本 PR）

公开流与 WebShell 流由 in-JVM Spring 提供；客户端的中止与续传就是注入，所以本信不需要代理。一个后台 run 与一次 monitor 观测提供在飞的事件流量。每个用例中止流后，先在断连期间推进能力 —— 先释放 gate；run 字母的积压是一条 post-gap prompt，因为没有调度器时退出通知是静默的 —— 并且只在 JDBC 证明有越过游标的已提交事件之后才重连，所以面对丢历史的端点，重放绝不会空转通过。

| 用例                      | 注入                                                 | 期望                                                                                 |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `public-run-resume`       | 在 run 中途中止公开流；以 `Last-Event-ID` 续传       | 重放序列从游标起不重复、不缺失；该 run 继续推进；终态事件恰好出现一次                |
| `webshell-run-resume`     | 在 run 中途中止 WebShell 流；以 `afterSequence` 续传 | 对 WebShell envelope 做同样的连续性断言                                              |
| `public-monitor-resume`   | 在一次 monitor 观测推进期间中止公开流；续传          | 观测事件按序重放，不丢不重；`observationSequence` / `notifiedThrough` 与重放尾部一致 |
| `webshell-monitor-resume` | 在 WebShell 流上做同样注入                           | 同样的断言                                                                           |
| `cursor-expired-resync`   | 以早于重放窗口的游标续传                             | 单帧 `agent.session.resync_required`，然后关闭；无伪造重放                           |

`cursor-expired-resync` 暂缓、不进片 1 的字母：重放地板只有会话快照落地才会前移，所以一个诚实的过期游标需要先把重放地板机制驱动到那个点；该用例随片 2 落地，它的变异（下面的第 2 条）一并移动。本次交付的 FG8e 字母覆盖四个中止/续传用例。

一条付出了一个 flake 的 fixture 教训：60 s 的事件轮询/心跳间隔（为强制 live hub 承载投递而设）可把 WebShell 续传压住一个完整轮询周期，而 monitor watch 的空闲窗口必须长过它 —— 空闲超时设 30 s 时，watch 在断流中途把顶在门边的生产者空闲杀掉，用例就吊死在一扇永不再开的门上。watch 以 `idle_timeout_ms` = 180 s 运行。同一轮询也限制续传 observer 追平已提交台账的速度 —— 在重放读取与 relay 停止之间提交的行要晚一个轮询周期才到，所以追平等待设为 120 s，长过两个周期。第二条纪律：monitor producer 绝不自然退出 —— 打过最后一个 mark 后空转，配额停表的 kill 是唯一出路。自然退出会关闭作用域，其 cancel 写入与配额结算赛跑，胜出时把记录翻折成 `stop_requested` 而不是 `max_events`（lane 上实测两次）。

### FG8f —— 输出投递（片 1，本 PR）

publisher 住在 Harness 进程内，所以「杀掉 publisher」是一次只断言输出侧事实的 Harness kill —— 跨 Harness 重启的 Runtime hold 恢复是 #13986 正在动的地面，属于片 3 的 FG8c（那里的 `harness-kill-capture` 断言恢复侧；这里只钉输出侧）。

这些用例把门的字节路径：worker 以 64 KiB rpc 块把子进程管道接力给 Harness；Harness 侧的 `HostedShellPublisher` 把它们装进 1 MiB 段，并通过会话的 `managedSessionStore` 客户端把段、页与 manifest 修订作为会话资源发布，它们始终以 `MYSQL_INLINE` 落在 `ma_resource`（段内容按其内容寻址 resourceId 幂等，`sha256([captureId, streamId, ordinal])`）。因此 driver 给这个 baseUrl 罩一个 store 侧代理 —— broker 代理继续留给 Runtime 调用 —— 按请求形态武装：整段提交在转发前扣留（worker 的 16 MiB 暂停水位必须随之顶到生产者的管道，由生产者自己的进度文件证明），以及一笔 journal 提交应答在提交落库后销毁（客户端有界的不确定错误重试必须按原事务身份重驱）。已提交前缀的读取在门侧以 JDBC 重验 —— manifest 修订、页封套与段摘要按序对着生产者的确定性块模式走查 —— 因为后台通道不投影进 artifact 表（已对 FG8e 遗留数据实证）；会话资源行才是生产读路径所服务的地面真相。

| 用例                           | 注入                                              | 期望                                                                                                                            |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `publisher-kill-mid-capture`   | 在后台 run 的 capture 正在追加时 SIGKILL Harness  | 已提交的输出前缀通过 Artifact 链保持逐字节相同且可读；manifest 绝不命名未持久化的页；绝不为恢复而重执行输出                     |
| `in-flight-cap`                | 后台 run 在代理延迟 store 提交期间产出超过 16 MiB | 16 MiB 暂停水位与 4 MiB 恢复水位在丢失下成立：管道减速而不是无界缓冲；resume 在排空前重新武装；最终 manifest 与每个已持久页一致 |
| `receipt-drop-after-watermark` | 在恢复水位提交后丢弃 manifest 提交应答            | 重驱按原 capture 身份解决：一个 manifest，无重复页，无重执行                                                                    |

## Fixture 设计

**Java。** `HostedMonitorRunFaultGatesIT` 像 `HostedChannelFaultGatesIT` 一样每封信起一个 in-JVM `ManagedAgentServerApplication`（workspace 挂载、registry/access 行 JDBC 播种、MySQL 属性强制 —— 缺失即失败而非跳过），内嵌 broker 在方法级钉死端口。打包 Harness 每用例以 `node dist/cli.js serve --profile hosted-harness` 对着该 broker 启动，每 case 隔离 `HOME` / `QWEN_HOME`。证据落在 `target/fg8-cases/<letter>/<case>/`，每方法重建。存储故障 trigger 复制 FG7b 的 DDL 形态，`SIGNAL SQLSTATE` 文本 `FG8B_<case>`，按 case 租户限定，在被捕获的 Spring 输出里断言，teardown 拆除（FG8b；片 1 不向 MySQL 注入任何东西）。`HostedMonitorRunProbe` 是 in-JVM 的门侧半边：在一个普通 `HttpServer` 上提供 `/fg8/<sessionId>/<phase>` —— `relay-start` / `relay-stop` 驱动测试自有的事件接力（生产投影器与追加路径；仅 FG8e），`state` 回答执行台账行、monitor/child-run 记录体与已提交的 tool-result 资源元数据，`ledger` 回答会话的 SESSION 流 `ma_public_event` 序列（child task 的 `state_changed` 审计行共享序列号空间但端点从不服务它们，所以门禁的 ground truth 像 `findEvents` 一样过滤）。IT 自己持有全部 JDBC ground-truth 断言：按 `executionCallId` 的执行台账行（含 `:process` 后缀）、记录诚实性，以及 FG8f 的输出链（manifest 修订、页封套、对着生产者确定性模式的段摘要）。

**Driver。** `integration-tests/helpers/hosted-monitor-run-fault-driver.ts`，像每个 FG6/FG7 driver 一样按字母以 `node --import tsx … <driver.json>` 启动。它拥有：broker 前的 lose-once 反向代理（操作日志即派发证据）、罩在会话 `managedSessionStore` baseUrl 前的 store 侧代理（FG8f 的扣留/丢弃武装）、FG8e 的原始 SSE 客户端（公开流带 `Last-Event-ID`、WebShell 流带 `afterSequence`、中止并续传、对重放序列做重复/缺失检测 —— 注意公开面的帧字段是 snake_case 而 WebShell 面是 camelCase），以及脚本化生产者 —— 真实的 `node -e` 后台进程，其块模式按段序号确定（所以逐字节相同在门侧就是摘要比较），其 `progress.txt` 让暂停水位顶到生产者这件事可观测。IT 等待或断言的 marker —— `FG8_CASE_OK <case>`、`FG8_STREAM_GAPS_OK`（FG8e）、`FG8_OUTPUT_DELIVERY_OK`（FG8f）、`FG8_DROPPED <what>` —— 为 IT 定序；`FG8_STEP` / `FG8_PROXY` / `FG8_STORE_PROXY` 追踪流程，`FG8_DIAG` 在失败时转储用例状态。per-case 目录让 Harness 重启是真的冷加载。

**模型。** 一个罐头 OpenAI 兼容模型像 FG7 一样给每个 turn 回一条固定的短应答 —— 模型从不是被门禁的对象。

**CI。** 类名把它放进 `hosted-harness-mysql` lane（`Hosted*IT` include；`check-failsafe-reports.js hosted` 强制它跑过）。这些门需要一个委派的 cgroup v2 根，所以 lane 新增一个 setup 步骤：创建并 chown `/sys/fs/cgroup/fg8`、把 `QWEN_MANAGED_HOOK_CGROUP_ROOT` 导出给 Verify 步骤、并用一个真实子进程加入 unit 来冒烟验证准入 —— 光有 `cgroup.kill` 存在证明不了迁移可行。委派遏制（delegation containment）意味着子树外的进程无法迁入子树（写 unit 的 `cgroup.procs` 要求公共祖先的 `cgroup.procs` 可写，而 runner 上该祖先归 root 所有），所以 Verify 步骤的 shell 先通过一次特权 `cgroup.procs` 写入把自己移进子树；测试随后拉起的每个进程都生在子树内。lane 的三项预算随新类全绿而移动，沿用 FG7 先例（900 s → 1200 s、25 → 35 min、148 → 160 min）。合并后的 lane 数值为 fork 1800 s、Verify 45 min、job 220 min：L4 shell-lifecycle 恢复类（#14125）在 main 上独立落地了同样的 1200 → 1800 s fork 提升，本类的 ~310 s 搭乘同一 fork；Verify 35 → 45 min 与 job 210 → 220 min 是覆盖两个类的合并后总量，同一变更内同步 `hosted-process-ci.test.js`（fork 健康余量重新测量 650 s → 1100 s）。新增 `hosted-monitor-run-gates` 本地聚焦 profile；cgroup 要求使这些门只在 Linux 上成立，所以本地循环在特权容器里跑（内核 ≥ 5.14 提供 `cgroup.kill`）对着宿主 MySQL。本地数据库：系统 `mysqld` 配一次性 datadir，需要 trigger 权限，与 FG6b/FG7b 相同。

## 变异检查

每个变异单独应用、证明恰好把它自己的门禁打红、然后回滚，沿用 FG6/FG7 记录在案的手动程序。下面的片 1 变异随本设计一起提交；片 2 与片 3 在落地时对着已合入的 #14021 / #13986 / #13918 语义细化自己的变异。

1. FG8e —— 公开流重放的游标 tiebreak 被削弱为包含游标行：`public-run-resume` 红（续传边界处重复）。
2. 随用例一并暂缓：FG8e —— 过期游标分支从序列 0 起播而不是回答 `resync_required`：`cursor-expired-resync` 红。随片 2 落地。
3. FG8e —— WebShell 重放窗口在 `afterSequence` 边界差一：`webshell-run-resume` 红（边界处缺失或重复）。
4. FG8f —— 恢复水位降为 0（resume 只在缓冲完全排空后才重新武装）：`in-flight-cap` 红 —— 生产者停摆后的第一个块要等整批滞留积压全部提交才会落地，恢复时点的已提交数因此到达停摆点而不是停在它后面。
5. FG8f —— journal 提交的重试铸了新的事务身份而非重驱原事务：`receipt-drop-after-watermark` 红（重驱的结算提交与已落库的原提交冲突，记录永不结算）。
6. FG8f —— 内容寻址的段资源身份偏离既定推导（`[captureId, streamId, ordinal]` 多出第四项）：`publisher-kill-mid-capture` 红在前缀走查上 —— 门侧按正确推导在序号 0 处找不到已提交行，而未清算的行就在 store 里。

计划在片落地时细化：FG8a —— 重新准入用新身份而非原 `executionCallId`（`dispatch-reply` 红）；FG8b —— invocation 提交在没有 `:process` 行的情况下继续（`invocation-commit` 红在零 OS 副作用断言上）；FG8c —— 冷加载把未结算的后台 run 当成干净（`harness-kill-dispatch` 红）；FG8d —— 例行 release 臂变成 drain 而非拒绝（`routine-release-refusal` 红），以及结算投影把平台停止映射成 `exited`（`cancel-during-capture` 红）。

## 验证与验收

- `npm run build && npm run typecheck`；driver 的 ESLint 干净；模块 surefire 套件绿。
- 新类在本地 MySQL/MariaDB 上全绿（CI lane 是 MySQL 8.4）：每个用例点燃其声明的故障 —— 每个 drop 计数、`FG8B_*` marker 与 kill marker 都被观测到 —— 按字母选择器可用，且无任何注入时顺利路径绿。
- 上述每个片 1 变异各自变红；源码还原；门禁复绿。片 2/3 对自己的变异重复该程序。
- `hosted-process-ci.test.js` 在预算变动后绿，且整 lane 跑完后 `check-failsafe-reports.js hosted` 满足。
- 按 AGENTS.md 做两轮连续干净的开放式与反向审计。
- 本设计双语落地；交付台账按片记录 FG8 行；在 #14054 上留一条评论记录分片与每片的交付，并点名决定 5 的两个伴随项（`team_state` / `team_task` 存储折叠，以及了结或重新命名 #13598 的 mcp/hook/schedule/automation 审计），让跟踪 issue 反映已确定的形态。

## 待定问题

1. 片 3 的 FG8c 是否还应钉住跨 _broker_ 重启（不只是 Harness 重启）的 #13986 held-Runtime 回填 —— 只有对着合入后的 #13986 表面才能定。
2. FG8e 的连续性断言是否应扩展到后续切片新增的 WebShell 镜像路由 —— 留给那个切片，如同 FG7 为自己的重定范围所做的记录。
