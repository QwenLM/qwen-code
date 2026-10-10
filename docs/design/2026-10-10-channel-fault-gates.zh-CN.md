# Channel 故障门禁（FG7）

[English](2026-10-10-channel-fault-gates.md) | [简体中文](2026-10-10-channel-fault-gates.zh-CN.md)

## 问题与范围

Issue #13802 是 #12380 中 F 阶段的下一片：为 **channel 域**补 FG6 式样的多进程故障门禁 —— 这两个域已由 #13572 启用提交（`channel_route`、`channel_delivery` 在 `MANAGED_SESSION_ENABLED_DOMAINS` 中，`managed-session-records.ts:137-138`，已在 HEAD `c3968ace2f`（Flyway V57 —— channel 的表为 V47 与 V55）上核实）。目前没有任何东西证明：当应答丢失、进程在发送中途死亡、或提供方回答含糊时，这些记录仍然诚实 —— 而 channel 的副作用会离开进程：重发是用户可见的重复，回执未到的静默 `accepted` 是记录之后无法撤回的谎言。

本片补上这些门禁，沿用 FG6 的形状：真实打包二进制、注入故障的代理、真实 MySQL/MariaDB、每道门禁一个具名变异检查。本片**不碰生产代码**。范围严格保持 channel：#13598 打开的 `schedule`/`automation_run` 缺口是另一个跟踪者（#13802 的 triage 评论），H5d 的多段计划也不在范围（见决定 2）。

## 现状

- 完整的多进程 channel 链路今天只存在于生产接线中：adapter（`ManagedEmailAdapter`）→ 内部 adapter 面（`ManagedChannelAdapterController`，今天零 HTTP 覆盖）→ `ManagedChannelService` → `QwenHostedHarnessConnector.runChannelOperation` → 打包 Harness（`POST /session/:id/channels/operations` → `HostedChannelSession`）→ journal → Session Store。既有测试在两侧都停在上一跳：Java 侧用进程内的 `RecordingHarness`（`ManagedChannelServiceTest`，H2）；TS 侧用本地 JSONL store（`hosted-channel-session.test.ts`）或假控制面（`managed-email-adapter.test.ts`）。
- FG7 复用的 Hosted 车道机关：`HostedWorkspaceToolTurnIT` 用一个类承载 FG6a/b/d/e/f —— FG6a/b/d/f 按字母给出用例选择子（`-Dqwen.fg6X.case`），FG6e 是单用例、无选择子；`HostedProcessCrashIT` + `HostedProcessCrashFixtureMain` 把 Spring 跑在可杀死的子 JVM 里做 FG6c；`integration-tests/helpers/hosted-harness-process.ts` 启动打包的 `dist/cli.js serve`；`integration-tests/fake-openai-server.ts` 提供确定性模型；每个故障类各有一个参数化 TS 驱动，内嵌反向代理；SQL 触发器注入存储故障（`FG6B_*` 标记在 Spring 日志里断言）。`check-failsafe-reports.js hosted` 强制每个 `Hosted*IT` 在 `hosted-harness-mysql` CI 作业中运行且只能在它中运行。
- 被门禁覆盖的相关生产防护：V47 route 行的重放应答与漏斗的 `inputId` 重放（`ManagedChannelService:206-232`，`hosted-channel-session.ts` 的 submit 重放）；claim 幂等与 claim 行唯一性；按 `providerMessageId` 的回执幂等（漏斗 `receipt`）；先记录后台账的顺序与协调器收敛（`reconcileClaim` 的结算前收敛）；adapter 发送前持久化 outbound、上报前持久化结果（`managed-email-adapter.ts` 的 `send`、`reportOrphanedOutbound`）；含糊 SMTP → `unknown` 的分类（5xx → `rejected`，其余 `unknown`）；10 分钟的 claim 租约清扫；漏斗的 `cancel`（planned → `cancelled`；sending → 仅 `cancelRequested` 标记）；稠密 ordinal 拒绝（`ManagedChannelRecords.java:124`、`HostedChannelSession.receipt`）；`unknown → delivered` 的诚实恢复步（`ManagedExtensionRecords.TRANSITIONS`）。

## 范围决定

1. **FG7e 改范围：没有可门禁的 SSE 面。** channel 不发布任何事件（`ManagedChannelService` 不向任何流追加）；投递只通过游标分页的 REST 台账只读暴露（`GET /v1/agent-channels/{id}/deliveries`，Base64 `createdAt:id` 游标）。「断开事件流、用 `Last-Event-ID` 续传、断言不重复不缺失」今天写不出来（triage 评论的选项 B）。因此 FG7e 改为门禁**读台账连续性**：跨客户端中断与跨投递状态推进的游标稳定、不重复、不缺失的分页 —— 这正是 SSE 续传本应作出的断言，只是对准真实存在的面。它刻意不挂 SSE 的名字。

2. **FG7f 门禁 `unknown` 族；`partial` 在 v1 没有生产者。** email 计划是单分段（`planChannelSegments` 恒返回一段，`managed-channel-operations.ts:556`），而 `partial` 要求 `settled > 0 && settled < segments.length` —— 单分段下不可达。`partial` 的后继规则见证存在于契约层（`managed-channel-record.ts:458`）；多进程 `partial` 门禁需要 H5d 的多段计划，属于那一片。本门禁在全链路上证明的是 v1 可达的那段诚实投递线：提供方回答含糊 → `unknown`；回执始终不到 → 租约结算 `unknown`（绝不自动重发）；计划外 ordinal → 被拒且投递不前进；恢复重读原身份（绝不重发）；显式 resend 链只带未发送分段并携带重复警告。

3. **FG7d 经生产连接器中继驱动取消。** adapter 面没有 cancel 动词（正确地 —— 没有 Java 调用者）；漏斗的 `cancel` 可经 Harness operations 路由到达，该路由按 Harness 签发的 `X-Qwen-Client-Id` 鉴权。IT 直接调用 `spring.getBean(HarnessConnector.class).runChannelOperation(tenant, sessionId, {kind:"cancel_delivery", ...})` —— 与 `ManagedChannelService` 使用的同一个通用中继 —— 因此门禁以正确鉴权驱动精确的生产路径，且不新增任何生产面（也无需探针 bean）。

4. **两个 IT 类，与 FG6 相同。** 应答/存储/取消/读取/unknown 门禁对着进程内 Spring 运行（`HostedChannelFaultGatesIT`，`-Dqwen.fg7X.case` 选择子）；崩溃门禁需要可杀死的控制面，因此 Spring 跑在子 JVM 里（`HostedChannelProcessCrashIT` + `HostedChannelCrashFixtureMain`）。两个命名让它们自动进入 `hosted-harness-mysql` 车道；`mysql-integration` 车道排除 `Hosted*IT`。Harness 杀死不在本片：Session 级 Harness 重启已由 `test:e2e:managed-harness-restart-*` 车道门禁，且 channel 特有的重开结算（`reconcileReplies`）在漏斗层有单元门禁。

## 门禁台账

`one send` 恒指假 SMTP 对该投递的分段恰好观察到一次物理发送；Java 侧的基准事实是 `qwen_managed_channel_{instance,binding,claim,route,delivery}`、Session Store journal 与被捕获的 Spring 日志上的 JDBC；每个用例都断言其故障确实点火（代理丢弃计数、`FG7B_<case>` SQLException 标记、杀死标记）。

### FG7a —— adapter ⇄ 控制面 应答丢失

驱动在内部监听器前内嵌一个反向代理；一次性丢失故障先转发请求、消耗上游已提交的应答，然后毁掉回复。adapter 从其持久化状态重驱动。claim 的点火按**内容触发**：只在**携带**投递的应答上点火 —— plan 落地之前的 outbox 扫描恒答 `deliveries: []`，绝不算数。

由门禁发现的一条语义注记：丢失 `deliveries:claim` 的携带应答会让投递搁浅在 `sending` —— 发现面只服务 `planned` 与 `partial`，因此不可能有第二次派发（这正是 issue 要求的至多一次），诚实的终点是租约协调器结算的 `unknown`，绝不静默前进。若后续某片补出按 claim 行的 claim 重放，`claim-reply` 的期望将从 `unknown` 升格为 `delivered`；门禁今天刻意锁定现有面。

| 用例            | 注入                                                       | 期望                                                                                                                                      |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `inbound-reply` | 在提交后丢弃一次 POST `/inbound` 应答                      | adapter 的 pending 事件按身份重驱动：一行 V47（`admitted`，一个 `inputId`）、一条 journal input、一次模型调用、一份投递计划、终态一次发送 |
| `claim-reply`   | 丢弃第一个携带投递的 `deliveries:claim` 应答（在其提交后） | 零发送（分段从未被获知）；重试绝不铸出第二行 claim；租约把搁浅的发送结算为 `unknown`；冷启动 adapter 绝不自动重发                         |
| `receipt-reply` | 在记录+台账提交后丢弃一次 `…:receipt` 应答                 | 已持久化的 outbound 回执按 `providerMessageId` 幂等重驱动：一次发送、台账 `delivered` 且持原回执                                          |

### FG7b —— 存储故障

纯测试 SQL 触发器，按租户与表限定作用域，每个类装拆一次，与 FG6b 相同。这里的应答丢失指 adapter 在一个它从没能看到应答的已提交事实之后重启。

| 用例                   | 注入                                                                       | 期望                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `route-admit`          | 一次性触发器在 Harness 已提交输入后，拒掉 V47 route 行的 `admitted` UPDATE | 重驱动按 `inputId` 应答已提交的准入（不产生第二条输入、第二次模型调用）；触发器耗尽后重试成功                               |
| `delivery-commit`      | 一次性触发器在 `receipt` 期间拒掉投递台账的 UPDATE                         | 记录已是 `delivered`；投递不重发；恢复（回执重驱动或协调器收敛步）让台账落到 `delivered` 并持原提供方回执 —— 绝不出现重复行 |
| `commit-reply-restart` | `receipt` 应答被毁，随后 adapter 进程重启                                  | 冷启动的 `reportOrphanedOutbound` 重放持久化的 accepted 回执；恰好一次发送、一行台账、`delivered`                           |

### FG7c —— 进程崩溃（`HostedChannelProcessCrashIT`，仅 POSIX）

Spring 跑在由 IT 杀死的子 JVM 里；adapter 驱动是可杀/可停进程。租约机关是确定性的而不是墙钟：生产清扫保持惰性（`claim-lease=30m`、`scan-delay=30s`），claim 行由 SQL 回拨时间，一次 reconcile 显式驱动（进程内走 bean；子 JVM 走 `/control/expire` + `/control/reconcile` 端点）。

| 用例                   | 注入                                                                                | 期望                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spring-kill-dispatch` | 接力携带的 claim 应答并毁掉，随即 SIGKILL Spring；在 adapter 的重试窗口背后弹性重启 | 零发送；一行 claim；搁浅由租约结算 `unknown`；冷启动绝不自动重发                                                                                                                                                 |
| `spring-kill-receipt`  | 接力 receipt 应答后 SIGKILL Spring                                                  | 重启；回执重驱动幂等结算：一次发送、一次 `delivered`                                                                                                                                                             |
| `adapter-kill`         | 假 SMTP 接受之后、回执持久化之前 SIGKILL adapter                                    | 租约清扫结算 `unknown`（提供方可能持信）；冷启动 adapter 把孤儿 outbound 结算为 `unknown`；没有任何自动重发；显式 `:resend` 打开 `<id>:r1`，只带未发送分段，警告 `possibleDuplicate`，并用自己的 Message-ID 送达 |
| `adapter-stop`         | 接受后 SIGSTOP adapter；等租约把投递结算为 `unknown`；SIGCONT                       | 重驱动的持久化回执落地合法的 `unknown → delivered` 步并持原回执；全程一次发送                                                                                                                                    |

### FG7d —— 取消（经生产中继驱动 `cancel_delivery`）

| 用例               | 注入                                                      | 期望                                                                                                           |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cancel-planned`   | 在 journal 已有 `planned`、尚未拉取时取消                 | 记录结算为 `cancelled`；outbox 永不返回它；零发送；不存在 claim 或投递台账行                                   |
| `cancel-sending`   | 领取后假 SMTP 泊停，取消，再放行发送                      | `sending` 期间记录 `cancelRequested`；只有物理结算产生终态：发送完成一次，回执提交 `delivered`，记录携带该标记 |
| `cancel-replay`    | 取消一个 `planned` 投递，然后当作应答丢失重驱动同一个取消 | 第二次取消原样应答已提交的 `cancelled`；一条终态记录；零发送                                                   |
| `cancel-unsettled` | sending 期间取消，随后 adapter 在回执前死亡；租约到期     | 终态是物理的 `unknown`，可见地携带 `cancelRequested=true`；没有捏造的 `cancelled`；一次发送                    |

### FG7e —— 读台账连续性（改范围后，决定 1）

| 用例                      | 注入                                                                                  | 期望                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `delivery-page-resume`    | 建两份投递（两轮），以 `limit=1` 读取，一页正文读到一半中止，状态持续推进中按游标续读 | 并集不重复、不缺失，稳定新在前；从头重读返回同一身份集合，状态诚实推进   |
| `delivery-state-progress` | 一份投递跨越 `planned → sending → delivered` 交错读取                                 | 每页状态都是台账真实持过的状态；任何读取绝不在回执提交前报告 `delivered` |

### FG7f —— 部分与未知投递（决定 2）

| 用例                    | 注入                                                               | 期望                                                                                             |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `provider-ambiguous`    | 假 SMTP 接受字节，然后以非 5xx 的方式失败应答（超时）              | adapter 分类 `unknown` 并上报；一次发送，不重试发送；下一份投递不受影响                          |
| `receipt-never-arrived` | 假 SMTP 接受；adapter 在上报前冷死（驱动进程被杀，不再重启其回执） | 租约清扫结算 `unknown`；之后的 adapter（全新冷启动）不自动重发；显式 resend 只带未发送分段并送达 |
| `out-of-plan-ordinal`   | 在 adapter 泊停于发送中时，驱动对单分段投递提交 ordinal 1 的回执   | 确定性拒绝（409）；投递既不前进也不重发；随后正确的 ordinal 0 回执结算 `delivered` —— 一次发送   |

## 夹具设计

**Java。** `HostedChannelFaultGatesIT` 按字母各起一个进程内 `ManagedAgentServerApplication`（workspace 挂载、registry/access 行由 JDBC 播种、MySQL 属性强制 —— 缺席即失败），外加 `qwen.managed-agent.channels.enabled=true` 与一个探测空闲端口上的 `qwen.managed-agent.internal-server.port`（`BrokerSecurity`/`Issue13180InternalPortTest` 模式 —— 全部测试中首次启动 adapter 面），session-store 的 base-url 固定指向该内部端口（`BrokerSecurity` 强制）。`session-store.workspace-id`、`harness.workspace-files-enabled`，以及 `durable-local-process=false`/`trusted-local-reboot-recovery=false` 这一对，让 workspace 链在 macOS 上保持诚实。取消直接经 `spring.getBean(HarnessConnector.class).runChannelOperation(...)` 携带 `kind: cancel_delivery` 驱动 —— 生产中继，无探针 bean。触发器沿用 FG6b 的 DDL 形状，`SIGNAL SQLSTATE` 文本为 `FG7B_<case>`，限定到用例租户，并在被捕获的 Spring 输出中断言。`HostedChannelProcessCrashIT` + `HostedChannelCrashFixtureMain` 照 `HostedProcessCrashIT` 的镜子：子 JVM、`FG7C_*` 环境变量、携带 `internalUrl`/`controlUrl` 的原子 `ready.json`、下一代启动前先杀掉上一代，以及租约用的 `/control/expire` + `/control/reconcile` 端点。

**驱动。** `integration-tests/helpers/hosted-channel-fault-driver.ts`，与所有 FG6 驱动一样按步启动为 `node --import tsx … <driver.json>`。它持有：内嵌故障代理（按具名动词一次性丢失，头部接力走 `hosted-relay-headers.ts`，点火按内容感知 —— claim 丢失只在携带 ≥1 个投递的应答上点火）；真实的 `ManagedEmailAdapter`（取自 `@qwen-code/channel-email` 的构建产物）配测试 deps —— 剧本化 FakeImap（剧本邮件携带确定性的 `(channel, uid)` Message-ID，使重驱动的事件绝不按内容另铸路由；打开时游标为空，使邮件被准入而非当作历史跳过）、可剧本化的 FakeSmtp，其 `sendMail` 记录每次发送并可在放行文件前泊停（`smtpMode: park`）、接受后挂起（`holdAfterSendFile`）、或无 5xx 码超时（`accept-timeout`），noop 锁，真实的 `mailparser`，以及包着生产 `HttpManagedChannelControlPlane` 的记录型控制面客户端（线上线形与生产完全一致，证据在旁记录；无客户端超时 —— 冷 Session 上的 claim 合法地需要它所需的时间）。`pollLoop: false`：阶段以独立步骤驱动 `tick()` 或纯入站的 `poll()`（`pull-terminate` 阶段则泊停于其杀死标记处），使 IT 能在取消与杀死前后编排顺序；多投递拉取用 `expectedSends`；零发送故障窗用 `holdAfterDrop`。状态放在每个用例自己的目录里，使重启是真的冷加载。每步 stdout 标记（`FG7_READY`、`FG7_DROPPED <verb>`、`FG7_CLAIMED`、`FG7_SEND_DONE`、`FG7_CLAIM_PARKED`、`FG7_HELD`、`FG7_AWAIT_KILL`、`FG7_PROBE_REFUSED`、`FG7_RESEND`、`FG7_<phase>_OK`）为 IT 排序；`results-<phase>.json` 携带用例证据（发送计数与 Message-ID、准入身份、带丢弃标记的接力次数、回执结果、探针状态）。`adapter-kill`/`adapter-stop` 中 IT 在标记处直接杀死驱动进程本身，并用同一状态目录重新拉起。

**Harness 与模型。** IT 在固定端口以 `dist/cli.js serve --profile hosted-harness` 启动，携带内嵌 broker 的 URL（同 FG6），并由一个 OpenAI 兼容的罐装模型对每轮的 channel 唤醒轮给出一小段固定回复，于是一个轮次产出一份 `<inputId>:reply` 投递、一个小分段。Harness 的 Workspace Session 需要 `hosted-workspace-files/1`，因此 harness 以 `--managed-runtime-broker-url` 启动，broker 以方法级固定端口内嵌运行（固定 harness 端口解开 base-url/broker-url 的启动循环）。IT 一律经 JDBC 等待 journal 事实，而不是 sleep；排序谓词点名驱动标记（读前先泊停），绝不只数行数。

**用例状态。** Legacy 派生的 adapter 状态存储按用户全局 qwen 目录建键，因此 IT 给每个用例自己的 `HOME`（用例目录的子目录）——否则同一用例会踩在上一轮的光标上重跑，并把测试状态漏进真实的 `~/.qwen`。持久化证据（`results-*.json`、`driver-*.log`）落在 `target/fg7-cases/` 下，每个 method 重建，因为 `@TempDir` 在测试结束时被清理。

**CI。** 两个类被 `hosted-harness-mysql` 收编（`Hosted*IT` include；`check-failsafe-reports.js hosted` 强制）。本机实测（M3、JDK 21、Node 22、MariaDB 10.11）：故障类五个字母共 34.4 s，崩溃类 25.1 s —— 测试时间新增约 60 s，共享分叉上墙钟约 150 s；预算调整为 900 s → 1200 s（分叉）、25 → 35 分钟（Verify 步骤）、148 → 160 分钟（作业），`hosted-process-ci.test.js` 同时钉住三者，并新增 `hosted-channel-gates` 聚焦 profile 供本地使用。本地数据库：系统 `mysqld` 配一次性 datadir —— MariaDB 用 `mariadb-install-db --auth-root-authentication-method=normal` 初始化；MySQL 8 按 `scripts/run-managed-agent-server-e2e.ts` 用 `mysqld --initialize-insecure` 初始化 —— 需要触发器权限，同 FG6b。

## 变异检查

每个变异按 FG6 文档化的手工流程施加、证明恰好让它那道门禁变红、再还原（adapter 变异重建 `packages/channels/email`，漏斗变异重打 `dist/cli.js` bundle，Java 变异重编译）：

1. FG7a —— 绕过服务侧的入场身份派生（`inputId` 每次尝试全新，不再是 `chin-<routeKey>`）：第二次尝试铸出第二条 route 行准入、第二条 input 事件与第二次物理发送（`inbound-reply` 红 —— 正是门禁为守住而存在的重复发送缺陷类）。
2. FG7a/b —— adapter 在回执重驱动时铸造新的 `providerMessageId`（持久化结果不再证明身份）：漏斗拒绝 `409`，台账永不收敛（`commit-reply-restart`、`receipt-reply` 红）。
3. FG7b —— 漏斗按 `providerMessageId` 的回执幂等改成拒绝：重驱动死于 `409`，台账永不收敛（`receipt-reply`、`commit-reply-restart`、`delivery-commit` 红）。
4. FG7b —— `ManagedChannelService.receipt` 丢掉台账步：记录与台账永久分叉（`delivery-commit` 在 delivered 台账断言上红）。
5. FG7c —— 租约协调器跳过 `unknown` 结算：搁浅挂在 `sending`（`adapter-kill`、`claim-reply`、`spring-kill-dispatch`、`adapter-stop`、`cancel-unsettled`、`receipt-never-arrived` 红）。
6. FG7c —— 漏斗的 `receipt` 把 `unknown` 视作终态：迟到的诚实回执永远落不下（`adapter-stop` 红）。
7. FG7d —— 漏斗 `cancel` 把 `sending` 投递立即结算为 `cancelled`：`cancel-sending` 红（无物理结算而捏造终态；其后回执失败）。
8. FG7d —— Java 两层 claim 发现筛选（`listSessionsWithPendingDeliveries` 与 `findPendingDeliveries`）同时弱化，叠加漏斗 `claim` 终态拒绝被弱化为容忍：`cancel-planned` 红（搁浅投递铸出 claim 行并发生一次物理发送）。仅弱化发现层无法产生发送 —— 漏斗终态守卫仍拦截 —— 故本变异按组合形态记录。
9. FG7e —— 游标决胜比较弱化为包含游标行：`delivery-page-resume` 红（页界处重复）。
10. FG7f —— 含糊 SMTP 失败被分类为 `accepted`：`provider-ambiguous` 红（记录无回执证据而声称 `delivered`；健全形态应保持 `unknown`）。

两个设计的变异在 v1 下可证不可分辨，**不执行**：把漏斗 `claim` 对 `sending` 改拒（对首个应答已死的 adapter 来说重复 claim 应答不可见 —— 它只持有一份拷贝）；以及让 `resend` 携带全部分段而非仅未发送集合（v1 email 计划为单分段，过滤与否的产物完全相同）。两者都需要 H5d 的多段计划，正是 `partial` 所等待的同一个前提（决定 2）。

## 验证与验收

- `npm run build && npm run typecheck`、驱动经 ESLint 干净、两个新 Java 类过 Checkstyle 与 SpotBugs、本模块 surefire 套件全绿（初验基线 1606 个测试）。
- 两个新类在本机 MariaDB 10.11 上全绿（CI 车道为 MySQL 8.4）：19 个用例全部点燃其声明的故障 —— 每个丢弃计数、`FG7B_*` 触发标记与杀死标记均被观察到 —— 按用例选择子可用、无任何注入时 channel 正常流绿。
- 上述每个变异单独变红；源码还原；整套门禁复绿。
- `hosted-process-ci.test.js` 在新预算下全绿，`check-failsafe-reports.js hosted` 在全车道运行后满足。
- 按 AGENTS.md 完成两轮连续干净的无方向与反向审计；第五轮之后只收 Critical 修复。
- 本设计以双语落地，交付台账补 FG7 行；并在 #13802 上发表一条评论记录 FG7e 的改范围与 FG7f 的 `partial` 顺延（H5d），使跟踪者反映定稿的形状。

## 开放问题

1. 后续某片新增的 WebShell 镜像路由是否继承 FG7e 的连续性断言 —— 留给那片，记在这里使改范围只记录一次。
2. 按 claim 行的 `deliveries:claim` 重放是否应作为后续某片的工作：今天丢失携带应答由租约收敛到 `unknown`（FG7a 已记录该决定）；当该重放落地时，`claim-reply` 门禁的期望将升格为 `delivered`。
