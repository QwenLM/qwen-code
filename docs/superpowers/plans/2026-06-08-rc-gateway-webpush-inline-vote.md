# RC Gateway — WebPush Part 4: Inline Approve/Deny (Cycle 12)

> **For agentic workers:** `- [ ]` steps. All work inside `packages/rc-gateway/`. ZERO edits outside it. Browser-vote logic is verified-locally-only; the payload change is unit-tested.

**Goal:** Service worker posts approve/deny inline from the notification action buttons (reading the IndexedDB token from cycle 11), and the payload carries `approveOptionId`.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-webpush-inline-vote-design.md` — has the full `sw.js` `notificationclick` logic and helpers. Implement as written.

**Conventions:** commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Run git/npm from repo root `/home/evan/projects/qwen-code`. `public/*` are static assets.

---

### Task 1: payload `approveOptionId` (TDD)

**Files:** `src/webpush/payload.ts`, `src/webpush/payload.test.ts`.

- [ ] Failing test: `permission_request` event with `data.options:[{optionId:'opt-allow'},{optionId:'opt-deny'}]` → built payload `approveOptionId === 'opt-allow'`; event with no `options` → `approveOptionId` undefined/absent; re-assert a planted secret tool-arg in `data` is NOT present anywhere in the payload.
- [ ] Run `-- payload` → FAILS.
- [ ] Implement: add `approveOptionId?: string` to `PushPayload` (doc comment: opaque option id, not sensitive); in the `permission_request` branch read `const options = data.options as Array<{ optionId?: unknown }> | undefined;` and `const approveOptionId = str(options?.[0]?.optionId);`, include `...(approveOptionId ? { approveOptionId } : {})`.
- [ ] Run → PASSES. Commit: `feat(rc-gateway): payload carries approveOptionId for inline vote`.

### Task 2: service worker inline voting

**Files:** `public/sw.js`.

- [ ] In the `push` handler's notification `data`, add `approveOptionId: p.approveOptionId`.
- [ ] Add helpers `idbGetToken()`, `postVote(sessionId, requestId, body, token)`, `confirmNote(text)`, and factor the existing matchAll/focus/openWindow into `openApp(url)`.
- [ ] Rewrite `notificationclick` per the design: action `approve`/`deny` with `requestId`+`sessionId` → read token, build body (approve→`{outcome:'selected',optionId:approveOptionId}` only if approveOptionId present, else null; deny→`{outcome:'cancelled'}`), `postVote`; on `res.ok`→`confirmNote('Approved'/'Denied')`; on 404→`confirmNote('Already resolved')`; otherwise fall through to `openApp`. Non-action clicks → `openApp`.
- [ ] Update the `/* global ... */` header to include every browser global used: `self, fetch, indexedDB` (and any others ESLint flags).
- [ ] `node --check packages/rc-gateway/public/sw.js` → OK; `npx eslint packages/rc-gateway/public/sw.js` → exit 0 (fix globals until clean).
- [ ] Commit: `feat(rc-gateway): service worker inline approve/deny voting`.

### Task 3: full verification

- [ ] From repo root run ALL: `npm run typecheck --workspace @qwen-code/rc-gateway && npm run lint --workspace @qwen-code/rc-gateway && npm run build --workspace @qwen-code/rc-gateway && npm run test --workspace @qwen-code/rc-gateway` → green. Then `node --check packages/rc-gateway/public/sw.js` and `npx eslint packages/rc-gateway/public/sw.js` (exit 0).
- [ ] (e2e unchanged — the vote path is browser-only. Don't touch the e2e script unless trivial.)
- [ ] Commit any remaining test tweaks if not already committed: skip if clean.

## Self-review checklist

- `approveOptionId` is an opaque id only (no args/paths); payload test asserts a planted secret stays absent.
- SW vote is best-effort: token read, fetch, JSON all guarded; any failure → `openApp` fallback (never an uncaught rejection; `event.waitUntil` wraps the async IIFE).
- approve without an `approveOptionId` → falls back to open-app (does NOT post a malformed vote); deny always works with just a token.
- `sw.js` passes `npx eslint` (globals declared) and `node --check`.
- No new route/audit; votes use the existing cycle-6 endpoint. Zero files outside `packages/rc-gateway/`.
