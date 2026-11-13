# Managed channel second adapter: DingTalk (H5d)

[English](2026-11-13-managed-channel-dingtalk-adapter.md) | [简体中文](2026-11-13-managed-channel-dingtalk-adapter.zh-CN.md)

Status: proposed. This is the second-adapter part of slice **H5d** of
[#12827](https://github.com/QwenLM/qwen-code/issues/12827). The multi-segment
producer half landed in #17002; the per-segment ledger it feeds landed in
#16797 and was hardened by #16818. This slice puts a second real provider on
the managed path so the multi-segment delivery capability is exercised beyond
email. The provider is DingTalk, chosen by product priority.

## Problem

The managed channel path has exactly one adapter, email. The route policy's
`adapter` and the control-plane `platform` are the literal `'email'`, and the
enablement list is `['email']`. The shared adapter contract
(`ManagedChannelPolicy`, `ManagedChannelControlPlane`, `ManagedInboundEvent`,
`ManagedClaimedDelivery`, `ManagedReceipt`) is defined inside the email package
and imported from there by the CLI's HTTP client. A second provider therefore
needs both a new adapter and a small generalization of that contract so two
packages can share it without one depending on the other.

## Current state (what is already generic)

The investigation found the control plane is already provider-agnostic, so this
is primarily a TypeScript slice:

- The Java `RegisterRequest.adapter` is validated by the pattern
  `[a-z][a-z0-9-]{0,63}` (not an email enum); `platform` is a bounded string;
  the reply context is adapter-opaque JSON echoed back on claim. There is no
  Java-side adapter enablement gate — enablement lives in the TypeScript core
  (`MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`).
- `ManagedClaimedDelivery.segments[]` and `ManagedReceipt` (accepted with
  `ordinal`/`providerMessageId`/`acceptedAt`, or `unknown`/`rejected`) are
  already multi-segment ready; the claim is budgeted by `maxClaimTextBytes`
  (#17002) and the adapter re-claims the remainder after each receipt.
- The DingTalk package already depends on `@qwen-code/channel-base` and
  `dingtalk-stream-sdk-nodejs`; the Legacy `DingtalkChannel` shows the provider
  mechanics (stream inbound; `conversationId → sessionWebhook` outbound).

## Decision

Add a managed DingTalk adapter beside the email one, and lift the shared
adapter contract into `channel-base` so both providers and the CLI share it.

- **Shared contract → `channel-base`.** Move `ManagedChannelPolicy`,
  `ManagedChannelControlPlane`, `ManagedInboundEvent`, `ManagedClaimedDelivery`
  and `ManagedReceipt` out of the email package into a `managed-channel` module
  in `channel-base`. Widen the `adapter`/`platform` literal `'email'` to the
  union `'email' | 'dingtalk'`. The email package and the CLI HTTP client import
  from `channel-base`; behavior is unchanged for email. The inbound event's
  reply context stays adapter-opaque (`unknown`); each provider defines its own
  reply-context shape.
- **Enablement.** Add `'dingtalk'` to `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`.
  The Java pattern already admits it; no Java change is required for the name.
- **`ManagedDingtalkAdapter`.** A deps-injected adapter mirroring the email
  adapter's discipline: every claim persists before its side effect, a restart
  replays the same event or reports the same segment `unknown`, never a second
  input or a second send. Inbound arrives over the DingTalk stream client
  (`dingtalk-stream-sdk-nodejs`); one message becomes one platform event the
  control plane admits. Outbound sends each claimed segment to the conversation's
  `sessionWebhook` and receipts it by ordinal; a multi-segment answer is several
  ordered messages, and an interrupted send resumes only the proven-unsent
  segments via the existing partial/resume protocol.
- **Identity and scope.** The route scope is `chat_thread` keyed by the DingTalk
  `conversationId`; the sender identity is the staff/sender id. The reply context
  carries what a reply needs (conversation id, the session webhook, sender and
  robot identity), committed with the input and echoed by the outbox.
- **Command.** A `managed-dingtalk` CLI command wires the adapter to
  `HttpManagedChannelControlPlane`, mirroring `managed-email`.

### Delivery and receipt discipline (outbound unchanged from email)

The adapter never drives a model. Inbound is admitted by the control plane
(route binding + input + wake in the Session journal); the reply returns through
the receipted outbox the adapter pulls. Each segment's send result is persisted
before its receipt, so a crash between send and receipt replays as `unknown`,
never a duplicate send. The claim budget and re-claim protocol from #17002 apply
unchanged.

One inbound divergence from email is load-bearing. Email's pending claim stores
only the message UID, because the mailbox can re-serve that message after a
restart. The DingTalk stream acks each message on receipt and never redelivers
it, and there is no mailbox to re-fetch from — so the pending claim persists the
full inbound event. A restart re-drives that exact persisted event; it must not
drop an admission it can no longer rebuild.

Inbound text is clamped to what the wire admits before it is submitted — at most
32,000 characters and the Harness's 64 KiB byte envelope, with the byte cut on a
code-point boundary — the same clamp the email reference applies. An over-long
message is therefore admitted truncated instead of meeting a deterministic
refusal and being dropped whole. A CJK message can sit under the character line
yet overflow the byte envelope, so both bounds are enforced.

The reply context's `sessionWebhook` is a bearer capability. Restart durability
requires persisting it with the state (a `0600` file inside a `0700` directory),
where the Legacy channel held it only in an in-memory map. That on-disk exposure
is new relative to Legacy and is the price of the ack-once re-drive.

## Files affected

- `packages/channels/base/src/managed-channel.ts` (new) — the shared adapter
  contract, widened to the two-provider union; exported from the base index.
- `packages/channels/email/src/managed-email-adapter.ts`, `managed-state.ts` —
  import the shared contract from `channel-base`; email behavior unchanged.
- `packages/cli/src/commands/channel/managed-channel-client.ts` — import the
  contract from `channel-base`.
- `packages/core/src/managed-runtime/managed-session-records.ts` — enablement
  list gains `'dingtalk'`.
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts`,
  `managed-dingtalk-deps.ts`, `managed-state.ts` (new) — the adapter, its
  production deps, and its persisted state.
- `packages/cli/src/commands/channel/managed-dingtalk.ts` (new) — the command.
- Collocated tests for each; the channel service/contract suites stay the
  baseline.
- This design doc and its Chinese version.

## Scope boundaries

- No change to the segment ledger, the claim budget, the receipt write-once
  rule, or the partial/unknown recovery — they already handle 1–64 segments and
  are provider-agnostic.
- No Java control-plane change is required for the adapter name or the opaque
  reply context; any Java-side provider-specific need discovered during
  implementation is called out before it is added.
- No DingTalk interactive/card surfaces (H5e), no attachment kinds beyond inline
  staging (Media), no proactive sends or automation (H6).
- The Legacy `DingtalkChannel`'s behavior is unchanged; the only Legacy edit is
  extracting the connect-logging credential guard into a shared module so it has
  a single copy. The managed adapter is a separate implementation that reuses the
  provider mechanics, not the Legacy class.

## Validation plan

- Contract witnesses: the widened union accepts `dingtalk` and still accepts
  `email`; enablement admits `dingtalk` and still refuses an unknown adapter;
  email's existing suites stay green unchanged after the contract move.
- Adapter witnesses (deps-injected, no live provider): an inbound message is
  admitted once and a redelivery replays; over-long inbound text is truncated to
  the wire bound rather than dropped; a multi-segment claim sends each segment in
  order and receipts each by ordinal; a non-accepted segment stops the rest of
  its delivery; a failed send reports `unknown`, never a second send; a persisted
  receipt replays on restart rather than settling `unknown`; the deterministic
  admission refusal, the instance-scoped stall (including across a restart) and
  the registration-refusal re-register each red their case. Resuming the
  still-unsent segments after an interruption is the control plane's
  partial/resume re-claim (#17002), unchanged here. Each rule disabled in turn
  reds its case.
- The real-provider leg (stream inbound + sessionWebhook outbound) is exercised
  against a fake DingTalk endpoint in the deps, mirroring the email adapter's
  fake-transport tests; a live-tenant smoke is a follow-up, not a merge gate.

## Open questions

1. Whether the DingTalk reply should use the session webhook only, or fall back
   to the robot `groupMessages/send` / `oToMessages/batchSend` API when the
   webhook expires, is decided during implementation against the provider's
   webhook lifetime; the design keeps the send behind the deps so either is a
   localized change.
2. Group @-mention gating and the sender allowlist reuse the email adapter's
   `senderPolicy` shape; the exact DingTalk identity space (staffId vs senderId)
   is pinned during implementation.
