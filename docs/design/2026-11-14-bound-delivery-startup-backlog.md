# Bound Delivery Startup Backlog: Comment Digest

[English](2026-11-14-bound-delivery-startup-backlog.md) | [简体中文](2026-11-14-bound-delivery-startup-backlog.zh-CN.md)

Status: proposed (2026-11-14). Extends [Bound PR Comment Watch](2026-11-08-bound-pr-comment-watch.md); the comment lane's per-comment delivery contract is unchanged outside the digest path. The PR **state** watch is daemon-owned since [the operator-owned watch migration](2026-11-14-daemon-pr-watch-config-migration.md) and is out of scope here.

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
- **Per-comment delivery unchanged within the cap.** Without a gap and with a
  deliverable window within the pass cap, delivery is byte-identical to today.
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
  comments accumulated while disabled deliver per comment once re-enabled.

### 2. Comment backlog digest (per-PR, armed by the gap or the window size)

The global flag ARMS a persisted per-entry `digestPending` flag on EVERY
persisted watch entry — not just the current snapshot's active keys, so a
degraded (empty/partial) first poll still arms the entries on disk and a
restart before a complete snapshot finds the arm. The arm is also persisted
immediately at gap detection, so a poll whose watch pass is skipped (failed
binding refresh) does not lose it. Entries outside the watch-cap slice keep
their arm until watched. The global flag clears once a trusted, non-aborted
pass has watched something; the per-entry flag carries the digest for
individual PRs across per-PR errors, cap exclusion, untrusted snapshots, and
restarts. An entry's arm clears when its backlog is consumed (the digest
settled with nothing omitted, or nothing to deliver) or on a silent first
observation. A held cursor (omitted tail, refused dispatch, gate grace) KEEPS
the arm. A complete-but-empty binding snapshot is authoritative absence: the
entry prunes under the existing contract, and a binding that appears later is a
silent first observation.

Digest mode is also armed by BACKLOG SIZE: a deliverable window larger than
`MAX_WATCH_COMMENTS_PER_PASS` digests regardless of the heartbeat, because a
healed endpoint after sustained per-PR fetch failures keeps the heartbeat fresh
while the cursor stays hours back — the gap alone would never arm it. The
size-armed digest uses a neutral lead (it must not claim an outage that did not
happen) and persists its own arm when it omits members, so the remainder
follows as further digests.

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
  being delivered.
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
  empty candidate set would consume the backlog with zero prompts.
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
notice. The omission notice rides at the FRONT because the shared body cap
truncates the tail. Structural markers and platform values follow the existing
language contract (English byte-identical entries for `en`).

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

- Per-comment delivery (no gap, window within the cap) is byte-identical to
  today; the digest is an additive path.
- Nothing is consumed without being delivered: a held cursor never advances
  past an undelivered member, and a retired verdict never advances the cursor.
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
  delivery ring, size arm (neutral lead + omitted-tail arm), disabled-watch
  no-arm, over-budget fall-through, degraded-first-poll restart, persistent
  fetch failure.
- E2E (hermetic mock GitHub + isolated daemon + PR sidecar): gap → one digest
  with rendered member keys recorded; no-gap → per-comment; full-size backlog →
  newest members survive the body budget; first-observation-under-gap → silent.
- `npm run build && npm run typecheck`, focused vitest on the changed files.

## Acceptance criteria

1. After a gap above the threshold (or a window larger than the per-comment
   pass cap), each bound PR's same-account comment backlog arrives as private
   digest prompts with class `comment` — one per body-budget window, the newest
   members within the budget, exactly the rendered member dedupe keys recorded,
   full-context authors excluded over the rendered slice and follower set, the
   channel-account identity admitted by the sender allowlist, a retired verdict
   never advancing the cursor, and any omitted members following as further
   digests (cursor held, arm retained, nothing lost).
2. Without a gap (or on first observation) AND with a deliverable window within
   the per-comment pass cap, comment delivery is byte-identical to today:
   per-comment prompts, silent baselines, no digest. A window over the cap
   digests even without a gap (the size arm).
3. Role-aware routing, authorship-attribution direction, the notification lane,
   and the public publication contract are unchanged.

## Open questions

- If operator feedback shows the notification lane's other-account backlog is
  also painful after long gaps, a follow-up can extend the digest to that lane
  under its own design (its mark-read/audit contract needs separate care).
