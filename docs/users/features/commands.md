# Commands

This page documents Qwen Code's built-in command surface and the other command
prefixes available in the CLI.

Qwen Code supports three command styles:

| Prefix Type                | Purpose                                           | Typical Use Case                                                 |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Slash Commands (`/`)       | Control Qwen Code itself                          | Managing sessions, settings, integrations, and built-in features |
| At Commands (`@`)          | Inject local files or directories into the prompt | Asking Qwen Code to inspect specific files or folders            |
| Exclamation Commands (`!`) | Run shell commands                                | Executing `git status`, `ls`, test commands, and other shell ops |

> [!note]
>
> The exact slash-command list shown by `/help` can include more than the
> built-ins on this page. Qwen Code also loads custom commands, extension
> commands, MCP prompt commands, and bundled skill commands.

## 1. Slash Commands (`/`)

### 1.1 Session, History, and Exports

| Command     | Description                                                        | Usage Examples                |
| ----------- | ------------------------------------------------------------------ | ----------------------------- |
| `/init`     | Analyze the current directory and create an initial context file   | `/init`                       |
| `/summary`  | Generate a project summary from the current conversation           | `/summary`                    |
| `/compress` | Summarize chat history to free context window space                | `/compress`                   |
| `/resume`   | Open the session picker and resume a previous session              | `/resume`                     |
| `/restore`  | List or restore checkpointed file states from earlier tool actions | `/restore`, `/restore <id>`   |
| `/export`   | Export the current session to a file                               | `/export md`, `/export jsonl` |

`/export` supports these built-in subcommands:

- `html`
- `md`
- `json`
- `jsonl`

### 1.2 Workspace, UI, and Language

| Command      | Description                                             | Usage Examples                        |
| ------------ | ------------------------------------------------------- | ------------------------------------- |
| `/clear`     | Clear the screen (`/reset` and `/new` are aliases)      | `/clear`                              |
| `/directory` | Manage extra workspace directories (`/dir` is an alias) | `/dir add ./src,./tests`, `/dir show` |
| `/docs`      | Open the full Qwen Code documentation in your browser   | `/docs`                               |
| `/editor`    | Open the preferred-editor picker                        | `/editor`                             |
| `/language`  | Show current UI/output language or change it            | `/language`, `/language ui zh-CN`     |
| `/settings`  | Open the settings editor                                | `/settings`                           |
| `/theme`     | Change the active CLI theme                             | `/theme`                              |
| `/vim`       | Toggle Vim editing mode for the input prompt            | `/vim`                                |

`/language` supports:

- `ui <language>` to change the CLI language
- `output <language>` to change the model output language

### 1.3 Tools, Skills, Models, and Automation

| Command          | Description                                                            | Usage Examples                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| `/approval-mode` | Show the approval dialog or set the current session's approval mode    | `/approval-mode`, `/approval-mode auto-edit`     |
| `/agents`        | Manage subagents for specialized task delegation                       | `/agents create`, `/agents manage`               |
| `/extensions`    | Manage extensions in the current session                               | `/extensions`, `/extensions install owner/repo`  |
| `/hooks`         | List hooks or enable/disable a configured hook for the current session | `/hooks`, `/hooks enable my-hook`                |
| `/mcp`           | Open the MCP management dialog                                         | `/mcp`                                           |
| `/memory`        | Show or add memory entries                                             | `/memory show`, `/memory add --project Use pnpm` |
| `/model`         | Switch the current model                                               | `/model`                                         |
| `/skills`        | List available skills or explicitly invoke one by name                 | `/skills`, `/skills docs-audit-and-refresh`      |
| `/review`        | Run the bundled `review` skill directly as a slash command             | `/review`, `/review 123`                         |
| `/tools`         | List available built-in tools, optionally with descriptions            | `/tools`, `/tools desc`                          |

`/approval-mode` accepts these modes:

- `plan`
- `default`
- `auto-edit`
- `yolo`

`/extensions` supports:

- `manage`
- `install <source>`
- `explore <Gemini|ClaudeCode>`

`/hooks` supports:

- `list`
- `enable <hook-name>`
- `disable <hook-name>`

`/memory` supports:

- `show`
- `show --project`
- `show --global`
- `add [--project|--global] <text>`

> [!note]
>
> `/review` is a bundled skill shipped with Qwen Code. For other skills, use
> `/skills <skill-name>` or let the model invoke a skill automatically when it
> matches your request. See [Skills](./skills).

### 1.4 Integrations and Setup

| Command           | Description                                                                           | Usage Examples    |
| ----------------- | ------------------------------------------------------------------------------------- | ----------------- |
| `/auth`           | Configure authentication (`/login` is an alias)                                       | `/auth`           |
| `/ide`            | Manage IDE integration; available subcommands depend on connection state and platform | `/ide status`     |
| `/permissions`    | Open the folder-trust dialog for the current folder                                   | `/permissions`    |
| `/setup-github`   | Download and configure GitHub Action workflow files for Qwen Code automation          | `/setup-github`   |
| `/terminal-setup` | Configure multiline terminal keybindings for supported editors                        | `/terminal-setup` |

`/ide` can expose:

- `status`
- `install`
- `enable`
- `disable`

> [!note]
>
> `/permissions` is only available when folder trust is enabled for the current
> session. See [Trusted Folders](../configuration/trusted-folders).

> [!note]
>
> `/ide` is environment-dependent. In unsupported environments it reports that
> IDE integration is unavailable instead of opening the normal management flow.
> See [IDE Integration](../ide-integration/ide-integration).

### 1.5 Information and Diagnostics

| Command    | Description                                                     | Usage Examples           |
| ---------- | --------------------------------------------------------------- | ------------------------ |
| `/bug`     | Open the bug-report flow                                        | `/bug Terminal froze`    |
| `/copy`    | Copy the last output to the clipboard                           | `/copy`                  |
| `/help`    | Show help and available slash commands (`/?` is an alias)       | `/help`, `/?`            |
| `/insight` | Generate a personalized insight report from your chat history   | `/insight`               |
| `/quit`    | Exit Qwen Code (`/exit` is an alias)                            | `/quit`, `/exit`         |
| `/stats`   | Show session statistics, model usage, or tool usage             | `/stats`, `/stats tools` |
| `/status`  | Show version and environment information (`/about` is an alias) | `/status`, `/about`      |

`/stats` supports:

- `model`
- `tools`

### 1.6 Common Shortcuts

For the full list, see [Keyboard Shortcuts](../reference/keyboard-shortcuts).

| Shortcut | Function                   | Note                                |
| -------- | -------------------------- | ----------------------------------- |
| `Ctrl+C` | Cancel the current request | Press twice to exit the application |
| `Ctrl+D` | Exit if the input is empty | Press twice to confirm              |
| `Ctrl+L` | Clear the screen           | Equivalent to `/clear`              |
| `Ctrl+T` | Toggle tool descriptions   | Useful when browsing tool lists     |
| `?`      | Open keyboard shortcuts    | Only when the input is empty        |
| `!`      | Toggle shell mode          | Only when the input is empty        |

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
