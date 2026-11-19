# Monitor run fault gates FG8a/FG8b/FG8d

[English](2026-10-15-monitor-run-fault-gates-abd.md) | [简体中文](2026-10-15-monitor-run-fault-gates-abd.zh-CN.md)

## Problem and scope

Issue #14163 tracks FG8's remaining fault gates for `monitor_run` and the
`child_run` `shell` kind. Slice 1 (FG8e/FG8f) landed as #14120
(`docs/design/2026-10-13-monitor-run-fault-gates.md`, the round design whose
shape, fixture discipline and gate ledger this document follows). This
document is the slice-2/3 design for **FG8a (lost replies), FG8b (store
failures) and FG8d (cancellation and drain)** — every case in the issue's
ledger, unchanged. **FG8c is out of scope**: it pins the restart behaviour
#13986 rewrites (#13986 is `CHANGES_REQUESTED` at design time), and stays
tracked by the issue until that PR lands.

Slicing decisions the round design recorded no longer hold: #14021 (FG8a's
prerequisite) merged as `7b95cfcb88`; #13918 (# then-store-failure taxonomy)
and #13986 (# then-cold-load backfill) are still open, and the issue+triage
answer the sequencing question they raised by keeping gates on
**physical / OS / store truth** — one process per dispatch, zero OS effects,
idempotent re-drives, byte-identical durable prefixes, honest terminal
states. Error-code wording and cold-load arms are #13918/#13986 ground and
this slice deliberately does not assert them.

It touches **no production code**. The rig is #14120's: one IT class
(`HostedMonitorRunFaultGatesIT`), one probe (`HostedMonitorRunProbe`), one
per-case TypeScript driver
(`integration-tests/helpers/hosted-monitor-run-fault-driver.ts`), real
packaged Harness, real MySQL/MariaDB, JDBC ground truth, and a named
mutation witness per gate.

## What the new letters share with slice 1

`runLetter` already owns: MySQL/Harness/node property gates, the
`-Dqwen.<letter>.case` selector, per-letter evidence rebuilt under
`target/fg8-cases/<letter>/`, one in-JVM Spring with the embedded broker,
per-case workspace mounts + JDBC-seeded registry/access rows, the
`HostedMonitorRunProbe` gate server, and the driver launch/readback
protocol (`FG8_CASE_OK`, letter terminal marker, `results.json`). The
`assertCase` half every letter shares — exactly one `<id>:process` row
(`ma_tool_execution`, the capability's at-most-one-physical-process proof)
— stays as is. New letters reuse `extensionRecord`,
`loadOutputRows`/`verifyOutputChain` (the FG8f output-chain walk) and the
observer/probe client helpers driver-side. Per-letter `@Timeout(600)`: the
host fork budget relation pins each ceiling plus the healthy allowance
inside the 1800 s fork; see the CI section.

## Scope decisions

1. **FG8c stays out until #13986 lands.** It intersects the exact
   cold-load/re-mint surface #13986 rewrites; writing it now means writing
   it twice. The IT class comment is updated to record a–d landing in two
   slices (a+b+d here, c later).

2. **Gates assert physical truth, not branch logic.** Triage's one
   substantive correction on #14163 stands: the `proven=false` collapse in
   `HostedMonitorRemoteExecutor.stop`, the routine/drain arm choice, and
   the `settleStopRequested` projection are all pinned in vitest today
   (`hosted-monitor-remote-executor.test.ts`,
   `hosted-harness-session.test.ts`, `hosted-child-run-session.test.ts`).
   What those tests structurally cannot pin — one physical process, zero OS
   effects, one journal row after a real dropped reply, a real transaction
   rollback — is exactly what every case here asserts through JDBC, the
   captured logs and the case-directory evidence. Expectation wording that
   only restates vitest assertions is dropped from the gate; where a case's
   natural outcome has two honest variants (e.g. a before-start cancel
   settling `cancelled` vs `start_failed`/`not_started_proven`), the gate
   asserts the row-level invariants and documents the settled form it
   observes, instead of betting on wording.

3. **The broker proxy grows real injection.** FG8a's dispatch/monitor-stop
   arms and FG8d's `cancel-reply-lost` land the first fault primitives in
   the broker-fronting proxy: a lose-once arm that forwards the request,
   consumes the committed upstream response, then destroys the client
   socket (so the Harness cannot mistake the loss for an HTTP refusal).
   Discrimination is by path-suffix operation (`:start`, `:cancel`) or, for
   monitor-stop, by parsed POST body (`operation.kind === 'monitor-stop'`),
   because every control call shares one path. The `#13896` control family
   has exactly one monitor control kind, so the body discriminant is
   unambiguous in this fixture.

4. **The driver speaks to the broker directly for FG8d's release arms.** No
   daemon route exposes routine/drain release; `cli.close()` releases
   through the drain arm but destroys the fixture. The driver therefore
   issues `:release` itself against the broker-base URL the Harness
   already trusts, with `protocolVersion: 1` and the
   `harnessSessionId`/`runtimeSessionId` identity the broker proxy
   captured from the dispatch traffic. This is the same wire the Harness
   would produce — the driver's role is trigger + witness injection, the
   production code under gate is the broker's arm split
   (`RuntimeBrokerService.releaseSessionAfterSweep`).

5. **FG8b's trigger facility follows FG7B, scoped per case.** One trigger
   per case, tenant- and case-scoped, installed before that case's driver
   work begins and dropped in the letter's `finally`, signalling
   `SQLSTATE '45000' SET MESSAGE_TEXT` = `FG8B_<case>`. The trigger
   refuses the case's commit kind **permanently**: a fire-once-then-disarm
   arm would let the publisher's re-drive heal over the blocking the issue
   gates ("a failed manifest commit blocks the run without re-executing
   it"), so there is no latch and no disarm. Every fire also writes an
   `fg8b_fire` row — MyISAM, so the row survives the signalled rollback,
   which is the only place arm-fired evidence can live — and the count is
   the case's attribution: the broker flattens this SQLException into
   `runtime_broker_internal_error`, so unlike FG7B's server-side commits
   the marker text never reaches captured output and an
   `OutputCaptureExtension` assertion on it is architecturally dead.

## The gate ledger

Ground truth per case is JDBC over `ma_tool_execution` (including `:process`
suffixed rows), `ma_session_record` bodies, the output tables
(`ma_resource`, captured manifests/page envelopes), plus the broker-proxy
operation log, the store-proxy commit log, the captured Spring output, and
the case directory evidence (producer markers, gate FIFOs, progress
files). Every case first asserts its fault actually fired: the proxy drop
count, the `FG8_DROPPED` line, the `fg8b_fire` fire count, or
the cancel/release answer's flags.

### FG8a — lost replies (4 cases)

The driver boots one Session per case through **both** proxies (broker
calls always traverse the broker proxy; the Session's
`managedSessionStore.baseUrl` is pointed at the store proxy). A lose-once
arm disarms after firing so a retried request passes normally.

| Case                        | Injection                                                                                                                                      | Expect (JDBC / evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dispatch-reply`            | Lose the `:start` reply once, after the broker committed the admission                                                                         | The retry resolves through the original `executionCallId`: exactly one `:process` row, exactly one physical process; the run completes; the child_run record settles from real exit evidence (`stopReason: 'exited'`, exit code 0) — never a fabricated settle; drop count = 1. The Broker answers `:start` once `beginDispatch` committed, before the worker necessarily wrote the producer's marker, so the driver waits until the run either started (marker present) or settled never-started before deciding whether to open the gate |
| `monitor-stop-reply`        | Lose the `monitor-stop` control reply once, after the stop committed                                                                           | The re-drive (auto-stop path parks, then re-asks by the same operation identity) hits the broker's terminal short-circuit: the record settles from real exit evidence with the quota stop (`stopReason: 'max_events'`), `observationSequence == maxEvents == notifiedThrough`; exactly one `:process` row; drop count = 1                                                                                                                                                                                                                  |
| `capture-commit-reply`      | Lose the reply to the journal commit whose fused `resources` array carries the `managed-tool-result-page` envelope — the envelope itself lands | The publisher's re-drive is idempotent: the verifyOutputChain walk finds every named page exactly once, byte-identical segments, no duplicated content rows; drop count = 1                                                                                                                                                                                                                                                                                                                                                                |
| `observation-advance-reply` | Lose one `commitMonitorRun` journal-commit reply after it committed                                                                            | `observationSequence`/`notifiedThrough` never skip ahead: the dropped advance stays behind until the re-drive lands it; final record carries `observationSequence == maxEvents == notifiedThrough`; drop count = 1                                                                                                                                                                                                                                                                                                                         |

### FG8b — store failures (4 cases)

Trigger DDL per FG7B, `fg8b_<hex>` names, `FG8B_<CASE>` message text
(`INVOCATION_COMMIT` / `PROCESS_LEDGER_COMMIT` / `MANIFEST_COMMIT` /
`PAGE_ENVELOPE_COMMIT`), plus one `INSERT INTO fg8b_fire` per fire.
Triggers are scoped to the case tenant and the case session, they refuse
the case's commit kind for the rest of the case, are installed before
that case's driver work begins, and are dropped in a `finally`. Every
case first asserts its trigger really fired through the `fg8b_fire`
count — a gate that silently never fired goes red on the fire count,
not on an outcome.

| Case                    | Injection                                                                                                                                                                                   | Expect (JDBC / evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invocation-commit`     | `BEFORE INSERT ON ma_tool_execution` (`NEW.harness_session_id = <session>` AND call-id has no `:process` suffix)                                                                            | Zero OS effects: no invocation row, no `:process` row, no capture registration (`ma_output_capture`/capture resources absent), no physical process ever (case directory has no `bg-started.txt`); the session turn settles without fabricating a background start — the blocked/blocked-settled form observed is documented gate-side                                                                                                                                                                                                                                                                                                                                                                                                               |
| `process-ledger-commit` | Same table, call-id suffixed `:process`                                                                                                                                                     | Invocation exists, `:process` row absent; the run blocks without a second admission (exactly ≤1 invocation row, no second dispatch in the broker operation log); no physical process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `manifest-commit`       | `BEFORE INSERT ON ma_resource`, `kind = 'managed-tool-result-manifest'` carrying `executionStatus: 'success'` (the capture's initial empty manifest must land, or the process never starts) | One `:process` row, one start attempt, and the settle-manifest commit never persists — and because the settle commit fuses the envelope into `commitChildRunRecord`, the refusal **blocks the run**: the producer exits 0 bounded-drop-quiet into a store that never journals its evidence, the record stays open forever (`running`, no stop proof, `stopRequested: false`, never re-executed); fire count ≥ 1                                                                                                                                                                                                                                                                                                                                     |
| `page-envelope-commit`  | Same table, `kind = 'managed-tool-result-page'`, permanent                                                                                                                                  | The same blocked form as `manifest-commit`: a 24-block capture fills no page before finish (a page holds 512 segments), so its only page envelope is staged when the stream seals and rides the next output-advance `commitChildRunRecord`; the refused page rolls that advance back, and every retry with it, because every later manifest (the finalize's success manifest included) still names the staged page — zero page rows, the settle manifest never lands, every committed manifest's page references resolve (only the initial empty manifest exists), and the record stays open (`running`, no stop proof, `stopRequested: false`, never re-executed); the witness is a refused advance that carried the page envelope; fire count ≥ 1 |

### FG8d — cancellation and drain (6 cases)

Production cancel surfaces the gate drives: the turn-level daemon cancel
(`POST /session/:id/cancel`, which aborts the live turn and drives the
turn's `broker.cancel` batch), and the broker `:release` maintenance
route with `drain: true`, issued by the driver under the Harness's
captured identity — the only stop surface a shell `child_run` answers
(the child-agent `children/operations` cancel family rejects shell
records outright, so this letter never drives it). The settle projection
under gate is `hosted-shell-publisher.ts`: a sink-side stop marker leads
to `requestStop` then `settleStopRequested`, the contract order, never
`exited`. Every driver release, routine or drain, is issued only after the
dispatching turn handed the Runtime Session back: every invocation row
terminal and the Harness's own turn-end routine release answered.
Earlier, the Broker answers `runtime_session_busy` for the foreground
work, or joins the release to the Harness's in-flight routine attempt and
answers it `runtime_session_held` even for a drain (seen on the Linux
rig); neither is a cell this letter gates.

| Case                        | Injection                                                                                                                                                                                                                                                                                                                  | Expect (JDBC / evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-before-start`       | Hold the `:start` request at the broker proxy _before_ forwarding; once the broker operation log shows the tool was admitted, issue the daemon cancel; then destroy the held request without forwarding                                                                                                                    | Zero OS effects: no `:process` row, no `bg-started.txt`, no capture rows; the invocation row settles by the broker's cancel path (`CANCEL_REQUESTED` → terminal); the child_run record is terminal, never `exited`                                                                                                                                                                                                                                                                                                                                                                                    |
| `cancel-during-capture`     | Mid-capture (≥3 full segments committed), arm the drain `:release` — the only stop surface a shell `child_run` answers                                                                                                                                                                                                     | The drain carries the stop command: `stopRequested: true` commits with the stop evidence and the run settles `cancelled` / `stop_requested`, never `exited`; one `:process` row                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cancel-status-unavailable` | Hold every Harness→Broker maintenance/status request at the broker proxy, then arm the drain during that outage (the Broker's own `shell-status` maintenance to the worker never crosses this proxy — see open question 1)                                                                                                 | The hold is positively witnessed — the driver issues the status read the Harness itself would (`GET /executions/<call>:process`, the Broker's real route) through the same proxy, the proxy names it as parked (a quiet Harness does not poll status on its own, so holding one of its calls would deadlock), and once released it must answer 200 for the same `executionCallId`; no terminal record is fabricated during the outage — the record keeps running, JDBC shows no settle truth; the drain still answers and, once released, the evidence settles the run `cancelled` / `stop_requested` |
| `cancel-reply-lost`         | Lose the store-commit reply to the drain-driven stop revision after it committed — the `commitChildRunRecord` whose shell record sets `stopRequested: true` with no stop reason yet, matched by content because every shell revision (admit, dispatch, attach, each output advance, the settle) shares that operation name | The committed record carries `stopRequested: true` anyway; exactly one committed stop revision exists — one distinct journal `commandId` ever set the stop mark (the re-drive resends the same command), never a second revision nor a duplicate record row; drop count = 1                                                                                                                                                                                                                                                                                                                           |
| `routine-release-refusal`   | With the run live and the turn handed back (above), driver issues broker `:release` without `drain`                                                                                                                                                                                                                        | The answer is 409 with `code: 'runtime_session_held'`; nothing is stopped — no stop kind reached the worker (no `shell-terminate`/`monitor-stop` forwarded), the producer still completes its blocks, and once its gate opens it exits on its own (`settled`/`exited`/exit 0); the `:process` row stays `PREPARED` until then                                                                                                                                                                                                                                                                         |
| `drain-release`             | With the turn handed back the same way, driver issues broker `:release` with `drain: true`                                                                                                                                                                                                                                 | The drain arm issues the stop (`shell-terminate` observed on the maintenance wire); the run settles `cancelled` / `stop_requested` with `stopRequested: true`, never `exited`; the release answers `released: true` under the same captured identity the routine arm is refused on                                                                                                                                                                                                                                                                                                                    |

## Driver design

The driver keeps its three existing arming primitives and adds:

- **Broker lose-once arms.** `dropNextStart` / `dropNextCancel` /
  `dropNextMonitorStop` flags armed per case; the broker proxy consumes
  the upstream reply then `req.socket.destroy()`s (mirroring
  the store proxy's lose-once commit arm). A dedicated `holdsStart` arm
  parks the request _before_ forwarding (the `cancel-before-start`
  choreography), with a bounded release like `heldReplies`; the held
  socket is destroyed, never forwarded, after the cancel settles.
- **Store arms.** `dropNextPagePublish` (the journal commit whose
  `resources` array carries a page envelope), the operation-name filter
  for `commitMonitorRun`, and `dropNextStopRevision` (the
  `commitChildRunRecord` whose shell record first sets `stopRequested`,
  read from the commit's record bytes). An arm fires only on a commit the
  store accepted: a refused commit never landed, so it relays and the arm
  stays armed. The commit log the arms and the cases read is reset per
  case, like every arm.
- **Broker identity capture.** The broker proxy records the
  `harnessSessionId` / `runtimeSessionId` pair from each POST body, so
  the FG8d release driver reuses the production identity instead of
  guessing (the FG6 reply-loss driver asserts the same pair).
- **Broker control-channel observation.** Control calls are logged with
  their body `operation.kind`, letting FG8d assert "the routine arm
  stopped nothing" as an _absence_ on the maintenance wire rather than a
  timing race.
- **A `brokerRequest` helper** for `:release` (routine and drain), using
  the captured identity and `protocolVersion: 1`; answers are returned to
  the case as `{status, code}` for the flag assertions.

FG8d Sessions run a 10 s writer lease (`CANCEL_DRAIN_LEASE_MS`), the
same length as FG8c's crash Sessions (`CRASH_LEASE_MS`, landed in
#14407). The six FG8d cases share one tenant, and the fixture admits
four active captures (`active-captures=4`). A capture a case leaves
OPEN keeps the expiry its last grant renewal set (the writer lease or the
activation, whichever ends first), and grant renewals stop once the tool
call that launched the run returns, so under the default 60 s lease the
capture holds its slot for up to a minute after the case moves on. On a
fast host `drain-release` found all four slots held: its reservation was
refused (the store's "Publication capacity exhausted", which the Harness
logged as "The request is invalid."), and the run never started. Under a
10 s lease a capture stops counting within ten seconds of its last
renewal. FG8d's one store arm, `dropNextStopRevision`, matches a single
stop-revision commit, so the extra writer and activation renewals never
trip it.

The step/diagnose/FIFO discipline is unchanged; every new wait is a
state, never a sleep; the producers provide `bg-started.txt`,
`progress.txt` and the gate FIFOs; per-case directories stay the
cold-load evidence substrate (a case booting later files must be absent,
not merely unread).

## Probe design

No new probe phases are required. FG8a's record/assertions read the
existing `state` (executions incl. `:process` rows, monitors, childRuns,
resources) and `ledger` phases; FG8b's zero-OS-effects assertions are
JDBC inside the IT (the probe's tables are the same ones the IT queries);
FG8d's identity capture arrives via the driver-side broker proxy.

## IT design

`HostedMonitorRunFaultGatesIT` gains three letters as
`@Test @Timeout(600)` methods calling `runLetter`, reusing `assertCase`
and naming each letter's expectations:

- `fg8aLostRepliesResolveThroughTheOriginalIdentityOnMySql`
- `fg8bStoreFailuresLeaveNoOsEffectsOnMySql`
- `fg8dCancellationAndDrainSettleHonestlyOnMySql`

FG8b installs its triggers case-by-case through `JdbcTemplate` before
that case's driver portion runs — the letter runs cases sequentially, the
way FG7B installed rows in letter order — and drops every installed
trigger plus the `fg8b_fire` count table in a `finally`, so a failing
case cannot leak its arm into the rest of the fork. The monitor-bearing
assertions call the existing helpers; the zero-OS-effects and
blocked-publication assertions are new small JDBC queries over the same
tables, plus the `fg8b_fire` fire-count attribution per case, all listed
per case in the ledger above.

## Environment constraint discovered: cgroup v2

On macOS, `HookCommandIsolationUnavailableError` ("requires a delegated
Linux cgroup v2 root on this Runtime") is returned for **every** H3
tool that spawns a supervised process: the `monitor` and the background
`is_background:true` shell both refuse inside
`packages/cli/src/serve/managed-runtime-tool-executor.ts:1105/1331`
(`spawnBackground`/`runMonitor`). The result is that `run.execute` falls
to `not_started`, the tool's reply reports `start_failed`, and no OS
effect touches JDBC (no `:process` row, no admission row, no capture
registration). Independently confirmed by `fg8e/fg8f` letters merged in
#14120 failing in exactly the same shape locally.

This wall bounds local verification: a letter whose physical truth needs
a physical process (all monitors, all pattern producers) cannot be
validated on this machine without production code or Linux+cgroup. Cases
whose settle point sits **before** physical start — dropped `:start`,
negated commit before process spawn, cancel-before-start — resolve to
the same physical truth whether the runtime is cgroup-enabled or not,
and are locally verifiable. On CI (`hosted-harness-mysql`, Linux) the
letters run with cgroup v2 and the settled/exited forms gate instead.

## Mutation checks

Applied, shown to turn exactly its gate red, then reverted (backup-copy
mutations, no `git checkout` over uncommitted work), following the round
design's slice-2/3 list, refined here after reading the landed #14021
surface:

1. FG8a — the background re-admit keyed by a fresh identity instead of
   the original `executionCallId` (e.g. the re-drive minting a new call
   id): `dispatch-reply` goes red at two `:process` rows.
2. FG8b — the invocation commit proceeding without its `:process` row
   (skip `admitBackgroundProcess`): `process-ledger-commit` (or
   `invocation-commit`, whichever semantics the landed code gives the
   skip) goes red at its zero-OS-effects assertion.
3. FG8d — the routine release arm draining instead of refusing:
   `routine-release-refusal` goes red (no 409, the producer stops).
4. FG8d — the settle projection mapping a platform stop to `exited`:
   `cancel-during-capture` goes red at the `cancelled`/`stop_requested`
   assertion.

## CI wiring and budgets

The class name keeps the new letters in the `hosted-harness-mysql` lane
with no workflow change; `check-failsafe-reports.js hosted` enforces
execution; per-letter selectors work without pom wiring (same
`-Dqwen.<letter>.case` contract). Local runs use the
`hosted-monitor-run-gates` profile against a throw-away MariaDB datadir
(trigger privileges as with FG6b/FG7b).

`scripts/tests/hosted-process-ci.test.js` pins: fork literal 1800 s,
healthy allowance `hostedForkHealthySeconds = 1100`, the evidence-path
and cgroup pins, and the per-ceiling relation (ceiling + 1100 ≤ fork).
The FG8e/FG8f letters measured ~310 s on the lane. The three new letters
add(ing) wall time: they must be measured on the lane in this PR, and any
budget moves land **in the same PR** — pom fork budget, the
`hostedForkHealthySeconds` literal with its sourcing comment, the Verify
step ceiling if the fork moves, and `hosted-process-ci.test.js` along
with them, per AGENTS.md's workflow-meta-test rule. `@Timeout(600)` per
letter is kept so the per-ceiling relation still proves the shape.

## Validation and acceptance

- `npm run build && npm run typecheck && npm run bundle`; ESLint clean on
  the driver; prettier clean on both languages of this document.
- `mvn verify` for managed-agent-server (unit/H2 + Checkstyle + SpotBugs)
  after sibling installs (`../qwencode`, `../runtime-broker`).
- Each new letter green against a local MariaDB (`mysqld`, throw-away
  datadir), which requires trigger privileges; each case's fault witness
  (drop counters, `FG8B_*` marker, flags) positively observed; the
  letter's happy path (no arm) green; per-letter selector runs work.
- All four mutations individually red; sources restored; letters green
  again.
- `hosted-process-ci.test.js` green with any moved budgets;
  `check-failsafe-reports.js hosted` satisfied (full lane run is CI-side;
  the structural checks run locally).
- Two consecutive clean open-ended + reverse audit passes per AGENTS.md.

## Open questions

1. Whether `cancel-status-unavailable`'s hold point should be the
   broker-side maintenance proxy arm (chosen above) or a worker-side
   stampede — the former is what the fixture supports without production
   changes; settled at landing time: lane run 38868090681 showed a quiet
   Harness issues no status reads of its own (sixty seconds of armed
   silence), so the positive hold witness is a captive status read the
   driver issues itself through the same arm; the held surface stays the
   broker-side maintenance proxy arm. Review on #14334 sharpened two
   points: the captive read must use a route the Broker serves (the
   Harness's `GET /executions/<call>:process`), answered 200 after the
   restore, or a 404 passes for a recovery; and the Broker's own
   background maintenance (`shell-status`/`shell-terminate` from
   `RuntimeBrokerService` to the worker) never crosses this proxy.
   Faulting that link needs a production seam for the worker endpoint,
   so it stays out of this test-only slice and is tracked as a
   follow-up.
2. Whether FG8b's `manifest-commit`/`page-envelope-commit` letters should
   run a 24-block producer (FG8f's heavy path) or a shorter 4-block
   variant for wall time — decided by local measurement; the ledger's
   expectations are size-independent.
