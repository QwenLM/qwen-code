# Managed Idle Suspension Wiring Implementation Plan

[English](2026-11-18-managed-idle-suspension-wiring.md) | [简体中文](2026-11-18-managed-idle-suspension-wiring.zh-CN.md)

Status: the suspension state machine is implemented and verified; this plan wires it into the Hosted Harness route surface. Date: 2026-11-18. Baseline: `4bbd817657` on branch `feat/managed-agent-idle-suspension` (worktree `eager-ray-2ab2a7`, based on `origin/main` `5fc5a98ecc`). This plan implements phase 1 of the [stateless Hosted Harness design](../design/2026-11-16-managed-stateless-harness.md); read that design's "准入闸门与在飞工作", "挂起流程", "teardown 失败或结果未知" and "close 路径审查" sections before coding. Stage IDs are local planning labels. All line anchors below refer to `packages/cli/src/serve/hosted-harness-session.ts` at `5fc5a98ecc` unless another file is named; the module commit does not shift them.

## 1. What already exists

`packages/cli/src/serve/hosted-session-suspension.ts` (commit `4bbd817657`, 19/19 unit tests, ESLint/Prettier clean) owns the pure state machine:

- `SessionSuspension`: gate `open | closing | blocked`, `admittedWork` counter, `teardownStarted` latch, `lastActivity`, `idleTimer`, `teardownAttempts`.
- `suspensionRefusalCode`: `hosted_session_closing` while closing, `hosted_session_teardown_blocked` when blocked, undefined while open.
- `admitSuspensionWork` / `releaseSuspensionWork`: admission refused unless open; release floors at zero.
- `armIdleSuspension` / `disarmIdleSuspension` / `recordSuspensionActivity`: ≤10% jitter, no arm unless open, timer unref'd.
- `beginSuspensionClose` / `revertSuspension` / `markSuspensionTeardown` / `escalateSuspension` / `clearSuspension`: revert only before the first teardown call; an abandoned revertible attempt records activity; clear only on confirmed-complete teardown.
- `runSuspensionAttempt(suspension, deps)`: pending-input check → synchronous `markClosing(attemptStart)` → bounded wait for `admittedWork` → `liveWork` + pending-input recheck → irreversible teardown with capped backoff+jitter retries → `removeResident` + clear on success, `removeResident` + escalate at the cap. Deps are injected; constants `HOSTED_IDLE_SUSPEND_MS` (10 min), `HOSTED_SUSPEND_WORK_WAIT_MS` (30 s), `HOSTED_SUSPEND_TEARDOWN_RETRY_CAP` (5) are candidates, measured before enablement.

The gate registry must live beside the `sessions` map, keyed by Session id, NOT on the resident object: an uncertain teardown keeps refusing loads after the resident is gone.

Parallel track (out of scope here): WP1 Java/SDK prerequisites are committed on branch `feat/managed-agent-recovery-prereqs` in worktree `managed-wp1-recovery` (`b5da254178` SDK heartbeat retirement notice, `f08a98b104` wait classification + churn caps), stacked on PR #17521. End-to-end suspend→reopen acceptance needs both tracks; unit/integration tests here run without WP1.

## 2. W1 — Core: expose renewal stop

`packages/core/src/managed-runtime/managed-session-assembly.ts`:

1. Add `stopRenewal(): Promise<void>` to the `ManagedSession` interface (near `releaseActivation`, ~:191).
2. Implement in the returned object (~:322): `stopRenewal: () => renewal.stop()`. `renewal.stop()` latches stopped, clears the interval and returns the in-flight renewal promise — awaiting it OUTSIDE the authority serial queue is the design requirement (the renewal itself runs inside `runSerial`, `managed-session-authority.ts:3865`).
3. Do not change `close()` semantics: it stays the existing non-transactional close (stops renewal, attempts seal even when activation release fails). Suspension orchestrates the steps itself.

Extend the collocated assembly tests: `stopRenewal` awaits an in-flight renewal, is idempotent, and leaves `close()` behavior unchanged.

Done when a caller can stop renewal and wait for the in-flight one without entering the serial queue.

## 3. W2 — Monitor loop liveness

`packages/cli/src/serve/hosted-monitor-loop.ts` (class at :100): add `get live(): boolean { return !this.ended; }`. `ended` is the liveness flag (`onLine`/`armWindow`/`armIdle`/`flush` all check it; `stop()` at :321 sets it). The `monitorLoops` maps are never pruned, so eligibility must test liveness, not map size.

Add a unit test: a stopped/parked loop reports `live === false`, a running one `true`.

Done when eligibility can distinguish live observation loops from stopped records.

## 4. W3 — Registry, idle period, gates, coordination

In `hosted-harness-session.ts`:

1. Import the suspension module. Extend `registerHostedHarnessSessionRoutes` (:4574, currently `(app, contract, cwd, brokerOptions?)`) with an optional fifth parameter `options?: { idleSuspendMs?: number }` (callers: `server.ts:2642` and tests — optional, no caller change required). Resolve the idle period: `options?.idleSuspendMs` ?? `QWEN_E2E_IDLE_SUSPEND_MS` env (accept only `0 < value < HOSTED_IDLE_SUSPEND_MS`, same pattern as `QWEN_E2E_DROP_LOAD_REPLY` at :4604; the variable can only shorten, never disable) ?? the constant. No supported configuration field, no capability advertisement.
2. `const suspensions = new Map<string, SessionSuspension>()` beside `sessions` (:4598). Helpers: `suspensionFor(id)` (lazy create), `noteActivity(id)` (record + rearm only when an entry exists and its gate is open), `armFor(id)` (arm with `onTimeout` firing `runSuspensionAttempt`, fire-and-forget with a stderr catch log).
3. **open() gate**: right after `sessionId` is computed (~:5046), before any resident reuse (:5302) or writer acquisition: look up the registry; a refusal code answers `409` with that code. This covers create, ordinary load, passive load, driven recovery and MCP-management load — the load route (:8467) is registered before the session middleware (:8476), so the middleware alone cannot gate it.
4. **Middleware gate** (:8476, after the identity check): a registry refusal answers `409` for every method including GET (reads during teardown answer closing; heartbeat answers closing until the seal lands and the next heartbeat 404 retires the SDK attachment via the WP1 notice). Private teardown reconciliation is not a route and stays ungated.
5. **Drain interlock** (one synchronous section each way): add `suspensions.get(sessionId)?.gate !== 'open'` to the `releaseIdleOwner` busy list (:4730); `markClosing` (W4) refuses when `session.ownershipRelease` is set, `instance?.accepting === false`, `session.lifecycle` is set, or `session.mcpClosing` is true. Whichever marks first wins; the other refuses. Suspension never calls `releaseIdleOwner` (drain-only, releases placement; phase 1 keeps placement).
6. **Arm points**: after each `sessions.set(sessionId, session)` (:6705, :7541, :8363) call `armFor(sessionId)` — load completion earns a full residency period, including read-triggered loads.
7. **Activity points**: in the middleware after `authorizeOrdinary` succeeds for non-GET (before `next()`), at the Turn settlement site (grep the `turn.settled` write), and at the wake pump's notification callback — `noteActivity(sessionId)`. Heartbeat (:13469), status/events/transcript reads, activation renewal and refused requests never record activity. Internal mutation sources (wake pump, reply planning) obey the same gate: check `suspensionRefusalCode` before starting work.

Done when a gated Session refuses every ordinary route and every load path with the registry's code, drain and suspension exclude each other, and activity re-arms the timer.

## 5. W4 — Eligibility, mark, teardown

Wire `runSuspensionAttempt` deps per Session:

1. **`pendingInputs` (async)**: `pendingSessionInputs(authority.eventsInSequenceRange(1, committedSequence)).length > 0` (`hosted-wake-intake.ts:37`) — includes future-`notBefore` wakes and loop inputs. Phase 1 suspends only with zero pending inputs.
2. **`liveWork` (synchronous)** — the `releaseIdleOwner` busy list (:4730) per-Session and live-work-only: `active`, `recoveredTurn`, `blocked`, `lifecycle`, `mcpBusy`, `hooksBusy`, `mcpRecovering`, `compressionBusy(session)` (:1096), `fileHistoryOwed`, `hasHostedCleanupDebt(managed)`, `childConsumption.size`, `messageOperations?.size`, `unsettledInputs(session).size` (:2014), `heldRuntimeTurns.size`, `automations?.hasPendingGateReleases`, any `shell`/`backgroundLane` `monitorLoops` value with `.live`, unsettled `child_run`/`monitor_run` extension records (the `heldResources` :4615 reduce), `ownershipRelease`, `clientFiles !== undefined` (active registration), and MCP-configured public Workspace Shell tiers without lifecycle protocol 2 (the `hosted_lifecycle_required` exclusion, close :13874). Do NOT count: `hooks`/`mcp`/publisher existence (teardown targets, re-acquired on load) or `runtimeLeaseHeld` (step 3 releases it). Instance-level terms (`inFlightMutations`, `opening.size`, `initialReconciliations`) are not per-Session eligibility.
3. **`markClosing(attemptStart)` (synchronous section)**: refuse (`false`) when `liveWork()`, `suspension.lastActivity > attemptStart`, or any W3.5 interlock condition holds; otherwise `beginSuspensionClose(suspension)` and set `session.mcpClosing = true`. Blocked-by-condition Sessions keep serving normally — no periodic closing refusals.
4. **`teardown`** — a step-state closure so capped retries resume at the failed step (precise retries only):
   1. `session.monitorWake?.close()` — closes the wake scheduler WITHOUT settling inputs. This is the irreversible boundary; `markSuspensionTeardown` already latched before the first call.
   2. `await session.hooks?.close({ terminal: false })` then `await session.mcp?.close({ terminal: false })` — same non-terminal calls as detach.
   3. `await releaseLeaseNow(session, false)` (:10844; settles owed file-history markers first; returns `true` for unproven/deferred → throw) then `await retryHostedCleanup(session, brokerOptions, true)` (:2741; without `brokerOptions`, `hasHostedCleanupDebt` → throw). Remainder or unknown outcome keeps the gate closed.
   4. `await session.shell?.publisher?.close()` and `await session.backgroundLane?.publisher?.close()` — no live loops remain (eligibility), nothing waits on their settlement, the next load recreates them.
   5. `await managed.stopRenewal()` (W1, outside the serial queue) → `await managed.releaseActivation()` → `await managed.authority.close()` (the memoized seal; a retry reconciles the SAME seal). Expose each step's outcome; a seal success with unconfirmed activation release is still recovery work, not a clean suspension.
   6. After ALL steps confirm: `await session.stores!.stopLocal()`, stop `session.streams`. Never `stopLocal()` while the seal still needs reconciliation — it fences those requests too (`http-managed-session-store.ts:2957/:3516`).
      Skipped versus detach (eligibility excludes or design forbids): held-Runtime drain, client-files close, pending-input cancellation, automation run reconciliation, SessionEnd/SessionDelete hooks, ordinary execution authorization (suspension starts no work; the seal is writer-fenced).
5. **`removeResident`**: `sessions.delete(id)` + `unresolvedOpenings.delete(id)`. On success the driver clears the gate — also `suspensions.delete(id)` so the next request cold-opens. On blocked, KEEP the registry entry (gate + evidence outlive the resident); a later load meets `hosted_session_teardown_blocked` until operator/lifecycle reconciliation under existing authority.
6. **`rearm`**: `armFor(id)`.

Done when an idle eligible Session suspends end-to-end and reloads cold, and every teardown failure mode keeps the gate closed with the right code.

## 6. W5 — Integration tests

New `hosted-session-suspension.integration.test.ts`, fixtures following `hosted-harness-session.test.ts` (register routes with a short `idleSuspendMs`):

1. Idle Session suspends after the period; a subsequent load cold-opens it (writer re-acquired, MCP/Hook re-connected, placement kept).
2. An admitted prompt resets the timer; the Session stays resident a full period after the Turn settles.
3. A pending input — including a future-`notBefore` loop input — keeps the Session resident (no closing refusals).
4. A live monitor loop keeps the Session resident; a stopped loop does not.
5. Requests during teardown answer `409 hosted_session_closing`; loads included.
6. Seal fault injection: teardown retries with backoff, escalates at the cap to `hosted_session_teardown_blocked`; the gate survives resident removal and refuses the next load; `stopLocal` was not called before reconciliation.
7. Drain and suspension interlock both ways (drain-first blocks the mark; suspension-first blocks `releaseIdleOwner`).
8. Activity arriving between the pending-input read and the mark reverts via `lastActivity > attemptStart`.
9. Revert after a bounded-wait timeout re-arms and records activity.

Pin every row of the design's close-path audit table that suspension treats differently (inputs never cancelled, non-terminal MCP/Hook, no client-files close, deregistration only after confirmed teardown).

## 7. Verification and self-audit

- `cd packages/cli && npx vitest run src/serve/hosted-session-suspension.test.ts src/serve/hosted-session-suspension.integration.test.ts` plus the collocated core assembly tests and monitor-loop tests.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --build` in `packages/cli` (default heap OOMs; project references, not standalone `--noEmit`).
- `npx eslint <changed files>` and `npx prettier --check <changed files>` in `packages/cli` (and `packages/core` for W1).
- Full `hosted-harness-session.test.ts` and the Hosted/MySQL CI tiers are CI-owned; local budget stays focused. Real-process suspend→reopen acceptance runs after WP1 lands (coordinated upgrade, no config switch).
- Self-audit per AGENTS.md: read the full diff in open-ended presume-wrong passes; stop after two consecutive clean passes; a fix resets the count. Verify every green test asserts the right thing.
- House rules: ESM, no `any`, core imports from defining modules, collocated tests, comments only for non-obvious why. No force-push on active PRs; this branch is local until the feature is complete.

## 8. Boundaries

- No configuration switch or capability for suspension; the test-only env variable can only shorten the period.
- No schema or Store protocol change; placement is kept; the existing seal protocol is used with the gate rules above.
- No input cancellation, no `releaseIdleOwner` reuse, no `managed.close()` as the suspend transaction, no `stopLocal()` before seal reconciliation.
- Cold-open admission cap (candidate 8 → `hosted_session_open_busy`) and observability counters are the next slice after this wiring; WP1-C/D (wake cache invalidation, receipt-less recovery proof) stay on the Java track.
- Enablement gates (measurements, real-process fault acceptance, design open question 8) are NOT part of this plan; they precede any release of the feature.
