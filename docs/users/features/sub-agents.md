# Sub-Agents

Delegate focused tasks to specialized AI agents with their own system prompts, tool restrictions, and model selection.

This page covers how to create and use sub-agents, the configuration format, built-in agents, and multi-agent team coordination.

## Create a sub-agent

Sub-agents are Markdown files with YAML frontmatter stored in `.proto/agents/` (project) or `~/.proto/agents/` (global). Project agents take precedence over global agents with the same name.

### Minimal example

Create `.proto/agents/code-reviewer.md`:

```markdown
---
name: code-reviewer
description: Reviews code for quality, security, and maintainability
tools:
  - read_file
  - grep_search
  - glob
---

You are a code reviewer. Analyze code for:

- Security vulnerabilities
- Performance issues
- Maintainability concerns

Provide specific, actionable feedback with file paths and line numbers.
```

### Use the agent

Ask the model naturally and it will delegate based on the `description` field:

```
Review the authentication module for security issues
```

Or invoke explicitly:

```
Use the code-reviewer agent to check my recent changes
```

### Management commands

| Command          | Purpose                            |
| ---------------- | ---------------------------------- |
| `/agents create` | Guided agent creation wizard       |
| `/agents manage` | View, edit, delete existing agents |

## Configuration reference

### Frontmatter fields

| Field                        | Required | Description                                        |
| ---------------------------- | -------- | -------------------------------------------------- |
| `name`                       | Yes      | Unique identifier (lowercase, hyphens, 2-50 chars) |
| `description`                | Yes      | When to delegate to this agent                     |
| `tools`                      | No       | Allowlist of permitted tools. Omit to inherit all. |
| `disallowedTools`            | No       | Denylist of tools to exclude from inherited set    |
| `permissionMode`             | No       | `default`, `plan`, `autoEdit`, `yolo`              |
| `modelConfig.model`          | No       | `haiku`, `sonnet`, `opus`, or full model ID        |
| `modelConfig.temp`           | No       | Temperature (0-2)                                  |
| `runConfig.max_turns`        | No       | Maximum agentic turns                              |
| `runConfig.max_time_minutes` | No       | Maximum execution time                             |
| `color`                      | No       | Display color for UI                               |

### Tool restrictions

Two mechanisms control which tools an agent can use:

**Allowlist (`tools`)** — Only these tools are available:

```yaml
tools:
  - read_file
  - grep_search
  - glob
```

**Denylist (`disallowedTools`)** — Remove these from the inherited set:

```yaml
disallowedTools:
  - write_file
  - edit
```

When both are specified, `disallowedTools` is applied first, then `tools` filters the remainder.

### Permission mode

Override the session's permission mode for a specific agent:

| Mode       | Behavior                         |
| ---------- | -------------------------------- |
| `default`  | Standard confirmation prompts    |
| `plan`     | Read-only, no file modifications |
| `autoEdit` | Auto-approve file edits          |
| `yolo`     | Auto-approve everything          |

If the parent session uses bypass permissions, it takes precedence.

### Template variables

System prompts support `${variable}` syntax. Variables are resolved from `ContextState` at runtime.

### Storage hierarchy

| Level     | Location                        | Priority |
| --------- | ------------------------------- | -------- |
| Session   | Passed via SDK at runtime       | Highest  |
| Project   | `.proto/agents/`                | 2        |
| User      | `~/.proto/agents/`              | 3        |
| Extension | Installed extension's `agents/` | 4        |
| Built-in  | Embedded in proto               | Lowest   |

When multiple agents share the same name, higher-priority location wins.

## Built-in agents

Four agents are always available:

| Agent             | Purpose                                              | Tools              |
| ----------------- | ---------------------------------------------------- | ------------------ |
| `general-purpose` | Complex multi-step tasks, code search                | All (except Agent) |
| `Explore`         | Fast codebase search and analysis                    | Read-only          |
| `verify`          | Review changes for correctness before finalizing     | Read-only          |
| `coordinator`     | Orchestrate multi-agent work with task decomposition | All + Agent        |

## Background execution

Agents can run in the background using `run_in_background: true` in the Agent tool call:

- Returns immediately with an agent ID
- Runs concurrently while the main conversation continues
- Completion notification is injected at the next tool boundary
- Results appear alongside tool results via mid-turn injection

The `coordinator` agent uses this to delegate subtasks in parallel.

## Agent teams

Teams enable coordinated multi-agent work with shared task visibility and messaging.

### Team commands

| Command                                | Description               |
| -------------------------------------- | ------------------------- |
| `/team list`                           | List all configured teams |
| `/team start <name> [member:type ...]` | Create and start a team   |
| `/team status <name>`                  | Show team member status   |
| `/team stop <name>`                    | Stop a running team       |
| `/team delete <name>`                  | Delete a team config      |

### Start a team

```
/team start research researcher:Explore implementer:general-purpose
```

Default (no members specified): `lead` (coordinator) + `scout` (Explore).

Team config is stored at `.proto/teams/{name}/config.json`.

### Shared task list

Teammates share task visibility through the task system:

- **Claim a task**: `claimTask(id, agentId)` atomically assigns and starts it
- **Find available work**: `getUnclaimedTasks()` returns pending tasks with no assignee
- Tasks track their `assignee` for ownership

### Inter-agent messaging

`TeamMailbox` enables direct communication:

| Method                     | Purpose                             |
| -------------------------- | ----------------------------------- |
| `send(from, to, message)`  | Direct message to a teammate        |
| `broadcast(from, message)` | Message all teammates except sender |
| `receive(agentId)`         | Drain unread messages               |
| `peek(agentId)`            | Read without draining               |

### Team lifecycle hooks

Three hook events fire during team coordination:

| Hook            | When it fires                                              |
| --------------- | ---------------------------------------------------------- |
| `TeammateIdle`  | Background agent finishes (exit 2 = reject, send feedback) |
| `TaskCreated`   | Task added to shared list                                  |
| `TaskCompleted` | Task marked done                                           |

See [Hooks](./hooks.md#team-events) for configuration details.

## Design guidelines

### Single responsibility

Each agent should have one clear purpose.

```yaml
# Focused
name: testing-expert
description: Writes comprehensive unit and integration tests

# Too broad
name: general-helper
description: Helps with testing, documentation, review, and deployment
```

### Actionable descriptions

Write descriptions that clearly indicate when to delegate:

```yaml
# Clear trigger
description: Reviews code for security vulnerabilities, performance issues, and maintainability

# Vague
description: A helpful code reviewer
```

### Minimal tool access

Grant only the tools the agent needs. Read-only agents should not have `write_file` or `edit`.

### Proactive delegation

Include "use proactively" in the description to encourage automatic delegation without explicit user request.
