# Todo Write Tool (`todo_write`)

This document describes the `todo_write` tool for Qwen Code.

## Description

Use `todo_write` to create and manage a structured task list for your current coding session. This tool helps the AI assistant track progress and organize complex tasks, providing you with visibility into what work is being performed.

### Arguments

`todo_write` takes one argument:

- `todos` (array, required): An array of todo items, where each item contains:
  - `content` (string, required): The description of the task.
  - `status` (string, required): The current status (`pending`, `in_progress`, or `completed`).
  - `activeForm` (string, required): The present continuous form describing what is being done (e.g., "Running tests", "Building the project").

## How to use `todo_write` with Qwen Code

The AI assistant will automatically use this tool when working on complex, multi-step tasks. You don't need to explicitly request it, but you can ask the assistant to create a todo list if you want to see the planned approach for your request.

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
    "content": "Create user preferences model",
    "status": "pending",
    "activeForm": "Creating user preferences model"
  },
  {
    "content": "Add API endpoints for preferences",
    "status": "pending",
    "activeForm": "Adding API endpoints for preferences"
  },
  {
    "content": "Implement frontend components",
    "status": "pending",
    "activeForm": "Implementing frontend components"
  }
])
```

## Important notes

- **Automatic usage:** The AI assistant manages todo lists automatically during complex tasks.
- **Progress visibility:** You'll see todo lists updated in real-time as work progresses.
- **Session isolation:** Each coding session has its own todo list that doesn't interfere with others.
