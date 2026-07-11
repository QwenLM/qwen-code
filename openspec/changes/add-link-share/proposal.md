# add-link-share

## Why

`add-remote-control` paired clients are great for devices the owner
controls long-term: their own laptop, their own phone, a teammate's
machine. Real collaborator workflows want a much shorter-lived,
lower-friction handoff:

- "Look at what the agent is about to do — approve it from your
  browser, no install."
- "Read along while I drive; tell me what you think in chat."
- "Watch this PR rollout for the next hour while I'm in a meeting."

Pairing a long-lived per-client token (30-day expiry, full workspace
access, manual revoke later) is overkill for these. Operators want a
**time-bounded shareable URL** that grants exactly one session's
worth of access, expires on its own, and can be revoked individually
without disturbing other paired devices.

This change adds that: a guest-link share flow that produces a URL
the operator can paste into Slack/DM/whatever, scoped to **one
session** with **one scope** (view-only or view+approve), bounded by
**TTL** and **max uses**, and revocable from the owner's CLI or web
client. It deliberately preserves the single-owner-per-daemon model
from `add-remote-control` D6 — guests are second-class by design.

## What Changes

- **New CLI subcommand `qwen rc share`.** Five operations:
  `create`, `list`, `revoke`, `show`, `watch`. `create` returns a URL
  like `https://daemon/ui/share/<opaque-token>`. The URL is the
  authentication — it is the credential.
- **Session-locked pairing variant.** Under the hood, share links
  are a new pairing-code shape that produces a `share` scope token
  with two extra constraints stored in `tokens.db`:
  `session_lock_id` (one specific session id, not the workspace),
  and `max_uses` / `uses` counters.
- **`share` scope.** New scope that implies `read` only by default;
  the operator can elevate to `approve` at create time. `share`
  never implies `write` (cannot send prompts) and never implies
  `owner`.
- **URL-as-credential redirect dance.** `GET /ui/share/<token>`
  returns a tiny bootstrap HTML page that immediately:
  1. Reads the token from the URL.
  2. Stores it in `sessionStorage` (NOT `localStorage`) under a
     share-namespaced key.
  3. Replaces the URL via `history.replaceState` to remove the token
     from the address bar before any other navigation happens.
  4. Loads the normal web client shell, which now sends the token
     in the `Authorization` header.
     Subsequent requests never carry the token in the URL.
- **Share-token watermark in the web client.** Every share-token
  session displays a banner showing `Shared: <label> · expires in
47m · 3 of 5 uses` so the owner (or anyone else watching) can see
  what guest access is live.
- **Audit visibility.** Every share-link creation, redemption, and
  every action by a share-token holder is audited with the share
  label and the parent owner's token id, so post-incident analysis
  ties guest actions back to who created the link.
- **List + revoke UX.** `qwen rc share list` shows active shares
  with remaining uses, time left, label, and last-use timestamp.
  `qwen rc share revoke <id>` kicks any live subscribers and 401s
  further requests; mirrors the existing per-token revoke flow.

## Capabilities

### New Capabilities

- `link-share` — session-locked guest-access tokens with TTL and
  max-uses bounds, the URL-as-credential bootstrap protocol, audit
  visibility, and revocation UX.

## User Stories

**L1. Quick approval handoff.** Owner is about to step away. They
run `qwen rc share <sessionId> --scope approve --ttl 1h --label
oncall-bob`. The daemon prints a URL. Owner pastes it to Bob in DM.
Bob clicks; his browser opens the web client; he can see the
transcript and approve/deny tool calls for the next hour. The
shareable URL never re-appears in his address bar after the first
click.

**L2. Read-only review.** Owner shares a debugging session with a
colleague: `qwen rc share <sessionId> --scope view --ttl 2h --label
review-jess --max-uses 1`. Single-use, view-only. Once Jess opens
it, the second attempt to use the same URL 401s with
`share_exhausted`.

**L3. Live revoke.** Owner realizes they shared a session that
included a private file path. From any owner-scope client, they run
`qwen rc share list` to find the share id, then `qwen rc share
revoke sh_abc123`. The colleague's open tab gets a `client_evicted`
frame within 1 s and 401s on the next refetch.

**L4. Auditing guest activity.** The next morning the operator runs
`qwen rc audit --share-id sh_abc123` and sees the four prompts the
guest viewed and the one approve they pressed, with the original
share label in every line.

**L5. Watermark visible to others.** The owner's own web client
shows the share watermark in the session header: `Shared:
oncall-bob (approve) · 3 of 5 uses · expires 18:42`. They can click
the watermark to revoke immediately.

## Impact

- **qwen-code repo**: extends the pairing system from
  `add-remote-control` with the `share` scope and `session_lock_id`
  - `max_uses` token-store columns. New routes:
    `POST /rc/share` (mint), `GET /rc/share` (list),
    `DELETE /rc/share/:id` (revoke), `GET /ui/share/<token>`
    (bootstrap page).
- **Web client**: adds the bootstrap page, the watermark banner, and
  filters destructive UI (prompt input, end-session button) when the
  active token has `share` scope.
- **Audit**: new column `share_id` populated for actions taken under
  a share token; `audit_event` SSE frames surface it.
- **No daemon-side coupling to bridges, search, or forking** — this
  change is intentionally independent of the other three changes in
  this batch.
- **Out of scope** (deliberately):
  - Anonymous links (no token in URL at all). The URL is the
    credential; that's the whole UX.
  - Per-message visibility controls (guest sees X but not Y). One
    session = one transcript; partial-view would require either
    re-rendering history or a redaction layer we don't have.
  - Per-share E2E encryption. The daemon and operator are still
    trusted; this only constrains who else can reach the session.
  - Cross-daemon sharing (the URL works only against the daemon
    that minted it). Multi-daemon UX is in `add-multi-workspace-
client`.
  - Federation: a share link minted on daemon A cannot be used
    against daemon B even with the same operator. By construction.
