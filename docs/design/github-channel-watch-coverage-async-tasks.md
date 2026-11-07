# GitHub Channel: Watch Coverage and Non-Blocking Task Execution

[English](github-channel-watch-coverage-async-tasks.md) | [简体中文](github-channel-watch-coverage-async-tasks.zh-CN.md)

Status: implemented and verified (2026-11-06); see
`.qwen/e2e-tests/github-channel-watch-coverage-async-tasks.md` for the
baseline dry-run, the local-build E2E results, and the mutation witnesses.

## Problem statement

The GitHub channel's bound-session delivery (`deliverToBoundSessions` +
`prWatchEvents`) is unreliable on a daemon with many PR bindings. Two
independent defects, both observed live on a production daemon running
0.26.8 with 315 session bindings (242 active watch candidates, ~94 open-PR
bindings):

1. **Watch starvation.** The PR state watch polls at most
   `MAX_WATCHED_PRS = 30` bound PRs per pass, selected purely by binding
   `updatedAt` recency (`GithubAdapter.ts`, `runPrStateWatch`). Every other
   bound PR is never polled, so `head_change` / `ci_failure` /
   `merge_conflict` / `state_change` events for it are never detected. The
   daemon logs `PR watch cap exceeded: watching 30/242 bound PRs` on every
   poll. Two effects compound:
   - Open PRs with older bindings are crowded out by newer bindings,
     including bindings of PRs that are already merged.
   - A PR whose binding records `merged`/`closed` stays in the active set
     until the watch itself observes the terminal transition. If the cap
     excludes it, that observation never happens, so it occupies an active
     slot forever. The active set grows monotonically with dead PRs.
2. **Head-of-line blocking.** The poll loop is serial
   (`PollingChannelBase.runLoop` awaits `pollOnce`). Inside `pollOnce`,
   both fresh dispatch (`dispatchEnvelope` public branch) and recovery
   (`recoverInboundTasks`) await `runInboundTask`, whose public path
   (`handleInbound`) awaits the **entire agent turn** before the reply is
   published. A single `review_requested` on an unbound PR therefore
   freezes the whole channel — watch pass, bound deliveries, and every
   other notification — for the full turn duration (observed: 64 minutes).
   Bound delivery itself is fast (a prompt POST that does not wait for the
   turn); only the public path blocks.

## Goals

- Every open bound PR is watched whenever the configured watch budget
  allows it; terminal-pending PRs drain out of the active set instead of
  accumulating.
- The watch budget is operator-configurable within documented rate-limit
  trade-offs.
- A long public-path agent turn never blocks the poll loop: watch
  detection, bound delivery, and intake of new notifications continue
  while the turn runs.
- No change to delivery guarantees: at-least-once, durable claims before
  cursor advance, edge-triggered watch semantics, crash recovery, and
  backpressure budgets all behave exactly as today.

## Non-goals

- Parallel public turns (concurrency stays 1; ordering is preserved).
- Changing the notification-cursor contract: recoverable non-backpressure
  tasks still hold mark-as-read (`hasCursorBlockingTasks`), as today.
- Raising GitHub rate limits or adding conditional-request caching.
- Any change to bound-session delivery itself (fan-out, roles, templates).

## Proposed changes

### 1. Watch selection and budget (`packages/channels/github`)

- New channel config field `prWatchLimit`:
  - Descriptor: `kind: 'number'`, `exclusiveMinimum: 0`, `maximum` and
    `default` built from the adapter's exported `MAX_PR_WATCH_LIMIT` (500)
    and `DEFAULT_PR_WATCH_LIMIT` (30) so the form bound and the effective
    bound cannot drift; the description states the rate arithmetic (~60
    requests/hour per watched PR at the 60 s default; a 5000/hour PAT
    budget admits ~80 watched PRs, ~69 open while a terminal backlog
    drains at the 1.2x fan-out; over budget, every watch pass aborts).
  - Adapter: a `prWatchLimit` getter clamps like the existing
    `pollInterval` getter (invalid/unset → 30; fractional → rounded up;
    above 500 → clamped to 500). Hand-edited settings reach the getter
    unchecked by the descriptor, so the clamp is load-bearing and tested.
  - Validation: `validateBoundSessionConfig` rejects `prWatchLimit`
    without `deliverToBoundSessions: true`, with the sibling wording.
  - Web Shell: the field is registered in the editor's GitHub label map
    and bound-session panel, with both locale catalogues translated.
- `runPrStateWatch` partitions the active set:
  - **open**: binding state is neither `merged` nor `closed`, and the
    watch entry has not observed `prState === 'closed'` (a stale-open
    registry must not let an observed-closed PR hold an open-tier slot);
  - **terminal-pending**: everything else that still needs its terminal
    observation.
    Open PRs take the FULL budget (by `updatedAt` desc). Terminal-pending
    PRs drain in an ADDITIONAL slice outside it —
    `min(terminalCount, max(1, ceil(limit * 0.2)))`, plus any leftover
    open budget. Without the slice, `limit == openCount` would starve the
    drain forever and the active set would grow with every merge. An
    IN-budget reservation was tried and removed: it excludes up to
    `ceil(limit * 0.2)` open bindings while the backlog drains, and an
    edge event on an excluded binding inside that window is swallowed
    permanently — the very defect this design fixes. The additional
    slice costs at most `ceil(limit * 0.2)` extra `pulls.get` per poll
    during the drain; each drained binding leaves the active set for
    good, so the fan-out returns to the open budget once the backlog
    clears.
- The cap warning keeps the `PR watch cap exceeded` prefix (pinned by
  tests) and fires whenever the selection cannot cover the whole active
  set: it reports `watched/active` counts (watched may exceed the open
  limit while the terminal slice drains), the configured open limit, and
  the excluded keys (open and terminal-pending alike).
- Terminal observation stays API-authoritative: no `state_change` is ever
  synthesized from binding registry data. The registry and the watch
  entry only decide _priority_, never event content. A genuinely reopened
  PR gets one leftover-budget observation and returns to the open tier.

### 2. Background public-task runner (`packages/channels/github`)

- A per-channel FIFO runner (concurrency 1) owns public-path
  `runInboundTask` execution. It follows the existing
  `retryPendingFinalDeliveries` background-loop pattern: started on
  demand, retired by generation on `disconnect`/`connect`.
- `dispatchEnvelope` public branch: claim the task durably (unchanged),
  run the absence gate synchronously, then enqueue and return `true`.
  The absence gate (incomplete binding snapshot cannot prove a PR is
  unbound) must run at dispatch so a deferred event keeps the `false`
  verdict the comment lane's first-contact body suppression depends on;
  `runInboundTask` re-checks it for tasks recovery enqueues.
- Gone-session public fallbacks (bound target vanished, absence
  authoritative) clear the delivery durably and requeue through the same
  runner (`requeued` verdict) instead of awaiting `handleInbound` in the
  poll lane: they are full public turns, and running them inline both
  head-of-line-blocks the poll and can steer-cancel another public turn
  on a shared channel session.
- Bound fan-out branch stays inline: delivery is a fast prompt POST whose
  verdict (delivered/deferred/retired) the dispatch return value and the
  cursor gate already depend on.
- `recoverInboundTasks` skips tasks in the runner's in-flight set BEFORE
  any branch mutates them (the retarget branch would otherwise re-resolve
  a backpressure-parked task whose public turn is running — the running
  transition merges patches, so `backpressure: true` survives — and
  deliver it bound a second time). A running task with no in-flight entry
  is a genuine crash and is still recovered and charged. Bound tasks run
  inline as today; other recoverable tasks are enqueued.
- An in-flight set (queued + running task ids) prevents double execution
  when a recovery pass re-scans a queued task. On a same-instance
  reconnect, the id the orphaned runner is still executing stays in the
  set (the orphan's `finally` removes it); queued-but-unstarted ids are
  dropped and re-enqueued by recovery from the durable store.
- The runner isolates failures: `runInboundTask` already transitions
  errors to `failed`/backpressure/retirement; an unexpected throw is
  logged AND journaled as an inbound `failed` row once per task id (the
  poll loop's per-thread catch no longer sees it), then the runner
  continues with the next task.
- `disconnect` retires the runner generation and resolves idle waiters.
  The winding-down runner's restart hook only fires for the CURRENT
  generation, so a retired queue is never drained after disconnect; the
  tasks stay durable for the next connect's recovery. An in-flight turn
  keeps today's semantics: the worker exits, the daemon session survives.
- While a thread's in-flight public work held the cursor at poll start,
  the comment/aggregate lanes skip re-fetching its comments and the
  direct lane skips re-processing (snapshot, not live: a task claimed
  during this poll must not suppress the same thread's later lanes, and
  a crashed task that is not in flight must stay re-dispatchable). The
  first-contact body feed is NOT gated: it claims once and the runner
  serializes it behind any running comment turn. A deferral gate was
  tried and removed — nothing reserves a deferred body, and the
  end-of-poll cursor commit can mark the thread read once the blocking
  task settles, after which first contact (`!lastReadAt`) is unreachable
  and the body is lost permanently.

### Invariants preserved (why this is safe)

- Claims are durable before the dispatch return, so cursor advance never
  outruns consumption — unchanged.
- `hasCursorBlockingTasks` still freezes mark-as-read while a public task
  is recoverable; polls during a long turn re-list the same window and
  dedupe skips already-claimed events, exactly the state crash recovery
  already produces today.
- Public tasks execute serially in claim order (FIFO, concurrency 1), so
  per-thread reply ordering is unchanged.
- Watch pending/fired reconciliation, attempt budgets, backpressure
  horizons, and the publication audit are untouched.

## Files affected

- `packages/channels/github/src/GithubAdapter.ts` — selection, limit
  getter, runner, dispatch/recovery hand-off, absence gate extraction,
  gone-session requeue, held-thread fetch skip, disconnect/connect.
- `packages/channels/github/src/index.ts` — `prWatchLimit` descriptor
  field built from the exported constants.
- `packages/channels/github/src/GithubAdapter.test.ts` — new coverage;
  the `pollOnce` test helpers additionally await runner idle so existing
  public-path assertions keep their meaning.
- `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`
  and `packages/web-shell/client/i18n.tsx` — field registration and both
  locale catalogues.
- Docs: the GitHub channel guide's bound-session section gains the
  `prWatchLimit` knob and the non-blocking execution note.

## Design decisions and rationale

1. **Open-first priority with an additional terminal slice.** A larger
   hard cap only postpones starvation and spends rate budget on dead
   PRs. Priority fixes the ordering defect; the additional slice (20% of
   the limit, at least one, OUTSIDE the open budget) guarantees the drain
   progresses even when open PRs fill the limit without excluding a
   single open binding, and disappears once the backlog clears. The
   in-budget variant was measured to re-starve the oldest open bindings
   for the whole drain window (verification fixture: 30 open + 5
   terminal at limit 30 must still deliver the oldest open PR's head
   change), so the slice is additive and the worst-case fan-out is
   bounded at the limit plus `ceil(limit * 0.2)` (1.2x at the default
   30).
2. **Configurable limit, default unchanged (30).** Each watched PR costs
   roughly one `pulls.get` per poll plus conditional Checks fetches —
   ~60 requests/hour at the 60 s default, so a 5000 req/h PAT budget
   admits ~80 watched PRs (~69 open while a terminal backlog drains at
   the 1.2x fan-out). Operators with more open bindings raise
   `prWatchLimit` (and `pollInterval`) deliberately. The watch pass
   already fails fast on rate limits, so an over-budget configuration
   degrades instead of hammering the API; the arithmetic is stated in
   the descriptor and the guide.
3. **Concurrency 1 runner, not per-session parallelism.** The defect is
   liveness, not throughput. Serial execution preserves reply ordering
   and avoids bridge-level concurrent-prompt hazards documented in
   `ChannelBase` (steer/chain-and-wait). Every transition into public
   execution goes through the runner, including gone-session fallbacks.
4. **No binding-state shortcut for terminal observation.** Synthesizing
   `state_change` from registry data would break the edge-triggered
   contract (the registry can lag or lead the API). One real observation
   per terminal PR is cheap and drains the set permanently. The watch
   entry may tier a stale-open binding as terminal, never fabricate an
   event.
5. **No first-contact body deferral gate.** A deferred body is not
   reserved by anything: once the blocking task settles, the end-of-poll
   cursor commit can mark the thread read, and first contact
   (`!lastReadAt`) becomes unreachable — permanent loss. The runner's
   FIFO already serializes the body turn behind any running comment
   turn, which is the property the gate was meant to protect. The
   synchronous absence gate at dispatch preserves the lane's
   false-verdict body suppression for backpressure-deferred comments.

## Constraints and risks

- **Test migration surface.** Existing tests assert public outcomes
  immediately after `await pollOnce()`. Centralizing the runner-idle wait
  in the test helpers keeps most assertions intact; tests that
  intentionally observe mid-flight state must opt out explicitly.
- **Frozen-cursor polling cost.** While a long public turn runs, the
  window re-lists every poll; the held-thread snapshot skips the
  redundant per-thread comment fetches and direct-lane reprocessing, so
  the request volume no longer scales with turn duration. Dispatch
  dedupe is unchanged.
- **Runner shutdown.** A turn in flight at `disconnect` is not cancelled
  by this change (same as today); recovery replays it at next start with
  the existing attempt budget. The retired generation never restarts
  the queue, and idle waiters resolve at disconnect.

## Validation plan

- Unit tests (collocated): open-first selection with the incident shape;
  the additional terminal slice at `limit == openCount` (every open
  binding keeps its observation while the backlog drains, and the oldest
  open PR's head change inside the drain window is delivered);
  stale-open tiering; limit clamping (over-ceiling, zero, non-finite) and
  descriptor acceptance; validation prerequisite; warning shape; runner
  hand-off,
  FIFO order, in-flight dedupe via a mid-turn recovery pass, recovery
  retarget skip, gone-session requeue, same-instance reconnect,
  disconnect stop + idle waiters, held-thread fetch skip, failure
  journaling; cursor gate unchanged while a public task runs.
- E2E (`.qwen/e2e-tests/github-channel-watch-coverage-async-tasks.md`):
  real daemon + local GitHub-compatible stub + local model endpoint, per
  the channel real-scenario harness. Baseline dry-run on the installed
  release must show both defects; the local build must pass all groups.
- Mutation witnesses: revert open-first ordering, revert the enqueue
  hand-off, remove the recovery in-flight skip, remove the additional
  terminal slice, shrink the open budget by the slice (the removed
  in-budget reservation), remove the disconnect generation guard — each
  must turn a dedicated test red.

## Acceptance criteria

- With >30 open bound PRs and default limit, the most recent open PRs
  are watched within the FULL open budget and terminal-pending PRs drain
  through the additional slice outside it; with `prWatchLimit` raised to
  the open count, every open bound PR receives `head_change` delivery.
- Terminal-pending PRs leave the active set after one observed poll,
  even when open PRs fill the limit, without excluding any open binding
  (fixture: 30 open + 5 newer terminal at limit 30 — the oldest open PR
  is observed and its head change is delivered); the active count in the
  cap warning shrinks accordingly.
- While a public review turn runs for minutes, a bound PR's head change
  is still delivered within one poll interval, new notifications are
  still claimed, and the held thread's comments are not re-fetched every
  poll.
- A first-contact body is never lost to a cursor commit; a deferred
  (backpressure) comment still suppresses the body for that poll.
- All existing delivery/recovery/backpressure tests pass (helpers await
  runner idle); lint, typecheck, and focused unit suites green.

## Open questions

- None blocking. A future enhancement could batch the PR state queries
  to remove the per-PR fan-out entirely (raised in triage as the
  preferred long-term shape); it is separate work with its own
  rate-limit questions and is deliberately deferred.
