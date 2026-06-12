# Cycle 56 — Token-management web UI (`/rc/tokens` list + revoke)

Proposal: `add-remote-control` (the pairing/token-management surface) —
an owner view to see every active token ("paired device") and REVOKE one
(a lost phone, a stale share). First web-UI cycle with a MUTATING action
(DELETE), so it exercises a write path, not just a read.

## What it adds

A self-contained "Tokens" section in `public/index.html`: a "List
tokens" button rendering `GET /rc/tokens` rows into `<div id="tokens">`,
each row showing `label [scopes] id` + a Revoke button that
`DELETE /rc/tokens/:id`. OWNER-scoped (both routes behind
`requireScope(OWNER)`).

## Route interface (primary-source)

- `GET /rc/tokens` → `store.list()` = `TokenInfo[]`
  (`{id, scopes, label, createdAt, ...}`) — NEVER the token value, only
  the id (tokens.ts:16). Safe to render.
- `DELETE /rc/tokens/:id` → `204` on revoke, `404 token_not_found`
  otherwise (tokens.ts:66-78); also evicts the token's open SSE streams.

## Feasibility

Works with the EXISTING `/tmp` harness unchanged — tokens already exist
from pairing + the cycle-54/55 mints. Same fetch-with-Bearer +
`localStorage` token.

## Decisions

1. **DOM rows via `createElement`, not innerHTML.** Rows need a per-row
   Revoke button + handler, so this mirrors the file's existing
   `renderPermissionCard` pattern (createElement + `textContent` per
   node) — NOT string-building HTML. The server-controlled `label`
   (operator-set at mint) and `scopes` go through `textContent`, so a
   `<script>` label renders inert. No `innerHTML` anywhere.
2. **Self-contained.** New ids (`list-tokens`/`tokens`) + a
   `revokeToken` helper; touches no existing handler; shares only the
   read-only `token()`/`$`/`setStatus` helpers.
3. **Revoking the active token is allowed (sign-out-this-device).** The
   client holds the token VALUE, not its id, so it can't reliably
   self-identify a row to disable; revoking the active token simply
   401s subsequent calls (the owner re-pairs) — a legitimate action, not
   a footgun worth special-casing. (The playwright check revokes a
   freshly-minted NON-active token to keep the session alive.)
4. **Read + per-row write only.** No new route/audit — revoke already
   audits `token_revoked` (tokens.ts:74), which now also shows live in
   the cycle-54 events UI and the cycle-55 audit query.

## Verification

Playwright in-session against the `/tmp` harness: pair OWNER → mint a
throwaway token (capture its id from the mint response) → List tokens
(assert the throwaway id appears) → click its Revoke (assert 204 / row
shows "revoked") → List again (assert the id is gone). The active token
is never revoked, so the session survives. lint/build/test unchanged,
e2e 45/45.

## Deferred

Token detail (createdAt formatting, share-vs-normal badges, session-lock
display), confirm-dialog on revoke, "revoke all", auto-refresh — later.
