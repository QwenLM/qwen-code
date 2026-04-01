# Hooks

Run custom scripts at key points in the proto lifecycle — before tool calls, after edits, at session boundaries, and during agent team coordination.

This page covers how to configure hooks, the available hook types and events, and the input/output contract for each event.

## Configure a hook

Hooks are defined in `.proto/settings.json` (project) or `~/.proto/settings.json` (global). Each hook attaches to an event name and optionally filters by a matcher pattern.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/check-bash-safety.sh",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

### Hook types

| Type      | Purpose                                                       | Key fields                         |
| --------- | ------------------------------------------------------------- | ---------------------------------- |
| `command` | Run a shell script. Event JSON on stdin, decisions on stdout. | `command`, `env`, `timeout`        |
| `http`    | POST event JSON to a webhook URL.                             | `url`, `headers`, `allowedEnvVars` |
| `prompt`  | Ask an LLM to make a judgment call.                           | `prompt`, `model`                  |

#### Command hooks

```json
{
  "type": "command",
  "command": "/path/to/script.sh",
  "timeout": 30000,
  "env": { "CUSTOM_VAR": "value" }
}
```

#### HTTP hooks

```json
{
  "type": "http",
  "url": "https://hooks.example.com/proto",
  "headers": { "Authorization": "Bearer $API_TOKEN" },
  "allowedEnvVars": ["API_TOKEN"]
}
```

Only variables listed in `allowedEnvVars` are interpolated in `url` and `headers`. Other `$VAR` references resolve to empty string.

#### Prompt hooks

```json
{
  "type": "prompt",
  "prompt": "Is this safe? Event: $ARGUMENTS. Respond with JSON: {\"decision\": \"allow\"} or {\"decision\": \"deny\", \"reason\": \"why\"}",
  "model": "haiku"
}
```

`$ARGUMENTS` is replaced with the event JSON. Model options: `haiku` (default), `sonnet`, `opus`.

### Hook modifiers

**`async`** — Run the hook in the background without blocking. Output and decisions are ignored.

```json
{ "type": "command", "command": "log-to-slack.sh", "async": true }
```

**`if`** — Fine-grained filter using permission-rule syntax. Only fires when tool arguments match the pattern. Avoids spawning a hook process for non-matching calls.

```json
{
  "matcher": "bash",
  "hooks": [
    { "type": "command", "if": "Bash(git *)", "command": "check-git-policy.sh" }
  ]
}
```

Syntax: `ToolName(glob)` where the glob matches the tool's primary argument (`command` for Bash, `file_path` for Edit/Write, `pattern` for Grep). Valid only for tool events.

## Events reference

### Lifecycle events

| Event              | When it fires                            | Can block?           |
| ------------------ | ---------------------------------------- | -------------------- |
| `SessionStart`     | Session begins or resumes                | No                   |
| `SessionEnd`       | Session terminates                       | No                   |
| `PreCompact`       | Before context compaction                | No                   |
| `UserPromptSubmit` | User submits a prompt, before processing | Yes (exit 2)         |
| `Stop`             | Before the model concludes its response  | Yes (exit 2 or JSON) |

### Tool events

| Event                | When it fires           | Can block? | Matcher target    |
| -------------------- | ----------------------- | ---------- | ----------------- |
| `PreToolUse`         | Before tool executes    | Yes        | Tool name (regex) |
| `PostToolUse`        | After tool succeeds     | Limited    | Tool name (regex) |
| `PostToolUseFailure` | After tool fails        | Limited    | Tool name (regex) |
| `PermissionRequest`  | Permission dialog shown | Yes        | Tool name (regex) |

### Agent events

| Event           | When it fires     | Matcher target     |
| --------------- | ----------------- | ------------------ |
| `SubagentStart` | Subagent spawned  | Agent type (regex) |
| `SubagentStop`  | Subagent finishes | Agent type (regex) |

### Team events

| Event           | When it fires                  | Can block?                  |
| --------------- | ------------------------------ | --------------------------- |
| `TeammateIdle`  | Background agent becomes idle  | Yes (exit 2 sends feedback) |
| `TaskCreated`   | Task added to shared task list | No                          |
| `TaskCompleted` | Task marked as completed       | No                          |

### Notification events

| Event          | When it fires     | Matcher target                                           |
| -------------- | ----------------- | -------------------------------------------------------- |
| `Notification` | Notification sent | Type: `permission_prompt`, `idle_prompt`, `auth_success` |

## Input/output contract

### Common input fields (all events)

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "string",
  "timestamp": "ISO 8601 string"
}
```

### Exit codes (command hooks)

| Exit code | Meaning            | Behavior                                          |
| --------- | ------------------ | ------------------------------------------------- |
| `0`       | Success            | Parse stdout as JSON for decisions                |
| `1`       | Non-blocking error | Continue; stderr logged but not shown to model    |
| `2`       | Blocking error     | Block the action; stderr fed to model as feedback |

### JSON output format

```json
{
  "continue": true,
  "decision": "allow",
  "reason": "explanation",
  "hookSpecificOutput": {}
}
```

### Event-specific fields

#### PreToolUse

**Additional input:** `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`

**Output:** `hookSpecificOutput.permissionDecision` (`allow` | `deny` | `ask`), `hookSpecificOutput.permissionDecisionReason`, `hookSpecificOutput.updatedInput`

#### PostToolUse

**Additional input:** `permission_mode`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`

**Output:** `decision` (`allow` | `block`), `hookSpecificOutput.additionalContext`

#### PostToolUseFailure

**Additional input:** `permission_mode`, `tool_use_id`, `tool_name`, `tool_input`, `error`, `is_interrupt`

#### UserPromptSubmit

**Additional input:** `prompt`

**Output:** `decision` (`allow` | `block`), `hookSpecificOutput.additionalContext`

#### Stop

**Additional input:** `stop_hook_active`, `last_assistant_message`

**Output:** `decision` (`allow` | `block`), `reason`

When `stop_hook_active` is `true`, the hook has already triggered a continuation. Exit early to prevent infinite loops.

#### SessionStart

**Additional input:** `permission_mode`, `source` (`startup` | `resume` | `clear` | `compact`), `model`, `agent_type`

**Output:** `hookSpecificOutput.additionalContext` (injected into session context)

#### SessionEnd

**Additional input:** `reason` (`clear` | `logout` | `prompt_input_exit` | `other`)

#### SubagentStart / SubagentStop

**Additional input:** `permission_mode`, `agent_id`, `agent_type`

SubagentStop also includes: `stop_hook_active`, `agent_transcript_path`, `last_assistant_message`

#### PermissionRequest

**Additional input:** `permission_mode`, `tool_name`, `tool_input`, `permission_suggestions`

**Output:** `hookSpecificOutput.decision.behavior` (`allow` | `deny`), `hookSpecificOutput.decision.updatedInput`, `hookSpecificOutput.decision.message`

#### PreCompact

**Additional input:** `trigger` (`manual` | `auto`), `custom_instructions`

#### TeammateIdle

**Additional input:** `agent_id`, `agent_name`, `result_summary`, `success`

#### TaskCreated

**Additional input:** `task_id`, `task_title`, `task_description`, `created_by`

#### TaskCompleted

**Additional input:** `task_id`, `task_title`, `completed_by`, `output`

## Matcher patterns

Matchers are regex patterns that filter which occurrences of an event trigger a hook.

| Event type             | Matches on      | Example                            |
| ---------------------- | --------------- | ---------------------------------- |
| Tool events            | Tool name       | `^bash$`, `read.*`, `(bash\|edit)` |
| Subagent events        | Agent type      | `^Explore$`, `coordinator`         |
| SessionStart           | Source          | `^(startup\|resume)$`              |
| SessionEnd             | Reason          | `^clear$`                          |
| Notification           | Type (exact)    | `permission_prompt`                |
| PreCompact             | Trigger (exact) | `manual`                           |
| UserPromptSubmit, Stop | Not supported   | Always fires                       |

Empty string `""` or `"*"` matches all.

## Execution model

- Hooks run **in parallel** by default. Use `sequential: true` on a hook definition to enforce order.
- When multiple hooks return conflicting decisions, the **most restrictive wins**: `deny` > `ask` > `allow`.
- Project hooks require trusted folder status.
- Default timeout: 60 seconds.
- Max output: 1 MB per hook.

## SDK hook callbacks

When using the [TypeScript SDK](../reference/sdk-api.md), register hook callbacks directly in code instead of writing shell scripts or HTTP endpoints. The SDK registers callbacks with the CLI during initialization and invokes them when hook events fire.

```typescript
import { query, type HookCallback } from '@qwen-code/sdk';

const auditLogger: HookCallback = async (input, toolUseId) => {
  const data = input as { tool_name?: string };
  console.log(`[audit] ${data.tool_name} (${toolUseId})`);
  return {};
};

const securityGate: HookCallback = async (input) => {
  const data = input as {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
  };
  if (data.tool_name === 'Bash') {
    const cmd = String(data.tool_input?.command ?? '');
    if (cmd.includes('rm -rf') || cmd.includes('sudo')) {
      return { shouldSkip: true, message: 'Blocked: destructive command' };
    }
  }
  return {};
};

const conversation = query({
  prompt: 'Refactor the auth module',
  options: {
    hookCallbacks: {
      PreToolUse: [auditLogger, securityGate],
      PostToolUse: async (input) => {
        const data = input as { tool_output?: string };
        if (data.tool_output?.includes('FATAL')) {
          return { shouldInterrupt: true, message: 'Fatal error detected' };
        }
        return {};
      },
    },
  },
});
```

### Callback return values

| Field             | Type      | Effect                                                          |
| ----------------- | --------- | --------------------------------------------------------------- |
| `shouldSkip`      | `boolean` | Skip this tool call entirely. Only meaningful for `PreToolUse`. |
| `shouldInterrupt` | `boolean` | Stop the agent immediately.                                     |
| `suppressOutput`  | `boolean` | Suppress the tool's output from the conversation.               |
| `message`         | `string`  | Feedback string sent to the agent.                              |

Returning `{}` lets the tool proceed normally.

### Supported SDK events

| Event          | When it fires                   |
| -------------- | ------------------------------- |
| `PreToolUse`   | Before a tool executes          |
| `PostToolUse`  | After a tool returns its result |
| `Stop`         | When the agent is about to stop |
| `Notification` | On agent notifications          |
| `SubagentStop` | When a subagent finishes        |

When multiple callbacks are registered for one event (as an array), they execute in order. The first `shouldSkip` or `shouldInterrupt` result short-circuits the rest.

See the [SDK hooks examples](../../developers/examples/sdk-hooks.md) for more patterns.

## Environment variables

Command hooks inherit `process.env` plus:

```
GEMINI_PROJECT_DIR  — project root
CLAUDE_PROJECT_DIR  — same (compatibility alias)
QWEN_PROJECT_DIR    — same (compatibility alias)
```

Custom variables can be added via the `env` field on command hooks.
