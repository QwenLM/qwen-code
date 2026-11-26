# Managed Suspension Placement Release

[English](2026-11-26-managed-suspension-placement-release.md) | [简体中文](2026-11-26-managed-suspension-placement-release.zh-CN.md)

Status: implementation design, 2026-11-26. Current-state claims are checked against `main` at `6d0e2336a7`. This addendum supersedes the Phase 1 non-goal that retained placements of suspended Sessions in [the stateless Harness design](2026-11-16-managed-stateless-harness.md).

## 1. Problem and current state

A clean idle suspension or Action park releases the activation and seals the writer with a wake stamp, but leaves the Session placement `ACTIVE`. While the old Harness remains healthy, pool selection keeps routing the Session to that owner. Another member cannot take over until the writer lease expires, because `JdbcHarnessPlacementStore.takeover` requires either:

- a `RELEASED` placement, a `SEALED` head and the release record for the current placement epoch; or
- an expired writer lease with an activation state that permits recovery.

The drain path already writes the required receipt through `quiesceOwnership` and `releaseOwnership`. It cannot be called directly from suspension: drain excludes live owners and pending work that suspension tears down, and its Store release arm currently requires an `ACTIVE` head. After suspension has sealed the head, both `quiesceOwnership` and the existing release arm reject the old writer.

The result is safe but sticky: Harness memory and renewal work are released, while ownership remains pinned for up to the writer lease duration.

## 2. Goals and scope

### Goals

- Let a clean idle suspension or Action park release its placement after the durable wake-stamped seal.
- Let a healthy pool member B take over from a still-healthy member A without waiting for A's writer lease to expire.
- Preserve the journal, wake stamp, Action-park certificate, writer fencing and exactly-once Action settlement.
- Reuse the existing release receipt, takeover CAS and recovery paths.
- Preserve current behavior during mixed Harness/control-plane versions.

### Non-goals

- Reclaiming placements left by departed members or by a crash between seal and release. That reaper is a separate slice.
- Releasing a bare-sealed Session when wake dispatch is not advertised.
- Relaxing takeover to accept a sealed head without a release receipt.
- Owner routing for arbitrary running Turns, Session-scoped replacement of the process boot fence, load-balancer deployment or pull scheduling.
- New public API routes, database schema changes or supported configuration keys.

## 3. Design decisions

| Decision            | Choice                                                                   | Rationale                                                                                                          |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Release proof       | Existing drain receipt and `RELEASED + SEALED + receipt` takeover arm    | No second ownership protocol or takeover relaxation is needed.                                                     |
| Clean-seal evidence | `wake_seal_revision == journal_revision`                                 | Distinguishes a recoverable suspension/park from a bare seal and preserves the existing recovery proof.            |
| Version negotiation | Additive `suspensionPlacementRelease` writer-grant capability            | A new Harness never attempts a post-seal release against an older Store.                                           |
| Capability gate     | Advertise the new bit only together with `wakeDispatch`                  | Clean release requires the wake-stamped seal; no independent setting is needed.                                    |
| Harness ordering    | Quiesce before activation release and seal; release placement after seal | The old writer can quiesce only while active, while a successor can acquire only after the release receipt exists. |
| Sealed-head update  | Do not rewrite the head during the sealed release arm                    | Preserves wake/park certificates and head modification time used by parked-MCP retention.                          |
| Failure recovery    | Exact release retry; lease expiry remains the fallback                   | A lost acknowledgement or crash cannot strand the Session or create a second writer incarnation.                   |

## 4. Capability and compatibility

`ManagedSessionStoreModels.WriterGrant` gains the additive boolean `suspensionPlacementRelease`. The control plane advertises it only when `qwen.managed-agent.wake-dispatch.enabled=true`; it is not an independent rollout switch.

The TypeScript grant parser, renewal merge and `HttpManagedSessionStores` expose `supportsSuspensionPlacementRelease()`. A Harness attempts the new release only when:

- the Session has a pool placement; and
- the current writer grant advertises `suspensionPlacementRelease`.

Otherwise suspension remains byte-for-byte on the current path. In particular, a new Harness with an old Store sees no capability and retains the placement, while an old Harness with a new Store simply never uses the new arm.

Deploy the control plane before the Harness. Roll back the Harness before the control plane. The additive grant field is safe for old readers, and the existing release route and receipt shape do not change.

## 5. Harness suspension flow

The existing suspension gate and eligibility checks remain unchanged. The teardown order becomes:

1. Close wake scheduling and drain Hooks, MCP, Runtime ownership and publishers as today.
2. Stop writer and activation renewal.
3. If the capability applies, quiesce the current placement with the still-active writer grant.
4. Release the activation and confirm the wake-stamped writer seal.
5. Release the placement with the same placement epoch, writer generation, journal revision and activation commit proof.
6. Stop local Store access and event streams, remove the resident and clear the suspension gate.

Quiescing and the confirmed seal are separate teardown milestones. A retry after a confirmed seal skips renewal, quiescing, activation release and the seal itself; only the remaining placement release is retried. A retry with an uncertain seal keeps the current reconciliation behavior, and never repeats a quiesce already confirmed.

`session.ownershipRelease` memoizes a newly generated operation ID and the activation commit proof across retries. The release client retains its grant after sealing and uses it only for this release operation; all ordinary writer operations remain fenced. A rejected release promise is cleared so the next attempt resends exactly the same request, never a new operation ID or proof.

The suspension gate stays closed throughout. If release does not complete, the resident is not returned to ordinary service.

## 6. Store release transaction and fencing

`JournalWriterLifecycle.releaseOwnership` keeps its existing drain arm and gains a clean-sealed arm. Both use the current lock order and transaction:

1. Verify tenant/workspace/Session credentials and the placement HMAC before resource lookup.
2. Lock the tenant placement guard, tenant publication guard and Session root in the existing order.
3. Replay an exact saved receipt before current-owner checks; a conflicting receipt for the same epoch is refused.
4. Require the current `QUIESCING` placement and no lifecycle claim.
5. Lock the head and verify its tenant/workspace/Session scope.

The clean-sealed arm requires all of:

- head state `SEALED`;
- the request's writer ID, writer generation and writer-token hash exactly matching the sealed incarnation;
- the existing exact journal revision, committed sequence and commit-prefix digest proof;
- `activation_phase='released'` and `activation_head_revision == journal_revision`;
- `wake_seal_revision == journal_revision`.

The sealed arm does not require an unexpired writer lease: the sealed incarnation and generation are the write fence. It does not update the head. The drain arm retains its current `ACTIVE` head and unexpired-lease requirements and performs the existing `ACTIVE → SEALED` update.

Both arms insert the same release resource, domain record and resource reference, then change the placement to `RELEASED` in the same transaction. All SQL remains tenant-scoped and parameterized. A stale owner cannot release a newer epoch or generation, and an old exact retry can only return its original receipt.

`JdbcHarnessPlacementStore.takeover` and `HarnessPoolConnector.select` need no change. A released placement already triggers reselection, and the existing receipt plus sealed-head proof permits the CAS before lease expiry.

## 7. Failure and race semantics

| Window                                            | Required outcome                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Quiesce succeeds, seal does not                   | Placement remains `QUIESCING`; no receipt exists. A successor waits for lease expiry, while the old writer reconciles the seal. |
| Seal request outcome is uncertain                 | No release is attempted until the same memoized seal is confirmed.                                                              |
| Seal commits, release fails                       | Retry only release with the same operation ID and proof. If recovery is later required, lease expiry remains safe.              |
| Release commits, acknowledgement is lost          | Exact retry returns the saved receipt, including after a successor takeover.                                                    |
| A reacquires before release                       | Acquisition changes the sealed incarnation and clears its wake stamp; the old release is refused.                               |
| B takes over after lease expiry before A releases | A's old epoch/token cannot release B's placement.                                                                               |
| Release commits before A crashes                  | A's old placement and writer are fenced; B can take over immediately.                                                           |
| Two successors race                               | Session-root locking and the epoch CAS admit exactly one successor epoch.                                                       |
| Decision races an Action park                     | Existing freeze and approval-revision rules decide the winner; release adds no new execution path.                              |

## 8. Affected files

### Control plane and contracts

- `packages/managed-agent-server/contracts/.../ManagedSessionStoreModels.java`: additive writer-grant capability.
- `packages/managed-agent-server/server/.../ManagedSessionStoreController.java`: advertise the capability with wake dispatch.
- `packages/managed-agent-server/persistence/.../JournalStoreRows.java`: expose `wake_seal_revision` on the locked head row.
- `packages/managed-agent-server/persistence/.../JournalWriterLifecycle.java`: clean-sealed release arm.

### TypeScript Store client and Harness

- `packages/core/src/managed-runtime/http-managed-session-store.ts`: capability parsing/exposure and release with the retained sealed grant.
- `packages/cli/src/serve/hosted-harness-session/session-suspension.ts`: quiesce/seal/release milestones and exact retry.

### Tests

- `HarnessPlacementStoreTest` and its MySQL subclass: release, replay, negative proof, certificate/head-timestamp preservation, rollback and successor fencing.
- `http-managed-session-store.test.ts`: capability, post-seal release and lost-acknowledgement replay.
- `hosted-harness-session.suspension.test.ts` and Action-parking tests: ordering, retry, capability-off behavior and certificate preservation.
- `HostedHarnessPoolMySqlIT`: real-process A-to-B takeover before lease expiry.

## 9. Validation plan

- Prove the baseline refusal of a post-seal release and the current sticky placement before implementing.
- Cover capability-off behavior, bare-seal refusal, stale wake revision, wrong generation/token/proof, lagging activation and cross-tenant credentials; none may write a receipt or change placement/head state.
- Prove exact replay, conflicting-operation refusal, rollback atomicity and stale-writer fencing on H2 and the selected MySQL 8.4 cases; retain the existing takeover-CAS coverage.
- Prove release preserves wake, background and parked-Turn certificates; the successor's acquisition clears them only under current semantics.
- Inject a lost release acknowledgement and a failure after seal; verify same-body retry without another quiesce, activation release or seal.
- Run real Harness processes A and B against MySQL 8.4 for a cleanly idle-suspended Session, with A healthy and its old lease live. Verify Action parking through the new-epoch cold-recovery unit test and the real-process replacement scenario for every outcome. A healthy two-member Action-parked soak is a follow-up, not evidence claimed by this slice.
- Run focused TypeScript and Java checks, the required root build/typecheck/bundle, and leave complete Java/MySQL/Hosted profiles to CI.

## 10. Acceptance criteria

- Unsupported or bare-seal suspensions behave exactly as before.
- A supported clean suspension writes one durable release receipt and leaves `RELEASED + SEALED` state without changing the wake/park certificate.
- B can acquire the next placement epoch while A is healthy and A's old writer lease is still live.
- A cannot commit, renew, seal or release B's resources after the transition.
- Cancellation, Allow, Deny, mode change and expiry retain their existing behavior; Allow executes exactly once and Deny zero times.
- No release attempt repeats quiesce, activation release or seal after those steps have completed.
- No new configuration, public route, schema migration or takeover proof exception is introduced.

## 11. Cost and follow-up

Each supported suspension adds one quiesce update and the release receipt writes. The sealed release arm deliberately avoids a second head update. Rollout measurement must compare these writes and the extra cold-open churn with the Harness/renewal resources saved and the value of immediate reassignment.

The [departed-placement reaper](2026-11-26-managed-departed-placement-reaper.md) handles legacy suspended rows and crashes between seal and release without inferring a release receipt from a bare sealed head. A separate real-process soak should also keep both pool members healthy through an Action-parked Allow/Deny handover; the clean-release slice does not claim that integrated evidence.
