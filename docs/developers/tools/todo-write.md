# Todo Write Tool (`todo_write`)

This document describes the `todo_write` tool for Qwen Code.

## Description

Use `todo_write` to create and manage a structured task list for your current coding session. This tool helps the AI assistant track progress and organize complex tasks, providing you with visibility into what work is being performed.

The tool is disabled by default. Enable it in `settings.json` and restart Qwen
Code:

```json
{
  "tools": {
    "todoWrite": {
      "enabled": true
    }
  }
}
```

To store todo files in the project, add the root-level `todosDirectory` setting next to it:

```json
{
  "todosDirectory": "./.qwen/todos",
  "tools": {
    "todoWrite": {
      "enabled": true
    }
  }
}
```

### Arguments

`todo_write` takes one argument:

- `todos` (array, required): An array of todo items, where each item contains:
  - `content` (string, required): The description of the task.
  - `status` (string, required): The current status (`pending`, `in_progress`, or `completed`).
  - `id` (string, required): A unique identifier for the todo item.

## How to use `todo_write` with Qwen Code

When the tool is enabled, the AI assistant may use it for complex, multi-step tasks. You can also ask the assistant to create a todo list if you want to see the planned approach for your request.

The tool stores each session's todo list in its own file, named after the session ID, so each coding session maintains its own task list. By default these files live in the `todos/` directory under the runtime output directory: `~/.qwen/todos/` unless the runtime directory is moved (for example with the `QWEN_RUNTIME_DIR` environment variable).

To keep todo files inside a project instead, set the root-level `todosDirectory` setting. Relative paths are resolved from the project root, and the resolved directory must stay within the project root; a value that escapes it is rejected at startup. See [`todosDirectory`](../../users/configuration/settings.md) in the settings reference.

Todo files stay keyed by session ID even in a project-local directory. A new session, on this machine or another one, starts its own file and does not pick up the todo list of an earlier session.

## When the AI uses this tool

The assistant uses `todo_write` for:

- Complex tasks requiring multiple steps
- Feature implementations with several components
- Refactoring operations across multiple files
- Any work involving 3 or more distinct actions

The assistant will not use this tool for simple, single-step tasks or purely informational requests.

### `todo_write` examples

Creating a feature implementation plan:

```
todo_write(todos=[
  {
    "id": "1",
    "content": "Create user preferences model",
    "status": "pending"
  },
  {
    "id": "2",
    "content": "Add API endpoints for preferences",
    "status": "pending"
  },
  {
    "id": "3",
    "content": "Implement frontend components",
    "status": "pending"
  }
])
```

## Important notes

- **Opt-in:** Set `tools.todoWrite.enabled` to `true` and restart Qwen Code before using the tool.
- **Automatic usage when enabled:** The AI assistant manages todo lists during complex tasks.
- **Progress visibility:** You'll see todo lists updated in real-time as work progresses.
- **Session isolation:** Each coding session has its own todo list that doesn't interfere with others.
