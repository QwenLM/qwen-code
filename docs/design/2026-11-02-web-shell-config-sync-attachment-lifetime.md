# Bind the session config-sync domain to the attachment, not the SSE stream

[English](2026-11-02-web-shell-config-sync-attachment-lifetime.md) | [简体中文](2026-11-02-web-shell-config-sync-attachment-lifetime.zh-CN.md)

Status: implemented with this change.

## Problem

The `E2E Smoke` lane fails on
`web-shell.smoke.spec.ts` — "previews qwen3.8-max reasoning before lazy session
creation @smoke" — on runs whose diff contains no web-shell code (issue #16065).
The model button settles on `qwen3.8-max · Thinking Off` where the test expects
`qwen3.8-max · Medium`, identically on all three attempts, and stays wrong for
the whole 20 s expect window.

This is not a timeout and not a request-ordering violation. The daemon receives
and confirms the `reasoning_effort=medium` write; the client then discards the
confirmed value and never reads it back. The user-visible consequence is that a
reasoning choice made before the first prompt is silently lost when the session
is created, and the composer keeps advertising the pre-choice value.

A second, unrelated failure in the same lane —
`web-shell.settings-exclusions.spec.ts` — exhausts the shared 60 s test budget.
It is covered in Scope below but needs no design decision.

## Current state

`attachSession()` resolves as soon as the transcript replay is injected, before
the session metadata fetches settle. This is deliberate: the comment above the
replay injection in `DaemonSessionProvider.tsx` records that the transcript
paints one metadata round-trip earlier, which matters on high-latency mobile.

`createAndAttachSessionForPrompt()` (`utils/sessionPreparation.ts`) uses that
early resolution to run `setModel()` and then `setReasoningEffort()` while the
load effect is still awaiting metadata.

Config reads and writes are ordered by a per-session domain object
(`session-config-sync.ts`, a `WeakMap` entry holding `generation`,
`pendingWrites`, `readSequence`). `captureConfigOwner()` in
`daemon/session/actions.ts` snapshots that object's identity, and
`beginSessionConfigMutation()` snapshots its counters. Both are checked again
when the daemon's answer arrives.

The load effect called `resetSessionConfigSync()` — which deletes the entry and
creates a fresh object — at the point where it establishes the SSE stream. That
point is _after_ `await metadataPromise`, so it can land in the middle of a
first-prompt config write.

### Evidence

From the CI trace of run `41444684995` attempt 2, retry 1 (artifact
`web-shell-e2e-smoke`, `0-trace.network`):

```
13:56:03.643  POST /session                          create
13:56:04.411  GET  /workspace/providers   took 510.7 ms -> landed 04.922
13:56:04.413  GET  /session/<id>/context             load metadata read
13:56:04.415  POST /session/<id>/model               setModel
13:56:04.557  GET  /session/<id>/context             setModel's own read
13:56:04.935  POST /session/<id>/config-option       confirmed medium write
13:56:04.966  POST /session/<id>/prompt
```

Three facts follow:

1. Both `context` reads precede the write, so both carry the scenario's initial
   `reasoning_effort` value `none`. `setModel` applies that value.
2. No `context` request is issued after the write, so the reconciliation that
   `setReasoningEffort`'s `finally` block owes never ran.
3. The browser console carries no `[WebShell] failed to ...` warning, so the
   write succeeded at the HTTP level and the daemon confirmed it.

The only predicate that gates both the apply and the reconciliation is
`isOwner()`. Of its clauses, the config-sync object identity is the one the load
effect provably changes in this window. The epoch clause is not implicated: the
mock daemon never emits an epoch, and a genuine epoch reset arrives as
`state_resync_required` with reason `epoch_reset`, which tears the session down
through `requestEpochResetReload()` and is already caught by the
`sessionRef.current === session` clause.

The window is load-dependent because `resetSessionConfigSync()` runs
synchronously in the JS continuation after the providers fetch resolves. On a
contended runner that continuation can be delayed past the point where
`setReasoningEffort` captured its ownership token, and land before the confirmed
value is applied.

A local reproduction independently produced the same ordering: providers landed
at 10.91 s and the confirmed write started at 10.93 s, a 20 ms gap against CI's
13 ms. The original spec failed 8 of 9 attempts locally without added load.
Widening `providersDelayMs` to 2000 moved the late response outside the creation
window and both attempts passed, which confirms the failure needs the stale
response _inside_ the window rather than merely late.

`session-config-sync.ts` was added by `d415444b78` (#15779, Workflow mode
controls) — the upper bound of the main-branch diff window named in the issue.
The failure is therefore a main-branch regression, consistent with the
reporter's PR-independent observation. Only this spec sets
`scenario.providersDelayMs = 500`, which is why only this spec widens the window
enough to fail repeatedly.

## Proposal

Move the `resetSessionConfigSync()` call from the SSE-establishment point to the
session-bind point in the same load-effect iteration, immediately before
`pendingLoadToResolve.resolve()`. The SSE establishment keeps reading the
domain through `getSessionConfigSync()`; it no longer recreates it.

The domain's lifetime then matches the attachment's lifetime: it is established
once, when the session becomes current, and torn down by `clearEventStream()`
when the attachment ends. A first-prompt config write can no longer straddle its
recreation, so a daemon-confirmed write is applied and its reconciliation is
scheduled.

No change to when `attachSession()` resolves, so first-prompt latency and the
early transcript paint are untouched.

## Design decisions

**Why move the reset rather than relax the guards.** The guards are correct: a
read captured in a superseded domain must not publish. Relaxing
`captureConfigOwner()` or `mutation.isCurrent()` would let stale snapshots
through in order to rescue one confirmed write. Moving the reset removes the
spurious domain change instead, and leaves every guard intact.

**Why the bind point is a safe home.** The reset must still happen exactly once
per attachment. Between the `try {` that opens the load path and the end of the
iteration body there is no branch at that indentation level that could reach SSE
establishment without passing the bind, and the bind is not inside a
conditional. A reconnect re-enters the loop and re-binds, so it still resets.
`clearEventStream()` keeps its own reset for teardown.

**Why concurrent writes do not lose ownership.** `isConfigOwner()` in the SSE
block compares the domain object's identity, not its `generation`. Writes that
bump `generation` between the bind and SSE establishment therefore keep the
stream's ownership claim valid, which is the intended behaviour.

**Why the load's own stale snapshot is still rejected.** The load effect captures
`configCurrent = beginSessionConfigRead(...)` after the bind point. Moving the
reset earlier does not move that capture, so a concurrent `setModel` or
`setReasoningEffort` still invalidates it and the late metadata still cannot
overwrite newer config.

**Rejected alternative: resolve `attachSession()` after SSE establishment.**
This would also close the window, but it would block the composer on the
metadata round-trip and undo the documented early-paint optimisation.

**Rejected alternative: re-capture ownership in the `finally` block.** This
would heal the displayed value through a fresh read, but the confirmed write's
own apply — including `withPersistedReasoningPreview()`, which carries the
persisted choice into the next deferred session — would still be lost, and the
UI would show a wrong value until the read landed.

### Consequence: one existing test pinned the dropped write

`DaemonSessionProvider.test.tsx` — "initial subscription recovery > handles
immediate 'turn*error' history=false approvalPending=true" — asserted
`connection.currentMode` was `undefined` \_after* `setApprovalMode('auto-edit')`
had been confirmed by the daemon. That assertion held only because the same
mid-write domain reset discarded the confirmed approval mode along with its
reconciliation. It pinned the defect for approval mode that this change fixes
for reasoning.

With the domain surviving, the write is applied and its reconciliation runs. The
test's context mock, however, kept reporting the pre-write `currentModeId` even
after confirming the write, so the reconciliation republished `default`. The
test was reworked rather than its assertion flipped:

- the mock now reads a `confirmedMode` variable at call time, so a context read
  after the confirmed write reports `auto-edit`, as a real daemon would;
- the intermediate assertion became `currentMode === 'auto-edit'`, which is
  strictly stronger than `undefined` — it now requires the confirmed value to
  survive both the stale snapshot and the reconciliation;
- the expected context read count for the pending-approval case rose by one,
  accounting for the post-write reconciliation that is no longer suppressed;
- the later re-mock to `auto-edit` became redundant and was removed.

The other three parameterisations of that test are unaffected: `confirmedMode`
stays `default`, which is structurally identical to the previous `latest`
fixture.

## Scope

In scope:

- `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx` — relocate
  the domain reset.
- `packages/web-shell/client/daemon/session/DaemonSessionProvider.test.tsx` — a
  new regression test for the reasoning write, and the reworked approval-mode
  test described above.
- `packages/web-shell/client/e2e/web-shell.settings-exclusions.spec.ts` — share
  the live daemon through `test.beforeAll`/`test.afterAll` and split the six-case
  loop into six tests, so each case owns a full budget and a failure names the
  case. Follows the existing fixture pattern in `web-shell.live-preview.spec.ts`.
  Case `name` values are unchanged, so the design-doc PNG artifact filenames are
  unchanged.

Out of scope:

- `web-shell.files.spec.ts:547`, listed as flaky in the issue matrix. It failed
  once and passed on retry, has a different signature, and is not named in the
  issue title.
- The dedicated runner pool proposal (#15967). It would relieve the budget half
  but cannot fix a state race that also fails on an idle runner.
- Any change to `attachSession()` resolution timing or to the guard predicates.
- The case where `connection.providers` has not been populated at all when a
  persisted reasoning write confirms, so `withPersistedReasoningPreview()` has
  nothing to update. The reported flow always has providers from the earlier
  session-less connect; see Open questions.

## Constraints and risks

- The domain reset is shared by every config action (`setModel`,
  `setReasoningEffort`, `setWorkflowMode`, `getContext`, reconciliation, recovery
  refresh). Moving it changes when in-flight reads are invalidated for all of
  them, so the existing config-sync unit tests are the primary regression gate.
- Reads issued between the bind and SSE establishment now survive into the new
  stream instead of being invalidated. They are guarded by `readSequence` and
  `generation`, and the load's own capture still post-dates the bind, so a stale
  snapshot still cannot publish. This is the behaviour change to watch, and it
  is what the reworked approval-mode test now exercises.
- The one traced behaviour flip in the other direction: a config write whose
  ownership was captured during a reconnect availability gap (after
  `clearEventStream()` reset, before the next bind) and confirmed after that bind
  used to be applied and is now invalidated at the bind. It self-heals —
  `replay_complete` is emitted on a Last-Event-ID incremental reconnect even when
  nothing was replayed, which sets `acceptingConfig` and triggers
  `requestInitialConfigRead()` to read the daemon's real state, including that
  confirmed write. The exposure is a transient display during a disconnect, not
  a lost write.
- The E2E split changes the `@smoke` test count for this file from one to six.
  Lane wall time may rise slightly because each test installs its own scenario;
  the daemon itself is spawned once.
- The live-daemon test remains POSIX-only; the win32 skip moved into
  `beforeAll` so the shared fixture never spawns on Windows.

- The bind-site reset is deliberately redundant, and no test in the current
  harness can pin it in isolation. Two mechanisms already invalidate anything
  captured before a re-attach: every load iteration calls
  `beginSessionConfigRead(...)` unconditionally, and both the read predicate and
  `mutation.isCurrent()` require the captured `readSequence`, so the new
  attachment's own capture supersedes prior reads _and_ writes; and a re-attach
  ends the outgoing SSE loop, whose exit paths call `clearEventStream()`, which
  resets the same owner's domain. Deleting the four bind-site lines leaves the
  provider suite at its pre-existing baseline. The call is kept because it makes
  "a new attachment starts with `pendingWrites` at zero" a local guarantee at the
  bind, rather than a property that holds only while a distant teardown path
  fires first — notably for an iteration that binds and then returns early on the
  post-await disposal check, where no stream was ever established. The
  load-bearing half of this change is the _removal_ of the SSE-site reset, and
  that is pinned by the regression test and the reworked approval-mode case.

## Validation plan

1. Unit: the `daemon/session` suites in `packages/web-shell`, before and after.
2. New regression test: hold the attach metadata read open, confirm a reasoning
   write inside that window, and assert the confirmed value is applied and a
   reconciliation read follows. The test also asserts the window itself exists
   (providers read issued, at least one context read) so it cannot pass
   vacuously. Mutation-checked: it fails on the pre-change code.
3. E2E: both named specs, with the forced `providersDelayMs = 500`, including the
   persisted-preview assertion after "New session".
4. Lint and format on the touched files, plus the package typecheck.
5. CI: the `E2E Smoke` lane on the PR is the authoritative check for the
   load-dependent half.

The new unit test deliberately stops at the applied value and the reconciliation
read. It does not assert the persisted providers preview, because in a
mount-time-load fixture `connection.providers` is still unpopulated while the
metadata is held, so there is nothing for `withPersistedReasoningPreview()` to
update. The E2E spec covers that path, where the session-less connect has
already populated providers.

## Acceptance criteria

- The smoke spec's model button reads `qwen3.8-max · Medium` after the lazy
  session is created, and still reads `Medium` after "New session", with
  `providersDelayMs = 500` in force.
- The new regression test passes with the change and fails without it.
- The only existing test whose expectations change is the approval-mode case
  described above, and it changes to a stronger assertion, not a weaker one.
- Each settings-exclusions case is a separate test with its own budget; the live
  daemon is spawned once per file; the win32 skip still holds.
- First-prompt latency is unchanged: `attachSession()` still resolves before the
  metadata fetches settle.

## Open questions

- Whether the same domain-lifetime reasoning should be applied to
  `clearEventStream()`'s reset on a mid-iteration SSE restart, where the
  attachment survives but the stream does not. Left unchanged here because no
  evidence in this issue implicates it.
- Whether a persisted reasoning write that confirms before any providers
  snapshot exists should record its preview for the next deferred session. Not
  reachable in the reported flow; worth a separate look if a host ever attaches
  a session without a prior session-less connect.
