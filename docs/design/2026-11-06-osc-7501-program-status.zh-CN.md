# 交互式 CLI 的 OSC 7501 程序状态上报

[English](2026-11-06-osc-7501-program-status.md) | [简体中文](2026-11-06-osc-7501-program-status.zh-CN.md)

状态：已实现（单元测试已覆盖，并已在 PTY 中端到端运行；尚未在支持该协议的终端里手动检查）。
Issue：[#13870](https://github.com/QwenLM/qwen-code/issues/13870)。

## 问题

终端和 agent inbox（Rex、cmux、Orca、Prowl、iTerm2、herdr）希望显示每个标签页里的 agent 是在工作、在等用户，还是已经结束。没有协议时，它们只能根据窗口标题和屏幕内容去猜，UI 一改就失效。[OSC 7501](https://www.superlogical.com/rex/docs/build/program-status) 让程序通过 pty 上报自己的状态。Claude Code、Codex、opencode 和 pi 都已支持，Qwen Code 还没有。

## 现状

- `packages/cli/src/utils/osc.ts` 负责构造 OSC 9 / 99 / 777 通知。
- `useTerminalProgress` 根据 `StreamingState` 发送 OSC 9;4 标签页进度。
- `StreamingState` 只有 `Idle`、`Responding`、`WaitingForConfirmation`，UI 没有"上一轮失败了"的明确信号。

## 目标与范围

- 上报一条 root record，覆盖全部五种状态：`idle`、`working`、`blocked`（带 `kind=permission|question|auth`）、`done`、`error`。
- 只在交互式 Ink UI 中上报。非交互模式（`-p`、JSON、stream-JSON）和 ACP 不会挂载 `AppContainer`，因此不会发送。
- 不新增设置项，不引入依赖。

不在范围内：子 record（`id=`）、`progress`、特性探测、基于焦点重置 `done`、tmux passthrough。

## 设计

### 线上格式

`osc.ts` 中的 `oscProgramStatus()` 输出

```text
ESC ] 7501 ; state=<state>[:kind=<kind>]:app=qwen-code[:msg=<base64>] ESC \
```

- 每次都带 `app=qwen-code`，因为每次上报都会完整替换 record。
- `kind` 只随 `blocked` 发送。
- `msg` 是 UTF-8 的 base64。编码前控制字符和行分隔符替换为空格；文本会被截短，直到编码结果不超过 2732 字节，从而整条序列不超过 4096 字节。
- `clear` 为 `ESC ] 7501 ; state=clear ESC \`。

### 状态映射

`ui/hooks/use-program-status.ts` 中的 `deriveProgramStatus()` 按以下顺序判断：

| 条件                                      | 上报                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `isAuthDialogOpen` 或 `isAuthenticating`  | `blocked`，`kind=auth`                                                      |
| 有工具调用处于 `awaiting_approval`        | `blocked`；`ask_user_question` 为 `kind=question`，其余为 `kind=permission` |
| 运行中的子 agent 有 `pendingConfirmation` | 同上                                                                        |
| 斜杠命令的 shell 确认                     | `blocked`，`kind=permission`                                                |
| 循环检测提示                              | `blocked`，`kind=question`                                                  |
| 文件夹信任、MCP 或项目 hook 审批          | `blocked`，`kind=permission`                                                |
| `WaitingForConfirmation` 但找不到详情     | `blocked`，`kind=permission`                                                |
| `Responding`                              | `working`                                                                   |
| 一轮结束后空闲                            | 锁存的结果：`done`、`error` 或 `idle`                                       |

用户自己打开的对话框（主题、设置、模型等）不算 `blocked`：此时用户本来就在键盘前。

### 轮次结果

`useTurnOutcome()` 在流式状态离开 `Idle` 时记下最后一条 history 条目的 id。回到 `Idle` 时一次性确定结果：

- 如果 `turnCancelledRef`（现由 `useLlmStream` 返回）为真，结果为 `idle`；
- 如果这一轮新增了 `MessageType.ERROR`、`user_prompt_submit_blocked` 或 `stop_hook_loop` 类型的 history 条目（即 id 更大的条目），或在 pending 条目里留下了错误（API 错误会带着 Ctrl+Y 重试提示停留在那里，直到下一次提交），结果为 `error`；
- 否则为 `done`。

结果保持到下一轮开始。空闲时 history 的变化不会改动它：失败的斜杠命令不会把 `done` 改成 `error`，删除旧条目的内存压缩也不会把它重置。只有 history 被清空（`/clear`）时才回到 `idle`。

### msg 策略

`msg` 最多写出工具名（`Permission needed: Shell`），不包含工具参数、提示词或模型输出，因为终端会把 `msg` 显示在标签页 UI 和桌面通知里。`working` 和 `done` 不带 `msg`；`error` 为 `Request failed`。

### 写入与生命周期

`utils/program-status.ts` 是唯一的写入方：

- 只在 `process.stdout.isTTY` 为真时写入。
- 与屏幕上已有的上报相同就跳过；写入抛错时保留旧值，下一次上报会重试。
- 外部编辑器接管终端之前（`useLaunchEditor`、`text-buffer` 的 `openInExternalEditor`），`releaseProgramStatus()` 清除 record；编辑器退出后，`restoreProgramStatus()` 写回最新的 record。
- 收到 `SIGCONT` 时 hook 重写 record，因为挂起期间出现的 shell prompt 会让终端丢弃 `working` / `blocked`。
- `exit` 时清除 `idle` / `working` / `blocked`，保留 `done` / `error`，这符合规范的设计：CLI 退出后，用户仍能看到上一轮是怎么结束的。UI 卸载时也会执行同样的收尾，因为 `/quit` 会先卸载 Ink 再调用 `process.exit()`。

### tmux

上报从不使用 DCS passthrough 包装。透传的上报到达外层终端时不带 pane 身份，后台 pane 的状态会覆盖整个标签页。tmux 目前会丢弃这条序列；等 tmux 原生实现 OSC 7501（tmux#5713）后，这里无需改动即可生效。

## 风险

- 结果是从 history 推断的：一轮进行期间，如果有与该轮无关的错误显示出来（例如并发的 `/btw`），这一轮会被标为 `error`。
- 还没有在终端侧验证；各终端如何展示由终端决定。

## 验证

- `utils/osc.test.ts`：格式、kind 的发送条件、base64 与清洗、长度限制、不做 tmux 包装、clear。
- `utils/program-status.test.ts`：去重、TTY 门控、写入失败后重试、release/restore、SIGCONT 重发、各状态的退出语义。
- `ui/hooks/use-program-status.test.ts`：映射表的每一行、工具参数不泄露、轮次结果（done、error、取消、忽略更早轮次的错误、`/clear`）以及监听器清理。
- 端到端：构建好的 CLI 在 PTY 中对接一个模拟的 OpenAI 兼容服务运行，捕获的字节显示：idle → working → done；blocked `permission`（shell）和 `question`（`ask_user_question`）；HTTP 400 时为 `error`，下一轮为 `done`；Esc 取消后为 `idle`；`/quit` 时保留 `done`；空闲时 `/quit` 发送 `clear`。`-p` 的文本、JSON 和 stream-JSON 输出都不含 OSC 7501。
- 尚待手动检查：在支持的终端（iTerm2 3.7.5+、Rex、cmux、Orca、Prowl）里运行，观察它如何展示这些 record。

## 后续工作

- 为后台子 agent 和 arena 运行上报子 record。
- 对大小已知的操作上报 `progress`。
- tmux 精简版发布后重新评估 tmux 支持。
