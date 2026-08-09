# Multi-Agent Coordination

Use `/coordinate` when independent Qwen agents can investigate parts of a task in parallel and one Leader should produce the final result:

```text
/coordinate inspect the authentication flow, compare the retry paths, and implement the smallest safe fix
```

Qwen Code launches one to three homogeneous investigators with the current model. Each investigator has exactly four repository-reading tools and cannot edit, run shell commands, delegate, access MCP, or persist work. The current session verifies their evidence and remains the only writer.

## Durable coordination with Agent View

Agent View is the experimental durable runtime for work that needs background execution, reconnection, reassignment, or one isolated writer.

Create one task file per assignment, then dispatch them together:

```bash
qwen agent-view dispatch \
  --task /absolute/path/investigate-api.md \
  --task /absolute/path/investigate-tests.md \
  --json
```

Add at most one writer task when the task benefits from an isolated implementation attempt:

```bash
qwen agent-view dispatch \
  --task /absolute/path/investigate.md \
  --writer /absolute/path/implement.md \
  --json
```

The JSON acknowledgement contains the full coordination, task, attempt, session, and prompt IDs. Keep the full coordination ID and collect with:

```bash
qwen agent-view collect <full-coordination-id> --json
```

At most three coordination workers and one writer can run at once. Read-only workers receive only `read_file`, `grep_search`, `glob`, and `list_directory`. The isolated writer adds only `edit` and `write_file`; it does not receive a shell.

## Inspect and continue an attempt

Open the roster, then inspect a managed attempt:

```bash
qwen agent-view
qwen agent-view peek <session-id>
qwen agent-view logs <session-id>
```

Managed coordination workers are one-shot. `send`, `answer`, `attach`, and generic `respawn` are rejected for them. If an agent returns `handback`, or an attempt fails or becomes stale, create a replacement without losing its lineage:

```bash
qwen agent-view reassign \
  <full-coordination-id> \
  <full-task-id> \
  --task /absolute/path/replacement.md \
  --json
```

## Results and writer receipts

Results are accepted only if the source checkout still matches the snapshot captured at dispatch. A changed checkout is reported as `checkout_changed`; the old result remains auditable but is not current evidence. Managed workers cannot access Git metadata or paths excluded by Git, `.qwenignore`, or configured custom ignore files. Repositories with Git submodules are rejected until nested snapshots are supported.

A clean writer worktree with no reported artifacts is removed automatically after the worker has exited. If the writer changed files, created unmerged commits, reported an artifact, or the worktree changes during cleanup, collection preserves it and returns its path, branch, and base commit. Review that receipt before applying the changes to the source checkout.

## Scope

Coordination is explicit; ordinary prompts never fan out automatically. All workers use the same Qwen configuration. Persistent heterogeneous Agent Teams and cross-vendor routing are not part of this feature.
