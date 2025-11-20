# Qwen Code Hook System

## Overview

The Qwen Code hook system allows users to execute custom scripts at key points in the application lifecycle. This system provides a flexible way to extend the functionality of Qwen Code with custom logic, validation, monitoring, or other automation tasks.

## Hook Types

The system supports various hook points during application execution:

### Application Lifecycle Hooks
- `app.startup` - Triggered when the application starts
- `app.shutdown` - Triggered when the application shuts down
- `session.start` - Triggered when a session starts
- `session.end` - Triggered when a session ends

### Interactive Mode Hooks
- `input.received` - Triggered when input is received from the user
- `output.ready` - Triggered when output is ready to be displayed
- `before.response` - Triggered before the AI generates a response
- `after.response` - Triggered after the AI generates a response

### Tool Execution Hooks
- `tool.before` - Triggered before a tool is executed
- `tool.after` - Triggered after a tool is executed

### Command Processing Hooks
- `command.before` - Triggered before a command is executed
- `command.after` - Triggered after a command is executed

### Model Interaction Hooks
- `model.before_request` - Triggered before sending a request to the model
- `model.after_response` - Triggered after receiving a response from the model

### File System Hooks
- `file.before_read` - Triggered before reading a file
- `file.after_read` - Triggered after reading a file
- `file.before_write` - Triggered before writing a file
- `file.after_write` - Triggered after writing a file

### Error Hooks
- `error.occurred` - Triggered when an error occurs
- `error.handled` - Triggered when an error is handled

### Additional Hooks
- `before.compact` - Triggered before compacting operations
- `session.notification` - Triggered for session notifications

## Hook Payload Structure

Hook payloads contain contextual information needed by the hook scripts:

```typescript
interface HookPayload {
  id: string;              // Unique identifier for the hook execution
  timestamp: number;       // Timestamp of when the hook was triggered
  [key: string]: unknown;  // Additional data specific to the hook type
}
```

## Hook Context

Hooks receive a context object containing:

```typescript
interface HookContext {
  config: Config;          // Configuration and runtime context
  signal?: AbortSignal;    // Cancellation signal for the hook execution
}
```

## Configuration

Hooks are configured in the main settings file. There are two ways to define hooks:

### Script Hooks

Execute external scripts:

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 10000,
    "hooks": [
      {
        "type": "tool.before",
        "scriptPath": "./hooks/security-check.js",
        "priority": 10,
        "enabled": true
      }
    ]
  }
}
```

### Inline Hooks

Execute inline script code:

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 10000,
    "hooks": [
      {
        "type": "input.received",
        "inlineScript": "console.log('Input received:', payload);"
      }
    ]
  }
}
```

### Hook Configuration Options

- `type`: The hook point to register for
- `scriptPath`: Path to a script file to execute
- `inlineScript`: Code to execute directly
- `priority`: Priority level (lower numbers execute first, default is 0)
- `enabled`: Whether the hook is enabled (default is true)

## Security

The hook system implements several security measures:

- Scripts execute with application permissions
- Path validation prevents directory traversal
- Input validation for security
- Session-based execution contexts

## Execution Model

Hooks are executed in priority order when triggered. Each hook receives the same payload and context. If multiple hooks are registered for the same event, they execute sequentially in order of priority.

Errors in one hook do not prevent other hooks from executing, but may be logged for debugging.