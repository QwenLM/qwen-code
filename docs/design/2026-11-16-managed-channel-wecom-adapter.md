# Managed channel fourth adapter: WeCom

[English](2026-11-16-managed-channel-wecom-adapter.md) | [简体中文](2026-11-16-managed-channel-wecom-adapter.zh-CN.md)

Status: proposed. This is the fourth-adapter slice of the managed channel path
([#12827](https://github.com/QwenLM/qwen-code/issues/12827)), following the
DingTalk second adapter
([2026-11-13-managed-channel-dingtalk-adapter](2026-11-13-managed-channel-dingtalk-adapter.md))
and the GitHub third adapter
([2026-11-16-managed-channel-github-adapter](2026-11-16-managed-channel-github-adapter.md)).
The provider is the existing WeCom intelligent bot (`wecom` channel type,
botId + secret over the `@wecom/aibot-node-sdk` WebSocket), chosen by product
priority and confirmed by the maintainer. The send-only group webhook and the
self-built application callback are other WeCom connection methods; neither is
this slice (see Scope boundaries).

## Problem

The managed channel path has three adapters, email, DingTalk, and GitHub. WeCom is a
first-class Legacy channel (intelligent bot, application callback, group
webhook) but has no managed-path adapter, so a WeCom bot cannot route inbound
messages into bound Managed Agent Sessions or deliver receipted replies
through the control plane's outbox. The shared adapter contract
(`ManagedChannelAdapter`, `ManagedChannelPolicy`, `ManagedChannelControlPlane`,
`ManagedInboundEvent`, `ManagedClaimedDelivery`, `ManagedReceipt`) already
lives in `channel-base`; the enablement list is `['email', 'dingtalk', 'github']`.

## Current state (what is already generic)

The control plane is provider-agnostic, so this is primarily a TypeScript
slice, exactly as the DingTalk slice found:

- The Java `ChannelPolicy.adapter` is validated by the pattern
  `[a-z][a-z0-9-]{0,63}` (not an adapter enum); `platform` is a bounded string;
  the reply context is adapter-opaque JSON echoed back on claim. There is no
  Java-side adapter enablement gate — enablement lives in the TypeScript core
  (`MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`). No Java change is required.
- The segment ledger, the claim budget, the receipt write-once rule and the
  partial/resume re-claim already handle 1–64 segments and are
  provider-agnostic.
- The WeCom package already depends on `@qwen-code/channel-base` and
  `@wecom/aibot-node-sdk`; the Legacy `WeComChannel` shows the provider
  mechanics: the SDK pushes inbound message frames over an authenticated
  WebSocket (`message.text` and siblings), and `sendMessage(chatid, body)`
  proactively sends markdown over the same connection, resolving with the
  provider's receipt frame. For a single chat the SDK's `chatid` is the user's
  userid; the Legacy channel already falls back to the sender userid when a
  single-chat frame carries no `chatid`.
- The shared command factory `createManagedChannelCommand` holds the argument
  surface, control-plane wiring and lifecycle; a provider supplies only its
  adapter factory and user-facing strings.

Two provider mechanics differ from DingTalk and are load-bearing:

1. **No inbound ack, no redelivery.** The SDK dispatches `aibot_msg_callback`
   frames to event handlers and never acknowledges them to the provider; the
   provider does not redeliver. DingTalk's stream acks each frame (SUCCESS /
   LATER) and redelivers the unacked ones. The WeCom adapter therefore has no
   "leave it unacked for redelivery" arm: a frame that reaches the adapter but
   cannot be durably staged is lost, and must be logged as lost. A frame that
   arrives after the adapter has stopped never reaches it — the deps drop it at
   their own `stopped`/`authenticated` gate — so that post-stop drop is not a
   staged loss and is not logged as one.
2. **No session webhook.** A DingTalk reply targets the conversation's
   `sessionWebhook`, a bearer capability that expires, so the DingTalk adapter
   caches, snapshots and evicts webhooks. A WeCom reply travels over the live
   authenticated WebSocket keyed only by `chatid`; there is no per-message
   capability to persist, cache or evict. The reply context carries identity,
   not a credential.

## Decision

Add a managed WeCom adapter beside the DingTalk one, mirroring its discipline:
every claim persists before its side effect, a restart replays the same event
or reports the same segment `unknown`, never a second input and never a second
send.

- **Shared contract.** Widen `ManagedChannelAdapter` in `channel-base` to
  `'email' | 'dingtalk' | 'github' | 'wecom'` and the command factory's `adapterType`
  union with it. This is an additive widening of a published package's type;
  no existing export changes shape.
- **Enablement.** Add `'wecom'` to `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`
  in core and update the pinned contract test. The Java pattern already admits
  the name.
- **`ManagedWecomAdapter`.** A deps-injected adapter. Inbound arrives over the
  SDK's `message.text` event; one text frame becomes one platform event the
  control plane admits. Outbound sends each claimed segment to the
  conversation's `chatid` through the live SDK client and receipts it by
  ordinal; a multi-segment answer is several ordered messages.
- **Identity and scope.** The route scope is `chat_thread` keyed by the chat
  id: the frame's `chatid` when present, else the sender userid (the
  single-chat fallback the Legacy channel and the SDK's send contract both
  use). The sender identity is `from.userid`. The reply context is
  `{ chatId, senderId, botId }`, committed with the input and echoed by the
  outbox.
- **Command.** A `managed-wecom` CLI command wires the adapter to
  `HttpManagedChannelControlPlane` through the shared factory, mirroring
  `managed-dingtalk`. Like the other managed entries it is experimental and
  explicitly selected: `qwen channel start` never picks it, and it drives no
  model.

### Inbound staging (the ack-once discipline, adapted)

The SDK event handler stages the frame synchronously as a durable claim before
it returns; the async admission is left to the tick, exactly as DingTalk does.
Because the provider never redelivers, the persisted claim is the only copy:
a restart re-drives the exact persisted event, never a rebuilt one. A
`store.save()` failure cannot leave the frame for redelivery — it drops the
frame and logs the loss (latched, so a disk outage does not drown the log).
This is the deliberate divergence from DingTalk's LATER arm.

The gate refuses an incoming frame for three causes, each named by the latched
diagnostic: the 32-entry claim table is full, an instance stall is armed, or the
channel is re-registering (`registeredGeneration === 0`). Such a frame was never
staged, so this is a drop of the only copy — not the discard of a durable claim
— and on a no-redelivery provider it is permanent. Separately, a deterministic
admission refusal discards an already-staged claim and records its id in
`recent`: a per-message verdict (400/403/409) drops on the first refusal; an
instance-scoped refusal (`workspace_not_found` and siblings) sacrifices the
first frame and holds from the second, stalling admission until the binding
answers. A held claim is re-driven each tick; a dropped one is gone, and a
redelivery of its id is deduped away by `recent`.

A frame is staged only when all of the following hold; every other frame is
dropped with a diagnostic line naming the cause (ids only, never the text):

- it carries a `msgid` (the dedupe key; a frame without one cannot be deduped
  across restarts);
- it is a single chat (`chattype` is not `group`) — the managed path serves
  private chats under the private-chat policy, the same decision the DingTalk
  slice made: answering a group under the private policy would post the reply
  where every member reads it;
- it is a text frame with non-empty `text.content`;
- it carries a sender userid and a resolvable chat id;
- the sender passes the email-shaped `senderPolicy` (allowlist / open /
  disabled; `pairing` is refused at construction, as in DingTalk).

Dedupe runs against both the settled `recent` window and the in-flight
`pending` claims. Inbound text is clamped to the wire bound before submission
with the same clamp the DingTalk adapter uses: at most 32,000 UTF-16 units
(the server's `maxTextChars` counts UTF-16; a trailing high surrogate is backed
off) and the Harness's 64 KiB JSON envelope minus the metadata overhead, cut on
a code-point boundary. An over-long message is admitted truncated instead of
meeting a deterministic refusal and being dropped whole. The clamp is a local
copy beside the adapter, as in DingTalk; lifting it into `channel-base` would
touch the published package and the DingTalk adapter for no behavior gain.

There is no reply-target admission gate (DingTalk's "no sessionWebhook and
none cached" drop): the reply target is the live client plus the chat id,
available whenever the adapter is connected.

### Outbound delivery and receipt discipline

The outbound protocol is the DingTalk one unchanged, persist guards included:
guard the claim phase, send each segment in order, persist the outbound entry
before the send and the receipt after it, report the receipt, and only then drop
the entry. The claim guard has one WeCom-specific addition: replies ride the
live authenticated WebSocket (DingTalk's per-session webhooks need no live
connection), so claims pause while the socket is disconnected or not yet
authenticated — an outage must not claim batches it could only settle
`unknown`. A receipt that cannot be reported re-drives on the next tick — never
the send. A
persisted receipt replays on restart; a segment whose send never produced an
outcome settles `unknown`. One delivery's unreportable receipt never aborts
the claimed batch.

Two WeCom-specific decisions:

- **Failure classification.** The SDK's `sendMessage` rejects on a socket
  failure, an ack timeout, a queue overflow, or a receipt frame with non-zero
  `errcode`. The aibot send path has no verified errcode retryability table
  (the SDK documents none), so every send failure classifies as `unknown` —
  re-drivable, never a claimed definitive refusal. Classifying an unverified
  errcode as definitive could settle a rate-limited segment's whole delivery
  `rejected` and never send the rest, the exact failure the DingTalk
  transient-errcode set prevents. The pre-send validation arm (missing chat id
  or a sender the current policy refuses) still reports `rejected`, because
  that refusal is locally provable. A verified errcode table is a follow-up.
- **Provider message id.** The receipt's `providerMessageId` is a locally
  generated UUID, as in DingTalk: the send-msg receipt frame's body shape is
  not verified to carry a provider message id, and a local correlation id is
  what the ledger needs.

A ledger segment can exceed WeCom's per-message markdown budget, so the deps
split it with the shared structure-aware splitter (`splitMarkdown`, target
3,800 UTF-8 bytes, max 20,000 — the Legacy channel's budgets) and send the
chunks in order; one receipt still covers the whole ledger segment. A failure
after some chunks were delivered is `unknown` (the segment is partially
delivered, not never sent), which the all-unknown classification already
guarantees.

### Stream lifecycle

The production deps wrap the SDK client:

- `connect()` resolves only after the SDK's `authenticated` event, bounded by
  a 30-second timeout (the Legacy channel's bound); an auth error or a kick
  before authentication rejects. The first failure surfaces to the operator —
  a bad credential must not report a healthy start that is permanently deaf.
  SDK error text is sanitized before logging (it can carry credential
  material), as the Legacy channel does.
- Readiness tracks **authentication**, not the socket reaching `OPEN`: the SDK
  marks `isConnected` at `OPEN`, before the subscribe acknowledgement, so the
  claim phase consults an authentication flag the deps restore on every
  `authenticated` event and clear on every `disconnected` event. Claiming in the
  open-but-unauthenticated window would send on a socket that may still fail
  authentication.
- The client is configured with infinite reconnect and infinite auth-failure
  retry (`maxReconnectAttempts: -1`, `maxAuthFailureAttempts: -1`): a transient
  disconnect or a mid-session credential rotation heals by retry, mirroring
  the DingTalk deps' forever-retry discipline. The SDK's heartbeat and
  missed-pong detection drive the reconnect.
- A server kick (`event.disconnected_event`, a new connection displaced this
  one) is fatal: reconnecting would displace the new owner in turn. The deps
  notify the adapter through an `onStopped` callback; the adapter logs, marks
  itself `displaced`, stops, and releases the state lock while parked — the kick
  displaced the WebSocket, not the lock (still ours), so a restart of this entry
  can acquire it instead of waiting for SIGTERM. A displaced adapter also skips
  the shared channel row's `disconnect()` on shutdown: the server's disconnect
  has no generation guard, so deregistering would 409 the new owner and drop
  inbound frames WeCom never redelivers. This is deliberately not the
  ownership-loss shape — on compromise the lock belongs to another process and
  is not released, and persisting is suppressed (though the row disconnect is
  skipped on that path too, for the same reason).
- Only `message.text` is forwarded to the adapter. Non-text frames (image,
  voice, file, video, mixed) are dropped with a latched diagnostic naming the
  frame type; media and mixed-text support is a follow-up, not part of this
  slice.

### State

The adapter's locked state mirrors the DingTalk store minus the webhook map:
version, account generation, the instance-refusal streak, the pending claims
(full persisted events, cap 32), the outbound segment ledger (cap 64, the
shared `MANAGED_OUTBOUND_LIMIT`), and the settled dedupe window (cap 256). One
directory per configured entry (channel name + botId) per workspace scope
(`~/.qwen/channels/<workspace-scope>/wecom-<hash>`), the same name+account key
shape the DingTalk store uses. The directory is the connection lock's key — per
configured entry AND per workspace scope — so two instances of the same entry in
the same workspace scope contend for one lock even when they target different
control-plane destinations (WeCom admits one connection per bot and kicks the
other). The same entry run from two workspace scopes (a clone and a worktree
beside it) hashes to different directories and takes independent locks, so both
would connect and WeCom would kick one; one bot entry must therefore run from a
single workspace scope. The ledger file beneath the directory is keyed
separately by the full registration identity (control plane + tenant + channel +
actor + workspace + cwd-relative), so a pending ledger staged under one
registration is never loaded or replayed under another registration of the same
entry. The cost of that isolation is deliberate: an identity change strands the
prior registration's staged claims in the old ledger file — they are not
replayed, because replaying them into the new owner is exactly the
cross-ownership hazard the keying prevents; the control plane's lease
reconciliation settles any already-claimed delivery unknown. Each ledger is a
`0600` file inside the `0700` directory, atomic write + fsync + rename, and a
validator refuses an unreadable or invalid state rather than silently resetting
it. The directory lock
(`proper-lockfile`, a new dependency of the WeCom package) serializes concurrent
managed instances of the entry; two entries sharing a botId get separate
directories and locks (the SDK then admits one connection and kicks the other),
so a duplicated or renamed entry is an operator config concern, not something
the lock merges. The Legacy WeCom channel takes no lock, so the lock does not
arbitrate managed-versus-Legacy. A compromised lock stops the adapter and stops
persisting, as in DingTalk. The reply context carries no bearer capability, so
the on-disk exposure is strictly smaller than DingTalk's persisted session
webhooks.

## Files affected

- `packages/channels/base/src/managed-channel.ts` — the adapter union widens to
  four providers; the control-plane interface gains an optional `destinationKey`
  (the full registration identity a persisting adapter keys its ledger by).
- `packages/core/src/managed-runtime/managed-session-records.ts` — enablement
  list gains `'wecom'`; `managed-channel-record.test.ts` updates its pin.
- `packages/channels/wecom/src/managed-wecom-adapter.ts`,
  `managed-wecom-deps.ts`, `managed-state.ts` (new) — the adapter, its
  production deps, and its persisted state.
- `packages/channels/wecom/src/index.ts` — export the adapter, settings
  parser, deps factory and their types.
- `packages/channels/wecom/package.json`, `pnpm-lock.yaml` — add
  `proper-lockfile` (and its types as a dev dependency).
- `packages/cli/src/commands/channel/managed-channel-command.ts` — the
  `adapterType` union widens.
- `packages/cli/src/commands/channel/managed-channel-client.ts` — the HTTP
  control plane exposes `destinationKey`, binding the full registration identity
  (base URL + tenant + channel + actor + workspace + cwd-relative) the WeCom
  ledger is keyed by; `managed-channel-client.test.ts` pins each ownership field.
- `packages/cli/src/commands/channel/managed-wecom.ts` (new) — the command.
- `packages/cli/src/commands/channel.ts` — register the command;
  `channel.test.ts` and `managed-channel-command.test.ts` pin the registration.
- Collocated tests for each new module; the Legacy WeCom suites stay the
  baseline, unchanged.
- This design doc and its Chinese version.

## Scope boundaries

- No change to the segment ledger, the claim budget, the receipt write-once
  rule, or the partial/unknown recovery — provider-agnostic already.
- No Java control-plane change: the adapter name and the opaque reply context
  are admitted by the existing patterns. Any Java-side provider-specific need
  discovered during implementation is called out before it is added.
- No group-chat policy (the managed path serves private chats only), no
  attachments or media (inbound or outbound), no mixed-text frames, no
  interactive cards or stream replies, no proactive sends or automation.
- The `wecom-callback` (self-built application) and `wecom-webhook` (send-only
  group) connection methods are not managed adapters in this slice; the
  webhook cannot receive inbound at all.
- No egress proxy wiring: both directions travel over the SDK WebSocket, and
  the Legacy WeCom channel has no proxy support either. A proxy-only
  deployment is a follow-up if the need is proven.
- The Legacy `WeComChannel`, `WeComCallbackChannel` and `WeComWebhookChannel`
  are unchanged.
- A definitive send-failure errcode table awaits verified provider semantics;
  until then every send failure is `unknown`.

## Validation plan

- Contract witnesses: the widened union accepts `wecom` and still accepts
  `email`, `dingtalk`, and `github`; enablement admits `wecom` and still refuses
  an unknown adapter; the email, DingTalk, and GitHub suites stay green
  unchanged.
- Adapter witnesses (deps-injected, no live provider), mirroring the DingTalk
  suite: an inbound frame is admitted once and a redelivery replays; a group
  frame, a non-text frame, a frame without `msgid` and a refused sender are
  dropped with their diagnostic; a single-chat frame without `chatid` routes
  on the sender userid; over-long inbound text is truncated to the wire bound;
  a failed save drops the frame and logs the loss (no redelivery arm); a
  multi-segment claim sends each segment in order and receipts each by
  ordinal; a non-accepted segment stops the rest of its delivery; every send
  failure reports `unknown`, never a second send; a persisted receipt replays
  on restart; the deterministic admission refusal, the instance-scoped stall
  (including across a restart) and the registration-refusal re-register each
  red their case; a kick stops the adapter.
- Deps witnesses against a fake SDK client: the auth wait resolves on
  `authenticated` and rejects on timeout/error/kick; only `message.text`
  reaches the adapter; a kick invokes `onStopped`; an over-budget segment is
  split into ordered provider-sized chunks; a disconnected client's send
  fails transient.
- The real-provider leg (authenticated WebSocket inbound + `sendMessage`
  outbound) can be exercised against a `wss://` loopback endpoint speaking the
  aibot frame protocol via the `wsUrl` setting. It is run as a local verification
  rig, not a committed test — every committed suite replaces the provider
  (`vi.mock('@wecom/aibot-node-sdk')` and fake deps), so the SDK-facing decode
  and ack correlation stay the unverified layer Decision 4 admits. A live-tenant
  smoke needs a WeCom intelligent bot credential and is a follow-up, not a merge
  gate.

## Decisions

1. The connection method is the intelligent bot WebSocket (the existing
   `wecom` channel type), confirmed by the maintainer. It is the closest
   analog of the DingTalk stream robot and needs no public endpoint.
2. Replies use the live SDK client's `sendMessage` only; there is no
   `response_url` or passive-reply fallback. The reply context carries
   `{ chatId, senderId, botId }` and no credential.
3. The sender identity is `from.userid`, gated by the email-shaped
   `senderPolicy`. Group frames (`chattype 'group'`) are dropped: the managed
   path serves private chats, and an explicit group policy is a follow-up.
4. Every send failure is `unknown` until a verified errcode retryability table
   exists; the pre-send validation refusal is `rejected`. The receipt's
   `providerMessageId` is a local UUID.
5. Outbound segments larger than the per-message markdown budget are split
   into ordered provider-sized chunks inside the deps (3,800 / 20,000 UTF-8
   bytes, the Legacy budgets); one receipt covers the whole ledger segment.
6. A server kick stops the adapter; transient disconnects and auth failures
   retry forever inside the SDK. The first connect must surface its failure.

## Open questions

None blocking the current scope. A live WeCom intelligent bot credential is
needed for the real-platform smoke; until one is available, real-platform
acceptance remains an explicit gap, as in the DingTalk slice.
