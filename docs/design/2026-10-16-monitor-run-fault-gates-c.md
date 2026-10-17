# Monitor run fault gates FG8c

[English](2026-10-16-monitor-run-fault-gates-c.md) | [简体中文](2026-10-16-monitor-run-fault-gates-c.zh-CN.md)

## Problem and scope

Issue #14163 tracks FG8's fault gates for `monitor_run` and the
`child_run` `shell` kind. FG8e/FG8f landed as #14120
(`docs/design/2026-10-13-monitor-run-fault-gates.md`, the round design)
and FG8a/FG8b/FG8d landed as #14334
(`docs/design/2026-10-15-monitor-run-fault-gates-abd.md`). This document is
the design for the last letter, **FG8c — process crashes**: the Harness,
the managed worker, and the background process itself are killed (or
stopped) for real under a live background run, and the gate pins what the
platform does next against JDBC ground truth.

FG8c was parked behind #13986 (restart-proof the held-Runtime drain
obligation), which rewrote the restart behaviour this letter pins. #13986
merged as `c24e99e9cb`, so the letter is written against the merged
surface.

The rig is #14120's and #14334's: one IT class
(`HostedMonitorRunFaultGatesIT`), one probe (`HostedMonitorRunProbe`), one
per-case TypeScript driver
(`integration-tests/helpers/hosted-monitor-run-fault-driver.ts`), the real
packaged Harness, the in-JVM Spring with its embedded broker, a real
MySQL/MariaDB, and a named mutation witness per case. Unlike the earlier
slices this one carries **one production fix**: the gate found that the
cgroup launcher reported a SIGKILLed background process as an exit with
status 1 (see "Finding: a signal death read as exit 1").

## Current state (verified)

Read at `main` = `b4614845f0` (which carries #14334 as `5af87595f3` and
#14303's never-started probe fan-out), and confirmed case by case on a real
lane
(Linux, cgroup v2, MySQL 8.4.6, JDK 21, the packaged CLI):

- **Topology.** The embedded broker spawns one managed worker per Harness
  Session binding as a direct child of the Spring JVM
  (`node dist/cli.js managed-runtime-worker`). The worker supervises each
  background run through a cgroup v2 unit (`qwen-bg-<callId>` /
  `qwen-mon-<callId>`): worker → launcher → shell → command. Nothing
  re-attaches a replacement worker to a running unit, and with
  `durable-local-process=false` the provisioner never produces
  stopped-writer evidence, so a lost binding is never released.
- **Harness restart.** The Harness observes a background run only through
  the worker's pushes into its in-process publisher; there is no
  cross-boot re-attachment. A reload therefore never re-learns a run. What
  #13986 restores is the obligation: at load the Harness reads the Session's
  live hold rows (`POST /tool-sessions:active-holds`) into its held set, and
  the close drains each with `{ drain: true }`
  (`packages/cli/src/serve/hosted-harness-session.ts:5849-5867`,
  `:9971-10013`).
- **Cold-load refusal.** A reload whose launch turn never settled is
  refused at the `unsettled_input` gate with 409
  `hosted_turn_recovery_required`, reason `turn_unsettled`
  (`hosted-harness-session.ts:5750-5776`). The never-started reconcile only
  reads the `:process` row and skips any row the broker still has — here a
  PREPARED one — as ambiguous (`hosted-never-started-reconcile.ts:76-90`).
- **Worker death.** The broker notices lazily (`isUsable` is
  `process.isAlive()`). A release over a dead worker is routed to
  `releaseUnusableSession` (`RuntimeBrokerService.java:2889-2894`), which
  turns the binding LOST without stop evidence and answers 503
  `runtime_reconciliation_required` (`:3015-3019`); the Harness close
  tolerates that answer, marks the drain unproven, and retires the Session
  (`hosted-harness-session.ts:9996-10013`). The background process survives
  the worker as an orphan.
- **Generation.** After the loss, the first warm answers 503
  `runtime_provision_failed`; the next one answers 503
  `runtime_broker_runtime_lost` (`RuntimeBrokerService.java:3864-3886`),
  after the reclaim's cleanup abandoned the generation's unsettled rows
  against `<bindingId>:1:journal-lost` (`:3888-3993`). The slot keeps the
  LOST binding
  active, so no generation 2 is minted: releasing a LOST binding requires
  loss **and** stop evidence (`RuntimeBindingRecord.java:202-204`).
- **Worker stop.** A stopped worker is still alive to the broker. A
  release sweep's status read runs into the broker's 30 s worker-request
  bound, the failure is swallowed (`RuntimeBrokerService.java:2769`), and a
  routine release still answers 409 `runtime_session_held`
  (`:2923-2953`). Nothing marks the Runtime lost; after `SIGCONT` the run
  continues and settles from its own evidence.
- **Monitor auto-stop.** An idle or quota stop asks the worker through the
  broker's `monitor-stop` (`hosted-monitor-remote-executor.ts:50-66`);
  anything but exit evidence parks the record
  (`hosted-monitor-loop.ts:459-472`) as `recovery_blocked` /
  `runtime_lost` / `outcome_unknown` (`hosted-monitor-session.ts:298-308`).

## Scope decisions

1. **The gates pin physical, ledger and record truth, not branch logic**,
   as #14334's scope decision 2 recorded. Every assertion reads JDBC
   (`ma_tool_execution`, `ma_runtime_binding`, `ma_runtime_slot`,
   `ma_runtime_session`, `ma_session_record` bodies, the session journal,
   the output resources) or the driver's physical evidence (signals sent,
   pids alive or gone, broker answers by declared code).
2. **No Spring kill** (round design decision 3). FG8c kills the Harness,
   the worker and the background process; the control plane stays up, so
   the in-JVM Spring and its probe keep serving ground truth throughout.
3. **The cases follow the code, not the planned table.** The round
   design's FG8c table predates #13986 and the merged recovery surface.
   Two of its expectations do not hold, and the gate pins what does:
   - a reload after the launch turn settled is **not** refused — it loads
     (200), restores the held Runtime, and its close drains the run it
     never saw;
   - an unsettled `child_run` does not move to a blocked state — the
     record stays `running` (only a monitor parks, and only through its own
     in-process loop). The gate pins that the record never settles on
     evidence nobody produced, and that the ledger tells the truth.
4. **A seventh case, `monitor-worker-kill`.** The planned table had no
   monitor case. A watch whose worker died is the #13896 rule under a real
   fault — the idle stop's `monitor-stop` meets a refusal, not a dropped
   reply as in FG8a's `monitor-stop-reply` — so it is gated here.
5. **One production fix, not a test workaround.** `process-kill` cannot
   pass honestly against the old launcher (see the finding below); the fix
   is small, sits on the evidence path both consumers already expect, and
   lands with unit tests in the same PR.
6. **Observed but not asserted: the orphan.** After a worker death the
   background process outlives the worker and the Session close in this
   topology; the Workspace-level cascade owns it (#13986 R2-1). Asserting
   the orphan would pin a leak; the gate only kills it in teardown.

## Finding: a signal death read as exit 1

The worker's exit evidence for a background run is the cgroup launcher's
own exit, and the launcher's exit handler ended with
`process.exit(code ?? 1)` (`packages/core/src/hooks/hook-command-cgroup.ts`).
A command a
signal killed has a null code, so the launcher exited 1: on the lane, a
SIGKILLed background process settled the `child_run` record `exited` with
`exitCode: 1, exitSignal: null`, and the `:process` row carried the same
evidence. Status 1 is a value the process never returned.

The fix re-raises the command's signal on the launcher itself, so its
waiter sees the same signal. Only the signals that cannot be re-raised
keep the old fallback: a core-dumping signal would dump the launcher too,
Node.js owns SIGUSR1 and ignores SIGPIPE. The hook runner reads the same
launcher and already treats a null exit code as "killed by signal"
(`hookRunner.ts`), a branch the old launcher left unreachable whenever only
the command was killed. Unit tests (SIGKILL, SIGTERM, SIGUSR2) pin the
behaviour and turn red on the old launcher.

The fix covers a killed process that is the launcher's direct child, which
is what a background Shell runs: `bash -c` execs a single simple command.
A compound command keeps bash in between, and bash's own status for a
signalled child (128 + N) is then the honest evidence of the process the
launcher ran.

## The gate ledger

Every case runs one Session (per-case workspace mount and storage) and a
background run launched by a turn whose first model call is the tool call,
under a 10 s writer lease: a reload outlives the killed writer without a
minute's wait, the capture a crashed or closed Session leaves open expires
within seconds — the fixture tenant admits four active captures, and seven
cases in a row under a 60 s lease exhausted it on the seventh — and a
renewal, due at half the lease, keeps 5 s of slack on a loaded lane. Common assertions for every case: the delivered signal is
the case's fault (the fault fired); exactly one broker `:start` was
answered across every boot, reload and later prompt, and exactly one
`:process` row exists (no duplicate dispatch); the Session holds exactly
one binding, at generation 1, and its slot's `last_generation` is 1 with
that binding active (no re-mint, in any case).

| Case                    | Injection                                                                                                                        | Expect (JDBC / evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-dispatch` | Park the committed `:start` reply at the broker proxy (the process already runs), SIGKILL the Harness, reload on a fresh Harness | The reload answers 409 `hosted_turn_recovery_required` / `turn_unsettled`; its broker traffic is reads only (the never-started probe's `status` read) and the model is not asked again; the run stays alive and unknown — record `running` / `dispatch_started`, `stopReason` null, `:process` row PREPARED, no `turn.settled` event in the journal                                                                                                                                                                                               |
| `harness-kill-capture`  | After the launch turn settled and ≥ 3 full segments committed, SIGKILL the Harness; reload; close                                | ≥ 3 full segments stand at the reload, which answers 200 and its only broker call is `active-holds`; the close sends exactly one release, `drain: true`, naming the launch turn's Runtime Session, answered 200; the drain is what ends the process (alive after the reload, gone after the close); the `:process` row settles from the stop's evidence (`error`, signal, never `success`) and the Runtime Session is RELEASED; the record stays `running`; the durable prefix is byte-identical and nothing lands once the dead writer is fenced |
| `worker-kill`           | SIGKILL the case's worker under a live run; close                                                                                | The close's drain answers 503 `runtime_reconciliation_required` and the close still answers 204; the binding is LOST with no stop evidence, the `:process` row stays PREPARED, the Runtime Session is not released; the record stays `running`, `stopReason` null                                                                                                                                                                                                                                                                                 |
| `worker-stop`           | SIGSTOP the worker; a routine release from the driver waits out the broker's 30 s worker bound; SIGCONT; open the run's gate     | The release answers 409 `runtime_session_held` after ≥ 25 s; during the stop the record is `running`, the `:process` row PREPARED, the binding READY; after the resume the run settles from its own evidence — record `exited`, exit 0; `:process` row SETTLED `success`, exit 0; the binding stays READY                                                                                                                                                                                                                                         |
| `process-kill`          | SIGKILL the background process itself (pid from the producer)                                                                    | The record settles `exited` with `exitSignal: SIGKILL`, `exitCode` null, `stopRequested` false; the `:process` row is SETTLED `error` with the same evidence; the binding stays READY                                                                                                                                                                                                                                                                                                                                                             |
| `generation-remint`     | SIGKILL the worker; two more prompts each ask for a foreground Shell; close                                                      | The first prompt's warm answers 503 `runtime_provision_failed`, the second's 503 `runtime_broker_runtime_lost` (each prompt's only refusal); no other execution row exists (nothing ran on the lost generation); the binding is LOST with loss evidence and no stop evidence; the `:process` row is ABANDONED against `<bindingId>:1:journal-lost` with no result; the close's drain answers 503 `runtime_reconciliation_required`; the record stays `running`                                                                                    |
| `monitor-worker-kill`   | A watch with a 60 s idle window emits one observation and goes silent; SIGKILL the worker; the idle stop fires; close            | Every `monitor-stop` answer is a refusal (≥ 400); the record parks `recovery_blocked` / `runtime_lost` / `outcome_unknown` with `stopReason` null and `notifiedThrough == observationSequence ≥ 1`; the binding is LOST without stop evidence, the `:process` row PREPARED; the close's drain answers 503 `runtime_reconciliation_required`                                                                                                                                                                                                       |

## Fixture design

**Probe.** Two read-only phases join `state` and `ledger`: `workers`
answers the JVM's live children carrying the `managed-runtime-worker`
argument (the in-JVM broker spawns workers as direct children), and
`runtime` answers the Session's bindings (isolation is per Harness
Session), their slots and Runtime Sessions, and the full loss fields of its
execution rows. The driver diffs `workers` around a case's first dispatch
to name the one worker it signals.

**Driver.** One `runCrashCase` serves the letter. The broker proxy gains an
answer log (operation, status, declared refusal code, the control kind,
and a release's Runtime Session and arm) and one arm, `holdCommittedStart`,
which parks the reply to a `:start` the broker already committed and
destroys it after the Harness kill. The Session body is shared between
create and `/load` so the reload carries the new Harness's writer identity;
crash Sessions talk to the store directly, so a Harness killed mid-upload
cannot leave the store proxy holding an aborted request (and the broker
proxy treats a client gone mid-request as no request). The reload retries
the writer conflict until the killed writer's lease lapses — its last
renewal can commit just after the kill — and the segment count is taken
after the reload, when the dead writer is fenced and any commit it had in
flight has landed or been refused.
The model can answer a post-crash prompt with a foreground Shell
(`foregroundNext`), and the watch's idle window is 60 s for
`monitor-worker-kill` only: the window runs from the watch's last flush —
here its one observation — and on a loaded lane ~25 s passed between that
and the kill (a 10 s window expired first and the stop met a live worker),
so the case asserts the watch is still `running` at the kill. The worker is signalled by pid; the
background
process by the pid its producer wrote; the Harness by its child handle.
Every wait is a state, never a sleep, except the writer-lease lapse
before a reload and the pacing of its conflict retries. Teardown resumes a stopped worker and kills an orphaned
background process. `FG8_CRASH_STATE` lines trace JDBC snapshots;
`FG8_PROCESS_CRASH_OK` is the letter's terminal marker.

**IT.** `fg8cProcessCrashesNeverDuplicateOrFabricateOnMySql` runs the
seven cases through `runLetter` (`@Timeout(600)`, selector
`-Dqwen.fg8c.case`), and `assertCrashCase` holds every assertion in the
ledger, reading the session journal for the terminal-event check.

**Indexed ground-truth reads.** `ma_resource` keys on the Session's
`session_scope_key` and holds the inline capture bytes; the probe's `state`
reads and the IT's `extensionRecord` / `loadOutputRows` filtered it by the
unindexed `tenant_id` / `session_id` columns alone, so every poll scanned
all the inline capture bytes the lane had written. Within one lane run that data
only grows (FG8f inlines tens of MiB a case), and every later letter polled
slower: on a local table of 664 MB a case's "run live" wait took 12–15 s
instead of ~2 s, enough to push timing-sensitive waits past their bounds.
The reads now lead with `session_scope_key`
(`ManagedSessionStore.sessionScopeKey`), keeping the tenant and session
predicates: the record-body read moves from a full scan to the
`uq_ma_resource_id` unique index and the resource listing to a
`session_scope_key`-led index; the `ma_session_record` read leads with the
same key for consistency.

## Mutation checks

Each was applied, shown to turn its case red, then reverted (backup-copy
mutations; TypeScript ones patched into the packaged bundle so the gate
runs the mutated binary):

1. `harness-kill-dispatch` — the cold load's `unsettled_input` refusal
   skipped: red at the reload status (expected 409, was 200).
2. `harness-kill-capture` — the #13986 restore dropped (the active-holds
   answer never seeds the held set): red at the close's releases (expected
   one, was none).
3. `worker-kill` — a release over a dead worker sent down the live-worker
   path instead of refused: the drain fails and so does the close (expected
   204, was 503).
4. `worker-stop` — the release sweep reading a failed status as a lost
   Runtime: red at "a stopped worker is not a lost Runtime" (expected
   READY, was LOST).
5. `process-kill` — the launcher fix reverted: red at "the kill is the
   evidence" (expected `SIGKILL`, was null with exit 1).
6. `generation-remint` — a LOST binding released on loss evidence alone:
   the broker re-mints, and the second prompt's warm answers 409
   `workspace_unavailable` instead of `runtime_broker_runtime_lost`.
7. `monitor-worker-kill` — the remote terminate answering a proven stop
   without asking the worker (the class of shortcut #13929 removed): the
   watch stays `running` with nothing observing it, and the case goes red
   at its park wait.

## CI wiring and budgets

The letter runs in the `hosted-harness-mysql` lane with no workflow
change: the class already belongs to it, the lane already delegates the
cgroup v2 root the background runs need, and `check-failsafe-reports.js
hosted` already requires the class to report. The letter measured 144 s
locally for all seven cases on a fresh MySQL 8.4.6 (`monitor-worker-kill`
spends ~65 s waiting out its idle window, `worker-stop` ~30 s waiting out
the broker's worker bound). Following the FG9 convention, the addition
moves `hostedForkHealthySeconds` 2640 → 2930 at twice the local
measurement; the `@Timeout(600)` ceiling keeps the per-ceiling relation
(600 + 2930 ≤ 3600) inside the 3600 s fork, to be confirmed by a lane run
on this branch.

## Validation and acceptance

- The launcher unit tests green, the signal cases red on the old launcher; the core
  hook and supervisor suites green.
- The letter green on a local Linux lane (cgroup v2 root delegated,
  MySQL 8.4.6, JDK 21, the packaged CLI), every case's fault positively
  observed. The whole `HostedMonitorRunFaultGatesIT` class run with the new
  letter beside the others on a fresh database: FG8c, FG8e and FG8f green;
  three of #14334's cases (`dispatch-reply`, `page-envelope-commit`,
  `cancel-reply-lost`) red, and red the same way on #14334's head without
  this change — they are that PR's open review items, not this letter's.
- All seven mutations individually red; sources and bundle restored.
- `hosted-process-ci.test.js` green; ESLint, Prettier and typecheck clean
  on the driver; Checkstyle clean on the Java sources.
- Two consecutive clean open-ended and reverse audit passes per AGENTS.md.

## Open questions and follow-ups

1. **The cross-boot record.** After a Harness restart a `child_run`
   record stays `running` forever, even when the restored drain stopped the
   process and the ledger settled it. The design for the rebuild driver and
   the cross-boot case is still open
   (`docs/design/2026-10-03-managed-shell-monitor-runtime.md`); when it
   lands, `harness-kill-capture`'s record assertion moves to the settled
   form it produces.
2. **The orphan after a worker death.** Nothing in this topology reaps the
   background process a dead worker supervised; whether the Workspace
   cascade should be gated for it belongs with that cascade's own gates.
3. **Signals the launcher does not re-raise.** A core-dumping signal,
   SIGUSR1 and SIGPIPE still read as exit 1; reporting the leaf's evidence
   over the launcher's fd 3 would cover them, at the cost of a supervisor
   protocol change.
