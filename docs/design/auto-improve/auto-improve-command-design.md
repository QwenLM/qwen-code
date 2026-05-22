# Auto-Improve Built-In Command Design

## Goal

Add a built-in `/auto-improve` command that runs a session-scoped loop for
small, locally verifiable repository improvements. The command should be useful
without becoming a hard-coded automation framework: first version keeps the
actual implementation, testing, repair, delivery, and documentation work
prompt-driven, while the built-in command owns reliable local state, scheduling,
status, and source configuration.

## User Commands

Expose four user-facing subcommands:

- `/auto-improve source`
- `/auto-improve start --every <interval> [prompt]`
- `/auto-improve status`
- `/auto-improve stop`

`source` is interactive-only. It opens a dialog with checkboxes for GitHub
issues, GitHub PRs / CI / review comments, and local repository scanning, plus a
custom source list. Users can add multiple custom source hints, edit existing
items, and delete items. Custom sources can be used alone or together with
checked built-in sources. Defaults are all off and an empty custom source list.

`start` may run even when no source and no prompt are configured. In that case
the tick prompt tells the agent to do a small baseline repository inspection and
choose one locally verifiable task. `start` snapshots the current repo-level
source configuration into the loop; future `source` changes affect only future
loops.

## State Layout

Store state under `.qwen/auto-improve/`:

```text
.qwen/auto-improve/
  config.json
  active.json
  loops/
    <loop-id>/
      state.json
      summary.md
      runs/
        index.json
        001-xxx.md
```

`config.json` is repository-level default source configuration, including the
built-in source toggles and ordered custom source hints. `active.json` is a thin
pointer to the one active loop. First version allows at most one active loop per
repository. `state.json` belongs to a single loop and contains the cadence,
loop default branch, source snapshot, delivery policy, start prompt, status,
stop request flag, current run, last run, and cron job id when available.
Historical loops remain in `loops/`, but `/auto-improve status` reads only the
active loop.

The loop is session-scoped. Exiting Qwen Code is equivalent to stopping the
loop. If the CLI exits abruptly and leaves `active.json` behind, a later status
can mark it stale rather than pretending it is still running.

## Loop Behavior

`/auto-improve start --every 2h [prompt]`:

1. Refuses to start if another active loop exists.
2. Reads `config.json`.
3. Captures the current local branch as `targetBranch`.
4. Creates a new loop directory with a `state.json`, `summary.md`, and `runs/`.
5. Registers a session-only recurring schedule.
6. Immediately submits the first tick prompt.

Each tick is prompt-driven. The prompt instructs the agent to:

- read the loop state;
- select exactly one small, coherent, locally verifiable improvement from the
  source snapshot and optional start prompt;
- create a dedicated issue branch from the repository default branch for
  GitHub issue-derived tasks;
- create an isolated worktree and branch;
- implement the change;
- run appropriate tests;
- repair and retest up to five times;
- commit only after tests pass;
- choose a delivery branch before editing;
- use a PR's head branch for PR-derived review / CI / comment tasks;
- prioritize open, non-draft PRs for PR-derived work;
- focus on actionable unresolved review comments, requested changes, and
  failing checks instead of already-resolved comments or general comment
  history;
- use the loop default branch for ordinary local/default tasks;
- use a local-only branch if the correct delivery branch is unclear;
- never merge a PR-derived fix into the loop default branch unless they are the
  same branch;
- never push unless the user explicitly requested push in the start prompt or
  selected source;
- never overwrite or discard user uncommitted work;
- delete the worktree after success or after five failed repair attempts;
- update `summary.md`, `runs/index.json`, and one run document for every
  attempted run.

Successful runs are local commits by default. For PR-derived tasks, the local
commit belongs to the PR head branch rather than the branch that started the
loop. The first version does not push unless the user explicitly requested it
and does not open pull requests. Failed runs delete their worktree and leave
only the run document.

## Stop And Status

`stop` is graceful. If no run is active, it cancels future scheduling, marks the
loop stopped, and clears `active.json`. If a run is active, it cancels future
scheduling and writes `stopRequested: true`; the current run may naturally
finish, fail, or cancel, but no later tick should start.

`status` displays the active loop when present. If there is no active loop, it
falls back to the most recent historical loop so stopped loops remain
discoverable. Status includes loop id, status, cadence, target branch, source
snapshot, start prompt, current run, last run, recent run records, and
next/future schedule information when available.

## Implementation Shape

Implement `/auto-improve` as a built-in command. Use a small hidden
`/auto-improve tick <loop-id>` subcommand as the scheduled entrypoint; it
returns `submit_prompt` with the internal tick instructions. The hidden tick is
not shown in help and is not part of the public UX.

This keeps the first version simple: program code controls reliable command
state and scheduling, while the agent remains responsible for the engineering
workflow inside each improvement run.
