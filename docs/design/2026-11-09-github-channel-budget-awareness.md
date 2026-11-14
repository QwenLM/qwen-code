# GitHub channel: API budget awareness and mention-lane protection

[中文版](2026-11-09-github-channel-budget-awareness.zh-CN.md)

- Issue: #16690
- Status: proposed
- Related: #16665 (removed redundant CI-aggregate requests), #16691 / #16692 (alternative watch-transport reductions)

## Problem statement

The GitHub channel polls GitHub with a token that has a fixed hourly REST budget (5,000/hour for a classic PAT). Two structural facts turn that budget into a user-facing problem:

1. **The PR state watch runs before the notification lane in every poll.** `pollOnce` reconciles pending watch events, runs `runPrStateWatch`, and only then processes notifications (mentions, review requests, comments). When the watch spends the budget down to a rate-limit answer, the interactive mention handling in the same poll — and subsequent polls until reset — is what fails. The least urgent work (background state polling of PRs that usually have not changed) starves the most urgent (a human asking the bot to do something).
2. **The channel is budget-blind on the success path.** `x-ratelimit-remaining` is read only inside `githubApi`'s catch block and the rate-limit classifiers (`rateLimitRemaining`, `isRateLimitAnswer`, `isDefiniteNoWriteGithubError`), all of which take an _error_. A successful response carries the same header, but nothing records it. So the channel cannot slow down before it hits the wall — it only reacts after a request has already been rejected.

### Current state (verified on `main`)

- `githubApi<T>(fn, label, retries, shouldRetry, signal)` awaits `fn()` and returns its value; on error it inspects `e.response.headers` for backoff. `fn()` returns different shapes per call site — `octokit.paginate(...)` resolves to an array, `octokit.rest.pulls.get(...)` resolves to `{ data, headers, ... }` — so the wrapper cannot uniformly read success headers from the return value.
- `rateLimitRemaining(err)` and friends are error-only; there is no stored "last known remaining".
- The watch pass is gated at `pollOnce` by `this.prWatchEvents.size > 0 && !this.boundRefreshFailed`, then `runPrStateWatch` caps fan-out at `prWatchLimit` (default 30). There is no budget gate.
- Degraded-but-survived conditions are journalled through `recordPollDegraded(reason, detail?, error?)`, which emits a `type: 'poll', outcome: 'degraded'` row. Existing reasons are edge-triggered (e.g. `watchReconcileBlockedCause`) so a permanent condition cannot rotate the useful rows out of the journal.

## Desired behavior

- Record the remaining REST budget from **every** successful GitHub response, at one choke point, regardless of the call's return shape.
- When the last known remaining budget is at or below a reserve threshold, **skip the watch pass for that poll** so the notification lane keeps the remaining budget. The watch is best-effort edge-triggered detection. Skipping delays detection rather than losing a persistent state: baselines and pending queues are durable, so a state that still holds when the watch resumes is detected. It is not lossless in general — `watchOnePr` compares the fresh observation against the stored baseline, so a transition that appears AND reverts between two passes is never observed, and a closed gate widens that window from one poll to up to a rate-limit window.
- Journal the skip as a degraded poll row, edge-triggered, and journal the recovery when budget climbs back above the threshold.
- Never let a stale low reading starve the watch forever: once the budget window's reset time has passed, the reading is stale and must not gate.

## Proposed changes by component

### 1. A single response hook records the budget

Register `octokit.hook.wrap('request', ...)` once in `connect()`, right after constructing the client. The wrapper awaits the real request, reads `x-ratelimit-remaining` and `x-ratelimit-reset` from the response headers, stores them on the adapter, and returns the response unchanged. Verified against the installed `@octokit/rest` (before-after-hook 3.0.2): the wrap callback sees the response headers on every request, including each page of a `paginate` call, so this is genuinely one choke point and is independent of `fn()`'s return shape.

State added to the adapter:

- `lastRateLimitRemaining: number | undefined`
- `lastRateLimitResetAt: number | undefined` (epoch ms; `x-ratelimit-reset` is epoch seconds)

Only the `core` REST resource is relevant here; the header on a REST response reports the core pool. GraphQL is out of scope (#16692).

### 2. A reserve threshold gates the watch pass

A new config field `prWatchBudgetReserve` (descriptor: number, optional) sets how many requests to hold back for the notification lane. Default chosen so a healthy 5,000/hour token is unaffected but a nearly-exhausted one protects mentions. Proposed default: **200**. Rationale in Resolved decisions.

The gate in `pollOnce`, replacing the current watch condition:

- Compute `budgetLow` = `lastRateLimitRemaining !== undefined && lastRateLimitRemaining <= reserve && !resetHasPassed`.
- `resetHasPassed` = `lastRateLimitResetAt !== undefined && Date.now() >= lastRateLimitResetAt`. A reading from a window that has already reset is stale and must not gate.
- If `budgetLow`, skip `runPrStateWatch()` this poll and journal the degraded edge. The notification lane runs unchanged.

The watch's existing `isWatchFailFastError` behavior (abort the pass on a 403/429) stays as the backstop for when the estimate is wrong or a secondary limit hits with quota nominally left. This change is a _proactive_ layer in front of that reactive backstop, not a replacement.

### 3. Edge-triggered journaling

Two flags, because they answer different questions. `watchBudgetLow` latches the skip so the low edge is journaled once; `watchBudgetEpisodeOpen` records that a low row is still awaiting its recovery row. On the first low-budget observation `noteWatchBudgetLow()` sets both and emits `recordPollDegraded('watch_budget_low', { remaining, reserve })` plus a stderr line; the in-pass yield calls the same helper so a mid-pass stop records the same row. `closeWatchBudgetEpisode()` emits `watch_budget_recovered` once the budget is no longer exhausted, and only then clears the episode flag. This keeps a permanent low-budget condition from flooding the journal.

Both flags are in-memory: a daemon restart mid-episode leaves no recovery row, and the next low observation journals a fresh skip. The user guide states this bound rather than promising an unconditional recovery row.

The skip latch is also released when the watch stops being eligible (subscriptions off, binding refresh failing), because that path skips the whole watch block. Without the release, a later genuine starvation is suppressed as a repeat of an episode that already ended, and the timeline's last budget word names a skip no longer in effect. Recovery is claimed on that path only when the budget really recovered: the watch being ineligible says nothing about the budget, so a still-low budget releases the latch silently and the next eligible low poll journals a fresh skip.

## Key design decisions

| Decision                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook, not per-call-site header reads                 | One choke point; shape-independent; covers pagination pages. The alternative (threading header capture through every `fn()`) touches a dozen call sites and misses the paginate array shape.                                                                                                                                                                                  |
| Skip the pass, and re-check before each PR inside it | The poll-boundary gate alone lets a pass entered just above the reserve spend the whole reserve before the notification lane runs (several requests per watched PR). The pass therefore re-reads the budget before each `watchOnePr` and breaks, journaling the same low edge; `break` rather than `return` so the baseline observed so far still reaches `savePrWatchState`. |
| Gate on last-known remaining + reset time            | The header is authoritative and free. Reset-time awareness prevents a stale low reading from starving the watch after the window rolls over.                                                                                                                                                                                                                                  |
| Reserve is a threshold, not a rate predictor         | Predicting spend-per-poll is fragile (fan-out and CI page counts vary). A fixed reserve is a clear, testable contract: "keep at least N requests for mentions."                                                                                                                                                                                                               |
| Keep `isWatchFailFastError`                          | The estimate can be wrong (secondary limits, other consumers of a shared token). The reactive abort remains the backstop.                                                                                                                                                                                                                                                     |

## Files affected

- `packages/channels/github/src/GithubAdapter.ts` — hook registration, budget state, gate, journaling, config field + getter.
- `packages/channels/github/src/index.ts` — `prWatchBudgetReserve` descriptor field.
- `packages/channels/github/src/GithubAdapter.test.ts` — hook mock; unit cases for record/gate/recovery/stale-reset; a real-paginator case proving the hook records the header.
- `docs/users/features/channels/github.md` — document the field and the mention-lane protection.
- This design doc + its zh-CN twin.

## Scope boundaries

- **In:** proactive budget gate for the watch pass, success-path budget recording, degraded journaling, one config knob, docs.
- **Out:** the dedicated-credential recommendation is a deployment/docs action, tracked in the issue but not a code change here (the `token` field already exists). ETag (#16691) and GraphQL (#16692) are separate, mutually-exclusive transport changes. No change to the notification lane's own behavior, publication retries, or `githubApi`'s backoff.
- The gate only affects the watch pass. If `prWatchEvents` is empty the feature is inert (no watch to skip).

## Resolved decisions

1. **Default reserve = 200, absolute, configurable.** Maintainer chose a fixed absolute count over a fraction-of-limit scheme. 200 ≈ 4% of a 5,000/hour budget: enough for several polls of mention traffic, barely trims a healthy watch. The field is operator-tunable for other scales. A fraction-of-limit scheme (for GitHub Enterprise / non-5,000 tokens) is explicitly deferred — an operator on such a deployment sets `prWatchBudgetReserve` by hand.
2. **Verification depth: unit tests + build/typecheck/lint + mutation, no E2E/tmux.** Maintainer chose this because the change is adapter-internal with no TUI surface. Coverage: unit cases for record/gate/recovery/stale-reset, a real-paginator case proving the hook records the header on the wire, and a mutation sweep proving each new guard is load-bearing. `npm run build`, `typecheck`, focused vitest, eslint, prettier.

## Open questions

1. **`hook.wrap` and the test mock.** The unit mock has no `hook`; it must gain a no-op `hook.wrap` so `connect()` does not throw, and the real-paginator wire-oracle test exercises the real hook. Confirm no other test constructs a client without the hook. (Implementation detail, resolved during Phase 5.)
