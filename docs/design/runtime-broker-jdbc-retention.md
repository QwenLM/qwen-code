# Runtime Broker JDBC Retention

[English](runtime-broker-jdbc-retention.md) | [简体中文](runtime-broker-jdbc-retention.zh-CN.md)

Status: Implemented for [#13203](https://github.com/QwenLM/qwen-code/issues/13203)

## Problem and scope

Terminal Broker bindings, sessions and executions accumulate indefinitely. New placement also maps and decrypts historical bindings to decide whether an earlier writer still blocks admission. Retention must bound cleanup work without discarding physical recovery, publication or migration evidence.

This change removes eligible JDBC records under retired bindings. It does not retire workers, delete physical storage, collect publication metadata or clean historical children under active bindings. Slots, generation counters, placement guards, harness drains and storage fences remain durable.

## Eligibility and references

Use the database clock. A binding must be older than the configured maximum age and have no live operation lease. RELEASED bindings are eligible; managed bindings additionally require a valid drain receipt or both loss and stopped-writer evidence. FAILED bindings are eligible only for unmanaged legacy/static placements with all three provision-seed columns absent. Other states and incomplete evidence remain retained.

Any nonterminal child retains the whole binding. SETTLED and ABANDONED executions must have completion timestamps older than the retention cutoff and no live dispatch lease. RELEASED and FAILED sessions must have last_active_at older than the cutoff and no remaining execution. Delete the binding only after every child is gone.

Operator recovery, Workspace holders and CSI retirement retain the whole binding, including completed recovery records. Publication and CSI worker ACK records retain their execution and, through it, the session and binding; unrelated siblings may be removed. COLLECTED publication records still retain their original evidence. Publication and ACK hashes use SHA-256 over raw UTF-8, unlike the Broker's length-prefixed execution hash; compute reference keys from bounded candidate IDs rather than joining unlike hashes.

A child Session's lineage retains its binding while the canonical parent child_run projection is missing or has no settled_at. Cascade and relay repair can need the original binding identity after the child has stopped, even without a tool execution or Workspace holder. Read lineage and the parent projection by primary key on the sweep connection, with exact raw identity checks. Lineage commits before child warm, and a terminal run cannot reopen; its committed settled_at ends this protection. Keep Session lineage, parent records and the permanent relay ledger intact.

## Components and concurrency

JdbcRuntimeRetention is a framework-neutral JDBC sweep with a same-connection reference guard supplied by the embedding. It returns continuation and scanned, skipped and per-table deletion counts. Its two-level keyset cursor tracks the binding and child phase; checked protected rows advance the cursor. Binding cursor comparisons use UTC literals with six fractional digits so Connector/J's MariaDB compatibility handshake cannot truncate timestamp parameters and stall traversal. A complete sweep wraps to the beginning, and a restart may safely repeat work.

For batch size B, one tick checks at most B bindings and B child rows and deletes at most B rows across all three tables. Large families span ticks. Each transaction locks tenant placement domain, slot, binding and then children; it rechecks eligibility and references using current committed state before deleting execution, session and finally binding. No transaction performs an unbounded cascade. Database errors roll back and propagate. Local publication mutations acquire the tenant placement guard and original JDBC binding and execution locks in their existing transaction, before publication locks, closing the reference-creation race and preserving the session lifecycle lock order. CSI retains its existing lock order.

Managed-server owns a separate single-thread scheduler gated by both Broker and retention enablement. Settings under qwen.managed-agent.runtime-broker.retention are enabled=false, max-age=30d, batch-size=100 (1–1000) and scan-delay=1m. Age and delay must be positive. Successful ticks log counts; failed ticks log the error and retry on the next scheduled run. A failure rolls back the current binding transaction; earlier commits in that tick remain committed and are not included in a partial-count report. Recovery scheduling remains independent. Existing HTTP and business repository interfaces remain unchanged.

Add indexes for binding state/time/ID, tenant/state and embedding reference keys, in both the standalone schema initializer and a new Flyway migration. Do not rewrite historical migrations. Placement uses SELECT 1 with LIMIT 1 and scalar state/identity predicates equivalent to blocksPlacement for valid records, preserving exact identity comparisons and conservatively treating incomplete seed/lease columns as present. It does not decrypt historical secrets and works independently of retention enablement.

## Retention contract and rollout

Enabling retention makes historical receipts and idempotency guarantees finite. After deletion, existing missing-record behavior applies; callers must not reuse expired runtime-session IDs or idempotency keys. No permanent execution tombstones are added.

Deploy V57 after the existing V56 actor migration with retention disabled, and verify upgrades from V56 preserve existing terminal receipts. Enable only after every instance uses the new publication locking protocol. Observe scan/deletion/skip counts, duration and failures. Disable retention before reverting to older writers. Disabling stops future cleanup but cannot restore deleted records.

## Validation and acceptance

Cover age boundaries, database time, lifecycle states, physical evidence, live leases, nonterminal children, generation continuity and expired lookup behavior. Cover every external reference, completed recovery, COLLECTED publication and the distinct hash algorithms. Prove bounded progress with large families and protected rows, including subsecond timestamps, equal-time ID ordering and single-row batches, concurrent sweepers, rollback and reference creation races. Compare placement decisions to the in-memory implementation and assert zero historical decrypts. Check schema/Flyway agreement, old-schema upgrades, scheduling isolation and configuration gates. Exercise locking and collation on MySQL/MariaDB, not H2 alone.

Reproduce a stopped child whose parent still owes dispatch/attach journal repair: cleanup must preserve its original binding until that repair can complete. Verify missing projections fail closed, raw identity mismatches do not end protection, the guard sees the sweep transaction's own writes, and a canonical terminal projection allows cleanup without collecting lineage or relay classifications.

Focused H2 and MySQL 8.4.11 verification passed, including bounded sweeps, rollback, exact placement comparisons, publication row locking and expired Broker history queries without provisioning or dispatch. Query-plan checks confirmed the candidate, tenant/state and reference indexes are usable on MySQL. MariaDB has not been verified locally; query-plan checks are not latency benchmarks.

Implementation artifacts are the Broker sweep and placement guard, managed-server reference guard, scheduler/configuration, additive migrations, repository tests and README updates. There are no unresolved product decisions.
