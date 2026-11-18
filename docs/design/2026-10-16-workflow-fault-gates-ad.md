# Workflow child_run fault gates FG10a + FG10d

[English](2026-10-16-workflow-fault-gates-ad.md) | [简体中文](2026-10-16-workflow-fault-gates-ad.zh-CN.md)

## Problem and scope

Issue #14165 is Stage F round FG10 of #12380, under the umbrella #14054:
fault gates for the `child_run` `workflow` kind enabled by #13858. The
kind owns no OS process (unlike FG8's capabilities) and lands no effect in
another participant's journal (unlike FG9); it executes deterministically
in-process under a pinned definition digest, and its distinctive risk is a
wedged child turn — nothing crashes, nothing is lost, and the child simply
never makes progress.

This slice implements **FG10a (digest integrity) and FG10d (process
crash)** only — the two gates the issue itself says the round specifically
owes, and the split the triage verdict recommended (question 4): FG10a
because the digest re-verification fails silently by design (it refuses, it
does not crash), FG10d because the in-process subagent model leaves no
independent witness after a crash, which is exactly when a record is most
likely to settle dishonestly. FG10b/c/e/f largely re-exercise kind-agnostic
mechanisms FG1–FG7 already covered and remain on #14165 as a later slice.

The slice follows the FG7/FG8 shape: real packaged Harness, a per-case
TypeScript driver, in-JVM Spring control plane against a real
MySQL/MariaDB, JDBC ground truth, and one named mutation per gate. It
touches **no production code**.

The properties under gate, re-verified against source at `main` =
`70758572ff` (the issue quoted them from #13858's description; both hold):

1. The definition is pinned from revision 1 by the sha256 of its script
   bytes — `workflowDefinitionPin`
   (`packages/cli/src/serve/hosted-workspace-tool-turn.ts:434-446`) mints
   `workflow/<name>@1` with `definitionDigest` over the exact bytes — and
   the digest is re-verified before the child spends anything:
   `runHostedWorkflowTurn` recomputes `sha256(script)` and compares it
   against the pinned digest as its first act
   (`packages/cli/src/serve/hosted-workflow-turn.ts:190-197`), before
   `loadSettings` (`:198`), `loadCliConfig` (`:226`), `refreshAuth`
   (`:256`) and `WorkflowRunner.start` (`:261`). The mismatch throws
   `HostedWorkflowTurnError` naming both digests
   (`Workflow launch pin does not match its script: pinned …, script ….`).
2. Subagents are in-process under `node:vm`
   (`packages/core/src/agents/runtime/workflow-sandbox.ts` — realm at
   `:1307`, `runInContext` at `:1313`), explicitly not nested managed
   grandchildren: a Harness crash takes every subagent with it, and no
   separate managed record exists to reconcile against.
3. The launch block crosses a `sha256(JSON.stringify(prompt))` admission
   digest between daemon and SDK
   (`packages/cli/src/serve/hosted-harness-session.ts:6087-6090`; SDK side
   `SubmitHarnessTurn.computePayloadDigest`,
   `packages/sdk-java/qwencode/.../SubmitHarnessTurn.java:53`), with the
   SDK's canonical JSON writer pinned to ECMAScript byte-fidelity by
   Node-exported golden vectors (`JsonSupportTest.java`) — the
   fractional-`args` wedge #13858 fixed.
4. The kind gate fires on every `child_run` revision commitment
   (`packages/core/src/managed-runtime/managed-session-authority.ts:1641`).

## Current state

- The enabled lists (`packages/core/src/managed-runtime/managed-session-records.ts`):
  `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` is
  `['child_agent', 'shell', 'workflow']` (`:199-203`);
  `CHILD_NOTIFICATION_SOURCES` is `['child_agent', 'workflow']` (`:212-216`).
  Verified at `70758572ff`.
- No fault coverage exists for the `workflow` kind: `workflow` appears
  nowhere in `hosted-channel-fault-driver.ts`,
  `hosted-monitor-run-fault-driver.ts`, `HostedChannelFaultGatesIT.java`,
  or `HostedMonitorRunFaultGatesIT.java`.
- Two of the issue's citations needed correction on re-read:
  - `workflow-session-gate.test.ts` is **not** a workflow-child driving
    test — it covers redacting `workflows` from ACP event streams. The
    reusable choreography lives in `hosted-workflow-turn.test.ts`,
    `hosted-workflow-turn.integration.test.ts`, and
    `hosted-workspace-tool-turn.workflow-child.test.ts`.
  - The re-verification is **in-Turn, not at admission**: a tampered
    launch is refused when the child's first Turn executes, after the
    child session exists and `input.accepted` is journaled, and the
    refusal settles through the relay as `child_failed`. "Refused before
    any child spend" therefore means before settings/config/auth/model
    spend — which the production order already guarantees and the unit
    test pins (`refuses a script whose bytes do not match the pin,
spending nothing`). These gates pin the existing in-Turn semantics;
    moving the refusal to admission time would be new production behavior
    and is out of scope.
- Settlement vocabulary the crash gate pins: the daemon maps relay verbs
  to `settleCompleted` / `settleFailed` / `settleCancelled`
  (`hosted-harness-session.ts:7054` ff.); nothing automatic settles a
  crashed run — a SIGKILLed Harness writes no settlement, and the relay's
  bounded watch is what declares the fact `unknown`
  (`ChildResultRelay.java:239`, "Bounded retries before a fact is declared
  unknown, never guessed", `:55-61`). Cold load refuses a session with an
  unsettled Turn with 409 `hosted_turn_recovery_required`
  (`hosted-harness-session.ts:5748` load route and its arms).
- The digest is never re-resolved from a later revision on reopen: the pin
  is synthetic (`workflow/<name>@1`, no registry, no revision counter) and
  the envelope bytes persist in the Session Store, which the relay reads
  back verbatim when rebuilding the child
  (`ChildResultRelay.java:465-495`). FG10d pins this as a witness, not as
  new mechanism.
- The Hosted lane machinery reused: per-case packaged Harness
  (`HostedHarnessProcess`, `node dist/cli.js serve --profile
hosted-harness`), the lose-once store/broker proxy shape from
  `hosted-monitor-run-fault-driver.ts`, in-JVM Spring with JDBC seeding,
  the probe-as-gate-half pattern (`HostedMonitorRunProbe`), per-letter
  case selectors, evidence under `target/fgN-cases/`, and
  `check-failsafe-reports.js hosted` family enforcement with the budgets
  pinned by `hosted-process-ci.test.js`.

## Scope decisions

1. **FG10a + FG10d only.** FG10b/c/e/f remain on #14165 for a later
   slice. Basis: the issue names a and d as the two the round owes; the
   triage verdict recommended landing exactly these two first; the Hosted
   fork budget is under repair (#14148, open) and main CI carries a red
   neighbour (#14023, open), so the slice spends the minimum budget that
   delivers the workflow-specific value. _As delivered, FG10a alone
   shipped here; FG10b–f, FG10d among them, landed in
   [the relay design](2026-10-17-workflow-relay-fault-gates.md)._
2. **Sequencing constraints re-evaluated, not inherited.** The issue's
   "land after FG8 and #14147" was written when FG8 had not started. FG8's
   slice 1 (#14120) has since merged and proved the per-letter driver
   pattern this slice copies; #14147 (extract shared helpers) remains
   blocked at P3, so this slice follows the **current pre-extraction**
   pattern and accepts the duplication FG8/FG9 already carry, exactly as
   FG8's slices did.
3. **One IT class; no Spring kill; no cgroup dependency.** FG10a lives
   in `HostedWorkflowFaultGatesIT` with in-JVM Spring, selector
   `-Dqwen.fg10a.case`, and evidence under `target/fg10-cases/`. FG10d,
   planned here too, landed in `HostedWorkflowRelayFaultGatesIT` (the
   relay design's slice 3, selector `-Dqwen.fg10d.case`), so this class
   reads no FG10d selector. The workflow kind owns no OS processes, so the
   cgroup v2 delegation FG8 needed is unnecessary; the crash letter's
   SIGKILL target is the packaged Harness itself, which hosts both the
   parent session and the in-process workflow run.
4. **The relay must run in the in-JVM Spring.** `ChildResultRelay` is a
   `@Service` (`ChildResultRelay.java:47-48`), so it comes up with the
   application; the fixture keeps it enabled (FG8's fixture disabled the
   Harness-facing services it did not need — a background `shell` run is
   not a child Session) because the workflow child session is created by
   the relay from the pending row (`ChildResultRelay.java:465-495` →
   `ManagedAgentService.createWorkflowChildSession`, `:307-326`).
5. **The tamper injection is a JDBC byte rewrite behind the probe, not a
   proxy mutation.** The envelope bytes land in the Session Store through
   the Harness's managed-session-store traffic; the probe holds the JDBC
   connection and rewrites the envelope resource's script bytes in place
   (byte-length preserving) after the record committed and before the
   relay builds the child Turn. This is deterministic where a proxy
   byte-rewrite would race the publish/commit ordering, and it exercises
   exactly the production re-verification the gate exists to pin.
6. **Assertions name the in-Turn refusal honestly.** FG10a expects the
   child Turn to fail with `HostedWorkflowTurnError` naming the two
   digests, zero model requests observed at the fake model server from the
   child, and an honest `child_failed` settlement — not an admission-time
   refusal (see Current state).
7. **#13339 isolation and the every-case-proves-its-fault discipline**
   carry over from FG8 decision 4: new class only, never a modification of
   existing `Hosted*IT` classes; every case first asserts its injection
   actually fired (tamper re-read, kill marker, in-flight proof) before
   asserting expectations.

## The gate ledger

Ground truth is JDBC over the child-run record rows and the relay
operation ledger, plus the driver's results JSON, the fake model server's
request log, and the captured Harness/Spring logs. Every case asserts its
fault actually fired before its expectations.

### FG10a — digest integrity

The fake model's first parent answer carries `fakeToolCall('workflow',
{script, args})`; the hosted workspace tool turn pins and commits the
child run, the relay creates the child session, and the child's first Turn
is where the digest gate lives.

| Case                               | Injection                                                                                                                                                 | Expect                                                                                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tampered-script-refused`          | Probe rewrites bytes inside the envelope's `script` (byte-length preserving) after the child_run record committed, before the relay builds the child Turn | The child Turn refuses with `HostedWorkflowTurnError` naming `pinned` vs `script` digests (turn `FAILED`); the fake model server records **zero** requests from the child session; the record never settles a false `settled`; the probe's re-read proves the tamper landed |
| `same-length-substitution-refused` | Probe swaps in `SUBSTITUTE_SCRIPT` — a syntactically valid, runnable, different script of identical byte length authored by the driver                    | Same refusal shape — the digest, not any length or parse check, is what catches it; with the digest check neutralised the substitute executes and completes, turning the case red                                                                                           |
| `fractional-args-admitted`         | None — a launch whose `args` carry fractional and subnormal values (`0.1`, `5e-324`) crosses the real daemon/SDK boundary                                 | The admission digest matches on both sides (no `invalid_hosted_prompt`); the child Turn runs to completion (`COMPLETED`), never wedged; the Turn's final content echoes the args in their exact ECMAScript rendering — the values provably reached the execution end        |
| `substitute-script-baseline`       | None — an honest launch of `SUBSTITUTE_SCRIPT` itself                                                                                                     | The child Turn completes and its final content carries the substitute's sentinel, proving the substitute is a valid runnable script — so the substitution case's refusal is attributable to the digest alone, never to a parse error                                        |

**Why the expectations sit at the child Turn, not the record's terminal
settlement.** The digest refusal fires inside the Turn
(`hosted-workflow-turn.ts`), and the Turn runs independently of the
relay's later bind/deliver walk. Driving that walk to the record's
settlement needs the relay's operations on the parent Session, which
conflict with a driver-held parent attach (`already_attached`) — and the
coordinator-owned alternative (the TeamLead shape) needs workspace
execution, unavailable to the local macOS loop (Linux-only, like FG8's
cgroup cases). The Turn-level assertions are exactly the digest property
this letter owes; the record's relay-driven settlement is FG10b/c's
machinery. The probe drives exactly one relay scan after the tamper to
fire the create; bind and beyond never run, so the driver-held parent
never conflicts.

### FG10d — process crash

**Delivered on the coordinator-owned fixture.** The driver and the gate
were built in this slice and went red on a genuine finding, not a fixture
gap. After a SIGKILL of the Harness mid-workflow (a subagent in flight)
and a restart, the recovery re-drove the child's unsettled workflow Turn:
the script re-ran and re-dispatched its subagent (the post-kill model
request carried the subagent's system prompt). That is exactly the "never
re-executed on reopen" violation this letter exists to pin.

The finding landed as a production bug (#14387) and was fixed in #14461.
The recovery parks the Turn `hosted_workflow_recovery_blocked` — never
re-driven, never settled — and the relay settles the record
`recovery_blocked` over `outcome_unknown`.

FG10d then landed after it, as slice 3 of
[the relay design](2026-10-17-workflow-relay-fault-gates.md) in
`HostedWorkflowRelayFaultGatesIT`, not in this driver-held class. Its
expectations — the record's blocked settlement, its ledger and the
parent's notification — are the relay's bind-to-deliver walk, which this
class's driver-held parent cannot run (FG10a's note above); the
coordinator-owned lead can. The two cases below keep their names; the
relay design records how each injection and expectation landed, the two
further defects the gate found there and fixed, and the mutations. FG10a
alone ships here. The section below stays as the original design.

POSIX-only. The driver owns the Harness child process and SIGKILLs it.
The in-flight witness is the fake model server's request log: an `agent()`
dispatch is one POST, so "subagent in flight" is a received request whose
response the server has not yet released.

The mechanism the gate observes: the coordinator's recovery sweep marks the
unsettled workflow Turn `hosted_workflow_recovery_blocked` — never
re-driven, never settled — and the relay reads the mark off the Turn line
and settles the record `recovery_blocked` over `outcome_unknown`,
classifying the ledger `unknown` within its own scan cadence (#14387). What
the gate pins is therefore the observable invariant inside the case budget:
the record settles `recovery_blocked` — never `failed`, `cancelled` or
`settled` — plus the cold-load refusal, which is the durable half of the
property.

| Case                                         | Injection                                                                                                                                                                                          | Expect                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill-mid-workflow-subagents-in-flight`      | SIGKILL the Harness while a subagent request is held open at the fake model server                                                                                                                 | Across a post-kill observation window the record settles `recovery_blocked` over `outcome_unknown` — never `failed`, `cancelled` or `settled`; a restarted Harness's cold load of the child session answers 409 `hosted_turn_recovery_required` with zero new model calls and zero re-execution; the record's `definitionDigest` still equals the original script's sha256 (never re-resolved) |
| `kill-after-last-subagent-before-settlement` | The store proxy holds the child's `settleTurn` commit and SIGKILLs the Harness **before forwarding it** — the kill precedes the commit deliberately, the deterministic pre-settlement interleaving | The settlement never landed: the record settles `recovery_blocked` over `outcome_unknown`, the dropped commit is witnessed in the proxy log, cold load refuses as above; never `failed`/`cancelled`, never re-executed on reopen                                                                                                                                                               |

## Fixture design

**Java.** `HostedWorkflowFaultGatesIT` starts one in-JVM
`ManagedAgentServerApplication` per letter the way
`HostedMonitorRunFaultGatesIT` does (workspace mounts and session rows
seeded by JDBC, MySQL properties mandatory — absence fails, not skips),
narrower in two respects: no tool-publication quota block and no OSS mock
(the workflow kind has no capture chain), and the child-result relay left
enabled (decision 4). `HostedWorkflowProbe` serves
`/fg10/<sessionId>/<phase>` over a plain `HttpServer`: `state` answers the
child_run record body and the relay operation-ledger rows, and
`tamper-envelope` performs the decision-5 byte rewrite, re-reading the row
afterwards so the case can prove the tamper landed. Evidence lives under
`target/fg10-cases/<letter>/<case>/`, rebuilt per method. Per-letter
`@Timeout(600)`.

**Driver.** `integration-tests/helpers/hosted-workflow-fault-driver.ts`,
launched per letter as `node --import tsx … <driver.json>` like every
FG6–FG8 driver. It owns: the per-case `HostedHarnessProcess` with isolated
`HOME`/`QWEN_HOME`/`QWEN_RUNTIME_DIR`; the store-fronting proxy, whose
commit log is the launch's store-side evidence (FG10a injects through the
probe; the settlement-observed kill arm planned here for FG10d went to the
relay class's Java proxy instead); the fake OpenAI server (below); and the
canned workflow scripts. Markers: `FG10_CASE_OK <case>` sequences the IT,
`FG10_STEP` / `FG10_DIAG` trace and dump, `FG10_TAMPERED` proves the
injection. If the
driver calls `relayUpstream`, it joins the pinned caller list in
`hosted-relay-headers.test.ts`.

**Model.** A canned OpenAI-compatible server answers the parent turn with
exactly one `fakeToolCall('workflow', …)`; the child run's `agent()`
dispatches get short fixed replies, answered immediately (the held-open
reply planned here for FG10d's in-flight kill went to the relay class's
scripted model). The model is
never the thing under gate; its request log is the in-flight witness.

**CI.** The class name places it in the `hosted-harness-mysql` lane
(`Hosted*IT` include; `check-failsafe-reports.js hosted` enforces it
ran). A `hosted-workflow-gates` focused profile (include
`**/HostedWorkflow*IT.java`) is added for local runs, mirroring
`hosted-monitor-run-gates`. `hosted-process-ci.test.js` gains the
per-class ceiling block, and the lane budgets move only by the measured
class cost — the fork cap and healthy allowance are literal pins
(`:477`, `:489`), so the PR updates them with the measured numbers and the
comment history, watching the interaction with #14148's in-flight repair.
The upload-artifact step gains `target/fg10-cases/`. No cgroup step: the
kind owns no OS processes. Local database: a throw-away MySQL/MariaDB,
same as FG7/FG8.

## Mutation checks

Each mutation is applied, shown to turn exactly its gate red, then
reverted, following the FG6/FG7/FG8 documented manual procedure.

1. FG10a — the digest comparison in `runHostedWorkflowTurn` neutralized
   (the recomputed digest always treated as equal):
   `tampered-script-refused` and `same-length-substitution-refused` red —
   the tampered script executes and the fake model server records child
   requests.
2. FG10d — planned here as the relay's bounded-watch classification for
   a child whose Harness died rewritten to settle the record `failed`
   instead of declaring the fact `unknown`. FG10d landed with the relay
   design, whose slice-3 mutations replace this one.

## Validation and acceptance

- `npm run build && npm run typecheck`; ESLint clean on the driver; the
  managed-agent-server surefire suite green.
- The new class green on a local throw-away MySQL/MariaDB: every case
  firing its declared injection (tamper re-read, kill marker, in-flight
  proof observed), per-letter selectors working, and the positive
  `fractional-args-admitted` case green.
- Both mutations above individually red; source restored; the gate green
  again.
- `hosted-process-ci.test.js` green with the re-measured budgets, and
  `check-failsafe-reports.js hosted` satisfied after a full lane run.
- Two consecutive clean open-ended and reverse audit rounds per AGENTS.md.
- This design lands in both languages; a comment on #14165 records the
  a+d slice split and points FG10b/c/e/f at the remaining tracker work.

## Open questions

1. Whether FG10b's kind-gate re-check assertions (the gate fires on every
   revision commitment, not only the first) should ride with the later
   b/c/e/f slice or be pinned here — left to that slice, since FG10a's
   positive case already exercises the first two commitments.
2. The exact budget numbers wait on the measured class cost; if the
   measurement lands while #14148's repair is still open, the PR calls
   out the interaction explicitly rather than pre-empting it.
3. Whether the cold-load 409 arms need branch-tagged reason names for
   workflow turns (the #13361 discipline FG8 followed) — decidable only
   against the load route's current arm set when the driver lands.
