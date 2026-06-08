# RC Gateway — WebPush Part 2: Send Machinery (Cycle 9)

> **For agentic workers:** Implement task-by-task with TDD (`- [ ]` steps). All work inside `packages/rc-gateway/` (+ repo-root `scripts/rc-gateway-e2e.mjs`). ZERO edits outside `packages/rc-gateway/`.

**Goal:** Gateway-side push send machinery — payload builder, web-push sender (retry + dead-sub removal), scope-filtered notifier fan-out, and an owner `POST /rc/push/test`. All unit-tested behind an injected transport (no browser/network).

**Design:** `docs/superpowers/specs/2026-06-07-rc-gateway-webpush-sender-design.md` (read it — it has full component signatures, the scope table, retry policy, and the per-file test strategy).

**Builds on cycle 8:** `VapidStore` (`src/webpush/vapid.ts`), `PushStore` (`src/pushStore.ts`), push router (`src/routes/push.ts`). web-push is CommonJS → `import webpush from 'web-push'`.

**Conventions:** license header on new `src/*.ts`; `.js` import extensions; commit per task, every message ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; pre-commit prettier hook is expected.

---

### Task 1: audit actions + TokenStore.scopesFor

- [ ] `src/auditLog.ts`: add `'push_sent'`, `'push_send_failed'`, `'push_subscription_expired'` to the `AuditAction` union AND `AUDIT_ACTIONS`.
- [ ] `src/tokenStore.ts`: add `scopesFor(id: string): RcScope[] | undefined` (find record by id; return a copy `[...record.scopes]`; pure, no I/O). Add a unit test in the existing token-store test file (scopesFor known id → scopes; unknown → undefined).
- [ ] typecheck + run the tokenStore test. Commit: `feat(rc-gateway): push send audit actions + TokenStore.scopesFor`.

### Task 2: payload builder (TDD)

**Files:** `src/webpush/payload.ts` (+ `payload.test.ts`); export from `src/index.ts`.

- [ ] Failing test per the design's `payload.test.ts` bullet (permission_request mapping incl. requestId + url `/ui/?session=s1`; missing toolName fallback; ≤140 truncation with `…`; unknown type → null; assert a planted secret tool-arg does NOT appear in the summary).
- [ ] Implement `buildPayload(event, ctx)`: switch on `event.type`. `permission_request` → `{v:1, kind:'permission.required', sessionId, sessionName, summary:'Permission needed: '+toolName, url:'/ui/?session='+encodeURIComponent(sessionId), requestId}` where toolName is read defensively (`(data.toolCall?.name)||(data.toolCall?.title)||data.toolName||'a tool call'`) and requestId from `data.requestId`. Truncate summary to 140 (`s.length>140 ? s.slice(0,139)+'…' : s`). Unknown type → `null`. Cast `data` via a local `as Record<string,any>` with safe optional chaining.
- [ ] Test passes. Commit: `feat(rc-gateway): metadata-only push payload builder`.

### Task 3: sender (TDD)

**Files:** `src/webpush/sender.ts` (+ `sender.test.ts`); export from `src/index.ts`.

- [ ] Failing test per design's `sender.test.ts` (fake transport, `backoffMs:[0,0,0,0,0]`, injected `sleep:async()=>{}`): 201→push_sent; 410→remove+expired no-retry; 503-then-201→retried then push_sent; persistent 503→5 attempts then push_send_failed (sub kept); network throw then 201→retried; send never throws even if the audit recorder throws.
- [ ] Implement `PushSender` per the design signature. Default transport: lazily call `setVapidDetails(...)` once (guard with a boolean), then `await webpush.sendNotification(sub, payloadJson)` → return `{statusCode: res.statusCode}`; catch `WebPushError` → return `{statusCode: err.statusCode}`; catch other → return `{statusCode: 0}` (network/transient). `send(record,payload)` loop: attempt = transport; classify: 2xx (200–299) → audit push_sent, return; 404/410/403 → `await store.remove(record.id)`, audit push_subscription_expired, return; else (429/5xx/0) → if attempts left, `await sleep(backoffMs[i])`, continue; after last → audit push_send_failed, return. Wrap the whole body in try/catch so `send` NEVER throws. Audit calls use `void audit?.record(...)` but note: to assert "never throws even if audit throws", call audit inside the try (a throwing audit must not propagate) — use `try { await audit?.record(...) } catch {}` or rely on the outer catch; simplest: outer try/catch around everything.
- [ ] Test passes. Commit: `feat(rc-gateway): web-push sender with retry + dead-sub removal`.

### Task 4: notifier (TDD)

**Files:** `src/webpush/notifier.ts` (+ `notifier.test.ts`); export from `src/index.ts`.

- [ ] Failing test per design's `notifier.test.ts` (scope table: permission.required→approve, task.completed→session:read; the session:read-only sub is skipped with no audit; `notifyToken` targets only that token's own subs). Use a real PushStore (temp) + real TokenStore (temp, mint tokens with specific scopes) + a PushSender with a fake transport capturing sends.
- [ ] Implement `PushNotifier`. Kind→required-scope map: `{'permission.required':'approve','task.completed':'session:read'}` (import APPROVE, SESSION_READ from scopes). `notify(event,ctx)`: `const p=buildPayload(event,ctx); if(!p)return; const need=MAP[p.kind]; await Promise.all(store.listAll().map(async r=>{ const sc=tokens.scopesFor(r.tokenId); if(sc && sc.includes(need)) await sender.send(r,p); }))`. `notifyToken(tokenId,payload)`: `const need=MAP[payload.kind]; await Promise.all(store.listFor(tokenId).map(async r=>{ const sc=tokens.scopesFor(tokenId); if(sc && sc.includes(need)) await sender.send(r,payload); }))`.
- [ ] Test passes. Commit: `feat(rc-gateway): scope-filtered push notifier fan-out`.

### Task 5: test route + wiring (TDD)

**Files:** `src/routes/push.ts` (+ extend `push.test.ts`), `src/server.ts`, extend `src/server.test.ts`.

- [ ] `createPushRouter` gains a `notifier: PushNotifier` param. Add `POST /test`: if `!req.rcClient!.scopes.includes(OWNER)` → 403 insufficient_scope; build a synthetic payload `{v:1, kind:'task.completed', sessionId: (body.sessionId||'test'), summary:'Task finished', url:'/ui/?session='+...}`; `await notifier.notifyToken(req.rcClient!.id, payload)`; respond `200 { sent: store.listFor(req.rcClient!.id).length }`.
- [ ] `server.ts`: when both stores present, build `const sender = new PushSender(deps.vapid, deps.pushStore, audit); const notifier = new PushNotifier(deps.store, deps.pushStore, sender);` and pass `notifier` into `createPushRouter(deps.vapid, deps.pushStore, notifier, audit)`. (Update the router signature/call order consistently.)
- [ ] Extend `push.test.ts`: `POST /test` non-owner→403; owner with 1 sub→200 {sent:1} and the fake transport saw a `task.completed`. (For the route test, construct the router with a PushSender whose transport is a capturing fake.)
- [ ] Extend `server.test.ts`: owner token subscribes then `POST /rc/push/test`→200 {sent:1}.
- [ ] Tests pass. Commit: `feat(rc-gateway): owner push-test route + wire sender/notifier`.

### Task 6: e2e + full verification

- [ ] `scripts/rc-gateway-e2e.mjs`: after the existing subscribe check, `POST /rc/push/test` with the owner token → 200 with `sent>=1`. (Real send to the dummy endpoint will fail/expire — that's fine; we assert the route + count.) Bump the summary count.
- [ ] Run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (all `--workspace @qwen-code/rc-gateway`) → green. Then `node scripts/rc-gateway-e2e.mjs` → pass.
- [ ] Commit: `test(rc-gateway): e2e push-test route check`.

## Self-review checklist

- Sender NEVER throws (best-effort), even when transport or audit throws; tests prove it.
- 410/404/403 removes the subscription + audits expired; 429/5xx/network retries (≤5) then push_send_failed keeping the sub.
- Payloads are metadata-only: no tool args, no file paths, no prompts; summary ≤140; url carries no token. Test asserts a planted secret is absent.
- Scope gate: session:read-only sub does NOT receive permission.required, with NO audit noise.
- Audit detail never contains the endpoint or payload contents beyond `kind`.
- backoff is injectable so tests are fast; zero files outside packages/rc-gateway/ (except e2e script).
