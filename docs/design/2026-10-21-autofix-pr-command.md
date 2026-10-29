# `/autofix-pr`: Watch a Pull Request and Fix It Locally

[English](2026-10-21-autofix-pr-command.md) | [简体中文](2026-10-21-autofix-pr-command.zh-CN.md)

Status: in progress. 2026-10-21, revised the same day after the scheduled-task
gate ([2026-10-21-scheduled-task-gate.md](2026-10-21-scheduled-task-gate.md),
PR #15069) replaced the model-driven tick: the trigger layer is a `gate` on a
scheduled task, and this command's probes — `snapshot --gate` for the author
and `review watch-repo` for a reviewer — are implemented, together with the
`prepare`, `ci-log` and `cleanup` helpers. Delivery step 3 (2026-10-24) adds
the reaction layer: the `push`, `sync`, `reply` and `rerun` helpers and the
bundled `/autofix-pr` skill, with `--once` and watch mode. Step 4 has begun
(2026-10-25) with the `status` and `schedule` helpers,
`/autofix-pr resume`, and the `autofix_pr` tool that runs the helpers. The reviewer watch, the rest of step 4 and the
follow-ups of step 5 are still proposals. The four product decisions in
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
/autofix-pr [<pr-number>|<pr-url>] [--once] [--every <minutes>] [--no-reply] [--yes] [instructions...]
/autofix-pr status [<pr-number>]
/autofix-pr resume [<pr-number>]
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
pushed 3f2a1c0`. `status` lists every watch of the clone, whichever session
owns it, with its last check and round, head SHA, pushes used, the items
waiting for a human, and whether this session runs it.

A watch's scheduled task ends with the session that ran it, and expires after
7 days. `resume` starts it again in the current session, with the interval,
`--no-reply` and instructions it was started with, its pushes, history and
budgets kept. It confirms once for every watch it resumes, then runs one round
of each and schedules it.

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
  ├─ qwen autofix-pr schedule  record the watch's task, print its cron, gate and prompt
  ├─ qwen autofix-pr status    every watch of the clone, read from its files
  ├─ qwen autofix-pr cleanup   remove worktree, branch and state file when safe
  └─ cron_create               recurring, gate (session-only; durable and bound
                               to the session in a daemon):
                               "qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host> --session <sessionId> --task <task>";
                               the prompt says how to handle the events the gate printed

qwen review watch-repo         the reviewer's probe: PRs opened, pushed or marked
                               ready since the last run, behind a gate of its own
```

Helpers live under `packages/cli/src/commands/autofix-pr.ts` and
`packages/cli/src/commands/autofix-pr/`, and the skill runs them through the
`autofix_pr` core tool (Section 6.12); the reviewer probe lives with the
other `qwen review` helpers. Per-PR state lives next to the worktree, outside
it, under the worktree the watch was prepared from — the session's own
worktree in a daemon session, else the clone's main worktree (see
[2026-10-29-autofix-pr-worktree-rooted-storage.md](2026-10-29-autofix-pr-worktree-rooted-storage.md)).
Branches are shared by every worktree of a clone; the watch listing scans them
all, so a watch is found whichever of them holds it:

- worktree: `.qwen/tmp/autofix-pr-<n>/`
- state: `.qwen/tmp/autofix-pr-<n>-state.json`
- gate cursor: `.qwen/tmp/autofix-pr-<n>-gate.json`
- when the watch's own gate last checked: `.qwen/tmp/autofix-pr-<n>-gate.checked`
- latest prepared snapshot: `.qwen/tmp/autofix-pr-<n>-snapshot.json`
- what GitHub said of bot comments: `.qwen/tmp/autofix-pr-<n>-replies.json`
- logs, briefs and reply plans: `.qwen/tmp/autofix-pr-<n>-*.{log,md,json}`
- the user's instructions for every round: `.qwen/tmp/autofix-pr-<n>-instructions.txt`
- reviewer cursor: `.qwen/tmp/review-watch/<host>/<owner>/<repo>.json` — this
  one stays under the clone's **main** worktree (`repoRoot()`), not the watch
  root: `qwen review watch-repo` is a clone-level probe, not a per-session watch

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
   refusal. `/clear` and `/resume` give a session a new id while its
   scheduled task goes on, so `prepare --take-over` moves the watch — its
   history and budgets kept — to the session that asks, when the user says
   so; the helpers of the session it was taken from refuse from then on,
   and its scheduled task stops at its next fire: its gate names the session that made it (`--session`, the `sessionId` `prepare` reports), and until then moves no cursor — it asks again whose the watch is before it writes one — and only wakes it (`watched_elsewhere`, with the owner as `session`). Each task also names the id `schedule` minted for it (`--task`, Section 6.11): a gate whose id is not the one the state file records — a task a later start or resume replaced, or a copy in a second process of the same session (`qwen --continue`), where the helpers would accept its rounds — answers the same, and one whose watch `cleanup` removed answers `watch_ended`. Either event names the gate's own session and task (`gateSession`, `gateTask`), so the round deletes exactly that task. A round of the old owner that is already under way is stopped by its next helper call, which carries the task too (Section 6.8); its fix agent, which calls no helper, is not, and may go on committing into the worktree, where the new owner's round could push it. That is a known limit: the take-over and resume questions say so when `status` reports `checkedRecently`, and a take-over is best made once the other session has stopped.
6. Fetch `refs/pull/<n>/head` into local branch `qwen-autofix/pr-<n>` and
   create the worktree on it. `prepare` never discards earlier work: a
   leftover worktree, or a leftover branch that may hold commits beyond the
   recorded head, is a refusal that points to `cleanup`.
7. Re-running `prepare` in the owning session while the worktree exists reports
   the existing state with `resumed: true`, asking GitHub only who the
   PR's author is and whether they can push, and deriving the remote and
   the push target from this clone's remotes again: the state file sits
   beside the worktree, in reach of the code a round runs, so none of these
   is read back from it, and a repository this clone does not serve is a
   refusal. Only a 404 from the permission API means the author cannot
   push; any other failure (a rate limit, the network) is a refusal that
   changes nothing, and a take-over is written only once these answers are
   in. A PR whose head repository is gone is a refusal too. On a new watch,
   whether the author can push is asked before anything is fetched or made,
   so a refusal leaves nothing behind. Every file of a watch — state,
   cursor, history, reply cache, snapshot — is read only when it is a
   regular file, so a FIFO planted under its name cannot block a helper or
   the gate, and each is written replacing a link rather than following it,
   so no helper writes outside `.qwen/tmp`. If the
   worktree was removed (also with `rm -rf`, which `git worktree prune`
   clears), it is recreated and the recorded `pushedShas`,
   `handledCommentIds` and `postedCommentIds` are kept, with the budgets,
   the recorded task (`watch`) and `needsHuman`, and the report says
   `recreated: true`: a start that is then cancelled must not clean up a
   watch it did not make. A watch `stop` had ended is resumed the same way
   (`wasEnded`, as on the path that keeps the worktree). With `--take-over`, the
   watch moves to this session only once the PR has passed step 2, so a
   refusal leaves it with the session that has it. A state file for
   another repository's PR of the same number is a refusal. Repositories
   compare as on GitHub: owner and name without case, and the host without
   case or the default port, but with any other port, which may name another
   instance. In a daemon session (`QWEN_CODE_SERVE=1`), the watch is rooted
   at the session's own worktree toplevel, so a session in a linked worktree
   of the clone prepares it inside its own directory. A worktree that would
   still fall outside the session's working directory (the session sits in a
   subdirectory of the worktree, or in another clone) is a refusal before the
   state file is read, on a resume or take-over as on a new watch: the daemon
   runs a fix agent's commands only inside that directory, so a round there
   could not test, commit or push. The refusal names the directory to prepare
   from.
8. Print a JSON report: worktree path, branch, head SHA, base/head refs, push
   target, viewer and PR author logins, draft and fork flags, and
   `localUnpushedCommits`, the number of commits on the user's own copy of the
   head branch that the PR does not have. The worktree never sees them. Only a
   local branch whose upstream is the head branch on the push remote counts as
   that copy, so a fork's `main` is never compared with the user's `main`.
   The report also carries `localUncommittedChanges`: whether a worktree of
   this clone has that copy checked out and holds changes git reports. It is
   read with `--no-optional-locks`, `--untracked-files=normal` and
   `--ignore-submodules=none`, so a user's `status.showUntrackedFiles` or
   submodule `ignore` setting cannot hide work; only `.qwen/tmp`, where the
   helpers write, is left out, and anything else under `.qwen` is the user's.
   It is computed only when the copy exists and only for checkouts of that
   branch; work in a checkout of another branch is not work on that copy.
   `worktree list --porcelain -z` keeps a path git would quote, with the line
   form as the fallback where git has no `-z` (before 2.36): a path it quotes
   then reads as unknown, not as no work. `localWorkUnknown` says the
   comparison could not be made at all — the PR head is not in this clone, or
   git could not read a checkout — which is never reported as "no work". The
   helper reports them and does not refuse: the skill's start does not go on
   while the work or that flag is set, unless the user asks once told, because
   the watch's push and the user's own go to the same head branch.

### 6.2 `snapshot <pr> [--repo <owner>/<repo>] [--host <host>] [--gate] [--session <id>] [--task <id>]`

One GraphQL call, plus one per further page of check contexts, check suites
or review threads (and a REST call for a bot's comment that opens a thread,
asking whether it answers a deleted one; see below), reads:

- PR fields: `state`, `isDraft`, `title`, `url`, `headRefOid`, `mergeable`,
  the author and the viewer
- the head commit's check suites, newest first and paged back to the oldest
  (up to five pages of 100: the suites a push created are the oldest of a
  head, and every review comment can add one after them)
- the status check rollup of the head commit, paged past the first 100
  contexts (up to ten pages; a head on a busy repository carries well over
  100, and a failure on a later page must not read as all green)
- the `reviewThreads`, paged past the first 100 (up to ten pages: threads
  come oldest first, so a new one is on the last page), each with its first
  comment's `databaseId` and its last 100 comments (`id`, `databaseId`,
  `author { __typename login }`, `authorAssociation`, `body`, `url`,
  `state` and `replyTo`)
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
wrote and prints events plus one action. The API can lag a push by some
seconds, so when its head differs from the one the watch knows, `snapshot`
asks the branch itself (`git ls-remote`): a branch still at the known head
means the API has not caught up — not a push by someone else — and the
snapshot leaves out that stale head's checks and merge state, keeps the
comments, and says `lagging: true`.

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
  Resolved threads, empty or pending reviews, approvals (their body accepts
  the PR; their inline comments still arrive as threads) and dismissed
  reviews (a dismissed review was withdrawn) are skipped; outdated threads
  are kept with `outdated: true`.
- A head SHA that differs from `lastKnownHeadSha` is `head_moved_externally`
  when the branch itself (`git ls-remote` on the push target) has left the
  known head too — a rollback to a head the watch pushed earlier included;
  while the branch still stands at the known head, the API is lagging
  (`lagging`, above). When the branch cannot be read, a head in
  `pushedShas` is taken for the watch's own.
- `title` is the PR's title, the language the round's summary is written in.
- A workflow GitHub could not start (`STARTUP_FAILURE`, often an invalid
  workflow file) leaves no check run in the rollup — no rollup at all when
  it is the only one — only its check suite. Of the suites read (paged back, above), the
  latest run of each workflow and trigger counts, and only for a trigger
  of the PR's code (`pull_request`, `pull_request_target`, `push`): a run
  for each review comment fails to start whenever GitHub has trouble, and
  says nothing of the code. It is a `ci_failed` with `startupFailure: true`
  and the run's id, once per head
  (`<workflow>@<head>@#startup:<workflow id>:<event>`), with no log and
  nothing to re-run, so the skill answers it as needing a human.
- A comment of a review not submitted yet (`PENDING`) is a draft only its
  author sees, and is skipped. A bot asks in the comment that opens a
  thread (and in a review); its replies answer someone and are not
  requests. Once the comment a reply answered is deleted, GraphQL drops its
  `replyTo` and lists it first in the thread, so a bot comment that looks
  as if it opened one, and is not known yet, is asked about over REST, one comment
  at a time (`in_reply_to_id` stays on it), only for an open thread of an
  open PR, and once: the answers are kept in
  `.qwen/tmp/autofix-pr-<n>-replies.json`, which the gate, prepared
  snapshots and `reply` share. A comment deleted meanwhile is no request.
  Each answer is kept as it comes. The gate asks about 20 at most a fire,
  within the gate's read budget, and stops at the first failure, leaving the rest — neither requests nor seen — for its next fire; a
  round's snapshot asks about every one and fails when GitHub does not answer,
  so it never drops a request the gate reported (`reply` asks the way the gate
  does: its plan names only threads the snapshot asked about); after eight minutes it stops,
  the answers kept, and asks to be run again. The gate keeps bot replies
  as seen.
  Otherwise a review bot that answers every reply would keep a
  round going for each, and an untrusted commenter could have a bot speak
  for them, even after deleting their own comment.
- A failed check carries a `runId` only when it is a GitHub Actions job of
  the PR's repository (its suite has a workflow run, and its URL is under
  `https://<host>/<owner>/<repo>/actions/runs/`): a commit status or another
  app's check may link any run, and `ci-log` would read it.
- A merged or closed PR is read with the first call alone: its answer is a
  stop, which needs no further page of checks, suites or threads.
- A watch belongs to a CLI session, whose id stays put. A Managed Session
  runs each turn, and each gate, as a Runtime Session of its own, so the
  helpers' session check refuses its next turn: the probe serves as a
  Managed automation's gate — one that names no `--session` makes no owner
  check — and the watch itself is not for Managed Sessions yet. Such a gate
  and a CLI watch of the same PR in one clone share the gate cursor, so
  whichever fires first takes a transition from the other: give each a
  clone of its own.
- Checks and suites belong to the commit, not to the PR: another PR of the
  same head commit shares them. That is a known limit.
- Prepared mode writes the whole snapshot, indented, to
  `.qwen/tmp/autofix-pr-<n>-snapshot.json` and prints one line: the snapshot
  without its events, the number of events and their types, and the file's
  path (`snapshot`). On a PR with any history the comments' bodies run far
  past what one line of tool output shows; the round reads the file, and the
  brief lists the items the fix agent handles, pointing to the file for
  their text. A body is written as the array of its lines, and a line past
  2,000 characters as the array of its pieces (never cut inside a
  character), since `read_file` pages a file by lines and cuts what one
  read returns at 25,000 characters; a read cut so is read again from its
  last line shown.
- `truncated` names the connections (`checks`, `reviewThreadComments`,
  `reviewThreads`, `reviews`, `comments`) that had more entries than the
  query reads.

Action precedence: `stop` (merged or closed) → `resync` (head moved
externally) → `fix` (a conflict, a failed check or a trusted comment) →
`wait`. The loop adds three more inputs: an exhausted budget means `stop`; a
background fix in flight (its attempt marker, Section 6.14) keeps the gate
quiet and the prepared snapshot refused until the attempt ends; and an
attempt its session left behind (a stale marker) is a source of `fix` too —
the watch's own gate reports it once as an `abandoned_fix` event, so a round
discards the attempt's work and redoes the fix though nothing else changed.

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

- A failed check is reported once per (check, head, attempt), where the
  attempt of a workflow a review or a comment starts is the workflow and its
  trigger (`#on:<workflow id>:<event>`): it runs again for every review
  anyone submits, and a new run of a handled failure says nothing new of
  the code. Once a round re-ran it on the head, or deferred its re-run
  (`rerunChecks`, or `heldChecks` for a deferral, records the check run), a
  failure of a later run is the
  re-run's answer,
  reported once more under `#rerun:<workflow id>:<event>`; the run re-run
  keeps its key, so a re-run GitHub has not listed yet, or one whose
  answer was lost, is not taken for it. The cursor key
  carries the run's id (a commit status: its creation time), so a re-run
  that fails again is reported again even when no poll saw it in progress.
  The cursor keeps only the failures still present, and a new head starts
  over. A failure a prepared watch of the PR handled without a push
  (`handledChecks`) counts as reported. A failure of a run whose re-run was
  deferred because the run was still going (`deferredRuns`, Section 6.9) is
  left out while that run goes, as prepared snapshots leave it out — the
  check runs the deferral held, not a job of the run that failed after it —
  and reported once more when it has ended, so the watch can re-run it
  then, unless a round has answered its key since. A key that names no run
  (`#on:`, `#rerun:`) is the same for every run of its check on the head:
  the cursor marks the run it was reported for, so a later run's failure
  (a review started the run while a round read the PR) is reported again
  until a round handles the key, and an earlier run's (a partial read
  listed only it) is not. A run's end is marked with the run's latest
  check run: a job re-run in it makes the run go again, and a second
  deferral of it ends once more. A job a run skipped (an `if:` that was
  false) did not run: it never takes the place of the run before it.
- Pending checks are never reported; `ci_pending` does not appear.
- A conflict is reported once per head; `mergeable` clears the mark,
  `UNKNOWN` keeps it. A conflict a prepared watch left for a human on the
  head (`handledConflictSha`) is not reported.
- Comments, reviews and thread comments are reported once each, by node id,
  with the trust rules of Section 8. The tool's own replies (the viewer's
  comments ending with the reply marker) are never events, nor are the
  ones a prepared watch of the same PR has handled
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
  one. The exception is a flood: more than 100 arriving between two checks
  push out one that no check has read. That is a known limit; the round
  names the cut in its report.
- A gate run reads GitHub for 15 seconds at most, inside a Managed
  automation's 20-second gate (a scheduled task allows 60): past it, paging
  stops and what was not read stays cut. The budget is checked before each
  call, so a call started just before it that GitHub answers slowly (or
  that `gh` retries after a 5xx) can still run a fire past the gate's
  limit; that fire fails before its cursor is written, and the next one
  reads again. A cut run wakes no one and keeps the record of cuts: what
  it did not read comes and goes with GitHub's speed. One cut in the check
  runs keeps the failures it reported as well, and one cut in the suites
  read after them the failures to start; one cut in the review threads
  only read every check, and keeps only the failures still there. The
  rollup lists a check's runs oldest first, so a read cut in the check runs
  can list an earlier run of a check and not its latest: the cursor keeps
  the latest run of each check the last whole read saw (`latestChecks`),
  and a cut read reports no failure of an earlier one, nor a deferred
  run's end, failure and all, which waits for a whole read. While
  GitHub stays that slow, what lies past the pages the gate reads — a check
  failure, a newer review thread — waits for a round something else
  starts, which reads it all; a page cap, which every run meets alike —
  the check runs' included, whatever time the suites after them had — is
  reported once as ever.
- The output stays within 12 KiB — counted as a gate hands it on, with each
  `<` written as `&lt;` — under the 16 KiB the gate hands the
  session (and cuts beyond). Events go in order — head move, conflict,
  failures, comments — and those that do not fit, or the later comments of a
  thread that does not fit whole, are left out, counted in `deferred` and
  not marked reported, so the next run reports them. One event or comment
  always goes, so every run makes progress.
- The first run reports what is outstanding: failed checks, a conflict, and
  comments no one has handled.
- An attempt of a background fix its session left behind (a stale marker,
  Section 6.14) is reported once per attempt id as an `abandoned_fix` event,
  recorded in the cursor (`reportedAbandonedFix`), and only by the watch's
  own gate (a run with `--session`): a probe by hand or a Managed
  automation's gate wakes no round to handle it. It goes after the other
  events, outside the 12 KiB they are fitted to — it is a few dozen bytes —
  and makes the action `fix` though nothing else changed. While a marker is
  fresh the gate prints nothing at all.

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
job — is an error, not an empty file. Jobs are listed 30 to a page (GitHub answers a page of 100 jobs of a large re-run run with a 502), and after eight minutes from the start, inside the shell tool's ten, the jobs left are written as `log unavailable` instead of read. Each log is cut to the lines kept as soon as it arrives, so a run's many large logs are never held at once.

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
from the worktree, with nine minutes for pre-push hooks (the skill gives the
shell call the tool's longest timeout, ten, so the helper still records the
outcome). `<sha>` is the commit
the checks above passed, not `HEAD`, which could move while GitHub is asked.
Hooks run, and there is no `--force` or `--no-verify`. Only that one ref
is pushed: `--no-follow-tags` and `--recurse-submodules=no` keep
`push.followTags` and `push.recurseSubmodules` from sending tags or
submodule branches along. Commands that reach a remote — this push,
`sync`'s and `prepare`'s fetches, `ls-remote` — keep the user's own
transport settings (`GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS`,
`GIT_PROXY_COMMAND`, `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME`), which every
other git call drops, so they connect and authenticate as the user's own
`git push` does. On success it records
the new SHA in `pushedShas` and `lastKnownHeadSha` and counts one push. A
rejected lease (`[rejected] (stale info)`, or a remote branch that
`git ls-remote` no longer finds at the known head, whatever language git
prints in) means someone else pushed; the result is `resync`, not a retry,
and nothing is recorded. A push whose answer was lost — the remote already
holds the commit — is recorded as pushed. A commit the remote held before
the push — someone else pushed it, or an earlier push of it was never
recorded — is not counted as this push: the answer is `resync`, `sync`
adopts it as the known head, and the next `push` has nothing to push. The
skill then treats the round's commits as pushed at that head, since it
contains them. Any other refusal —
a hook, branch protection, credentials — is an error with git's last lines.
The output is one JSON line: `{"pushed": true, "sha", "pushes", "maxPushes"}`;
`{"pushed": false, "action": "resync" | "stop", "reason"}`; or, when `HEAD`
is the known head and there is nothing to push, `{"pushed": false, "reason"}`
with no `action` — the skill reads that absence as "the fix left no commit".
A push also records the PR's base branch as GitHub names it then, as `sync`
does: a PR can be retargeted while a watch runs, and the round's brief
merges the recorded base.

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
  "handledConflict": false,
  "needsHuman": ["PRRC_x: rename the public option, or keep it?"]
}
```

The helper decides what may be posted, against one fresh read of the PR
(the prepared snapshot's rules):

- A reply goes only to a thread that has, right now, a new comment from a
  trusted author, and `handled` names comments of that thread. Untrusted
  comments cannot be marked handled; a check key must be one a `ci_failed`
  event reports on the head (prepared mode prints its `key`) — now, or in
  the round's prepared snapshot file (or, once a background fix's claim
  moved that file, the claimed `autofix-pr-<n>-fix-snapshot.json`, read
  until a round prepares another; Section 6.14): the head can move on from a failure
  while the round runs (a re-run, a run a review starts), and the round's
  answer still stands, under the key the next failure of a review-started
  workflow on that head carries. A failure a deferral holds while its run
  goes (Section 6.9) is not recorded (it counts in `ignoredChecks`): the
  gate reports it once more when the run has ended, or reports a later run
  of the check that fails, and the round answers it then. Any other the
  round saw is recorded, a job of the deferred run that failed after the
  deferral included: the gate does not report it again; a conflict can
  be left for a human only while there is one. The PR must be open.
- The head the plan is judged by is the one the watch knows (`sync` and
  `push` read it from the branch), not the API's, which can lag a push.
- A failure key of another head — the round pushed past it — is ignored and
  counted in `ignoredChecks`: prepared snapshots read only the current head.
  A string that is not a failure key at all is refused.
  `handledConflict` is recorded against the head while GitHub reports a
  conflict, or reports `UNKNOWN` on a head this watch pushed: right after a
  push GitHub answers `UNKNOWN` until it has recomputed the merge.
- A plan with two replies to one thread, or one comment id twice, is refused.
- Every check runs before anything is posted, so a refused plan posts
  nothing.
- Each POST is announced in the state file first (`pendingPosts`: where it
  goes, the comments it answers, a hash of its body, the head it is posted
  on — a summary adopted later counts for that head's push, not a later
  one's). The next run looks for
  each announced reply on the PR: one that is there — a POST that reached
  GitHub although its answer was lost — is recorded with exactly the
  comments it was posted for (`adopted`); one that is not was never posted.
  A reply is never recognized by a later plan's wording, and a reply the
  tool posted for other comments is never taken for the answer to new ones.
- A comment a reply names that is answered already is left out of it; the
  reply still answers the rest, so a comment that arrived while a round ran
  is not left without an answer.
- Each body gets the marker once and must fit GitHub's 65,536 characters.
- Each posted id is written to the state file the moment it exists, with the
  comments its reply handled. A run that fails part way leaves the rest
  unposted and unrecorded; running the same plan again recognizes what was
  posted (above) and skips a reply whose comments are all handled, and the
  summary when its comments are — unless the head is a push of the watch's
  that has no summary yet: each push gets one, once per head
  (`summarizedSha`), whether or not it answers comments.
- `handledChecks` and `handledConflict` record failures and a conflict the
  round did not fix with a push, so prepared snapshots stop reporting them:
  a failure by its attempt (a re-run that fails again is new), a conflict by
  its head.
- `needsHuman` is one line per item the round left for a person. The helper
  keeps each in the state file with the head it was answered on and the
  time, newest last and at most 20, for `status`. Whitespace is folded, a
  line over 300 characters is cut, and the same line on the same head is
  kept once, so running a plan again adds nothing.
- `--no-post` (the skill's `--no-reply`) records the same, the summary's
  `summarizedSha` included, and posts nothing.

Replies to review threads use
`POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`; the summary is an
issue comment. Neither POST is retried: one that reached GitHub before a
transport error would be posted twice.

### 6.6 `cleanup <pr> [--force] [--take-over]`

Removes the worktree, its branch and the state file together. When the
worktree has uncommitted changes (untracked files and changes inside
submodules included, whatever `status.showUntrackedFiles` or a submodule's
`ignore` setting says), or the worktree (or the branch, once the
worktree was deleted) has commits that no PR head the watch knows of
contains, all three are kept and the report says why. The watch ends all the
same: its recorded task (`watch`, Section 6.11) is dropped and the state
records `ended` (when, and the reason), so `/autofix-pr resume` does not
start it again, the helpers of a round still under way refuse it (a fire
queued before its task was deleted, a second process of the session), and
its gate answers `watch_ended`: any of them would discard what was kept. A
start (`prepare`, reporting `wasEnded`) resumes it. The heads it knows of
are `lastKnownHeadSha` and `pushedShas`, and — asked only when those leave
commits over — the PR head on the remote (`refs/pull/<n>/head`), so work
pushed by hand is not held back. A directory at the worktree path that is
not a worktree of its own is kept: git run inside it would judge the
enclosing clone. Without a state file there is no recorded head, so a
leftover worktree or branch is kept. A state file owned by another session
is a refusal, unless `--take-over` first moves the watch to this session, as
`prepare --take-over` does: `/autofix-pr stop <n>` passes it, so a watch
another session left behind can be stopped without discarding its work.
`--force` overrides these checks and also discards an
unreadable state file. A branch that cannot be deleted is an error, and the
state file stays. Running `cleanup` from inside the worktree it would remove
is a refusal. The gate cursor is not removed: it belongs to the scheduled
task, which outlives a watch, and without it the next fire would report
everything again. Delete the task to stop the gate. The report names the
kept cursor (`gateCursor`): a later gate on another repository's PR of the
same number is refused until that file is removed.

What the watch posted and handled — `handledCommentIds`,
`postedCommentIds`, `handledChecks`, `rerunChecks`, `handledConflictSha`,
and the replies announced but not yet settled (`pendingPosts`) and re-runs
deferred (`deferredRuns`, `heldChecks`), which are the watch's own lists as they stand
(they were started from the history, and what was settled since must not
come back) — is added to the PR's history before the state file goes,
`.qwen/tmp/autofix-pr-<n>-history-<host>+<owner>+<repo>.history.json` (one
clone may watch PRs of one number in a fork and its upstream; `+` and `@`, in
place of a port's `:`, occur in no name, and the suffix never matches a file
the skill may write), and that file is kept
as well (`history` in the report). `--force` also removes the watch's lock,
in case a helper was killed holding it. A later watch of the same
PR's `prepare` starts from it, so it does not answer the comments an earlier
watch answered, nor re-run a check twice on one head; a history of another
repository's PR of the same number is ignored.

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

### 6.8 `sync <pr> [--discard] [--task <id>]`

A round starts with `sync`, so it also checks that the round may run: the
watch is not ended (Section 6.6) and is this session's, and — with
`--task`, the task the round's prompt names — that this task still drives
it. A fire queued before a later `schedule` replaced its task, or before
`stop` ended the watch, is refused here and the round deletes the task.
`snapshot`, `ci-log`, `push`, `reply` and `rerun` take the same `--task`
and refuse the same way, so a round that was past its `sync` when its task
was replaced stops at its next helper.

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
  merged it) is recorded as `lastKnownHeadSha`, and the checked-out
  submodules are moved along as described below. The answer carries
  `unpushed`, the number of commits the worktree holds that the PR does
  not: a round's own work, or work a round that never ended left behind,
  which the skill discards before a round starts;
- a worktree behind it is fast-forwarded, when it is clean;
- a worktree with unpushed commits of a round is not touched: the answer is
  `{"synced": false, "action": "merge"}` with the head to merge (never
  rebase), and nothing changes.

A worktree with uncommitted changes is never moved or reset. `--discard`
returns the worktree to the PR head — back on the watch's branch if a fix switched to another, which keeps its commits, after quitting a merge, rebase, cherry-pick, revert or `am` it left stopped — whatever it holds — unpushed commits and
uncommitted changes, nested repositories (`git clean -ffd`) and changes in
checked-out submodules included (`git submodule foreach`, which never
touches one that is not checked out) — to end a round whose work was not
pushed, and reports what it dropped. A worktree that is still not clean
afterwards answers `{"synced": false, "reason"}`. Whenever `sync` moves the
worktree, it moves its checked-out submodules to the commits the new head
records the same way, fetching a commit a submodule lacks from that
submodule's own remote (the PR's fetch does not recurse into submodules, so
a submodule commit that cannot be fetched does not fail it). `foreach` only
lists the checked-out submodules, one NUL-terminated record each (a path
the PR names may hold a newline, and read by lines, what follows it would
pass for another submodule); the fetch, with a minute of its own, three for
all the submodules of one `sync`, and the protocol policy git applies to
submodules, and the reset run outside it,
since a child of `foreach` would outlive a timeout that kills only the
top-level git and go on changing the submodule after `sync` returned (a
fetch that times out is killed; a transport process it started may linger
until its connection ends, but it only downloads objects). Submodules are
aligned one level at a time, so a nested one gets the commit its parent
records once the parent has moved, and also when the worktree already
contains the PR head (a round merged it: a merge moves the gitlinks, not the
checked-out submodules). Nothing was checked for uncommitted changes on that
last path, so there a submodule holding work of its own — uncommitted
changes, or a HEAD the recorded commit does not contain — is left as it is.
A listed submodule is touched only when it lies inside the worktree, is the
top of its own repository, and keeps its git directory under its parent's
`modules` directory (where `git submodule` puts it) or inside itself: in a
plain directory `git -C` would find the enclosing repository, and through a
`.git` file or a `core.worktree` naming another repository or tree, a reset
would move that repository's branch or write to that tree. No
reset recurses into submodules, whatever `submodule.recurse` says, and a worktree that is not clean afterwards answers
`synced: false`, so a fix never commits a submodule back to an old commit. When the
PR's branch cannot be read (the PR was closed, the branch deleted, the
network is down), it returns to the head the watch last knew instead.

Like `push`, `sync` first asks GitHub for the PR's head branch and checks
the destination against the clone's remotes, so an edited state file cannot
point the fetch at another ref or repository; the head ref is validated as
a branch name (`git check-ref-format --branch`), so it cannot carry a
refspec. It also records the PR's base branch as GitHub names it now.
`remote` and `baseRefName`, which the round's brief puts into the fix
agent's merge command, must be branch names without a character a shell
gives a meaning to (`prepare` refuses a PR or a remote whose name has one).
Every list a helper reads from the state file must be a list of the right
type; a history file's malformed field is dropped, and the rest still
merged.

### 6.9 `rerun <pr> <run-id>`

Re-runs the failed jobs of a run the fix agent judged an infrastructure
failure, with `gh run rerun <run-id> --failed`, on an open PR only. Only a GitHub Actions job of
the PR's repository counts: a commit status or another app may link any URL,
and a run id read from it would re-run some unrelated run. Each failed or
cancelled job of the run's latest attempt spends its check's one re-run —
one a later run of the check took the place of on the PR as well, since
`--failed` re-runs it too (`rerunChecks`, keyed by the
check's identity — app, workflow, trigger and job name, as Section 6.2 tells
checks apart — and the head, so two workflows with a job of the same name
each keep theirs, with the check run a run of the check must come after to
be the re-run's answer, which Section 6.2 keys it by: the job's, or the
latest of its check on the PR when a later run is there already);
a run with a check that was re-run on this head already answers
`{"rerun": false}`, and the failure is treated as real. The attempts it
re-ran are recorded in `handledChecks`, so the prepared snapshot does not
dispatch them again while the re-run is going; a re-run that fails again is
a new attempt. A head that moved since the watch last saw it answers
`resync`, and a run with no failed check on the head is an error. The re-run
is counted before GitHub is asked and the call is not retried, so a re-run
whose answer was lost is not asked for a second time: at most once, never
twice. Its failures are marked handled only once GitHub took the re-run: a
refusal (gh's `run <id> cannot be rerun`, a 403 — a token without
`actions: write`, a run too old — or another HTTP 4xx) gives the re-run back, one a deferral held included, and every error tells the round to answer those failures
as needing a human, so a check is never left red and unreported.

GitHub re-runs a run only once it has ended, while `snapshot` reports a
failed job as soon as it fails. A run still in progress therefore answers
`{"rerun": false, "deferred": true}` without asking GitHub, and is recorded
in `deferredRuns`: the gate reports its failures once more when the run has
ended (Section 6.2), and the round then re-runs it. Until then prepared
snapshots leave them out as well, so another event does not hand the round
the same failure to defer again. The deferral holds the re-run of each of
its failed checks — in `heldChecks`, apart from the spent ones in
`rerunChecks`, under the run's id and with the check run deferred, so a
re-run another run spent is never taken for one this run holds — and only
those check runs are left out: a job of the run that fails after it is the
round's at once, however long the run goes on. The run is re-run when it
ends; the re-run, or a lost answer, spends every hold of the run, one whose
check no longer fails in it included (a job re-run on its own had its
re-run). A later run of the check on the head — one a review started before
it ended, say — answers for it as a re-run's would,
under the re-run's key (Section 6.2), and is treated as real. Two jobs of
one workflow that share a name are one check: when the second fails only
after the deferral, the re-run is held by the first, and the second is
treated as real once the run has ended. That is a known limit.

`push`, `sync`, `reply` and `rerun` each hold the watch's lock
(`.qwen/tmp/autofix-pr-<n>.lock`) while they read and write the state file:
two helper calls the model issues at once would otherwise each write back
what they read, undoing the other's record of a push, a reply or a re-run.
`prepare` holds it while it creates the worktree and the state file, so two
starts at once cannot roll back or take over each other's worktree.
The lock is created whole, as a hard link to a file already holding its
token, and removed only while it still holds that token. A sandbox may run
each command in a pid namespace of its own, where pids repeat, so the
holder's pid is checked only from the same namespace; any other lock is
taken over once it is older than any helper runs (fifteen minutes), and
`cleanup --force` removes it at once. Stale locks are broken one at a time,
under an exclusive `<lock>.break` file (one left by a killed helper is
cleared once it is a minute old, either way from now): a lock that still
holds the stale token there is replaced by the breaker's own token in one
rename, so the lock path never stands empty for another helper to slip
into, and a fresh lock is never touched.

### 6.10 `status [<pr>]`

Lists the watches of the clone, read from their files under each worktree's
`.qwen/tmp` — every worktree of the clone is scanned, so a watch rooted in any
of them is listed (`--no-work` leaves `worktreeWork` null, skipping its git
scan): no lock is taken and GitHub is not asked, so it answers while a helper
runs and whichever session owns a watch. An explicit root scans just that one
worktree. Output:
`{ "now": "<time>", "watches": [...] }`, and `unreadable` with the PR and
the reason for a state file that could not be read. Each watch carries:

- the PR, its repository, host and URL; `headRefName`, `pushTarget` and the
  head the watch knows (`headSha`);
- `pushes` and `maxPushes`;
- `session`, the session that owns it, and `thisSession`;
- `preparedAt`, when `prepare` made the watch (null for one from before it
  recorded that), which `prepare` reports too;
- `lastCheck`, the last run of the watch's own gate (one with a
  `--session`), whether it read the PR or, with a background fix in
  flight, skipped reading it (Section 6.14) — it touches
  `.qwen/tmp/autofix-pr-<n>-gate.checked` on every such run, which
  `cleanup` removes with the watch, while a gate with no session, which
  shares the cursor, leaves it — and `lastRound`, the time of the last
  prepared snapshot; both null before the first;
- `checkedRecently`, whether `lastCheck` is within two of the watch's
  intervals: a gate, of this session or another, is likely still running.
  The helper says it, not the model, which knows the date but not the time;
- `stopped`, `merged` or `closed` when the gate saw the PR end and the watch
  was not cleaned up — as of `lastCheck`: the PR may have been reopened
  since, so the skill acts on it only through a round, which reads GitHub;
- `watch`, the task `schedule` recorded, or null for `--once`;
- `ended`, when and why a `cleanup` that kept the worktree ended the watch;
- `needsHuman` (Section 6.5);
- `gitTrusted`: the worktree's gitfile and every checked-out submodule's
  name git directories the clone keeps, read from the files (Section 6.12);
- the worktree's path and whether it exists, and `worktreeWork`: what the
  worktree or its branch holds that the PR does not, judged as `cleanup`
  judges it without asking the remote or taking the index lock, or null.
  A round that starts on it
  discards it, so a take-over or a resume says so before it asks;
- `fix`: `{ attempt, startedAt, fresh }` for a background fix's attempt
  marker, or null. `fresh` is an attempt that has not ended: its agent works
  in the worktree, or has ended — finished or stopped — and the round may
  still claim the attempt; either way the round's helpers refuse. Otherwise its session left it
  behind, and the next round's `sync` removes it (Section 6.14).

The gate cursor outlives a watch (Section 6.6), so it is read only when it
names the watch's repository and is no older than the watch (`preparedAt`,
written by `prepare`: a cursor that saw the PR closed before it was
reopened and watched again is a former watch's), and one that cannot be
read leaves `stopped` null instead of hiding the watch. A state file is
read under the name the helpers give it (no leading zero) and must name its
own PR, and neither it nor the cursor is read unless it is a regular file
(a FIFO under that name would block); anything else is `unreadable`, with
the file and the way out (`cleanup <n> --force`).

A scheduled task lives in the session that created it, which the helper
cannot see: the skill joins the list with `cron_list` to say which watches
this session runs.

### 6.11 `schedule <pr> [--every <minutes>] [--no-reply] [--instructions] | --again`

Records the watch's scheduled task in the state file
(`watch: { every, reply, instructions, task }`; the state is read with
these fields only, so anything else a file holds there is dropped) and
prints it as `cron_create` takes it:
`cron`, `recurring`, `gate` and `prompt`, with the options. Both the gate
and the prompt carry the task id (`tick <owner>/<repo>#<n> --task <id>`),
so a round woken by a replaced task stops at its first `sync`. The skill creates the task from these exactly as printed, so the
gate and the prompt are not composed in a prompt.

- Every run mints a new task id, which the gate carries (`--task`). The task
  made from this output is the watch's only one: the gate of any other —
  from an earlier start, from before a take-over, or a copy in a second
  process of the same session — answers stop (Section 6.1, step 5), and the
  skill deletes the PR's other tasks before it creates this one.

- `--every` is one of `1, 2, 5, 10, 15, 30, 60` (default 2), and takes a
  value; 60 is `0 * * * *`.
- `--instructions` reads the user's instructions from
  `.qwen/tmp/autofix-pr-<n>-instructions.txt`, which the skill writes as the
  user gave them. A prompt is one line, so whitespace is folded and format
  characters (bidi controls, zero-width ones) dropped; more than 2,000
  characters is refused.
- The gate names the session that owns the watch; one prepared outside a
  session, or a session id that a command cannot carry as it is (it must
  start with a letter or digit, so it never reads as an option), is refused.
- Control characters in the instructions are folded like whitespace, and the
  state file's own check holds a recorded task to one line of at most 2,000
  characters, so `--again` prints nothing longer.
- `--again` schedules the task recorded before again, with its options
  under a new id, and takes no other option: `resume` runs it after a
  take-over, before its round. A watch with no task recorded (a
  `--once` start, or one `cleanup` ended keeping its worktree) is refused,
  and so is one the round ended: it is started again with `/autofix-pr <n>`.
- A PR whose author cannot push is refused — any state but
  `authorCanPush: true`: its code runs with the user's credentials in reach,
  which is confirmed for one `--once` round at a time, never for a watch.
- Fields of `watch`, `ended` or `needsHuman` that this CLI does not know — a
  newer one's — are dropped when it reads the state, and so are not written
  back.
- Only the owning session may run it; nothing is recorded when a task cannot
  be made.

### 6.12 The `autofix_pr` tool

A core tool runs the helpers, so that a rule can name them. One call runs
one helper: `command` names it (`prepare`, `snapshot`, `ci-log`, `push`,
`sync`, `reply`, `rerun`, `schedule`, `status`, `cleanup`; `fix-end`,
Section 6.14; `unattended` and `attended`, Section 6.13 — `fix-start` is
no command of the tool: the launch of a background fix runs it), and typed
parameters carry its options (`pr`, `repo`, `host`, `take_over`, `task`,
`run_id`, `lines`, `plan`, `no_post`, `discard`, `every`, `no_reply`,
`instructions`, `again`, and `attempt`, which `fix-end` requires). The tool builds the arguments itself, options as
`--name=value`, and starts the CLI without a shell, so nothing in a
parameter is read as shell syntax or as an option; a parameter the command
does not take is a refusal before anything runs. `reply`'s plan must be the
one the skill writes, `.qwen/tmp/autofix-pr-<n>-plan.json` beside the
worktree — for a watch this session prepared, beside that very worktree —
and not a file inside it: a file the PR's own tree carries must not speak on
the PR.

- It runs the CLI of the session: `QWEN_CODE_CLI` when it names a usable
  entry — a script through the JavaScript interpreter, an executable
  directly, a Windows `.cmd` or `.bat` shim skipped, since only a shell can
  start one — otherwise the interpreter with the entry this process was
  started from. The environment is the one the shell gives its children,
  under the calling session's id, and the working directory is the
  session's, so the daemon check of Section 6.1, step 7 sees what a shell
  call would.
- A call may take ten minutes, the longest a helper needs (`push` gives
  pre-push hooks nine), and is stopped when the turn is cancelled. Calls in
  one working directory run one at a time — but `status`, which takes no
  lock, waits for none, and a call cancelled while it waits returns at once;
  the helpers' lock covers other processes.
- The result is the helper's JSON line. A non-zero exit is the helper's
  refusal, returned with its message.
- `snapshot --gate` and `cleanup --force` are not offered: the gate runs
  outside the model, and only the user discards a worktree's work.
- Only the main session has it: subagents, forks, teammates and workspace
  agents do not, and code mode's `exec` cannot call it.
- Before any git command in the worktree, `push`, `sync`, `status` and
  `cleanup` check its `.git` from the files: it must name this clone's own
  admin entry for a worktree, which must point back at it. The file is read
  as git reads it (`gitdir: ` and the rest), the path resolved as the
  kernel resolves it, and a worktree without one is refused. A round's code
  can rewrite that file, and a git directory it built would hand every git
  command there its config — a `core.fsmonitor` command runs on the next
  `git status`.
- A user's PreToolUse or PostToolUse hook for the shell tool does not see
  these calls; one for `autofix_pr` does.
- In plan mode it runs nothing but `status`: a rule lets a round's helpers
  past the dialog plan mode would block, and each of them writes.

`status` only reads and needs no approval. Every other call asks, as a shell
command does — in auto mode the classifier decides. Rules match on
`command` and on `watch`, which the tool derives and the model cannot set:

- **`watch:confirmed`, a watch this session prepared.** When `prepare`
  succeeds through the tool, the session records, in memory, the watch it
  reported: the PR, its repository and host, the directory it was prepared
  from, the worktree, its `preparedAt`, and whether GitHub said just then that the
  author can push. A helper call is `confirmed` when that record exists for
  this clone and `status`, asked when the permission is, still lists the
  watch as that one — same repository, host, `preparedAt` and worktree — of
  this
  session and not ended. `status` runs there with `--no-work`, which skips
  its git scan of the worktree, and not at all in YOLO mode, which asks
  nothing, or in plan mode, which runs no helper. A `push` or `sync` is
  `confirmed` only when git would run none of the hooks they trigger
  (`pre-push`, `post-checkout`, `post-merge`, `reference-transaction`), or
  the watch's fixes run unattended (Section 6.13): a relative
  `core.hooksPath` (husky's `.husky`) resolves inside the worktree, where the
  PR's own tree supplies the hooks, and a hook in the clone's own hooks
  directory may be a dispatcher (pre-commit, lefthook, husky 4) that runs
  what a config file in the tree says. The dialog of such a call says so. Nor is
  a call `confirmed` unless `status` reports `gitTrusted`: every git
  directory a command in the worktree reads — its own and each checked-out
  submodule's — is one the clone keeps, not one embedded in a submodule or
  anywhere else the tree can write, which would hand git a config the PR
  controls; `status` and `cleanup` do not scan such a worktree with git at
  all. An ask rule for the shell command (`Bash(qwen autofix-pr push *)`)
  asks for the tool's call too, past any allow rule for the tool and the
  auto-mode classifier, as it would for the shell (YOLO ignores ask rules
  for both). The
  state file the helper reads sits in reach of
  the code a round runs, so it can only make a call `unconfirmed`; none of
  the record is read back from it. Any other helper call is
  `watch:unconfirmed`. A round starts with `status` through the tool: a
  task left running for a watch that is no longer this session's (after a
  `/clear`, or a take-over) ends there, asking nothing, instead of at a
  helper that would ask. `status` also marks each watch with
  `preparedHere`; when it is false for this session's watch — a durable task
  a daemon restart brought back (Section 6.11), or a `/resume` back into the
  session — the round goes on with its helpers and its fix under the
  approval mode, as without the tool, and its report says that
  `/autofix-pr resume <n>` confirms the watch again — a resume that takes
  such a watch even though this session's task drives it. The record ends with
  `cleanup` of the PR through the tool and with the session.
- **`watch:take-over`**, for `prepare --take-over` and `cleanup
--take-over` (which `/autofix-pr stop <n>` runs, and so asks). `prepare`
  and `status` have `watch:none`.
- **A rule that names `command` alone covers every call of it**, whatever
  its `watch`: `deny: ["AutofixPr(command:push)"]` stops every push. So
  does a rule that denies the shell route of the call — `Bash`, or
  `Bash(qwen autofix-pr *)` — since the tool runs the same program, with the
  repository's git hooks.
- **A start, a new schedule, a take-over and an unconfirmed helper** offer
  no "always allow": a saved rule would let every later one through. The
  `prepare` dialog says that the watch's rounds then push and reply without
  asking, and in auto mode it is the user's to answer, not the classifier's.
  Elsewhere the rule saved names `watch:confirmed`.

The skill's `allowedTools` grant the commands a round runs with
`watch:confirmed` — `snapshot`, `ci-log`, `sync`, `push`, `reply`,
`rerun` and `cleanup` — plus `status`, and neither `prepare`, which starts
or resumes a watch, nor `schedule`, which a round never runs and which
would replace the watch's task and options. What these rules let through is
bounded by the helpers as well: each refuses a watch that another task
drives (Section 6.1, step 5; Section 6.8), `push` checks where it pushes and
counts the pushes, and `reply` answers only threads with a new comment from
a trusted author. The CLI the tool runs is found once per process, so a
later change of the environment (a reloaded `.env`) does not move it.

Where the tool is not registered — a tool allowlist in the settings
(`autofix_pr` is one of the core tools it lists), or the per-command
execution sandbox — the skill runs the same helper through the
shell tool, as before. Under that sandbox the fix agent cannot start anyway:
an `agent` with `working_dir` is refused there. The daemon's shell guard
checks shell calls only; it never saw the git commands a helper runs, and
the tool's working directory is the session's own.

### 6.13 Fix commands without asking: `autofix_pr` `unattended`

The fix agent asks before each command in the default, auto-edit and auto
modes, so until now a watch ran unattended only when the whole session
lets commands run. The start, take-over and resume questions now offer a
choice for that ("Start, fixes run without asking"), and on it the skill
calls `command: "unattended"` with `pr`, which confirms the choice in a
dialog of its own and records it for this session.

- The dialog has no "always allow", and the grant is made only from its
  answer: no saved rule, hook, auto-edit approval or auto-mode classifier
  stands in for it. Declining it is a cancelled tool call, which ends the
  turn, so the skill offers it only to a user who just chose it; the watch
  is then left prepared without its task, and the start or resume is run
  again. Without anyone to answer — a headless run, a background agent — it
  is refused, and so is the answer of a stream-json host or of a program
  driving the session through `--input-file`, which would run in YOLO mode
  if it wanted this. In YOLO mode nothing is needed,
  and it records nothing. A refusal known before the dialog (the folder,
  the host, the watch below) is given without one.
- It grants only a watch this session prepared through the tool
  (Section 6.12) whose author GitHub then said can push, and only while
  `status <pr>` lists it as this session's, not ended, of that repository
  (the name compared without case), with that worktree and that
  `preparedAt` — a watch another process of the session prepared again is
  another one. The grant is for the watch the dialog named; one prepared
  again before the answer is refused. `status` reads the state file, so it can only take the
  grant away. A PR by anyone else is never watched (Section 8), and a
  `--once` round of one asks for each command. An untrusted folder, or a
  session-agents session, is refused: their subagents get no privileged
  mode.
- The grant lives in the CLI process, keyed by the session id and the
  worktree's real path. Nothing is written to disk.
- It reaches one agent: the built-in `general-purpose` agent — not a
  project's or user's definition of that name, which may run another
  executor that no deny rule of this session reaches — when the session
  itself, not a subagent of it, launches it with `working_dir` at the
  granted worktree. Before the launch it checks again: the folder still trusted, the
  watch still as above. Then the agent runs in YOLO mode; an agent it starts
  in turn takes the session's own mode, not YOLO, whatever its executor.
  Plan mode stays plan mode; an agent of another executor
  (Codex), a teammate and a workflow agent are not affected.
- `command: "attended"` takes the PR's grant back, asking nothing: the skill
  calls it on a plain "Start", "Take over" or "Resume" answer and with
  `--yes`, so an earlier choice does not outlast a later one.
- The grant ends with `cleanup` of the PR through the tool, with a
  `prepare` that reports another watch of the PR (recreated, of another
  repository, or taken from another session; a start or resume over the
  same watch, a refused one included, leaves it), with a check at launch
  that fails, and with the session: `/clear`, `/new` and `/resume`
  drop what the session confirmed and granted, the session left and the one
  entered alike, and so does closing it, which a daemon does before it loads
  the session again. Plan mode grants nothing.

It does not contain the agent. The agent runs as an agent of a YOLO session
would: with the user's credentials, able to reach files outside the
worktree, past the user's ask rules; deny rules still apply. The dialog
says so, and the trust rule of Section 8 is what keeps someone else's code
out of it. A watch whose task expired or was deleted keeps the grant until
one of the above ends it.

### 6.14 Background fixes and `fix-end`

A watch whose fixes run unattended (Section 6.13) runs its fix agent in the
background, so the session stays usable while it works. Any other fix keeps
the foreground agent of Section 7 — a background agent cannot ask, and
every command of such a fix asks — and so do the merge agent of a round,
every `--once` round (even on a PR whose watch runs unattended: the grant
and the attempt are the watch's, with its options), a round restarted within its
turn, and the fix of a round whose previous attempt was abandoned (below).
`status`, run through the tool, says which watches this session runs
unattended (`unattended`); a YOLO session records no grant, so its fixes
stay in the foreground.

**The launch.** The `agent` tool refuses `working_dir` with
`run_in_background` because the caller owns the worktree and could remove it
under a running agent. It allows the pair for one launch only: the
top-level, built-in `general-purpose` agent the session starts at a worktree
it holds an unattended grant for, outside plan mode and in a trusted folder
— the agent Section 6.13 runs in YOLO mode. Its parameter check sees the
grant without checking it; the launch checks the whole condition as for a
foreground fix and fails the launch, rather than run in the background
without it, when any part fails. The launch itself, not the skill, then opens the fix's
attempt: the grant runs `fix-start <n> --attempt <id>` (a helper only the
session runs). It refuses unless this session owns the watch, the watch has
not ended, no marker of an attempt is there (a fresh one runs; a stale one
is the round's `sync` to remove), and the round prepared a snapshot to fix
at the watch's head in the last 30 minutes, under the watch's task (the
prepared snapshot records the task it ran under, so a `--once` round's
never qualifies), and every run of the gate that printed something had
finished reading the PR before that snapshot began to (the gate's cursor
records when its last such run finished reading, `reportedAt`, and the
snapshot when it began, `readAt`; a quiet run, which may still move the
cursor, records nothing) — otherwise
the gate's fire waits in the queue, and its round, run while the
fix worked, would find nothing to do and the events it reported would not
come again; with a foreground fix it runs after. It writes the attempt
marker `autofix-pr-<n>-fix.json` beside the state file: the attempt id, the
watch's task, the head and when. The claim (`fix-end`) moves the round's
snapshot to `autofix-pr-<n>-fix-snapshot.json`, which `reply` reads until
a round prepares another, and a `sync` that removes an abandoned attempt
removes its snapshot: no later attempt starts from it. A refusal refuses the launch, and a launch
that fails after it ends the attempt (`fix-end --abandon`, which removes
the marker and leaves the round's snapshot to the foreground fix the round
then runs). The round falls back to that foreground fix only when the
grant no longer holds or no round has a fix to start; any other refusal (a
fix in flight, one left behind, a watch no longer the round's) ends the
round. So every background agent at a worktree has an attempt tied to the
round that prepared it, and while one lives no other agent, teammate or
workflow agent launches there, in the foreground or the background — but
one the fix agent starts, itself or through an agent it started, is its
own: a subagent starts agents through the `agent` tool only (workflows and
teammates are the top-level session's), and the registry's parent links tie
each such agent to the fix agent. The session's own `edit`,
`write_file` and `notebook_edit` into the worktree — any but those of the
fix's own agents — the path resolved as
the kernel will, each link followed as written before a `..` after it, and
also as Windows will, which folds `..` as text first; inside either way is
inside — ask the user whatever the approval mode,
as the fix agent builds and runs what is there without asking; an agent,
teammate or workflow agent the session starts in its own directory after a
`/cd` into the worktree is refused. Only this process
knows of the attempt: an agent another process pins to the worktree is not
refused, and the launch does not see one pinned there before it — as two
sessions' foreground fixes of one watch before this step.

A background fix agent takes no `send_message` while it runs (its registry
entry carries a reason that refuses it, though the events of a Monitor it
starts still reach it), and is never continued: once it ends, `send_message` to
it, a revival of its transcript and a resume after a restart are refused,
through the reason its saved record carries and, once it ends, its
registry entry (not while it runs, which would refuse the events of a
Monitor it starts), and it never stays resident, so no later turn
gives the agent work outside an attempt — or in the session's own
directory, where a revived agent would run. Its saved record keeps the
approval mode it would have had without the grant.

**The attempt.** The session keeps the attempt in memory, beside the grant,
with the watch's `--no-reply` and instructions as the session's own
`schedule` printed them. That record decides for this session: while the
agent runs, the `autofix_pr` tool refuses every helper of the PR but
`status` and `cleanup` (which stops the agent, below), and `fix-end` until
the agent has ended — its registry entry
reached a terminal state, which a stopped agent does once its tools settle
or its cancellation's grace runs out; a claim then waits up to 15 seconds
more for the agent's body to settle. A stop asked for while the agent
launches stops it as it registers. The marker is for the gate and for
other sessions and processes: every 30 seconds the session refreshes the
modification time of the marker (opened without following a link or
blocking, and only when it is a regular file) while it still names the
attempt, and stops the agent when it does not, when the
attempt it names started more than a minute ahead of the clock (the clock
was set back, and the helpers would read the marker as stale), or when a
refresh comes more than a minute late (the process was suspended, and another
session may have taken the worktree meanwhile). A late refresh is also found as the tool or the
agent tool looks the attempt up: after a laptop's sleep the gate can find the
marker stale before the session's timer runs again, and the round it starts
must not be refused for an attempt that is already over. Whoever acts on the
worktree next — a helper through the tool, a launch of the agent tool, of
a teammate or of a workflow agent, whether pinned there or started in the
session's own directory inside it — first waits, up to 15 seconds from when an attempt was dropped (by a late
refresh, its deadline or a revoked grant), for its stopped agent to settle;
a stop and a claim wait so themselves, and the session's own writes into
the worktree ask until then. The heartbeat counts no refresh as
late before it starts. A helper takes the marker as
fresh when it was refreshed within the last 90 seconds and its attempt
started neither more than a minute ahead of the clock nor more than 45
minutes ago. While it
is fresh:

- `sync` (with `--discard` too), the prepared `snapshot`, `ci-log`, `push`,
  `reply`, `rerun`, `schedule`, `cleanup` (with `--force` too) and `prepare`
  refuse, naming the attempt and when it started: a reset, a push, a reply
  or a removal now would act on work half made;
- the gate prints nothing, asks GitHub nothing and keeps its cursor, so a
  fire costs no turn and what changed meanwhile reaches the round after
  the attempt; it still marks its check, so `status` does not read the watch
  as left behind;
- `status` shows it (`fix`), with whether it is fresh; a scheduled round
  whose `status` shows a fresh one ends without a message.

The session stops the agent when it runs past the attempt time limit
(Section 10, 30 minutes from when the attempt opened); such an attempt stays
the round's to claim, as an agent that was stopped. When the grant ends
(Section 6.13: `attended`, a failed launch check) it stops the agent and
drops the attempt: the next round redoes the fix in the foreground, asking
as the user now wants. `/autofix-pr stop` in this session — `cleanup`
through the tool — stops the agent without a notification, waits up to 15
seconds for its body to settle (outside the helpers' queue; also when the
agent had ended already, as its grace can end it first), ends the attempt
and then cleans up; a refusal of the helper that ends it keeps the attempt
for the next stop. The session drops the
attempt, and with it the marker's refreshes, when no claim came within 40
minutes of the attempt's opening — a notification waits for the session to
be idle, so the deadline does not run from the agent's end — and when the
session or its process ends, or its conversation is reset (`/clear`,
`/resume`), when the agent is stopped with no notification: one would
reach the next conversation. A dropped attempt's marker is made stale once
its stopped agent has settled (at most 15 seconds), while it still names
that attempt, so the helpers let the next round in then rather than 90
seconds later.
Another session cannot stop the agent: its `cleanup`, `prepare --take-over`
and `resume` refuse while the marker is fresh, saying that a fix of the
session that owns the watch is running there. A marker no longer fresh is
one its session left behind: the gate prints an `abandoned_fix` event once
for it, so a round runs even when nothing else changed; that round's `sync`, once it answered,
removes it and reports `abandonedFix` (a `sync` that fails leaves it to the
next), and the round discards what the
worktree holds, as for any round that never finished, and handles the
attempt's items again with its fix in the foreground — a session whose
notifications do not reach the model would otherwise abandon one background
attempt after another. A `cleanup` that removes the watch and a
`prepare --take-over` remove such a marker too (a `cleanup` that keeps the
worktree leaves it to the next `sync`).

**The continuation.** The round launches the agent with
`run_in_background: true` and `description` = `autofix-pr <owner>/<repo>#<n>
round`. A scheduled round then ends its turn with one line; a start or a
resume goes back to the step that ran the round, so the watch is scheduled
before its fix ends. When the agent ends, its completion notification
carries a `<follow-up>` element the session writes, beside the agent's
escaped `<result>` and only while the attempt is still the round's to
claim: invoke the skill with
`after-fix <owner>/<repo>#<n> --task <task> --attempt <id>`, with
`--no-reply` and the instructions from the record. That turn enters the
skill again, whatever the conversation kept of the round, and runs
`fix-end <n> --task <task> --attempt <id>`, which removes the marker of
that attempt only and prints the snapshot the attempt took, its brief and
the head it started from; the tool adds how the agent ended, its report and
the watch's options, from memory, which the turn uses whatever the
follow-up said. A refusal of the helper leaves the attempt to claim again; one that says
the round's snapshot is gone drops it, to go stale. The tool reads a
helper's refusal from the line of the CLI's error that names it, not from
the stack printed after it.
The brief lists, besides the agent's items, the round's own — the re-runs
and the items needing a human that the round decided before the fix — so
the turn answers them too. Then it goes on with Section 7's re-runs, push
and reply, exactly as after a foreground agent. Nothing an agent that failed or
was stopped made is pushed: the turn runs `sync --discard` and answers the
brief's items as needing a human — on the PR with a fixed sentence, the
agent's report only in the session — as for a fix that did not verify, so
they are recorded and not lost to a gate that reported them already. A claim
the helper refuses — the attempt was dropped, or a round discarded it —
ends with one line. In plan mode the tool refuses `fix-end`; the turn says
so, and the attempt ends as an unclaimed one. A notification that never
comes, or comes too late, leaves the attempt to the `abandoned_fix` round.

`reply` without `--no-post` refuses on a watch started with `--no-reply`, so
that option holds even when a turn forgets it.

**Not in this step.** The budget of fix attempts per failing check without
turning green (Section 10) needs a record of which checks passed, which no
helper keeps yet; it stays a proposal.

### 6.15 The Web Shell: watches and their tasks

The Web Shell shows a watch where its owner already looks — the card of its
scheduled task — and on a page of its own, **PR watches**, which lists every
watch of the workspaces it reaches.

**What the daemon serves.** `GET /autofix-pr/watches` (the primary
workspace) and `GET /workspaces/:workspace/autofix-pr/watches` (a registered,
trusted one), advertised as `autofix_pr_watches`, answer what `status`
lists for the workspace's clone. One `git worktree list` finds every
worktree of the clone, so a workspace that is a linked worktree or a
subdirectory reads the clone's watches; the answer still names the main
worktree as `root` (for display). `runStatus` takes that set of worktrees
(`roots`) and no session, rather than the daemon's own directory and
environment, and runs no git command (`git: false`): the daemon lists the
watches on its own thread, where a git command that hangs would hold every
request. It reads the files only, each opened without
following a link and without blocking, so a FIFO put in place of one cannot
hold the daemon either (the helpers read them so too). No lock is taken and
GitHub is not asked, so the answer comes back while a helper runs. Left out
are `thisSession` (the daemon is no session), the worktree's path and what
only git tells (`gitTrusted`, `worktreeWork`). `available` is false when no
git repository is found for the workspace, or git cannot run there. The
routes change nothing.

**Which watch is a task's.** A scheduled task carries no kind: a watch's
task is known by the prompt `schedule` writes,
`Run /autofix-pr tick <owner>/<repo>#<n> [--task <id>]…`, matched to the
watch of that repository and number in the task's workspace. The task is
stale as its gate judges it: the watch ended, it records no task where the
task has an id, or it records another task (a later `schedule` replaced
it; a task from before task ids is not the one recorded either), or the
watch is another session's (a take-over moved it). Its gate stops it at its
next fire, and the card says so.

**What is shown.** The PR, as a link, with where the watch is, the first
that holds:

- the PR merged or closed (`stopped`);
- ended by a `cleanup` that kept the worktree (`ended`);
- no task (`watch` null: a `--once` check's state);
- fixing in the background (a fresh attempt, with its age);
- a background fix left behind (a stale one: the next round redoes it);
- checked within two intervals (`checkedRecently`);
- otherwise, not checked recently.

Then its pushes and maximum, when its gate last checked and its last round
ran, and the items left for a person (`needsHuman`). The page lists the
state files it cannot read with their reason, as `status` does.

**Actions.** Only for a watch whose owning session is a session of this Web
Shell: a task of it, not stale, is bound to the session the state file
names. The page looks for that task in every workspace it lists, and lists
a clone's watch once, as two checkouts of one clone can both be registered.

- **Open session** opens that conversation.
- **Stop watch** sends `/autofix-pr stop <n>` to it the way a scheduled
  task's manual run sends its prompt — the session switches there and the
  prompt goes through the same path as one typed — so the skill runs it,
  with every confirmation it asks for there. The Web Shell does not write a
  watch's files or delete its task itself.

Both restore the session in the workspace of its task — the one workspace
of a single-project daemon included — whatever workspace the watch is
listed under and whatever the current conversation is (another workspace's,
a standalone or a Live one).

A watch no session of this Web Shell runs, but whose gate checked within
two intervals, runs in another process (a terminal session) and is stopped
there; the page says so. Any other — ended, with no task, or checked by
nothing lately — is cleaned up or started again with `/autofix-pr stop <n>`
or `resume <n>` in a session of its workspace, which the page names.

**Refresh.** The page and the cards read the watches again every 15
seconds while shown. The cards read them only while a watch's task is
listed, and only from a daemon advertising the tag.

## 7. One check (`tick`)

The gate already ran `snapshot --gate`; a fire that reaches the model carries
its events in the gate output, so a quiet check never becomes a turn.

```text
snapshot --gate (in the gate)
  ├─ stop     → cleanup, cron_delete, report outcome
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

The fix runs in an `agent` with `working_dir` set to the worktree.
Its brief is a file listing the events, log paths, the trust rules, the user's
extra instructions and the verification requirement. The agent runs in the
foreground — the `agent` tool refuses `working_dir` with
`run_in_background`, since the caller owns the worktree — and the main
session runs `push` and `reply` when it returns. The one exception is a
watch whose fixes run unattended: there the tool allows the pair for the
built-in `general-purpose` agent at that watch's worktree, outside plan mode
in a trusted folder, the agent runs in the background and the round goes on
from its completion notification (Section 6.14). If verification fails, nothing is pushed and the failure is
reported.

A background fix's attempt marker (Section 6.14) keeps the gate quiet and
the round's helpers refused while its agent works. An attempt whose session
ended cannot keep the watch waiting: its marker goes stale, and the next
round removes it and discards what the worktree holds.

A resync whose new head does not contain the worktree's `HEAD` (the author
rebased or force-pushed) resets the worktree to the new head instead of
fast-forwarding. Whatever the tool pushed is now in the author's hands, as
part of the history they rewrote. The reset drops at most an attempt that
was not pushed, which was made on the old head, so `push` would refuse it
anyway; that attempt ends as above.

A tick never asks the user a question. Anything that needs a human (a design
disagreement, contradictory comments, a request outside the PR's scope) is
replied to as "needs a human decision" and recorded in `needsHuman`. The loop
keeps watching other events. The round answers such items on the PR, reports
them in its message and names them in the reply plan's `needsHuman`, which
`status` lists (Sections 6.5, 6.10).

## 8. Trust model

Every comment, review and CI log is data. A trusted author decides which
feedback is acted on, but cannot widen what the tool may do.

Verification runs the PR's code: its tests, and build scripts the PR may
change. For a PR whose author has no write access, that is someone else's
code running unattended with the user's `gh` and `git` credentials in reach.
No sandbox Qwen Code offers keeps those credentials out of that code's
reach: the default macOS profile restricts only writes, and inside a
container the helpers themselves need `gh` and `git` credentials. The watch
therefore does not watch such a PR at all; `--once` runs in the foreground
after the user confirms, with that risk spelled out, and `--yes` does not
skip the confirmation. A PR by the user or a collaborator is verified as the
user would verify it. `prepare` reports `authorCanPush` (the author is the
user, or has write access to the base repository), and the skill applies the
rule before it asks to start. A verification sandbox that holds no
credentials would lift the restriction; it is not part of this design.

The helpers check where a push goes and that it builds on the PR head, not
what the round's commits contain: a fix that moves a submodule pointer, for
one, is pushed like any other change. The brief tells the fix agent to stage
only the files it changed and never to commit a gitlink change the fix does
not need; the PR's review sees the rest. Nor do the helpers contain a fix
agent that turns against them: it runs commands with the user's own
credentials, as any tool the user runs does. They keep the session's own
steps, and an edited state file, from pushing anywhere else or rewriting the
PR's history, reading history as git stores it: replace refs and a graft
file are ignored.

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
- comments from anyone else. They are listed in the round's snapshot and report,
  but never acted on or replied to.

Even for actionable comments, the brief forbids: revealing secrets or tokens;
editing CI configuration to skip, disable or weaken checks; deleting or
weakening tests to make them pass; skipping the repository's commit hooks
(`--no-verify`); force-pushing; and changes unrelated to the PR. Such requests get a "needs a human decision" reply.

Loop guards for bots: each review comment gets one fix attempt (a new
comment in a thread already answered is a new request), a bot's reply in a
thread is no request (Section 6.2), and pushes are capped (Section 10). A bot that re-reviews every push therefore cannot keep the
loop running forever.

## 9. Replies

Replies are on by default; `--no-reply` turns them off.

- Each handled review thread gets a reply: `Fixed in <short-sha>: <one line>`,
  or `Not changed: <reason>`, or `Needs a human decision: <question>`.
- Each push gets one PR comment summarizing what it addressed: checks fixed or
  re-run, comments addressed, conflict resolved, and how it was verified.
- Replies use the language of the comment they answer; the summary uses the
  language of the PR's title, which `snapshot` reports (`title`).
- Every body ends with `<!-- qwen-autofix-pr:v1 -->`.
- Review threads are never resolved by the tool.

## 10. Scheduling, budgets and lifecycle

- Start runs the first check immediately — `snapshot <n>` in prepared mode,
  which reads the state file and not the gate cursor, so a new watch sees
  everything outstanding whatever an older gate reported — then calls
  `cron_create` with the task `schedule` printed before that round
  (Section 6.11), once `status` shows the watch still records it — what the
  round's fix agent could have written to the state file never reaches the
  task: a
  recurring job — session-only in a terminal session, durable and bound to the
  session in a daemon (`QWEN_CODE_SERVE=1`), whose idle reclaim would otherwise
  take a session-only task's in-memory scheduler with it — cron
  `*/<every> * * * *` (default `*/2`), the
  gate `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo> --host <host> --session <sessionId> --task <task>`
  (the host it passed to `prepare`, the session that owns the watch), and a
  prompt that tells the model how to handle the events in the gate output
  (`Run /autofix-pr tick <owner>/<repo>#<n> --task <task>`). The first
  round runs under that task too. The gate
  is confirmed once, like a Monitor command, when the task is created. A
  daemon conversation carries one scheduled task, so a second watch there
  needs a conversation of its own.
- Fires that arrive while the session is busy wait in the notification queue;
  the probe runs once when the session is idle and prints everything new
  since its previous run.
- The job ends with the process, except in a daemon session: there the task is
  durable and bound to its session, so the daemon keeps it resident and
  rehydrates it after a restart. The state file stays, owned by the session
  that wrote it, and a new session's `prepare` refuses it (Section 6.1).
  A later session takes the watch over, its pushes and budgets kept, with
  `prepare --take-over` once the user agrees (Section 6.1, step 5).
  `/autofix-pr resume` does that for every watch whose task this session
  does not run, after one confirmation, and creates the task `schedule`
  recorded at the start (`schedule --again`), so the watch goes on with the
  same interval, `--no-reply` and instructions. A task that expired is
  resumed the same way. It takes over and runs `schedule --again` for
  every watch it resumes before any round runs — a round's fix agent works
  beside the other watches' state files — and leaves out one whose printed
  options are not those it asked about; the new task ids stop every other
  task of the watches, one in a second process of the same session
  included, and it deletes the PRs' tasks left in this session. Then it
  runs a round of each under its task, then creates each task from what
  was printed, once `status` shows the watch still records it; it
  leaves out, unless the PR is named, a watch another session's gate
  checked within two of its intervals; and a watch `stop` ended while
  keeping its worktree has no task recorded, so it is not resumed.
  What the watch posted and handled survives in the PR's history file
  (Section 6.6), so the new watch does not answer the same comments again.
  A watch that stopped ran `cleanup` already.
- The cron maximum age setting (`QWEN_CODE_CRON_MAX_AGE_DAYS`) still applies.

Budgets, stored in the state file:

| Budget                                               | Default | When exhausted                 |
| ---------------------------------------------------- | ------- | ------------------------------ |
| Fix attempts per failing check without turning green | 3       | stop the loop                  |
| Re-runs per check per head SHA                       | 1       | treat the next failure as real |
| Fix attempts per review comment                      | 1       | never offered again            |
| Pushes per start                                     | 10      | stop the loop                  |
| Consecutive external head moves                      | 2       | stop the loop                  |
| Minutes one background fix may run                   | 30      | stop its agent, discard it     |

Stop conditions: the PR is merged or closed; `/autofix-pr stop`; a budget in
the table says stop; the cron job expires. Every stop but the scheduled task's expiry (7 days by default: `experimental.cronRecurringMaxAgeDays`, or `QWEN_CODE_CRON_MAX_AGE_DAYS`), which ends the watch without a round, runs `cleanup` and
prints the reason, the pushes made and any `needsHuman` items.

Cost: a quiet check is one probe run — one GraphQL call, plus one per extra
page of check contexts, check suites or review threads, and a REST call per
bot comment that opens a thread and was not asked about before — and no model turn. Only a check with events reaches the
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
  `snapshot` → `push` → `reply` → `cleanup` — not written yet; each helper
  is tested on its own against real git with a bare remote and a stubbed
  `gh`.
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
   start a second attempt (the background fix of step 4 adds the attempt
   marker of Section 6.14). The budgets it
   enforces are the pushes per start (`push`), one re-run per check and head
   (`rerun`), and one attempt per review comment (every comment a round
   handled is recorded, whatever its outcome; the round after the last
   push is the watch's last); two resyncs within one round
   stop the watch, and a round whose work was not pushed ends with
   `sync --discard`, so the next one does not build on it. The sandbox rule of
   Section 8 is applied at the start, and each round starts with `sync`, so
   a push or a rollback the GitHub API does not show yet is followed; it
   syncs once more before it pushes, which moves along the submodules a
   merge the fix agent made left behind. The skill's `allowedTools` grant
   reading its `.qwen/tmp` files, writing its brief, plan and the user's
   instructions (step 4 adds the last), and `cron_list` — no shell command. The permission matcher reads a leading
   `"${QWEN_CODE_CLI:-qwen}"` as an empty word, so no rule can name the
   helpers alone, and an allow rule for even a read-only command such as
   `gh pr view *` also admits command substitution, redirections and
   environment prefixes behind it. In the default approval mode each helper
   call — the push included — therefore asks first; step 4's `autofix_pr`
   tool changes that (Section 6.12).
4. The loop state: `status`, `stop`, budgets, and a later session taking
   over the state file.
   Begun (2026-10-25): `status` (Section 6.10) lists every watch from its
   files, the items left for a human included (`needsHuman` in the reply
   plan, Section 6.5); `schedule` (Section 6.11) records the watch's task;
   `/autofix-pr resume` takes watches over and schedules that task again.
   The `autofix_pr` tool (Section 6.12) runs the helpers, so the skill's
   `allowedTools` name a round's helpers and those run without asking;
   `unattended` (Section 6.13) lets the fix agent of a confirmed watch run
   its commands without asking too, and such a watch's fix agent runs in the
   background (Section 6.14), stopped at the 30-minute limit of Section 10.
   The Web Shell shows each watch on its task's card and on a PR watches
   page, and stops one in the session that owns it (Section 6.15).
   Still to come: the fix-attempts-per-failing-check budget of Section 10.
5. Follow-ups: a configurable bot allowlist.

Open questions:

- Should trusted bots be narrowed to a configurable allowlist by default once
  the setting exists?
- Should draft PRs be watched, or refused until marked ready?
- Some automation posts as a regular user account with collaborator access
  (on this repository, `qwen-code-review-bot` writes its triage status
  comments that way). Such comments pass the trust rules and each costs one
  fix pass before it is marked handled. Should a configurable list of
  automation logins be skipped?
