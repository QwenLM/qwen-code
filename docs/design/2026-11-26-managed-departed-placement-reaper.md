# Managed Departed-placement Reaper

[English](2026-11-26-managed-departed-placement-reaper.md) | [简体中文](2026-11-26-managed-departed-placement-reaper.zh-CN.md)

Status: implementation design, 2026-11-26. This is the failure/legacy-row counterpart to the [clean suspension placement-release design](2026-11-26-managed-suspension-placement-release.md).

## 1. Problem and current state

A clean suspension can release its placement only while the old Harness remains alive long enough to complete the release request. A crash between seal and release, a process that disappears before this feature lands, or a control-plane restart with a smaller static pool leaves an `ACTIVE` or `QUIESCING` placement owned by an absent member.

The existing request-driven takeover can recover after writer-lease expiry, but no background task enumerates these rows. A departed owner can therefore retain placement/connector metadata until a later request happens to select that Session. A member removed from static configuration after a control-plane restart has no in-memory `Member` object, so scanning the member map would miss the principal case.

A failed `readInstance()` alone is not authorization to reclaim. It is eligible only when the independent writer-lease and clean-seal proof is already sufficient for the existing expired takeover. Automatic reclamation is therefore limited to instances absent from the authoritative current snapshot or whose negotiated member is known unreachable; members with unknown health, healthy members and draining members remain protected.

## 2. Goals and scope

### Goals

- Reclaim expired, wake-stamped suspension placements whose owner instance is absent from the current pool configuration or known unreachable with the full expiry proof.
- Transfer each placement to a healthy accepting member through the existing takeover CAS, without manufacturing a release receipt.
- Keep the successor Harness unattached until a real request or wake requires recovery.
- Cover both legacy `ACTIVE` placements and `QUIESCING` placements left between quiesce/seal and release.
- Preserve tenant isolation, writer/activation fencing, wake/Action-park certificates and exactly-once recovery semantics.

### Non-goals

- Reaping a configured member merely because it is unreachable, draining, quiescing or has a new boot.
- Shortening a writer lease, treating `SEALED` alone as proof, inserting a synthetic release record or marking placement `RELEASED` without a receipt.
- Opening a Harness attachment, driving a Turn, delivering a decision or recovering Runtime/Tool state during the reaper pass.
- Reassigning arbitrary running Sessions, pending close/archive/delete lifecycle operations or rows without a current wake-stamped seal.
- New public routes, configuration keys, scheduler beans, schema fields or production dynamic-discovery implementations.

## 3. Design decisions

| Decision             | Choice                                                                                                              | Rationale                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Departure signal     | Instance absent from a `current=true` snapshot, or a negotiated member known unreachable plus the full expiry proof | Unreachability alone is never enough; healthy, draining and unknown-state members are excluded.   |
| Candidate proof      | Expired lease + `SEALED/READY` head + released/current activation + current wake seal                               | Reuses durable suspension evidence and excludes bare/stale seals and live writers.                |
| Ownership transition | Existing `takeover` to a healthy accepting successor                                                                | The expired arm already permits this CAS without a receipt; no second release protocol is needed. |
| Successor work       | Placement-only; no attachment or recovery RPC                                                                       | The reaper changes routing metadata, never executes Session work.                                 |
| Scheduling           | Bounded pass at the end of the existing synchronized pool refresh                                                   | Reuses the existing daemon and discovery snapshot without overlapping schedulers.                 |
| Batch size           | Up to 32 candidates per refresh                                                                                     | Bounds each pass; successful takeovers remove candidates so later passes make progress.           |
| Database access      | Distinct owner instances plus owner-scoped joins                                                                    | Uses `idx_ma_harness_owner`; avoids an unindexed fleet-wide `NOT IN` scan.                        |

## 4. Store candidate finder

`HarnessPlacementStore` gains `findExpiredSuspensions(excludedInstanceIds, limit)`.

The implementation first reads distinct placement owner instance IDs. For every instance absent from `excludedInstanceIds`, it performs an owner-scoped join between `ma_session` and the managed head, returning candidates until the requested batch is full. The finder returns existing `Placement` values only; it performs no writes.

A candidate must satisfy all of:

- placement state `ACTIVE` or `QUIESCING`, with an epoch below the counter ceiling;
- Session status `ACTIVE`, not retired and resource GC incomplete;
- managed head `SEALED`, recovery status `READY`;
- non-null writer lease at or before the database's current time;
- `activation_phase='released'` and `activation_head_revision=journal_revision`;
- `wake_seal_revision=journal_revision`.

The query orders candidates deterministically by tenant and Session ID. The owner distinct scan and each owner-scoped candidate lookup use the existing placement-owner index; no head lease/wake index is added.

The finder deliberately does not execute Turn/Runtime recovery predicates. A sealed head and expired writer fence the old incarnation, and the reaper only changes placement. The existing recovery/readiness and load paths still validate parked Turns, background obligations and cleanup when a real recovery is requested.

## 5. Refresh integration

At the end of `HarnessPoolConnector.refresh()`, after publishing `accepting` and before member pruning:

1. Return immediately when discovery is not current or no healthy accepting successor exists.
2. Exclude every configured instance except one whose negotiated member is known unreachable; members with no reliable health evidence remain excluded.
3. For each candidate, choose an accepting successor with the existing round-robin counter.
4. Call ordinary `placements.takeover(tenant, session, expected, successorInstance, successorBoot)`.
5. Ignore only expected per-candidate races: owner became live again, placement changed, Session disappeared or lifecycle admission changed. Other store failures retain the existing refresh failure behavior.
6. Leave connector pruning to `hasUnreleasedOwnership`; a successful takeover moves ownership away from the departed instance.

The reaper does not call `select`, `createOrLoad`, `recoverForWake`, `quiesce`, `releaseOwnership` or any leaf RPC. No new executor is introduced.

After a successful CAS, the placement is `ACTIVE` on the successor with `epoch+1`. The next request finds the healthy successor and issues a credential for that epoch; only that request/load acquires the writer and restores the Session.

## 6. Failure and race semantics

| Race                                    | Required outcome                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Configured member is unreachable        | It is offered only with the full expired clean-seal proof; a transient failure without that proof changes nothing.     |
| Discovery snapshot is uncertain         | No finder call and no takeover.                                                                                        |
| Configured member is draining           | It is not departed; request-driven drain behavior remains unchanged.                                                   |
| Old owner releases before the reaper    | The genuine receipt arm permits the same takeover CAS.                                                                 |
| Old owner reacquires before the CAS     | The head becomes active with a live lease; takeover refuses and later scans exclude it.                                |
| Reaper and request-driven takeover race | Expected owner/epoch plus the Session-root lock admits one successor; the loser receives `harness_placement_changed`.  |
| Two control-plane reapers race          | The same store CAS admits one epoch transition; no extra leader election is required.                                  |
| Old owner returns after takeover        | Its old placement credential and writer generation remain fenced.                                                      |
| No accepting successor                  | No finder write and no ownership change; the old placement remains for a later pass.                                   |
| Successor drains after selection        | The placement CAS may complete, but no attachment is opened; later load follows existing reselection/fencing behavior. |
| Pending lifecycle operation             | Ordinary takeover refuses it; the lifecycle-claim-aware path remains authoritative.                                    |
| Bare or stale seal                      | The finder excludes it; no receipt or forced release is invented.                                                      |

## 7. Affected files

- `contracts/.../repository/HarnessPlacementStore.java`: bounded candidate-finder contract.
- `persistence/.../JdbcHarnessPlacementStore.java`: owner discovery and parameterized eligible-row queries.
- `adapters/.../HarnessPoolConnector.java`: refresh-time placement-only reaper.
- `verification/.../HarnessPlacementStoreTest.java` and its MySQL subclass: finder eligibility, exclusions and existing takeover composition.
- `verification/.../HarnessPoolConnectorTest.java`: authoritative departure, restart-without-old-member, uncertainty, configured-unreachable, no-capacity and race behavior.
- `verification/.../HostedHarnessPoolMySqlIT.java`: real successor process, expired sealed legacy row, refresh-time CAS without attachment, then explicit load.

## 8. Validation and acceptance

- Before implementation, the same expired sealed fixture remains on the departed owner after refresh; no finder exists and no attachment-free takeover occurs.
- `ACTIVE` and `QUIESCING` candidates are found, while live lease, active head, bare/stale wake seal, lagging/active activation, non-READY recovery, terminal/retired/GC-complete Session and exhausted epoch are excluded.
- Configured-but-unreachable owners are reclaimed only with the full expiry proof; healthy/draining and unknown-state owners never reach takeover. Uncertain discovery and zero successor capacity are no-ops.
- A control-plane restart with only successor B in the member map still finds old owner A from SQL.
- Successful refresh changes only placement ownership/epoch/state. It creates no release record, opens no attachment and does not rewrite head, Turn, Action or journal data.
- A later explicit load on B restores the Session and fences A's old credential.
- Two competing takeovers produce one epoch winner; late old-owner release cannot mutate the successor epoch.
- H2 and selected MySQL 8.4 cases pass, along with the existing pool, drain, clean-release and Action-parking regressions.

## 9. Cost and follow-up

Each refresh performs one distinct-owner query and at most one bounded candidate query per departed owner, followed only by necessary takeover transactions. This is preferable to a recurring fleet-wide head scan. Candidate volume and query plans should be observed before increasing the batch size.

Boot-level reclamation when a still-configured instance has a healthy replacement boot, and real crash injection exactly between seal and release, remain separate work. Those cases retain the request-driven lease-expiry fallback and must not weaken this slice's proof requirements.
