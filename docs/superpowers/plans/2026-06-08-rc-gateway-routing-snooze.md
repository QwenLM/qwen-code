# RC Gateway — Notification Routing Part 1: Snooze (Cycle 15)

> **For agentic workers:** TDD, `- [ ]` steps. All inside `packages/rc-gateway/` (+ repo-root `scripts/rc-gateway-e2e.mjs`). ZERO edits outside it.

**Goal:** A persisted global/per-kind snooze that suppresses push, owner-gated routes, notifier integration, audit.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-routing-snooze-design.md` — full `SnoozeStore` API, route contract, notifier integration. Implement as written.

**Builds on:** cycle 9 notifier (you add optional `snooze`+`audit`), cycle 8 store patterns (private-ctor + `static async open` + 0600 JSON persist), cycle 13/14 routing/policy dir conventions.

**Conventions:** license headers; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; run git/npm from repo root `/home/evan/projects/qwen-code`.

---

### Task 1: audit actions

- [ ] `src/auditLog.ts`: add `'push_suppressed'`, `'routing_snoozed'`, `'routing_unsnoozed'` to the `AuditAction` union AND `AUDIT_ACTIONS`.
- [ ] typecheck. Commit: `feat(rc-gateway): routing/snooze audit actions`.

### Task 2: SnoozeStore (TDD)

**Files:** `src/routing/snooze.ts` (+ `snooze.test.ts`); export from `src/index.ts`.

- [ ] Failing test per design's `snooze.test.ts` bullets (use an injectable `nowFn` returning a mutable counter so expiry is deterministic; temp file path for persistence).
- [ ] Implement `SnoozeStore` modeled on `pushStore.ts` (private ctor + `static async open(filePath, nowFn=Date.now)`): in-memory `state: SnoozeState | null`, loaded from JSON on open (absent/corrupt → null). `snooze(durationSec, scope)`: set `state = {until: this.nowFn()+durationSec*1000, scope}`, await persist (writeFile mode 0600, mkdir -p). `clear()`: `state=null`, await persist (write `{}` / or unlink — write `null`/empty object is fine). `active()`: if `state && this.nowFn() < state.until` return state; else (expired) set `state=null` and return null. `isSnoozed(kind)`: `const s=this.active(); return !!s && (s.scope==='all' || s.scope===kind)`.
- [ ] Test passes. Export `SnoozeStore`, `type SnoozeState`. Commit: `feat(rc-gateway): persisted snooze store`.

### Task 3: notifier integration (TDD)

**Files:** `src/webpush/notifier.ts` (+ extend `notifier.test.ts`).

- [ ] Add optional ctor params `snooze?: SnoozeStore`, `audit?: AuditRecorder` (after existing args). Store them.
- [ ] In `notify(event, ctx)`: after building `payload` (so `payload.kind` is known) and BEFORE the fan-out loop: `if (this.snooze?.isSnoozed(payload.kind)) { void this.audit?.record({action:'push_suppressed', target: ctx.sessionId, detail:{kind: payload.kind, reason:'snoozed'}}); return; }`. `notifyToken` UNCHANGED (not snooze-gated).
- [ ] Extend `notifier.test.ts`: a SnoozeStore snoozed 'all' → `notify(permission_request)` → fake sender NOT called + a fake audit got push_suppressed{reason:'snoozed'}; snoozed for a different kind only → still sends.
- [ ] Tests pass. Commit: `feat(rc-gateway): notifier suppresses snoozed pushes`.

### Task 4: routing routes (TDD)

**Files:** `src/routes/routing.ts` (+ `routing.test.ts`); export `createRoutingRouter` from `src/index.ts`.

- [ ] Failing test per design's `routing.test.ts` (mini express app + `express.json()` + middleware setting an OWNER `req.rcClient`; real SnoozeStore temp + fake audit). POST/GET/DELETE /snooze paths; 400 on durationSec 0/missing.
- [ ] Implement `createRoutingRouter(snooze, audit?)` returning a `Router` with `/snooze` POST/GET/DELETE per the design (POST validates `durationSec` finite >0 → 400 `invalid_snooze`; scope default 'all'; audits routing_snoozed/routing_unsnoozed). The router is mounted under `requireScope(OWNER)` at the wiring site (so no in-handler scope check needed).
- [ ] Tests pass. Export. Commit: `feat(rc-gateway): owner snooze routes`.

### Task 5: wiring (TDD via server.test)

**Files:** `src/server.ts`, `src/cli.ts`, `src/server.test.ts`.

- [ ] `GatewayDeps` gains `snooze?: SnoozeStore`. In `createGatewayApp`, when `deps.snooze` present: pass it + `audit` into the `PushNotifier` construction (currently `new PushNotifier(deps.store, deps.pushStore, sender)` → `new PushNotifier(deps.store, deps.pushStore, sender, deps.snooze, audit)`); and mount `app.use('/rc/routing', requireScope(OWNER, audit), createRoutingRouter(deps.snooze, audit))`. (Mount only when `deps.snooze` present.)
- [ ] `server.test.ts` `boot()`: open a temp `SnoozeStore` and pass in deps. Add a test: owner token → POST /rc/routing/snooze {durationSec:60} → 200; GET → active:true; a `session:read`-only token → 403 on POST /rc/routing/snooze.
- [ ] `cli.ts`: `import { SnoozeStore } from './routing/snooze.js';` `const snooze = await SnoozeStore.open(join(homedir(),'.qwen','rc','snooze.state'));` pass into `createGatewayApp` deps.
- [ ] typecheck/lint/build/test green. Commit: `feat(rc-gateway): wire snooze store + routing routes`.

### Task 6: e2e + full verification

- [ ] `scripts/rc-gateway-e2e.mjs`: with the owner token, POST /rc/routing/snooze {durationSec:1} → 200; GET → active true; DELETE → 204. Bump the summary count.
- [ ] From repo root run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green; then `node scripts/rc-gateway-e2e.mjs` → pass.
- [ ] Commit: `test(rc-gateway): e2e snooze checks`.

## Self-review checklist

- `snooze.state` 0600; persisted across reopen; expired snooze treated as inactive (lazily cleared); awaited persist.
- Snooze suppresses the WHOLE fan-out once per notify (not per-sub) BEFORE sends; `/test` (notifyToken) is NOT snooze-gated.
- `isSnoozed` honors scope ('all' vs specific kind).
- Routes owner-gated (mounted under requireScope(OWNER)); POST validates durationSec>0.
- 3 audit actions in union + AUDIT_ACTIONS; push_suppressed detail has {kind,reason} (no secrets).
- Notifier ctor change is back-compat (new args optional); all prior tests green. Zero files outside packages/rc-gateway/ except the e2e script.
