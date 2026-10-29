# 循环保护设置与停止前提醒

[English](2026-10-21-loop-protection-setting.md) | [简体中文](2026-10-21-loop-protection-setting.zh-CN.md)

- **状态**：已在 PR 分支实现
- **日期**：2026-10-21
- **相关**：issue #14828（两个 PR 中的第二个）、
  [循环停止原因](2026-10-20-loop-stop-reason.zh-CN.md)（PR 1，#14858）、
  [自适应工具调用上限](2026-07-17-adaptive-tool-call-cap.md)、
  [ACP 重复工具调用保护](acp-repeated-tool-call-protection.md)

## 问题

每个循环检测器一触发就停止当前 turn。模型从不会被告知自己即将被停止，没有机会改变做法；无人值守的运行随后只能等人处理。只有 ACP 重复工具失败守卫会先提醒。

开关也很分散。`model.skipLoopDetection` 只决定启发式检测器是否运行；`model.maxToolCallsPerTurn ≤ 0` 关闭上限；core 的连续相同调用守卫、shell 停滞守卫以及 daemon 的无效参数守卫都没有设置项，只有 TUI 对话框能在当前会话内关闭它们。

## 目标与范围

目标：

- 一个设置 `model.loopProtection: "off" | "warn" | "stop"`，core client、子代理和 daemon/ACP 会话都遵循它。
- 默认（`warn`）下，检测器触发时给模型一次纠正提醒，让 turn 继续，这样无人值守的运行不会被一个可能误判的检测器停下；预算仍然限制 turn 的长度。
- `stop` 保持今天的每个停止点，常开检测器先提醒，供偏好旧行为的用户使用。
- 一个决策遥测事件，用来衡量提醒的效果。

不在范围内：

- 预算：显式的 `model.maxToolCallsPerTurn`、1000 次调用的兜底上限，以及子代理的 `maxTurns` / `maxTimeMinutes`，在所有模式下都会停止。
- 重复 provider tool-call id 熔断器，以及 ACP 重复工具失败守卫（它保留自己的分阶段发布）。
- 新的检测器，例如 daemon 中的连续相同调用守卫。
- 交互式的继续 / 停止提示。

## 设计

### 模式

| 模式           | 常开检测器                           | 可选启发式（`model.skipLoopDetection: false`）        |
| -------------- | ------------------------------------ | ----------------------------------------------------- |
| `warn`（默认） | 在提醒点提醒一次，之后不停止。       | 在今天的停止点改为提醒一次。内容 / 思考重复仍然停止。 |
| `stop`         | 同样的提醒，然后在今天的停止点停止。 | 不变。                                                |
| `off`          | 不提醒、不停止，遥测记录这次检测。   | 不提醒、不停止，遥测记录这次检测。                    |

在 `warn` 和 `off` 下，卡住的 turn 会一直运行到预算停止它，默认是 1000 次调用的兜底上限。设置说明里写明了这一点。默认使用 `warn` 是 #14828 中维护者的设计决策：误判的停止会让用户的运行停滞，而提醒后仍然卡住的 turn 依然受预算限制；想要旧停止行为的用户可以设置 `stop`。

`model.skipLoopDetection` 的含义不变：它决定启发式检测器是否运行。`off` 有意让常开守卫变得可配置，这是 `client.ts` 中原注释所排除的；#14828 实测 DashScope 已不再拒绝重复的相同调用，因此提供真正的关闭是安全的。

### 常开检测器

| 检测器（`loopType`）                                             | 运行位置             | 提醒                                | 停止（今天，以及 `stop` 下）  |
| ---------------------------------------------------------------- | -------------------- | ----------------------------------- | ----------------------------- |
| 连续相同调用（`consecutive_identical_tool_calls`）               | core、子代理         | 连续第 3 次相同调用                 | 第 5 次                       |
| Shell 检查停滞（`shell_command_stagnation`）                     | core、子代理         | 连续第 6 次概览检查                 | 第 8 次                       |
| 无效工具参数（`invalid_tool_params_stagnation`）                 | daemon               | 同一工具本 turn 第 2 次无效参数错误 | 第 3 次                       |
| 自适应上限的卡住重复（`turn_tool_call_cap`，`stuck_repetition`） | core、子代理、daemon | 超过软上限后同一调用重复 4 次       | 超过软上限后同一调用重复 6 次 |

每个连续段只提醒一次。连续段按检测器已有的重置规则结束：不同的调用结束连续相同调用段，非检查类命令结束 shell 段，上限和无效参数的计数在整个 turn 内有效。成功的结果不会结束连续段。对有状态的读工具（`task_list`），连续相同调用的提醒需要和停止一样的“结果未变”证据，因此有效的轮询不会被提醒。缺少结果时，`stop` 仍在第 5 次停止，`warn` 只记录 `observed` 决策，不发可能有误的提醒。

如果一批调用同时到达两个点，或者 turn 越过软上限时某个调用已经重复了 6 次，`stop` 照今天的行为停止，排队的提醒不会发出；`warn` 下则在该点给出提醒。

### 提醒的投递

检测器把提醒排入队列。它被追加到下一个携带工具结果的模型请求末尾，探索提醒和 todo 提醒也放在这里：

- core client：`client.ts` 中发送工具结果处；
- 子代理：`agent-core.ts` 中的工具响应消息；
- daemon：`Session.ts` 中这一批的 `parts`。

同一批中不同模式排入的提醒会一起发出。重试会丢弃本次尝试排队的提醒，因为重放的调用会再次排入它们。并发的 `/btw` 侧问不会排入、取走或丢弃正在运行的 turn 的提醒，包括通过它的开始、它的有状态工具结果和它的重试；在 `off` 下也不会为该 turn 记录 `observed` 决策。提醒会说明检测器、工具和应当改变什么；`stop` 下还会说明继续下去会停止本 turn。

### 遥测

`loop_detected` 和 `StopFailure` hook 仍然表示“turn 已停止”。新增的 `loop_protection` 事件记录每个受管控的决策：`reminded`、`stopped`，或 `off` 下的 `observed`，并带上循环类型、原因和模式。`reminded` 在提醒发出时记录，所以被重试丢弃、或在同一批中被停止截断的提醒不计入；`stopped` 每个 turn 只记录一次。预算停止和 provider id 熔断器不受管控，不产生决策事件。

### 提示文案

受管控的常开检测器停止时，headless 提示改为指向 `model.loopProtection`，不再说该守卫无法关闭。TUI 循环对话框的说明也提到这个设置。

## 兼容性

这改变了默认行为。不配置该设置时行为是 `warn`：常开守卫和可选启发式都改为提醒而不停止，因此过去在第 5 次相同调用、第 8 次 shell 检查、第 3 次 daemon 无效参数错误或越过软上限后的卡住重复处停止的 turn，现在会继续运行，直到模型改变做法或预算停止它。内容和思考重复以及所有预算照旧停止。把 `model.loopProtection` 设为 `stop` 即可恢复今天的停止点，`turn_error`、`loop_detected` 和 hook 负载不变，外加提醒。`loopType` 取值和 PR 1 的字段不变。提醒会在工具结果之后给请求增加几十个 token，已缓存的前缀不受影响。

## 影响的文件

- Core：新增 `services/loop-protection.ts`（模式、提醒点和文案），以及 `services/loopDetectionService.ts`、`core/client.ts`、`agents/runtime/agent-core.ts`、`config/config.ts`、`telemetry/types.ts`、`telemetry/loggers.ts`、`telemetry/qwen-logger/qwen-logger.ts`。
- CLI：`config/settingsSchema.ts`、`config/config.ts`、`acp-integration/session/Session.ts`、`utils/loop-detected-message.ts`、`ui/components/LoopDetectionConfirmation.tsx`。
- 生成文件：VS Code 设置 schema。
- 文档：设置和遥测参考。

## 验证

单元测试覆盖：每个受管控检测器在各模式下的行为、提醒点、每个连续段只提醒一次、重试处理、有状态读工具的豁免、各模式下的预算、决策事件、core / 子代理 / daemon 中的提醒投递，以及设置的传递。

端到端测试使用模拟的 OpenAI 兼容服务器：

- headless 默认（`warn`）：相同调用在第 3 次调用之后的请求中收到提醒，继续运行直到模型结束 turn；卡住的上限和 shell 场景同理；
- headless `stop`：同样的提醒，并在第 5 次相同调用、第 6 次卡住重复和第 8 次检查时停止；
- headless `off`：不提醒、不停止；
- daemon / Web Shell：无效参数在第 2 次错误后收到提醒，默认继续运行，`stop` 下在第 3 次停止。

## 验收标准

- `stop`：每个受管控检测器都在与今天完全相同的位置停止，并且每个常开检测器都先提醒。
- `warn`：除内容 / 思考重复外，没有受管控的停止。预算会停止。
- `off`：没有提醒，也没有受管控的停止。预算会停止，遥测记录 `observed`。

## 后续

- 分析 `loop_protection` 决策数据：被提醒的 turn 有多少恢复正常，以及 `warn` 是否需要为一直卡住的 turn 增加升级机制。
- 交互式的继续 / 停止提示，包括在对话框的关闭选项不起作用时隐藏它。
