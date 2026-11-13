# Bound Delivery Startup Backlog: Supersession Folding and Comment Digest

[English](2026-11-14-bound-delivery-startup-backlog.md) | [简体中文](2026-11-14-bound-delivery-startup-backlog.zh-CN.md)

Status: proposed (2026-11-14).

## Problem statement

When a GitHub channel with `deliverToBoundSessions` restarts after a downtime
gap (daemon stopped overnight, a long outage, a channel re-enabled after being
off), the persisted cursors replay the whole backlog into bound PR sessions as
individual prompts:

- The **comment watch** cursor (`commentSince`) survives restarts by design
  (`MAX_WATCH_COMMENTS_PER_PASS` documents the outage-drain scenario). Every
  same-account comment created during the gap becomes its own durable task and
  prompt, drained 20 per pass over many passes.
- The **state watch** fires transitions against the stale persisted baseline.
  Events detected before shutdown can describe facts that no longer hold: a
  `ci_failure` for a head that has since been replaced, a `merge_conflict`
  that was resolved, or intermediate `head_change` hops A→B, B→C when only the
  net A→C matters. Such an event is usually NOT sitting in `pending`: detection
  claims it immediately, and a full session prompt queue parks it as a
  recoverable backpressure task (`state: failed`, `backpressure: true`, no
  `deliveredAt`) that retries every poll for up to the 240-deferral horizon —
  across restarts. The dry-run fixture reproduced exactly this: the stale
  `ci_failure` lived in `github-inbound-tasks.json`, not in the pending queue.

Each stale prompt costs a model turn in the bound session and can trigger work
on already-resolved state. The delivery contract
([2026-11-02-github-channel-bound-session-events](2026-11-02-github-channel-bound-session-events.md),
key decisions 10/11) deliberately treats restart re-injection as correct
recovery and forbids silent consumption, so the fix must keep every retirement
visible and every current fact deliverable.

## Current state

All references are to `packages/channels/github/src/GithubAdapter.ts` unless
noted.

| Lane              | Backlog mechanism                                                                                                                                                                                                                               | Location                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Notification lane | `since = cursor.lastProcessedAt - 1s` re-lists every unread notification of the gap; comment threads already batch through the aggregate lane (`agg:` content-hash batches, `MAX_AGGREGATE_COMMENTS = 20`, `MAX_AGGREGATE_COMMENT_CHARS = 400`) | `pollOnce` ~3045; `processAggregateLane`                        |
| State watch       | Persisted baseline (`headSha`, `ci`, `mergeableState`, `prState`) compared on the first poll after restart; pending queue drains via `reconcilePendingWatch` before the watch pass                                                              | `watchOnePr`, `drainPendingWatch`, `drainPendingWatchRoleAware` |
| Comment watch     | `commentSince` survives restarts; per-pass burst budget 20; one durable task and prompt per comment                                                                                                                                             | `watchPrComments`                                               |

First-ever observation (no persisted entry) already baselines silently in both
watch lanes — no backlog is delivered. The problem requires an existing
persisted state plus a gap.

Role-aware routing constrains any bundling: `boundEventClass` derives a watch
event's class from the `watch:<type>:` messageId prefix, and
`resolveBoundActionTemplate` (channel-base) resolves
`role:event → role:lane → role:default → event → lane → default`; **no match
skips the role**. A synthetic digest class would silently miss every role
configured with only member-class templates (e.g. `fix:watch:ci_failure`).

## Goals

1. Never deliver a watch event whose fact has been superseded by a later
   observation, and never deliver intermediate head hops when the net change
   is available. Retirements are visible (dead-letter + journal), never silent.
2. After a detected downtime gap, deliver the comment backlog of each bound PR
   as ONE private digest prompt instead of one prompt per comment, with no
   change to role routing, authorship attribution direction, or cursor
   crash-safety.
3. No new configuration keys; no change to the notification lane, the public
   publication contract, or the recovery contract for already-claimed tasks.

## Scope boundaries

- **State events stay individual.** After a gap the state watch fires at most
  four events per PR (head_change, ci_failure, merge_conflict, state_change),
  each describing the CURRENT state, each routed by its own event class.
  Bundling them into one digest would require a new event class and an
  "any member class matches" extension of the published channel-base template
  resolution — a routing regression risk for existing role configurations.
  Folding (goal 1) removes the stale ones; the remainder are current facts.
  This narrows the original "one summary per PR incl. head/CI" proposal; the
  unbounded flood source (comments) is fully covered.
- **Notification lane unchanged.** It already batches comment threads, and its
  mark-read + publication-audit + public-fallback contract is the highest-risk
  surface. Other-account comment backlog keeps today's behavior.
- **Pre-shutdown pending** drains through the existing reconcile contract on
  the first poll, before the first detection can fold it (bounded: pending cap
  64 per entry, current at detection time). **Parked backpressure tasks** ARE
  folded, on the first detection that observes the superseding fact — including
  the first poll after a restart. **In-flight or delivered tasks** (accepted /
  running / `deliveredAt` set) are never folded; they settle through the
  existing recovery contract.
- **First observation stays silent.** A PR with no persisted entry baselines
  without delivering anything, digest mode or not.

## Proposed changes

### 1. Supersession folding (always on, detection time)

In `watchOnePr`, after the new baseline (`next`) is computed and before events
are appended:

- **ci_failure superseded by head advance.** A pending `ci_failure` whose key
  SHA differs from the currently observed `headSha` is retired. The SHA is read
  from the stable key format `watch:ci_failure:<n>:<sha>:<detectedAt>`; a key
  carrying `unknown` is never folded (no proof of supersession).
- **merge_conflict superseded by resolution.** When `mergeableState` is
  positively observed as non-`dirty`, pending `merge_conflict` events are
  retired. A `null`/absent mergeable (GitHub still computing) never folds.
- **head_change coalescing.** When a new `head_change` is appended while one is
  already pending, the pending item keeps its key and its text is re-rendered
  as the net change (original `from` → new `to`). `PendingWatchEvent` gains an
  optional `headChangeFrom?: string` recorded at detection; a legacy pending
  item without it is not coalesced (both events deliver — the pre-upgrade
  behavior). A round trip (the head returns to the pending hop's original
  `from`) retires the pending hop with reason
  `superseded: head returned to original` instead of rendering a no-op
  "A to A" prompt; a failed dead-letter write falls through to append the new
  hop (two factual prompts, never a lost transition).

The same supersession rules apply to **parked backpressure tasks** — the
dominant stale path, since detection claims events immediately and a full
prompt queue parks them. When the new facts supersede, `watchOnePr` also scans
the inbound task store for this PR's watch tasks and retires every task whose
`source.messageId` is a superseded `ci_failure` (key SHA ≠ current head) or
`merge_conflict` (non-dirty positively observed) AND that is parked, not
in-flight: `state === 'failed'`, `backpressure === true`, `deliveredAt`
undefined, and not owned by this process (`publicTasksInFlight`). Tasks in any
other state (accepted/running, delivered, non-backpressure failed) are never
folded — they settle through the existing recovery contract.

Retirement surface mirrors the existing pending-overflow path: a dead-letter
record in `github-bound-deadletter.jsonl` with reason
`superseded: head advanced` / `superseded: conflicts resolved` /
`superseded: head returned to original` is the commit point; the event then
leaves `pending` (in the same end-of-pass save that commits the baseline) or
the task is removed from the store, and a `watch_superseded` journal skip row
is written after the durable step. A failed
dead-letter write keeps the event queued / the task parked (fail-closed,
retried on the next detection).

Crash window: a recovery pass that finds a recoverable watch task whose key is
already dead-lettered completes the retirement (removes the task, journals the
skip) instead of delivering — the same completion logic the drain already
applies to dead-lettered pending heads. The fired ring, `ciFiredSha` pin, and
seq counter semantics are unchanged; a coalesced head_change consumes one seq
number like any detection. Retiring a parked predecessor also unblocks the
per-PR drain ordering guard, so the surviving net `head_change` delivers
without waiting for the stale event's horizon.

Contract amendment: the bound-session-events acceptance "every transition
instance produces exactly one injected prompt" becomes "every transition
instance produces exactly one injected prompt **or one visible superseded
retirement**". Legitimate recurrences (dirty → clean → dirty, SHA revisits,
close → reopen → close) still fire: folding only consumes instances whose fact
a later observation has superseded.

### 2. Downtime gap detection

- `GithubCursor` gains `lastPollAt?: string`, stamped at the top of `pollOnce`
  (before any early return) and persisted by the base class after every
  successful poll. `validateCursor` accepts a missing value (legacy cursors)
  and drops a malformed one.
- On the first `pollOnce` of the process, if a persisted `lastPollAt` exists
  and `now - lastPollAt > max(10 minutes, 5 × pollInterval)`, the in-memory
  one-shot flag `startupDigestPending` is set. The threshold scales with the
  configured poll interval so a long-interval channel does not digest every
  poll; a sustained API outage (failed polls do not save the cursor) counts as
  a gap, which matches the backlog semantics.

### 3. Comment backlog digest (first complete watch pass after a gap)

`runPrStateWatch` reads the flag into a pass-local digest mode and clears the
flag only after a pass completes (a rate-limit/credential abort or a failed
state save keeps it for the next pass; PRs already digested have advanced
cursors, so re-running digest mode is a no-op for them).

In `watchPrComments`, digest mode replaces the per-comment dispatch loop:

- All deliverable candidates (authorship-excluded and gate-filtered exactly as
  today) become ONE private-only envelope:
  - `messageId`: `comment-digest:<n>:<sha256-40 of sorted member keys>`
    (content-hash identity, mirroring the aggregate lane).
  - Class: metadata keeps `Trigger: comment.`, so `boundEventClass` resolves
    `comment` — role routing is byte-identical to individual comment-watch
    deliveries.
  - Text: a localized lead with the total count, then the newest
    `MAX_AGGREGATE_COMMENTS` entries (author lead, body excerpt capped at
    `MAX_AGGREGATE_COMMENT_CHARS` with the existing truncation notice, comment
    URL), then the existing `omittedNotice` for the remainder. The shared bound
    prompt body ceiling still caps the final text visibly.
  - Dedupe: `dispatchedComments` records EVERY member key, so a re-list after
    a crash filters consumed members individually; a grown re-fetch window
    dispatches only the new remainder under a fresh hash (the aggregate lane's
    superset semantics).
- Authorship exclusion for the digest is the UNION of per-member exclusions: a
  session that authored ANY bundled comment is excluded from the digest.
  Rationale: a session that posted during the gap was active elsewhere and
  already holds the context; the digest targets the dormant followers. If
  every target is excluded, the digest retires with the existing
  `comment_watch_no_target` journal row and the cursor advances (consumed with
  a trace, exactly like today's no-target path).
- Digest mode BYPASSES the pass-wide comment burst budget: the budget bounds
  per-comment task fan-out, while a digest is one task per PR however large
  its backlog, and the watch limit already bounds the PR fan-out. Spending
  the budget would push tail PRs (watch limit 30 > budget 20 by default) back
  to per-comment delivery once digest mode clears. The cursor commits
  `nowIso` when the dispatch settles, holds `since` when it does not (retry
  next pass), and the gate-grace hold keeps its existing one-cycle semantics
  at batch granularity.
- Cross-instance note: individual comment-watch deliveries dedupe across
  channel instances via stable GitHub ids; a digest's hash identity is
  instance-local (each instance has its own cursor), matching watch-event
  at-least-once-per-subscription semantics. Two instances watching the same PR
  through the same gap each deliver one digest.

New copy entries in `BOUND_DELIVERY_COPY` (en + zh): an offline-backlog lead
with the count. Structural markers and platform values follow the existing
language contract (English byte-identical entries for `en`).

## Design decisions and rationale

1. **Fold at detection, not drain.** New facts arrive only in `watchOnePr`;
   folding there covers both drain variants (legacy and role-aware) with one
   code path and no interaction with the claim/fired crash windows. A
   drain-time check would add nothing: the head only advances through an
   observation, which already folds.
2. **Dead-letter is the fold commit point.** Reusing the overflow retirement
   surface keeps "surfaced, never silent" and the fail-closed write semantics
   operators already know; `isDeadLettered` keeps a folded key undeliverable
   even if a crash interleaves.
3. **Digest only the comment lane.** It is the only unbounded backlog source;
   its `comment` class keeps role routing identical without touching the
   published channel-base resolution chain. State events are bounded (≤4 per
   PR per gap) and current after folding.
4. **Heartbeat in the notification cursor, not the watch state.** The cursor is
   saved after every successful poll regardless of watch eligibility (budget
   skips, missing bindings), so the gap signal cannot be faked by a watch that
   legitimately did not run. The watch state file is only written when the
   watch pass runs.
5. **Union authorship exclusion.** Per-member exclusion cannot apply to a
   bundle; excluding sessions that posted during the gap is the conservative
   direction (they were active) and preserves the self-trigger loop prevention
   for dormant sessions.
6. **No config keys.** The behavior is a strict improvement on the reported
   pain with visible retirements; an operator switch would add surface without
   a requested use case (simplicity first).

## Constraints

- The notification cursor, mark-as-read, publication audit, and public fallback
  contracts are untouched.
- `PendingWatchEvent.headChangeFrom` is additive; `isPrWatchEntryShape`'s
  pending validator checks key/issueNumber/envelope/delivery and passes extra
  fields, so legacy state files load unchanged.
- `lastPollAt` is additive to `GithubCursor`; legacy cursors without it skip
  digest detection on the first upgrade poll (no false digest).
- channel-base is a published package; this design changes no export of it.
- The digest body respects `BOUND_PROMPT_BODY_MAX_CODE_POINTS` via the shared
  envelope cap; excerpts reuse the aggregate lane's constants.

## Risks

- **Information density.** A digest excerpt cap can hide an actionable comment
  behind `omittedNotice`; the notice names the remedy (list the PR comments)
  and every member URL pattern remains derivable from the PR. Accepted: the
  alternative is the prompt flood this design removes.
- **Pre-shutdown stale pending.** Events still in `pending` at shutdown drain
  before the first fold (see scope). Bounded and current-at-detection;
  accepted for v1. Parked backpressure tasks — the dominant stale path — are
  folded.
- **Task-store scan cost.** Folding reads the inbound task store once per
  detecting PR per pass; the store is already read every poll by reconcile and
  recovery, and the scan only runs when a superseding fact was observed
  (head change / conflict resolution), not on steady-state polls.
- **Digest mode re-entry.** A pass aborted mid-way keeps the flag; already
  digested PRs have advanced cursors and produce no second digest. A PR whose
  first digest dispatch failed retries from `since` with member dedupe.
- **Multi-instance duplication** during a shared gap (one digest per instance)
  — consistent with existing watch-event semantics, documented above.

## Validation plan

- Unit tests (collocated, `GithubAdapter.test.ts`): each folding rule on both
  pending events and parked backpressure tasks, including the fail-closed
  dead-letter write, `unknown`-SHA and null-mergeable non-folding, in-flight /
  delivered / non-backpressure tasks never folded, recovery completing a
  dead-lettered watch task, legacy pending without `headChangeFrom`; gap
  threshold scaling and legacy-cursor tolerance; digest bundling, member
  dedupe on re-list, union authorship exclusion, no-target retirement, burst
  budget bypass, cursor commit/hold, flag clearing on complete pass and
  retention on abort, first-observation silence under a gap.
- E2E (hermetic mock GitHub + isolated daemon, per the bound-delivery fixture
  pattern; two-stage: boot → bind → silent baseline → stop → rewrite
  `commentSince`/`lastPollAt` to simulate the gap → reboot): assert ONE digest
  prompt in the bound session transcript with all member dedupe keys recorded;
  a no-gap control asserts unchanged per-comment delivery; a backpressure arm
  (full prompt queue, CI red then head advance) asserts the stale `ci_failure`
  task is retired from `github-inbound-tasks.json` with a superseded
  dead-letter row; a first-observation-under-gap arm asserts silence.
  Pre-seeding watch state before the first boot does NOT work: the first
  complete-but-empty binding snapshot prunes unbound entries.
- `npm run build && npm run typecheck`, focused vitest for the changed files.

## Acceptance criteria

1. A `ci_failure` for a non-current head, a `merge_conflict` after a positively
   observed non-dirty state, and intermediate head hops are retired/coalesced
   with dead-letter + journal traces — whether the event sits in `pending` or
   is a parked backpressure task; a recovery pass completes a dead-lettered
   watch task's retirement instead of delivering it; nothing is silently
   consumed; a failed dead-letter write keeps the event queued / task parked;
   in-flight and delivered tasks are never folded.
2. After a gap above the threshold, each bound PR's same-account comment
   backlog arrives as one private digest prompt with class `comment`, all
   member dedupe keys recorded, authorship union exclusion applied, and the
   cursor advanced exactly as the per-comment path would.
3. Without a gap (or on first observation), delivery is byte-identical to
   today: per-comment prompts, silent baselines, no digest.
4. Role-aware routing, recovery of claimed tasks, the notification lane, and
   the public publication contract are unchanged.

## Open questions

- If operator feedback shows the notification lane's other-account backlog is
  also painful after long gaps, a follow-up can extend the digest to that lane
  under its own design (its mark-read/audit contract needs separate care).
