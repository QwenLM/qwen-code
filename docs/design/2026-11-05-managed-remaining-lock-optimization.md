# Remaining Managed Agent lock optimization

[English](2026-11-05-managed-remaining-lock-optimization.md) | [简体中文](2026-11-05-managed-remaining-lock-optimization.zh-CN.md)

## Status and scope

Investigation and local verification used `main` at `6fe5bca8e1a13ffb17be93123f75063f48181f44` on 2026-11-05. This change implements SSH settlement and main worktree preparation concurrency; no throughput improvement is claimed. PRs #16369 and #16370 are already merged: rewind no longer owns the whole directory exclusively, and ordinary journal/publication completion no longer takes storage row locks.

This change introduces no general lock manager, new lock table or profile flag. Session order, writer generations, idempotency, authorization and exact execution-stop evidence remain independent requirements. Ordinary concurrent workspace edits continue to use the agreed CLI semantics.

## Findings and decisions

| Area                        | What it protects now                                                                       | Decision                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Remaining storage admission | The logical migration fence and physical registration state before accepting new work      | Do not globally replace the admission helper with a nonlocking read. Separate new admissions from already accepted metadata completion.     |
| `member_count`              | Runtime Session memberships and running uploads, checked before exclusive maintenance      | Retain for now. It is updated at attach/detach/upload boundaries, not for every tool execution.                                             |
| Maintenance hold            | Physical Git work, including restart recovery and uncertain worker completion              | Main Session worktree preparation permits ordinary members; maintenance-to-maintenance exclusion and durable ownership remain.              |
| Tenant guards               | Some cross-resource invariants, plus some redundant serialization of individual operations | Remove the guard from three SSH registration settlement paths, with an exact owner update. Keep cross-resource placement/retirement guards. |

## First implementation: SSH registration settlement

In [SshWorkspaceStore](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/SshWorkspaceStore.java), remove the tenant `runtime_placement` guard only from `complete`, `completeParked` and `releaseParked`. Each already locks the existing registration operation through `requireClaim` or `parkedRow`. This serializes completion, failure and recovery of the same reservation. Publication writes only that reservation's alias, owner, Workspace and OWNER grant in one transaction; it does not select a tenant default or enforce a tenant-wide quota.

One SQL change accompanies the deletions. Previously `publish` updated `ma_storage_owner` by `mount_registration_id`, which is not indexed in the baseline schema. It now reads `physical_key` from the already locked alias and updates the owner by the existing unique `storage_key`, retaining the registration identity and `SSH_LOCAL` predicates. The expected owner must be present before publishing the Workspace. The key cannot come from `intent.registration()`: the normal caller retains an Intent obtained before reservation, so that field can be absent.

Keep `begin` and `reserve` unchanged. They cover creation of a previously absent operation and physical-directory reservation. In particular, the host-scoped overlap guard in [LocalStorageOwners](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/LocalStorageOwners.java) coordinates different tenants on one host; it is not redundant tenant serialization. No schema or API change is needed for this slice.

## Storage admission and membership

[WorkspaceMigrationAdmission](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/WorkspaceMigrationAdmission.java) currently combines two checks. `requireOpenForAdmission` reads `ma_storage.fence_operation_id` and the physical registration with shared locks on MySQL. The ten direct shared-admission call sites include Turn submission, Action responses, context compression, task cancellation, Session mutation and configuration/policy changes. Several enqueue new work, unlike an ordinary journal receipt.

Retain the current logical-fence ordering for new work. Under that contract, a fence writer waits for admitted transactions, and later admission observes the closed gate. Replacing this with a snapshot read is a protocol change, including under an already established REPEATABLE READ snapshot. Offline physical migration does not by itself prove that this separate admission contract is unused. Workspace/permission locks and final physical-write admission also remain outside the proposed removal.

Already accepted metadata settlement is a separate candidate: `AgentSessionCommands.completeSessionMutation` updates Session metadata, its receipt and its event, while retaining Session/receipt locks. A follow-up could allow this settlement through a logical migration fence and use the existing nonlocking physical check, as ordinary journal completion does. It must explicitly define the behavior of delayed `FAILED` receipts and superseding mutations and test it; this is not part of the SSH slice.

Removing only the physical-owner shared read is not a complete contention fix: Runtime claim/upload still acquire alias and owner exclusive locks, including through `storageKey`. Conversely, removing `member_count` but retaining those reads would leave much of the serialization in place.

The existing count remains useful for both owned-root LOCAL and imported LOCAL: imported roots reject whole-root physical maintenance, but still support Session/child worktree maintenance. SSH_LOCAL has no corresponding LOCAL worktree maintenance consumer, but special-casing its count alone adds lifecycle branches for limited tool-path benefit. Unknown or pending uploads and retained Runtime memberships must not disappear merely because a lease expired or a connection was lost.

If measured attach/upload waits later justify replacing the count, reuse existing Runtime membership and running-upload rows. Admissions would share an owner gate; maintenance would hold its exclusive counterpart and use current reads to check both member sets. A plain `COUNT`/`NOT EXISTS` has an empty-set insertion race and may see an old snapshot. That alternative must cover all claim/release, LOST/stopped cleanup, pending-upload and idle-check paths together. It is deferred, not a second bookkeeping mechanism to add now.

## Main worktree preparation protocol

[SessionWorktreeGit.prepare](../../packages/managed-agent-server/adapters/src/main/java/com/alibaba/qwen/code/managedagent/adapters/workspace/SessionWorktreeGit.java) creates a separately allocated target and branch from a frozen commit SHA. It does not snapshot the source directory's dirty files. Therefore an unrelated Runtime Session editing the source need not force preparation to wait for the entire physical root to become idle.

Ordinary members can run alongside a verified main `SESSION_WORKTREE` preparation, while maintenance operations continue to exclude one another using the existing owner and durable execution record. The original preparation operation ID equals the worktree ID; cleanup uses a different operation ID. Classification matches this immutable identity, tenant, Session, logical and physical storage, claim generation and holder digest. It does not depend on mutable worktree/operation state or claim expiry: an uncertain Git result can mark the worktree BLOCKED while its original physical execution still holds maintenance.

Runtime admission/execution, upload admission/settlement and Runtime stop/recovery share this predicate in [StorageOwnerMembership](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/StorageOwnerMembership.java). This keeps the shared decision outside its consumers and allows their class-size ceilings to decrease. Counter updates still run under the owner row lock. The operation/worktree classification is a separate nonlocking query, avoiding an operation lock after the owner lock. An older REPEATABLE READ snapshot that cannot match the current generation fails closed. Existing mount readiness checks remain at their original call sites; stopped Runtime cleanup does not acquire a new READY requirement. Unknown, expired or unproved-stopped maintenance remains fenced against successor maintenance. A Runtime member pointing to a different physical storage remains unavailable even when the expected storage is busy.

Preparation still changes the Git common directory, refs and worktree registration. Concurrent user Git activity follows CLI conflict semantics: return the conflict without resetting or adopting an existing target. This is not a claim that preparation touches only its new directory. Shared-container/target conflicts retain the existing failure semantics and marker/identity checks.

Do not broaden the first worktree change to cleanup or child operations. Cleanup deletes a checkout and must exclude its users and uploads. Child preparation snapshots the parent repository's working files; merge/apply reads and writes the parent; discard also modifies shared refs. A `cwd` or `worktreeId` alone is not a complete conflict boundary, and Shell execution is not confined to that directory. Narrowing those operations requires a separate source/target/common-Git protocol.

Do not remove the maintenance tenant guard independently either. Current acquisition paths include owner-before-operation and operation-before-owner ordering; the broader guard currently prevents those paths from racing. Unify those orders before narrowing that guard.

## Validation and delivery

Keep SSH settlement and worktree preparation independently reviewable. SSH MySQL acceptance cases are:

1. Holding the same tenant's placement guard, or an unrelated physical-owner row lock, does not delay the target registration's settlement.
2. Concurrent completion and release of one parked operation produce one valid outcome: a complete Workspace/grant/READY owner, or failed registration with only its unfinished reservation removed.
3. Competing reservations for the same or overlapping directory, including across tenants, preserve directory ownership. A delayed old request cannot publish or remove a replacement owner's registration. Publication rejects a mismatched physical key even if the registration ID still matches.

Worktree acceptance covers Runtime/upload admission in both orders around a preparation hold, pending upload settlement after BLOCKED/claim expiry, stale generations, and continued cleanup exclusion. Real Git checks verify the frozen commit and unchanged source dirty files/index, and preserve existing targets after interrupted preparation. Uncertain worker stop must never permit successor maintenance. Keep child merge/discard coverage unchanged.

Runtime placement still scans recovery obstacles across bindings/slots. Runtime retention, CSI and Resident retirement still depend on resource references and broader lifecycle transitions. Ordinary collectors may be narrowed later, but their reader/recovery/ownership handoff races have not been established by this audit. Do not claim those guards are removable based on this design.

The implementation changes six persistence classes and focused tests, with no schema/API additions. Initial local verification passed 131 unique focused cases (including 17 real Git cases), 45 real MySQL cases and Checkstyle. Review follow-ups additionally verify the class-size and module/lock contracts, moved predicate consumers and physical-key/error-priority regressions. Full Java/MySQL/Hosted CI and UI acceptance remain pending; commands, failed attempts and limitations are recorded in `.qwen/e2e-tests/2026-11-05-registration-worktree-locks.md`. Actual wait frequency on attach/upload and the existing current-read contract remain explicit inputs to any later storage-admission/count redesign.
