# Managed Agent lock simplification

[English](2026-11-02-managed-agent-lock-simplification.md) | [简体中文](2026-11-02-managed-agent-lock-simplification.zh-CN.md)

## Status and boundary

Implementation follows the Store decomposition in #16090, inspected at `66d23ceb1a5bee7e9cb6362cfc238eb64297f3e6` and merged on 2026-11-02 as `d9d6fc4a4b8e654d405dbb1d01bf3404e6435a1c`. This branch has been rebased onto `main` at `73474ef094ea1c6bb2a95a9a2a33a28b0ec58e9e`. The rebase preserved the original implementation patch exactly. The subsequent CI classification fix is recorded below; production code remains unchanged by that fix. Implementation and acceptance are separate; local results and remaining CI qualification are recorded below.

Preserve public APIs, schema, transaction managers, propagation, isolation, error codes, replay receipts, and writer/CSI fencing. Production changes stay inside persistence. Existing tenant guards and exceptional CSI ordering retain their timeout and error mapping. This work does not introduce a generic lock manager or cache lock ownership across transactions.

## Agent row access

`AgentStoreRows` provides ordinary and legacy paired reads returning `LockedSessionTurn`. They retain the existing Session root → event stream → Turn SQL, row mapping, and failure order. Seven adjacent pairs in recovery marking, Harness binding, recovery admission, retraction, and event ingestion use these methods. Clock sampling remains after the original waits. Empty batches and retraction argument checks keep their original positions. Conditional cancellation and other staged reads remain staged; Turn-only CAS paths do not gain Session/event-stream locks.

## Journal row access

Separate complete root/head acquisition from head acquisition under an already-held root. Share the head query, mapping, retirement check, and missing-head error. Reuse the latter only after CSI admission on the same datasource's transactional connection with autocommit disabled. A Spring synchronization-bound connection from an unrelated transaction can still be in autocommit; the explicit connection check preserves full root acquisition there. A null continuation alone is not evidence of a held root. Standalone paths keep full acquisition and existing CSI refusals; ordinary standalone heartbeat behavior also stays unchanged.

Apply this to commit, seal, recovery blocking, tool-result/publication writers, CSI renewal, and both owner-read transaction phases. Reuse the CSI head within a commit before it is mutated. Keep ordinary duplicate receipt lookup/return before head acquisition. Preserve subsequent database-time, lease, generation, token, and CSI authority checks. Acquisition/root/event-stream initialization and unrelated lifecycle paths retain their existing behavior.

## Conditional updates

Existing claim, renew, release, retry, and submission-marker conditional updates remain the fast-path contract. The two additional candidates are `cancelBeforeAdmission` and `settleFailedTurn`. Their Session lock, terminal event, command settlement, and transaction must remain intact.

Both candidates retain their original implementation. `RecoverySettlementStoreMySqlIT.removingThePreReadWouldChangeAnOldSnapshotOwnerDecision` proves a legal difference for cancellation, ordinary failure, and recovery-blocked failure: transaction A reads owner A, another transaction releases that owner and claims owner B, then A calls the terminal operation with B. The existing snapshot pre-read refuses; the proposed conditional UPDATE sees current B and succeeds. The candidate update is rolled back in the test. Removing the pre-read would change results, so neither conversion meets the agreed equivalence condition.

| Path                                                                     | Decision and contract                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| claim / renew / release / retry / submission marker                      | Keep existing conditional UPDATE; assert exactly one Turn UPDATE and no public Session/event-stream lock |
| `cancelBeforeAdmission`                                                  | Keep Session lock and snapshot pre-read; old-snapshot owner rejection differs from UPDATE-first          |
| `settleFailedTurn`, including recovery-blocked                           | Keep Session lock and snapshot pre-read for the same demonstrated difference                             |
| Old-value calculations, cross-table decisions, multi-resource settlement | Keep existing reads and locks; outside the conversion scope                                              |

Wrong-owner refusal retains one nonlocking Turn SELECT and no Turn UPDATE. Successful settlement keeps its original UPDATE, event append, and locking command-settlement read. Existing missing-row, lease, repeated-call, and recovery-settlement tests remain; this work does not change those semantics.

## Runtime verification

Replace the cross-file Java call-graph interpreter with an explicit entry inventory, executed JDBC traces, and real MySQL races. The inventory identifies declaring class and full parameter signature, transaction attributes, behavior category, and its scenario suite. Include facade methods, interface defaults, package-visible bridges, and sibling stores. A lightweight source inventory pins files containing protected-table SQL; it does not infer method calls or prove unexecuted branches.

The JDBC recorder observes execution attempts and completions, bound identity parameters, JDBC connection lease identity, transaction boundaries, commit, and rollback. Preparing a statement is not acquiring a lock. The recorder executes no SQL itself. Fixed statement patterns identify the audited resources; different Sessions, connections, transactions, or a failed statement cannot supply a required lock. Actual Spring proxies, external transactions, standalone calls, and owner-read transaction phases are covered separately.

| Previous protection                              | Replacement                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Facade entry and overload population             | Full-signature entry/transaction inventory                                                               |
| Session-before-Turn inference through helpers    | Real Agent workflows and JDBC order assertions                                                           |
| Root-before-head and repeated acquisition        | Journal workflows and SQL-count assertions                                                               |
| Default-interface transaction delegation         | Existing proxy transaction tests plus real Store proxy scenarios                                         |
| Sibling Store boundary                           | Protected SQL source inventory; Action, UserMessage, WorkspaceRecovery scenarios                         |
| Unknown Java receiver/overload/lambda resolution | Removed interpreter machinery; changed executed branches require scenarios                               |
| False positives from other locks                 | Negative traces for wrong Session, connection, transaction, failed execution, and reversed/missing locks |
| Database concurrency and stale snapshots         | MySQL event-sequence, recovery-settlement, physical-fence, guard-convoy, and publication-order tests     |

`SessionRowLockOrderTest` now checks 286 exact entries and a protected-SQL literal/file inventory; JDK parsing only extracts string literals, so comments cannot masquerade as SQL. It performs no receiver resolution, overload guessing, recursive call graph, or ambiguity exemptions. The entry registry records source suites, not a claim that each branch of each entry has run. SQL containing a protected table in a new file or literal must update the inventory; SQL assembled indirectly through existing constants still requires scenario/review coverage.

`StoreLockTrace` uses fixed table, locking-read, and identity-predicate spellings. It records prepared/plain/batch execution attempts and successes/failures, copies batch bindings, and forgets locks at transaction end. It never executes a database observation query. Connection IDs identify borrowed JDBC connections, not server-side connection IDs. `StoreLockTraceTest` also runs deliberately wrong JDBC sequences for missing/reversed locks, other connections, early commit, and another Session.

Optimization counts also match the journal reader's fixed WHERE shape. CSI replay admission uses the same complete head projection with different identity predicates for a required authority recheck; it remains a head access for ordering and transaction assertions, but is counted separately from the optimized journal read. Replay therefore retains one journal head and one authority head in the same transaction. A classification regression also rejects an authority read before the root.

| Source family / special lane                                                               | Scenario owners                                                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Seven Agent pairs and CAS rejection/fast paths                                             | `AgentLockContractTest`, `AgentLockContractMySqlIT`, `RecoverySettlementStoreMySqlIT`                              |
| Journal writers, ordinary replay, external rollback, standalone and unrelated transactions | `JournalLockContractTest`, `JournalLockContractMySqlIT`                                                            |
| Native owner read's admission and completion transactions                                  | `ManagedSessionNativeReadTest`                                                                                     |
| Native successful commit and replay                                                        | `WorkspaceCsiNativeActivationGateTest` (built Node prerequisite; pending CI locally)                               |
| Action / UserMessage / WorkspaceRecovery                                                   | Executed-order assertions in `ManagedActionStoreTest`, `ManagedUserMessageStoreTest`, `WorkspaceRecoveryStoreTest` |
| Existing lifecycle, policies, queries, creation and default delegation                     | Per-signature registry; existing business suites and `AgentStateStoreProxyTransactionTest`                         |
| Retention, publication, physical freeze and tenant isolation                               | `ToolPublicationLockOrderMySqlIT`, `ManagedSessionPhysicalFenceMySqlIT`, `ManagedSessionGuardConvoyIT`             |

The selected runtime-first approach cannot prove every unexecuted branch. New entries require classification, and changed success, rejection, replay, and special branches require executable cases. Remove the old parser only after the replacement cases are in place. Count all replacement helpers when assessing simplification; moving the parser to another file is not completion.

## Acceptance and validation

Cover missing Session/Turn/stream, CSI refusal, empty batches, duplicate dispatch, stale owners and leases, cancellation/admission/failure races, old read views, journal replay and rollback, retirement/deletion, cross-Session isolation, bounded CSI deadlocks, and notifications after commit only. Paired Agent reads must retain their SQL sequence; each optimized Journal handoff must remove its repeated root acquisition. Report conditional-update success and rejection costs separately.

Use JDK 21, an isolated Maven repository, and the module's shared 600-second local verification budget. H2 validates fixtures/contracts; MySQL 8.4 establishes concurrency evidence. Full verify, Checkstyle, SpotBugs, MySQL, Hosted/fault, and platform qualification remain CI gates. Skipped or unavailable checks are pending, never passes. No production deployment or schema migration is required; reverting the independent change restores the prior implementation.

The original checker was 3,281 lines. Its replacement checker, JDBC recorder, negative fixtures, Agent/Journal scenarios, MySQL adapters, and both registries total 1,511 lines. Including the 125-line net increase in existing business/CSI tests gives 1,636 lines of replacement validation, a net reduction of 1,645 lines. This includes the 633 lines of registry data; no parser was moved elsewhere.

## Measured SQL and validation record

The comparison restores the eight production files from `66d23ceb`, runs the same fixtures with baseline counts, and restores the candidate files in a `finally` block. Counts below are the target root `SELECT ... FOR UPDATE` and full mapped head SELECT, not all SQL in the operation. Existing physical/CSI authority probes are deliberately excluded from the optimization counts and remain ordered in the trace.

| Scenario                                                                           | Baseline → candidate                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| All seven paired Agent reads                                                       | root → Session stream → Turn unchanged, three initial locking reads    |
| Ordinary commit, seal, block recovery, publication writer, tool-result publication | root 2 → 1; mapped head 1 → 1                                          |
| Ordinary renewal                                                                   | root 1 → 1; mapped head 1 → 1; no tenant guard added                   |
| Ordinary replay                                                                    | root 1 → 1; mapped head 0 → 0                                          |
| Standalone seal                                                                    | root 1 → 1; mapped head 1 → 1                                          |
| Unrelated Spring transaction with autocommit managed connection                    | full root acquisition retained: root 2, mapped head 1                  |
| CSI renewal                                                                        | root 2 → 1; mapped head 1 → 1                                          |
| CSI commit reaching native proof rejection                                         | root 3 → 1; mapped head 2 → 1; original refusal and rollback preserved |
| Native owner read, each of two independent transactions                            | root 2 → 1; mapped head 1 → 1                                          |
| Terminal CAS wrong-owner rejection                                                 | snapshot Turn SELECT 1 → 1; Turn UPDATE 0 → 0                          |

Successful native CSI commit/replay assertions are added to the existing producer-backed suite. Their execution is pending CI; the local CSI refusal-path count is not evidence of successful native execution. Ordinary commit/rollback/replay tests also assert publication only after commit, none after rollback, and no additional publication on replay. Locks cannot be reused after commit/rollback; see the [MySQL locking-read contract](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html).

Local verification used macOS arm64, JDK 21.0.8, Maven 3.9.14, and a task-isolated Maven repository. MySQL 8.4.11 was an owned loopback instance with disposable test databases, `max_allowed_packet=134217728`, and binary logging disabled. Linux's native-AIO flag was not used on macOS. No shared database was cleared.

- Baseline: 46 initial contract cases, then 42 baseline comparison cases passed.
- Candidate: 153 focused cases passed in the combined H2/MySQL run; the subsequent transaction-boundary run passed 46 cases, including the autocommit check on both H2 and MySQL. These run counts overlap and must not be summed as unique tests.
- MySQL: the first selected run passed 67 cases. Later selections also covered the four new terminal-refusal/missing-row cases, tenant-guard isolation, duplicate commit contention, and the unrelated-transaction boundary.
- Checkstyle passed across all reactor modules; the final 15 recorder cases passed, including actual JDBC order violations. Initial attempts failed on new fixture setup, overly broad head counts, and test formatting; those attempts remain in the local budget log.
- Pending: full Maven `verify`, SpotBugs, full MySQL profile, producer-backed native successful CSI commit/replay, Hosted/fault consumers, Linux and Windows. Local Core/CLI build artifacts were absent, so those real-process cases were not run or counted as passing. No CI configuration or coverage guard is weakened.

CI subsequently ran the native producer suite at `c6d83e08a268395011c7ceb71a9dcbfe9cf60a67`: its 6,100-case Java run had one failure in the new replay cost assertion and 17 skipped cases. The trace showed that ordering and single-transaction assertions passed, but the cost classifier counted the preserved authority recheck as a second journal read. The classifier and native expectation now distinguish these reads without changing production code. A further local run passed 42 recorder, journal, native-read, and inventory cases plus reactor Checkstyle. The producer-backed case on the corrected revision remains pending CI; this local run does not establish its success.

Commands run from `packages/managed-agent-server` selected the classes above through `mvn -Dtest=... test checkstyle:check`; MySQL selections additionally used `-Pmysql-integration -Dmysql.url=... -Dmysql.user=...`. Total local Java validation time is 571.08/600 seconds, including setup, all failed attempts, and MySQL cleanup. The shared budget ledger and per-attempt logs are under `.qwen/investigations/managed-lock-simplification/`. The dependency was reconciled before the classification fix: `git range-diff` confirmed the same implementation patch after rebase, and comparison with the tested revision confirmed unchanged persistence code, affected test sources, and lock inventories. The existing focused evidence is retained alongside the classification regression; broader integration changes on the refreshed base remain subject to CI. Acceptance remains pending the listed CI gates. Deployment is outside the scope of this change.
