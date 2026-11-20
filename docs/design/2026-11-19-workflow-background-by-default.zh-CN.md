# workflow 默认后台运行

[English](2026-11-19-workflow-background-by-default.md) | [简体中文](2026-11-19-workflow-background-by-default.zh-CN.md)

状态：提议。第 1 步（headless 模式支持后台运行）已在同一变更中实现；第 2、3 步在后续变更中完成。

## 问题

前台 workflow 会一直占住它的工具调用，直到运行结束，最长可达 30 分钟的总时长上限。这段时间里模型的回合被阻塞，用户只能等着看。后台运行会立刻返回运行句柄，运行结束后通过对话汇报，但只有模型主动要求时才会用到：`run_in_background` 默认为 `false`，headless 运行（`qwen -p`、stream-json）则直接拒绝它。

## 现状

- Workflow 工具在交互式 TUI 和 ACP 会话（Web Shell、IDE 客户端）里接受 `run_in_background: true`。这两者都登记了 workflow 完成回调，把结果送进会话的通知队列。
- headless 运行没有登记 workflow 完成回调，退出前的等待也只等后台 agent，所以工具在这里拒绝后台 workflow。
- 有些宿主有意让 workflow 留在前台：Qwen Session Agent（它的 adapter 只返回原始 prompt 的结果）、收不到后台结果的 Channel 回合，以及关掉 workflow 控制的 ACP 会话（workflows 被禁用、bare 模式、不受信任的工作区）。
- 需要在同一回合内拿到结果的内置 skill，要么显式传 `run_in_background: false`（`review`），要么依赖默认值（`autofix-pr` 的前台分支）。

## 目标

- 每个能把结果送回对话的宿主都接受后台 workflow 运行，包括 headless。
- 调用方没有指定时，只要宿主支持，workflow 就在后台运行。
- 前台模式继续保留：可以显式要求，也作为宿主不支持后台时的回退。

不做：取消前台模式、改变 Session Agent 或 Channel 送回结果的方式、执行视图改版。

## 设计

1. **headless 送回结果（本变更）。**
   - headless 运行登记一个 workflow 完成回调，把完成结果作为通知排进队列，方式和后台 agent 的结果相同，运行结束时清除回调。stream-json 会话的每个 prompt 都走同一段代码，所以行为一致。
   - 输出最终结果前，只要还有 workflow 处于启动中、运行中或暂停中（pausing），运行就继续等待，并把每个完成结果作为一个回合处理。
   - 被取消的运行不发完成通知；已暂停的运行在无人值守的运行里等不到恢复。所以这两种都不会让运行一直挂着，收尾时会把剩下的取消。
   - 所有让运行提前结束的路径（任何时刻的中断或 `--max-wall-time` 触发的中止、structured output、循环检测）都会取消正在运行的 workflow，并等每个 workflow 最多 2 秒，让它记录自己的结束。来得及结束的运行会保存为 `cancelled` 并删除 checkpoint，不会被当成因崩溃而中断的运行。
   - `hostSupportsBackgroundWorkflows` 对所有非 ACP 宿主都返回支持。没有登记完成回调时，工具仍然拒绝后台运行，所以送不回结果的宿主继续按失败处理。
   - 参数和运行时说明写明：headless 运行会等后台 workflow 结束后才退出。
2. **默认后台（下一个变更）。**
   - 没传 `run_in_background` 时，宿主支持就走后台，不支持就走前台。显式传 `true` 在不支持的宿主里仍然被拒绝；显式传 `false` 留在前台。
   - 已保存 workflow 的斜杠命令遵循同样的默认值。
   - 告诉模型"省略这个参数"的拒绝文案，改成"传 `false`"。依赖"不传就是前台"的 skill 步骤改为显式传 `false`。
3. **执行视图（之后）。** 改版把后台运行当作常见情况：内联卡片仍是运行的实时视图，完整细节放在 Workflows 页面和 Background tasks 对话框里。

## 决定

- **保留前台模式。** 有些调用方需要在同一回合内拿到结果：review 的每一波、要把结果交回调用方的 Session Agent、没有 chat 可汇报的 Channel 回合。
- **参数省略时回退而不是报错。** 调用方没有要求后台，所以不支持后台的宿主按现在的方式运行。
- **headless 不另设等待上限。** workflow 自身的总时长上限（`QWEN_CODE_MAX_WORKFLOW_SECONDS`，默认 30 分钟）已经限定了等待时间，`--max-wall-time` 限定整个 headless 运行。
- **取消回合不再停止后台运行。** 要在 Background tasks 或 `/workflows` 里停止；headless 运行里，中断会取消它。
- **本变更不为 workflow 发 SDK 任务事件。** 被取消的 workflow 不发完成通知，所以 `task_started` 事件不一定能和 `task_notification` 配对。stream-json 的使用方会看到作为 user message 的完成摘要，以及它引发的回合。

## 风险

- 启动了后台 workflow 的 headless 运行，现在会持续到 workflow 结束，而不是让工具调用失败。
- stream-json 会话里已暂停的后台 workflow 不会让 prompt 挂着；如果它在这个 prompt 结束后被恢复并跑完，它的完成通知送不出去。
- stream-json 会话能恢复的中断，会让后台 workflow 继续运行，和后台 agent 一样。只有它结束时恰好有后续 prompt 在运行，它的完成通知才会送达，而那个 prompt 会等它结束。
- 第 2 步之后，原本期待前台结果的模型会拿到运行句柄，需要等通知。工具说明和 authoring skill 会写明这一点。

## 验证

- Core：有完成回调的非交互宿主接受 `run_in_background: true`；没有回调时被拒绝。
- CLI：headless 运行在后台 workflow 运行期间持续等待，把它的完成结果作为第二个回合处理，结束时清除回调。
- CLI：中断会取消 workflow，并在它的 runner 结束后才退出。
- E2E：让 `qwen -p` 在后台跑一个短 workflow，它在 workflow 完成后输出最终回答；运行中中断（无论在等待退出时还是回合中途）以退出码 130 退出，运行保存为 `cancelled`，不留 checkpoint。

## 验收标准

- `qwen -p` 和 stream-json 会话接受后台 workflow，并且在处理完它的完成结果之前不会退出。
- 没有完成通道的宿主仍然拒绝后台运行。
- 第 1 步不改变 TUI 和 ACP 的行为。

## 后续

- 第 2 步：把后台设为默认。
- 等被取消的运行也能报告结束后，为 workflow 发 SDK `task_started` / `task_notification` 事件。
