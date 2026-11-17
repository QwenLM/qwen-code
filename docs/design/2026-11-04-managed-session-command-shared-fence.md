# Shared storage fence for Session command admissions

[English](2026-11-04-managed-session-command-shared-fence.md) | [简体中文](2026-11-04-managed-session-command-shared-fence.zh-CN.md)

## Problem and current state

The [lock scope design](2026-11-04-managed-lock-scope.md) split the storage
fence check into read-only admission, which takes shared locks on MySQL, and
storage mutation, which keeps exclusive locks. Turn admission, rename and
mutation admission, ordinary journal commits and inline tool results use the
shared form. Six Session command admissions still take the exclusive form, so
every Session on one storage queues on its alias and directory rows while it
only checks that the storage is open:

| Admission                  | Call                                                      |
| -------------------------- | --------------------------------------------------------- |
| MCP management check       | `AgentSessionPolicies.requireMcpManagement`               |
| Extension management check | `AgentSessionPolicies.requireExtensionManagement`         |
| Model and approval changes | `AgentSessionPolicies.requirePolicyChange`                |
| Context compression        | `AgentExecutionOperations.beginContextCompression`        |
| Task cancel                | `AgentExecutionOperations.beginTaskCancelOperation`       |
| Action response            | `ManagedActionStore.admit` (through `requireSessionOpen`) |

## Design

Each of the six calls `requireOpenForAdmission`; the action response calls a
new `requireSessionOpenForAdmission`, which resolves the Session's storage as
`requireSessionOpen` does. On H2 both keep the exclusive fallback.

The lock scope design's rule holds for every one of them: after the check, the
transaction never updates or exclusively locks the same alias or directory
row. They write the Session row, its command receipts, its operations and
journal-adjacent rows. `requirePolicyChange` is called only by the model and
approval changes; the MCP and extension checks run in their own read-only
transactions.

A fence writer (migration prepare, physical fence, maintenance) takes the rows
exclusively, so it still waits for every admitted command and then closes
admission; task cancel and action responses, which create work that migration
counts, are then seen by migration prepare's committed-read idle check.

## Kept exclusive

- `JournalWriterLifecycle.lockPublicationWriter`: the receipt lane
  (`ToolPublicationAdmissionStore.commitReceipt`) commits in the same
  transaction, and a commit with lifecycle authority or a CSI original takes
  the exclusive form. Sharing here would upgrade S to X in one transaction,
  which deadlocks two such transactions on one storage.
- Lifecycle begin and completion, Session creation (the worktree admission
  locks the same rows exclusively later), writer acquisition, storage
  registration, membership, maintenance, recovery and migration.

## Risks

- A later change that makes one of these transactions write the checked
  storage rows would introduce an S-to-X upgrade. The lock scope design's
  invariant, restated in the code comment on `requireSessionOpenForAdmission`,
  names that rule.

## Verification and acceptance

1. `ManagedLockScopeConcurrencyMySqlIT` (MySQL): while one transaction holds
   the Session-scoped read admission for a Session on a storage, another
   Session's admission on the same storage completes, and a fence writer waits
   until the first transaction ends.
2. Existing model, approval, MCP, extension, context compression, task cancel,
   action, migration admission and lock contract suites pass, including the
   MySQL profiles in CI.
