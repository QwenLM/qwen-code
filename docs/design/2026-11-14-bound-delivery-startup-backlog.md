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
   observation, and never deliver intermediate PENDING head hops when the net
   change is available (a parked hop delivers as observed — a hop is a
   historical fact, not a current-state claim; see §1). Retirements are
   visible (dead-letter + journal), never silent. An event already `pending`
   at shutdown is the carved-out exception: the reconcile contract delivers it
   on the first poll before detection can fold it (accepted for v1; see Scope).
2. After a detected downtime gap (or a window larger than the per-comment pass
   cap), deliver the comment backlog of each bound PR as private digest
   prompts — one per body-budget window, never one prompt per comment — with
   no change to role routing, authorship attribution direction, or cursor
   crash-safety.
3. No new configuration keys; no change to the notification lane, the public
   publication contract, or the recovery contract for in-flight or delivered
   tasks; a parked, undelivered watch task's recovery now completes a durable
   retirement instead of delivering it (§1, acceptance criterion 4).

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

### 1. Supersession folding (always on, fact-driven)

A shared predicate `supersededWatchReason(key, number, facts)` decides whether
a watch event is superseded by the given facts. It is **fact-driven, not
transition-driven**: a retained event (a failed dead-letter write) stays
foldable on later passes, and a green re-run folds the red event for the SAME
head. The arms:

- **ci_failure, head advanced.** The key SHA (parsed from the stable format
  `watch:ci_failure:<n>:<sha>:<detectedAt>`) differs from `facts.headSha`. A
  key carrying `unknown` is never folded (no proof of supersession).
- **ci_failure, CI recovered.** The key SHA equals `facts.headSha` and
  `facts.ci === 'success'` — a positively observed green re-run. A failed or
  absent Checks fetch never folds (the baseline preserves the last aggregate).
- **merge_conflict, resolved.** `facts.mergeableState` is positively observed
  as non-`dirty`. A `null`/absent mergeable (GitHub still computing) never
  folds.
- **state_change, reopened.** `facts.prState === 'open'` retires a parked
  "PR closed" event; the close-edge-only firing means a reopen produces no
  corrective event of its own.

Two call sites share the predicate:

- **Detection time** (`watchOnePr`): facts are the freshly computed baseline
  (`next`). Pending events are scanned whenever any are queued; parked
  backpressure tasks are scanned against a task-store snapshot read ONCE per
  watch pass by `runPrStateWatch` (not once per PR — the steady-state cost is
  one read per pass, and an unreadable store skips the fold fail-closed). A
  task folds only when parked, not in-flight: `state === 'failed'`,
  `backpressure === true`, `deliveredAt` undefined, not in
  `publicTasksInFlight`, and scoped to this PR via `prBindingKey`.
- **Recovery time** (`recoverInboundTasks`): facts are the PERSISTED baseline,
  so a poll whose watch pass was skipped (REST budget below reserve, failed
  binding refresh) still retires a stale parked task before delivering it.
  This fold needs no live observation.

**head_change coalescing** (pending only): when a new `head_change` is appended
while one is already pending, the pending item keeps its key and its text is
re-rendered as the net change (original `from` → new `to`); the absorbed hop
writes a `watch_coalesced` journal row (coalescing is not a retirement, so no
dead-letter). The candidate search SKIPS dead-lettered keys: a pending item
whose key is already retired (e.g. a round-trip retire whose state save threw)
must not absorb the new hop — the net change would deliver nowhere while the
journal claims a live fold; the new hop is appended instead.
`PendingWatchEvent` gains an optional `headChangeFrom?: string` recorded at
detection and validated as `undefined | string` by the pending-item shape
check (a malformed value drops the entry like any bad shape); a legacy pending
item without it is not coalesced (both events deliver — the pre-upgrade
behavior). A round trip (the head returns to the pending hop's original
`from`) retires the pending hop with reason
`superseded: head returned to original` instead of rendering a no-op "A to A"
prompt — but ONLY when no target has received the hop yet (the durable
delivery ring is the evidence): a role-aware fan-out leaves the event pending
while one role is blocked, and the delivered role must learn the revert, so
the reverse hop is queued instead. A failed dead-letter write also falls
through to append the new hop (fail-closed: factual prompts, never a lost
transition). A coalesced hop keeps its original key and consumes NO new seq
number (the branch continues before the increment). Parked `head_change` tasks
are NOT folded: a hop is a historical fact, not a current-state claim, so it
delivers as observed; coalescing applies only while the hop is pending.

Retirement surface mirrors the existing pending-overflow path: a dead-letter
record in `github-bound-deadletter.jsonl` with reason `superseded: head
advanced` / `superseded: CI recovered` / `superseded: conflicts resolved` /
`superseded: PR reopened` / `superseded: head returned to original` is the
commit point; the event then leaves `pending` (in the same end-of-pass save
that commits the baseline) or the task is removed from the store, and a
`watch_superseded` journal skip row is written after the durable step. A failed
dead-letter write keeps the event queued / the task parked (fail-closed,
retried on the next detection or recovery).

**Scoped recovery guard.** Dead-letter records carry two scopes: event-scoped
records (no `taskId` — supersession folds, overflow) retire every task of the
event, while per-task records (`retireBoundTask`'s exhaustion surface, which
writes `taskId`) retire only the task they name. The recovery guard completes
a retirement only when the record covers THIS task, so one role's exhaustion
never retires a sibling role's still-parked task of the same event. The
in-memory index tracks both scopes and stays current on every append —
including the pending-overflow retire, which writes an event-scoped record.

**Suppression release on an undelivered same-head retire.** The fired-ring
prefix and the `ciFiredSha` pin exist so a DELIVERED red suppresses a
red→green→red flap on one head. The CI-recovered arm retires a failure that was
never delivered, so it must not spend the head's only firing slot: when that
arm retires a `ci_failure` (pending or parked, at detection or recovery), the
pin is cleared (if it names the key's SHA) and the matching fired-ring prefix
entries are removed, so a later genuine failure on the same head fires again.
A delivered red keeps both suppressors; a head advance drops the pin as before.
At recovery the release is saved to the watch state BEFORE the dead-letter
record is written: the recovery dead-letter guard completes a retire on a later
pass without re-deriving the release, so the release must already be durable
before the record that lets that guard remove the task exists (a failed release
save leaves the parked task, and no dead-letter, for the next recovery to fold
again). The release is fact-driven — CI is positively green on this arm — so it
is correct even if the dead-letter write then fails and the task retries.
Retiring a parked predecessor also unblocks the per-PR drain ordering guard,
so the surviving net `head_change` delivers without waiting for the stale
event's horizon.

Contract amendment: the bound-session-events acceptance "every transition
instance produces exactly one injected prompt" becomes "every transition
instance produces exactly one injected prompt **or one visible superseded
retirement**"; a coalesced pending hop still delivers ONE net-change prompt
plus a `watch_coalesced` row. Legitimate recurrences (dirty → clean → dirty,
close → reopen → close, a new head failing) still fire; a return to a still-
pending hop's origin is the carved-out exception (it retires with zero prompts
when undelivered). The 2026-11-02 design pair is amended in the same change.

### 2. Downtime gap detection

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
  poll.

### 3. Comment backlog digest (per-PR, armed by the gap)

The global flag ARMS a persisted per-entry `digestPending` flag on EVERY
persisted watch entry — not just the current snapshot's active keys, so a
degraded (empty/partial) first poll still arms the entries on disk and a
restart before a complete snapshot finds the arm. Entries outside the
watch-cap slice keep their arm until watched. The global flag clears once a
trusted, non-aborted pass has watched something; the per-entry flag carries
the digest for individual PRs across per-PR errors, cap exclusion, untrusted
snapshots, and restarts. An entry's arm clears when its backlog is consumed
(the digest settled with nothing omitted, or nothing to deliver), when comment
watching is disabled (a named exception: the accumulated backlog then delivers
per comment once re-enabled), or on a silent first observation. A held cursor
(omitted tail, refused dispatch, gate grace) KEEPS the arm. A complete-but-empty
binding snapshot is authoritative absence: the entry prunes under the existing
contract, and a binding that appears later is a silent first observation.

Digest mode is also armed by BACKLOG SIZE: a deliverable window larger than
`MAX_WATCH_COMMENTS_PER_PASS` digests regardless of the heartbeat, because a
healed endpoint after sustained per-PR fetch failures keeps the heartbeat
fresh while the cursor stays hours back — the gap alone would never arm it.

In `watchPrComments`, digest mode replaces the per-comment dispatch loop:

- **Body budget, newest-first**: the shared bound-prompt ceiling
  (`BOUND_PROMPT_BODY_MAX_CODE_POINTS`, 6,000) keeps the PREFIX, so the digest
  allocates it newest-first: full member lines (author lead, excerpt capped at
  `MAX_AGGREGATE_COMMENT_CHARS` with the truncation notice, comment URL) are
  accepted from the newest backwards while they fit under the ceiling minus
  the lead and the front omission notice. The newest members therefore always
  survive; the shared cap never truncates the digest tail.
- **Authorship exclusion over the RENDERED slice and the follower set**: a
  follower is excluded only if it authored EVERY rendered member (it already
  holds the whole body); the population is the same bound-follower set the
  per-comment path uses, so the delivery-time Gone fallback cannot hand the
  digest back to a session that authored every rendered member. A partial
  author still receives the digest — the mutual-authorship case (two roles
  each wrote one member) must not consume the bundle with zero prompts. An
  all-targets exclusion is unreachable (every deliverable member has some
  target that did not author it), so there is no digest no-target branch.
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
  consumes the task and returns settled WITHOUT recording a delivery. The
  digest path checks the durable delivery ring after dispatch; if the event
  was not delivered, it holds `since` and keeps the arm, so the cursor never
  advances past members that were never delivered.
- Cursor: commits `nowIso` (clearing the arm) when the dispatch delivered and
  nothing was omitted; holds before the backlog head (keeping the arm) when
  members were omitted; holds `since` (keeping the arm) when nothing was
  delivered. The gate-grace hold keeps its existing one-cycle semantics at
  batch granularity and keeps the arm. If not even one member fits (a
  pathologically long URL), the digest falls through to the per-comment path
  and consumes its arm.
- The digest path never decrements the pass-wide comment burst budget (one
  task per PR, not per comment), so a digest pass always finds the budget
  intact; the budget continues to bound per-comment fan-out.
- Cross-instance note: individual comment-watch deliveries dedupe across
  channel instances via stable GitHub ids; a digest's hash identity is
  instance-local (each instance has its own cursor), matching watch-event
  at-least-once-per-subscription semantics. Two instances watching the same PR
  through the same gap each deliver their own digests.

New copy entries in `BOUND_DELIVERY_COPY` (en + zh): an offline-backlog lead
with the count and an offline omission notice. The omission notice rides at
the FRONT because the shared body cap truncates the tail. Structural markers
and platform values follow the existing language contract (English
byte-identical entries for `en`).

## Design decisions and rationale

1. **Fold on facts at detection AND recovery.** New facts arrive in
   `watchOnePr`; folding there covers both drain variants (legacy and
   role-aware) with one code path. The recovery-time fold against the
   persisted baseline covers the polls whose watch pass was skipped (budget,
   failed refresh), where recovery would otherwise deliver the stale parked
   task before any detection could fold it. The predicate is fact-driven so a
   retained event (failed dead-letter write) and a green re-run both fold on
   later passes without a new transition.
2. **Dead-letter is the fold commit point, scoped per record.** Reusing the
   overflow retirement surface keeps "surfaced, never silent" and the
   fail-closed write semantics operators already know. Event-scoped records
   retire every task of the event; per-task exhaustion records retire only
   their named task, so a sibling role's parked task survives.
3. **Digest only the comment lane.** It is the only unbounded backlog source;
   its `comment` class keeps role routing identical without touching the
   published channel-base resolution chain. State events are bounded (≤4 per
   PR per gap) and current after folding.
4. **Heartbeat in the notification cursor, stamped on success only.** The
   cursor is saved after every successful poll regardless of watch
   eligibility, so the gap signal cannot be faked by a watch that legitimately
   did not run; failed polls leave it stale, so an in-process outage is
   detected when polls recover. The comparison runs every poll (a pure local
   check), not once per process.
5. **Exclude only full-context authors, over the rendered slice.** A follower
   that authored EVERY rendered member already holds the whole body and is
   excluded; a partial author still receives the digest. The population is the
   bound-follower set (not just resolved targets) so the Gone fallback cannot
   hand the digest back to its author; the slice is the rendered one (not all
   deliverable members) so a target that authored the whole rendered window
   is excluded even when older omitted members are not its. The earlier union
   rule consumed the mutual-authorship bundle with zero prompts — a regression
   against the per-comment path, which delivers each session the comments it
   did not write.
6. **Per-PR persisted digest arm, armed on every persisted entry.** A one-shot
   global flag cleared by "a pass completed" lost the digest on empty/untrusted
   snapshots, per-PR errors, and watch-cap exclusion; arming only the snapshot's
   active keys lost it again on a degraded first poll followed by a restart.
   The arm is written to every persisted entry and clears only when that PR's
   backlog is consumed (or watching is disabled, or a silent first observation);
   a held cursor keeps it. Backlog size arms the digest independently of the
   heartbeat, covering a healed endpoint whose polls never failed.
7. **Newest-first body budget, lossless omission, arm retained.** The shared
   cap keeps the prefix; allocating newest-first guarantees the most actionable
   members survive. Holding the cursor before the omitted prefix (with their
   keys unrecorded) AND keeping the arm makes the remainder follow as further
   digests — clearing the arm would drain it one prompt per comment, the flood
   this feature removes.
8. **Channel-account identity; retired is not consumed.** The digest carries
   the channel login like every per-comment envelope on this same-account lane,
   so the group sender allowlist waiver matches; and the digest path verifies
   the durable delivery ring after dispatch, holding the cursor when a retired
   verdict consumed the task without a delivery. Either alone closes the
   silent-consumption path; both are kept as defense in depth.
9. **Release suppression only for an undelivered same-head retire.** A delivered
   red must keep suppressing a red→green→red flap; a CI-recovered retire that
   never delivered must not spend the head's firing slot, so the pin and the
   fired-ring prefix are released for that SHA.
10. **No config keys.** The behavior is a strict improvement on the reported
    pain with visible retirements; an operator switch would add surface without
    a requested use case (simplicity first).

## Constraints

- The notification cursor, mark-as-read, publication audit, and public fallback
  contracts are untouched.
- `PendingWatchEvent.headChangeFrom` and `PrWatchEntry.digestPending` are
  additive; `isPrWatchEntryShape` validates them loosely (extra/boolean fields
  pass), so legacy state files load unchanged.
- `lastPollAt` is additive to `GithubCursor`; legacy cursors without it skip
  digest detection until the first successful poll stamps it (no false digest).
- channel-base is a published package; this design changes no export of it.
- The digest bounds itself to `BOUND_PROMPT_BODY_MAX_CODE_POINTS` before the
  shared envelope cap applies; excerpts reuse the aggregate lane's constants.

## Risks

- **Information density.** A large backlog omits members from the digest body;
  the front notice names the count and promises further digests, and the held
  cursor plus the retained arm guarantee that follow-up. Accepted: the
  alternative is the prompt flood this design removes.
- **Pre-shutdown stale pending.** Events still in `pending` at shutdown drain
  before the first fold (see scope). Bounded and current-at-detection;
  accepted for v1. Parked backpressure tasks — the dominant stale path — are
  folded at detection and recovery.
- **Task-store scan cost.** The store is read once per watch pass (not per PR)
  and once per recovery pass; both already read it every poll. The fold
  compares keys against the baseline in memory.
- **Digest arm re-entry.** An armed entry whose dispatch was refused (or
  retired without delivery) retries from `since` with member dedupe; an omitted
  tail digests again on the next pass. A complete-but-empty snapshot prunes the
  entry (authoritative absence), so a later binding is a silent first
  observation. Disabling comment watching clears the arm (named exception):
  the accumulated backlog delivers per comment once re-enabled.
- **Multi-instance duplication** during a shared gap (one digest per instance)
  — consistent with existing watch-event semantics, documented above.

## Validation plan

- Unit tests (collocated, `GithubAdapter.test.ts`, 70 cases in the
  `startup backlog` suite): each folding arm on pending events and parked
  tasks (head advanced, CI recovered, conflicts resolved, PR reopened, round
  trip), fact-driven retry after a failed dead-letter write, recovery-time
  baseline fold when the watch pass is skipped, scoped per-task vs event-scoped
  dead-letter records (sibling role survives), fail-closed dead-letter writes,
  `unknown`-SHA and null-mergeable non-folding, in-flight/delivered tasks never
  folded, cross-REPOSITORY task scoping (same PR number), coalescing with a
  `watch_coalesced` journal row and end-to-end `headChangeFrom` minting,
  coalescer skipping a dead-lettered pending hop, round trip after a partial
  fan-out delivery queuing the reverse hop, CI-recovered release letting a
  later same-head failure fire, a recovery-time release save failure keeping
  the parked task for a retry that completes the release, malformed
  `headChangeFrom` dropping the entry,
  overflow retire keeping the event-scoped index current in-process; gap floor
  (6 min no / 11 min yes), interval scaling, in-process outage recovery,
  legacy-cursor tolerance, clock skew; digest body budget (newest survives, no
  tail truncation), lossless omitted tail following as FURTHER DIGESTS with the
  arm retained, content-hash id shape, re-list dedupe, mutual authorship,
  exclusion over the rendered slice and follower set, group sender allowlist
  delivering the digest, a retired verdict (message-route preflight) holding
  the cursor and the arm, an unreadable delivery ring holding the retired
  digest cursor, a retired digest's members re-listing on the next pass, a
  restart poll holding a stale parked watch task until a trusted pass observes
  it, a pending-event CI-recovered release, disabling comment watch clearing a
  stale arm without losing the cursor, a single over-budget member falling
  through to per-comment and consuming the arm, size-based arming without a
  gap (neutral lead, omitted tail armed), cursor commit/hold,
  per-PR arm retention across partial/empty snapshots and a restart, persistent
  fetch failure running the per-PR handler, gate grace and refused dispatch
  keeping the arm, budget exhaustion, first-observation silence under a gap.
- E2E (hermetic mock GitHub + isolated daemon, per the bound-delivery fixture
  pattern; two-stage: boot → bind → silent baseline → stop → rewrite
  `commentSince`/`lastPollAt` to simulate the gap → reboot): assert ONE digest
  prompt in the bound session transcript with the rendered member dedupe keys
  recorded; a no-gap control asserts unchanged per-comment delivery; a
  backpressure arm (full prompt queue, CI red then head advance) asserts the
  stale `ci_failure` task is retired from `github-inbound-tasks.json` with a
  superseded dead-letter row; a full-size-backlog arm asserts the newest
  members survive the body budget; a first-observation-under-gap arm asserts
  silence. Pre-seeding watch state before the first boot does NOT work: the
  first complete-but-empty binding snapshot prunes unbound entries.
- `npm run build && npm run typecheck`, focused vitest for the changed files.

## Acceptance criteria

1. A `ci_failure` for a non-current head or a positively recovered head, a
   `merge_conflict` after a positively observed non-dirty state, a
   `state_change` after a reopen, and intermediate pending head hops are
   retired/coalesced with dead-letter + journal traces (coalescing: journal
   only, and the net-change prompt still delivers) — whether the event is a
   pending item queued during a watch pass or a parked backpressure task, and
   whether the watch pass ran or was skipped (an event already pending at
   shutdown drains via reconcile first — see Scope); a CI-recovered retire
   releases the head's suppression so a later genuine failure fires; the
   coalescer never absorbs into a
   dead-lettered key, and a round trip after a partial delivery queues the
   reverse hop; a recovery pass completes a dead-lettered watch task's
   retirement only when the record covers that task; nothing is silently
   consumed; a failed dead-letter write keeps the event queued / task parked;
   in-flight and delivered tasks are never folded.
2. After a gap above the threshold (or a window larger than the per-comment
   pass cap), each bound PR's same-account comment backlog arrives as private
   digest prompts with class `comment` — one per body-budget window, the newest
   members within the budget, exactly the rendered member dedupe keys recorded,
   full-context authors excluded over the rendered slice and follower set, the
   channel-account identity admitted by the sender allowlist, a retired verdict
   never advancing the cursor, and any omitted members following as further
   digests (cursor held, arm retained, nothing lost).
3. Without a gap (or on first observation) AND with a deliverable window within
   the per-comment pass cap, COMMENT delivery is byte-identical to today:
   per-comment prompts, silent baselines, no digest. A window OVER the cap
   digests even without a gap (criterion 2's size arm — a deliberate extension
   of the old per-comment burst drain, which the comment-watch contract pair
   records). The always-on supersession fold still applies to watch events
   regardless of any gap — that is criterion 1, not a comment-delivery change.
4. Role-aware routing, recovery of accepted/running/delivered tasks, the
   notification lane, and the public publication contract are unchanged;
   recovery of a dead-lettered parked watch task now completes its retirement
   (§1) instead of delivering it.

## Open questions

- If operator feedback shows the notification lane's other-account backlog is
  also painful after long gaps, a follow-up can extend the digest to that lane
  under its own design (its mark-read/audit contract needs separate care).
