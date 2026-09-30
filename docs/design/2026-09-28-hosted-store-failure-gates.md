# Hosted Session Store failure gates (FG6b)

[English](2026-09-28-hosted-store-failure-gates.md) | [简体中文](2026-09-28-hosted-store-failure-gates.zh-CN.md)

## Problem and scope

Issue #12872 requires executable evidence that Hosted workspace tools respect
Session Store commit boundaries. FG6a covers Broker reply loss; FG6b covers
Store failures and applied commits whose replies are lost. This change extends
the existing packaged Harness → Spring Store → real MySQL/MariaDB and Broker →
worker fixture. It does not implement crash recovery, automatic tool replay,
shell tools, provider faults, or the later FG6 gates.

## Current behavior

Publishing a resource stages bytes in the Harness. The first referencing
transaction sends those bytes to the Store. Tool arguments and `tool.intent`
therefore share one atomic HTTP/SQL transaction. Broker prepare precedes that
commit; prepare reserves an execution without running it. The `await_runtime`
checkpoint must commit before Broker start.

After execution, the Harness commits the tool result message, then a
`results_ready` checkpoint containing the outcome resource. A failed or
unacknowledged write stops that authority's subsequent writes. The active
session blocks further prompts. An applied terminal commit can nevertheless
be recovered by a fresh authority reading the durable journal.

## Faults and expected behavior

| Case                | Injection                                                                                    | Required evidence                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `arguments`         | SQL resource insert rejects `managed-tool-input`                                             | No start/effect; entire intent transaction absent                                                    |
| `intent`            | SQL journal insert rejects `toolIntent`, after resource insertion                            | No start/effect; resources and references roll back                                                  |
| `await-runtime`     | SQL journal insert rejects the `await_runtime` checkpoint                                    | No start/effect; checkpoint transaction and staged resources roll back                               |
| `result-message`    | SQL journal insert rejects the tool result message                                           | Exactly one effect; no model continuation or terminal                                                |
| `result-checkpoint` | SQL journal insert rejects `results_ready`                                                   | Exactly one effect; result message remains committed; no model continuation or terminal              |
| `result-reply`      | Forward and consume a successful result-message commit, then close the downstream connection | Exactly one effect; cold read contains the applied transaction once; incomplete turn remains blocked |
| `turn-reply`        | Forward and consume a successful terminal commit, then close the downstream connection       | Exactly one effect; live session blocks, but cold load recovers the committed terminal turn          |

All cases use non-idempotent `edit` (`x` → `xx`, replacing all occurrences).
An accidental second execution yields `xxxx`. A decoy in the Harness working
directory and a missing parent-workspace file check the actual execution path.

## Fixture design

Reuse the saved Workspace/Session setup and existing Maven profile. Install
uniquely named, test-only SQL triggers restricted to the generated tenant and
session. Require each trigger's SQL exception marker in the captured server
output, so an unrelated HTTP 500 cannot qualify. Drop the triggers in fixture
cleanup. No production routes or schema are
added. A transparent HTTP proxy recognizes semantic events and checkpoint
resources, records the exact selected transaction, and forwards the original
tenant and writer credentials. SQL rejection and reply loss are distinct:
reply loss occurs only after a real successful upstream commit response.

For lost replies, replay the identical request directly against the Store and
require its original receipt with `replayed: true`. This probes the Store's
idempotency contract; it does not add automatic retry to the Harness.

After observing live failure, stop the old Harness and allow its short writer
and activation leases to expire. Start a fresh Harness for cold loads; a failed
authority cannot reliably commit the activation release needed by detach.
Observe transactions actually returned to that new Harness. Unsettled inputs
must return `hosted_turn_recovery_required`; the applied terminal case must
load successfully. Neither path may contact the Broker or replay a tool.
Activation bookkeeping may add transactions, so count the original identities
instead of assuming the entire journal is unchanged.

Independent JDBC assertions check physical effects, execution identity and
dispatch generation, workspace ownership, rollback, exact committed bytes,
unique events, journal continuity, and the durable head. The proxy report is a
description of the attempted operation, not the source of truth for success.

The driver is `integration-tests/helpers/hosted-store-failure-driver.ts`;
the Spring/SQL fixture is extended in
`packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedWorkspaceToolTurnIT.java`.

## Validation and acceptance

The global CLI baseline is attempted first; a CLI lacking Hosted support is
recorded as unavailable, not as evidence of passing behavior. Run the fresh
packaged CLI with the real database through `hosted-workspace-tools`, retaining
the original happy path and FG6a cases. Run build, typecheck, relevant focused
tests, formatting and Java checks. Remove commit ordering, rollback,
idempotency and recovery guards in temporary mutations and require the
corresponding gate to fail; restore and rerun the unmodified gate afterward.

Acceptance requires every selected fault to fire, all seven cases to satisfy
their physical and durable assertions, no tool reexecution on cold load, and
two consecutive clean open-ended and reverse audit rounds. After five rounds,
only Critical correctness, security, data-loss or regression fixes are in
scope. SQL triggers require permission in a dedicated test database; the
fixture is not intended for a shared production database.
