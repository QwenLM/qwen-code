# Bound Delivery Startup Backlog: Comment Digest

[English](2026-11-14-bound-delivery-startup-backlog.md) | [简体中文](2026-11-14-bound-delivery-startup-backlog.zh-CN.md)

Status: implemented as #17199 (proposed 2026-11-14). The body below describes the increment as designed. Extends [Bound PR Comment Watch](2026-11-08-bound-pr-comment-watch.md); the comment lane's per-comment delivery contract is unchanged outside the digest path. The PR **state** watch is daemon-owned since [the operator-owned watch migration](2026-11-14-daemon-pr-watch-config-migration.md) and is out of scope here.

## Problem statement

When the channel is not running for a while (a restart, a deploy, or a sustained
API outage), every same-account comment created on a bound PR during the gap
becomes eligible at once when polling resumes. The comment watch delivers each
as its own durable task and prompt, so a bound `fix` session is flooded with one
model turn per stale comment — most of them already superseded by later
discussion. The cursor survives the restart, so the backlog is real and must be
delivered, but it should arrive as a compact summary, not a flood.

## Current state

- The comment watch (`watchPrComments`) polls conversation + inline review
  comments on each bound PR and delivers each new same-account comment to every
  bound follower that did not post it, with a per-pass burst budget
  (`MAX_WATCH_COMMENTS_PER_PASS`, 20) shared across watched PRs.
- After an outage the whole gap window is eligible at once; the burst budget
  caps one pass but the tail drains one prompt per comment over subsequent
  passes — still a flood.
- The PR state watch (head/CI/conflict/state transitions) moved to the daemon
  and is operator-owned; the channel no longer detects or delivers state
  transitions. This design therefore concerns the comment lane only.

## Goals

1. After a detected downtime gap (or a deliverable window larger than the
   per-comment pass cap), deliver each bound PR's same-account comment backlog
   as private digest prompts — one per body-budget window, never one prompt per
   comment — with no change to role routing, authorship-attribution direction,
   or cursor crash-safety.
2. No new configuration keys; no change to the notification lane, the public
   publication contract, or the per-comment delivery path outside the digest.

## Scope boundaries

- **Comment lane only.** The state watch is daemon-owned; this design does not
  touch state transitions.
- **Notification lane unchanged.** Other-account comments keep today's behavior.
- **Per-comment delivery unchanged within the cap.** Without a gap, with no
  persisted digest arm, and with a deliverable window within the pass cap,
  delivery is byte-identical to today.
- **First observation stays silent.** A PR with no persisted entry baselines
  silently even under a gap (no backlog delivery on first observation).

## Proposed changes

### 1. Downtime gap detection

- `GithubCursor` gains `lastPollAt?: string`, stamped ONLY after a successful
  poll (the base class saves the cursor after `pollOnce` resolves).
  `validateCursor` accepts a missing value (legacy cursors) and drops a
  malformed one.
- EVERY poll compares `now - lastPollAt > max(10 minutes, 5 × pollInterval)`;
  when the gap exceeds the threshold the in-memory flag `startupDigestPending`
  is set (stderr once per edge). A healthy poll re-stamps the heartbeat, so the
  comparison cannot fire in steady state. Both a process restart AND an
  in-process outage count as gaps: failed polls skip the cursor save, so the
  heartbeat stays stale until polls recover. The threshold scales with the
  configured poll interval so a long-interval channel does not digest every
  poll. Gap detection is gated on bound delivery AND comment watching being
  enabled: a gap while comment watching is disabled does not arm the digest, so
  comments accumulated while disabled deliver per comment once re-enabled —
  within the per-comment cap; an over-cap window still digests via the size
  trigger, which is flood prevention independent of the gap. An
  arm persisted BEFORE watching was disabled is cleared at the poll loop's
  watch gate (the observable disabled site — the watch pass itself is never
  called while disabled), so a disabled restart cannot carry the arm into a
  later re-enable and digest comments that were never gap backlog. A transient
  skip (failed binding refresh, budget reserve) keeps the arm: the backlog is
  real.

### 2. Comment backlog digest (per-PR, armed by the gap or the window size)

The global flag ARMS a persisted per-entry `digestPending` flag on EVERY
persisted watch entry — not just the current snapshot's active keys, so a
degraded (empty/partial) first poll still arms the entries on disk and a
restart before a complete snapshot finds the arm. The arm is also persisted
immediately at gap detection, so a poll whose watch pass is skipped (failed
binding refresh) does not lose it. Entries outside the watch-cap slice keep
their arm until watched. The global flag is a TRUE one-shot: it clears as soon
as it has armed the persisted entries, not after a trusted pass — keeping it
alive across aborted passes would re-arm entries an earlier pass already
drained, so a later single fresh comment would digest under an outage lead that
never happened. The per-entry flag (persisted by the pass's save) carries the
digest for individual PRs across per-PR errors, cap exclusion, untrusted
snapshots, aborted passes, and restarts. An entry's arm clears when its backlog
is consumed (the digest settled with nothing omitted, or nothing to deliver) or
on a silent first observation. A held cursor (omitted tail, refused dispatch,
gate grace) KEEPS the arm. A complete-but-empty binding snapshot is authoritative
absence: the entry prunes under the existing contract, and a binding that appears
later is a silent first observation.

Digest mode is also armed by BACKLOG SIZE: a deliverable window larger than
`MAX_WATCH_COMMENTS_PER_PASS` digests regardless of the heartbeat, because a
healed endpoint after sustained per-PR fetch failures keeps the heartbeat fresh
while the cursor stays hours back — the gap alone would never arm it. The cap is
the PASS-WIDE per-comment budget, deliberately reused as a PER-PR flood
threshold: a single PR whose window alone exceeds the whole pass budget would
otherwise drain one prompt per comment across many passes, so it digests
instead. The size-armed digest uses a neutral lead (it must not claim an outage
that did not happen) and persists its own arm when it omits members, so the
remainder follows as further digests. The size-triggered origin is remembered per entry
(`digestSizeArmed`), so the follow-ups — which re-enter through the persisted
arm — keep the neutral lead too; only a genuine downtime gap uses the
offline-backlog wording. A detected gap RESETS the size origin, so an outage
that interrupts a size-armed drain reports the offline lead again rather than
inheriting the stale neutral one.

In `watchPrComments`, digest mode replaces the per-comment dispatch loop:

- **Body budget, newest-first**: the shared bound-prompt ceiling
  (`BOUND_PROMPT_BODY_MAX_CODE_POINTS`, 6,000) keeps the PREFIX, so the digest
  allocates it newest-first: full member lines (author lead, excerpt capped at
  `MAX_AGGREGATE_COMMENT_CHARS` with the truncation notice, comment URL) are
  accepted from the newest backwards while they fit under the ceiling minus the
  lead and the front omission notice. The newest members therefore always
  survive; the shared cap never truncates the digest tail.
- **Authorship exclusion over the RENDERED slice and the follower set**: a
  follower is excluded only if it authored EVERY rendered member (it already
  holds the whole body); the population is the same bound-follower set the
  per-comment path uses, so the delivery-time Gone fallback cannot hand the
  digest back to a session that authored every rendered member. A partial
  author still receives the digest — the mutual-authorship case (two roles each
  wrote one member) must not consume the bundle with zero prompts. An
  all-targets exclusion is unreachable (every deliverable member has some target
  that did not author it), so there is no digest no-target branch.
- **Omission is lossless and keeps the arm**: members that do not fit (beyond
  the newest-20 window or dropped by the budget) are counted in a FRONT-placed
  `offlineOmittedNotice` ("…will follow in further digests"), their dedupe keys
  are NOT recorded, and the cursor holds before the backlog head WITH the arm
  retained, so the next pass re-lists and DIGESTS the remainder (the rendered
  suffix dedupes). Clearing the arm here would drain the remainder one prompt
  per comment — the flood this feature removes. Nothing is consumed without
  being delivered. The rendered suffix dedupes against a per-entry persisted
  frontier (`digestRendered`) as well as the shared `dispatchedComments` ring:
  the ring evicts keys older than the NOTIFICATION cursor, which a healthy poll
  advances past a held digest's backlog, so a rendered key can be evicted
  mid-drain; the frontier keeps it deduped so the follow-up neither re-delivers
  it nor over-counts its "new comment(s)". The frontier accumulates while the
  cursor is held and clears when the backlog is consumed.
- Envelope: `messageId` is `comment-digest:<n>:<sha256-40 of sorted RENDERED
member keys>` (content-hash identity over what was actually delivered,
  mirroring the aggregate lane's superset semantics); metadata keeps
  `Trigger: comment.`, so `boundEventClass` resolves `comment` and role routing
  is byte-identical to individual comment-watch deliveries. `dispatchedComments`
  records exactly the rendered member keys. The envelope carries the CHANNEL
  ACCOUNT's identity (`senderId = botUsername`), exactly like the per-comment
  envelopes on this same-account lane: a synthetic sender would fail the group
  sender allowlist preflight (the waiver matches the channel login) and retire
  the digest while the cursor advanced past the whole backlog.
- **Retired is not consumed**: a retired verdict (e.g. preflight rejection)
  consumes the task and returns settled WITHOUT recording a delivery. The digest
  path requires known-positive delivery evidence after dispatch — the durable
  delivery ring, and NOT an unreadable ring (which is unknown, not proof) — and
  if the event was not delivered it undoes the claim-time member recording,
  holds `since`, and keeps the arm, so the cursor never advances past members
  that were never delivered and the next pass re-lists them. Without the undo,
  the claim-time keys would hide every member from the retry and the next pass's
  empty candidate set would consume the backlog with zero prompts. A successful
  delivery rewrites the ring and LATCHES a separate repair flag, so a
  startup-unreadable ring is repaired by the first accepted digest and the
  backlog drains once instead of re-delivering every poll. The repair is gated
  at the digest's delivered check only: the unreadable verdict itself is never
  cleared, because the keys lost with the file stay unknown and the public-
  duplicate suppression callers must keep failing closed for them — clearing it
  globally would flip every pre-corruption event from "delivered" to "not
  delivered" and open an irreversible public-reply window. The not-delivered
  hold is fail-closed for a TRANSIENT cause (a deferral returns unsettled and
  re-lists next pass), but a PERMANENT retirement (preflight rejects the digest:
  settled with no delivery) is bounded by a per-entry consecutive-retirement
  counter (`digestRetiredCount`, `MAX_DIGEST_RETIREMENT_RETRIES`): at the bound
  the backlog is consumed with a visible journal trace (`comment_digest_retired`)
  instead of holding the cursor and spending the pass-wide watch budget every
  poll for the process lifetime. A transient deferral or a successful delivery
  resets the counter.
- Cursor: commits `nowIso` (clearing the arm) when the dispatch delivered and
  nothing was omitted; holds before the backlog head (keeping the arm) when
  members were omitted; holds `since` (keeping the arm) when nothing was
  delivered. The gate-grace hold keeps its existing one-cycle semantics at batch
  granularity and keeps the arm. If not even one member fits (a pathologically
  long URL), the digest falls through to the per-comment path and consumes its
  arm.
- The digest path never decrements the pass-wide comment burst budget (one task
  per PR, not per comment), so a digest pass always finds the budget intact; the
  budget continues to bound per-comment fan-out.
- Cross-instance note: individual comment-watch deliveries dedupe across channel
  instances via stable GitHub ids; a digest's hash identity is instance-local
  (each instance has its own cursor), matching at-least-once-per-subscription
  semantics. Two instances watching the same PR through the same gap each
  deliver their own digests.

New copy entries in `BOUND_DELIVERY_COPY` (en + zh): an offline-backlog lead
(gap arm), a neutral comment-backlog lead (size arm), and an offline omission
notice. The offline lead is worded to be true of BOTH gap triggers — a restart
and an in-process API outage both leave a stale heartbeat while the process may
still be running — so it says "since the last successful poll" rather than
claiming the channel was not running. The omission notice rides at the FRONT
because the shared body cap truncates the tail. Structural markers and platform
values follow the existing language contract (English byte-identical entries
for `en`).

## Design decisions and rationale

1. **Digest only the comment lane.** It is the only unbounded backlog source the
   channel still delivers; the state watch is daemon-owned. Bundling state
   events would need a new event class and a routing-regression-risky template
   extension.
2. **Gap detection is a pure local heartbeat comparison**, stamped only on
   success, so both restarts and in-process outages are detected without any
   extra API call.
3. **Per-entry persisted arm, armed on every persisted entry.** A global
   one-shot alone would lose the digest on a degraded first poll or a per-PR
   error; the per-entry flag survives them and restarts.
4. **Size arm as well as gap arm.** A healed endpoint after sustained per-PR
   fetch failures keeps the heartbeat fresh, so the gap alone would never arm
   the digest; the over-cap window arms it directly.
5. **Newest-first body budget.** The shared cap keeps the prefix, so allocating
   oldest-first would eat exactly the newest, most actionable members.
6. **Exclusion over the rendered slice and the follower set.** Excluding over
   the whole deliverable would hand a full digest of its own comments to a
   session that authored the entire rendered slice; excluding only resolved
   targets would let the Gone fallback hand it back to a non-target author.
7. **Content-hash identity over rendered members.** A crash before the cursor
   save re-lists the window; the rendered members dedupe and a grown window
   dispatches only the new remainder (aggregate-lane superset semantics).
8. **Channel-account identity + retired-is-not-consumed.** Either alone closes
   the silent-consumption path; both are kept as defense in depth. The
   unreadable-ring gate is at the digest site only, because the ring's fail-open
   direction is load-bearing for the suppression callers.
9. **Omission keeps the arm and follows as further digests.** Clearing the arm
   on the omitted tail would drain the remainder one prompt per comment — the
   flood this feature removes.

## Constraints

- Per-comment delivery (no gap, window within the cap, no persisted arm) is
  byte-identical to today; the digest is an additive path.
- Nothing is consumed silently: a held cursor never advances past an undelivered
  member, and a TRANSIENT retired/deferred verdict never advances the cursor. A
  PERMANENT retirement (preflight keeps rejecting the digest) is the one bounded
  exception: after `MAX_DIGEST_RETIREMENT_RETRIES` consecutive retirements the
  backlog is consumed WITH a visible journal trace, never silently.
- Role routing, authorship-attribution direction, and the notification lane are
  unchanged.
- The digest never decrements the pass-wide burst budget.

## Risks

- A digest summarises rather than replays each comment; a session that needs a
  specific older comment can still list the PR comments (the omission notice
  names the count). The newest members always survive the body budget.
- Two channel instances watching the same PR through the same gap each deliver
  their own digest (instance-local hash identity), matching
  at-least-once-per-subscription semantics.
- The permanent-retirement bound consumes a backlog that was never delivered
  (preflight keeps rejecting it). This is deliberate — the alternative is an
  unbounded hold that spends the watch budget every poll — and it is never
  silent: a `comment_digest_retired` journal row names the consumed digest and
  the consumed count. The member keys stay recorded, so the comments do not
  re-list: once the bound is reached the backlog is consumed for this cursor,
  and fixing the route/sender gate afterwards does NOT re-deliver it — recovery
  is an operator action, not an automatic retry.
- A startup-unreadable delivery ring keeps the public-fallback suppression
  fail-closed for the process lifetime, even after a successful write repairs
  the ring: the keys lost with the file stay unknown, so a brand-new `pr:` event
  that was never delivered is indistinguishable from a lost key and is also
  suppressed from the public fallback until a restart. This trades a
  recoverable cost (public replies on unbound PRs pause after a corrupt ring
  until restart) for closing the irreversible duplicate direction; the digest's
  own acceptance is gated on the repaired ring plus its freshly written key, so
  the digest lane itself drains normally.

## Validation plan

- Unit tests (collocated, `GithubAdapter.test.ts`, `comment digest (startup
backlog)` suite): gap digest vs per-comment no-gap, legacy cursor, interval
  scaling, gap floor (6 min no / 11 min yes), clock skew, first-observation
  silence, author-owned drop, mutual authorship, rendered-slice + follower
  exclusion, refused dispatch, aborted pass, zh lead, malformed `lastPollAt`,
  25-member omission, inline locations, excerpt truncation, gate grace,
  full-size body budget, omitted tail as further digests, content-hash id +
  re-list dedupe, partial/empty snapshot arm retention, per-PR fetch error,
  in-process outage recovery, budget exhaustion, group sender allowlist,
  retired verdict (with a second poll after the gate clears), unreadable
  delivery ring, a repaired ring draining an accepted digest once over three
  polls, a repaired ring keeping the suppression fail-closed for pre-corruption
  events, size arm (neutral lead + omitted-tail arm + neutral follow-up lead),
  a gap resetting a size-armed drain to the offline lead, disabled-watch
  no-arm, a disabled restart clearing a persisted arm before re-enable, a
  drained PR not re-armed when a later pass aborts, a held digest deduping
  rendered members the ring evicts, the legacy Gone fallback excluding the
  full-context author, over-budget fall-through, degraded-first-poll restart,
  persistent fetch failure, a permanently-retired digest consumed with a trace
  after the retry bound, the gap-detection persist arming the entry when the
  watch pass is skipped, the entry-shape guard dropping each malformed digest
  field individually, the budget guard skipping the pass before any fetch, and
  a failed poll leaving the heartbeat stale.
- E2E (hermetic mock GitHub + isolated daemon + PR sidecar), reproducible from
  the tree via `scripts/run-github-bound-backlog-e2e.mjs` (build the bundle
  first, then `node scripts/run-github-bound-backlog-e2e.mjs --group g1 --cli
"node dist/cli.js" --expect digest`, and g2/g4/g5 for the other arms): gap →
  one digest with rendered member keys recorded; no-gap → per-comment;
  full-size backlog → newest members survive the body budget;
  first-observation-under-gap → silent.
- `npm run build && npm run typecheck`, focused vitest on the changed files.

## Acceptance criteria

1. After a gap above the threshold (or a window larger than the per-comment
   pass cap), each bound PR's same-account comment backlog arrives as private
   digest prompts with class `comment` — one per body-budget window, the newest
   members within the budget, exactly the rendered member dedupe keys recorded,
   full-context authors excluded over the rendered slice and follower set, the
   channel-account identity admitted by the sender allowlist, a transient
   retired/deferred verdict never advancing the cursor (a permanent retirement
   is consumed only at the retry bound, with a visible trace), and any omitted
   members following as further digests (cursor held, arm retained, nothing
   lost).
2. Without a gap (or on first observation), with no persisted digest arm, AND
   with a deliverable window within the per-comment pass cap, comment delivery
   is byte-identical to today: per-comment prompts, silent baselines, no digest.
   A window over the cap digests even without a gap (the size arm), and a
   persisted arm from an earlier gap still digests a within-cap window.
3. Role-aware routing, authorship-attribution direction, the notification lane,
   and the public publication contract are unchanged.

## Open questions

- If operator feedback shows the notification lane's other-account backlog is
  also painful after long gaps, a follow-up can extend the digest to that lane
  under its own design (its mark-read/audit contract needs separate care).
