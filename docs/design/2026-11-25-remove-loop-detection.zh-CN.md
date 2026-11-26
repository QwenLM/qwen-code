# 移除循环检测

[English](2026-11-25-remove-loop-detection.md) | [简体中文](2026-11-25-remove-loop-detection.zh-CN.md)

- **状态**：已实现（"交付"第 3 步）
- **日期**：2026-11-25
- **取代**：[循环保护设置](2026-10-21-loop-protection-setting.zh-CN.md)、
  [循环停止原因](2026-10-20-loop-stop-reason.zh-CN.md)（下文保留的两种停止除外）、
  [自适应工具调用上限](2026-07-17-adaptive-tool-call-cap.md)、
  [只读探索收敛](tool-exploration-convergence.zh-CN.md)、
  [ACP 重复工具调用保护](acp-repeated-tool-call-protection.md)
- **相关**：#14828、#15016、#13321、#10887、#5019

## 问题

Qwen Code 会判断模型是否卡住，然后提醒它或让它停下。这些判断已经膨胀成多套
独立机制：三个设置、一个环境变量、一个 TUI 对话框、若干遥测事件，以及在
core 客户端、子 agent 和 daemon 会话里各自的一份实现。每套都要维护自己的阈值、
豁免条件（有状态读取、并行读取批次、`/btw`、重试）和提示文案，而且每套都可能
把正常推进的 turn 误判为循环。

其他编码 agent harness 大多不做这件事。对 Claude Code、Codex、Pi、Kimi Code 和
mini-swe-agent，Harness Lens 中的 agent loop 描述（每条都链接到源码）没有列出任何
循环检测；DeepSeek Harness 只提醒（相同调用第 3、5、8 次时）；
OpenCode 在 3 次相同调用后发起权限询问，Grok Build 依赖 xAI 自家服务端的信号，
这两家在 headless 下的实际行为未经核实。Qwen Code 的上游 Gemini CLI 以及
OpenHands 会停止。

在无人值守运行中，停止的代价很高：它直接结束任务。在 Harness Leaderboard 上
（Qwen Code 0.25.2，当时仍会停止），抽样的 50 个 Flint DeepSWE 失败 trial 中有
31 个是被循环检测终止的。在其中一个任务上，一个没有循环守卫的 harness 里，模型把
一个参数错误的编辑调用重复了 102 次，随后自行恢复，又继续了 116 次调用。v0.26.0
已经把默认值改为只提醒（#15016）；本提案更进一步，把判断本身移除，理由是简化。
没有任何测量表明提醒有害，移除它们的原因是它们背负的
代码量和误判面，而不是它们的效果。

## 现状（upstream main，2026-11-25）

| 机制                                                                                               | 位置                                       | 默认行为                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| 常开检测器：连续相同调用（第 3 次提醒、第 5 次停止）、shell 检查停滞（6 / 8）                      | core 客户端、子 agent                      | 提醒（`model.loopProtection: warn`）    |
| 可选启发式：内容与思考重复、读文件循环、动作停滞、全局重复、交替模式                               | core 客户端、子 agent；全局重复也在 daemon | 关闭（`model.skipLoopDetection: true`） |
| 自适应工具调用上限：软上限 100（卡住重复时提醒），硬兜底 1000（停止）                              | core 客户端、子 agent、daemon              | 开启                                    |
| 显式 `model.maxToolCallsPerTurn`                                                                   | core 客户端、子 agent、daemon              | 未设置                                  |
| daemon 无效参数停滞（第 2 次提醒、第 3 次停止）                                                    | daemon                                     | 提醒                                    |
| ACP 重复工具失败守卫（`QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD`：off / shadow / warn / enforce） | daemon                                     | shadow（只记遥测）                      |
| 只读探索收敛提醒（连续读取达到 `maxToolCallsPerTurn` 次时）                                        | core 客户端、daemon                        | 开启                                    |
| provider 重复 tool-call id 熔断                                                                    | core 客户端、子 agent、daemon              | 停止                                    |
| TUI 的"可能存在循环"对话框（可在本会话内禁用）                                                     | Ink TUI                                    | 停止时显示                              |

`#14828` 以及 `TOOL_CALL_LOOP_THRESHOLD` 上方的代码注释称 DashScope 已不再拒绝
重复的相同调用，这与事实不符，但拒绝的范围比 #5019 所暗示的要窄。2026-11-25 的
探测（Standard CN 与 Token Plan）发送了一段含 N 轮连续相同 `read_file` 调用的历史：
调用时传的是 `path`，而 schema 要求 `file_path`，每次都以 schema 错误作答。
qwen3.7-plus 大约从 N = 20 起返回 `400 invalid_parameter_error "Repetitive tool
calls detected in the conversation history..."`（开启思考时；关闭思考后在 40 到 80
之间）；qwen3.6-plus、qwen3.7-max 和 qwen3.6-flash 在 N = 30 时同样返回 400。
qwen3.5-plus、qwen3.8-flash、qwen3.8-max、qwen4-max 以及 Token Plan 上的
DeepSeek、Kimi、GLM 模型在 N = 30 以内都不会。qwen3.7-plus 是 Token Plan 预设中
的第一个模型。这种拒绝取决于内容，而且不是确定性的：N = 25 时同一个请求三次中有两次
被拒；重复的成功读取、不同的错误文本，或参数名正确时的 schema 错误，都从未被拒绝。
在最后一个工具结果之后直接追加新的用户消息仍会被拒绝，而中间夹一条 assistant 文本
回复或一轮不同的工具调用则会被接受。通过客户端本身没有复现这种拒绝：用 qwen3.7-plus
恢复一个含 25 轮此类调用的会话（Qwen Code 0.27.4，带它的系统提示、工具和循环提醒），
每次请求都返回 200，`/compress` 也正常工作。Coding Plan 的 `qwen3-coder-plus`、`qwen3-coder-next` 和
`qwen3-max-2026-01-23` 在 Standard CN 上不提供，未测；Qwen OAuth（`coder-model`）
同样未测。

## 目标与范围

目标：

- 任何组件都不再判断模型是否在循环。由模型自己决定；工具结果和错误原样返回。
- 只保留一个预算：显式的 `model.maxToolCallsPerTurn`，由用户主动开启的硬上限。
  不设默认上限。
- 保留 provider 重复 tool-call id 熔断。它处理的是 provider 的协议故障（provider
  重放了一个已经应答过的 call id，再执行一次会让副作用重复发生），与模型行为无关。
- DashScope 的重复调用 400 附带说明：发生了什么、如何恢复。
- 已移除的设置项读到后忽略并提示一次，而不是报错。

不在范围内：

- 重命名 `loop_detected` 停止通道（见"决策"）。
- 其他地方已有的轮数或时间限制：`maxSessionTurns`、子 agent 的
  `maxTurns` / `maxTimeMinutes`、fork 子 agent 的 200 轮、workflow 子 agent 的
  50 轮 / 10 分钟、daemon 的 prompt deadline，以及流超时。
- todo 提醒，以及其他不判断循环的提醒。
- 内置替代方案。需要守卫的用户自己写 hook（见"扩展点"）。

## 设计

### 移除的内容

- core 中的 `LoopDetectionService` 与 `loop-protection.ts`：所有检测器、提醒和
  会话内禁用，以及它们在 `client.ts`、`turn.ts`、`agent-loop.ts` 和子 agent 运行时
  （`agent-core.ts`）中的调用。
- 自适应上限：软上限 100、卡住重复时的停止，以及 1000 次兜底。
- 只读探索收敛提醒（`ToolExplorationBudget`，#13601）。这意味着拒绝 #13321。
- daemon 会话（`Session.ts`）中的：无效参数停滞守卫、可选的全局重复停止、自适应
  上限、探索预算，以及重复工具失败守卫（`repeated-tool-failure-guard.ts`，#8469，
  连同 `QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD` 环境变量）。这意味着拒绝 #10887。
- 设置项 `model.loopProtection` 和 `model.skipLoopDetection`。
- TUI 的 `LoopDetectionConfirmation` 对话框。停止改为显示一条消息。
- 遥测事件 `loop_protection`、`loop_detection_disabled`、
  `repeated_tool_failure_guard` 及其指标；不再有任何停止会产生的 `LoopType` 与
  `LoopReason` 取值。
- Web Shell 和 SDK 中针对已移除停止原因的展示（兜底、卡住重复、重复调用、无效
  参数、重复失败的本地化文案）。已持久化的记录若带有这些取值，回落为通用的停止文案。

### 保留的内容

| 停止                                 | `loopType` / `loopReason`                              | 适用范围                      |
| ------------------------------------ | ------------------------------------------------------ | ----------------------------- |
| 超过显式 `model.maxToolCallsPerTurn` | `turn_tool_call_cap` / `explicit_cap`                  | core 客户端、子 agent、daemon |
| provider 重放了已应答的 tool-call id | `global_tool_call_duplicate` / `provider_duplicate_id` | core 客户端、子 agent、daemon |

两者沿用现有的停止路径：`LoopDetected` 事件、带 `errorKind: loop_detected` 的
`turn_error`、带 `loop_detected` 的 `StopFailure` hook、`loop_detected` 遥测事件
以及现有的载荷字段。显式上限保持已发布的语义：达到上限后的下一次调用使 turn 停止；
daemon 中会越过上限的工具批次整批跳过。用一个小的每 turn 计数器取代原服务；turn
的重置点保持不变（用户 turn、阻塞式 Stop hook 续跑和 Goal turn 都从零开始计数）。

不属于循环判断的工具错误文案保持不变：调度器对重复 schema 错误追加的重试指令，以及
被拒绝的部分编辑（输出被截断或参数不完整）从第二次拒绝起得到的重试指令。只有 daemon
在第三次拒绝部分编辑时的停止随其他停止一起移除。

### 设置

| 键                          | 变更后                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `model.maxToolCallsPerTurn` | 默认不设置：没有上限。正数为硬上限。零或负数表示没有上限。显式设置过 100（今天的默认值）的用户仍保有 100 的硬上限。 |
| `model.loopProtection`      | 移除。若存在则忽略，每个进程提示一次，说明该项已移除。                                                              |
| `model.skipLoopDetection`   | 移除。处理方式相同。                                                                                                |

settings schema、生成的 VS Code schema 和设置参考文档删除这两个键，并说明
`maxToolCallsPerTurn` 新的默认值。

### DashScope 重复调用 400

不做任何规避（不加 provider 专属提醒，也不改写历史）。API 错误格式化逻辑识别
`Repetitive tool calls detected in the conversation history` 这段消息，并像处理
429 那样追加一段提示：

> The provider rejected the request because the conversation repeats the same
> tool call. The next message may be rejected for the same reason; run
> /compress to summarize the history, or /clear to start over.

daemon 会话在 turn 错误后追加同样的提示。`/compress` 发送历史时关闭了思考，实测此时
阈值更高；`/clear` 一定能恢复。这条提示与移除工作相互独立：在今天的 `warn` 默认值下
已经可能撞上这个 400，所以它先发（#18317）。

### 扩展点

循环守卫可以写成 hook。2026-11-25 通过阅读 main 的代码，并用已发布的 0.27.4 在
headless 下对接模拟服务（模型先用无效的 `path` 参数、再用有效参数反复调用
`read_file`）做了核对：

- `PreToolUse` 对每次调用都会触发，包括之后因参数无效而被拒绝的调用，能看到工具名
  和输入。它可以拒绝调用，它的 `additionalContext` 会进入下一次请求。
- `PostToolUse` 只对实际执行的调用触发；它的 `additionalContext` 会附加到工具结果上。
- 对执行前就被拒绝的调用（`invalid_tool_params`、`not_started`），
  `PostToolUseFailure` 不会触发。
- 自 #18345 起，工具 hook 返回 `continue: false` 会在当前批次之后结束 turn
  （`PreToolUse`、`PostToolUse`、`PostToolUseFailure` 和 `PostToolBatch`；ledger
  C14 与 T11）。在此之前，`PostToolUse` 返回 `continue: false` 只会把该次调用的结果
  变成错误，运行继续。

因此 hook 能提醒、能拒绝，也能停止。daemon 重启后恢复的 `ask_user_question` 调用
是唯一一条工具 hook 停止仍只让该次调用失败的 daemon 路径。

hooks 指南中增加一个简短示例（示例 4），`model.maxToolCallsPerTurn` 的参考说明链接到
它：一个 `PreToolUse` 命令 hook，把会话最近一次调用记录在临时文件里，连续三次相同调用
后加一条提醒，到第六次结束 turn。

## 决策与理由

- **移除而不是保留提醒。** 提醒在单个请求上很便宜，但每个检测器仍然背负阈值、
  豁免条件和各运行面的接线，误判的代价落在用户身上。把决定权交给模型，所有运行面
  只需一条规则，而不是每个运行面一套阈值。（维护者决定。）
- **收敛提醒和 ACP 重复失败守卫一并移除。** 两者都是根据调用模式判断进展，保留
  它们就等于保留同一类代码。它们对应的 issue（#13321、#10887）由 hook 扩展点回应。
  （维护者决定。）
- **不设默认上限。** 去掉 1000 次兜底后，普通和后台子 agent、headless 运行以及
  daemon prompt（包括 cron、Goal、通知和 channel turn）在用户未设置
  `maxToolCallsPerTurn`、也没有其他现有限制生效时，没有内置的调用上限。默认上限
  本身就是一种循环判断（选一个数字来代表"卡住了"），而需要上限的调用方已经有轮数、
  时间或 deadline 限制。（维护者决定。）
- **两种保留的停止继续使用 `loop_detected` 通道。** 改名会同时改动 SDK 的
  `DAEMON_ERROR_KINDS`、`StopFailure` hook 枚举、Web Shell、acp-bridge 和遥测消费方，
  只为一个名字。代价是名字不再贴切：两者分别是预算和协议故障，不是循环。改名可以
  之后单独进行。
- **DashScope：只给提示（方案 A）。** 受影响的是 qwen3.6 和 qwen3.7 系列，其中包括
  Token Plan 预设的第一个模型 qwen3.7-plus；qwen3.5-plus、qwen3.8、qwen4-max 和非
  Qwen 模型不受影响。provider 专属提醒等于重新引入一个检测器。（维护者决定。）
- **忽略已移除的设置。** 如果报错，会让现有 `settings.json` 因一个已无作用的键而失效。

## 兼容性

- 今天会收到提醒的 turn（相同调用、shell 检查、卡住重复、无效参数、只读探索）
  将不再收到提醒。今天在 1000 次兜底处停止的 turn 将继续运行。设置了
  `model.loopProtection: "stop"` 的用户将失去这些停止。
- 在 qwen3.6 和 qwen3.7 模型上，一直重复某个会被 DashScope 拒绝的调用的模型，可能
  会收到 DashScope 的 400，而不是客户端的提醒，会话需要 `/compress` 或 `/clear`。在今天的 `warn` 默认值
  下，模型忽略提醒时也会撞上同一个 400。
- 协议：`turn_error`、`errorKind: loop_detected`、`loopType`、`loopReason`、
  `toolCallCount` 和 `toolCallLimit` 的结构不变。客户端不再收到已移除的 `loopType`
  和 `loopReason` 取值。SDK 在 `DAEMON_ERROR_KINDS` 中保留 `loop_detected`。
- core 导出：`LoopDetectionService`、`loop-protection.ts` 的导出、已移除的遥测类
  和枚举值从 `@qwen-code/qwen-code-core` 中消失。
- Hook：`StopFailure` 在两种保留的停止上仍以 `loop_detected` 触发。

## 风险

- 无人值守场景中失控的模型会持续消耗 token，直到外部限制把它停下。缓解：显式上限、
  现有的轮数和时间限制，以及 hook。
- 收敛提醒和 ACP 守卫的使用者会失去它们；#13321 和 #10887 以指向 hook 的说明关闭。
- 在受影响的模型上，DashScope 400 一旦触发，会让会话卡住，直到用户压缩或清空。

## 涉及的文件

- core：`services/loopDetectionService.ts`、`services/loop-protection.ts`、
  `services/tool-exploration-budget.ts`（删除）；`core/client.ts`、`core/turn.ts`、
  `core/agent-loop.ts`、`agents/runtime/agent-core.ts`、
  `agents/runtime/agent-headless.ts`、`agents/runtime/terminate-reason.ts`、
  `config/config.ts`、`telemetry/types.ts`、`telemetry/loggers.ts`、
  `telemetry/metrics.ts`、`telemetry/qwen-logger/qwen-logger.ts`、
  `utils/errorParsing.ts`、`index.ts`。
- CLI：`acp-integration/session/Session.ts`、
  `acp-integration/session/repeated-tool-failure-guard.ts`（删除）、
  `config/settingsSchema.ts`、`config/config.ts`、
  `config/migration/versions/v1-to-v2-shared.ts`、`config/shared-env-keys.ts`、
  `nonInteractiveCli.ts`、`utils/loop-detected-message.ts`、
  `ui/components/LoopDetectionConfirmation.tsx`（删除）及其 TUI 接线、OpenTUI 适配层。
- Web Shell 与 SDK：已移除停止原因的文案及其本地化字符串。
- 生成文件：VS Code settings schema。
- 文档：设置与遥测参考；[loop capability ledger](2026-11-15-loop-capability-ledger.zh-CN.md)
  的 T22 行，以及 [统一 agent loop](2026-10-23-unified-agent-loop.zh-CN.md) 设计中
  有关循环保护的条目（两种语言），它们把已移除的守卫描述为当前行为。

确切清单在实现时敲定；边界以"现状"中的表格为准。

## 交付

1. **DashScope 提示**（小而独立）：格式化逻辑与 daemon 中的提示及其测试（#18317）。
2. **工具 hook 结束 turn**（#18345，已合入）：任一工具 hook 的 `continue: false`
   在该批次之后结束 turn（ledger C14 与 T11，#18217），使 hook 扩展点能够停止。
3. **移除**：core、子 agent、daemon、设置、TUI、遥测和文档放在一个 PR 中，因为
   设置和共享计数器横跨三个运行时。
4. **展示清理**：Web Shell 和 SDK 中已移除原因的文案。

## 验证

单元测试：core 客户端、子 agent 和 daemon 中的显式上限（停止点、整批跳过、turn
重置）；provider 重复熔断；已移除设置的提示；DashScope 提示。被移除代码的测试随
代码一起删除。

端到端，对接一个模拟的 OpenAI 兼容服务：

- headless：模型把同一个相同调用重复 30 次，既无提醒也无停止，运行在模型不再
  调用工具时结束；
- headless 且 `model.maxToolCallsPerTurn: 5`：turn 在第 6 次调用时以显式上限消息停止；
- daemon / Web Shell：重复的无效参数和重复失败既无提醒也无停止；显式上限以
  `turn_error` `loop_detected` / `explicit_cap` 停止；
- 被重放的 provider call id 仍会停止；
- 带有 `model.loopProtection` 或 `model.skipLoopDetection` 的设置只打印一次提示，
  并正常运行；
- 带 DashScope 消息的模拟 400 在 headless 文本与 JSON 输出以及 daemon 会话中显示
  提示（已在 #18317 完成）。

## 验收标准

- 任何运行面都没有基于调用模式的提醒或停止。
- 显式上限和 provider 重复熔断的停止行为与今天完全一致。
- 未设置 `maxToolCallsPerTurn` 时，不存在任何工具调用上限。
- 已移除的设置和已移除的环境变量除一次性的设置提示外不产生任何作用。
- DashScope 重复调用 400 显示恢复提示。

## 待定问题

- #15016 的 `loop_protection` 决策数据是否存在。它能说明被提醒的 turn 有多少恢复了，
  但不改变本决定。
- 如有需要，之后再重命名 `loop_detected` 通道。
