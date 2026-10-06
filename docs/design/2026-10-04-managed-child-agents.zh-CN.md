# Managed 子 Agent、工作流与团队（H4）

[English](2026-10-04-managed-child-agents.md) | [简体中文](2026-10-04-managed-child-agents.zh-CN.md)

状态：设计提案；本文描述的任何能力均未实现，文中提到的 domain 均未开放提交。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H4 切片设计，属于 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段。它建立在 H0a 的任务契约（[设计](2026-09-27-managed-agent-task-contract.zh-CN.md)）、H0b 的记录契约（[设计](2026-09-27-managed-extension-record-contract.zh-CN.md)）和 H0c 的 authority（[设计](2026-09-27-managed-extension-authority.zh-CN.md)）之上。下文的“参考设计”指该提案[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)的第 1、3、8、11、12、13、14 节；其序言把 child/team 资源的字段级契约留给[自动化设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md)，均以 #12827 固定的提交为准。

## 问题

子 Agent 是独立的执行 scope。当它需要比单个回合更长的独立运行、冷恢复或跨进程执行时，参考设计（第 8 节）要求使用完整的 child Session，由持久化流水线驱动，而不是回调：

```text
父 Session 提交 child_run launch + outbox
  → Java 幂等创建 child Session / Runtime binding
  → child Harness 执行并提交 terminal result
  → child result outbox
  → 父 Session acceptChildResult（accepted）+ 唤醒
  → 父 Harness 消费（consumed）
```

Legacy 子 Agent 是进程内的：Agent 工具、默认后台的顶层子 Agent（[设计](2026-07-16-default-background-subagents.md)）、roster 恢复（[设计](2026-07-22-background-agent-roster-restore.md)）以及带可选 worktree 隔离的 headless fork（[设计](2026-07-21-headless-fork-subagents.md)）都把完成回调、roster 和结果保存在父进程内存中。参考设计第 1 节明确指出：内存 callback、Promise、PID 或 `notified=true` 都不是恢复凭据。在 Managed 路径上 Harness 可能被替换、Runtime 可能被回收，因此 H4 必须回答：哪些已提交记录承载 child 的启动、执行与结果；重启后的 relay 如何区分已存在的 child 和需要创建的 child；父 Session 何时算 accepted 而不只是收到；工作区如何隔离；父 Session 关闭时 child 怎么办。

## 现状

以下事实基于 `main` 的 `5ddfacc9d4`。

- **Domain 索引。** `child_run` 与 `child_acceptance` 已在 `packages/core/src/managed-runtime/managed-session-records.ts` 的封闭 v1 domain 索引中注册，`team_state`、`team_task`、`team_message`、`team_plan` 同样在内。注册不等于开放：它们在 `MANAGED_EXTENSION_RECORD_BODIES`（`managed-extension-projection.ts`）中没有记录正文，也不在 `MANAGED_SESSION_ENABLED_DOMAINS` 中，`LocalManagedSessionAuthority.commitExtensionRecord` 会拒绝没有正文或未开放的 domain。`monitor_run` 有正文，但在 H3 之前同样不开放。
- **共用运行块。** H0b 的 `run` 块（`managed-extension-record/1`）已经分好 child 所需的三条状态线：逻辑运行（`reserved → admitted → running/waiting → settled/failed/cancelled/recovery_blocked`）、物理执行（`intent → dispatch_started → running_attached → settled/not_started_proven/outcome_unknown/corrupt`）和交付状态线。交付目标 `session` 恰好具备 child 结果接收所需的状态：`planned → accepting → accepted → consumed`，外加 `unknown`、`rejected` 与 `cancelled`。
- **Outbox。** H0c 从已提交的交付状态线导出 outbox：`planned`、`sending`、`partial`、`accepting` 或 `unknown` 表示仍需发送或仍需对账。Java 存储在提交事务的同一 SQL 事务中，把它物化到 `qwen_managed_session_extension_record`（Flyway V18）。目前还没有组件读取 outbox；H0c 把派发器划给了 H4 和 H5。
- **唤醒。** H0c 决策 2：没有 `WakeIntent` 记录。Stage H 修订可以在同一事务中提交一个通知输入，authority 会像 `submitInput` 那样为它生成 `input.accepted` 加 `wake.requested`。Session inbox（`managed-session-inbox.ts`）是用户消息队列，不是唤醒的载体。已提交唤醒的消费方还不存在（H0c 未决问题 6）。
- **任务投影。** 任务种类 `child_agent` 与 `workflow` 已声明（`MANAGED_TASK_KINDS`）并冻结在公开的 `TaskKind` 枚举中。任务列表与详情已提供（`partial`，契约 v1.19）；任务事件与取消保持 `planned`，语义已定（v1.23）。
- **生命周期。** D4 让 close、archive 和 delete 成为持久命令操作（#12881，契约 v1.18）。Workspace 绑定 Session 的可靠关闭（#13135，V32）在公开 Session 锁下执行 `ACTIVE → CLOSING`，活动回合以 `409 turn_active` 拒绝，最后封存写入者。O4 引退（#13084，V30）与回收（V34）把 Session 持有的输出钉到关闭之后。这些路径目前都不认识 child。
- **Java 正文。** Java 存储只物化它认识的记录正文，其他 `domain.committed` 事件直接透传（H0c 未决问题 7）。因此 H4 新增的正文必须先于任何写入者提交该 domain 之前送达服务器。
- **已合入的前置。** 已在该基线上核实：H0a–H0c（#12855）；H1 MCP 正文（#12946 及后续，V23）与 H2 Hook 正文（#13129，V27/V28），两者已开放提交；显式私有 profile 之后的 Hosted 前台 Shell 工具回合（[设计](2026-09-27-hosted-shell-tool-turn.zh-CN.md)）；O2 Hosted 结果存储（#12894）、O3 公开结果/Artifact 投影（V26，契约 v1.27）与 O4-1 引退（#13084）；W0 Workspace 绑定及代数门禁，以及默认开启、可用开关退出的持久本地进程供给与可信重启恢复（`runtime-broker.durable-local-process`、`runtime-broker.trusted-local-reboot-recovery`；专属 Linux 重启验收仍在进行，见 [W0e](2026-09-27-managed-workspace-recovery.zh-CN.md)）。

## 目标

- 在 H0b 运行块之上定义 `child_run` 与 `child_acceptance` 记录正文，带流水线所需的身份（`childRunId`、`rootSessionId`、`parentSessionId`、`childSessionId`、`dispatchId`、`deliveryId`）。
- 把 child terminal、parent accepted、parent consumed 提交为三个可分别观察的事实；重启后的 relay 只重投未被 accepted 的原结果，绝不创建第二个 child。
- 让 relay 能幂等创建 child Session，并在流水线任意两步之间崩溃后恢复。
- 为首批切片固定一种工作区隔离策略：父绑定的只读快照。
- 把 child 的取消与分离绑定到持久关闭路径。

## 非目标

- **独立 worktree 与共享串行工作区。** 参考设计第 8 节把独立 worktree 作为需要写入的 child 的默认值，共享写入仅在显式串行下允许。H4 的首批切片明确推迟两者：需要写入的启动在准入时拒绝，而不是静默降级。worktree 的生命周期、配额、关闭时合并策略与 Runtime hold 需要独立契约，在后续 H4 切片落地。第 8 节的默认值在此被显式收窄，而不是被遗忘。
- **工作流。** `workflow` 任务种类已注册，但步骤图计划、逐步记录和步骤级恢复属于后续切片。
- **团队与邮箱。** `team_state`、`team_task`、`team_message`、`team_plan` 只是已注册的 domain 名。参考设计第 8 节把 team 定义为 lead Session authority 下的持久领域资源，成员身份、任务分配与消息都走 outbox/ACK。本文不设计也不开放其中任何部分。
- **任务事件与向父 Session 的输出流。** `output_cursor` 与任务事件路由保持 `planned`；需要输出流的 child 使用 Artifact，与所有 Stage H 能力一致。
- **Legacy 子 Agent 变更。** 进程内的 Agent 工具保持现有行为；Managed 路径是独立的引擎选择，参考设计禁止在运行中的 Session 上切换引擎。
- **跨租户或跨工作区的 child。** 在这批切片中，child Session 创建在父 Session 的租户与工作区绑定内。

## 决策

1. **两个 domain，各归拥有事实的那个 Session。** 父 Session authority 提交 `child_run`：它是父 Session 的任务，因此以 `child_agent` 种类出现在父 Session 的 `SessionTaskView` 中。child Session authority 提交 `child_acceptance`：它是 child 对“终态结果已提交并交给 relay”的持久陈述。这样拆分让每个 Session 的日志保持单写入者（H0b/H0c：注册 domain 没有第二条写入路径），relay 也能从两侧已提交的状态对账，而不是信任任一进程。
2. **三个事实，三条线。** child 到达终态是 `child_acceptance` 运行进入 `settled`/`failed`/`cancelled`——第一个事实。父 Session 接受结果是 `child_run` 交付状态线到达 `accepted`——第二个。父模型消费它是交付到达 `consumed`——第三个。三者互不涵盖：`accepted` 等待的是模型而不是派发器（H0c 决策 6），已结算的 child 说明不了父 Session 任何情况。
3. **身份在第一个副作用之前稳定。** 父 Session 在 Java 尝试任何创建之前，先提交带 `childRunId` 与 `dispatchId` 的启动修订，因此提交与派发之间的崩溃按身份对账，而不是靠猜。Java 用按启动键控的持久幂等命令创建 child Session，把 `childSessionId` 写回 `child_run` 链，child 固定启动时给出的 AgentBundle 修订。创建调用的超时、404 或不完整回答本身证明不了任何事：relay 重新查询原 occurrence，绝不盲目重发。
4. **结果经 outbox 与幂等接受跨越 Session。** child 提交终态的 `child_acceptance` 修订，携带结果引用（Artifact，遵循 O 系列切片）和目标为 `session` 的交付状态线——这一共享终态事实对两种 child 相同。**两种 child 的跨越方式不同**（参考设计第 8 节：前台 child 只回原 tool result，后台 child 只经持久通知输入，绝不两路都送；见决策 6）。**前台** child 提交终态修订后，以原 tool result 直接回答父 Session 的同一次 tool call——回答事务把 `accepted` 持久接受下来；**`consumed` 不在那次回答里**，而是由父 Session authority 在其消费进度真实成立时以一条单独的后继修订提交。父 Harness 若在回答已接受与消费进度提交之间崩溃，恢复后看到的应是「已接受、待消费」，绝不是不可逆的 `consumed`。这条支路同样不生成通知输入、不铸 wake——但三个事实仍是三个。**后台或已分离** child 以同样方式提交其终态修订；relay 读取 Java 存储已经物化的 outbox 列，以 trusted-entry 操作向父 Session 提交 `acceptChildResult`：父 Session 在同一事务中把交付推进到 `accepted`，并提交通知输入及其唤醒。重放的接受返回已记录的修订，不会再发送一次。消费了该通知的回合取得 `turn.settled` 后，一条后继修订提交 `consumed`。送达已关闭或已删除父 Session 的结果保留为 orphaned——记录在案，绝不喂给模型，也绝不成为重开父 Session 的理由（参考设计第 14 节第 7 条）。
5. **工作区隔离：只读快照，且只有只读快照。** `child_run` 正文携带封闭的 policy 名。注册的名字是参考设计的三个——`read_only_snapshot`、`independent_worktree`、`shared_serialized`——但首批切片只准入 `read_only_snapshot`：child 得到父绑定在所记录 context 修订上的冻结只读视图，任何会写入的工具都被准入策略拒绝。另外两个名字保留注册，在其切片落地前于准入时拒绝（非目标 1），因此任何读取者都不会毫无准备地遇到它们。按第 8 节要求，child 不隐式继承父模型上下文；purpose、depth 与预算随记录传递。
6. **前台与后台 child 的返回方式不同。** 前台 child 只在父 Session 的回合中返回工具结果；后台 child 只经持久通知输入返回。启动时二选一，由记录的种类固定，任何路径不得两路都送（参考设计第 8 节）。
7. **关闭级联绑定持久关闭路径。** 父 Session 关闭遵循参考设计的固定顺序（第 12 节）：封新输入与派发 → 取消或分离长期 child → 接收未回执 → 关闭 Harness activation → 核验 Runtime 无 hold → 释放 Runtime → 结束写入者。H4 把第二步接到现有 CLOSING 路径（#13135）上：未到终态的 child 默认级联取消；关闭前明确 detach 的 child 必须先换成独立持久 owner——没有 owner 的 detach 被拒绝，而不是拒绝关闭。迟到的结果按决策 4 成为 orphaned。关闭路径对活动回合保持 `409 turn_active` 拒绝；child 取消作为关闭的一部分运行，而不是无限阻塞关闭；关闭 API 的观察超时绝不释放物理 owner。
8. **配额使用共用原因。** 深度、并发 child、模型/工具预算以 H0b 的配额原因拒绝（`depth_limit`、`count_limit`、`budget_exhausted`），投影与公开的 `recovery_blocked`/`failed` 状态不需要新词汇。

## 记录正文（H4a 契约方向）

**Body 版本与已注册的 Shell 正文。** `managed-child_run` 已在 main 上按 H3 的单 kind 正文注册：`kind: 'shell'`,`recordId = shellId`，投影任务种类 `background_shell`——而 H3 正文的头注释恰恰写明：H4 用自己的 body 版本把该 domain 扩展到其他 child 种类。因此 H4a 不改写 v1 正文，而是定义**正文版本 2 为 kind-union**:`kind: 'shell'` 逐字保留 v1 字段集（已提交的每个 Shell 的 JSON 逐字节不变——所谓迁移等于原地不变）,`kind: 'child_agent'` 携带下方的新正文，`recordId = childRunId`，投影任务种类 `child_agent`。`domain.committed` payload 的 version 只对本 domain 放开 `1 | 2`，其他所有 domain 维持 `version == 1`（准入矩阵以双语共享 fixture 钉死）;`child_acceptance`、`schedule` 及其余 H 系列仍在其自身 v1。

两个正文都原样嵌入 H0b 运行块。封闭的字段集、验证器与迁移规则由 H4a 变更在共用 schema 与 fixture 文件中固定，TypeScript 与 Java 双方回放，与 H0b/H0c 的做法一致。本节确定方向，不固定字节级 schema。

- `managed-child_run`（父 authority 提交，链身份为 `childRunId`）：`rootSessionId`、`parentSessionId`、purpose（有界文本）、`depth`、AgentBundle 定义钉（`DefinitionPin`）、模型与工具预算引用、工作区隔离 policy（决策 5）、`deliveryId`，以及分配之后的 `childSessionId`、`dispatchId` 与 child Runtime binding。其运行线是 child 的逻辑生命周期，执行线是物理 child Session/binding，交付线是决策 4 的结果接受。`run.delivery.target` 必须为 `session`。
- `managed-child_acceptance`（child authority 提交，链身份为其父侧的 `childRunId`）：child 自身的 Session 身份、终态结果、结果引用，以及指向父 Session 的交付状态线。其终态修订是三个事实中的第一个。
- 跨修订不变的字段遵循 H0b 的规则（`MONITOR_FIXED_KEYS` 是先例）：身份、定义钉、policy 与预算在链建立后绝不改变。

## 切片计划

| 切片 | 范围                                                                                                                                                                                                                               | 通过门槛                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H4a  | 记录契约：两个正文、验证器、固定字段规则与迁移见证，加入共用 schema 与 `managed-extension-record-v1` fixture；`MANAGED_EXTENSION_RECORD_BODIES` 条目；Java 同步回放。                                                              | TypeScript 与 Java 对 fixture 给出并拒绝完全相同的链。两个 domain 继续缺席 `MANAGED_SESSION_ENABLED_DOMAINS`；`commitExtensionRecord` 仍然拒绝它们。没有生产调用方构造任一正文。Java 存储先于任何写入者提交，携带这两个正文（H0c 未决问题 7）。                                          |
| H4b  | 前台 child、只读快照：父启动提交 + outbox、幂等 child 创建、child 终态提交、由同一存储事务以原 tool result 回答——`accepted` 于其中落地（不发通知 input、不铸 wake),`consumed` 仅在其后的消费进度修订中落地。两个 domain 开放提交。 | 三个事实在任务视图与记录链上可分别观察：回答后崩溃只见 `accepted` 无 `consumed`，父重启原样读回绝不扩大。父重启只重投未 `accepted` 的原结果，同一 `dispatchId` 绝不创建第二个 child。relay 在创建与接受之间崩溃时按已提交 occurrence 对账。重复接受幂等。关闭中的父 Session 拒绝新启动。 |
| H4c  | 后台 child 通知；关闭级联（默认取消、带持久 owner 的 detach、orphaned 结果）；经 planned 取消路由的 child 任务取消；深度/并发/预算配额。                                                                                           | 关闭父 Session 取消其未分离的 child，orphaned 结果绝不复活父 Session；没有独立持久 owner 的 detach 被拒绝。取消按 v1.23 语义持久、有序、幂等。配额拒绝携带 H0b 原因。任务事件与 `output_cursor` 保持 `planned`。                                                                         |

后续 H4 切片（本文不排期）：带生命周期与合并策略的 `independent_worktree`；带代数/屏障的 `shared_serialized`；`workflow` 任务种类；team domain 与邮箱；跨工作区 child。

## 验证计划

- 两个正文的 fixture 一致性，TypeScript 与 Java 双方回放，沿用 H0b/H0c 为 `monitor_run`、MCP 与 Hooks 固定的 fixture 文件做法。
- authority 套件：启动、接受重放、固定字段不可变、关闭时启动拒绝、orphaned 结果记录。
- Java 存储对新正文的物化（main 的 V34 之后的一个 Flyway 迁移），包括 outbox 列与拒绝回滚。
- 变异检查：每条迁移规则、固定字段规则与幂等检查逐一禁用，并且每一次都有测试失败，与 H0c 的要求一致。
- H4b 流水线的故障注入 E2E：在启动提交前、提交与创建之间、创建与终态之间、终态与接受之间、接受与消费之间崩溃；每次运行最终恰好一个 child、至多一份送达结果，或进入可见的 `unknown`/`recovery_blocked`，绝不静默重复。

## 验收标准

- 参考设计第 14 节第 2、7 条对该流水线成立：断开/重连不改变任何 child 的状态；child terminal、parent accepted、parent consumed 可分别观察；重启后的父侧 relay 只补原结果；orphaned 结果绝不复活已关闭的父 Session。
- 所有失败都能归为确定未执行、已结算、可 attach 或 `unknown`/`corrupt` 之一，`unknown` 不伪装成功或自动重跑（参考设计第 14 节第 10 条）。
- H4a–H4c 不改变已 planned 的任务面之外的公共 API：任务列表出现 `child_agent` 任务，取消在 H4c 接线时转为 `partial`，事件保持 `planned`。
- 两个 domain 只在随其生产者落地的切片中开放提交，并有契约测试证明开放是显式的。

## 未决问题

1. **前台结果的边界。** 前台 child 的结果在父 Session 的工具结果中返回；该结果是否也必须按 O 系列切片规则转存为 Artifact、还是可以经工具结果存储内联传递，由 H4b 决定。
2. **消费事务的分组。** `consumed` 修订是在 `turn.settled` 事务中提交还是在之后的事务中提交，由 H4b 固定。
3. **重建成本。** H0c 未决问题 1（无界链回放）同样适用于有大量接受修订的长运行 child；在 H4c 大规模开放取消之前，可能需要带检查点的任务视图。
4. **detach 后 child 的 owner。** 被 detach 的 child 换成什么持久 owner（租户级保留策略，或 root Session authority）留给 H4c；关闭路径只强制要求存在这样一个 owner。
