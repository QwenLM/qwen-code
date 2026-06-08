# RC Gateway — WebPush Part 3: Service Worker + Enrollment (Cycle 11)

> **For agentic workers:** Browser-code cycle (verified-locally-only). `- [ ]` steps. All work inside `packages/rc-gateway/`. ZERO edits outside it.

**Goal:** Ship `public/sw.js` (push display + click-opens-app) and an "Enable notifications" enrollment flow in `public/index.html`, mirroring the token into IndexedDB for cycle-12 inline voting.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-webpush-serviceworker-design.md` — contains the full `sw.js` source and the enrollment-handler steps. Implement them as written.

**Verification reality:** browser delivery can't run in WSL. We verify (a) the gateway serves `/ui/sw.js`, (b) `sw.js` passes `node --check`, (c) index.html contains the enrollment wiring. The rest is manual/verified-locally-only.

**Conventions:** `public/*` are static assets (not tsc/eslint). Commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; prettier pre-commit may reformat the HTML/JS — fine.

---

### Task 1: service worker asset

**Files:** Create `packages/rc-gateway/public/sw.js`.

- [ ] Write `sw.js` exactly per the design's Service-worker section (install/activate/push/notificationclick). No secrets; click opens/focuses the deep link.
- [ ] `node --check packages/rc-gateway/public/sw.js` → no syntax error.
- [ ] Commit: `feat(rc-gateway): push service worker (display + open)`.

### Task 2: serve-asset test (TDD-ish)

**Files:** `src/server.test.ts`.

- [ ] Add a test: boot, `GET /ui/sw.js` → 200 and content-type matches `/javascript/`. (No bearer needed — `/ui` is the public static mount, served before `bearerResolve`.)
- [ ] Run it → PASSES (the file exists from Task 1; this just locks in that it's served).
- [ ] Commit: `test(rc-gateway): assert /ui/sw.js is served`.

### Task 3: enrollment + IndexedDB token mirror

**Files:** `public/index.html`.

- [ ] Add the `urlBase64ToUint8Array` helper and `idbPutToken(token)` (best-effort, try/catch) per the design.
- [ ] Call `idbPutToken(data.token)` immediately after the existing `localStorage.setItem(TOKEN_KEY, data.token)` in the pair handler.
- [ ] Add an "Enable notifications" `<section>`/button (`id="enable"`) and the `enableNotifications()` handler per the design's 6 steps (guard → register `/ui/sw.js` → requestPermission → fetch `/rc/push/vapid` → `pushManager.subscribe` → POST `/rc/push/subscribe`; also `idbPutToken(token())`). Surface every outcome via `setStatus(...)`; never throw uncaught.
- [ ] `node --check` won't parse HTML — instead manually re-read the `<script>` block to confirm it's syntactically balanced; rely on the Task-2 test + opus review for wiring. Optionally extract nothing (keep inline).
- [ ] Commit: `feat(rc-gateway): enable-notifications enrollment + idb token`.

### Task 4: index-content test + full verification

**Files:** `src/server.test.ts`.

- [ ] Add a test: `GET /ui/index.html` → 200 and body contains both `id="enable"` and `sw.js` (sanity that enrollment + SW reference shipped).
- [ ] Run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green. (lint only covers src/, not public/.) Then `node --check public/sw.js`. The e2e script is unchanged unless trivial to add a `/ui/sw.js` 200 check — add it if quick.
- [ ] Commit: `test(rc-gateway): assert enrollment UI shipped`.

## Self-review checklist

- `sw.js` references no token/secret; push handler ignores `v !== 1`; body truncated ≤140.
- enrollment: every failure path shows a status; IndexedDB/absence never breaks pairing (try/catch).
- `/ui/sw.js` served with a JS content-type (test asserts); `/ui/` index contains enrollment wiring (test asserts).
- Cycle 11 does NOT post votes from the SW (that's cycle 12) — clicks only open the app.
- Browser delivery explicitly recorded as verified-locally-only (manual), not claimed as automated.
- Zero files outside `packages/rc-gateway/`.
