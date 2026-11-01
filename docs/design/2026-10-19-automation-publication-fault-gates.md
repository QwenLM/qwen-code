# FG11f: publication faults during an automation wake turn

[English](2026-10-19-automation-publication-fault-gates.md) | [简体中文](2026-10-19-automation-publication-fault-gates.zh-CN.md)

Status: slice 1 is delivered. All three in-process arms — `fail-before-write`,
`drop-ack-after-write` and `timeout` — run green against the packaged stack.
Slice 2 (publisher death) is scoped here and untouched.

Issue: #14446, the FG11 tracker. The tracker's gate table names FG11f as one
of the two slices the round owes. FG11c is delivered; this is the remainder.

## Why

Every automation gate so far stops at the automation ledger. FG11f asks a
different question: what happens to the **Shell output a wake turn publishes**
when the object store misbehaves, and does the run still settle exactly once?

Nothing in CI answers it today. The in-memory OSS stub
(`HostedGateTestSupport.stubPublicationOss`) accepts every object and has no
fault arms. `ToolPublicationStoreTest` injects failed writes on H2. The
tracker records `O4OssGate` as injecting real-bucket faults, opt-in and not in
CI.

The production seams this gate pins:

- `QwenHostedHarnessConnector.create` sets `captureBytes` when tool
  publication is on and the session profile is a public Shell or the internal
  team lead (the `create` builder).
- `ToolPublicationRetentionStore` writes through
  `ToolPublicationObjectStore.putIfAbsent` and marks the `OBJECT_PUT`
  operation `UNKNOWN` when the write throws (`:630-641`); a retry reconciles
  by reading the object first, and only one that cannot prove the object is
  refused with `409 tool_output_put_unresolved`.

## Fixture

The case lives in `HostedAutomationFaultGatesIT`, the class that already runs
the packaged stack for this domain: in-JVM Spring with the scanner enabled, a
real Harness behind `HostedLifecycleRelay`, a real MySQL schema and a model
stub. Its `createSession` already opens a workspace session
(`workspace-0` + `child`), so no new fixture is needed. What it does not do is
carry a tool profile: the case creates its own session from a stored
definition whose tools name `hosted_profile: hosted-workspace-shell/1`, which
is why the server also needs `definition-tool-profiles`.

A new case boots with:

- `--qwen.managed-agent.definition-tool-profiles=hosted-workspace-shell/1`
  and `--qwen.managed-agent.harness.workspace-shell-enabled=true`, so the
  session's definition may select the public Shell profile;
- `HostedGateTestSupport.toolPublicationArgs(port, bucket, bytes)`, the same
  16 properties the other publication fixtures use;
- an OSS stub with a fault schedule, registered before boot.

The model stub answers the wake turn with one Shell tool call and then a
final text. The automation definition targets that session, so the scanner's
fire wakes the turn and the Shell output is captured and published.

## Injection

The stub is extended with an optional fault schedule instead of adding a
second `ToolPublicationObjectStore` bean. Faulting the `OSS` client keeps the
real `AliyunToolPublicationObjectStore` adapter in the path, so the gate also
exercises its error mapping (`ToolPublicationStorageException`), which a
hand-written store would skip.

| Arm                         | Injected at `putObject`                                                                                     | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fail-before-write`         | Throw `OSSException` (`InternalError`) without storing the object                                           | The operation stays `UNKNOWN`; the next attempt reconciles by reading the object, finds none, and refuses with `409 tool_output_put_unresolved`. The tool result is honestly failed or unknown, and the Shell is not re-executed.                                                                                                                                                                                                                                                                                    |
| `drop-ack-after-write`      | Store the object, then throw `ClientException`, so the caller cannot tell a committed write from a lost one | The `OBJECT_PUT` row is transiently `UNKNOWN`; the resubmission is admitted off that state alone, and there is no claim to free — `abandonScan` resets claims only for the capture kinds, and an `OBJECT_PUT` row is inserted without one. The packaged caller resubmits the same operation and bytes, and the store then reconciles by reading the object and settling `RETURNED`; the gate asserts that final state, exactly one physical PUT, a byte-identical readable object, and no re-execution of the Shell. |
| `timeout`                   | Stay silent past `operation-timeout`, then throw `SocketTimeout` without storing the object                 | Same refusal as `fail-before-write`, and the wake turn's Workspace lease is released; one run, one Turn, one execution.                                                                                                                                                                                                                                                                                                                                                                                              |
| `publisher-death` (slice 2) | Park the put inside the child JVM, then SIGKILL it                                                          | On restart the run settles once from the journal; a committed object reconciles to `RETURNED`, an absent one refuses; the Shell is not re-executed and the lease is released.                                                                                                                                                                                                                                                                                                                                        |

The two shapes are deliberately different. `fail-before-write` pins the refusal
(`tool_output_put_unresolved`) and the honest failure; `drop-ack-after-write`
pins that a lost acknowledgement is never recovered by **writing the object
again** or by running the Shell again — the object is already there, and a
caller's resubmission reconciles by reading it, and the gate pins the final
`RETURNED` state rather than accepting a readable object as sufficient. A gate
that only injected one shape would leave the other half of the reconcile path
unpinned.

`publisher-death` needs the process to die mid-capture, so it uses the
child-JVM fixture (`HostedAutomationCrashFixtureMain`) rather than the
in-process class. Slice 1 covers the first three arms.

## Assertions

Each arm asserts the same four properties, and only the fault-visible ones
differ:

1. **One run, one Turn.** `ma_session_record` holds one `automation_run` for
   the session, and the run's persisted Turn identity is a single Turn. The
   model stub's prompt list cannot carry this property: the Shell-then-final
   flow sends two model requests inside one Turn. Count the occurrence's Turn
   in the Harness journal instead — the `turn.settled` event whose `turnId` is
   that run's automation input — or count only the initial model request and
   exclude tool-result continuations. `ma_turn` cannot witness this:
   automation dispatch commits its input through the hosted session journal,
   and the only production inserts into `ma_turn` are Session creation and
   public input admission.
2. **No recovery by re-execution.** `ma_tool_execution` has one row for the
   Shell call. A lost ack must never buy a second execution.
3. **Honest result.** The published object, when it exists, is byte-identical
   to the expected bytes and readable through the store; otherwise the tool
   result is explicitly failed or unknown, never a fabricated success.
4. **Settled once.** The occurrence is terminal exactly once, and the wake
   turn's Workspace lease is released — with no leftover `READY` owner row
   still holding it.

Slice 2 repeats 1, 2 and 4 across the kill.

## Fixture constraints

Running the first case against the packaged stack established three
requirements the fixture has to meet. They cost a run each to find, so they
are recorded here instead of being rediscovered:

- `harness.workspace-shell-enabled=true` refuses the server default
  `approval-mode: yolo` (`ManagedAgentProperties.validateWorkspaceFiles`), so
  the case boots with `default`.
- A definition whose tools name `hosted-workspace-shell/1` refuses `yolo` at
  admission ("Shell definitions must start with an asking policy", #13271).
  The case stores it with `default` and answers the wake turn's Shell
  permission action over
  `/api/agent/web-shell/v1/actions/{query,respond}`.
- A public Shell wake turn fails before any fault arm runs: the non-durable
  broker answers the Harness with `409 workspace_unavailable`, and the durable
  broker on an owner-private state directory still ends the turn in
  `WorkspaceExecutionStore.unavailable()`. Answering the Shell permission
  action — the `actions/respond` flow `HostedPublicWorkspaceIT` drives — does
  not change that. The session-level `authorize` passes for both a plain and a
  definition-backed Session, and the runtime session carries the workspace
  capability digest, so the refusing branch sits inside the acquire/claim path
  and is not yet pinned; slice 1 must locate it before a fault arm can run.

## Limits

- The arms fault the object store, not the network between Spring and OSS.
  `O4OssGate` remains the only real-bucket fault gate.
- `publisher-death` pins the publisher dying, not the Harness. A Harness
  death mid-capture is FG11c's `turn-crash` window.
- The stream-gap gate (`FG11e`) — the second gap the audit named — is
  untouched here.

## Acceptance

- Each slice green on JDK 21 with a real MySQL 8, selected with
  `-Phosted-automation-gates`.
- Every arm red at the site it names when its fault arm is removed.
- Budgets in `scripts/tests/hosted-process-ci.test.js` recomposed if the
  class's runtime moves; the class list is unchanged for slice 1.
- Delivered in both languages with matching structure.
