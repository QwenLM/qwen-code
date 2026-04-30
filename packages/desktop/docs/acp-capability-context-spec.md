# Qwen Code ACP Capability Context Spec

本文档描述 qwen code 作为 Agent 后端时，通过 ACP（Agent Capability Protocol）暴露给外部 Agent/UI 可理解的能力上下文。本文档的目标是能力建模与上下文暴露，不是 Electron 接入方案。

---

Qwen Code 项目位于本地 /Users/dragon/Documents/qwen-code

## 1. Capability Overview（系统能力概览）

### Chat / Multimodal Prompt

用途：接收用户消息并生成 Agent 回复。

典型场景：代码问答、解释仓库结构、基于选中文本或嵌入资源回答问题。

ACP 表达：

- `initialize` 宣告 `promptCapabilities`
- `session/new` 创建会话
- `session/prompt` 输入用户消息
- `session/update` 流式输出文本、思考、工具调用、计划等状态

支持内容：

- text
- image
- audio
- resource_link
- embedded resource context

### Tool Use

用途：让模型调用可执行工具完成读文件、改代码、搜索、命令执行、联网 fetch、LSP 查询等操作。

典型场景：读取目标文件、定位符号、执行测试、应用补丁、查询网页内容。

ACP 表达：

- 工具调用开始：`sessionUpdate: "tool_call"`
- 工具调用结果：`sessionUpdate: "tool_call_update"`
- 工具分类：`kind: read | edit | search | execute | fetch | think | switch_mode | other`
- 权限请求：`session/request_permission`

### Code Generation / Modification

用途：生成新代码、修改现有代码、写入文件、展示 diff。

典型场景：修 bug、添加功能、重构、生成测试文件。

ACP 表达：

- `edit` / `write_file` 工具为模型内部 action
- 通过 `tool_call` 暴露待执行动作
- 通过 `tool_call_update.content[type="diff"]` 暴露文件变更上下文
- 修改类工具通常有副作用，需要 permission flow

### Agent Loop / Multi-step Execution

用途：支持 plan -> act -> observe 的多步执行。

典型场景：复杂代码修改、跨文件调查、先搜索再读取再修改再测试。

ACP 表达：

- 模型输出文本 chunk
- 模型发出 function call
- qwen code 执行工具
- 工具结果作为 function response 回灌给模型
- 循环直到无新 tool call
- 最终 `PromptResponse.stopReason = "end_turn" | "cancelled"`

### Planning / Todo Context

用途：让 Agent 对复杂任务维护计划状态。

典型场景：多步骤修复、先列计划再逐步执行。

ACP 表达：

- `todo_write` 工具不作为普通 tool call 暴露
- 它被转换为 `sessionUpdate: "plan"`
- plan entries 包含 `content`, `priority`, `status`

### Memory / Context Persistence

用途：支持会话历史、用户/项目记忆、自动记忆文件、session resume。

典型场景：恢复历史会话、利用长期偏好或项目背景辅助决策。

ACP 表达：

- `loadSession: true`
- `sessionCapabilities.list/resume`
- 会话历史 replay 为消息、工具调用、plan update
- memory 主要作为模型上下文注入，不是 ACP 独立方法

注意：当前 ACP session path 会注入 plan/subagent/arena system reminder；代码注释显示 managed auto-memory relevant recall 尚未完全搬到 ACP path。

### File / Environment Interaction

用途：读取/写入本地文件、列目录、搜索文件、执行 shell、通过 MCP 扩展能力。

典型场景：打开源码、运行单测、查看构建错误、读写 IDE 所在文件系统。

ACP 表达：

- 若 client 声明 `fs.readTextFile/writeTextFile`，qwen code 可通过 ACP 请求 client 文件系统
- 否则 fallback 到本地文件系统服务
- shell / terminal 能力主要通过内部 `run_shell_command` 工具和权限系统表达

---

## 2. ACP Capability Model（能力抽象模型）

qwen code 中的能力分两层：

1. ACP session capability：协议级能力，如 prompt、session、mode、model、permission、filesystem。
2. Core tool capability：模型可调用工具，如 `read_file`, `edit`, `run_shell_command`, `agent`。

抽象结构可表示为：

```ts
type AcpCapability = {
  name: string;
  description: string;
  transport: "acp-method" | "model-tool";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  streaming: boolean;
  sideEffects: boolean;
  permission?: "allow" | "ask" | "deny" | "dynamic";
  emits?: Array<
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan"
    | "current_mode_update"
    | "available_commands_update"
  >;
};
```

ACP session update 统一模型：

```json
{
  "sessionId": "string",
  "update": {
    "sessionUpdate": "agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | plan | available_commands_update | current_mode_update",
    "content": {},
    "_meta": {}
  }
}
```

工具调用上下文模型：

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "string",
  "status": "pending | in_progress | completed | failed",
  "title": "human readable operation",
  "kind": "read | edit | delete | move | search | execute | think | fetch | switch_mode | other",
  "locations": [{ "path": "string", "line": 1 }],
  "rawInput": {},
  "_meta": {
    "toolName": "read_file"
  }
}
```

工具结果模型：

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "string",
  "status": "completed | failed",
  "content": [
    {
      "type": "content",
      "content": { "type": "text", "text": "..." }
    }
  ],
  "rawOutput": {},
  "_meta": {
    "toolName": "read_file"
  }
}
```

支持情况：

- streaming：支持，message chunk、thought chunk、tool lifecycle、usage metadata 均可增量发出。
- 多轮上下文：支持，通过 sessionId 维护 chat history。
- 中间状态：支持，`tool_call`, `tool_call_update`, `plan`, `current_mode_update`。
- 能力边界：外部 UI 不直接调用模型工具；工具由模型在 Agent loop 中选择，ACP 将其作为可观察、可授权、可渲染的上下文事件暴露。

---

## 3. Capability Registry（能力列表）

| Capability | 描述 | 输入 schema 摘要 | 输出 schema 摘要 | Streaming | 副作用 |
|---|---|---|---|---|---|
| `chat` | 用户与 Agent 对话 | `{ sessionId, prompt: ContentBlock[] }` | `PromptResponse { stopReason }` + session updates | 是 | 否 |
| `session_create` | 创建 Agent 会话 | `{ cwd: string, mcpServers: McpServer[] }` | `{ sessionId, modes?, models?, configOptions? }` | 否 | 是，创建运行时会话 |
| `session_load` | 加载历史会话 | `{ cwd, sessionId, mcpServers }` | `{ modes?, models?, configOptions? }` + history replay | 是 | 是，恢复上下文 |
| `session_list` | 列出历史会话 | `{ cwd?, cursor?, _meta.size? }` | `{ sessions[], nextCursor? }` | 否 | 否 |
| `mode_switch` | 切换执行模式 | `{ sessionId, modeId }` | `{}` / `current_mode_update` | 是 | 是，影响权限行为 |
| `model_switch` | 切换模型 | `{ sessionId, modelId }` | `{}` | 否 | 是，影响后续推理 |
| `permission_request` | 请求用户授权敏感 tool call | `{ sessionId, toolCall, options[] }` | `{ outcome }` | 否 | 取决于授权结果 |
| `file_read` | 读取文件 | `{ file_path, offset?, limit?, pages? }` | text/blob content via tool result | 是 | 否 |
| `file_write` | 覆盖或创建文件 | `{ file_path, content, modified_by_user?, ai_proposed_content? }` | diff / status / error | 是 | 是 |
| `file_edit` | 精确替换文件片段 | `{ file_path, old_string, new_string, replace_all? }` | diff / status / error | 是 | 是 |
| `directory_list` | 列目录 | `{ path, ignore?, file_filtering_options? }` | file entries text | 是 | 否 |
| `file_search` | glob 文件搜索 | `{ pattern, path? }` | matched paths | 是 | 否 |
| `content_search` | grep/ripgrep 内容搜索 | `{ pattern, path?, glob?, limit? }` | matches with file/line | 是 | 否 |
| `command_execute` | 执行 shell 命令 | `{ command, is_background, timeout?, description?, directory? }` | stdout/stderr/status | 是 | 是 |
| `code_generation` | 通过 chat + tools 生成代码 | `{ prompt/context }` | text + file edits | 是 | 可能 |
| `agent_plan_execute` | 维护任务计划 | `{ todos[] }` via `todo_write` | `sessionUpdate: "plan"` | 是 | 否 |
| `subagent_delegate` | 启动子 Agent | `{ description, prompt, subagent_type? }` | child tool events + summary | 是 | 可能 |
| `skill_use` | 调用技能上下文 | `{ skill, prompt? }` | skill result/context | 是 | 可能 |
| `memory_save` | 保存长期记忆 | memory file write/tool behavior | tool result | 是 | 是 |
| `web_fetch` | 获取网页并按 prompt 处理 | `{ url, prompt }` | fetched/summarized content | 是 | 外部网络访问 |
| `lsp_query` | LSP 语义查询 | `{ operation, filePath?, position?, query?, ... }` | symbols/diagnostics/actions | 是 | 通常无 |
| `ask_user_question` | Agent 向用户提问 | `{ questions[] }` | answers | 是 | 否 |
| `cron_create` | 创建定时 Agent prompt | `{ cron, prompt }` | cron id/status | 是 | 是 |
| `cron_list` | 列出定时任务 | `{}` | cron jobs | 是 | 否 |
| `cron_delete` | 删除定时任务 | `{ id }` | deletion status | 是 | 是 |
| `task_stop` | 停止后台任务/子 Agent | `{ task_id }` | stop status | 是 | 是 |
| `send_message` | 向后台任务继续发送消息 | `{ task_id, message }` | delivery/result status | 是 | 是 |

核心 tool output 统一结构：

```json
{
  "toolCallId": "string",
  "status": "completed | failed",
  "content": [
    {
      "type": "content | diff | terminal",
      "content": {}
    }
  ],
  "rawOutput": {},
  "_meta": {
    "toolName": "string"
  }
}
```

---

## 4. Agent Behavior Model（Agent 行为模型）

qwen code 的 ACP Agent 是 loop-based。

典型循环：

```text
user prompt
  -> resolve prompt blocks / embedded context
  -> inject session reminders
  -> model streaming
  -> collect function calls
  -> run tools
  -> emit ACP tool state
  -> feed tool results back to model
  -> repeat until no function calls
  -> emit final stopReason
```

能力选择方式：

- 模型根据 system prompt、tool schemas、上下文历史选择 tool。
- ToolRegistry 提供可用工具声明。
- PermissionManager、approval mode、hooks 决定工具是否可执行。
- ACP client 不负责选择内部工具，但能观察、授权、取消。

Planner / executor：

- 没有独立强制分离的 planner/executor 服务。
- planning 由模型和 `todo_write` / plan mode 协作完成。
- executor 是 qwen code runtime：负责校验参数、权限判断、执行工具、回灌结果。
- `agent` tool 可启动 subagent，形成父 Agent 委派子 Agent 的执行结构。

ACP 如何参与 Agent loop：

- 输入：`session/prompt`
- 中间状态：`session/update`
- 授权：`session/request_permission`
- 取消：`session/cancel`
- 终止：`PromptResponse.stopReason`

---

## 5. Context Model（上下文模型）

输入 context：

```json
{
  "sessionId": "string",
  "prompt": [
    { "type": "text", "text": "..." },
    { "type": "image", "mimeType": "image/png", "data": "base64" },
    { "type": "audio", "mimeType": "audio/wav", "data": "base64" },
    { "type": "resource_link", "uri": "file:///abs/path", "name": "file.ts" },
    {
      "type": "resource",
      "resource": {
        "uri": "file:///abs/path",
        "text": "embedded content"
      }
    }
  ]
}
```

上下文来源：

- system prompt / custom system prompt
- 用户消息
- 多轮 chat history
- tool result history
- embedded resources
- file links resolved into content
- plan mode reminder
- subagent reminder
- arena reminder
- session resume history
- memory prompt / memory files，在 core 层作为模型上下文的一部分

截断与压缩：

- core client 支持 chat compression，默认在上下文达到模型窗口比例阈值时压缩历史。
- compression 会保留近期历史，将较早历史总结为 state snapshot。
- memory index 有行数和字节截断限制。
- 当前 ACP session 实现直接使用 chat stream path，并显式补充 plan/subagent/arena reminders；相关注释表明 managed auto-memory recall 尚未完整进入 ACP path。

历史如何参与决策：

- chat history 保存在 session 对应的 GeminiChat 中。
- 工具结果以 function response 形式回灌给模型。
- session resume 会重建 API history，并 replay UI 可观察事件。
- slash command 的结果可记录为 system/slash_command，不污染模型上下文。

---

## 6. Execution Flow（典型执行流程）

### Flow A：用户请求修改代码

1. 外部 Agent/UI 调用 `session/prompt`

```json
{
  "sessionId": "s1",
  "prompt": [
    {
      "type": "text",
      "text": "修复 packages/cli/src/acp-integration/acpAgent.ts 里的会话加载问题"
    }
  ]
}
```

2. qwen code 进入 Agent loop，模型决定先搜索/读取文件。

Capability：

- `content_search`
- `file_read`

ACP update：

```json
{
  "sessionUpdate": "tool_call",
  "kind": "read",
  "_meta": {
    "toolName": "read_file"
  }
}
```

3. 模型根据观察结果生成修改动作。

Capability：

- `file_edit` 或 `file_write`

若需要授权：

```json
{
  "method": "session/request_permission",
  "params": {
    "sessionId": "s1",
    "toolCall": {
      "toolCallId": "call-2",
      "kind": "edit",
      "rawInput": {
        "file_path": "/abs/path/acpAgent.ts"
      }
    },
    "options": []
  }
}
```

4. 用户授权后执行修改，ACP 暴露 diff。

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call-2",
  "status": "completed",
  "content": [
    {
      "type": "diff",
      "path": "/abs/path/acpAgent.ts",
      "oldText": "...",
      "newText": "..."
    }
  ]
}
```

5. 模型可能调用 `command_execute` 运行测试。

Capability：

- `command_execute`

6. 最终返回。

```json
{
  "stopReason": "end_turn"
}
```

### Flow B：复杂任务使用计划和多工具执行

1. 用户请求跨文件功能开发。
2. 模型调用 `todo_write`。
3. ACP 不展示普通 tool call，而是展示 plan。

```json
{
  "sessionUpdate": "plan",
  "entries": [
    {
      "content": "定位 ACP session 初始化逻辑",
      "priority": "medium",
      "status": "pending"
    },
    {
      "content": "修改能力声明",
      "priority": "medium",
      "status": "pending"
    },
    {
      "content": "补充测试",
      "priority": "medium",
      "status": "pending"
    }
  ]
}
```

4. 模型依次调用：

- `file_search`
- `file_read`
- `file_edit`
- `command_execute`

5. 每个工具调用通过 `tool_call` / `tool_call_update` 暴露。
6. 计划状态随 `todo_write` 更新。
7. 无新工具调用后，prompt turn 结束。

---

## 7. Limitations（能力约束）

- 非确定性：模型选择工具、执行顺序、生成内容均受模型推理影响。
- 权限依赖：edit、write、shell 等能力可能被 approval mode、PermissionManager 或 hooks 阻止。
- ACP client 能观察和授权 tool call，但通常不直接调用内部 core tools。
- streaming 是事件流式；最终 `session/prompt` response 只返回 stopReason。
- 文件能力有双路径：client 支持 ACP fs 时走 client fs，否则 fallback 到本地 FileSystemService。
- plan mode 会阻止修改类工具，除非通过 `exit_plan_mode` 退出。
- Agent tool 可并发运行；普通工具保持顺序执行以保留模型隐含依赖。
- shell 执行有安全判断，但仍具有环境副作用。
- MCP、web_fetch、LSP、cron 依赖外部配置或运行时能力。
- 错误以 `tool_call_update.status = "failed"`、content 文本、functionResponse error 或 JSON-RPC error 表达。
- cancel 会 abort 当前 prompt、工具调用和 cron 队列，但 agent 可能仍发送最后的 cleanup updates。

---

## 8. Minimal Example（最小示例）

### 1）一个 ACP capability 定义示例（JSON）

```json
{
  "name": "file_read",
  "description": "Read file content for model reasoning. Supports line ranges and selected document formats.",
  "transport": "model-tool",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "Absolute file path"
      },
      "offset": {
        "type": "integer",
        "description": "Zero-based start line"
      },
      "limit": {
        "type": "integer",
        "description": "Maximum number of lines"
      },
      "pages": {
        "type": "string",
        "description": "PDF page range, e.g. 1-5"
      }
    },
    "required": ["file_path"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "toolCallId": {
        "type": "string"
      },
      "status": {
        "enum": ["completed", "failed"]
      },
      "content": {
        "type": "array",
        "items": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "content"
                }
              }
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "diff"
                }
              }
            }
          ]
        }
      },
      "rawOutput": {},
      "_meta": {
        "type": "object",
        "properties": {
          "toolName": {
            "const": "read_file"
          }
        }
      }
    },
    "required": ["toolCallId", "status"]
  },
  "streaming": true,
  "sideEffects": false,
  "permission": "dynamic"
}
```

### 2）完整调用示例（request -> response）

#### Request: `session/prompt`

```json
{
  "sessionId": "s1",
  "prompt": [
    {
      "type": "text",
      "text": "读取 packages/cli/src/acp-integration/acpAgent.ts 并总结它暴露了哪些 ACP 能力"
    }
  ]
}
```

#### Streaming update: tool call start

```json
{
  "sessionId": "s1",
  "update": {
    "sessionUpdate": "tool_call",
    "toolCallId": "read_file-1710000000000",
    "status": "in_progress",
    "title": "ReadFile: packages/cli/src/acp-integration/acpAgent.ts",
    "kind": "read",
    "locations": [
      {
        "path": "/repo/packages/cli/src/acp-integration/acpAgent.ts",
        "line": null
      }
    ],
    "rawInput": {
      "file_path": "/repo/packages/cli/src/acp-integration/acpAgent.ts"
    },
    "_meta": {
      "toolName": "read_file"
    }
  }
}
```

#### Streaming update: tool call completed

```json
{
  "sessionId": "s1",
  "update": {
    "sessionUpdate": "tool_call_update",
    "toolCallId": "read_file-1710000000000",
    "status": "completed",
    "content": [
      {
        "type": "content",
        "content": {
          "type": "text",
          "text": "file content or summarized read result..."
        }
      }
    ],
    "_meta": {
      "toolName": "read_file"
    }
  }
}
```

#### Streaming update: agent response

```json
{
  "sessionId": "s1",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "content": {
      "type": "text",
      "text": "该文件实现 QwenAgent，初始化时声明 prompt、session、MCP、loadSession 等 ACP 能力..."
    }
  }
}
```

#### Final response: `session/prompt`

```json
{
  "stopReason": "end_turn"
}
```
