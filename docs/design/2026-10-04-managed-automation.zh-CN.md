# Managed 自动化（H6）

[English](2026-10-04-managed-automation.md) | [简体中文](2026-10-04-managed-automation.zh-CN.md)

状态：设计提案；本文描述的任何能力均未实现，文中提到的 domain 均未开放提交。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H6 切片设计，属于 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段。它建立在 H0a 的任务契约（[设计](2026-09-27-managed-agent-task-contract.zh-CN.md)）、H0b 的记录契约（[设计](2026-09-27-managed-extension-record-contract.zh-CN.md)）和 H0c 的 authority（[设计](2026-09-27-managed-extension-authority.zh-CN.md)）之上。下文的“参考设计”指该提案[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)的第 1、3、7、11、12、13、14 节；其序言把 Schedule 资源的字段级契约留给[自动化设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md)，均以 #12827 固定的提交为准。

## 问题

自动化拆成 `ScheduleDefinition` 与 `AutomationRun`（参考设计第 7 节）。Scheduler 只发现候选并 claim run，绝不驱动模型。每个触发必须在任何副作用之前取得稳定的 `runId` 与 `occurrenceKey`，使两个扫描者实例、一次重试或一次补跑都无法把同一 occurrence 点火成两次模型运行。Legacy 计划任务运行在 daemon 中：`scheduled-task-run.ts` 与 `/scheduled-tasks` serve 路由为每次点火创建全新的 child Session，并以控制句注入触发指令（`SCHEDULED_TASK_RUN_INSTRUCTION`）。其计划状态保存在 daemon 本地存储中，同一时刻只有一个节点负责点火（靠构造保证），错过的窗口或节点替换没有已提交事实可对账。参考设计第 1 节要求每次派发先有稳定 ID 和持久 intent，并禁止对未知副作用盲目重试。H6 必须回答：occurrence 如何标识；多个 Java 节点中恰由谁 claim；重叠、错过或目标派发不确定的 run 怎么办；以及已结算的 run 如何送达而不重跑模型。

## 现状

以下事实基于 `main` 的 `5ddfacc9d4`。

- **Domain 索引。** `schedule` 与 `automation_run` 已在 `packages/core/src/managed-runtime/managed-session-records.ts` 的封闭 v1 domain 索引中注册。注册不等于开放：两者在 `MANAGED_EXTENSION_RECORD_BODIES`（`managed-extension-projection.ts`）中没有记录正文，也不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中，`commitExtensionRecord` 会拒绝它们。
- **任务投影。** 任务种类 `automation_run` 已声明（`MANAGED_TASK_KINDS`）并冻结在公开的 `TaskKind` 枚举中；H0b 运行块带有 `AutomationRun` 所需的运行、执行与交付三条状态线。
- **公开契约。** H0a 在 v1.16 把自动化资源（`GET /v1/agent-automations`、`GET /v1/agent-automations/{automationId}/runs`）以 `planned` 命名，并把它们的形状划给 H6：定义 CRUD、手动 run 与 run 查询，定义与历史 run 分开分页（参考设计第 11 节）。变更使用 `Idempotency-Key` 并返回 `202 + operationId`。
- **Legacy 计划任务。** `packages/cli/src/runtime/scheduled-task-run.ts` 按任务标签加触发时间为每次点火构造 child Session 名，`packages/cli/src/serve/scheduled-task-*.ts` 保存 daemon 路由与 keepalive。其中没有已提交的计划台账；没有任何内容能以可对账的事实在节点替换后存活。
- **唤醒与输入。** H0c 决策 2：没有 `WakeIntent` 记录；修订可以在同一事务中提交通知输入及其 `input.accepted` 与 `wake.requested`。唤醒的消费方尚不存在（H0c 未决问题 6）。
- **门禁原语。** W0 Workspace 绑定及代数门禁、持久本地进程供给（默认开启、可用开关退出；专属 Linux 重启验收仍在进行，见 [W0e](2026-09-27-managed-workspace-recovery.zh-CN.md)），以及 Runtime Broker 的 claim/代数模型为 H6 提供了租约词汇；自动化扫描者租约本身由本文设计，尚未实现。
- **后续切片的依赖。** H4 拥有 `per_run` run 创建的 Managed child Session；H5 拥有 run 的交付 policy 使用的 Channel 交付契约。H6 消费两者，不重复造。
- **Java 正文。** Java 存储只物化它认识的正文；H6 新增的正文必须先于任何写入者提交该 domain 之前送达服务器（H0c 未决问题 7）。

## 目标

- 在 H0b 运行块之上定义 `schedule`（定义）与 `automation_run` 记录正文。
- 固定 occurrence 身份：定时触发为 `scheduleId + revision + slot`，手动运行为 command ID，webhook 触发为已验证 event ID。
- 增加扫描者：发现到期 occurrence，并在 workspace 租约/代数 token 下 claim 每个 run，使多个 Java 节点恰有一个 claim 成功。
- 固定重叠策略（默认 `skip`、`queue_one`、`allow`）与补跑策略（默认 `none`、`latest`、有界次数），禁止无限补跑。
- run 的执行目标为 `persistent` 目标 Session 输入或 `per_run` child Session，目标在 run 的 intent 修订中冻结。
- 已结算 run 按已提交的交付 policy 送达——一条 Channel outbox 条目——发送失败后绝不重跑模型。

## 非目标

- **第二套 scheduler 或模型 loop。** Goal、Live、channel loop、webhook 与后台完成通知继续经统一内部输入队列进入 Session，保留各自优先级与预算（参考设计第 7 节）；它们迁移到该台账属于后续工作，本文不给它们增加第二套 scheduler。
- **webhook 入口。** 已验证 event ID 触发需要的 webhook 界面在这批切片中不存在；occurrence 身份为其保留 `eventId`，该触发种类在其切片落地前于准入时拒绝。
- **H4/H5 范围。** child Session 创建细节（H4）与 Channel 交付回执（H5）是被消费的契约，不在此重设计。
- **Legacy daemon 路由。** `/scheduled-tasks` 路由保持内部适配来源（参考设计第 11 节）；不改动 daemon 路由。
- **计数上限之外的预算执行。** 定义固定预算 policy；对模型/工具消耗的执行复用 Session 现有机制，新的预算种类属于后续切片。
- **run 进行中的定义字段变更。** 已开始的 run 固定点火时的定义修订；定义更新只影响之后的 occurrence（参考设计第 1 节第 5 条）。

## 决策

1. **定义与 run 是两种记录。** `schedule`（链身份 `scheduleId`）保存定义修订：cron 表达式与时区、prompt 资源修订、目标 Session 模式、交付 policy、错过/补跑 policy、并发与预算 policy——只增修订并带内容摘要，与 AgentDefinition 契约（D8a）一致。`automation_run`（链身份 `runId`）保存一次 occurrence：`occurrenceKey`、钉住的定义修订、冻结的目标、运行/执行/交付三条状态线，以及任务种类 `automation_run`，使每个 run 出现在被绑定 Session 的 `SessionTaskView` 中。
2. **occurrence 先标识后 claim。** 定时触发的 `occurrenceKey` 是规范化三元组：`scheduleId`、定义 `revision` 与 `slot`——定义时区下的计划时刻，由 H6a 契约规范化，使 DST 折叠与跳跃恰有一种读法。手动 run 使用其准入命令 ID（`Idempotency-Key`）。webhook run 使用已验证 event ID。同一 `occurrenceKey` 的两次 claim 归结为一个 run；第二个 claim 者读取已提交的 run，而不是再创建一个。**定义修订绝不重新武装已覆盖的 slot。** 运行台账跨全部修订维护每个 schedule 的水位 `latestAdmittedSlot`——已提交过 `automation_run` 的最大计划时刻（`scheduleId` 不限 revision）。claim 与补跑判定查水位、绝不只查 revision 键:`slot` 不高于水位即已覆盖；补跑（`latest` 或 bounded)只提议严格在水位之上的 slot,以及水位与当前之间错过的 slot,无论已提交者出自哪个 revision。因此一次只改 prompt 的修订更新无法重放旧修订已执行的 slot——`catch_up: latest` 下,r2 重新铸出的 `slot 09:00` 被水位判为已覆盖,而不是再点一次火(参考设计第 7 节:定义更新只影响之后的 occurrence,绝不重放已提交的 slot)。
3. **恰有一个扫描者 claim。** 扫描者运行在 Java 节点上，按与 Runtime Broker 对 binding 相同的纪律，在带代数的租约下竞争 workspace 作用域的 claim：租约携带 fencing token，失去代数的运行者可以查询与对账，但不能创建副作用。每轮扫描计算到期的 occurrence，各自一个事务地提交 `automation_run` 起始修订，然后才派发。派发路径的超时、404 或不完整回答证明不了目标是否收到 intent——扫描者按原 `occurrenceKey` 与 `runId` 对账，绝不盲目重新点火（参考设计第 1、7 节）。
4. **重叠是定义的显式选择。** `skip`（默认）：前一个 run 未到终态时，到期 occurrence 被丢弃，并在 run 台账上记录为被跳过的 occurrence，而不是一个 run。`queue_one`：至多一个 occurrence 排队；一个在运行、一个在等待时的第三次点火按同样记录跳过。`allow`：允许重叠，受并发配额约束，超出时以 H0b 的 `count_limit` 拒绝。
5. **补跑有界或没有。** `none`（默认）：错过的窗口记录为错过，绝不点火。`latest`：至多最新的一个错过 occurrence 点火一次。`bounded: N`：至多最新的 N 个错过 occurrence 点火，从最旧的开始。无限补跑在定义准入时拒绝。
6. **两种目标模式，在 intent 时冻结。** `persistent`：run 以 H0c 机制（同一事务的输入加唤醒）向被绑定的 task Session 提交输入；被绑定 Session 是定义的一部分。`per_run`：run 经 H4 的流水线创建独立 child Session，拥有自己的历史与生命周期。模式与具体目标（Session、bundle 修订、workspace 上下文）冻结进 run 的起始修订，run 进行中不可迁移；Workspace 变更期间延后准入，不回退到 daemon primary 或默认工作区（参考设计的 v1.9/v1.10 Workspace/cwd 契约补充）。
7. **送达绝不重跑模型。** run 结算时，其已提交的交付 policy 创建 `channel_delivery` outbox 条目（H5 的契约）。发送失败、`partial` 或 `unknown` 交付按 H5 的规则对账；仅因交付未结而重试 run 的模型工作被禁止（参考设计第 7 节与第 14 节第 6 条）。
8. **历史与保留跟随 run 台账。** 定义与历史 run 在公开 API 上分开分页（参考设计第 11 节）。run 记录的结果 Artifact 按 O4 的 Session 根保留钉住，因此无论送达与否，run 的证据都在事件过期后存活——与参考设计第 14 节第 8 条对高频 Monitor 输出提出的有界聚合原则一致。

## 记录正文（H6a 契约方向）

两个正文都原样嵌入 H0b 运行块。封闭的字段集、验证器与迁移规则由 H6a 变更在共用 schema 与 fixture 文件中固定，TypeScript 与 Java 双方回放。本节确定方向，不固定字节级 schema。

- `managed-schedule`（链身份 `scheduleId`）：租户/Workspace 作用域、定义修订与摘要、cron 与时区、prompt 资源引用、`sessionMode`（`persistent` | `per_run`）及其冻结目标、交付 policy、重叠 policy、补跑 policy、并发与预算 policy、启用/停用标志。定义修订只增；第一条修订以契约默认值 `overlap: "skip"` 与 `catch_up: "none"` 开启。
- `managed-automation_run`（链身份 `runId`）：`scheduleId` 与钉住的定义修订、`occurrenceKey` 及其触发种类（`timer` | `manual` | `webhook`）、定时触发的 slot、冻结的目标（被绑定 Session 引用或 child Session intent）、交付 policy 快照，以及任务种类为 `automation_run` 的 H0b 运行块。其执行线跟踪目标派发；其交付线（policy 需要送达时为目标 `channel`）跟踪 H5 交付。
- 跨修订不变的字段遵循 H0b 的规则：occurrence 身份、定义钉与冻结目标在链建立后绝不改变。

## 切片计划

| 切片 | 范围                                                                                                                                                                                      | 通过门槛                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H6a  | 记录契约：两个正文、验证器、occurrence 身份规范化（含 DST 见证），加入共用 schema 与 `managed-extension-record-v1` fixture；`MANAGED_EXTENSION_RECORD_BODIES` 条目；Java 回放。           | TypeScript 与 Java 对 fixture（含 DST 用例）给出并拒绝完全相同的链。两个 domain 继续缺席 `MANAGED_SESSION_ENABLED_DOMAINS`；`commitExtensionRecord` 仍然拒绝它们。Java 存储先于任何写入者提交，携带这两个正文（H0c 未决问题 7）。没有生产调用方构造任一正文。                                              |
| H6b  | planned 公开路由下的定义 CRUD（转为 `partial`）、经 command ID 的手动 run、带 workspace 租约/代数与单一 claim 的扫描者、带跳过/排队记录的 run 台账、重叠/补跑执行。两个 domain 开放提交。 | 两个扫描者实例对每个 occurrence 恰 claim 一个 run（参考设计第 14 节第 6 条）：失败的一方读取已提交的 run。`none` 下错过的窗口被记录且绝不点火；`latest` 下至多补跑一次；`bounded: N` 下至多 N 次。手动 run 重放其 `Idempotency-Key`。定义与 run 分开分页；每个变更返回 `202 + operationId`。               |
| H6c  | 执行目标与送达：`persistent` 带唤醒的输入准入、经 H4 的 `per_run` child Session、交付 policy 到 H5 `channel_delivery` 条目的投影。                                                        | `persistent` run 的输入与其唤醒在一个事务中提交，claim 与准入之间的扫描者崩溃按 `runId` 对账。答案未知的 `per_run` 派发绝不因同一 `occurrenceKey` 产生第二个 child。已结算 run 恰好创建其已提交的交付；Channel 发送失败、`partial` 或 `unknown` 对账而不触碰该 run 的模型工作（参考设计第 14 节第 6 条）。 |

后续 H6 切片（本文不排期）：带已验证 event ID 的 webhook 触发；Goal/Live/channel loop 迁移到台账；新的预算种类。

## 验证计划

- 两个正文的 fixture 一致性，TypeScript 与 Java 双方回放，包括 occurrence 规范化表（时区偏移、DST 折叠与跳跃见证）。
- 扫描者竞争测试：两个 claim 者、派发中途失去代数、对账期间租约过期、claim 提交与派发之间重启扫描者。
- 策略矩阵自动化：每个（重叠 × 补跑）组合对脚本化错过与重叠窗口，断言精确的 run 总体与跳过/错过记录。
- Java 存储物化（main 的 V34 之后的一个 Flyway 迁移），覆盖拒绝回滚，并为会送达的 run 覆盖 outbox 列。
- H6c 故障注入 E2E：输入提交前、提交与派发之间、结算与创建交付之间崩溃；每次最终每个 occurrence 至多一次模型运行，或进入可见的 `unknown`/`recovery_blocked`。
- 变异检查：每条身份、策略与门禁规则逐一禁用，并且每一次都有测试失败。

## 验收标准

- 参考设计第 14 节第 6 条：双扫描者对每个 occurrence 只 claim 一个 run；未知的 `per_run` 派发绝不在父侧重复执行；模型完成后的 Channel 发送失败绝不重跑模型。
- 参考设计第 14 节第 10 条：所有失败都能归为确定未执行、已结算、可 attach 或 `unknown`/`corrupt` 之一，`unknown` 不伪装成功或自动重跑。
- 参考设计第 3.2 节：定义的更新历史、run 台账与交付状态线是三个可分别读取的事实。
- 两个 domain 只在随其生产者落地的切片中开放提交，并有契约测试证明开放是显式的。

## 未决问题

1. **slot 的表示。** H6a 契约固定 slot 的规范形式（时刻加定义时区，或本地钟面时间）；fixture 让该选择可观察。
2. **补跑窗口上界。** `bounded: N` 是否还需要最大年龄，还是由定义的启用窗口界定，是 H6b 的决策。
3. **租约尺寸。** 扫描者租约时长与扫描周期作为部署配置提供；按参考设计第 12 节容量表（活动 run、每窗口触发、模型/工具预算）的要求，以实测值为准再开放。
4. **手动 run 的准入范围。** 手动 run 要求定义的 owner 还是只需目标上的 Session 写入者，随 H6b 公开路由的授权映射一起决定。
