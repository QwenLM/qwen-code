# Managed workflow 任务取消

[English](2026-10-13-managed-workflow-task-cancel.md) | [简体中文](2026-10-13-managed-workflow-task-cancel.zh-CN.md)

状态：本变更实现，Stage F 待验证。`workflow` 任务类型加入公开任务取消路径：`CANCELLABLE_TASK_KINDS` 放宽以准纳它，契约在 `1.46.0` 中予以点名。它所走的每一个停止机构都已存在且与 kind 无关；本变更打开这道闸门，并用 workflow 链路测试把路径钉住。该类型的 F 阶段故障轮次（决定 6）欠账未跑 —— 下文引用的证据仅为单元、契约与记录层。

这是 [#13746](https://github.com/QwenLM/qwen-code/issues/13746) F1 剩余的一个 `child_run` 类型。H4f 切片（#13823）实现了 `child_agent` 任务的取消，其余类型全部推迟；其 follow-up 表点名了这一片 ——「Workflow, automation: with the workflow runtime (#13803) … a stop request on their records, then the same delivery and stop arms」——[workflow 运行时设计](2026-10-10-managed-workflow-child-runtime.zh-CN.md)（「public cancel —— 各自具名的切片」）与 `CANCELLABLE_TASK_KINDS` 注释本身也各自点名。本片唯一的前置 —— workflow child 运行时 —— 已由 #13858 落地。本片是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H4f-b 切片，即 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段。

## 问题

自 #13858 起，一次 workflow 发起就是一个真实的任务：一条 kind 为 `workflow` 的 `child_run` 记录，带着它的每任务日志与输出游标投影到两个任务面上。调用者能列出它、能观察它 —— 却不能停止它。对该类型的取消准入答复 `409 task_action_unavailable`，任务视图也不公布任何动作。今天要停掉一个 workflow 任务只能关闭整个父 Session，因为 close cascade 是唯一能停 workflow child 的驱动者。

## 现状

已在 `d28bc60d73`（Flyway V68、契约 `1.44.0`）上核实：

- **闸门就是一个集合。** `CANCELLABLE_TASK_KINDS` 为 `Set.of("child_agent")`（`ManagedExtensionProjection.java:130`）。它的读者只有：`taskActions`（:239）—— 由任务视图（`ManagedTaskService.java:251`；Session 非 `ACTIVE` 时视图不公布任何动作）与投影行锁下的准入重查（`ManagedAgentStore.java:1710`）共用 —— 以及投递判定（`TaskCancelCoordinator.java:207`）。不存在第四个读者。
- **停止路径端到端与 kind 无关。**
  - relay 的停止臂在状态分派之前以 `stopRequested && !ended` 运行，没有任何 kind 分支（`ChildResultRelay.java:245-262`）；`stopChild`（:302-427）经 child 自己的命令行取消其 Turn 并结算 `close_scope`，从不读取 kind。H4d-b 的消息分支对 workflow child 是惰性死分支：workflow child Session 不接收 session message（`hosted-child-agent-session.ts:700`）。
  - Hosted 的 children/operations `cancel` 动词与 `requestStop` 不读取 kind（`hosted-harness-session.ts:6786-6789`；`hosted-child-agent-session.ts:1429-1445`）；funnel 已经能用同一套动词把一条 workflow 链结算为 cancelled（钉在 `hosted-child-agent-session.test.ts:1123`）。
  - workflow child 的首个 Turn 在进程内运行其脚本，Turn 的 abort 信号接到 `WorkflowRunner.abort()`（`hosted-workflow-turn.ts:261-273`）；start 被挂起时注册表侧的取消经 `WorkflowStartCancelledError` 把该 Turn 结算为 cancelled（`hosted-harness-session.ts:3088-3096`）。relay 读取的 `turn.cancel.requested` 日志证据是通用 Turn 取消记录，两种 kind 完全一致。
- **authority 已经准纳该记录。** `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 已列出 `workflow`（`managed-session-records.ts:199-203`），所以今天对 workflow 行提交 `stopRequested` 修订即可通过 —— close cascade 产出的正是这个修订。
- **waiter 文案已经按 kind 命名。** `childRunEndedText` 经 `childKindLabel` 渲染（`hosted-child-agent-session.ts:346-360`）：被停止的 workflow child 应答「Workflow child run cancelled (stop_requested).」。
- **契约只点名了 child_agent。** `info.description` 的 v1.40 段与 `TaskActionCapability` 的 description 都把取消描述为 `child_agent` 的动作。
- **WebShell 任务面板只显示 `child_agent` 任务**（`ManagedTaskPanel.tsx:103`），所以它的取消客户端根本观察不到 workflow 任务（`use-managed-task-cancel.ts:311` 的 kind 检查对 workflow 不可达）。

## 决定

1. **只改一个集合成员；Java 生产代码没有其他改动。** `CANCELLABLE_TASK_KINDS` 变为 `{child_agent, workflow}`，其注释重写：workflow 运行的取消走与 child agent 完全相同的持久停止请求、record-first 判定、有界投递与 relay 停止臂。视图、准入重查与判定三者按构造保持一致，因为它们读的是同一条规则。
   - workflow 运行的任务状态就是 `child_run` 的共享词汇，所以 `CANCELLABLE_TASK_STATES`（`pending`、`running`、`waiting`、`degraded`）原样适用；终态或 `recovery_blocked` 的 workflow 任务不公布动作，新取消答复 `409 task_action_unavailable`，与 child agent 完全一致。
   - record-first 判定的关键不变量对该 kind 成立：终态 `child_run` 修订冻结除 delivery 行之外的一切（`isChildRunSuccessor` 同时服务两种 kind），所以「已结束且无停止请求」仍是唯一确定性的拒绝；赢得竞争的天然完成保留其普通结算，并把该请求记录在案。
2. **TypeScript 生产代码零改动。** 上面的现状清单就是整条路径，其中每一环要么已经与 kind 无关，要么已经准纳 `workflow`。本片在 TS 侧不新增任何东西；现有的 workflow funnel 测试（`hosted-child-agent-session.test.ts:1123`、`hosted-workflow-turn.test.ts` 的 abort 接线钉住）即为证据。
3. **无迁移。** `managed_agent_operation.task_id`（V62）与 kind 无关，operation 行不携带 kind。单 open operation 规则、parked 取消的排除与生命周期扫描的排除都按 `TASK_CANCEL` 键控，与任务 kind 无关。
4. **契约 1.46.0 只是点名该 kind；没有形状或状态变化。** 两条取消路由保持 `partial` —— 路由集、结果集与 operation 形状都是 v1.40 的。只点名 `child_agent` 的两处描述文本予以更新，`info.description` 增加 v1.46 段。本片按 `1.45.0` 撰写；main 的持久化整合（#14069）在本分支在飞期间占用了 `1.45.0`，故本片以 `1.46.0` 交付。
5. **WebShell 面板在本片保持 child_agent 范围。** 面板的任务过滤是 #13936 自己的范围决定；把面板与其提交闸门放宽到 workflow 任务是 WebShell 的后续工作，不属于提供路由本身。服务端在 workflow 任务上公布的 `cancel` 无论如何都符合契约事实：路由确实提供它。
6. **该类型的 F 阶段故障轮次随本片一起走。** #13746 的 F 阶段说明要求在某个 kind 上提供取消就欠该 kind 的故障轮次 —— 取消应答丢失、结算过程中取消、所有者消失后取消 —— 按 #13823 的形状在真实栈上运行（打包链路、脚本化模型、故障注入 tap）。同一场次顺带关闭 `child_agent` 轮次剩余的一个时序（所有者消失后取消），那是 #13823 验收推迟的。

## 契约变更（1.46.0）

- `info.version`：`1.45.0` → `1.46.0`。
- `info.description` 增加：「v1.46 extends public task cancel to workflow tasks (the H4f follow-up of the workflow runtime): a workflow task in pending, running, waiting or degraded, in an active Session, advertises cancel; its cancel rides the same durable task_cancel operation as a child agent's, and the result relay stops the workflow child through its own Turn's abort.」
- `TaskActionCapability` 的 description：「cancel: the cancel route accepts a new command for this task (since 1.40 for child_agent and 1.46 for workflow, tasks of those kinds in pending, running, waiting or degraded, in an active Session); …」—— 其余不变。
- 生成的 WebShell 类型在同一变更中重新生成（在 `packages/web-shell` 跑 `npm run generate:managed-agent-api`）：`TaskActionCapability` 的 JSDoc 随 description 同步，无形状变化。一致性门禁 `managed-agent-api.test.ts` 会把生成文件与契约的即时渲染逐字节比较，不一致即失败 —— 任何契约文本改动都要重新生成。
- 没有其他：无路由、形状、错误码或状态变化。

## 验证

- **存储**（`ManagedTaskCancelOperationTest`，H2 + Flyway）：按状态的动作规则增加 workflow 臂；准入、回放与 digest 冲突对一个 workflow 任务各跑一遍。
- **投递**（`TaskCancelCoordinatorTest`）：`TaskTarget` 夹具新增 workflow 形状；从记录完成、`task_already_settled`（不发送）与一次实时发送各对 workflow 目标跑一遍。
- **Relay**（`ChildResultRelayTest`）：不变 —— 停止臂对 kind 不可见（`RelayRow` 不携带任务 kind，停止臂也不读取），所以它的 child_agent 停止夹具就是 workflow 的证据；携带 kind 的证据在存储层与真实记录链两层。
- **真实记录**（`ManagedExtensionRecordStoreTest`）：一条 workflow 链经 Session store 提交，走过停止请求与取消 —— 每一步公布的动作、`draining` 运行时状态、落日志的 `state_changed` 事件与输出游标，与 child_agent 的钉住相对称。
- **契约**（`ManagedAgentApiContractTest`、`PlannedTaskContractTest`、`SurfaceAdmissionAcceptanceTest`）：一个 workflow 任务在两个面上的取消往返，以及描述文本钉住的更新。
- **TS**：无新行为；funnel 的 workflow 取消动词与 workflow Turn 的 abort 接线均已钉住（`hosted-child-agent-session.test.ts:1123`、`hosted-workflow-turn.test.ts`）。
- **真实栈**：决定 6 的 F 阶段轮次，计划写在 `.qwen/e2e-tests/2026-10-13-managed-workflow-task-cancel.md`。

## 后续工作

| 项                    | 范围                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3 类型               | **已在 [H4f-c](2026-10-17-managed-h3-task-cancel.zh-CN.md) 交付：** A8（#13889）已把被平台停止的 Shell 结算为 `stop_requested`；两类加入 `CANCELLABLE_TASK_KINDS`，其投递经 Runtime Broker 停止进程，Monitor 的 `stop_requested` 结算即其已记录的停止。 |
| `automation_run`      | 不携带停止请求；归 H6 的 per_run 目标所有。                                                                                                                                                                                                             |
| Channel delivery 取消 | **已在 [#13746 F3](2026-10-17-managed-delivery-task-cancel.zh-CN.md) 交付：** 投递投影为其路由 Session 的任务（`channel_delivery`），在尚无适配器认领时走同一条任务取消；不再需要决策 10 所说的独立路由。                                               |
| Child 输出事件        | 已由 [child Session 链接](2026-10-17-managed-child-task-session-link.zh-CN.md)（#13746 F2）交付：workflow 任务像 child agent 任务一样给出其 child Session。                                                                                             |
| WebShell 面板         | **已交付：** 面板与其他所有类型一起列出 workflow 任务，并在任务公布取消时接受取消（[面板文档](2026-10-12-managed-child-task-panel.zh-CN.md)）。                                                                                                         |
| Close 停止 child      | [#13875](https://github.com/QwenLM/qwen-code/issues/13875)，不变：relay 的停止臂仍跳过不再 `ACTIVE` 的父 Session。                                                                                                                                      |
