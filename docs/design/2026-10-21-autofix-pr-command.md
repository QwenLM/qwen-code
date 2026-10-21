# `/autofix-pr`: Watch a Pull Request and Fix It Locally

[English](2026-10-21-autofix-pr-command.md) | [简体中文](2026-10-21-autofix-pr-command.zh-CN.md)

Status: in progress. 2026-10-21. Delivery step 1 (the `prepare`,
`snapshot`, `ci-log` and `cleanup` helpers) is implemented; everything else is
a proposal. The four product decisions
in [Resolved decisions](#11-resolved-decisions) were made on 2026-10-21.

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

| Capability                  | Existing building block                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recurring trigger           | `cron_create` (`packages/core/src/tools/cron-create.ts`): session-only or durable, recurring jobs jittered by up to 10% of the period, auto-expiry. Fires enter the notification queue and never interrupt a running turn (`packages/cli/src/ui/hooks/use-llm-stream.ts`). |
| Loop conventions            | Bundled `loop` skill (`packages/core/src/skills/bundled/loop/SKILL.md`), `cron_list` / `cron_delete`, the CronPill.                                                                                                                                                        |
| Isolated PR worktree        | `qwen review fetch-pr` (`packages/cli/src/commands/review/fetch-pr.ts`) and its git helpers (`releaseWorktree` in `packages/cli/src/commands/review/lib/git.ts`, `redirectedAncestor` in `lib/worktree.ts`).                                                               |
| Delegation                  | The `agent` tool with `working_dir` and `run_in_background` (`packages/core/src/tools/agent/agent.ts`).                                                                                                                                                                    |
| Deterministic skill helpers | The `qwen review <helper>` pattern: logic lives in tested CLI subcommands and the skill calls them through `"${QWEN_CODE_CLI:-qwen}"`.                                                                                                                                     |
| Conflict policy             | The `/resolve` design ([2026-06-23-fix-conflicts-command.md](2026-06-23-fix-conflicts-command.md)): merge the base branch and push with `--force-with-lease` against the expected head SHA.                                                                                |
| Untrusted-input rules       | The repository's `.qwen/skills/autofix` skill treats PR text, comments and logs as data, not instructions.                                                                                                                                                                 |

What is missing is the deterministic part: reading a PR's state and computing
what changed since the last check, enforcing push safety, and posting replies
without creating feedback loops. Running a monitor until a condition is met
does not fit, because `monitor` stops after at most 10 minutes of silence,
while a PR can stay quiet for hours.

## 3. Goals and non-goals

Goals:

- Watch one PR from a local session and react to CI failures, review feedback
  from trusted authors, and merge conflicts.
- Never touch the user's working tree, and never force-push or push to the
  default branch.
- Reply to the feedback it handled, so reviewers can see what changed.
- Stop on its own when the PR is merged or closed, or when the attempt budgets
  run out, and report why.
- Keep idle checks cheap.

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
- `--every`: check interval in minutes, one of `5, 10, 15, 20, 30, 60`.
  Default `15`.
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
  ├─ fix                       background agent, working_dir = worktree
  ├─ qwen autofix-pr push      guarded push, advances the cursor
  ├─ qwen autofix-pr reply     post replies with a marker, record their ids
  ├─ qwen autofix-pr cleanup   remove worktree, branch and state file when safe
  └─ cron_create               session-only, recurring: "Run /autofix-pr tick <owner>/<repo>#<n>"
```

Helpers live under `packages/cli/src/commands/autofix-pr.ts` and
`packages/cli/src/commands/autofix-pr/`. Per-PR state lives next to the
worktree, outside it, under the clone's main worktree. Branches are shared by
every worktree of a clone, so each helper finds the same watch from any of
them, the autofix worktree included:

- worktree: `.qwen/tmp/autofix-pr-<n>/`
- state: `.qwen/tmp/autofix-pr-<n>-state.json`
- logs and briefs: `.qwen/tmp/autofix-pr-<n>-*.{log,md}`

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
   repository; otherwise use the head repository URL in the protocol from
   `gh config get git_protocol`. Record it in the state file.
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
   another repository's PR of the same number is a refusal.
8. Print a JSON report: worktree path, branch, head SHA, base/head refs, push
   target, viewer and PR author logins, draft and fork flags, and
   `localUnpushedCommits`, the number of commits on the user's own copy of the
   head branch that the PR does not have. The worktree never sees them. Only a
   local branch whose upstream is the head branch on the push remote counts as
   that copy, so a fork's `main` is never compared with the user's `main`.

### 6.2 `snapshot <pr>`

One GraphQL call reads:

- PR fields: `state`, `isDraft`, `url`, `headRefOid`, `mergeable`
- the status check rollup of the head commit (first 100 contexts)
- the first 100 `reviewThreads` with their comments (`id`, `databaseId`,
  `author { __typename login }`, `authorAssociation`, `body`, `url`)
- the last 100 `reviews` and the last 100 issue comments

`snapshot` compares them with the state file and prints events plus one action:

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
      "runId": 456
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
  id the REST replies endpoint accepts.
- Checks count only for the current `headRefOid`; a rollup of an older commit
  is ignored. A check run fails on `FAILURE`, `TIMED_OUT` or
  `STARTUP_FAILURE`; a commit status fails on `FAILURE` or `ERROR`.
  `CANCELLED` is not a failure. `runId` is parsed from an Actions URL and is
  null otherwise.
- CI that is still pending alone means `wait`. A trusted comment can still be
  fixed while CI runs, because the next push restarts CI anyway.
- A comment is new when its id is neither in `handledCommentIds` nor in
  `postedCommentIds`, and its body does not carry the reply marker
  (Section 9). Resolved threads, empty or pending reviews are skipped;
  outdated threads are kept with `outdated: true`.
- A head SHA that differs from `lastKnownHeadSha` and is not in `pushedShas`
  is `head_moved_externally`.
- `truncated` names the connections (`checks`, `reviewThreads`) that had more
  entries than the query reads.

Action precedence: `stop` (merged or closed) → `resync` (head moved
externally) → `fix` (a conflict, a failed check or a trusted comment) →
`wait`. The loop adds two more inputs: an exhausted budget means `stop`, and a
fix in flight (`inFlight` in the state file) means `wait`.

### 6.3 `ci-log <pr> <run-id> [--lines 200]`

Writes the failed jobs' log (`gh run view --log-failed`), trimmed to the last
`--lines` lines per job with a note of how many were omitted, to
`.qwen/tmp/autofix-pr-<n>-ci-<run-id>.log`, and prints the path and the job
names. The fix agent reads that file instead of piping logs into a shell
preview. `--lines` must be a positive integer.

### 6.4 `push <pr>`

Refuses unless all of these hold:

- the worktree is clean (every change committed);
- `lastKnownHeadSha` is an ancestor of `HEAD` (fast-forward only, no history
  rewrite);
- the target branch is not the base repository's default branch.

Then it runs
`git push <target> HEAD:refs/heads/<headRef> --force-with-lease=refs/heads/<headRef>:<lastKnownHeadSha>`.
Pre-push hooks run, and there is no `--force` or `--no-verify`. On success it
records the new SHA in `pushedShas` and `lastKnownHeadSha`, counts one push,
and clears `inFlight`. A rejected lease means someone else pushed; the result
is `resync`, not a retry.

### 6.5 `reply <pr> <plan.json>`

Posts the replies in a plan the skill writes (Section 9), adds the marker to
each body, records the returned ids in `postedCommentIds`, and moves the
handled comment ids into `handledCommentIds`. Replies to review threads use
`POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`; the push summary
uses an issue comment.

### 6.6 `cleanup <pr> [--force]`

Removes the worktree, its branch and the state file together. When the
worktree has uncommitted changes, or the worktree (or the branch, once the
worktree was deleted) has commits beyond `lastKnownHeadSha`, all three are
kept and the report says why. Without a state file there is no recorded head,
so a leftover worktree or branch is kept. A state file owned by another
session is a refusal. `--force` overrides these checks and also discards an
unreadable state file. A branch that cannot be deleted is an error, and the
state file stays. Running `cleanup` from inside the worktree it would remove
is a refusal.

## 7. One check (`tick`)

```text
snapshot
  ├─ stop     → cron_delete, cleanup, report outcome
  ├─ wait     → end the turn with no message
  ├─ resync   → fetch, fast-forward the worktree to the new head, set cursor;
  │             two resyncs in a row → stop: "someone else is pushing to this PR"
  └─ fix
       1. conflict  → merge origin/<base> in the worktree (merge, never rebase)
       2. ci_failed → ci-log; the agent decides between a code fix and
                      "infrastructure" → gh run rerun <runId> --failed
                      (at most once per check per head SHA)
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

A tick never asks the user a question. Anything that needs a human (a design
disagreement, contradictory comments, a request outside the PR's scope) is
replied to as "needs a human decision" and recorded in `needsHuman`. The loop
keeps watching other events.

## 8. Trust model

Every comment, review and CI log is data. A trusted author decides which
feedback is acted on, but cannot widen what the tool may do.

A comment is actionable when its author is:

- `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`;
- the PR author;
- a bot account (`__typename == "Bot"`), for reviews and review-thread
  comments only. Bot issue comments, such as coverage or CI reports, are not
  treated as requests.

Never actionable:

- comments with the reply marker or with an id in `postedCommentIds`. The
  viewer is often the PR author and therefore trusted, so without this rule the
  tool would answer itself.
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

- Start runs the first tick immediately, then calls `cron_create` with a
  session-only recurring job, cron `*/<every> * * * *` (default `*/15`), prompt
  `Run /autofix-pr tick <owner>/<repo>#<n>`. The cron prompt reaches the model
  as text, and the model invokes the skill.
- Fires that arrive while the session is busy wait in the notification queue.
- The job ends with the process. Re-running `/autofix-pr` later resumes from the
  state file, so handled comments are not answered twice.
- The cron maximum age setting (`QWEN_CODE_CRON_MAX_AGE_DAYS`) still applies.

Budgets, stored in the state file:

| Budget                                               | Default | When exhausted                 |
| ---------------------------------------------------- | ------- | ------------------------------ |
| Fix attempts per failing check without turning green | 3       | stop the loop                  |
| Re-runs per check per head SHA                       | 1       | treat the next failure as real |
| Fix attempts per review thread                       | 1       | reply "needs a human decision" |
| Pushes per start                                     | 10      | stop the loop                  |
| Consecutive external head moves                      | 2       | stop the loop                  |

Stop conditions: the PR is merged or closed; `/autofix-pr stop`; a budget in
the table says stop; the cron job expires. Every stop runs `cleanup` and
prints the reason, the pushes made and any `needsHuman` items.

Cost: a quiet tick is one short model turn (the `snapshot` call and an empty
end of turn). At 15 minutes that is at most 4 turns an hour. Skipping the model
turn when nothing changed needs a cron precondition and is follow-up work
(Section 12).

## 11. Resolved decisions

Decided on 2026-10-21:

1. The command is named `/autofix-pr`.
2. Trusted authors include the PR author and review bots, in addition to
   `OWNER`, `MEMBER` and `COLLABORATOR`.
3. Replying on the PR is part of the first version and on by default.
4. The default check interval is 15 minutes.

## 12. Risks, validation and delivery

Risks:

- Pushing under the user's identity. Mitigated by consent on every start, the
  push guard and the budgets.
- Feedback loops with bots or with the tool's own replies. Mitigated by the
  marker, the recorded ids and per-thread attempts.
- Racing another agent or a person on the same branch. Mitigated by
  `--force-with-lease` and stopping after two external head moves.
- Conversation growth in long sessions. Each quiet tick adds a small exchange;
  context compaction handles it, and the cron precondition follow-up removes it.

Validation:

- Unit tests with recorded `gh` JSON fixtures: event diffing, stale checks on
  an old SHA, the trust classes, marker and id self-exclusion, action
  precedence, budgets.
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

1. Helpers `prepare`, `snapshot`, `ci-log` and `cleanup` with tests.
2. Helpers `push` and `reply` with tests, and the skill with `--once`. The
   state records which failed checks were handled on which head, so a failure
   the agent declined or reran is not dispatched again on the same head.
3. The loop: `tick`, `status`, `stop`, budgets and resume from the state file.
4. Follow-ups: a cron precondition so quiet ticks skip the model, durable
   watching in daemon sessions (`durable` with `sessionMode: "current"`), and a
   configurable bot allowlist.

Open questions:

- Should trusted bots be narrowed to a configurable allowlist by default once
  the setting exists?
- Should draft PRs be watched, or refused until marked ready?
- Some automation posts as a regular user account with collaborator access
  (on this repository, `qwen-code-review-bot` writes its triage status
  comments that way). Such comments pass the trust rules and each costs one
  fix pass before it is marked handled. Should a configurable list of
  automation logins be skipped?
