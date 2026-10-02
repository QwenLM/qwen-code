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
that path is still fixed here: its heartbeat re-authorization becomes O(1)
via Section 6. The contract change is tracked by the follow-up issue #13242.

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
while the consumer progress already covers it, so
`findMaterializationTargets` also re-selects a session whose snapshot lags
its progress once the snapshot ages past `SNAPSHOT_REFRESH_MILLIS`; the
re-selected (empty) tick converges the snapshot. Without the reselection an
idle caught-up session would never be revisited and the snapshot would stay
stale forever.

All snapshot readers (`listPublicItems`, `transcript`, SSE resync frames,
`advanceReplayFloor`) already key off the snapshot's own `covered_sequence`,
so a staler snapshot is self-consistent; `transcript` additionally tails
events past the snapshot, so WebShell reads do not lose freshness.

## 4. SSE read-grant recheck window

Each stream caches its read grant and rechecks at most once per
`qwen.managed-agent.events.read-grant-recheck-interval` (new
`ManagedAgentProperties.Events` duration, default `PT5S`, `PT0S` restores
per-event checks). The initial `requireReadableSession` on subscription is
unchanged. A revoked subscriber may receive events for up to one window; a
`session.deleted` event still terminates the stream immediately, and a failed
recheck completes the stream as today. Per-subscriber cost drops from up to
two `canRead` queries per event to one per window.

## 5. Session list batch assembly

The page query stays as is; per-row lookups move into grouped batch queries
added to `AgentStateStore` / `ManagedAgentStore`:

- `findActiveTurns(tenant, sessionIds)` — one query, first row per session
  after `ORDER BY created_at DESC` (ties remain unspecified, as today).
- `findSnapshotCoveredSequences(tenant, sessionIds)` — one `IN` query.
- `findLatestTurns(tenant, sessionIds)` — one query joining the turn rows
  to each session's latest `turn.accepted` event (`MAX(sequence_id)`
  derived table), preserving the single-session `findLatestTurn` semantics
  including the turn-row existence join. Migration `V35` adds
  `managed_agent_event (tenant_id, session_id, event_type, sequence_id)` so
  it reads index ranges instead of a session's whole event history.
- `findLatestEnvironmentEvents(tenant, turns)` — one query over the
  (session, turn) pairs, first per session by descending sequence.
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
page of workspace-bound sessions costs one more for the close-state batch —
independent of page size in all cases. The single-session views
(`publicSession`, `webShellSession`) delegate to the same assembly with
singleton inputs, so there is one code path. The single-session store methods `findActiveTurn` / `findLatestTurn` /
`findLatestEnvironmentEvent` (which keeps its `session_not_found` guard) are
one-line delegations to the batch twins, so each selection rule has exactly
one spelling; `findSnapshotCoveredSequence` had no callers and is gone.

## 6. Publication authorization O(1)

Migration `V34` adds four nullable columns to
`qwen_managed_session_journal_head`: `activation_id`, `activation_phase`,
`activation_event_epoch`, `activation_expires_at`. `ManagedSessionStore.commit`
collects the last `activation.changed` payload during the extension-record
parse pass that every commit already runs (no extra decode of the record
bytes) and writes its fields into the head in the same transaction that
appends the journal transaction and bumps `journal_revision`. The head row
therefore carries the journal's current activation state under the same lock
discipline. `expiresAt` may be absent from the payload (`timeOrNull`); a NULL
column then fails the freshness check exactly like the journal scan reading
the value as absent does. All three readers of the payload's `expiresAt` (the
commit extraction and the two backfill scans) share one lenient helper — an
integral number or an integral numeric string, else absent — so the scan and
the head columns can never disagree about representability.

While a rolling fleet can still run a pre-V34 binary — which commits without
maintaining the columns — the head is not yet trustworthy, so
`qwen.managed-agent.tool-publication.journal-head-authorization` (default
`false`) keeps authorization on the journal scan. Once every writer runs the
V34 schema's code, an operator flips the flag and:

`ToolPublicationStore.producerBindingLocked` checks the head columns it
already read `FOR UPDATE` — phase is `active`, the id and event epoch match
the binding, and `activation_expires_at` is in the future — instead of the
backward journal scan. When the columns are NULL (journals written before the
migration, journals that never committed an activation change, or a payload
wider than the columns, which the commit blanks rather than rejecting), it
runs the legacy scan once and backfills the head from the found event, so
every session becomes O(1) after its first post-migration authorization or
its next activation change. `verifyDispatch` and the seal/prefix/finish
heartbeats all flow through `producerBindingLocked`, so they all become O(1).

`ToolPublicationStore.requireEvidence` (reserve/renew) takes the activation
state from the already locked head via the extended `PublicationWriter`
record, and reads the `tool.intent` at its own revision directly: the binding
carries `intentSequence`, so one range read over
`first_sequence`/`last_sequence` resolves the revision and one verified page
fetches it, keeping the per-revision chain check for that revision. Legacy
rows keep the previous combined scan, backfilling the head on success.

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
  close-state batch) and `listWebShellSessions` ≤ 3, with the
  batch turn reads asserted to project the summary column list and the
  admission-order selection rules exercised through the page (a two-Turn
  session admitted out of `created_at` order with inverted environment-event
  sequences). `materializeNextBatch` rewrites the snapshot at most once per
  1000 covered events during a burst, at most once per
  `SNAPSHOT_REFRESH_MILLIS` on a drained trickle, always on a terminal event,
  and a deferred snapshot is pinned to converge on the aged-out reselection.
  `verifyDispatch`/`publish` after an activation commit read
  `qwen_managed_session_journal_tx` zero times (seal/prefix/finish share the
  same `producerBindingLocked` path); `renew` reads the intent at its own
  revision, a constant 3 journal statements regardless of filler depth. The
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
  scans), `ManagedAgentServerIntegrationTest`,
  `ManagedArtifactReadIntegrationTest`, `ManagedArtifactApiIntegrationTest`,
  `ManagedAgentMySqlIT`, `RuntimeBrokerFlywaySchemaTest`.
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
- Rolling deployment: a pre-V34 binary commits without maintaining the head
  activation columns, so the columns can go stale while old binaries still
  write. Authorization therefore reads the journal until
  `journal-head-authorization` is enabled; enable it only after the fleet
  fully runs the V34 schema's code, and leave it off while a rollback to a
  pre-V34 binary remains possible.
- Follow-up: move the seal/finish stream rehash off the request thread
  (requires an asynchronous seal contract — issue #13242), and consider
  splitting `ManagedAgentStore` as noted in the issue.
