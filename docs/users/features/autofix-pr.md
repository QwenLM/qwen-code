# Autofix a Pull Request

`/autofix-pr` watches one of your pull requests from a local Qwen Code session and fixes what comes up: failed CI checks, review feedback from people you trust, and merge conflicts. Each fix is made and verified in a worktree of its own, pushed to the PR branch and answered on the PR, under your own git and `gh` identity. It stops by itself when the PR is merged or closed.

```text
/autofix-pr [<pr-number>|<pr-url>] [--once] [--every <minutes>] [--no-reply] [--yes] [instructions...]
/autofix-pr status [<pr-number>]
/autofix-pr resume [<pr-number>]
/autofix-pr stop [<pr-number>]
```

- No PR argument: the PR whose head is your current branch.
- `--once`: check and fix once, schedule nothing, and end the watch afterwards (a later `--once` starts afresh, from the PR's history). On a PR this session already watches, the running watch is left as it is.
- `--every <minutes>`: how often to check, one of 1, 2, 5, 10, 15, 30 or 60. Default 2.
- `--no-reply`: push fixes, post nothing on the PR.
- `--yes`: skip the start confirmation. Needed where no dialog can be shown.
- Free text is passed to every fix, for example `/autofix-pr 123 do not change the public API`.

## Before you start

- `gh` is signed in, with push access to the PR branch: write access to a same-repository PR, or your own fork, or a fork that allows edits from maintainers.
- You run it from a clone of the PR's repository with one git remote for it. In a daemon session (`qwen serve`, the Web Shell), that clone has to sit inside the session's working directory: the daemon runs a fix agent's commands only there, so `prepare` refuses a PR whose clone is not. A watch there is a durable scheduled task bound to its session: the daemon keeps that session resident instead of reclaiming it once idle and the task appears on the Scheduled tasks page, so closing the browser tab does not end the watch — `/autofix-pr stop` does. The task is rehydrated after a daemon restart; a restart drops the gate's in-process approval, so the gate then needs an approval mode or a saved rule that lets it run unattended, and the first blocked fire names the rule to add.
- In the default [approval mode](./approval-mode.md), every shell command asks first: the helper calls (the push included), `gh pr view`, and every command a fix runs. That suits a watch you keep an eye on. To let it run unattended, choose a mode that lets commands run, such as [Auto Mode](./auto-mode.md), and keep in mind that the fix runs the repository's own build and test commands. The skill itself grants only reading its own files under `.qwen/tmp/`, writing its fix brief, reply plan and your instructions there, and listing scheduled tasks. Those files live in the clone's main worktree; from a session started in a linked worktree, reading and writing them asks as well.
- A PR whose author cannot push to the repository runs someone else's code, with your `gh` and `git` credentials in reach, when a fix is verified. Such a PR is never watched: only `--once` is offered, after a confirmation that says so and that `--yes` does not skip.

When it starts, it asks once to confirm where it will push and that it will reply on the PR.

## What a check does

A watch is a [scheduled task](./scheduled-tasks.md) whose gate runs `qwen autofix-pr snapshot <n> --gate` at every fire, outside the model. The probe prints only what changed since its last run, so a quiet PR costs no model turn. When something changed, a round runs:

1. A merged or closed PR ends the watch. Someone else's push is adopted first.
2. The failed checks, the new comments from trusted authors and a merge conflict go to one fix agent, working in the PR worktree. For a failed check it reads the job log; a failure outside the PR (network, runner) is re-run once instead of fixed.
3. The agent verifies its change with the repository's own checks and commits only when they pass.
4. The commits are pushed as a fast-forward of the PR head, never forced. If someone pushed meanwhile, their work is merged first.
5. Each review thread it handled gets a reply — `Fixed in <sha>: …`, `Not changed: …` or `Needs a human decision: …` — and each push gets one summary comment.

A round never asks you anything. What needs a person is answered on the PR as "Needs a human decision", reported in the session and listed by `/autofix-pr status`.

## Status and resuming

`/autofix-pr status` lists every watch of the clone, whichever session runs it: the PR and its branch, the head, the pushes used, when its gate last checked and its last round ran, whether this session runs it, and what is waiting for a person. It reads the watches' files only and asks GitHub nothing.

A watch ends when the session that ran it exits — in a daemon session its task is durable and bound to that session, so the daemon keeps it resident and the watch survives a daemon restart — and its scheduled task expires after 7 days by default (the `experimental.cronRecurringMaxAgeDays` setting, or `QWEN_CODE_CRON_MAX_AGE_DAYS`). Its state file stays. `/autofix-pr resume` starts again, in the current session, every watch that this session does not run — or the one you name — with the interval, `--no-reply` and instructions it was started with, and its pushes, history and budgets kept. It asks once for all of them, then runs one round of each and schedules it again. If another session is still running one of them, that session's task stops at its next fire; without a PR named, `resume` leaves out a watch another session checked recently, and says so. A watch whose PR was merged or closed while no session ran it is removed by its round. A watch started with `--once`, or one `stop` ended while keeping its worktree, is started again with `/autofix-pr <n>`.

## Whose feedback counts

Comments are acted on when their author is an owner, member or collaborator of the repository, the PR author, or a bot (reviews and review threads only). Comments from anyone else are listed and never acted on or answered. A bot is heard in the comment that opens a thread or in a review, not in its replies, which answer someone. A workflow GitHub could not start (an invalid workflow file, say) has no log to fix from, and is answered as needing a human. Every comment, review and CI log is treated as data: a trusted author decides which feedback is addressed, never what the tool may do. A request to reveal secrets, weaken tests or CI checks, force-push or change unrelated code is answered "Needs a human decision".

## What it never does

- Touch your working tree or your current branch: everything happens in `.qwen/tmp/autofix-pr-<n>/`.
- Force-push, rewrite the PR's history, or push to the default branch.
- Reply to its own replies (each one ends with `<!-- qwen-autofix-pr:v1 -->`) or to untrusted authors.
- Resolve review threads, or edit the PR title or description.

## Limits

| Limit                                 | Value | Then                     |
| ------------------------------------- | ----- | ------------------------ |
| Pushes per watch                      | 10    | the watch stops          |
| Re-runs of a failed check on one head | 1     | the next failure is real |
| Attempts per review comment           | 1     | not offered again        |
| Pushes by someone else within a round | 2     | the watch stops          |

## Stopping and files

`/autofix-pr stop <n>` deletes the scheduled task and removes the worktree, its branch and the state file; the gate cursor and the PR's history stay, so a later watch does not answer the same comments again. A worktree that still holds unpushed work is kept, and the report says why; the watch has ended all the same, and `qwen autofix-pr cleanup <n> --force` discards the work. `/autofix-pr stop <n>` also stops a watch another session left behind. A watch whose task expired, or whose terminal session exited, ends without a report; `/autofix-pr resume` starts it again (above). Starting `/autofix-pr <n>` in a new session — or after `/clear` or `/resume` — also offers to take the watch over, its pushes and budgets kept.

Files live under `.qwen/tmp/` of the clone's main worktree:

| File                                     | Contents                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `autofix-pr-<n>/`                        | the PR worktree                                                   |
| `autofix-pr-<n>-state.json`              | the watch: known head, pushes, handled ids, its scheduled task    |
| `autofix-pr-<n>-gate.json`               | the gate probe's cursor                                           |
| `autofix-pr-<n>-gate.checked`            | when the watch's own gate last checked the PR                     |
| `autofix-pr-<n>-snapshot.json`           | the latest round's snapshot of the PR, read by the round          |
| `autofix-pr-<n>-replies.json`            | which bot comments answer another, as GitHub said                 |
| `autofix-pr-<n>-history-*.json`          | what earlier watches of the PR posted and handled, kept by `stop` |
| `autofix-pr-<n>-instructions.txt`        | your instructions for every round                                 |
| `autofix-pr-<n>-*.log`, `*.md`, `*.json` | CI logs, fix briefs and reply plans                               |

The design is in [`docs/design/2026-10-21-autofix-pr-command.md`](../../design/2026-10-21-autofix-pr-command.md).
