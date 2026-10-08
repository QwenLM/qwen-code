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

## Components and concurrency

JdbcRuntimeRetention is a framework-neutral JDBC sweep with a same-connection reference guard supplied by the embedding. It returns continuation and scanned, skipped and per-table deletion counts. Its two-level keyset cursor tracks the binding and child phase; checked protected rows advance the cursor. A complete sweep wraps to the beginning, and a restart may safely repeat work.

For batch size B, one tick checks at most B bindings and B child rows and deletes at most B rows across all three tables. Large families span ticks. Each transaction locks tenant placement domain, slot, binding and then children; it rechecks eligibility and references using current committed state before deleting execution, session and finally binding. No transaction performs an unbounded cascade. Database errors roll back and propagate. Local publication mutations acquire the original JDBC binding and execution locks in their existing transaction, before publication locks, closing the reference-creation race. CSI retains its existing lock order.

Managed-server owns a separate single-thread scheduler gated by both Broker and retention enablement. Settings under qwen.managed-agent.runtime-broker.retention are enabled=false, max-age=30d, batch-size=100 (1–1000) and scan-delay=1m. Age and delay must be positive. Failed ticks are logged and retried on the next scheduled run; recovery scheduling remains independent. Existing HTTP and business repository interfaces remain unchanged.

Add indexes for binding state/time/ID, tenant/state and embedding reference keys, in both the standalone schema initializer and a new Flyway migration. Do not rewrite historical migrations. Placement uses SELECT 1 with LIMIT 1 and scalar state/identity predicates equivalent to blocksPlacement for valid records, preserving exact identity comparisons and conservatively treating incomplete seed/lease columns as present. It does not decrypt historical secrets and works independently of retention enablement.

## Retention contract and rollout

Enabling retention makes historical receipts and idempotency guarantees finite. After deletion, existing missing-record behavior applies; callers must not reuse expired runtime-session IDs or idempotency keys. No permanent execution tombstones are added.

Deploy migrations and code with retention disabled. Enable only after every instance uses the new publication locking protocol. Observe scan/deletion/skip counts, duration and failures. Disable retention before reverting to older writers. Disabling stops future cleanup but cannot restore deleted records.

## Validation and acceptance

Cover age boundaries, database time, lifecycle states, physical evidence, live leases, nonterminal children, generation continuity and expired lookup behavior. Cover every external reference, completed recovery, COLLECTED publication and the distinct hash algorithms. Prove bounded progress with large families and protected rows, concurrent sweepers, rollback and reference creation races. Compare placement decisions to the in-memory implementation and assert zero historical decrypts. Check schema/Flyway agreement, old-schema upgrades, scheduling isolation and configuration gates. Exercise locking and collation on MySQL/MariaDB, not H2 alone.

Focused H2 and MySQL 8.4.11 verification passed, including bounded sweeps, rollback, exact placement comparisons, publication row locking and expired Broker history queries without provisioning or dispatch. Query-plan checks confirmed the candidate, tenant/state and reference indexes are usable on MySQL. MariaDB has not been verified locally; query-plan checks are not latency benchmarks.

Implementation artifacts are the Broker sweep and placement guard, managed-server reference guard, scheduler/configuration, additive migrations, repository tests and README updates. There are no unresolved product decisions.
