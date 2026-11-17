# `/autofix-pr --in-place`: scheduled rounds that ask before editing

[English](2026-10-31-autofix-pr-in-place-scheduled-ask.md) | [简体中文](2026-10-31-autofix-pr-in-place-scheduled-ask.zh-CN.md)

Status: proposed (not implemented). Date: 2026-10-31.

This design extends [`/autofix-pr --in-place`](2026-10-30-autofix-pr-in-place-copilot.md)
(the "v1 in-place design", merged in #15929) with the follow-up its Section 12
open question 1 left open: scheduled in-place rounds that ask the user before
they edit. Section numbers below that cite the "command design" refer to
[2026-10-21-autofix-pr-command](2026-10-21-autofix-pr-command.md); those that
cite "v1" refer to the v1 in-place design.

## 1. Problem

v1 in-place is once-shaped: every round is a manual `/autofix-pr <n> --in-place`
invocation, and the round's end cleans the watch up. That is safe — a person
is present for each round — but it asks the user to remember to run a round
whenever CI fails or a trusted reviewer comments. The co-driving benefit
(the agent works in the user's own checkout, with its installed dependencies)
is then gated on the user noticing the PR needs attention.

Worktree mode already runs rounds on a schedule, but its rounds never ask
(command design rule 4) and its lifecycle is destructive-by-isolation: a
scheduled round may `reset --hard`, `clean`, and discard a worktree because
the worktree is the helper's own, never the user's. None of that is safe in
the user's checkout, where a second writer (the user) may be editing.

The gap is a mode that combines the two: rounds fire on a schedule like
worktree mode, but each round asks the user before it edits the checkout,
like v1 in-place. v1 deliberately left this out (v1 Section 5 decision 1:
"the two contracts are not mixed in v1"); this design is that follow-up.

## 2. Current state

Verified against the merged implementation
(`packages/cli/src/commands/autofix-pr/`,
`packages/core/src/skills/bundled/autofix-pr/SKILL.md`):

- `schedule` refuses an in-place watch (`state.inPlace` → "its rounds run
  only when you ask … there is no scheduled task"); `fix-start` refuses it
  too ("its fixes run in the foreground … never in the background"). The
  skill stops a start that gives both `--every` and `--in-place` before
  running `prepare`.
- A worktree watch's scheduled task (`scheduledTask`) is a cron expression,
  a **gate** (`autofix-pr snapshot <n> --gate --session <id> --task <id>`)
  that runs without the model and prints only what changed since the gate
  cursor, and a **prompt** (`Run /autofix-pr tick <repo>#<n> …`) delivered
  to the session as a turn when the gate reports something to do. A daemon
  session's task is `durable` and bound to the session (`sessionMode:
"current"`), so the daemon keeps the session resident and reloads the task
  after a restart.
- The gate advances its cursor when it reports events; the round that the
  fire starts addresses them. A quiet PR costs no turn.
- v1 in-place's round: `sync` fast-forwards a clean checkout (the co-driving
  benefit) and answers `synced: false` for a dirty or diverged one; the fix
  agent runs in the foreground in the checkout; every path that would
  discard stops and asks; the round's end runs `cleanup`, which removes only
  the watch's files. There is no task and no gate cursor in play.

None of this changes for worktree mode.

## 3. Goals and non-goals

Goals:

- An in-place watch may run rounds on a schedule (`--in-place --every <n>`).
- A scheduled round **asks the user before the fix agent edits the
  checkout**, and edits nothing without an explicit per-round approval.
- A fire that finds nothing to do costs no turn and asks nothing (the gate
  stays cheap, as in worktree mode).
- A declined or unanswered round changes nothing and loses nothing: its
  events stay pending for a later fire.
- v1's safety holds unchanged: nothing is ever discarded automatically; a
  dirty or diverged checkout stops and asks; the fix is foreground only.

Non-goals:

- No autonomous editing in the user's checkout, ever, without a per-round
  approval. There is no "fixes run without asking" for an in-place watch,
  scheduled or not, and no `unattended` grant.
- No background fix for in-place (it stays foreground, as v1).
- No change to worktree mode's scheduled rounds, gate, or lifecycle.
- No new sandbox. The exposure is v1's (Section 7), consented per round.

## 4. User experience

```
# Session at the checkout root, on the PR head branch, clean
/autofix-pr 123 --in-place --every 5
```

The start confirmation **replaces** v1's once-shaped confirmation. It says:

- the fix agent works in this checkout, in the foreground, under the
  session's approval mode, and the user may edit alongside it;
- a round fires every `<n>` minutes; **each round asks before it edits** —
  it reports what it found (failing checks, trusted review feedback) and
  waits for a "Fix it" answer; nothing is edited without that answer;
- a round pushes what the branch holds on top of the PR head — including
  the user's own commits made between the round's sync and push — and
  replies on the PR, under the user's git and `gh` identity;
- nothing is ever discarded automatically: a dirty or diverged checkout
  stops the round and asks;
- a declined or unanswered round edits nothing and keeps its events for the
  next fire; `/autofix-pr stop 123` ends the watch, keeping the checkout,
  the branch and the history.

The options are "Start" and "Cancel" only — `--yes` does not skip this
confirmation, and there is no "fixes run without asking" (Section 3).

Then a fire with something to do surfaces a **proposal** in the session:

```
PR #123 — 2 failing checks, 1 trusted review thread since the last round.
Fix them in your checkout?  [Fix it] [Not now] [Stop watching]
```

- **Fix it** → one foreground round as v1 (fix agent under the approval
  mode, push, reply), then the gate cursor advances past what it addressed.
- **Not now** → the round ends having edited nothing; the events stay
  pending and the next fire proposes them again.
- **Stop watching** → `cleanup` (keeps the checkout and branch) and the task
  is deleted.

A fire with nothing to do asks nothing and ends silently. A dirty or
diverged checkout at fire time stops and asks as v1, regardless of the
proposal answer.

## 5. Design decisions

1. **A scheduled in-place round is a proposal, not an autonomous round.**
   The fire runs the read-only/safe prefix (gate, `sync` of a clean
   checkout, `snapshot`), then asks before the fix agent runs. The fix
   agent never starts without a "Fix it" answer. This is the single rule
   that reconciles "fires on a schedule" with "the user's checkout is never
   edited without a person deciding".
2. **Two-layer consent.** A standing schedule consent at the start (the
   confirmation in Section 4) plus a per-round approval before any edit.
   Neither is skippable by `--yes`; neither offers an unattended option.
   The standing consent is what makes the watch a watch; the per-round
   approval is what keeps each edit attended.
3. **The gate cursor advances only on addressing, not on proposing.** A
   worktree gate commits its cursor when it reports events, because the
   round it starts will address them. An in-place round may be declined, so
   its gate reports pending events **without** committing the cursor; the
   cursor advances only after the round pushes/replies (or the user
   dismisses the events). A declined round therefore re-proposes the same
   events at the next fire instead of losing them.
4. **A safe fast-forward still runs; only editing asks.** `sync` of a clean,
   fast-forwardable checkout proceeds at fire time as in v1 — it loses no
   work and keeps the branch current. The proposal gates the fix agent's
   edits, not the fast-forward. A dirty or diverged checkout refuses and
   asks as v1 (decision 5 of v1 unchanged).
5. **No answer is a decline.** A proposal that goes unanswered within a
   bounded wait ends the round having edited nothing, with its events
   pending. The watch never edits because the user was away. The exact
   notification-and-timeout mechanism is an open question (Section 12).
6. **The task is durable and session-bound, as worktree mode's.** A
   scheduled in-place watch needs a daemon task that keeps its session
   resident (`durable`, `sessionMode: "current"`), because the round must
   reach the user to ask. A terminal session's in-place watch lives only as
   long as the session, as a worktree watch does there.

## 6. Proposed changes

### 6.1 `schedule` and the watch state

- `runSchedule` stops refusing an in-place watch. Instead it records a watch
  whose options mark it scheduled-in-place; `scheduledTask` prints a gate
  and prompt for the proposal round (the prompt invokes the skill's
  scheduled-in-place round, not the autonomous `tick`). The
  `authorCanPush !== true` refusal stays: such a PR is never watched.
- `AutofixPrWatchOptions` carries the scheduled-in-place mode (a field, or
  the existing `inPlace` state flag read together with `watch`); old state
  files read unchanged. `fix-start` keeps refusing in-place (no background
  fix).
- The gate cursor for an in-place watch follows decision 3: report pending,
  commit on addressing.

### 6.2 The gate (`snapshot --gate`)

- For an in-place watch the gate reports the events newer than the cursor
  (failing checks, trusted review feedback) **without** advancing the
  cursor. It still names the session and task, so a stale task stops at its
  next fire (command design). A quiet PR prints nothing and costs no turn.
- The cursor advances when the round reports it addressed the events (after
  push/reply), or when the user dismisses them. The exact helper that
  commits the cursor is an implementation detail; the invariant is decision 3.

### 6.3 The skill (`SKILL.md`)

- A start giving `--in-place --every <n>` is no longer refused; it runs the
  scheduled-in-place start (Section 4 confirmation, then `schedule`, then
  the durable task). `--in-place` without `--every` stays v1's once shape.
- A new "Scheduled in-place round" path: run the gate; if it reports
  nothing, end silently; otherwise run `sync` (clean fast-forward, or
  refuse-and-ask for dirty/diverged) and `snapshot`, write the brief, and
  **ask** (Section 4 proposal) before launching the fix agent. On "Fix it"
  run the foreground fix and the rest of v1's round (push, reply), then
  commit the gate cursor; on "Not now"/timeout end with nothing edited and
  the cursor untouched; on "Stop watching" clean up and delete the task.
- The in-place confirmation, brief variant, and `## Never` list carry over
  from v1 unchanged; the scheduled round adds the proposal step and the
  cursor-on-addressing rule.

### 6.4 The `autofix_pr` tool (core)

- `schedule` is allowed for an in-place watch (it currently refuses);
  `unattended` keeps refusing in-place. The confirmed-watch record and reply
  plan placement stay as v1 (plan in `<checkout>/.qwen/tmp`).

### 6.5 `status`, `stop`, `resume`

- `status` lists a scheduled in-place watch with `inPlace: true` and its
  task; `worktreeWork` is the user's checkout's work, reported as v1.
- `stop` cleans up (keeps checkout/branch) and deletes the task.
- `resume` re-creates the durable task in this session with the recorded
  options, as a worktree watch; a leftover once-shaped in-place state is
  still `cleanup`'d (v1).

## 7. Trust model

The exposure is v1 in-place's (v1 Section 7): the fix agent runs the PR's
code in the user's checkout, with the user's credentials in reach, in an
attended session. The schedule does not widen it, because no edit happens
without a per-round approval (decision 1): a fire that catches the user
away proposes and then defers, it does not edit. The standing schedule
consent is consent to be asked on a schedule, not consent to edit
unattended. Everything else — PR content as data, trusted-author sorting,
the brief's `## Never` list, the push lease, fast-forward-only, default-branch
refusal, push budget — carries over from v1 and the command design unchanged.

## 8. Affected files

- `packages/cli/src/commands/autofix-pr/schedule.ts` — allow scheduling an
  in-place watch; the proposal-round gate/prompt.
- `packages/cli/src/commands/autofix-pr/state.ts` — scheduled-in-place watch
  options; cursor-on-addressing.
- `packages/cli/src/commands/autofix-pr/snapshot.ts` (gate) — report pending
  without committing the cursor for an in-place watch.
- `packages/cli/src/commands/autofix-pr/fix.ts` — unchanged (in-place still
  refuses a background fix).
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` — Section 4 start,
  the scheduled-in-place round, status/stop/resume.
- `packages/core/src/tools/autofix-pr.ts` — `schedule` allowed for in-place;
  `unattended` still refused.
- Collocated tests for each; this design pair; an E2E test plan under
  `.qwen/e2e-tests/`.

## 9. Constraints and risks

- **Two writers, one tree, on a timer.** The user may be editing when a fire
  arrives. The clean-checkout fast-forward and the dirty/diverged refusal
  (v1) handle the tree state; the per-round approval handles the edit. A
  user who edits during an approved foreground fix can still make a messy
  commit; the brief still requires staging only the agent's own files by
  name (v1 Section 9).
- **Nagging.** A declined round re-proposes the same events every interval
  (decision 3). v1 of this follow-up accepts that: the user answers "Not
  now" to defer or "Stop watching" to end. A snooze interval is an open
  question (Section 12).
- **Reachability.** The proposal must reach the user. A durable,
  session-bound daemon task keeps the session resident; a terminal session
  that ends takes its task with it (as worktree mode). The bounded-wait
  mechanism for an away user is an open question.
- **Gate cost.** The gate stays model-free and cheap; only a fire with
  pending events spends a turn (the proposal). A quiet scheduled in-place
  watch costs no more than a quiet worktree watch.

## 10. Validation plan

Unit tests (collocated, vitest):

- `schedule`: an in-place watch schedules (task printed, durable in a daemon
  session); `authorCanPush: false` still refused; old state reads unchanged.
- gate: an in-place gate reports pending events without advancing the
  cursor; the cursor advances on addressing; a quiet gate prints nothing.
- `fix-start`: in-place still refuses a background fix.
- tool: `schedule` allowed for in-place; `unattended` still refused.
- Regression: every worktree-mode test passes unchanged.

E2E (plan under `.qwen/e2e-tests/`): a scheduled in-place watch on a scratch
PR; a fire with a failing check proposes and waits; "Not now" edits nothing
and the next fire re-proposes; "Fix it" runs a foreground round, pushes,
replies, and advances the cursor; a dirty checkout at fire time refuses and
asks; "Stop watching" keeps the checkout and branch and deletes the task;
worktree mode on the same PR afterwards behaves exactly as before.

## 11. Acceptance criteria

1. `/autofix-pr <n> --in-place --every <n>` starts a scheduled in-place watch
   with a durable, session-bound task; the confirmation says rounds ask
   before editing; `--yes` does not skip it.
2. A fire with pending events asks before the fix agent runs; no edit
   happens without a "Fix it" answer.
3. "Not now" or an unanswered proposal edits nothing, keeps the events
   pending, and the next fire re-proposes them.
4. "Fix it" runs a foreground round under the approval mode, pushes, replies,
   and advances the gate cursor past what it addressed.
5. A dirty or diverged checkout at fire time stops and asks; nothing is
   discarded; the user's work survives byte for byte.
6. No background fix and no `unattended` grant for an in-place watch.
7. Every existing worktree-mode unit test passes unchanged.
8. "Stop watching", a merged/closed PR, or the push budget ends the watch
   with `cleanup` keeping the checkout and branch and deleting the task.
9. This design pair and the SKILL.md change ship in the same PR.

## 12. Open questions

1. **The bounded-wait proposal mechanism.** A blocking `ask_user_question`
   turn cannot wait forever for an away user. Does the daemon scheduler
   support a notification the user answers later, or a turn timeout after
   which the round defers? This needs a daemon-scheduler investigation
   before implementation; the invariant (no answer → no edit, events
   pending) is fixed, the mechanism is not.
2. **Nagging control.** Re-propose every interval (this proposal) versus a
   snooze ("ask again in an hour"). v1 of this follow-up re-proposes; a
   snooze option is a later refinement.
3. **Does the clean fast-forward also ask?** This proposal lets `sync`
   fast-forward a clean checkout at fire time without asking (decision 4),
   reserving the ask for edits. If users prefer the branch not to move while
   they are away, the fast-forward could be gated by the same proposal; v1
   of this follow-up keeps v1's safe fast-forward.
