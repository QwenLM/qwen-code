---
name: security-check
description: Security validation skill that registers hooks to check dangerous commands and log file operations
hooks:
  PreToolUse:
    - matcher: '*'
      hooks:
        - type: command
          command: 'echo ''{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by security check"}}'''
          timeout: 5000
          statusMessage: 'Running security check...'
---

# Security Check Skill

This skill provides security validation hooks that are automatically registered when the skill is invoked.

## Features

- **PreToolUse for Bash**: Validates shell commands before execution
- **PreToolUse for Write/Edit**: Checks file paths before modifications
- **PostToolUse Audit**: Logs all tool executions to an audit file

## How It Works

When you invoke this skill using `/skill security-check` or the Skill tool, the hooks defined in the frontmatter are automatically registered as session hooks. These hooks will remain active for the duration of the session.

## Available Hooks

| Event       | Matcher             | Description              |
| ----------- | ------------------- | ------------------------ | ---------------------- |
| PreToolUse  | `run_shell_command` | Validates shell commands |
| PreToolUse  | `^(write_file       | edit)$`                  | Checks file operations |
| PostToolUse | `*`                 | Logs all tool executions |

## Environment Variables

Hooks have access to:

- `$QWEN_SKILL_ROOT` - The skill's base directory
- `$TOOL_NAME` - Name of the tool being executed
- `$TOOL_INPUT` - JSON input to the tool

## Example Usage

```
User: /skill security-check
Assistant: Skill loaded. Security hooks are now active for this session.

User: Run ls -la
Assistant: [Security Check] Validating command...
<command executes>
[Audit Log] Tool run_shell_command executed
```
