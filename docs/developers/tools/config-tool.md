# Config Tool (`config`)

This document describes the `config` tool for Qwen Code.

## Description

Use `config` to read or write Qwen Code configuration settings during a conversation. This tool allows the AI agent to help users inspect and adjust settings without leaving the chat.

### Arguments

`config` takes the following arguments:

- `action` (string, required): Either `"get"` to read a setting or `"set"` to write a setting.
- `setting` (string, required): The name of the configuration setting. Only settings in the supported allowlist are accepted.
- `value` (string, optional): The new value for the setting. Required when `action` is `"set"`.

## How to use `config` with Qwen Code

The tool is available to the AI agent as part of the core toolset. Users interact with it through natural language — for example, asking "what model am I using?" or "switch to qwen-max".

### Read (GET)

Reading a setting does not require user confirmation.

```
config(action="get", setting="model")
→ model = qwen3-coder-plus
  Available models:
    - qwen3-coder (Qwen3 Coder)
    - qwen3-coder-plus (Qwen3 Coder Plus)
    - ...
```

### Write (SET)

Writing a setting requires explicit user confirmation via the tool confirmation dialog.

```
config(action="set", setting="model", value="qwen-max")
→ Confirmation dialog: Change model from 'qwen3-coder-plus' to 'qwen-max'
→ model changed from 'qwen3-coder-plus' to 'qwen-max'
```

## Supported Settings

| Setting             | Type    | Source  | Writable | Description                                                                                                             |
| ------------------- | ------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `model`             | string  | project | Yes      | The active LLM model ID. GET returns the current model and available options. SET switches the model for this session.  |
| `approvalMode`      | string  | project | No       | Tool call approval mode. Options: plan, default, auto-edit, yolo. Read-only — see "Why only `model` is writable" below. |
| `checkpointing`     | boolean | global  | No       | Whether file checkpointing (code rewind) is enabled (read-only).                                                        |
| `respectGitIgnore`  | boolean | project | No       | Whether to respect .gitignore when discovering files (read-only).                                                       |
| `enableFuzzySearch` | boolean | project | No       | Whether fuzzy file search is enabled (read-only).                                                                       |
| `debugMode`         | boolean | global  | No       | Whether debug mode is enabled (read-only).                                                                              |
| `targetDir`         | string  | project | No       | The project root directory (read-only).                                                                                 |
| `outputFormat`      | string  | global  | No       | The output format: text, json, or stream-json (read-only).                                                              |

### Why only `model` is writable

The allowlist exposes many settings for `GET` (so the agent can introspect its environment), but only one for `SET`:

- **`approvalMode`**: Never writable by the agent. Allowing the agent to escalate its own permission level — even with an `ask` confirmation — is a prompt injection risk. A compromised instruction could pressure a fatigued user into approving a `SET approvalMode yolo` call. Users must change approval mode through a slash command or settings file.
- **`checkpointing` / `respectGitIgnore` / `enableFuzzySearch`**: These are user preferences, not task-scoped behaviors. There is no clear agent-driven use case for toggling them mid-conversation. Task-scoped changes should be expressed through sub-agents or skill-level overrides (e.g., a skill that needs a different model can declare it in its frontmatter — see #2949).
- **`debugMode` / `targetDir` / `outputFormat`**: Always read-only. These reflect how the CLI was started; changing them at runtime would be meaningless.

Only `model` has a legitimate agent-driven write use case: a multi-stage task may want to switch the session default model durably (rather than just override a single call). Every other behavior change is better handled by other mechanisms.

## Permission Model

- **GET operations**: Automatically allowed without user confirmation.
- **SET operations**: Always require user confirmation. The confirmation dialog displays the current and proposed values.
- The "Always Allow" option is intentionally hidden for ConfigTool to ensure users review each change.

## Error Handling

The tool returns descriptive error messages for common failure scenarios:

- Unknown setting name → lists available settings
- Missing value on SET → reminds that value is required
- Write to read-only setting → indicates the setting is read-only
- Backend write failure → forwards the error message from the config layer

## Important Notes

- **Allowlist only**: The tool can only access settings registered in the allowlist (`supported-config-settings.ts`). Attempting to read or write any other setting will return an error.
- **Type coercion**: The `coerceValue` helper supports `string`, `boolean`, and `number`. Only `string` is exercised today (via `model`), but boolean/number coercion stays in place for future writable settings.
- **Options validation**: Settings that declare `options` or `getOptions` validate the value before writing. For `model`, the list comes from `config.getAvailableModels()`.
- **Structured output**: All responses are JSON objects with `success`, `operation`, `setting`, `source`, `value`/`previousValue`/`newValue`, `options`, and `error` fields.
- **Session scope**: Model changes via SET take effect for the current session. Persistent changes are written through the Config object.
- **Security**: All key lookups use `Object.hasOwn()` to prevent prototype pollution attacks.
