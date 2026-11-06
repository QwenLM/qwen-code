# Tool execution control without tenant guards

[English](2026-11-05-managed-dispatch-tenant-guards.md) | [简体中文](2026-11-05-managed-dispatch-tenant-guards.zh-CN.md)

Status: part (a) implemented; part (b) is a proposal.

## Problem

Every tool call admits an execution (`JdbcRuntimeBindingRepository.admitExecution`) and
then authorizes its dispatch (`authorizeDispatch`). Both call
`JdbcCsiActivationAdmission.lockForExecution`, which calls
`JdbcCsiFilesRetirementGuard.lockBindingControl`.

For a `session`-class binding, which is the default (`isolationClass = session`),
`lockBindingControl` takes these locks in order:

1. tenant `runtime_placement`;
2. tenant `output_publication`;
3. every slot and binding row of the Session;
4. the Session root.

For an ordinary (non-CSI) Session, `lockManagedSession` then answers `null`: the Session
is not pinned, and no CSI files profile slot or binding exists. The whole sequence only
proves that a binding is not CSI. Yet every tool call of a tenant queues on two
tenant-wide rows, behind binding transitions, provisioning, retention, maintenance,
collectors and writer acquisition. `admitExecution` also takes placement unconditionally
before all of this.

## Lock orders today

Placement owners lock binding rows and Session roots in both orders:

- **Binding, then root:** `lockManagedSession` and `requireProvisionPin` lock the slot and
  binding rows before `readPin` locks the root.
- **Root, then binding:** lifecycle verification (`verifyHarnessResources`), hosted
  cleanup commits (`HostedCleanupReferences`) and operator recovery.

Placement is taken first everywhere, so these never meet. A path that drops placement
must lock the root and the binding in one order that every remaining owner shares.

## (a) Execution control under the Session root

1. **One order: root, then slot and binding rows.** `lockManagedSession` and
   `requireProvisionPin` call `readPin`, which locks the Session root, before
   `readRuntimeRows`. Every placement owner now locks a Session root before that
   Session's slot and binding rows. The guards they take before the root are unchanged.
2. **Guard-free execution control.** `lockExecutionControl` serves `lockForExecution`, and
   so admission and dispatch. For a binding outside the CSI files profile, it locks only
   the Session root (`readPin`). It refuses if the Session is pinned to the profile, if
   the pin names a request key, or if a profile slot or binding is still present
   (`hasCsiRuntimeMarker`, a plain read). These are the refusals `lockManagedSession`
   makes for such a binding. A profile binding keeps the full guarded path.

   The path also requires an existing Session root. A locking read of a missing root
   takes only a gap lock, and gap locks do not exclude one another. So dispatch would
   not be ordered against binding control. Their binding lookups then lock the
   binding's unique index and primary key in opposite orders, and they deadlock. The
   MySQL stress test reproduced this. Without a root, which is not expected for a
   managed Session, execution control keeps the guarded path. A root deleted between
   the existence check and the lock is refused.

3. **Why the root is enough.**
   - The pin columns are on the Session root, so a pin change waits for this lock.
   - A profile slot or binding is created only by `requireProvisionPin`, which requires
     an already committed pin, so none can appear while the root shows no pin.
   - The binding's own state is then checked under its row lock in `authorizeDispatch`
     and `admitExecution`, as before.

Resulting orders:

| Path                                                     | Order                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Dispatch (non-Resident)                                  | root → binding → runtime Session → execution                                          |
| Admission                                                | placement → (storage, for shared Runtime Sessions) → root → binding → runtime Session |
| Binding control (`compareAndSet`, claim, renew, release) | placement → publication guard → root → slot, binding                                  |

No path locks a slot or binding and then a Session root while it holds no guard. Paths
that lock a slot and binding without the root (`findOrCreate` for an ordinary request,
`recoverLost`, Runtime retention) never wait for a root. Binding control and
`requireProvisionPin` keep both guards, so their behavior beyond the order is unchanged.

## (b) Admission placement (proposal)

`admitExecution` still takes placement first. Placement orders admission against the
harness drain fence. `requestHarnessDrain` inserts the drain row under placement, and
admission reads that row without a lock (`requireHarnessAdmission`). Removing placement
needs a row-level handshake. One option: admission materializes and share-locks the
harness head row, and drain locks it exclusively. That is a protocol change with its own
design and tests, so it is not part of (a).

## Verification

- `ExecutionControlTenantGuardsTest` runs on H2, and on MySQL through
  `ExecutionControlTenantGuardsMySqlIT`. It covers a session-class binding:
  - dispatch completes while placement and the publication guard are both held on
    another connection;
  - admission completes while the publication guard is held.
- `ExecutionControlTenantGuardsMySqlIT.dispatchBesideBindingControlOfTheSameSessionDoesNotDeadlock`:
  dispatches race claim, renew and release of the same session-class binding, with and
  without a Session root, with no InnoDB deadlock. Before the root-existence check, the
  case without a root deadlocked.
- `ExecutionControlTenantGuardsTest.withoutASessionRootDispatchKeepsTheGuardedPath`:
  without a root, dispatch still waits for a held placement guard.
- Existing CSI, Resident Workspace, Runtime broker, retention, binding control and lock
  contract suites pass, including the CSI MySQL suites.

## Risks

- Any remaining path that locks a session-class slot or binding and then that Session's
  root, while holding no guard, would deadlock against dispatch. The table above is the
  inventory. The CSI paths that lock rows before calling `lockManagedSession`
  (`findOrCreate` with `lockBinding`, `lockRuntimeSession`) hold placement, and they
  concern profile bindings. Ordinary dispatch on such a Session is refused right after
  its root read.
- A lingering profile slot or binding is detected with a plain read rather than a locked
  one. It can only disappear concurrently, not appear, so a missed one only means a
  refusal that should not have happened. It never admits a CSI Session.
