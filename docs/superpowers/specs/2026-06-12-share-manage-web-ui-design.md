# Cycle 66 — Share list/revoke web UI (`GET`/`DELETE /rc/share`)

Proposal: `add-link-share` (story L3 revoke). The owner can now CREATE shares
(cycle 64); this adds listing + revoking existing ones, mirroring the cycle-56
token-management UI. Closes the share-management loop in the owner console.

## Deviation note

Gateway UI; consumes the existing owner-gated `GET /rc/share` (-> `{shares:
ShareInfo[]}`) and `DELETE /rc/share/:id` (204 / 404 share_not_found, evicts
live streams). No daemon change.

## ShareInfo (read from source)

`{id, label, scopes, sessionLockId, expiresAt?, createdAt, expired, maxUses?,
uses?, usesRemaining?}` — no token/secret material. `scope` is derived: contains
`approve` -> "approve", else "view".

## What it adds

A "Manage shares" `<section>`: a "List shares" button -> `GET /rc/share` ->
one `.token-row` per share (built createElement + textContent, mirroring
revokeToken): `label  [scope]  session=<sessionLockId>  uses=<n/max or n>
<expired?>  <id>` + a Revoke button -> `DELETE /rc/share/:id` (204 -> row ->
"revoked: <id>"; 404 -> "already gone").

## Decisions

1. Mirror cycle-56 `revokeToken` exactly (disable-sync-before-await, row
   collapse on success, 404/other handled, re-enable on error).
2. Render `usesRemaining`/`maxUses` and an `(expired)` marker so a stale share
   is visible. No token value is ever present in ShareInfo.
3. textContent/createElement only; additive section (new ids `list-shares`/
   `shares-list`), touches no existing handler. No src change.

## Verification

Playwright in-session (OWNER): create a share (cycle 64) -> List shares -> the
share renders (label, session, usesRemaining, id; NO token) -> Revoke -> row
"revoked: <id>" (DELETE 204) -> re-List -> gone. lint/build/test unchanged,
e2e 45/45.

## Deferred

Filtering; bulk revoke; showing the share URL again (the token is not in
ShareInfo by design — re-create to get a new link); a copy button.
