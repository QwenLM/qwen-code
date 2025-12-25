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
| `/restore`  | Restore files to state before tool execution              | `/restore` (list) or `/restore <ID>` |

### 1.2 Interface and Workspace Control

Commands for adjusting interface appearance and work environment.

| Command      | Description                              | Usage Examples                |
| ------------ | ---------------------------------------- | ----------------------------- |
| `/clear`     | Clear terminal screen content            | `/clear` (shortcut: `Ctrl+L`) |
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

- Available UI languages: `zh-CN` (Simplified Chinese), `en-US` (English)
- Output language examples: `Chinese`, `English`, `Japanese`, etc.

### 1.4 Tool and Model Management

Commands for managing AI tools and models.

| Command          | Description                                   | Usage Examples                                |
| ---------------- | --------------------------------------------- | --------------------------------------------- |
| `/mcp`           | List configured MCP servers and tools         | `/mcp`, `/mcp desc`                           |
| `/tools`         | Display currently available tool list         | `/tools`, `/tools desc`                       |
| `/approval-mode` | Change approval mode for tool usage           | `/approval-mode <mode (auto-edit)> --project` |
| →`plan`          | Analysis only, no execution                   | Secure review                                 |
| →`default`       | Require approval for edits                    | Daily use                                     |
| →`auto-edit`     | Automatically approve edits                   | Trusted environment                           |
| →`yolo`          | Automatically approve all                     | Quick prototyping                             |
| `/model`         | Switch model used in current session          | `/model`                                      |
| `/extensions`    | List all active extensions in current session | `/extensions`                                 |
| `/memory`        | Manage AI's instruction context               | `/memory add Important Info`                  |

### 1.5 Information, Settings, and Help

Commands for obtaining information and performing system settings.

| Command         | Description                                     | Usage Examples                                   |
| --------------- | ----------------------------------------------- | ------------------------------------------------ |
| `/help`         | Display help information for available commands | `/help` or `/?`                                  |
| `/about`        | Display version information                     | `/about`                                         |
| `/stats`        | Display detailed statistics for current session | `/stats`                                         |
| `/settings`     | Open settings editor                            | `/settings`                                      |
| `/auth`         | Change authentication method                    | `/auth`                                          |
| `/bug`          | Submit issue about Qwen Code                    | `/bug Button click unresponsive`                 |
| `/copy`         | Copy last output content to clipboard           | `/copy`                                          |
| `/quit-confirm` | Show confirmation dialog before quitting        | `/quit-confirm` (shortcut: press `Ctrl+C` twice) |
| `/quit`         | Exit Qwen Code immediately                      | `/quit` or `/exit`                               |

### 1.6 Common Shortcuts

| Shortcut           | Function                | Note                   |
| ------------------ | ----------------------- | ---------------------- |
| `Ctrl/cmd+L`       | Clear screen            | Equivalent to `/clear` |
| `Ctrl/cmd+T`       | Toggle tool description | MCP tool management    |
| `Ctrl/cmd+C`×2     | Exit confirmation       | Secure exit mechanism  |
| `Ctrl/cmd+Z`       | Undo input              | Text editing           |
| `Ctrl/cmd+Shift+Z` | Redo input              | Text editing           |

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

### Quick Overview

| Function         | Description                                | Advantages                             | Priority | Applicable Scenarios                                 |
| ---------------- | ------------------------------------------ | -------------------------------------- | -------- | ---------------------------------------------------- |
| Namespace        | Subdirectory creates colon-named commands  | Better command organization            |          |                                                      |
| Global Commands  | `~/.qwen/commands/`                        | Available in all projects              | Low      | Personal frequently used commands, cross-project use |
| Project Commands | `<project root directory>/.qwen/commands/` | Project-specific, version-controllable | High     | Team sharing, project-specific commands              |

Priority Rules: Project commands > User commands (project command used when names are same)

### Command Naming Rules

#### File Path to Command Name Mapping Table

| File Location                | Generated Command | Example Call          |
| ---------------------------- | ----------------- | --------------------- |
| `~/.qwen/commands/test.toml` | `/test`           | `/test Parameter`     |
| `<project>/git/commit.toml`  | `/git:commit`     | `/git:commit Message` |

Naming Rules: Path separator (`/` or `\`) converted to colon (`:`)

### TOML File Format Specification

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

```
# git/commit.toml
description = "Generate Commit message based on staged changes"
prompt = """
Please generate a Commit message based on the following diff:
diff
!{git diff --staged}
"""
```

#### 4. File Content Injection (`@{...}`)

| File Type    | Support Status         | Processing Method           |
| ------------ | ---------------------- | --------------------------- |
| Text Files   | ✅ Full Support        | Directly inject content     |
| Images/PDF   | ✅ Multi-modal Support | Encode and inject           |
| Binary Files | ⚠️ Limited Support     | May be skipped or truncated |
| Directory    | ✅ Recursive Injection | Follow .gitignore rules     |

Example: Code Review Command

```
# review.toml
description = "Code review based on best practices"
prompt = """
Review {{args}}, reference standards:

@{docs/code-standards.md}
"""
```

### Practical Creation Example

#### "Pure Function Refactoring" Command Creation Steps Table

| Operation                     | Command/Code                                |
| ----------------------------- | ------------------------------------------- |
| 1. Create directory structure | `mkdir -p ~/.qwen/commands/refactor`        |
| 2. Create command file        | `touch ~/.qwen/commands/refactor/pure.toml` |
| 3. Edit command content       | Refer to the complete code below.           |
| 4. Test command               | `@file.js` → `/refactor:pure`               |

```# ~/.qwen/commands/refactor/pure.toml
description = "Refactor code to pure function"
prompt = """
	Please analyze code in current context, refactor to pure function.
	Requirements:
		1. Provide refactored code
		2. Explain key changes and pure function characteristic implementation
		3. Maintain function unchanged
	"""
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
