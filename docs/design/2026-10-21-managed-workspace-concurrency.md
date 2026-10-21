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

Published singleton Runtime holders remain recognized. They are validated against their exact Runtime Session and holder digest before another member can join. The first compatible acquisition atomically transfers the original holder to its exact membership before clearing the singleton columns; no execution authority is dropped. A holder released before that transfer still uses its original evidence-gated cleanup. A malformed holder fails closed. No timeout steals ownership and no SQL operation assumes a cancelled command stopped.

## File history

Concurrent edits have Legacy's shared-file semantics: separate Sessions can overwrite each other's files, and Shell/Hook/MCP effects are not transactions. The existing fingerprint checks alone cannot safely attribute a write when another Session changes the file before the final fingerprint is captured.

Past execution overlap does not disable file undo, including overlap involving only reads. No persistent overlap marker is stored and ordinary execution acquisition does not create or update a history head for this purpose. Once other memberships have released, the Session can request rewind through the existing runtime/history implementation. Existing file-level history checks remain in force; this change adds no cross-Session file transaction or attribution guarantee.

Rewind upgrades its membership to exclusive under the physical row lock after verifying there are no other members or legacy holders. If another member is still held, it returns the existing conflict result. New acquisitions refuse until the rewind result returns. Successful completion downgrades the membership; an uncertain result retains exclusive membership for original-operation recovery. Existing Hosted conflict receipts and pending-undo handling are reused without changing the history wire format or UI API.

## Lifecycle and recovery

Physical registration, fencing, restoration, child-Workspace maintenance, and storage migration require zero memberships as well as the existing holder and writer checks. A retained membership counts even if its Runtime Session was locally marked RELEASED. Maintenance acquired first excludes subsequent claims; execution acquired first prevents maintenance from entering its physical step.

Stopping a drained worker checks only that binding's execution and Session evidence. A different worker using the same directory is not a reason to keep this worker alive. Lost-worker cleanup requires the original persisted stop evidence and operation claim, then clears only memberships for that binding and generation. Stopped Session release clears only that Session. Retention preserves bindings with retained memberships.

Operator recovery keeps its current explicit Runtime Session identity. Preparing recovery from only a binding is refused when that binding has multiple held members; other members must settle first. Existing prepared operations continue to validate their exact membership and digest. UNKNOWN status and cancel calls keep the original execution identity and remain non-replayable.

The existing Runtime placement recovery barrier is unchanged. An UNKNOWN tool result on an otherwise READY binding does not exclude another ordinary Session. A LOST, DRAINING, or OPERATOR_RECOVERY binding, or an attested RECOVERY_BLOCKED binding, still blocks a new placement in its recovery scope until the existing physical recovery gate is satisfied. This change does not authorize replacement workers past that gate.

## Changes by component

| Component                              | Change                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared schema and projections          | Add V15 without rewriting published migrations; include the new fields in strict CSI inventory and require ordinary memberships to be absent on CSI rows. |
| Workspace execution store              | Shared claim, exact release, exclusive rewind, legacy-holder validation, complete maintenance occupancy, and scoped lost cleanup.                         |
| Runtime transport                      | Acquire/execute still prove the original membership; reuse the existing conflict result for current occupancy and retain exclusivity on uncertain rewind. |
| Storage guard                          | Include all memberships in inspect, registration, fence, restore, and captured-registration verification.                                                 |
| Binding repository and retention guard | Preserve memberships across CAS; exact stopped release, close checks, and retention references.                                                           |
| Operator recovery                      | Resolve and fence the exact retained member; reject ambiguous binding-only preparation.                                                                   |
| Hosted Harness and Runtime worker      | Existing execution, status, cancellation, and history protocols are reused. No new public routes or model-facing options.                                 |

## Rollout and boundaries

Drain and stop all old Broker/control-plane/maintenance writers before applying V15 and reopening execution. Old binaries do not understand memberships; mixed writers are unsupported. Preserve old data and original execution evidence. Rollback requires a compatible build or a fully drained catalog; do not erase memberships or unknown executions to force rollback. Existing CSI limits are unchanged.

This change prevents an UNKNOWN tool result on a READY binding from blocking unrelated ordinary Sessions; it does not repair the unknown result, bypass placement recovery, prove escaped writers stopped, add transactional file isolation, implement CSI concurrency, change child-agent admission, or fix the separate empty Skill display. Maintenance remains blocked by unproven writers. The original incident deployment is not modified during development.

## Validation and acceptance

- Baseline the globally installed CLI and confirm the existing Java/Broker contention behavior before implementation, documenting a Java/API fallback when the CLI cannot reach the embedded ownership store.
- Two independent SQL clients and two Broker processes can hold ordinary memberships on one physical directory. A blocked or UNKNOWN A does not prevent B's real tool call from completing; A retains its original status/cancel identity and cannot replay.
- Releasing, cancelling, handing back, closing, or recovering A leaves B held. Cross-tenant aliases, stale generations, malformed legacy holders, revoked authority, and CSI profile confusion fail closed.
- Maintenance and acquisition races have one winner; physical operations wait for every member, including RELEASED rows with retained claims. Lost cleanup and retention cannot discard another binding's claim.
- Sequential undo remains functional. After the neighbor releases, a Session that previously overlapped can rewind through the existing history implementation. Current neighbor occupancy still produces a conflict with no file effect. Exclusive rewind excludes a late acquisition; uncertainty preserves exclusivity.
- Run focused H2 tests, Maven verify, disposable MySQL 8.4 concurrency/schema tests, and the real-process Hosted concurrency test using the built CLI. Inspect the full diff in two clean self-audit passes, then obtain independent review.

### Verification results

Locally verified on main base `461be87304c7b3b5d64b701207c49f236515d5fd`, using macOS, JDK 21, Node 22.22.3 and disposable MySQL 8.4.11:

- Frozen-lockfile installation and its normal prepare completed root build and bundle; root typecheck also passed. All 145 focused H2/schema cases passed without skips.
- Complete module verification covered 5,145 unit/H2 cases: 5,127 passed, 18 skipped, no failures or errors. The skips have explicit macOS, SSH interop, Kubernetes, worker-bundle, MySQL-locking/consistent-read or mutually exclusive admission-profile conditions. Both Checkstyle executions and high-confidence SpotBugs passed in the same `verify` command.
- Nine complete affected MySQL classes passed all 202 cases without skips: Managed Agent, creation schema, strict CSI inventory, recovery, retention guard, retention races, SSH storage, CSI checkpoints and migration. This is selected-class coverage; the complete MySQL roster was not rerun.
- All 44 fault-profile cases and both standalone Hosted concurrency cases passed without failures, errors or skips, using the synchronized CLI bundle.
- Independent actual-process probes used two Broker JVMs and real Node workers per case. B completed tool work while A remained prepared or held an injected UNKNOWN record; exact release preserved its neighbor and UNKNOWN could not be replayed. After B completed a read-only `read_file` and released, A's real history implementation completed a no-op rewind with `conflict:false`, no failed files and cleared temporary exclusivity.
- The existing MCP Spring-restart/release gate passed on MySQL, preserving the original binding and Runtime Session identities and the `1 → 1 → 0` retained/retained/released membership expectations.
- The disposable MySQL server was verified by port, data directory and PID, then shut down gracefully with no other clients. Its private data was removed and logs retained. The independent probes' recorded processes and all five recorded standalone Hosted process PIDs exited; both independent private H2 servers stopped.

The process probes use synthetic physical identity and injected UNKNOWN state on macOS. They do not establish native Linux/Windows physical qualification, real SSH workers, host reboot, the complete Hosted/MySQL matrix or a model-driven WebShell conversation. The real undo probe is a no-op over an actual snapshot and does not prove restoration of modified file bytes. Production deployment is outside this verification.

## Open questions

None for this slice. Cross-Session file isolation or stronger attribution, CSI concurrency, public wait-reason UX, and relaxing the existing child-admission restrictions are follow-up work rather than hidden acceptance claims.
