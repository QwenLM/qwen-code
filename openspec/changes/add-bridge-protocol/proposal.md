# add-bridge-protocol

## Why

WebPush is the right channel for the workstation owner's own devices,
but it doesn't cover collaboration patterns where attention lives on
a chat service the team already uses: Telegram, Discord, Matrix,
Slack, even SMS via Twilio. Each of these has its own SDK, message
shape, button affordance, and rate-limit story. Embedding all of
that into the daemon would bloat its attack surface, force every
operator to update every bridge in lockstep with the daemon, and
push third-party dependencies into the core process.

The user's stated preference (and the right architecture) is
**sidecar bridges**: each bridge is its own process holding its own
scoped token, talking to the daemon over the existing HTTP+SSE API.
Bridge compromise = revoke that bridge's token. Bridge crash = the
daemon and other bridges are unaffected.

This change defines the **contract**: what scope a bridge needs, how
it represents external users in audit, what events it sees, how it
votes on permission requests on behalf of a remote user, and how it
identifies itself in presence events. The reference Telegram bridge
(`add-telegram-bridge`), Discord (`add-discord-bridge`), and Matrix
(`add-matrix-bridge`) all conform to this contract.

## What Changes

- **New scope `bridge`.** Tokens with `bridge` scope can do everything
  `approve` + `write` can, plus assert a `subActor` identity in audit
  entries ("the underlying Telegram user is @evan"). `bridge` is NOT
  implied by `owner` and cannot be granted by `owner` accidentally;
  it must be requested explicitly during pairing (`scope: bridge`).
- **`subActor` field across audit log and SSE events.** All
  authenticated routes accept an `X-RC-SubActor` header with a
  stable identifier for the underlying user. Audit log gains
  `sub_actor` column. The audit-event SSE frame surfaces it so
  workstation clients see "Approved by Phone-Bridge (acting for
  @evan)".
- **Bridge registration via `POST /rc/bridges`.** A bridge declares
  its capabilities (`supportsActions`, `supportsMarkdown`,
  `maxMessageBytes`, `displayName`) and gets back a registration
  record. Registration is idempotent on the bridge's stable id.
- **Per-sub-actor rate limit.** Bridges fan in N external users; the
  daemon enforces a per-sub-actor rate limit on writes
  (prompts, permission votes) to prevent one rude Telegram user from
  saturating the queue.
- **Capability flag on `permission_request`.** When a permission
  request fires, the daemon's event includes `bridgeHints` indicating
  whether the call's args can be safely rendered to chat (length,
  presence of secrets). Bridges use this to decide whether to render
  full content or a "tap to view in web client" deep link.
- **Bridge presence with `kind: "bridge"`.** `client_joined` events
  carry `kind: "bridge"`, and `client_left` distinguishes bridge
  disconnects. The workstation owner can see which bridges are live.
- **Bridge sub-actor revocation.** Owner-scope can ban a specific
  `subActor` from a specific bridge without revoking the bridge's
  token entirely.

## Capabilities

### New Capabilities

- `bridge-protocol` — scope semantics for sidecar bridges, audit and
  presence extensions, registration endpoint, per-sub-actor rate
  limit, sub-actor revocation, capability advertisement for bridges,
  and the threat-model isolation between bridges and the rest of
  the daemon.

## User Stories

**B1. Operator installs Telegram bridge.** Operator runs the
Telegram sidecar (Docker image) with a daemon URL, a bridge-scope
pairing code, and a Telegram bot token. Bridge redeems the code,
gets a `qwk_*` token, registers via `POST /rc/bridges` declaring
`supportsActions: true`. Audit log records the registration with the
bridge's display name.

**B2. Telegram user approves a prompt.** Agent fires a permission
request. Bridge receives the SSE frame, decides (per `bridgeHints`)
to render an inline-keyboard message in Telegram with Approve/Deny
buttons. The Telegram user @evan taps Approve. Bridge POSTs to
`/permission/:requestId` with `X-RC-SubActor: telegram:evan` and the
approve vote. Workstation web client sees `permission_resolved`
with originator = bridge token, subActor = `telegram:evan`.

**B3. Bridge crash / restart.** Bridge process dies. Daemon emits
`client_left` with `kind: "bridge"` for the dropped subscription.
External users still send messages to Telegram; bot replies "agent
offline." On restart, bridge re-attaches with its (still-valid)
token, replays missed events via `Last-Event-ID`, catches up.

**B4. Misbehaving sub-actor.** A Discord member spams the bot with
prompts. Operator runs `qwen rc bridges ban discord:troll123 --on
discord-bridge`. Bridge receives a `sub_actor_banned` event and
filters that user. Audit log records the ban.

**B5. Bridge compromise.** Telegram bot token leaked publicly.
Operator runs `qwen rc tokens revoke <bridge-token-id>`. Bridge is
booted from SSE, all in-flight bridge actions fail closed, audit log
shows last actions. New Telegram bot, new pairing code, new bridge
token, back online.

## Impact

- **qwen-code repo**: extend `add-remote-control`'s scope system to
  include `bridge`; extend audit schema with `sub_actor`; add bridge
  registration routes in
  `packages/cli/src/serve/remoteControl/bridges/`. New CLI:
  `qwen rc bridges {list, ban, unban, deregister}`.
- **Audit schema migration**: backfill `sub_actor: null` for existing
  rows.
- **No bridge code in core**: this change does NOT implement any
  specific bridge. Telegram/Discord/Matrix are their own changes that
  reference this contract.
- **External artifacts**: an example bridge skeleton in
  `examples/bridges/skeleton/` (TypeScript), demonstrating how to
  build a conformant bridge. Not shipped as a release artifact.
- **Out of scope** (deliberately):
  - Specific bridge implementations.
  - End-to-end encryption between sub-actor and the agent. Bridges
    necessarily see plaintext.
  - Federated identity between bridges (a Telegram @evan and Discord
    @evan are different sub-actors and stay distinct).
  - Bridge auto-update from a registry.
