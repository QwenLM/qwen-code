# Remote-Control Gateway — WebPush Part 3: Service Worker + Enrollment (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 11)
**Scope:** The browser half of WebPush — a service worker that shows push
notifications and opens the app on click, plus the web-client "Enable
notifications" enrollment flow. **Part 3 of `add-webpush-notifications`.** Builds on
cycles 8–10 (VAPID + subscriptions + sender + pump are all done server-side).

## Verification caveat (important)

This cycle is almost entirely browser code (`public/sw.js`, `public/index.html`).
**It cannot be end-to-end verified in headless WSL** — there is no real browser,
service-worker runtime, or push service. So:

- Gateway-served-asset wiring IS tested (the gateway serves `/ui/sw.js` with a
  JS content-type).
- `sw.js` is syntax-checked with `node --check`.
- The SW/enrollment **logic** is reviewed by the opus reviewer reading the code.
- Actual push delivery + SW execution are **verified-locally-only** (manual, in a
  real browser over localhost/HTTPS). This is recorded as a known gap, not a pass.

Operational note: service workers require a secure context — `localhost` works for
local testing; remote phone use needs HTTPS (a tunnel/reverse proxy). Not a code
issue; documented for the operator.

## Decisions

1. **Scope this cycle to display + open + enroll.** The SW shows the notification
   (with Approve/Deny action buttons for `permission.required`) and on click opens
   /focuses the app at the deep link. **Inline voting from the notification
   (posting the approve/deny without opening the app) is deferred to cycle 12**,
   which will amend the payload to carry the approve `optionId` and have the SW POST
   the vote using the token below. (Deny = `{outcome:'cancelled'}` needs no
   optionId; approve needs one the payload doesn't carry yet — hence the deferral.)
2. **Mirror the bearer token into IndexedDB at enrollment / pairing.** Service
   workers cannot read `localStorage`. To make cycle-12 inline voting possible
   without re-plumbing, store the token in IndexedDB (DB `qwen-rc`, store `auth`,
   key `token`) whenever it's set (on pair and on enable-notifications). The SW
   reads it in cycle 12. This cycle just writes it (and the page keeps using
   `localStorage` as today).
3. **Enrollment is explicit, not automatic.** An "Enable notifications" button
   (not auto-prompt on pair) registers the SW, requests `Notification.permission`,
   fetches the VAPID key (`GET /rc/push/vapid`), `pushManager.subscribe({
userVisibleOnly:true, applicationServerKey })`, and POSTs the subscription to
   `/rc/push/subscribe`. Status is surfaced in the existing `#status` line.
4. **applicationServerKey conversion.** The VAPID public key is base64url; convert
   to a `Uint8Array` for `pushManager.subscribe` via a standard
   `urlBase64ToUint8Array` helper.

## Components

### Service worker (`public/sw.js`) — new static asset

```js
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p;
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    p = {};
  }
  if (p.v !== 1) return;
  const title =
    p.kind === 'permission.required' ? 'Permission needed' : 'qwen-code';
  const actions =
    p.kind === 'permission.required'
      ? [
          { action: 'approve', title: 'Approve' },
          { action: 'deny', title: 'Deny' },
        ]
      : [];
  event.waitUntil(
    self.registration.showNotification(title, {
      body: String(p.summary || '').slice(0, 140),
      tag: p.requestId || p.sessionId || undefined,
      data: {
        url: p.url || '/ui/',
        requestId: p.requestId,
        sessionId: p.sessionId,
        kind: p.kind,
      },
      actions,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  // Cycle 11: every click (incl. action buttons) opens/focuses the app at the
  // deep link. Cycle 12 will POST approve/deny inline for the action buttons.
  const url = d.url || '/ui/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const c of all) {
        if ('focus' in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
```

(No secrets in the SW this cycle; it only displays + opens.)

### Web client (`public/index.html`) — modify

- **IndexedDB token mirror:** add `idbPutToken(token)` (open `qwen-rc` DB v1,
  create object store `auth` in `onupgradeneeded`, `put(token,'token')`). Call it
  right after every `localStorage.setItem(TOKEN_KEY, …)` (in the pair handler and
  the enable-notifications flow). Best-effort (wrap in try/catch; IndexedDB absence
  must not break pairing).
- **Enable-notifications UI:** a new `<section>` with a `<button id="enable">Enable
notifications</button>` and reuse `#status`. Handler `enableNotifications()`:
  1. guard: `token()` set (else "pair first"); `'serviceWorker' in navigator` &&
     `'PushManager' in window` (else "push unsupported").
  2. `const reg = await navigator.serviceWorker.register('/ui/sw.js')`.
  3. `const perm = await Notification.requestPermission()`; if `!== 'granted'` →
     "notifications denied".
  4. `const { applicationServerKey } = await (await fetch('/rc/push/vapid',{headers:
{Authorization:'Bearer '+token()}})).json()`.
  5. `const sub = await reg.pushManager.subscribe({ userVisibleOnly:true,
applicationServerKey: urlBase64ToUint8Array(applicationServerKey) })`.
  6. `await fetch('/rc/push/subscribe',{method:'POST',headers:{'Content-Type':
'application/json',Authorization:'Bearer '+token()},body:JSON.stringify({
subscription: sub.toJSON ? sub.toJSON() : sub })})` → on 201 "notifications
     enabled"; else "enable failed (status)".
  - All wrapped so any step's failure shows a status, never throws uncaught.
- **`urlBase64ToUint8Array(base64url)`** helper (standard impl: pad, replace
  `-_`→`+/`, `atob`, map to Uint8Array).

### Gateway (no code change needed)

`express.static(webRoot)` at `/ui/` already serves any file in `public/`, so
`public/sw.js` is served at `/ui/sw.js` automatically. We only ADD a test asserting
it.

## Testing strategy

**`server.test.ts` (or a small static test):** `GET /ui/sw.js` → 200 and a
JavaScript content-type (`application/javascript` or `text/javascript`). `GET
/ui/index.html` (or `/ui/`) → 200 and the body contains `id="enable"` and
`serviceWorker.register('/ui/sw.js')` (sanity that enrollment wiring shipped).

**Syntax:** `node --check packages/rc-gateway/public/sw.js` passes (add to the
verification run; optionally a tiny vitest that runs it via `child_process`).

**Manual (verified-locally-only, documented not automated):** in a real browser
over localhost — pair, Enable notifications (grant), confirm `GET
/rc/push/subscriptions` lists one entry, run `POST /rc/push/test` (cycle 9) and see
a notification appear; clicking it focuses the app. Recorded as a manual checklist
in the cycle notes; NOT asserted by CI.

## File boundary

All within `packages/rc-gateway/` (+ no e2e script change required, though we may
add a `/ui/sw.js` 200 check). New: `public/sw.js`. Modified: `public/index.html`
(enroll + idb), `src/server.test.ts` (asset tests). No new deps. Zero upstream
edits.

## Follow-on

Cycle 12: inline approve/deny from the notification — amend `payload.ts` to carry
`approveOptionId` (from `data.options?.[0]?.optionId`) for `permission.required`;
SW `notificationclick` for `approve`/`deny` reads the IndexedDB token and POSTs to
`/rc/session/:id/permission/:requestId` (`{outcome:'selected',optionId}` /
`{outcome:'cancelled'}`), falling back to opening the app if no token/optionId.
Then `add-webpush-notifications` is complete except the deliberately-deferred
prefs/quiet-hours/rate-limit/coalescing (a later optional cycle). After that, the
next proposal: `add-policy-engine`.
