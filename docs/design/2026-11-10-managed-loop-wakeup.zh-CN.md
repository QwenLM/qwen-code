# Managed 自定步调 loop 唤醒

[English](2026-11-10-managed-loop-wakeup.md) | [简体中文](2026-11-10-managed-loop-wakeup.zh-CN.md)

状态：提案，尚未实现。这是 Managed Session 支持 `/loop` 的自定步调分支，
是 [H6 automation 设计](2026-10-04-managed-automation.zh-CN.md)及其
[运行时](2026-10-07-managed-automation-runtime.zh-CN.md)的后续工作。它复用
[Shell/Monitor 运行时](2026-10-03-managed-shell-monitor-runtime.zh-CN.md)
的 H3 嵌入式 wake 调度器，以及
[H0c](2026-09-27-managed-extension-authority.zh-CN.md)的 input/wake 权限机制。
`/loop` 的固定间隔分支在
[姊妹设计](2026-11-10-managed-loop-schedule.zh-CN.md)中映射到 H6
automation definition；本设计不创建任何 definition。

## 问题

`/loop`（bundled skill，位于
`packages/core/src/skills/bundled/loop/SKILL.md`）反复执行一个 prompt。
它的自定步调路径——仅 prompt、自主模式、`loop.md` 动态 sentinel——用
`loop_wakeup` 安排下一个 tick，该工具调用
`CronScheduler.scheduleWakeup`：一个秒级精度、纯内存、会话专属的一次性
唤醒，随进程消亡，从不持久化。

Managed Session 今天无法运行这条路径：

- Hosted 工具 profile（`hosted-workspace-profiles.ts`：
  `hosted-workspace-files/1`–`/3`、`hosted-workspace-shell/1`、
  `hosted-workspace-team-lead/1`、`hosted-workspace-read/1`）不声明
  `loop_wakeup`，也没有 cron 工具，Hosted skill catalog 不含 loop skill。
- 即使暴露了该工具，内存唤醒也撑不过 Harness 重启或接管；而 daemon 本地
  调度器被禁止触发 Managed 工作：H6 运行时设计决策 14 把
  `cronScheduler.ts` 排除在 Managed definition 之外，H6 设计把
  「第二个调度器或模型循环」列为 non-goal。

因此唤醒必须成为 Session journal 中的事实，由现有嵌入式 wake pump 投递，
保留本地工具的语义并约束其预算——不引入控制面 scanner、schedule 记录，
也不引入任何新调度器。

## 现状

以下事实来自本仓库 `488845a4a81`。

- **本地语义**（`packages/core/src/services/cronScheduler.ts`、
  `packages/core/src/tools/loop-wakeup.ts`）。`scheduleWakeup` 把延迟
  clamp 到 `[WAKEUP_MIN_SECONDS, WAKEUP_MAX_SECONDS]` = `[60, 3600]`
  秒；非有限输入回退到 1200 s 默认心跳。每个调度器只有一个 pending
  唤醒：新安排会替换它（`replacedId`）。链锚点（`wakeupChainStartedAt`）
  在首次成功安排时设置，仅由 `stop()`/`destroy()` 重置；触发时刻将超过
  锚点加 `WAKEUP_CHAIN_MAX_AGE_MS`（24 h）的安排会被拒绝，且先丢弃原有
  pending 唤醒*再*做预算检查，因此被拒绝的重新安排不会留下任何东西。
  已触发的唤醒在其 turn 运行前就立即离开 pending map。
  `cancelWakeup(id)` 与 `cancelAllWakeups()` 不经过模型 turn 即消费
  pending 唤醒。工具的 `getDefaultPermission()` 返回 `'ask'`，
  `toAutoClassifierInput()` 把续跑 prompt 转交 AUTO 分类器，因为调度
  未来模型输入是有副作用的。prompt schema 把 `prompt` 上限设为 10000
  字符。本地 `cron_list` 把唤醒与 cron 任务一同列出（`@wakeup`），
  `CronScheduler.delete` fall-through 到 `cancelWakeup`——Managed 工具面
  保留的正是这个并集形状。
- **Hosted wake 机制**（`packages/cli/src/serve/hosted-wake-intake.ts`、
  `hosted-monitor-wake.ts`、`hosted-harness-session.ts`）。一个 input 以
  `input.accepted` 加权限机制生成的 `wake.requested` 在同一事务中提交
  （`managed-session-authority.ts` 的 `inputEvents`）。
  `pendingSessionInputs` 仅从 journal 推导 pending 集：一个 input 恰好
  在其 `turnId` 下有 turn settle 时被消费。
  `HostedMonitorWakeScheduler` 选取最旧的 pending wake input
  （`isWakeInputSource`：`monitor`、`channel`、`automation`、child
  通知、session message），立即将其作为普通文本 turn 执行；它没有延迟
  投递概念。重试节奏为 500 ms（busy/blocked）与 15 s（held）。
  `settlePendingMonitorInputs` 在 close 路径上以无模型方式 settle 未启动
  的通知 input，并由 `wakeHasPriorAttempt` 守卫：已启动的 turn 归恢复
  机制所有。
- **input 契约是封闭的**（`managed-session-records.ts`，
  `EVENT_SCHEMAS`）。`input.accepted` 恰好携带 `inputId`、`turnId`、
  `source`、`contentRef`、`deadline`、`admissionRef`。`deadline` 已有
  含义——G3 step-3 恢复与 team-member 30 分钟限制读取的绝对 turn 截止
  时间——因此不得挪用作唤醒触发时刻。该 schema 有可选字段先例
  （`activation.changed` 的 `renewalSeq`）。envelope 是携带 `{ text }`
  的 `managed-input` 资源；`admissionRef` 是 `managed-admission` 资源
  （monitor 发布 `{}`）。
- **H6 automation** 仅通过控制面公开路由创建 definition，用 scanner 的
  lease/fence 账本触发，并从各自的 turn settle 每个 run。一次性自定步调
  唤醒不需要其中任何一环，也不得在此复制其中任何一环。

## 目标

- 在 Managed Session 中运行 `/loop` 的自定步调路径，保留本地工具语义：
  clamp、默认心跳、单 pending、替换、24 h 链上限、取消应答。
- 让唤醒在 Session journal 中持久：Harness 重启或接管后重新推导，过期
  唤醒恰好迟触发一次。
- 复用 H3 嵌入式 wake pump 作为唯一投递机制；不引入控制面 scanner、
  `schedule`/`automation_run` 记录，不引入第二个调度器。
- 以结构约束预算：每 Session 一个未触发唤醒、24 h 链、现有 input
  尺寸限制。

## 非目标

- **固定间隔分支。** `/loop 5m …` 映射到 H6 automation definition（在
  现有 `define_schedule` funnel 之上加一个 Session 侧创建工具）；那是
  另一个切片。
- **Gate 探针。** 自定步调 loop 自行决定续跑；managed automation gate
  解决的是 cron 监视每个 slot 的成本，不适用于此。
- **Channel 投递（H5）与 `per_run` 目标（H4）。** 唤醒的结果留在其
  Session 的 transcript 中。
- **Web Shell 调度 UI。** 基于 journal 的读取可以展示 pending 唤醒；
  本设计不设计新的变更面。
- **迁移本地 `CronScheduler`。** daemon 与 TUI 的行为保持不变。

## 决策

1. **唤醒是 Session input，不是 schedule。** 安排时把 prompt 发布为
   `managed-input` 资源（`{ text }`，逐字——不加控制句，与
   `AUTOMATION_RUN_INSTRUCTION` 不同：续跑指令是模型自己的指令），并
   发布一个安排时的 `managed-admission` 资源，记录请求与 clamp 后的
   延迟、reason、分类器裁决。然后在同一 journal 事务中提交 source 为
   `loop` 的 `input.accepted` 与权限机制生成的 `wake.requested`。input
   与 turn id 为 `loop:<wakeupId>`，每次安排使用新的 `wakeupId`。
   autonomous 与 `loop.md` sentinel（`<<autonomous-loop-dynamic>>`、
   `<<loop.md-dynamic>>`）逐字存入 envelope，在触发时而非安排时展开：
   funnel 在 pump 选取 input 时展开它们，对应本地的触发时展开。展开
   复用共享的 loop-task-file 读取器，因此携带本地守卫而非裸文件读取：
   项目 `.qwen/loop.md` 仅在 Hosted 信任门判定工作区受信任时读取（该门的
   求值模型由切片钉住；本地读取器的 `allowProjectFile` 默认 false），
   否则读 home 文件（进程全局 `QWEN_HOME`）或 absent-file tick；内容按
   `LOOP_TASK_FILE_MAX_BYTES`（25 000）字节截断并带本地截断警告；文件
   缺失收敛到 autonomous tick，瞬时读取失败收敛到 no-op re-arm tick，
   因此抛错的 turn 绝不会永久终结 loop。由于安排时分类器审查的是
   sentinel 常量而非文件文本，展开是分类器可见的：`managed-admission`
   记录持久化上次审查的内容，解析内容与该上次审查值不同的 fire 在运行前
   被重新审查——稳态不变内容不在每个 tick 重审。被拒绝的重审把 input
   settle 为 `cancelled`、stop reason `loop_admission_denied`（终结
   loop），而非永远重新选取或静默丢弃。任务文件的变更因此在下一触发时
   被拾取，重启或压缩后重新提供完整指令。不产生 `schedule`
   或 `automation_run` 记录、不产生控制面行、不涉及 scanner：journal 是
   唯一事实，与 monitor 通知完全一致。
2. **`notBefore` 是 `input.accepted` 新增的可选 payload 字段**
   （`timeOrNull`），loop 唤醒是它的第一个生产者。语义：`notBefore`
   在未来的 input 不得在该时刻之前启动 turn；`deadline` 保留其现有
   含义。该字段在契约中与 source 无关，后来的生产者（例如定时 channel
   投递）无需再改 schema 即可继承。投递元数据属于 payload——
   `deadline`/`admissionRef` 先例——这让 pump 的延迟判定与所有
   list/cancel 读取都只走 journal。备选方案是把触发时刻放进
   `managed-input` envelope：它避免契约变更，但把一次 Store 读取放上
   延迟判定路径，并对仅读 journal 的消费者隐藏该事实；予以否决。封闭
   schema 增加一个可选字段（`EVENT_SCHEMAS`、`managed-event-envelope-v1`
   schema 与 fixtures、`managed-session-store-v1` fixtures），由
   TypeScript 与 Java 共同重放；现有生产者省略该字段，所有现有 fixture
   保持逐字节不变。
3. **pump 延迟投递，而非轮询。** `next()` 跳过 `notBefore` 在未来的
   input，选取最旧的*已到期* wake input，并报告它跳过的最早未来
   `notBefore`；调度器在该时刻恰好安排一个定时器，而不是走 500 ms 重试
   节奏。一次 kick（新安排、取消、加载）重新求值。未到期的 loop input
   绝不阻塞其后已到期的 monitor/channel/automation input：延迟是按
   input 的，不是队头停泊。`pendingSessionInputs` 透传 `notBefore`，
   选取仍是一次 journal 读取。
4. **准入以原子方式强制执行本地语义。** 延迟 clamp 到 `[60, 3600]` s，
   非有限输入取 1200 s 默认；prompt 必须非空、至多 10000 字符，且包装
   后的 envelope 至多 `MANAGED_AUTOMATION_LIMITS.maxInputBytes`
   （64 KiB）。每 Session 至多一个未触发的 loop input——即一个没有
   先前尝试的 pending input。一次安排在提交新 input 的同一事务中替换
   这样的 input（被替换 input 的 `turnId` 以 stop reason
   `loop_replaced` settle 为 `cancelled`），受与 close 路径相同的
   `wakeHasPriorAttempt` 守卫。turn 已启动的 input 绝不被替换：正常的
   续跑正是在 firing turn 中安排下一个唤醒，而该 input 保持 pending
   直到 `turn.settled` 消费它——本地已触发的唤醒在触发时就离开
   pending map，journal 模型通过让 firing input 自然 settle、新 input
   与其共存来复现这一点。链锚点是 Session 首个已提交 `loop` input 的
   `occurredAt`——从 journal 推导，跨重启稳定；取消不重置它。触发时刻
   （`now + clampedDelay`）超过锚点加 24 h 的安排被拒绝，且未触发的
   替换在同一判定中丢弃，因此被拒绝的重新安排不留下任何未触发的
   pending 唤醒——本地的先丢弃后检查规则，由事务使其原子化；firing
   input 绝不被丢弃。turn-result 固定的 `turn:<turnId>` 事件 id 是提前
   settle 不合法的第二条理由：它会与运行中 turn 自己的 settle 冲突。
5. **触发是普通文本 turn；续跑是模型的事。** 现有 `runTurn` 路径在该
   input 的 `turnId` 下投递 envelope 文本；`turn.settled` 消费该
   input。loop 仅在该 turn 安排了另一个唤醒时才继续。loop turn 内部的
   崩溃走现有 wake 善后（journal 无法证明任何一方时以
   `outcome_unknown` 记 `failed`）；没有任何自动重新安排，因此崩溃的
   tick 终结 loop，除非后续 turn 将其复活。
6. **过期唤醒恰好迟触发一次。** 重启从 journal 重新推导 pending 集；
   `notBefore` 在过去即立即到期。无需维护 catch-up 计数：任何时刻至多
   一个未触发唤醒 pending，且其 turn 消费它，故至多触发一次。链预算在安排时
   检查，因此预算内安排的唤醒可能在 24 h 标记之后触发——本地契约的
   读法相同。
7. **取消是仅走 journal 的消费，由 `cron_delete` 路由。** 传给
   `cron_delete` 的 `loop:<wakeupId>` id 把 pending input 的 `turnId` 以
   stop reason `loop_cancelled` settle 为 `cancelled`，受与 close 路径
   相同的 `wakeHasPriorAttempt` 守卫：turn 已启动的唤醒归恢复机制所有，
   取消被拒绝。应答是幂等的——不 pending 的 id 应答「未取消」，对应
   `cancelWakeup` 的布尔值。`/loop clear` 走 skill 现有的
   `cron_list` + `cron_delete` 路由，取消那一个未触发的 pending 唤醒。
   close 路径把 `loop` 加入其无模型 settle 的 source 集，settle 未触发的
   pending `loop` input（`wakeHasPriorAttempt` 过滤排除 firing 那个）。
   firing loop turn 不被无模型 settle：close 中止它，由现有 wake 恢复善后
   settle 它，正像任何已启动的 wake turn——在已运行的 turn 上再写一条
   `cancelled` 会与其固定的 `turn:<turnId>` settle 冲突（决策 4）。两者
   合起来使下次打开时没有 pending `loop` input 遗留为
   `hosted_turn_recovery_required`。
8. **工具面是 `loop_wakeup` 加共享的 cron list/cancel。** `loop_wakeup`
   由可写 profile 的新修订版声明，沿用添加 `todo_write` 的 `files/3`
   先例。profile 修订版是持久化词汇，因此每个切片各自发布自己的修订版：
   [固定间隔姊妹设计](2026-11-10-managed-loop-schedule.zh-CN.md)为其
   cron 三件套钉住下一批修订版号，本切片取其后的一批（版号在落地时按
   落地顺序分配）；无论哪个切片先落地都由它声明
   `cron_list`/`cron_delete`，本切片把它们扩展到并集——`cron_list`
   加上未触发的 pending loop input（id、触发时刻、prompt），
   `cron_delete` 把 `loop:<wakeupId>` 路由到决策 7 的取消。不存在
   `loop_list` 或 `loop_cancel`：本地工具本就覆盖两类，skill 的
   `allowedTools` 保持不变。read profile 永不声明 `loop_wakeup`。
   部署开关 `qwen.managed-agent.loop.enabled`（环境变量
   `QWEN_MANAGED_AGENT_LOOP_ENABLED`）在验收证据落地前默认 false，
   对应 automation 的 opt-in 历史。开关只门控安排：关闭时
   `loop_wakeup` 被拒绝，但已安排的唤醒存活——pump 投递 journal input
   不看工具是否声明——且 `cron_list`/`cron_delete` 仍能列出并取消它。
   由于该取消是模型调用的工具，运维还有一条非模型路径：控制面的内部
   Session 路由仅走 journal settle pending loop input，独立于工具面与
   开关。因此关闭功能绝不遗留它已安排的东西。
9. **安排时分类器审查取代交互对话框。** 本地工具返回 `'ask'`，让 AUTO
   分类器审查续跑 prompt；Hosted Session 没有交互审批，因此 funnel 在
   安排时把同样的分类器输入（`delaySeconds`、`prompt`、`reason`）经
   Hosted 权限分类器提交，显式 deny 规则在任何模式下都拒绝安排。裁决
   记录在该次安排的 `managed-admission` 资源中。调度未来模型输入保留
   本地工具注释所要求的审查；未经准入的东西不会触发。对 sentinel 安排，
   准入值是常量，因此决策 1 的触发时展开在解析内容不同时重新审查——
   准入门覆盖实际运行的东西，而非仅 sentinel。
10. **预算是结构性的，不是新的配额表。** 一个未触发唤醒（决策 4）、
    24 h 链（决策 4）、prompt 与 envelope 界限（决策 4）、部署开关
    （决策 8）就是全部预算。不消耗 definition 配额，因为不存在
    definition；Session 现有的 turn 与工具预算像对待任何其他 turn 一样
    为每个触发的 tick 计价，包括触发时重审（决策 1）——它仅在解析内容
    变更时运行，而非每个稳态 tick。

## 流水线，逐步

| 步骤 | 位置                     | 提交                                                                                                                                                                                                                 |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `loop_wakeup`（funnel）  | 分类器审查；发布 `managed-input` + `managed-admission`；一个事务：被替换的未触发 input 的 `cancelled` settle（如有）+ `input.accepted`（`loop`、`notBefore`）+ `wake.requested`；应答 id、触发时刻、clamp、被替换 id |
| 2    | wake pump                | 无提交；`next()` 跳过未到期 input，在最早 `notBefore` 安排一个定时器                                                                                                                                                 |
| 3    | wake pump `runTurn`      | 在该 input 的 `turnId` 下的普通文本 turn；`turn.settled` 消费该 input                                                                                                                                                |
| 4    | 被触发的 turn            | 另一个 `loop_wakeup`（回到步骤 1）或没有——loop 结束                                                                                                                                                                  |
| 5    | `cron_delete`（loop id） | pending input 的 `cancelled` settle（`loop_cancelled`），无先前尝试；幂等                                                                                                                                            |
| 6    | close 路径               | 对未触发 pending loop input 的无模型 `cancelled` settle（`session_closing`）；firing loop turn 被中止并由 wake 恢复善后 settle，而非无模型行                                                                         |
| 7    | 重启后的加载             | 无提交；重新推导 pending 集，过期唤醒立即到期                                                                                                                                                                        |

## 契约触点

- `packages/core/src/managed-runtime/managed-session-records.ts`：
  `EVENT_SCHEMAS['input.accepted']` 增加可选 `notBefore`
  （`timeOrNull`）；payload 规则对每个 source 接受它。
- `packages/core/src/managed-runtime/contracts/managed-event-envelope-v1.schema.json`、
  `managed-event-envelope-v1.fixtures.json`、
  `managed-session-store-v1.fixtures.json`：可选字段与一个 `loop`
  source 见证；现有 fixture 不变。
- Java fixture 重放（`ManagedEventEnvelopes` 对整个事件求 digest，新
  字段走现有 digest 路径；重放测试证明两个宿主一致）。
- `packages/cli/src/serve/hosted-wake-intake.ts`：`PendingSessionInput`
  透传 `notBefore`。
- `packages/cli/src/serve/hosted-monitor-wake.ts`：`next()` 契约增加
  延迟信号；在最早 `notBefore` 安排一个定时器。
- `packages/cli/src/serve/hosted-harness-session.ts`：`isWakeInputSource`
  接纳 `loop`；pump 的选取尊重 `notBefore`；close 路径的 settle source
  集增加 `loop`。
- 新的 `hosted-loop-session.ts` funnel（`HostedAutomationSession` 的
  形状）：arm、触发时 sentinel 展开、由 `cron_delete` 路由的取消，与
  journal 串行化。
- `packages/cli/src/serve/hosted-workspace-profiles.ts` 与 Hosted 工具
  turn：新 profile 修订版与 `loop_wakeup` 的声明，加上与姊妹切片共享的
  `cron_list`/`cron_delete` 并集扩展。
- managed loop skill 变体（与姊妹切片共享）：`allowedTools` 不变；
  skill 资产是两份设计共同的契约触点。
- `packages/cli/src/serve/capability-parity.ts`：loop 工具面与开关的
  条目；过期的 `scheduled_task_gate` 条目另行修正（managed automation
  gate 已于 2026-10-22 落地）。
- 部署 settings schema：`qwen.managed-agent.loop.enabled`。

## 验证计划

- Fixture 对等：两个宿主一致地重放扩展后的 envelope 与 store
  fixtures；每个既有 fixture 保持逐字节不变。
- 准入矩阵：59 s clamp 到 60，3601 s 到 3600，非有限到 1200；空
  prompt、10001 字符 prompt、超过 64 KiB 的包装 envelope 各自被拒绝。
- 链：锚点是首个已提交 `loop` input；24 h 边界上的安排被准入，越过的
  被拒绝*且*未触发的 pending 唤醒被丢弃（原子性见证）；取消不重置
  锚点；重启保留锚点。
- 替换：第二次安排消费第一个未触发 input（`loop_replaced`），恰好一个
  未触发 input 保持 pending；firing turn 中的安排不触动运行中 turn 的
  input，该 turn settle 后恰好只剩新 input pending；被拒绝的重新安排
  不留下未触发 input，也绝不丢弃 firing input。
- pump，用假时钟：3600 s 唤醒安排一个定时器，不产生 500 ms 轮询；
  未到期 loop input 之后已到期的 monitor input 先执行；安排或取消的
  kick 重新求值延迟；瞬时 envelope 读取故障按现有节奏重试。
- 重启：pending 唤醒撑过 Harness kill，重载后恰好迟触发一次；turn 已
  启动的唤醒走恢复，绝不二次触发。
- loop turn 内部崩溃：善后将其 settle 为 `failed`/`outcome_unknown`；
  不自动重新安排唤醒。
- sentinel：`loop.md` sentinel 在触发时从当前文件展开，安排与触发之间
  的变更被拾取；重启或压缩后重新提供完整指令；内容不变投递简短提醒；
  文件缺失投递 autonomous tick（不抛错、不空 prompt）；瞬时不可读投递
  no-op re-arm tick；autonomous sentinel 无需文件即展开。100 KB 的
  `loop.md` 触发按 `LOOP_TASK_FILE_MAX_BYTES` 截断并带警告的输入。
  不受信任工作区的 `.qwen/loop.md` 产出 absent-file tick，而非其内容。
- sentinel 准入：安排 `<<loop.md-dynamic>>` 后在触发前改文件，重新审查
  解析出的内容，而非未经审查执行；被拒绝的重审把 input settle 为
  `cancelled`（`loop_admission_denied`）；稳态不变内容不在每个 tick 重审。
- 取消：`loop:<wakeupId>` id 经 `cron_delete` 路由；幂等；turn 有先前
  尝试后被拒绝；`/loop clear` 消费那一个未触发的 pending 唤醒。开关
  关闭时，已安排的唤醒仍触发且仍可列出/取消（含运维内部路由），新安排
  被拒绝。
- close：未触发 pending loop input 以无模型方式 settle；firing loop turn
  被中止并由 wake 恢复善后 settle（无第二条 `cancelled` 行）；下次打开
  不被卡死。
- 分类器：deny 规则拒绝安排；admission 资源记录裁决。
- 变异检查：逐个禁用各决策的守卫都会使某个测试失败（延迟跳过、替换
  settle、先丢弃后检查、链锚点、取消与替换的先前尝试守卫、触发时展开、
  开关关闭时的取消路径、开关）。

## 验收标准

- 带 loop profile 的 Managed Session 安排一个唤醒，Harness 在其到期前
  重启，重载后该唤醒恰好触发一次。
- 任何时刻每 Session 至多一个未触发 loop input（无先前尝试）pending；
  被拒绝的重新安排不留下任何未触发 input，firing turn 中的安排绝不
  取消运行中 turn 的 input。
- 任何 loop 操作都不创建 `schedule` 记录、`automation_run` 记录或控制面
  scanner 行。
- 3600 s 唤醒只花一个定时器，而非轮询节奏。
- 已安排的唤醒在部署开关关闭后存活，且仍可经 `cron_delete` 取消。
- `loop.md` sentinel 触发时读取当前文件，截断并带警告；不受信任工作区
  的文件不被读取；变更内容在运行前被重新审查。
- clamp、默认值、链上限、替换与取消应答与
  `CronScheduler.scheduleWakeup` 的契约一致。
- 两个宿主一致地重放扩展后的 fixtures。

## 开放问题

1. **链锚点作用域。** 本地锚点在 `stop()` 时重置（cron 重载也会触发
   它）；提案的 journal 锚点是每 Session 的，永不重置。Hosted Session
   可以比 TUI 会话多活数天：首个 loop input 之后 24 h，即使上一个
   loop 早已结束，也无法再安排任何新 loop。确认这一更严格的读法，或
   采用可从 journal 推导的重置规则——例如，一次安排发现没有存活的
   loop（既无未触发 pending input，也无 firing loop turn）时开启新链。
   显式说明其中的张力：这种重置是安排时开启新 loop 的属性，而非取消
   本身的属性，但终结 loop 的取消会让下一次安排开启新链——因此采纳它
   会取代决策 4「取消不重置锚点」的读法。该绕过还需要一个非 loop turn：
   firing loop turn 内总存在存活 loop，重置在那里无法触发——模型驱动的
   先取消再安排只能从普通 turn 重启 24 h 预算。在实现前钉住该规则，以及
   它取代哪种读法。
2. **profile 修订版号。** 本切片先落地，取 `hosted-workspace-shell/3`，
   跳过统一 Shell 生命周期（#15330）已退役的 `shell/2`；
   [固定间隔姊妹设计](2026-11-10-managed-loop-schedule.zh-CN.md)按其
   落地顺序说明互换到更后的一批修订。切片落地时仍需与控制面的规范
   Shell 准入核对，确认识别 `shell/3`。
3. **开关默认值时间线。** 验收证据落地前为 false，之后像
   `qwen.managed-agent.automation.enabled` 一样默认 true；与部署负责人
   确认启用顺序。
