# Managed Agent Monitor Auto-Stop: Remote Exit Evidence

[English](2026-10-11-managed-monitor-auto-stop-evidence.md) | [简体中文](2026-10-11-managed-monitor-auto-stop-evidence.zh-CN.md)

Status: implemented (2026-10-11). Implements #13896 on top of the H3
enablement (#13856, #13889). Related:
[H3 enablement](2026-10-11-managed-h3-enablement.md) (the hold rows and the
interim park this change replaces),
[H3 Shell/Monitor runtime](2026-10-03-managed-shell-monitor-runtime.md) (the
worker's `monitor-status`/`monitor-stop` route).

## 1. Problem

A Monitor watch runs in the worker, while the loop that owns its quota
(`max_events`) and idle window (`idle_timeout_ms`) runs in the Harness. Only
the Runtime's maintenance route can physically stop the watch, and before
this change only the Broker's own release sweep could reach it: the
client-facing control route admitted MCP and Hook operations alone. The
remote watch handle's terminate therefore stopped nothing.

The H3 enablement's interim (#13889) stopped the loop from claiming a
settlement it could not prove: an auto-stop parks the record on the
`recovery_blocked` / `runtime_lost` / `outcome_unknown` line instead of
settling `max_events` or `idle_timeout`. The watch kept running, kept its
`background_v3_monitor` hold row live, and kept its Runtime Session held
until the Session close's drain ended it.

## 2. Current state (verified at `1bbaf93e8d`, #13889 merged)

- `RuntimeBrokerService.control` routes anything that is not an MCP or Hook
  operation to `ProviderRuntimeProtocol.control`, whose default arm refuses
  a `monitor-*` kind with `runtime_control_operation_invalid`.
- `HostedMonitorRemoteExecutor`'s handle answers `terminate()` with `false`
  without asking anyone.
- `HostedMonitorLoop.settle(reason, true)` settles `max_events` /
  `idle_timeout` only when `terminate()` proves the stop, and otherwise
  parks the record (#13889). A park ends the loop's observing but leaves
  the record open: the watch's later exit, or the close's proven stop,
  still settles it.
- The worker's `ManagedMonitorRuntime.control` answers `monitor-stop` from
  its registry: `exited` with evidence once the watch's unit is proven
  empty, `unknown` otherwise. The registry's terminate resolves with the
  watch's completion, which delivers the capture's finalize to the Harness
  publisher before the answer returns.
- The Broker's transports (`HttpRuntimeTransport`,
  `WorkspaceRuntimeTransport`) already forward and validate `monitor-*`
  operations for the sweep; `ManagedMonitorProtocol.response` already
  requires evidence on `exited`.

## 3. Scope

In scope: the four items of #13896 — the Broker's admission of Monitor
operations on the client control route, a CLI `monitorControl()` wrapper,
a remote terminate that waits for the worker's exit evidence, and the
decision on worker-side bounds (§5.3).

Out of scope: admitting Shell maintenance kinds on the client route (no
Harness-side caller needs them); releasing a held Runtime Session early
once its last hold ends (the close still drains it, as for a background
Shell that exits on its own). A parked record that settles at its watch's
later exit is #13889's, not this change's.

## 4. Design

### D1. The client control route admits Monitor operations (Broker)

`control()` admits `ManagedMonitorProtocol` operations beside MCP and Hook:
`validateSession` checks the `sessionKey` against the acquired Session, and
both kinds are recovery kinds, so a stop reaches its watch even when new
admission is closed (a draining Harness). On top of the protocol's own
check, the operation must name one of this Runtime Session's watches:

- `operationId` is the execution that started the watch. The Broker reads
  its hold row (`<operationId>:process`) from the ledger.
- The row must be of the `MONITOR` hold family, belong to this Harness
  Session, Runtime Session, binding and generation, and carry
  `targetOperationId` as its `callId` — the Runtime call the worker derived
  the watch's unit from.

Anything else — another Session's key, another Session's watch, a
background Shell's row, a mismatched pair, a missing row, an id no hold row
can carry (a NUL, or too long once suffixed) — is refused with the
protocol's shape (400 `runtime_control_operation_invalid`) before the
worker sees it.

A Monitor control runs outside the control fence (the active-control count
a release's busy check reads), as the re-acquire scan's status ask already
does (#13830). The watch's hold row, not the fence, keeps the Runtime
Session from releasing while the watch may run: a routine release over a
non-terminal row answers `runtime_session_held`, and a drain issues its own
stop. Fenced, an auto-stop still waiting on the worker when the watch's own
turn finishes would turn that turn's routine release into
`runtime_session_busy`, which blocks the whole Session.

### D2. A proven exit settles the hold row at the route

When the worker answers `exited`, the Broker settles the watch's hold row
with that evidence exactly as the release sweep would
(`settleBackgroundProcess`). `running` and `unknown` keep the row. The hold
therefore ends with the auto-stop: the Broker no longer counts the watch, so
a routine release of that Runtime Session no longer answers held on its
account. The Harness itself still releases a held Runtime Session at the
Session close (§3).

### D3. `monitorControl()` and the remote handle's proof (CLI)

`HostedWorkspaceBroker.monitorControl()` posts to the same control route as
`control()` and `hookControl()`, but validates the watch vocabulary: the
answer names `targetOperationId`, its state is `running`, `exited` or
`unknown` (never the Hook/MCP `settled`/`outcome_unknown`), and `exited`
carries evidence.

`HostedMonitorRemoteExecutor` now receives the turn's broker, the Session
key, the start execution id and the Runtime call id. Its terminate issues
`monitor-stop` and answers `true` only for `exited`. A `running` or
`unknown` answer, a Broker refusal, a lost Runtime Session or a transport
failure all answer `false`.

### D4. The loop settles only on the proof, and one stop at a time

Since #13889 the loop's quota and idle stops settle `max_events` /
`idle_timeout` only when terminate proves the stop, and park otherwise.
With D3 the proof now exists, and a stop now takes a round trip to the
worker. While it waits, the loop keeps three rules:

- Only a loop that still observes starts an auto-stop. A window or idle
  timer that fires while another stop is under way stops nothing.
- The Session close's `loop.stop()` first waits for an auto-stop still in
  flight. A proven auto-stop settles the record, or, when its final output
  never landed, the close settles it at the stop's reason with no second
  stop (D5). Only its park leaves the record to the close's own stop.
- A stop whose exit settled the record before the stop's own answer
  returned keeps that settlement (D5).

The close's `loop.stop()` also reaches the worker for a loop that is still
live (the drain normally ended it first); its settle choice is unchanged.

### D5. The final output lands before the settle

The worker answers `monitor-stop` only after the watch's completion, which
includes the capture's finalize to the Harness publisher. The publisher
advances the record's output manifest to its sealed revision, then hands
the exit to the loop while the auto-stop is still waiting. That exit is the
stop's own evidence: the loop settles at the stop's quota or idle reason
from inside the finalize chain, and the finalize's `stopRequested` marker
does not override it. The worker's answer that follows finds the record
settled, and a lost answer changes nothing, because the exit already
proved the end. After the settle the record contract allows only
`notifiedThrough` to change.

A proven stop can still arrive before its exit. When the publisher refuses
that finalize (for example, a transient store failure on the final output
forward), the worker's completion records the delivery failure and keeps
the evidence, so `monitor-stop` still answers `exited`. No exit has reached
the loop, and the record's output is not sealed yet. The loop then keeps
the record open at the stop's reason, with no park and no terminal settle:
a terminal record would refuse the output revision that the publisher's
bounded redrive of the same finalize still has to write. The redrive
delivers the exit, and the record settles at the stop's reason with its
sealed manifest. If the redrive never lands, the Session close settles the
record at that reason with no second stop, since the stop is already
proven. Until then the record reads `running` for a watch that has ended,
while its hold row is already settled.

The exit chain itself never issues a stop. When a watch ends on its own (or
through a drain) and the final window its finalize flushes reaches the
quota, the window commits but does not fire the quota: the physical end
supersedes it and the record settles at the exit (#13856 R1-30). A stop
issued from inside that finalize would wait on itself, because the worker
answers a stop only after the same finalize returns.

## 5. Decisions

1. **The watch is named by its start execution and its Runtime call.** The
   Harness knows both, the hold row derives from the first and the worker's
   unit from the second, and the Broker binds them through the ledger. The
   lookup is by row id, not over live rows, so a stop or status for a watch
   that already ended still reaches the worker's retained receipt
   (idempotent).
2. **No Harness-side re-poll after an unproven stop.** The worker's stop
   already escalates from SIGTERM through the cgroup kill within its grace
   and answers `unknown` only when the unit refuses to empty. A short
   re-poll would not change that answer. The record parks, and the Session
   close's drain remains the backstop. A refusal or a transport failure
   parks the same way, with no retry: the park leaves the record open
   (#13889), so the watch's own end or the close's drain still settles it.
3. **No worker-side quota or idle bounds in this change (#13896 item 4).**
   The record's `max_events` requires `observationSequence == maxEvents`,
   counted in the Harness's debounced observation windows, which the worker
   cannot reproduce from raw lines: a worker-side quota would end the watch
   at a different point and project `stop_requested` or `exited`, never the
   quota. An idle bound could be mirrored approximately, but two clocks
   would then race for one reason. The remaining exposure — a Harness that
   dies and never reopens its Session — is shared with background Shells,
   so it belongs to a family-agnostic orphan policy (for example a hold
   lease the Harness renews), recorded as follow-up work rather than added
   per family here.

## 6. Constraints and risks

- **Mixed versions stay honest.** A new Harness against an old Broker gets
  the old refusal, terminate answers `false`, and the record parks as
  under #13889. An old Harness never sends Monitor operations.
- **A Broker that lost the Runtime Session** (restart) answers
  `runtime_session_not_found`; the stop is unproven and the record parks.
  The Harness does not re-acquire the Runtime Session for a stop.
- **A finalize the publisher refuses at the stop** still yields `exited`
  (the worker's completion records the delivery failure but keeps the
  evidence). The record stays open at the stop's reason until the
  finalize's redrive lands (D5). When the bounded redrive runs out, or the
  Session close settles the record before a pending redrive fires, the
  record settles with its output manifest still pending. Any terminal
  settle that runs ahead of a refused finalize has the same exposure.
- **An unproven auto-stop can end as `stop_requested`.** The worker marks
  the stop requested before it tries the kill. When that stop stays
  unproven and the watch ends later, its finalize carries the marker, and
  the open park settles the requested stop under #13889's rule for a stop
  after a park. The worker cannot tell that marker from a drain's.
- **An idle stop that lands inside a window's flush.** The window and idle
  timers are not serialized. When the idle timer fires while a window
  flush is still committing its observation, and the stop's settle commits
  first, the record contract refuses that late observation. A remote stop
  takes a round trip to the worker, so the local observation commit
  normally lands first. The shape is not specific to the remote stop: any
  stop that settles before a concurrent flush commits meets it. Closing it
  needs a window/settle order that does not wait on the exit chain (D5).

## 7. Validation

- Broker (`RuntimeBrokerServiceTest`): admission of `monitor-status` and
  `monitor-stop`, the hold row kept on `unknown` and settled on `exited`, and a routine
  release with no further maintenance call; a routine release that answers
  held, not busy, while a stop is still in flight; a completed Monitor
  control that ends no control fence, so a fenced control still in flight
  keeps the release busy; a stop during a Harness drain; refusal of another Session's key, of a watch that differs from the
  Session's in exactly one ownership field (Harness Session, Runtime
  Session, binding, generation), of a Shell row, a mismatched pair, a
  missing row and an id no hold row can carry, none of them forwarded.
- CLI: `monitorControl()` forwarding, its admission of `running` and
  `unknown` and its answer validation, and the
  refusal surfacing as a rejection (`hosted-workspace-broker.test.ts`);
  the handle's proof mapping (`hosted-monitor-remote-executor.test.ts`);
  the turn's wiring of the Runtime call (`hosted-workspace-tool-turn.test.ts`);
  `max_events` and `idle_timeout` settling through the real publisher only
  after the final output landed, including a final forward the store
  refuses twice whose redrive lands the sealed output before the record
  settles, and a natural exit that crosses the quota settling with no stop
  (`hosted-shell-publisher.background.test.ts`,
  `hosted-monitor-loop.test.ts`). The loop also pins the stop in flight
  (`hosted-monitor-loop.test.ts`): an exit that lands before the worker's
  answer settles at the stop's reason whether that answer is proven or
  lost; an end without evidence settles `watch_failed`; a close stop waits out the auto-stop and acts only on its park; a
  close stop keeps the settlement its exit made; an idle timer that
  fires inside the quota flush issues no second stop; and a proven stop
  with no exit keeps the record open and unparked until the exit arrives,
  or settles at its reason on the close.
- Mutation pass, run on the code merged with main: 27 mutants over the
  Broker gate, the row settle, each ownership check on its own, the id
  screen, the `unknown` keep, the control fence, the wrapper's validation
  and accepted states, the proof mapping, the exit chain, the turn wiring
  and each stop-in-flight rule, all killed. The second review round added
  five more: the completion's fence end, and four over the refused-finalize
  hold (settling on the proof, parking on it, dropping the kept reason, and
  the close's settle at that reason), all killed. The refusal path's fence
  end has no observable mutant. Its only throw is a dead Runtime process,
  which loses the binding first. A lost binding is never reactivated, a
  dead process does not become usable again, and both release checks of the
  fence run only after the lease proves usable.
- `npm run build && npm run typecheck`, the touched CLI suites, and
  `mvn test` / `checkstyle:check` for `runtime-broker`.
- Physical: not run in this change. The H3 rig's Monitor arm is where an
  auto-stop pass belongs (a watch with a small `max_events`, its hold row
  settled and a routine release succeeding before the close).

## 8. Acceptance criteria

1. A watch that hits `max_events` is proven stopped in the worker
   (`monitor-stop` answers `exited`) before its record settles, and its
   hold row settles without a Session close.
2. The same holds for `idle_timeout_ms`.
3. A stop the worker cannot prove still parks the record; nothing claims a
   settlement over a running watch.
4. Java and CLI tests pin both the admission and the refusal of a Monitor
   control operation that names another Session.

## 9. Open questions

1. The family-agnostic orphan policy for holds whose Harness never returns
   (§5.3).
2. Whether a held Runtime Session should be released as soon as its last
   hold ends, instead of at the close's drain.
3. An order between a window flush and an idle stop that keeps the late
   observation without waiting on the exit chain (§6).
