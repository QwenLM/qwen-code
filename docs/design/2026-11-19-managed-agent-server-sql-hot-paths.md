# Managed Agent Server SQL Hot-Path Optimization

[English](2026-11-19-managed-agent-server-sql-hot-paths.md) | [简体中文](2026-11-19-managed-agent-server-sql-hot-paths.zh-CN.md)

- Status: implemented and verified with focused tests and a dedicated MySQL benchmark; full CI acceptance pending.
- Date: 2026-11-19
- Scope: `packages/managed-agent-server` only (persistence, control-plane call sites, contracts, shared schema, verification).

## Problem

An inventory of 72 SQL sites (JOIN, UNION, recursive CTE, window functions, GC ledgers) in the managed agent server found full scans and per-row follow-up queries on hot paths. On a deterministic 100,000-row history, active-run counting, blocking-run discovery, and child-result relay discovery exceeded a 5-second statement budget; latest-turn, latest-environment, and lifecycle-window reads grew linearly with unrelated history; GC collectors re-scanned history from the beginning on every round.

## Goals and non-goals

Goals:

- Bound scans and round-trips on hot read paths at large history sizes.
- Move repeatable background work from "re-derive from history" to state-transition ledgers with fixed-round compensation.
- Preserve tenant/actor/workspace authorization, transaction boundaries, lock order, lease/fence guards, idempotency, and recovery semantics exactly.
- Keep H2 and MySQL behavior identical; parameterized SQL only.

Non-goals (explicitly not adopted):

- No public API changes and no asynchronous caches.
- Runtime retention is not split into two read-committed snapshots: an execution insert path does not take the binding lock, so the split is unproven safe.
- Tool-detail bodies are not blindly prefetched and page limits are not raised; the 8 MiB read budget stays.
- Quota uses merged aggregates, not a TTL cache.

## Solution overview

### 1. Query-shape fixes (A01, A02, A04, A05, A12, supplemental)

- Action receipt settlement reads all settlement fields in one projection instead of two follow-up queries per item; conditional updates stay idempotent.
- Single-package extension lookup queries the target directly; the catalog cap is preserved by first reading at most 257 distinct extension ids inside the same read-only repeatable-read transaction.
- The first native-snapshot candidate drops a redundant `GROUP BY`; the build-closure aggregation is unchanged.
- The lifecycle window adds canonical `session_scope_key` batch predicates; active-first window priority is unchanged.
- The workspace artifact first page produces its watermark from one fully filtered query instead of a repeated three-table `MAX` scan; later-page boundaries are unchanged.
- Supplemental: narrow session-list projections, worktree reuse of already-read rows, canonical keys for alias/request/MCP lookups, eight zero-count probes replaced by existence checks, and quota merged into two aggregates on both the normal and the rejection path.

### 2. Predicate and index support (A06, A10, A15)

- A composite event-type index serves latest-turn/latest-environment/control-event reads; the latest-turn re-join is confined to the same session stream and picks the newest by event sequence.
- The recursive permission CTE moves the identity function to the CTE side so parent-chain and actor reverse indexes apply; sentinel identity encoding, multi-byte and trailing-space semantics, and authorize-before-paginate order are preserved.
- Runtime recovery discovery uses a generated eligibility flag plus a narrow index; version/state/provider proofs, the global binary cursor, and exclusive operations are unchanged.

### 3. Queues and UNION discovery (A08, A09)

- The ready queue uses `EXISTS` to remove row multiplication, withdraws queued messages inside the close transaction, and deduplicates channel bindings first; fair ordering, active/recovery exclusion, claimed and late receipts, and fixed-round compensation are preserved.
- Child-relay discovery keeps one SQL snapshot: each UNION arm applies its complete filters, sorts, and takes N rows inside a derived-table wrapper; the outer query keeps the original global sort and limit. Priority, ordering, and changing-limit semantics are unchanged. The wrapper also stops H2 from retaining the first branch limit across repeated executions.

### 4. Ledger state machines (A07, A11)

- Automation maintains a run-terminal mirror in the same transaction as the record projection; exact active counting becomes one SQL, and blocking candidates use keyset pagination instead of OFFSET. `firing` stays active, a missing mirror stays active, and root locks and fences are retained.
- Retirement enqueues GC debt idempotently in the same transaction; capture batches 32 items; GC compensation runs fixed rounds. Debt is recorded even when GC is disabled; existing claims, generations, and terminal states are never reset.

### 5. Journal pack object I/O (A13)

- Object-store I/O moves out of SQL transactions. A put-closure flag records proof that the single physical object creation completed; an unknown PUT keeps its debt forever rather than reporting false GC completion. Each UUID is PUT exactly once. Short confirming transactions replace long I/O-holding ones, session GC waits for all pack debts, and reference deletion targets the exact `resource_key`.

### 6. Batch rebuild (A14)

- Activity diagnostic rebuild aggregates resource bytes in batches of 32 revisions: 65 items drop from 65 `SUM` queries to 3. Chain integrity and the 8 MiB read budget are preserved; tool-detail bodies stay deferred by budget.

## Schema changes

The shared V1 baseline is edited in place, per the module policy that applies until the first formal Managed Agent release; development catalogs are recreated rather than upgraded.

- `ma_journal_pack`: `is_put_closed` flag, generated `active_from_revision` (NULL when RETIRED) so cleanup debt does not block a replacement pack, unique key moved to `(session_scope_key, active_from_revision)`, and a put-closure CHECK.
- `ma_public_event`: `idx_ma_event_type_sequence (tenant_id, session_id, stream_kind, stream_id, event_type, sequence_id, turn_id)`.
- `ma_session_record`: `idx_ma_record_identity (session_scope_key, domain, record_id)` matching the close-debt join equalities; locked record reads still use the unique `(session_scope_key, record_key)`. Key length 2560 bytes < the 3072-byte InnoDB limit.
- `ma_workspace`: `idx_ma_workspace_parent (tenant_id, parent_workspace_id, workspace_kind)`.
- `ma_workspace_access`: `idx_ma_workspace_access_actor (tenant_id, actor_id, workspace_id)`.
- `ma_runtime_binding`: generated `is_recovery_candidate` plus `idx_ma_runtime_recovery_candidate (is_recovery_candidate, binding_id)`; boolean CHECK extended.
- `ma_schedule_occurrence`: `is_run_terminal` mirror flag, `idx_ma_occurrence_outcome` extended with `(is_run_terminal, gmt_create, occurrence_key)`, new `idx_ma_occurrence_run (tenant_id, run_id)`, boolean CHECK added.

## Preserved invariants

- Tenant/actor/workspace authorization runs before LIMIT and pagination, including lookahead rows; no cross-request authorization cache.
- Root/head/row lock order, writer and claim generations, lease fences, and repeatable-read snapshot rules are unchanged; fresh-committed checks are not moved back into stale snapshots.
- Settlement and retirement remain idempotent; reference and recovery protection is unchanged.
- H2/MySQL parity: nested CASE instead of persistent IN-capture, derived wrappers for repeated UNION branch limits, bound parameters or binary literals for VARBINARY identities.

## Risks and trade-offs

- Write amplification: terminal mirrors and GC enqueue add work to write transactions; this is the deliberate cost of bounded background reads.
- Measured regression: empty-result UNION discovery at 100k regresses from 70.452 ms to 100.968 ms p50 (branch top-N plus index lookups on empty sets). Sparse queues and the permission first page remain linear in domain rows.
- Benchmark limits: shared development machine, warm cache, single connection, synthetic JDBC reads; p95 uses nearest-rank on 15 samples. These are not production capacity numbers.

## Validation

- Unit: 29 suites, 887 tests — 883 pass, 4 H2-engine-only skips, each covered by a MySQL suite.
- MySQL 8.4.11: 12 suites, 123 tests, all pass, including the four engine-specific lock/recovery cases, scanner concurrency, fixed-round ledger repair, and native-media retention against real Core/CLI build output.
- Builds: Java reactor compile, Core/CLI build, Checkstyle all pass.
- Benchmark: an opt-in harness (`ManagedSqlPerformanceMySqlIT`) runs the production read paths on deterministic histories at 1,000/10,000/100,000 rows with at least 15 measured samples, 5-second per-statement and logical-call budgets, per-thread `COUNT_STAR`/`SUM_ROWS_EXAMINED` deltas cross-validated against performance_schema history, and EXPLAIN ANALYZE captured after timing. It is enabled with `-Dsqlperf.enabled=true -Dsqlperf.variant=baseline|optimized -Dsqlperf.group=core|discovery|all -Dsqlperf.sizes=1000,10000,100000 -Dsqlperf.samples=15 -Dsqlperf.output=<new-file>.json` plus the usual `mysql.url`/`mysql.user`/`mysql.password` properties pointing at a dedicated catalog; `useServerPrepStmts=false` is required. Failures fail the build; reports never overwrite an earlier run.
- Result equivalence: 69 scenarios pass (39 core + 30 discovery); 59 available baseline result fingerprints are identical; the 10 scenarios whose baseline timed out are checked against independently computed expectations; table row counts are equal.

Headline p50 at 100k (ms):

| Scenario                         | Baseline        | Optimized                      |
| -------------------------------- | --------------- | ------------------------------ |
| Active-run count, mixed history  | >5000 (timeout) | 0.447 (1 SQL, 6 rows examined) |
| Blocking-run discovery, mixed    | >5000 (timeout) | 0.973 (2 SQL, 7 rows examined) |
| Latest turn per session          | 139.935         | 0.682                          |
| Latest environment per session   | 145.639         | 0.612                          |
| Lifecycle window                 | 36.417          | 0.844                          |
| Child relay UNION, mixed         | >5000 (timeout) | 98.865                         |
| Child relay UNION, sparse normal | >5000 (timeout) | 135.570                        |
| Child relay UNION, debt only     | >5000 (timeout) | 147.721                        |
| Child relay UNION, empty result  | 70.452          | 100.968 (regression)           |
| Ready queue, multiple queued     | 127.989         | 9.045                          |
| Permission first page            | 55.451          | 41.692                         |
| Permission next page             | 11.717          | 1.049                          |

At 10k the mixed UNION drops from 3035.787 ms to 12.116 ms. The event index reduces plan-operator input from 200,015 scanned rows to 4 (turn) / 10 (environment). An intermediate branch-limit-only build (100k UNION 784–837 ms) is retained as evidence that the record-identity index, not the rewrite alone, produces the final UNION numbers.

## Acceptance criteria

- Result equivalence holds for every measured scenario (fingerprints or independent expectations), with equal table row counts.
- Hot-path counting, blocking discovery, latest-turn/environment, and lifecycle reads at 100k use at most 2 SQL and single-digit examined rows.
- Authorization, lease/fence, idempotency, and recovery suites pass on both engines; GC never reports completion while a PUT is unproven.
- No production database access; parameterized SQL only; builds and Checkstyle pass.

## Follow-up work

- Full CI, SpotBugs/full verify, integration profiles, and online write-throughput/capacity measurement are not run here.
- The empty-result UNION regression is a candidate for an empty-set short-circuit if real workloads show it matters.
- The due-work UNION arm still scans domain rows plus a sort; the permission first page and sparse queues remain linear in domain rows. Further narrowing needs workload evidence.
