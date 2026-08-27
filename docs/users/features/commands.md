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
| `/summary`       | Generate project summary based on conversation history                   | `/summary` or `/summary docs/my-summary.md`                   |
| `/compress`      | Replace chat history with summary to save Tokens                         | `/compress` or `/summarize`                                   |
| `/compress-fast` | Fast compression without AI — strips old tool outputs and thinking parts | `/compress-fast`                                              |
| `/resume`        | Resume a previous conversation session                                   | `/resume` or `/continue`                                      |
| `/recap`         | Generate a one-line session recap now                                    | `/recap`                                                      |
| `/restore`       | Revert project files to the checkpoint before a tool call ran            | `/restore` (list) or `/restore <ID>`                          |
| `/delete`        | Delete a previous session                                                | `/delete`                                                     |
| `/branch`        | Fork the current conversation into a new session                         | `/branch`                                                     |
| `/fork`          | Spawn a background agent that inherits the full conversation             | `/fork <directive>`                                           |
| `/rewind`        | Rewind conversation to a previous turn                                   | `/rewind` or `/rollback`                                      |
| `/export`        | Export session history to file                                           | `/export html`, `/export md`, `/export json`, `/export jsonl` |
| `/rename`        | Rename or tag the current session                                        | `/rename My Feature` or `/tag`                                |

> [!note]
>
> `/summarize` is an alias for `/compress` (it compresses chat history — a destructive operation). To generate a non-destructive project summary instead, use `/summary`.

> [!note]
>
> `/summary` accepts an optional `[path]` argument to save the summary to a custom location within the project root. Without an argument, it saves to `.qwen/PROJECT_SUMMARY.md`. Custom-path summaries are not detected by the welcome-back flow (`ui.enableWelcomeBack`), which only reads the default `.qwen/PROJECT_SUMMARY.md` location.

### 1.2 Interface and Workspace Control

Commands for adjusting interface appearance and work environment.

| Command              | Description                                                                                                                                                                       | Usage Examples                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/clear`             | Clear conversation history and free up context                                                                                                                                    | `/clear`, `/reset`, `/new`                                                        |
| `/context`           | Show context window usage breakdown                                                                                                                                               | `/context`                                                                        |
| → `detail`           | Show per-item context usage breakdown                                                                                                                                             | `/context detail`                                                                 |
| `/history`           | Control history display preferences and visibility                                                                                                                                | `/history collapse-on-resume`, `/history expand-on-resume`, `/history expand-now` |
| `/diff`              | Open an interactive diff viewer showing uncommitted changes and per-turn diffs. Use ←/→ to switch between current git diff and individual conversation turns, ↑/↓ to browse files | `/diff`                                                                           |
| `/log`               | Open a commit history viewer for the workspace (Web Shell only)                                                                                                                   | `/log`                                                                            |
| `/theme`             | Change Qwen Code visual theme                                                                                                                                                     | `/theme`                                                                          |
| `/vim`               | Turn input area Vim editing mode on/off                                                                                                                                           | `/vim`                                                                            |
| `/voice`             | Toggle voice dictation input                                                                                                                                                      | `/voice`, `/voice hold`, `/voice tap`, `/voice off`, `/voice status`              |
| `/directory`         | Manage multi-directory support workspace                                                                                                                                          | `/dir add ./src,./tests`, `/dir show`                                             |
| `/cd`                | Move this session to a new working directory                                                                                                                                      | `/cd ../other-project`                                                            |
| `/editor`            | Open dialog to select supported editor                                                                                                                                            | `/editor`                                                                         |
| `/statusline`        | Open interactive [status line](./status-line.md) preset dialog                                                                                                                    | `/statusline`                                                                     |
| `/statusline <text>` | Generate a command-mode [status line](./status-line.md) via agent                                                                                                                 | `/statusline show model and git branch`                                           |
| `/terminal-setup`    | Configure terminal keybindings for multiline input                                                                                                                                | `/terminal-setup`                                                                 |

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

| Command               | Description                                                                           | Usage Examples                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/mcp`                | List configured MCP servers and tools                                                 | `/mcp`, `/mcp desc`, `/mcp nodesc`, `/mcp schema`                                                         |
| `/import-config`      | Import MCP servers from Claude configs                                                | `/import-config all`, `/import-config claude-code`, `/import-config claude-desktop --scope user\|project` |
| `/tools`              | Display currently available tool list                                                 | `/tools`, `/tools desc`                                                                                   |
| `/skills`             | Open the Skills panel to browse, search, toggle, and launch skills                    | `/skills`, `/<skill-name>`                                                                                |
| `/learn`              | Create a reusable project skill from a file, directory, URL, video, or text           | `/learn https://docs.example.com/api`, `/learn ./tutorial.mp4 focus on deployment`                        |
| `/curator`            | Inspect, pin, archive, or restore inactive project auto-skills                        | `/curator`, `/curator run --dry-run`, `/curator pin <directory>`, `/curator restore <directory>`          |
| `/plan`               | Switch to plan mode or exit plan mode                                                 | `/plan`, `/plan <task>`, `/plan exit`                                                                     |
| `/approval-mode`      | Change the tool-approval mode (current session only)                                  | `/approval-mode`, `/approval-mode auto-edit`                                                              |
| → `plan`              | Analysis only, no execution (secure review)                                           | `/approval-mode plan`                                                                                     |
| → `default`           | Require approval for edits (daily use)                                                | `/approval-mode default`                                                                                  |
| → `auto-edit`         | Auto-approve edits (trusted environment)                                              | `/approval-mode auto-edit`                                                                                |
| → `auto`              | Classifier-evaluated approval (autonomous)                                            | `/approval-mode auto`                                                                                     |
| → `yolo`              | Auto-approve everything (quick prototyping)                                           | `/approval-mode yolo`                                                                                     |
| `/peers`              | Review messages held from other Qwen Code sessions on this machine                    | `/peers`, `/peers accept <id>`, `/peers deny all`                                                         |
| `/model`              | Switch model used in current session                                                  | `/model`, `/model <model-id>` (switch immediately)                                                        |
| `/model --fast`       | Set a lighter model for prompt suggestions                                            | `/model --fast qwen3-coder-flash`                                                                         |
| `/model --voice`      | Set the model used for voice transcription                                            | `/model --voice <model-id>`                                                                               |
| `/model --vision`     | Set the vision-bridge model used to transcribe images for a text-only main model      | `/model --vision <model-id>`                                                                              |
| `/model --compaction` | Set the model used for chat compression                                               | `/model --compaction <model-id>`, `/model --compaction clear`                                             |
| `/model --image`      | Set an image-generation-capable model for the built-in image generation tool          | `/model --image <model-id>`                                                                               |
| `/effort`             | Set reasoning effort for thinking-capable models                                      | `/effort` (opens picker), `/effort high` (low/medium/high/xhigh/max; mapped & clamped per provider)       |
| `/extensions`         | Manage extensions                                                                     | `/extensions list`, `/extensions manage`                                                                  |
| → `list`              | List installed extensions                                                             | `/extensions list`                                                                                        |
| → `manage`            | Manage installed extensions (interactive)                                             | `/extensions manage`                                                                                      |
| → `explore`           | Open extensions page in browser                                                       | `/extensions explore <Gemini\|ClaudeCode>`                                                                |
| → `install`           | Install an extension from a git repo or path                                          | `/extensions install <repo-or-path>`                                                                      |
| `/memory`             | Open the Memory Manager dialog                                                        | `/memory`                                                                                                 |
| `/remember`           | Save a durable memory                                                                 | `/remember Prefer terse responses`                                                                        |
| `/forget`             | Remove matching entries from auto-memory                                              | `/forget <query>`                                                                                         |
| `/dream`              | Manually run auto-memory consolidation                                                | `/dream`                                                                                                  |
| `/hooks`              | Manage Qwen Code hooks                                                                | `/hooks`, `/hooks list`                                                                                   |
| `/reload-plugins`     | Reload extension changes (commands, skills, agents, hooks, MCP/LSP servers) from disk | `/reload-plugins`                                                                                         |
| `/permissions`        | Manage permission rules                                                               | `/permissions`                                                                                            |
| `/agents`             | Manage subagents                                                                      | `/agents manage`, `/agents create`                                                                        |
| `/arena`              | Manage Arena sessions                                                                 | `/arena start`, `/arena stop`, `/arena status`, `/arena select` (alias `choose`)                          |
| `/goal`               | Set a goal — keep working until condition met (see [Goals](./goals.md))               | `/goal <condition>`, `/goal clear`                                                                        |
| `/tasks`              | List background tasks                                                                 | `/tasks`                                                                                                  |
| `/workflows`          | Inspect workflow runs; cooperatively pause/resume a background run                    | `/workflows`, `/workflows <runId>`, `/workflows p <runId>`                                                |
| `/lsp`                | Show LSP server status                                                                | `/lsp`                                                                                                    |
| `/trust`              | Manage folder trust settings                                                          | `/trust`                                                                                                  |

> [!warning]
>
> Only install extensions (`/extensions install`) from sources you trust. Extensions can bundle MCP servers, skills, and commands that run with the same permissions as Qwen Code itself — they can access your files, API keys, and conversation data. `/extensions install` does not prompt for confirmation.

> [!warning]
>
> The `auto-edit`, `auto`, and `yolo` approval modes bypass approval prompts for tool executions. In `yolo` mode, all actions — including shell commands, file writes, and network requests — run without confirmation. Only use these modes in trusted, sandboxed, or disposable environments.

> [!note]
>
> `/workflows`, `/lsp`, and `/trust` are registered only when their feature is enabled — via the user/system-scoped `tools.workflowsEnabled` setting or `QWEN_CODE_ENABLE_WORKFLOWS=1` env var, the `--experimental-lsp` CLI flag, and the `security.folderTrust.enabled` setting respectively. Workspace values for `tools.workflowsEnabled` are ignored. When disabled these commands won't appear and will report an unknown command. Similarly, `/dream` and `/forget` are registered only when managed auto-memory is available; without it they won't appear.

### 1.5 Built-in Skills

These commands invoke bundled skills that provide specialized workflows.

| Command       | Description                                                   | Usage Examples                                                            |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/review`     | Multi-agent code review (12 parallel agents at high effort)   | `/review`, `/review 123`, `/review 123 --comment`, `/review --effort low` |
| `/coordinate` | Coordinate read-only workers and one optional worktree writer | `/coordinate investigate and fix the authentication regression`           |
| `/loop`       | Run a prompt on a recurring schedule                          | `/loop 5m check the build`                                                |
| `/goal-draft` | Turn a fuzzy intention into a verifiable `/goal` objective    | `/goal-draft make the auth tests pass`                                    |
| `/simplify`   | Review recent changes and apply safe cleanup edits directly   | `/simplify`, `/simplify focus on duplication`                             |
| `/qc-helper`  | Answer questions about Qwen Code usage and configuration      | `/qc-helper how do I configure MCP?`                                      |

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

### 1.7 Second Opinion (`/advisor`)

The `/advisor` command runs an independent, read-only review of the conversation so far and returns a structured second opinion — without performing the task or interrupting the main conversation.

| Command            | Description                            |
| ------------------ | -------------------------------------- |
| `/advisor`         | Review the conversation above          |
| `/advisor <focus>` | Focus the review on a specific concern |

**How It Works:**

- The review is sent as a separate, single-turn API call with recent conversation context (up to the last 40 messages)
- The reviewer model **cannot execute tools** — tools are stripped at the request level (the same mechanism as `/btw`), so the review never writes code or runs commands; every claim must be grounded in the visible transcript
- The main conversation is **not** interrupted; the review is shown only to you
- The review is rendered as a boxed markdown block with four fixed sections — **Verdict**, **Risks**, **Missing evidence**, and **Recommendation** — under an `/advisor · <model>` header that names the resolved reviewer model
- Unlike `/btw`, which is fire-and-forget and leaves the session usable, `/advisor` blocks input until the review returns; over a full context window with a strong reviewer this can take tens of seconds
- By default the main model is used; set [`advisorModel`](../configuration/settings.md#advisormodel) to route the review to a different (typically stronger) model — the recent transcript is sent to that model even when it uses another provider

**Example:**

```
> /advisor is my fix for the null check actually correct?

  Consulting advisor...

  ╭──────────────────────────────────────────────────────╮
  │ /advisor · qwen3-max                                 │
  │                                                      │
  │ Verdict                                              │
  │ The approach is sound, but the edge case at line 42  │
  │ is unverified.                                       │
  │                                                      │
  │ Risks                                                │
  │  - The fix assumes the config is always loaded; a    │
  │    startup race could leave it null.                 │
  │                                                      │
  │ Missing evidence                                     │
  │  - No test exercises the null-config path in the     │
  │    visible transcript.                               │
  │                                                      │
  │ Recommendation                                       │
  │ Add a focused unit test for the null-config branch   │
  │ before merging.                                      │
  ╰──────────────────────────────────────────────────────╯
```

The review renders in a bordered box whose header names the resolved reviewer model. An unknown `advisorModel` is not validated up front — if the provider rejects it, `/advisor` reports the failure, so check the model name; only unresolvable alias selectors (e.g. `fast` with no fast model configured) fall back to the main model. Advisor requests do not use configured model fallbacks.

**Supported Execution Modes:**

| Mode                 | Behavior                                            |
| -------------------- | --------------------------------------------------- |
| Interactive          | Renders the four-section review in the conversation |
| ACP (Agent Protocol) | Returns the review as a message result              |

> [!tip]
>
> Use `/advisor` for a second opinion before committing to a direction — it is especially useful for catching flawed assumptions, unverified claims, or risky next steps. Configure `advisorModel` to get the review from a different model than the one driving the main conversation.

> [!note]
>
> `advisorModel` is set in settings only; unlike `fastModel` and `visionModel`, it has no `/model` flag counterpart yet.

### 1.8 Session Recap (`/recap`)

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

### 1.9 Diff Viewer (`/diff`)

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

**Web Shell:** In the Web Shell UI (`qwen serve`), `/diff` opens a graphical diff dialog. A tab bar at the top lets you switch between the **Changes** view and the **History** view (`/log`).

#### History Viewer (`/log`) — Web Shell only

The `/log` command opens a commit history browser for the current workspace. It is available only in the Web Shell UI; the CLI/TUI does not have this command.

**How it works:**

`/log` opens a dialog listing commits in reverse chronological order (newest first). Each row shows:

- Short SHA (monospace, with a copy button for the full SHA)
- Commit subject (single line)
- Author name and relative time (e.g. "2h ago")
- Branch/tag ref labels, when present
- A merge icon (⎇) for merge commits

Click a commit row to expand its details on demand:

- Full commit message body
- File change statistics (files changed, lines added/removed, per-file breakdown)

Use **Load more** at the bottom to fetch the next page of commits (50 per page).

**Example:**

```
┌─ History ──────────────────────────── 50 commits ─ ✕ ┐
│                                                       │
│  a1b2c3d  feat(cli): add --json flag        2h ago   │
│           wenshao                                    │
│                                                       │
│  e4f5g6h  fix(core): handle null config     5h ago   │
│           dev · main  v1.2.0                         │
│                                                       │
│ ▼ 789abcd  refactor: simplify parser        1d ago   │
│   ┌─────────────────────────────────────────────┐    │
│   │  Broke the monolithic parse() into smaller  │    │
│   │  functions for readability.                 │    │
│   │                                             │    │
│   │  3 files · +45 −12                          │    │
│   │   +30 −8   src/parser.ts                    │    │
│   │   +10 −2   src/utils.ts                     │    │
│   │   +5  −2   test/parser.test.ts              │    │
│   └─────────────────────────────────────────────┘    │
│                                                       │
│              [ Load more ]                            │
└───────────────────────────────────────────────────────┘
```

> [!note]
>
> `/log` requires a git repository workspace. If the workspace is not a git repository or has no commits, the dialog shows a placeholder message.

### 1.10 Information, Settings, and Help

Commands for obtaining information and performing system settings.

| Command          | Description                                                                                                                    | Usage Examples                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/help`          | Display help information for available commands                                                                                | `/help` or `/?`                                                                     |
| `/status`        | Display version information                                                                                                    | `/status` or `/about`                                                               |
| `/status paths`  | Display current session file and log paths                                                                                     | `/status paths`                                                                     |
| `/stats`         | Open the interactive usage statistics dashboard (Session, Activity, and Efficiency tabs)                                       | `/stats` or `/usage`                                                                |
| `/stats model`   | Show per-model token breakdown and estimated cost                                                                              | `/stats model`                                                                      |
| `/stats tools`   | Show per-tool call counts                                                                                                      | `/stats tools`                                                                      |
| `/stats skills`  | Show per-skill call counts for the current live session (live only; excludes cross-session daily/monthly activity)             | `/stats skills`                                                                     |
| `/stats daily`   | Show daily token usage statistics                                                                                              | `/stats daily` (alias `day`), `/stats day [YYYY-MM-DD]`                             |
| `/stats monthly` | Show monthly token usage statistics                                                                                            | `/stats monthly` (alias `month`), `/stats month [YYYY-MM]`                          |
| `/stats export`  | Export usage statistics to CSV or JSON                                                                                         | `/stats export <daily\|monthly> [date\|month] [--format csv\|json] [--output path]` |
| `/settings`      | Open settings editor                                                                                                           | `/settings`                                                                         |
| `/config`        | Get or set any setting by dot-path key (writes to user settings)                                                               | `/config` (list all), `/config <key>`, `/config <key>=<value>`                      |
| `/auth`          | Change authentication method                                                                                                   | `/auth`, `/connect`, `/login`                                                       |
| `/doctor`        | Run installation and environment diagnostics                                                                                   | `/doctor`, `/doctor memory`                                                         |
| → `memory`       | Show current process memory diagnostics                                                                                        | `/doctor memory [--json] [--sample] [--snapshot]`                                   |
| → `cpu-profile`  | Record a CPU profile for Chrome DevTools analysis                                                                              | `/doctor cpu-profile [--duration <seconds>]`                                        |
| → `rollback`     | Roll back the standalone CLI binary to the previous version (standalone installs only; for conversation history use `/rewind`) | `/doctor rollback`                                                                  |
| `/docs`          | Open full Qwen Code documentation in browser                                                                                   | `/docs`                                                                             |
| `/ide`           | Manage IDE integration                                                                                                         | `/ide status`, `/ide install`, `/ide enable`, `/ide disable`                        |
| `/insight`       | Generate programming insights from chat history                                                                                | `/insight`                                                                          |
| `/setup-github`  | Set up GitHub Actions                                                                                                          | `/setup-github`                                                                     |
| `/bug`           | Submit issue about Qwen Code                                                                                                   | `/bug Button click unresponsive`                                                    |
| `/copy`          | Copy to clipboard: reply (Nth-last), code (by lang), LaTeX, or Mermaid                                                         | `/copy`, `/copy 2`, `/copy python`, `/copy latex`, `/copy mermaid`                  |
| `/quit`          | Exit Qwen Code immediately                                                                                                     | `/quit` or `/exit`                                                                  |

> [!warning]
>
> `/doctor memory --snapshot` writes a V8 heap snapshot that may contain prompts, file contents, API keys, and tool results from the current session. Review the file before sharing it.

> [!note]
>
> `/config` reads and writes individual settings by dot-path key (e.g. `general.vimMode`), complementing the interactive `/settings` editor. Running `/config` with no argument (or `--help`) lists every settable key with its type and current value. `/config <key>` prints the current value — except for boolean keys, where it toggles the value. `/config <key>=<value>` sets the value. Changes are written to user settings (`~/.qwen/settings.json`). Only `boolean`, `string`, `number`, and `enum` settings can be changed this way — `array` and `object` settings must be edited in `settings.json` directly. Sensitive values (API keys, tokens, base URLs) are masked in output, and setting `tools.approvalMode` to `yolo` is blocked.

### 1.11 Common Shortcuts

| Shortcut           | Function                | Note                                                                      |
| ------------------ | ----------------------- | ------------------------------------------------------------------------- |
| `Ctrl/cmd+L`       | Clear screen            | Clears the visible screen only (does not reset the session like `/clear`) |
| `Ctrl/cmd+T`       | Toggle tool description | MCP tool management                                                       |
| `Ctrl/cmd+C`×2     | Exit confirmation       | Secure exit mechanism                                                     |
| `Ctrl/cmd+Z`       | Undo input              | Text editing                                                              |
| `Ctrl/cmd+Shift+Z` | Redo input              | Text editing                                                              |

### 1.12 Authentication Commands

Use `/auth` inside a Qwen Code session to configure authentication. Use `/doctor` to inspect the current authentication and environment status.

| Command   | Description                                                            |
| --------- | ---------------------------------------------------------------------- |
| `/auth`   | Configure authentication interactively (aliases: `/connect`, `/login`) |
| `/doctor` | Show authentication and environment checks                             |

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

| Command              | Description                                 | Usage Examples                                               |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `qwen sessions list` | List recent conversation sessions           | `qwen sessions list`, `qwen sessions list --json --limit 50` |
| `qwen sessions ps`   | List interactive sessions running right now | `qwen sessions ps`, `qwen sessions ps --json`                |

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

#### `qwen sessions ps`

Lists the interactive Qwen Code sessions running on this machine right
now. `sessions list` walks saved transcripts ("what have I worked on");
this walks the live-process registry ("what is running at this moment").
Records left behind by a killed session are swept as they are found.
Headless sessions (`qwen -p`) do not register with the live-process
registry, so they are not shown.

**Flags:**

| Flag     | Type    | Default | Description                                     |
| -------- | ------- | ------- | ----------------------------------------------- |
| `--json` | boolean | `false` | Output as JSON Lines (one JSON object per line) |

**Human-readable output (default):**

A table with columns: NAME, PID, AGE, DIRECTORY.

**JSON output (`--json`):**

Outputs JSON Lines on stdout, newest session first. Each line is a JSON
object with fields:

```
schemaVersion, pid, procStart, pidNs, sessionId, cwd, name, startedAt,
qwenVersion
```

Nothing else is written to stdout — an empty listing prints nothing at
all — so `qwen sessions ps --json | jq .` is safe to script against.

JSON output is raw data: field values are emitted exactly as recorded,
with no terminal sanitization. Treat them as data, and sanitize before
rendering them in a terminal.

**Examples:**

```bash
# Show the other live sessions
qwen sessions ps

# Which directories are busy right now?
# Note: `jq -r` renders the raw recorded value in your terminal (see the
# raw-data note above); pipe through a sanitizer if the path is untrusted.
qwen sessions ps --json | jq -r .cwd
```

#### Messaging another running session

Two interactive sessions on the same machine can send each other
messages. The feature is experimental and **off by default**; turn it on
in `settings.json` and restart:

```json
{ "agents": { "crossSessionMessaging": true } }
```

Once on, the model in one session can discover the others with
`list_agents` — each appears under `sessions` with the same `name` that
`qwen sessions ps` prints — and address one with `send_message` using
that name as `to`. When two sessions share a name, `list_agents` shows
each with a short `[ref]` and the send must include it (`name [ref]`); a
bare name that could mean either is refused rather than guessed.
`list_agents` also reports the session's own name under `self`, and
`to: "*"` still means "my Agent Team teammates" and never reaches other
sessions.

A message arrives in the other session marked as coming from another
session, not from its user, and carries none of your authority there:
the receiving session acts on it only within its own permission settings.
Its user can choose what happens to incoming messages with
`agents.crossSessionInbound` (`accept`, `hold`, or `refuse`). When unset,
a message is delivered if the receiving session still reviews each
action (default or plan mode), or if both sessions are in a mode that
applies actions without per-action review; otherwise it is held for
review. Held messages are listed and released with `/peers` in the
receiving session.

The `send_message` call only confirms the message was handed to the other
session. What became of it arrives later as a receipt: if it was held,
declined, expired, or misaddressed (the address changed hands — list the
agents again) — or released after a hold — a notice appears in the
sending session's transcript (`Message to <name>: …`). The model that
sent it is not told; if the other session replies, the reply arrives as a
cross-session message.
