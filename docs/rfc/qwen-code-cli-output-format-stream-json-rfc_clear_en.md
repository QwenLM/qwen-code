# RFC: Qwen-Code CLI Structured Input/Output Specification (Clean Version)

## Overview

| Field | Details |
| --- | --- |
| Status | Draft |
| Last Updated | 2025-10-13 |
| Author | x22x22 |
| Tracking | <https://github.com/QwenLM/qwen-code/issues/795> |
| Scope | CLI-level `--input-format/--output-format` structured protocol, event semantics, error specification, and rollout plan |

- Aims to provide third-party systems and multi-language Agent SDKs with stable, programmable IPC Stream JSON capabilities.
- Keeps protocol behavior aligned with the TUI, adds JSON Lines output, symmetric input, and control channels to address community requests for `--input-format/--output-format json/stream-json`.
- The document focuses on CLI capabilities and does not cover SDK internals.

## Background and Scenarios

### Issue 795 Overview
- Community issue [#795](https://github.com/QwenLM/qwen-code/issues/795) requests `--input-format/--output-format json/stream-json`, aiming to mirror the Claude Code implementation so downstream programs can reliably consume structured IO.
- This RFC expands the CLI while staying compatible with existing TUI behavior, giving SDKs and backends symmetric JSON protocols and message semantics.

### Integration Scenarios
- **Task-level staged handling**: SDK submits prompts one by one, receives multiple partial results, post-processes them, and finally presents them to end users.
- **Task-level streaming**: SDK submits prompts and streams the CLI’s response directly to users for real-time visibility.
- **Instruction shortcuts**: Third-party input boxes must support `/`, `@`, and `?` triggers with behavior identical to the TUI to guarantee a consistent UX.
- **Terminal simulation**: Frontends such as xterm.js mimic terminal output while separating the input field from the display, yet still need full terminal semantics from the CLI.

### Integration Approach
- Third parties will rely on forthcoming multi-language `qwen-code-agent-sdk` packages.
- The SDK spawns `qwen code` as a subprocess and uses STDIN/STDOUT for bidirectional IPC.
- SDKs read the CLI’s structured output and handle errors and state transitions.
- Upper-layer applications consume the SDK’s results and render them in their own UI or services.

### Current Pain Points
- The CLI currently emits human-oriented text, making structured consumption brittle.
- There is no symmetric structured input protocol, preventing higher-level automation and tool orchestration.

## Goals and Scope

| Type | Content |
| --- | --- |
| Design Goals | Configurable output formats, JSON Lines streaming protocol, symmetric structured input, common schemas, SDK-friendly |
| Non-Goals | Describing concrete SDK implementations (see the Agent Framework document) |
| Core Pain Points | Only human-readable STDOUT, lack of structured input, cannot drive automation |
| Scenario Examples | SDK sending prompts in batches and handling multi-segment responses; streaming directly to users; `/`, `@`, `?` commands matching TUI behavior; xterm.js frontends splitting input from terminal display |

## Interface Overview

| Category | Key Items | Description |
| --- | --- | --- |
| CLI Parameters | `--input-format`, `--output-format` | Values: `text` / `stream-json` / `stream-chunk-json`; structured modes automatically disable the TUI |
| Output Events | `chat.completion*`, `result/*`, `control_request` | Written to STDOUT line by line as JSON Lines |
| Input Events | `*request`, `control_response`, Qwen Chat Request | Written to STDIN as JSON Lines to drive CLI behavior symmetrically |
| Channel Semantics | Result events, request events, control channel | Clarify acknowledgment requirements to prevent CLI blocking |
| Protocol Extensions | Handshake metadata, version negotiation, error semantics | Remain compatible extensions to OpenAI `/chat/completions` |

- Communication still uses standard input and output; no extra sockets are introduced.
- `text` mode preserves the original behavior, while structured modes provide stable schemas and observability fields.

## Output Format Semantics

| Format | Applicable Scenarios | Behavior Summary | Compatibility |
| --- | --- | --- | --- |
| `text` | Human-interactive compatibility mode | Outputs the original TUI text | Default mode, to be marked for manual use later |
| `stream-json` | Message-level JSONL | Each line is a `chat.completion`, including initialization receipts, assistant replies, tool invocations, and closing summaries | Aligns with OpenAI `/chat/completions` |
| `stream-chunk-json` | Incremental chunk JSONL | Each line is a `chat.completion.chunk`, with `choices[].delta` carrying token/block increments | Aligns with OpenAI streaming responses, with full session IDs |

### Consumption Strategy

- **Message-level JSONL (`stream-json`)**: Suited to third-party backends or CLI wrappers that process results in stages; compatible with existing JSONL pipelines and considered the default structured mode.
- **Incremental chunks (`stream-chunk-json`)**: Targets IDE/UI scenarios that need “display as it streams”; SDKs should watch for `chat.completion.chunk` events and finalize once the terminal `finish_reason` arrives.
- **Terminal semantics parity**: Regardless of whether the CLI runs in text or structured mode, `stream-json` / `stream-chunk-json` must cover every semantic emitted by the TUI (text, ANSI/Vt100 control codes, tool hints, exit codes, etc.) using `choices[].message.content` / `choices[].delta.content` plus `choices[].delta.annotations` (e.g. `{"type":"x-qwen-ansi","value":"\u001b[32m"}`) so frontends like xterm.js can faithfully reproduce the terminal experience.

### `stream-json` Example

```json
{"object":"chat.completion","id":"chatcmpl-session-123","created":1739430000,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","content":"Analyzing...","tool_calls":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}}
{"object":"chat.completion","id":"chatcmpl-session-123","created":1739430002,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"tool-1","type":"function","function":{"name":"edit_file","arguments":"..."}}]},"finish_reason":"tool_calls"}]}
{"object":"chat.completion","id":"chatcmpl-session-123","created":1739430010,"model":"qwen-coder","choices":[{"index":0,"message":{"role":"assistant","content":"Fix completed; the file has been updated."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1600,"completion_tokens":200,"total_tokens":1800}}
```

### `stream-chunk-json` Behavior Highlights

- First line sends `{"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}` to declare the role.
- Outputs text tokens, tool call increments, and `tool_calls` updates as needed.
- Final line includes `{"choices":[{"delta":{},"finish_reason":"stop"}]}` and attaches a summary in `usage` or `metadata`.
- Optional `annotations` and `spans` fields describe terminal styling (see below).

## Event Payloads and Annotations

`packages/cli/src/nonInteractiveCli.ts` and `packages/cli/src/ui/utils/ConsolePatcher.ts` jointly decide how text-mode output is produced: model content is appended to `stdout` via `GeminiEventType.Content`, tool execution state and logs are printed to `stderr` through `ConsolePatcher`, and tool result structures (`ToolResultDisplay`, etc.) are rendered by `packages/cli/src/ui/hooks/useReactToolScheduler.ts`. To ensure `stream-json` / `stream-chunk-json` covers every semantic, we reuse the OpenAI `annotations` field with the following conventions:

| Type | Key Fields | Purpose |
| --- | --- | --- |
| `chat.completion.chunk` annotation | `annotations`, `spans` | Reproduce terminal styling, ANSI control codes, and origin labels |
| `x-qwen-terminal` | `channel`, `source`, `console_level`, `ansi` | Output terminal streams (stdout/stderr/console/system) |
| `x-qwen-tool-display` | `tool_call_id`, `status`, `result_display` | Present tool diffs, strings, TODOs, plan summaries, task execution, etc. |
| `x-qwen-thought` | `subject`, `description` | Show thinking prompts (GeminiEventType.Thought) |
| `x-qwen-session-event` | `event`, `message`, `metrics` | Session-level notifications such as compression, cancellation, and token limits |

### Terminal Annotation Structure

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

- `channel`: `stdout` / `stderr`; console logs use `ConsolePatcher` to inject `stderr` with `console_level`.
- `source`: `assistant`, `tool`, `console`, `system`, enabling layered display on the frontend.
- `spans.style.theme_token`: Reuse CLI themes (`AccentGreen`, `DiffAdded`, etc.).
- `ansi`: Positions of raw ANSI sequences for frontends to replay.
- `console_level`: When `source=console`, takes values `log`, `warn`, `error`, `info`, or `debug` so that downstream consumers can mirror `ConsolePatcher` behavior.
- `exit_code`: Provided when `source=system` and the flow finishes.
- `prompt_id`: Associates the record with a specific turn.

### Tool Result Display

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

- `status` follows `ToolCallStatus` (`Pending`, `Executing`, `Success`, `Error`, `Canceled`, `Confirming`).
- `tool_call_id` reuses the OpenAI schema field; together with `session_id` it uniquely locates a call, and can be reused even in test/non-session modes.
- `result_display` supports unions such as `string`, `file_diff`, `todo_list`, `plan_summary`, and `task_execution`.
- `confirmation` serializes the relevant `ToolCallConfirmationDetails` (diffs, commands, MCP payloads) so third parties can surface approval dialogs.
- `pending=true` indicates the call is still validating/queued and matches `ToolCallStatus.Pending`.
- `timestamp` is used for ordering and matches records from `useReactToolScheduler`.

### Thought and Session Events

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

- `event` values derive from `GeminiEventType`, including `Finished`, `ChatCompressed`, `MaxSessionTurns`, `USER_CANCELLED`, etc.
- `metrics` optionally provide statistics such as tokens before and after compression.

## Input Format (Qwen Session Protocol)

| Mode | Behavior | Notes |
| --- | --- | --- |
| `text` | Preserve original TUI text input | Parse natural language or command-line text |
| `stream-json` / `stream-chunk-json` | Use Qwen Chat Request | Each JSON line describes one incremental input |

### Qwen Chat Request Mode

```jsonc
{
  "session_id": "session-123",
  "prompt_id": "session-123########7",
  "model": "qwen-coder",
  "input": {
    "origin": "user",
    "parts": [
      {"type": "text", "text": "Please fix the bug in @main.py"}
    ],
    "command": null
  },
  "options": {
    "temperature": 0.2,
    "tool_overrides": ["EditTool"]
  }
}
```

- `session_id`: Session identifier (`config.getSessionId()`); pass `"_new"` to create a new session.
- `prompt_id`: Distinguishes turns; default format `<session_id>########<turn>`, and must be reused when tools continue the conversation.
- `input.origin`: `user` / `tool_response` / `system`, determining how the session continues.
- `input.parts`: Compatible with `@google/genai` PartListUnion, allowing `text`, `function_response`, `file_data`, etc. When `origin="user"`, the CLI concatenates all text parts in order and reuses the same semantics as `prepareQueryForGemini`.
- `options`: Per-request overrides (model, sampling, tool allowlist).
- Extended fields:
  - `tool_call_id`: Required when `origin=tool_response` to match output events.
  - `continuation`: Boolean equivalent to `submitQuery(...,{isContinuation:true})`; if omitted, the CLI infers continuation based on `origin` and command context.
  - `tool_request`: Mirrors `ToolCallRequestInfo` to support concurrent tools and sub-agents.

### Session Control

- Third parties may invoke the CLI’s “create session” command or reuse an existing ID; when `session_id` is missing or set to `"_new"`, the CLI returns the actual ID in the first `chat.completion`.
- `prompt_id` and `tool_call_id` together isolate concurrent flows; reuse them for tool continuations. The default format is `<session_id>########<turn>`, but any unique identifier is acceptable.
- Sending `input.origin="system"` with parts such as `{"type":"instruction","text":"/clear"}` triggers slash commands exactly as in the TUI.
- When `origin="tool_response"`, `tool_call_id` is mandatory so the CLI can attach results to the correct turn before proceeding.

### Commands and `@` References

| Mode | Trigger Method | Behavior |
| --- | --- | --- |
| Implicit Parsing | `origin="user"` with text starting with `/`/`?`/`@` | CLI automatically follows the slash/at flow, invoking logic such as `handleAtCommand` |
| Explicit Declaration | Describe the command in `input.command` | Recommended for third parties to avoid string parsing ambiguities |

- `command.kind`: `slash` / `at`, matching the TUI command taxonomy.
- `command.path`: For slash commands, represents the hierarchical command array (mirrors `commandPath`); omit for `at`.
- `command.args`: Remaining argument string that the CLI will parse exactly as in TUI mode.
- `command.references`: When `kind="at"`, can directly provide resolved references such as `{ "original":"@src/main.ts", "resolved":"src/main.ts" }`; if omitted, the CLI falls back to `handleAtCommand` and `useAtCompletion` for automatic resolution.

Explicit command example:

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

- CLI outputs the corresponding `result/command`:

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
    "content": "The current session has 3 history records."
  }
}
```

- `command.result.type` supports enums such as `message`, `dialog`, `tool`, and `submit_prompt` for easier UI rendering.
- If the command triggers a model call, subsequent output includes `assistant`, `tool_call`, and `result/*` events, following the same order as the TUI.

Explicit `@` reference example:

```jsonc
{
  "session_id": "session-123",
  "input": {
    "origin": "user",
    "parts": [{"type": "text", "text": "Please review @src/main.py"}],
    "command": {
      "kind": "at",
      "references": [
        {"original": "@src/main.py", "resolved": "src/main.py"}
      ]
    }
  }
}
```

- The CLI uses the explicit `references` to read files; if missing, it falls back to automatic parsing, preserving TUI tolerance for partial paths.

### SDK-Side Command Coordination

| `command.result.type` | Description | SDK Guidance |
| --- | --- | --- |
| `handled` | Command completed fully inside the CLI | No extra action |
| `message` | Informational or error message | Display a notification in the UI |
| `dialog` (`auth`/`theme`/`editor`/`privacy`/`settings`/`model`/`subagent_create`/`subagent_list`/`help`) | Requires dialogs or navigation | Present the appropriate UI panel |
| `tool` | Triggers a tool call | Convert `tool_request` or command args into a tool request and monitor results |
| `submit_prompt` | Immediately sends a PartListUnion to the model | Submit `content` as the next input with `continuation=true` |
| `load_history` | Reset or load specified session history | Refresh or reload history views |
| `quit` / `quit_confirmation` | Exit flow or await user confirmation | Control the host app lifecycle and return confirmation |
| `confirm_shell_commands` | Shell commands awaiting approval | Show an approval dialog; resend with `approvedCommands` / `confirmationOutcome` once approved |
| `confirm_action` | General confirmation prompt | Provide confirmation UI and return the outcome |

- SDKs should expose a unified command API that maps user input to the structure above and drives local UI or follow-up requests based on the resulting action.
- When commands kick off further model interactions (e.g., `/submit`, expanded `@file`), the CLI keeps streaming `assistant`, `tool_call`, and `result/*` events in the same order as the TUI, letting third parties replicate the interaction with pure text input plus JSON output.

### STDIN Command Acknowledgement

- With `--input-format=stream-json`, the CLI must still acknowledge `/`, `?`, and `@` commands immediately, reusing `useSlashCommandProcessor` and `handleAtCommand`.
- After parsing, the CLI emits structured responses such as:

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
    "content": "The current session has 3 history records."
  }
}
```

- The `result` field matches the `command.result.type` table above for consistent UI handling.
- If commands lead to continued interaction, the CLI streams the rest of the turn with matching session fields.
CLI outputs the corresponding `result/command`:

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
    "content": "The current session has 3 history records."
  }
}
```

- `command.result.type` supports enums such as `message`, `dialog`, `tool`, and `submit_prompt` for easier UI rendering.
- If the command triggers a model call, subsequent output includes `assistant`, `tool_call`, and `result/*` events, following the same order as the TUI.

## Real-Time Suggestions, Heartbeats, and Interrupts

| Capability | Request | Response | Notes |
| --- | --- | --- | --- |
| Command Suggestions | `command_hint_request` | `result/command_hint` | Triggered by characters; `trigger` supports `slash`, `at`; `status` can be `ok` / `loading` / `error` |
| Heartbeat | `heartbeat_request` | `result/heartbeat` | Periodic keepalive; the CLI may proactively push the same event |
| Interrupt/Cancel | `control/cancel` | `result/cancel` + `control_response` | Simulates ESC; `reason` is currently fixed at `escape` |

### Suggestion Request Example (`/c`)

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

### Suggestion Response Example

```jsonc
{
  "type": "result/command_hint",
  "session_id": "session-123",
  "prompt_id": "session-123########preview",
  "trigger": "slash",
  "status": "ok",
  "suggestions": [
    {"label": "chat", "value": "chat", "description": "Manage conversation history."},
    {"label": "clear", "value": "clear", "description": "Clear the screen and conversation history."},
    {"label": "compress", "value": "compress", "description": "Compresses the context by replacing it with a summary."},
    {"label": "copy", "value": "copy", "description": "Copy the last result or code snippet to clipboard."},
    {"label": "corgi", "value": "corgi", "description": "Toggles corgi mode."}
  ],
  "metadata": {
    "is_perfect_match": false
  }
}
```

### Suggestion Request Example (`@src/co`)

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

### Suggestion Response Example (`@src/co`)

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

### Suggestion Request Example (`/?`)

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

### Suggestion Response Example (`/?`)

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
      "description": "For help on Qwen Code.",
      "matchedIndex": 0
    }
  ],
  "metadata": {
    "is_perfect_match": true
  }
}
```

- `suggestions` reuse the TUI `Suggestion` structure; `status="loading"` indicates the CLI is preparing data (for example while `useAtCompletion` builds the file index), and `error` responses include a message.
- The CLI reuses `useSlashCompletion` and `useAtCompletion` to generate hints; these requests never touch `GeminiChat` nor session history, and `prompt_id` may carry a `_preview` suffix that is echoed back.
- Triggers can fire repeatedly as the text or cursor changes; send `{"type":"command_hint_cancel", ...}` to stop long-running lookups.

### Heartbeat Request and Response

```jsonc
{"type":"heartbeat_request","session_id":"session-123"}
{"type":"result/heartbeat","session_id":"session-123","status":"ok","ts":1739430123}
```

- Third parties can configure timeouts (e.g., 10 seconds) to detect CLI hangs and restart the process.
- The CLI responds with the same `result/heartbeat` shape and may proactively push keepalive events in the background.
- `@third-party/anthropics/claude-agent-sdk-python` currently lacks a heartbeat implementation; the P1.1 rollout must define default intervals, timeout policy, and whether SDKs can customize the heartbeat cadence.

### Interrupt Example

```jsonc
{
  "type": "control/cancel",
  "session_id": "session-123",
  "prompt_id": "session-123########8",
  "reason": "escape"
}
```

- The CLI must call `cancelOngoingRequest`, abort the `AbortController`, finalize history items, and emit `result/cancel`.
- If no request can be canceled, the CLI should return `{"type":"result/cancel","status":"noop"}` with an explanation.
- When the underlying stream reports `GeminiEventType.UserCancelled`, the CLI also emits `{"type":"x-qwen-session-event","event":"USER_CANCELLED","message":"User cancelled the request."}` so clients can update the session state.
- Double-tapping ESC to clear the input is handled on the client side; structured integrations can replicate that locally without sending additional CLI messages.

## Event Categories and Channels

| Category | Direction | Representative Events | Acknowledgment Requirement | Purpose |
| --- | --- | --- | --- | --- |
| Result Events | CLI → STDOUT | `result/command`, `result/command_hint`, `result/heartbeat`, `result/cancel`, `x-qwen-session-event` | No acknowledgment required | Publish command output, status tips, heartbeat results |
| Request Events | SDK/Third Party → STDIN | `command_hint_request`, `heartbeat_request`, `control/cancel` | CLI returns the corresponding `result/*` | Trigger immediate actions or controls |
| Control Channel | CLI ↔ STDIN/STDOUT | `control_request` / `control_response` | Must match `request_id` | Permission approvals, hook callbacks, MCP calls |

These categories can also be viewed as three event mechanisms:

1. **Result events (`result/*`)**  
   - CLI → STDOUT one-way announcements such as `result/command`, `result/command_hint`, `result/heartbeat`, `result/cancel`, `x-qwen-session-event`.  
   - Carry command output, hints, heartbeat results, and session state updates. No acknowledgment is required.

2. **Request events (`*request`)**  
   - SDK/third party → STDIN directives like `command_hint_request`, `heartbeat_request`, or `control/cancel`.  
   - Trigger immediate CLI behavior, and each request must be answered with the corresponding `result/*`.

3. **Control channel events (`control_request` / `control_response`)**  
   - CLI outputs `control_request`, external integrations respond with matching `control_response`; used for approvals, hook callbacks, MCP JSON-RPC, etc.  
   - Each carries a unique `request_id`, requires timely responses, and bypasses conversation history to stay in sync with TUI behavior.

- All events travel over a unified JSON Lines protocol; route them by `type`/`subtype`.  
- Control channel participants must implement timeout and error fallback strategies to avoid blocking the CLI.

## Control Requests and Responses

| Field | Description |
| --- | --- |
| `type` | Always `control_request` or `control_response` |
| `request_id` | Unique identifier pairing requests with responses |
| `subtype` | `can_use_tool`, `hook_callback`, `mcp_message`, etc. |
| `payload` / `response` | Carries event details or acknowledgment content |

- `control_request` example:

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

- Corresponding `control_response`:

```jsonc
{
  "type": "control_response",
  "request_id": "req-1",
  "response": {
    "subtype": "success",
    "result": {
      "behavior": "approve",
      "message": "Allowed to execute."
    }
  }
}
```

- If a callback fails, the SDK must return `{"subtype":"error","error":{"message":"...","retryable":false}}`, and the CLI will follow the safety fallback (auto-deny or report failure).
- MCP integration: `subtype:"mcp_message"` carries JSON-RPC (`tools/list`, `tools/call`, etc.), and the SDK wraps results as `mcp_response` inside `control_response`.
- Current state: the CLI primarily emits one-way output while the TUI handles confirmations inline, so dual-channel hooks similar to Claude Code still need to be generalized.
- Design requirement: whenever the CLI needs external confirmation, it should emit a `control_request` and wait for the matching `control_response`, covering tool approvals, hook callbacks, and MCP JSON-RPC exchanges.
- Coverage examples: `/confirm_shell_commands`, `confirm_action`, `quit_confirmation`, tool permission approvals, sub-agent orchestration, and future dialogs/forms/identity flows.
- Fallback policy: if the control channel is disabled, the CLI must explicitly reject risky actions or state “unavailable in structured mode” via `result/command` instead of failing silently.
- Follow-up tasks: (1) add JSON Schemas for `control_request` / `control_response`; (2) build a unified dispatcher so the TUI and CLI share the same logic; (3) extend SDKs with listeners/hooks that surface the requests to upper-layer UIs.

## Version Negotiation and Error Semantics

| Item | Description |
| --- | --- |
| Protocol Version | The first `chat.completion` includes `protocol_version`, `input_format`, `output_format`, and `capabilities` in `metadata` / `system_fingerprint` |
| Version Mismatch | If the SDK requests unsupported features, the CLI returns `finish_reason="error"`, marks `unsupported_protocol` in `metadata.error`, and exits with a non-zero code |
| Fatal Errors | Emit OpenAI-style error objects and terminate |
| Recoverable Errors | Return error details via `chat.completion` with `finish_reason` `stop/tool_calls` while keeping the process healthy |
| Control Protocol Errors | Attach details in `metadata.control_errors` so the SDK can decide whether to retry or terminate |

Fatal error example:

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

## Security and Resource Control

| Domain | Policy |
| --- | --- |
| Permissions | Structured mode still honors existing CLI approval and tool allowlists; high-risk actions default to denial without acknowledgement |
| Audit | Control channel lets the SDK audit sensitive operations beforehand; if disabled, `result/command` must state the limitation explicitly |
| Keepalive | `heartbeat` events can trigger process recycling to avoid resource leaks |

## Logging Layers and Observability

| Component | Highlights |
| --- | --- |
| ConsolePatcher | Intercepts `console.*`, records `channel="stderr"` and `console_level` within `x-qwen-terminal` |
| `log_scope` extension | Recommend attaching `log_scope` (`system`, `tool`, `debug`) to annotations in structured mode to align with `ConfigLogger` levels |
| Tool Logs | Output via `ToolResultDisplay`; `result_display` can carry `log_scope` for filtering |
| OTel Plan | SDK and CLI each integrate OpenTelemetry to chain traces and spans |

- Third parties are advised to store the full message sequence in audit logs for replay.

## Debugging Examples

```bash
echo '{"model":"qwen-coder","messages":[{"role":"user","content":"Hello"}]}' \
  | qwen --input-format stream-json --output-format stream-json

echo '{"model":"qwen-coder","messages":[{"role":"user","content":"Output the greeting character by character."}]}' \
  | qwen --input-format stream-json --output-format stream-chunk-json
```

- Use these commands to quickly verify output formats and event flows.
