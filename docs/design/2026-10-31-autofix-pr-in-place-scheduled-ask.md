# `/autofix-pr --in-place --watch`: scheduled rounds that ask before editing

[English](2026-10-31-autofix-pr-in-place-scheduled-ask.md) | [简体中文](2026-10-31-autofix-pr-in-place-scheduled-ask.zh-CN.md)

Status: implemented. Date: 2026-10-31 (updated 2026-11-27).

This design extends [`/autofix-pr --in-place`](2026-10-30-autofix-pr-in-place-copilot.md)
(the "v1 in-place design", merged in #15929) with the follow-up its Section 12
open question 1 left open: scheduled in-place rounds that ask the user before
they edit, enabled via `--in-place --watch` (or `--in-place --every <n>`).
Section numbers below that cite the "command design" refer to
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
worktree mode, but each scheduled round asks the user before it edits the
checkout, like v1 in-place. v1 deliberately left this out (v1 Section 5
decision 1: "the two contracts are not mixed in v1"); this design is that
follow-up.

## 2. Prior state (before this change)

Before this change (`packages/cli/src/commands/autofix-pr/`,
`packages/core/src/skills/bundled/autofix-pr/SKILL.md`):

- `schedule` refused an in-place watch (`state.inPlace` → "its rounds run
  only when you ask … there is no scheduled task"); `fix-start` refused it
  too ("its fixes run in the foreground … never in the background"). The
  skill stopped a start that gave both `--every` and `--in-place` before
  running `prepare`.
- `prepare --in-place` rejected any existing watch of the PR (even an
  in-place watch in the same checkout), so `resume` and `--take-over` did
  not apply to in-place watches.
- A worktree watch's scheduled task (`scheduledTask`) is a cron expression,
  a **gate** (`autofix-pr snapshot <n> --gate --session <id> --task <id>`)
  that runs without the model and prints only what changed since the gate
  cursor, and a **prompt** (`Run /autofix-pr tick <repo>#<n> …`) delivered
  to the session as a turn when the gate reports something to do. A daemon
  session's task is `durable` and bound to the session (`sessionMode:
"current"`), so the daemon keeps the session resident and reloads the task
  after a restart.
- The gate advances its cursor when it reports events; the round reads
  full unhandled state from `snapshot` (which compares against `state.json`,
  not `gate.json`). A quiet PR costs no turn.
- v1 in-place's round: `sync` fast-forwards a clean checkout (the co-driving
  benefit) and answers `synced: false` for a dirty or diverged one; the fix
  agent runs in the foreground in the checkout; every path that would
  discard stops and asks; the round's end runs `cleanup`, which removes only
  the watch's files.

None of this changes for worktree mode.

## 3. Goals and non-goals

Goals:

- Add `--watch` to `/autofix-pr`:
  - `--in-place --watch` starts a scheduled in-place watch (default interval
    2 minutes, optional `--every <n>`).
  - `--in-place --every <n>` implies `--watch`.
  - `--in-place` alone (or `--in-place --once`) preserves v1's one-shot
    behavior.
  - In worktree mode (no `--in-place`), `--watch` is accepted as an
    explicit synonym of the default watch; `--once` with `--watch` or
    `--every` is refused before `prepare`.
- Every scheduled or resumed in-place round **asks the user before the fix
  agent edits the checkout** (`Fix it` / `Not now` / `Stop watching`), and
  edits nothing without an explicit `"Fix it"` answer.
- A fire that finds nothing to do costs no turn and asks nothing (the gate
  stays cheap, as in worktree mode).
- Waiting for an answer or choosing `"Not now"` never stacks duplicate
  prompts in the session's cron queue and never re-nags every interval,
  while leaving `state.json` untouched so still-unhandled items surface
  again on the next new PR event or on a manual `/autofix-pr <n> --in-place`.
- `resume` and `--take-over` work for scheduled in-place watches in the
  same checkout (without ever converting between worktree and in-place
  modes).
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

```text
# Session at the checkout root, on the PR head branch, clean
/autofix-pr 123 --in-place --watch
/autofix-pr 123 --in-place --watch --every 5
/autofix-pr 123 --in-place --every 5        # implies --watch
/autofix-pr 123 --in-place                  # one-shot (unchanged v1)
/autofix-pr 123 --watch                     # explicit synonym of default worktree watch
```

The scheduled in-place start confirmation says:

- the fix agent works in this checkout, in the foreground, under the
  session's approval mode, and the user may edit alongside it;
- it runs one immediate attended round now, then schedules a check every
  `<every>` minutes (durable and bound to this conversation in a daemon
  session); **every scheduled round asks before editing** (`Fix it` /
  `Not now` / `Stop watching`), and edits nothing without a `"Fix it"`
  answer;
- rounds push what the branch holds on top of the PR head — including the
  user's own commits made between sync and push — and reply on the PR (not
  with `--no-reply`), under the user's git and `gh` identity;
- nothing is ever discarded automatically: a dirty or diverged checkout
  stops the round and asks;
- choosing `"Not now"` edits nothing and leaves the watch quiet until a new
  PR event arrives (or the user runs `/autofix-pr <n> --in-place`), when any
  still-unhandled items are offered again; `/autofix-pr stop 123` (or
  `"Stop watching"`) ends the watch, keeping the checkout, the branch and
  the history.

The options are `"Start"` and `"Cancel"` only — `--yes` does not skip this
confirmation, and there is no `"fixes run without asking"` (Section 3).

When a scheduled fire (or a `/autofix-pr resume` round) finds something to
do, it surfaces a **proposal** via `ask_user_question`:

```text
PR #123 — 2 failing checks, 1 trusted review thread.
Fix them in your checkout?  [Fix it] [Not now] [Stop watching]
```

- **Fix it** → one foreground round as v1 (fix agent under the approval
  mode, verify, `sync`, `push`, `reply`).
- **Not now** → edits nothing, pushes nothing, posts nothing, runs no
  `rerun`, and leaves `state.json` untouched so those items stay unhandled
  for the next new PR event or a manual `/autofix-pr 123 --in-place`.
- **Stop watching** → `cleanup` (keeps the checkout and branch) and deletes
  the scheduled task.

A fire with nothing to do asks nothing and ends silently. A dirty or
diverged checkout at fire time stops and asks as v1, regardless of the
proposal answer.

## 5. Design decisions

1. **A scheduled in-place round is a proposal, not an autonomous round.**
   The fire runs the read-only/safe prefix (gate, `sync` of a clean
   checkout, `snapshot`, `ci-log`), then asks via `ask_user_question` before
   writing the brief, launching the fix agent, re-running CI, pushing, or
   replying. No edit happens on a scheduled or resumed fire without a
   `"Fix it"` answer.
2. **Two-layer consent.** A standing schedule consent at the start (the
   confirmation in Section 4) plus a per-round approval before any edit on
   scheduled and resumed rounds. Neither is skippable by `--yes`; neither
   offers an unattended option.
3. **Reuse the advancing gate cursor (no queue stacking, no re-nagging).**
   The original 2026-10-31 draft proposed leaving the gate cursor
   unadvanced until the round addressed its events. Code inspection of
   `packages/cli/src/acp-integration/session/Session.ts` (`#enqueueCronPrompt`)
   and daemon `permissionResponseTimeoutMs` (default `0`, wait for human)
   showed that an unadvanced cursor would re-emit the same events on every
   `--every` tick while `ask_user_question` is open — stacking duplicate
   ticks in `cronQueue` — and would nag the user again every 2 minutes after
   `"Not now"`.

   Instead, scheduled in-place reuses `snapshot --gate`'s existing advancing
   cursor unchanged:
   - Each new PR transition triggers **one** proposal and advances
     `gate.json`, so subsequent ticks while waiting for the user (or after
     `"Not now"`) stay completely quiet with zero queue stacking.
   - Because prepared `snapshot` compares GitHub against `state.json`
     (never `gate.json`), choosing `"Not now"` leaves those items unhandled
     in `state.json`. The next time any new PR event arrives, or whenever
     the user manually runs `/autofix-pr <n> --in-place` (which reuses the
     existing in-place watch without cleaning it up), every still-unhandled
     item is surfaced again automatically.

4. **A safe fast-forward still runs; only editing asks.** `sync` of a clean,
   fast-forwardable checkout proceeds at fire time as in v1 — it loses no
   work and keeps the branch current. A dirty or diverged checkout refuses
   and asks as v1 (decision 5 of v1 unchanged).
5. **Same-checkout resume and take-over for in-place watches.** `prepare
--in-place` resumes an existing in-place watch owned by this session in
   the same checkout (and takes over from another session with
   `--take-over`), preserving recorded watch options, history and budgets
   without touching dirty or ahead work in the checkout. Worktree watches,
   other repositories, and other checkouts are still refused — modes are
   never converted silently.
6. **The task is durable and session-bound, as worktree mode's, and reuses
   the `tick` prompt shape.** `scheduledTask` emits
   `Run /autofix-pr tick <repo>#<n> --task <id> --in-place ...`, which
   automatically integrates with Web Shell's PR Watches page, Scheduled
   Tasks dialog (`parseAutofixPrTick`), and daemon PR watch detection
   (`session-pr-watches.ts`), while explicitly signaling `--in-place` to the
   round.

## 6. Changes

### 6.1 `schedule` (`packages/cli/src/commands/autofix-pr/schedule.ts`)

- Remove the `state.inPlace` refusal in `runSchedule`; `authorCanPush !==
true` continues to refuse (non-collaborator PRs are never watched in
  either mode).
- Include `--in-place` in `scheduledTask`'s `prompt` when `state.inPlace`
  is true: `Run /autofix-pr tick <repo>#<n> --task <id> --in-place ...`.
- Update the `--again` error message when no task is recorded to point
  in-place watches at `/autofix-pr <n> --in-place --watch`.

### 6.2 `prepare` (`packages/cli/src/commands/autofix-pr/prepare.ts`)

- Allow `runInPlacePrepare` to resume an existing in-place watch in the
  same checkout (and take it over with `--take-over` from another session),
  re-checking PR eligibility (`pr_closed` if merged/closed), `authorCanPush`,
  remotes, head branch, and upstream tracking, fetching into `paths.headRef`
  so `localCopy` reports accurately, and leaving any dirty/ahead work in
  the checkout untouched for `sync` to handle.
- Continue refusing: existing worktree watch (no silent mode conversion),
  different repository, different checkout, and another session's watch
  without `--take-over` (`watched_elsewhere`).
- Fresh `prepare --in-place` keeps every v1 precondition (clean checkout,
  at or behind PR head).

### 6.3 The `autofix_pr` tool (`packages/core/src/tools/autofix-pr.ts`)

- Update `startsWatchWarning` for `prepare --in-place --take-over` so
  take-over confirmations accurately describe taking over an in-place watch.
- Update the `in_place` parameter description; `schedule` already works on
  a confirmed in-place watch, while `checkUnattendedWatch` keeps refusing
  `unattended` for `watch.inPlace === true`.

### 6.4 The skill (`packages/core/src/skills/bundled/autofix-pr/SKILL.md`)

- Add `--watch` to frontmatter, arguments, and conflict checks (`--once`
  with `--watch` or `--every` stops before `prepare`; `--in-place --every`
  implies `--watch`; worktree `--watch` is an explicit synonym).
- Update Start steps 3–8, Round steps 1 & 8, Section "In-place", and
  Section "Resume" so:
  - one-shot `--in-place` keeps v1 behavior (no task, cleanup at round end
    only when this start created the watch);
  - scheduled `--in-place --watch` schedules the task, passes `--task`,
    asks `Fix it` / `Not now` / `Stop watching` before editing on scheduled
    and resumed rounds, never discards, never runs unattended/background,
    and cleans up only on stop / push budget / `"Stop watching"`;
  - `resume` handles scheduled `inPlace: true` watches using `prepare
--in-place --take-over` and `schedule --again`, without ever offering
    or calling `unattended`.

### 6.5 Gate, `fix-start`, Web Shell, docs

- `snapshot.ts --gate`: unchanged — reuses the advancing cursor and
  session/task ownership checks for in-place watches.
- `fix.ts`: unchanged — `fix-start` still refuses `state.inPlace`.
- `packages/web-shell/client/utils/autofixPrWatches.ts`: already parses
  `Run /autofix-pr tick <repo>#<n> --task <id> --in-place ...`; pinned by
  a new unit test in `autofixPrWatches.test.ts`.
- `docs/users/features/autofix-pr.md`: documents `--watch`, `--in-place`,
  and `--in-place --watch`.

## 7. Trust model

The exposure is v1 in-place's (v1 Section 7): the fix agent runs the PR's
code in the user's checkout, with the user's credentials in reach, in an
attended session. The schedule does not widen it, because no edit happens
on a scheduled or resumed fire without a per-round `"Fix it"` approval
(decision 1): a fire that catches the user away waits on
`ask_user_question` and never edits autonomously. Non-collaborator PRs
(`authorCanPush: false`) remain refused for scheduling. Everything else —
PR content as data, trusted-author sorting, the brief's `## Never` list,
the push lease, fast-forward-only, default-branch refusal, push budget —
carries over from v1 and the command design unchanged.

## 8. Affected files

- `packages/cli/src/commands/autofix-pr/schedule.ts` & `schedule.test.ts`
- `packages/cli/src/commands/autofix-pr/prepare.ts` & `prepare.test.ts`
- `packages/cli/src/commands/autofix-pr/chain.integration.test.ts`
- `packages/core/src/tools/autofix-pr.ts` & `autofix-pr.test.ts`
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` & `SKILL.test.ts`
- `packages/web-shell/client/utils/autofixPrWatches.test.ts`
- `docs/users/features/autofix-pr.md`
- `docs/design/2026-10-31-autofix-pr-in-place-scheduled-ask.{md,zh-CN.md}`

## 9. Constraints and risks

- **Two writers, one tree, on a timer.** The user may be editing when a fire
  arrives. The clean-checkout fast-forward and the dirty/diverged refusal
  (v1) handle the tree state; the per-round approval handles the edit. A
  user who edits during an approved foreground fix can still make a messy
  commit; the brief still requires staging only the agent's own files by
  name (v1 Section 9).
- **Deferred items wait for a new event or manual trigger.** Because the
  gate cursor advances on proposal (decision 3), choosing `"Not now"` stays
  quiet until another PR event occurs or the user runs
  `/autofix-pr <n> --in-place`. This intentionally trades automatic
  re-nagging for zero queue stacking and zero repeated interruptions.
- **Reachability.** A durable, session-bound daemon task keeps the session
  resident; a terminal session that ends takes its task with it (as
  worktree mode), and `/autofix-pr resume <n>` re-attaches it.
- **Gate cost.** The gate stays model-free and cheap; only a fire with a
  new transition spends a turn.

## 10. Validation plan

Unit and integration tests (vitest):

- `schedule.test.ts`: in-place watch schedules with `--in-place` in the
  tick prompt and `durable`/`sessionMode` in a daemon session; `--again`
  preserves `--in-place` and options under a new task id; `--again` without
  a recorded task names `--in-place --watch`; `authorCanPush: false` still
  refused.
- `prepare.test.ts`: resuming an existing in-place watch preserves options
  and history without touching dirty/ahead work; another session is refused
  with `watched_elsewhere` and taken over with `--take-over`; closed PRs
  refuse with `pr_closed`; worktree watches, other repos and other
  checkouts stay refused.
- `chain.integration.test.ts`: full helper chain for a scheduled in-place
  watch (`prepare --in-place` → `schedule` → `sync`/`snapshot`/`push`/
  `reply` with `--task` → gate quiet on handled, fires once on new comment
  without re-nagging while `snapshot` keeps the unhandled comment →
  take-over resume via `prepare --in-place --take-over` + `schedule --again`
  → `cleanup` keeping checkout and branch).
- `autofix-pr.test.ts`: `prepare --in-place --take-over` warning;
  `schedule` allowed on an in-place watch while `unattended` stays refused.
- `SKILL.test.ts`: `--watch`, `--once` conflicts, `--in-place --watch` /
  `--in-place --every`, per-round `ask_user_question` proposal, `resume`
  with `--in-place` and no `unattended`, no `--discard`.
- `autofixPrWatches.test.ts`: `parseAutofixPrTick` parses `--in-place`
  tick prompts.
- Regression: `npm run build && npm run typecheck` plus every existing
  `autofix-pr` test passing unchanged.

## 11. Acceptance criteria

1. `/autofix-pr <n> --in-place --watch` (and `--in-place --every <n>`)
   starts a scheduled in-place watch with a durable, session-bound task in
   daemon sessions; the confirmation says scheduled rounds ask before
   editing; `--yes` does not skip it.
2. `/autofix-pr <n> --in-place` without `--watch` or `--every` preserves
   v1's one-shot behavior; `/autofix-pr <n> --watch` is accepted as an
   explicit synonym in worktree mode; `--once` with `--watch` or `--every`
   is refused before `prepare`.
3. A scheduled or resumed in-place round with actionable events asks
   (`Fix it` / `Not now` / `Stop watching`) before the fix agent runs; no
   edit happens without a `"Fix it"` answer.
4. `"Not now"` edits nothing and leaves `state.json` untouched; the
   advancing gate cursor prevents duplicate cron-queue stacking and
   repeated nagging, while still-unhandled items reappear on the next new
   PR event or a manual `/autofix-pr <n> --in-place`.
5. `"Fix it"` runs a foreground round under the approval mode, pushes, and
   replies.
6. A dirty or diverged checkout at fire time stops and asks; nothing is
   discarded; the user's work survives byte for byte.
7. No background fix and no `unattended` grant for an in-place watch.
8. `/autofix-pr resume` restores a scheduled in-place watch via `prepare
--in-place --take-over` and `schedule --again`, without offering
   unattended fixes.
9. `"Stop watching"`, `/autofix-pr stop <n>`, a merged/closed PR, or the
   push budget ends the watch with `cleanup` keeping the checkout and
   branch and deleting the task.
10. Every existing worktree-mode test passes unchanged; both language
    versions of this design doc and `SKILL.md` ship together.

## 12. Resolved open questions

1. **Wait behavior for an away user (resolved via decision 3).** Because
   the gate advances its cursor on report, an open `ask_user_question`
   proposal never causes subsequent ticks to stack duplicate prompts into
   `cronQueue`, and never edits while the user is away.
2. **Nagging control (resolved via decision 3).** Advancing the gate cursor
   on proposal eliminates every-interval re-nagging after `"Not now"`,
   while `state.json` retains the unhandled items for the next PR event or
   manual `/autofix-pr <n> --in-place`.
3. **Clean fast-forward at fire time (resolved: kept as v1).** `sync` still
   fast-forwards a clean checkout without asking; only editing asks, and a
   dirty or diverged checkout stops and asks.
