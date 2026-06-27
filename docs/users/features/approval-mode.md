# Approval Mode

Qwen Code offers five distinct permission modes that allow you to flexibly control how AI interacts with your code and system based on task complexity and risk level.

## Permission Modes Comparison

| Mode                 | File Editing                | Shell Commands              | Best For                                                                                               | Risk Level |
| -------------------- | --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| **Plan**​            | ❌ Read-only analysis only  | ❌ Not executed             | • Code exploration <br>• Planning complex changes <br>• Safe code review                               | Lowest     |
| **Ask Permissions**​ | ✅ Manual approval required | ✅ Manual approval required | • New/unfamiliar codebases <br>• Critical systems <br>• Team collaboration <br>• Learning and teaching | Low        |
| **Auto-Edit**​       | ✅ Auto-approved            | ❌ Manual approval required | • Daily development tasks <br>• Refactoring and code improvements <br>• Safe automation                | Medium     |
| **Auto**​            | ✅ Classifier-evaluated     | ✅ Classifier-evaluated     | • Long autonomous sessions <br>• When Auto-Edit is too cautious but YOLO is too risky                  | Medium     |
| **YOLO**​            | ✅ Auto-approved            | ✅ Auto-approved            | • Trusted personal projects <br>• Automated scripts/CI/CD <br>• Batch processing tasks                 | Highest    |

> [!NOTE]
>
> The mode previously named **Default** has been renamed to **Ask Permissions** to better describe its behavior. The underlying configuration value (`tools.approvalMode: "default"`) and the `/approval-mode default` command are unchanged for backward compatibility.

### Quick Reference Guide

- **Start in Plan Mode**: Great for understanding before making changes
- **Work in Ask Permissions Mode**: The balanced choice for most development work
- **Switch to Auto-Edit**: When you're making lots of safe code changes
- **Try Auto Mode**: When you want fewer interruptions but still want safety on shell commands and network calls — an LLM classifier evaluates each call
- **Use YOLO sparingly**: Only for trusted automation in controlled environments

> [!tip]
>
> You can quickly cycle through modes during a session using **Shift+Tab** (or **Tab** on Windows). The terminal status bar shows your current mode, so you always know what permissions Qwen Code has.

> The cycle order is: **plan → default → auto-edit → auto → yolo → plan → ...**

## 1. Use Plan Mode for safe code analysis

Plan Mode instructs Qwen Code to create a plan by analyzing the codebase with **read-only** operations, perfect for exploring codebases, planning complex changes, or reviewing code safely.

### When to use Plan Mode

- **Multi-step implementation**: When your feature requires making edits to many files
- **Code exploration**: When you want to research the codebase thoroughly before changing anything
- **Interactive development**: When you want to iterate on the direction with Qwen Code

### How to use Plan Mode

**Turn on Plan Mode during a session**

You can switch into Plan Mode during a session using **Shift+Tab** (or **Tab** on Windows) to cycle through permission modes.

If you are in Normal Mode, **Shift+Tab** (or **Tab** on Windows) first switches into `auto-edits` Mode, indicated by `⏵⏵ accept edits on` at the bottom of the terminal. A subsequent **Shift+Tab** (or **Tab** on Windows) will switch into Plan Mode, indicated by `⏸ plan mode`.

**Use the `/plan` command**

The `/plan` command provides a quick shortcut for entering and exiting Plan Mode:

Regular planning requests do not switch modes by themselves. If you want the read-only Plan Mode workflow, use `/plan`, the keyboard shortcut, or set the approval mode to `plan` explicitly.

```bash
/plan                          # Enter plan mode
/plan refactor the auth module # Enter plan mode and start planning
/plan exit                     # Exit plan mode, restore previous mode
```

When you exit Plan Mode with `/plan exit`, your previous approval mode is automatically restored (e.g., if you were in Auto-Edit before entering Plan Mode, you'll return to Auto-Edit).

**Start a new session in Plan Mode**

To start a new session in Plan Mode, use the `/approval-mode` then select `plan`

```bash
/approval-mode
```

**Run "headless" queries in Plan Mode**

You can also run a query in Plan Mode directly with `-p` or `prompt`:

```bash
qwen --prompt "What is machine learning?"
```

### Example: Planning a complex refactor

```bash
/plan I need to refactor our authentication system to use OAuth2. Create a detailed migration plan.
```

Qwen Code enters Plan Mode and analyzes the current implementation to create a comprehensive plan. Refine with follow-ups:

```
What about backward compatibility?
How should we handle database migration?
```

### Configure Plan Mode as default

```json
// .qwen/settings.json
{
  "tools": {
    "approvalMode": "plan"
  }
}
```

## 2. Use Ask Permissions Mode for Controlled Interaction

Ask Permissions Mode is the standard way to work with Qwen Code. In this mode, you maintain full control over all potentially risky operations - Qwen Code will ask for your approval before making any file changes or executing shell commands.

### When to use Ask Permissions Mode

- **New to a codebase**: When you're exploring an unfamiliar project and want to be extra cautious
- **Critical systems**: When working on production code, infrastructure, or sensitive data
- **Learning and teaching**: When you want to understand each step Qwen Code is taking
- **Team collaboration**: When multiple people are working on the same codebase
- **Complex operations**: When the changes involve multiple files or complex logic

### How to use Ask Permissions Mode

**Turn on Ask Permissions Mode during a session**

You can switch into Ask Permissions Mode during a session using **Shift+Tab**​ (or **Tab** on Windows) to cycle through permission modes. If you're in any other mode, pressing **Shift+Tab** (or **Tab** on Windows) will eventually cycle back to Ask Permissions Mode, indicated by the absence of any mode indicator at the bottom of the terminal.

**Start a new session in Ask Permissions Mode**

Ask Permissions Mode is the initial mode when you start Qwen Code. If you've changed modes and want to return to Ask Permissions Mode, use:

```
/approval-mode default
```

**Run "headless" queries in Ask Permissions Mode**

When running headless commands, Ask Permissions Mode is the default behavior. You can explicitly specify it with:

```
qwen --prompt "Analyze this code for potential bugs"
```

### Example: Safely implementing a feature

```
/approval-mode default
```

```
I need to add user profile pictures to our application. The pictures should be stored in an S3 bucket and the URLs saved in the database.
```

Qwen Code will analyze your codebase and propose a plan. It will then ask for approval before:

1. Creating new files (controllers, models, migrations)
2. Modifying existing files (adding new columns, updating APIs)
3. Running any shell commands (database migrations, dependency installation)

You can review each proposed change and approve or reject it individually.

### Configure Ask Permissions Mode as default

```bash
// .qwen/settings.json
{
  "tools": {
    "approvalMode": "default"
  }
}
```

## 3. Auto Edits Mode

Auto-Edit Mode instructs Qwen Code to automatically approve file edits while requiring manual approval for shell commands, ideal for accelerating development workflows while maintaining system safety.

Auto-approved edit tools include `edit`, `write_file`, and `notebook_edit`.

### When to use Auto-Accept Edits Mode

- **Daily development**: Ideal for most coding tasks
- **Safe automation**: Allows AI to modify code while preventing accidental execution of dangerous commands
- **Team collaboration**: Use in shared projects to avoid unintended impacts on others

### How to switch to this mode

```
# Switch via command
/approval-mode auto-edit

# Or use keyboard shortcut
Shift+Tab (or Tab on Windows) # Switch from other modes
```

### Workflow Example

1. You ask Qwen Code to refactor a function
2. AI analyzes the code and proposes changes
3. **Automatically**​ applies all file changes without confirmation
4. If tests need to be run, it will **request approval**​ to execute `npm test`

## 4. Auto Mode - Classifier-Driven Approval

Auto Mode sits between Auto-Edit and YOLO. An LLM classifier evaluates each
shell command, network call, and out-of-workspace edit and auto-approves
the ones it judges safe while blocking risky ones. Most read-only operations
and in-workspace edits skip the classifier for speed.

See [auto-mode.md](./auto-mode.md) for the full reference (hints
configuration, troubleshooting, FAQ).

### When to use Auto Mode

- **Long autonomous sessions**: When Ask Permissions Mode interrupts too often but
  YOLO is too risky.
- **Trusted projects**: Internal codebases where the agent should keep
  moving but you still want a guardrail on destructive shell commands and
  outbound network calls.
- **Headless / scheduled runs**: Where Auto-Edit isn't enough (the agent
  needs to run shell commands too) but you want safety on `rm -rf /`,
  `curl ... | sh`, credential exfiltration, etc.

### How to use Auto Mode

**Turn on Auto Mode during a session**

Press **Shift+Tab** (or **Tab** on Windows) to cycle into Auto Mode. The
status bar shows the active mode.

**Use the `/approval-mode` command**

```
/approval-mode auto
```

The first time you enter Auto Mode, an information message explains how it
works. The notice does not appear again.

**Start a new session in Auto Mode**

```jsonc
// .qwen/settings.json
{
  "tools": {
    "approvalMode": "auto",
  },
}
```

### What Auto Mode auto-approves vs blocks

The classifier is biased toward blocking when uncertain. Defaults:

- **Auto-approved**: read-only commands (ls, cat, git status, grep, find),
  package install in cwd, build/test commands, file edits inside the
  workspace, local-only operations.
- **Blocked**: irreversible destruction (rm -rf /, fdisk, mkfs),
  code-from-external execution (curl | sh, eval of remote content),
  credential exfiltration, unauthorized persistence (.bashrc edits,
  crontab), security weakening, force-push to main/master.

You can customize the classifier's judgement via natural-language hints in
settings.json. See [auto-mode.md](./auto-mode.md#configuring-hints).

### Safety guardrails

- **Hard rules remain in force**: `permissions.deny` rules block actions
  before the classifier ever runs.
- **Over-broad allow rules are stripped while in Auto Mode**: e.g.
  `permissions.allow: ["Bash"]` (allow every shell command) defeats the
  classifier; entering Auto Mode temporarily disables such rules so the
  classifier can do its job. The rules are restored when you leave Auto
  Mode. Settings on disk are never modified.
- **Fail-closed**: when the classifier API is unreachable, the action is
  blocked rather than allowed. After two consecutive unavailable calls,
  the next tool call falls back to manual approval.
- **Loop guard**: after three consecutive policy blocks, the next call
  also falls back to manual approval so the agent isn't stuck cycling on
  a dead-end approach.

### Example

```
/approval-mode auto
Refactor the auth module to use OAuth2. Run the full test suite afterwards.
```

Qwen Code makes the file edits (in-workspace edits skip the classifier),
runs `npm test` (classifier judges safe), and surfaces a block if it ever
tries something risky like `rm -rf /Users/me/.aws`. You can review the
reason inline and decide whether to switch to Ask Permissions Mode for that step.

### Configure Auto Mode as default

```jsonc
// .qwen/settings.json
{
  "tools": {
    "approvalMode": "auto",
  },
  "permissions": {
    "autoMode": {
      "hints": {
        "allow": ["Running pytest, mypy, and ruff on this Python repo"],
        "deny": ["Any network call to intranet.example.com"],
      },
      "environment": ["Open-source monorepo; commits are signed"],
    },
  },
}
```

## 5. YOLO Mode - Full Automation

YOLO Mode grants Qwen Code the highest permissions, automatically approving all tool calls including file editing and shell commands.

### When to use YOLO Mode

- **Automated scripts**: Running predefined automated tasks
- **CI/CD pipelines**: Automated execution in controlled environments
- **Personal projects**: Rapid iteration in fully trusted environments
- **Batch processing**: Tasks requiring multi-step command chains

> [!warning]
>
> **Use YOLO Mode with caution**: AI can execute any command with your terminal permissions. Ensure:
>
> 1. You trust the current codebase
> 2. You understand all actions AI will perform
> 3. Important files are backed up or committed to version control

### How to enable YOLO Mode

```
# Temporarily enable (current session only)
/approval-mode yolo

# Set as project default
/approval-mode yolo --project

# Set as user global default
/approval-mode yolo --user
```

### Configuration Example

```bash
// .qwen/settings.json
{
  "tools": {
    "approvalMode": "yolo"
  }
}
```

### Automated Workflow Example

```bash
# Fully automated refactoring task
qwen --prompt "Run the test suite, fix all failing tests, then commit changes"

# Without human intervention, AI will:
# 1. Run test commands (auto-approved)
# 2. Fix failed test cases (auto-edit files)
# 3. Execute git commit (auto-approved)
```

## Mode Switching & Configuration

### Keyboard Shortcut Switching

During a Qwen Code session, use **Shift+Tab**​ (or **Tab** on Windows) to quickly cycle through the five modes:

```
Plan Mode → Ask Permissions Mode → Auto-Edit Mode → Auto Mode → YOLO Mode → Plan Mode
```

### Persistent Configuration

```
// Project-level: ./.qwen/settings.json
// User-level: ~/.qwen/settings.json
{
  "tools": {
    "approvalMode": "auto-edit"  // or "plan", "default", "auto", "yolo"
  }
}
```

### Mode Usage Recommendations

1. **New to codebase**: Start with **Plan Mode**​ for safe exploration
2. **Daily development tasks**: Use **Auto-Accept Edits**​ (default mode), efficient and safe
3. **Automated scripts**: Use **YOLO Mode**​ in controlled environments for full automation
4. **Complex refactoring**: Use **Plan Mode**​ first for detailed planning, then switch to appropriate mode for execution
