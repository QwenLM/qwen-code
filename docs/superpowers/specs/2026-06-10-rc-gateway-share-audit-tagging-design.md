# Cycle 31 — Link-share L4: `share_id`/`share_label` audit tagging + `--share-id` filter — design

## Context

`add-link-share` story **L4** (proposal.md:96): the morning after a guest
session, the operator runs `qwen rc audit --share-id sh_abc123` and sees
"the four prompts the guest viewed and the one approve they pressed, **with
the original share label in every line**." design.md:226 specifies the audit
log gains nullable `share_id` and `share_label` fields; existing rows are not
backfilled.

Today every audit row a guest produces already carries
`actorTokenId = req.rcClient.id`, and for a guest **that id IS the share
token's id** (a share is a normal `TokenStore` token). So guest attribution
is already present in the log — what's missing is (a) a query filter that
collects a share's whole lifecycle, and (b) the human-readable **label** on
each row (a share's token record is gone by morning — expired and possibly
evicted — so a query-time join to recover the label fails; it must be
captured at action time).

## Deviation from the proposal

design.md describes SQLite columns + an `audit_event` SSE frame carrying
`share_id`. We deliver the same capability against our JSONL audit log
(`AuditEntry` gains two optional fields) and defer the SSE frame (no
`audit_event` stream exists in the gateway yet — its own slice). No daemon
edit. The `qwen rc audit --share-id` CLI is deferred (no `qwen rc` CLI
exists yet); the gateway exposes the equivalent `GET /rc/audit?shareId=`.

## The bounded set of share-reachable audit producers

A share token carries `[SHARE, session:read, (approve)]` — never `write`.
So a guest can reach exactly:

| Route                            | Scope gate     | Audit actions                                                | actorTokenId set? |
| -------------------------------- | -------------- | ------------------------------------------------------------ | ----------------- |
| `GET /rc/session/:id/events`     | `session:read` | `session_attached`, `session_detached`                       | ✅                |
| `POST .../permission/:requestId` | `approve`      | `permission_voted`                                           | ✅                |
| `GET /rc/push/*`                 | `session:read` | `push_subscribed`, `push_unsubscribed`, `push_prefs_updated` | ✅                |
| `GET /rc/share/whoami`           | `share`        | `share_redeemed`, `share_exhausted`                          | ✅ (= id)         |

`prompt`/`fork`/`command` all require `write` → unreachable by a share.
Owner-only `share_created`/`share_revoked` are produced by the owner (actor =
owner, not the share) but carry `detail.shareId`.

**Also tagged (added after opus review):** the `scope_denied` rows emitted by
the `requireScope` / `enforceSessionLock` middleware in `auth.ts`. A guest can
trip these (a view-only share POSTing a vote → `requireScope(APPROVE)` denial;
a share probing another session → `enforceSessionLock` denial). They run after
`bearerResolve`, so `req.rcClient.shareId/shareLabel` are already set; without
tagging, the `--share-id` filter would surface these (via `actorTokenId`)
unlabeled, breaking the "label in every line" requirement.

## Decisions

- **D1 — `AuditEntry` gains optional `shareId?: string` and
  `shareLabel?: string`.** Top-level (siblings of `actorTokenId`), not buried
  in `detail`, so the read side filters one field. Neither is an
  `AuditAction`, so **no change to the `AuditAction` union / `AUDIT_ACTIONS`
  runtime list.** Old rows simply lack the fields (no backfill, per design).

- **D2 — `AuditQuery.shareId` filters a UNION of three sources:**

  ```
  r.shareId === q.shareId
    || r.actorTokenId === q.shareId
    || (typeof r.detail?.shareId === 'string' && r.detail.shareId === q.shareId)
  ```
  - `shareId` clause: new guest + lifecycle rows that set it explicitly.
  - `actorTokenId` clause: every guest row already written (historical) — a
    guest's actor id IS the share id. Makes the filter work the instant it
    ships, before any producer is touched.
  - `detail.shareId` clause: the `share_created`/`share_revoked` rows already
    in the log (actor = owner, so neither of the first two clauses catches
    them). The `typeof` guard reads `unknown` detail without tripping
    `no-explicit-any`.

- **D3 — `shareLabel` is captured at action time on every line that can
  appear in a `--share-id` result set.** The label is denormalized because
  the proposal requires it "in every line" and the token record is gone by
  query time:
  - Lifecycle rows that already hold the label locally: `share_created`
    (`label`), `share_revoked` (`rec.label`), `share_redeemed`/`share_exhausted`
    (`info.label`) → stamped from local vars, **no auth-path touch.**
  - Guest view/approve/push rows: the label comes from an enriched
    `req.rcClient.shareLabel` (see D4).

- **D4 — `req.rcClient` is enriched with `shareId`/`shareLabel` when the
  resolved token is a share.** `TokenStore.resolve()` already returns
  `sessionLockId` — the share discriminator (every share has one via
  `issueShare`; paired/owner tokens never do). resolve() additionally
  returns the record's `label` as `shareLabel`. `bearerResolve` sets
  `rcClient.shareId = resolved.id` and `rcClient.shareLabel = resolved.shareLabel`
  **only when `resolved.sessionLockId !== undefined`.** Both additions are
  purely additive — the auth DECISION (which tokens resolve, the expiry
  check) is unchanged. This is the only hot-path edit, so it lands LAST.

- **D5 — Top-level `shareId` is also set on guest + lifecycle rows** (not just
  relied-on via `actorTokenId`), matching the named deliverable "`share_id`
  column populated for actions taken under a share token." It is free
  (`rcClient.shareId` / local id). The `actorTokenId`/`detail.shareId` union
  clauses remain for historical rows + robustness if a route is ever missed.

- **D6 — `--share-id <non-share-token-id>` degrades to `--actor` for that
  id.** A harmless, documented consequence of the `actorTokenId` union
  clause; the route is `OWNER`-gated so only the operator can do it. Not a
  leak.

## Implementation & commit order (fail-safe: inert → additive → hot-path last)

1. **Docs** (this spec + plan).
2. **INERT/functional — schema + read side, no producers:**
   `auditLog.ts`: add `shareId?`/`shareLabel?` to `AuditEntry`;
   add `shareId?` to `AuditQuery`; add the D2 union filter to
   `AuditLog.query`. `routes/audit.ts`: parse `?shareId=` (non-empty string).
   Ships working immediately — catches all existing guest/lifecycle rows.
3. **Lifecycle-row tagging (no auth touch):** `routes/share.ts` —
   `share_created`/`share_revoked` set `shareId` + `shareLabel` from local
   vars (`share_revoked` reads `rec.label` from the `listShares().find`);
   whoami `share_redeemed`/`share_exhausted` set `shareId: id` +
   `shareLabel: info.label`.
4. **WIRE auth (hot path, last):** `tokenStore.resolve()` returns
   `shareLabel?` (the matched record's `label` when it is a share);
   `types.ts` `rcClient` gains `shareId?`/`shareLabel?`; `auth.ts`
   `bearerResolve` enriches when `sessionLockId !== undefined`; stamp
   `shareId`/`shareLabel` from `req.rcClient` on the guest rows
   (`session_attached`/`session_detached`, `permission_voted`,
   `push_subscribed`/`push_unsubscribed`/`push_prefs_updated`).

## Audit privacy

`shareId` is a token id (already logged as `actorTokenId`/`target`).
`shareLabel` is the operator-chosen label string (e.g. "review for Sam") —
already returned by `listShares()`/whoami and logged in `share_created`
detail today. No new secret class. No raw token/endpoint/transcript.

## Deferred (not this cycle)

- `audit_event` SSE frame carrying `share_id` (no audit SSE stream exists).
- `qwen rc audit --share-id` CLI (no `qwen rc` CLI exists).
- `/ui/share/<token>` bootstrap page + watermark + hide-write-UI (browser).
- Server-stored share-session redemption marker (replaces the cookie dedup's
  documented parallel-first-load over-count limitation).

## Verification

`typecheck/lint/build/test --workspace @qwen-code/rc-gateway` +
`node scripts/rc-gateway-e2e.mjs`. New unit tests: query `shareId` matches
top-level / `actorTokenId` / `detail.shareId` rows and excludes others;
audit route parses `?shareId=`; `share_created`/`whoami` rows carry
`shareId`+`shareLabel`; resolve() returns `shareLabel` for a share and not
for a normal token; bearerResolve enriches rcClient only for shares;
sessionEvents/permission rows carry the share label end-to-end (capturing
fake daemon / share token). e2e unaffected (no share mint in its path).
