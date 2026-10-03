# Hosted cancellation fault gates (FG6d)

[English](hosted-cancellation-fault-gates.md) | [简体中文](hosted-cancellation-fault-gates.zh-CN.md)

## Problem and current behavior

Issue #12872 requires Hosted cancellation gates across the packaged Harness,
Session Store, Runtime Broker and real worker. FG6a already drops a prepared
cancellation reply, but does not prove what happens while a tool is physically
running. A cancellation acknowledgement is not evidence that the tool stopped.
The current private Hosted file profile supports Read, Write and Edit.

## Scope and design

Extend the existing Hosted Workspace integration fixture with a dedicated
cancellation driver. Spring and the independent JDBC assertions run in the
Java test process; the packaged Harness, real worker and MySQL/MariaDB remain
separate processes. No production protocol or behavior change is proposed.

| Case                 | Injection                                                           | Required result                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepared`           | Cancel through the Harness API while the real prepare reply is held | No start, Runtime execute or Runtime cancel; dispatch generation zero; cancelled result and Turn; released owner; cold load succeeds                                        |
| `running`            | Cancel after Edit enters the worker read barrier                    | Cancellation first remains pending with no terminal Turn or result and the same owner; only after the operation returns may the cancelled Turn settle and ownership release |
| `status-unavailable` | After running cancellation, fail the Harness's status request       | Session blocks, with no terminal Turn, outcome commit or release; later physical settlement cannot unblock it; cold load returns exact recovery-required 409                |
| `cancel-reply`       | Drop the real running-cancel reply after it applied                 | Same blocked contract, even after best-effort cancellation and later physical settlement; every request retains the original execution identity                             |

The worker imports the test-only `hosted-file-read-gate.mjs` wrapper around
`fs.promises.readFile`. After backup preparation, the driver creates
`proof.txt.read-gate` before forwarding start. The wrapper writes
`proof.txt.read-entered` when native Edit reaches the read and waits until the
gate is removed before calling the original reader. Keep the regular file
unchanged as `x` while testing cancellation. Observe the real
Runtime transport without changing its results: prepared cancellation has zero
execute/cancel calls, and running cancellation has no completed execute yet.
Independent JDBC checks require `CANCEL_REQUESTED`, null result, the original
storage owner, an `await_runtime` checkpoint and no terminal/result records.

For the confirmed running case, hold the first post-cancel status reply while
checking these facts. For the two unavailable-confirmation cases, keep the tool
parked until the Harness reports blocked. Then remove `proof.txt.read-gate`.
The real Edit may finish its one write as `xx` even though its execution status
is cancelled: this profile's Edit is not interrupted halfway through its file
read. Only prepared cancellation guarantees zero physical effects.

After physical completion, require exactly one original execution, one dispatch
for started cases, a cancelled result and exactly one physical effect. The
successful cases persist one tool result and one cancelled Turn, release their
owner and load in a fresh Harness. The blocked cases retain the owner and
unsettled input, reject new prompts and cold load, and never contact the model
or Broker during reload. A decoy file in the Harness directory stays unchanged.

## Implementation boundaries

- `integration-tests/helpers/hosted-cancellation-driver.ts`: actual HTTP faults,
  worker read-barrier coordination, public status/transcript checks and fresh-Harness reload.
- `HostedWorkspaceToolTurnIT.java`: add the four-case test to the existing real
  database fixture. Existing Hosted CI selection automatically includes it.
- A test-only cancellation probe: observe real Runtime calls and inspect SQL
  during the barrier and after completion, independently of driver assertions.

Use bounded HTTP, driver and test deadlines, restore transport observation on
exit, close driver-owned listeners and let the parent fixture forcibly terminate
and reap its owned workers, including failures before read-barrier entry. Do not
remove a held read gate during uncertain-effect cleanup merely to unblock Edit.
Preserve existing normal/FG6a/FG6b/FG6c gates. Keep documentation in both languages.

## Validation and acceptance

First attempt the baseline with the installed global CLI, recording when its
version cannot enter the private Hosted path. Then validate the built packaged
CLI against real MySQL or MariaDB with a deterministic fake model. Run build,
typecheck, bundle, targeted CLI tests, Checkstyle, all four cancellation cases
and existing Hosted controls. Observe database version and actual child workers.

Mutations must remove covered production guards while leaving the gate intact:
start despite an already-aborted signal, treat cancel-requested as settled,
release uncertain work, or admit an unsettled cold load. Each mutant must fail
a behavioral assertion; compilation errors, startup failures and timeouts do
not count. Restore the exact source and runtime before final verification.

Audit the full diff in open-ended and reverse passes until two consecutive
passes are clean. After round five, accept only Critical fixes. No Shell/provider
cancellation, SSE recovery, automatic continuation, orphan adoption, reclamation
or native Windows execution validation is included. The read barrier uses
regular files; the current process fixture still relies on POSIX process cleanup.
No unresolved design question remains.
