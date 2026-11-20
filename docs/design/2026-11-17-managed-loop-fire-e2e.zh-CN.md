# Managed /loop 定时触发观察 E2E

- 状态：提案
- 日期：2026-11-17
- 关联：[Managed loop skill 资产](2026-11-14-managed-loop-skill-asset.zh-CN.md)
  （#17272、#17433、#17470 已合入）、[Managed loop 固定间隔](2026-11-10-managed-loop-schedule.zh-CN.md)
  （#17088、#17197、#17235 已合入）、[Managed loop 唤醒](2026-11-10-managed-loop-wakeup.zh-CN.md)
  （#16835 已合入）
- English version: [2026-11-17-managed-loop-fire-e2e.md](2026-11-17-managed-loop-fire-e2e.md)

## 问题陈述

Managed `/loop` 链路已完整合入：带创建者的 profile 在准入时收到 cron loop
变体，模型驱动真实的 `cron_create` / `cron_list` / `cron_delete` 工具，全栈
E2E（`npm run test:e2e:managed-loop-skill`，full-tier `hosted-failover-e2e`
CI 步骤）见证该生命周期。skill 资产设计明示了剩余缺口：「观察定时触发仍在
范围外」。

今天 E2E 在 schedule 触发前就把它退役（五分钟 cron，同一轮里 clear）。打包
栈 E2E 里没有任何东西证明已提交的 schedule 会自行触发：Java scanner 认领
armed 定义、推导到期的分钟槽、向 Harness 中继 `fire_run`，Harness 派发一条
automation 输入、其框架文本作为新回合到达模型，控制面把该次 occurrence 结算
为 `fired` 且 trigger 为 `scheduled`。Java 集成测试用假 Harness 跑 scanner；
CLI 单测用进程内 store 跑 fire 路由。这两半从未在真实 socket/文件系统/路由
栈上被一起观察过。

## 现状（在 91690e86e5 核实）

触发链路，端到端：

1. files/4 Session 上的 `cron_create` 跑 arm-time 分类器审查，经控制面提交
   定义（`packages/cli/src/serve/hosted-cron-session.ts` create 路径）。账本
   将其 arm（state `live`）。
2. `AutomationScanner.scan()`
   （`packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/automation/AutomationScanner.java:111`）
   在 `managedAutomationScheduler` 上按
   `${qwen.managed-agent.automation.scan-delay:10s}` 运行；automation 默认
   启用（`server/src/main/resources/application.yml:97-101`，env
   `QWEN_MANAGED_AGENT_AUTOMATION_SCAN_DELAY`）。每个 tick 认领 armed 行、
   推导分钟粒度的 cron 槽（`CronSlots`）、每槽记录一条决策，并把获准的
   occurrence 作为一次幂等 Harness 操作触发。fire 正文携带
   `kind: "fire_run"`、铸造的 `scheduleId`、`definitionRevision`、
   `occurrenceKey`、`trigger`、`firedAt`（AutomationScanner.java `fire`）。
3. Harness 路由 `fire_run`
   （`packages/cli/src/serve/hosted-harness-session.ts:14238`）调用
   `automations.fire`，派发一条输入，其文本为 `automationTurnText`
   （`packages/core/src/managed-runtime/managed-automation-operations.ts:699`）：
   框架块（`Scheduled automation: <goal>`、`Automation ID:`、`Schedule:`、
   `Occurrence:`、`Triggered at:`、`Trigger: <trigger>`）、
   `AUTOMATION_RUN_INSTRUCTION` 句、然后是 schedule 的 prompt。输入 source
   为 `automation`（`managed-automation-operations.ts:80`）。wake pump 在
   Session 空闲的瞬间启动回合；runtime worker 驱动模型。
4. scanner 在中继应答后把 occurrence 结算为 `fired`。公共读路由
   `GET /v1/agent-automations/{automationId}/runs`
   （`ManagedAutomationController.java:89`）应答 `PublicAutomationRun` 记录
   （`ApiModels.java:794`），携带 `trigger`、`outcome`、`occurrence_key`、
   `slot`、`state`。

时序：cron 槽是分钟粒度，watermark 推进到 `floor(now / 60s)`
（AutomationScanner.java `work`）。分钟中途 arm 的 schedule 在下一个分钟
边界、其后的第一个 tick 触发；最坏等待一分钟加 scan 延迟。`*/1 * * * *`
是 skill 的 `1m` 映射，与 `* * * * *` 同样可编译。

runner（`scripts/run-managed-agent-server-e2e.ts`）已经启动 MySQL、打包
Spring jar、hosted harness、内嵌 runtime broker 与假 OpenAI 服务器；
`waitForTerminal` 轮询公共事件流；`--loop-skill` 臂的假模型按 block schema
匹配应答分类器的 `respond_in_schema` 侧查询。fire 臂全部复用。

## 提议的变更

新增互斥 runner 模式 `--loop-fire`，接为第三十条 `hosted-failover-e2e` 臂。
一个场景，一个问题：已提交的每分钟 schedule 是否自行触发并驱动一个模型
回合？

### 场景

1. 创建 files/4 定义与 Session，输入为
   `/loop 1m LOOP-FIRE-PROMPT check the deploy`。不发送 caller skills
   （决策 D4）。注入的变体在第一回合前加载；脚本化模型以
   `cron: "*/1 * * * *"`、`prompt: "LOOP-FIRE-PROMPT check the deploy"`、
   `recurring: true`、`durable: true` 调用 `cron_create`，然后确认。create
   回合必须以恰好一个 `turn.completed` 结算。
2. runner 从 create 工具结果提取铸造的 `asch_` id（按 `tool_call_id` 匹配，
   非子串）。
3. runner 不再发送任何输入，读 `GET /v1/agent-automations/{id}/runs`，直到
   某条 occurrence 应答 `trigger: "scheduled"`、`outcome: "fired"`、
   `state: "completed"`。harness 驱动的 wake 回合不进入公共回合事件流——
   该流由控制面的派发回合管线写入——因此 run 镜像是其公共生命周期：
   `state: "completed"` 从 wake 回合自身的已提交结果结算，证明该回合跑过
   且完成。
4. fire 的 prompt 必须已到达模型：某个流式 round 的最新 user 文本是
   automation 框架。假模型对该 round 给 wake 标记应答、不带工具调用，因此
   completed 的 run 证明标记应答跑过。
5. 守卫把两个见证绑到同一次 occurrence（决策 D3），臂断言负例：任何
   create 回合的 round 都不携带 automation 框架。
6. 清理：`/loop clear` 客户端回合（从 create 光标排队——wake 回合没有增加
   公共事件）驱动 `cron_delete` 指向铸造 id；delete 结果必须陈述退役，该
   客户端回合必须以恰好一个 `turn.completed` 结算。存活的每分钟 schedule
   不得在臂结束后残留。

### 假模型

`--loop-fire` 分支按序应答：分类器的 block-schema 侧查询给 allow（与 skill
臂相同的 schema 匹配）；wake 回合——最新 user 文本携带
`Scheduled automation:` 框架头——给终态标记内容、不带工具调用；
`/loop clear` 回合给 `cron_delete`（id 取自 create 结果打印值），然后确认；
其余回合给 `cron_create` 夹具，该调用自己的结果进入历史后确认。假模型与
回合搜索只匹配框架头；scheduled-trigger 判别仅由守卫承担，因此中继 trigger
漂移会使守卫红而 wake 回合仍跑。

### 守卫

顶层纯函数 `assertScheduledFireWitness(runs, wakeText, scheduleId)`，使元
测试可提取并执行它：

- 必须存在某条 run `trigger === 'scheduled'` 且 `outcome === 'fired'`，否则
  抛错（manual 或 skipped 的 occurrence 不得通过）；
- 该 run 的 `occurrence_key` 必须逐字出现在 `wakeText`，否则抛错（模型回合
  与账本必须点名同一次 occurrence）；
- `wakeText` 必须携带 `Automation ID: <scheduleId>` 与 `Trigger: scheduled`，
  否则抛错（该回合必须是 fire 的框架，而非客户端 prompt）。

### CI 接线

- `package.json`：`test:e2e:managed-loop-fire` 以 `--loop-fire` 跑 runner。
- `.github/workflows/sdk-java.yml`：skill 臂之后加 `Run /loop scheduled-fire
E2E` 步骤，同 `failover_prerequisites` 门控，`timeout-minutes: 10`；job
  ceiling 315 → 325（30 臂 × 10 + cgroup 10 = 310，+ ~13 搭建 + 2）。
- `scripts/tests/hosted-process-ci.test.js`：`failoverArms` 表行、
  `--loop-fire` flag 排他项、ceiling 表 `[310, 325, 15]`、臂数注释。
- `scripts/tests/managed-agent-server-e2e.test.js`：臂契约钉子测试 + 提取
  守卫的可执行断言。

## 设计决策

- **D1 — 独立臂，不扩展 `--loop-skill`。** skill 臂的 create → list → clear
  契约已合入且上钉；fire 臂问的是另一个问题，需要另一种时钟（分钟边界
  等待）。独立臂让失败归因干净，且不动任何既有钉子。两者共享 runner 与
  打包栈，遵循既有的一 runner 模式。
- **D2 — 真实 scheduled 触发，不走捷径。** 见证必须是
  `trigger: "scheduled"`。不用 manual-run 路由、不注入时钟：臂仅在本模式设
  `QWEN_MANAGED_AGENT_AUTOMATION_SCAN_DELAY=1s`，等待真实分钟边界。最坏
  等待 ≈ 60s + 1s tick + 中继 + 回合；runs 路由轮询预算 150s，CI 步骤沿用
  每臂 10 分钟 ceiling。
- **D3 — 双向见证，同一次 occurrence。** 仅有一条 fired 账本行，可能搭上一个
  模型从未看见的 wake 回合；仅有一个模型回合，可能是伪装的客户端 prompt。
  守卫要求账本 `occurrence_key` 逐字出现在该回合框架内、框架的
  `Automation ID` 等于铸造 id、两侧 trigger 均为 `scheduled`。负例（任何
  create round 都无框架）证明 fire 回合是新的。wake 回合的终态由 run 镜像的
  `completed` 状态见证，该状态从回合自身的已提交结果结算：harness 驱动的
  wake 回合不进入公共回合事件流（该流由控制面的派发回合管线写入），因此
  runs 路由是其生命周期的公共面。
- **D4 — 本臂不带 caller skills。** files/4 准入无条件注入变体，替换路径已
  在 skill 臂有双向见证。省略 caller skills 让本臂最小，避免重复该见证。
- **D5 — 清理腿是模型回合。** `/loop clear` 驱动真实 `cron_delete`，结果必须
  陈述铸造 id 的退役，证明 schedule 触发后仍可取消，且不残留存活的每分钟
  定义。
- **D6 — 守卫在元测试里可执行。** 仅文本钉子不证明守卫运行（#17470 round-2
  教训）：守卫是顶层纯声明，元测试经既有 load/extracted harness 加载它，
  演练每个抛错方向与通过。

## 涉及文件

| 文件                                                               | 变更                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `scripts/run-managed-agent-server-e2e.ts`                          | `--loop-fire` flag、排他、usage、scan-delay env、假模型分支、场景、守卫、结果 JSON |
| `scripts/tests/managed-agent-server-e2e.test.js`                   | 臂钉子测试 + 守卫可执行断言                                                        |
| `scripts/tests/hosted-process-ci.test.js`                          | failoverArms 行、flag 排他、ceiling 表、臂数注释                                   |
| `package.json`                                                     | `test:e2e:managed-loop-fire` 脚本                                                  |
| `.github/workflows/sdk-java.yml`                                   | 新臂步骤、job ceiling 325、臂数注释                                                |
| `docs/design/2026-11-17-managed-loop-fire-e2e.md` + `.zh-CN.md`    | 本设计                                                                             |
| `docs/design/2026-11-14-managed-loop-skill-asset.md` + `.zh-CN.md` | out-of-scope 句注明跟进臂                                                          |

## 范围边界

- 仅 `scheduled` trigger。`manual` 与 `catch_up` 范围外；守卫拒绝 manual
  occurrence 作为见证。
- 无 gate 探针：files/4 不声明 Shell lane，gate 在 create 时即被拒。带 gate
  的触发范围外。
- overlap 与 catch-up 策略、多次触发耐久、自定步调 `loop_wakeup` 姊妹切片
  范围外。观察一次触发后即退役。
- 模型是假的；其余一切（MySQL、Spring scanner、Harness 中继、runtime
  broker、wake pump、事件流）都是真实打包栈。

## 验收标准

- create 与 clear 客户端回合各结算恰好一个 `turn.completed`；create 结果
  点名铸造的 `asch_` id；任何 create round 都不携带 automation 框架。
- create 之后无客户端输入，runs 列表应答一条 `trigger: "scheduled"`、
  `outcome: "fired"`、`state: "completed"` 的 occurrence——run 镜像从 wake
  回合自身的已提交结果结算，证明 harness 驱动的回合跑过且完成（它不进入
  公共回合事件流）。
- 某个流式 round 的最新 user 消息携带含铸造 id、`Trigger: scheduled`、
  occurrence key 与 prompt 标记的框架；账本行的 `occurrence_key` 逐字出现
  在该框架内。
- clear 腿退役铸造 id，delete 结果陈述退役。
- 元测试执行守卫：缺 fired 行、manual trigger、occurrence key 不在 wake
  文本、框架缺铸造 id 各抛错；匹配的见证通过。剪断守卫使可执行断言红而
  文本钉保持绿。
- CI 元测试钉新步骤的名、脚本、flag、timeout、条件与 ceiling 算术；workflow
  尺寸门保持在容差内。
- 本地全栈在合并 main 的构建上绿。变异见证：把 scanner 中继的 `trigger`
  换成 `manual`（重建 jar）使臂在守卫处红而 wake 回合仍跑；还原字节并重建
  复绿。

## 开放问题

无阻塞项。臂名、一分钟节奏与 150s wake 预算已在上面决定；节奏是 cron 最小
粒度，不伪造时钟就无法缩短等待，而 D2 禁止伪造时钟。
