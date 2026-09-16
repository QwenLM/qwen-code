# ACP bridge control-plane / harness boundary

[English](2026-09-14-acp-bridge-control-plane-harness-boundary.md) | [简体中文](2026-09-14-acp-bridge-control-plane-harness-boundary.zh-CN.md)

Status: historical design and verification record for the lifecycle-registry,
handshake, transport and startup slices, 2026-09-15. The remaining split is now
implemented; final combined acceptance is tracked in the
[completion design](2026-09-15-acp-bridge-completion.md).
Tracks [#11866](https://github.com/QwenLM/qwen-code/issues/11866). Baseline code
and test observations refer to `9efdd898e7`; local implementation and verification
results are identified separately below.

## Problem and current state

At the baseline, `packages/acp-bridge/src/bridge.ts` contains 15,358 lines. Its
`createAcpSessionBridge` factory occupies roughly 12,585 lines and owns both
session policy and ACP channel supervision. The problem is shared responsibility
and mutable state, so moving the function into several files alone is inadequate.

The public `AcpSessionBridge` interface already exists in `bridgeTypes.ts`.
`ChannelFactory` and `AcpChannel` already exist in `channel.ts`; physical spawning
is implemented in `spawnChannel.ts`. Reuse these seams. `deriveConfig` belongs to
`packages/core/src/config/config.ts`, not this bridge; do not move it here.

Each bridge is bound to one canonical workspace. Sessions multiplex onto its
channel. One channel is available for attachment, but a replacement can coexist
with an old channel awaiting exit. `aliveChannels` deliberately retains the old
channel so synchronous shutdown can still reach it. `byId` is the session map;
it has a different owner and lifetime from this channel registry.

## Goals and scope

- Give channel supervision and session control explicit internal ownership.
- Preserve public bridge methods, ACP messages, HTTP/SSE behavior, errors,
  telemetry, ordering, and workspace isolation.
- Deliver independently reviewable PRs with behavioral evidence at each step.

This work does not implement Java serving, remote transport, `wake(sessionId)`,
`getEvents()`, a worker pool, or external event storage. The bridge currently
creates its `EventBus` and compaction engine in the hosting process. Retention
caps do not prove that every idle session consumes that amount of heap, and a
module split alone does not reduce retention.

## Ownership and internal boundary

| Responsibility                                                     | Owner after extraction                                                              | Boundary rule                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Workspace selection, trust, environment construction               | Existing runtime caller                                                             | Construct one bridge with the resolved workspace and dependencies; never select a fallback runtime inside the supervisor.        |
| Current channel, live channel registry, startup coalescing         | Channel supervisor                                                                  | Keep attach availability distinct from transport/process lifetime.                                                               |
| Factory invocation, ACP handshake, liveness and physical teardown  | Channel supervisor                                                                  | Consume existing `ChannelFactory`; report channel outcomes without mutating session policy.                                      |
| `byId`, default attachment, session creation/restore and ownership | Session control                                                                     | Bind each session to its actual channel; a replacement current channel does not acquire old sessions.                            |
| Prompt admission/FIFO, mid-turn promotion, terminal deduplication  | Session control                                                                     | Supervision must not own queues, terminal latches, or event publication.                                                         |
| Event/journal state, permission settlement, artifact forwarding    | Session control and existing modules                                                | Keep current persistence and publication order; do not create another storage or ingestion path.                                 |
| Worktree attribution                                               | Session control plus existing worktree operations                                   | Preserve per-session metadata and transfer barriers; translate the selected directory into ACP requests at dispatch.             |
| Idle and retirement policy                                         | Session control supplies eligibility; supervisor performs channel lifecycle actions | Include restore/new-session settlement, runtime reservations, workspace calls and child active-work holds before declaring idle. |

`BridgeClient` currently calls into session state and publication callbacks while
being constructed inside `ensureChannel`. In the completed split, compose that
adapter with the existing session lookup and handlers, and hand the resulting
ACP client to supervision. Do not pass the entire bridge, `byId`, or a shared
all-purpose state object into the supervisor. Keep session cleanup as a named
control-plane handler of channel exit, preserving its ordering relative to
registry cleanup and subscription closure.

The dependency direction is session control → channel operations, with explicit
ACP client and exit handlers supplied during composition. These are internal
TypeScript seams, not a new remote protocol or package export.

## First implementation PR: channel lifecycle registry

Start with the three lifecycle state slots: `channelInfo`, `aliveChannels`, and
`inFlightChannelSpawn`. Encapsulate their mutation in an internal
`channel-lifecycle.ts` module. Keep the existing `ChannelInfo` shape initially;
move its declaration to an internal type module if needed to avoid an import
cycle. Do not move `SessionEntry` or turn this into a generic registry framework.

The internal interface should expose only operations used by existing callers:

| Operation                           | Required semantics and current consumers                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read the current slot               | Preserve the raw slot, including a dying channel; `liveChannelInfo` retains its existing availability filter. Used by ACP callback routing, startup, liveness and idle checks.                    |
| Read or join the pending startup    | Share one startup outcome and clear its slot on settlement, including rejection. Used by `ensureChannel`, `doSpawn` telemetry, runtime status and shutdown.                                       |
| Track, publish and remove a channel | Track before awaiting initialization; publish only at the existing successful-handshake point; remove only on exit. An old exit clears the current slot only if it still names that same channel. |
| Inspect registered channels         | Membership and snapshots serve session-owner lookup, settlement/liveness guards, status, and both shutdown paths. Callers cannot add/delete through an exposed mutable set.                       |

Keep the startup body, runtime epoch allocation, `BridgeClient` construction,
exit side effects, `isDying` transitions, idle timers, and shutdown orchestration
in `bridge.ts` in this first PR. A startup callback may temporarily retain the
existing closure; this is an incremental ownership step, not completion of the
harness boundary. Keep the shutdown check and idle cancellation at their current
positions before startup reuse/coalescing. Preserve synchronous state visibility;
do not introduce an extra asynchronous dispatch hop.

Audit every read and write of the three old variables, including
`channelInfoForEntry`, `doSpawn`'s `reused`/`joined`/`spawned_on_request` telemetry,
`getWorkspaceRuntimeLifecycleSnapshot`, and in-flight shutdown waiting. The
channel registry must not decide admission, quarantine, runtime trust, or session
termination. New-session rejection on a quarantined channel is separate from
whether its existing sessions can continue using that channel.

Expected source scope: `bridge.ts`, the new internal lifecycle module, an internal
channel type file if needed, and collocated/focused tests. No edits to core,
routes, SDKs, package exports, or dependency manifests are expected. Prefer a few
hundred changed production lines; split further if this requires moving the
entire startup function or rewriting its callback wiring.

The first slice now keeps `ChannelInfo` and `createChannelLifecycle` together in
`channel-lifecycle.ts`; a separate type file was unnecessary. Its explicit
`ChannelLifecycle` interface exposes `current`, `starting`, `size`, `has`,
`values`, `track`, `publish`, `remove`, `startSpawn`, and `finishSpawn`. The set
itself stays private; `values` preserves the original live iteration semantics.
`startSpawn` returns the original startup promise synchronously, and the creator
still calls `finishSpawn` from its existing `finally` in `ensureChannel`. Session
cleanup, handshake publication and shutdown retain their original ordering.

## Second implementation slice: handshake protocol

Extract the synchronous ACP initialize request construction and capability
negotiation into internal `channel-handshake.ts`. Its two functions,
`createChannelInitializeRequest` and `negotiateChannelCapabilities`, consume
only the private parent capability, the resolved filesystem-read delegation
boolean, the initialize response and whether external tool enforcement is
required. The result contains negotiated active-work interval/categories and
channel-liveness support. It does not contain session state, the channel registry,
timers or transport objects, and is not exported from the package.

Keep all advertised metadata, protocol/client identifiers, filesystem flags,
required guard acknowledgement errors, version checks, interval clamping and
category filtering unchanged. An absent or unsupported optional capability must
remain unnegotiated; it must not be interpreted as an idle report. The private
parent capability must remain the same value sent to the physical factory for
that channel, including across replacement channels.

Keep the initialize call, remaining startup budget, timeout/transport race,
telemetry span and profile, failure teardown, runtime epoch and publication in
`bridge.ts`. Assign the parsed active-work capability with its initial `seq: 0`
inside the existing span callback, immediately after synchronous negotiation,
before the profiler and before returning the response. Assign liveness support
there too. Adding an asynchronous boundary or moving these assignments outside
the span could drop an early active-work snapshot and is out of scope.

Use the existing guard, private capability, file capability, active-work,
liveness and startup-failure bridge tests as regression evidence. Add focused
bridge-level coverage for unsupported capability versions and negotiation before
the initialize span finishes. Run those tests before the source extraction,
repeat the public HTTP/SSE baseline against global `qwen`, then build, typecheck,
bundle, run affected tests and repeat the E2E harness against the local bundle.
Acceptance is sole ownership of handshake wire construction/interpretation in
the new module, no additional async hop and no changed lifecycle or session
behavior. This slice does not complete startup supervision or the whole issue.

## Third implementation slice: transport operations

Move physical termination and the channel-unavailable race to internal
`channel-transport.ts`. `terminateChannel(channel, timeoutMs, context)` consumes
the existing `AcpChannel` and resolved bridge initialization timeout. It starts
`kill()` immediately, bounds its completion, attempts `killSync()` on failure,
and preserves the original rejection even if the forced signal succeeds. If
both operations fail, preserve their order in `AggregateError`. The bridge
continues to mark channels dying and stop liveness before requesting teardown.

Keep `channelUnavailableReject(channel, context)` synchronous: it returns the
existing race against process exit and, when present, transport failure, mapping
both fulfillment and rejection to `BridgeChannelClosedError`. Do not introduce
another async wrapper or eager subscription. The session and workspace-status
caches remain in the bridge so repeated commands reuse their existing rejection
promise and retain the actual owning channel.

Move the one existing `withTimeout` implementation unchanged into internal
`with-timeout.ts`, imported directly by both modules. Preserve its error type,
timer reference, cleanup in `finally`, and non-cancelling semantics. No timeout
policy or additional fallback is introduced. Keeping this dependency separate
avoids importing session code from transport operations or duplicating the timer
implementation.

Termination consumers are channel kill/idle retirement, pending-empty-channel
reaping, late factory disposal, connection-construction failure, initialize
failure, late shutdown, exit during initialize, invalid runtime epoch, and
bridge shutdown. Unavailability consumers are initialize, new-session creation,
the cached session race, the cached workspace-status race, restore, and
branch-session cleanup. Retain each call's original channel, context and timeout.
No route, registry, session-cleanup handler or package export moves in this slice.
Factory invocation stays in place because its abort controller and startup
budget also govern handshake and epoch failure; extracting it now would require
a broader startup boundary.

Before extraction, add bridge-level tests for a hanging teardown's deadline and
forced signal, combined graceful/forced teardown failure, and rejected transport
failure while a prompt is pending. Existing tests retain successful shutdown,
construction cleanup, overlapping old/new channels, handshake exit, restore,
status and command timeout coverage. Repeat global and local public E2E, build,
typecheck, bundle and focused tests. Acceptance is independent transport
operations with unchanged scheduling, errors, channel ownership and cleanup.

## Fourth implementation slice: startup orchestration

Move the complete asynchronous startup body into internal `channel-startup.ts`.
`createChannelStartup` owns the local runtime epoch and exposes a read-only
`epoch` plus `start`. The lifecycle registry still coalesces its raw startup
promise; `ensureChannel` retains shutdown admission, idle cancellation, reuse,
and the creator's `finally`. Initial epoch validation stays at bridge
construction, and all later epoch consumers read the startup owner's value.

Keep factory invocation, private capability and channel ID generation, the shared
startup clock and abort controller, construction failure cleanup, registration,
initialize, late-shutdown/exit checks, epoch validation, publication and liveness
installation within the same async function. Preserve every existing `await`
position. In particular, do not return from an async factory helper before
registration, and do not return initialized state to the bridge for later
publication. The initialize span still assigns active-work state before profiling
or returning. All existing errors, telemetry, time budgets and late-result
cleanup retain their ordering.

The bridge provides synchronous `constructChannelInfo`,
`handleChannelTransportUnavailable` and `handleChannelExit` actions.
`constructChannelInfo` keeps `BridgeClient`, guarded connection construction,
session sets and active-work callback wiring together; the startup owner retains
the surrounding physical construction-failure catch. The transport action clears
extension refreshes after the startup owner marks failure and stops liveness.
The exit action retains the complete ordered cleanup of timers, registry,
sessions, prompt terminals, attachments and event buses. Startup only registers
that action at the original point; it never receives `byId` or `SessionEntry`.
The existing `killChannelWithLog` action remains the liveness fallback, and
`isShuttingDown` reads live admission state. Other inputs are the already-resolved
factory, workspace, environment snapshot, timeout, telemetry, registry and epoch
source; external-tool-guard presence is still read at negotiation time.
`ChannelLifecycle` is exported from its internal module for this new type
consumer; no package export is added.

This slice moves startup ownership and its epoch, not idle/session policy or
exit cleanup ownership. It adds no public options, routes, package exports or
cross-package dependencies. Add deterministic bridge regressions before moving
production code for the factory/initialize shared deadline, synchronous channel
registration before the initialize span, and shutdown before publication.
Retain the earlier capability-sequencing, shared-startup, late-factory cleanup,
construction-failure and epoch tests. Run the global public E2E baseline, then
build, typecheck, bundle, focused tests and the unchanged local E2E. Acceptance
requires preserved event-loop ordering, correct session/channel ownership and
normal public behavior; the whole issue still includes further control-plane
and channel-exit separation.

## Subsequent PRs and related work

1. Separate channel-owned exit cleanup from session cleanup in the named exit
   action, then move it to the channel owner. Move idle scheduling only with its
   complete busy and reservation inputs. Expand the internal interface only for
   observed consumers.
2. Extract session lifecycle and then prompt admission/FIFO, mid-turn handling,
   terminal publication and artifact forwarding in bounded PRs. Retain the
   original factory as composition and the public interface as the facade.
3. Update both design versions with actual boundaries and verification evidence
   as each slice lands. File length alone is not acceptance evidence.

[#11867](https://github.com/QwenLM/qwen-code/issues/11867) can define and test the
external daemon contract in parallel. Process count and spawn coalescing belong
in bridge/lifecycle tests, not in a cross-implementation wire contract.
[#11868](https://github.com/QwenLM/qwen-code/issues/11868) owns event storage and
retention changes. Share the boundary with
[#11869](https://github.com/QwenLM/qwen-code/issues/11869), but do not make its Java
implementation a prerequisite for the first internal extraction.

## Validation and acceptance

Eight existing tests in `packages/acp-bridge/src/bridge.test.ts` passed during
the investigation (932 skipped out of 940). They cover workspace mismatch,
thread-scope channel reuse, concurrent mixed-scope creation, overlapping-channel
force-kill, same-session FIFO, single-scope spawn coalescing, channel-exit fan-out,
and concurrent active prompts. This is a focused baseline, not full-suite or E2E
certification.

Do not overstate that coverage: the mixed-scope test checks distinct sessions but
does not assert the physical factory count; the single-scope coalescing test can
be satisfied by the outer session-spawn deduplication. Three added tests in
`channel-lifecycle.test.ts` passed before extraction: independent thread-scope
callers share one physical startup and receive two sessions; shared startup
rejection permits a fresh retry; and an old exit preserves the replacement for
new sessions and existing-session prompts. They use controllable promises rather
than timing delays to hold startup and physical teardown open.

| Invariant                       | Required evidence for lifecycle extraction                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace isolation             | A mismatched request fails before another channel is created.                                                                                                                |
| Shared startup and recovery     | Independent session creates join one physical startup; rejection reaches both and a later call retries.                                                                      |
| Publication and startup failure | Existing preheat tests for exit during initialize, factory timeout/abort, late factory result disposal, and monotonic runtime epochs remain green.                           |
| Replacement and shutdown        | Old and new channels can overlap; old exit preserves the new current channel; synchronous shutdown reaches both; shutdown during startup cannot publish a late live channel. |
| Session behavior                | Same-session FIFO, cross-session concurrency, shared-channel sibling survival and exit fan-out remain unchanged.                                                             |
| Idle eligibility                | Reuse and timer cancellation, pending restores/new sessions, workspace operations and keep-alive reservations retain their current protections.                              |

Before production changes, write the executable E2E plan in `.qwen/e2e-tests/`
and dry-run its public create/prompt/SSE/delete and workspace-isolation scenarios
against the global `qwen` CLI. Use deterministic fake channels for internal
startup/exit races. After each source slice, run root build and typecheck, focused
package tests, and the affected E2E scenarios against the local bundle. The final
split also requires the full suite requested by #11866 and two clean self-audit
passes under `AGENTS.md`.

The initial documentation preparation attempted root `npm run build`; it failed
in existing core code because `@jitl/quickjs-singlefile-mjs-release-sync` and
`quickjs-emscripten-core` were unavailable, with consequent implicit-`any` errors.
A separate root `npm run typecheck` also failed with those errors and outdated
workspace declarations: for example, `DAEMON_SUBMITTED_PROMPT_META_KEY` exists
in the bridge source but was absent from its local built declaration. Running
`QWEN_SKIP_PREPARE=true npm ci` restored the locked dependencies without changing
manifests or lockfiles. Full root build and typecheck then passed before the
production extraction.

The global `qwen` 0.23.3 E2E dry-run also passed before extraction: workspace
mismatch returns 400, concurrent creates return distinct sessions, each SSE
receives its own prompt result and exactly one terminal, deletion returns 204,
and the sibling continues prompting after the first session closes. All three
model requests used a local fake endpoint; the daemon exited cleanly without
remaining test processes. The executable plan and report are in
`.qwen/e2e-tests/issue-11866-channel-lifecycle.md`.

After extraction, root build, typecheck and bundle passed, as did ESLint on the
three source/test files and formatting checks. The five affected bridge test
files passed all 965 tests. The same E2E harness passed against the local bundle;
normalized HTTP method/route/status sequences, three prompt terminals, fake model
requests and cleanup matched the global baseline. This validates the first slice;
it does not claim the full repository suite required for the completed split.

The second slice implements the two synchronous handshake functions above in
115 lines. Three added bridge-level tests passed before and after extraction:
unknown numeric and string capability versions remain disabled, and an empty
active-work snapshot received before the initialize span returns retains its
sequence so a later stale snapshot cannot overwrite it. The latter test also
accepts a newer report. A temporary mutation that delayed capability assignment
until after the span caused that test to fail; the mutation was then removed.
An AST comparison confirmed that the initialize request and active-work
interval/category expressions match the pre-extraction source. Root build,
typecheck, bundle, ESLint and all 981 tests in eight affected test files passed.

The second slice's public E2E also passed against the local bundle, matching
the repeated global baseline's HTTP sequence, prompt terminals, model requests
and cleanup. Both comparison runs exited normally with no remaining test
processes. An earlier global run passed the public assertions but exited 1
during shutdown; the report retains that intermittent baseline observation and
does not infer its cause. The separate plan and evidence are recorded in
`.qwen/e2e-tests/issue-11866-channel-handshake.md`.

The third slice's four new bridge-level tests passed before and after
extraction. They cover the exact teardown deadline and forced signal, retention
of that timeout after late completion, synchronous and asynchronous kill
failures combined with a forced-kill failure, and a rejected transport signal
closing a pending prompt before process exit. AST comparison verified the three
extracted function bodies, all nine teardown channel/context/budget inputs, six
unavailability calls and 47 other timeout calls. Root build, typecheck, bundle,
ESLint and all 985 tests in nine affected test files passed.

The third slice's public E2E matched its global baseline for HTTP results,
prompt terminals, model requests and cleanup. Both daemons exited 0; independent
process and TCP checks also confirmed no local test process or listening port
remained, with no shutdown error in the log. The separate plan and evidence are
in `.qwen/e2e-tests/issue-11866-channel-transport.md`. These results validate the
three local slices, not the completed issue or full repository suite.

The fourth slice's three bridge regressions passed before and after extraction:
30 ms spent in the factory leaves 20 ms for initialize from a 50 ms budget;
a microtask scheduled by connection construction can force-kill the registered
channel; shutdown waits for a pending factory without publishing its result or
allocating an epoch. Temporarily inserting an async boundary before registration
makes the second test fail because force-kill cannot find the channel. That
mutation was restored before final verification.

Independent AST comparison preserves the complete exit handler, client and
connection construction, initial channel state and transport error sanitizers.
The full startup body matches after normalizing the synchronous action calls
and live-state readers; the rest of the bridge factory matches after replacing
startup wiring and the four epoch reads. Initial build validation identified a
missing internal type export for the new registry consumer; after adding it,
full build, typecheck, bundle and ESLint passed. All 988 tests across ten affected
test files passed. Existing lifecycle, handshake and transport code/tests remain
unchanged except for that type export.

Independent review found that the shutdown-wait regression's original single
microtask wait could miss an early shutdown completion. The test now waits for
one event-loop turn while the factory stays pending. Removing the startup waiter
makes the original assertion pass but the strengthened assertion fail, confirming
that the revised test detects the missing wait. The production mutation was
restored; this correction changes only the test, and restarts final verification
and the two-pass self-audit.

The fourth slice's initial public E2E matches its global baseline for HTTP results,
prompt terminals, model requests and cleanup. Both daemons exited 0; independent
process and TCP checks confirmed no local test process or listener remained,
with no shutdown error in the log. The report and evidence are in
`.qwen/e2e-tests/issue-11866-channel-startup.md`. These results cover four local
slices, not the completed issue or a full-repository test run.

A later post-review local sanity run passed every public assertion but its
daemon exited 1: the child required SIGKILL after about five seconds and the
daemon reported incomplete shutdown. The harness itself exited 0, and no process
or listener remained. This run is a public-behavior match but a shutdown
mismatch, and is preserved separately in the startup E2E report. Its production
source fingerprints equal the earlier successful local run. The earlier global
handshake baseline also had a similar failure, but neither observation proves a
shared cause or rules out a startup-refactor contribution. A subsequent unchanged global run followed serially by a local run both
matched the original baseline and exited 0, with independent process/port
cleanup checks passing. Those successful reruns do not erase the exit-1 result.
The shutdown cause has not been established and is not claimed fixed by this
extraction.

A subsequent investigation reproduced exit 1 twice in the unmodified global
binary with 32 valid skills in an isolated user configuration, including once
without instrumentation. In the instrumented failure, closing the workspace
watcher during Config shutdown blocked synchronously in macOS FSEvents until
the parent's five-second TERM grace expired. This establishes a native watcher
shutdown failure that does not require the extraction; it does not retrospectively
attribute every earlier failure to the same operation. The separate reproduction
script now fails on a nonzero actual daemon exit. With the existing
`CHOKIDAR_USEPOLLING=1` launch setting, the same fixture passed public checks and
exited 0 against both global and local binaries, with process/port cleanup
confirmed. Polling is a tested mitigation, not a default change or permanent fix.
Production code remains unchanged. Evidence and limitations are recorded in
`.qwen/issues/issue-11866-shutdown.md` and
`.qwen/investigations/issue-11866-shutdown/journal.md`.

Acceptance for the first PR is single ownership of the three lifecycle slots,
no mutable registry escape, no changed observable behavior, and the evidence
above. Acceptance for the completed issue additionally requires that supervision
no longer captures or mutates the session registry, queues, terminal latches or
event stores. No public wire/type change or new behavior is part of either gate.

## Risks and remaining decisions

The main risks are changed callback timing, losing a dying channel, routing an
old session through the replacement channel, dropping shutdown waiters, and
confusing runtime activity with an empty session map. Review those consumers
against the exact source revision for each PR.

Startup now uses explicit synchronous construction and cleanup actions, while
`ChannelInfo` still contains session-owned fields used by the existing policy.
Further exit/idle extraction must separate those responsibilities rather than
treating this transitional type as a final transport interface. It does not
freeze a future JVM-facing ABI. Worktree execution remains session-specific, so
a later harness interface must carry that attribution without rebinding the
workspace.
