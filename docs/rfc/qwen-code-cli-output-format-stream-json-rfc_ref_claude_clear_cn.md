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
| CLI 参数 | `--input-format`、`--output-format`、`--include-partial-messages` | SDK 默认固定 `--output-format stream-json`，在流式模式追加 `--input-format stream-json`；`--include-partial-messages` 可开启 Qwen-Code 式增量输出 |
| 输出事件 | `user`、`assistant`、`system`、`result`、`stream_event`、`control_request`、`control_response`、`control_cancel_request` | 全部以 JSON Lines 逐行写入 STDOUT，字段对齐 Claude Code CLI |
| 输入事件 | `user`、`control_request`、`control_response`、`control_cancel_request` | JSON 行写入 STDIN，对称驱动 CLI 行为，Envelope 与 Claude Python SDK 一致 |
| 通道语义 | 会话事件、控制通道、流式事件 | 明确回执要求（默认 60s 超时），防止 CLI 阻塞 |
| 协议扩展 | 握手元数据、版本协商、错误语义 | 参考 Claude `initialize`、`result`、错误对象结构 |

- 通信仍使用标准输入输出，未引入额外套接字。
- `text` 模式保留原行为，结构化模式提供稳定 schema 与可观测字段。

## 输出格式语义

| 格式 | 适用场景 | 行为概要 | 兼容性 |
| --- | --- | --- | --- |
| `text` | 手动调试兼容模式 | 输出原有 TUI 文本 | 仅 CLI 手动/降级模式使用 |
| `stream-json` | Claude Code 样式 JSONL | 每行含 `type` 字段：`assistant`、`user`、`result`、`stream_event`、`control_*` 等 | 对齐 Claude Code CLI |
| `stream-json` + `--include-partial-messages` | 增量消息 JSONL | 在标准事件外追加部分 `assistant` 内容与 `stream_event`，便于实时展示 | 对齐 Claude Code `include_partial_messages` |

### 消费策略

- **消息级 JSONL（`stream-json`）**：适合第三方后端或 CLI 包装器按阶段消费结果，与 Claude Agent SDK 默认行为一致。
- **增量模式（`stream-json` + `--include-partial-messages`）**：面向 IDE/UI“边生成边展示”的实时场景，SDK 需监听 `stream_event` 中的 `content_block_delta` 与 `message_stop` 事件完成聚合。
- **终端语义一致性**：Claude Code CLI 不提供独立的终端注解事件；stdout/stderr 相关内容会以文本或工具结果形式写入 `assistant` 消息，增量期间由 `content_block_delta` 输送文本片段，宿主若需还原 ANSI 可解析内容本身。

### `stream-json` 示例

```json
{"type":"system","subtype":"init","session_id":"session-123","data":{"model":"qwen3-coder"}}
{"type":"stream_event","uuid":"evt-1","session_id":"session-123","event":{"type":"message_start","index":0}}
{"type":"stream_event","uuid":"evt-2","session_id":"session-123","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"正在分析…"}}}
{"type":"stream_event","uuid":"evt-3","session_id":"session-123","event":{"type":"message_stop","index":0}}
{"type":"control_request","request_id":"req-tool-1","request":{"subtype":"can_use_tool","tool_name":"edit_file","input":{"path":"src/main.py","patch":"--- a/src/main.py\n+++ b/src/main.py\n@@\n-print('Hi')\n+print('Hello')"}}}
{"type":"control_response","response":{"subtype":"success","request_id":"req-tool-1","response":{"behavior":"allow","message":"已授权","interrupt":false}}}
{"type":"assistant","message":{"role":"assistant","model":"qwen3-coder","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"命令执行成功"}],"is_error":false}]}}
{"type":"result","subtype":"session_summary","duration_ms":6021,"duration_api_ms":5870,"is_error":false,"num_turns":2,"session_id":"session-123","total_cost_usd":0.0021,"usage":{"input_tokens":820,"output_tokens":640}}
```

### 增量消息行为要点

- Claude CLI 仅提供 `stream-json`，当启用 `--include-partial-messages` 时，会把 Anthropic RawMessageStreamEvent 原样封装为 `stream_event`，常见事件类型包括 `message_start`、`content_block_start`、`content_block_delta`、`content_block_stop` 与 `message_stop`。
- `stream_event.event` 中的字段与 Claude SDK `StreamEvent` dataclass 一致：`index` 对应内容块序号，`delta.type` 可能是 `text_delta`、`thinking_delta` 或 `input_json_delta` 等，SDK 需自行聚合增量并在 `message_stop` 后完成收尾。
- `assistant` 消息在同一回合内仍返回完整的 `content` 列表（文本、工具调用、思考块等），方便第三方在增量消费结束后复用统一结构。
- `result` 消息提供 `usage`、`duration_ms`、`duration_api_ms`、`num_turns`、`session_id` 等统计字段，可直接映射到原 RFC `chat.completion` 的资源消耗语义。

## 事件载荷与注解

Claude CLI 的结构化输出由 `third-party/anthropics/claude-agent-sdk-python` 中的 `SubprocessCLITransport` 读取并交由 `message_parser` 解析为强类型对象。`assistant`、`user`、`system`、`result`、`stream_event` 与 `control_*` 事件共同覆盖对话内容、工具调度、统计汇总与控制协议。对应关系如下：

| 类型 | 主要字段 | 用途 |
| --- | --- | --- |
| `assistant` 内容块 | `content[].type`、`content[].text`/`thinking`/`tool_use`/`tool_result` | 复刻 Claude CLI 的会话消息与工具调用流程 |
| `stream_event` | `event.type`、`event.delta`、`event.index` | 原样承载 Anthropic RawMessageStreamEvent（`message_start`、`content_block_delta` 等）以便还原增量输出 |
| `system` | `subtype`、`data` | 广播初始化信息（模型、可用工具、slash 命令、设置来源等）或后续状态通知 |
| `control_request.*` | `request.subtype`、`request_id`、`request` | 工具审批、Hook 回调、MCP JSON-RPC 桥接 |
| `result` | `subtype`、`duration_ms`、`num_turns`、`usage` | 汇总任务统计、错误信息与成本 |

### `StreamEvent` 示例

```json
{
  "type": "stream_event",
  "uuid": "evt-delta-1",
  "session_id": "session-123",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "text_delta",
      "text": "命令执行成功"
    }
  }
}
```

- 常见事件类型：`message_start`（会话增量开始）、`content_block_start`（声明内容块类型）、`content_block_delta`（增量文本或思考内容）、`content_block_stop`、`message_stop`。
- `delta.type` 会区分 `text_delta`、`thinking_delta`、`input_json_delta` 等，第三方需结合 `event.index` 与 `parent_tool_use_id` 聚合增量。
- 未启用 `--include-partial-messages` 时不会输出 `stream_event`；所有输出仅由完整的 `assistant`/`result` 构成。

### 工具结果展示

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "model": "qwen3-coder",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_1",
        "is_error": false,
        "content": [
          {"type": "text", "text": "diff --git a/src/main.py b/src/main.py\n@@\n-print('Hi')\n+print('Hello')"}
        ]
      }
    ]
  }
}
```

- `tool_use_id`：与前一条 `tool_use` 块配对，Claude SDK 会将其映射为 `ToolResultBlock`。
- `content` 可以是字符串或内容块数组；当返回 diff、JSON 等结构化信息时，可拆成多个 `text`/`image` 块。
- `is_error=true` 时表示工具执行失败，SDK 应展示错误提示或回退。

### 思考与会话事件

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "model": "qwen3-coder",
    "content": [
      {
        "type": "thinking",
        "thinking": "Analyzing repository layout…",
        "signature": "sig-001"
      }
    ]
  }
}
```

- `thinking` 块展示 Claude 的内部推理，`signature` 可用于安全校验。

### SystemMessage 示例

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "session-123",
  "data": {
    "cwd": "/workspace/demo",
    "model": "qwen3-coder",
    "slash_commands": ["commit", "run"],
    "tools": ["read", "write", "run_command"],
    "setting_sources": ["user"],
    "permission_mode": "manual"
  }
}
```

- `system` 消息常以 `subtype="init"` 开场，`data` 中包含工作目录、可用工具、可加载的 slash 命令、权限模式等元数据。
- 后续系统提示可能使用其他 `subtype`（如 `status_update`、`warning`），结构同样承载在 `data` 字段内。

## 输入格式

| 模式 | 行为 | 说明 |
| --- | --- | --- |
| `text` | 保留原有 TUI 输入体验 | 仅适用于手动调试或降级模式，沿用 CLI 传统逐行解析 |
| `stream-json` | Claude Envelope JSONL | 每行 JSON 传递 `user`、`assistant`、`result`、`control_*` 等事件，SDK 以流式方式驱动 CLI |

### 用户消息 Envelope

```jsonc
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"请修复 main.py 的 bug"}]},"parent_tool_use_id":null}
```

- `message.content` 可为字符串或 `ContentBlock` 数组；当内容包含工具回执时应为 `tool_result` 块。
- `parent_tool_use_id` 允许在工具串联或子任务续写时保持上下文关联，Claude SDK 会基于该字段恢复父工具调用。
- SDK 可通过 `options` 字段覆写一次性参数（模型、权限模式、是否包含部分消息等），格式与 `ClaudeAgentOptions` 保持一致。
- 写入完成后可调用 `end_input()`（或关闭 stdin）提示 CLI 当前回合结束，`SubprocessCLITransport` 会向 CLI 发送 EOF。

### 工具结果回传 Envelope

```jsonc
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"命令输出"}],"is_error":false}]}}
```

- 当 CLI 通过 `control_request.can_use_tool` 请求外部执行操作时，SDK 负责落地实际动作并将结果回写为 `tool_result` 块。
- `is_error=true` 表示工具失败，CLI 将以 `assistant` 消息或 `result` 反馈错误并决定是否中断后续流程。
- 允许在 `content` 中混合多种块（文本、富媒体、JSON），Claude SDK 会按 `ContentBlock` 定义解析。

### 会话控制与初始化

- Claude SDK 在建立流式会话时会先发送 `control_request.initialize`，CLI 以 `control_response.success` 回传，`response` 中通常包含：
  - `commands`：CLI 支持的命令与子命令列表。
  - `output_styles`/`output_style`：默认输出格式（通常为 `stream-json`）。
  - `serverInfo`：CLI 侧标识、版本号、可选能力标志。
- SDK 在构造初始化请求时会将 Hook 与 MCP 配置编码至 `request` 字段（如 `hooks`、`mcp`、`permission_mode`），字段结构与 `InitializeRequest` / `InitializeSuccessPayload` 对齐。【参考 `src/claude_agent_sdk/_internal/query.py`】
- 初始化完成后，CLI 将继续输出 `assistant`/`stream_event`／`result` 等消息，保持与 TUI 一致的事件顺序。

### SDK 主动控制请求

- Claude SDK 通过 `_send_control_request()` 发送下列子类型：
  - `interrupt`：请求 CLI 终止当前任务，常用于用户点击“Stop”。
  - `set_permission_mode`：动态调整权限模式（如 `auto`、`manual`）。
  - `set_model`：切换模型，允许传入 `null` 表示恢复 CLI 默认。
  - `initialize`：首个握手请求，封装 Hook、权限、MCP 配置。
- 每个请求包含唯一 `request_id`，SDK 会等待最长 60 秒的 `control_response` 回执，超时将抛出 `Control request timeout` 并清理挂起状态。

### CLI 主动控制请求与取消

- CLI 在需要外部确认或执行扩展逻辑时输出 `control_request`：
  - `can_use_tool`：征询工具执行权限，可携带 `permission_suggestions`、`blocked_path` 等上下文。
  - `hook_callback`：触发 SDK 侧自定义 Hook，并将返回值通过 `control_response` 回写。
  - `mcp_message`：封装 JSON-RPC 报文与服务器名称，交由 SDK 托管的 MCP Server 处理。
- 若需要放弃等待，CLI 会发送 `control_cancel_request`，SDK 应停止对对应 `request_id` 写回结果，避免状态错乱。

## 实时事件

| 能力 | 事件 / 请求 | 响应 | 说明 |
| --- | --- | --- | --- |
| 增量输出 | `stream_event.message_start` / `content_block_*` | `assistant` 消息或 `stream_event.message_stop` | 描述增量生成生命周期，便于还原逐 token / 块输出 |
| 控制回执 | `control_request.*` | `control_response.success/error` | 工具审批、Hook/MCP 回调需严格配对 `request_id` |
| 中断 | SDK 发送 `control_request.interrupt` | `control_response.success` + `result` | 停止当前任务并返回汇总信息 |
| 取消提示 | `control_cancel_request` | 无需响应 | CLI 请求放弃等待某个控制回执，SDK 仅记录并清理挂起状态 |

```jsonc
{"type":"stream_event","uuid":"evt-2","session_id":"session-123","event":{"type":"message_stop","index":0}}
```

- SDK 应组合前序 `content_block_delta` 与此处的 `message_stop` 来生成最终文本。
- Claude CLI 未提供额外的 `command_hint_request`、`heartbeat_request` 或 keepalive 事件，宿主应用需自行设定超时与保活策略。

## 事件分类与通道

| 类别 | 方向 | 代表事件 | 回执要求 | 作用 |
| --- | --- | --- | --- | --- |
| 会话主通道 | CLI → STDOUT | `user`（回放）、`assistant`、`result`、`system`、`stream_event` | 无需回执 | 呈现对话、工具输出、统计、保活 |
| 控制通道 | CLI ↔ STDIO | `control_request` / `control_response` | 必须匹配 `request_id` | 工具审批、Hook、MCP、初始化、权限切换 |
| 输入通道 | SDK/第三方 → STDIN | `user`、`control_request`（SDK 发起） | CLI 必须处理或返回错误 | 驱动用户输入、主动控制、取消 |

- `system` 消息用于广播初始化能力，`result` 消息返回统计与错误信息，`stream_event` 则承载增量输出；三类事件共同覆盖主通道语义。
- 所有事件均以 JSON Lines 传输，建议按照 `type`、`subtype` 与 `event.type` 路由，并为控制通道实现超时机制避免阻塞。

## 控制请求与响应

| 字段 | 说明 |
| --- | --- |
| `type` | 固定为 `control_request` 或 `control_response` |
| `request_id` | 唯一标识，请求与响应配对 |
| `request` | 当 `type=control_request` 时携带子类型与明细，例如 `can_use_tool`、`hook_callback`、`mcp_message` |
| `response` | 当 `type=control_response` 时包含 `subtype`=`success`/`error` 及返回值 |

- `control_request` 示例：

```jsonc
{
  "type": "control_request",
  "request_id": "req-1",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "edit_file",
    "input": {"path": "main.py", "patch": "..."},
    "permission_suggestions": null
  },
  "session_id": "session-123"
}
```

- 成功回执示例：

```jsonc
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req-1",
    "response": {
      "behavior": "allow",
      "updatedInput": null,
      "message": "允许执行"
    }
  }
}
```

- 失败回执示例：

```jsonc
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "req-1",
    "error": "Tool execution denied by policy"
  }
}
```

- MCP 集成：当 `subtype="mcp_message"` 时，`request` 中包含 `server_name` 与 JSON-RPC `message`；SDK 需在 `response.response.mcp_response` 中回传规范化结果。【参考 `query.py` 及 `types.py`】
- 若 CLI 发送 `control_cancel_request`，SDK 必须停止等待并记录取消原因。Claude SDK 当前仅记录日志，后续可扩展主动回执。

## 版本协商与错误语义

| 项目 | 说明 |
| --- | --- |
| 协议版本 | `control_response.success` (initialize) 可返回 `protocolVersion`、`supportedOutputStyles`、`capabilities`，SDK 应缓存用于兼容性判断 |
| 版本不匹配 | 若 CLI 不支持请求的能力，会输出 `result`（`subtype="error"`、`is_error=true`）并在 stderr 打印 Anthropic 错误 JSON，SDK 侧会抛出异常终止流程 |
| 致命错误 | CLI 遵循 Claude Code 错误对象格式（`type`、`message`、`code`），同时写入 `stderr`，SDK 将其包装为异常 |
| 可恢复错误 | 可通过 `result` 或 `assistant` 返回错误消息，`is_error=true` 并保持进程健康 |
| 控制协议错误 | `control_response.error` 的 `error` 字段提供文本描述，SDK 可决定重试、降级或中止 |

致命错误示例：

```json
{
  "error": {
    "message": "invalid tool input",
    "type": "invalid_request_error",
    "param": "tools[0].function.arguments",
    "code": "QWEN_CODE_INVALID_TOOL_ARGS"
  }
}
```

## 安全与资源控制

| 领域 | 策略 |
| --- | --- |
| 权限 | 沿用 Claude CLI 审批模型；未收到 `control_response` 时默认拒绝高风险操作，并提示需要人工确认 |
| 审计 | 建议记录完整 JSONL 流（含 `control_request`/`response`、`user` 输入），便于复盘与合规检查 |
| 保活 | Claude CLI 未内置 keepalive 事件；建议结合 `stream_event` 活跃度与控制通道超时实现监控 |
| 资源释放 | `SubprocessCLITransport.close()` 会在会话结束时清理子进程与异步任务组，第三方应在异常时调用 |

## 日志分层与可观测

| 组件 | 要点 |
| --- | --- |
| 会话输出 | `assistant` 文本块与 `stream_event` 增量共同覆盖 stdout/stderr，必要时可在内容中解析 ANSI |
| `result` 统计 | `duration_ms`、`usage`、`total_cost_usd` 便于计费与性能分析 |
| Hook/MCP 追踪 | `control_request`/`response` 可附带自定义元数据，建议记录以支持端到端追踪 |
| OpenTelemetry | SDK/CLI 可分别注入 OTel Trace，将 `request_id` 和 `session_id` 作为 Span 属性以便串联 |

- 推荐将所有消息持久化到审计日志，结合 `session_id`、`request_id`、`uuid` 实现重放与问题定位。

## 调试示例

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"你好"}]}}'   | qwen code --input-format stream-json --output-format stream-json --model qwen-coder

echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"逐字输出问候"}]}}'   | qwen code --input-format stream-json --output-format stream-json --include-partial-messages
```

- 结合 `jq -c` 可验证事件流是否符合 Claude Envelope 约定。
- 建议同时监控 CLI `stderr`，以捕获致命错误或协议不匹配提示。

## 会话消息 Schema 摘要

为了便于第三方实现与 Claude SDK 对齐的解析逻辑，本节整理主要 Envelope 与内容块结构，均来源于 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py` 与 `message_parser.py`。

### `AssistantMessageEnvelope`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `"assistant"` | 固定值 |
| `message.role` | `"assistant"` | 角色标识 |
| `message.model` | `string` | 实际使用的模型名称 |
| `message.content` | `ContentBlock[]` | 混合文本、思考、工具调用、工具结果 |
| `parent_tool_use_id` | `string?` | 指向父工具调用，便于链式对话 |

### `UserMessageEnvelope`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `"user"` | 用户输入或回放 |
| `message.content` | `string | ContentBlock[]` | 原始文本或结构化内容 |
| `parent_tool_use_id` | `string?` | 当消息是工具结果续写时必填 |

### `ResultMessageEnvelope`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `"result"` | 汇总事件 |
| `subtype` | `string` | 常见值：`session_summary`、`tool_execution`、`error` |
| `duration_ms` / `duration_api_ms` | `number` | 总耗时与 API 耗时 |
| `is_error` | `boolean` | 是否为错误场景 |
| `usage` | `object?` | token 统计，字段同 Claude SDK `Usage` |
| `total_cost_usd` | `number?` | 计费信息 |

### `StreamEventEnvelope`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `"stream_event"` | 流式事件 |
| `uuid` | `string` | 事件唯一标识 |
| `session_id` | `string` | 会话 ID |
| `event.type` | `string` | `message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_stop` |
| `event.index` | `number?` | 指向内容块序号，与 `assistant` 消息的块顺序一致 |
| `event.delta` | `object?` | 当 `event.type` 为 `content_block_delta` 时包含 `text_delta`/`thinking_delta` 等增量 |
| `event` 其他字段 | `object?` | 原样保留 Anthropic RawMessageStreamEvent 的附加信息 |

## 控制 Schema 摘要

下表列出常见 `control_request` / `control_response` 子类型及关键字段，方便 SDK/第三方严格校验。

| 子类型 | 方向 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| `initialize` | SDK → CLI | `hooks`、`mcp`、`permission_mode` | 建立握手，公布 Hook、MCP 与权限配置 |
| `interrupt` | SDK → CLI | - | 中断当前任务，CLI 返回 `control_response.success` 并输出 `result` |
| `set_permission_mode` | SDK → CLI | `mode` | 切换 `auto`/`manual` 等权限模式 |
| `set_model` | SDK → CLI | `model` | 动态切换模型，支持 `null` 恢复默认 |
| `can_use_tool` | CLI → SDK | `tool_name`、`input`、`permission_suggestions` | 工具执行授权，SDK 返回 `behavior`、`updatedInput` 等 |
| `hook_callback` | CLI → SDK | `callback_id`、`input` | 调用已注册 Hook，支持同步/异步结果 |
| `mcp_message` | CLI → SDK | `server_name`、`message` | 与 MCP Server 通信，遵循 JSON-RPC |
| `control_cancel_request` | CLI → SDK | `request_id`、`reason` | 终止挂起控制请求，SDK 应停止回执 |

成功响应 (`control_response.success`) 常用 payload：

- `InitializeSuccessPayload`：携带 `commands`、`output_style`、`serverInfo`、`capabilities`。
- `ToolPermissionSuccessPayload`：`behavior`=`allow`/`deny`，可选 `updatedInput`、`updatedPermissions`、`message`。
- `HookCallbackSuccessPayload`：`async`、`continue`、`decision`、`hookSpecificOutput` 等字段。
- `McpMessageSuccessPayload`：封装 `mcp_response`，与 JSON-RPC 返回结构一致。
- `AckOnlyPayload`：用于无附加数据的确认（如 `interrupt` 成功）。

错误响应 (`control_response.error`) 在 `error` 字段提供字符串描述，可结合 `result` 或 `stream_event` 提示用户。

## SDK ↔ CLI 协作流程速记

1. **启动阶段**：`SubprocessCLITransport` 追加 `--output-format stream-json`、`--input-format stream-json`，合并环境变量并启动 `qwen` 进程，保持 STDIN/STDOUT 管道打开。
2. **握手阶段**：SDK 发送 `control_request.initialize`，CLI 回以 `control_response.success`，并在后续输出首批 `assistant`/`system`/`result` 消息公布能力与状态。
3. **主循环**：
   - SDK 写入 `user` 消息或主动控制请求。
   - CLI 输出 `assistant`、`stream_event`、`result` 等事件，并在需要授权时推送 `control_request`。
   - SDK 匹配 `request_id` 写回 `control_response`，如有工具执行结果则以 `user` 消息的 `tool_result` 内容块反馈。
4. **取消/中断**：SDK 可发送 `control_request.interrupt`，或由 CLI 输出 `control_cancel_request` 终止挂起请求；双方需清理本地状态并记录日志。
5. **收尾阶段**：CLI 输出最终 `result`（`is_error`/`session_summary`），随后退出或等待下一轮输入；传输层在检测到 EOF 时释放子进程与缓冲队列。

该流程在 Claude SDK 中由 `Query` 协程驱动，第三方实现可参考相同的状态机、超时与异常处理策略。

## 源码索引（Claude 规范相关）

| 功能 | 文件 | 说明 |
| --- | --- | --- |
| 传输层 | `src/claude_agent_sdk/_internal/transport/subprocess_cli.py` | 启动 CLI、处理 JSONL、维护进程生命周期 |
| 控制与会话调度 | `src/claude_agent_sdk/_internal/query.py` | 握手、控制请求发送、输入流收尾、事件路由 |
| 消息解析 | `src/claude_agent_sdk/_internal/message_parser.py` | 将 JSON 行解析为 `AssistantMessage`、`ResultMessage`、`StreamEvent` 等对象 |
| 类型定义 | `src/claude_agent_sdk/types.py` | `ContentBlock`、控制请求/响应、结果统计等 TypedDict/Dataclass |
| 对外客户端 | `src/claude_agent_sdk/client.py`、`query.py` | 暴露 `ClaudeSDKClient`、`query()` 等高层 API，封装命令行与选项 |

- 建议在实现第三方 SDK 时直接参考以上模块，确保字段命名、结构与错误处理完全一致。
- 若需自定义传输层（如 WebSocket），可沿用同样的 Envelope 与控制语义，实现最小改动的兼容适配。

## 详细 Schema 附录

以下附录按照 Claude SDK 文档顺序列出关键 Envelope 与控制协议 Schema，便于实现时逐项比对。

### 会话消息 Envelope 结构

| 名称 | 核心字段 | 说明 |
| --- | --- | --- |
| `UserMessageEnvelope` | `type="user"`、`message.role="user"`、`message.content`、`parent_tool_use_id` | SDK 写入 CLI 的用户消息封装，也用于 CLI 回放用户输入。 |
| `AssistantMessageEnvelope` | `type="assistant"`、`message.model`、`message.content[]`、`parent_tool_use_id` | Claude CLI 输出的助手回复，内容块遵循 `ContentBlock` 枚举。 |
| `SystemMessageEnvelope` | `type="system"`、`subtype`、`data` | 系统提示、设置或统计信息。 |
| `ResultMessageEnvelope` | `type="result"`、`subtype`、`duration_ms`、`is_error`、`usage`、`total_cost_usd` | 任务级统计、工具执行总结或错误描述。 |
| `StreamEventEnvelope` | `type="stream_event"`、`uuid`、`session_id`、`event.type`、`event.delta` | 承载 Anthropic RawMessageStreamEvent，用于增量输出与内容块生命周期管理。 |

`ContentBlock` 类型包括：

- `text`: `{"type":"text","text":"..."}` —— 普通文本回复。
- `thinking`: `{"type":"thinking","thinking":"...","signature":"sig-1"}` —— 展示 Claude 内部推理。 
- `tool_use`: `{"type":"tool_use","id":"toolu_1","name":"run_shell","input":{...}}` —— 声明工具调用并提供参数。
- `tool_result`: `{"type":"tool_result","tool_use_id":"toolu_1","content":[...],"is_error":false}` —— 返回工具执行结果，可包含富文本或结构化内容。

### 控制请求 Schema 摘要

| 子类型 | 方向 | 必需字段 | 说明 |
| --- | --- | --- | --- |
| `initialize` | SDK → CLI | `hooks`、`mcp`、`permission_mode` | 握手阶段传递 Hook/MCP 配置与权限模式。 |
| `interrupt` | SDK → CLI | - | 中断当前任务。 |
| `set_permission_mode` | SDK → CLI | `mode` | 运行时切换权限模式。 |
| `set_model` | SDK → CLI | `model` | 切换模型，允许 `null` 恢复默认。 |
| `can_use_tool` | CLI → SDK | `tool_name`、`input`、`permission_suggestions?` | 工具权限与参数确认。 |
| `hook_callback` | CLI → SDK | `callback_id`、`input?`、`tool_use_id?` | 执行已注册 Hook，支持同步/异步结果。 |
| `mcp_message` | CLI → SDK | `server_name`、`message` | 透传 MCP JSON-RPC 请求。 |
| `control_cancel_request` | CLI → SDK | `request_id?`、`reason?` | 取消挂起的控制请求。 |

成功响应 (`control_response.success`) 对应的 payload：

- `InitializeSuccessPayload`：`commands`、`output_style`、`serverInfo`、`capabilities`。
- `ToolPermissionSuccessPayload`：`behavior`、`updatedInput?`、`updatedPermissions?`、`message?`、`interrupt?`。
- `HookCallbackSuccessPayload`：`async?`、`continue?`、`decision?`、`hookSpecificOutput?`。
- `McpMessageSuccessPayload`：`mcp_response`（JSON-RPC 返回）。
- `AckOnlyPayload`：用于 `interrupt`、`set_model` 等无额外数据的确认。

错误响应 (`control_response.error`) 在 `error` 字段提供文本描述，可结合 `result` 或 `stream_event` 提示用户。

### 代码片段参考

```python
        case "assistant":
            try:
                content_blocks: list[ContentBlock] = []
                for block in data["message"]["content"]:
                    match block["type"]:
                        case "text":
                            content_blocks.append(TextBlock(text=block["text"]))
                        case "thinking":
                            content_blocks.append(
                                ThinkingBlock(
                                    thinking=block["thinking"],
                                    signature=block["signature"],
                                )
                            )
                        case "tool_use":
                            content_blocks.append(
                                ToolUseBlock(
                                    id=block["id"],
                                    name=block["name"],
                                    input=block["input"],
                                )
                            )
                        case "tool_result":
                            content_blocks.append(
                                ToolResultBlock(
                                    tool_use_id=block["tool_use_id"],
                                    content=block.get("content"),
                                    is_error=block.get("is_error"),
                                )
                            )

                return AssistantMessage(
                    content=content_blocks,
                    model=data["message"]["model"],
                    parent_tool_use_id=data.get("parent_tool_use_id"),
                )
            except KeyError as e:
                raise MessageParseError(
                    f"Missing required field in assistant message: {e}", data
                ) from e
```

```python
    async def _handle_control_request(self, data: dict[str, Any]) -> None:
        request_id = data["request_id"]
        request = data["request"]
        subtype = request["subtype"]

        if subtype == "can_use_tool":
            if not self.can_use_tool:
                await self._send_control_response_error(
                    request_id, "Tool usage not allowed: handler missing"
                )
                return
            response = await self.can_use_tool(
                request["tool_name"],
                request.get("tool_use_id"),
                request.get("input"),
                request.get("permission_suggestions"),
            )
            await self._send_control_response_success(request_id, response)
        elif subtype == "hook_callback":
            response = await self._run_hook_callback(request, request_id)
            await self._send_control_response_success(request_id, response)
        elif subtype == "mcp_message":
            response = await self._handle_mcp_message(request)
            await self._send_control_response_success(request_id, response)
        else:
            await self._send_control_response_error(
                request_id, f"Unsupported control subtype: {subtype}"
            )
```

```python
    async def _read_stdout(self) -> None:
        assert self.process is not None
        assert self.stdout_queue is not None

        while True:
            line = await self.process.stdout.readline()
            if not line:
                await self.stdout_queue.put(None)
                break

            decoded = line.decode("utf-8", errors="replace").strip()
            try:
                message = json.loads(decoded)
            except json.JSONDecodeError as exc:
                raise CLIJSONDecodeError(decoded) from exc

            await self.stdout_queue.put(message)
```
