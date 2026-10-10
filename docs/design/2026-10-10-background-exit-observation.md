# Background-process exit observation at Session (re-)acquire (#13533 B1)

[English](2026-10-10-background-exit-observation.md) | [简体中文](2026-10-10-background-exit-observation.zh-CN.md)

## Problem statement

A background Shell process that exits **naturally** — not stopped by anyone — is
never observed by the Broker in production. `observeBackgroundProcess` has no production caller; the only observation
entry is the release sweep (`settleUnprovenBackgroundRows`, called from
`releaseSession`). Two gaps
follow:

1. While the run's Session lives, its `:process` ledger row stays `PREPARED`
   after the process has exited until a release happens to sweep it.
2. After a Broker restart, the gap becomes permanent: the (re-)acquire scan
   (`scanExecutions`) filters with
   `needsReconciliation()`, which excludes `PREPARED`
   (`ToolExecutionRecord.java:320`), so the row is never asked about again — and
   if the binding is later judged lost, the run reports `runtime_lost`
   (abandoned) rather than its real, provable exit. An unknown/abandoned
   outcome is deliberately unreplayable, so a Session that only needed the exit
   fact parks instead of settling.

## Proposed change

Extend the (re-)acquire scan to observe non-terminal background `:process`
rows from durable evidence. For each such row in the scanned batch, run the
existing `observeProcessRow` primitive (one `shell-status` control against the
physical owner):

- An `exited` answer settles the row with that evidence
  (`settleBackgroundProcess` already maps exit code 0 → `success`, anything
  else → `error`).
- Any other answer, or a failed lookup, keeps the row non-terminal and holding
  — the wedge semantics are unchanged: an outcome that cannot be proven never
  becomes a claimed end.

The observation is fire-and-forget like the scan's reconcile arm: the acquire
does not wait on it, and a failed observation surfaces nowhere but the row
staying non-terminal.

## Design decisions

| Decision                                                      | Rationale                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller lives in `scanExecutions` (Session acquire/re-acquire) | The moments that need the exit fact are exactly (re-)acquire and release. Release already sweeps (`settleUnprovenBackgroundRows`, including its durable backfill for post-restart contexts); acquire was the gap.                   |
| Not a periodic sweep                                          | A scheduler would add `control` traffic to every ready Session forever, to maintain a fact nobody is reading. The design doc's Recovery section keeps restart mechanics unchanged; a per-acquire observation is exactly that shape. |
| Not the status read path                                      | No production caller reads a `:process` row's status today, and a read that mutates the ledger would break the Broker's evidence-pure read surface.                                                                                 |
| Not the daemon                                                | The daemon never names `:process` rows; the Broker owns the physical-observation contract (`shell-status` against the owner).                                                                                                       |
| Reuse `observeProcessRow`/`controlProcessRow` unchanged       | The primitive already carries the wedge semantics (settle only on proven `exited`; `requireUsableLease`; control fencing). The change is one scan arm, not a new mechanism.                                                         |

## Scope

- `RuntimeBrokerService.scanExecutions` gains the observation arm.
- One witness in `RuntimeBrokerServiceTest`.
- No daemon, contract, schema, or API changes. No new scheduler.

## Acceptance criteria

Per #13533 B1, and verifiable as written:

1. A background process's natural exit settles its `:process` row with exit
   evidence when the Session is (re-)acquired — including after a Broker
   restart, where the same run reports the same outcome as before the restart.
2. A witness test fails when the scan's observation arm is removed.
3. A row whose owner cannot prove the exit keeps its hold (no regression of
   the wedge semantics — the existing
   `unprovenProcessStatusKeepsItsHold`-style witnesses stay green).

## Validation plan

- Unit: witnesses driving a restarted Broker (a fresh
  `RuntimeBrokerService` over a `RuntimeRecoveryContract.Fixture`'s durable
  state, with an adoption-ready provisioner) over a provably-exited
  background row, asserting the settle-with-evidence at re-acquire; plus the
  unprovable arm, the broken-control arm, and the orphaned-row arm.
- Physical: on the Linux acceptance rig, start a background run whose producer
  exits on its own, restart the Broker (Spring), re-acquire, and read the
  `:process` row — it must be settled `exited` with the exit evidence, and the
  Session must not park.

## Open questions

None. The release-time sweep and its durable backfill stay as they are; the
turn-settle drain question is tracked separately in #13533 and is untouched
here.
