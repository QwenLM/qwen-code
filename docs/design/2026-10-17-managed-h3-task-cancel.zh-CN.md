# Managed 后台 Shell 与 Monitor 的任务取消（H4f-c）

[English](2026-10-17-managed-h3-task-cancel.md) | [简体中文](2026-10-17-managed-h3-task-cancel.zh-CN.md)

状态：已在本变更中实现。`background_shell` 与 `monitor` 两类任务加入公开任务取消路径，契约在 `1.54.0` 中点名它们。已落地：两类加入唯一的可取消类型规则；投递经内嵌 Runtime Broker 停止任务的进程；verdict 把 Monitor 的 `stop_requested` 结算读作其已记录的停止；以及一个真实栈门禁（FG8g），分别取消一个运行中的后台 Shell 与一个运行中的 Monitor watch。没有 TypeScript 改动。

这是 [#13746](https://github.com/QwenLM/qwen-code/issues/13746) F1 的 H3 部分，即 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H4f-c 切片，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的阶段 H。H4f 切片（#13823，[设计](2026-10-10-managed-task-cancel.zh-CN.md)）取消 `child_agent` 任务，H4f-b 切片（#14076，[设计](2026-10-13-managed-workflow-task-cancel.zh-CN.md)）加入了 `workflow`。两者都把这两类推迟到其门禁解除之后，而 #13889（[H3 启用](2026-10-11-managed-h3-enablement.zh-CN.md)）已解除门禁。

## 问题

自 #13889 起，模型可以启动一个后台 Shell（带 `is_background` 的 `run_shell_command`）或一个 Monitor watch。它们比所在 turn 活得更久，并持有其 Runtime 直到退出。两者都是调用者能列出、能观察、却不能停止的任务：取消回 `409 task_action_unavailable`，任务视图也不公布任何动作。唯一的停止方式是 Session 关闭时的排空，而它会停掉所有东西。

## 现状

核对于 `3bddf6e0bb`（契约 `1.51.0`）：

- **门禁。** `CANCELLABLE_TASK_KINDS` 为 `{child_agent, workflow}`（`ManagedExtensionProjection.java:130`）。它的读取方是视图与准入共用的 `taskActions`，以及 `TaskCancelCoordinator` 中投递的 verdict。
- **记录。** 后台 Shell 是 `kind: "shell"` 的 `child_run` 记录，Monitor 是 `monitor_run` 记录。每条记录的 id 都是启动调用的 `executionCallId`（`hosted-workspace-tool-turn.ts:4120`、`:4128`）。Shell 记录体有一个只设一次的 `stopRequested`；`monitor_run` 记录体没有，且其键集合是闭合的（`ManagedExtensionRecords.java:161`）。
- **平台停止已经投影为停止（A8，#13889）。**
  - worker 的注册表在被要求停止某个 run 时，先打标记再杀进程（`managed-background-shell-registry.ts:141`）；Monitor 注册表委托给它（`managed-monitor-registry.ts:80`）。
  - 停止只在 run 完成时才应答，也就是带停止标记的 finalize 已投递之后（`:146`）。
  - Hosted 发布器对带标记的 Shell 结束先 `requestStop` 再 `settleStopRequested`（`hosted-shell-publisher.ts:919`）；对带标记的 Monitor 结束则交给该 watch 的 loop，由它结算 `stop_requested`（`:806`、`hosted-monitor-loop.ts:268`）。
- **谁能停止单个进程。**
  - Broker 的排空扫描对一个 Runtime Session 的每个 hold 行依次执行 status、该族的停止（`shell-terminate` 或 `monitor-stop`）、再 status（`RuntimeBrokerService.java:2658`）。只有 worker 的 `exited` 应答才会结算该行。
  - 客户端控制路由只放行 Monitor 类，且限本 Session 自己的 watch（#13896）。Shell 类会落到 provider 协议并被拒绝（`:828`）。
  - Hosted Harness 没有能停止单个 Shell 或 Monitor 的路由。`/children/operations` 只服务 child Session 类；对 Shell 记录调用它的 `cancel` 会抛错（`hosted-child-agent-session.ts:1794`）。
- **H4f 的后续行**要求「Shell 在其请求之后结算为 `stop_requested`，Monitor 获得停止请求」。A8 已交付前一半，决策 2 替代后一半。

## 决策

1. **两类 H3 任务加入同一条规则。**
   - `CANCELLABLE_TASK_KINDS` 变为 `{child_agent, workflow, background_shell, monitor}`。视图、准入复查与 verdict 读取同一个集合，因此天然一致。
   - 状态不变：`pending`、`running`、`waiting` 或 `degraded`，且 Session 为 `ACTIVE`。
   - `recovery_blocked` 的 run 仍不公布任何动作：对被阻塞 run 的停止无法到达其所有者（H3 未决问题 3）。

2. **记录自身的停止就是 authority 的陈述；Monitor 不新增字段。**
   - Shell 的停止就是其 `stopRequested` 标志，A8 在结算之前写入它。
   - Monitor 的停止就是其 `stop_requested` 结算。给 `monitor_run` 加停止请求会改动两种语言中闭合的记录体及其 fixtures，还会立起回滚下限：旧的读取方会拒绝这条记录。
   - Monitor 的停止短且有界（worker 的 5 s 宽限），所以它的接受与物理结算就是同一次提交；verdict 仍然只读已提交的记录。
   - 后果：
     - Monitor 的操作在其任务结算为 `cancelled` 的同一刻完成。
     - Monitor 永远不投影 `draining`。
     - 任何 `stop_requested` 结算都会完成一个待定的 Monitor 取消，例如关闭排空所产生的结算。与其他类型一样，请求会合并。

3. **投递经内嵌 Broker 停止进程，而不是经 Harness。**
   - 新增的 `RuntimeBrokerService.stopBackgroundProcess(tenant, session, executionCallId)` 查找 hold 行 `<executionCallId>:process`。它要求：
     - 该行属于任务所在的 Session：其 Harness Session 就是该 managed Session，且 Runtime Session 的租户一致；
     - 该 Runtime Session 在本 Broker 中处于就绪。
   - 然后对这一行执行排空扫描的 status → 停止 → status。
   - **为什么用 Broker。**
     - Broker 拥有 hold 行，并且关闭排空时本来就发出完全相同的停止。
     - 对于空闲的后台 run，Harness 没有任何能在其重启后保留的句柄：发布器的 capture 与 Monitor loop 都在其进程内，而被持有的 Runtime Session 只会被关闭重新获取——每个 turn 获取的是以自己 id 命名的 Runtime Session，所以后续 turn 永远不会重新获取后台 run 所持有的那一个。
     - 没有落地的停止会让记录保持存活，于是 coordinator 的有预算重试会重新驱动它。不需要新的扫描器，就得到了持久的重驱动。
   - **为什么不加 fence。** 它像 #13896 的客户端 Monitor 控制那样运行：未终态的 hold 行本来就阻止 Runtime Session 被释放；加 fence 的控制会让与之竞争的关闭排空回 `runtime_session_busy`。

4. **结果沿用 H4f 的表。**

   | 已提交的记录                                                               | 操作结果                                                |
   | -------------------------------------------------------------------------- | ------------------------------------------------------- |
   | 停止已记录（Shell 的 `stopRequested`、Monitor 的 `stop_requested`）        | `completed`，带 receipt                                 |
   | run 在没有停止的情况下结束（`exited`、`max_events`、`idle_timeout`、失败） | `failed` `task_already_settled`                         |
   | run 仍存活                                                                 | 经 Broker 停止，然后再读一次记录                        |
   | 停止未获证明                                                               | 在预算内重试，之后停成 `recovery_blocked`（H4f 决策 5） |
   - **哪些算未获证明：** worker 无法证明结束，或者没有配置 Broker。
   - **本 Broker 没有其上下文的 Runtime Session**（Java 重启后的新进程中，在关闭重新获取它之前）会让取消立即停住而不是重试：空闲 Session 所持有的 Runtime Session 只会随关闭回来，而一个 open 的取消会在整个预算期间占住 Session 的操作位，也就挡住了那次关闭。停住的取消不占任何东西，所以关闭可以继续，关闭排空的 `stop_requested` 结算会在下一次复查时完成这个停住的取消。停住前会先重读记录，所以期间已结束的进程照常结算取消。
   - **与自然完成的竞争：**
     - 停止的第一次 status 读取发现的自然结束，保留其结果。
     - 落在停止自身窗口内的结束会带标记，因为 worker 先打标记再杀进程；它投影为 `stop_requested`，与关闭排空遵循同一条 A8 规则。

5. **没有 TypeScript 改动。** worker 的标记、发布器的 A8 结算以及 Monitor loop 对带标记退出的处理都已存在。verdict 所需的一切，记录都已提交。

## 契约变更（1.54.0）

- `TaskActionCapability` 的描述在 `child_agent` 与 `workflow` 之外点名 `background_shell` 与 `monitor`。
- `info.description` 增加 v1.54 段落。
- 没有路由、schema 或状态变化。两条取消路由仍为 `partial`。

## 验证

- **投递**（`TaskCancelCoordinatorTest`，新增 6 个测试）：
  - 运行中的 Shell 经 Broker 停止、从不走 child operation 路由，并从其记录完成；
  - Monitor 从其 `stop_requested` 结算完成；
  - 先以 `exited` 或 `idle_timeout` 结束的进程以 `task_already_settled` 失败，已结算的进程从不被停止；
  - 未获证明的停止与缺失的 Broker 都从记录出发重试；
  - Broker 没有其上下文的 Runtime Session 让取消在第一次认领时停住；
  - 对期间已结束的进程，无法到达的停止会从记录结算取消，而不是停住。
  - 没有取消路径的类型改用 `automation_run`。
- **准入**（`ManagedTaskCancelOperationTest`，新增 1 个测试）：两类与其他类型一样按状态准入、重放与拒绝；`automation_run` 仍回 `task_action_unavailable`。
- **Broker**（`RuntimeBrokerServiceTest`，新增 1 个测试）：
  - 另一个 Harness Session、另一个租户，或没有 hold 行的 id，都回 `runtime_execution_not_found`，且不发出任何控制；
  - 未获证明的停止依次请求 status、停止、status 并保留 hold，所以常规释放仍回 `runtime_session_held`；
  - 已获证明的停止以启动调用为 `targetOperationId` 结算该行，之后释放成功；
  - 已结算的行不再被询问。
- **真实栈**（FG8g，`HostedMonitorRunFaultGatesIT`，MySQL 8.4，打包的 Harness，委派的 cgroup v2）：一个用例取消一个卡在 FIFO 门上的运行中后台 Shell，另一个取消一个运行中的 Monitor watch。每个用例检查：
  - 任务公布 `cancel`，公开路由回 `202` `task_cancel`；
  - 操作读为 `completed`，同 key 重放返回它；
  - 任务读为 `cancelled` 且无动作；
  - 经 JDBC：一条 `TASK_CANCEL` 行为 `COMPLETED` 且带 receipt；记录以 `stop_requested` 为 `cancelled`（Shell 还带 `stopRequested`）；hold 行为 `SETTLED`。
  - **结果：** 在 Linux x86_64（MySQL 8.4.6，委派的 cgroup v2 根）上跑 5 次全部通过，两个进程都由 `SIGTERM` 结束。
    - Shell 用例每次都在第二次认领时完成，距准入 6.2 至 7.1 s。worker 的第一次 terminate 在 unit 报告清空之前就应答了，属于未获证明的停止；一个退避之后的重试读到了保留的退出与已结算的记录。
    - Monitor 用例在第一次认领时完成，用时 0.3 至 5.1 s。
- **未覆盖：**
  - **真实栈上的故障分支。** 取消应答丢失、worker finalize 时 Harness 宕机、Java 重启后取消，只由「先读记录」的单元测试覆盖。
  - **WebShell 面板。** 在面板中列出这些类型是面板自己的变更。

## 约束与风险

- **worker finalize 时 Harness 宕机。** 发布器接不住 finalize 时，记录保持存活。取消会重试，耗尽预算后停住，并在记录结算后对账：经 finalize 的重驱动、下一次获取时的观察，或关闭。
- **Java 重启。** 在关闭重新获取之前，新 Broker 进程中没有被持有的 Runtime Session。这段时间里的取消会立即停住（决策 4）；调用者关闭 Session，其排空会停止进程并完成那个停住的取消。
- **本可由重试到达进程的窗口。** 立即停住用这些窗口换来了不被阻塞的关闭：Java 重启时持有该 Runtime Session 的 turn 仍在运行，该 turn 的 takeover 大约一个租约之后会以原 id 重新获取它；取消落在 acquire 的作用域检查与上下文登记之间；以及有多个副本的控制面，认领可能落在不持有该上下文的副本上（多个存活控制面不在首个版本范围内）。这些情况下取消都停在未确认状态，由调用者重新发起；不会有任何结果报告一次没有发生的停止。
- **带标记的竞争。** 落在停止窗口内的退出投影为 `stop_requested` 而不是 `exited`。这是关闭排空的规则，已在 A8 中接受。

## 后续工作

| 项               | 范围                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation_run` | 没有停止请求；归 H6 的 per_run 目标。                                                                                                                                                                     |
| channel 投递取消 | **已在 [#13746 F3](2026-10-17-managed-delivery-task-cancel.zh-CN.md) 交付：** 投递投影为其路由 Session 的任务（`channel_delivery`），在尚无适配器认领时走同一条任务取消；不再需要决策 10 所说的独立路由。 |
| child 输出       | #13746 F2：把 child 任务链接到其 child Session。                                                                                                                                                          |
| WebShell 面板    | 显示 `workflow`、`background_shell` 与 `monitor` 任务并接受其取消（`ManagedTaskPanel.tsx`、`use-managed-task-cancel.ts`）。                                                                               |
| F 阶段故障分支   | FG8g 在真实栈上覆盖取消应答丢失、finalize 时 Harness 宕机、Java 重启后取消。                                                                                                                              |
