# Remote-Control Gateway — WebPush Part 4: Inline Approve/Deny (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 12)
**Scope:** Let the service worker post an approve/deny vote **directly from the
notification's action buttons** — proposal story N3 ("approve from the lock
screen"). Finishes the interactive half of `add-webpush-notifications`. Builds on
cycles 8–11.

## Verification caveat

Same as cycle 11: the SW voting path is browser code, **verified-locally-only**.
The one server-side change (the payload gains `approveOptionId`) IS unit-tested.

## The problem this closes

Cycle 11's notification shows Approve/Deny buttons but every click just opens the
app. To vote without opening the app, the SW needs two things it lacked:

1. **An option id to approve with.** The cycle-6 vote route needs
   `{outcome:'selected', optionId}` for approve (deny = `{outcome:'cancelled'}`
   needs none). The metadata-only payload didn't carry any option id.
2. **A bearer token.** SWs can't read `localStorage`. Cycle 11 already mirrors the
   token into IndexedDB (`qwen-rc`/`auth`/`token`) — the SW now reads it.

## Decisions

1. **Payload carries `approveOptionId`** = the **first** option's id
   (`data.options?.[0]?.optionId`), if present. This is a heuristic (the daemon's
   first permission option is conventionally the proceed/allow choice). It stays
   metadata-only (an opaque id, no args). If absent, the SW falls back to opening
   the app for approve.
2. **SW votes inline on action clicks; falls back to open-app.** `approve` →
   POST `{outcome:'selected', optionId: approveOptionId}` (only if both token and
   approveOptionId are available; else open app). `deny` →
   POST `{outcome:'cancelled'}` (only needs a token; else open app). Any non-action
   click (notification body) → open app (unchanged). After a successful vote, the
   SW shows a brief confirmation notification ("Approved"/"Denied") and does NOT
   open a window.
3. **Best-effort, never throws.** Token read, fetch, and JSON are all guarded; on
   any failure the SW falls back to opening the app at the deep link.
4. **No new audit / no new route.** Votes hit the existing cycle-6
   `POST /rc/session/:id/permission/:requestId`, which already audits
   `permission_voted`. Server-side change is limited to `payload.ts`.

## Components

### `payload.ts` — add `approveOptionId`

- Add `approveOptionId?: string` to `PushPayload` (documented: opaque option id,
  not sensitive).
- In the `permission_request` branch, read `const options = data.options as
Array<{ optionId?: unknown }> | undefined;` and
  `const approveOptionId = str(options?.[0]?.optionId);` then include
  `...(approveOptionId ? { approveOptionId } : {})` in the returned payload.

### `public/sw.js` — carry id into notification data + vote on click

- In the `push` handler, add `approveOptionId: p.approveOptionId` to the
  notification's `data` object.
- Add helpers:
  - `idbGetToken()` → Promise<string|undefined>: open `qwen-rc` DB, read
    `auth`/`token`; resolve undefined on any error (best-effort).
  - `postVote(sessionId, requestId, body, token)` → Promise<Response|undefined>:
    `fetch('/rc/session/'+enc(sessionId)+'/permission/'+enc(requestId), {method:'POST',
headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},
body: JSON.stringify(body)})`; catch → undefined.
  - `confirmNote(text)` → `self.registration.showNotification(text, { tag:
requestId, ... })` for the brief confirmation.
- Rewrite `notificationclick`:
  ```js
  const d = event.notification.data || {};
  const isVote = event.action === 'approve' || event.action === 'deny';
  if (isVote && d.requestId && d.sessionId) {
    event.waitUntil(
      (async () => {
        const token = await idbGetToken();
        const body =
          event.action === 'approve'
            ? d.approveOptionId
              ? { outcome: 'selected', optionId: d.approveOptionId }
              : null
            : { outcome: 'cancelled' };
        if (token && body) {
          const res = await postVote(d.sessionId, d.requestId, body, token);
          if (res && res.ok) {
            await confirmNote(
              event.action === 'approve' ? 'Approved' : 'Denied',
            );
            return;
          }
          if (res && res.status === 404) {
            await confirmNote('Already resolved');
            return;
          }
        }
        // fall through: open the app so the user can act manually
        await openApp(d.url || '/ui/');
      })(),
    );
    return;
  }
  event.waitUntil(openApp(d.url || '/ui/'));
  ```
  where `openApp(url)` is the existing matchAll/focus/openWindow logic factored
  into a helper.

## Testing strategy

**`payload.test.ts` (extend):** a `permission_request` with
`data.options:[{optionId:'opt-allow'},{optionId:'opt-deny'}]` → payload
`approveOptionId === 'opt-allow'`; with no `options` → `approveOptionId` absent;
still no tool args/paths leak (the option id is opaque — assert a planted secret
arg still absent).

**`sw.js`:** `node --check` passes; lint-clean (`/* global self */` already present
— ensure any new globals like `fetch`, `Response`, `indexedDB` are covered: add
them to the `/* global */` comment). The vote logic is reviewed, not auto-run
(verified-locally-only).

**Manual (verified-locally-only):** real browser — trigger a real permission
request, receive the push, tap Approve on the notification → the daemon resolves
the request (visible in the open viewer / audit `permission_voted`), no window
opens; tap Deny → cancelled.

## File boundary

All within `packages/rc-gateway/`. Modified: `src/webpush/payload.ts`,
`src/webpush/payload.test.ts`, `public/sw.js`. No new deps, no new routes, zero
upstream edits.

## Follow-on

`add-webpush-notifications` is then complete except the deliberately-deferred
**prefs / quiet-hours / rate-limit / coalescing** (proposal Phase 2.4) — an
optional later cycle. Next proposal per the backlog: **add-policy-engine** (the
gateway auto-votes permission requests it already sees on the pumped SSE events,
using rules — no daemon edit).
