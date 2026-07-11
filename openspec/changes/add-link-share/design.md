# Design — add-link-share

## Context

`add-remote-control` produced a tight pairing model: a single owner
bootstrap, owner-minted per-client codes with default 90-second TTL,
exchanged for `qwk_*` tokens with 30-day sliding expiry. Tokens are
workspace-scoped — any token can attach to any session in the
workspace, subject to scope checks.

That model assumes the recipient is somebody the operator trusts
durably (a personal device, a teammate's machine). It is too heavy
for the very common case of "look at this for an hour." It is also
workspace-scoped, which leaks more than needed when the goal is to
share a single session.

This change adds a parallel flow optimised for ephemeral guests:
URLs that are also credentials, scoped to one session, with TTL +
max-uses + revoke. It explicitly does NOT replace pairing. Pairing
is for devices you keep; share is for people you hand a transient
view to.

The risk shape is fundamentally different from pairing tokens:

- Pairing tokens are in OS-level secret stores; the leak surface is
  "the device got compromised."
- Share URLs are pastable into anything; the leak surface is "the
  link was forwarded / posted to a public channel / sent over an
  unencrypted medium." This is the worst-case threat model and the
  whole design assumes it could happen.

## Goals / Non-Goals

**Goals:**

- One CLI command + paste = working URL.
- The URL is the credential. No additional pairing step.
- Time-bounded and use-count-bounded by default.
- Locked to one session, not the whole workspace.
- Revocable as easily as paired tokens.
- Watermarked in every UI surface so the owner sees what's live.
- Audit-trail attribution: a guest action ties back to (share id,
  owner who minted, label).
- No changes to existing pairing flow or `qwk_*` tokens.

**Non-Goals:**

- Anonymous public sharing (no auth at all). The URL still carries a
  high-entropy token; that's the auth.
- Custom UI for guests (e.g., hiding sidebar, simplified layout).
  Guests get the standard web client with destructive controls
  disabled by scope.
- Sharing across daemons (one share = one daemon). Multi-daemon
  client aggregation is in `add-multi-workspace-client`.
- Pre-rendering / static snapshot of a session for sharing.
  Different problem.
- Replacing pairing with always-share. Pairing remains primary.

## Architecture

```
   Owner-scope client                          Daemon
   ─────────────────                           ──────
   qwen rc share create
       ── POST /rc/share { sessionId, ────►   create row in tokens.db:
            scope, ttl, maxUses, label }       - scope: "share"
                                               - session_lock_id: <sid>
                                               - max_uses: N
                                               - uses: 0
                                               - argon2(token)
                                               - label, expiresAt
       ◄── 200 { id, url, expiresAt }
            url = https://D/ui/share/<plain>

   Owner pastes URL to Bob (Slack/DM/...)

   Bob's browser
   ─────────────
   GET /ui/share/<plain>      ──────────────►  daemon serves a tiny
                                                bootstrap HTML page
                                                (no token validation
                                                here yet; just static
                                                HTML referencing inline
                                                JS that runs in browser)
       ◄── 200 text/html
   bootstrap JS runs:
     - extracts <plain> from URL
     - stores in sessionStorage["qwen-rc:<origin>:share-token"]
     - history.replaceState() → /ui/  (token gone from address bar)
     - loads main web client bundle
   main web client:
     - reads sessionStorage token
     - calls GET /rc/share/whoami (validates + returns metadata)
                                  ─────────────► daemon checks token,
                                                  bumps uses counter
                                                  emits audit + SSE
                                                  audit_event
       ◄── 200 { sessionId, scope, sharedBy, label, expiresAt,
                 usesRemaining }
   web client renders watermark banner and locked-down UI:
     - subscribes /session/<locked-sid>/events
     - prompt input HIDDEN if scope == view
     - approve/deny VISIBLE only if scope == approve
     - session list HIDDEN (locked to one session)
```

## URL-as-credential mechanics

The token-bearing URL appears in exactly one place: the operator's
clipboard before paste, and the guest's first request. Two important
properties:

**Property 1 — token never persists in browser history.** The
bootstrap HTML's inline JS runs synchronously on first load. It
calls `history.replaceState({}, '', '/ui/')` before any other code
executes. The URL the browser commits to history is `/ui/`, not
`/ui/share/<token>`. Future back/forward, bookmarks, and the
address bar all show `/ui/`.

**Property 2 — token never appears in server logs after first
request.** The first GET `/ui/share/<token>` does NOT validate the
token. It serves the same static HTML regardless of what
`<token>` is. Validation happens later via the `Authorization`
header. Therefore daemon access logs see one `/ui/share/<random>`
GET (no auth check, no DB read) and then `/rc/share/whoami` with the
header. The reverse proxy in front MAY log the first URL; operators
are advised to scrub `ui/share` from request logs (documented).

**Property 3 — sessionStorage, not localStorage.** Closing the tab
discards the token. This is deliberate: share tokens are
single-tab-session by default. A guest who wants to come back uses
the original URL again, which then increments the `uses` counter
(rate-limited and bounded by `max_uses`). If `max_uses` is reached,
the URL stops working.

### Why not just an `EventSource` query token

Browser EventSource can't set custom headers, which historically
pushed people to `?token=…`. `add-remote-control` D5 already
rejected that for paired tokens; the bootstrap+fetch-SSE solution is
in place. Share tokens inherit it. Same fetch-based SSE reader; same
header.

## Token lifecycle

```
   minted  ──▶ active (uses < max_uses, now < expiresAt, not revoked)
                  │
                  ├── used: increments uses; emits audit, audit_event
                  │
                  ├── revoked: DELETE /rc/share/:id; live SSE evicted; 401
                  │
                  ├── exhausted: uses == max_uses; next attempt → 410 Gone
                  │
                  └── expired: now > expiresAt; next attempt → 410 Gone
```

`uses` counter increments on every distinct browser session — defined
as "first request from a request stream that has not yet
authenticated this server-side request flow." Concretely: each call
to `GET /rc/share/whoami` bumps `uses` once; subsequent requests in
the same browser session do not. Implementation detail: a short-lived
server-side session-id cookie distinguishes refresh-on-same-tab (no
bump) from refresh-after-close (bump). The cookie is `Secure`,
`HttpOnly`, `SameSite=Strict`, lifetime tied to the share token.

### Defaults

| Knob         | Default | Range                   |
| ------------ | ------- | ----------------------- |
| `--ttl`      | 1h      | 5m to 30d (clamped)     |
| `--scope`    | `view`  | `view` or `approve`     |
| `--max-uses` | 5       | 1 to 100                |
| `--label`    | none    | 1 to 64 chars; advisory |

## Watermark UX

Every web client surface that's authenticated by a share token
renders a non-dismissable banner above the chat surface:

```
   ┌──────────────────────────────────────────────────────────┐
   │ ⚠ Shared session: "oncall-bob" (approve only)            │
   │   3 of 5 uses · expires in 47m · Shared by evan@station  │
   │                                              [ revoke ]  │
   └──────────────────────────────────────────────────────────┘
```

The revoke button is visible to the owner (if they happen to be
viewing the same session from a different tab); for the guest it
shows nothing destructive but the metadata is identical.

Owner-scope clients on the same session see a corresponding banner
in their UI listing every active share for that session, so they're
constantly aware. This banner sources from `GET /rc/share?
sessionId=<sid>` polled on session attach and updated via SSE
`share_created` / `share_revoked` events.

## Scope semantics

| Share scope | Reads transcript | Approves tools | Sends prompts | Ends session | Notes                                          |
| ----------- | ---------------- | -------------- | ------------- | ------------ | ---------------------------------------------- |
| `view`      | yes              | no             | no            | no           | Default.                                       |
| `approve`   | yes              | yes            | no            | no           | "Watch and unblock." Cannot start new actions. |

Neither share scope ever lets the holder mint another share, list
shares, revoke, or read audit. The web client masks out unreachable
UI based on the `scope` returned by `/rc/share/whoami`.

## Persistence

The pairing-auth tokens table from `add-remote-control` gains three
columns:

```sql
ALTER TABLE tokens ADD COLUMN session_lock_id  TEXT NULL;
ALTER TABLE tokens ADD COLUMN max_uses         INTEGER NULL;
ALTER TABLE tokens ADD COLUMN uses             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN label            TEXT NULL;
ALTER TABLE tokens ADD COLUMN parent_token_id  TEXT NULL;
CREATE INDEX idx_tokens_session_lock ON tokens(session_lock_id);
```

`parent_token_id` records the owner-scope token that minted this
share, for audit attribution. Existing paired tokens have these
columns null; their behaviour is unchanged.

Audit log gains `share_id` (nullable) and `share_label` (nullable)
fields. Existing rows are not backfilled.

## Threat model

| Attacker                                | Capability                               | Mitigation                                                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share URL forwarded to public channel   | Any reader gets the share's access       | Short default TTL (1h); `max_uses` cap (default 5); fast revoke; visible watermark on owner's own UI so they see suspicious use; audit log of every redemption with IP and user-agent.                                              |
| Reverse proxy logs the first URL        | Token visible to operator's log host     | Documented mitigation: configure proxy to redact `/ui/share/*` request paths from access logs. The daemon itself never logs the path with the token.                                                                                |
| Browser history / bookmark              | Token persists locally on guest's device | History neutralised by `history.replaceState` on first load. Bookmarks save `/ui/` after replace. SessionStorage clears on tab close.                                                                                               |
| Guest's machine compromised mid-share   | Attacker reads sessionStorage            | Same blast radius as the share scope itself (one session, time-bounded). Revoke ends it. Pairing-token compromise is broader and slower; share is narrower and shorter by design.                                                   |
| Share holder tries to escalate scope    | Mint another share, etc.                 | `share` scope cannot reach `/rc/share`, `/rc/pair`, `/rc/tokens`, `/rc/audit`. Enforced by scope guard.                                                                                                                             |
| Share holder attaches to other sessions | Workspace-wide leak                      | `session_lock_id` is checked on every session-scoped route: `/session/:id/events`, `/session/:id/prompt`, `/permission/:requestId` (resolved to its session for the check). Wrong session → 403 with code `share_session_mismatch`. |
| Use-count race                          | Two clicks slip past `max_uses`          | `UPDATE tokens SET uses = uses + 1 WHERE id = ? AND uses < max_uses` returning rowcount; if rowcount is 0 the request 410s. SQLite-level atomicity.                                                                                 |
| Long-TTL share → token theft tail risk  | Forgotten share keeps working            | TTL clamp default 1h; max 30d. CLI warns when ttl > 24h. Listing surfaces every active share.                                                                                                                                       |
| Owner shares wrong session by mistake   | Wrong transcript leaked                  | `qwen rc share create` requires explicit `<sessionId>`; no "default to active session" sugar. CLI prints the session's display name in the confirmation output before printing the URL.                                             |
| Daemon restart                          | Tokens persist; uses counter intact      | Tokens.db is durable. Revocation state, uses count, expiry, all persist across restart.                                                                                                                                             |

### What leaks if a share URL leaks

- Anyone with the URL can act with that share's scope on that one
  session until: revoked, TTL expires, or `max_uses` exhausted.
- They CANNOT see any other session, even in the same workspace.
- They CANNOT mint anything new.
- They CANNOT read audit, file enumeration outside the session's
  context, or workspace-wide presence (only same-session presence).

## Decisions

### D1 — URL is the credential, not a pairing-code prompt

**Choice**: The share URL embeds the token directly. The recipient
clicks it; they're in. No code-entry screen, no second factor, no
pre-share pairing.

**Alternative considered**: The URL goes to a code-entry page; the
operator separately shares a 9-char code; recipient enters it. Same
pairing UX as `add-remote-control`, just session-locked.

**Why**: The whole point of share is one-click handoff. A code-entry
step doubles the latency and the failure modes (typo, code expired
between the click and the entry, recipient confused about which code
to use). For the time-bounded scope, the URL-as-credential pattern
is strictly better. The threat model section above shows the
remaining risks are addressable.

**Cost**: A leaked URL is a leaked credential. Mitigated by short
default TTL, max-uses, fast revoke, and visible audit. Operators are
told this explicitly in the CLI help text and in `--ttl >24h`
warnings.

### D2 — `share` scope is brand new, not "read with extra

constraints"

**Choice**: Add `share` as a distinct scope. It implies `read` only
by default (no `approve`); operator opts in to `approve` at create
time.

**Alternative considered**: Treat share tokens as `read`-scope (or
`approve`-scope) tokens with a separate `session_lock_id` column.
Same enforcement but no new scope name.

**Why**: A distinct name surfaces in audit and in `qwen rc tokens
list` as "this is a share-link, not a paired device." It also keeps
the scope guard simple: no conditional logic ("is this token's
scope `read` AND does it have a session lock?"). The downside is
two scopes (`read` and `share`) effectively grant the same actions
on the locked session; that's fine because they're distinguished by
provenance, not by capability.

**Cost**: Another scope to remember and document. The capability
list grows by one. Acceptable.

### D3 — `sessionStorage`, not `localStorage`, for the share token

**Choice**: Share tokens live in `sessionStorage` (clears on tab
close); paired tokens continue to live in `localStorage`.

**Alternative considered**: `localStorage` for both. Means a guest
who bookmarks `/ui/` and comes back later still has the token.

**Why**: Share is by definition ephemeral. `localStorage` would
extend the leak window past the closed tab — an attacker who later
gets the device retrieves it. `sessionStorage` matches user
expectations ("I closed the tab; the share is over for me").
Guests who actually need a longer access get a fresh URL when they
come back; the `uses` counter handles this correctly.

**Cost**: A guest who closes the tab and comes back is prompted for
the URL again. Acceptable; the URL is in their original DM.

### D4 — `uses` counts browser-sessions, not HTTP requests

**Choice**: `uses` increments once per distinct browser session via
the `whoami` endpoint, gated by a `Secure HttpOnly SameSite=Strict`
cookie keyed off the share token. Subsequent requests inside the
same session do not bump the counter.

**Alternative considered**: Count every individual HTTP request
against `max_uses`.

**Why**: Counting HTTP requests would make `max_uses = 5` mean "five
GETs," which is so trivially exhausted by an SSE reconnect or an
SPA's normal traffic that the cap becomes useless. Counting browser
sessions matches the user mental model: "five different times
someone clicked the link."

**Cost**: A cookie. Documented as essential to the feature. No
fingerprinting; the cookie value is opaque and tied to one share
token.

### D5 — Revoke is per-share, immediate, like token revoke

**Choice**: `DELETE /rc/share/:id` mirrors `DELETE /rc/tokens/:id`
from pairing-auth: instant 401 on subsequent requests, SSE evicts
within 1 s. Same code path, just filtered for share scope.

**Alternative considered**: Mark revoked but allow current SSE
streams to live out their natural reconnect; only block new connections.

**Why**: Revocation is a user action that means "stop this now."
Consistency with paired-token revoke is the right call. Leaving live
streams running confuses operators ("I revoked it, why is it still
showing in audit?").

**Cost**: SSE eviction code path reused. Free.

### D6 — Watermark cannot be hidden by the guest

**Choice**: The web client renders the share watermark
non-dismissably whenever the active token has `share` scope. There
is no setting, no close button, no opacity tweak.

**Alternative considered**: A subtle indicator only (small icon in
the corner).

**Why**: The watermark is for the _owner's_ awareness, not the
guest's. The owner views their own client and sees, at a glance,
that an external share is live. A guest dismissing the banner
defeats that purpose.

**Cost**: Slightly cramped UX for the guest. They asked to look at
someone else's session; a banner is the lightest possible signal.

## Persistence

| Artifact                          | Format   | Notes                                                                                                                                             |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens` (extended)               | SQLite   | New columns above; existing rows null in those columns.                                                                                           |
| Audit log entries                 | JSONL    | New `share_id`, `share_label` fields.                                                                                                             |
| Bootstrap HTML for `/ui/share/*`  | Static   | Bundled with web client; no per-request rendering.                                                                                                |
| Server-side share-session cookies | Volatile | Stored in tokens.db `share_browser_sessions(token_id, cookie_hash, first_seen)` keyed for the dedup-counter check. Pruned 24h after share expiry. |

## Risks / Trade-offs

| Risk                                | Likelihood | Impact | Mitigation                                                                                         |
| ----------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| Guests forward the URL              | H          | M      | Defaults: 1h TTL, 5 uses, watermark visible to owner, fast revoke. Owner is the controlling adult. |
| Reverse proxy logs token            | M          | H      | Documented redaction config snippets for Caddy and Nginx in `docs/users/remote-control.md`.        |
| Owner forgets to revoke a 30d share | M          | M      | `qwen rc share list` prominent in `--watch`; weekly summary in audit feed; max TTL clamp 30d.      |
| Watermark UX feels heavy            | M          | L      | The whole point. Operator can revoke if guest complains; can't disable the watermark.              |
| Confusion: share vs pair            | M          | M      | CLI help, owner docs, distinct command (`share`, not `pair --short`). Scope enum separate.         |
| `max_uses` race                     | L          | M      | Atomic SQL UPDATE; tested.                                                                         |
| Long-running SSE survives revoke    | L          | M      | Eviction within 1s reused from pairing-auth.                                                       |

## Open questions

1. **Should `qwen rc share create` accept `--copy-to-clipboard` and
   emit the URL only to the clipboard, not to stdout?** Helps avoid
   leaking the URL into shell history. Leaning yes for the default
   on TTY interactive use; explicit `--print` to fall back.

2. **Should the bootstrap HTML hash itself with SRI to prevent a
   reverse-proxy-injected script-tag from stealing the token in
   transit?** TLS already handles this in the threat model
   (operator must terminate TLS upstream — `add-remote-control` D-
   level), but defense-in-depth might warrant an SRI hash baked
   into the daemon's served HTML.

3. **Should share tokens be revealable via `qwen rc share show
<id>`?** No — same as paired tokens, plaintext is shown only at
   creation. If the operator lost the URL, they revoke and recreate.

4. **Watermark on the guest side: should we also include the
   sharing operator's email / handle, or just a label?** Currently
   the label is operator-chosen free text. Showing the operator
   identity might be over-personal. Leaning toward label-only for
   v1 and revisiting.

5. **Allow `--scope approve` only after a delay / confirmation?**
   Approve-scope shares grant the ability to greenlight bash on the
   operator's machine. A `--scope approve` should require explicit
   `--i-understand` confirmation flag, or maybe just a verbose
   warning. Phase 2 of implementation will measure.
