# `/autofix-pr`: Watch a Pull Request and Fix It Locally

[English](2026-10-21-autofix-pr-command.md) | [简体中文](2026-10-21-autofix-pr-command.zh-CN.md)

Status: in progress. 2026-10-21, revised the same day after the scheduled-task
gate ([2026-10-21-scheduled-task-gate.md](2026-10-21-scheduled-task-gate.md),
PR #15069) replaced the model-driven tick: the trigger layer is a `gate` on a
scheduled task, and this command's probes — `snapshot --gate` for the author
and `review watch-repo` for a reviewer — are implemented, together with the
`prepare`, `ci-log` and `cleanup` helpers. Delivery step 3 (2026-10-24) adds
the reaction layer: the `push`, `sync`, `reply` and `rerun` helpers and the
bundled `/autofix-pr` skill, with `--once` and watch mode. The reviewer
watch, the loop state of step 4 and the follow-ups of step 5 are still
proposals. The four product decisions in
[Resolved decisions](#11-resolved-decisions) were made on 2026-10-21; the
fourth is revised there.

## 1. Problem

After a pull request is opened, the author still has to watch it: CI fails on a
platform they did not test, a reviewer leaves comments, the base branch moves
and the PR conflicts. Each round is small, but it needs someone to notice, sync
the branch, fix, verify, push and reply. Today Qwen Code can do each step when
asked, but nothing watches the PR and starts the next round on its own.

`/autofix-pr` closes that loop inside a local Qwen Code session. It watches one
PR, fixes CI failures, review feedback and merge conflicts in an isolated
worktree, pushes the fix to the PR branch, replies to the feedback it handled,
and stops when the PR is merged or closed.

## 2. Current state

Everything this command needs to schedule, isolate and delegate work already
exists on `main`:

| Capability                  | Existing building block                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recurring trigger           | `cron_create` (`packages/core/src/tools/cron-create.ts`): session-only or durable, recurring jobs jittered by up to 10% of the period, auto-expiry. Fires enter the notification queue and never interrupt a running turn (`packages/cli/src/ui/hooks/use-llm-stream.ts`).             |
| Model-free trigger          | A scheduled task's `gate` ([2026-10-21-scheduled-task-gate.md](2026-10-21-scheduled-task-gate.md)): a command runs at each fire outside the model; silence skips the fire with no turn, output wakes the session with the output attached as data. The probes below are such commands. |
| Loop conventions            | Bundled `loop` skill (`packages/core/src/skills/bundled/loop/SKILL.md`), `cron_list` / `cron_delete`, the CronPill.                                                                                                                                                                    |
| Isolated PR worktree        | `qwen review fetch-pr` (`packages/cli/src/commands/review/fetch-pr.ts`) and its git helpers (`releaseWorktree` in `packages/cli/src/commands/review/lib/git.ts`, `redirectedAncestor` in `lib/worktree.ts`).                                                                           |
| Delegation                  | The `agent` tool with `working_dir` and `run_in_background` (`packages/core/src/tools/agent/agent.ts`).                                                                                                                                                                                |
| Deterministic skill helpers | The `qwen review <helper>` pattern: logic lives in tested CLI subcommands and the skill calls them through `"${QWEN_CODE_CLI:-qwen}"`.                                                                                                                                                 |
| Conflict policy             | The `/resolve` design ([2026-06-23-fix-conflicts-command.md](2026-06-23-fix-conflicts-command.md)): merge the base branch and push with `--force-with-lease` against the expected head SHA.                                                                                            |
| Untrusted-input rules       | The repository's `.qwen/skills/autofix` skill treats PR text, comments and logs as data, not instructions.                                                                                                                                                                             |

What is missing is the deterministic part: reading a PR's state and computing
what changed since the last check, enforcing push safety, and posting replies
without creating feedback loops. Running a monitor until a condition is met
does not fit, because `monitor` stops after at most 10 minutes of silence,
while a PR can stay quiet for hours; a gated scheduled task has no such cap
and costs nothing while the PR is quiet.

## 3. Goals and non-goals

Goals:

- Watch one PR from a local session and react to CI failures, review feedback
  from trusted authors, and merge conflicts.
- Never touch the user's working tree, and never force-push or push to the
  default branch.
- Reply to the feedback it handled, so reviewers can see what changed.
- Stop on its own when the PR is merged or closed, or when the attempt budgets
  run out, and report why.
- Wake the session only when something changed; a quiet check costs no model
  turn.

Non-goals (first version):

- Running when no Qwen Code session is open (no cloud runner, no webhooks).
- PRs in repositories without a matching local remote.
- Resolving review threads. Reviewers keep that decision.
- Opening new PRs or rewriting PR titles and descriptions.

## 4. User experience

```text
/autofix-pr [<pr-number>|<pr-url>] [--once] [--every <minutes>] [--no-reply] [instructions...]
/autofix-pr status
/autofix-pr stop [<pr-number>]
```

- No PR argument: use the PR whose head is the current branch.
- `--once`: run one check-and-fix pass and do not schedule anything. This is
  the only mode in headless `-p` runs.
- `--every`: check interval in minutes, one of `1, 2, 5, 10, 15, 30, 60`.
  Default `2`: a quiet check runs only the probe, never the model.
- `--no-reply`: push fixes but post nothing on the PR.
- Free text after the options is appended to every fix brief, for example
  "do not touch the public API".

Before it starts, the command shows one confirmation:

- It will push commits to `<owner>/<repo>:<headRef>` and post replies on the
  PR, both under the user's own git and `gh` identity.
- Verification runs repository-defined build and test commands.

The confirmation is asked on every start, not on scheduled checks. A session
that cannot show the confirmation needs `--yes`.

After start, the user sees one line per check only when something happened, for
example `autofix-pr owner/repo#123: fixed "Test ubuntu" and 2 review comments,
pushed 3f2a1c0`. `status` lists watched PRs with last check time, head SHA,
pushes used and comments waiting for a human.

## 5. Architecture

The design follows `/review`: decisions that can be computed are CLI helpers
with unit tests; judgment stays in the skill.

```text
/autofix-pr  (bundled skill: packages/core/src/skills/bundled/autofix-pr/SKILL.md)
  ├─ qwen autofix-pr prepare   validate PR, create pushable worktree and state file
  ├─ qwen autofix-pr snapshot  read PR state, diff against the cursor, emit events + action
  ├─ qwen autofix-pr ci-log    write the failing job's log tail to a file
  ├─ fix                       agent, working_dir = worktree
  ├─ qwen autofix-pr push      guarded push, advances the cursor
  ├─ qwen autofix-pr sync      adopt a head someone else pushed
  ├─ qwen autofix-pr reply     post replies with a marker, record what a round handled
  ├─ qwen autofix-pr rerun     re-run an infrastructure failure, once per check and head
  ├─ qwen autofix-pr cleanup   remove worktree, branch and state file when safe
  └─ cron_create               session-only, recurring, gate:
                               "qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host>";
                               the prompt says how to handle the events the gate printed

qwen review watch-repo         the reviewer's probe: PRs opened, pushed or marked
                               ready since the last run, behind a gate of its own
```

Helpers live under `packages/cli/src/commands/autofix-pr.ts` and
`packages/cli/src/commands/autofix-pr/`; the reviewer probe lives with the
other `qwen review` helpers. Per-PR state lives next to the worktree, outside
it, under the clone's main worktree. Branches are shared by every worktree of
a clone, so each helper finds the same watch from any of them, the autofix
worktree included:

- worktree: `.qwen/tmp/autofix-pr-<n>/`
- state: `.qwen/tmp/autofix-pr-<n>-state.json`
- gate cursor: `.qwen/tmp/autofix-pr-<n>-gate.json`
- logs, briefs and reply plans: `.qwen/tmp/autofix-pr-<n>-*.{log,md,json}`
- reviewer cursor: `.qwen/tmp/review-watch/<host>/<owner>/<repo>.json`

## 6. Helper contracts

### 6.1 `prepare <pr> --repo <owner>/<repo> [--host <host>]`

1. Resolve the PR with `gh`. Refuse when the PR is closed or merged, when its
   head repository was deleted, or when its head is the default branch.
2. Check push permission before any work. A same-repository PR needs the
   repository's `viewerPermission` to be `WRITE`, `MAINTAIN` or `ADMIN`. A fork
   PR needs a viewer that owns the fork, or write access plus
   `maintainerCanModify`. Otherwise refuse with the reason.
3. Require exactly one local remote that matches the base repository (the
   matcher behind `review match-remote`).
4. Resolve the push target. Prefer the one local remote that matches the head
   repository and pushes only to it: the matcher reads fetch URLs, so every
   URL the remote pushes to — its `pushurl`, or each of several `url` entries
   — is checked by the same matcher, and a remote with any destination
   elsewhere does not count. Otherwise use the head repository URL in the
   protocol from `gh config get git_protocol`. Record it in the state file.
5. The state file is the lock. It records the session id
   (`QWEN_CODE_SESSION_ID`); a state file written by another session is a
   refusal, never a takeover.
6. Fetch `refs/pull/<n>/head` into local branch `qwen-autofix/pr-<n>` and
   create the worktree on it. `prepare` never discards earlier work: a
   leftover worktree, or a leftover branch that may hold commits beyond the
   recorded head, is a refusal that points to `cleanup`.
7. Re-running `prepare` in the owning session while the worktree exists reports
   the existing state with `resumed: true` and calls nothing else. If the
   worktree was removed (also with `rm -rf`, which `git worktree prune`
   clears), it is recreated and the recorded `pushedShas`,
   `handledCommentIds` and `postedCommentIds` are kept. A state file for
   another repository's PR of the same number is a refusal. Repositories
   compare as on GitHub: owner and name without case, and the host without
   case or the default port, but with any other port, which may name another
   instance.
8. Print a JSON report: worktree path, branch, head SHA, base/head refs, push
   target, viewer and PR author logins, draft and fork flags, and
   `localUnpushedCommits`, the number of commits on the user's own copy of the
   head branch that the PR does not have. The worktree never sees them. Only a
   local branch whose upstream is the head branch on the push remote counts as
   that copy, so a fork's `main` is never compared with the user's `main`.

### 6.2 `snapshot <pr> [--repo <owner>/<repo>] [--host <host>] [--gate]`

One GraphQL call, plus one per further page of checks or review threads,
reads:

- PR fields: `state`, `isDraft`, `url`, `headRefOid`, `mergeable`, the author
  and the viewer
- the status check rollup of the head commit, paged past the first 100
  contexts (up to ten pages; a head on a busy repository carries well over
  100, and a failure on a later page must not read as all green)
- the `reviewThreads`, paged past the first 100 (up to ten pages: threads
  come oldest first, so a new one is on the last page), each with its first
  comment's `databaseId` and its last 100 comments (`id`, `databaseId`,
  `author { __typename login }`, `authorAssociation`, `body`, `url`)
- the last 100 `reviews` and the last 100 issue comments

The rollup lists every run on the head: earlier attempts of a re-run job,
and each trigger of a workflow that runs on several events. Only the latest
run of each check counts — a check run is its app, its workflow (by id: two
workflow files may share a name), the trigger event and the job name,
ordered by the run's id; a commit status is its context, ordered by creation
time — so a failure that a re-run turned green is not reported. Two apps that
publish a check of the same name publish two checks: a branch rule can
require it from either, so one's success does not clear the other's failure.

Without `--gate`, `snapshot` compares them with the state file `prepare`
wrote and prints events plus one action:

```json
{
  "action": "fix",
  "headSha": "3f2a1c0...",
  "isDraft": false,
  "url": "https://github.com/owner/repo/pull/123",
  "events": [
    {
      "type": "ci_failed",
      "check": "Test ubuntu",
      "url": "https://github.com/owner/repo/actions/runs/456/job/789",
      "runId": 456,
      "key": "Test ubuntu@3f2a1c0...@#789"
    },
    { "type": "ci_pending", "checks": ["Lint"] },
    {
      "type": "review_thread",
      "threadId": "PRRT_x",
      "replyTo": 1001,
      "path": "src/a.ts",
      "line": 3,
      "outdated": false,
      "comments": [
        {
          "id": "PRRC_y",
          "author": "alice",
          "trust": "collaborator",
          "body": "...",
          "url": "..."
        }
      ]
    },
    {
      "type": "untrusted_comment",
      "id": "IC_z",
      "author": "someone",
      "url": "..."
    },
    { "type": "conflict" }
  ],
  "truncated": []
}
```

Event rules:

- Comment ids are GraphQL node ids, unique across comments, reviews and
  threads. `replyTo` is the `databaseId` of a thread's first comment, the only
  id the REST replies endpoint accepts; it is read on its own, so a thread
  past 100 comments still has it.
- Checks count only for the current `headRefOid`; a rollup of an older commit
  is ignored. A check run fails on `FAILURE`, `TIMED_OUT` or
  `STARTUP_FAILURE`; a commit status fails on `FAILURE` or `ERROR`.
  `CANCELLED` is not a failure. `runId` is parsed from an Actions URL and is
  null otherwise.
- CI that is still pending alone means `wait`. A trusted comment can still be
  fixed while CI runs, because the next push restarts CI anyway.
- A comment is new when its id is neither in `handledCommentIds` nor in
  `postedCommentIds`, and it is not one of the tool's replies: a comment by
  the viewer whose body ends with the reply marker (Section 9). A marker
  anywhere else — someone quoting a reply — does not hide a comment.
  Resolved threads, empty or pending reviews, and dismissed reviews (a
  dismissed review was withdrawn) are skipped; outdated threads are kept
  with `outdated: true`.
- A head SHA that differs from `lastKnownHeadSha` and is not in `pushedShas`
  is `head_moved_externally`.
- `truncated` names the connections (`checks`, `reviewThreadComments`,
  `reviewThreads`, `reviews`, `comments`) that had more entries than the
  query reads.

Action precedence: `stop` (merged or closed) → `resync` (head moved
externally) → `fix` (a conflict, a failed check or a trusted comment) →
`wait`. The loop adds two more inputs: an exhausted budget means `stop`, and a
fix in flight (`inFlight` in the state file) means `wait`, until the attempt
ends (Section 7).

#### Gate mode (`--gate`)

`snapshot <n> --gate` is the command behind the scheduled task's gate. It
needs no worktree and no state file: on the first run `--repo` names the
PR's repository (or the prepared state supplies it), and its own cursor,
`.qwen/tmp/autofix-pr-<n>-gate.json`, records what it has already reported.
Without `--host` (or `GH_HOST`) it uses the host the PR is already watched
on — its cursor's, or the prepared state's — before falling back to
github.com; a blank `--host` is refused. A cursor for another repository's
PR of the same number is a refusal, compared as `prepare` compares state
files. It prints the same
JSON, but only the transitions since the previous run, and prints nothing
when there are none, so the session is woken only for them:

- A failed check is reported once per (check, head, attempt): the cursor key
  carries the run's id (a commit status: its creation time), so a re-run
  that fails again is reported again even when no poll saw it in progress.
  The cursor keeps only the failures still present, and a new head starts
  over.
- Pending checks are never reported; `ci_pending` does not appear.
- A conflict is reported once per head; `mergeable` clears the mark,
  `UNKNOWN` keeps it.
- Comments, reviews and thread comments are reported once each, by node id,
  with the trust rules of Section 8. The viewer's own comments are never
  events, nor are the ones a prepared watch of the same PR has handled
  (`handledCommentIds`, `postedCommentIds`); those the query returns are
  adopted into the cursor, so they stay quiet once `cleanup` has removed the
  state file. An untrusted comment alone is
  reported as a notice (`wait`). The cursor keeps every reported id the query
  still returns, however many, and bounds only the ids that left the page, so
  an identical poll is quiet. A body is cut to its first 1,000 characters
  (`bodyTruncated: true`); the event's `url` leads to the whole of it.
- A head that differs from the previous run's is `head_moved_externally`
  (`resync`), unless a prepared watch of the same PR recorded or pushed it
  (`lastKnownHeadSha`, `pushedShas`); the first run records the head without
  reporting it.
- A merge or close is reported once (`stop`); afterwards the probe is quiet,
  and a reopened PR is watched again.
- A connection read from the front that starts being cut (`checks`,
  `reviewThreads`) is reported once, as `wait` when nothing else happened:
  past the last page a new thread leaves no other trace. A cut that lasts is
  quiet. Comments, reviews and thread comments are read newest first, so a
  cut there hides only older ones: it is listed in `truncated` but wakes no
  one.
- The output stays within 12 KiB, under the 16 KiB the gate hands the
  session (and cuts beyond). Events go in order — head move, conflict,
  failures, comments — and those that do not fit, or the later comments of a
  thread that does not fit whole, are left out, counted in `deferred` and
  not marked reported, so the next run reports them. One event or comment
  always goes, so every run makes progress.
- The first run reports what is outstanding: failed checks, a conflict, and
  comments no one has handled.

The cursor is written before the output, so a probe that prints and then
dies cannot report the same transitions twice. `ci_pending` and the `wait`
action for a quiet PR exist only in prepared mode.

### 6.3 `ci-log <pr> <run-id> [--lines 200]`

Writes the log of each finished job of the run that failed or timed out,
cut after the job's last `##[error]` line (what follows is post-job cleanup)
and trimmed to the last `--lines` lines per job, with a note of how many were
omitted, to
`.qwen/tmp/autofix-pr-<n>-ci-<run-id>.log`, and prints the path and the job
names. The fix agent reads that file instead of piping logs into a shell
preview. `--lines` must be a positive integer. A job whose log cannot be
read gets a `log unavailable: <reason>` line in place of its log, and the
other jobs are still written. A run with no finished job that failed or
timed out — its failed jobs still running, or a startup failure before any
job — is an error, not an empty file.

Each job's log comes from the REST jobs endpoint, not `gh run view
--log-failed`: `gh run view` (with or without `--job`) refuses a run that is
still in progress, and `snapshot` reports a failed job as soon as it fails,
while other jobs of the same run may still be running.

### 6.4 `push <pr>`

Refuses unless all of these hold:

- the worktree is the watch's own: not a symlink, a worktree of its own, with
  `qwen-autofix/pr-<n>` checked out (a fix that switched it to the user's
  copy of the PR branch must not publish that branch);
- the worktree is clean (every change committed);
- `lastKnownHeadSha` is an ancestor of `HEAD` (fast-forward only, no history
  rewrite);
- the target branch is not the base repository's default branch.

It asks GitHub at push time, not at `prepare`: a PR that was merged or closed
meanwhile answers `stop`, and the default branch is read again, since it can
be renamed while a watch runs. The branch and the destination come from
GitHub and the clone's remotes, found the way `prepare` found them, and must
equal the ones the state file recorded, so an edited state file cannot
redirect a push. Every value of the state file that reaches git — the
remote, the push target, the head ref, the SHAs — is checked when the file
is read; one starting with `-` would be taken as an option. A watch that has
used its pushes (10, Section 10) answers `stop` without asking anything. A
`HEAD` equal to the known head has nothing to push.

Then it runs
`git push --porcelain <target> <sha>:refs/heads/<headRef> --force-with-lease=refs/heads/<headRef>:<lastKnownHeadSha>`
from the worktree, with ten minutes for pre-push hooks. `<sha>` is the commit
the checks above passed, not `HEAD`, which could move while GitHub is asked.
Hooks run, and there is no `--force` or `--no-verify`. On success it records
the new SHA in `pushedShas` and `lastKnownHeadSha` and counts one push. A
rejected lease (`[rejected] (stale info)`) means someone else pushed; the
result is `resync`, not a retry, and nothing is recorded. Any other refusal —
a hook, branch protection, credentials — is an error with git's last lines.
The output is one JSON line: `{"pushed": true, "sha", "pushes", "maxPushes"}`,
or `{"pushed": false, "action": "resync" | "stop", "reason"}`.

### 6.5 `reply <pr> <plan.json> [--no-post]`

Posts the replies in a plan the skill writes (Section 9) and records what the
round handled. The plan:

```json
{
  "replies": [
    { "replyTo": 1001, "body": "Fixed in 3f2a1c0: ...", "handled": ["PRRC_x"] }
  ],
  "summary": { "body": "...", "handled": ["IC_y"] },
  "handled": ["PRR_z"],
  "handledChecks": ["Test ubuntu@<head>@#789"],
  "handledConflict": false
}
```

The helper decides what may be posted, against one fresh read of the PR
(the prepared snapshot's rules):

- A reply goes only to a thread that has, right now, a new comment from a
  trusted author, and `handled` names comments of that thread. Untrusted
  comments cannot be marked handled; a check key must be one a `ci_failed`
  event reports on the head (prepared mode prints its `key`); a conflict can
  be left for a human only while there is one. The PR must be open.
- A failure key of another head — the round pushed past it — is ignored and
  counted in `ignoredChecks`: prepared snapshots read only the current head.
  `handledConflict` is recorded against the head unless GitHub reports it as
  mergeable; right after a push it reports `UNKNOWN` until it has recomputed
  the merge.
- A plan with two replies to one thread, or one comment id twice, is refused.
- Every check runs before anything is posted, so a refused plan posts
  nothing.
- Each body gets the marker once and must fit GitHub's 65,536 characters.
- Each posted id is written to the state file the moment it exists, with the
  comments its reply handled. A run that fails part way leaves the rest
  unposted and unrecorded; running the same plan again skips a reply when any
  of its comments is already handled (a comment it did not name stays open
  for the next round, rather than risk a second copy), and the summary when
  its comments are (a summary that handles none is posted once per head,
  `summarizedSha`).
- `handledChecks` and `handledConflict` record failures and a conflict the
  round did not fix with a push, so prepared snapshots stop reporting them:
  a failure by its attempt (a re-run that fails again is new), a conflict by
  its head.
- `--no-post` (the skill's `--no-reply`) records the same, the summary's
  `summarizedSha` included, and posts nothing.

Replies to review threads use
`POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`; the summary is an
issue comment. Neither POST is retried: one that reached GitHub before a
transport error would be posted twice.

### 6.6 `cleanup <pr> [--force]`

Removes the worktree, its branch and the state file together. When the
worktree has uncommitted changes (untracked files and changes inside
submodules included, whatever `status.showUntrackedFiles` or a submodule's
`ignore` setting says), or the worktree (or the branch, once the
worktree was deleted) has commits that no PR head the watch knows of
contains, all three are kept and the report says why. The heads it knows of
are `lastKnownHeadSha` and `pushedShas`, and — asked only when those leave
commits over — the PR head on the remote (`refs/pull/<n>/head`), so work
pushed by hand is not held back. A directory at the worktree path that is
not a worktree of its own is kept: git run inside it would judge the
enclosing clone. Without a state file there is no recorded head, so a
leftover worktree or branch is kept. A state file owned by another session
is a refusal. `--force` overrides these checks and also discards an
unreadable state file. A branch that cannot be deleted is an error, and the
state file stays. Running `cleanup` from inside the worktree it would remove
is a refusal. The gate cursor is not removed: it belongs to the scheduled
task, which outlives a watch, and without it the next fire would report
everything again. Delete the task to stop the gate. The report names the
kept cursor (`gateCursor`): a later gate on another repository's PR of the
same number is refused until that file is removed.

### 6.7 `review watch-repo --repo <owner>/<repo> [--host <host>] [--limit 50] [filters]`

The reviewer's probe, behind a gate of its own. One GraphQL call reads the
most recently updated open PRs (`--limit`, default 50, at most 100) with
their head, draft flag, author, labels and review requests, and whether more
open PRs exist past the limit. The cursor,
`.qwen/tmp/review-watch/<host>/<owner>/<repo>.json` (lowercase, a port's
`:` written as `_`, so every spelling of a repository shares one file),
records every open PR's head and draft flag. With filters the file is
`<repo>@<key>.json`, `<key>` naming the filter set whatever its spelling or
order: two tasks on one repository with different filters keep their own
heads, since a push one of them recorded without reporting it would never
be a transition for the other.

- The first run records the open PRs and prints nothing.
- Afterwards a PR that is new to the cursor is `pr_opened`, one whose head
  changed is `pr_pushed`, and one that was a draft and no longer is is
  `pr_ready`. Each event carries the number, title, author, URL, head SHA,
  base branch, labels and whether the viewer's review was requested.
- Filters decide which PRs become events: `--author <login>`,
  `--label <name>` (both compared without case, as GitHub does),
  `--review-requested` (the viewer is a requested reviewer; team requests do
  not count), `--exclude-drafts`, `--exclude-bots`, `--exclude-mine`. The
  cursor follows every PR regardless, and another filter set starts a cursor
  of its own whose first run is silent, so changing a filter does not replay
  history. Filters choose among the three transitions and are not
  transitions themselves: a label added, or a review requested, on an
  unchanged head prints nothing until the PR's next push.
- A PR missing from the list was closed or merged and leaves the cursor —
  unless the list was cut at `--limit`. Then the PRs missing from it may
  still be open, and the cursor keeps up to `--limit` of them, highest
  numbers first, since closed and merged ones cannot be told apart and would
  otherwise accumulate. An open PR that fell out of the cursor and changes
  again comes back as `pr_opened`.

Output: `{ "repo": "<owner>/<repo>", "events": [...] }`, and nothing when
there are no events. Within the same 12 KiB as the author's gate, events that
do not fit are left out and counted in `deferred`; their PRs keep their old
head in the cursor, so the next run reports them. The skill that uses it decides what each event means:
run `/qreview <number>`, or a verification pass, per PR.

### 6.8 `sync <pr> [--discard]`

Adopts a head someone else pushed. It fetches the PR branch from the push
target — the ref the push lease protects, which moves at once, unlike
`refs/pull/<n>/head` — into the worktree's own `FETCH_HEAD` (the user's
checkout is untouched), and checks the worktree as `push` does. Then:

- a head that does not contain the known head rewrote the history: the
  author rebased, force-pushed, or rolled the branch back, perhaps past a
  push of the watch. The worktree is reset to it, as Section 7 describes:
  anything built on the old history would put back what the author removed.
  An unpushed attempt made on the old history is reported as `dropped`;
- a head built on the known one that the worktree already contains (a round
  merged it) is only recorded as `lastKnownHeadSha`;
- a worktree behind it is fast-forwarded, when it is clean;
- a worktree with unpushed commits of a round is not touched: the answer is
  `{"synced": false, "action": "merge"}` with the head to merge (never
  rebase), and nothing changes.

A worktree with uncommitted changes is never moved or reset. `--discard`
returns the worktree to the PR head whatever it holds — unpushed commits and
uncommitted changes — to end a round whose work was not pushed, and reports
what it dropped.

### 6.9 `rerun <pr> <run-id>`

Re-runs the failed jobs of a run the fix agent judged an infrastructure
failure, with `gh run rerun <run-id> --failed`. Only a GitHub Actions job of
the PR's repository counts: a commit status or another app may link any URL,
and a run id read from it would re-run some unrelated run. Each failed check
of that run on the head spends its one re-run (`rerunChecks`, keyed by the
check's identity — app, workflow, trigger and job name, as Section 6.2 tells
checks apart — and the head, so two workflows with a job of the same name
each keep theirs);
a run with a check that was re-run on this head already answers
`{"rerun": false}`, and the failure is treated as real. The attempts it
re-ran are recorded in `handledChecks`, so the prepared snapshot does not
dispatch them again while the re-run is going; a re-run that fails again is
a new attempt. A head that moved since the watch last saw it answers
`resync`, and a run with no failed check on the head is an error. The call
is not retried, for the same reason as a reply.

## 7. One check (`tick`)

The gate already ran `snapshot --gate`; a fire that reaches the model carries
its events in the gate output, so a quiet check never becomes a turn.

```text
snapshot --gate (in the gate)
  ├─ stop     → cron_delete, cleanup, report outcome
  ├─ wait     → end the turn with no message
  ├─ resync   → fetch, fast-forward the worktree to the new head, set cursor,
  │             then handle the other events of the same output (the gate
  │             does not report them again);
  │             two resyncs in a row → stop: "someone else is pushing to this PR"
  └─ fix
       1. conflict  → merge origin/<base> in the worktree (merge, never rebase)
       2. ci_failed → ci-log; the agent decides between a code fix and
                      "infrastructure" → gh run rerun <runId> --failed
                      (at most once per check per head SHA, and only once
                      the run has finished: GitHub refuses to rerun a run
                      in progress); when ci-log finds no finished failed
                      job (the run failed before any job started), there
                      is no log to fix from: re-run it under the same
                      rule and report it, and once re-run, report it as
                      needing a human
       3. trusted comments → address or decline with a reason
       4. verify (targeted tests, lint, typecheck chosen from the repo's docs)
       5. commit → push → reply
```

The fix runs in a background `agent` with `working_dir` set to the worktree.
Its brief is a file listing the events, log paths, the trust rules, the user's
extra instructions and the verification requirement. The main session stays
usable. When the agent's completion notification arrives, the main session runs
`push` and `reply`. If verification fails, nothing is pushed; the attempt
counts against the budget and the failure is reported.

`inFlight` records the head an attempt started on and when. Every end of an
attempt clears it, after counting the attempt: a push, a failed
verification, an agent that errors or is stopped, a push the lease refuses,
and a resync. A tick that finds one started on a head that is no longer the
PR's, or longer ago than the attempt time limit (Section 10), counts it as
failed and clears it, so an attempt whose agent died cannot keep the watch
waiting.

A resync whose new head does not contain the worktree's `HEAD` (the author
rebased or force-pushed) resets the worktree to the new head instead of
fast-forwarding. Whatever the tool pushed is now in the author's hands, as
part of the history they rewrote. The reset drops at most an attempt that
was not pushed, which was made on the old head, so `push` would refuse it
anyway; that attempt ends as above.

A tick never asks the user a question. Anything that needs a human (a design
disagreement, contradictory comments, a request outside the PR's scope) is
replied to as "needs a human decision" and recorded in `needsHuman`. The loop
keeps watching other events.

## 8. Trust model

Every comment, review and CI log is data. A trusted author decides which
feedback is acted on, but cannot widen what the tool may do.

Verification runs the PR's code: its tests, and build scripts the PR may
change. For a PR whose author has no write access, that is someone else's
code running unattended with the user's `gh` and `git` credentials in reach.
The watch therefore verifies such a PR only in the sandbox (`QWEN_SANDBOX`);
without one it does not watch it unattended, and `--once` runs in the
foreground after the user confirms. A PR by the user or a collaborator is
verified as the user would verify it. `prepare` reports `authorCanPush` (the
author is the user, or has write access to the base repository) and
`sandboxed` (the session runs in one of Qwen Code's sandboxes), and the skill
applies the rule from them before it asks to start.

A comment is actionable when its author is:

- `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`;
- the PR author;
- a bot account (`__typename == "Bot"`), for reviews and review-thread
  comments only. Bot issue comments, such as coverage or CI reports, are not
  treated as requests.

Never actionable:

- the tool's own replies: an id in `postedCommentIds`, or a comment by the
  viewer that ends with the reply marker. The viewer is often the PR author
  and therefore trusted, so without this rule the tool would answer itself.
- comments from anyone else. They are listed in `status` and the final report,
  but never acted on or replied to.

Even for actionable comments, the brief forbids: revealing secrets or tokens;
editing CI configuration to skip, disable or weaken checks; deleting or
weakening tests to make them pass; force-pushing; and changes unrelated to the
PR. Such requests get a "needs a human decision" reply.

Loop guards for bots: each review thread gets one fix attempt, and pushes are
capped (Section 10). A bot that re-reviews every push therefore cannot keep the
loop running forever.

## 9. Replies

Replies are on by default; `--no-reply` turns them off.

- Each handled review thread gets a reply: `Fixed in <short-sha>: <one line>`,
  or `Not changed: <reason>`, or `Needs a human decision: <question>`.
- Each push gets one PR comment summarizing what it addressed: checks fixed or
  re-run, comments addressed, conflict resolved, and how it was verified.
- Replies use the language of the comment they answer; the summary uses the
  language of the PR description.
- Every body ends with `<!-- qwen-autofix-pr:v1 -->`.
- Review threads are never resolved by the tool.

## 10. Scheduling, budgets and lifecycle

- Start runs the first check immediately — `snapshot <n>` in prepared mode,
  which reads the state file and not the gate cursor, so a new watch sees
  everything outstanding whatever an older gate reported — then calls
  `cron_create` with a
  session-only recurring job, cron `*/<every> * * * *` (default `*/2`), the
  gate `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host>`
  (the host it passed to `prepare`), and a
  prompt that tells the model how to handle the events in the gate output
  (`Run /autofix-pr tick <owner>/<repo>#<n> on the events below`). The gate
  is confirmed once, like a Monitor command, when the task is created.
- Fires that arrive while the session is busy wait in the notification queue;
  the probe runs once when the session is idle and prints everything new
  since its previous run.
- The job ends with the process. The state file stays, owned by the session
  that wrote it, and a new session's `prepare` refuses it (Section 6.1).
  Taking a watch over in a later session, keeping its handled comments and
  pushes, is delivery step 4; until then a restart needs
  `cleanup <n> --force`, which discards that history. A watch that stopped
  ran `cleanup` already.
- The cron maximum age setting (`QWEN_CODE_CRON_MAX_AGE_DAYS`) still applies.

Budgets, stored in the state file:

| Budget                                               | Default | When exhausted                 |
| ---------------------------------------------------- | ------- | ------------------------------ |
| Fix attempts per failing check without turning green | 3       | stop the loop                  |
| Re-runs per check per head SHA                       | 1       | treat the next failure as real |
| Fix attempts per review thread                       | 1       | reply "needs a human decision" |
| Pushes per start                                     | 10      | stop the loop                  |
| Consecutive external head moves                      | 2       | stop the loop                  |
| Minutes one fix attempt may run                      | 30      | count it failed, clear it      |

Stop conditions: the PR is merged or closed; `/autofix-pr stop`; a budget in
the table says stop; the cron job expires. Every stop runs `cleanup` and
prints the reason, the pushes made and any `needsHuman` items.

Cost: a quiet check is one probe run — one GraphQL call, plus one per extra
page of checks or review threads — and no model turn. Only a check with events reaches the
model, so a two-minute cadence costs nothing while the PR is quiet.

## 11. Resolved decisions

Decided on 2026-10-21:

1. The command is named `/autofix-pr`.
2. Trusted authors include the PR author and review bots, in addition to
   `OWNER`, `MEMBER` and `COLLABORATOR`.
3. Replying on the PR is part of the first version and on by default.
4. The default check interval was 15 minutes while every check was a model
   turn. With the gate a quiet check costs no turn, so the default is
   2 minutes (revised 2026-10-21).

## 12. Risks, validation and delivery

Risks:

- Pushing under the user's identity. Mitigated by consent on every start, the
  push guard and the budgets.
- Feedback loops with bots or with the tool's own replies. Mitigated by the
  marker, the recorded ids and per-thread attempts.
- Racing another agent or a person on the same branch. Mitigated by
  `--force-with-lease` and stopping after two external head moves.
- Conversation growth in long sessions. A quiet check never reaches the model;
  only events do, and the probes report each transition once.
- A probe that prints on every run would turn the gate back into a
  model-driven loop. Both probes keep a cursor and report transitions only;
  their tests pin that a second run on unchanged data prints nothing.

Validation:

- Unit tests with recorded `gh` JSON fixtures: event diffing, stale checks on
  an old SHA, the trust classes, marker and id self-exclusion, action
  precedence, budgets; the gate cursor rules (once per head, re-run failures,
  conflict marks, the viewer's own comments, merge and reopen) and check
  rollup paging; the reviewer probe's events, filters and cursor pruning.
- Push guard tests against a local bare repository: non-fast-forward refusal,
  default-branch refusal, lease rejection after an external push.
- An integration test with a fake `gh` on `PATH` that drives `prepare` →
  `snapshot` → `push` → `reply` → `cleanup`.
- Manual end-to-end on a sandbox repository: a failing test is fixed and
  pushed; a collaborator comment is fixed and answered; a stranger's comment is
  ignored; merging the PR ends the loop and removes the worktree.

Acceptance criteria:

- The user's working tree and current branch are unchanged after any run.
- No push is ever forced or made to the default branch.
- The tool never replies to its own comments or to untrusted authors.
- A merged or closed PR ends the loop within one interval.

Delivery plan:

1. The trigger layer: the scheduled-task gate (PR #15069).
2. The probes (this PR): `snapshot --gate` with its cursor and check paging,
   and `review watch-repo`; `prepare`, `ci-log` and `cleanup` ship alongside
   and wait for the reaction layer.
3. Helpers `push` and `reply` with tests, and the skills: `/autofix-pr` with
   `--once`, then watch mode as a gated task, and the reviewer watch that runs
   `/qreview` or a verification pass per event. The state records which
   failed check attempts were handled, keyed like the gate's cursor (check,
   head, attempt), so a failure the agent declined is not dispatched again,
   while a re-run that fails again is.
   Delivered (2026-10-24) except the reviewer watch: `push`, `sync`
   (Section 6.8), `reply`, `rerun` (Section 6.9), the bundled skill with
   `--once`, watch mode, `stop` and a minimal `status`. In this step the fix
   agent runs in the foreground: the session waits for it, so no fire can
   start a second attempt and `inFlight` is not needed yet. The budgets it
   enforces are the pushes per start (`push`), one re-run per check and head
   (`rerun`), and one attempt per review thread (every comment a round
   handled is recorded, whatever its outcome); two resyncs within one round
   stop the watch, and a round whose work was not pushed ends with
   `sync --discard`, so the next one does not build on it. The sandbox rule of
   Section 8 is applied at the start. The skill's `allowedTools` grant
   reading its `.qwen/tmp` files, writing its brief and plan, and
   `cron_list` — no shell command. The permission matcher reads a leading
   `"${QWEN_CODE_CLI:-qwen}"` as an empty word, so no rule can name the
   helpers alone, and an allow rule for even a read-only command such as
   `gh pr view *` also admits command substitution, redirections and
   environment prefixes behind it. In the default approval mode each helper
   call — the push included — therefore asks first.
4. The loop state: `status`, `stop`, budgets, and a later session taking
   over the state file.
5. Follow-ups: durable watching in daemon sessions (`durable` with
   `sessionMode: "current"`, once the gate supports it), and a configurable
   bot allowlist.

Open questions:

- Should trusted bots be narrowed to a configurable allowlist by default once
  the setting exists?
- Should draft PRs be watched, or refused until marked ready?
- Some automation posts as a regular user account with collaborator access
  (on this repository, `qwen-code-review-bot` writes its triage status
  comments that way). Such comments pass the trust rules and each costs one
  fix pass before it is marked handled. Should a configurable list of
  automation logins be skipped?
