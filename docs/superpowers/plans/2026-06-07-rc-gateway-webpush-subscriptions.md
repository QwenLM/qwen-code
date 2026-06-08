# RC Gateway — WebPush Part 1: VAPID + Subscriptions (Cycle 8)

> **For agentic workers:** Implement task-by-task with TDD. Steps use checkbox (`- [ ]`). All work inside `packages/rc-gateway/` (+ the repo-root `scripts/rc-gateway-e2e.mjs`). ZERO edits outside `packages/rc-gateway/`.

**Goal:** Gateway-owned VAPID keypair management + token-bound push-subscription CRUD + audit, as the backend for WebPush. No web client / service worker / send pipeline (cycle 9).

**Architecture:** Fork-owned gateway; VAPID keys and subscriptions are gateway state under `~/.qwen/rc/`. See design: `docs/superpowers/specs/2026-06-07-rc-gateway-webpush-subscriptions-design.md`.

**Tech Stack:** TypeScript (NodeNext ESM), Express, vitest, `web-push@^3.6.7` (already installed; `@types/web-push` devDep already installed).

**web-push API (verified):** `generateVAPIDKeys(): { publicKey: string; privateKey: string }` (base64url). `setVapidDetails`/`sendNotification`/`WebPushError` are cycle 9. `PushSubscription = { endpoint: string; expirationTime?; keys: { p256dh: string; auth: string } }`.

**Conventions:** License header (copy from an existing `src/*.ts`) on every new file. `.js` extensions on relative imports. Commit after each task; every message ends with:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
(pre-commit prettier hook runs; that's expected).

---

### Task 1: audit actions

**Files:** Modify `src/auditLog.ts`.

- [ ] Add `'push_subscribed'` and `'push_unsubscribed'` to the `AuditAction` union AND the `AUDIT_ACTIONS` array.
- [ ] `npm run typecheck --workspace @qwen-code/rc-gateway` passes.
- [ ] Commit: `feat(rc-gateway): add push audit actions`.

### Task 2: VAPID store (TDD)

**Files:** Create `src/webpush/vapid.ts`, `src/webpush/vapid.test.ts`. Modify `src/index.ts` (export `VapidStore`, `type VapidKeys`).

- [ ] **Failing test** `src/webpush/vapid.test.ts`: use `mkdtempSync` for a temp dir.
  - first `VapidStore.open(path)` → file exists; on POSIX assert mode is 0600 (`statSync(path).mode & 0o777 === 0o600`); `getApplicationServerKey()` returns a non-empty base64url string (matches `/^[A-Za-z0-9_-]+$/`); `getKeys().privateKey` is non-empty.
  - second `VapidStore.open(path)` returns the SAME publicKey (no regeneration — compare to the first).
  - corrupt the file (write `'not json'`) then `open` → regenerates a valid key (no throw).
  - `getSubject()` returns `process.env.QWEN_RC_WEBPUSH_SUBJECT` when set, else `mailto:noreply@<hostname>` (set/restore the env var in the test).
- [ ] Run `npm run test --workspace @qwen-code/rc-gateway -- vapid` → FAILS (module not found).
- [ ] **Implement** `src/webpush/vapid.ts`:
  - License header. `import webpush from 'web-push';` (default import; it's a CommonJS module — if `webpush.generateVAPIDKeys` is undefined under ESM interop, use `import * as webpush from 'web-push'`. Verify which works via the test.) `import { mkdir, readFile, writeFile } from 'node:fs/promises'; import { dirname } from 'node:path'; import { hostname } from 'node:os';`
  - `export interface VapidKeys { publicKey: string; privateKey: string }`
  - `export class VapidStore` with a private constructor holding `keys` + `subject`. `static async open(filePath, subject?)`: try read+parse JSON `{publicKey,privateKey}` (both non-empty strings) → reuse; on any failure → `generateVAPIDKeys()`, `mkdir(dirname,{recursive:true})`, `writeFile(filePath, JSON.stringify(keys), {mode:0o600})`. Resolve subject = `subject ?? process.env.QWEN_RC_WEBPUSH_SUBJECT ?? 'mailto:noreply@'+hostname()`.
  - `getApplicationServerKey()=>this.keys.publicKey`; `getKeys()=>this.keys`; `getSubject()=>this.subject`.
- [ ] Run vapid test → PASSES. Export from `src/index.ts`.
- [ ] Commit: `feat(rc-gateway): gateway-owned VAPID keypair store`.

### Task 3: push subscription store (TDD)

**Files:** Create `src/pushStore.ts`, `src/pushStore.test.ts`. Modify `src/index.ts` (export `PushStore`, `type PushSubscriptionRecord`).

- [ ] **Failing test** `src/pushStore.test.ts` (temp file path):
  - `add('tokA', {endpoint:'https://push/1', keys:{p256dh:'p', auth:'a'}})` → record with an id, tokenId 'tokA', createdAt number; `listFor('tokA')` has 1.
  - add the SAME (tokenId,endpoint) again → still 1 record, same id (idempotent).
  - add same endpoint under 'tokB' → distinct record; `listAll()` has 2; `listFor('tokB')` has 1.
  - `get(id)` returns it; `remove(id)` → true then `remove(id)` again → false; persists (reopen `PushStore.open(samePath)` → reflects the removal).
- [ ] Run `-- pushStore` → FAILS.
- [ ] **Implement** `src/pushStore.ts` modeled on `tokenStore.ts` (private ctor + `static async open`): in-memory array, JSON persist `{subscriptions: [...]}` at mode 0600 (mkdir -p), `add` awaits persist (durability), id = `randomBytes(16).toString('hex')`, de-dup by `(tokenId,endpoint)`. `nowFn` injectable default `Date.now`.
- [ ] Run pushStore test → PASSES. Export from `src/index.ts`.
- [ ] Commit: `feat(rc-gateway): token-bound push subscription store`.

### Task 4: push routes (TDD)

**Files:** Create `src/routes/push.ts`, `src/routes/push.test.ts`. Modify `src/index.ts` (export the route factories).

- [ ] **Failing test** `src/routes/push.test.ts`: build a tiny express app with `express.json()` + a middleware that sets `req.rcClient` from a per-test variable, then mount the routes. Use a real `VapidStore` (temp) + `PushStore` (temp) + a fake `AuditRecorder` collecting entries. Cases per the design's testing section: vapid GET 200; subscribe valid 201 + audit `push_subscribed`; malformed (missing keys.auth) 400; list-own isolation; `?all=true` non-owner 403 / owner sees all incl tokenId; delete own 204 + audit / delete other's as non-owner 404 / as owner 204. Assert the serialized audit entry for subscribe/unsubscribe does NOT contain the endpoint string.
- [ ] Run `-- push` → FAILS.
- [ ] **Implement** `src/routes/push.ts`. Export individual factories taking `(vapid, store, audit?)` OR one factory returning a configured `express.Router()`. **Use a Router factory** `export function createPushRouter(vapid: VapidStore, store: PushStore, audit?: AuditRecorder): Router` that defines the 4 routes (the Router is mounted under `requireScope(SESSION_READ)` at the wiring site). Inside:
  - `GET /vapid` → `{ applicationServerKey: vapid.getApplicationServerKey() }`.
  - `POST /subscribe`: read `body.subscription`; validate `endpoint`, `keys.p256dh`, `keys.auth` are non-empty strings → else 400 `{error:'Invalid subscription',code:'invalid_subscription'}`; `const rec = await store.add(req.rcClient!.id, {endpoint, keys})`; audit `push_subscribed {subscriptionId: rec.id}`; `201 {id: rec.id}`.
  - `GET /subscriptions`: if `req.query.all === 'true'` → require `req.rcClient!.scopes.includes(OWNER)` else 403; return `{subscriptions: store.listAll().map(r=>({id,endpoint,createdAt,tokenId}))}`. Else `{subscriptions: store.listFor(req.rcClient!.id).map(r=>({id,endpoint,createdAt}))}`.
  - `DELETE /subscriptions/:id`: `const rec = store.get(req.params.id)`; if `!rec` → 404; const isOwnerScope = scopes.includes(OWNER); if `rec.tokenId !== req.rcClient!.id && !isOwnerScope` → 404 (hide); else `await store.remove(rec.id)`; audit `push_unsubscribed {subscriptionId: rec.id}`; 204.
  - Import `OWNER` from `../scopes.js`. Note the Router mount path is `/rc/push` so route paths are `/vapid`, `/subscribe`, `/subscriptions`, `/subscriptions/:id`.
- [ ] Run push test → PASSES. Export `createPushRouter` from `src/index.ts`.
- [ ] Commit: `feat(rc-gateway): push subscription + vapid routes`.

### Task 5: wire into server + deps (TDD via server.test)

**Files:** Modify `src/server.ts`, `src/server.test.ts`.

- [ ] Add to `GatewayDeps` (all optional): `vapid?: VapidStore; pushStore?: PushStore;`. Import `VapidStore`, `PushStore`, `createPushRouter`, `SESSION_READ` (already imported).
- [ ] In `createGatewayApp`, after the prompt route, if `deps.vapid && deps.pushStore`:
  ```ts
  app.use(
    '/rc/push',
    requireScope(SESSION_READ, audit),
    createPushRouter(deps.vapid, deps.pushStore, audit),
  );
  ```
- [ ] **Failing test** in `src/server.test.ts`: extend `boot()` to also `await VapidStore.open(join(dir,'vapid.json'))` and `await PushStore.open(join(dir,'push.json'))` and pass them in deps (return them too if convenient). New test: mint a `session:read` token via a code, redeem, then `GET /rc/push/vapid` → 200 with `applicationServerKey`; `POST /rc/push/subscribe {subscription:{endpoint:'https://x/1',keys:{p256dh:'p',auth:'a'}}}` with bearer → 201; `GET /rc/push/subscriptions` → 200 list length 1. Also: a `redeem` with no scopes... (skip — minting empty scopes; instead) assert a token whose scopes lack `session:read` gets 403 on `GET /rc/push/vapid` (mint `[OWNER]`-only? OWNER lacks session:read → but OWNER is for tokens; mint `[]`? PairingService.mint takes scopes; mint `['owner']` only and hit /rc/push/vapid → 403 since session:read absent).
- [ ] Run server test → was failing (routes not wired / boot lacked stores) → now PASSES.
- [ ] Commit: `feat(rc-gateway): wire push routes into gateway`.

### Task 6: CLI wiring

**Files:** Modify `src/cli.ts`.

- [ ] `import { VapidStore } from './webpush/vapid.js'; import { PushStore } from './pushStore.js';`
- [ ] In `runServe`, after opening `store`, `const vapid = await VapidStore.open(join(homedir(),'.qwen','rc','vapid.json')); const pushStore = await PushStore.open(join(homedir(),'.qwen','rc','push-subscriptions.json'));` and pass `vapid, pushStore` into `createGatewayApp`.
- [ ] Add a banner line: `` `webpush: enabled (key ${vapid.getApplicationServerKey().slice(0,8)}…)` `` placed after the web-viewer line.
- [ ] `npm run typecheck && npm run build --workspace @qwen-code/rc-gateway` → pass.
- [ ] Commit: `feat(rc-gateway): boot VAPID + push store in CLI`.

### Task 7: e2e + full verification

**Files:** Modify `scripts/rc-gateway-e2e.mjs`.

- [ ] Add checks using the boot owner token: `GET /rc/push/vapid` → 200 with `applicationServerKey`; `POST /rc/push/subscribe` synthetic sub → 201 capture id; `GET /rc/push/subscriptions` includes it; `DELETE /rc/push/subscriptions/<id>` → 204. Bump the script's check count/summary.
- [ ] Run ALL: `npm run typecheck --workspace @qwen-code/rc-gateway && npm run lint --workspace @qwen-code/rc-gateway && npm run build --workspace @qwen-code/rc-gateway && npm run test --workspace @qwen-code/rc-gateway` → green.
- [ ] Run `node scripts/rc-gateway-e2e.mjs` → all checks pass.
- [ ] Commit: `test(rc-gateway): e2e webpush subscription checks`.

## Self-review checklist

- VAPID private key never returned by a route, never logged/audited; `vapid.json` mode 0600.
- `push-subscriptions.json` mode 0600; `add` de-dups by (tokenId,endpoint); persist awaited.
- Audit entries for push_subscribed/push_unsubscribed contain subscriptionId, NEVER the endpoint (test asserts).
- `?all=true` and cross-token delete require `owner`; non-owner sees 404 (not 403) for others' ids.
- Push routes mounted only when both stores present; existing tests still green.
- `AUDIT_ACTIONS` includes both new actions; license headers on new files; zero files changed outside `packages/rc-gateway/` except the e2e script and package.json/lock (deps).
