# Session commands without the tenant guard

[English](2026-11-03-managed-session-commands-tenant-guard.md) | [简体中文](2026-11-03-managed-session-commands-tenant-guard.zh-CN.md)

## Problem and current state

The [Turn admission design](2026-11-03-managed-turn-admission-tenant-guard.md)
removed the tenant placement guard from Turn submit and made migration prepare
check idleness on committed data after locking the storage's fence row. About
twenty other Session commands still begin with
`WorkspaceMigrationAdmission.lockTenant`, so every rename, model or approval
change, MCP or extension check, task cancel, context compression and action
response in a tenant queues on the same row, without the five-second bound that
Turn submit had.

## Criteria

A command can drop the guard only if all of the following hold:

1. **Migration.** Work that migration's idle check counts (Turns, `CLOSE`,
   `ARCHIVE`, `DELETE`, `ACTION_RESPONSE`, `CWD_CHANGE`, `TASK_CANCEL`, pending
   `SESSION_COMMAND` receipts, open `RENAME` deliveries) is either created in a
   transaction that takes `requireOpen`'s locking read of the fence row, or the
   command never checked the fence. In the second case it could already be
   admitted right after the fence committed, so an admission while prepare runs
   leaves the same state.
2. **No later guard.** Nothing later in the transaction takes the guard, so
   removing the first acquisition only removes a wait edge.
3. **No reader relies on it.** No other guard holder checks the command's rows
   with nonlocking reads and relies on the guard to keep them from changing.
4. **Snapshot after a lock.** After the guard is removed, the first statement is
   still a locking read (the Session row or Session root), so later checks read a
   snapshot taken after that lock.
5. **Idempotency.** Concurrent requests that share an idempotency key are still
   serialized by a lock the command takes, or the conflict is handled.

## Audit

Every command below starts with the Session row (`requireLegacySessionForUpdate`)
or the Session root (`requireLegacyMutation`) right after the guard (criterion 4).
CSI-pinned Sessions are refused by the `is_csi_guard` flag on that row, so CSI
retirement and its application inventory never see these commands' writes.
Lifecycle begin, including Workspace close, runs per Session and locks the same
Session row before it checks for open operations (criterion 3). Callees were
followed two levels deep; none takes the guard (criterion 2).

| Command | Decision | Reason |
| --- | --- | --- |
| `claimRename`, `settleRename`, `abandonSessionRename`, `retryRename` | Remove | Advance an existing `RENAME` delivery of this Session under the Session lock and the operation row's conditional update. |
| `completeSessionMutation`, `settleParkedRename`, `completeCwdChangeOperation` | Remove | Settle an existing command or operation of this Session, located with a locking read. |
| `changeSessionModel`, `changeSessionApproval` | Remove | The receipt scope is `(operation, Session, actor)`, so the Session lock serializes replays. `requirePolicyChange` checks the fence. The receipt is written `COMPLETED`. |
| `beginContextCompression`, `beginTaskCancelOperation`, `ManagedActionStore.admit` | Remove | The idempotency key is Session-scoped. Each checks the fence through `requireOpen` or `requireSessionOpen` before writing `TASK_CANCEL` or `ACTION_RESPONSE`, which the migration prepare fix covers. |
| `requireMcpManagement`, `requireExtensionManagement` | Remove | Standalone read-only validation transactions. The configuration commit validates again in its own transaction. |
| `beginSessionRename`, `beginSessionMutation` | Remove, with changes below | The command key is tenant-scoped, so two Sessions reusing one key were serialized only by the guard (criterion 5). The receipt's unique key now decides that race. |
| `insertWorkspaceSessionCommand`, `insertInternalTeamLeadSessionCommand`, `insertChildSession` | Keep | Not audited here. Creation relies on the guard coming before the transaction's first consistent read, and its Workspace resolution and admission helpers were not traced (criteria 2 and 4). |
| Lifecycle (`beginLifecycle`, `beginOperation`, `beginWorkspaceClose`, `beginChildClose`, `unarchiveWorkspaceSession`) | Keep | The L3 lifecycle protocol. Low frequency. |

## Design

Delete the `WorkspaceMigrationAdmission.lockTenant` call from the sixteen
commands marked "Remove". Rename and mutation admission also change:

- The replay probe in `beginSessionMutation` becomes a nonlocking read for every
  kind. `UNARCHIVE` used a locking read; on a missing key that gap-locks the
  tenant-shared receipt index, and without the guard two admissions of different
  keys would deadlock inserting into the same gap, the hazard Turn admission
  already avoids. The Session lock still serializes one Session's commands, and
  it is taken first, so the probe's snapshot follows it.
- A `DuplicateKeyException` from inserting the receipt means another request
  committed the same tenant-scoped key first, because every receipt unique key
  derives from it. Nothing has been written yet. The command re-reads the
  receipt with a locking read and applies the existing rules: a different
  Session or digest answers `409 idempotency_conflict`. If the engine still
  hides the receipt, it answers the same conflict.

Other code is unchanged. This depends on the migration
prepare change in the Turn admission design, because task cancel and action
responses create work that migration counts.

## Risks

- Commands for one Session still serialize on its Session row. Commands that
  check the fence briefly wait on the storage's alias and directory rows during a
  migration or physical fence.
- The lock order is Session row or root, then alias and directory, as in Turn
  admission and lifecycle begin.

## Verification and acceptance

1. `ManagedModelSelectionTest`: a model change completes while another
   transaction holds the tenant placement guard.
2. `ManagedSchemaSessionStoreTest` (and its MySQL subclass): with a snapshot
   pinned before another Session commits a rename under the same key, the
   rename answers `idempotency_conflict` and writes nothing.
3. Existing suites for rename, model, approval, MCP, extension, context
   compression, task cancel, cwd change, action response, migration and CSI
   Session refusal pass, including the MySQL profiles in CI.

## Follow-up

- Audit Session creation: trace its Workspace resolution and admission helpers
  and replace the guard's ordering role with a locking read of the Session's
  rows before its first consistent read.
