# Hosted wake recovery after writer loss

[English](2026-10-18-hosted-wake-recovery.md) | [简体中文](2026-10-18-hosted-wake-recovery.zh-CN.md)

Status: implemented and locally verified on macOS/MySQL 8.4 for
[#14116](https://github.com/QwenLM/qwen-code/issues/14116). Real MQ-on,
Linux/Windows and deployed provider acceptance remain unverified.

## Problem

A committed wake input can outlive its Harness. The replacement process has no
Session loaded. Source relays stop at different delivery boundaries, and an MQ
notice acknowledged while the writer lease is live does not return after it
expires. No new user input should be needed to discover that durable work.

## Recovery ownership

The control plane scans SQL independently of EventTransport. It restores an
eligible Session; the existing Harness wake pump owns input execution and crash
aftermath. Neither the scanner nor the message broker decides an execution's
outcome, resends its source operation, or replays a tool effect.

Supported sources are `monitor` (including background Shell), `channel`,
`child_agent`, `workflow`, `automation`, and `session_message`. A matching
`turn.settled` consumes an accepted input, regardless of its outcome. Public
foreground inputs remain the dispatcher's responsibility.

## Discovery and fencing

An additive V11 migration extends the existing Session head without changing the
32-table baseline or published migration resources. A `wake_pending` hint and
`wake_head_revision` stamp are maintained with journal commits. A generated
`wake_scan_pending` column includes both hinted work and unknown/stale stamps;
an index orders candidates by durable `wake_retry_at` and the scoped head keys.
Each pass reads hinted work first, then uses remaining slots for stale-stamp
backfill. A new head stamps its proven empty prefix at revision zero; existing
heads retain their unknown stamps.

New wake admissions set the hint. Other commits advance a current stamp without
clearing the hint. Settlement is proven by replaying the committed journal prefix
before clearing it with a revision compare-and-set. A concurrent admission cannot
be cleared. Old heads start with an unknown stamp, and writes by a binary that
does not maintain the stamp make it stale again. Backfill is therefore lazy and
uses the same scan; it does not invent delivery or consumption state.

Only an `ACTIVE`, non-retired public Session with a matching Workspace and an
`ACTIVE` expired writer or `SEALED` journal is eligible. Database time decides
expiry. Private CSI authority is excluded. Workspace admission, grants, physical
mount verification and the Harness's writer generation acquisition remain the
final fences. Closing, closed, deleted and retired Sessions never resume here.
Stopped or terminal child runs are left to their stop/close relay. The scanner
clears their hint at the proved revision, so it neither restarts cancelled work
nor repeatedly reloads a terminal run awaiting close.

Writer acquisition locks and checks the public Session's status, including an
unbound Session. A close that wins after discovery therefore still fences the
load; a writer that wins first remains subject to the existing close gate.

A claim locks the public Session before its journal head in one transaction,
matching normal admission and lifecycle. Its durable retry timestamp commits
before journal replay or Harness HTTP; no database lock spans a load. This avoids
the head-to-Session inversion an update with a Session subquery would introduce.

The scanner reads one journal transaction per page (at most 8 MiB of stored
record bytes), verifies its scope, byte digest and
contiguous committed prefix, and derives the pending set from input acceptance
and Turn settlement. Discovery, claim and the proof stamp exclude compacted
heads, whose complete proof material is permanently unavailable. Missing or
corrupt prefixes are refused and logged; neither is interpreted as no pending
work. The Harness independently verifies its restore before running anything.

A proof invocation reads at most 32 transactions, so one long history yields to
other candidates instead of monopolizing the scheduler. A cache retains at most
128 entries keyed by the complete immutable candidate prefix: either a partial
proof with its revision, event sequence and pending/settled Turn sets, or a
completed positive memo. A partial result neither stamps the head nor requests a
load. The durable retry delay spaces its next claim, which resumes the cached
strict prefix. Only a complete walk whose terminal sequence matches the exact
candidate can conclude that nothing is pending. Completed negative results are
never cached; a new revision or process restart starts at zero without clearing
the durable hint. Live partials are not evicted to admit new work: completed
memos free slots first, and a full cache rotates one exact scoped eligibility
check to reclaim a stale holder. A new long proof without a slot yields without
retaining its partial state; short proofs can still complete. Once an admitted
proof completes or becomes ineligible, waiting long proofs can retain progress.
A new candidate replaces an older cached prefix for the same Session.

## Reattachment and policy

Recovery forces a passive load instead of trusting a connector attachment cache.
A generation mismatch follows the connector's existing adoption path; a later
scan retries with the new boot. This also covers channel Sessions with no saved
public Turn boot binding. Passive takeover does not drive an unrelated parked
foreground Turn; that remains the dispatcher's work.

The connector validates a passive response against its currently serving boot
inside the cache slot. It publishes the attachment before its recovery marker,
then changes that marker only while the cache still holds the same ref. A late
old response cannot replace a current attachment or erase its marker, and
generation adoption cannot mistake a not-yet-published ref's marker for an
orphan. The marker phase rechecks the boot after publication and removes an
invalid ref if adoption skipped its earlier unpublished slot. No HTTP call or
connector monitor is held inside those cache operations.

The Harness uses the same six-source classifier for pump selection, blocked
recovery and the prompt park guard. A channel turn's aftermath reuses its own
interruption funnel, including Runtime settlement and file-history cleanup;
it does not use the generic wake error outcome. Recovery requires a proven
prior attempt, preserves queued inputs, and keeps held approvals resolvable.
Transient or unprovable recovery leaves the input pending for another pass.

No age-based cancellation is introduced. An unattempted wake keeps its original
identity and runs through ordinary admission even after a long outage. An
attempted wake uses its existing source-specific crash aftermath: committed
effects are not replayed, unknown outcomes stay honest, and unprovable recovery
remains blocked. Lifecycle and committed cancellation retain their existing
precedence.

The scan uses its own single-thread scheduler, a bounded candidate page and a
durable retry delay. A failing Session moves behind other due candidates. There
is no permanent attempt limit for discovering an already committed input. Source
relay give-up states remain unchanged: the scan does not re-admit an input that
never committed, or upgrade an unknown source receipt into success. Each failure
names its tenant and Session in the server log.

Proof still reads the complete history after a new journal revision or process
restart, across bounded invocations. Total work grows with history length, partial proofs retain Turn identities, and a full cache delays
admission of new long proofs. The per-invocation transaction bound is not a
database query timeout or a byte bound on retained continuation state. Candidate filtering may visit
live-writer, HARNESS, closed, retired and CSI historical heads; those index
entries need not converge away. The candidate page bounds returned rows, not
index traversal. Large catalogs and histories can therefore still delay recovery.
Durable incremental proof and catalog cleanup remain capacity work. Lifecycle
cleanup must not bless unexamined history for a state that can later become
eligible again.

MQ continues to accelerate first discovery. Its `wake_covered_sequence` is only
notice deduplication; an `OWNED`, duplicate, failed or dropped notice cannot hide
SQL-pending work from this scan.

## Validation and acceptance

1. Reproduce writer loss with a real Harness, control plane and disposable MySQL
   8.4; record the committed input, lease expiry, boot change and absence of a
   replacement load. A later explicit load is the positive control.
2. After the fix, restart without sending input. Pending supported wake inputs
   are automatically loaded after the old writer lease expires and a due scan
   succeeds. A fixture model provides deterministic requests and settlement.
3. Exercise EventTransport off and on, including a notice consumed before lease
   expiry and a claimed notice whose load failed. The journal remains the source
   of truth in all cases.
4. Cover settlement, multiple inputs, old/stale hints, rollback, concurrent
   admission and claim, tenant/Workspace separation, live writers, lifecycle,
   private CSI, stopped children, stale attachments and transient failures.
   Long journals must yield, preserve both Turn sets and sequence continuity,
   resume to completion, and retain their hint across restart or head changes.
   Compacted heads must be excluded without certifying consumption.
5. Run affected Java tests, full Maven verification, the matching MySQL and
   Hosted recovery profiles. Any fixture source production or unavailable
   provider/platform acceptance is reported explicitly.

The normal single-Session recovery delay is the remaining writer lease plus the
retry delay and scan/load time. Backlog, an unavailable Harness, revoked grants,
an unreadable journal or a blocked Runtime can extend it; recovery does not claim
a successful outcome while those conditions persist.

## Initial implementation validation

Before the review fixes, the complete Java unit run executed 4,670 tests with zero failures/errors and
18 predefined skips. Eleven isolated MySQL tests cover discovery, exact
settlement, revision races, durable claims and the Session-before-head lock
order. Checkstyle, SpotBugs, the latest-main root build/bundle and Markdown
formatting/reference checks pass.

Validation of subsequent review fixes is recorded on
[PR #14603](https://github.com/QwenLM/qwen-code/pull/14603). The initial counts
below do not establish validation of those later changes.

Real Spring/MySQL/Harness process probes reproduce the missing automatic load
and verify monitor, actual Automation define/fire and actual channel input
recovery without new input. The final Automation artifact run recovers in
34,807 ms, follows an old-boot 409 with an automatic new-boot 200, and retains
one input/model/settlement after another 35 seconds. An interrupted attempted
Automation settles with `outcome_unknown` without repeating its model request.
A claim followed by a completed public close now rejects ordinary writer
acquisition with `managed_session_not_writable`; the head and model count do
not advance.

The matching Hosted/MySQL and process-crash profiles pass, including coordinator
restart and six physical fault cuts at Harness prepare/start/result, Spring
termination, worker termination and worker pause. Cold recovery remains blocked
without replaying tools. The fault fixture registers native storage on both
already-supported Linux and macOS; identity verification stays enabled.

Monitor input production in these wake probes is a fixture. Generic journal
tests cover all six source names; they do not establish physical background
Shell production, child/workflow/message relationship acceptance, external
channel delivery or real MQ-on behavior. Those and deployed/cross-platform
acceptance remain separate validation work.
