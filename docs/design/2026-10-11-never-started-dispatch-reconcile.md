# Never-started dispatch reconcile arm (issue #13801 A3)

[English](2026-10-11-never-started-dispatch-reconcile.md) | [简体中文](2026-10-11-never-started-dispatch-reconcile.zh-CN.md)

Status: proposed (2026-10-11, author wenshao)
Tracks: #12380 Stage H → #12827, finding **A3** of the #13532 acceptance run.
Out of scope: A1 itself (#13789, merged), the cross-Session wedge (#13800),
enabling `monitor_run` or the `child_run` `shell` kind.

## Problem statement

A `child_run` record whose background dispatch was claimed can commit
`run.state: "running"` with `run.execution: "dispatch_started"` while the
process provably never started, and stay there forever:

- Record revision 1 (`admit`) and revision 2 (`dispatchStarted`) commit
  **before** the Broker execute call (`hosted-workspace-tool-turn.ts` —
  the `commitAwaitRuntimeBatch` checkpoint makes the dispatch durable).
- If the daemon dies after the `dispatchStarted` commit but before the
  execute/settle path runs, or if the in-turn catch arm
  (`hosted-workspace-tool-turn.ts`, the `proven` gate over
  `close_not_started`) cannot obtain its proof, **no arm ever settles the
  record again**. Every other `settleFailed` caller fires only inside a live
  turn.
- The public tasks API then reports `running` / `provisioning` forever
  (`managed-extension-projection.ts`: `intent | dispatch_started →
provisioning`, `taskState → running`).

R1 — the missing arm: on reload, a record whose execution was claimed but
whose process provably never existed (no `:process` ledger row, no cgroup
unit) must settle to `not_started_proven` instead of staying at
`dispatch_started`.
R2 — the public answer follows the record by construction (the projection
is a pure read; `not_started_proven` already projects terminal).
R3 — no widening: an ambiguous outcome must stay blocked and must never be
reported as never-started.

## Key evidence chain (all verified at HEAD)

1. **A missing `:process` row is a complete proof of never-started.**
   `RuntimeBrokerService` admits the `:process` ledger row (keyed
   `<executionCallId>:process`, durable JDBC) at execute-admission, _before_
   `beginDispatch` runs, inside the same `.thenApply` block
   (`RuntimeBrokerService.java` execute path). Admission therefore strictly
   precedes dispatch:
   - row **absent** ⇒ execute-admission never happened ⇒ dispatch never
     began ⇒ the worker never received the call ⇒ no cgroup unit could
     exist. The cgroup-unit leg of the issue's two-part evidence is
     _entailed by_ the row leg and needs no separate check (the harness
     cannot see worker-local units anyway).
   - row **present** ⇒ dispatch began ⇒ the process may or may not have
     started: **ambiguous ⇒ stays as-is** (that is the B1 family, #13533,
     out of scope here).
2. **The 404 asymmetry makes the proof conservative.** The Broker's
   `requireExecution` looks the row up by `executionCallId` in the shared
   repository _first_ and throws `runtime_execution_not_found` (404) before
   any Session/binding identity check. The TS client
   (`HostedWorkspaceBroker.status`) maps exactly this 404 to `undefined` and
   nothing else (409 `runtime_broker_execution_unknown` →
   `{state:'unknown'}`; every other rejection re-throws). So `status()`
   answering `undefined` is a definitive "the row provably does not exist",
   independent of which runtime-session context answered.
3. **The absence read does not need a session context.** `getExecution`
   runs `requireOwnedExecution` — a durable `findByExecutionCallId` lookup —
   before any Session-lifecycle check (`requireReadySession`), and it answers
   `runtime_execution_not_found` (404) for the absent `:process` row even
   after the original runtime Session is `RELEASED` (reacquisition, which
   matters only for mutations like cancel/settle, then fails permanently
   with `runtime_session_not_acquirable`). So a probe of the missing row is
   unaffected by runtime Session liveness and never needs an acquire.
4. **The runtime-session identity is durable via the journal.** Each
   background dispatch writes a `tool.intent` event
   (`payload.executionCallId`, `payload.argsRef`); in publication mode the
   `argsRef` resource is a `managed-tool-input` route JSON carrying
   `harnessSessionId` and `runtimeSessionId`
   (`hosted-runtime-recovery.ts` `originalRuntimeBroker` already recovers
   owners this way). A stranded record can therefore reconstruct the exact
   Broker identity under which its execution was claimed.
5. **The settle transition is contract-legal today.** `dispatch_started →
not_started_proven` is an admitted execution step, `running → failed`
   an admitted run step, `failed` + `not_started_proven` a proven terminal
   pair (`parseExtensionRun` rules), and `start_failed` is an admitted child
   `stopReason`. The in-turn arm already commits exactly this body. The
   record never carries `startReceiptRef`, which is exactly what a
   never-started settlement requires.

## Proposed design

### New module: reconcile-on-open scan

`packages/cli/src/serve/hosted-never-started-reconcile.ts` exports:

```text
reconcileNeverStartedChildRuns(input: {
  authority: LocalManagedSessionAuthority;
  resources: { read(ref): Promise<Buffer> };
  childRuns: HostedChildRunSession;
  brokerOptions: HostedWorkspaceBrokerOptions;
}): Promise<{ scanned: number; settled: string[]; skipped: string[] }>
```

Algorithm:

1. Enumerate `authority.extensionRecordsInDomain('child_run')`; keep
   records whose parsed `run.execution === 'dispatch_started'`.
2. For each candidate, reconstruct the runtime-session identity from its
   `tool.intent` event: read `payload.argsRef`; require the
   `managed-tool-input` route with `runtimeSessionId` and a matching
   `harnessSessionId`; validate with `assertManagedSessionStableId`.
   Anything unreadable / missing / mismatched ⇒ **skip** (no proof).
3. Group candidates by runtimeSessionId. Per group:
   `broker = new HostedWorkspaceBroker(brokerOptions, sessionKey,
runtimeSessionId)`. No acquire: a released runtime Session would wedge a
   mandatory reacquire behind a permanent
   `runtime_session_not_acquirable`, while the definitive not-found answer
   needs no session context anyway (§3).
4. Per candidate: `status(<executionCallId>:process)`:
   - `undefined` (404, definitive) ⇒
     `childRuns.settleFailed(shellId, { stopReason: 'start_failed',
started: false })` → commits `state: failed`,
     `execution: not_started_proven`, `stopReason: start_failed` through
     `commitExtensionRecord` (durable in the same transaction, replay-safe
     by command id, deep-equal no-op if already settled).
   - any answer (`{state}` incl. `unknown`) or any rejection ⇒ **skip**.
5. The settle **commit** error propagates (the session's own writer plane
   failing is loudly retryable); every _proof-reading_ error (route read,
   status) is reported in `skipped` and never blocks the open —
   a Broker that is not reachable yet simply means "not proven", which is
   the R3-safe answer.

### Hook point: hosted session open

In `registerHostedHarnessSessionRoutes`'s open/load path
(`hosted-harness-session.ts`), immediately after the `childRuns`/`monitors`
funnels are constructed (after the records were replayed by
`openManagedSession`):

```text
if (session.childRuns && brokerOptions)
  await reconcileNeverStartedChildRuns({
    authority: session.managed.authority,
    resources: session.managed.resources,
    childRuns: session.childRuns,
    brokerOptions,
  });
```

- Runs once per fresh open, before any route can consume the session; no
  concurrent turn can re-attach between the scan and the registration.
- Zero cost when nothing is stranded (no candidates ⇒ no Broker traffic).
- Re-entrant: a partially-settled crash between scan and settle is healed
  by the next open (deep-equal skips, replay-safe command ids).

### What is deliberately NOT built

- No cgroup-unit leg from the harness (worker-local, requires supervisor
  adoption — the row leg already entails it; see evidence §1).
- No `monitor_run` arm: monitor records strand at the same window but the
  issue frames R1 on `child_run` (monitor `dispatchStarted` also keeps
  `state: 'admitted'`, which is the _under_-claiming direction tracked by
  #13377's mirror — a different symptom, out of scope).
- No periodic scanner: reload-only per R1. A broker-outage-at-open hole
  stays stranded until a later reload; strictly better than today (never).
- No `release()` after probing: releasing persists `RELEASED` and wedges
  future redrives of that runtime session (established recovery hazard).
- No changes to the record contract, the projection, or the Java side:
  the transition is already legal everywhere (evidence §5).

## Witness plan (fails-when-arm-removed / collapsed)

Unit level (`hosted-never-started-reconcile.test.ts`, local-store rig with a
stubbed `HostedWorkspaceBroker` module):

- **R1 settle**: stranded `dispatch_started` record + `status(':process')
→ undefined` ⇒ record reads `failed` + `not_started_proven` +
  `stopReason: start_failed`; **reopen** the authority again and assert the
  same (reload-visible). Assert `broker.acquire` is never called: the
  definitive absence read carries no liveness prerequisite (released
  runtime Session still proves the missing `:process` row).
- **R2 by construction**: after the settle, `authority.taskViews()` shows a
  terminal task (`state: failed`, no runtime hold) instead of
  running/provisioning.
- **R3 ambiguous:** `status → {state:'executing'|'unknown'}` or a rejection
  ⇒ record untouched (still `dispatch_started`, no settle commit).
- **R3 no-identity**: no `tool.intent` route / mismatched session ⇒ skip.
- **R3 not-stranded**: `running_attached` records are never even candidates.

Contract level (`contracts/managed-child-run-record-v1.fixtures.json`):

- New successor pair e.g. `dispatch-started-never-started-proven`:
  before = the `admit-to-dispatch` body, after =
  `{ stopReason: 'start_failed', run: {state: 'failed',
execution: 'not_started_proven'} }`, `valid: true` — replayed by the
  existing TS and Java fixture suites automatically (both languages pin the
  transition the arm commits).
- The opposite-pin already exists through the run-level fixtures
  (`failed-with-unknown-outcome` valid, non-blocked unknown invalid); the
  forcing rule (`outcome_unknown|corrupt` ⇒ `recovery_blocked`) already
  commits the ambiguity family elsewhere.

Hook wiring (`hosted-harness-session.test.ts`):

- A load on a Session with a stranded record invokes the reconcile with the
  built session (module mock; **fails if the hook is removed**).

## Files affected

| File                                                                                    | Change                        |
| --------------------------------------------------------------------------------------- | ----------------------------- |
| `packages/cli/src/serve/hosted-never-started-reconcile.ts`                              | **new**, the arm              |
| `packages/cli/src/serve/hosted-never-started-reconcile.test.ts`                         | **new**, witnesses            |
| `packages/cli/src/serve/hosted-harness-session.ts`                                      | call the arm on open (~small) |
| `packages/cli/src/serve/hosted-harness-session.test.ts`                                 | wiring witness                |
| `packages/core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json` | +1 successor pair             |
| `docs/design/2026-10-11-never-started-dispatch-reconcile(.zh-CN).md`                    | this doc                      |

## Open questions

- Should a resolved-but-unproven parked turn's own replay path
  (e.g. `finishBackground`/resumeAttached arms) converge to the same proof
  read later, replacing the duplicated logic? Deferred: the open-scan
  covers the strictly larger record set; convergence can come after B1.
- Acquired-but-never-released runtime sessions: keeping the lease matches
  the established recovery behavior; the daemon/Broker lifecycle owns
  cleanup. Revisit only if lease pressure shows up in soak.
