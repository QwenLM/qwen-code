# Ordinary publication without storage row locks

[English](2026-11-05-managed-publication-storage-sharing.md) | [简体中文](2026-11-05-managed-publication-storage-sharing.zh-CN.md)

## Problem and scope

Ordinary LOCAL and SSH_LOCAL tools and uploads already share a Workspace. Publication still locks the storage alias and physical owner although it only reads identity, registration and mount state. Replacing exclusive locks with shared locks lets readers coexist but still waits for unrelated membership updates on the owner row.

Use ordinary nonlocking storage reads, including for the final publication receipt. Removing the writer's lock alone would leave another storage lock in the journal commit. Rewind behavior, directory membership and maintenance granularity are outside this increment.

## State writers and maintenance

Existing LOCAL storage identity changes, physical fencing, restoration and migration are offline maintenance. The production commands require `--offline-confirmed`; the [service README](../../packages/managed-agent-server/README.md) requires stopping admissions, services and external writers before fencing and forbids using it on live shared storage. Fencing is a durable refusal of subsequent work, not a way to stop arbitrary processes.

Online LOCAL creation registers storage before publishing its Workspace. SSH registration publishes REGISTERED/READY storage and its Workspace in one transaction; failed-registration cleanup only deletes FENCE_ONLY aliases and UNVERIFIED owners. These paths do not invalidate an already usable Workspace. Online execution, uploads and child maintenance update members or holders, which the publication physical-open predicate does not inspect. LOCAL logical migration fencing already permits admitted final results while the physical owner remains open.

A plain read therefore suffices for ordinary publication's physical-state check. It reads the current transaction's committed snapshot and rejects invalid states visible there. It does not promise to wait for unsupported concurrent offline maintenance or refresh an older ambient REPEATABLE READ snapshot. Do not introduce another connection, isolation override or coordination service.

## Implementation

Add `WorkspaceMigrationAdmission.requirePhysicalOpenForRead`, reusing the existing physical-open predicates with an empty locking suffix, and forward it through `JournalFencing.requireSessionStorageOpenForRead`. `JournalWriterLifecycle` uses this only when placement is absent and the original is not CSI. Placement-dependent writers retain the existing exclusive check.

`ToolPublicationAdmissionStore` already validates the original binding, resources, single receipt event and absence of Hosted cleanup. When placement and the CSI/lifecycle guard are absent, both first receipt and replay use a package-private `ManagedSessionStore.commitPublicationReceipt` entry. Its internal journal path reuses the physical-state check performed by the publication writer in the same transaction and does not take a second storage lock. All writer, root, head, lifecycle and receipt validation remains.

Public repository commit methods keep their previous behavior. Do not select the internal shortcut by `operation = recordToolResult` or a resource kind: those are incoming request values, not evidence that publication validation ran. No public API, schema, configuration or request switch is added.

## Preserved guarantees and boundaries

- Ordinary reserve, renew, producer fencing, close-not-started, both admission transactions and verified receipts omit storage row locks. Dispatch, upload, verification and finish already omit the publication writer check.
- Alias identity, registration and physical-owner availability predicates are unchanged. Invalid registrations or FENCED owners committed before the transaction snapshot still refuse new publication work.
- Session writer credentials, generations, binding and execution ownership, journal serialization, retention, publication identity and receipt idempotency retain their existing protection. Generic journal commits retain their storage locks.
- CSI, Resident, lifecycle-authority and snapshot paths retain their existing checks and locks. Execution membership and maintenance holds are unchanged.
- The offline FENCED mechanism remains supported. Unsupported concurrent physical maintenance is not made safe by this change, and no cross-Session file merge or conflict-free writing is promised.

## Affected components

The change touches the physical-read helper, journal fencing and publication writer, the concrete Session store and internal journal commit, and publication receipt routing. The public Session repository contract is unchanged. Update the real MySQL publication tests to distinguish nonlocking reads from shared locks and include actual receipt commits and replay. Keep the earlier shared-lock results as historical evidence only.

## Verification and acceptance

1. Before implementation, an independent exclusive alias/owner row lock must reproduce ordinary publication waiting. Use harmless locking or a membership update rather than unsupported concurrent offline fencing.
2. Afterwards, Session-isolated and Workspace-shared reserve, renew, admission and receipt/replay complete while the unrelated storage row lock remains held. Cover ambient transactions. In the opposite ordering, a member-count update completes before publication releases its transaction.
3. Already committed invalid alias or FENCED owner states still reject publication without installing a successful new capture/admission/receipt.
4. Generic journal requests, including one merely named `recordToolResult`, retain their original locking path. Verify placement-dependent writers, Session ownership and receipt idempotency.
5. Reuse valid rewind/schema evidence. Run affected journal/publication tests, the changed MySQL cases and Checkstyle within the original shared ten-minute Java budget. Record exact commands, baseline failures, final results and omissions. Full Java/MySQL, Hosted/fault, SSH process and SpotBugs acceptance remains CI work.

## Open questions

None for this change. Removing membership from user-owned directories or narrowing worktree maintenance is a separate follow-up; deleting the offline FENCED mechanism is not proposed here.
