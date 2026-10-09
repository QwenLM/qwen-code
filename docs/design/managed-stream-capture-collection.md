# Stream-capture output collection (O4 extension, P1)

[English](managed-stream-capture-collection.md) | [简体中文](managed-stream-capture-collection.zh-CN.md)

## Problem and baseline

O4 (`managed-tool-output-retention.md`) made the physical collection of tool
output safe, and covers only `qwen_tool_publication` rows — the foreground Shell
O2 publications. #13265 (H3) turned background Shell into a second real
producer. Its bytes do not enter the publication protocol. Each segment, page
and manifest is sent to `POST /tool-results:publish`
(`ManagedSessionStore.publishToolResult`) and lands in
`qwen_managed_session_resource` as a row with `state = 'PUBLISHED'`,
`storage_kind = 'MYSQL_INLINE'` and one of the kinds
`managed-tool-result-content` (up to 1 MiB), `managed-tool-result-page` (up to
256 KiB) or `managed-tool-result-manifest` (up to 64 KiB). Foreground Shell
stream leftovers share the same shape.

No production code path ever deletes a `qwen_managed_session_resource` row.
The table has carried an unused `retention_until` column since V4; the only
path that frees inline bytes is the O4-2 collector's clear of copies cataloged
to a collected publication, which reaches `REFERENCED` rows and never the
`PUBLISHED` stream-capture rows this pass targets. Even with `gc-enabled =
true`, a
long-running background Shell keeps every byte it ever produced: with hosted
storage these rows sit `MYSQL_INLINE` in MySQL (foreground leftovers and
background captures alike). The Session-rooted retirement tombstone
(`qwen_output_session_retirement`, V30) already proves the writer is closed
when a Session is permanently deleted; what is missing is the collection pass
that frees these rows' bytes under the same policy. This is #13534 P1.

Baseline: `main` = `4a3b8f3c08`. The V30/V34 lifecycle (`PINNED → RETIRING →
DELETING → COLLECTED`), the candidate predicate in
`ToolPublicationRetentionStore.candidate`, and the `ToolPublicationCollector`
claim/page/confirm shape stay unchanged.

## Contract and scope

The Session remains the retention root. A stream-capture output stays pinned
through close, archive, Runtime draining and event expiry, exactly like an O4
publication. Permanent Session deletion writes the existing tombstone; after
the same `deletion-grace` (default 24h) and the same proof that no reader,
writer or recovery depends on the bytes, the collection pass drops the byte
copies of that Session's stream-capture rows. Identity rows
(`resource_id`, `kind`, `byte_length`, `sha256`, `publish_command_id`,
timestamps, journal reference ledger) are never deleted.

Rows eligible for collection, per row:

- `qwen_managed_session_resource` with `state = 'PUBLISHED'`,
  `storage_kind = 'MYSQL_INLINE'`, `schema_version = 1`, NULL
  `object_key`/`object_version_id`/`encryption_key_id`, `inline_bytes` still
  present, and `kind` in the three `managed-tool-result-*` kinds above with
  `byte_length` inside the fail-closed per-kind bounds `toolResultLimit`
  already enforces (content ≤ 1 MiB, page ≤ 256 KiB, manifest ≤ 64 KiB). A
  row violating any of these layout invariants can only arise from
  corruption, which the fail-closed read instruments protect as evidence; the
  pass never byte-drops it. The presence clause guards the accounting rather
  than the byte drop: `byte_length` is metadata that outlives the bytes, so a
  row another writer already freed must not be counted a second time;
- its Session has a retirement tombstone whose `recovery_protected` is false
  and whose `retired_at + deletion-grace` has elapsed;
- no unexpired `qwen_output_read_lease` exists for the Session;
- no in-flight workspace-recovery operation (`CAPTURING` or `VERIFYING`)
  pins the Session — recovery byte reads take no read lease, so the lease
  check cannot see them;
- no `qwen_managed_session_resource_ref` row names the resource.

Rows outside the predicate stay pinned and keep all bytes, conservatively and
permanently:

- `state = 'REFERENCED'` rows. These belong to committed transactions and to
  the tool-publication admission copies; the O4-2 collector nulls the bytes
  only of rows cataloged in `qwen_tool_publication_object` by a collected
  publication, and a manifest committed through a plain transaction is not
  cataloged there.
- Monitor observation outputs (kind `managed-monitor-observation`), MCP
  records, media objects, checkpoints and every other kind.
- PUBLISHED rows that carry a journal reference. The sealed manifest of
  every committed Shell capture is exactly such a row — the foreground receipt
  carries `resources: [manifestRef]`, and a background capture's manifest
  arrives as `child_run.outputRef` — so it is pinned permanently: P1 frees
  segment, page and content bytes only, and the "sealed manifest" deliverable
  of #13534 stays open for a follow-up that collects journal-referenced rows
  without breaking the CSI invariant. Requiring the absence of
  `qwen_managed_session_resource_ref` protects the CSI checkpoint snapshot —
  its snapshot requires every reference row to resolve against a live
  resource.
- Any row violating a layout invariant: an unknown `storage_kind`, a
  non-NULL `object_key`/`object_version_id`/`encryption_key_id`, a wrong
  `schema_version`, or a `byte_length` column outside the per-kind bounds.
  `verifyStoredResource` keeps failing closed for these; the collection pass
  never clears their bytes. The predicate never compares the stored blob
  against `byte_length` or `sha256`, though: a row whose bytes no longer match
  their own metadata is collected like any other, and afterwards the
  corruption `verifyStoredResource` would have reported is no longer visible
  anywhere.

Row state vocabulary gains one value: `COLLECTED`. A row in `COLLECTED` state
keeps its metadata with `inline_bytes = NULL` and never returns to another
state. TTL-style time-based collection outside permanent Session deletion is
not added: `retention_until` stays unused.

## Collection and accounting

One new table records one collection ledger per Session scope
(migration V56):

```
qwen_managed_session_resource_collection
  session_scope_key CHAR(64) PRIMARY KEY
  tenant_key CHAR(64), session_key CHAR(64)
  tenant_id VARCHAR(128), session_id VARCHAR(512)   -- audit copies
  gc_generation BIGINT          -- claim fencing, mirrors gc_generation
  gc_owner VARCHAR(36) NULL     -- collection instance identity (UUID per process)
  gc_claim_until BIGINT         -- milliseconds; 60-second claim budget
  gc_next_at BIGINT             -- due time for the next attempt; -1 once collected
  gc_cursor VARCHAR(512)        -- last collected resource_id ('' at start)
  gc_blocker VARCHAR(64) NULL   -- last evaluated blocker, for observation
  collected_at BIGINT NULL
  collected_bytes BIGINT NOT NULL DEFAULT 0
  created_at DATETIME(6)
```

Completed rows leave `gc_next_at = -1`, outside the claim scan's
`gc_next_at >= 0` range, so the per-tick scan stays proportional to unfinished
work although ledger rows are kept forever. V56 also adds
`idx_output_session_retirement_due (retired_at)` so the due-candidate scan
(`r.retired_at <= now - grace`) is index-served: tombstones are never deleted,
and an unindexed scan would otherwise cost O(retired Sessions) on every
60-second cadence pass forever. It also adds
`idx_workspace_recovery_session_session (session_id, operation_id)` on
`managed_workspace_recovery_session`: the page-time recovery re-check below
probes that table by `session_id` with a locking read, and its only key is
`(operation_id, session_id)`, so an unindexed probe would next-key-lock the
whole table behind every 1 Hz page.

The collector mirrors `ToolPublicationCollector`: one bounded pass per tick on
the existing single-thread `managedToolOutputScheduler`, so blob-heavy UPDATEs
never hold the live-session scheduler.

1. A ledger row is created when a tombstone for the Session first becomes due
   (`retired_at + deletion-grace <= now`), during a scan that examines at most
   32 due candidates, oldest `retired_at` first, and runs at a 60-second
   cadence per instance. A Session becomes collectible within about a minute
   after its grace elapses once the due backlog is empty; after a mass
   retirement or the first enablement on a fleet with deep retirement history,
   the backlog drains into collection at roughly 32 Sessions per minute per
   instance. The coarse cadence caps the cost of the history-wide scan (open
   question 3).
2. A claim re-evaluates eligibility under the tenant and Session locks
   (`ToolPublicationRetentionStore.lockSession`): the tombstone row is present
   with matching identity, the journal head is absent (a closed writer —
   publishing requires one and retirement fences its creation) or reads
   `state = 'DELETED'`, `recovery_protected` is false, grace has elapsed, no
   unexpired read lease exists, and no in-flight recovery operation pins the
   Session. The blockers are `session_not_retired`, `recovery_protected`,
   `grace_period`, `session_head_live` (a live, non-`DELETED` head),
   `reader_active` and `recovery_active` (a `CAPTURING` or `VERIFYING`
   recovery or migration operation pinned the Session). Each failure
   reschedules with the
   same backoff taxonomy as the publication collector: `recovery_protected`
   waits 24 hours, `grace_period` waits until `retired_at + grace`, and every
   other blocker waits 60 seconds.
3. A confirmed claim holds the ledger for 60 seconds. Each page runs in its
   own new transaction: claim's locks and blocker evaluation committed with
   claim's transaction, so the page first re-takes the tenant and Session
   locks in claim's order and re-evaluates the recovery pin — the one blocker
   that can be born inside the claim→page gap — with a locking read, because a
   plain re-read under REPEATABLE READ stays pinned to the page transaction's
   snapshot and cannot see a registration that committed in the gap. A page
   that now meets a live recovery defers exactly like a claim-time blocker.
   Only then does the page select up to 100 eligible rows after `cursor`,
   stop early if their byte total exceeds 32 MiB, flip those rows to
   `COLLECTED` with `inline_bytes = NULL`, add their `byte_length` sum to
   `collected_bytes`, and advance `cursor` to the last collected resource_id.
   The byte-presence clause of the eligibility predicate lives on the
   byte-drop UPDATE, not on the page SELECT: naming the BLOB column in the
   SELECT would make InnoDB materialize every candidate's bytes (up to 101
   MEDIUMBLOB rows) just to test them for NULL on the shared single-threaded
   scheduler, while the UPDATE side resolves through the resource primary key.
   The byte budget matters: content rows can reach 1 MiB and MEDIUMBLOB
   updates are not free. All effects are in one transaction; a crash never
   leaves rows half-collected, and there is no out-of-transaction step because
   no object-store write or delete exists for these rows.
4. The page that finds no more eligible rows after `cursor` closes the claim:
   it sets `collected_at`, clears `owner`/`claim_until`, and leaves
   `collected_bytes` as the permanent accounting. The ledger row is retained
   forever, like the collected publication catalog rows. Eligible-row sums can
   legitimately be zero for a Session that never ran stream captures.

No quota is released: `PUBLISHED` rows carry no `capture_held_bytes`-style
charge anywhere. `collected_bytes` is the sum of the `byte_length`
metadata of the rows dropped — equal to the bytes actually freed for every row
the producer wrote, and able to exceed it for a row whose blob no longer
matches its own metadata — which deployment observes through the collector
log. A blocked ledger keeps the full
charge in place and records its blocker, matching the observer model of the
publication collector.

Claim fencing uses the same proof as `ToolPublicationCollector`: an expired
claim is taken over only through the original owner/generation fence
(`generation + 1` and `owner = self`), so two broker instances can never
collect the same page twice. `collected_bytes` advances only inside a page
transaction that also advances `cursor` and `generation`-checked ownership, so
bytes are released exactly once.

## Outcome after collection

Retained references must resolve to an accurate outcome instead of an
unreadable or corrupt reference. One gating fact shapes every surface: a row
can only become `COLLECTED` after its Session is tombstoned and its journal
head is `DELETED`, and every `ManagedSessionStore` funnel is fenced before it
reaches a row — `requireLive` throws `tool_output_session_retired` for any
Session with a tombstone, and writer paths require an `ACTIVE` head. The
outcome surfaces are therefore:

- `ManagedSessionStore` read and write surfaces (`readResource`,
  `publishToolResult`, commit paths): unchanged — they answer exactly what a
  retired Session always answered (`tool_output_session_retired` /
  writer conflict). The accurate "retired" outcome for a collected run is the
  pre-existing Session-level fence; no new error code is introduced here.
- `storedResource` (commit-time REFERENCED lookup) continues to answer the
  existing `managed_session_resource_missing` conflict for any non-REFERENCED
  row, as today.
- `WorkspaceRecoveryReader.resource` answers with its new named check
  `resource_collected`, not `resource_layout_unsupported` or
  `resource_corrupt`, when a bundle read physically reaches a collected byte
  copy. This is the one surface that can meet a legitimately collected row,
  and it now names the outcome accurately. The code is terminal: like
  `source_drift` it invalidates the capture operation and, through
  `WorkspaceMigrationStore.failed`, the migration — the bytes have no other
  copy, so no retry can succeed, and an invalidated operation stops pinning
  the other retired Sessions of its registration cut.
- `WorkspaceCsiCheckpointSnapshotStore` selects only `state = 'REFERENCED'`
  rows and is therefore unaffected; a CSI snapshot never contains PUBLISHED
  rows and the no-reference predicate above keeps that invariant.

No corridor changes: the TS runtime keeps reading through the same
endpoints; broker codes propagate as today. A TS-side classification change is
out of scope (see Non-goals).

## Configuration and rollout

No new configuration keys. The pass runs only when
`qwen.managed-agent.tool-publication.enabled` and
`qwen.managed-agent.tool-publication.gc-enabled` are both true, and uses the
existing `deletion-grace` (default 24h). Defaults are unchanged: with
`gc-enabled` false, byte drop never happens and the ledger is not created, so
existing deployments see no change. The bean lives next to
`ToolPublicationCollector` in `ToolPublicationConfiguration`.

Rollout notes:

- Renumber the migration forward against latest `main` immediately before
  landing (hygiene rule already established for O4 migrations).
- Operations documentation (`managed-tool-output-retention-operations.md`)
  gains one paragraph: enabling GC now also frees stream-capture bytes; its
  deployment gates (upgrade of Java writers first, isolated OSS, database
  gates) already apply.
- Older broker versions without V56 never start the pass. The first upgraded
  broker starts collecting as soon as `gc-enabled` is already true, since
  there is no version handshake; pre-upgrade brokers misname legitimately
  collected rows as `resource_layout_unsupported` or `resource_corrupt`, so a
  fleet that may roll workloads during the upgrade keeps the flag off until
  every broker runs V56
  — the same every-writer-first order the O4 rollout already requires.

## Affected layers and delivery

| Layer                                                     | Change                                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration V56                                             | New `qwen_managed_session_resource_collection` ledger table; `retired_at` index on `qwen_output_session_retirement`; `(session_id, operation_id)` index on `managed_workspace_recovery_session` |
| `store/SessionResourceCollectionCollector.java` (new)     | Tick, candidate scan, claim, paging, byte accounting                                                                                                                                            |
| `store/WorkspaceRecoveryReader.java`                      | `resource_collected` named check                                                                                                                                                                |
| `config/ToolPublicationConfiguration.java`                | Collector bean on the existing scheduler                                                                                                                                                        |
| `store/SessionResourceCollectionCollectorTest.java` (new) | Predicate, blockers, paging, fencing, byte-exact accounting, retirement-fenced outcomes                                                                                                         |
| `packages/sdk-java/managed-agent-server/README.md`        | Operations paragraph                                                                                                                                                                            |

Out of this change: `ToolPublicationRetentionStore`,
`ToolPublicationCollector`, and every TS package are untouched except for
documentation links. Any decompilation of the publication collector and this
collector into a shared helper is deliberately not done: the two passes are
each ~200 lines against different tables, and sharing a skeleton adds coupling
without removing policy surface.

## Acceptance and validation

Unit tests (JUnit, mirroring `ToolPublicationCollectorTest` infrastructure)
must prove:

1. A retired Session past grace with live tombstone and no leases has its
   eligible rows collected byte-exact (`SUM(byte_length)` over collected rows
   equals `collected_bytes`) and `inline_bytes` is gone.
2. Each blocker holds everything: no tombstone; `recovery_protected`; grace
   not elapsed; a live (non-`DELETED`) journal head; an unexpired read lease;
   an in-flight recovery operation. Each blocker persists with the right
   next-attempt time (`24h` / `retired_at + grace` / `60s`).
3. Per-row exclusion: `REFERENCED`, wrong kind, `TOOL_PUBLICATION` storage, a
   present reference row, and rows outside the byte/kind bounds are not
   collected, and an all-excluded Session still completes with
   `collected_bytes = 0`.
4. Paging: a capture larger than one page is collected cursor-ordered with
   deterministic page boundaries under both the 100-row and the 32 MiB caps,
   and a kill between pages resumes without double counting.
5. Fencing: two collector identities can hold the ledger only through
   generation-owner handoff; an expired claim is taken over and completes.
6. Outcome surfaces: after collection, a `readResource` against the retired
   Session answers the pre-existing `tool_output_session_retired` conflict
   (not a corruption verdict and not a fabricated new code);
   `WorkspaceRecoveryReader.resource` answers `resource_collected`;
   `verifyStoredResource` still fails closed for a tampered non-collected row.

Validation on real MySQL: the byte drop is SQL-local, so the existing
H2/testcontainer-based tests are sufficient for unit evidence; the real-MySQL
O4 gates are not extended in this slice. A follow-up may add a measured
closure case (a captured run above 100 MiB) to the O4 deployment gates when
operators ask for fleet numbers.

## Non-goals and open questions

- P2 (MCP result retention) and P3 (media and shared outputs) are separate
  slices of #13534 with different reference closures: the MCP records' set-once
  ref rules and the omni object store's cross-session content addressing need
  their own designs.
- The local file runtime (`LocalToolResultSegmentStore`, filesystem layout
  under the runtime base directory) is unmanaged by this design; its retention
  is a separate host-local problem.
- Replay tolerance: `loadExtensionRevision` re-reads `child_run.outputRef`
  when a workspace is restored. That manifest row is journal-referenced and
  never collected, but the page and content rows it points at carry no
  reference rows and are collectible. If a retired Session's bytes are
  collected before another machine replays its journal, the replay meets
  `resource_collected` on a page or content row — an accurate outcome — but
  whether recovery should skip the closure check for tombstoned Sessions is an
  open product decision. P1 does not change replay.
- Per-tenant fleet reporting of `collected_bytes` (metrics endpoint) is left
  to the operations follow-up.

Open questions:

1. Should the observer (`ToolPublicationRetentionObserver`) also sample new
   ledger blockers for its histogram, or is the per-claim log line sufficient
   for P1?
2. Is 32 MiB the right page byte budget for blob-heavy rows on production
   MySQL, or should the budget follow `max_allowed_packet`-style
   introspection instead of a constant?
3. Is the 60-second ledger-creation cadence enough for fleets with deep
   retirement histories? The scan is index-served but still walks the whole
   history per cadence tick; a persisted high-water watermark over
   `retired_at` would make it proportional to newly due work, at the cost of
   cross-instance cursor state. Deferred until fleet numbers exist.
