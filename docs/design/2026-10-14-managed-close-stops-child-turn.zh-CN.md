# 父会话关闭时停止每个 child 的运行中 Turn（#13875）

[English](2026-10-14-managed-close-stops-child-turn.md) | [简体中文](2026-10-14-managed-close-stops-child-turn.zh-CN.md)

状态：本变更已实现。交付 [#13875](https://github.com/QwenLM/qwen-code/issues/13875)，即 [H4f](2026-10-10-managed-task-cancel.md) 真实栈验收的发现 2。单元级验证已完成；issue 的真实栈验收探针列在「验证」一节，尚待重跑。

## 问题

关闭父会话会为每个仍在运行的 child 记录一条停止请求，然后**等待 child 的 Turn 自己结束**——最长等到 Harness 的 Turn 截止时间（`qwen.managed-agent.harness.turn-deadline`，默认 30 分钟）。调用方先取消 child 的任务再关闭（这是自然的清理顺序）也得不到更快的停止：紧跟取消之后被接纳的关闭仍然要等，因为唯一在物理上停止 child 的工作者——child 结果 relay 的停止分支（H4f）——会在父会话不再是 `ACTIVE` 时提前返回，而关闭准入会先把父会话置为 `CLOSING`。等待期间，child 继续在 owner 已要求关闭的 Workspace 里调用模型、运行工具。

## 变更前的现状

- 关闭级联（`SessionLifecycleCoordinator.cascadeChildScopes`）向每个 child 发送 `cancel` 操作（在 run 记录上写入 `stopRequested`），然后接纳 child 自身的关闭。child 有活跃 Turn 时这个关闭会被拒绝（"The Session has an active Turn."），拒绝被记为关闭债务，父关闭经调度重试重新排队。这条路径上没有任何东西取消 Turn。
- relay 的停止分支通过 `ManagedAgentService.cancelChildTurn` 取消 Turn，但只在父会话为 `ACTIVE` 时运行。关闭一旦被接纳，relay 尚未处理的停止请求就再也不会被处理。

## 决策：级联自己取消 Turn（方案 B）

#13875 给了两个方案。方案 A——relay 的停止分支在父会话为 `CLOSING` 时也运行——把取消留在 relay，但必须重新打开 relay 的提前返回（它同时守护着不向正在关闭的父会话投递结果），还必须仲裁两个结算者：停止分支与级联都会以 `close_scope` 结算 run，而只有一次结算可以提交。**方案 B 即本实现：级联在接纳 child 关闭之前，用与停止分支相同的带 key 的 `cancelChildTurn`，自己取消每个 child 的活跃 Turn。** relay 不变，没有事先公开取消的关闭也被同一条分支覆盖。任一时刻只有一个驱动者拥有停止权：父会话为 `ACTIVE` 时归 relay；关闭被接纳后归级联。带 key 的命令（父、run、Turn）让这次交接重放安全。

## 工作方式

在级联的逐 child 处理中，停止请求记录之后、关闭能力门禁之前：

| child 的最新 Turn                          | 级联行为                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCEPTED` 或 `RUNNING`                    | 调用 `cancelChildTurn`（重驱动只会重放带 key 的准入），然后记为债务等待重新排队——Turn 仍在运行时 child 关闭仍会被拒绝，所以下一轮在 Turn 结算后再接纳它。 |
| `CANCELLING`                               | 经重试等待；Turn 自己拥有其结果，不重复驱动取消。                                                                                                         |
| 终态（`COMPLETED`、`CANCELLED`、`FAILED`） | 不取消；走既有的 child 关闭与 `close_scope` 结算。                                                                                                        |
| 无 Turn                                    | 不变（never-started 配对逻辑）。                                                                                                                          |

- 在取消落地之前就已完成的 Turn 保留其自然结果：带 key 的取消对已结束的 Turn 不生效；而 relay 已结算过的 run 由记录后继规则冻结，级联的 `close_scope` 无法改写。
- 停止动作只在停止请求持久化之后执行：`cancel` 操作失败会把 Turn 取消推迟到后续轮次（child 关闭尝试本身不变），因此按父 `ACTIVE` 状态工作的 relay 绝不会看到一个没有已记录请求的已取消 Turn 并把它结算成 `child_failed`。请求提交后，任何看到 Turn 被取消的观察者同时也能看到该请求，并以 `stop_requested` 结算 `cancelled`。
- 持有会话消息（H4d-b）的 child 会在 Turn 取消**之前**先停掉消息路由，与 relay 的停止分支同一顺序：取消自身的 load 可能启动 wake pump 消费排队的 input。消息 stop 失败时不驱动 Turn 取消。Turn 进入终态后，child 自身的关闭会停掉剩余消息工作（「holding the Session as a close does」），那里不再需要单独的 stop。
- 嵌套 child 递归：每个 child 自身的关闭会运行同一个级联。删除也走同一个级联（`settle` 对 `CLOSE` 与 `DELETE` 都调用它），所以删除活跃会话同样停止其 child。

## 边界

- run 的终态修订不变：`close_scope` 以 `stop_requested` 结算 `cancelled`。Turn 自然完成但结果从未被投递的 child（relay 不向正在关闭的父会话投递）仍然结算 `cancelled`。这是 H4b 的关闭语义，本变更有意不改：Turn 自身的 `COMPLETED` 结果与其产物完整保留在 child 会话自己的记录里，没有任何东西被改写。
- 重新排队的节奏不变（调度退避）。取消新增的每一轮都做持久工作，因此关闭在几秒内完成，而不是等到 Turn 自然结束。
- Turn 取消失败与其他 child 动词失败一样记为关闭债务：记日志、重新排队，绝不凭猜测结算。

## 验证

- `SessionLifecycleCoordinatorTest#theCascadeCancelsTheChildsActiveTurnInsteadOfWaitingForIt`（在 `ACCEPTED` 与 `RUNNING` 上参数化）：child 的 Turn 永远不会自己结束。级联恰好驱动一次带 key 的取消——Turn 处于 `CANCELLING` 的后续一轮只重记停止请求、不重复驱动——Turn 结算为 `CANCELLED` 后 child 关闭被接纳，父关闭无需等待即完成。该测试先作为失败的复现写出，修复后通过。
- 同套件的停止路径故障分支：`theCascadeRetriesAFalteredChildTurnCancel`（取消失败保留债务并重新驱动）、`aFalteredStopRequestDefersTheTurnCancelUntilItIsDurable`（首个持久化停止请求之前不做 Turn 取消）、`theCascadeStopsTheMessageRouteBeforeCancellingTheTurn`（消息 stop 先于 Turn 取消）、`aFalteredMessageStopDefersTheTurnCancel`（消息 stop 失败时不驱动 Turn 取消）与 `aToleratedMessageStopRefusalStillCancelsTheTurn`（两个容忍拒绝码 `hosted_turn_recovery_required`、`hosted_session_closing` 不推迟 Turn 取消）。
- 回归：`SessionLifecycleCoordinatorTest`（29 个测试）、`ChildResultRelayTest`（106 个）、`ManagedCwdChangeOperationTest`（48 个），以及 `managed-agent-server` 模块全量套件。模块套件唯一的失败是 `BackfillWitnessesTest`（一个 Flyway baseline 版本断言），在未修改的 HEAD 上以同样方式失败——已做基线核对，与本变更无关。Checkstyle 与 SpotBugs：干净。
- 真实栈，在打包链路上用脚本化的慢 child（issue 的验收探针）：
  - S8a（先取消再关闭）与 S8b（只关闭）：child 的 Turn 在关闭被接纳后几秒内以 `CANCELLED` 结束，父关闭不等 Turn 自然结束即完成。
  - 在竞争窗口里完成的 child 保留其自然 Turn 结果与其产物。
  - 排着 H4d-b 消息的 child：消息永不被消费，run 结算 `cancelled`。
  - 两层树：关闭能停下两层。
  - 删除活跃会话时同样停止其 child。

## 后续工作

无新增。H4f 后续工作表中的「关闭时停止 child」一行由本变更交付。
