---
title: 'Sub-Session Completion TTL'
date: '2026-10-16'
status: 'implemented'
---

# Sub-Session Completion TTL

[English](subsession-completion-ttl.md) | [简体中文](subsession-completion-ttl.zh-CN.md)

## Problem

`create_sub_session` spawns background sub-sessions that the caller does not
watch. Every finished sub-session keeps a live bridge entry and a persisted
transcript row, so the daemon's session roster grows without bound and
finished, uncontinuable sub-sessions accumulate on disk forever. The issue
([QwenLM/qwen-code#14289](https://github.com/QwenLM/qwen-code/issues/14289))
asks for an opt-in automatic cleanup of completed sub-sessions.

## Goals

- Provide a daemon setting that removes finished sub-sessions after a
  configurable retention window, keeping the default behavior unchanged.
- Never remove a sub-session that is running, cancelled work in progress, or
  whose transcript the user wants to keep (archived rows, failed/cancelled
  turns kept for diagnosis).
- Survive daemon restarts: previously completed sub-sessions must not escape
  retention forever because the completion clock was process-local.
- Keep the implementation small and contained in the sub-session launcher
  layer.

## Non-Goals

- No per-session retention policy and no user-visible "keep this
  sub-session" flag; archiving or deleting the transcript is the existing
  keep-forever lever.
- No new persistence format; removal reuses `SessionService.removeSession`.
- No backfill of stop reasons for transcripts written before this change.

## Design

### Setting

`serve.subSessionCompletionTtlHours` (integer, hours, minimum `0`,
`requiresRestart: true`). The default is `0`: auto-removal is opt-in and the
built-in default keeps completed sub-sessions forever, preserving the
pre-feature behavior bit for bit (no completion marking, no sweeper
interval). Non-negative integers are honored; anything else produces a
warning and falls back to the default (shared contract with the
`serve.maxConcurrentSubSessions*` settings via one integer-settings helper).

### Which completions arm the clock

Only a clean turn end (`stopReason === 'end_turn'`) records a completion
timestamp. Turns that failed, were cancelled, or ended for other non-clean
reasons are never removal candidates: their transcripts are diagnostic
records the user should be able to inspect, so they are kept until the user
archives or deletes them. The three observer-side stop reasons
(`timeout`, `incomplete`, `shutdown`) mean "the watcher stopped seeing the
turn", not "the turn ended badly" — they stay non-terminal for the clock,
and a sub-session whose live entry the idle reaper then closed is still
provable-terminal (the reaper only closes work-free sessions) and is armed
from its persisted last write instead.

### Sweep and candidate set

The launcher runs one sweeper `setInterval` (fixed 5-minute cadence,
`unref`, serialized with an in-flight flag). Removal candidates are the
completion clocks (`completedAt`) plus any tracked roster id that never got a
clock. The sweep iterates the clocks rather than the roster set, so a
completed id that the roster's FIFO cap (1024) evicted is never lost — its
transcript cannot outlive retention because of an unrelated eviction.

A live entry is removable only when it is free of work: an admitted prompt,
running background tasks, or an active work state each keep the transcript.
A post-completion `send_message` revival (a new admitted prompt) restarts
the clock from the fresh activity. A live row the user archived in the
meantime drops out of the candidate set.

### Removal and terminal state

Removal runs under the session's exclusive lifecycle lane — the
`SessionArchiveCoordinator` guard that archive, delete, and restore take and
prompt admission shares. A lane already held (an in-flight prompt admission,
an archive or delete) refuses the removal and the clock stays armed for the
next sweep; while the removal holds it, no prompt can be admitted. Under the
lane the removal re-decides "still terminal and inactive" (work state,
archive state, and activity newer than the clock, which restarts it), then
closes the live entry with no await in between (tolerating
`SessionNotFoundError` — the idle reaper usually wins that race),
re-validates that no revival re-created the entry immediately before the
persisted mutation, removes the transcript via
`SessionService.removeSession` (resolved under the launcher's runtime base
dir so the removed row is the one the disk-scan listing reads), and prints
the operator line only when a transcript was actually removed. Once the live
entry is confirmed gone and the transcript is gone, the id leaves both the
completion clock and the roster set — terminal state — so later sweeps
cannot re-process it and cannot re-print the removal. Any failure before
that point keeps the clock armed and the next sweep retries. The depth-1
spawn gate remains safe: its durable fallback (`caller.parentSessionId !==
undefined`) covers restored children, and a removed session cannot be a live
caller.

### Discovery after a restart

The completion clocks are process-local, so a daemon restart would orphan
every previously completed sub-session transcript. To bound that, the first
sweep performs a one-time disk discovery: it enumerates the active session
files exhaustively (`SessionService.listAllProjectSessionIds`,
`archiveState: 'active'` — not the paged `listSessions`, whose strict
`mtime < cursor` filter silently skips rows that share an mtime with a
page's last entry) and re-arms the rows it can prove finished: the persisted
creation metadata names a `parentSessionId` (such a row is a sub-session,
never a primary session), and the transcript's last persisted turn result
(`turn_result` record, appended at turn settle) is a clean completion
(`completed`/`end_turn`). A failed or cancelled turn keeps its diagnostic
transcript, and a transcript without a readable turn result is
unclassifiable, so it stays with the user. An armed row's clock starts at
the transcript's `mtime`. Discovered rows are seeded into the completion
clock only, never into the roster set whose depth-1 gate must count only the
live roster. A scan failure re-arms the discovery for the next sweep.

## Design decisions and rationale

- **Opt-in default (`0`).** The issue triage and maintainer ruling are
  explicit that auto-deletion of session data must not be the default.
- **In-launcher durability via discovery, not a layer move.** The policy
  owner stays in the sub-session launcher; a one-time disk scan gives the
  retention owner the ability to rediscover eligible transcripts after a
  restart. Moving the policy into `SessionService` housekeeping would
  couple the daemon's in-memory lifecycle to a daily file-retention pass and
  cannot honor sub-day TTLs (see Open questions).
- **Allowlist, not denylist, for terminal completions.** Deleting a
  transcript is destructive; the safe default is to delete only what is
  provably a clean completion and keep everything diagnostic.
- **Candidate set = completion clocks.** Decoupling the retention clock from
  the roster's FIFO cap removes the class of "evicted but not expired"
  transcripts that would otherwise persist forever.

## Constraints and risks

- Eligibility and mutation are one decision under the session's exclusive
  lifecycle lane, so prompt admission through the serve routes cannot
  revive a session between the check and the close/delete. A revival path
  that bypasses the lane is still caught by the post-close re-validation
  before the transcript is deleted.
- Discovery runs once per launcher lifetime; transcripts completed during
  the current process lifetime are tracked in memory and do not need
  re-scanning.
- The `nonCleanTerminal` bookkeeping set is bounded by the number of
  observed failed/cancelled turns per process lifetime and is never pruned
  (documented, in-memory only).

## Validation plan

- Unit/integration tests in `packages/cli/src/serve/create-sub-session.test.ts`
  (fake timers, 5-minute sweep cadence, per-test `mkdtemp` workspaces and a
  real transcript fixture for the discovery path) covering: clean-completion
  removal, second-sweep no-op (terminal state), discovery of a persisted
  completed transcript in a fresh launcher, exhaustive discovery of an
  mtime-tied batch (the old paged cursor's skip class), failed/cancelled and
  unclassifiable transcript retention after a restart, revival restart,
  work-state guards, removal retry after close/removal failure,
  serialization of overlapping sweeps, the lifecycle lane (deferral while
  it is held, admission refused mid-removal, the in-lane re-check),
  FIFO-eviction retention, and the
  sent-mode completion path.
- Settings tests pin the schema default (`0`), the reader's warning
  contract, and the absent-key no-op.
- `tsc --noEmit` and `eslint` on the touched files.

## Acceptance criteria

- With the default settings, behavior is identical to pre-feature: no
  sub-session is ever removed, no sweeper is installed.
- With a positive TTL, a sub-session that completed with a clean turn end
  is removed (live entry closed, transcript removed, one operator line)
  after the TTL elapses, and never removed before it; a revival restarts the
  clock; failed/cancelled sub-sessions are never removed; a daemon restart
  does not orphan previously completed transcripts — the restart path reaps
  only rows whose last persisted turn result is a clean completion, and
  failed, cancelled, or unclassifiable rows are kept.

## Open questions

- Long-term ownership: should retention eventually move to the persisted
  session lifecycle (`SessionService` housekeeping, next to file-history
  retention) so that no daemon-side timer is needed at all? The in-launcher
  sweeper with one-time discovery is the smaller step this PR takes; a
  housekeeping pass is a candidate follow-up (H4b handoff).
