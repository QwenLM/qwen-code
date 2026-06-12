# Cycle 80 — Approve/deny from the guest share page

Proposal: `add-link-share`. The guest page `public/share.html` (cycle 62) is a
read-only watch. An `approve`-scoped share (cycle 18: `scope:'approve'` →
`[SHARE, session:read, approve]`, session-locked) already has the RIGHT to vote
on its locked session's permission requests — but the page never offers it. This
cycle adds approve/deny to the guest page, confined to its locked session.

## The backend is the spine (verify + test, not build)

The vote route is ALREADY correct and reachable by an approve-share:
`server.ts` mounts `POST /rc/session/:id/permission/:requestId` under
`requireScope(APPROVE)` + `enforceSessionLock` (NOT owner-gated). So an
approve-share (has APPROVE + a `sessionLockId`) passes the scope gate and is
confined by the lock. The deliverable on the backend is an EXPLICIT server-test
of this path (the stub daemon answers votes, so unlike the frontend it is fully
testable):

- an `approve`-scoped share votes on ITS locked session → 200 (reaches the
  daemon), and
- the same share voting on a DIFFERENT session → 403 `session_locked`
  (`enforceSessionLock` backstop).

(Existing coverage: the route unit test already votes with an approve-share;
server.test already confines a _view_ share on events/prompt. This adds the
missing full-mount approve-share-vote confinement test — the cycle's spine.)

## Frontend (`public/share.html`) — the thin caller

1. **allow_once ONLY** (the security decision). A guest must NOT be able to set a
   standing `allow_always` grant — its effect would outlive the share's TTL/
   revocation and remove future human checkpoints (the cycle-14 escalation, for a
   delegated approver). So the page mirrors the cycle-12 push inline-approve, NOT
   index.html's all-options loop: render ONE **"Approve (once)"** button bound to
   the `options[].kind === 'allow_once'` option, plus **Deny**. If the event has
   no allow_once option → render Deny only + a note ("one-time approval
   unavailable") — fail-safe, NEVER fall back to allow_always.
2. **Gated on `info.scope === 'approve'`** (defense in depth; the backend 403s a
   view share anyway). A view share keeps the read-only page unchanged.
3. **Vote target = the whoami lock** (`info.sessionId`), NEVER client input;
   `enforceSessionLock` is the backstop. Token rides the **Authorization header**
   (not URL/query) — preserves the cycle-62 token-in-URL hygiene.
4. **XSS-safe**: the toolCall renders via `textContent` (mirrors index.html);
   zero innerHTML.
5. **`watch()` dispatch**: the read loop parses each `data:` frame's JSON and
   dispatches on `ev.type` — `permission_request` → render a card,
   `permission_resolved` → resolve it, everything else → `log()` exactly as
   before (non-permission events still log identically).
6. **Conditional watermark** (the advisor's catch): the static "Read-only shared
   view" line is FALSE for an approve share. Show "You can approve or deny
   actions in this session." for `scope === 'approve'`, keep "Read-only…" for
   view.

## Decisions

1. allow_once-only for a guest (see Frontend 1) — the load-bearing security call.
2. Cards live in a new `#cards` container appended above/below the log; entirely
   self-contained in share.html (one file, no backend change).
3. Vote POST mirrors index.html `vote()`: `{outcome:'selected', optionId}` for
   approve, `{outcome:'cancelled'}` for deny, FLAT body to the cycle-6 route
   (which builds the nested SDK shape).

## Fail-safe commit order

docs → server.test spine test (backend already correct; this just pins it) →
share.html approve/deny + conditional watermark.

## Verification

vitest: the spine server-test (approve-share votes locked session → 200; other
session → 403 session_locked). typecheck/lint/build, full suite, e2e 45.
Playwright (in-session, /tmp harness): the guest page for an approve share renders
the approve watermark + is wired; for a view share it stays read-only. **Honesty
ceiling (advisor): the live card-render + vote are NOT stream-verified** — the
stub emits no `permission_request`, so the approve flow is "wired, mirrors the
server-tested backend path", not exercised end-to-end in-harness.

## Deferred

A live-stream playwright proof (needs a daemon emitting permission_request); a
copy-link button + expiry countdown on the page (next link-share UI slice);
prompt-from-share (write — a bigger trust decision).
