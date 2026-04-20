# Commands

This document details all commands supported by Qwen Code, helping you efficiently manage sessions, customize the interface, and control its behavior.

Qwen Code commands are triggered through specific prefixes and fall into three categories:

| Prefix Type                | Function Description                                | Typical Use Case                                                 |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Slash Commands (`/`)       | Meta-level control of Qwen Code itself              | Managing sessions, modifying settings, getting help              |
| At Commands (`@`)          | Quickly inject local file content into conversation | Allowing AI to analyze specified files or code under directories |
| Exclamation Commands (`!`) | Direct interaction with system Shell                | Executing system commands like `git status`, `ls`, etc.          |

## 1. Slash Commands (`/`)

Slash commands are used to manage Qwen Code sessions, interface, and basic behavior.

### 1.1 Session and Project Management

These commands help you save, restore, and summarize work progress.

| Command     | Description                                               | Usage Examples                       |
| ----------- | --------------------------------------------------------- | ------------------------------------ |
| `/init`     | Analyze current directory and create initial context file | `/init`                              |
| `/summary`  | Generate project summary based on conversation history    | `/summary`                           |
| `/compress` | Replace chat history with summary to save Tokens          | `/compress`                          |
| `/resume`   | Resume a previous conversation session                    | `/resume`                            |
| `/recap`    | Show a 1-3 sentence "where you left off" summary          | `/recap`                             |
| `/restore`  | Restore files to state before tool execution              | `/restore` (list) or `/restore <ID>` |

### 1.2 Interface and Workspace Control

Commands for adjusting interface appearance and work environment.

| Command      | Description                              | Usage Examples                |
| ------------ | ---------------------------------------- | ----------------------------- |
| `/clear`     | Clear terminal screen content            | `/clear` (shortcut: `Ctrl+L`) |
| `/context`   | Show context window usage breakdown      | `/context`                    |
| → `detail`   | Show per-item context usage breakdown    | `/context detail`             |
| `/theme`     | Change Qwen Code visual theme            | `/theme`                      |
| `/vim`       | Turn input area Vim editing mode on/off  | `/vim`                        |
| `/directory` | Manage multi-directory support workspace | `/dir add ./src,./tests`      |
| `/editor`    | Open dialog to select supported editor   | `/editor`                     |

### 1.3 Language Settings

Commands specifically for controlling interface and output language.

| Command               | Description                      | Usage Examples             |
| --------------------- | -------------------------------- | -------------------------- |
| `/language`           | View or change language settings | `/language`                |
| → `ui [language]`     | Set UI interface language        | `/language ui zh-CN`       |
| → `output [language]` | Set LLM output language          | `/language output Chinese` |

- Available built-in UI languages: `zh-CN` (Simplified Chinese), `en-US` (English), `ru-RU` (Russian), `de-DE` (German)
- Output language examples: `Chinese`, `English`, `Japanese`, etc.

### 1.4 Tool and Model Management

Commands for managing AI tools and models.

| Command          | Description                                   | Usage Examples                                |
| ---------------- | --------------------------------------------- | --------------------------------------------- |
| `/mcp`           | List configured MCP servers and tools         | `/mcp`, `/mcp desc`                           |
| `/tools`         | Display currently available tool list         | `/tools`, `/tools desc`                       |
| `/skills`        | List and run available skills                 | `/skills`, `/skills <name>`                   |
| `/plan`          | Switch to plan mode or exit plan mode         | `/plan`, `/plan <task>`, `/plan exit`         |
| `/approval-mode` | Change approval mode for tool usage           | `/approval-mode <mode (auto-edit)> --project` |
| →`plan`          | Analysis only, no execution                   | Secure review                                 |
| →`default`       | Require approval for edits                    | Daily use                                     |
| →`auto-edit`     | Automatically approve edits                   | Trusted environment                           |
| →`yolo`          | Automatically approve all                     | Quick prototyping                             |
| `/model`         | Switch model used in current session          | `/model`                                      |
| `/model --fast`  | Set a lighter model for prompt suggestions    | `/model --fast qwen3-coder-flash`             |
| `/extensions`    | List all active extensions in current session | `/extensions`                                 |
| `/memory`        | Open the Memory Manager dialog                | `/memory`                                     |
| `/remember`      | Save a durable memory                         | `/remember Prefer terse responses`            |
| `/forget`        | Remove matching entries from auto-memory      | `/forget <query>`                             |
| `/dream`         | Manually run auto-memory consolidation        | `/dream`                                      |

### 1.5 Built-in Skills

These commands invoke bundled skills that provide specialized workflows.

| Command      | Description                                                         | Usage Examples                                    |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------- |
| `/review`    | Review code changes with 5 parallel agents + deterministic analysis | `/review`, `/review 123`, `/review 123 --comment` |
| `/loop`      | Run a prompt on a recurring schedule                                | `/loop 5m check the build`                        |
| `/qc-helper` | Answer questions about Qwen Code usage and configuration            | `/qc-helper how do I configure MCP?`              |

See [Code Review](./code-review.md) for full `/review` documentation.

### 1.6 Side Question (`/btw`)

The `/btw` command allows you to ask quick side questions without interrupting or affecting the main conversation flow.

| Command                | Description                           |
| ---------------------- | ------------------------------------- |
| `/btw <your question>` | Ask a quick side question             |
| `?btw <your question>` | Alternative syntax for side questions |

**How It Works:**

- The side question is sent as a separate API call with recent conversation context (up to the last 20 messages)
- The response is displayed above the Composer — you can continue typing while waiting
- The main conversation is **not blocked** — it continues independently
- The side question response does **not** become part of the main conversation history
- Answers are rendered with full Markdown support (code blocks, lists, tables, etc.)

**Keyboard Shortcuts (Interactive Mode):**

| Shortcut             | Action                                              |
| -------------------- | --------------------------------------------------- |
| `Escape`             | Cancel (while loading) or dismiss (after completed) |
| `Space` or `Enter`   | Dismiss the answer (when input is empty)            |
| `Ctrl+C` or `Ctrl+D` | Cancel an in-flight side question                   |

**Example:**

```
(While the main conversation is about refactoring code)

> /btw What's the difference between let and var in JavaScript?

  ╭──────────────────────────────────────────╮
  │ /btw What's the difference between let   │
  │     and var in JavaScript?               │
  │                                          │
  │ + Answering...                           │
  │ Press Escape, Ctrl+C, or Ctrl+D to cancel│
  ╰──────────────────────────────────────────╯
  > (Composer remains active — keep typing)

(After the answer arrives)

  ╭──────────────────────────────────────────╮
  │ /btw What's the difference between let   │
  │     and var in JavaScript?               │
  │                                          │
  │ `let` is block-scoped, while `var` is    │
  │ function-scoped. `let` was introduced    │
  │ in ES6 and doesn't hoist the same way.   │
  │                                          │
  │ Press Space, Enter, or Escape to dismiss │
  ╰──────────────────────────────────────────╯
  > (Composer still active)
```

**Supported Execution Modes:**

| Mode                 | Behavior                                     |
| -------------------- | -------------------------------------------- |
| Interactive          | Shows above Composer with Markdown rendering |
| Non-interactive      | Returns text result: `btw> question\nanswer` |
| ACP (Agent Protocol) | Returns stream_messages async generator      |

> [!tip]
>
> Use `/btw` when you need a quick answer without derailing your main task. It's especially useful for clarifying concepts, checking facts, or getting quick explanations while staying focused on your primary workflow.

### 1.7 Session Recap (`/recap`)

The `/recap` command generates a short "where you left off" summary of the
current session, so you can resume an old conversation without scrolling
back through pages of history.

| Command  | Description                                      |
| -------- | ------------------------------------------------ |
| `/recap` | Generate and show a 1-3 sentence session summary |

**How it works:**

- Uses the configured fast model (`fastModel` setting) when available, falling
  back to the main session model. A small, cheap model is enough for a recap.
- The recent conversation (up to 30 messages, text only — tool calls and tool
  responses are filtered out) is sent to the model with a tight system prompt.
- The recap is rendered in dim color with a `❯` prefix so it stands apart
  from real assistant replies.
- Refuses with an inline error if a model turn is in flight or another command
  is processing. If there is no usable conversation, or the underlying
  generation fails, `/recap` shows a short info message instead of a recap —
  the manual command always responds with something.

**Auto-trigger when returning from being away:**

If the terminal is blurred for **5+ minutes** and gets focused again, a recap
is generated and shown automatically (only when no model response is in
progress; otherwise it waits for the current turn to finish and then fires).
Unlike the manual command, the auto-trigger is fully silent on failure: if
generation errors or there is nothing to summarize, no message is added to
the history. Controlled by the `general.showSessionRecap` setting
(default: `true`); the manual `/recap` command always works regardless of
this setting.

**Example:**

```
> /recap

❯ Refactoring loopDetectionService.ts to address long-session OOM caused by
  unbounded streamContentHistory and contentStats. The next step is to
  implement option B (LRU sliding window with FNV-1a) pending confirmation.
```

> [!tip]
>
> Configure a fast model via `/model --fast <model>` (e.g.
> `qwen3-coder-flash`) to make `/recap` fast and cheap. Set
> `general.showSessionRecap` to `false` to opt out of the auto-trigger
> while keeping the manual command available.

### 1.8 Information, Settings, and Help

Commands for obtaining information and performing system settings.

| Command     | Description                                     | Usage Examples                   |
| ----------- | ----------------------------------------------- | -------------------------------- |
| `/help`     | Display help information for available commands | `/help` or `/?`                  |
| `/about`    | Display version information                     | `/about`                         |
| `/stats`    | Display detailed statistics for current session | `/stats`                         |
| `/settings` | Open settings editor                            | `/settings`                      |
| `/auth`     | Change authentication method                    | `/auth`                          |
| `/bug`      | Submit issue about Qwen Code                    | `/bug Button click unresponsive` |
| `/copy`     | Copy last output content to clipboard           | `/copy`                          |
| `/quit`     | Exit Qwen Code immediately                      | `/quit` or `/exit`               |

### 1.9 Common Shortcuts

| Shortcut           | Function                | Note                   |
| ------------------ | ----------------------- | ---------------------- |
| `Ctrl/cmd+L`       | Clear screen            | Equivalent to `/clear` |
| `Ctrl/cmd+T`       | Toggle tool description | MCP tool management    |
| `Ctrl/cmd+C`×2     | Exit confirmation       | Secure exit mechanism  |
| `Ctrl/cmd+Z`       | Undo input              | Text editing           |
| `Ctrl/cmd+Shift+Z` | Redo input              | Text editing           |

### 1.10 CLI Auth Subcommands

In addition to the in-session `/auth` slash command, Qwen Code provides standalone CLI subcommands for managing authentication directly from the terminal:

| Command                                              | Description                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `qwen auth`                                          | Interactive authentication setup                              |
| `qwen auth qwen-oauth`                               | ~~Authenticate with Qwen OAuth~~ (discontinued on 2026-04-15) |
| `qwen auth coding-plan`                              | Authenticate with Alibaba Cloud Coding Plan                   |
| `qwen auth coding-plan --region china --key sk-sp-…` | Non-interactive Coding Plan setup (for scripting)             |
| `qwen auth status`                                   | Show current authentication status                            |

> [!tip]
>
> These commands run outside of a Qwen Code session. Use them to configure authentication before starting a session, or in scripts and CI environments. See the [Authentication](../configuration/auth) page for full details.

## 2. @ Commands (Introducing Files)

@ commands are used to quickly add local file or directory content to the conversation.

| Command Format      | Description                                  | Examples                                         |
| ------------------- | -------------------------------------------- | ------------------------------------------------ |
| `@<file path>`      | Inject content of specified file             | `@src/main.py Please explain this code`          |
| `@<directory path>` | Recursively read all text files in directory | `@docs/ Summarize content of this document`      |
| Standalone `@`      | Used when discussing `@` symbol itself       | `@ What is this symbol used for in programming?` |

Note: Spaces in paths need to be escaped with backslash (e.g., `@My\ Documents/file.txt`)

## 3. Exclamation Commands (`!`) - Shell Command Execution

Exclamation commands allow you to execute system commands directly within Qwen Code.

| Command Format     | Description                                                        | Examples                               |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------- |
| `!<shell command>` | Execute command in sub-Shell                                       | `!ls -la`, `!git status`               |
| Standalone `!`     | Switch Shell mode, any input is executed directly as Shell command | `!`(enter) → Input command → `!`(exit) |

Environment Variables: Commands executed via `!` will set the `QWEN_CODE=1` environment variable.

## 4. Custom Commands

Save frequently used prompts as shortcut commands to improve work efficiency and ensure consistency.

> [!note]
>
> Custom commands now use Markdown format with optional YAML frontmatter. TOML format is deprecated but still supported for backwards compatibility. When TOML files are detected, an automatic migration prompt will be displayed.

### Quick Overview

| Function         | Description                                | Advantages                             | Priority | Applicable Scenarios                                 |
| ---------------- | ------------------------------------------ | -------------------------------------- | -------- | ---------------------------------------------------- |
| Namespace        | Subdirectory creates colon-named commands  | Better command organization            |          |                                                      |
| Global Commands  | `~/.qwen/commands/`                        | Available in all projects              | Low      | Personal frequently used commands, cross-project use |
| Project Commands | `<project root directory>/.qwen/commands/` | Project-specific, version-controllable | High     | Team sharing, project-specific commands              |

Priority Rules: Project commands > User commands (project command used when names are same)

### Command Naming Rules

#### File Path to Command Name Mapping Table

| File Location                            | Generated Command | Example Call          |
| ---------------------------------------- | ----------------- | --------------------- |
| `~/.qwen/commands/test.md`               | `/test`           | `/test Parameter`     |
| `<project>/.qwen/commands/git/commit.md` | `/git:commit`     | `/git:commit Message` |

Naming Rules: Path separator (`/` or `\`) converted to colon (`:`)

### Markdown File Format Specification (Recommended)

Custom commands use Markdown files with optional YAML frontmatter:

```markdown
---
description: Optional description (displayed in /help)
---

Your prompt content here.
Use {{args}} for parameter injection.
```

| Field         | Required | Description                              | Example                                    |
| ------------- | -------- | ---------------------------------------- | ------------------------------------------ |
| `description` | Optional | Command description (displayed in /help) | `description: Code analysis tool`          |
| Prompt body   | Required | Prompt content sent to model             | Any Markdown content after the frontmatter |

### TOML File Format (Deprecated)

> [!warning]
>
> **Deprecated:** TOML format is still supported but will be removed in a future version. Please migrate to Markdown format.

| Field         | Required | Description                              | Example                                    |
| ------------- | -------- | ---------------------------------------- | ------------------------------------------ |
| `prompt`      | Required | Prompt content sent to model             | `prompt = "Please analyze code: {{args}}"` |
| `description` | Optional | Command description (displayed in /help) | `description = "Code analysis tool"`       |

### Parameter Processing Mechanism

| Processing Method            | Syntax             | Applicable Scenarios                 | Security Features                      |
| ---------------------------- | ------------------ | ------------------------------------ | -------------------------------------- |
| Context-aware Injection      | `{{args}}`         | Need precise parameter control       | Automatic Shell escaping               |
| Default Parameter Processing | No special marking | Simple commands, parameter appending | Append as-is                           |
| Shell Command Injection      | `!{command}`       | Need dynamic content                 | Execution confirmation required before |

#### 1. Context-aware Injection (`{{args}}`)

| Scenario         | TOML Configuration                      | Call Method           | Actual Effect            |
| ---------------- | --------------------------------------- | --------------------- | ------------------------ |
| Raw Injection    | `prompt = "Fix: {{args}}"`              | `/fix "Button issue"` | `Fix: "Button issue"`    |
| In Shell Command | `prompt = "Search: !{grep {{args}} .}"` | `/search "hello"`     | Execute `grep "hello" .` |

#### 2. Default Parameter Processing

| Input Situation | Processing Method                                      | Example                                        |
| --------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Has parameters  | Append to end of prompt (separated by two line breaks) | `/cmd parameter` → Original prompt + parameter |
| No parameters   | Send prompt as is                                      | `/cmd` → Original prompt                       |

🚀 Dynamic Content Injection

| Injection Type        | Syntax         | Processing Order    | Purpose                          |
| --------------------- | -------------- | ------------------- | -------------------------------- |
| File Content          | `@{file path}` | Processed first     | Inject static reference files    |
| Shell Commands        | `!{command}`   | Processed in middle | Inject dynamic execution results |
| Parameter Replacement | `{{args}}`     | Processed last      | Inject user parameters           |

#### 3. Shell Command Execution (`!{...}`)

| Operation                       | User Interaction     |
| ------------------------------- | -------------------- |
| 1. Parse command and parameters | -                    |
| 2. Automatic Shell escaping     | -                    |
| 3. Show confirmation dialog     | ✅ User confirmation |
| 4. Execute command              | -                    |
| 5. Inject output to prompt      | -                    |

Example: Git Commit Message Generation

````markdown
---
description: Generate Commit message based on staged changes
---

Please generate a Commit message based on the following diff:

```diff
!{git diff --staged}
```
````

#### 4. File Content Injection (`@{...}`)

| File Type    | Support Status         | Processing Method           |
| ------------ | ---------------------- | --------------------------- |
| Text Files   | ✅ Full Support        | Directly inject content     |
| Images/PDF   | ✅ Multi-modal Support | Encode and inject           |
| Binary Files | ⚠️ Limited Support     | May be skipped or truncated |
| Directory    | ✅ Recursive Injection | Follow .gitignore rules     |

Example: Code Review Command

```markdown
---
description: Code review based on best practices
---

Review {{args}}, reference standards:

@{docs/code-standards.md}
```

### Practical Creation Example

#### "Pure Function Refactoring" Command Creation Steps Table

| Operation                     | Command/Code                              |
| ----------------------------- | ----------------------------------------- |
| 1. Create directory structure | `mkdir -p ~/.qwen/commands/refactor`      |
| 2. Create command file        | `touch ~/.qwen/commands/refactor/pure.md` |
| 3. Edit command content       | Refer to the complete code below.         |
| 4. Test command               | `@file.js` → `/refactor:pure`             |

```markdown
---
description: Refactor code to pure function
---

Please analyze code in current context, refactor to pure function.
Requirements:

1. Provide refactored code
2. Explain key changes and pure function characteristic implementation
3. Maintain function unchanged
```

### Custom Command Best Practices Summary

#### Command Design Recommendations Table

| Practice Points      | Recommended Approach                | Avoid                                       |
| -------------------- | ----------------------------------- | ------------------------------------------- |
| Command Naming       | Use namespaces for organization     | Avoid overly generic names                  |
| Parameter Processing | Clearly use `{{args}}`              | Rely on default appending (easy to confuse) |
| Error Handling       | Utilize Shell error output          | Ignore execution failure                    |
| File Organization    | Organize by function in directories | All commands in root directory              |
| Description Field    | Always provide clear description    | Rely on auto-generated description          |

#### Security Features Reminder Table

| Security Mechanism     | Protection Effect          | User Operation         |
| ---------------------- | -------------------------- | ---------------------- |
| Shell Escaping         | Prevent command injection  | Automatic processing   |
| Execution Confirmation | Avoid accidental execution | Dialog confirmation    |
| Error Reporting        | Help diagnose issues       | View error information |
