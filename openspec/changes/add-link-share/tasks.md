# tasks — add-link-share

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify `add-remote-control` Phase 2 (pairing, scopes, audit) > is `completed`. Confirm the `tokens` table schema in > `packages/cli/src/serve/remoteControl/schema/` is reachable > and additive migrations are wired through the migrator. If > the scope guard from `add-remote-control` hard-codes the four > existing scopes such that adding `share` requires touching > many call sites, note the drift here and update > `add-remote-control/specs/pairing-auth/spec.md` `Requirement:
Scope hierarchy and enforcement` to enumerate scopes via a > registry. Record `BASELINE_SHA=<sha>` of the qwen-code branch > you build against.

## Phase 1 — Schema and scope

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Check that
    > `add-remote-control` `specs/pairing-auth/spec.md` enumerates
    > scopes in an enum-extensible way. If not, patch the spec
    > delta (with a dated drift note) to permit adding `share`
    > without rewriting other requirements.

- [ ] **1.1 Add `share` scope to enumeration**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/scopes.ts`
  - **Prompt:**
    > Add `share` to the scope enum. Implication graph: `share`
    > implies `read` only; never implies `write`, `approve`, or
    > `owner`. Add a per-token "elevations" set so an operator can
    > mint a `share` with `approve` capability ANDed in (stored
    > as `scopes: ["share", "approve"]` in the tokens row).
    > Update `/capabilities` `supportedScopes` listing.
    > Acceptance: integration test mints a `share`-scope token,
    > verifies it cannot mint pairing codes, cannot list audit,
    > cannot revoke tokens, cannot send prompts.

- [ ] **1.2 Tokens-table migration**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/schema/00X_share.sql`,
    `packages/cli/src/serve/remoteControl/tokenStore.ts`
  - **Prompt:**
    > Add columns `session_lock_id TEXT NULL`,
    > `max_uses INTEGER NULL`, `uses INTEGER NOT NULL DEFAULT 0`,
    > `label TEXT NULL`, `parent_token_id TEXT NULL`. Add
    > `idx_tokens_session_lock`. Add a `share_browser_sessions`
    > table for the `whoami`-driven dedup-cookie tracking
    > (`token_id`, `cookie_hash`, `first_seen`, FK to tokens).
    > Forward-only migration; existing rows are not backfilled.
    > Acceptance: migration tests apply cleanly to an empty DB and
    > to a DB with paired tokens present.

- [ ] **1.3 Session-lock enforcement in scope guard**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Extend the scope guard to consult `session_lock_id` on every
    > route that resolves to a session: `/session/:id/*`,
    > `/permission/:requestId` (resolve to its session first). When
    > the active token has `session_lock_id != null` AND the
    > resolved session id differs, respond `403` code
    > `share_session_mismatch`. Acceptance: scenarios under
    > `Requirement: Share tokens are session-locked`.

## Phase 2 — Share mint, list, revoke

**Effort:** ~2 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Re-read
    > `specs/link-share/spec.md` `Requirement: Share lifecycle`
    > to confirm the create/list/revoke shapes are unchanged. If
    > scope-guard discovery surfaced any blocking issue, patch
    > the delta first.

- [ ] **2.1 Mint route `POST /rc/share`**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/shareRoutes.ts`
  - **Prompt:** > Implement `POST /rc/share { sessionId, scope, ttlSec,
maxUses, label }`. Owner-scope only. Validates sessionId > belongs to the daemon's workspace and exists. Validates > scope is `view` or `approve` (mapping to > `["share"]` or `["share","approve"]` in storage). Clamps > `ttlSec` to [300, 2592000]; clamps `maxUses` to [1, 100]. > Stores `parent_token_id` = the calling token. Generates > `qwk_*`-style token (32 bytes, base64url), persists > argon2id hash, returns `{ id, url, expiresAt, scope,
maxUses, label }`. The `url` is > `https://<daemon-host>/ui/share/<plain-token>`. Acceptance: > integration test mints a share, fetches it via the URL, > confirms scope, confirms 200.

- [ ] **2.2 List + show + revoke routes**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Implement `GET /rc/share[?sessionId=…]` (owner: full list;
    > non-owner with read-on-session-S: only shares for S where
    > the token is owner of the share — restrict carefully).
    > `GET /rc/share/:id` returns metadata (no plaintext token).
    > `DELETE /rc/share/:id` (owner only) sets `revoked_at`,
    > evicts live SSE subscribers within 1 s with
    > `client_evicted` reason `share_revoked`. Acceptance:
    > scenarios under `Requirement: Revoke is immediate`.

- [ ] **2.3 `qwen rc share` CLI**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `packages/cli/src/commands/rc/share.ts`
  - **Prompt:**
    > Subcommands: `create`, `list`, `show`, `revoke`, `watch`.
    > `create` accepts `--scope view|approve`, `--ttl <duration>`
    > (e.g. `1h`, `30m`, `7d`), `--max-uses N`, `--label <name>`,
    > `<sessionId>`. Default `--ttl 1h`, `--scope view`,
    > `--max-uses 5`. If `--ttl > 24h`, print a warning. Print the
    > resulting URL once; do not log it to any history file. On a
    > TTY, also offer `--copy-to-clipboard` (no-op outside TTY).
    > `list` prints a table: id, sessionId, scope, label, uses
    > (n/N), remaining TTL, lastUsedAt. `revoke <id>` mirrors
    > `qwen rc tokens revoke`. `watch` is `list --follow`,
    > redraws every 5 s.

## Phase 3 — URL bootstrap and watermark

**Effort:** ~2 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm the web client's
    > pairing-screen flow from `add-remote-control` Phase 4.2 is
    > intact; share bootstrap is a separate entry point and must
    > not regress pairing.

- [ ] **3.1 `GET /ui/share/<token>` bootstrap page**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/share-bootstrap.html`,
    `packages/web-client/src/share-bootstrap.ts`
  - **Prompt:** > Daemon serves this static HTML for any `/ui/share/<rest>` > path. The HTML's inline JS: > > 1. Reads `<rest>` from `location.pathname`. > 2. Validates shape (`qwk_…`, length, regex). > 3. `sessionStorage.setItem("qwen-rc:" + location.host +
":share-token", token)`. > 4. `history.replaceState({}, '', '/ui/')`. > 5. Dynamically imports the main web client bundle. > The path validation must reject obvious junk before storage > (so a typo'd URL doesn't poison state). Acceptance: tests > that the address bar after load shows `/ui/` and that > `sessionStorage` contains the token; that > `localStorage` is untouched.

- [ ] **3.2 `GET /rc/share/whoami` endpoint**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Endpoint accepts the share token via `Authorization:
Bearer`. On valid: returns `{ shareId, sessionId, scope,
sharedByTokenName, label, expiresAt, usesRemaining }`. Sets > a `Secure HttpOnly SameSite=Strict` cookie named > `qwen-rc-share-session` with an opaque hashed-cookie value; > if no cookie present, atomically bumps `uses` (SQL UPDATE > guarded by `uses < max_uses`); if rowcount 0, return `410
Gone` with code `share_exhausted`. If cookie present and > matches a stored hash for this token, do NOT bump uses; > respond 200. Audit each first-use. Acceptance: scenario > "max_uses race is atomic" and "refresh-same-tab does not > bump uses".

- [ ] **3.3 Watermark banner in web client**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/components/Watermark.tsx`
    (or `.ts` if no JSX)
  - **Prompt:**
    > When the active token's `whoami` shows scope `share`, render
    > a non-dismissable banner at the top of the chat surface with
    > label, scope, uses remaining, expiry countdown, and sharedBy
    > token name. Banner is sticky; cannot be hidden by CSS the
    > guest can reach. Update the chat input + approve/deny UI
    > controls to mask based on the scope (prompt input hidden
    > for `view`; approve buttons hidden for `view`; both hidden
    > for `view` if user is on someone else's permission_request
    > that they can't act on).

- [ ] **3.4 Owner's view of active shares**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > When an owner-scope client attaches to a session, fetch
    > `GET /rc/share?sessionId=<sid>` and render a "Live shares"
    > strip above the watermark area (empty if none). Each row
    > has revoke button. Subscribe to `share_created` /
    > `share_revoked` SSE events to keep the strip live.

## Phase 4 — Audit integration and ops

**Effort:** ~1 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Ensure
    > `add-remote-control`'s audit writer can accept new fields
    > without breaking older log readers.

- [ ] **4.1 Audit fields + filter**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Audit writer adds `share_id` (nullable) and `share_label`
    > (nullable). Populated for every request authenticated by a
    > share token, and for every share lifecycle action
    > (`share.create`, `share.use`, `share.revoke`,
    > `share.exhausted`, `share.expired`). The
    > `audit_event` SSE frame mirrors both. `GET /rc/audit`
    > supports `?shareId=<id>` filter (owner only).

- [ ] **4.2 SSE lifecycle events**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Emit `share_created`, `share_used` (first-use only),
    > `share_revoked`, `share_exhausted`, `share_expired` to all
    > subscribers of the affected session who have at least `read`
    > scope. Owners on any session of the workspace receive
    > `share_created` and `share_revoked` daemon-wide.

- [ ] **4.3 Operator docs**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `docs/users/remote-control.md` (append)
  - **Prompt:**
    > New "Sharing a session with a guest" section covering the
    > CLI, watermark, defaults, when to use share vs pair, how to
    > redact `ui/share` from reverse-proxy logs (Caddy and Nginx
    > snippets), and the threat model summary.

- [ ] **4.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Run `openspec archive add-link-share` once Phases 0–4 are
    > `completed`.

## Effort summary

| Phase     | Description                | Estimate (days) |
| --------- | -------------------------- | --------------- |
| 0         | Foundation                 | 0.5             |
| 1         | Schema + scope             | 1.5             |
| 2         | Mint / list / revoke + CLI | 2               |
| 3         | URL bootstrap + watermark  | 2               |
| 4         | Audit + ops + archive      | 1               |
| **Total** |                            | **7**           |
