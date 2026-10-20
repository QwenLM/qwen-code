# Hosted Hook store-failure gates FG13b

[English](2026-10-20-hosted-hook-store-fault-gates-b.md) | [简体中文](2026-10-20-hosted-hook-store-fault-gates-b.zh-CN.md)

> The injection seam and the first two cells ship in one PR; the remaining
> three cells are planned and are not claimed implemented until each lands.

## Problem and scope

FG13b rejects each Hook durable commit inside the real Session store
transaction: the execution intent, `dispatch_started`, the execution result,
the plan record's result and the registration settle. A rejected write must
leave no physical call, no duplicate execution and a retryable record.

## Seam

`StoreFaultGate` (test-only) gains four Hook phases: `HOOK_INTENT`,
`HOOK_DISPATCH_STARTED`, `HOOK_SETTLED` and `HOOK_PLAN_SETTLED`. It matches a
`hook_execution` record by `hookExecutionId`, and separates the plan marker by
`hookId == "__plan__"`. `FaultingExtensionRecordStore` already wraps the store
bean; the Hook IT registers it through a test `@Configuration`, so every
commit still runs in the real transaction.

## Cells

| Cell                                                      | Inject                                  | Expect                                                                    |
| --------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `fg13bHookIntentStoreRejectionDispatchesNothingOnMySql`   | Reject the intent commit                | The injection fires; zero physical calls.                                 |
| `fg13bHookDispatchStoreRejectionDispatchesNothingOnMySql` | Reject the `dispatch_started` commit    | The injection fires; zero physical calls.                                 |
| result commit (planned)                                   | Reject the settled commit               | One physical call; a later status read settles from the worker's receipt. |
| plan result commit (planned)                              | Reject the plan marker's settled commit | The marker is rebuilt from the saved receipts.                            |
| registration settle (planned)                             | Reject the catalog settle               | The retry keeps the original operation id.                                |

## Witnesses

Measured on the `hosted-harness-mysql` lane, one mutation at a time.

- Arm the wrong phase, or leave the gate unarmed: `attempts` never leaves zero,
  so the cell reddens as a `ConditionTimeout` on that wait.
- Match only the MCP domains, so the Hook commit is never rejected: the same
  `ConditionTimeout` on `attempts`, since the injection never fires.
- Let every commit through with the gate still armed: the shipped 2–3 s window
  is too short to see it, and the cell stays green. Widening the window to
  25–30 s reddens it on the zero-`hook.call` assertion, so the window is the
  liveness bound rather than the assertion.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated cgroup
v2 root is the evidence. A skipped cell is not a passing gate.
