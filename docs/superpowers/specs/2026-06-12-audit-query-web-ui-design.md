# Cycle 55 — Audit-log history/query web UI (`/rc/audit` consumer)

Proposal: `add-policy-engine` Phase 4 / `add-notification-routing` R6 —
the HISTORICAL, filterable complement to cycle 54's live `/rc/events`
stream. This is the deferred "replay path": cycle 49/54 left
`Last-Event-ID` replay to `/rc/audit` (the durable record), and this UI
is the browser front for it.

## What it adds

A self-contained "Audit log" section in `public/index.html`: an `action`
filter (a `<select>` populated from the known audit actions) + a `limit`
input + a "Query" button, rendering `GET /rc/audit` results newest-first
into a dedicated `<pre>`. OWNER-scoped (the route is behind
`requireScope(OWNER)`).

## Route interface (primary-source, audit.ts)

`GET /rc/audit?limit&since&action&actor&shareId` → a newest-first JSON
ARRAY of audit records `{ts, action, actorTokenId?, target?, detail?}`.
This UI uses `action` (exact match against `AUDIT_ACTIONS`) and `limit`;
`actor`/`shareId`/`since` are deferred.

## Feasibility

Works with the EXISTING `/tmp` UI harness unchanged — audit records
already exist from pairing + token minting, no daemon/push/chats setup
needed (unlike a fork-tree or push-prefs UI). Reuses the same
fetch-with-Bearer + `localStorage` token the rest of the client uses.

## Decisions

1. **Self-contained section + handler.** New ids
   (`audit-action`/`audit-limit`/`audit-query`/`audit`) and a new global;
   touches no existing handler (HTML inert-first — a mid-cut leaves the
   UI working).
2. **Inline record rendering, not a shared helper.** Same one-line
   `ts action by= target= detail` format as cycle 54, inlined again
   rather than refactoring the committed cycle-54 handler into a shared
   function — keeps this cycle's diff additive and the cut safe. The
   minor duplication matches the file's established all-inline style.
3. **`textContent`-only render (XSS-safe).** Server-controlled audit
   fields are concatenated into a string and assigned via `textContent`,
   exactly like cycle 54 — no `innerHTML` anywhere.
4. **Action `<select>` from the known set.** A fixed option list (the
   `AUDIT_ACTIONS` the operator cares about) + an "(any)" default; an
   unknown/empty action is simply omitted from the query (the route
   ignores a non-matching `action`). Read-only; no new route/audit.

## Verification

Playwright in-session against the `/tmp` harness: pair OWNER → mint a few
tokens (generates `token_minted`/`pairing_redeemed` records) → set the
action filter to `token_minted`, Query → assert only `token_minted` rows
render and a different action (e.g. `pairing_redeemed`) is absent;
default "(any)" → assert mixed actions appear. Plus lint/build/test
unchanged (no `src` change), e2e 45/45.

## Deferred

`actor`/`shareId`/`since` filters, paging/“load more”, CSV export, a
combined live+history view, styling — all later/optional.
