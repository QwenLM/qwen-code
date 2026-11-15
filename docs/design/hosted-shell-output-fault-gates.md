# Hosted Shell output fault gates

[English](hosted-shell-output-fault-gates.md) | [简体中文](hosted-shell-output-fault-gates.zh-CN.md)

## Scope and current state

This is the Shell-output part of FG6f in #12872, based on merged #12848.
The explicit private `hosted-workspace-shell/1` profile already runs foreground
Shell through the packaged Harness, production Broker, worker and HTTP Session
Store. Existing coverage includes complete large output, lost start and raw-write
replies, content-publication failure, cancellation and retained output reads.

The missing gates exercise process loss during capture and the durable
`tool.receipt` transaction. They extend the Hosted MySQL integration family;
they do not enable capabilities or change production protocols. The seven-field
provider-reference and close-admission release gates still depend on #12868 and
are outside this slice. Completing this slice does not complete all of FG6f.

## Scenarios and required evidence

| Scenario           | Fault boundary                                                                                                             | Required result                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Publisher loss     | SIGKILL the Harness that owns the publisher after SQL has committed an output segment, while the original command is alive | Retained partial output cannot become an admitted complete result; no next model request, terminal Turn or replacement execution |
| Worker loss        | SIGKILL the actual worker at the same durable-prefix boundary                                                              | Original execution becomes unknown; incomplete output cannot permit continuation                                                 |
| Receipt failure    | A Session-scoped SQL trigger rejects `recordToolResult`                                                                    | No committed receipt or staged outcome resource; the physical command ran once, but continuation remains blocked                 |
| Receipt reply loss | Apply the original receipt transaction, then discard its HTTP response                                                     | Exactly one durable receipt and matching outcome; the unresolved Turn remains blocked and must not rerun the command             |

Every case checks one original reservation and dispatch, one filesystem effect
in the selected Workspace, an unchanged Harness-directory decoy and retained
Workspace ownership. A new Harness boot loads the same Session after the old
writer lease expires. Cold load must refuse the unresolved input without calling
the model or Broker. When the original Harness survives the fault, a new prompt
must also be refused with `hosted_turn_recovery_required`, without additional
model or Broker calls. A durable receipt by itself does not resolve the existing
`await_runtime` checkpoint or authorize automatic continuation.

## Fixture design

A dedicated TypeScript driver uses a deterministic local model and the existing
Hosted process helper. It proxies the Harness's Store and Broker requests to
select exact faults and records original identities and transaction bytes.
Successful execution responses must name the original execution; captured
identity fields must exist before they are compared with the saved reference.
The publisher runs inside the Harness; killing only a proxy would not exercise
publisher-process loss and is not used as its substitute.

For process faults, the command writes an append-only proof, publishes a known
1 MiB output prefix and waits on a FIFO. Injection requires a real committed
content resource, an executing Broker row and the original live worker and
Shell child. After publisher loss, the fixture lets that original command finish
against the dead publisher; after worker loss, it reaps the held child during
cleanup. This avoids timing sleeps and faults that happen before the tool starts
or after all output is complete.

A Java test probe independently reads MySQL or MariaDB, checks execution and
ownership identities, verifies journal continuity and resource hashes, and
owns worker/child signaling and cleanup. It targets only processes belonging to
the selected fixture. The receipt-failure trigger is scoped to its unique
tenant and Session and is removed in cleanup. Each case can be selected alone
for fault diagnosis and mutation checks.

## Validation and acceptance

The installed global CLI is tried first with isolated settings and a local model.
If its private Hosted profile is unavailable, record that startup limitation;
it is not evidence that a Shell fault reproduced. Verification uses the current
packaged local CLI and a real MySQL/MariaDB database, never H2 as proof of FG6f.

Run build, typecheck, bundle, focused Shell and Hosted unit tests, the new gate,
and the existing Hosted gate family. Check the original execution, persisted
receipt presence or absence, checkpoint, output bytes and process exit evidence
independently of the driver's success marker. Remove relevant production guards
in isolated mutation runs and require the unchanged gate to fail its behavioral
assertions. Restore sources and artifacts before the final normal run.

Failure cleanup must reap owned Harness, worker and Shell processes even when
injection or an assertion fails. Review the complete diff in open-ended and
reverse passes until two consecutive passes are clean; after round five only
Critical corrections are in scope.

## Boundaries and risks

These gates prove the current block-and-never-replay contract. They do not prove
or implement worker adoption, lease reclamation, automatic continuation, public
Workspace admission, provider controls, background Shell, PTY, remote
provisioners, object storage or real-model behavior. Retained partial output and
ownership are expected until the separate recovery work handles them. Process
control uses POSIX signals and the gate does not claim Windows coverage.
