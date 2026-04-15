# ConfigTool Design

> Enables the AI agent to programmatically read and write Qwen Code configuration settings during a conversation, with user confirmation for write operations.

## Problem

Users who want to adjust Qwen Code settings (e.g., switch models) during a conversation must manually edit `settings.json` or restart the CLI with different flags. The AI agent cannot help with configuration changes, even when the user explicitly asks for it. This creates friction, especially for users unfamiliar with the configuration file format.

## Solution

Introduce a `ConfigTool` that the AI agent can invoke to read and write a curated allowlist of configuration settings. Read operations are auto-approved; write operations require explicit user confirmation before taking effect.

## Architecture

```
User: "Switch to qwen-max"
        │
        ▼
┌───────────────────┐
│  AI Agent decides  │
│  to call ConfigTool│
│  SET model=qwen-max│
└────────┬──────────┘
         │
         ▼
┌───────────────────────┐
│  ConfigTool            │
│  1. Validate setting   │──── Unknown setting? → Error
│     is in allowlist    │
│  2. Validate params    │──── Missing value? → Error
│  3. Coerce type        │──── Type mismatch? → Error
└────────┬──────────────┘
         │
         ▼
┌───────────────────────┐
│  Permission check      │
│  GET → auto-allow      │
│  SET → ask user        │──── User denies? → Reject
└────────┬──────────────┘
         │ User approves
         ▼
┌───────────────────────┐
│  Pre-write validation  │
│  1. Check options      │──── Invalid option? → Error
│  2. validateOnWrite()  │──── Validation fail? → Error
└────────┬──────────────┘
         │
         ▼
┌───────────────────────┐
│  Execute               │
│  - Read/write via      │
│    Config object       │
│  - Return structured   │
│    JSON result         │
└───────────────────────┘
```

## Security Design

### Allowlist-based Access Control

Only settings explicitly registered in `supported-config-settings.ts` are accessible. This is the primary security boundary. The allowlist pattern ensures:

- The agent cannot access arbitrary configuration keys
- New settings require an explicit code change to expose
- Each setting declares whether it is writable or read-only

### Prototype Pollution Prevention

All key lookups use `Object.hasOwn()` instead of the `in` operator or direct property access to prevent prototype pollution attacks (e.g., `__proto__`, `constructor`).

### Write Confirmation

All SET operations go through the tool confirmation flow, requiring explicit user approval. The confirmation dialog shows the current value and the proposed new value, so the user can make an informed decision.

### Input Validation

- The `setting` parameter is validated against the allowlist before any operation
- The `value` parameter is required for SET operations and must be a non-empty string
- Read-only settings reject write attempts at the validation layer
- Type coercion: string values from the LLM are coerced to the target type (`boolean`, `number`, `string`) with clear error messages on mismatch
- Options check: if a setting declares `options` or `getOptions`, the value is validated against the allowed list before writing
- Async validation: if a setting declares `validateOnWrite`, the callback is invoked before the actual write

## Supported Settings

| Setting             | Type    | Source  | Writable | Description                                           |
| ------------------- | ------- | ------- | -------- | ----------------------------------------------------- |
| `model`             | string  | project | Yes      | The active LLM model ID for the current session       |
| `approvalMode`      | string  | project | No       | Tool call approval mode (plan/default/auto-edit/yolo) |
| `checkpointing`     | boolean | global  | No       | Whether file checkpointing (code rewind) is enabled   |
| `respectGitIgnore`  | boolean | project | No       | Whether to respect .gitignore when discovering files  |
| `enableFuzzySearch` | boolean | project | No       | Whether fuzzy file search is enabled                  |
| `debugMode`         | boolean | global  | No       | Whether debug mode is enabled                         |
| `targetDir`         | string  | project | No       | The project root directory                            |
| `outputFormat`      | string  | global  | No       | Output format (text/json/stream-json)                 |

### Scope of writable settings

Only `model` is writable. This is an intentional narrowing:

- **`approvalMode` — security**: Allowing the agent to escalate its own permission level (even with an `ask` confirmation) is a prompt injection risk. A malicious instruction could pressure a fatigued user into approving `SET approvalMode yolo`. Users must change approval mode through a slash command or settings file.
- **`checkpointing` / `respectGitIgnore` / `enableFuzzySearch` — no clear use case**: These are user preferences, not task-scoped behaviors. Task-scoped behavior changes are better handled via sub-agents or skill-level overrides (#2949) — mechanisms that scope the change to a specific piece of work rather than mutating session state.
- **`debugMode` / `targetDir` / `outputFormat` — nothing to change**: These reflect how the CLI was started and cannot be meaningfully changed at runtime.

Only `model` has a legitimate agent-driven write case: a multi-stage task may want to switch the session default model durably (rather than override a single call). Other model-switching needs should use sub-agents or skill `model:` frontmatter.

## Structured Output

All operations return a JSON object (`ConfigToolOutput`) with the following fields:

```typescript
interface ConfigToolOutput {
  success: boolean; // Whether the operation succeeded
  operation: 'get' | 'set'; // The operation type
  setting: string; // The setting key
  source?: 'global' | 'project'; // Where the setting is stored
  value?: string | boolean | number; // Current value (GET)
  previousValue?: string | boolean | number; // Value before change (SET)
  newValue?: string | boolean | number; // Value after change (SET)
  options?: string[]; // Valid options (if applicable)
  error?: string; // Error message (on failure)
}
```

This structured format allows the AI agent to reliably parse results and provide accurate feedback to the user.

## Extending the Allowlist

To add a new setting, add an entry to `SUPPORTED_CONFIG_SETTINGS` in `packages/core/src/tools/supported-config-settings.ts`:

```typescript
export const SUPPORTED_CONFIG_SETTINGS: Record<
  string,
  ConfigSettingDescriptor
> = {
  // existing settings...

  newSetting: {
    description: 'Human-readable description shown to the LLM.',
    type: 'boolean', // 'string' | 'boolean' | 'number'
    writable: true,
    source: 'project', // 'global' | 'project'
    options: ['true', 'false'], // optional: fixed valid values
    validateOnWrite: async (config, value) => {
      // optional: async validation
      // return null on success, error message on failure
      return null;
    },
    read: (config) => config.getNewSetting(),
    write: async (config, value) => {
      try {
        config.setNewSetting(value as boolean);
        return null; // success
      } catch (e) {
        return e instanceof Error ? e.message : 'Failed to set newSetting';
      }
    },
  },
};
```

The tool description and schema are auto-generated from the allowlist, so no other changes are needed to expose the new setting to the AI agent.

## Future Considerations

- **AppState synchronization**: For settings that affect the UI (e.g., theme), writing the config is not enough — the change should also be synced to the runtime AppState for immediate effect.
- **More settings**: Additional settings (theme, language, telemetry, etc.) can be added as the Config class exposes more setter methods.

## Files

| File                                                   | Purpose                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `packages/core/src/tools/config-tool.ts`               | Tool implementation (ConfigTool class + ConfigToolInvocation) |
| `packages/core/src/tools/config-tool.test.ts`          | Unit tests                                                    |
| `packages/core/src/tools/supported-config-settings.ts` | Allowlist of accessible settings                              |
| `packages/core/src/tools/tool-names.ts`                | Tool name and display name constants                          |
