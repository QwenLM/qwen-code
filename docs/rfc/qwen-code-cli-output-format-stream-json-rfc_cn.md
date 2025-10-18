# RFC: Qwen-Code CLI 输出格式与 IPC Stream JSON 能力

- **状态**: Draft
- **更新时间**: 2025-10-13
- **作者**: x22x22
- **追踪**: <https://github.com/QwenLM/qwen-code/issues/795>

## 摘要

为了支撑第三方系统以编程方式稳定集成 Qwen-Code，本 RFC 旨在定义并实现 CLI 层的结构化输入/输出能力。核心改动是在现有 CLI 上引入 `--input-format/--output-format`（`text`/`stream-json`/`stream-chunk-json`）与对称的结构化输入协议，配套 JSON Lines、错误语义、会话字段及分阶段落地计划。这一能力是 IPC SDK、第三方后端服务、UI 组件以及多语言 SDK 协同工作的基础，可直接回应 issue #795 关于“提供 `--input-format/--output-format json/stream-json`”的诉求，并与现有架构设计保持一致。

## 背景

### Issue 795 概述

社区提出希望参考 Claude Code 的实现，为 Qwen-Code CLI 增加 `--input-format/--output-format json/stream-json`，以便第三方程序可以无 UI 干预地消费 CLI 输出，构建可自动化的集成能力。

### 集成方场景

1. task级别的集成，即通过sdk一条条发送prompt，中间接收多次数据并进行处理后再返回给用户展示。
2. task级别的集成，即通过sdk一条条发送prompt，直接流式返回给用户展示。
3. 在输入框中输入指令(/,@,?)需要和在TUI中一样要有反应。
4. 使用类似xterm.js的库在前端模拟终端交互，但是输入框和终端内容是分离的。

### 集成方式

1. 第三方程序依赖后期提供的各个语言的"qwen-code-agent-sdk"；
2. "qwen-code-agent-sdk"使用子进程方式启动"qwen code"，并基于stdio进行双向IPC通信；
3. "qwen-code-agent-sdk"接收"qwen code"执行的结果；
4. 第三方程序获取到"qwen-code-agent-sdk"的结果。

### 现状痛点

1. CLI 仅支持人机交互式的纯文本 STDOUT，输出不稳定。
2. 没有对称的结构化输入，难以驱动高级自动化流程。

## 设计目标

1. 在 CLI 层提供稳定可配置的输出格式选项，默认兼容现有行为。
2. 实现 JSON Lines 流式协议，匹配 IPC SDK 设计中的消息语义与控制协议。
3. 提供对称的结构化输入能力，支持 SDK 将提示与控制消息写入 STDIN。
4. 定义跨语言可共用的schema、错误语义。
5. 为后期需要实现的qwen-code-agent-sdk友好化考虑。

## 非目标

- 不在本 RFC 中体现 SDK 的设计。

## 方案概览

### CLI 参数设计

| 参数 | 取值 | 默认值 | 说明 |
|------|------|--------|------|
| `--input-format` | `text` / `stream-json` | `text` | 控制 STDIN 解析逻辑 |
| `--output-format` | `text` / `stream-json` / `stream-chunk-json` | `text` | 控制 STDOUT 输出格式 |
| *(自动)* |  |  | 当 `--input-format/--output-format` 取值为 `stream-json` / `stream-chunk-json` 时，CLI 自动禁用 TUI，进入结构化输出模式；仅 `text` 模式保留原有 TUI 行为。**通信仍通过标准输入/输出管道完成，未改用额外通道** |

CLI 参数在帮助信息中展示，且 `text` 模式沿用现有行为，保证向后兼容。无需额外的 `--stdio` 开关。

### 输出格式语义

1. **`text`（兼容模式）**  
   - 沿用当前 STDOUT 逻辑，适用人类交互。  
   - 不保证结构化信息；未来将逐步标记为“仅供手动使用”。

2. **`stream-json`（消息级 JSON Lines）**  
   - 每行输出一个符合 OpenAI `/chat/completions` 响应格式的对象，`object` 固定为 `chat.completion`。  
   - CLI 会在同一个流程中依次输出：初始化回执（含能力声明）、每次助手回复/工具调用的 `chat.completion` 对象、收尾摘要。  
   - 示例：
     ```json
     {"object":"chat.completion","id":"chatcmpl-session-123","created":1739430000,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","content":"正在分析...","tool_calls":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}}
     {"object":"chat.completion","id":"chatcmpl-session-123","created":1739430002,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"tool-1","type":"function","function":{"name":"edit_file","arguments":"..."}}]},"finish_reason":"tool_calls"}]}
     {"object":"chat.completion","id":"chatcmpl-session-123","created":1739430010,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","content":"修复完成，已更新文件。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1600,"completion_tokens":200,"total_tokens":1800}}
     ```
   - 仍保持 JSONL 逐行输出，方便 第三方后端服务、SDK 以消息级颗粒度消费。

3. **`stream-chunk-json`（增量 chunk JSON Lines）**  
  - 输出遵循 OpenAI 流式响应格式；每行一个 `chat.completion.chunk` 对象，`choices[].delta` 承载 token/块增量，同一 `id` 覆盖整个会话。  
  - CLI 会在开头发送带 `delta: {}` 的 `role` 声明，过程中发送文本或工具调用增量，最后输出仅含 `finish_reason`（以及可选 `usage`）的结束 chunk，与 OpenAI `/chat/completions` 规范保持一致。  
   - 示例：
     ```json
     {"object":"chat.completion.chunk","id":"chatcmpl-session-123","created":1739430000,"model":"qwen-coder","choices":[{"index":0,"delta":{"role":"assistant"}}]}
     {"object":"chat.completion.chunk","id":"chatcmpl-session-123","created":1739430001,"model":"qwen-coder","choices":[{"index":0,"delta":{"content":"正在"}},{"index":1,"delta":{"content":""}}]}
     {"object":"chat.completion.chunk","id":"chatcmpl-session-123","created":1739430001,"model":"qwen-coder","choices":[{"index":0,"delta":{"content":"分析..."},"finish_reason":null}]}
     {"object":"chat.completion.chunk","id":"chatcmpl-session-123","created":1739430003,"model":"qwen-coder","choices":[{"index":0,"delta":{"tool_calls":[{"id":"tool-1","type":"function","function":{"name":"edit_file","arguments":"..."}}]}}]}
     {"object":"chat.completion.chunk","id":"chatcmpl-session-123","created":1739430008,"model":"qwen-coder","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}}
     {"object":"chat.completion.chunk","id":"chatcmpl-session-123","created":1739430008,"model":"qwen-coder","usage":{"prompt_tokens":1600,"completion_tokens":200,"total_tokens":1800},"choices":[]}
     ```
   - 不再额外补发完整 `chat.completion`，而是在最后的 chunk 中给出 `finish_reason` 与可选 `usage`，符合 OpenAI 文档（见 `@third-party/code-cli-any-llm/docs/research/completions.chat.openapi.documented.yml`）的结尾语义。

#### 消费策略

- **消息级 JSONL (`stream-json`)**: 适合需要稳定阶段性结果的 第三方后端服务 或 CLI 包装器，默认采用此模式，与现有 JSONL 管线兼容。
- **增量 chunk (`stream-chunk-json`)**: 适合 IDE / UI 组件的“边生成边展示”场景；SDK 需监听 `chat.completion.chunk`，并在接收到最终 `finish_reason` 后处理总结对象。
- **前端模拟终端关系**: 无论 CLI 原始模式为文本还是结构化输出，SDK 均可统一消费 `chat.completion` / `chat.completion.chunk` 序列。从 CLI 角度，`stream-json` 与 `stream-chunk-json` 必须完整覆盖 TUI 模式会写入标准输出的全部语义信息（文本、ANSI/Vt100 控制、工具提示、退出码等），并通过 `choices[].message.content` / `choices[].delta.content` 与 `choices[].delta.annotations`（示例：`{"type":"x-qwen-ansi","value":"\u001b[32m"}`）进行编码。这样第三方即可在基于 xterm.js 的终端里还原颜色、光标移动、逐步输出等效果，而无需依赖 `text` 模式。

### 前端模拟终端注解（annotations）

`packages/cli/src/nonInteractiveCli.ts` 与 `packages/cli/src/ui/utils/ConsolePatcher.ts` 共同决定了文本模式输出的来源：模型内容通过 `GeminiEventType.Content` 追加到 `stdout`；工具执行状态、错误与日志通过 `ConsolePatcher` 打印至 `stderr`；工具结果结构体 (`ToolResultDisplay` 等) 则在 `packages/cli/src/ui/hooks/useReactToolScheduler.ts` 中驱动 UI 渲染。为保证 `stream-json` / `stream-chunk-json` 能完整覆盖这些信息，我们在 OpenAI `annotations` 字段上新增以下约定：

| 注解类型 | 作用 | 对应代码来源 |
|----------|------|--------------|
| `x-qwen-terminal` | 描述终端通道、样式与 ANSI/Vt100 控制序列 | `process.stdout.write`/`process.stderr.write` 拦截 (`nonInteractiveCli.ts`) + `ConsolePatcher` |
| `x-qwen-tool-display` | 携带工具执行过程/结果的结构化数据 | `ToolResultDisplay`/`ToolCallStatus` (`packages/core/src/tools/tools.ts`, `packages/cli/src/ui/hooks/useReactToolScheduler.ts`) |
| `x-qwen-thought` | 暴露 `GeminiEventType.Thought` 推理摘要 | `packages/core/src/core/turn.ts` |
| `x-qwen-session-event` | 包含 `Finished`、`ChatCompressed` 等控制事件的人类可读提示 | `packages/core/src/core/turn.ts` + `useGeminiStream.ts` |

#### `x-qwen-terminal`

```json
{
  "type": "x-qwen-terminal",
  "channel": "stdout",
  "source": "assistant",
  "spans": [
    {
      "start_index": 0,
      "end_index": 5,
      "style": {
        "theme_token": "AccentGreen",
        "bold": false
      }
    }
  ],
  "ansi": [
    {"offset": 0, "sequence": "\u001b[32m"},
    {"offset": 5, "sequence": "\u001b[0m"}
  ]
}
```

- `channel`: `stdout` / `stderr`（日志与错误来自 `ConsolePatcher` 会标记为 `stderr`，同时附带 `console_level` 字段以区分 `log`/`warn`/`error`）。
- `source`: `assistant`（模型输出）、`tool`（工具实时输出/结果）、`console`（`console.*` 调用）、`system`（启动/关闭/致命错误）。
- `spans.style.theme_token`: 直接复用 `Colors` 主题枚举（如 `AccentGreen`、`DiffAdded`，定义于 `packages/cli/src/ui/colors.ts` 与 `themes/*.ts`），第三方可映射为自定义调色板。
- `ansi`: 原始 ANSI 序列与其在内容中的偏移，便于 xterm.js 原样重放；若无 ANSI 控制，数组可为空。
- 附加字段：
  - `console_level`: 当 `source = console` 时，为 `log` / `warn` / `error` / `info` / `debug`。
  - `exit_code`: 当 `source = system` 且流程结束时给出。
  - `prompt_id`: 若可关联到某次用户输入/回合（`nonInteractiveCli.ts` 中的 `prompt_id`），用于跨消息聚合。

> 示例：`packages/cli/index.ts` 中 `FatalError` 会输出红色字体；在 `stream-chunk-json` 中表现为 `delta.content:"配置缺失"` + `annotations:[{type:"x-qwen-terminal",channel:"stderr",source:"system",ansi:[...]}]`。

#### `x-qwen-tool-display`

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
  }
}
```

- `status`: 映射自 `ToolCallStatus`（`Pending`，`Executing`，`Success`，`Error`，`Canceled`，`Confirming`），见 `packages/cli/src/ui/types.ts`。
- `tool_call_id`: 复用 OpenAI schema 字段名，结合 `session_id` 可唯一定位某次调用，便于第三方将多个调用分区展示。若 CLI 处于测试/非会话模式，可仅使用 `tool_call_id`。
- `result_display` union：
  - `kind: "string"` → `{ "text": "stdout captured..." }`。
  - `kind: "file_diff"` → `FileDiff` 字段集合。
  - `kind: "todo_list"` → `{ "todos": [{id, content, status}] }`（源自 `TodoResultDisplay`）。
  - `kind: "plan_summary"` → `{ "message": "...", "plan_markdown": "..."}`
  - `kind: "task_execution"` → 直接映射 `TaskResultDisplay`（包含 `subagentName`、`status`、`toolCalls` 等）。
- `confirmation`: 若 `ToolCallConfirmationDetails` 仍待用户确认（`type: 'edit'|'exec'|'mcp'|'info'|'plan'`），序列化必要字段（例如 diff、命令、提示等），便于第三方弹窗。
- `pending`: 布尔值，表示调用仍在 `validating`/`scheduled` 状态，尚未交给执行器；用于第三方提前占位，与 `ToolCallStatus.Pending` 等价。
- `timestamp`: 可选毫秒级时间戳，对应 `useReactToolScheduler` 中的历史写入时间，便于排序。

#### `x-qwen-thought`

```json
{
  "type": "x-qwen-thought",
  "subject": "Analyzing repo",
  "description": "Listing tsconfig patterns..."
}
```

- 对应 `GeminiEventType.Thought` 推理摘要（`packages/core/src/core/turn.ts` 第 250 行），在 UI 中常用于“思考中”提示。

#### `x-qwen-session-event`

用于承载会话级事件（`Finished`、`ChatCompressed`、`SessionTokenLimitExceeded` 等）的人类可读提示，字段包括：

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

`event` 取值来自 `GeminiEventType`（`Finished`、`ChatCompressed`、`MaxSessionTurns` 等），`message` 为 UI 在 `useGeminiStream.ts` 中构造的提示文案。当用户或集成方触发 ESC 取消时，CLI 需发送 `event: "USER_CANCELLED"`、`message: "User cancelled the request."`，保持与 TUI 一致。

### 输入格式语义（Qwen 会话协议）

> 传输层保持与现有 CLI 相同：所有结构化输入仍以 `\n` 结尾的 JSON 行写入 STDIN，CLI 侧按照 `--input-format` 选择解析器。该模式直接参考了 `@anthropics/claude-agent-sdk-python` 中的 `SubprocessCLITransport` 实现，后者同样在流式模式下对每条消息 `json.dumps(...)` 后写入子进程 STDIN。

- `text`: 与现有模式一致，从 STDIN 读取自然语言指令，维持原始 TUI 行为。
- `stream-json` / `stream-chunk-json`: CLI 期望每行输入遵循 **Qwen Chat Request** 协议。该协议借鉴 OpenAI `/chat/completions` 的结构，但不会要求调用方重复发送完整历史，而是仅提交“本次增量”。CLI 通过 session ID 与内部 `GeminiChat` 历史（参见 `GeminiChat.sendMessageStream`）维护上下文。

#### Qwen Chat Request 结构

```jsonc
{
  "session_id": "session-123",          // 必填, 由 CLI/SDK 生成或复用
  "prompt_id": "session-123########7",  // 可选, 不传时 CLI 自动生成; 与工具调用关联时需复用
  "model": "qwen-coder",               // 可选, 为空时沿用当前会话模型
  "input": {
    "origin": "user",                  // user | tool_response | system
    "parts": [                         // 与 @google/genai PartListUnion 对齐
      {"type": "text", "text": "请修复 @main.py 的 bug"}
    ],
    "command": null                    // 可选, 显式声明 slash/@ 命令 (见下文)
  },
  "options": {
    "temperature": 0.2,
    "tool_overrides": ["EditTool"]
  }
}
```

- `session_id`: 对应 `config.getSessionId()`，是所有会话状态的主键。第三方可调用 CLI 提供的“创建会话”命令获取，或复用现有 TUI 生成的 ID。
- `prompt_id`: 用于标识一次用户输入或工具续写；同一个 `prompt_id` 下可能经历多轮工具调用。CLI 默认格式为 `<session_id>########<turn>`，第三方可复用该格式或自定义但需保持唯一性。
- `input.origin`:
  - `user`: 常规用户输入，`parts` 通常是一个或多个 `{"type":"text"}`。
  - `tool_response`: 当第三方执行完一个工具后向模型返回结果时使用。此时 `parts` 应包含 `{"type":"function_response","function_response":{...}}`，同时需要提供 `tool_call_id` 字段（见下方）。
  - `system`: CLI 内部控制消息，例如 slash 命令恢复历史；第三方仅在需要注入系统提示时使用。
- `input.parts`: 允许出现 `text`、`function_response`、`file_data` 等 `@google/genai` 支持的结构，CLI 会直接传给 `GeminiChat`。当 `origin="user"` 时，CLI 会将所有 text part 按顺序拼接成字符串后复用原有 TUI 语义（同 `prepareQueryForGemini` 流程）。
- `options`：对单次请求的参数覆写（模型、采样、工具限制等），默认读取当前 Config。
- 额外字段：
  - `tool_call_id`: 当 `origin=tool_response` 时必填，用于与输出中的 `tool_call_id` 匹配（参照 `CoreToolScheduler`）。
  - `continuation`: 布尔值，等价于 `submitQuery(..., { isContinuation: true })`；缺省由 CLI 根据 `origin` 判定。
  - `tool_request`: 可选对象，镜像 `ToolCallRequestInfo` 中的 `args` / `isClientInitiated` / `prompt_id` 等字段，便于第三方在 CLI 侧复用同一调度逻辑（例如并发工具、子代理）。未提供时由 CLI 自动推断。

#### 会话控制

- `session_id` 不存在或传入 `"_new"` 时，CLI 自动创建新会话并返回首个响应中附带的实际 `session_id`。
- 通过 `input.origin="system"` + `parts:[{"type":"instruction","text":"/clear"}]` 可触发清空历史（模拟 `/clear` 命令）。
- `prompt_id` 与 `tool_call_id` 共同保证并发调用不串扰：`CoreToolScheduler` 与子代理均使用 `callId` 区分任务，第三方在发送工具结果时需保留该 ID。

#### 命令与 @ 引用

TUI 在文本模式下会根据输入字符串自动解析 slash 命令与 `@` 引用：

- Slash (`/` 或 `?`) 由 `useSlashCommandProcessor` 处理，可触发内建命令、子命令及工具调度。
- `@` 引用由 `handleAtCommand` 解析，会使用文件服务与 `read_many_files`、`glob` 等工具扩展用户提示。

结构化协议保留同样语义：

1. **隐式模式**：当 `origin="user"` 且首个 text part 以 `/` 或 `?` 开头时，CLI 自动进入 slash 流程；当文本包含未转义的 `@` 时，会调用 `handleAtCommand` 读取文件并在发送给模型前生成新的 `parts`。
2. **显式模式（推荐给第三方）**：在 `input.command` 中描述命令，避免 CLI 解析字符串。
   ```jsonc
   {
     "session_id": "session-123",
     "input": {
       "origin": "user",
       "parts": [{"type": "text", "text": "/chat list"}],
       "command": {
         "kind": "slash",
         "path": ["chat", "list"],
         "args": ""
       }
     }
   }
   ```
   - `kind`: `slash` | `at`.
   - `path`: 对于 slash 命令，是命令层级数组（等价于 `commandPath`）；对于 `at`，则省略。
   - `args`: 剩余参数字符串。
   - `references`: 当 `kind="at"` 时可选，提前给出解析后的 `[{original:"@foo", resolved:"./src/foo.ts"}]`；若省略，CLI 将按隐式模式解析。

示例：显式引用文件
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

#### SDK 侧命令协作

`useSlashCommandProcessor` 的执行结果可能包含多种动作（消息、弹窗、工具、提交 prompt、加载历史、退出等）。结构化模式通过 `action` 下发这些意图，SDK 需在本地处理效果，并在必要时再向 CLI 发送补充请求：

| `command.result.type` | 说明 | SDK 动作建议 |
|-----------------------|------|--------------|
| `handled` | 已在 CLI 内部完成 | 无需处理 |
| `message` | 返回信息/错误 | 在 UI 显示通知 |
| `dialog` (`auth`/`theme`/`editor`/`privacy`/`settings`/`model`/`subagent_create`/`subagent_list`/`help`) | 需要弹窗或页面跳转 | 在第三方界面发起对应 UI |
| `tool` | 触发工具调用 | 将 `tool_request` 或命令参数转为工具请求，向 CLI 发送并监听结果 |
| `submit_prompt` | 立即向模型发送 PartListUnion | 将 `content` 作为下一条 `input.parts` 提交，并设置 `continuation=true` |
| `load_history` | 重置会话历史 | 调用 CLI 提供的历史设置接口或重新加载 UI 历史 |
| `quit` / `quit_confirmation` | 退出应用或询问确认 | 第三方控制自身生命周期，必要时触发 CLI 退出流程 |
| `confirm_shell_commands` | 需要用户确认 shell 命令 | 弹窗确认；批准后携带 `approvedCommands` / `confirmationOutcome` 再次调用命令 |
| `confirm_action` | 需要确认提示 | 同上，提供确认按钮并返回结果 |

SDK 应暴露统一的命令执行 API，将用户输入映射为上述 `command`（显式或隐式），处理 `action`，并在必要时再次与 CLI 协调，确保行为与 TUI 一致。

CLI 会使用提供的 `resolved` 值读取文件；若未提供则回退到 `handleAtCommand` 的自动解析逻辑。

#### STDIN 命令回执

- 当 `--input-format = stream-json` 时，CLI 必须对 STDIN 中的 `/`、`?`、`@` 等命令指令保持即时反馈，与文本模式一致。解析逻辑沿用 `useSlashCommandProcessor` 与 `handleAtCommand`，不会因结构化模式而绕过。
- 命令解析完成后，CLI 需向 STDOUT 写出结构化响应，形如：
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
  其中 `result` 字段遵循上表的 `command.result.type` 枚举（`message`、`dialog`、`tool`、`submit_prompt` 等），以便 SDK 在收到 `stream-json` / `stream-chunk-json` 消息后立即驱动 UI 或后续请求。
- 若命令触发进一步的模型调用（例如 `/submit`、`@file` 展开），CLI 会在输出中继续串联对应的 `assistant`/`tool_call`/`result` 消息，保持与 TUI 相同的顺序与会话字段，使第三方可以纯文本输入 + JSON 输出的方式完整复现交互。

#### 实时命令提示（Hint）

- 结构化模式必须支持“字符触发提示”流程：当用户在第三方 UI 中输入 `/`、`@`、`?` 等触发字符但尚未按下回车时，集成方可立即发送 **Command Hint Request**，CLI 应返回对应提示数据而不写入会话历史。
- Slash 请求示例（输入 `/c`）：
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
- Slash 响应示例（基于内置命令数据）：
  ```jsonc
  {
    "type": "result/command_hint",
    "session_id": "session-123",
    "prompt_id": "session-123########preview",
    "trigger": "slash",
    "status": "ok",
    "suggestions": [
      {
        "label": "chat",
        "value": "chat",
        "description": "Manage conversation history."
      },
      {
        "label": "clear",
        "value": "clear",
        "description": "clear the screen and conversation history"
      },
      {
        "label": "compress",
        "value": "compress",
        "description": "Compresses the context by replacing it with a summary."
      },
      {
        "label": "copy",
        "value": "copy",
        "description": "Copy the last result or code snippet to clipboard"
      },
      {
        "label": "corgi",
        "value": "corgi",
        "description": "Toggles corgi mode."
      }
    ],
    "metadata": {
      "is_perfect_match": false
    }
  }
  ```
- `@` 请求示例（输入 `@src/co`）：
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
- `@` 响应示例（来自 `useAtCompletion` 文件搜索）：
  ```jsonc
  {
    "type": "result/command_hint",
    "session_id": "session-123",
    "prompt_id": "session-123########preview",
    "trigger": "at",
    "status": "ok",
    "suggestions": [
      {
        "label": "src/components/",
        "value": "src/components/"
      },
      {
        "label": "src/components/Button.tsx",
        "value": "src/components/Button.tsx"
      },
      {
        "label": "src/components/Button with spaces.tsx",
        "value": "src/components/Button\\ with\\ spaces.tsx"
      }
    ],
    "metadata": {
      "is_perfect_match": false
    }
  }
  ```
- `?` 请求示例（输入 `/?`，等价于 `/help`）：
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
- `?` 响应示例（利用 `helpCommand` 的别名）：
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
- `suggestions` 结构复用 TUI 中 `Suggestion` 定义，`status="loading"` 表示 CLI 仍在准备数据（例如 `useAtCompletion` 初始化文件索引），前端可据此展示 Loading；`error` 时附带 `message`。
- CLI 内部复用 `useSlashCompletion`、`useAtCompletion` 等逻辑生成提示；该类请求不会调用 `GeminiChat` 或写入历史，`prompt_id` 可带 `_preview` 后缀并在响应中原样返回。
- 支持连续触发：每当输入内容或光标位置变化时，集成方可重复发送 `command_hint_request`，CLI 需进行节流/去抖后反馈最新提示。若前端取消提示，可发送 `{ "type": "command_hint_cancel", "session_id": "...", "prompt_id": "...", "trigger": "slash" }` 通知 CLI 终止耗时搜索。

#### 日志分层策略

- CLI 仍通过 `ConsolePatcher` 拦截 `console.log`/`warn`/`error`，并在 `x-qwen-terminal` 注解中携带 `channel="stderr"`、`source="console"` 与 `console_level`。
- 为方便第三方过滤，建议在结构化模式下扩展 `annotations[].log_scope` 字段（取值如 `system`、`tool`、`debug`），默认与 TUI 中 `ConfigLogger` 的级别组合保持一致（见 `packages/cli/src/config/config.ts`）。
- 对于工具执行产生的日志，可继续经由 `ToolResultDisplay` 输出；若需要更细粒度过滤，可在对应 `result_display` 中附加 `log_scope`。

#### 心跳与保活

- 结构化协议提供与实时提示类似的独立事件，不污染会话上下文：
  - 集成方可定期发送 `{"type":"heartbeat_request","session_id":"session-123"}`（可选携带 `prompt_id`）。
- CLI 以 `{"type":"result/heartbeat","session_id":"session-123","status":"ok","ts":1739430123}` 回复；亦可在后台主动推送相同事件。
- 若超过约定时间（例如 10 秒）未收到心跳响应，第三方可判定子进程已挂起并执行重启。
- `@third-party/anthropics/claude-agent-sdk-python` 当前未实现心跳机制，需由本项目 CLI/SDK 自行补足；P1.1 实施时需定义默认间隔、超时策略及是否允许 SDK 自定义心跳频率。

#### 实时中断（Escape 指令）

- 结构化模式必须暴露与 TUI 相同的“终止当前响应”能力。TUI 通过 `useGeminiStream.ts` 中的 `useKeypress` 监听 ESC 键并调用 `cancelOngoingRequest`：该流程会中止 `AbortController`、记录 `ApiCancelEvent` 遥测、补齐 `pendingHistoryItem`，并向历史追加“Request cancelled.” 等提示。
- 集成方可在任意时刻通过 STDIN 写入下述控制消息来触发相同行为：
  ```jsonc
  {
    "type": "control/cancel",
    "session_id": "session-123",
    "prompt_id": "session-123########8",
    "reason": "escape"
  }
  ```
  - `session_id`: 必填，用于定位当前会话；
  - `prompt_id`: 可选；若提供，CLI 仅当该 prompt 正在 `Responding`/`WaitingForConfirmation` 状态时才执行取消；缺省时默认取消最近一次启动的请求；
  - `reason`: 预留枚举，当前固定为 `"escape"`，后续可扩展 `"keyboard_interrupt"`、`"timeout"` 等。
- CLI 响应要求：
  - 若存在可取消的流式请求，必须复用 `cancelOngoingRequest` 的逻辑：调用 `AbortController.abort()`、写入 `ApiCancelEvent`、冲刷 `pendingHistoryItem` 并重置补全状态。
  - 立即向 STDOUT 输出 `{"type":"result/cancel","session_id":"session-123","prompt_id":"session-123########8","status":"ok","message":"Request cancelled."}`，便于第三方 UI 更新状态。
  - 当底层流返回 `GeminiEventType.UserCancelled` 事件时，追加发送 `{"type":"x-qwen-session-event","event":"USER_CANCELLED","message":"User cancelled the request."}`，提示会话被中断。
  - 若当前不存在可取消的请求，则响应 `{"type":"result/cancel","session_id":"session-123","status":"noop"}`，不再触发其它事件。
- 双击 ESC 清空输入属于客户端自身的输入框逻辑；结构化模式下的集成方可在本地复用该交互，无需再向 CLI 发送额外消息。

#### 双向控制通道

- 代码现状：`third-party/qwen-code` 目前只支持单向输出（CLI → STDOUT），TUI 中的确认/对话框逻辑直接在进程内处理，缺少像 Claude Code 那样的 `control_request` / `control_response` hook。
- 设计需求：为了让 SDK 集成具备与 TUI 等价的能力（命令确认、敏感操作授权、子代理调度等），协议需复用“独立事件 + STDIN 回写”模式，实现真正的双向通信。
  - 当 CLI 需要外部输入时，输出 `{"type":"control_request","session_id":"session-123","request_id":"req-1","request":{"subtype":"confirm_shell_commands",...}}`。
  - 支持 In-Process MCP Server 时，CLI 还需输出 `subtype: "mcp_message"`，实体内携带 JSON-RPC (`tools/list`、`tools/call`、`initialize` 等)；SDK 处理后在 `control_response` 中返回 `{"response":{"mcp_response":{...}}}`。
  - 第三方应用处理后，通过 STDIN 写回 `{"type":"control_response","request_id":"req-1","response":{"subtype":"success","result":{"behavior":"approve"}}}`。  
  - 该事件不写入会话历史，保持与 `command_hint`、`heartbeat` 相同的旁路通道。
- 场景覆盖：
  - `/confirm_shell_commands`、`confirm_action`、`quit_confirmation` 等需要用户响应的命令。
  - In-Process MCP Server 工具调用链路（`mcp_message` → `mcp_response`）。
  - 工具权限审批（类似 `can_use_tool`）、计划执行或子代理调度需要外部确认的步骤。
  - 未来扩展的弹窗、表单、身份验证流程。
- 回退策略：在通道未启用时，CLI 应采用显式策略（例如自动拒绝危险操作、提示“在结构化模式下不可用”），并在 `result/command` 中返回明确错误，避免静默失败。
- 后续工作：  
  1. 在 RFC 中追加 `control_request`/`control_response` 的 JSON Schema（参考 Claude Code 实现）。  
  2. 在 CLI 中抽象统一的控制消息分发层，使 TUI 与 CLI 复用同一逻辑。  
  3. 在 SDK 中实现监听与响应，暴露钩子给上层 UI。

#### 事件机制分类

为便于第三方实现统一的事件路由与处理，本 RFC 将结构化 STDIN/STDOUT 消息归纳为三类：

1. **结果事件 (`result/*`)**  
   - CLI → STDOUT 的单向通告，例如 `result/command`、`result/command_hint`、`result/heartbeat`、`result/cancel`、`x-qwen-session-event`。  
   - 承载命令输出、提示建议、心跳反馈、取消结果及会话状态更新，不要求 SDK 回执。  
   - 建议第三方根据 `type` 字段实现事件派发，确保不同 UI/服务都能统一处理。

2. **请求事件 (`*request`)**  
   - 第三方 → STDIN 的前向指令，例如 `command_hint_request`、`heartbeat_request`、`control/cancel`。  
   - 用于触发 CLI 的即时响应：
     - `command_hint_request` 获取 `/`、`@` 等提示建议；
     - `heartbeat_request` 维持保活；
     - `control/cancel` 终止当前响应。  
   - CLI 会以对应的 `result/*` 事件回复（如 `result/command_hint`、`result/heartbeat`、`result/cancel`）。

3. **控制通道事件 (`control_request`/`control_response`)**  
   - CLI → STDOUT 输出 `control_request`，SDK/第三方需在 STDIN 写回匹配的 `control_response`；
   - 用于需要回执的回调场景：工具授权 (`can_use_tool`)、Hook (`hook_callback`)、规划中的 MCP 调用 (`subtype: "mcp_message"`) 等；
   - 每条 `control_request` 包含唯一 `request_id`，SDK 必须在合理超时内返回结果或错误，避免 CLI 阻塞。  
   - `control_request` 不写入会话历史，而通过控制层旁路处理，保持与 TUI 行为一致。

以上三类事件通过统一的 JSON Lines 协议传输，可视作同一事件机制的不同子类。集成方在实现时应：

- 按 `type` 或 `subtype` 进行分发，避免将 `control_request` 与一般 `result/*` 混淆；
- 确保请求事件在 STDIN 写入后正确等待相应的 `result/*` 反馈；
- 对控制通道事件实现健壮的回执与超时处理，以防 CLI 阻塞或进入不一致状态。

### JSON Schema 与版本协商

- 在 OpenAI `/chat/completions` 基础上精简为“增量输入”模型，保留 `model`、`tools` 等字段，并新增 `session_id`、`prompt_id`、`origin`、`tool_call_id` 等会话字段。
- CLI 在首个 `chat.completion` 对象的 `metadata`（或 `system_fingerprint` 扩展段）中附带 `protocol_version`、`output_format`、`input_format`、`capabilities`（当支持 chunk 输出时应包含 `chat.completion.chunk` 能力位）。
- SDK 若请求超出 CLI 能力（例如 `protocol_version=3`），CLI 将返回 `chat.completion` 对象，其中 `choices[0].finish_reason="error"` 并在 `usage` 或 `metadata.error` 中携带 `unsupported_protocol` 描述，同时以非零退出码终止。

### 错误语义

- **致命错误**: 输出 OpenAI 风格错误对象，并以非零退出码终止：
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
- **可恢复错误 / 任务失败**: 返回 `chat.completion` 对象，`choices[0].finish_reason` 设为 `stop`（或 `tool_calls`）并在 `choices[0].message.content` / `metadata.error` 中说明失败原因，CLI 继续保持健康状态。
- **控制协议异常**: 若工具授权、Hook 回调出错，CLI 通过 `chat.completion` 对象携带 `metadata.control_errors`，SDK 可据此决定是否重试或中断。

## 安全与资源控制

- CLI 在 `stream-json` 模式下仍遵循现有的 Approval/工具白名单逻辑。
- 计划中的 `control_request`/`control_response` 通道将允许 SDK/第三方在敏感操作前进行审计；在实现之前，应默认拒绝需要授权的动作，或要求用户回退到 TUI 模式。
- 支持在协议层扩展 `heartbeat`，若超时可触发进程回收，避免资源泄漏。

## 可观测性与调试

- 第三方后端服务/SDK 记录消息序列到审计日志，便于重放与问题定位。
- 提供示例命令：

    ```bash
    echo '{"model":"qwen-coder","messages":[{"role":"user","content":"你好"}]}' \
  | qwen --input-format stream-json --output-format stream-json
  
    echo '{"model":"qwen-coder","messages":[{"role":"user","content":"逐字输出问候"}]}' \
  | qwen --input-format stream-json --output-format stream-chunk-json
    ```
