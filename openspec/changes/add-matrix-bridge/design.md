# Design — add-matrix-bridge

## Context

`add-telegram-bridge` and `add-discord-bridge` shipped the first two
conformant bridges. Matrix is the natural third because:

- It is open-protocol and self-hostable end-to-end, which aligns
  with the broader project's "operator owns the stack" thesis.
- It exercises three corners of the bridge contract the prior
  bridges did not: `supportsActions: false` (no inline buttons),
  `supportsMarkdown: "full"`, and explicit handling of end-to-end
  encrypted rooms.
- Federation introduces a new trust dimension: a bot on
  homeserver `A` can act in a room hosted on homeserver `B`. The
  bridge's threat model must say something about this.

The patterns from prior bridges apply: env-only config, atomic JSON
persistence, hint-driven rendering, sender-attributed sub-actors,
decoupled SSE-vs-chat back-pressure. The deviations are:

- **Reactions, not buttons, for voting.** Matrix has no inline
  button surface. `m.reaction` events with `key: "👍"` or `key:
"👎"` on a permission-request message are the closest equivalent.
- **DM-bootstrapped attach.** Operator invites the bot to a room
  and posts `!qwen attach <invite>` — there's no slash-command
  registry to register, so we use a text command prefix.
- **E2E key management.** Bot maintains a megolm/olm store on disk
  to decrypt messages across restarts.

## Goals / Non-Goals

**Goals:**

- Single-container deployment against any standards-compliant
  Matrix homeserver (Synapse, Conduit, Dendrite).
- User-mode bot login (just an access token); no application
  service registration needed.
- Encrypted room participation with persistent key store.
- Reaction-based voting that maps cleanly to the bridge-protocol
  vote semantics.
- Federation-agnostic operation (bridge works whether the room is
  on the operator's homeserver or federated in).

**Non-Goals:**

- Application service (AS) registration. Future.
- Cross-homeserver identity reconciliation.
- Voice / video / Element Call.
- Spaces management.
- SSO/OIDC bot login.
- Bot self-registration (the operator creates the user account
  out-of-band).

## Architecture

```
   Operator workstation                       Matrix homeserver(s)
   ┌─────────────────────────────┐
   │ qwen serve (daemon)         │
   │  +bridge-protocol routes    │
   └──────────────┬──────────────┘
                  │ HTTP+SSE (loopback or LAN)
                  │ X-RC-SubActor: matrix:@user:server
   ┌──────────────┴──────────────┐         ┌─────────────────────┐
   │ qwen-bridge-matrix          │ HTTPS   │ home.example.com    │
   │  - SSE consumer (per room)  │◀───────▶│   /sync, /send,     │
   │  - Matrix sync loop         │         │   /receipt, /redact │
   │  - Reaction listener        │         └─────────────────────┘
   │  - olm/megolm store         │              ▲
   │  - room<->session store     │              │ federation
   │  - sensitivity renderer     │              │
   │  - ban filter cache         │              ▼
   └─────────────────────────────┘         ┌─────────────────────┐
            │                                │ other-server.org    │
            └── ~/.qwen/rc/bridges/matrix/    │   (federated rooms) │
                ├ rooms.json                   └─────────────────────┘
                ├ cursors.json
                ├ bans.json
                └ olm/  (sqlite + key files)
```

Loops:

1. **Sync loop.** `GET /_matrix/client/v3/sync?since=<token>`
   long-poll. Receives messages, reactions, room invites,
   membership changes, key shares.
2. **SSE loop per binding.** Daemon SSE per bound session.
3. **REST send loop.** Outbound `m.room.message` / `m.reaction` /
   `m.replace`.

## Configuration

| Var                        | Required | Notes                                                    |
| -------------------------- | -------- | -------------------------------------------------------- |
| `MATRIX_HOMESERVER_URL`    | yes      | e.g. `https://home.example.com`.                         |
| `MATRIX_USER_ID`           | yes      | e.g. `@qwenbot:home.example.com`.                        |
| `MATRIX_ACCESS_TOKEN`      | yes      | From a one-time `/login` (manual).                       |
| `QWEN_DAEMON_URL`          | yes      |                                                          |
| `QWEN_BRIDGE_TOKEN`        | yes      | `qwk_*` bridge-scope token.                              |
| `QWEN_BRIDGE_PAIRING_CODE` | no       | One-time bootstrap.                                      |
| `QWEN_BRIDGE_STATE_DIR`    | no       | Default `~/.qwen/rc/bridges/matrix`. Contains olm store. |
| `MATRIX_COMMAND_PREFIX`    | no       | Default `!qwen`. Operator can override if it clashes.    |
| `BRIDGE_LOG_LEVEL`         | no       | `info` default.                                          |

## Attach flow

Matrix has no slash-command registry; commands are plain text. The
flow:

1. Operator generates `inv_abc` via `qwen rc bridges invite --kind
matrix --session sess_xyz`.
2. Operator (or any room member) invites `@qwenbot:home.example.com`
   to the target room.
3. Bot auto-accepts the invite (on `m.room.member` invite event,
   call `POST /rooms/:id/join`).
4. The inviting user posts `!qwen attach inv_abc` in the room.
5. Bot calls daemon `POST /rc/bridges/:id/invite/redeem` with the
   token; on 200, persists binding and replies "Room bound to
   session `sess_xyz`. React 👍/👎 on tool-call messages to vote."
6. `!qwen detach`, `!qwen status` work analogously.

Only members with power level ≥ 50 (default Moderator) can run
`!qwen attach`. This prevents random room members from binding
sessions to channels they don't control.

## Rendering

### Plain session updates

`session_update` chunks rendered as `m.room.message` events with
`msgtype: "m.text"`, `body` (plaintext), `format:
"org.matrix.custom.html"`, and `formatted_body` (HTML).

Matrix's max event size is 65536 bytes; we declare 65536 in
capabilities but practically flush at 16 KB to leave headroom for
formatting and federation.

Streaming uses the same boundary-buffered flush pattern as Telegram
and Discord, with the higher cap allowing fewer fragments.

### permission_request

Reactions are the affordance. Branch on
`bridgeHints.recommendedSurface`:

- **`inline`**: Send a message with body

  ```
  ⚠️ Tool call: <argsSummaryShort>
  React 👍 to approve, 👎 to deny.
  ```

  Record `(requestId → eventId)`.

- **`deeplink`**: Send a message with body
  ```
  ⚠️ Sensitive tool call: <argsSummaryShort>
  Open in web client: <daemon-url>/ui/permission/<reqId>
  ```
  No reaction prompt — sensitive calls require explicit
  web-client review.

When the bridge observes `m.reaction` events whose `m.relates_to`
points at the recorded eventId, with `key` matching 👍 or 👎, from a
sender not in the ban cache, it casts the vote against the daemon.
First-responder-wins, matching the daemon's existing semantics; the
bridge does NOT tally reactions.

### permission_resolved

Use `m.replace` edits to mutate the original event:

- Append `\n\nResolved: <vote> by <subActor>` to the body.
- Set `m.new_content.body` and `m.new_content.formatted_body`
  accordingly.

Past reactions remain visible in the timeline but are now informational.

### Sub-actor identity

`matrix:@user:homeserver`. Matrix IDs are immutable and globally
unique across the Matrix network.

Extracted from `event.sender` (always a fully-qualified MXID).

## E2E encryption

The bridge MUST handle encrypted rooms gracefully. We use
`matrix-bot-sdk`'s crypto provider, which persists olm/megolm keys
to a SQLite store at `$QWEN_BRIDGE_STATE_DIR/olm/`.

Two facts the operator must internalize, documented prominently:

1. **The bridge sees plaintext** in any encrypted room it joins.
   It's a room member with keys. End-to-end means "encrypted
   between members"; the bridge is a member.
2. **The olm store contains room keys.** Loss of the store on a
   running bridge forces re-keying (room members must re-share
   keys). Backup is the operator's responsibility; we document an
   `rsync $QWEN_BRIDGE_STATE_DIR/olm/` pattern.

The bridge SHALL trust the homeserver's `/keys/upload` and
`/keys/query` endpoints; we do not implement cross-signing
verification in v1. Documented limitation.

## Rate limits

Matrix homeservers rate-limit per-user; Synapse default is generous
(~10 msg/s per user). The bridge uses `matrix-bot-sdk`'s built-in
backoff on `M_LIMIT_EXCEEDED`. On daemon 429, the bridge replies in
the room with `> Slow down...` (note: room-visible, not ephemeral —
Matrix has no ephemeral message concept).

## Bans

Standard pattern. `sub_actor_banned` SSE event → local cache →
filter messages and reactions before any daemon call.

For reactions: a banned user's reaction is acknowledged passively
(we don't redact it; that would surprise the user) but does NOT
trigger a vote.

## Packaging

- **Docker image** `ghcr.io/qwen-code/bridge-matrix:<ver>`.
- **Single binary** via `bun build --compile`.
- **Source package** `packages/bridge-matrix/`.

## Threat model

| Attacker                         | Capability                                       | Mitigation                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot access-token leak            | Impersonate the bot account across all its rooms | Operator revokes the access token via `/logout` on the homeserver AND revokes the bridge token. Coupled rotation.                                                       |
| Bridge token leak                | Mint daemon calls with arbitrary subActor        | Revoke bridge token; audit pinpoints.                                                                                                                                   |
| Homeserver compromise            | See / forge all bot messages                     | Out of bridge's control; documented. Trust assumption: "your homeserver is trusted." Operators self-host for this reason.                                               |
| Federated homeserver compromise  | Forge messages in federated rooms                | Matrix federation trust model; same caveat as Matrix in general. The bridge's only defence: scope-limited bridge token.                                                 |
| Olm store theft                  | Decrypt past room messages                       | $QWEN_BRIDGE_STATE_DIR permissioned 0700, files 0600. Docker volume isolation. Documented.                                                                              |
| Non-moderator user binds session | Hijack channel for their session                 | `!qwen attach` requires power level ≥ 50.                                                                                                                               |
| Spam reactions from many MXIDs   | Drain vote rate limit / inflate audit            | Per-sub-actor token bucket; ban flow.                                                                                                                                   |
| Long-downtime missed events      | Bot misses /sync events past server retention    | On reconnect, full /sync with empty `since` re-establishes state; bridge logs a "events possibly missed" warning. Daemon SSE remains the source of truth for the agent. |

## Decisions

### D1 — User-mode bot via access token, not application service

**Choice**: Operator creates a regular Matrix user account on their
homeserver, logs in once to grab an access token, supplies it via
env var.

**Alternative considered**: Application Service (AS) registration
via `registration.yaml` posted to the homeserver admin.

**Why**: User-mode requires no homeserver admin access beyond
"create a user." Many operators don't admin their own homeserver
(they use matrix.org or a hosted Synapse). AS mode is more powerful
(no rate limits, namespaced users) but requires admin cooperation
and a YAML round-trip; not worth it for v1.

**Cost**: User-mode bot is subject to homeserver rate limits and
counts as a real user. Acceptable for the bridge's volume.

### D2 — `matrix-bot-sdk` over `matrix-js-sdk`

**Choice**: `matrix-bot-sdk` (turt2live/matrix-bot-sdk).

**Alternative considered**: `matrix-js-sdk` (official, browser-
oriented).

**Why**: `matrix-bot-sdk` is designed for bots from the ground up:
simpler API surface, built-in crypto store (Rust-backed via NAPI),
cleaner sync pattern. `matrix-js-sdk` carries browser-shaped APIs
(IndexedDB stores, web crypto) that we'd have to plumb to Node
equivalents.

**Cost**: Slightly smaller community vs the official SDK. Mitigation:
documented; if `matrix-bot-sdk` is abandoned we have a clear
migration path back to `matrix-js-sdk`.

### D3 — Reactions for voting; no actions surface

**Choice**: Declare `supportsActions: false`. Use 👍 / 👎 reactions
on the permission-request message as the vote affordance.

**Alternative considered**: Render a fake "button" by listening for
text replies like "approve" / "deny".

**Why**: Reactions are native UX, atomic, and unambiguous. Text
replies suffer from typos, capitalization, and timing races.
Reactions are also unambiguously attributable to a specific MXID
on a specific event.

**Cost**: Users unfamiliar with reactions may not know to use them;
the bridge's message body includes explicit instructions.

### D4 — MXID-based sub-actor (federation-aware)

**Choice**: `matrix:@user:homeserver` — the fully-qualified MXID.

**Alternative considered**: `matrix:<localpart>` stripping the
homeserver.

**Why**: Matrix IDs are namespaced by homeserver; `@evan:foo.org`
and `@evan:bar.org` are different users. Stripping loses identity
across federation.

**Cost**: Audit lines are longer. Acceptable.

### D5 — Power level ≥ 50 required for `!qwen attach`

**Choice**: Only members with power level ≥ 50 (default
"Moderator") in the room can bind a room to a session.

**Alternative considered**: Anyone in the room can attach.

**Why**: A bound room exposes session activity to all room members
and lets them vote on permissions. The decision to bind should
rest with someone trusted to manage the room. Power level 50 is
the natural threshold (it's also the default for room moderation
verbs like kick).

**Cost**: A new room operator must explicitly raise their own (or
the operator's) power level before binding. Acceptable; documented.

### D6 — Persistent olm store on disk

**Choice**: Persist megolm/olm keys to `$QWEN_BRIDGE_STATE_DIR/olm/`
across restarts.

**Alternative considered**: Re-key on every boot (require room
members to re-share keys).

**Why**: Forcing re-key on every restart is unworkable for any
moderately active room; key share dialogs would flood the operator's
clients. Persistence is the only practical choice.

**Cost**: The on-disk store contains room keys. Operator must
protect the volume. Documented as a top-level security note.

## Risks / Trade-offs

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                             |
| --------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Encrypted room key-share fails after bridge restart | M          | M      | Persistent olm store; documented backup pattern; debug log on `m.room.encrypted` decrypt failure.                      |
| Federation outage hides reaction events             | M          | L      | Sync resumes when federation restores; voting deadline extended on the daemon-side.                                    |
| Reaction spam from multiple MXIDs                   | M          | L      | First-responder-wins (daemon-level); per-sub-actor token bucket; ban flow.                                             |
| Long downtime exceeds server retention              | L          | M      | On `/sync` empty-`since` full state load; emit `events_possibly_missed` log; chats may show edited-but-not-seen state. |
| MXID with unusual chars breaks audit                | L          | L      | The bridge-protocol regex allows the MXID character set; verified in tests.                                            |
| Bot kicked from room mid-stream                     | L          | M      | Bridge detects `m.room.member` leave for itself; logs and detaches binding on next scan.                               |
| Homeserver-side rate limit thrashes                 | L          | M      | `matrix-bot-sdk` backoff; daemon SSE unaffected.                                                                       |

## Open questions

1. **Should the bridge attempt cross-signing verification in v1?**
   Currently no. Cross-signing would let the bridge refuse messages
   from unverified devices, raising security but adding UX cost
   (verification ceremony on every operator device). Defer to v2.

2. **Should `!qwen attach` accept a room-aliased shorthand
   instead of the invite token?** E.g. `!qwen attach
#session-abc:home.example.com`. Defer; the invite-token path
   matches the other bridges.

3. **Should the bridge handle Spaces (parent rooms) specially?**
   Today no. Spaces are addressed like any room. Future work could
   bind a whole space to a session, mapping subrooms to sub-sessions.

4. **Should reactions other than 👍 / 👎 trigger anything?** No.
   Other reactions are ignored. Documented.

5. **What happens when the operator's homeserver federates with a
   server they don't trust, and a remote user reacts?** The
   reaction still counts (first-responder). The operator's recourse
   is to ban the MXID. Acceptable; matches the broader bridge
   model of "operator owns the trust boundary."
