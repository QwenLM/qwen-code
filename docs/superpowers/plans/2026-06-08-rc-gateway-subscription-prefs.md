# RC Gateway — Per-Subscription Prefs (Cycle 16)

> **For agentic workers:** TDD, `- [ ]` steps. All inside `packages/rc-gateway/` (+ repo-root `scripts/rc-gateway-e2e.mjs`). ZERO edits outside it.

**Goal:** Per-subscription `prefs` (kind allowlist) with a PATCH route; notifier filters per-subscription. Absent prefs → receive all; `[]` → receive nothing.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-subscription-prefs-design.md` — full contract. Implement as written.

**Conventions:** license headers; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; run git/npm from repo root `/home/evan/projects/qwen-code`.

---

### Task 1: audit action

- [ ] `src/auditLog.ts`: add `'push_prefs_updated'` to the `AuditAction` union + `AUDIT_ACTIONS`. typecheck. Commit: `feat(rc-gateway): push_prefs_updated audit action`.

### Task 2: PushStore.setPrefs + record.prefs (TDD)

**Files:** `src/pushStore.ts` (+ extend `pushStore.test.ts`).

- [ ] Failing test: `setPrefs(id,['a'])`→record.prefs `['a']`; `setPrefs(id,undefined)`→prefs field removed; `setPrefs('missing',...)`→false; persists across `PushStore.open` reopen.
- [ ] Implement: add `prefs?: string[]` to `PushSubscriptionRecord`; `async setPrefs(id, prefs: string[]|undefined): Promise<boolean>` — find by id (false if absent); if `prefs===undefined` delete the field else assign a copy; await persist; return true.
- [ ] Test passes. Commit: `feat(rc-gateway): per-subscription prefs in push store`.

### Task 3: notifier per-sub filter (TDD)

**Files:** `src/webpush/notifier.ts` (+ extend `notifier.test.ts`).

- [ ] Failing test: two subs under an `approve`-scoped token (use a real TokenStore + PushStore, fake sender) — sub A no prefs, sub B `prefs:['task.completed']`; a `permission.required` event → A gets a send, B does NOT; a sub with `prefs:[]` → no send.
- [ ] Implement: in `notify`'s fan-out, after the scope check and before `sender.send`: `if (record.prefs !== undefined && !record.prefs.includes(payload.kind)) return;` (inside the per-record map; skip silently, no audit). (Snooze + scope checks unchanged, run first.)
- [ ] Test passes. Commit: `feat(rc-gateway): notifier honors per-subscription prefs`.

### Task 4: PATCH route + GET prefs (TDD)

**Files:** `src/routes/push.ts` (+ extend `push.test.ts`).

- [ ] `GET /subscriptions`: include `prefs` in each mapped entry (own + `?all=true`).
- [ ] Add `PATCH /subscriptions/:id` per the design: lookup→404 if absent; own-or-OWNER else 404; validate `body.prefs` is `null`/absent OR an array of strings (else 400 `invalid_prefs`); `await store.setPrefs(id, Array.isArray(body.prefs)?body.prefs:undefined)`; audit `push_prefs_updated {subscriptionId:id}`; `200 {id, prefs}`.
- [ ] Failing tests then impl per design's `routes/push.test.ts` bullets (PATCH own→200+GET shows prefs; null→clears; other's-id non-owner→404; owner→200; non-array→400; audit fires).
- [ ] Tests pass. Commit: `feat(rc-gateway): PATCH subscription prefs route`.

### Task 5: server test + e2e + full verification

**Files:** `src/server.test.ts`, `scripts/rc-gateway-e2e.mjs`.

- [ ] `server.test.ts`: subscribe (owner token) then PATCH `/rc/push/subscriptions/:id {prefs:['task.completed']}` via the mounted router → 200.
- [ ] `scripts/rc-gateway-e2e.mjs`: after subscribe, PATCH prefs → 200, GET subscriptions shows prefs. Bump summary count.
- [ ] From repo root run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green; then `node scripts/rc-gateway-e2e.mjs` → pass.
- [ ] Commit: `test(rc-gateway): e2e subscription prefs`.

## Self-review checklist

- Absent prefs → receive all (back-compat); `[]` → receive nothing; specific list → only those kinds.
- PATCH authz: own-or-owner; other's id as non-owner → 404 (hide). Non-array prefs → 400. null/absent → clears to receive-all.
- Per-sub filter runs in the fan-out AFTER scope + (event-global) snooze; skip is silent (no audit).
- `push_prefs_updated` in union + AUDIT_ACTIONS; audit detail has only subscriptionId (no endpoint).
- Prior 200 tests green. Zero files outside packages/rc-gateway/ except the e2e script.
