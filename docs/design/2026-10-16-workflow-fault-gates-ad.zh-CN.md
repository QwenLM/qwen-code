# Workflow child_run 故障门禁 FG10a + FG10d

[English](2026-10-16-workflow-fault-gates-ad.md) | [简体中文](2026-10-16-workflow-fault-gates-ad.zh-CN.md)

## 问题与范围

Issue #14165 是 #12380 的 Stage F 第 FG10 轮，隶属伞形 #14054：为
#13858 启用的 `child_run` `workflow` kind 补故障门禁。该 kind 不拥有
自己的 OS 进程（不同于 FG8 的能力），副作用也不落进另一个参与者的
journal（不同于 FG9）；它在进程内确定性执行、受一个被 pin 住的定义
摘要约束，其特有风险是 child turn 被楔死——没有崩溃、没有丢失，
child 却永远无法前进。

本切片只实现 **FG10a（摘要完整性）与 FG10d（进程崩溃）**——即 issue
自述本轮特别欠的两道门禁，也是 triage 结论建议的拆分（问题 4）：FG10a
是因为摘要重验在设计上静默失效（拒绝而非崩溃）；FG10d 是因为进程内
子 agent 模型在崩溃后没有独立见证者，而这正是记录最可能被不诚实结算
的情形。FG10b/c/e/f 大多在重跑 FG1–FG7 已覆盖的 kind 无关机制，留在
#14165 作为后续切片。

本切片沿用 FG7/FG8 的形态：真实打包 Harness、每 case 一个 TypeScript
驱动器、in-JVM Spring 控制面接真实 MySQL/MariaDB、JDBC 地面真相、
每门禁一个命名 mutation。**不改任何生产代码。**

被门禁的性质，已在 `main` = `70758572ff` 上对照源码重新核实（issue
引自 #13858 的描述；两条均成立）：

1. 定义从 revision 1 被 pin 住，用其脚本字节的 sha256——
   `workflowDefinitionPin`
   （`packages/cli/src/serve/hosted-workspace-tool-turn.ts:434-446`）
   铸造 `workflow/<name>@1`，`definitionDigest` 覆盖精确字节——且
   摘要在 child 花费任何东西之前被重验：`runHostedWorkflowTurn` 的
   第一个动作就是复算 `sha256(script)` 并与 pin 比对
   （`packages/cli/src/serve/hosted-workflow-turn.ts:190-197`），先于
   `loadSettings`（`:198`）、`loadCliConfig`（`:226`）、`refreshAuth`
   （`:256`）与 `WorkflowRunner.start`（`:261`）。不匹配抛出
   `HostedWorkflowTurnError`，消息点名两个摘要
   （`Workflow launch pin does not match its script: pinned …, script ….`）。
2. 子 agent 在进程内、跑在 `node:vm` 下
   （`packages/core/src/agents/runtime/workflow-sandbox.ts`——realm 在
   `:1307`，`runInContext` 在 `:1313`），明确不是嵌套 managed 孙代：
   Harness 崩溃带走每一个子 agent，且没有独立的 managed 记录可对账。
3. launch block 跨 daemon 与 SDK 走 `sha256(JSON.stringify(prompt))`
   准入摘要（`packages/cli/src/serve/hosted-harness-session.ts:6087-6090`；
   SDK 侧 `SubmitHarnessTurn.computePayloadDigest`，
   `packages/sdk-java/qwencode/.../SubmitHarnessTurn.java:53`），SDK 的
   canonical JSON writer 由 Node 导出的 golden vectors 钉住 ECMAScript
   字节保真（`JsonSupportTest.java`）——即 #13858 修掉的
   fractional-`args` 楔死。
4. kind 门禁在每一次 `child_run` revision 提交时触发
   （`packages/core/src/managed-runtime/managed-session-authority.ts:1641`）。

## 现状

- 启用清单（`packages/core/src/managed-runtime/managed-session-records.ts`）：
  `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 为
  `['child_agent', 'shell', 'workflow']`（`:199-203`）；
  `CHILD_NOTIFICATION_SOURCES` 为 `['child_agent', 'workflow']`
  （`:212-216`）。于 `70758572ff` 核实。
- `workflow` kind 今天没有任何故障覆盖：`workflow` 在
  `hosted-channel-fault-driver.ts`、`hosted-monitor-run-fault-driver.ts`、
  `HostedChannelFaultGatesIT.java`、`HostedMonitorRunFaultGatesIT.java`
  中零命中。
- issue 的两处引用在重读时需要更正：
  - `workflow-session-gate.test.ts` **不是** workflow child 的驱动
    测试——它测的是在 ACP 事件流里抹掉 `workflows` 命令。可复用的
    编排在 `hosted-workflow-turn.test.ts`、
    `hosted-workflow-turn.integration.test.ts` 与
    `hosted-workspace-tool-turn.workflow-child.test.ts`。
  - 重验发生在 **Turn 内部，而非准入时**：被篡改的 launch 在 child
    首个 Turn 执行时才被拒绝，此时 child session 已建好、
    `input.accepted` 已落 journal，拒绝经 relay 以 `child_failed`
    结算。「在任何 child 花费之前被拒绝」因此指先于
    settings/config/auth/model 花费——生产顺序已保证，且单测已钉住
    （`refuses a script whose bytes do not match the pin, spending
nothing`）。本组门禁钉住既有的 Turn 内语义；把拒绝挪到准入时
    是新的生产行为，不在范围内。
- 崩溃门禁要钉的结算词汇：daemon 把 relay 动词映射到
  `settleCompleted` / `settleFailed` / `settleCancelled`
  （`hosted-harness-session.ts:7054` 起）；没有任何自动路径结算一个
  崩溃的 run——被 SIGKILL 的 Harness 写不出结算，relay 的有限重试
  观望才把事实宣告为 `unknown`（`ChildResultRelay.java:239`，
  「Bounded retries before a fact is declared unknown, never
  guessed」，`:55-61`）。冷载对有未结算 Turn 的 session 回答 409
  `hosted_turn_recovery_required`（`hosted-harness-session.ts:5748`
  的 load 路由及其分支）。
- 摘要在重开时绝不会从较晚的 revision 被重新解析：pin 是合成的
  （`workflow/<name>@1`，无注册表、无 revision 计数器），envelope
  字节持久在 Session Store 里，relay 重建 child 时原样读回
  （`ChildResultRelay.java:465-495`）。FG10d 把这条钉成见证，而非
  新机制。
- 复用的 Hosted 车道机器：每 case 打包 Harness
  （`HostedHarnessProcess`，`node dist/cli.js serve --profile
hosted-harness`）、`hosted-monitor-run-fault-driver.ts` 的
  lose-once store/broker 代理形态、JDBC 播种的 in-JVM Spring、
  probe 作门禁半边的模式（`HostedMonitorRunProbe`）、按 letter 的
  case 选择器、`target/fgN-cases/` 证据目录，以及
  `check-failsafe-reports.js hosted` 的家族强制与
  `hosted-process-ci.test.js` 的预算钉。

## 范围决定

1. **只做 FG10a + FG10d。** FG10b/c/e/f 留在 #14165 的后续切片。
   依据：issue 自述 a 与 d 是本轮欠的两道；triage 结论建议正好先落
   这两道；Hosted fork 预算正在修（#14148，open）且主干 CI 有红色
   邻居（#14023，open），所以本切片只花能交付 workflow 特有价值的
   最小预算。_实际交付时只有 FG10a 落在这里；FG10b–f（含 FG10d）落在
   [relay 设计](2026-10-17-workflow-relay-fault-gates.zh-CN.md)中。_
2. **排序约束重新评估，而非照旧继承。** issue 的「排在 FG8 与
   #14147 之后」写于 FG8 尚未开工时。FG8 的切片 1（#14120）此后已
   合入并证明了本切片照抄的按 letter 驱动器模式；#14147（抽取共享
   helper）仍阻塞于 P3，故本切片遵循**当前未抽取**的模式，接受
   FG8/FG9 已携带的重复——正如 FG8 各切片所为。
3. **一个 IT 类；不杀 Spring；无 cgroup 依赖。** FG10a 在
   `HostedWorkflowFaultGatesIT` 内、in-JVM Spring，选择器
   `-Dqwen.fg10a.case`，证据在 `target/fg10-cases/`。原本也规划在这里的
   FG10d 落在了 `HostedWorkflowRelayFaultGatesIT`（relay 设计的第 3 片，
   选择器 `-Dqwen.fg10d.case`），所以本类不读取任何 FG10d 选择器。
   workflow kind 不拥有 OS 进程，因此不需要 FG8 的 cgroup v2 委托；
   崩溃 letter 的 SIGKILL 目标是打包 Harness 本体——父 session 与
   进程内 workflow run 都住在其中。
4. **relay 必须在 in-JVM Spring 里运行。** `ChildResultRelay` 是
   `@Service`（`ChildResultRelay.java:47-48`），随应用启动；本夹具
   保持其启用（FG8 的夹具关掉了它不需要的 Harness 侧服务——后台
   `shell` run 不是 child Session），因为 workflow child session 由
   relay 从 pending 行创建（`ChildResultRelay.java:465-495` →
   `ManagedAgentService.createWorkflowChildSession`，`:307-326`）。
5. **篡改注入是 probe 背后的 JDBC 字节改写，不是代理改包。**
   envelope 字节经 Harness 的 managed-session-store 流量落入
   Session Store；probe 持有 JDBC 连接，在记录提交之后、relay 构建
   child Turn 之前，原地改写 envelope 资源的 script 字节（保持字节
   长度）。这比代理字节改写更具确定性（后者会与 publish/commit 的
   排序竞争），且恰好触到本门禁要钉的生产重验路径。
6. **断言如实指名 Turn 内拒绝。** FG10a 期望 child Turn 以点名两个
   摘要的 `HostedWorkflowTurnError` 失败、假模型服务器从零记录到
   child session 的请求、记录以 `child_failed` 诚实结算——而非准入
   时拒绝（见「现状」）。
7. **沿用 FG8 决定 4 的 #13339 隔离与「每个 case 先证其故障」
   纪律**：只加新类，绝不动既有 `Hosted*IT`；每个 case 先断言注入
   确实发生（篡改重读、kill 标记、在飞证明），再断言期望。

## 门禁台账

地面真相是 child_run 记录行与 relay operation 账本的 JDBC 查询，
加上驱动器的 results JSON、假模型服务器的请求日志、以及捕获的
Harness/Spring 日志。每个 case 先证其故障确实注入，再断言期望。

### FG10a —— 摘要完整性

假模型对父 turn 的第一次应答携带 `fakeToolCall('workflow',
{script, args})`；hosted workspace tool turn 完成 pin 与 child run
提交，relay 创建 child session，摘要门禁住在 child 的首个 Turn 里。

| Case                               | 注入                                                                                                          | 期望                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tampered-script-refused`          | probe 在 child_run 记录提交之后、relay 构建 child Turn 之前，改写 envelope 内 `script` 的字节（保持字节长度） | child Turn 以点名 `pinned` 与 `script` 摘要的 `HostedWorkflowTurnError` 拒绝（turn `FAILED`）；假模型服务器从 child session 记录到**零**请求；记录绝不伪 settle 为 `settled`；probe 重读证明篡改已落库 |
| `same-length-substitution-refused` | probe 换入 `SUBSTITUTE_SCRIPT`——由 driver 编写的一份语法合法、可运行、字节长度相同的不同脚本                  | 同样的拒绝形态——抓住它的是摘要，而不是任何长度或解析检查；若中和摘要检查，替换脚本会被执行并完成，用例随之变红                                                                                         |
| `fractional-args-admitted`         | 无——一次 `args` 携带 fractional 与 subnormal 值（`0.1`、`5e-324`）的 launch 跨过真实 daemon/SDK 边界          | 准入摘要两侧一致（无 `invalid_hosted_prompt`）；child Turn 跑到完成（`COMPLETED`），绝不楔死；Turn 最终内容以精确的 ECMAScript 形态回显这些值——证明它们确实到达了执行端                                |
| `substitute-script-baseline`       | 无——对 `SUBSTITUTE_SCRIPT` 本身做一次诚实 launch                                                              | child Turn 完成且其最终内容携带替换脚本的哨兵，证明替换脚本合法可运行——从而替换用例的拒绝只归因于摘要，绝非解析错误                                                                                    |

**为什么断言落在 child Turn 而非记录的终态结算。** 摘要拒绝发生在
Turn 内部（`hosted-workflow-turn.ts`），且 Turn 的运行独立于 relay
后续的 bind/deliver 链。要把那条链驱动到记录结算，需要 relay 对
parent Session 的 server-side 操作——它与 driver 直挂的 parent
attach 冲突（`already_attached`）；而 coordinator 持有的替代拓扑
（TeamLead 形态）需要 workspace execution，本地 macOS 回路不可用
（Linux-only，如同 FG8 的 cgroup 用例）。Turn 级断言恰好覆盖本
letter 欠的摘要性质；记录的 relay 结算是 FG10b/c 的机制。probe 在
篡改后恰好驱动一次 relay scan 来触发 create;bind 及其后绝不运行，
因此 driver 直挂的 parent 永不冲突。

### FG10d —— 进程崩溃

**已在 coordinator 持有 parent 的夹具上交付。** 驱动器与门禁在本切片里都已搭好，
而门禁是红在一个真实发现上、不是夹具缺陷：在 workflow 中途（子 agent 在飞）SIGKILL
Harness 再重启后，恢复机制重新驱动了 child 未结算的 workflow Turn——脚本重跑并重新
派发了它的子 agent（击杀后的 model 请求带着子 agent 的系统提示词）。这正是本 letter
要钉的「never re-executed on reopen」所禁止的。

该发现已作为生产 bug（#14387）落地并在 #14461 修复：恢复机制把该 Turn 泊车为
`hosted_workflow_recovery_blocked`——绝不重驱动、绝不结算——relay 随之把记录结算为
`recovery_blocked` 覆盖 `outcome_unknown`。

FG10d 随后作为 [relay 设计](2026-10-17-workflow-relay-fault-gates.zh-CN.md) 的第 3 片
落在 `HostedWorkflowRelayFaultGatesIT` 里，而不是这个由 driver 持有 parent 的类。它的
期望——记录的阻断结算、ledger 以及 parent 收到的通知——都在 relay 从 bind 到 deliver
的流程里，本类由 driver 持有的 parent 跑不了这条流程（见上文 FG10a 的说明），而
coordinator 持有的 lead 可以。下面两个用例沿用原名；每项注入和期望如何落地、门禁在那里
又发现并修复的两个缺陷，以及变异，都记在 relay 设计里。本切片只交付 FG10a。下文保留为
原始设计。

仅 POSIX。驱动器持有 Harness 子进程并 SIGKILL。在飞见证是假模型
服务器的请求日志：一次 `agent()` 派发即一次 POST，所以「子 agent
在飞」= 已收到但尚未放行应答的请求。

门禁观察的机制：coordinator 的恢复扫描把未结算的 workflow Turn 标记为
`hosted_workflow_recovery_blocked`——绝不重驱动、绝不结算；relay 从
Turn 行读到该标记，把记录结算为 `recovery_blocked` 覆盖
`outcome_unknown`，并在自己的扫描节奏内把台账归类为
`unknown`（#14387）。门禁因此钉住的是 case 预算内的可观测不变量：
记录结算为 `recovery_blocked`——绝不为 `failed`、`cancelled` 或
`settled`——再加上冷载拒绝这条持久性质的另一半。

| Case                                         | 注入                                                                                                                                | 期望                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill-mid-workflow-subagents-in-flight`      | 在一条子 agent 请求被假模型服务器挂起期间 SIGKILL Harness                                                                           | 击杀后的观察窗内记录结算为 `recovery_blocked` 覆盖 `outcome_unknown`——绝不为 `failed`、`cancelled` 或 `settled`；重启的 Harness 对 child session 的冷载回答 409 `hosted_turn_recovery_required`，零新 model 调用、零重执行；记录的 `definitionDigest` 仍等于原脚本的 sha256（绝不重新解析） |
| `kill-after-last-subagent-before-settlement` | store 代理扣住 child 的 `settleTurn` 提交并在**转发之前** SIGKILL Harness——击杀先于提交是刻意的，这就是被钉死的确定性「结算前」交错 | 结算从未落库：观察窗内记录结算为 `recovery_blocked` 覆盖 `outcome_unknown`，被丢弃的提交在代理日志里有见证，冷载如上拒绝；绝不为 `failed`/`cancelled`，重开时绝不重跑                                                                                                                       |

## 夹具设计

**Java 侧。** `HostedWorkflowFaultGatesIT` 按
`HostedMonitorRunFaultGatesIT` 的方式为每个 letter 起一个 in-JVM
`ManagedAgentServerApplication`（workspace mount 与 session 行用
JDBC 播种，MySQL 属性强制——缺失即失败而非跳过），收窄两处：不要
tool-publication 配额块、不要 OSS mock（workflow kind 没有捕获链），
并保持 child-result relay 启用（决定 4）。`HostedWorkflowProbe` 在
普通 `HttpServer` 上服务 `/fg10/<sessionId>/<phase>`：`state` 回答
child_run 记录体与 relay operation 账本行；`tamper-envelope` 执行
决定 5 的字节改写并重读该行，供 case 证明篡改已落库。证据在
`target/fg10-cases/<letter>/<case>/`，按方法重建。每 letter
`@Timeout(600)`。

**驱动器。** `integration-tests/helpers/hosted-workflow-fault-driver.ts`，
按 letter 以 `node --import tsx … <driver.json>` 启动，与每个
FG6–FG8 驱动器相同。它持有：每 case 的 `HostedHarnessProcess`
（隔离 `HOME`/`QWEN_HOME`/`QWEN_RUNTIME_DIR`）；store 前置代理，
其 commit 日志是启动在 store 侧的证据（FG10a 经 probe 注入；原本为
FG10d 规划的「结算在飞即杀」臂改由 relay 类的 Java 代理承担）；假
OpenAI 服务器（见下）；以及预置的 workflow 脚本。标记：
`FG10_CASE_OK <case>` 供 IT 排序，`FG10_STEP` / `FG10_DIAG` 追踪与
转储，`FG10_TAMPERED` 证明注入。若驱动器调用
`relayUpstream`，须加入 `hosted-relay-headers.test.ts` 的被钉调用者
名单。

**模型。** 一个预置的 OpenAI 兼容服务器：父 turn 得到恰好一次
`fakeToolCall('workflow', …)`；child run 的 `agent()` 派发得到简短
固定应答，立即应答（原本为 FG10d 在飞击杀规划的挂起应答改由 relay 类
的脚本化模型承担）。模型永远不是
被门禁的对象；它的请求日志是在飞见证。

**CI。** 类名使其落入 `hosted-harness-mysql` 车道（`Hosted*IT`
include；`check-failsafe-reports.js hosted` 强制其运行）。新增本地
聚焦 profile `hosted-workflow-gates`（include
`**/HostedWorkflow*IT.java`），镜像 `hosted-monitor-run-gates`。
`hosted-process-ci.test.js` 增加按类的天花板断言块；车道预算只按
实测的类成本移动——fork 上限与 healthy 余量是字面钉（`:477`、
`:489`），所以 PR 以实测数字更新它们及其注释史，并显式留意与
#14148 在修预算的交互。upload-artifact 步骤增加
`target/fg10-cases/`。不需要 cgroup 步骤：该 kind 不拥有 OS 进程。
本地数据库：一次性 MySQL/MariaDB，同 FG7/FG8。

## Mutation 检验

每个 mutation 施加后证明恰好把自己的门禁打红，再还原，遵循
FG6/FG7/FG8 已记录的手工流程。

1. FG10a——把 `runHostedWorkflowTurn` 里的摘要比对中和（复算出的
   摘要一律视为相等）：`tampered-script-refused` 与
   `same-length-substitution-refused` 变红——被篡改的脚本被执行，
   假模型服务器记录到 child 请求。
2. FG10d——本设计原计划把 relay 对「Harness 已死的 child」的有限观望归类改写
   为把记录结算 `failed` 而非宣告事实 `unknown`。FG10d 随 relay 设计落地，由其
   第 3 片的变异取代这一条。

## 验证与验收

- `npm run build && npm run typecheck`；驱动器 ESLint 干净；
  managed-agent-server 的 surefire 套件绿。
- 新类在本地一次性 MySQL/MariaDB 上全绿：每个 case 都确实触发了
  其声明的注入（篡改重读、kill 标记、在飞证明均被观测到），按
  letter 选择器可用，正向用例 `fractional-args-admitted` 绿。
- 上述两个 mutation 各自单独变红；源码还原；门禁复绿。
- `hosted-process-ci.test.js` 以实测预算转绿，完整车道跑过后
  `check-failsafe-reports.js hosted` 满足。
- 按 AGENTS.md 做两轮连续干净的开放式与反向自审。
- 本设计双语落地；在 #14165 留言登记 a+d 切片拆分，并把
  FG10b/c/e/f 指回该跟踪者的剩余工作。

## 开放问题

1. FG10b 的 kind 门禁重查断言（每次 revision 提交都触发，而非仅
   首次）随 b/c/e/f 切片，还是在此先行钉住——留给后续切片；FG10a
   的正向用例本就经过前两次提交。
2. 确切预算数字等类成本实测；若实测完成时 #14148 的修复仍 open，
   PR 显式说明交互而非抢占其结论。
3. workflow turn 的冷载 409 分支是否需要 #13361 式的分支标记
   reason 名（FG8 遵循的纪律）——只能在驱动器落地时对照 load 路由
   当前的分支集决定。
