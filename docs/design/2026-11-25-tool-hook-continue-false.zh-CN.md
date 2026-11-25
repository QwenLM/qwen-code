# 工具 hook 用 `continue: false` 结束 turn

[English](2026-11-25-tool-hook-continue-false.md) | [简体中文](2026-11-25-tool-hook-continue-false.zh-CN.md)

- **状态**：已在共享 agent loop 上实现，单元测试和 E2E 验证通过（2026-11-25）。
- **日期**：2026-11-25。
- **相关**：#18217（hooks 对齐，A1 #18229 的后续），[Agent loop 能力对照表](2026-11-15-loop-capability-ledger.zh-CN.md) 的 C14、T11、T27 行。这是计划中移除客户端循环检测的前置步骤。

## 问题

`continue: false` 是 hook 输出的通用字段，含义是"hook 运行后停止"。自 #18229 起，Stop hook 的 `continue: false` 会结束 turn，但在工具事件上不会：

- **PreToolUse**：这次调用被拒绝，`stopReason` 作为它的错误，模型继续。
- **PostToolUse**：这次调用的真实结果被替换成带 `stopReason` 的错误，模型继续。
- **PostToolUseFailure**：这个字段被忽略。
- **PostToolBatch**：最后一个调用的结果被替换成错误，模型继续。

所以 hook 无法在工具边界让 agent 停下来。一个 hook 发现了循环（同一个调用反复出现）、预算超支或违反策略时，只能让一次调用失败，而模型通常会重试。循环检测移除之后，hook 是文档里写明的停止一次运行的方式，所以必须先让这一点生效。1.0 的循环（`v1.0.0-preview`）在这些事件上已经会结束 turn（对照表 C14、T11、T27）。

## 现状

- `firePreToolUseHook` 遇到 `continue: false` 返回 `blockType: 'stop'`。调度器把 `ask` 以外的任何阻断都变成一个 `not_started` 的 `EXECUTION_DENIED` 错误。
- `firePostToolUseHook` 返回 `shouldStop`。调度器把结果替换成 `EXECUTION_DENIED` 错误，并把 span 标成 `post_hook_stopped`。
- `firePostToolUseFailureHook` 只读取 `additionalContext` 和 artifacts。
- `firePostToolBatchHook` 对 `continue: false`、`decision: block`/`deny` 和退出码 2 一视同仁：最后一个结果被替换成错误。
- `ToolCallResponseInfo.terminateTurn` 已经存在，但实际上是 Goal 的信号，不能复用：
  - headless 只在 Goal turn 里认它；
  - 子代理从不认它；
  - Ink 和 OpenTUI 把它和 Goal 的收尾绑在一起；
  - 它不带原因。
- prompt 和 function hook 执行器在阻断时（`ok: false`、返回 `false`）会同时写出 `continue: false` 和 `decision: "block"`。#18229 在 Stop 上定下了"block 优先"的规则。工具事件必须沿用这条规则，否则 prompt hook 在 PostToolUse 上的 `ok: false` 就会开始结束 turn。

## 目标与范围

- 在 PreToolUse、PostToolUse、PostToolUseFailure 和 PostToolBatch 上，不带阻断决定的 `continue: false` 会在当前这批工具结束后结束 turn，用户能看到 `stopReason`。
- 主会话，即运行在共享 agent loop 上的这些界面：Ink TUI、OpenTUI、headless（text、JSON、stream-json）、ACP/daemon 会话（Web Shell、IDE、SDK）。
- 子代理：以一种新的结束方式结束运行，父代理能看到原因。
- Code Mode：`exec` 脚本里嵌套调用发出的停止，同样结束 turn。
- 不在范围内（这些地方 turn 照常继续）：
  - 旧的（非共享）循环。它们是可以手动切回的旧路径，#17045 会移除。它们用的是同一个调度器，所以 PreToolUse 拒绝该调用，PostToolUse 保留结果，PostToolBatch 保留所有结果。
  - 在共享批处理之外运行工具的 ACP turn：恢复的 turn、Stop hook 的续写、cron turn 和后台通知 turn。它们自己的工具路径保持旧的效果（PreToolUse 拒绝该调用，PostToolUse 的停止把结果替换成错误）。后续改动会把它们移到共享批处理上，或者在那里也结束 turn。
  - Hosted Harness，它有自己的 hook 处理。
  - speculation，它不是用户 turn；以及给 PostToolUse 的 `decision` 新增含义。

## 设计

### 各事件的规则

hook 输出照旧合并，然后：

| 事件               | `continue: false`，无阻断决定                                                             | 带 `decision: block`/`deny` 或退出码 2（不变）      |
| ------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| PreToolUse         | 这次调用不运行，结果是错误 `stopReason`。同一批的其他调用照常运行。这批结束后 turn 结束。 | 调用被拒绝（权限决定）                              |
| PostToolUse        | 保留并发送真实结果。这批结束后 turn 结束。                                                | 不变：结果被替换成带 `stopReason` 的错误，turn 继续 |
| PostToolUseFailure | 保留错误结果。这批结束后 turn 结束。                                                      | 与现在一样被忽略                                    |
| PostToolBatch      | 保留所有结果，turn 结束。                                                                 | 不变：最后一个结果被替换成错误，turn 继续           |

"这批结束后"指这一批的每个调用都已结束，每个结果都已写入历史，所以下一条 prompt 不会带着没有结果的工具调用发出去。这一轮里模型不会再收到请求。

### 信号

- `ToolCallResponseInfo` 新增 `hookStopReason?: string`。
  - 调度器把它设在那个 hook 要求停止的调用上；PostToolBatch 则设在最后一个调用上。
  - 取值依次为 `stopReason`、`reason`、`No reason provided`（即 `getEffectiveReason`）。
- `runToolBatch` 从已执行的结果中读取它，返回新的停止原因 `hook_stopped`，并带上 `hookStopReason`（按请求顺序取第一个）。
  - 它不受 `endsOnTerminateTurn` 控制。
  - 优先级排在 `cancelled`、`surface_ended` 和 `tool_ended_turn` 之后。Goal 工具结束 turn 时仍走 Goal 的收尾路径。
- 两个内核（经典循环和 event-bus 内核）本来就会把这批工具的停止原因透传出去，所以 `runAgentLoop` 会返回 `reason: 'hook_stopped'` 和原因。

### 各界面

各界面处理 `hook_stopped` 的方式，与处理"工具结束 turn"的情况相同：把这一批的 function response 加入历史，显示提示，然后以正常结束（`ok`，不是错误）收尾这一轮。在 Goal turn 里，Goal turn 的收尾和工具结束它时一样，由 Goal 运行时决定接下来做什么。ACP 的 channel turn 同样结束，尽管它的 channel 因此收不到最终回复：hook 要求停止。

- **提示**：文案为 "A hook stopped the turn: <stopReason>"。
  - Ink 和 OpenTUI 两个 TUI：一行 info。Stop hook 的 "Stop says:" 那一行会把事件名说错，所以不用它；
  - headless text：写到 stderr；JSON 和 stream-json 输出不带它，和不带 Stop hook 的原因一样；
  - ACP：A1 的 `emitStopHookNotice`（`_meta.source: "stop_hook_notice"`），SDK、Web Shell 和 VS Code 已经能显示。
- **子代理**：新增 `AgentTerminateMode.HOOK_STOPPED`。
  - 这一批的结果写入子代理的历史，子代理被恢复时能看到它们。
  - 它的最终文本是 "A hook stopped the agent: <stopReason>"，父代理拿到的工具结果带着这段文本。
  - 状态行显示 "Agent stopped by a hook."，遥测把它和其他非 goal 的结束方式同样计数。
- **Code Mode**：`exec` 对待带 `hookStopReason` 的嵌套结果，与对待 `terminateTurn` 一样：脚本停止，`exec` 的结果把 `hookStopReason` 带给外层调度器。

### 遥测

工具 span 只在阻断式的 PostToolUse 路径上保留 `post_hook_stopped`。结束 turn 的停止记录在 hook span（`blockType: 'stop'`）和 debug 日志里。不新增指标。

## 决定

- **新增字段，而不是用 `terminateTurn`。** 那个字段在好几个界面上是 Goal 的约定，而且不带原因。扩大它的含义会改变 Goal turn 的行为。
- **block 优先。** 这是 #18229 的规则，今天所有会阻断的 prompt hook 和 function hook 都能保持原样工作。
- **PostToolUse 保留结果。** 工具已经运行，它的效果是真实的。用一个错误盖住输出，会误导下一轮。输出脱敏是另一个功能（B4 `updatedToolOutput`）。
- **PreToolUse 不取消同一批的其他调用。** 它们已经排好了，它们的结果无论如何都要写入。这批结束后 turn 就结束。
- **旧循环保持不变。** 它们是可以手动切回的旧路径，#17045 会移除。连它们一起改，改动量会翻倍，而这些路径默认没人走。有自己工具路径的那几种 ACP turn 出于同样的原因留作后续：每一种都有自己的循环。

## 兼容性

- **command/HTTP hook 返回 `{"continue": false}`：** 以前在工具事件上，这样的 hook 只让一次调用失败，模型继续。现在会结束 turn。这正是该字段文档里的含义，也是本次改动的原因。发布说明会写明。
- **PostToolBatch 的 `continue: false`：** 以前会替换最后一个结果，现在保留结果并结束 turn。`decision: block` 和退出码 2 不变。
- **阻断式输出不变：** `decision: block`/`deny`、退出码 2、prompt hook 的 `ok: false`、function hook 的 `false`。
- **接口：** 设置、协议字段和 SDK 类型都没有改动。唯一的新增是工具响应上可选的 `hookStopReason`，以及子代理新的结束方式。
- **托管工具运行时协议：** 形状不变。PostToolUse 的 `continue: false` 仍以 `postHook.shouldStop` 报给它，PostToolUseFailure 不带停止。

## 风险

- **某个界面漏了写历史这一步：** 会留下一个没有结果的工具调用，下一条 prompt 就会失败。缓解：E2E 用例在 hook 停止后，在同一会话里发第二条 prompt，并检查请求内容。
- **Goal turn：** hook 停止结束的是 turn，不是 goal。Goal 运行时像对待任何被工具结束的 turn 一样结算它，所以自主运行的 Goal 可能会开始下一轮。要停止 Goal 运行，hook 需要在每一轮都停止，或者由用户暂停 goal。

## 涉及文件

- `packages/core/src/core/toolHookTriggers.ts`：各事件的停止判定（block 优先），以及 PostToolUseFailure 的 `continue`。
- `packages/core/src/core/coreToolScheduler.ts`：设置 `hookStopReason`，保留 PostToolUse 的结果。
- `packages/core/src/core/turn.ts`：`ToolCallResponseInfo` 上的 `hookStopReason`。
- `packages/core/src/core/agent-loop.ts`、`packages/core/src/event-bus/conversation.ts`：`hook_stopped` 停止原因及其原因文本。
- `packages/core/src/tools/exec.ts`、`packages/core/src/tools/tools.ts`：Code Mode 的透传。
- `packages/core/src/tools/managed-tool-runtime.ts`：保持托管协议的形状。
- `packages/core/src/agents/runtime/*`、`packages/core/src/tools/agent/agent.ts`：`HOOK_STOPPED`。
- `packages/cli/src/nonInteractiveCli.ts`、`packages/cli/src/ui/hooks/use-llm-stream.ts`、`packages/cli/src/ui/opentui/live-session.ts`、`packages/cli/src/acp-integration/session/*`：各界面。
- `docs/users/features/hooks.md`，以及对照表的 C14、T11、T27 行。

## 验证

- **单元测试：**
  - 各事件的 trigger 结果：停止、block 优先、PostToolUseFailure。
  - 各事件的调度器响应：字段、保留的结果、没有运行的调用。
  - `runToolBatch` 返回 `hook_stopped`，优先级正确。
  - 各界面对这种停止的处理。
  - 子代理的结束方式，以及 Code Mode。
- **E2E**（构建好的 CLI 加一个模拟的 OpenAI 兼容服务）：
  - 每个事件：headless text 模式下，这批结束后 turn 结束，stderr 显示原因，工具结果之后模拟服务不再收到请求。
  - ACP 会话：收到停止提示，然后在同一会话里发第二条 prompt。它的请求带着工具结果，模拟服务返回 200。
  - 交互式 TUI（tmux）：显示提示，输入框重新可用。
  - 在 PostToolUse 上阻断的 prompt hook 或 function hook：行为不变（错误结果，turn 继续）。
- **基线**（全局 `qwen`）：同样的配置只让这次调用失败，模型继续。

## 验收标准

- PreToolUse、PostToolUse、PostToolUseFailure 或 PostToolBatch hook 返回 `{"continue": false, "stopReason": "…"}` 时，在每个主界面上都能结束 turn、显示原因，并且会话仍能接受下一条 prompt。
- 子代理以 `HOOK_STOPPED` 结束，父代理能看到原因。
- 阻断式输出的行为与以前相同。

## 待定问题

无。
