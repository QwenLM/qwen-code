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
   中关于 durable 与过期的措辞不同。
2. **变更经控制面，绝不单独走 funnel。** store 前缀下新增内部路由族——
   `/internal/managed-session-store/v1/sessions/{sessionId}` 上的
   `automations:create`、`automations:list`、`automations:retire`——
   与 `memory:query` 完全相同地以 writer 绑定鉴权，从绑定 Session 的
   创建者推导 actor，并委托 `ManagedAutomationService`。委托继承创建者
   检查、部署开关、模式门、容量检查、command 账本与镜像写入。直接
   funnel 调用被拒绝作为创建路径：仅存 journal 的 definition 没有镜像
   行，scanner 永远不会触发它——使 definition 可被发现的是路由，不是
   funnel。
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
   校验；其无人值守审批由安排时分类器审查覆盖（姊妹设计决策 9 的
   模式），正如 managed gate 设计已为 definition 作者规定的那样。
5. **本切片不做自动过期。** legacy 的 7 天过期没有 definition 字段；
   工具创建的 definition 持续存在直到被退役，与经公开 API 创建的完全
   一致。预算是每 Session 容量、每次 fire 的 turn 计价、以及让安静
   监视变便宜的 gate 探针。该对等差距记录为开放问题，不予隐藏：
   managed skill 变体告知用户任务会一直运行直到取消。
6. **list 读 scanner 的真相；delete 即 retire。** `cron_list` 从控制面
   账本应答——与 scanner 读取的同一批行，按公开 list 的方式分页——且
   `create` 在应答前完成镜像，因此创建后的 list 是一致的。`cron_delete` 即退役：中继提交
   终态 journal 修订版，镜像随之退役；退役已退役的 definition 应答
   重放，非 ACTIVE 的 Session 走继承的本地退役兜底。唤醒取消属于姊妹
   切片的 `loop_cancel`，不属于本工具。
7. **fire 原样走现有流水线。** 到期 slot 成为 `automation_run`，其
   input 与 wake 同事务提交，wake pump 执行 turn，turn settle 该
   run——overlap 策略、公开 Turn 抑制、catch-up、gate 探针全部像对待
   公开 API definition 一样适用。skill 的立即首次执行就是当前 turn；
   不为其新增机制。
8. **工具面随下一批 profile 修订版发布。**
   `hosted-workspace-files/4`、`hosted-workspace-shell/2`、
   `hosted-workspace-team-lead/2` 声明 cron 三件套，沿用 `files/3`
   先例；版号假设本切片先落地，若姊妹切片先落地则两族互换。准入要求
   `qwen.managed-agent.automation.enabled`。read profile 永不声明
   它们。姊妹切片的 loop 三件套按落地顺序取其后的一批修订版。managed loop skill 变体作为 skill 资产经现有 Session Skills
   发布；其可见性与工具一同门控，对应本地 `BundledSkillLoader` 在
   cron 关闭时隐藏 `cron_` skill 的规则。
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
| 4    | `cron_list`               | 内部 `automations:list` 路由应答账本页                                                                                                                            |
| 5    | `cron_delete`             | 内部 `automations:retire` 路由中继 `retire_schedule` 并退役镜像；已退役的 id 应答重放                                                                             |
| 6    | 被重驱动的执行            | 同一 `executionCallId` 推导同一 key；控制面应答重放，绝不产生第二个 definition                                                                                    |

## 契约触点

- 新的内部 controller（`ManagedMemorySessionController` 的形状）承载
  三个动词，配 `SurfaceRegistry` 条目、OpenAPI 内部面、
  `ManagedAgentApiContractTest`、`SurfaceRegistryGateTest` 与
  `managed-surface.txt` fixture。
- `ManagedAutomationService`：无语义变更；controller 推导创建者 actor
  并委托。
- `packages/cli/src/serve/hosted-workspace-profiles.ts` 与 Hosted 工具
  turn：新 profile 修订版、cron 三件套的声明与执行接线，经现有 store
  通道（`baseUrl` + writer 绑定）调用内部路由。
- managed loop skill 变体，作为 Session Skills 发布中的 skill 资产。
- `packages/cli/src/serve/capability-parity.ts`：cron 三件套 Managed
  地位的条目。
- 无 journal schema 变更：无新事件种类，无新 payload 字段。

## 验证计划

- 内部路由准入：要求 writer 绑定；外部 Session 或 tenant 被拒绝；
  actor 是绑定 Session 的创建者；部署开关关闭时拒绝每个动词。
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
- 失败划分：503 以同一 key 重驱动；pre-commit 拒绝释放 key；丢失的
  应答被重放。
- skill E2E：`/loop 5m …` 创建 definition 并立即执行 prompt；
  `/loop list` 展示它；`/loop clear` 退役它。
- 变异检查：逐个禁用各决策的守卫都会使某个测试失败（镜像写入、推导
  key、一次性拒绝、durable 拒绝、创建者推导、gate）。

## 验收标准

- Managed Session 中的 `/loop 5m …` 创建一个 definition，scanner 在下
  一个到期 slot 触发它，fire 作为 automation turn 到达同一 Session。
- 被重驱动的工具执行绝不创建第二个 definition。
- 仅提交进 journal 的 definition 永不触发：内部路由而非 funnel 才是
  创建路径。
- `/loop list` 与 `/loop clear` 对工具创建的 definition 有效。
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
