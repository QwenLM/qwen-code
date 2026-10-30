# `/autofix-pr --in-place`: Co-Driving in the User's Own Checkout

[English](2026-10-30-autofix-pr-in-place-copilot.md) | [简体中文](2026-10-30-autofix-pr-in-place-copilot.zh-CN.md)

Status: proposed and implemented in the same change. Date: 2026-10-30.

This design extends [`/autofix-pr`](2026-10-21-autofix-pr-command.md) with a
second working mode. Section numbers below that cite "the command design"
refer to that document.

## 1. Problem

`/autofix-pr` always fixes a PR in a dedicated worktree
(`.qwen/tmp/autofix-pr-<n>`, branch `qwen-autofix/pr-<n>`). That isolation is
what makes an unattended watch safe, but it is the wrong shape for
human-machine co-driving — the user sitting in a session, working on the PR
branch together with the agent:

- Every push the watch makes leaves the user's own checkout behind; the next
  push from there is refused. The skill warns about this at start, and the
  user must fetch and reset by hand after every round.
- The dedicated worktree has no `node_modules` or other installed state; the
  fix agent pays a full setup before it can run the repository's checks,
  while the user's checkout already has everything.
- The user cannot see the edits as they happen, cannot intervene mid-fix,
  and reviews only after the push, on the PR.

When the session's current branch **is** the PR's head branch, working
directly in that checkout removes all three frictions. Today the skill
refuses to start in exactly this situation whenever the checkout holds
unpushed or uncommitted work (`localUnpushedCommits`,
`localUncommittedChanges`, `localWorkUnknown` in `prepare`): it detects the
two-writer conflict and declines. This design turns that refusal seam into
an explicit, consented co-driving mode.

## 2. Current state

Verified against the implementation at the time of writing
(`packages/cli/src/commands/autofix-pr/`,
`packages/core/src/skills/bundled/autofix-pr/SKILL.md`):

- `prepare` fetches `refs/pull/<n>/head` into a fresh `qwen-autofix/pr-<n>`
  branch and runs `git worktree add`. The user's checkout is never touched
  (SKILL.md rule 3).
- The watch lifecycle is destructive by design: `sync --discard` runs
  `git reset --hard` plus `git clean -ffdq` (`sync.ts`); `requireWorktree`
  with `switchBack` runs `git switch --discard-changes` (`worktree.ts`); a
  round that ends without pushing discards the worktree's work; `cleanup`
  removes the worktree and the branch.
- Rounds never ask (SKILL.md rule 4): a scheduled fire runs `sync`,
  `snapshot`, a fix agent (in the background when `unattended`), `push`,
  `reply` — without a question. Anything needing a person becomes a
  "Needs a human decision" reply on the PR.
- Trust checks assume a linked worktree: `untrustedGitfile` requires a
  gitfile naming the clone's own worktree entry; the anchor store and
  `trustAnchor` pin the genuine clone (`state.ts`, `worktree.ts`).
- The daemon shell guard confines a session's commands to its own working
  directory, so a watch prepared from a linked worktree roots there
  (`watchRoot()`, design
  [2026-10-29-autofix-pr-worktree-rooted-storage](2026-10-29-autofix-pr-worktree-rooted-storage.md)).

None of these may change for the existing worktree mode.

## 3. Goals and non-goals

Goals:

- An explicit `--in-place` mode in which the fix agent works in the user's
  own checkout of the PR head branch, in the foreground, attended.
- The user's work is never destroyed: every destructive path of the worktree
  mode becomes a refusal that asks the user instead.
- The user sees edits live, can edit alongside the agent, and keeps using
  the checkout's installed dependencies.
- Push, reply, rerun, budgets, history and the trust rules of the command
  design keep working unchanged in substance.

Non-goals (v1):

- No scheduled in-place watch: no cron task, no background fix, no
  `unattended` grant. Rounds run only when the user invokes the skill.
- No automatic branch switching: the mode requires the head branch to be
  checked out already; the skill never checks out a branch for the user.
- No mid-flight conversion between modes: switching means `cleanup` and a
  fresh `prepare`.
- No sandboxing. The exposure is spelled out and consented to (Section 7).

## 4. User experience

```
# session opened at the root of the checkout that holds the PR branch
/autofix-pr 123 --in-place
```

The start confirmation replaces the worktree mode's confirmation bullets
and says:

- the fix agent works **in this checkout**, in the foreground, and the user
  may edit alongside it;
- the round pushes whatever the branch holds on top of the PR head —
  **including commits the user makes** between the round's sync and push;
- nothing is ever discarded automatically: a dirty or diverged checkout
  stops the round and asks;
- there is no scheduled task; each `/autofix-pr <n> --in-place` runs one
  round, and `cleanup` at the end keeps the checkout and the branch.

A round then runs as usual — sync, snapshot, fix, verify, push, reply —
except that the fix agent's `working_dir` is the user's checkout, it always
runs in the foreground under the session's approval mode, and any step that
would discard work stops and asks the user instead.

`--every` with `--in-place` is refused. `--yes` does not skip the start
confirmation (the consent is about the user's own tree). Headless runs are
refused: co-driving presumes a person present. `--no-reply` and free-text
instructions work as in the worktree mode.

## 5. Design decisions

1. **Attended, manual rounds only.** The worktree mode's core contract is
   "a round never asks"; co-driving's is "a person is present and decides".
   v1 keeps the two contracts from mixing: an in-place invocation is
   `--once`-shaped (prepare → one round → cleanup, history kept), and
   `schedule`, `fix-start` and the `unattended` grant refuse in-place
   watches. Scheduled in-place rounds that ask before editing are a possible
   follow-up, not this change.
2. **Never destroy user work.** `sync --discard` is refused outright in
   place; the history-rewrite reset and the dirty-worktree reset become
   `synced: false` answers; `requireWorktree` never switches the user's
   branch back; `cleanup` never removes the checkout or a branch. Every
   refusal names what the user must do (commit, stash, switch back,
   reconcile).
3. **Push carries the user's commits.** Between a round's sync and push the
   user may commit; the push sends everything the branch holds on top of
   the known head, under the same fast-forward lease. Filtering by author
   was rejected: git authorship is not a boundary, and co-driving means
   pushing together. The start confirmation states this explicitly.
4. **One optional state field.** `AutofixPrState.inPlace?: true`; absent
   means the worktree mode. Old state files read unchanged; no migration.
   `worktreePath` names the user's checkout toplevel and `branch` names the
   PR head branch itself — no `qwen-autofix/pr-<n>` branch is created.
5. **Entry is a narrow, checked seam.** `prepare --in-place` refuses unless
   every precondition holds (Section 6.1); it never tries to repair the
   user's checkout into shape.
6. **The flag is `--in-place`** (tool parameter `in_place`), on `prepare`
   and on the skill's start arguments. It describes where the work happens,
   symmetric with the worktree mode's "a worktree of its own".

## 6. Proposed changes

### 6.1 `prepare --in-place`

New checks, all before anything is written, in this order:

1. **No watch of this PR exists in the clone** (`findWatchRoot`), in either
   mode → `cleanup` first. This is also how a mode conversion happens.
2. **Session placement.** Under the daemon (`QWEN_CODE_SERVE=1`), the
   same containment rule as `assertSessionCanRunWorktree`, applied to the
   checkout: it must lie inside the session's working directory, which for
   a checkout toplevel means the session must be opened **at the checkout
   root**. Outside the daemon, the cwd must lie inside the checkout.
3. **The checkout is the repository the session sits in.**
   `git rev-parse --show-toplevel` from the cwd names it; a cwd inside a
   submodule or a foreign repository fails remote inference (no single
   remote serves the PR's repository) before anything is written.
4. **The head branch is checked out.** `symbolic-ref -q HEAD` equals
   `refs/heads/<headRefName>`; a detached HEAD or another branch is refused
   (the skill never switches branches for the user).
5. **The push target is a named remote, and the branch tracks it.** git
   can only track `<remote>/<branch>`, never a URL: when no remote of this
   clone serves the head repository (`pushTargetFor` falls back to a URL),
   the refusal names the actionable step — add a remote whose fetch and
   push URLs both serve the head repository, and set the branch's upstream
   to it. With a named remote, the upstream must be
   `<pushTarget>/<headRefName>` — the same convention `localCopy` uses to
   recognize the user's copy of the head branch.
6. **The checkout is clean.** The `checkoutHoldsWork` semantics: porcelain
   status with untracked files, NUL-delimited (`-z`) so a C-quoted path
   cannot masquerade as user work, where untracked watch files under
   `.qwen/tmp` do not count.
7. **No unpushed local commits.** After fetching `refs/pull/<n>/head` into
   the watch's private ref `refs/qwen-autofix/pr-<n>/head` (outside
   `refs/heads`, moving no branch — not `FETCH_HEAD`, which the user's
   concurrent fetches rewrite in the shared checkout), the local branch
   tip is the PR head or an ancestor of it. Ahead or diverged → refuse with
   guidance; the first round's `sync` fast-forwards a behind branch.
   `cleanup` deletes the private ref.

The standard eligibility checks (open PR, push permission, default-branch
refusal, `authorCanPush`) apply unchanged. On success `prepare` writes the
state with `inPlace: true`, `worktreePath` = checkout toplevel, `branch` =
`headRefName`, `lastKnownHeadSha` = the fetched PR head — and creates no
branch and no worktree. The report carries `inPlace: true` so the skill can
pick the in-place confirmation and round contract.

There is no in-place resume or take-over in v1: an in-place watch has no
scheduled task, so `resume` never meets one, and a leftover state — even
one a crashed round left behind — is removed with `cleanup`. A classic
`prepare` that finds an in-place state likewise refuses (mode mismatch),
naming `cleanup` as the only way forward; the check runs both at the first
state read and again under the watch lock, so an in-place start landing
during the classic call's GitHub round-trips cannot be silently converted
into a worktree watch.

### 6.2 `sync` in place

- `--discard` → refused: "an in-place watch never discards the user's
  checkout".
- Dirty checkout (at any step that would move it) → `synced: false` with a
  reason that tells the user to commit or stash; it never suggests
  `--discard`.
- History rewrite (the known head is not an ancestor of the new PR head) →
  `synced: false`: the author rewrote history; the user reconciles the
  checkout. The worktree mode's clean-tree `reset --hard` does not run.
- Clean and fast-forwardable → fast-forward the user's branch (this is the
  co-driving win: the author's pushes arrive in the user's checkout), then
  align submodules with `keepWork = true` — a submodule holding work is
  left alone, and if that keeps the tree from being clean the answer is
  `synced: false`. The merge runs with `--no-overwrite-ignore`: when the PR
  head starts tracking a path the checkout holds as an ignored file, git
  refuses and the answer is `synced: false` naming the collided paths —
  the dirty gate ignores ignored files on purpose, and the merge must not
  destroy them.
- The PR head is fetched into the watch's private ref
  (`refs/qwen-autofix/pr-<n>/head`, the same ref prepare uses) and read
  from there — never from the shared `FETCH_HEAD`, which a concurrent
  fetch in the user's checkout rewrites between the fetch and the read.
- The checked-out branch is revalidated after the network round-trips and
  immediately before the checkout is mutated: a user who switched branches
  while the fetch waited gets the mid-round-switch refusal, and neither
  branch advances.
- Unpushed commits (the round's, the user's, or both) with the new head on
  top → `action: "merge"` as today; the merge runs in the foreground, in
  the user's checkout, attended.

### 6.3 `push` in place

Mechanically unchanged: fast-forward only, leased on the known head, never
to the default branch, pre-push hooks run, `MAX_PUSHES` budget. Two
consequences are documented, not coded around:

- the push carries any commits the user made since the round's sync
  (decision 3);
- `push` still refuses a checkout with uncommitted changes — the round
  asks the user to commit or set aside their edits first.

### 6.4 `requireWorktree` and the trust checks in place

- The branch check stays: HEAD must be on `state.branch`. `switchBack` is
  never honored in place — if the user switched branches mid-round, the
  helper refuses and the user switches back.
- The gitfile check adapts to the checkout kind: a linked worktree keeps
  `untrustedGitfile` unchanged (trust root = the clone's main worktree);
  the clone's **main** worktree has a `.git` directory, so the check
  instead compares that directory's kernel-resolved path (`realpath`)
  against the clone's own git common directory, resolved from the trusted
  root. No git command runs in the checked tree — that would read the
  config in question; the toplevel match is `requireWorktree`'s separate
  later check. `untrustedSubmodules` applies unchanged.
- The symlink-ancestor and anchor checks apply unchanged.

### 6.5 `cleanup` in place

Ends the watch and removes only what the watch owns: the state file, its
tmp artifacts and the private head ref (`refs/qwen-autofix/pr-<n>/head`),
keeping the history and the gate-cursor rules exactly as today. It never
calls `releaseWorktree`, never deletes a branch, and `--force` changes only
ownership/readability handling (plus the leftover lock and non-regular
gate cursor a killed helper may have left) — never touches the tree. The
answer reports `removed: true` with `inPlace: true`; the skill's "the
worktree was kept" wording does not apply (there is nothing of the watch's
to keep). The "cannot remove from inside it" guard is moot.

### 6.6 `schedule`, `fix-start`, `unattended`

- `schedule` refuses an in-place watch: rounds run only when the user asks.
- `fix-start` refuses an in-place watch: no background fix. (`fix-end`
  needs no change — no attempt can exist to claim.)
- The `autofix_pr` tool's `unattended` command refuses an in-place watch;
  `attended` works as today.

### 6.7 `status` and the Web Shell

`status` passes `inPlace` through. For an in-place watch, `worktreeWork`
describes the **user's checkout**; the skill reports it as "your checkout
holds work", not as a round's leftover. The Web Shell PR-watches page reads
the same listing; it must not misreport an in-place watch as a worktree one
(pass the field through; a badge is optional and verified during
implementation). In-place watches are short-lived, so the page rarely shows
one.

### 6.8 The skill (`SKILL.md`)

- Arguments: `--in-place` on a start; a start giving both `--every` and
  `--in-place` stops and says so before `prepare` (an agent action, not a
  passive promise — no helper ever receives the combination).
- Rule 3 carve-out: "The user's working tree is never touched — except in
  an explicit `--in-place` start, where the user's checkout **is** the
  workspace, consented to at the start."
- Rule 4 carve-out: an in-place round may ask the user; it is attended by
  definition. It still never needs to ask on a quiet PR.
- Start: the in-place confirmation of Section 4; headless refused; `--yes`
  does not skip it; `authorCanPush: false` keeps its existing stricter
  confirmation, now also saying the code runs in the user's own checkout.
- Round: every `sync --discard` path (unverified fix, refused push, failed
  merge, abandoned work) becomes "stop and ask the user what to keep"; the
  fix agent runs in the foreground with `working_dir` = the checkout; the
  end-of-round `cleanup` always runs (once-shaped).
- Brief template: an in-place variant of the working-directory paragraph —
  the directory is the user's checkout, shared with the user, who may edit
  alongside — and of the verification-failure sentence ("the round stops
  and asks the user what to keep — nothing is discarded", not "the round
  discards it"); the `## Never` list keeps every item (no stash, no branch
  switching, no writes outside the checkout, no push — the main session
  pushes).
- Stop / Status / Resume: the in-place wordings above; an in-place watch
  has no task, so `resume` never meets one — a leftover in-place state is
  `cleanup`'d, and the next start prepares fresh.

### 6.9 The `autofix_pr` tool (core)

`prepare` gains the `in_place` parameter (allowlisted like `take_over`);
the confirmed-watch record gains `inPlace` from the prepare report, and
the reply-plan location check derives the plan directory from it: an
in-place watch's plan sits in `<checkout>/.qwen/tmp`, not beside the
checkout (its parent), which is where a worktree watch's plan sits.
`unattended` refuses in-place watches (6.6).

## 7. Trust model delta

The worktree mode's isolation buys two things: the user's tree is never
touched, and a round that goes wrong is contained in a directory the
helpers own. In-place deliberately gives both up, with explicit consent:
the fix agent runs the PR's code **in the user's checkout, with the user's
credentials in reach** — the same exposure as an attended session in which
the user asks the agent to edit that checkout directly. The start
confirmation spells this out, and for a PR whose author cannot push
(`authorCanPush: false`) the existing stricter confirmation applies on top.

What does not change:

- PR content is data; trusted authors decide what is acted on, never what
  the tool may do (command design Section 8).
- The brief's `## Never` list, the push lease, fast-forward-only, the
  default-branch refusal, the push budget, and the helpers' refusal to push
  anywhere but the PR's head branch.
- The git-level trust checks adapt (6.4) but keep their purpose: a round
  cannot repoint the checkout's git at a replacement repository and have
  the helpers vouch for it. As in the command design, this is
  defense-in-depth, not a boundary against same-user writes.

What changes: the destructive lifecycle is replaced by refuse-and-ask
(decision 2), so the worst a confused round can do to the user's work is
stop and ask — not discard it.

## 8. Files affected

- `packages/cli/src/commands/autofix-pr/prepare.ts` — `--in-place` entry
  checks and state; report field.
- `packages/cli/src/commands/autofix-pr/sync.ts` — in-place refusals and
  keep-work submodule alignment.
- `packages/cli/src/commands/autofix-pr/worktree.ts` — `requireWorktree`
  in-place branch/gitfile handling.
- `packages/cli/src/commands/autofix-pr/cleanup.ts` — file-only removal.
- `packages/cli/src/commands/autofix-pr/schedule.ts`, `fix.ts` — refusals.
- `packages/cli/src/commands/autofix-pr/state.ts` — `inPlace` field.
- `packages/cli/src/commands/autofix-pr/status.ts` — pass-through.
- `packages/cli/src/commands/autofix-pr/push.ts` — no logic change; test
  coverage for the user-commits-ride-along case.
- Collocated tests for each of the above.
- `packages/core/src/tools/autofix-pr.ts` (+ grants if touched) and tests —
  `in_place` parameter, `unattended` refusal.
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` — Sections 4, 6.8.
- `packages/web-shell` PR-watches listing — pass-through verified during
  implementation.
- This design pair; the E2E test plan under `.qwen/e2e-tests/`.

## 9. Constraints and risks

- **Two writers, one tree.** The user may edit while the fix agent runs.
  v1's answer is presence plus the approval mode: the user sees each edit,
  and `sync`/`push` refuse a dirty tree instead of moving it. A user who
  edits during a foreground fix can still produce a confused commit; the
  brief tells the agent to stage only its own files by name.
- **Entry strictness.** Requiring a clean checkout at the PR head (or
  behind) means the user must commit or stash before starting. This is
  deliberate: the mode never reconciles the user's work for them.
- **Push budget.** Each in-place invocation is a fresh watch, so
  `MAX_PUSHES` applies per invocation chain, as it does for `--once` today;
  history persists across invocations.
- **Daemon placement.** The session must sit at the checkout root under the
  daemon; a session in a subdirectory is refused with the directory to open
  (the same fail-closed shape as the worktree mode).

## 10. Validation plan

Unit tests (collocated, vitest):

- `prepare --in-place`: each refusal (wrong branch, detached, dirty, ahead,
  diverged, wrong upstream, subdirectory daemon session, existing watch,
  another clone) leaves nothing written; the happy path writes the state
  with `inPlace`, creates no branch and no worktree, and a behind branch is
  left for the first sync.
- `sync` in place: `--discard` refused; dirty → `synced: false` without
  `--discard` advice; rewrite → `synced: false`, branch unmoved; clean
  fast-forward moves the branch; a submodule holding work is kept.
- `requireWorktree` in place: main-worktree gitdir check; linked-worktree
  gitfile check; another branch → refusal, never a switch.
- `push` in place: a user commit between sync and push rides along under the
  lease; uncommitted changes refuse.
- `cleanup` in place: checkout and branch untouched, state and tmp files
  gone, history kept; `--force` no different for the tree.
- `schedule` / `fix-start` / `unattended`: refuse in-place watches.
- Regression: every existing worktree-mode test passes unchanged.

E2E (full plan in `.qwen/e2e-tests/autofix-pr-in-place-copilot.md`, Phase 3):
a scratch PR whose head branch is checked out in a real clone; an attended
`--in-place` round fixes a failing check in the user's checkout and pushes;
a dirty checkout stops the round with a question and survives untouched;
`cleanup` leaves the checkout and branch intact; the worktree mode on the
same PR afterwards behaves exactly as before.

## 11. Acceptance criteria

1. `/autofix-pr <n> --in-place` from a session at the checkout root, on the
   PR head branch, clean and at head, runs one attended round in that
   checkout and pushes; the checkout keeps its installed dependencies
   throughout.
2. No code path of an in-place watch runs `reset --hard`, `clean`,
   `switch --discard-changes`, `worktree remove` or `branch -D` against the
   user's checkout or branch (unit-tested).
3. A dirty or diverged checkout stops the round with a refusal that names
   the user's next step; the user's work is byte-for-byte intact afterwards.
4. `schedule`, `fix-start` and `unattended` refuse an in-place watch; no
   cron task is created for one.
5. `cleanup` of an in-place watch removes only watch files; the checkout,
   the branch and the user's commits remain.
6. Every pre-existing worktree-mode unit test passes without modification.
7. Both design versions and the SKILL.md changes ship in the same PR.

## 12. Open questions

1. Scheduled in-place rounds that ask before editing — worth a follow-up
   once the manual mode proves out? (v1: no.)
2. Should `prepare` fast-forward a behind branch immediately instead of
   leaving it to the first `sync`? (v1: first sync, so `prepare` itself
   moves nothing.)
3. Does the Web Shell PR-watches page need an in-place badge, or is the
   pass-through enough for a watch that lives one round? **Verified during
   implementation:** the daemon route spreads the status watch through
   (`autofix-pr-watches.ts`), so `inPlace` reaches the client unchanged,
   and the view omits `worktreePath` entirely — nothing misreports an
   in-place watch as a worktree one. No badge in v1.
