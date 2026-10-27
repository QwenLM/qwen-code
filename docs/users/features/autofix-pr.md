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
- You run it from a clone of the PR's repository with one git remote for it. In a daemon session (`qwen serve`, the Web Shell), that clone has to sit inside the session's working directory: the daemon runs a fix agent's commands only there, so `prepare` refuses a PR whose clone is not. A watch there is a durable scheduled task bound to its session: the daemon keeps that session resident instead of reclaiming it once idle and the task appears on the Scheduled tasks page, so closing the browser tab does not end the watch — `/autofix-pr stop` does. The task is rehydrated after a daemon restart; a restart drops the gate's in-process approval, so the gate then needs an approval mode or a saved rule that lets it run unattended, and the first blocked fire names the rule to add. One daemon conversation carries one scheduled task, so a second watch there needs a conversation of its own. A restart also drops what the session confirmed for the watch: until `/autofix-pr resume <n>` confirms it again, its helpers and its fixes follow the approval mode as shell commands do.
- The skill runs its helpers through the `autofix_pr` tool. On a watch you started or resumed in this session, a round's helpers — the push and the replies included — run without asking. Starting or resuming a watch, scheduling it, and taking one over from another session — which `/autofix-pr stop <n>` naming the PR does — still ask, each time (in [Auto Mode](./auto-mode.md) its classifier decides, except that a start is always yours to confirm), and so do `gh pr view` and creating the scheduled task. A rule that denies the shell command, such as `Bash` or `Bash(qwen autofix-pr *)`, denies the tool's call too, an ask rule for it keeps the call asking, and `AutofixPr(command:push)` in your deny rules stops every push. A PreToolUse hook you set on the shell tool does not see these calls; set it on `autofix_pr`. In a clone with a git hook that a push or sync runs (`pre-push`, `post-checkout`, `post-merge`, `reference-transaction`) — a hooks path inside the worktree, such as husky's, or a hook manager such as pre-commit or lefthook that runs what a file in the PR says — `sync` and `push` ask too unless the fixes run without asking (below). So does every helper of a worktree with a submodule whose git directory sits inside it rather than in the clone's own, and an ask rule for the shell command asks here too. The skill also grants reading its own files under `.qwen/tmp/`, writing its fix brief, reply plan and your instructions there, and listing scheduled tasks. Those files live in the clone's main worktree; from a session started in a linked worktree, reading and writing them asks as well.
- The start question also offers **Start, fixes run without asking**: the fix agent's commands — builds, tests, commits in the PR worktree — then run without asking for this watch, after one more dialog that confirms it (declining that dialog cancels the start; run `/autofix-pr <n>` again). Its agent runs as one of a [YOLO](./approval-mode.md) session would: with your `git` and `gh` credentials, able to reach files outside the worktree, past your ask rules; your deny rules still apply. That lasts until the watch is stopped, started again with plain **Start** (or `--yes`), or the session exits or is cleared; `/autofix-pr resume` asks again. Choose plain **Start**, and in the default [approval mode](./approval-mode.md) each of its commands asks first, which suits a watch you keep an eye on. Taking a watch over and `/autofix-pr resume` offer the same choice. Only you answer that dialog: no saved rule, [Auto Mode](./auto-mode.md)'s classifier or `--yes` does, and the choice is refused in an untrusted folder and to a program driving Qwen Code through stream-json. A scheduled round of such a watch runs its fix agent in the background, so the session stays usable while it works; it stays in the foreground in a YOLO session (which records no such choice), for `--once`, for a round that restarted in its turn because the PR moved, and for the round that redoes a discarded background fix; the agent that merges someone else's push before the round pushes always runs in the foreground. The round goes on — re-runs, the push and the replies — when the agent's completion notification arrives. Meanwhile the PR's helpers refuse until it ends and its gate stays quiet; `/autofix-pr status` shows the fix running; `/autofix-pr stop <n>` in this session stops the agent first, while from another session stop and resume are refused until it ends — at most 45 minutes. Starting or resuming the watch again is refused while its fix runs; `/autofix-pr stop <n>` stops it. Meanwhile your own edits of files in its worktree (`.qwen/tmp/autofix-pr-<n>/`) ask first whatever the approval mode, as the fix agent goes on building and running what is there, and an agent this session starts from inside that worktree is refused. Only the session running the fix knows of it: an agent of another session on the same clone is not refused, so do not work in that worktree from a second session while a fix runs. A fix whose round never went on (the session ended, or no claim came within 40 minutes of its start) is discarded by the next round, which handles its items again in the foreground. Where the `autofix_pr` tool is not available (a tool allowlist in your settings can leave it out), the helpers run through the shell and each asks first.
- A PR whose author cannot push to the repository runs someone else's code, with your `gh` and `git` credentials in reach, when a fix is verified. Such a PR is never watched: only `--once` is offered, after a confirmation that says so and that `--yes` does not skip.

When it starts, it asks once to confirm where it will push and that it will reply on the PR, and whether the fixes may run their commands without asking.

## What a check does

A watch is a [scheduled task](./scheduled-tasks.md) whose gate runs `qwen autofix-pr snapshot <n> --gate` at every fire, outside the model. The probe prints only what changed since its last run, so a quiet PR costs no model turn. When something changed, a round runs:

1. A merged or closed PR ends the watch. Someone else's push is adopted first.
2. The failed checks, the new comments from trusted authors and a merge conflict go to one fix agent, working in the PR worktree — in the background when the fixes run without asking. For a failed check it reads the job log; a failure outside the PR (network, runner) is re-run once instead of fixed.
3. The agent verifies its change with the repository's own checks and commits only when they pass.
4. The commits are pushed as a fast-forward of the PR head, never forced. If someone pushed meanwhile, their work is merged first.
5. Each review thread it handled gets a reply — `Fixed in <sha>: …`, `Not changed: …` or `Needs a human decision: …` — and each push gets one summary comment.

A round never asks you anything. What needs a person is answered on the PR as "Needs a human decision", reported in the session and listed by `/autofix-pr status`.

## Status and resuming

`/autofix-pr status` lists every watch of the clone, whichever session runs it: the PR and its branch, the head, the pushes used, when its gate last checked and its last round ran, whether this session runs it, and what is waiting for a person. It reads the watches' files only and asks GitHub nothing.

A watch ends when the session that ran it exits — in a daemon session its task is durable and bound to that session, so the daemon keeps it resident and the watch survives a daemon restart — and its scheduled task expires after 7 days by default (the `experimental.cronRecurringMaxAgeDays` setting, or `QWEN_CODE_CRON_MAX_AGE_DAYS`). Its state file stays. `/autofix-pr resume` starts again, in the current session, every watch that this session does not run — or the one you name — with the interval, `--no-reply` and instructions it was started with, and its pushes, history and budgets kept. It asks once for all of them, then runs one round of each and schedules it again. In a daemon session one conversation carries one scheduled task, so resume the others one conversation at a time. If another session is still running one of them, that session's task stops at its next fire; without a PR named, `resume` leaves out a watch another session checked recently, and says so. A watch whose PR was merged or closed while no session ran it is removed by its round. A watch started with `--once`, or one `stop` ended while keeping its worktree, is started again with `/autofix-pr <n>`.

### In the Web Shell

The Web Shell shows the same state, read from the same files:

- **PR watches**, in the sidebar, lists the watches of every workspace the Web Shell can reach. For each watch it shows the PR (a link), where the watch is, its pushes, when its gate last checked and its last round ran, and what is waiting for you:
  - watching;
  - fixing in the background, and for how long;
  - a background fix left behind, which the next round redoes;
  - not checked recently;
  - the PR merged or closed;
  - stopped.
- On the **Scheduled tasks** page, the card of a watch's task shows the same state under the task.
- **Open session** goes to the conversation that runs the watch.
- **Stop watch** sends `/autofix-pr stop <n>` to that conversation, exactly as if you typed it there, and it asks what it would ask there.
- Both buttons appear only for a watch run by a conversation of this Web Shell. A watch run from a terminal is stopped in that terminal. One that no session runs any more is cleaned up, or started again, with `/autofix-pr stop <n>` or `/autofix-pr resume <n>` in a session of its workspace.

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
| Minutes a background fix may run      | 30    | its agent is stopped     |

## Stopping and files

`/autofix-pr stop <n>` deletes the scheduled task and removes the worktree, its branch and the state file; the gate cursor and the PR's history stay, so a later watch does not answer the same comments again. A worktree that still holds unpushed work is kept, and the report says why; the watch has ended all the same, and `qwen autofix-pr cleanup <n> --force` discards the work. `/autofix-pr stop <n>` also stops a watch another session left behind; a bare `/autofix-pr stop` leaves a watch another session is still running alone, and naming its PR ends it. A watch whose task expired, or whose terminal session exited, ends without a report; `/autofix-pr resume` starts it again (above). Starting `/autofix-pr <n>` in a new session — or after `/clear` or `/resume` — also offers to take the watch over, its pushes and budgets kept.

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
| `autofix-pr-<n>-fix.json`                | the fix running in the background, refreshed while it runs        |
| `autofix-pr-<n>-fix-snapshot.json`       | the snapshot the last background fix worked from                  |
| `autofix-pr-<n>-*.log`, `*.md`, `*.json` | CI logs, fix briefs and reply plans                               |

The design is in [`docs/design/2026-10-21-autofix-pr-command.md`](../../design/2026-10-21-autofix-pr-command.md).
