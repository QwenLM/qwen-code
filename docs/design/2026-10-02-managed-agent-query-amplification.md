# Managed Agent Query Amplification Fix

[English](2026-10-02-managed-agent-query-amplification.md) | [简体中文](2026-10-02-managed-agent-query-amplification.zh-CN.md)

## 1. Status and problem

Proposed; tracks GitHub issue #13181 (audit of `main` at a7deb01bcb).

Four hot paths in the Managed Agent Runtime Broker amplify database work far
beyond request volume, two of them while holding row locks:

1. `ManagedAgentStore.materializeNextBatch` rewrites the whole
   `managed_agent_snapshot.items_json` after every ≤200-event batch, inside
   the `requireSessionForUpdate` row lock that event ingestion also needs.
   Write volume grows quadratically with session length.
2. `ManagedEventStreamService` runs `requireReadGrant` →
   `ManagedWorkspaceRegistry.canRead` (SQL) before nearly every event, per
   subscriber.
3. `ManagedAgentService.listPublicSessions` / `listWebShellSessions` run 2-3
   per-row queries (`findActiveTurn` / `findSnapshotCoveredSequence` /
   `findLatestTurn` / `findLatestEnvironmentEvent` / `approvalMode`) on top
   of the page query.
4. `ToolPublicationStore.producerBindingLocked` rescans the session journal
   backwards to the last `activation.changed` (one
   `SELECT ... FOR UPDATE` per revision) on every publish/seal/prefix/finish,
   while holding the publication and tenant locks.

Related: `ManagedArtifactService.content` re-runs a multi-table permission
check per 64 KiB chunk, and seal/finish re-read and re-hash the whole stream
on the HTTP request thread.

## 2. Scope and invariants

In scope: the four numbered paths plus the artifact download check. The
public API shapes, the event/journal record formats, and fail-closed
authorization semantics do not change. The accepted relaxations, both
explicitly sanctioned by the issue, are bounded staleness: permission
decisions may be reused within a revalidation window (5 seconds by default,
operator-configurable with no enforced upper bound; `PT0S` restores per-event
checks), and the snapshot may lag the projection during bursts but converges
once ingestion pauses (bounded by the same 5-second snapshot cadence).

Out of scope: splitting `ManagedAgentStore`, and moving the seal/finish
byte-rehash off the request thread. The rehash is an integrity commitment
over mutable object storage; making it asynchronous changes the seal API
contract (clients would have to poll `operationStatus`). The database side of
that path is fixed here but opt-in at runtime: its heartbeat
re-authorization becomes O(1) via Section 6 once an operator enables
`journal-head-authorization` after the fleet fully runs the V36 code (the
rollout is Section 9; the flip itself is tracked by the follow-up issue
#13295); until then the heartbeat pays the legacy journal scan, unchanged
from before. The contract change is tracked by the follow-up issue #13242.

## 3. Snapshot rewrite gating

`materializeNextBatch` keeps per-event projection into the item tables and
the consumer-progress update exactly as today, but rewrites the snapshot only
when one of the following holds:

1. no snapshot row exists yet (the insert path, unchanged);
2. the batch carries a terminal event — a Turn always ends rewritten, so
   reads converge at Turn boundaries;
3. the projection advanced at least `SNAPSHOT_REFRESH_EVENTS` (1000) events
   since the snapshot's `covered_sequence`;
4. the batch caught up with `session.last_sequence` (the session row is
   locked `FOR UPDATE` for the whole batch, so this comparison is stable)
   AND at least `SNAPSHOT_REFRESH_MILLIS` (5000) elapsed since the last
   snapshot write — the trickle case (a batch smaller than one scheduler
   tick's `EVENT_LIMIT`) must not rewrite per tick.

A drained batch that rule 4 defers leaves the snapshot behind the projection
while the consumer progress already covers it, so the deferral is recorded on
the progress row: the batch's progress update sets `snapshot_stale_since` to
the snapshot's `updated_at` (migration `V38`), and
`findMaterializationTargets` re-selects a session whose marker is at least
`SNAPSHOT_REFRESH_MILLIS` old; the re-selected (empty) tick converges the
snapshot and clears the marker. Without the reselection an idle caught-up
session would never be revisited and the snapshot would stay stale forever;
the marker keeps the tick's scan free of a per-row snapshot lookup.

All snapshot readers (`listPublicItems`, `transcript`, SSE resync frames,
`advanceReplayFloor`) already key off the snapshot's own `covered_sequence`,
so a staler snapshot is self-consistent; `transcript` additionally tails
events past the snapshot (the cursor-less page serves every event after the
snapshot, as the published contract promises, so the stream can resume at
the reported watermark with no band unserved), so a WebShell stream's event
view does not lose freshness — its items array is the snapshot's and lags
by the same bound Section 9 states for `listPublicItems`.

## 4. SSE read-grant recheck window

Each stream caches its read grant and rechecks at most once per
`qwen.managed-agent.events.read-grant-recheck-interval` (new
`ManagedAgentProperties.Events` duration, default `PT5S`, `PT0S` restores
per-event checks). The initial `requireReadableSession` on subscription is
unchanged. A revoked subscriber may receive events for up to one window; a
`session.deleted` event still terminates the stream immediately, and a failed
recheck completes the stream as today. The recheck runs when the stream loop
iterates, so an idle stream's closure additionally waits for its next loop
wake — at most one `events.poll-interval` (5s by default) past the window.
Per-subscriber cost drops from up to two `canRead` queries per event to one
per window.

## 5. Session list batch assembly

The page query stays as is; per-row lookups move into grouped batch queries
added to `AgentStateStore` / `ManagedAgentStore`:

- `findActiveTurns(tenant, sessionIds)` — one query, first row per session
  after `ORDER BY created_at DESC` (ties remain unspecified, as today).
- `findSnapshotCoveredSequences(tenant, sessionIds)` — one `IN` query.
- `findLatestTurns(tenant, sessionIds)` — one query joining the turn rows
  to each session's latest `turn.accepted` event (`MAX(sequence_id)`
  derived table), preserving the single-session `findLatestTurn` semantics
  including the turn-row existence join. Migration `V37` adds
  `managed_agent_event (tenant_id, session_id, event_type, sequence_id)` so
  it reads index ranges instead of a session's whole event history.
- `findLatestEnvironmentEvents(tenant, turns)` — one query selecting each
  session's latest environment event on its latest Turn in SQL (a
  `MAX(sequence_id)` derived table filtered to the (session, turn) pairs),
  so exactly one row per session is read.
- `completedWorkspaceCloses(tenant, sessionIds)` — one `IN` query over
  `managed_agent_operation`, fetched only when the page holds
  workspace-bound sessions, feeding the archive/unarchive/delete
  capability flags without a per-row read.

Both turn reads project only `TURN_SUMMARY_COLUMNS` (`session_id, turn_id,
status, created_at, completed_at, error_code`) — exactly what the public and
WebShell views expose — so a page never Jackson-parses or retains a prompt
graph per row. The approval mode needs no query of its own: every
`sessionMapper` read is a `SELECT *` over `managed_agent_session`, so the
mapper now maps `approval_mode` onto `SessionRecord` and `hasActions` reads
it from the row the page already fetched.

A page of unbound sessions costs at most 3 queries on either surface, and a
page of workspace-bound sessions costs one more for the close-state batch;
a WebShell page carrying submit-shaped sessions adds one creator-marker
batch, and one grant batch when it also holds creator-owned ones — all
independent of page size. The single-session views
(`publicSession`, `webShellSession`) delegate to the same assembly with
singleton inputs, so there is one code path. The single-session store reads
(`findActiveTurn` / `findLatestTurn` / `findLatestEnvironmentEvent`,
`findSnapshotCoveredSequence`) had no production callers left and are
removed, so each selection rule has exactly one spelling; the close-state
predicate likewise has one spelling, the singular `hasCompletedWorkspaceClose`
delegating to the batch twin.

## 6. Publication authorization O(1)

Migration `V36` adds five nullable columns to
`qwen_managed_session_journal_head`: `activation_id`, `activation_phase`,
`activation_event_epoch`, `activation_expires_at`, and
`activation_head_revision`. `ManagedSessionStore.commit` collects the last
in-range `activation.changed` payload during the extension-record parse pass
that every commit already runs (no extra decode of the record bytes) and
writes its fields into the head in the same single head `UPDATE` that bumps
`journal_revision`; the stamp `activation_head_revision = journal_revision`
is written on every activation-carrying commit, and on any other commit
only when the preserved columns were current at the previous revision — a
commit that keeps columns whose stamp already lags leaves the stamp
lagging, so a skew left by a pre-V36 writer is never re-stamped into
looking fresh. The head row therefore carries the journal's current
activation state under the same lock discipline, and the stamp says which
journal revision the columns reflect: a commit from a binary that does not
maintain the columns still bumps `journal_revision`, so its head fails the
stamp equality check and authorization rescans the journal — the rolling
window is self-healing, since the scan's backfill rewrites the columns and
re-stamps them. `expiresAt` may be absent from the payload (`timeOrNull`); a NULL
column then fails the freshness check exactly like the journal scan reading
the value as absent does. All three readers of the payload's `expiresAt` (the
commit extraction and the two backfill scans) share one lenient helper — an
integral number or an integral numeric string of at most 19 integer digits
and at most 19 decimal places, else absent, with width and scale pre-checks
before any BigInteger materialization so an exponent-form string costs
nothing in either direction (1e+N needs the giant integer, 1e-N expands
10^N before dividing) — so the scan and the head columns can never disagree
about representability.

While a rolling fleet can still run a pre-V36 binary — which commits without
maintaining the columns — the head is not yet trustworthy, so
`qwen.managed-agent.tool-publication.journal-head-authorization` (default
`false`) keeps authorization on the journal scan. Once every writer runs the
V36 schema's code, an operator flips the flag and:

`ToolPublicationStore.producerBindingLocked` checks the head columns it
already read `FOR UPDATE` — phase is `active`, the id and event epoch match
the binding, `activation_expires_at` is in the future, and the stamp matches
the head's `journal_revision` — instead of the backward journal scan. When
the columns are NULL or the stamp lags (journals written before the
migration, journals that never committed an activation change, a payload
wider than the columns, which the commit blanks rather than rejecting, or
residue from a pre-V36 commit), it runs the legacy scan once and backfills
the head from the found event — skipping the write when the columns already
hold exactly those values — so every session becomes O(1) after its first
post-migration authorization or its next activation change. `verifyDispatch`
and the seal/prefix/finish heartbeats all flow through
`producerBindingLocked`, so they all become O(1).

`ToolPublicationStore.requireEvidence` (reserve/renew) takes the activation
state from the already locked head via the extended `PublicationWriter`
record — before reading anything else, so a fenced activation pays no journal
statement at all — and reads the `tool.intent` at its own revision directly:
the binding carries `intentSequence`, so one indexed range read over
`last_sequence` (migration `V39`) resolves the revision, one verified page
fetches it, and one indexed count (bounded by the same byte-length tripwire
the legacy walk applied per revision) proves the chain from that revision
up to the locked head is gap-free. The statement count is constant — four
journal statements regardless of journal depth — while the locate's row
cost grows with the distance between the intent and the head, exactly as
the legacy walk's did (it paid the same distance in full locked row reads,
so the head path is strictly lighter, not asymptotically constant).
Legacy rows keep the previous combined scan, backfilling the head
on success.

## 7. Artifact download revalidation throttle

`ManagedArtifactService.content` keeps its per-call read-timeout guard but
re-runs `requireContentAccess` (session row + workspace grant + policy) at
most once per
`qwen.managed-agent.artifacts.read-revalidation-interval` (new duration,
default `PT5S`). The initial check before streaming starts is unchanged, so
revocation latency is bounded by one window instead of being re-evaluated per
64 KiB chunk.

The window throttles the whole of `requireContentAccess`, which includes the
session-lifecycle gate: a session that enters stage-1 `DELETING` mid-download
is likewise observed only at the next window boundary, not at the next chunk
(stage-2 retirement still aborts per chunk through the read lease). This
deferral is accepted for the same bounded-staleness reason as the grant
recheck; the read-timeout guard still caps any download at
`read-timeout`. `ReadLease.check()` deliberately does not take over the
lifecycle check: it is shared by the retention and producer paths that must
keep reading the rows of a session being deleted.

## 8. Validation and acceptance

- `Issue13181QueryBudgetTest`'s `QueryLedger` (a `DataSource` proxy counting
  prepared statements) pins per-endpoint query budgets: a 20-session page of
  `listPublicSessions` ≤ 3 queries (4 for workspace-bound rows, adding the
  close-state batch) and `listWebShellSessions` ≤ 3 (a bound page whose
  submit-shaped sessions include creator-owned ones costs 6 — page, latest
  turns, environment events, close-state, creator-marker, grant; 5 when the
  page carries no Turns and the environment-event batch is skipped), with the
  batch turn reads asserted to project the summary column list and the
  admission-order selection rules exercised through the page (a two-Turn
  session admitted out of `created_at` order with inverted environment-event
  sequences). `materializeNextBatch` rewrites the snapshot at most once per
  1000 covered events during a burst, at most once per
  `SNAPSHOT_REFRESH_MILLIS` on a drained trickle, always on a terminal event,
  and a deferred snapshot is pinned to converge on the aged-out reselection.
  `verifyDispatch`/`publish` after an activation commit read
  `qwen_managed_session_journal_tx` zero times (seal/prefix/finish share the
  same `producerBindingLocked` path), and a fenced renew pays no journal
  statement at all. `renew` reads the intent at its own revision, a constant
  4 journal statements regardless of filler depth (the range read, the
  chain-contiguity count, and the verified page). The
  artifact revalidation window is pinned separately by policy-call counts in
  `ManagedArtifactReadIntegrationTest`, including the deferred stage-1
  `DELETING` observation.
- `ManagedEventStreamServiceTest` keeps the revocation test at a zero window
  and gains windowed tests counting `canRead` invocations across events: the
  window covering a delivery, a revocation landing when it lapses, a
  successful recheck re-anchoring the window, and the shipped 5-second
  default exercised through the null-sentinel path (the value itself pinned
  in `ManagedAgentPropertiesTest`).
- Existing suites must pass unchanged otherwise: `ToolPublicationStoreTest`
  (activation fencing now exercises the head columns through
  `sessions.commit`, and the intra-record ordering of both backward journal
  scans), `ManagedAgentApiIntegrationTest`,
  `ManagedAgentMySqlIT`, `RuntimeBrokerFlywaySchemaTest`.
  `ManagedArtifactReadIntegrationTest` gained the window tests and a shared
  setup extraction for them.
  `ManagedAgentServerIntegrationTest` is the deliberate exception: the
  materializer's 10ms tick races its explicit drains, so its transcript
  catch-up wait budget rose to 15s (the deferred snapshot converges within
  one `SNAPSHOT_REFRESH_MILLIS`), and two snapshot-content tests
  (`preservesTextOrderAcrossToolsAndReasoningInSnapshots`,
  `singleAppendsContinueTheTextPartBeforeThem`) mark their trailing fixture
  event terminal so the explicit drain always rewrites — both assertions
  are unchanged.
- Acceptance: the pinned budgets hold, no test outside the deliberately
  updated revocation semantics changes its expectations, and the legacy
  fallback still authorizes a pre-migration journal (covered by a test that
  nulls the new columns).

## 9. Risks and follow-up

- Bounded-staleness relaxations (Sections 4 and 7) are deliberate; both
  intervals default to 5 seconds and are operator-configurable durations with
  no enforced upper bound (`PT0S` restores the strict per-event behaviour),
  so a deployment may widen the accepted staleness by configuration.
- A snapshot that lags during bursts delays `listPublicItems` freshness by up
  to 1000 covered events; reads converge at Turn boundaries and, for a
  drained trickle, within `SNAPSHOT_REFRESH_MILLIS` via the reselection rule.
- The legacy scan fallback in Section 6 keeps the old cost for
  pre-migration journals until their first authorization or activation
  change; this is intentional to avoid a data migration over journal bytes.
- Rolling deployment: a pre-V36 binary commits without maintaining the head
  activation columns, so the columns can go stale while old binaries still
  write. The `activation_head_revision` stamp records which journal revision
  the columns reflect, so such a head fails the stamp check and authorization
  rescans the journal and re-backfills — a premature flag flip self-heals per
  session instead of certifying stale state. The
  `journal-head-authorization` flag (default off) still ships as the
  deliberate operator switch; enable it once the fleet fully runs the V36
  code, knowing residual skew is detected and repaired rather than trusted.
- The head path's chain proof (Section 6) is a count with the legacy walk's
  byte-length tripwire, not a per-line parse of the intermediate revisions:
  a line carrying a foreign scope in a journal written before this change
  would be caught by the legacy scan but not re-read after the head is
  backfilled. Commits now reject any misscoped or unknown-version event
  line (an `activation.changed` line is the only one whose payload the head
  persists), so the residual is confined to journals already written by a
  misbehaving writer — and such a writer could equally have written
  correctly scoped forgeries.
- Follow-up: move the seal/finish stream rehash off the request thread
  (requires an asynchronous seal contract — issue #13242), and consider
  splitting `ManagedAgentStore` as noted in the issue.
