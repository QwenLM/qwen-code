# Monitor run fault gates (FG8)

[English](2026-10-13-monitor-run-fault-gates.md) | [简体中文](2026-10-13-monitor-run-fault-gates.zh-CN.md)

## Problem and scope

Issue #14054 is the next Stage F slice of #12380: FG6/FG7-style multi-process
fault gates for the capabilities enabled for submission since FG7 landed —
`monitor_run` and the `child_run` `shell` kind (#13889, the H3 enablement),
whose records stay honest today only because two reviewers caught the
counterexamples by hand (#13896, fixed by #13929). The triage verdict on
#14054 accepts **FG8 only**; FG9 (`session_message` / `session_command`) and
FG10 (the `workflow` kind) get their own trackers once this round's practice
is proven.

This slice adds the gates, following the FG6/FG7 shape: real packaged
binaries, a fault-injecting proxy, a real MySQL/MariaDB, and a named mutation
check per gate. It touches **no production code**.

The capabilities under gate own real operating-system processes that outlive
their turn and hold a Runtime across turns:

- A background `shell` child run is admitted by `admitBackgroundProcess`
  (`RuntimeBrokerService.java:2084-2119`), which writes the
  `<executionCallId>:process` ledger row (`:2098-2099`); exactly-once rests
  on that identity's uniqueness (a re-admit answers 409
  `runtime_execution_conflict`).
- A monitor run's honesty fields are `observationSequence` /
  `notifiedThrough` (record contract in `ManagedExtensionRecords.java`,
  `requireMonitorRun`); its stop path is the broker's `monitor-stop`
  control (`RuntimeBrokerService.java:733-747`, `:822-846`) behind
  `HostedMonitorRemoteExecutor.stop`
  (`packages/cli/src/serve/hosted-monitor-remote-executor.ts:25-70`), the
  real terminate #13929 substituted for `Promise.resolve()`.
- The release split (#13889): a routine release sweeps and answers 409
  `runtime_session_held` without stopping anything
  (`RuntimeBrokerService.java:2490`); only the drain arm issues
  shell-terminate / monitor-stop and answers 409 `runtime_session_busy`
  for what it cannot prove stopped (`:2496-2497`).
- The settle projection (`hosted-shell-publisher.ts:884-925`): no physical
  evidence → `settleFailed` (`watch_failed` / `process_failed` — "the
  marker can never mint a stop nobody proved"); `stopRequested` →
  `requestStop` then `settleStopRequested`, in that contract order;
  otherwise `settleExited`. A platform-stopped run must never settle as
  `exited`.
- Output delivery: the Session-scoped `HostedShellPublisher` advances the
  output manifest per append and finalizes it; the 16 MiB in-flight pause
  and 4 MiB resume watermarks
  (`managed-runtime-tool-executor.ts:255-256`) keep the pipe bounded; the
  Artifact read chain re-verifies the manifest against persisted page
  envelopes before serving
  (`WorkspaceProfileLifecycleVerifier.java:172-190`).
- SSE: the public stream resumes by `Last-Event-ID` / `after`
  (`PublicAgentController.java:202`, 400 `invalid_event_cursor` at `:289`),
  the WebShell stream by `afterSequence`
  (`WebShellAgentController.java:129-133`); an expired replay cursor
  answers a single `agent.session.resync_required` frame and closes.

## Current state

- The enabled lists these gates protect
  (`packages/core/src/managed-runtime/managed-session-records.ts`):
  `MANAGED_SESSION_ENABLED_DOMAINS` holds 18 domains including
  `monitor_run` (`:128`); `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` is
  `['child_agent', 'shell', 'workflow']` (`:199`);
  `MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED` is `true` (`:241`).
  Verified at `main` = `c3c38cf583`.
- The domain-level fault coverage that exists today is channel-only: the
  three hosted fault-gate suites (`HostedChannelFaultGatesIT`,
  `HostedChannelProcessCrashIT`, `HostedProcessCrashIT`) contain zero
  occurrences of `monitor`, `workflow`, `session_command` or
  `session_message` (the #14054 keyword check, reproduced by triage at
  `c3c38cf5`).
- The Hosted lane machinery FG8 reuses: in-JVM Spring with the embedded
  broker and JDBC-seeded registry rows (`HostedChannelFaultGatesIT`
  `start()`), the packaged Harness child process (`node dist/cli.js serve
--profile hosted-harness`), a per-case TypeScript driver with an embedded
  lose-once reverse proxy (`integration-tests/helpers/hosted-channel-fault-driver.ts`),
  one-shot SQL triggers for store failures (`FG7B_*` markers asserted in
  the captured Spring log), a shared gate-support class owning the
  driver/results protocol (`HostedChannelGateSupport`), per-letter case
  selectors (`-Dqwen.fg7X.case`), and evidence under `target/fg7-cases/`.
  `check-failsafe-reports.js hosted` forces every `Hosted*IT` into the
  `hosted-harness-mysql` CI job; `hosted-process-ci.test.js` pins the
  lane's three budgets.

## Scope decisions

1. **FG8 only; FG9/FG10 are separate trackers.** The triage verdict: FG8
   names an observed defect (#13896) and a written obligation (#13856's G6
   row); FG9/FG10 are coverage-driven and land after this round's practice
   is proven. This design covers FG8a–FG8f and nothing else.

2. **Three landing slices, ordered by in-flight overlap.** Three open PRs
   are changing the exact semantics FG8 would pin; writing against them now
   would gate a moving contract. The slices land in this order, each its
   own PR in the FG6 shape:

   | Slice | Letters              | Waits for                                                                                          | Why                                                                                                                                     |
   | ----- | -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
   | 1     | **FG8e, FG8f**       | nothing                                                                                            | SSE streams and the output manifest/capture delivery chain are untouched by all three in-flight PRs.                                    |
   | 2     | **FG8a**             | **#14021** (settle never-started background dispatches in the live turn)                           | The background-dispatch reply-loss arm pins the settlement semantics #14021 is writing. #14021 is small (+173/-65); waiting is cheap.   |
   | 3     | **FG8b, FG8c, FG8d** | **#13986** (restart-proof the held-Runtime drain) and **#13918** (tenant-wide InnoDB guard convoy) | #13986 rewrites the cold-load held-set backfill FG8c/FG8d pin; #13918 rewrites the store-failure error-code taxonomy FG8b would assert. |

   The gate ledger below specifies all six letters so the round is reviewable
   as one design; each slice's PR implements its letters and marks them
   delivered here. A letter's injection points and assertions are re-verified
   against the merged prerequisites when its slice lands.

3. **One IT class; no Spring kill.** FG8c kills the packaged Harness, the
   managed worker, and the background process itself — never the Spring
   control plane — so the FG7c child-JVM fixture
   (`HostedChannelCrashFixtureMain`) is unnecessary. All six letters live in
   `HostedMonitorRunFaultGatesIT` with in-JVM Spring, per-letter selectors
   `-Dqwen.fg8a.case` … `-Dqwen.fg8f.case`, and a shared
   `HostedMonitorRunGateSupport`. POSIX signals confine the crash cases to
   Linux/macOS, same as FG6c/FG7c.

4. **#13339 isolation.** `HostedWorkspaceToolTurnIT` already flakes on the
   MySQL 8.4 lane (#13339, open, root cause narrowed to the cold-load
   file-history `pendingTurn` arm, unfixed; #13361 landed branch-tagged 409
   arms and bounded idempotent retries as the diagnostic half). The lane has
   **no** quarantine or retry mechanism — one flake reds a 160-minute job.
   FG8 therefore: (a) adds only new `Hosted*IT` classes and never modifies
   `HostedWorkspaceToolTurnIT`; (b) writes its cold-load assertions against
   the #13361 branch-tagged 409 arm names, not a bare 409, so a recurrence
   localizes immediately; (c) avoids the `SHELL_REFUSAL → /title → /detach
→ javaLoad` sequence #13339 flakes on; (d) keeps the FG7 discipline that
   every case first asserts its fault actually fired (drop counter, trigger
   marker, kill marker), so a gate can never go silently green.

5. **The issue's scope cuts are recorded, not done here.** Folding a
   `team_state` / `team_task` storage-failure case into
   `HostedTeamLeadMySqlIT` / `HostedTeamMemberCommandMySqlIT`, and the
   coverage audit for `mcp_configuration` / `mcp_operation` /
   `hook_registration` / `hook_execution` / `schedule` / `automation_run`
   (which must explicitly discharge or re-name the #13598 automation
   obligation #13856's G6 recorded), are companion tasks tracked on #14054,
   not part of any FG8 slice. The four A/W-stage record domains stay out;
   FG9's channel-adjacent cases will not assume a second provider behind
   `email`.

## The gate ledger

Ground truth is JDBC over the execution ledger (`:process` rows), the
monitor/child-run record tables, the output manifest and page-envelope
tables, the Session Store journal, and the captured Spring and Harness logs.
Every case asserts its fault actually fired: the proxy drop counter and the
`FG8B_<case>` SQLException marker (FG8a/b), the kill markers (FG8c), the
cancel answer's flags (FG8d), the aborted stream's unread proof (FG8e), or
the publisher's watermark/receipt evidence (FG8f). `one process` always
means the OS held exactly one physical process for the dispatch — the
`:process` row's uniqueness is the SQL proof, and the worker/registry side
carries the process identity.

### FG8a — lost replies (slice 2, after #14021)

The driver embeds a reverse proxy in front of the broker and store
listeners; a lose-once fault forwards the request, consumes the committed
upstream response, then destroys the reply. The Harness re-drives from its
persisted state by the original execution identity.

| Case                        | Injection                                                                        | Expect                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-reply`            | Drop the reply to a background shell dispatch after the `:process` row committed | The retry resolves through the original `executionCallId`: at most one physical process, one `:process` row; a duplicate re-admit answers 409 `runtime_execution_conflict` and starts nothing |
| `monitor-stop-reply`        | Drop the `monitor-stop` reply after the stop committed                           | The re-drive resolves by the original operation identity; exactly one physical terminate reaches the worker; the record settles with real exit evidence                                       |
| `capture-commit-reply`      | Drop a capture-page commit reply after the envelope persisted                    | The publisher's re-drive is idempotent: one page envelope, the manifest advances once, no duplicated bytes                                                                                    |
| `observation-advance-reply` | Drop a monitor observation advance reply after it committed                      | `observationSequence` / `notifiedThrough` stay behind rather than skipping ahead; the re-drive lands them on the committed values, never beyond the observed tail                             |

### FG8b — store failures (slice 3, after #13918)

Test-only SQL triggers, tenant- and table-scoped, installed and dropped per
case like FG6b/FG7b, `SIGNAL SQLSTATE` text `FG8B_<case>` asserted in the
captured Spring output. The error codes these cases assert are the post-#13918
taxonomy.

| Case                    | Injection                                                                 | Expect                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `invocation-commit`     | One-shot trigger fails the invocation-row commit before process start     | Zero OS effects: no process, no `:process` row, no capture registration                                                                    |
| `process-ledger-commit` | One-shot trigger fails the `:process` ledger commit                       | The run is blocked without re-executing; no second admission is attempted                                                                  |
| `manifest-commit`       | One-shot trigger fails the output-manifest commit                         | The run blocks without re-executing; the capture's durable prefix stays readable and byte-identical                                        |
| `page-envelope-commit`  | One-shot trigger fails a page-envelope commit after the manifest names it | The Artifact read chain never resolves to a manifest whose page envelopes were not persisted: the read refuses, the manifest is not served |

### FG8c — process crashes (slice 3, after #13986)

POSIX-only. The IT owns the Harness child process and signals the worker and
the background process by pid. Cold-load assertions read the #13361
branch-tagged 409 arms (decision 4b).

| Case                    | Injection                                                              | Expect                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-dispatch` | SIGKILL the Harness after the dispatch committed, before capture start | Restart: no duplicate dispatch, one `:process` row; the unsettled run stays blocked with no terminal event; cold load refuses it (`hosted_turn_recovery_required` with its arm tag) |
| `harness-kill-capture`  | SIGKILL the Harness after capture start                                | As above, plus: the durable output prefix stays byte-identical and readable; the run is never re-executed to recover                                                                |
| `worker-kill`           | SIGKILL the managed worker mid-run                                     | The outcome-unknown run stays blocked; no terminal event; the hold is not released without evidence                                                                                 |
| `worker-stop`           | SIGSTOP the worker, let the uncertainty window pass, SIGCONT           | The run neither settles nor duplicates; the resumed worker's evidence settles it honestly                                                                                           |
| `process-kill`          | SIGKILL the background process itself                                  | The record settles from real exit evidence (or stays honestly unknown); never a fabricated `exited`                                                                                 |
| `generation-remint`     | Restart the broker generation behind an unsettled run                  | The dead generation answers `runtime_broker_runtime_lost`; it is never silently re-minted; the run stays blocked                                                                    |

### FG8d — cancellation and drain (slice 3, after #13986)

| Case                        | Injection                                                 | Expect                                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-before-start`       | Cancel after admission, before process start              | The run settles `cancelled`; zero OS effects                                                                                                                               |
| `cancel-during-capture`     | Cancel mid-capture                                        | `stopRequested: true` is recorded; only the physical termination settles the run, as `cancelled` / `stop_requested` — never `exited`                                       |
| `cancel-status-unavailable` | Cancel while the worker's status is unreadable            | The cancel is recorded; no terminal event is fabricated; the uncertainty resolves by evidence, not by the cancel's optimism                                                |
| `cancel-reply-lost`         | Drop the cancel's reply after it committed                | The re-driven cancel answers the committed state unchanged; one terminal record                                                                                            |
| `routine-release-refusal`   | Routine (non-drain) release against a live background run | 409 `runtime_session_held`; nothing is stopped; the run keeps progressing                                                                                                  |
| `drain-release`             | Drain release against the same run                        | The drain arm issues the stop; the run settles `cancelled` / `stop_requested` with `stopRequested: true`; what cannot be proven stopped answers 409 `runtime_session_busy` |

### FG8e — SSE gap (slice 1, this PR)

The public and WebShell streams are served by the in-JVM Spring; the client
aborts and resumes are the injection, so this letter needs no proxy. A
background run and a monitor observation supply the in-flight event traffic.
Each case aborts the stream, advances the capability while disconnected —
the gate releases first, and the run letter's backlog is a post-gap prompt
because the exit notification is silent without a scheduler — and reconnects
only after JDBC proves a committed event beyond the cursor, so the replay
is never vacuous against a history-dropping endpoint.

| Case                      | Injection                                                            | Expect                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `public-run-resume`       | Abort the public stream mid-run; resume with `Last-Event-ID`         | The replayed sequence is duplicate-free and gap-free from the cursor; the run keeps progressing; the terminal event appears exactly once |
| `webshell-run-resume`     | Abort the WebShell stream mid-run; resume with `afterSequence`       | Same continuity assertions over the WebShell envelope                                                                                    |
| `public-monitor-resume`   | Abort the public stream during a monitor observation advance; resume | The observation events replay in order without loss or duplication; `observationSequence` / `notifiedThrough` match the replayed tail    |
| `webshell-monitor-resume` | Same over the WebShell stream                                        | Same assertions                                                                                                                          |
| `cursor-expired-resync`   | Resume with a cursor older than the replay window                    | A single `agent.session.resync_required` frame, then close; no fabricated replay                                                         |

`cursor-expired-resync` is deferred out of the slice-1 letter: the replay
floor only advances when a session snapshot lands, so an honestly expired
cursor needs the replay-floor mechanics driven to that point first; the
case lands with slice 2, and its mutation (2 below) moves with it. The
shipped FG8e letter covers the four abort/resume cases.

A fixture note that cost a flake: the 60 s events poll/heartbeat interval
(which forces the live hub to carry delivery) can hold a WebShell resume
for a full poll cycle, and the monitor watch's idle window must outlive
it — with a 30 s idle timeout the watch idle-killed the gated producer
mid-gap and the case hung on a gate that would never reopen. The watch
runs with `idle_timeout_ms` = 180 s. The same poll bounds the resumed
observer's catch-up to the committed ledger — rows committed between the
replay read and the relay stop arrive a poll cycle late, so the catch-up
wait runs at 120 s, outliving two cycles. A second discipline: the monitor
producer never exits on its own — it idles past its last mark, and the
quota stop's kill is the only way out. A natural exit closes the scope,
and its cancel write races the quota settle, flipping the record to
`stop_requested` instead of `max_events` (observed twice on the lane).

### FG8f — output delivery (slice 1, this PR)

The publisher lives inside the Harness process, so "kill the publisher" is a
Harness kill scoped to output assertions only — Runtime-hold restoration
across a Harness restart is #13986's moving ground and belongs to slice 3's
FG8c (`harness-kill-capture` there asserts the recovery side; here only the
output side is pinned).

The byte path these cases gate: the worker relays the child pipes to the
Harness in 64 KiB rpc chunks; the Harness-side `HostedShellPublisher` packs
them into 1 MiB segments and publishes segments, pages and manifest
revisions as session resources through the Session's
`managedSessionStore` client, which always lands them `MYSQL_INLINE` in
`ma_resource` (segment content is idempotent by its
content-addressed resourceId, `sha256([captureId, streamId, ordinal])`).
The driver therefore fronts that base URL with its store-side proxy — the
broker proxy stays for the Runtime calls — and arms per request shape:
full segment commits are held before forwarding (the worker's 16 MiB pause
watermark must then reach the producer's pipe, proven by the producer's own
progress file), and one journal-commit reply is destroyed after the commit
landed (the client's bounded uncertain-error retry must re-drive it by the
original transaction identity). The committed-prefix read is re-verified
gate-side over JDBC — manifest revisions, page envelopes and segment
digests walked in order against the producer's deterministic block pattern
— because the background lane does not project into the artifact tables
(verified against the FG8e leftovers); the session-resource rows are the
ground truth the production read paths serve from.

| Case                           | Injection                                                                       | Expect                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publisher-kill-mid-capture`   | SIGKILL the Harness while a background run's capture is appending               | The committed output prefix stays byte-identical and readable through the Artifact chain; the manifest never names unpersisted pages; output is never re-executed to recover                                       |
| `in-flight-cap`                | A background run produces more than 16 MiB while the proxy delays store commits | The 16 MiB pause and 4 MiB resume watermarks hold under loss: the pipe slows instead of buffering unboundedly; resume re-arms before the drain empties; the final manifest is consistent with every persisted page |
| `receipt-drop-after-watermark` | Drop the manifest-commit reply after the resume watermark committed             | The re-drive resolves by the original capture identity: one manifest, no duplicated pages, no re-execution                                                                                                         |

## Fixture design

**Java.** `HostedMonitorRunFaultGatesIT` starts one in-JVM
`ManagedAgentServerApplication` per letter the way `HostedChannelFaultGatesIT`
does (workspace mounts, registry/access rows seeded by JDBC, MySQL
properties mandatory — absence fails, not skips), with the embedded broker
on a method-scoped pinned port. The packaged Harness boots per case as
`node dist/cli.js serve --profile hosted-harness` against that broker, with
a per-case isolated `HOME` / `QWEN_HOME`. Evidence lives under
`target/fg8-cases/<letter>/<case>/`, rebuilt per method. Store-failure
triggers copy the FG7b DDL shape with `SIGNAL SQLSTATE` text
`FG8B_<case>`, scoped to the case tenant, asserted in the captured Spring
output, dropped in teardown (FG8b; slice 1 injects nothing into MySQL).
`HostedMonitorRunProbe` is the in-JVM gate half: it serves
`/fg8/<sessionId>/<phase>` over a plain `HttpServer` — `relay-start` /
`relay-stop` drive the test-owned event relay (the production projector and
append path; FG8e only), `state` answers the execution-ledger rows, the
monitor/child-run record bodies and the committed tool-result resource
metadata, and `ledger` the session's SESSION-stream `ma_public_event`
sequence — a child task's `state_changed` audit rows share the sequence
space but the surfaces never serve them, so the gate's ground truth
filters exactly the way `findEvents` does. The IT
keeps every JDBC ground-truth assertion: execution-ledger rows by
`executionCallId` (including the `:process` suffix), record honesty, and
the FG8f output chain (manifest revisions, page envelopes, segment digests
against the producer's deterministic pattern).

**Driver.** `integration-tests/helpers/hosted-monitor-run-fault-driver.ts`,
launched per letter as `node --import tsx … <driver.json>` like every
FG6/FG7 driver. It owns: the lose-once reverse proxy in front of the broker
(the operation log is the dispatch evidence), the store-fronting proxy in
front of the Session's `managedSessionStore` base URL (FG8f's hold/drop
arms), the raw SSE clients for FG8e (public stream with `Last-Event-ID`,
WebShell stream with `afterSequence`, abort-and-resume, duplicate/gap
detection over the replayed sequence — note the public surface speaks
snake_case and the WebShell surface camelCase frame fields), and the
scripted producers — real `node -e` background processes whose block
pattern is deterministic per segment ordinal (so byte-identity is a digest
comparison gate-side) and whose `progress.txt` makes the pause watermark's
reach into the producer observable. The markers the IT waits on or asserts
— `FG8_CASE_OK <case>`, `FG8_STREAM_GAPS_OK` (FG8e),
`FG8_OUTPUT_DELIVERY_OK` (FG8f), `FG8_DROPPED <what>` — sequence the IT;
`FG8_STEP` / `FG8_PROXY` / `FG8_STORE_PROXY` trace the flow and
`FG8_DIAG` dumps the case state on failure. Per-case directories make a
Harness restart genuinely cold-load.

**Model.** A canned OpenAI-compatible model answers every turn with a short
fixed reply per case, like FG7 — the model is never the thing under gate.

**CI.** The class name places it in the `hosted-harness-mysql` lane
(`Hosted*IT` include; `check-failsafe-reports.js hosted` enforces it ran).
The gates need a delegated cgroup v2 root, so the lane gains a setup step
that creates and chowns `/sys/fs/cgroup/fg8`, exports
`QWEN_MANAGED_HOOK_CGROUP_ROOT` to the Verify step, and smoke-tests
admission with a real child joining a unit — `cgroup.kill` existing alone
proves nothing about migration. Delegation containment means a process
outside the subtree cannot migrate into it (the write to a unit's
`cgroup.procs` needs the common ancestor's `cgroup.procs` writable, and
that ancestor is root-owned on the runner), so the Verify step's shell
first moves itself into the subtree through a privileged `cgroup.procs`
write; every process the tests spawn is then born inside it. The lane's three
budgets moved with the new class green, following the FG7 precedent
(900 s → 1200 s, 25 → 35 min, 148 → 160 min). The merged lane numbers are
fork 1800 s, Verify 45 min, job 220 min: the L4 shell-lifecycle recovery
class (#14125) independently landed the 1200 → 1800 s fork bump on main,
and this class's ~310 s rides inside the same fork; Verify 35 → 45 min and
job 210 → 220 min are the merged totals covering both classes, with
`hosted-process-ci.test.js` updated in the same change (the fork-healthy
allowance re-measured 650 s → 1100 s).
A `hosted-monitor-run-gates` focused profile is added for local runs; the
cgroup requirement makes the gates Linux-only, so the local loop runs them
in a privileged container (kernel ≥ 5.14 for `cgroup.kill`) against a host
MySQL. Local database: a system `mysqld` with a throw-away datadir, trigger
privileges required, same as FG6b/FG7b.

## Mutation checks

Each mutation is applied, shown to turn exactly its gate red, then reverted,
following the FG6/FG7 documented manual procedure. The slice-1 mutations
below are committed with this design; slices 2 and 3 refine theirs against
the merged #14021 / #13986 / #13918 semantics when they land.

1. FG8e — the public replay's cursor tiebreak weakened to include the
   cursor row: `public-run-resume` red (duplicate at the resume boundary).
2. Deferred with its case: FG8e — the expired-cursor branch streaming from
   sequence 0 instead of answering `resync_required`:
   `cursor-expired-resync` red. Lands with slice 2.
3. FG8e — the WebShell replay window off by one at the `afterSequence`
   boundary: `webshell-run-resume` red (gap or duplicate at the boundary).
4. FG8f — the resume watermark dropped to 0 (resume re-arms only once the
   buffer fully empties): `in-flight-cap` red — the producer's first
   post-stall block lands only after the whole stalled backlog committed,
   so the committed-at-resume count reaches the stall point instead of
   staying behind it.
5. FG8f — the journal-commit retry minting a fresh transaction identity
   instead of re-driving the original: `receipt-drop-after-watermark` red
   (the re-driven settle commit conflicts against the landed original and
   the record never settles).
6. FG8f — the content-addressed segment resource identity drifting from
   the documented derivation (`[captureId, streamId, ordinal]` gains a
   fourth element): `publisher-kill-mid-capture` red at the prefix walk —
   the gate-side recomputation finds no committed row at ordinal 0 while
   the unaccounted rows sit in the store.

Planned, refined at slice landing: FG8a — re-admit keyed by a fresh
identity instead of the original `executionCallId` (`dispatch-reply` red);
FG8b — the invocation commit proceeding without its `:process` row
(`invocation-commit` red at the zero-OS-effects assertion); FG8c — cold
load treating an unsettled background run as clean (`harness-kill-dispatch`
red); FG8d — the routine release arm draining instead of refusing
(`routine-release-refusal` red), and the settle projection mapping a
platform stop to `exited` (`cancel-during-capture` red).

## Validation and acceptance

- `npm run build && npm run typecheck`; ESLint clean on the driver; the
  module's surefire suite green.
- The new class green on a local MySQL/MariaDB (the CI lane is MySQL 8.4):
  every case firing its declared fault — each drop counter, `FG8B_*`
  marker and kill marker observed — per-letter selectors working, and the
  happy path green without any injection.
- Every slice-1 mutation above individually red; source restored; the gate
  green again. Slices 2/3 repeat the procedure for their mutations.
- `hosted-process-ci.test.js` green with any moved budgets, and
  `check-failsafe-reports.js hosted` satisfied after a full lane run.
- Two consecutive clean open-ended and reverse audit rounds per AGENTS.md.
- This design lands in both languages; the delivery ledger gains the FG8
  rows per slice; a comment on #14054 records the slice split and each
  slice's delivery, and names the two companions from decision 5 (the
  `team_state` / `team_task` storage fold and the mcp/hook/schedule/
  automation audit that discharges or re-names #13598) so the tracker
  reflects the settled shape.

## Open questions

1. Whether slice 3's FG8c should also pin the #13986 held-Runtime backfill
   across a _broker_ restart (not only a Harness restart) — decidable only
   against the merged #13986 surface.
2. Whether the FG8e continuity assertions should extend to any WebShell
   mirror routes a later slice adds — left to that slice, as FG7 recorded
   for its own re-scope.
