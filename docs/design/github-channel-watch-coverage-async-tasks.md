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
  - Descriptor: `kind: 'number'`, `exclusiveMinimum: 0`, `maximum: 500`,
    `default: '30'`, description naming the per-poll API cost and the
    `pollInterval` trade-off.
  - Adapter: a `prWatchLimit` getter clamps like the existing
    `pollInterval` getter (invalid/unset → 30; fractional → raised to 1;
    above 500 → clamped to 500). `MAX_WATCHED_PRS` becomes the default
    constant, not the hard ceiling.
- `runPrStateWatch` partitions the active set using the binding registry
  state it already reads:
  - **open**: binding state is neither `merged` nor `closed`;
  - **terminal-pending**: binding state is `merged`/`closed` but the watch
    entry has not observed `prState === 'closed'` yet.
    Selection watches open PRs first (by `updatedAt` desc) up to the limit,
    then fills any remaining budget with terminal-pending PRs (same order)
    so they get their one terminal observation and leave the active set.
- The cap warning keeps the `PR watch cap exceeded` prefix (pinned by
  tests) and fires whenever the budget cannot cover the whole active set:
  it reports `watched/active` counts, the configured limit, and the excluded
  keys (open and terminal-pending alike).
- Terminal observation stays API-authoritative: no `state_change` is ever
  synthesized from binding registry data. The registry only decides
  _priority_, never event content.

### 2. Background public-task runner (`packages/channels/github`)

- A per-channel FIFO runner (concurrency 1) owns public-path
  `runInboundTask` execution. It follows the existing
  `retryPendingFinalDeliveries` background-loop pattern: started in
  `connect`, stopped by `disconnect`.
- `dispatchEnvelope` public branch: claim the task durably (unchanged),
  enqueue it, return `true`. The boolean now means "durably claimed or
  retired", which is exactly what callers persist as dedupe keys; execution
  outcome continues to flow through task-state transitions and recovery.
- Bound fan-out branch stays inline: delivery is a fast prompt POST whose
  verdict (delivered/deferred/retired) the dispatch return value and the
  cursor gate already depend on.
- `recoverInboundTasks`: bound tasks run inline as today; recoverable
  public tasks are enqueued instead of awaited.
- An in-flight set (queued + running task ids) prevents double execution
  when a re-listed event re-claims a running task or a recovery pass
  re-scans it. `claimInboundTask` already returns the existing record for
  a live task; the runner skips ids it already owns.
- The runner isolates failures: `runInboundTask` already transitions
  errors to `failed`/backpressure/retirement; an unexpected throw is
  journalled and the runner continues with the next task.
- `disconnect` stops the runner from picking up new tasks. An in-flight
  turn keeps today's semantics: the worker exits, the daemon session
  survives, and the durable task is recovered by the next worker start.
- The first-contact issue body feed gains a thread-level gate: while any
  recoverable task for the same thread exists (a fresh claim or a retry in
  the runner), the body is deferred to a later poll. Without the gate an
  async body turn could overtake a still-retrying comment turn on the same
  channel session and steer-cancel it. The body key is not recorded while
  deferred, so no event is lost; the deferral is bounded by the task's own
  retry/deferral horizon.

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
  getter, runner, dispatch/recovery hand-off, disconnect.
- `packages/channels/github/src/index.ts` — `prWatchLimit` descriptor
  field.
- `packages/channels/github/src/GithubAdapter.test.ts` — new coverage;
  the `pollOnce` test helpers additionally await runner idle so existing
  public-path assertions keep their meaning.
- `packages/cli` channel descriptor pin tests, if they enumerate GitHub
  management fields.
- Docs: the GitHub channel guide's bound-session section gains the
  `prWatchLimit` knob and the non-blocking execution note.

## Design decisions and rationale

1. **Open-first priority instead of a bigger fixed cap.** A larger hard
   cap only postpones starvation and spends rate budget on dead PRs.
   Priority + terminal drain fixes the ordering defect at any budget.
2. **Configurable limit, default unchanged (30).** Each watched PR costs
   roughly one `pulls.get` per poll plus conditional Checks fetches; at
   the 60 s default interval, 30 PRs already approach a meaningful share
   of the 5000 req/h PAT budget. Operators with more open bindings raise
   `prWatchLimit` (and `pollInterval`) deliberately. The watch pass
   already fails fast on rate limits, so an over-budget configuration
   degrades instead of hammering the API.
3. **Concurrency 1 runner, not per-session parallelism.** The defect is
   liveness, not throughput. Serial execution preserves reply ordering
   and avoids bridge-level concurrent-prompt hazards documented in
   `ChannelBase` (steer/chain-and-wait).
4. **No binding-state shortcut for terminal observation.** Synthesizing
   `state_change` from registry data would break the edge-triggered
   contract (the registry can lag or lead the API). One real observation
   per terminal PR is cheap and drains the set permanently.

## Constraints and risks

- **Test migration surface.** Existing tests assert public outcomes
  immediately after `await pollOnce()`. Centralizing the runner-idle wait
  in the test helpers keeps most assertions intact; tests that
  intentionally observe mid-flight state must opt out explicitly.
- **Frozen-cursor polling cost.** While a long public turn runs, every
  poll re-lists the notification window. This is the existing
  recovery-state behavior, bounded by the window and dedupe; the win is
  that watch and bound lanes keep flowing.
- **Runner shutdown.** A turn in flight at `disconnect` is not cancelled
  by this change (same as today); recovery replays it at next start with
  the existing attempt budget.

## Validation plan

- Unit tests (collocated): open-first selection; terminal drain; limit
  clamping and descriptor acceptance; warning shape; runner hand-off,
  FIFO order, in-flight dedupe, recovery enqueue, failure isolation,
  disconnect stop; cursor gate unchanged while a public task runs.
- E2E (`.qwen/e2e-tests/github-channel-watch-coverage-async-tasks.md`):
  real daemon + local GitHub-compatible stub + local model endpoint, per
  the channel real-scenario harness. Baseline dry-run on the installed
  release must show both defects; the local build must pass all groups.
- Mutation witnesses: revert open-first ordering, revert the enqueue
  hand-off, and remove the in-flight dedupe set — each must turn a
  dedicated test red.

## Acceptance criteria

- With >30 open bound PRs and default limit, the most recent 30 open PRs
  are watched and no terminal-pending PR occupies an open slot; with
  `prWatchLimit` raised to the open count, every open bound PR receives
  `head_change` delivery.
- Terminal-pending PRs leave the active set after one observed poll; the
  active count in the cap warning shrinks accordingly.
- While a public review turn runs for minutes, a bound PR's head change
  is still delivered within one poll interval, and new notifications are
  still claimed.
- All existing delivery/recovery/backpressure tests pass (helpers await
  runner idle); lint, typecheck, and focused unit suites green.

## Open questions

- None blocking. A future enhancement could reserve a small terminal
  budget even when open PRs exceed the limit; today terminal drain uses
  only leftover budget, which is sufficient because terminal-pending PRs
  no longer block open coverage.
