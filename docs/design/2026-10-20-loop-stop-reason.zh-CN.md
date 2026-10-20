# 循环停止原因与按原因区分的停止提示

[English](2026-10-20-loop-stop-reason.md) | [简体中文](2026-10-20-loop-stop-reason.zh-CN.md)

- **状态**：已在 PR 分支实现
- **日期**：2026-10-20
- **相关**：issue #14828（两个 PR 中的第一个）、
  [自适应工具调用上限](2026-07-17-adaptive-tool-call-cap.md)、
  [重复 provider tool-call id 守卫](2026-08-19-duplicate-provider-toolcall-id-guard.md)、
  [Web Shell 循环检测 turn error](web-shell-loop-detection-turn-error.md)

## 问题

每次循环保护停止都带一个 `loopType`。其中有两个 loopType 各自对应两种不同的原因：

| `loopType`                   | 原因                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn_tool_call_cap`         | 超过了显式设置的 `model.maxToolCallsPerTurn`（用户自己设的预算）。自适应默认值超过了 1000 次兜底（预算）。自适应默认值超过软上限 100，且某个调用已重复 6 次（循环信号）。 |
| `global_tool_call_duplicate` | 启发式全局重复检测器，只在 `model.skipLoopDetection: false` 时运行。重复 provider tool-call id 熔断，这是一个常开的协议检查，复用了这个类型（重复 id 设计中的决策 D1）。  |

所有解释停止原因的地方，要么含糊其辞，要么说错了原因：

- headless 模式下，`turn_tool_call_cap` 的提示把所有可能都列了一遍。`global_tool_call_duplicate`
  的提示说这个守卫常开、不能通过 `model.skipLoopDetection` 关闭，但对启发式检测器来说这是错的。
- TUI 的循环对话框、对话框之后的消息以及 OpenTUI 适配器，对所有停止都输出同一句话，不看
  `loopType`。
- Web Shell 对所有停止都显示同一句话。SDK 的 UI normalizer 会从 `turn_error` 中丢掉
  `loopType`，所以客户端区分不出任何两种原因。
- 遥测无法区分"卡住"停止和兜底停止。自适应上限的设计文档把这一点列为后续事项。

## 目标与范围

目标：

- 为每一次上限停止和重复停止标明原因，并把它从检测器一路传到所有解释停止原因的地方。
- 让 headless CLI、TUI、OpenTUI 和 Web Shell 针对每种原因给出具体提示。

不在范围内：

- 不改变任何检测器触发或停止的时机，不改设置，不改 `loopType` 的取值。
- 不新增遥测上报点。TUI、headless 和 subagent 中的 provider-id 熔断仍然不上报
  `loop_detected` 事件。
- 不改变 subagent 结果的结构（agent 结果上的 `loopType`）。
- `model.loopProtection` 和停止前提醒属于 #14828 的第二个 PR。

## 设计

### 原因取值

在 core 遥测类型里，`LoopType` 旁边新增 `LoopReason` 枚举。只有上述两个共用的 loopType
会带原因。

| `loopType`                   | `loopReason`            | 何时                                                                       |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `turn_tool_call_cap`         | `explicit_cap`          | 超过了显式设置的 `model.maxToolCallsPerTurn`。                             |
| `turn_tool_call_cap`         | `backstop`              | 自适应默认值超过了硬兜底（软上限 × 10）。                                  |
| `turn_tool_call_cap`         | `stuck_repetition`      | 自适应默认值超过软上限，且某个调用已重复 `GLOBAL_DUPLICATE_THRESHOLD` 次。 |
| `global_tool_call_duplicate` | `repeated_call`         | 启发式全局重复检测器：core 的请求路径和结果路径，以及 daemon 的批次路径。  |
| `global_tool_call_duplicate` | `provider_duplicate_id` | TUI、headless CLI 和 daemon 中的重复 provider tool-call id 熔断。          |

对于上限，显式设置的值总是得到 `explicit_cap`。在自适应默认值下，只要超过兜底就记为
`backstop`，即使同时有调用在重复，因为预算是用户能改的那一项。

### 工具调用次数

`turn_tool_call_cap` 停止还带两个数字：

- `toolCallCount`：停止发生时已计入的调用次数。daemon 在每个批次执行前检查上限，所以它的计数包含被跳过的那个批次。
- `toolCallLimit`：当时生效的上限，即显式设置的值、兜底值，或者"卡住"停止时的软上限。

### 两个运行时共用同一套分类

`getTurnToolCallCapHalt()` 返回原因和上限，turn 可以继续时什么也不返回。它取代了布尔版本的 `shouldHaltOnTurnToolCallCap()`，后者唯一的调用方是 daemon。core 的逐次检查和 daemon 的逐批次检查都调用这个分类函数，所以两个运行时不会产生分歧。

### 承载字段

| 层                         | 字段                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core 流事件 `LoopDetected` | 在 `value.loopType` 旁边加 `value.loopReason`、`value.toolCallCount` 和 `value.toolCallLimit`。                                                                                                                                                               |
| `LoopDetectionService`     | `getLastLoopDetail()` 在 `getLastLoopType()` 之外返回原因和数字，按 prompt 重置；同一轮检查中后面的检测器改写了类型时返回空。                                                                                                                                 |
| 遥测 `loop_detected`       | `loop_reason`、`tool_call_count` 和 `tool_call_limit` 三个 OTEL 属性。RUM 事件带同样的属性。                                                                                                                                                                  |
| daemon `turn_error`        | 在 JSON-RPC error data 和 bridge 的 `turn_error` 事件中，`loopType` 旁边加 `loopReason`、`toolCallCount` 和 `toolCallLimit`。                                                                                                                                 |
| SDK                        | `DaemonTurnErrorData` 加上这些字段。`DaemonUiErrorEvent` 和 `DaemonStatusTranscriptBlock` 在 `loop_detected` 的 turn error 上加上 `loop`（`DaemonLoopStop`：`loopType`、`loopReason`、`toolCallCount`、`toolCallLimit`），这样 normalizer 会保留 `loopType`。 |

Web Shell 重新加载一个仍在运行的会话时，bridge 会重放已发布的 `turn_error` 事件，所以刷新页面后这些字段依然在。

### 提示文案

CLI 把 headless 的标签移到一个模块里，由 headless CLI、TUI 和 OpenTUI 共用。原因会细化标签和提示：

| 原因                    | 标签                                                                   | 提示                                                                              |
| ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `explicit_cap`          | 这一轮达到了 `model.maxToolCallsPerTurn` 设置的单轮工具调用上限（N）。 | 调大这个值，或设为 0 关闭上限。                                                   |
| `backstop`              | 这一轮达到了自适应单轮上限的兜底值（N 次调用）。                       | 设置 `model.maxToolCallsPerTurn` 改用固定上限（设为 0 关闭）。                    |
| `stuck_repetition`      | 超过 N 次工具调用后，模型仍在重复同一个调用。                          | 给出更具体的指令。显式设置 `model.maxToolCallsPerTurn` 会用固定上限取代这项检查。 |
| `repeated_call`         | 沿用现有的全局重复标签。                                               | 把 `model.skipLoopDetection` 设为 true 即可关闭。这一条修正了原来"常开"的提示。   |
| `provider_duplicate_id` | provider 重放了一个已经执行过的 tool call id。                         | 常开的协议守卫，不受 `model.skipLoopDetection` 影响。                             |

没有原因时，各处保持现有文案。

- headless：stderr 输出和 JSON 的 `errorMessage` 使用细化后的标签和提示。
- TUI：循环对话框在标题下方显示原因，选择"keep"之后的消息使用 headless 的措辞。OpenTUI 输出同样的消息。
- Web Shell：对 daemon 可能产生的每种原因提供本地化文案（英文和中文），包括三种上限原因、两种重复原因、`invalid_tool_params_stagnation` 和 `repeated_tool_execution_failure`。其他原因或缺少原因时，仍显示通用文案。

## 兼容性

所有字段都是可选的新增字段。旧客户端会忽略它们；连接不发送这些字段的旧 daemon 时，新客户端回退到通用文案。`loopType` 的取值、`turn_error` / `errorKind` 约定，以及 `StopFailure` hook 的 `error_details`（即 loop type）都不变。上限停止和重复停止的 headless 文案会变化，但这段文案从来不是需要解析的约定。

导出的 transcript 文档会打包 Web Shell 的整张 i18n 表，所以新增的键让渲染脚本从 2,041,583 字节增加到 2,046,722 字节（+5,139，在 main 158ff26aeb 上分别构建不含和含本改动的版本测得）。`packages/web-templates/src/export-html/build.mjs` 中的渲染脚本预算从 2,045,000 提高到 2,050,000，保持上一次调整时留下的余量。

## 涉及文件

- core：`telemetry/types.ts`、`telemetry/qwen-logger/qwen-logger.ts`、
  `services/loopDetectionService.ts`、`core/turn.ts`、`core/client.ts`、
  `index.ts`。
- CLI：新增一个共用的循环提示模块，以及 `nonInteractiveCli.ts`、
  `ui/hooks/use-llm-stream.ts`、`ui/types.ts`、
  `ui/components/DialogManager.tsx`、
  `ui/components/LoopDetectionConfirmation.tsx`、
  `ui/opentui/event-adapter.ts`、`acp-integration/session/Session.ts`。
- ACP bridge：`session-control-plane.ts`。
- SDK：`daemon/events.ts`、`daemon/ui/types.ts`、`daemon/ui/normalizer.ts`、
  `daemon/ui/transcript.ts`、`daemon/ui/index.ts`、`daemon/index.ts`。
- Web Shell：`adapters/transcriptToMessages.ts`、
  `adapters/localizedMessages.ts`、`i18n.tsx`。
- Web templates：`src/export-html/build.mjs` 中的导出渲染脚本预算。
- 文档：遥测参考文档。

## 验证

单元测试覆盖：

- 上限分类及其优先级；
- 每个产生方给出的原因；
- 事件取值和遥测属性；
- daemon 的 `turn_error` 数据和 bridge 的发布；
- SDK 的 normalizer 和 transcript block；
- CLI 提示格式化、对话框和 OpenTUI 适配器；
- Web Shell 适配器在两种语言下的文案。

端到端：

- headless 对接 mock 的 OpenAI 兼容服务：显式上限停止和"卡住"停止输出细化后的提示，连续相同调用停止的输出保持不变。
- tmux 中的 TUI：对话框显示原因。
- 真实 daemon 加 Web Shell（Playwright）：显式上限停止和"卡住"停止各自显示对应文案，刷新页面后依然如此。

## 验收标准

- 每一次上限停止和重复停止，在 core 事件、遥测和 daemon `turn_error` 中都带有原因；其他 loopType 不带原因。
- 没有任何检测器在不同的时机触发或停止。除新增字段外，现有的循环检测测试保持不变并通过。
- 各处都显示按原因区分的文案；缺少原因时回退到现有文案。

## 后续工作

- #14828 的第二个 PR：`model.loopProtection`，以及每次停止前的提醒。
- subagent 中的 provider-id 熔断不报告 `loopType`，可以改为报告 `global_tool_call_duplicate` 加 `provider_duplicate_id`。
- TUI、headless 和 subagent 中的 provider-id 熔断不上报 `loop_detected` 遥测。
- TUI 循环对话框对所有原因都提供"本会话禁用循环检测"选项，但 TUI 中的 provider-id 熔断并不理会这个选择。既然对话框已经显示原因，可以在该选项无效时把它隐藏（即 #14828 后续事项中的交互式提示）。
