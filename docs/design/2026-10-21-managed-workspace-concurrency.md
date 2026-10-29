# Concurrent Managed Workspace Sessions

[English](2026-10-21-managed-workspace-concurrency.md) | [简体中文](2026-10-21-managed-workspace-concurrency.zh-CN.md)

## Status and scope

This change permits ordinary Managed Sessions on LOCAL and SSH_LOCAL storage to execute concurrently in the same directory. It covers both Session-isolated and Workspace-isolated workers. A Session still runs one Turn at a time. Resident and private CSI profiles retain their current admission, reservation, and retirement rules. Existing Agent/Workflow child-admission restrictions are outside this slice.

## Problem and current behavior

Legacy daemon queues prompts per Session and permits different Sessions to use the same directory. Before this change, Managed execution recorded one Runtime Session in the physical storage owner's holder columns for the entire tool Turn. A second Session polled `workspace_busy` without a visible wait reason. An UNKNOWN execution retained its original owner, so an unrelated conversation could wait until its prompt deadline even though its worker could execute independently.

The single holder also protects physical maintenance, lost-worker cleanup, operator recovery, retention, and file rewind. Removing the conflicting-holder check alone would invalidate those consumers. Runtime workers already maintain separate Session configuration, tool journals, background processes, and cancellation identities; no process-global cwd change is needed.

## Ownership model

Add a nullable `execution_storage_key` and a false-by-default `execution_exclusive` to each persisted Runtime Session. A non-null physical key is that exact Session's execution membership, independent of its lifecycle state. READY alone cannot express this because mount handback intentionally preserves READY. UNKNOWN, failed acquisition, and failed release retain membership until the existing evidence-gated cleanup succeeds.

The physical `ma_storage_owner` row continues to identify the registered mount and any exclusive maintenance holder. Acquisition locks that row briefly, verifies the original tenant/Workspace/storage/binding/generation and mount, rejects migration, maintenance, or an exclusive rewind, and records only the requesting member. Other ordinary members are allowed. Release removes only the original member. It never clears the directory's other memberships. All membership scans used for admission or physical maintenance are current locking reads under the same physical row lock, including across storage aliases.

## File history

Concurrent edits have Legacy's shared-file semantics: separate Sessions can overwrite each other's files, and Shell/Hook/MCP effects are not transactions. The existing fingerprint checks alone cannot safely attribute a write when another Session changes the file before the final fingerprint is captured.

Past execution overlap does not disable file undo, including overlap involving only reads. No persistent overlap marker is stored and ordinary execution acquisition does not create or update a history head for this purpose. Once other memberships have released, the Session can request rewind through the existing runtime/history implementation. Existing file-level history checks remain in force; this change adds no cross-Session file transaction or attribution guarantee.

Rewind upgrades its membership to exclusive under the physical row lock after verifying there are no other members. If another member is still held, it returns the existing conflict result. New acquisitions refuse until the rewind result returns. Successful completion downgrades the membership; an uncertain result retains exclusive membership for original-operation recovery. Existing Hosted conflict receipts and pending-undo handling are reused without changing the history wire format or UI API.

## Lifecycle and recovery

Physical registration, fencing, restoration, child-Workspace maintenance, and storage migration require zero memberships as well as the existing holder and writer checks. A retained membership counts even if its Runtime Session was locally marked RELEASED. Maintenance acquired first excludes subsequent claims; execution acquired first prevents maintenance from entering its physical step.

Stopping a drained worker checks only that binding's execution and Session evidence. A different worker using the same directory is not a reason to keep this worker alive. Lost-worker cleanup requires the original persisted stop evidence and operation claim, then clears only memberships for that binding and generation. Stopped Session release clears only that Session. Retention preserves bindings with retained memberships.

Operator recovery keeps its current explicit Runtime Session identity. Preparing recovery from only a binding is refused when that binding has multiple held members; other members must settle first. Existing prepared operations continue to validate their exact membership and digest. UNKNOWN status and cancel calls keep the original execution identity and remain non-replayable.

The existing Runtime placement recovery barrier is unchanged. An UNKNOWN tool result on an otherwise READY binding does not exclude another ordinary Session. A LOST, DRAINING, or OPERATOR_RECOVERY binding, or an attested RECOVERY_BLOCKED binding, still blocks a new placement in its recovery scope until the existing physical recovery gate is satisfied. This change does not authorize replacement workers past that gate.

## Changes by component

| Component                              | Change                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared schema and projections          | Add V15 without rewriting published migrations; include the new fields in strict CSI inventory and require ordinary memberships to be absent on CSI rows. |
| Workspace execution store              | Shared claim, exact release, exclusive rewind, complete maintenance occupancy, and scoped lost cleanup.                                                   |
| Runtime transport                      | Acquire/execute still prove the original membership; reuse the existing conflict result for current occupancy and retain exclusivity on uncertain rewind. |
| Storage guard                          | Include all memberships in inspect, registration, fence, restore, and captured-registration verification.                                                 |
| Binding repository and retention guard | Preserve memberships across CAS; exact stopped release, close checks, and retention references.                                                           |
| Operator recovery                      | Resolve and fence the exact retained member; reject ambiguous binding-only preparation.                                                                   |
| Hosted Harness and Runtime worker      | Existing execution, status, cancellation, and history protocols are reused. No new public routes or model-facing options.                                 |

## Rollout and boundaries

Fresh installations initialize schema V15 and use the matching Server and Broker build. Ordinary execution has one authority representation: per-Runtime-Session membership. There is no conversion or fallback for an earlier singleton representation. CSI reservation and physical-maintenance identities retain their existing roles.

An existing canonical V1–V14 catalog requires a drained cutover, not a mixed-version rolling upgrade. Disable new Turn admission and use the old build to finish or recover and release every ordinary LOCAL/SSH_LOCAL holder. Stop the old Server, Broker, Harness, Runtime workers and other storage writers, then verify that no `ma_storage_owner` row with `storage_kind IN ('LOCAL', 'SSH_LOCAL')` and `maintenance_id IS NULL` has a non-null `holder_key`. Only then apply V15 and start the matching build. An UNKNOWN holder with unconfirmed writer cleanup must remain on the old deployment until recovery and release succeed; do not manually clear its ownership or start the new build against that catalog. This requirement does not add compatibility handling to V15 or runtime cleanup.

This change prevents an UNKNOWN tool result on a READY binding from blocking unrelated ordinary Sessions; it does not repair the unknown result, bypass placement recovery, prove escaped writers stopped, add transactional file isolation, implement CSI concurrency, change child-agent admission, or fix the separate empty Skill display. Maintenance remains blocked by unproven writers. The original incident deployment is not modified during development.

## Validation and acceptance

- Baseline the globally installed CLI and confirm the existing Java/Broker contention behavior before implementation, documenting a Java/API fallback when the CLI cannot reach the embedded ownership store.
- Two independent SQL clients and two Broker processes can hold ordinary memberships on one physical directory. A blocked or UNKNOWN A does not prevent B's real tool call from completing; A retains its original status/cancel identity and cannot replay.
- Releasing, cancelling, handing back, closing, or recovering A leaves B held. Cross-tenant aliases, stale generations, revoked authority, and CSI profile confusion fail closed.
- Maintenance and acquisition races have one winner; physical operations wait for every member, including RELEASED rows with retained claims. Lost cleanup and retention cannot discard another binding's claim.
- Sequential undo remains functional. After the neighbor releases, a Session that previously overlapped can rewind through the existing history implementation. Current neighbor occupancy still produces a conflict with no file effect. Exclusive rewind excludes a late acquisition; uncertainty preserves exclusivity.
- Run focused H2 tests, Maven verify, disposable MySQL 8.4 concurrency/schema tests, and the real-process Hosted concurrency test using the built CLI. Inspect the full diff in two clean self-audit passes, then obtain independent review.

### Verification results

Verified the single-representation cleanup based on `48e2adc0b5bb3b65c608abf8188702ca938bdfeb`, using macOS, JDK 21, Node 22.22.3 and disposable MySQL 8.4.11:

- All 94 focused H2 cases passed without skips. Complete module verification covered 5,144 unit/H2 cases: 5,126 passed, 18 skipped, no failures or errors, across 349 classes. Both Checkstyle executions and high-confidence SpotBugs passed. The skips require unavailable platform, SSH/Kubernetes/worker fixtures, MySQL locking/consistent-read semantics or mutually exclusive admission profiles.
- Eight selected MySQL cases across four classes passed without skips: original-member recovery and operator preparation, LOCAL/SSH_LOCAL stopped-member cleanup and recovery batches, exact CSI/member retention, and query-scale contracts. This is selected-method/class coverage, not the complete MySQL matrix.
- All 15 selected reboot, lost-reply and storage-concurrency fault cases, both standalone Hosted concurrency cases, and all 10 selected Hosted MCP reply-loss/store-fault/Spring-restart cases passed without failures, errors or skips. MCP recovery retained the original member before confirmed release and then cleared it.
- Five independent private probes exited successfully. They confirmed that an old ordinary singleton is neither execution authority nor converted or cleared. Actual Broker JVMs and Node workers retained normal shared execution, exact release and UNKNOWN non-replay. After a read-only neighbor released, the real history implementation completed a no-op rewind with `conflict:false` and cleared temporary exclusivity. Saved-member recovery also passed after actual worker loss with synthetic reboot evidence.
- All nine independent-probe and five standalone Hosted recorded Broker/worker PIDs, plus 14 recorded MCP stdio PIDs, exited. Both independent private H2 servers stopped. The disposable MySQL port, data directory, UUID and PID were verified; it was shut down gracefully with no other clients, its data removed and logs retained.

Tracked Java/POM inputs and the existing CLI bundle stayed unchanged throughout verification. This cleanup changes no TypeScript or shared API, so earlier root build/typecheck evidence was not rerun or counted as new validation. Modified Linux-only extension/public-close cases and optional cancellation/provider-control/Shell-output/operator process modes were compiled but not all executed. Process fixtures use synthetic physical identity and injected UNKNOWN/reboot evidence on macOS; they do not establish native Linux/Windows qualification, real SSH workers, actual host reboot, hardware CSI/Kubernetes acceptance, production deployment or a model-driven WebShell conversation. The actual rewind probe is a successful no-op, not restoration of modified bytes.

## Open questions

None for this slice. Cross-Session file isolation or stronger attribution, CSI concurrency, public wait-reason UX, and relaxing the existing child-admission restrictions are follow-up work rather than hidden acceptance claims.
