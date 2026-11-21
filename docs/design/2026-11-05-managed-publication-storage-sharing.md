# Ordinary journal and publication without storage row locks

[English](2026-11-05-managed-publication-storage-sharing.md) | [简体中文](2026-11-05-managed-publication-storage-sharing.zh-CN.md)

## Problem and scope

Ordinary LOCAL and SSH_LOCAL tools and uploads already share a Workspace. Journal commits and tool-result publication still lock the storage alias and physical owner although they only read identity, registration and mount state. Shared locks let readers coexist but still wait for unrelated membership updates on the owner row.

Use ordinary nonlocking storage reads for generic journal commits, inline tool-result publication and ordinary publication writers. Publication receipts use the common commit entry, without a dedicated bypass or request flag. Rewind behavior, directory membership and maintenance granularity are outside this increment.

## State writers and maintenance

Existing LOCAL storage identity changes, physical fencing, restoration and migration are offline maintenance. The production commands require `--offline-confirmed`; the [service README](../../packages/managed-agent-server/README.md) requires stopping admissions, services and external writers before fencing and forbids using it on live shared storage. Fencing is a durable refusal of subsequent work, not a way to stop arbitrary processes.

Online LOCAL creation registers storage before publishing its Workspace. SSH registration publishes REGISTERED/READY storage and its Workspace in one transaction; failed-registration cleanup only deletes FENCE_ONLY aliases and UNVERIFIED owners. These paths do not invalidate an already usable Workspace. Online execution, uploads and child maintenance update members or holders, which the physical-open predicate does not inspect. LOCAL logical migration fencing already permits admitted commits while the physical owner remains open.

Ordinary commits write journal records, resources and projections in SQL; recording file history does not itself change Workspace files. Session/root and head locks serialize the actual shared journal state. Hosted cleanup records retain their placement and original-binding protection. Resident storage uses CSI aliases: this physical check only validates alias identity, while reservation and retirement keep their separate ownership and idle checks.

A plain read therefore suffices for ordinary journal and publication physical-state checks. It reads the current transaction's committed snapshot and rejects invalid states visible there. It does not promise to wait for unsupported concurrent offline maintenance or refresh an older ambient REPEATABLE READ snapshot. Physical freezing no longer waits for ordinary journal transactions; stop writers before maintenance. Do not introduce another connection, isolation override or coordination service.

## Implementation

Add `WorkspaceMigrationAdmission.requirePhysicalOpenForRead`, reusing the existing physical-open predicates with an empty locking suffix, and forward it through `JournalFencing.requireSessionStorageOpenForRead`. `JournalWriterLifecycle` uses it only when placement is absent and the original is not CSI. Placement-dependent writers retain the existing exclusive check.

`JournalCommit` and `JournalResourceWrites.publishToolResult` use the same read when lifecycle authority and private CSI continuation are absent. They retain the existing locked path otherwise. Remove the now-unused journal shared-lock helper.

`ToolPublicationAdmissionStore` continues to validate the original binding, resources, single receipt event and absence of Hosted cleanup. Both first receipt and replay call the common transactional Session commit method. Remove `commitPublicationReceipt`, `publicationStorageChecked` and special routing. No decision depends on an incoming operation label or resource kind. No public API, schema, configuration or request switch is added.

## Preserved guarantees and boundaries

- Ordinary commits, inline results, reserve, renew, producer fencing, close-not-started, both admission transactions and receipts omit explicit storage row locks. Dispatch, upload, verification and finish already omit the publication writer check.
- Alias identity, registration and physical-owner availability predicates are unchanged. Invalid registrations or FENCED owners committed before the transaction snapshot still refuse new writes. Existing idempotent journal replay keeps its earlier return before the storage check.
- Session writer credentials, generations, binding and execution ownership, journal serialization, retention, publication identity and receipt idempotency retain their existing protection. Direct generic requests still cannot manufacture missing publication resources.
- Private CSI, lifecycle-authority and snapshot guards, placement-dependent publication writers, and Resident reservation/retirement retain their existing checks and locks. Execution membership, maintenance holds and action-response admission locks are unchanged.
- The offline FENCED mechanism remains supported. Unsupported concurrent physical maintenance is not made safe by this change, and no cross-Session file merge or conflict-free writing is promised.

## Affected components

The change touches the physical-read helper, journal fencing, publication writer, common journal commit and inline resource publication. The public Session repository contract is unchanged. Remove the dedicated receipt path from the concrete Session store and publication routing. Update real MySQL and lock-contract tests; earlier shared-lock and generic-lock control results remain historical evidence only.

## Verification and acceptance

1. Reuse the recorded baseline where generic journal commits wait behind an independent owner row lock. Use harmless locking or online metadata updates rather than unsupported concurrent offline fencing.
2. Ordinary generic commits and inline results complete while an independent alias/owner exclusive lock remains held. Metadata updates also complete while a journal transaction remains open. Ordinary reserve, renew, admission and actual receipt/replay stay nonblocking for Session-isolated and Workspace-shared bindings, including ambient transactions.
3. Already committed invalid alias or FENCED owner states still reject new work. A generic request named `recordToolResult` with an uninstalled resource fails without advancing the journal, even though it no longer waits for storage locks.
4. Verify placement-dependent writers, Session/root-before-head ownership, credentials, generations, receipt idempotency and the separate action-response admission lock. Update the old test requiring a freeze to wait for a journal commit: test harmless metadata concurrency, then install the fence after the transaction and verify refusal.
5. Reuse valid rewind/schema evidence. Run affected journal/publication tests, changed MySQL cases and Checkstyle within the original shared ten-minute Java budget. Record exact commands, baseline failures, final results and omissions. Full Java/MySQL, Hosted/fault, SSH process and SpotBugs acceptance remains CI work.

## Open questions

None for this change. Removing membership from user-owned directories or narrowing worktree maintenance is a separate follow-up; deleting the offline FENCED mechanism is not proposed here.
