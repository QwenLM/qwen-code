# RFC: Qwen-Code CLI 结构化输入输出规范（整理版）

## 概览

| 字段 | 详情 |
| --- | --- |
| 状态 | Draft |
| 更新时间 | 2025-10-13 |
| 作者 | x22x22 |
| 追踪 | <https://github.com/QwenLM/qwen-code/issues/795> |
| 范围 | CLI 层 `--input-format/--output-format` 结构化协议、事件语义、错误规范与落地计划 |

- 目标是为第三方系统与多语言 Agent SDK 提供稳定、可编程的 IPC Stream JSON 能力。
- 协议保持与 TUI 相同的行为，补齐 JSON Lines 输出、对称输入以及控制通道，回应社区关于 `--input-format/--output-format json/stream-json` 的诉求。
- 文档聚焦 CLI 侧能力，不涵盖 SDK 内部设计。

## 背景与场景

### Issue 795 概述
- 社区在 issue [#795](https://github.com/QwenLM/qwen-code/issues/795) 中请求为 CLI 增加 `--input-format/--output-format json/stream-json`，希望参考 Claude Code 的实现，提供可被程序稳定消费的结构化 IO。
- RFC 旨在扩展 CLI，使其在保持 TUI 兼容的同时，为 SDK 与第三方后端提供对称的 JSON 协议与消息语义。

### 集成方场景
- **任务级串行处理**：SDK 逐条发送 prompt，同时在多个阶段接收 CLI 返回的数据并二次处理后再展示给最终用户。
- **任务级流式直传**：SDK 逐条发送 prompt，CLI 的流式响应被直接转发给用户，保持实时可见性。
- **指令提示与快捷符号**：第三方输入框中的 `/`、`@`、`?` 等触发行为需要与 TUI 完全一致，确保不同前端体验统一。
- **前端终端模拟**：利用 xterm.js 等库复刻终端交互，输入区域与终端输出分离，但仍需消费 CLI 的完整终端语义。

### 集成方式
- 第三方程序依赖后续提供的多语言 `qwen-code-agent-sdk`。
- SDK 通过子进程方式启动 `qwen code`，并以 STDIN/STDOUT 建立双向 IPC。
- SDK 负责读取 CLI 的结构化输出，并完成错误处理与状态管理。
- 第三方应用消费 SDK 的结果，在自身 UI 或后端逻辑中呈现。

### 现状痛点
- CLI 仅面向人工交互的纯文本 STDOUT，输出语义不稳定，难以被自动化消费。
- 缺乏对称的结构化输入协议，无法驱动高级自动化与工具调度流程。

## 目标与范围

| 类型 | 内容 |
| --- | --- |
| 设计目标 | 可配置输出格式、JSON Lines 流式协议、对称结构化输入、通用 schema、面向 SDK 友好化 |
| 非目标 | 描述 SDK 具体实现（另见 Agent 框架文档） |
| 核心痛点 | 仅有人机交互 STDOUT、缺少结构化输入、无法驱动自动化流程 |
| 场景示例 | SDK 分批发送 prompt 并处理多段响应；流式直传用户；`/`,`@`,`?` 指令与 TUI 对齐；xterm.js 前端分离输入与终端 |

## 接口总览

| 类别 | 关键项 | 说明 |
| --- | --- | --- |
| CLI 参数 | `--input-format`、`--output-format` | 取值 `text` / `stream-json` / `stream-chunk-json`，结构化模式自动禁用 TUI |
| 输出事件 | `chat.completion*`、`result/*`、`control_request` | 全部以 JSON Lines 逐行写入 STDOUT |
| 输入事件 | `*request`、`control_response`、Qwen Chat Request | JSON 行写入 STDIN，对称驱动 CLI 行为 |
| 通道语义 | 结果事件、请求事件、控制通道 | 明确回执要求，防止 CLI 阻塞 |
| 协议扩展 | 握手元数据、版本协商、错误语义 | 与 OpenAI `/chat/completions` 保持兼容扩展 |

- 通信仍使用标准输入输出，未引入额外套接字。
- `text` 模式保留原行为，结构化模式提供稳定 schema 与可观测字段。

## 输出格式语义

| 格式 | 适用场景 | 行为概要 | 兼容性 |
| --- | --- | --- | --- |
| `text` | 人机交互兼容模式 | 输出原有 TUI 文本 | 默认模式，后续标记为手动使用 |
| `stream-json` | 消息级 JSONL | 每行 `chat.completion`，含初始化回执、助手回复、工具调用、收尾摘要 | 对齐 OpenAI `/chat/completions` |
| `stream-chunk-json` | 增量 chunk JSONL | 每行 `chat.completion.chunk`，`choices[].delta` 承载 token/块增量 | 对齐 OpenAI 流式响应，覆盖完整会话 ID |

### 消费策略

- **消息级 JSONL（`stream-json`）**：适合第三方后端或 CLI 包装器按阶段消费结果，与现有 JSONL 管线兼容，是默认结构化模式。
- **增量 chunk（`stream-chunk-json`）**：面向 IDE/UI“边生成边展示”的实时场景，SDK 需监听 `chat.completion.chunk` 并在收到最终 `finish_reason` 时收尾。
- **终端语义一致性**：无论 CLI 在文本模式还是结构化模式，`stream-json` 与 `stream-chunk-json` 都必须完整覆盖 TUI 向标准输出写入的全部语义（文本、ANSI/Vt100 控制、工具提示、退出码等），并通过 `choices[].message.content` / `choices[].delta.content` 与 `choices[].delta.annotations`（如 `{"type":"x-qwen-ansi","value":"\u001b[32m"}`）编码，便于 xterm.js 等终端完全还原效果。

### `stream-json` 示例

```json
{"object":"chat.completion","id":"chatcmpl-session-123","created":1739430000,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","content":"正在分析...","tool_calls":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}}
{"object":"chat.completion","id":"chatcmpl-session-123","created":1739430002,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"tool-1","type":"function","function":{"name":"edit_file","arguments":"..."}}]},"finish_reason":"tool_calls"}]}
{"object":"chat.completion","id":"chatcmpl-session-123","created":1739430010,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","content":"修复完成，已更新文件。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1600,"completion_tokens":200,"total_tokens":1800}}
```

### `stream-chunk-json` 行为要点

- 首行发送 `{"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}` 声明角色。
- 按需输出文本 token、工具调用增量、`tool_calls` 更新。
- 最后一行包含 `{"choices":[{"delta":{},"finish_reason":"stop"}]}`，并在 `usage` 或 `metadata` 中附带总结。
- 可选 `annotations`、`spans` 字段详述终端样式（见下节）。

## 事件载荷与注解

`packages/cli/src/nonInteractiveCli.ts` 与 `packages/cli/src/ui/utils/ConsolePatcher.ts` 共同决定了文本模式输出的来源：模型内容通过 `GeminiEventType.Content` 写入 `stdout`，工具执行状态与日志由 `ConsolePatcher` 打印至 `stderr`，工具结果结构体 (`ToolResultDisplay` 等) 则在 `packages/cli/src/ui/hooks/useReactToolScheduler.ts` 中驱动 UI 渲染。为保证 `stream-json` / `stream-chunk-json` 能完整覆盖这些语义，整理版沿用原 RFC 在 OpenAI `annotations` 字段上的扩展约定：

| 类型 | 主要字段 | 用途 |
| --- | --- | --- |
| `chat.completion.chunk` 注解 | `annotations`、`spans` | 复刻终端风格、ANSI 控制、来源标记 |
| `x-qwen-terminal` | `channel`、`source`、`console_level`、`ansi` | 输出终端流（stdout/stderr/console/system） |
| `x-qwen-tool-display` | `tool_call_id`、`status`、`result_display` | 呈现工具 diff、字符串、TODO、计划摘要、任务执行等 |
| `x-qwen-thought` | `subject`、`description` | 展示思考中提示（GeminiEventType.Thought） |
| `x-qwen-session-event` | `event`、`message`、`metrics` | 会话级提示，如压缩、取消、token 限制 |

### 终端注解结构

```json
{
  "type": "x-qwen-terminal",
  "channel": "stdout",
  "source": "assistant",
  "spans": [
    {"start": 0, "end": 24, "style": {"theme_token": "AccentGreen"}}
  ],
  "ansi": [
    {"offset": 0, "code": "\u001b[32m"},
    {"offset": 24, "code": "\u001b[0m"}
  ],
  "console_level": "info",
  "exit_code": null,
  "prompt_id": "session-123########7"
}
```

- `channel`: `stdout` / `stderr`，控制台日志通过 `ConsolePatcher` 注入 `stderr` 与 `console_level`。
- `source`: `assistant`、`tool`、`console`、`system`；便于前端分层展示。
- `spans.style.theme_token`: 复用 CLI 主题 (`AccentGreen`、`DiffAdded` 等)。
- `ansi`: 原始 ANSI 序列位置，方便前端重放。
- `console_level`: 当 `source=console` 时取 `log` / `warn` / `error` / `info` / `debug`，与 `ConsolePatcher` 输出保持一致。
- `exit_code`: 当 `source=system` 且流程结束时给出退出码。
- `prompt_id`: 关联到具体回合。

### 工具结果展示

```json
{
  "type": "x-qwen-tool-display",
  "tool_call_id": "call_tool-1",
  "session_id": "session-123",
  "status": "executing",
  "result_display": {
    "kind": "file_diff",
    "file_name": "src/main.py",
    "diff": "--- a/src/main.py\n+++ b/src/main.py\n@@ -1 +1 @@\n-print('Hi')\n+print('Hello')",
    "original": "print('Hi')\n",
    "modified": "print('Hello')\n",
    "stat": {
      "ai_added_lines": 1,
      "ai_removed_lines": 1,
      "user_added_lines": 0,
      "user_removed_lines": 0
    }
  },
  "confirmation": null,
  "pending": false,
  "timestamp": 1739430005
}
```

- `status` 取自 `ToolCallStatus`（`Pending`、`Executing`、`Success`、`Error`、`Canceled`、`Confirming`）。
- `tool_call_id` 复用 OpenAI schema 字段名，结合 `session_id` 可唯一定位调用；在测试或非会话模式下也可单独使用。
- `result_display` 支持 `string`、`file_diff`、`todo_list`、`plan_summary`、`task_execution` 等 union。
- `confirmation` 序列化 `ToolCallConfirmationDetails` 中的 diff、命令、计划等信息，便于第三方弹窗确认。
- `pending=true` 表示调用仍在验证/排队阶段，尚未交给执行器，与 `ToolCallStatus.Pending` 等价。
- `timestamp` 用于排序，与 `useReactToolScheduler` 记录一致。

### 思考与会话事件

```json
{
  "type": "x-qwen-thought",
  "subject": "Analyzing repo",
  "description": "Listing tsconfig patterns..."
}
```

```json
{
  "type": "x-qwen-session-event",
  "event": "MAX_TOKENS",
  "message": "Response truncated due to token limits.",
  "metrics": {
    "original_tokens": 12000,
    "compressed_tokens": 8000
  }
}
```

- `event` 取值来自 `GeminiEventType`，包括 `Finished`、`ChatCompressed`、`MaxSessionTurns`、`USER_CANCELLED` 等。
- `metrics` 可选地提供压缩前后 token 数等统计。

## 输入格式（Qwen 会话协议）

| 模式 | 行为 | 说明 |
| --- | --- | --- |
| `text` | 保留原始 TUI 文本输入 | 解析自然语言或命令行文本 |
| `stream-json` / `stream-chunk-json` | 采用 Qwen Chat Request | 每行 JSON 描述一次增量输入 |

### Qwen Chat Request 模式

```jsonc
{
  "session_id": "session-123",
  "prompt_id": "session-123########7",
  "model": "qwen-coder",
  "input": {
    "origin": "user",
    "parts": [
      {"type": "text", "text": "请修复 @main.py 的 bug"}
    ],
    "command": null
  },
  "options": {
    "temperature": 0.2,
    "tool_overrides": ["EditTool"]
  }
}
```

- `session_id`：会话主键（`config.getSessionId()`），传入 `"_new"` 可创建新会话。
- `prompt_id`：区分回合；默认格式 `<session_id>########<turn>`，须在工具续写时复用。
- `input.origin`：`user` / `tool_response` / `system`，决定会话续写逻辑。
- `input.parts`：兼容 `@google/genai` PartListUnion，允许 `text`、`function_response`、`file_data` 等；当 `origin="user"` 时，CLI 会将所有 `text` part 顺序拼接并复用 `prepareQueryForGemini` 的语义处理。
- `options`：单次请求参数覆写（模型、采样、工具白名单）。
- 扩展字段：
  - `tool_call_id`：`origin=tool_response` 时必填，用于匹配输出事件。
  - `continuation`: 布尔值，等价 `submitQuery(...,{isContinuation:true})`；缺省时 CLI 会根据 `origin` 与命令上下文判断是否续写。
  - `tool_request`: 镜像 `ToolCallRequestInfo`，支撑并发工具与子代理。

### 会话控制

- 第三方可调用 CLI 提供的“创建会话”命令或复用已有 ID；当 `session_id` 缺失或指定为 `"_new"` 时，CLI 会在首个 `chat.completion` 中返回实际 ID。
- `prompt_id` 与 `tool_call_id` 共同确保并发流程隔离，需在工具回传与续写时保持一致；默认格式 `<session_id>########<turn>`，也可自定义但必须唯一。
- 使用 `input.origin="system"` 并在 `parts` 中发送 `{"type":"instruction","text":"/clear"}` 等指令，可触发与 TUI 相同的 slash 命令逻辑。
- 当 `origin="tool_response"` 时，必须提供 `tool_call_id` 以关联输出事件；CLI 会将结果写入对应回合并继续调度。

### 命令与 `@` 引用

| 模式 | 触发方式 | 行为 |
| --- | --- | --- |
| 隐式解析 | `origin="user"` + 文本以 `/`/`?`/`@` 开头 | CLI 自动走 slash/at 流程，调用 `handleAtCommand` 等逻辑 |
| 显式声明 | `input.command` 描述命令 | 推荐给第三方，避免字符串解析歧义 |

- `command.kind`: `slash` / `at`，与 TUI 命令分类一致。
- `command.path`: 对于 slash 命令是层级数组（等价 `commandPath`），`at` 模式可省略。
- `command.args`: 剩余参数字符串，CLI 会按原逻辑解析。
- `input.command.references` 支持在 `kind="at"` 时直接提供已解析的引用列表，例如 `{ "original":"@src/main.ts","resolved":"src/main.ts" }`，CLI 会基于显式路径读取文件。
- 若未传入 `references`，CLI 将回退到 `handleAtCommand` 与 `useAtCompletion` 的自动解析逻辑，以保持与 TUI 相同的容错能力。

#### 显式 slash 命令示例

```jsonc
{
  "session_id": "session-123",
  "prompt_id": "session-123########8",
  "input": {
    "origin": "user",
    "parts": [{"type": "text", "text": ""}],
    "command": {
      "kind": "slash",
      "path": ["chat", "list"],
      "args": ""
    }
  }
}
```

#### 显式 `@` 引用示例

```jsonc
{
  "session_id": "session-123",
  "input": {
    "origin": "user",
    "parts": [{"type": "text", "text": "请审阅 @src/main.py"}],
    "command": {
      "kind": "at",
      "references": [
        {"original": "@src/main.py", "resolved": "src/main.py"}
      ]
    }
  }
}
```

### SDK 侧命令协作

| `command.result.type` | 说明 | SDK 建议动作 |
| --- | --- | --- |
| `handled` | 命令已在 CLI 内部完成 | 无需额外处理 |
| `message` | 返回信息或错误 | 直接在 UI 显示通知 |
| `dialog` (`auth`/`theme`/`editor`/`privacy`/`settings`/`model`/`subagent_create`/`subagent_list`/`help`) | 需要弹窗或页面跳转 | 在第三方界面呈现对应对话框 |
| `tool` | 触发工具调用 | 将 `tool_request` 或命令参数转为工具请求并继续监听结果 |
| `submit_prompt` | 立即发送 PartListUnion 至模型 | 将 `content` 作为下一条输入并设置 `continuation=true` |
| `load_history` | 重置或加载指定会话历史 | 触发历史刷新或重新加载 |
| `quit` / `quit_confirmation` | 退出流程或等待用户确认 | 控制宿主应用生命周期并回传确认结果 |
| `confirm_shell_commands` | 待确认 shell 命令 | 弹窗确认，批准后携带 `approvedCommands`/`confirmationOutcome` 再次调用 |
| `confirm_action` | 需要确认提示 | 提供确认按钮并返回结构化结果 |

- SDK 应暴露统一命令执行 API，将用户输入映射为上述 `command` 结构，并根据 `result` 类型驱动本地 UI 或后续请求。
- CLI 会使用显式 `references` 读取文件；若缺失则自动回退到 `handleAtCommand` 的解析流程，保证行为与 TUI 完全一致。
- 命令触发后续模型调用时，CLI 会继续输出 `assistant`、`tool_call` 与 `result/*` 事件，顺序保持与 TUI 相同，使第三方可以通过纯文本输入与 JSON 输出复现完整交互。

### STDIN 命令回执

- 当 `--input-format=stream-json` 时，CLI 必须对 `/`、`?`、`@` 等命令保持即时反馈，解析逻辑沿用 `useSlashCommandProcessor` 与 `handleAtCommand`。
- 命令解析完成后，CLI 将向 STDOUT 写出结构化响应：

```jsonc
{
  "type": "result/command",
  "session_id": "session-123",
  "prompt_id": "session-123########8",
  "command": {
    "kind": "slash",
    "path": ["chat", "list"],
    "args": ""
  },
  "result": {
    "type": "message",
    "level": "info",
    "content": "当前会话共有 3 条历史记录"
  }
}
```

- `result` 字段遵循上表所列 `command.result.type` 枚举，便于 SDK 在收到 `stream-json`/`stream-chunk-json` 时立即驱动 UI。
- 若命令触发进一步的模型交互（如 `/submit`、`@file` 展开），CLI 会在同一会话中继续串联对应事件并保持字段一致。

## 实时提示、心跳与中断

| 能力 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- |
| 命令提示 | `command_hint_request` | `result/command_hint` | 字符触发提示；`trigger` 支持 `slash`、`at`；`status` 可为 `ok` / `loading` / `error` |
| 心跳 | `heartbeat_request` | `result/heartbeat` | 定期保活；CLI 可主动推送同结构事件 |
| 中断/取消 | `control/cancel` | `result/cancel` + `control_response` | 模拟 ESC；`reason` 当前固定 `escape` |

### 提示请求示例（`/c`）

```jsonc
{
  "type": "command_hint_request",
  "session_id": "session-123",
  "prompt_id": "session-123########preview",
  "trigger": "slash",
  "text": "/c",
  "cursor": 2,
  "context": {
    "cwd": "/workspace/demo",
    "selected_text": ""
  }
}
```

### 提示响应示例

```jsonc
{
  "type": "result/command_hint",
  "session_id": "session-123",
  "prompt_id": "session-123########preview",
  "trigger": "slash",
  "status": "ok",
  "suggestions": [
    {"label": "chat", "value": "chat", "description": "Manage conversation history."},
    {"label": "clear", "value": "clear", "description": "clear the screen and conversation history"},
    {"label": "compress", "value": "compress", "description": "Compresses the context by replacing it with a summary."},
    {"label": "copy", "value": "copy", "description": "Copy the last result or code snippet to clipboard"},
    {"label": "corgi", "value": "corgi", "description": "Toggles corgi mode."}
  ],
  "metadata": {
    "is_perfect_match": false
  }
}
```

### 提示请求示例（`@src/co`）

```jsonc
{
  "type": "command_hint_request",
  "session_id": "session-123",
  "prompt_id": "session-123########preview",
  "trigger": "at",
  "text": "@src/co",
  "cursor": 7,
  "context": {
    "cwd": "/workspace/demo",
    "selected_text": ""
  }
}
```

### 提示响应示例（`@src/co`）

```jsonc
{
  "type": "result/command_hint",
  "session_id": "session-123",
  "prompt_id": "session-123########preview",
  "trigger": "at",
  "status": "ok",
  "suggestions": [
    {"label": "src/components/", "value": "src/components/"},
    {"label": "src/components/Button.tsx", "value": "src/components/Button.tsx"},
    {"label": "src/components/Button with spaces.tsx", "value": "src/components/Button\\ with\\ spaces.tsx"}
  ],
  "metadata": {
    "is_perfect_match": false
  }
}
```

### 提示请求示例（`/?`）

```jsonc
{
  "type": "command_hint_request",
  "session_id": "session-123",
  "prompt_id": "session-123########preview",
  "trigger": "slash",
  "text": "/?",
  "cursor": 2,
  "context": {
    "cwd": "/workspace/demo",
    "selected_text": ""
  }
}
```

### 提示响应示例（`/?`）

```jsonc
{
  "type": "result/command_hint",
  "session_id": "session-123",
  "prompt_id": "session-123########preview",
  "trigger": "slash",
  "status": "ok",
  "suggestions": [
    {
      "label": "help",
      "value": "help",
      "description": "for help on Qwen Code",
      "matchedIndex": 0
    }
  ],
  "metadata": {
    "is_perfect_match": true
  }
}
```

- `suggestions` 结构复用 TUI `Suggestion`，`status="loading"` 表示 CLI 正在准备数据，`error` 时附带 `message`。
- CLI 内部复用 `useSlashCompletion`、`useAtCompletion` 生成提示；这些请求不会写入会话历史，`prompt_id` 可使用 `_preview` 后缀并在响应中原样返回。
- 支持连续触发：输入或光标变化时可重复发送 `command_hint_request`，CLI 负责节流并返回最新结果；取消提示时发送 `{"type":"command_hint_cancel",...}`。

### 心跳请求与响应

```jsonc
{"type":"heartbeat_request","session_id":"session-123"}
{"type":"result/heartbeat","session_id":"session-123","status":"ok","ts":1739430123}
```

- 第三方可配置超时（如 10 秒）判断 CLI 是否挂起并执行重启。
- CLI 会按相同结构回复 `result/heartbeat`，也可在后台主动推送保活事件。
- `@third-party/anthropics/claude-agent-sdk-python` 目前缺少心跳实现；P1.1 落地时需定义默认间隔、超时策略，并允许 SDK 自定义心跳频率。

### 中断示例

```jsonc
{
  "type": "control/cancel",
  "session_id": "session-123",
  "prompt_id": "session-123########8",
  "reason": "escape"
}
```

- CLI 必须调用 `cancelOngoingRequest`，中止 `AbortController`，补齐历史项并发出 `result/cancel`。
- 若当前无可取消请求，CLI 应返回 `{"type":"result/cancel","status":"noop"}` 并说明原因。
- 当底层流返回 `GeminiEventType.UserCancelled` 事件时，CLI 需追加 `{"type":"x-qwen-session-event","event":"USER_CANCELLED","message":"User cancelled the request."}` 提示会话被中断。
- 双击 ESC 清空输入属于客户端自身逻辑，结构化模式的集成方可在本地复用该交互，无需额外向 CLI 发送消息。

## 事件分类与通道

| 类别 | 方向 | 代表事件 | 回执要求 | 作用 |
| --- | --- | --- | --- | --- |
| 结果事件 | CLI → STDOUT | `result/command`、`result/command_hint`、`result/heartbeat`、`result/cancel`、`x-qwen-session-event` | 无需回执 | 发布命令输出、状态提示、心跳结果 |
| 请求事件 | SDK/第三方 → STDIN | `command_hint_request`、`heartbeat_request`、`control/cancel` | CLI 返回对应 `result/*` | 触发即时行为或控制 |
| 控制通道 | CLI ↔ STDIN/STDOUT | `control_request` / `control_response` | 必须匹配 `request_id` | 权限审批、Hook 回调、MCP 调用 |

按语义还可归纳三类事件机制：

1. **结果事件 (`result/*`)**  
   - CLI → STDOUT 的单向通告，承载命令输出、提示建议、心跳反馈、会话状态更新等信息。  
   - 不要求第三方回执，可直接用于 UI 展示与日志记录。
2. **请求事件 (`*request`)**  
   - 第三方 → STDIN 的即时指令，例如 `command_hint_request`、`heartbeat_request`、`control/cancel`。  
   - CLI 会以对应的 `result/*` 响应，确保提示、保活与取消流程与 TUI 一致。
3. **控制通道事件 (`control_request` / `control_response`)**  
   - CLI 输出 `control_request`、第三方写回 `control_response`，用于工具授权、Hook 回调、MCP 调用等需要回执的场景。  
   - 每条请求含唯一 `request_id`，必须在合理超时内返回结果，该类事件不写入会话历史而走控制层旁路。

- 所有事件通过统一 JSON Lines 协议传输，集成方应按 `type`/`subtype` 路由；对控制通道需实现超时与错误回退策略，以避免 CLI 阻塞并保持与 TUI 行为一致。

## 控制请求与响应

| 字段 | 说明 |
| --- | --- |
| `type` | 固定 `control_request` 或 `control_response` |
| `request_id` | 唯一标识，请求与响应配对 |
| `subtype` | `can_use_tool`、`hook_callback`、`mcp_message` 等 |
| `payload` / `response` | 携带事件明细或回执内容 |

- `control_request` 示例：

```jsonc
{
  "type": "control_request",
  "request_id": "req-1",
  "subtype": "can_use_tool",
  "session_id": "session-123",
  "prompt_id": "session-123########8",
  "tool": {
    "name": "edit_file",
    "arguments": {"path": "main.py", "patch": "..."}
  },
  "metadata": {
    "reason": "apply_diff"
  }
}
```

- 对应 `control_response`：

```jsonc
{
  "type": "control_response",
  "request_id": "req-1",
  "response": {
    "subtype": "success",
    "result": {
      "behavior": "approve",
      "message": "允许执行"
    }
  }
}
```

- 代码现状：当前 CLI 仅支持单向输出，TUI 内的确认/对话框逻辑在进程内处理，缺少 Claude Code 样式的 `control_request`/`control_response` hook。
- 设计需求：当 CLI 需要外部确认或回执时输出 `control_request`，第三方在 STDIN 写入匹配的 `control_response` 完成授权或补充信息，覆盖工具审批、Hook 回调、MCP JSON-RPC 等场景。
- 场景覆盖：`/confirm_shell_commands`、`confirm_action`、`quit_confirmation`、工具权限审批、子代理调度，以及未来的弹窗、表单、身份验证流程。
- 回退策略：若控制通道未启用，CLI 应显式拒绝危险操作或提示“结构化模式下不可用”，并通过 `result/command` 返回错误，避免静默失败。
- 后续工作：1）在 RFC 中追加 `control_request`/`control_response` JSON Schema；2）在 CLI 内抽象统一控制消息分发层，让 TUI 与 CLI 复用逻辑；3）在 SDK 中实现监听与响应，向上层 UI 暴露钩子。
- 若回调异常，SDK 需返回 `{"subtype":"error","error":{"message":"...", "retryable":false}}`，CLI 按协议走安全回退（自动拒绝或提示失败）。
- MCP 集成：`subtype:"mcp_message"` 承载 JSON-RPC (`tools/list`、`tools/call` 等)，SDK 将结果封装为 `control_response` 内的 `mcp_response`。

## 版本协商与错误语义

| 项目 | 说明 |
| --- | --- |
| 协议版本 | 首个 `chat.completion` 的 `metadata` / `system_fingerprint` 携带 `protocol_version`、`input_format`、`output_format`、`capabilities` |
| 版本不匹配 | 若 SDK 请求超出能力，CLI 返回 `finish_reason="error"`，在 `metadata.error` 中标记 `unsupported_protocol` 并以非零退出码终止 |
| 致命错误 | 输出 OpenAI 风格错误对象并退出 |
| 可恢复错误 | 通过 `chat.completion` 返回错误信息，`finish_reason` 为 `stop/tool_calls`，进程保持健康 |
| 控制协议错误 | 在 `metadata.control_errors` 中附带详情，供 SDK 决定重试或终止 |

致命错误示例：

```json
{
  "error": {
    "message": "invalid tool input",
    "type": "invalid_request_error",
    "param": "tools[0].function.arguments",
    "code": "QWEN_INVALID_TOOL_ARGS"
  }
}
```

## 安全与资源控制

| 领域 | 策略 |
| --- | --- |
| 权限 | 结构化模式仍遵循 CLI 现有 Approval / 工具白名单；无回执时默认拒绝高风险操作 |
| 审计 | 控制通道允许 SDK 在敏感动作前进行审计；未启用时需在 `result/command` 明确提示 |
| 保活 | `heartbeat` 事件可触发进程回收、避免资源泄漏 |

## 日志分层与可观测

| 组件 | 要点 |
| --- | --- |
| ConsolePatcher | 拦截 `console.*`，在 `x-qwen-terminal` 中记录 `channel="stderr"`、`console_level` |
| log_scope 扩展 | 建议在结构化模式下为注解附加 `log_scope`（`system`、`tool`、`debug`），与 `ConfigLogger` 级别对齐 |
| 工具日志 | 通过 `ToolResultDisplay` 输出，可在 `result_display` 中附带 `log_scope` 便于过滤 |
| OTel 规划 | SDK/CLI 分别接入 OpenTelemetry，串联 Trace/Span |

- 建议第三方记录完整消息序列到审计日志，便于重放。

## 调试示例

```bash
echo '{"model":"qwen-coder","messages":[{"role":"user","content":"你好"}]}' \
  | qwen --input-format stream-json --output-format stream-json

echo '{"model":"qwen-coder","messages":[{"role":"user","content":"逐字输出问候"}]}' \
  | qwen --input-format stream-json --output-format stream-chunk-json
```

- 命令可用于快速验证输出格式与事件流。
