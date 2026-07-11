# add-matrix-bridge

## Why

`add-bridge-protocol` defined the contract; `add-telegram-bridge`
and `add-discord-bridge` shipped the first two conformant
implementations. Matrix covers a class of operators we have not yet
served: those who self-host their chat (Synapse / Conduit / Dendrite)
or who prefer a federated, open-protocol alternative to commercial
chat platforms. It is also the chat service most aligned with the
"self-host everything" thesis behind qwen-remote-control itself.

Matrix differs from Telegram and Discord in three ways that this
change must handle:

1. **No inline buttons.** Matrix has no equivalent of Telegram inline
   keyboards or Discord components. We declare
   `supportsActions: false` and use **reactions** (`m.reaction`) as
   the voting affordance — operators react with 👍 or 👎 on a tool-
   call message.
2. **End-to-end encryption is a real concern.** Matrix rooms can be
   E2EE-enabled. A bot that joins an encrypted room sees plaintext
   only because it's a room member with keys; the operator must
   understand the bridge holds keys.
3. **Federation.** A bridge can run on a homeserver that federates
   with the operator's, OR be a "puppet" on the operator's
   homeserver. We recommend the latter for simplicity.

## What Changes

- **New sidecar process `qwen-bridge-matrix`.** Standalone Node
  binary + Docker image. Env: `MATRIX_HOMESERVER_URL`,
  `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`, `QWEN_DAEMON_URL`,
  `QWEN_BRIDGE_TOKEN`. Operator creates a Matrix user account on
  their homeserver, logs in once to obtain an access token, and
  passes it to the bridge.
- **Matrix bot setup procedure documented.** Two paths:
  (a) user-mode bot via `/login` (recommended for simplicity);
  (b) application service (preferred for high-volume deployments).
  V1 implements (a) only.
- **Room-to-session binding via DM + command.** The operator DMs
  the bot from the workstation (or any logged-in client), and the
  bot replies with a one-time `!qwen attach <invite>` command to
  use in the target room. Bridge persists `(roomId, sessionId)`
  bindings.
- **Reactions for permission votes.** `permission_request` events
  render as a room message; the bridge listens for `m.reaction`
  events on that message with `key: "👍"` or `key: "👎"` from any
  room member.
- **E2E encryption disclosure.** Documentation makes clear: the
  bridge sees plaintext in any encrypted room it joins. The bridge
  holds room keys. Loss of the bridge's `olm` store is a
  re-keying event.
- **Capability declaration:** `supportsActions: false`,
  `supportsMarkdown: "full"` (Matrix supports CommonMark via
  `org.matrix.custom.html` formatted body), `maxMessageBytes:
65536` (Matrix's effective practical limit), `supportsThreads:
true` (`m.thread` relations), `supportsEdits: true`
  (`m.replace`).
- **Sub-actor:** `matrix:@user:homeserver`. Matrix IDs are
  homeserver-scoped and immutable.

## Capabilities

### New Capabilities

- `matrix-bridge` — Matrix-specific behaviour of the sidecar
  process: user-mode bot auth, DM-based attach flow, reaction-as-
  vote (since no inline buttons), threading via `m.thread`, full
  CommonMark rendering, E2E-aware room participation, MXID-based
  sub-actor.

## User Stories

**M1. Operator sets up the bridge.** Operator creates `@qwenbot:
home.example.com` on their Synapse server (manual user reg or
admin API), logs in once via Element to grab an access token, runs
`qwen rc pair --scope bridge --name matrix`, then runs the bridge
container with all env vars. Bridge logs "registered as br\_...";
operator confirms via `qwen rc bridges list`.

**M2. Team member binds a room.** Operator generates `inv_abc` via
`qwen rc bridges invite --kind matrix --session sess_xyz`. Operator
invites `@qwenbot` to the room. Bot auto-joins. Operator posts
`!qwen attach inv_abc`. Bridge redeems, persists binding, replies
"Room bound to session `sess_xyz`."

**M3. Approve from Matrix via reaction.** Agent fires `permission_
request`. Bridge sends a room message with `argsSummaryShort` and a
suffix "React 👍 to approve, 👎 to deny." Team member adds 👍.
Bridge POSTs vote with `X-RC-SubActor: matrix:@evan:home.example.com`.
On `permission_resolved`, bridge edits the message (via `m.replace`)
to read "Resolved: approved by `<subActor>`."

**M4. E2EE room.** Operator invites the bot to a room with
`m.room.encryption` enabled. Bot accepts. From this point the bot
holds the room's megolm keys and sees plaintext like any other
member. The bridge log records "joined encrypted room
`!abcd:home.example.com`." Bridge documentation makes this trust
boundary explicit.

**M5. Banned sub-actor.** Operator bans
`matrix:@spammer:other-server.com` via `qwen rc bridges ban`.
Bridge caches the ban; future messages and reactions from that MXID
are ignored.

**M6. Bridge re-keys after restart.** Bridge restarts and reads its
persisted olm store from `$QWEN_BRIDGE_STATE_DIR/olm/`. Resumes
decrypting room messages without prompting users to share keys
again.

## Impact

- **New package**: `packages/bridge-matrix/` (Node, TypeScript,
  bundled via esbuild; Docker image).
- **Depends on**: `add-bridge-protocol`, and the invite route
  extension from `add-telegram-bridge`.
- **No daemon changes** specific to this bridge.
- **Docs**: `docs/bridges/matrix.md` covering homeserver setup
  (Synapse user reg), bot login, E2E disclosure, invite/attach
  flow, reaction voting UX, troubleshooting (key sharing, re-key,
  federation, missed events on long downtime).
- **Library**: `matrix-bot-sdk` (chosen over `matrix-js-sdk`;
  rationale in design D2).
- **Out of scope:**
  - Application-service (AS) bridge mode. Future.
  - Cross-room session multiplexing.
  - Voice / video.
  - Spaces management.
  - SSO/OIDC login (bot is access-token-based only).
  - Identity-server interactions.
