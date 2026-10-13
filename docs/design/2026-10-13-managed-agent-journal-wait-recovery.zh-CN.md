# Managed Agent Journal-Wait 恢复

[English](2026-10-13-managed-agent-journal-wait-recovery.md) | [简体中文](2026-10-13-managed-agent-journal-wait-recovery.zh-CN.md)

状态：由本设计随附的改动实现。

## 问题

Hosted 工具轮次可能只包含控制面调用：后台 Agent 或 Workflow 启动、Session 消息，或 lead 侧 team/task 操作。这些调用会写入持久化领域记录，但不会创建 Runtime binding。因此 Harness 会跳过 `commitAwaitRuntimeBatch`，后台启动也会跳过前台调用使用的 `await_agent` checkpoint。若 Harness 在某个领域写入之后、下一个 checkpoint 之前退出，替代 Harness 会看到 `model_start` 或 `unresolved_after_settle`，拒绝接管 Turn，并让 lead Session 永久阻塞。虽然已有按持久化事实回答的 helper，但接管会在 helper 运行前被拒绝。

## 目标

- 在第一次领域写入前，让零 Runtime 的控制面批次可恢复。
- 按持久化记录回答已提交调用，把未执行调用回答为 never run，且不重复副作用。
- 在 default 与 yolo 审批模式、Hooks Session、team/task 调用、匿名或命名后台启动中保持一致行为。
- 让前台 child wait、成员 command wait 和 Runtime 批次继续使用现有专用 checkpoint。

## 设计

Harness checkpoint schema 新增 `await_journal` 和 `journalWait` group。该 group 记录每个受保护函数调用的 `functionCallId` 和 `toolName`，不保存可变业务结果。对于不需要现有前台 Agent wait 或成员 command wait 的零 Runtime 批次，在第一个调用可能写入 child、team、task、workflow 或 message 记录之前，以 `HARNESS_DURABLE_WAIT_BOUNDARY` 提交该 group。

实时批次提交全部 tool result 并完成 PostTool Hook 后，将 journal wait 解析为 `model_output_committed`。解析后的 checkpoint 继续携带 group。这样即使解析后再次崩溃，替代 activation 仍可识别并接管该 Turn，再开始下一轮模型调用。

恢复报告使用 `await_journal`，且不获取 Runtime lease。每个记录的调用都是结果可由 journal 判定的执行：wait 打开时状态为 `executing`，解析后为 `settled`。continue 路径调用现有 `answerResumedTurnCalls`：它从 child/team/task/message journal 推导真实响应，用已有 never-run 响应补齐未执行调用，并跳过已经写入 journal 的 tool result；随后解析或重新认领 journal wait，并从完整 tool-result 轮次继续模型。取消路径使用相同的 journal 派生回答，解析 wait，再写入 cancelled 终态。

只有当固定 checkpoint 是 journal wait 时，Hooks Session 才可使用相同的 continue 和 cancel 路径。恢复会重建现有 Hook owner，并复用当前 occurrence identity，使 PostToolUse 和 PostToolUseFailure 保持幂等；这些 Hook 完成前不得解析 journal wait。

Runtime 批次继续使用 `await_runtime`；前台 Agent 与 Workflow 调用继续使用 `await_agent`；成员 command 继续使用 `await_command`。包含这些专用 wait 的批次不创建通用 journal wait，避免出现相互竞争的 durable boundary。

## 失败语义

- 相同的 journal-wait 提交可安全重放；不同调用集合会冲突。
- checkpoint 先于所有受保护的领域写入。专用前台 wait 现有的 admission 到 checkpoint 窗口保持不变。
- checkpoint 读取或 journal 写入的瞬时失败继续保持可重试，不生成伪造终态。
- 未知 phase、畸形 group、Turn 不匹配或不支持的 Hook 状态继续阻塞。
- 恢复不会重放已提交的 child/team/task/message 操作；响应由持久化记录决定。

## 验证

- 单测覆盖 checkpoint 解析、phase invariant、重放、解析、携带 group 的 activation 认领和冲突。
- 重新运行受控后台 child 崩溃复现，断言接管可以继续、原 Turn 结算、后续 load 成功，并且 child result 只接收一次。
- 覆盖命名成员在 join 前后崩溃、lead `task_create`/`task_update`、Hooks、yolo、取消和 resolve 后再次崩溃窗口。
- 运行聚焦的 TypeScript build/typecheck/test 和 Java client/coordinator 测试；当主机提供 Java 与 Docker 时，再运行一次原生 Hosted/MySQL 崩溃验收。

## 验收标准

Harness 在 journal wait 提交后的任意位置崩溃时，替代 Harness 都能继续或取消同一个 Turn。已提交调用得到原始持久化回答，未执行调用得到 never-run 回答，领域操作不会重复，lead Session 可以接收后续 Turn，已完成 child 可以 attach 并交付结果。
