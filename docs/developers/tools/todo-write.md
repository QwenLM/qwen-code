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

### Arguments

`todo_write` takes one argument:

- `todos` (array, required): An array of todo items, where each item contains:
  - `content` (string, required): The description of the task.
  - `status` (string, required): The current status (`pending`, `in_progress`, or `completed`).
  - `id` (string, required): A unique identifier for the todo item.

## How to use `todo_write` with Qwen Code

When the tool is enabled, the AI assistant may use it for complex, multi-step tasks. You can also ask the assistant to create a todo list if you want to see the planned approach for your request.

The tool stores todo lists in your home directory (`~/.qwen/todos/`) with session-specific files, so each coding session maintains its own task list.

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
