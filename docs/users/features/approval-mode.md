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
- **Auto Mode (default)**: The default out-of-the-box experience — an LLM classifier auto-approves safe actions and blocks risky ones, minimizing interruptions while keeping a safety net
- **Switch to Ask Permissions**: When you want manual approval for every file edit and shell command
- **Switch to Auto-Edit**: When you're making lots of safe code changes
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

### Vouching for a custom read-only CLI

Plan Mode decides whether a shell command is read-only by analysing it against
a built-in set of known-safe root commands (`cat`, `ls`, `grep`, `find`,
`git status`, …). A binary outside that set — typically a project-specific CLI
— cannot be judged, so Plan Mode asks for approval, and that approval is
deliberately good for one exact invocation only.

If you have a CLI you know is read-only, list its root command name under
`permissions.planMode.extraReadOnlyCommands`.

In `~/.qwen/settings.json` (root command names only, the same shape as the
built-in set):

```json
{
  "permissions": {
    "planMode": {
      "extraReadOnlyCommands": ["ib"]
    }
  }
}
```

**Where it can be set.** User (`~/.qwen/settings.json`), System, and
SystemDefaults settings only, merged across those scopes. A vouch is a standing instruction to run a
binary unattended, so a project's own `.qwen/settings.json` cannot grant one —
otherwise cloning a repository would be enough to arrange it. Qwen Code warns
if it finds the key in workspace settings, the same way it treats other
security-relevant keys.

**What an entry means.** It vouches for the _entire binary_. Qwen Code cannot
see inside a custom CLI, so if `ib` has mutating sub-commands, listing `ib`
silences the prompt for those too. Only list a command you would be comfortable
letting the model run unattended.

**What still applies.** Everything else about Plan Mode's analysis is unchanged
— a vouched root only replaces the "is this binary known-safe?" question:

| Command with `"ib"` listed  | Result                                                |
| --------------------------- | ----------------------------------------------------- |
| `ib domain list`            | runs without a prompt                                 |
| `ib domain list > out.txt`  | blocked — output redirection is state-modifying       |
| `ib domain list $(whoami)`  | prompts — command substitution stays unknown          |
| `IB_TOKEN=x ib domain list` | prompts — environment-assignment prefix stays unknown |
| `ib domain list \| badcmd`  | prompts — the pipe target is still unknown            |
| `ib exec rm -rf build`      | prompts — see "how a vouch is applied" below          |

**What has no effect.** Four kinds of entry are ignored:

- Commands Qwen Code already understands keep their built-in classification.
  Listing `rm`, `git`, `sed`, or `tee` does not make `rm -rf build` or
  `git push` read-only.
- **Launchers** — shell interpreters, language interpreters, multi-call
  binaries, and wrappers whose job is to run a command taken from their
  arguments (`bash`, `busybox`, `env`, `sudo`, `su`, `xargs`, `watch`,
  `nohup`, `timeout`, `time`, `setsid`, `powershell`, `python3`, `python3.12`,
  `node`, `perl`, `ruby`, `ssh`, and similar). Vouching one of these is not a
  statement about that binary, it is a statement about whatever it is handed:
  `time rm -rf build` and `python3 -c "…"` would launder a write past the
  analysis.
- **Build and package tools** (`make`, `npm`, `npx`, `pnpm`, `yarn`, `cargo`,
  `cmake`, `gcc`, `c++`, `clang`, `rustc`, `javac`, `ninja`, `scons`, `pip`,
  `uv`, `uvx`, `poetry`, `conda`, `gradle`, `mvn`, `docker`, and similar).
  Their payload is a Makefile recipe, a build manifest, a package downloaded
  mid-command, or a plugin the compiler loads — it never appears in the command
  line, so nothing about `make` on its own says what `make` will do.
- **Shell builtins that rebind name resolution or assign variables** (`hash`,
  `alias`, `unalias`, `bind`, `complete`, `enable`, `set`, `shopt`, `read`,
  `getopts`, `mapfile`, and similar). One of these can change what a _later_
  command in the same line resolves to — `hash` would quietly vouch for
  whatever it points `git` at, and `read PATH` for everything after it.

**How a vouch is applied.** Qwen Code cannot recognise every launcher by name,
so the vouch is honoured only for an invocation it can read literally:

- every argument must be a plain word — quoting, escaping, variables, and
  globs are each an open-ended way to spell something else (`r\m`, `r'm'`,
  `$cmd` and `*` all reach the binary as `rm`), so `ib $cmd` prompts;
- no argument may name a command Qwen Code knows, which is why
  `ib exec rm -rf build` prompts even though `ib` is vouched and `ib exec` is
  not otherwise special. `.` and `..` are the exception: as arguments they name
  a directory, not the POSIX spelling of `source`, so `ib list .` is fine.

- no argument may be one of `git`'s redirecting global options (`-C`, `-c`,
  `--git-dir`, `--work-tree`, `--namespace`, `--config-env`, `--exec-path`,
  `--bare`) or a flag that makes a `git` read verb run a helper program
  (`--textconv`, `--filters`, `--show-signature`, `--ext-diff`,
  `--open-files-in-pager`). A vouched command is treated
  as a possible `git` frontend (see below), and these options change which
  repository, which configuration, or which executables `git` uses. The cost is
  a prompt for a CLI that spells its own config flag `-c` or `-C`; ordinary
  flags such as `--json` or `--format=…` are unaffected. The attached
  spellings are refused too, on every vouched invocation rather than only
  `git`-shaped ones — an alias planted through the option makes the first word
  a non-`git` verb, and an invocation of flags alone has no verb at all. What
  is refused is the two shapes those options need: an attached path (`-Cdir`)
  and a single-dash `key=value` (`-ccore.fsmonitor=./evil.sh`, and by the same
  token a CLI's own `-count=5`). Clustered flags without a payload keep
  working, so `-cp` and `-classpath` are unaffected — as long as the
  invocation is not `git`-shaped. When the first non-flag argument is a `git`
  verb, or there is no non-flag argument at all, any single-dash cluster
  carrying a `c` or `C` is refused too, since real `git` accepts no clustered
  global options: `ib -cp status` and a bare `ib -cp` prompt, while
  `ib -cp lib get` does not.

- when the first non-flag argument is any of `git`'s 170 commands, the whole
  invocation is screened by `git`'s own evaluator — the write-verb list, the
  `branch -D` flags, `--output`, and the `%G…` signature formats. A wrapper for
  `git` is a case this setting explicitly supports, so it gets exactly what
  literal `git` gets. The cost is a prompt for a vouched CLI whose own verb
  collides with one of `git`'s, such as `ib add`, `ib tag`, `ib config`, or
  `ib init`. Verbs that collide with a `git` _read_ verb are free: `ib status`
  and `ib log` still run silently.

A vouched command is also treated as a possible `git` frontend. `git diff` and
`git status` are downgraded to a prompt when the repository's own
`.git/config` sets `diff.external` or `core.fsmonitor`, because git then runs a
script the command line never names; a wrapper you vouched for gets the same
treatment, since Qwen Code cannot know which of its verbs reach git. The same applies to any other repository-local
setting that makes a read verb run a program — a `textconv` diff driver, a
clean/smudge filter, the gpg program, or a `!`-prefixed shell alias. In a
repository that plants none of them — the ordinary case — nothing changes.

The cost is an occasional extra prompt — when a CLI's own sub-command shares a
name with a real command, or when an argument needs quoting. Prompting costs a
keystroke; accepting wrongly costs the write.

Anything that is not a bare command name (a path, a command with arguments, or
a string containing shell metacharacters) is also ignored, and so is the whole
setting if it is not a list of strings. Entries are lowercased, and a command
is matched by its exact lowercase name — `MyTool` and `mytool` are different
binaries on Linux, so an invocation spelled with capitals still prompts. A
on Windows a trailing `.exe` is stripped from the _invocation_, so listing
`mytool` covers both `mytool` and `mytool.exe` — they are one file there. On
macOS and Linux they are two different files, and the `.exe` one is a name
nobody legitimately ships, so a vouch for `mytool` does **not** cover
`mytool.exe` and that spelling still prompts. The entry is never stripped on
any platform: listing `mytool.exe` covers only `mytool.exe`. List the bare
name.

**Scope.** This setting applies only in Plan Mode. In every other mode, use
`permissions.allow` (e.g. `"Bash(ib *)"`) to auto-approve a command.

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
      // Optional: route ALL shell commands (including read-only ones like
      // ls, cat) through the classifier for defense-in-depth.
      // "classifyAllShell": true,
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
