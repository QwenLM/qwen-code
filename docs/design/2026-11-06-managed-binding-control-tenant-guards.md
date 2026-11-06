# Runtime binding control without the publication guard

[English](2026-11-06-managed-binding-control-tenant-guards.md) | [简体中文](2026-11-06-managed-binding-control-tenant-guards.zh-CN.md)

Status: implemented.

## Problem

Runtime binding control (`compareAndSet`, `claimOperation`, `renewOperation`,
`releaseOperation`) called `JdbcCsiFilesRetirementGuard.lockBindingControl`. For a
session-class binding that took:

1. tenant `runtime_placement`;
2. tenant `output_publication`;
3. the Session root, then its slot and binding rows.

Lease renewal runs periodically for every claimed binding, so each renewal queued on
both tenant-wide rows.

## Why the guards are not needed

- **The publication guard serves only the CSI profile original.** `lockBindingControl`
  uses it to learn whether the tenant's retention root is initialized. The result
  matters only when the Session is pinned and this binding is its profile original.
  For any other binding, `lockManagedSession` answers null, or the binding id differs
  from the original's and the call is refused, whatever the guard says.
- **No publication guard holder relies on excluding binding control.** Its holders
  (lifecycle, writer acquisition, collectors, retention, CSI publication lanes and
  migration) do not read a binding's operation lease. Where they read a binding, they
  do so as a hint before their transaction or under `lockOriginal`.
- **A lease change needs no placement.** Claim, renew and release change only a
  binding's operation owner and lease. They move no binding out of its state and
  touch no slot. Like dispatch, they only need proof that the Session is not
  CSI-pinned, and the Session root decides that (part (a) of
  [2026-11-05-managed-dispatch-tenant-guards](2026-11-05-managed-dispatch-tenant-guards.md)).

## Design

1. **The publication guard only for a profile binding.** `lockBindingControl` takes
   `output_publication` only when the binding is in the CSI files profile.
2. **Lease changes use execution control.** Claim, renew and release call
   `lockExecutionControl`:
   - with an existing Session root, an ordinary session-class binding locks only that
     root, then its binding row;
   - without a root, and for a profile binding, the guarded path stays.
3. **`compareAndSet` keeps placement.** It takes placement right after binding control
   and may move a binding out of its state. Placement must precede the root, so it
   keeps the guarded path, now without the publication guard.

### Resulting orders

| Path                                | Order                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| Claim, renew, release (root exists) | root → binding                                                     |
| Claim, renew, release (otherwise)   | placement → (publication guard, profile only) → root → rows        |
| `compareAndSet`                     | placement → (publication guard, profile only) → root → rows → slot |
| Dispatch                            | root → binding → Runtime Session → execution                       |

Lease changes lock the root before the binding, like dispatch and every placement
owner. A missing root keeps placement, for the gap-lock reason given in part (a).

## Verification

- `ExecutionControlTenantGuardsTest` (H2) and `ExecutionControlTenantGuardsMySqlIT`:
  - with a root, claim, renew and release complete while placement and the
    publication guard are both held;
  - without a root, they complete while only the publication guard is held, and wait
    while placement is held;
  - `compareAndSet` completes while the publication guard is held, and waits for
    placement.
- `ExecutionControlTenantGuardsMySqlIT.dispatchBesideBindingControlOfTheSameSessionDoesNotDeadlock`
  races dispatch with claim, renew and release of the same binding, with and without a
  root.
- Existing binding repository, CSI retirement and Runtime broker suites.

## Risks

- A future publication guard holder that reads a binding's lease and expects binding
  control to wait would race. None does today.
- A CSI profile binding keeps both guards, unchanged.
