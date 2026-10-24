# Configurable default execution mode for subagents

[English](agent-default-background.md) | [简体中文](agent-default-background.zh-CN.md)

## Problem and current behavior

Top-level regular subagents default to background execution. Users who need the complete result inline must repeat `run_in_background: false` on each call or set `background: false` in each agent definition. There is no global setting for this preference. This change addresses [#15147](https://github.com/QwenLM/qwen-code/issues/15147).

## Proposed behavior

Add the boolean setting `agents.defaultBackground`, defaulting to `true`. Setting it to `false` makes eligible top-level regular subagents run in the foreground and return their results inline. An omitted setting preserves existing behavior.

```json
{
  "agents": {
    "defaultBackground": false
  }
}
```

The precedence is explicit `run_in_background`, then agent-definition `background`, then `agents.defaultBackground`, then the existing built-in default. Both explicit boolean values remain meaningful at each layer.

## Implementation and decisions

The CLI settings schema declares the setting and generates its editor JSON schema. CLI configuration forwards it to the existing core `AgentsCollabSettings` object. The Agent tool reads it through `getAgentsSettings()` only in the existing regular-subagent fallback. No new runtime state or execution path is needed.

The optional tool argument has no static schema default: its effective default depends on the agent definition and settings. This preserves omission for consumers that apply JSON schema defaults.

The setting requires a restart because core agent settings are a construction-time snapshot. Declaring it live would require additional synchronization outside this feature's scope.

Affected code is the CLI settings schema and configuration mapping, the core configuration type and Agent tool, and their focused tests. The settings reference, subagent guide, and Agent tool documentation describe the preference and its precedence. Model-facing tool descriptions mention the configurable default.

## Compatibility and scope

- Headless forks remain background tasks. Interactive forks retain their existing behavior.
- Nested agents remain foreground, and explicit nested background requests remain rejected.
- Caller-owned `working_dir` and named-agent restrictions retain their existing guards. Named teammates retain their separate execution path.
- Agent definitions, including external executors with `background: false`, take precedence over the global setting.
- Display and lifecycle consumers continue to use the resolved `executionMode` and `isBackgrounded` values. Legacy transcript classification is unchanged.
- Existing background-task resumption, hosted workspace execution profiles, and external desktop implementations are outside this change.

## Validation and acceptance criteria

Focused tests cover omitted, `true`, and `false` settings; explicit argument and frontmatter overrides in both directions; CLI configuration forwarding; schema defaults; and existing execution guards. Assertions inspect returned results, display mode, and registry state.

Behavioral verification uses an isolated CLI session with a deterministic local model endpoint to request a regular subagent without an explicit mode. Before implementation, a `false` setting still launches it in the background. After implementation, the subagent result returns inline; an explicit background request continues to launch a background task. The E2E plan records commands, results, and environment limitations. Build, typecheck, bundle, formatting, and relevant lint checks complete the validation.

## Open questions

None required for this implementation. Maintainers may choose to add live reconfiguration separately.
