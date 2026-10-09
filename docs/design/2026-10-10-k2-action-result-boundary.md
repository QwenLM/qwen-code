# K2 legacy action and result mutation boundary

[English](2026-10-10-k2-action-result-boundary.md) | [简体中文](2026-10-10-k2-action-result-boundary.zh-CN.md)

Status: implemented with bounded independent local validation; maintainer review
and full K2 acceptance remain open. Baseline:
`1cae4cd16d9475dc8f3d6052d77a12187c34ea5a`. Refs #12380, #13395 and
Draft PR #13526. This increment follows the legacy Managed Agent mutation
boundary and does not certify full K2 retirement.

## Problem and baseline behavior

The public event guard does not cover independent result transactions. Receipt
capture creates legacy projection work even during qualified native CSI journal
commits. Backfill changes journal checkpoints and, after rollback, writes its
error separately. Claim and failure callbacks change result leases, attempts and
state without checking the parent Session. Projection admits a retention read
lease before checking its actual persisted target. Action response admission and
completion also have independent write boundaries.

A result's caller-constructible `Claim.Source` and its `source_json` cannot
authorize the database row addressed by `result_id`. The stored tenant,
workspace, Session and digest are the target identity. Historical private
derived rows must remain unchanged until the complete native inventory accounts
for them; marking them unsupported is still an application write.

## Goals and boundaries

- Exclude private CSI Sessions, including retained pins with ordinary profiles,
  from legacy action/result writes and already-durable private projection I/O.
- Preserve original native receipt, outcome, resource and journal transactions.
- Preserve ordinary journals without a public Managed Agent Session, ordinary
  action actor/replay semantics, and result policy/lapse/error behavior.
- Preserve immutable historical private rows; do not delete, terminalize, clear
  leases, create authority, or increment generations as a migration.

The generated `csi_guard = TRUE` predicate is an exclusion signal, not native
placement, membership, continuation or drain authority. Contradictory ordinary
profile/null-pin CSI history is not certified by this increment. Retention
retirement, collectors, application-cut inventory, physical writer termination,
exact CSI NodeUnpublish, atomic RELEASED and safe reuse remain separate work.
Public Spring/Hosted CSI selection remains closed. Alibaba ACK is a test
environment, not a runtime dependency.

## Proposed changes

| Component                            | Boundary                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared package-private Session guard | Extract the existing exact TRUE locking probe, ten-second query timeout and MySQL/MariaDB index hint. Keep semantic `csi_managed_mutation_unavailable` for explicit legacy mutations. No new public capability or late placement acquisition.          |
| Original journal commit              | Call the legacy result-capture hook only when the already-qualified `csiOriginal` is absent. Keep native journal validation and persistence unchanged.                                                                                                 |
| Result capture                       | Validate ordinary sources/deduplication as before. Before nonempty insertion, skip an actual current TRUE target. Empty batches remain no-ops.                                                                                                         |
| Result backfill                      | Filter private targets before LIMIT; peek without locking, probe the current parent, lock the exact head, then revalidate current scope/state/checkpoint before writing.                                                                               |
| Result claim                         | Filter each existing state before LIMIT; sort bounded nonlocking candidates, probe actual scope, lock one exact result and revalidate its current state/due/source before leasing.                                                                     |
| Result fail/complete                 | Identify the persisted row before probing. Validate immutable columns, parsed stored Source and claimed Source after qualification. Keep state/generation checks. Actual private rows return without writes, including forged ordinary-looking claims. |
| Result projector                     | Perform persisted-result qualification before readLease or object I/O, outside error-to-fail catches. Each later mutation independently requalifies. Missing/private targets do no projection work; conflicting ordinary sources fail before I/O.      |
| Action apply/admit/complete          | Guard actual `action.changed` application, admission and settlement before mutation. The unconditional native non-action callback remains a no-op. Retain admission's existing placement lock before the probe.                                        |
| Action deliverable                   | Exclude private operations before its existing LIMIT, preserving ordinary backlog progress.                                                                                                                                                            |

No schema, route, controller, native grant, action schema or source converter
change is required. A small shared SQL helper has concrete consumers in three
stores; it is not a general authority resolver.

## Identity and lock order

Result/backfill discovery uses `NOT EXISTS` a TRUE parent, rather than requiring
a FALSE parent. Existing ordinary journal-only fixtures and production paths
can lack the public Session. Snapshot discovery is not mutation authority.

Backfill follows candidate peek → current TRUE probe → exact head FOR UPDATE →
current checkpoint validation. Claim/fail follow persisted target peek → current
probe → exact result FOR UPDATE → current identity/state validation. Do not
acquire a parent after locking the head/result while waiting for an original
native parent→head writer.

Completion retains the existing retention ordering: actual result peek →
retention tenant → current TRUE probe → journal head → publication → public
Session → result. A private refusal rolls back any tenant upsert in that
transaction. Internal failure settlement uses the already-qualified locked row;
it must not open a new parent/domain acquisition after taking child locks.
Updates remain bound to the locked persisted identity and claim generation.
Completion normally owns its transaction. If called inside an ambient Spring
transaction, its private refusal marks the participating transaction rollback-only;
the outer owner must roll back rather than commit unrelated writes.

Backfill owns its short scheduler transactions: its entry rejects an active
Spring transaction before any discovery, lock or write. Keep default REQUIRED;
do not suspend an outer owner with REQUIRES_NEW while it still holds the head.
The backfill catch runs in a new transaction after rollback, probes before
locking its head, and checks that the failed scope/checkpoint is still eligible
before marking `invalid_journal`. A private refusal is not invalid journal data;
another worker's later checkpoint must not be overwritten by a stale catch.

Projector preflight is a short transaction, and no transaction spans object I/O.
It rejects an already durable private target. It does not certify an ordinary
orphan journal's concurrent replacement by a new private CREATE after preflight,
or hold a lifetime read admission fence. That lease-admission race belongs to
the later retention/read-callback boundary and full application-cut proof.

## Validation and acceptance

Before implementation, a read-only test-engineer discovers global `qwen` CLI
reachability and reproduces the gap using the built Java/JDBC fallback. Use real
private CREATE and current Flyway schema. Explicitly label seeded historical
legacy work as fixtures, not native membership authority. Record original
process exits, raw table snapshots and source/product hashes.

Acceptance for this increment requires:

1. Concrete baseline claim/fail/backfill/action writes, then post-fix full-table
   private no-write observations with mixed ordinary controls.
2. Private PENDING/RETRYABLE/LEASED backlog does not fill bounded selectors;
   already terminal/READY histories also remain unchanged.
3. Forged caller/stored Source scope cannot mutate a private result or start
   its read lease/GET. Ordinary source conflicts also do no I/O or writes.
   Private completion also rolls back an otherwise new retention tenant row;
   retired/lapsed ordinary branches validate the locked Source before settlement.
4. Ordinary journal-only backfill, prior-page digest error durability, lease
   lapse, policy change, missing publication/turn and stale-generation behavior
   retain their existing outcomes. Actual ordinary action responses/replays work.
   Backfill invoked in an ambient transaction refuses before any write.
5. Configured native receipt commit and replay retain exact original durable
   receipt/history/resource values while creating no legacy result. Native
   non-action callbacks remain usable; actual private action callbacks refuse.
6. Owned MySQL RC and warmed RR current-parent contention with the historical
   result already visible, parent→head/result
   lock-order observations and concurrent ordinary claim single-winner checks.
   H2/mock observations alone do not prove these properties.
7. Relevant Java tests, Checkstyle/SpotBugs, repository build/typecheck/bundle,
   two clean self-audits and independent read-only review of the final candidate.
   Report any unavailable native review separately; no synthetic approval.

Keep independently observed artifacts immutable and clean only owned fixture
resources. Bind every result to the exact observed candidate and products;
rebuilt packaging bytes do not inherit old cloud acceptance. Update the same
Draft PR with a separate E2E report; keep the complete K2 goal active.

### Observed local results

The candidate passed repository build/typecheck/bundle and full Managed Agent
verification: 131 suites, 1645 passed, one skipped, no failures/errors, and clean
Checkstyle/SpotBugs. An independent test-engineer observed four owned MySQL RC/RR
test invocations and 11 packaged JDBC groups; private callbacks preserved all 57
tables, while ordinary controls advanced only their expected table.

Separate real native read-file turns configured the actual JDBC result hook.
The old baseline added one legacy result; the candidate added none. Both
accepted the original receipt and its exact wire replay with HTTP 200, used two
provider requests, and preserved all 57 tables during replay. The candidate
receipt boundary advanced only the original journal/resource/ref/head. No
native authority was seeded through a result fixture or fake `csiOriginal`.

Earlier fixture, serialization and isolated-copy setup failures retain their
original nonzero exits. The successful observer restores complete copied CLI
products, actual package dependency lookup and separate fixture helper classes;
it pins actual loaded origins but is not a hermetic dependency build. Synthetic
Kubernetes/attestation, MockMvc, deterministic SSE and Darwin mount seams remain
explicit. These results do not establish a lifetime read fence, a fresh target
Linux/cloud run, physical release or complete K2 acceptance.

## Files affected

Production under `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/`:
`ManagedAgentStore`, shared legacy guard, `ManagedSessionStore`,
`ManagedToolResultStore`, `ManagedToolResultProjector` and `ManagedActionStore`.
Focused tests cover these stores and ordinary publication/action integration.
The paired design and ignored E2E plan record scope and independent evidence.

## Open follow-up

Full native membership includes frozen legacy result/action histories. Closing
these writers cannot itself establish an immutable application cut or aggregate
DRAINED. Retention read admission/callbacks and retirement/collector writes must
be qualified in their own transactions before the later physical stop/unpublish,
release/reuse, Linux/cloud and security/portability acceptance can finish K2.
