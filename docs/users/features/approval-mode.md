Qwen Code offers three distinct permission modes that allow you to flexibly control how AI interacts with your code and system based on task complexity and risk level.

## Permission Modes Comparison

| Mode           | File Editing                | Shell Commands              | Best For                                                                                               | Risk Level |
| -------------- | --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| **Plan**​      | ❌ Read-only analysis only  | ❌ Not executed             | • Code exploration <br>• Planning complex changes <br>• Safe code review                               | Lowest     |
| **Default**​   | ✅ Manual approval required | ✅ Manual approval required | • New/unfamiliar codebases <br>• Critical systems <br>• Team collaboration <br>• Learning and teaching | Low        |
| **Auto-Edit**​ | ✅ Auto-approved            | ❌ Manual approval required | • Daily development tasks <br>• Refactoring and code improvements <br>• Safe automation                | Medium     |
| **YOLO**​      | ✅ Auto-approved            | ✅ Auto-approved            | • Trusted personal projects <br>• Automated scripts/CI/CD <br>• Batch processing tasks                 | Highest    |

### Quick Reference Guide

- **Start in Plan Mode**: Great for understanding before making changes
- **Work in Default Mode**: The balanced choice for most development work
- **Switch to Auto-Edit**: When you're making lots of safe code changes
- **Use YOLO sparingly**: Only for trusted automation in controlled environments

> [!tip]
>
> You can quickly cycle through modes during a session using **Shift+Tab**. The terminal status bar shows your current mode, so you always know what permissions Qwen Code has.

## 1. Use Plan Mode for safe code analysis

Plan Mode instructs Qwen Code to create a plan by analyzing the codebase with **read-only** operations, perfect for exploring codebases, planning complex changes, or reviewing code safely.

### When to use Plan Mode

- **Multi-step implementation**: When your feature requires making edits to many files
- **Code exploration**: When you want to research the codebase thoroughly before changing anything
- **Interactive development**: When you want to iterate on the direction with Qwen Code

### How to use Plan Mode

**Turn on Plan Mode during a session**

You can switch into Plan Mode during a session using **Shift+Tab** to cycle through permission modes.

If you are in Normal Mode, **Shift+Tab** first switches into `auto-edits` Mode, indicated by `⏵⏵ accept edits on` at the bottom of the terminal. A subsequent **Shift+Tab** will switch into Plan Mode, indicated by `⏸ plan mode`.

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
/approval-mode plan
```

```
I need to refactor our authentication system to use OAuth2. Create a detailed migration plan.
```

Qwen Code analyzes the current implementation and create a comprehensive plan. Refine with follow-ups:

```
What about backward compatibility?
How should we handle database migration?
```

### Configure Plan Mode as default

```json
// .qwen/settings.json
{
  "permissions": {
    "defaultMode": "plan"
  }
}
```

## 2. Use Default Mode for Controlled Interaction

Default Mode is the standard way to work with Qwen Code. In this mode, you maintain full control over all potentially risky operations - Qwen Code will ask for your approval before making any file changes or executing shell commands.

### When to use Default Mode

- **New to a codebase**: When you're exploring an unfamiliar project and want to be extra cautious
- **Critical systems**: When working on production code, infrastructure, or sensitive data
- **Learning and teaching**: When you want to understand each step Qwen Code is taking
- **Team collaboration**: When multiple people are working on the same codebase
- **Complex operations**: When the changes involve multiple files or complex logic

### How to use Default Mode

**Turn on Default Mode during a session**

You can switch into Default Mode during a session using **Shift+Tab**​ to cycle through permission modes. If you're in any other mode, pressing **Shift+Tab**​ will eventually cycle back to Default Mode, indicated by the absence of any mode indicator at the bottom of the terminal.

**Start a new session in Default Mode**

Default Mode is the initial mode when you start Qwen Code. If you've changed modes and want to return to Default Mode, use:

```
/approval-mode default
```

**Run "headless" queries in Default Mode**

When running headless commands, Default Mode is the default behavior. You can explicitly specify it with:

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

### Configure Default Mode as default

```bash
// .qwen/settings.json
{
  "permissions": {
"defaultMode": "default"
  }
}
```

## 3. Auto Edits Mode

Auto-Edit Mode instructs Qwen Code to automatically approve file edits while requiring manual approval for shell commands, ideal for accelerating development workflows while maintaining system safety.

### When to use Auto-Accept Edits Mode

- **Daily development**: Ideal for most coding tasks
- **Safe automation**: Allows AI to modify code while preventing accidental execution of dangerous commands
- **Team collaboration**: Use in shared projects to avoid unintended impacts on others

### How to switch to this mode

```
# Switch via command
/approval-mode auto-edit

# Or use keyboard shortcut
Shift+Tab  # Switch from other modes
```

### Workflow Example

1. You ask Qwen Code to refactor a function
2. AI analyzes the code and proposes changes
3. **Automatically**​ applies all file changes without confirmation
4. If tests need to be run, it will **request approval**​ to execute `npm test`

## 4. YOLO Mode - Full Automation

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
  "permissions": {
"defaultMode": "yolo",
"confirmShellCommands": false,
"confirmFileEdits": false
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

During a Qwen Code session, use **Shift+Tab**​ to quickly cycle through the three modes:

```
Default Mode → Auto-Edit Mode → YOLO Mode → Plan Mode → Default Mode
```

### Persistent Configuration

```
// Project-level: ./.qwen/settings.json
// User-level: ~/.qwen/settings.json
{
  "permissions": {
"defaultMode": "auto-edit",  // or "plan" or "yolo"
"confirmShellCommands": true,
"confirmFileEdits": true
  }
}
```

### Mode Usage Recommendations

1. **New to codebase**: Start with **Plan Mode**​ for safe exploration
2. **Daily development tasks**: Use **Auto-Accept Edits**​ (default mode), efficient and safe
3. **Automated scripts**: Use **YOLO Mode**​ in controlled environments for full automation
4. **Complex refactoring**: Use **Plan Mode**​ first for detailed planning, then switch to appropriate mode for execution
