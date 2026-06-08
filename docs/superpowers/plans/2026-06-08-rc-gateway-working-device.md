# RC Gateway — Working-Device Suppression (Cycle 17)

> **For agentic workers:** TDD, `- [ ]` steps. All inside `packages/rc-gateway/`. ZERO edits outside it. Stay on branch `add-remote-control-spec` (do NOT create a branch). Run git/npm from repo root `/home/evan/projects/qwen-code`.

**Goal:** Suppress `permission.required` push to a subscription whose own token posted recently (working device). In-memory tracker + activity middleware on session POST routes + notifier suppression.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-working-device-design.md` — full contract + the mechanical-vs-R1 interpretation. Implement as written.

**Conventions:** license headers; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: WorkingDeviceTracker + middleware (TDD)

**Files:** `src/routing/workingDevice.ts` (+ `workingDevice.test.ts`); export from `src/index.ts`.

- [ ] Failing test: unknown token → `isWorking` false; `touch(id)` → true; advance injected `nowFn` past window → false; re-`touch` → true. Middleware: a fake `req` with `rcClient.id` → after `recordActivity(tracker)(req,res,next)`, `isWorking(id)` true and `next` called; `req` without `rcClient` → no throw, `next` called, nothing recorded.
- [ ] Implement `WorkingDeviceTracker(windowMs=120000, nowFn=Date.now)` with a `Map<string,number>`, `touch(id)`, `isWorking(id)` (`now - (last ?? -Infinity) < windowMs`). `export function recordActivity(tracker): RequestHandler` → touches `req.rcClient?.id` then `next()`.
- [ ] Tests pass. Export `WorkingDeviceTracker`, `recordActivity`. Commit: `feat(rc-gateway): working-device tracker + activity middleware`.

### Task 2: notifier suppression (TDD)

**Files:** `src/webpush/notifier.ts` (+ extend `notifier.test.ts`).

- [ ] Add optional `workingDevice?: WorkingDeviceTracker` ctor arg (after existing args).
- [ ] In the fan-out, AFTER the prefs check, before `sender.send`: `if (payload.kind === 'permission.required' && this.workingDevice?.isWorking(record.tokenId)) { void this.audit?.record({action:'push_suppressed', target: ctx.sessionId, detail:{kind: payload.kind, reason:'working_device', subscriptionId: record.id}}); return; }`
- [ ] Failing+impl tests: permission.required + a tracker touched for the sub's token → NOT sent + audit push_suppressed{reason:'working_device'}; non-working token → sent; task.completed + working token → still sent (permission.required-only).
- [ ] Tests pass. Commit: `feat(rc-gateway): notifier suppresses pushes to working devices`.

### Task 3: wiring (TDD via server.test)

**Files:** `src/server.ts`, `src/server.test.ts`.

- [ ] In `createGatewayApp`: `const workingDevice = new WorkingDeviceTracker();` (import it). Pass it into the `PushNotifier` construction (new last arg). Mount `recordActivity(workingDevice)` between `requireScope(...)` and the handler on BOTH the prompt route and the permission vote route, e.g. `app.post('/rc/session/:id/prompt', requireScope(WRITE, audit), recordActivity(workingDevice), createPromptRoute(deps.daemon, audit));` (and similarly for permission).
- [ ] `server.test.ts`: mint a token with `[SESSION_READ, APPROVE, WRITE]` via a pairing code; `POST /rc/session/s1/prompt {prompt:'hi'}` with the bearer → 200 (proves the middleware is wired and doesn't break the route).
- [ ] typecheck/lint/build/test green. Commit: `feat(rc-gateway): record session activity + wire working-device suppression`.

### Task 4: full verification

- [ ] From repo root run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green; then `node scripts/rc-gateway-e2e.mjs` → pass (prompt POST still 200; no e2e change needed — skip touching the e2e script unless trivial).
- [ ] Commit any leftover (skip if clean).

## Self-review checklist

- Tracker is in-memory, injectable clock; unknown token → not working; window default 120000ms.
- Middleware touches only when `req.rcClient?.id` present; never throws; always `next()`.
- Notifier suppression is permission.required-ONLY, runs after snooze+scope+prefs, audits push_suppressed{reason:'working_device', subscriptionId}; task.completed unaffected.
- recordActivity mounted AFTER requireScope (so req.rcClient is set) on both prompt + permission routes; routes still 200.
- Notifier ctor arg optional (back-compat); all prior 214 tests green. Zero files outside packages/rc-gateway/.
