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

| Command          | Description                                                              | Usage Examples                                                |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `/init`          | Analyze current directory and create initial context file                | `/init`                                                       |
| `/summary`       | Generate project summary based on conversation history                   | `/summary`                                                    |
| `/compress`      | Replace chat history with summary to save Tokens                         | `/compress`                                                   |
| `/compress-fast` | Fast compression without AI — strips old tool outputs and thinking parts | `/compress-fast`                                              |
| `/resume`        | Resume a previous conversation session                                   | `/resume`                                                     |
| `/recap`         | Generate a one-line session recap now                                    | `/recap`                                                      |
| `/restore`       | Revert project files to the checkpoint before a tool call ran            | `/restore` (list) or `/restore <ID>`                          |
| `/delete`        | Delete a previous session                                                | `/delete`                                                     |
| `/branch`        | Fork the current conversation into a new session                         | `/branch`                                                     |
| `/fork`          | Spawn a background agent that inherits the full conversation             | `/fork <directive>`                                           |
| `/rewind`        | Rewind conversation to a previous turn                                   | `/rewind` or `/rollback`                                      |
| `/export`        | Export session history to file                                           | `/export html`, `/export md`, `/export json`, `/export jsonl` |
| `/rename`        | Rename or tag the current session                                        | `/rename My Feature` or `/tag`                                |

### 1.2 Interface and Workspace Control

Commands for adjusting interface appearance and work environment.

| Command              | Description                                                                                                                                                                       | Usage Examples                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `/clear`             | Clear terminal screen content                                                                                                                                                     | `/clear` (shortcut: `Ctrl+L`)           |
| `/context`           | Show context window usage breakdown                                                                                                                                               | `/context`                              |
| → `detail`           | Show per-item context usage breakdown                                                                                                                                             | `/context detail`                       |
| `/diff`              | Open an interactive diff viewer showing uncommitted changes and per-turn diffs. Use ←/→ to switch between current git diff and individual conversation turns, ↑/↓ to browse files | `/diff`                                 |
| `/theme`             | Change Qwen Code visual theme                                                                                                                                                     | `/theme`                                |
| `/vim`               | Turn input area Vim editing mode on/off                                                                                                                                           | `/vim`                                  |
| `/directory`         | Manage multi-directory support workspace                                                                                                                                          | `/dir add ./src,./tests`                |
| `/editor`            | Open dialog to select supported editor                                                                                                                                            | `/editor`                               |
| `/statusline`        | Open interactive [status line](./status-line.md) preset dialog                                                                                                                    | `/statusline`                           |
| `/statusline <text>` | Generate a command-mode [status line](./status-line.md) via agent                                                                                                                 | `/statusline show model and git branch` |
| `/terminal-setup`    | Configure terminal keybindings for multiline input                                                                                                                                | `/terminal-setup`                       |

### 1.3 Language Settings

Commands specifically for controlling interface and output language.

| Command               | Description                      | Usage Examples             |
| --------------------- | -------------------------------- | -------------------------- |
| `/language`           | View or change language settings | `/language`                |
| → `ui [language]`     | Set UI interface language        | `/language ui zh-CN`       |
| → `output [language]` | Set LLM output language          | `/language output Chinese` |

- Available built-in UI languages: `zh-CN` (Simplified Chinese), `en-US` (English), `ru-RU` (Russian), `de-DE` (German), `ja-JP` (Japanese), `pt-BR` (Portuguese - Brazil), `fr-FR` (French), `ca-ES` (Catalan)
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
| →`auto`          | Classifier-evaluated approval                 | Autonomous sessions with safety guardrails    |
| →`yolo`          | Automatically approve all                     | Quick prototyping                             |
| `/model`         | Switch model used in current session          | `/model`                                      |
| `/model --fast`  | Set a lighter model for prompt suggestions    | `/model --fast qwen3-coder-flash`             |
| `/extensions`    | List all active extensions in current session | `/extensions`                                 |
| `/memory`        | Open the Memory Manager dialog                | `/memory`                                     |
| `/remember`      | Save a durable memory                         | `/remember Prefer terse responses`            |
| `/forget`        | Remove matching entries from auto-memory      | `/forget <query>`                             |
| `/dream`         | Manually run auto-memory consolidation        | `/dream`                                      |
| `/hooks`         | Manage Qwen Code hooks                        | `/hooks`, `/hooks list`                       |
| `/permissions`   | Manage permission rules                       | `/permissions`                                |
| `/agents`        | Manage subagents                              | `/agents manage`, `/agents create`            |
| `/arena`         | Manage Arena sessions                         | `/arena start`, `/arena status`               |
| `/goal`          | Set a goal — keep working until condition met | `/goal <condition>`, `/goal clear`            |
| `/tasks`         | List background tasks                         | `/tasks`                                      |
| `/workflows`     | Inspect workflow runs                         | `/workflows`, `/workflows <runId>`            |
| `/lsp`           | Show LSP server status                        | `/lsp`                                        |
| `/trust`         | Manage folder trust settings                  | `/trust`                                      |

### 1.5 Built-in Skills

These commands invoke bundled skills that provide specialized workflows.

| Command      | Description                                                         | Usage Examples                                    |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------- |
| `/review`    | Review code changes with 5 parallel agents + deterministic analysis | `/review`, `/review 123`, `/review 123 --comment` |
| `/loop`      | Run a prompt on a recurring schedule                                | `/loop 5m check the build`                        |
| `/simplify`  | Review recent changes and apply safe cleanup edits directly         | `/simplify`, `/simplify focus on duplication`     |
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

| Command  | Description                                |
| -------- | ------------------------------------------ |
| `/recap` | Generate and show a one-line session recap |

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
(default: `false`); the manual `/recap` command always works regardless of
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
> `general.showSessionRecap` to `true` to enable the auto-trigger; the
> manual `/recap` command always works regardless of this setting.

### 1.8 Diff Viewer (`/diff`)

The `/diff` command opens an interactive diff viewer showing uncommitted changes and per-turn diffs. Use ←/→ to switch between the current git diff and individual conversation turns, ↑/↓ to browse files, and Enter to view inline diffs.

**How it works:**

In interactive mode, `/diff` opens a dialog with a **source picker** along the top:

- **Current** — working tree vs HEAD (`git diff HEAD`). Shows all uncommitted changes including staged, unstaged, and untracked files.
- **T1, T2, T3, …** — per-turn diffs, one tab per model turn that modified files. Most recent turns appear first. Each tab shows a preview of the original prompt for context.

The file list displays per-file stats (lines added/removed) with tags for special states (`new`, `deleted`, `untracked`, `binary`, `truncated`, `oversized`). Press Enter on a file to view its inline diff with syntax-highlighted hunks.

Per-turn diffs require file checkpointing to be enabled (on by default in interactive mode). When file checkpointing is off, only the "Current" source is available.

**Keyboard shortcuts:**

| Key       | Action                                      |
| --------- | ------------------------------------------- |
| `←` / `→` | Switch between sources (Current / T1 / T2…) |
| `↑` / `↓` | Navigate file list                          |
| `j` / `k` | Navigate file list (vim-style)              |
| Enter     | View inline diff for selected file          |
| `←` / Esc | Return to file list from inline diff view   |
| Esc       | Close the dialog                            |

**Example:**

```
┌ /diff · Turn 3 "refactor the auth middleware" ──── 3 files +45 -12 ┐
│                                                                     │
│ ◀ Current · T3 · T2 · T1 ▶                                         │
│                                                                     │
│ › src/utils/parser.ts                              +30 -8           │
│   src/utils/parser.test.ts                         +12 -2           │
│   README.md                                        +3 -2            │
│                                                                     │
│ ←/→ source · ↑/↓ file · Enter view · Esc close                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Non-interactive mode:**

In headless (`--prompt`) or non-interactive contexts, `/diff` prints a plain-text summary of the working tree vs HEAD. Per-turn navigation is not available.

```
3 files changed, +45 / -12
  +30  -8  src/utils/parser.ts
  +12  -2  src/utils/parser.test.ts
   +3  -2  README.md
```

### 1.9 Information, Settings, and Help

Commands for obtaining information and performing system settings.

| Command         | Description                                                                                                                                                                                                                                                                                     | Usage Examples                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `/help`         | Display help information for available commands                                                                                                                                                                                                                                                 | `/help` or `/?`                  |
| `/status`       | Display version information                                                                                                                                                                                                                                                                     | `/status` or `/about`            |
| `/status paths` | Display current session file and log paths                                                                                                                                                                                                                                                      | `/status paths`                  |
| `/stats`        | Open interactive usage statistics dashboard with three tabs: Session (live metrics), Activity (heatmap, token trend, project ranking), and Efficiency (cache rate, tool leaderboard, model comparison). Use `tab` to switch tabs, `r` to cycle time ranges, `←→` to pan months, `esc` to close. | `/stats`                         |
| `/stats model`  | Show per-model token breakdown and estimated cost                                                                                                                                                                                                                                               | `/stats model`                   |
| `/stats tools`  | Show per-tool call counts                                                                                                                                                                                                                                                                       | `/stats tools`                   |
| `/settings`     | Open settings editor                                                                                                                                                                                                                                                                            | `/settings`                      |
| `/auth`         | Change authentication method                                                                                                                                                                                                                                                                    | `/auth`                          |
| `/doctor`       | Run installation and environment diagnostics                                                                                                                                                                                                                                                    | `/doctor`, `/doctor memory`      |
| `/docs`         | Open full Qwen Code documentation in browser                                                                                                                                                                                                                                                    | `/docs`                          |
| `/ide`          | Manage IDE integration                                                                                                                                                                                                                                                                          | `/ide status`, `/ide install`    |
| `/insight`      | Generate programming insights from chat history                                                                                                                                                                                                                                                 | `/insight`                       |
| `/setup-github` | Set up GitHub Actions                                                                                                                                                                                                                                                                           | `/setup-github`                  |
| `/bug`          | Submit issue about Qwen Code                                                                                                                                                                                                                                                                    | `/bug Button click unresponsive` |
| `/copy`         | Copy AI output to clipboard (`/copy N` = Nth-last AI message)                                                                                                                                                                                                                                   | `/copy` or `/copy 2`             |
| `/quit`         | Exit Qwen Code immediately                                                                                                                                                                                                                                                                      | `/quit` or `/exit`               |

### 1.10 Common Shortcuts

| Shortcut           | Function                | Note                   |
| ------------------ | ----------------------- | ---------------------- |
| `Ctrl/cmd+L`       | Clear screen            | Equivalent to `/clear` |
| `Ctrl/cmd+T`       | Toggle tool description | MCP tool management    |
| `Ctrl/cmd+C`×2     | Exit confirmation       | Secure exit mechanism  |
| `Ctrl/cmd+Z`       | Undo input              | Text editing           |
| `Ctrl/cmd+Shift+Z` | Redo input              | Text editing           |

### 1.11 Authentication Commands

Use `/auth` inside a Qwen Code session to configure authentication. Use `/doctor` to inspect the current authentication and environment status.

| Command   | Description                                |
| --------- | ------------------------------------------ |
| `/auth`   | Configure authentication interactively     |
| `/doctor` | Show authentication and environment checks |

> [!note]
>
> The standalone `qwen auth` CLI command has been removed. Legacy invocations such as `qwen auth status` print a removal notice with migration guidance. See the [Authentication](../configuration/auth) page for full details.

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

## 5. CLI Subcommands

These commands are run from the shell as `qwen <subcommand>` before starting an interactive session.

### Session Management

| Command              | Description                       | Usage Examples                                               |
| -------------------- | --------------------------------- | ------------------------------------------------------------ |
| `qwen sessions list` | List recent conversation sessions | `qwen sessions list`, `qwen sessions list --json --limit 50` |

#### `qwen sessions list`

Lists your recent Qwen Code sessions with metadata.

**Flags:**

| Flag      | Type    | Default | Description                                     |
| --------- | ------- | ------- | ----------------------------------------------- |
| `--json`  | boolean | `false` | Output as JSON Lines (one JSON object per line) |
| `--limit` | number  | `20`    | Maximum number of sessions to show              |

**Human-readable output (default):**

A table with columns: SESSION ID, STARTED (UTC timestamp), TITLE, BRANCH, PROMPT.

**JSON output (`--json`):**

Outputs JSON Lines on stdout. Each line is a JSON object with fields:

```
sessionId, startTime, mtime, prompt, gitBranch, customTitle, titleSource, filePath, cwd
```

The "has more sessions" hint is emitted via stderr so piping to `jq` remains safe.

**Examples:**

```bash
# Show last 20 sessions (default)
qwen sessions list

# Show last 50 sessions
qwen sessions list --limit 50

# Output as JSON for scripting
qwen sessions list --json | jq .
```
