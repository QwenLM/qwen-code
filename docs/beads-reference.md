# beads_rust (`br`) + proto Agent — Comprehensive Reference

Generated: 2026-04-02  
`br` version: 0.1.23  
Tool path: `/home/josh/.cargo/bin/br`  
Active workspace: `/home/josh/dev/labs/qwen-code/.beads/`

---

## 1. What is beads_rust?

`br` is an agent-first, per-project issue tracker backed by SQLite + JSONL.
Issues are stored in `.beads/beads.db` inside the working directory and are
flushed to JSONL for portability. The database auto-discovers itself by walking
up from the current directory, so all `br` commands work from any subdirectory
of the project.

---

## 2. Global flags (apply to every subcommand)

| Flag                  | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `--json`              | Machine-readable JSON output                          |
| `--db <PATH>`         | Override database path (auto-discovered by default)   |
| `--actor <NAME>`      | Actor name written to the audit trail                 |
| `--no-color`          | Disable ANSI colour                                   |
| `--quiet` / `-q`      | Suppress all output except errors                     |
| `--verbose` / `-v`    | Increase log verbosity (repeat for `-vv`)             |
| `--allow-stale`       | Skip freshness check warning                          |
| `--lock-timeout <MS>` | SQLite busy timeout in ms                             |
| `--no-auto-flush`     | Skip automatic JSONL export after write               |
| `--no-auto-import`    | Skip automatic JSONL import check on startup          |
| `--no-db`             | JSONL-only mode (no database connection)              |
| `--no-daemon`         | Force direct mode — no-op in v1 (already direct-only) |

---

## 3. Full command reference

### 3.1 Workspace management

#### `br init`

Initialize a `.beads/` workspace in the current directory.  
Called automatically by the proto agent on first use.

#### `br where`

Print the path to the active `.beads/` directory.

#### `br info`

Show diagnostic metadata: database path, mode, daemon status, issue count,
prefix.

#### `br config <subcommand>`

| Subcommand               | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `list`                   | Print all config options (merged: defaults + project + user) |
| `get <key>`              | Get a single value                                           |
| `set <key> <value>`      | Persist a value                                              |
| `delete <key>` / `unset` | Remove a value                                               |
| `edit`                   | Open config file in `$EDITOR`                                |
| `path`                   | Show config file locations                                   |

Relevant config keys seen in this project's `config.yaml`:

```yaml
issue_prefix: qwen-code # prefix for auto-generated IDs
default_priority: 2 # numeric (0=critical…4=backlog)
default_type: task
```

#### `br doctor`

Run diagnostics and optionally repair issues (missing columns, schema drift,
etc.).

#### `br upgrade`

Upgrade `br` binary in-place to the latest release.

---

### 3.2 Core CRUD

#### `br create [TITLE] [OPTIONS]`

Create a new issue.

| Flag                   | Type                | Description                                             |
| ---------------------- | ------------------- | ------------------------------------------------------- |
| `TITLE` / `--title`    | string              | Issue title (1–500 chars)                               |
| `-t` / `--type`        | string              | `task` `bug` `feature` `epic` `chore` `docs` `question` |
| `-p` / `--priority`    | 0–4 or P0–P4        | 0=critical, 1=high, 2=medium, 3=low, 4=backlog          |
| `-d` / `--description` | string              | Body / detailed description (alias `--body`)            |
| `-a` / `--assignee`    | string              | Assign to a person                                      |
| `--owner`              | string              | Set owner email                                         |
| `-l` / `--labels`      | comma-separated     | Apply labels at creation                                |
| `--parent`             | issue-id            | Creates a parent-child dependency                       |
| `--deps`               | `type:id,…`         | Arbitrary dependency edges                              |
| `-e` / `--estimate`    | minutes             | Time estimate                                           |
| `--due`                | RFC3339 or relative | Due date                                                |
| `--defer`              | RFC3339 or relative | Defer until date                                        |
| `--external-ref`       | string              | External reference (GitHub issue URL, etc.)             |
| `-s` / `--status`      | string              | Initial status (default: `open`)                        |
| `--ephemeral`          | flag                | Not exported to JSONL                                   |
| `--silent`             | flag                | Output only the new issue ID                            |
| `--dry-run`            | flag                | Preview without writing                                 |
| `-f` / `--file`        | path                | Bulk-import from a Markdown file                        |

Returns: full issue object (with `--json`).

#### `br q [TITLE WORDS…] [OPTIONS]`

Quick-capture — same as `create` but prints only the new ID. Useful for
scripting. Supports: `--priority`, `--type`, `--labels`, `--description`,
`--parent`, `--estimate`.

#### `br show [IDS…] [OPTIONS]`

Show full details of one or more issues.  
Formats: `text` (default), `json`, `toon` (token-optimised).  
Returns an **array** even for a single ID.

#### `br update [IDS…] [OPTIONS]`

Update one or more existing issues.

| Flag                                     | Description                                     |
| ---------------------------------------- | ----------------------------------------------- |
| `--title`                                | New title                                       |
| `--description` / `--body`               | New description                                 |
| `--design`                               | Technical design notes                          |
| `--acceptance-criteria` / `--acceptance` | Acceptance criteria                             |
| `--notes`                                | Additional notes                                |
| `-s` / `--status`                        | New status                                      |
| `-p` / `--priority`                      | New priority                                    |
| `-t` / `--type`                          | New issue type                                  |
| `--assignee`                             | Assign (empty string clears)                    |
| `--owner`                                | Set owner (empty string clears)                 |
| `--claim`                                | Atomic: set assignee=actor + status=in_progress |
| `--due`                                  | Set/clear due date                              |
| `--defer`                                | Set/clear defer date                            |
| `--estimate`                             | Time estimate in minutes                        |
| `--add-label`                            | Append label(s)                                 |
| `--remove-label`                         | Remove label(s)                                 |
| `--set-labels`                           | Replace all labels                              |
| `--parent`                               | Reparent (empty string removes parent)          |
| `--external-ref`                         | Set external reference                          |
| `--session`                              | Set `closed_by_session`                         |
| `--force`                                | Update even if blocked                          |

#### `br close [IDS…] [OPTIONS]`

Close one or more issues.

| Flag              | Description                                  |
| ----------------- | -------------------------------------------- |
| `-r` / `--reason` | Close reason (stored)                        |
| `-f` / `--force`  | Close even if blocked by open dependencies   |
| `--suggest-next`  | After closing, return newly unblocked issues |
| `--session`       | Session ID for tracking                      |
| `--robot`         | Alias for `--json`                           |

Uses "last-touched" issue if no IDs given.

#### `br reopen [IDS…] [OPTIONS]`

Reopen closed issues.  
`-r` / `--reason` — stored as a comment.

#### `br delete [IDS…]`

Delete an issue (creates a tombstone record — soft delete, auditable).

---

### 3.3 Listing and filtering

#### `br list [OPTIONS]`

List issues (open only by default).

| Flag                | Description                                  |
| ------------------- | -------------------------------------------- |
| `-s` / `--status`   | Filter by status (repeatable)                |
| `-t` / `--type`     | Filter by type (repeatable)                  |
| `--assignee`        | Filter by assignee                           |
| `--unassigned`      | Unassigned only                              |
| `--id`              | Filter by specific IDs (repeatable)          |
| `-l` / `--label`    | AND label filter (repeatable)                |
| `--label-any`       | OR label filter (repeatable)                 |
| `-p` / `--priority` | Exact priority (repeatable)                  |
| `--priority-min`    | Minimum priority (0=critical)                |
| `--priority-max`    | Maximum priority                             |
| `--title-contains`  | Substring match on title                     |
| `--desc-contains`   | Substring match on description               |
| `--notes-contains`  | Substring match on notes                     |
| `-a` / `--all`      | Include closed issues                        |
| `--deferred`        | Include deferred issues                      |
| `--overdue`         | Only overdue issues                          |
| `--limit`           | Max results (default 50, 0=unlimited)        |
| `--sort`            | `priority` `created_at` `updated_at` `title` |
| `-r` / `--reverse`  | Reverse sort                                 |
| `--long`            | Long text format                             |
| `--pretty`          | Tree/pretty format                           |
| `--format`          | `text` `json` `csv` `toon`                   |
| `--fields`          | CSV columns to include                       |

Available CSV fields: `id`, `title`, `description`, `status`, `priority`,
`issue_type`, `assignee`, `owner`, `created_at`, `updated_at`, `closed_at`,
`due_at`, `defer_until`, `notes`, `external_ref`.

#### `br search <QUERY> [OPTIONS]`

Full-text search across title, description, and notes. Accepts the same
filters as `br list`.

#### `br ready [OPTIONS]`

List issues that are unblocked and not deferred (actionable now).

| Flag                 | Description                             |
| -------------------- | --------------------------------------- |
| `--limit`            | Max results (default 20)                |
| `--assignee`         | Filter by assignee                      |
| `--unassigned`       | Unassigned only                         |
| `-l` / `--label`     | AND label filter                        |
| `--label-any`        | OR label filter                         |
| `-t` / `--type`      | Type filter                             |
| `-p` / `--priority`  | Priority filter                         |
| `--sort`             | `hybrid` (default) `priority` `oldest`  |
| `--include-deferred` | Include deferred                        |
| `--parent`           | Children of a specific parent           |
| `-r` / `--recursive` | Include all descendants with `--parent` |

#### `br blocked [OPTIONS]`

List issues blocked by open dependencies.  
`--detailed` — include full blocker details in text output.

#### `br stale [OPTIONS]`

List issues not updated in N days.  
`--days` — threshold (default 30).

#### `br count [OPTIONS]`

Count issues with optional grouping.  
`--by <status|priority|type|assignee|label>` or shorthand flags.

#### `br stats [OPTIONS]`

Summary statistics: totals by status, optional breakdowns by type / priority /
assignee / label. Returns a `summary` object in JSON mode.

---

### 3.4 Dependencies

#### `br dep add <ISSUE> <DEPENDS-ON>`

Add a dependency edge (ISSUE blocks on DEPENDS-ON).

#### `br dep remove <ISSUE> <DEPENDS-ON>`

Remove a dependency edge.

#### `br dep list <ISSUE>`

List all dependencies of an issue.

#### `br dep tree <ISSUE>`

Render the full dependency tree rooted at an issue.

#### `br dep cycles`

Detect and report circular dependency cycles.

#### `br graph [ISSUE] [OPTIONS]`

Visualise the dependency graph. `--all` shows all connected components.
`--compact` — one line per issue.

---

### 3.5 Comments

#### `br comments [ID]`

List comments on an issue.

#### `br comments add <ID> <TEXT>`

Append a comment to an issue. This is how `task_output` stores its data in
the beads backend.

---

### 3.6 Labels

#### `br label add <ID> <LABEL…>`

Add labels. Labels are plain strings; the proto agent uses two reserved
namespaces: `parent:<id>` and `assignee:<agentId>`.

#### `br label remove <ID> <LABEL…>`

Remove labels.

#### `br label list [ID]`

List labels on one issue or all unique labels across the workspace.

#### `br label list-all`

All unique labels with usage counts.

#### `br label rename <OLD> <NEW>`

Rename a label across all issues.

---

### 3.7 Workflow helpers

#### `br defer [IDS…] --until <DATE>`

Move issues to `deferred` status until a date/time (`+1h`, `tomorrow`,
`2025-01-15`, RFC3339).

#### `br undefer [IDS…]`

Remove deferral and return issues to `open`.

#### `br orphans`

List issues referenced in git commits that are still open.

#### `br changelog`

Generate a changelog from closed issues.

#### `br lint`

Check issues for missing template sections.

#### `br epic status`

Show progress and closure eligibility for all epics.

#### `br epic close-eligible`

Auto-close epics whose children are all closed.

---

### 3.8 Agent/AI integration utilities

#### `br audit record`

Append an agent-interaction entry (JSONL append-only log).

#### `br audit label`

Append a label entry referencing an existing interaction.

#### `br audit log <ISSUE>`

View the audit log for a specific issue.

#### `br audit summary`

View aggregate audit summary.

#### `br agents [OPTIONS]`

Manage AGENTS.md workflow instructions injected into the project root.
`--add` injects beads workflow guidance; `--update` refreshes to the latest
version; `--remove` strips it.

#### `br schema [TARGET]`

Emit JSON Schemas for all `br` output types — useful for tooling integration.
Targets: `all` (default), `issue`, `issue-with-counts`, `issue-details`,
`ready-issue`, `stale-issue`, `blocked-issue`, `tree-node`, `statistics`,
`error`.

---

### 3.9 History and sync

#### `br history`

Manage local history backups of the JSONL file.

#### `br sync`

Sync the database with the JSONL file (export or import).

---

## 4. Issue schema (full field set)

From `br schema issue --json`:

| Field                 | Type           | Description                                    |
| --------------------- | -------------- | ---------------------------------------------- |
| `id`                  | string         | Unique ID, e.g. `qwen-code-c43`                |
| `title`               | string         | 1–500 chars                                    |
| `description`         | string?        | Detailed body                                  |
| `design`              | string?        | Technical design notes                         |
| `acceptance_criteria` | string?        | Acceptance criteria text                       |
| `notes`               | string?        | Additional notes                               |
| `status`              | Status enum    | See below                                      |
| `priority`            | int 0–4        | 0=Critical, 1=High, 2=Medium, 3=Low, 4=Backlog |
| `issue_type`          | IssueType enum | See below                                      |
| `assignee`            | string?        | Assigned user                                  |
| `owner`               | string?        | Owner email                                    |
| `estimated_minutes`   | int?           | Effort estimate                                |
| `created_at`          | datetime       | Creation timestamp (RFC3339)                   |
| `created_by`          | string?        | Creator username                               |
| `updated_at`          | datetime       | Last update                                    |
| `closed_at`           | datetime?      | When closed                                    |
| `close_reason`        | string?        | Reason for closure                             |
| `closed_by_session`   | string?        | Session ID that closed it                      |
| `due_at`              | datetime?      | Due date                                       |
| `defer_until`         | datetime?      | Deferred until                                 |
| `external_ref`        | string?        | External reference (GitHub URL etc.)           |
| `labels`              | string[]?      | Arbitrary labels                               |
| `source_repo`         | string?        | Git repo path                                  |
| `dependency_count`    | int            | Number of outbound dependencies                |
| `dependent_count`     | int            | Number of inbound dependents                   |
| `compaction_level`    | int            | JSONL compaction level                         |
| `comments`            | Comment[]?     | Present in `br show` output                    |

**Status enum** values (br native):
`open` `in_progress` `blocked` `deferred` `draft` `closed` `tombstone` `pinned`

**IssueType enum**:
`task` `bug` `feature` `epic` `chore` `docs` `question`

**Dependency types**:
`blocks` `parent-child` `conditional-blocks` `waits-for` `related`
`discovered-from` `replies-to` `relates-to` `duplicates` `supersedes`
`caused-by`

**Sample real issue** (from `br list --json`):

```json
{
  "id": "qwen-code-c43",
  "title": "Test beads task creation (IN PROGRESS)",
  "description": "Creating a test task to verify beads_rust backend integration works correctly",
  "status": "in_progress",
  "priority": 2,
  "issue_type": "task",
  "created_at": "2026-04-01T03:03:04.031173943Z",
  "created_by": "josh",
  "updated_at": "2026-04-01T03:03:22.880996318Z",
  "source_repo": ".",
  "compaction_level": 0,
  "dependency_count": 0,
  "dependent_count": 0
}
```

Comments appear only in `br show --json` output, not in `br list --json`.

---

## 5. Proto agent tools — mapping to `br` commands

The six agent tools are implemented in
`packages/core/src/tools/task-*.ts` and backed by
`packages/core/src/services/task-store.ts`. All `br` calls are made via
`execFileSync` with `--json` appended (or raw without `--json` for commands
that don't support it).

### 5.1 Status and priority translation

The proto agent uses its own vocabulary that is translated before hitting `br`:

**Status mapping (proto → br)**:
| Proto `TaskStatus` | `br` status |
|---|---|
| `pending` | `open` |
| `in_progress` | `in_progress` |
| `completed` | `closed` (via `br close --reason done`) |
| `blocked` | `deferred` |
| `cancelled` | `closed` (via `br close --reason cancelled`) |

**Reverse mapping (br → proto)**:
| `br` status | Proto `TaskStatus` |
|---|---|
| `open` | `pending` |
| `in_progress` | `in_progress` |
| `closed` | `completed` |
| `deferred` | `blocked` |
| anything else | `pending` (fallback) |

Note: `br` statuses `draft`, `tombstone`, and `pinned` have no proto equivalent
and fall back to `pending`.

**Priority mapping (proto → br numeric)**:
| Proto `TaskPriority` | `br` priority |
|---|---|
| `critical` | `0` |
| `high` | `1` |
| `medium` | `2` |
| `low` | `3` |

br priority 4 (backlog) maps back to proto `low`.

### 5.2 `task_create`

**Agent parameters**: `title` (required), `description`, `parentTaskId`,
`priority` (`low` `medium` `high` `critical`).

**What the store does**:

1. Runs `br create --title <title> --type task [--description …] [--priority N] --json`
2. If `parentTaskId` is set, runs `br label add <newId> parent:<parentTaskId>` (raw, no `--json`)
3. Fetches the created issue via `br show <id> --json` and returns it.

**Note**: `br`'s native `--parent` flag is NOT used. Parent relationships are
encoded as the label `parent:<id>`. This means `br ready --parent <id>` and
`br dep` dependency edges are **not** used — parent lookup is done by scanning
all labels client-side.

### 5.3 `task_get`

**Agent parameters**: `taskId` (required).

**What the store does**:

1. Runs `br show <id> --json` — returns an array; takes `[0]`.
2. Enriches with `subtaskCount` (calls `list({ parentTaskId: id })`) and full
   `subtasks` array.
3. Returns the combined object as JSON to the agent.

### 5.4 `task_list`

**Agent parameters**: `status` (`pending` `in_progress` `completed` `blocked`
`cancelled`), `parentTaskId`.

**What the store does**:

1. Runs `br list [--status <brStatus>] --json` — `br` does not support `--all`
   by default so closed tasks require `--status closed` explicitly.
2. Filters by `parentTaskId` **client-side** by inspecting the `parent:` label
   on each returned issue.
3. Sorts results by `created_at` ascending.

**Note**: The `--all` flag (to include closed) is NOT passed; to see completed
tasks the agent must pass `status: "completed"` which maps to
`--status closed`.

### 5.5 `task_update`

**Agent parameters**: `taskId` (required), plus any of `status`, `title`,
`description`, `priority`.

**What the store does**:

- If `status === "completed"` → `br close <id> --reason done --json`
- If `status === "cancelled"` → `br close <id> --reason cancelled --json`
- If `status === "pending"` → `br reopen <id> --json`
- For all other status values (i.e. `in_progress`, `blocked`) or non-status
  fields → `br update <id> [--title …] [--description …] [--priority N]
[--status <brStatus>] --json`
- Then fetches the updated task via `br show`.

**Validation**: At least one of `status`, `title`, `description`, or
`priority` must be provided. The tool returns an error otherwise.

### 5.6 `task_stop`

**Agent parameters**: `taskId` (required), `reason` (optional).

**What the store does**:

1. Runs `br close <id> [--reason <reason>] --json`.
2. Recursively cancels all children by fetching `list({ parentTaskId: id })`
   and calling `stop()` on each non-terminal child.
3. Returns the list of all cancelled tasks.

### 5.7 `task_output`

**Agent parameters**: `taskId` (required), `output` (required string).

**What the store does**:

1. Runs `br comments add <id> <output>` (**raw**, no `--json`).
2. Returns a task object with the `output` field set in-memory (not persisted
   as a field — it lives in comments).

**Critical gap**: `output` is stored as a comment in `br`, not as a native
field. When the task is later fetched via `br show --json`, the output appears
in the `comments` array, not as a top-level `output` field. The `brIssueToTask`
conversion does not read comments, so `task.output` will always be `undefined`
when re-fetching via `task_get`. The value is write-once from the agent's
perspective.

---

## 6. Architecture notes

### Fallback mode

If `br` is not installed, `TaskStore` falls back to an in-memory
`Map<string, Task>` persisted to a session-scoped JSON file at
`<runtimeDir>/tasks/<sessionId>.json`. The fallback is feature-complete for
the six agent operations but does not persist across sessions and has no
`output` field persistence either.

### Workspace initialisation

On construction, `TaskStore` checks for `.beads/` in `cwd`. If missing it runs
`br init`. This means the agent can work in any project directory and will
auto-initialise beads storage.

### ID format

`br` generates IDs as `<prefix>-<hash>`, e.g. `qwen-code-c43`. The prefix
comes from `config.yaml:issue_prefix` which is set to the project name during
`br init`. Hashes are 3–8 chars (configurable via `min_hash_length` /
`max_hash_length`).

### Concurrency

All `execFileSync` calls use a 10-second timeout. `br` operates in direct mode
(no daemon in v1) so every call opens and closes the SQLite database. SQLite
WAL mode handles concurrent reads; writes are serialised by the busy timeout.

---

## 7. Known gaps and limitations in the current integration

### Gap 1: Parent-child via labels, not native `--parent`

`br create --parent <id>` would register a proper `parent-child` dependency
edge, enabling `br ready --parent`, `br dep tree`, and `br epic` features.
The current implementation uses labels (`parent:<id>`) instead, which means:

- `br ready --parent <id>` does NOT work for agent-created subtasks.
- `br epic` commands do not recognise the hierarchy.
- Dependency graphs (`br graph`, `br dep tree`) do not show parent-child edges.
- The `--parent` flag on `task_create` is cosmetic from `br`'s perspective.

### Gap 2: `output` is not a first-class field

`task_output` stores data as a comment (`br comments add`). Re-fetching via
`task_get` does not reconstruct `task.output` because `brIssueToTask` ignores
the `comments` array. To read back output the agent would need to call
`br show --json` and read `comments[*].text` directly — which is not exposed
through any agent tool.

### Gap 3: `task_list` does not expose closed tasks by default

`br list` excludes closed issues unless `--all` or `--status closed` is
passed. The agent must explicitly pass `status: "completed"` to see them.
There is no way to list ALL statuses at once via the current tool API.

### Gap 4: No `br search` tool

`br search <query>` is a powerful full-text command not exposed to the agent.
Finding tasks by description content requires shell access.

### Gap 5: No `br ready` tool

`br ready` is the most useful "what should I work on next?" command but is
not exposed to the agent. The agent must use `task_list` and filter manually.

### Gap 6: No dependency management tools

`br dep add/remove/list/tree` and `br blocked` are not exposed. The agent
cannot model blocking relationships, which limits multi-agent coordination.

### Gap 7: No `br stats` / `br count` tool

The agent cannot query aggregate statistics without running a shell command.

### Gap 8: `cancelled` → `completed` collision in round-trips

Both `completed` and `cancelled` map to `br` status `closed`. Once a task
is closed for either reason, fetching it back maps `closed` → `completed`
regardless of the original close reason. The `close_reason` field on the
`br` issue ("done" vs "cancelled") is ignored during translation.

### Gap 9: `br` statuses `blocked` and `deferred` are swapped in meaning

The proto agent status `blocked` maps to `br` status `deferred` (not to br's
own `blocked` status, which is a dependency-driven state). This means:

- Issues the agent marks as `blocked` appear as `deferred` in the `br` UI.
- Genuine `br blocked` issues (from dependency edges) map to `pending` in
  the proto agent view.

### Gap 10: `--actor` not set

The `br` calls do not pass `--actor`, so the audit trail records the system
default actor (`josh` in this workspace) rather than the agent's session ID.

---

## 8. Best practices for long-horizon task management

### 8.1 When to create tasks

- Create a root task at the start of any multi-step operation that will span
  more than ~3 tool calls or involve risk (file changes, API calls, etc.).
- Break epics/features into sub-tasks of 30–90 minutes of estimated effort.
- Use `parentTaskId` to nest: one epic → multiple features → multiple tasks.
- For exploratory work, create a task with `description` containing the
  hypothesis and update it as you learn.

### 8.2 Naming and typing

- Use `issue_type: "epic"` for project-level goals.
- Use `issue_type: "feature"` for user-visible deliverables.
- Use `issue_type: "task"` for implementation work (default).
- Use `issue_type: "bug"` for defects.
- Keep titles to a single action-verb phrase: "Add JWT validation to login
  endpoint", not "JWT stuff".

### 8.3 Status discipline

- Call `task_update { taskId, status: "in_progress" }` **before** starting
  work, not after. This signals to other agents that the task is claimed.
- Use `task_update { status: "blocked", description: "Blocked on X" }` when
  you cannot proceed rather than leaving a task as `in_progress` indefinitely.
- Call `task_update { status: "completed" }` immediately after finishing,
  before starting the next task.
- Call `task_stop` only when a task is definitively abandoned (approach
  changed, out-of-scope). It cascades to all subtasks.

### 8.4 Recording output

- Use `task_output` to attach findings, file paths, test results, or
  summaries to a task before closing it. This is the only way to leave
  a persistent artifact on the task.
- Keep outputs concise but complete enough to understand what was done
  without re-reading the conversation.
- For large outputs (long diffs, full file contents), summarise rather than
  dump raw content — `br comments add` has no enforced size limit but large
  comments degrade readability.

### 8.5 Hierarchy patterns

**Single-agent linear work**:

```
root task (in_progress)
  ├── step-1 subtask (completed)
  ├── step-2 subtask (in_progress)
  └── step-3 subtask (pending)
```

**Multi-phase feature**:

```
epic: "Ship auth v2" (open)
  ├── feature: "JWT middleware" (in_progress)
  │     ├── task: "Write validateToken()" (completed)
  │     └── task: "Write refreshToken()" (in_progress)
  └── feature: "Rate limiting" (pending)
```

**Note**: Due to Gap 1 above, use `parentTaskId` in `task_create` for
hierarchy even though it is stored as a label. Do NOT call `br dep add`
or `br create --parent` directly, as those will diverge from what the agent
tools can read.

### 8.6 Claiming tasks in multi-agent scenarios

The `claimTask` method in `TaskStore` exists (uses `br label add assignee:<id>`

- `br update --status in_progress`) but is not exposed as an agent tool.
  If you need multi-agent task claiming, use `br update --claim` via the
  shell tool, or rely on status-checking via `task_list { status: "pending" }`
  and `task_update { status: "in_progress" }` as a soft lock.

### 8.7 Querying the board efficiently

- `task_list` with no parameters returns all non-closed tasks (up to `br`'s
  default limit of 50).
- Pass `status: "completed"` to see closed tasks.
- For subtask work: `task_get <parentId>` returns `subtasks` array inline —
  prefer this over `task_list { parentTaskId }` for a single parent.
- For board-level visibility, call `br stats --json` via shell for aggregate
  counts.

### 8.8 Avoiding stale tasks

- At the start of a session, run `task_list` to see what is `in_progress`.
  Any tasks left `in_progress` from a prior session that you are resuming
  are still valid — the beads backend persists across sessions.
- Close or reopen stale tasks explicitly; do not create duplicates.
- Run `br stale` (via shell) periodically to surface tasks untouched for
  30+ days.

### 8.9 Using `br` directly for things the tools don't cover

The agent has shell access. For operations not exposed through agent tools,
use the shell tool to call `br` directly:

```bash
# Find what to work on next
br ready --json

# See blocked tasks
br blocked --json

# Full text search
br search "authentication" --json

# Dependency management
br dep add <issue-id> <blocker-id>
br dep tree <issue-id>

# Epic progress
br epic status --json

# Board stats
br stats --json
```

Always pass `--json` for machine-readable output and `--no-color` if
parsing stdout.

---

## 9. Quick reference card

```
# Create
br create "Fix login bug" -t bug -p 1 -d "Users get 403 on valid credentials"
br q "Quick note title" -p 3          # print ID only

# Read
br list --json                          # open tasks
br list -s closed --json                # closed tasks
br list -a --json                       # all tasks
br show <id> --json                     # full detail + comments
br ready --json                         # actionable now
br blocked --json                       # dependency-blocked

# Update
br update <id> --status in_progress
br update <id> --title "New title" --description "More context"
br update <id> --claim                  # assignee=actor + in_progress

# Close / reopen
br close <id> --reason "shipped"
br reopen <id>

# Comments / output
br comments add <id> "Output text here"
br comments <id> --json

# Hierarchy
br create "Subtask" --parent <parent-id>   # native dep edge
br label add <id> "parent:<parent-id>"      # label-based (current agent approach)

# Dependencies
br dep add <issue> <blocker>
br dep tree <issue>
br graph <issue>

# Stats
br stats --json
br count --by-status
br epic status --json
```
