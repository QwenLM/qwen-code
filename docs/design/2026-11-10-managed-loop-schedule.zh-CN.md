# Managed loop 定时任务（/loop 的固定间隔分支）

[English](2026-11-10-managed-loop-schedule.md) | [简体中文](2026-11-10-managed-loop-schedule.zh-CN.md)

状态：提案，尚未实现。这是 Managed Session 支持 `/loop` 的固定间隔分支，
是[自定步调唤醒设计](2026-11-10-managed-loop-wakeup.zh-CN.md)的姊妹篇。
它从 Session 内部创建
[H6 automation definition](2026-10-04-managed-automation.zh-CN.md)，
走 [H6b/H6c 运行时](2026-10-07-managed-automation-runtime.zh-CN.md)
的现有机制；不新增调度器、不新增 journal 事件种类、不新增 payload
字段。

## 问题

`/loop` 的固定间隔路径（按
`packages/core/src/skills/bundled/loop/SKILL.md`，前导间隔 token 或
尾部 "every" 子句）把间隔换算为五字段 cron 表达式，以 `recurring: true`
调用 `cron_create`，然后立即执行 prompt；`/loop list` 与 `/loop clear`
走 `cron_list` 与 `cron_delete`。在 daemon 中这些工具驱动本地
`CronScheduler`，其 durable 任务存放在 daemon 本地文件里。

Managed Session 无法运行这条路径：Hosted 工具 profile 不声明 cron
工具，而本地调度器被禁止触发 Managed 工作（H6 运行时决策 14）。H6 已经
具备周期任务所需的一切——definition、单认领 scanner、run 账本、overlap
与 catch-up 策略、gate 探针、以及唤醒绑定 Session 的 persistent
fire——但 definition 只能由 Session 创建者经控制面公开路由创建。
Session 内部的模型没有任何创建途径。

因此缺口是入口路径，不是机制：一个 Session 侧工具，以与公开路由相同的
权限、幂等与 scanner 可发现性，创建、列出、退役 H6 definition。

## 现状

以下事实来自本仓库 `488845a4a81`。

- **创建流程归控制面所有**（`ManagedAutomationService.java`）。`create`
  检查创建者（`requireCreatorSession`）与部署开关（`requireEnabled`），
  从 tenant 与 `Idempotency-Key` 推导 `scheduleId`，检查每 Session
  容量（`MAX_DEFINITIONS`），认领 command 行（`claimCommand`），向
  Harness funnel 中继 `define_schedule`，镜像已提交的 definition
  （`committedDefinition`），并结算 command（`remember`）。`update` 与
  `retire` 同样在中继前认领；退役已退役的 definition 是其自身的重放，
  非 ACTIVE 的 Session 走本地退役兜底。只有 `PRE_COMMIT_REFUSALS`
  （`automation_mode_disabled`、`automation_gate_unsupported`、
  `automation_gate_invalid`）释放已认领的 key；其他任何应答都保留
  绑定。
- **scanner 读镜像，不读 journal。** `AutomationScanner` 从账本的
  `ScheduleRow` 发现到期 definition。仅提交进 Session journal 的
  definition——绕过控制面的直接 `define_schedule` 调用——没有镜像行，
  永远不会触发。journal 仍是唯一业务事实；镜像是 scanner 读取的可重建
  索引（H6b 决策 12）。
- **Harness funnel**（`hosted-harness-session.ts`，
  `POST /session/:id/automations/operations`）把 `define_schedule`、
  `retire_schedule`、`fire_run` 映射到 `HostedAutomationSession` 动作，
  由推导的 command id 保证重放安全。persistent fire 在同一事务中提交
  run 的 dispatch 及其 input 与 wake；嵌入式 wake pump 将其作为普通
  turn 执行，turn settle 该 run（H6c）。
- **内部 Session 作用域通道已存在。** Harness 经
  `QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` 访问控制面，路径为
  `/internal/managed-session-store/v1/sessions/{sessionId}`，以 writer
  绑定（`WRITER_TOKEN_HEADER`）鉴权。
  `ManagedMemorySessionController` 的 `memory:query` 是该通道上
  Session 作用域操作的先例，由 Hosted 工具调用。
- **工具执行有持久身份。** managed 工具执行器把每次调用记入 journal，
  以其 `executionCallId` 为键并重放其 receipt；被重驱动的执行保持同一
  id。
- **managed 限制与文法**（`managed-automation-operations.ts`、
  `managed-automation-record.ts`）：`maxPromptBytes` 与 `maxInputBytes`
  为 64 KiB，`maxCronBytes` 400，`maxDefinitionsPerSession` 32；cron 是
  五字段数字/范围/列表/步进原子，Vixie 日语义，IANA 时区在准入时解析
  （`automation_timezone_unknown`）。gate 探针已于 2026-10-22 落地，
  与 daemon 的 scheduled-task gate 共享 `gateCommandError`。
- **本地工具契约**（`cron-create.ts`、`cronScheduler.ts`）：`recurring`
  可为 false（一次性），`durable` 缺省为会话专属，recurring durable
  任务在创建 7 天后自动过期（`DEFAULT_RECURRING_MAX_AGE_DAYS`）。
  Hosted skill 走 Session Skills 发布（`managed-agent-skills` 资源）；
  本地 `BundledSkillLoader` 在 cron 关闭时隐藏 `allowedTools` 以
  `cron_` 开头的 skill——可见性门控的先例。

## 目标

- 在 Managed Session 中运行 `/loop` 的固定间隔路径、`/loop list` 与
  `/loop clear`，创建 scanner 能发现并经现有 persistent 流水线触发的
  H6 definition。
- 保持公开路由的权限与幂等：创建者作用域的变更、已认领的 key、重放
  安全的重试、容量与 gate 检查。
- 给模型一个工具名与 skill 的 `allowedTools` 一致的工具面，使 skill 的
  解析与间隔换算表原样复用。
- 不新增调度器、不新增 journal 事件种类、不新增 payload 字段。

## 非目标

- **自定步调分支。** `loop_wakeup` 及其 journal 持久一次性唤醒属于
  [姊妹设计](2026-11-10-managed-loop-wakeup.zh-CN.md)。
- **一次性任务。** legacy `recurring: false` 没有 H6 表示；予以拒绝，
  不做模拟。
- **`per_run` 目标与 channel 投递。** 归 H4/H5 所有；本切片创建的每个
  definition 都是 `persistent`，绑定其自身 Session。
- **Web Shell 调度 UI。** 公开读取路由已为其服务。
- **改动 scanner、funnel 或 fire 流水线。** 本切片是接入它们的入口
  路径。

## 决策

1. **工具保留 legacy 名称，语义为 Managed。** `cron_create`、
   `cron_list`、`cron_delete` 由 Hosted profile 以 Managed 描述声明，
   正如今天 `write_file`/`edit` 携带 profile 专属文本。skill 的
   `allowedTools` 与其间隔换算表因此原样复用；只有 managed skill 变体
   中关于 durable 与过期的措辞不同。并集的 list/cancel 工具面（决策 6）
   使 `list`/`clear` 子命令无需改白名单即可工作。
2. **变更经控制面，绝不单独走 funnel。** store 前缀下新增内部路由族——
   `/internal/managed-session-store/v1/sessions/{sessionId}` 上的
   `automations:create`、`automations:list`、`automations:retire`——
   与 `memory:query` 完全相同地以 writer 绑定鉴权，从绑定 Session 的
   创建者推导 actor，并委托 `ManagedAutomationService`。内部路由是 Session
   作用域而非 actor 作用域：`create` 的目标是绑定 Session；`list` 在
   分页前按绑定 Session 过滤——服务的 actor 作用域 `list` 读取创建者
   在整个 Workspace 可读的全部 definition，会让一个 Session 的 writer
   看到另一个的；`retire` 在执行或应答重放前验证目标 definition 属于
   绑定 Session。仅凭创建者 actor 不提供这种隔离：同一用户可以创建多个
   Session。此作用域是内部路由专属的 carve-out——公开 controller 以无
   绑定 Session 调用同一服务、保留其 actor 作用域，因此变更绝不能回归
   公开 API。作用域落在服务/账本内部，过滤发生在分页 limit 之前、`next`
   游标从过滤后的流推导——controller 侧后置过滤会先切页再返回错误游标。
   内部 `list` 用覆盖每 Session 容量的页大小（账本的 100 行上限），使满
   Session 一页装下。委托继承创建者检查、模式门、容量检查、command 账本
   与镜像写入。部署开关门控创建，同时也停掉 scanner
   （`AutomationScanner.scan` 在同一设置上提前返回），因此开关关闭期间
   已武装的 definition 停止触发。`list` 今天已解门控、保持可用；`retire`
   今天调用 `requireEnabled`，因此切片为内部路由解门控（一处代码变更，
   非现有行为），使运维能退役开关停掉的东西。直接 funnel 调用被拒绝作为
   创建路径：仅存 journal 的 definition 没有镜像行，scanner 永远不会触发
   它——使 definition 可被发现的是路由，不是 funnel。
3. **Idempotency-Key 从工具执行的身份推导。** 每个变更使用从其
   `executionCallId` 与动词推导的 key（例如
   `loop:<executionCallId>:create`，符合 key 的 1–128 可打印 ASCII
   界限）。receipt 丢失后被重驱动的执行复用该 key，因此控制面重放已
   提交的 definition，而不是铸造第二个；重试
   绝不铸造新 key。工具执行器的 journal 拥有至多一次执行语义，推导的
   key 把该保证延伸到控制面，无需新状态。
4. **参数契约映射到 definition，拒绝 H6 无法表示者。** `recurring`
   必须为 true——一次性以类型化消息拒绝。`durable: false` 被拒绝：
   Managed definition 永远 durable，静默接受该 flag 会承诺平台并不
   具备的会话专属生命周期；缺省即 durable。`timezone` 是可选 IANA
   名称，默认 UTC，与每个 definition 一样在准入时解析。prompt 遵守
   `maxPromptBytes` 与包装输入界限；cron 遵守 `maxCronBytes` 与 H6a
   文法。可选 `gate` 透传到 definition，由共享的 `gateCommandError`
   校验。安排时分类器审查是对模型创建 definition 的新增要求，而非
   managed gate 设计已规定的内容——该设计的作者审批路径没有分类器。
   分类器输入同时覆盖续跑 prompt 与 gate 命令，沿用姊妹设计决策 9 的
   模式。
5. **本切片不做自动过期。** legacy 的 7 天过期没有 definition 字段；
   工具创建的 definition 持续存在直到被退役，与经公开 API 创建的完全
   一致。预算是每 Session 容量、每次 fire 的 turn 计价、以及让安静
   监视变便宜的 gate 探针。该对等差距记录为开放问题，不予隐藏：
   managed skill 变体告知用户任务会一直运行直到取消。
6. **list 与 delete 覆盖两个分支，与本地一致。** `cron_list` 应答并集：
   绑定 Session 的 definition 来自控制面账本——与 scanner 读取的同一批
   行——加上 wakeup 切片落地后来自 journal 的未触发 pending loop input。
   本设计拥有并集契约；wakeup 姊妹篇引用它而非复述。内部 `list` 一页返回
   满 Session（决策 2 覆盖容量的页大小），但公开 list 默认 20 行而一个
   Session 可持有 32 个 definition，因此 `cron_list` 无论如何走完每一页
   再应答（单个 journal 唤醒随最后一页一起返回）；未改动的 skill `clear`
   配方——list 后 delete 每个返回 id——因此清空整个 Session。`create` 在
   应答前完成镜像，因此创建后的 list 是一致的。
   `cron_delete` 按 id 路由：definition id 走退役（中继提交终态 journal
   修订版，镜像随之退役；退役已退役的 definition 应答重放，非 ACTIVE 的
   Session 走继承的本地退役兜底）；`loop:<wakeupId>` id 经姊妹切片的仅
   journal 消费取消唤醒，受其先前尝试守卫。`cron_list` 渲染的唤醒 id 与
   `cron_delete` 接受的完全一致（`loop:<wakeupId>`），因此从 list 直接
   喂给 delete 的 id 取消该唤醒——本地形状，`cron_list` 本就列出唤醒
   （`@wakeup`）、`CronScheduler.delete` 本就 fall-through 到
   `cancelWakeup`，前缀由 list 产生、由 delete 消费。skill 的
   `list`/`clear` 子命令原样复用。
7. **fire 原样走现有流水线。** 到期 slot 成为 `automation_run`，其
   input 与 wake 同事务提交，wake pump 执行 turn，turn settle 该
   run——overlap 策略、公开 Turn 抑制、catch-up、gate 探针全部像对待
   公开 API definition 一样适用。skill 的立即首次执行就是当前 turn；
   不为其新增机制。
8. **工具面随下一批 profile 修订版发布。**
   `hosted-workspace-files/4`、`hosted-workspace-shell/3`、
   `hosted-workspace-team-lead/2` 声明 cron 三件套，沿用 `files/3`
   先例；版号假设本切片先落地，若姊妹切片先落地则两族互换。`shell/2`
   被有意跳过：它是已退役标识符，由
   [2026-10-23 Shell profile 设计](2026-10-23-managed-shell-profile.zh-CN.md)
   撤回并被回归测试钉死，重新启用会反转它们。`cron_create` 的准入要求
   `qwen.managed-agent.automation.enabled`；`cron_list` 与
   `cron_delete` 在开关关闭时仍声明且可用（决策 2）。read profile 永不
   声明它们。姊妹切片在其后的一批修订版上新增 `loop_wakeup`，并把
   `cron_list`/`cron_delete` 扩展到决策 6 的并集——工具名是持久化词汇，
   行为可以生长；无论哪个切片先落地都由它声明 `cron_list`/`cron_delete`。
   managed loop skill 变体作为 skill 资产经现有 Session Skills 发布，
   `allowedTools` 与 bundled skill 相同；其可见性与工具一同门控，对应
   本地 `BundledSkillLoader` 在 cron 关闭时隐藏 `cron_` skill 的规则。
9. **失败语义区分可重试与终态。** 传输故障或 503 使工具执行保持
   pending；重驱动推导同一 key，遇到认领或重放。`PRE_COMMIT_REFUSALS`
   与其他所有确定性 4xx（容量、冲突、文法、时区）是携带类型化 code 的
   终态工具错误；服务仅对 pre-commit 拒绝释放 key，与公开路由完全
   一致。应答丢失的已提交 definition 由重放应答，绝不重新创建。
10. **预算是继承的，不是新的。** 每 Session 32 个 definition 的容量、
    每次 fire 的 turn 与工具计价、gate 探针就是全部预算；不新增配额
    表。被遗忘的 loop 在 `cron_list` 中可见、可用 `cron_delete` 取消，
    其 definition 就是运维已经在管理的同一批账本行。

## 流水线，逐步

| 步骤 | 位置                      | 提交                                                                                                                                                              |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `cron_create`（工具执行） | 执行器以 `executionCallId` 记录 intent；内部 `automations:create` 路由认领推导的 key，中继 `define_schedule`，镜像 definition，结算 command；工具应答 schedule id |
| 2    | skill 的立即首次执行      | 当前 turn——无新机制                                                                                                                                               |
| 3    | scanner tick              | 镜像行的到期 slot 成为 occurrence；`fire_run` 提交 run、其 input 与 wake；wake pump 执行 turn；turn settle 该 run                                                 |
| 4    | `cron_list`               | 内部 `automations:list` 路由走完每一账本页并加上未触发 pending 唤醒；工具应答完整并集，每个唤醒 id 渲染为 `cron_delete` 接受的形式                                |
| 5    | `cron_delete`             | definition id 中继 `retire_schedule` 并退役镜像（已退役的 id 应答重放）；`loop:<wakeupId>` id 路由到姊妹切片的仅 journal 取消                                     |
| 6    | 被重驱动的执行            | 同一 `executionCallId` 推导同一 key；控制面应答重放，绝不产生第二个 definition                                                                                    |

## 契约触点

- 新的内部 controller（`ManagedMemorySessionController` 的形状）承载
  三个动词，配 `SurfaceRegistry` 条目、OpenAPI 内部面、
  `ManagedAgentApiContractTest`、`SurfaceRegistryGateTest` 与
  `managed-surface.txt` fixture。
- `ManagedAutomationService`：controller 推导创建者 actor 并委托；内部
  路由的 list/retire 在服务/账本内部变为 Session 作用域（分页 limit 前
  过滤、正确的 `next` 游标、覆盖容量的页大小），作为保留公开 actor 作用域
  路由不变的 carve-out。`retire` 为内部路由解门控（它今天调用
  `requireEnabled`——一处代码变更）；`list` 已解门控；创建仍受门控。
- `packages/cli/src/serve/hosted-workspace-profiles.ts` 与 Hosted 工具
  turn：新 profile 修订版（跳过已退役的 `shell/2`）、cron 三件套的声明
  与执行接线，经现有 store 通道（`baseUrl` + writer 绑定）调用内部
  路由。Shell 身份并非集中式：profile 谓词
  （`isHostedWorkspaceShellProfile` 等）、比较字面量
  `hosted-workspace-shell/1` 的准入路径、控制面的规范 Shell 准入都必须
  识别 `shell/3`，否则 `shell/3` Session 会失去 shell lane、child-agent
  与 foreground-only 准入。列出 `files/4` 的 unknown-profile fixture 在
  同一改动中翻转。
- managed loop skill 变体，作为 Session Skills 发布中的 skill 资产。
- `packages/cli/src/serve/capability-parity.ts`：cron 三件套 Managed
  地位的条目。
- 无 journal schema 变更：无新事件种类，无新 payload 字段。

## 验证计划

- 内部路由准入：要求 writer 绑定；外部 Session 或 tenant 被拒绝；
  actor 是绑定 Session 的创建者；部署开关关闭时拒绝 create 但不拒绝
  list/retire。
- Session 隔离：同 tenant、同创建者、两个 Session——一个 Session 的
  writer 既不能列出也不能退役另一个的 definition，create 的目标永远
  是绑定 Session。分页语义：在其他 Session 之间持有 32 个 definition 的
  绑定 Session 第一页返回全部 32 个、无后续游标。
- 重放：同一 `executionCallId` 的重驱动执行应答同一 `scheduleId` 并带
  重放标记；同一 key 下不同 body 应答冲突。
- scanner 发现：工具创建的 definition 在下一个到期 slot 触发；仅存
  journal 的 definition（无镜像行的直接 funnel 探针）永不触发——镜像
  承重的见证。
- 参数矩阵：一次性、`durable: false`、不可解析时区、文法非法 cron、
  超限 prompt、非法 gate 各自以类型化 code 被拒绝；合法 gate 随
  definition 与 fire 生效。
- 创建后 list 的一致性；delete 幂等；非 ACTIVE Session 的本地退役
  兜底。
- 并集工具面（wakeup 切片落地后）：`cron_list` 返回 definition 加未触发
  pending 唤醒；`cron_list` 发出的 id 直接喂给 `cron_delete` 把 pending
  loop input settle 为 `cancelled`/`loop_cancelled`；definition id 走
  退役。21+ 个 definition 时 `cron_list` 返回每个 id，`/loop clear` 后
  零个存活 definition。
- profile 准入：已退役的 `hosted-workspace-shell/2` 仍被拒绝；
  `hosted-workspace-shell/3` Session 保留 shell lane、child-agent 与
  foreground-only 准入；列出 `files/4` 的 unknown-profile fixture 在
  准入它的同一改动中翻转。
- 失败划分：503 以同一 key 重驱动；pre-commit 拒绝释放 key；丢失的
  应答被重放。
- skill E2E：`/loop 5m …` 创建 definition 并立即执行 prompt；
  `/loop list` 展示它；`/loop clear` 退役它。
- 变异检查：逐个禁用各决策的守卫都会使某个测试失败（镜像写入、推导
  key、一次性拒绝、durable 拒绝、创建者推导、Session 作用域、开关关闭
  时的 list/retire、gate）。

## 验收标准

- Managed Session 中的 `/loop 5m …` 创建一个 definition，scanner 在下
  一个到期 slot 触发它，fire 作为 automation turn 到达同一 Session。
- 被重驱动的工具执行绝不创建第二个 definition。
- 仅提交进 journal 的 definition 永不触发：内部路由而非 funnel 才是
  创建路径。
- `/loop list` 与 `/loop clear` 对工具创建的 definition 有效，wakeup
  切片落地后也覆盖 pending 唤醒。
- 一个 Session 的 writer 不能列出或退役另一个 Session 的 definition，
  即使创建者相同。
- 无新 journal 事件种类或 payload 字段；无第二个调度器。

## 开放问题

1. **自动过期对等。** legacy 的 7 天过期防范被遗忘的 loop；本切片不带
   它发布。决定日后的 definition 字段（`expiresAt`）是否值得契约变更，
   还是运维可见的账本行加 gate 已足够。
2. **时区默认值。** 提案为 UTC；确认 skill 变体是否应改为解析用户
   时区，以及从哪里解析。
3. **一次性支持。** legacy `recurring: false` 需要 H6 契约扩展（一次性
   trigger kind）；延后，在此之前以类型化消息拒绝。
4. **skill 资产打包。** 哪个 AgentBundle 携带 managed loop 变体、以及
   两个切片只落地其一时 skill 如何降级，随 bundle 的 skill 准入决定。
