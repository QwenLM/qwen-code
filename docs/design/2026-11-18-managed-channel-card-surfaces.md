# Managed channel card surfaces (H5e)

[English](2026-11-18-managed-channel-card-surfaces.md) | [简体中文](2026-11-18-managed-channel-card-surfaces.zh-CN.md)

Status: implemented in this change for DingTalk interactive cards (private
chat); the live-tenant smoke and card rendering for other adapters stay
separate. This is slice **H5e** of
[#12827](https://github.com/QwenLM/qwen-code/issues/12827), tracked by
[#17716](https://github.com/QwenLM/qwen-code/issues/17716), under the Managed
Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). It
builds on the [H5 design](2026-10-04-managed-channels.md), the
[channel runtime](2026-10-07-managed-channel-runtime.md), the
[multi-segment ledger](2026-11-10-managed-channel-multi-segment-ledger.md), the
[multi-segment producer](2026-11-12-managed-channel-multi-segment-producer.md)
and the [DingTalk adapter](2026-11-13-managed-channel-dingtalk-adapter.md).
The first card-capable provider is DingTalk; every other managed adapter stays
on the text path.

## Problem

A managed channel reply is delivered as 1–64 ordered text segments, one
write-once receipt per segment. None of the four enabled adapters (email,
DingTalk, GitHub, WeCom) renders a delivery as a provider-native card, and none
can edit what it delivered. On the managed DingTalk path the gap is concrete:
each segment is a `sessionWebhook` text message whose `providerMessageId` is a
local `randomUUID()`, so the adapter holds no provider-side handle it could
ever update. DingTalk has a real interactive-card API, and the Legacy channel
already uses it (`DingtalkInteractiveCardClient`), but the managed path does
not.

H5e closes that gap for one provider without inventing a second delivery
source: a card-capable adapter renders one delivery as one card, and the
segments after the first become edits of that card. The segment plan, the
per-segment receipts, the claim budget and the partial/unknown recovery stay
exactly as they are.

## Current state

Facts verified against the merge-base with `main` for this change and
re-checked after each merge of `main` (latest `3612b40420`). Symbol names, not
line numbers, anchor the sites so the census does not drift.

- **The record contract forbids post-hoc edits.** `ChannelDelivery` in
  `packages/core/src/managed-runtime/managed-channel-record.ts` closes the
  segment and receipt key sets; `isChannelDeliverySuccessor` freezes the plan,
  the segment identities and each segment's `contentRef`, and a receipt is
  write-once. The [H5 design](2026-10-04-managed-channels.md) states the rule
  directly: a terminal run freezes the record, "so an already-delivered message
  cannot be edited after the fact". An edit therefore cannot be a record
  revision; it can only be a provider-side update of a surface the delivery
  already owns.
- **Claims are batched.** `HostedChannelSession.claimResult` in
  `packages/cli/src/serve/hosted-channel-session.ts` returns only the leading
  unreceipted segments that fit `MANAGED_CHANNEL_LIMITS.maxClaimTextBytes`
  (512 KiB, under the SDK's 1 MiB JSON cap); the adapter re-claims the rest
  after each receipt. A card that carries the whole reply must accumulate its
  body across claims, and across restarts.
- **The receipt replay is per ordinal.** `HostedChannelSession.receipt` looks
  up `delivery.segments[ordinal]` and answers an already-set receipt unchanged
  when its `providerMessageId` matches. Several segments may therefore share
  one provider handle — the handle of the single card they all render into.
- **The managed DingTalk send** (`ManagedDingtalkAdapter.send`) persists an
  `outbound` entry before each side effect, sends the segment through
  `deps.sendWebhook`, classifies a definitive refusal as `rejected` and an
  ambiguous failure as `unknown`, persists the receipt, reports it, and stops
  the delivery on any non-accepted outcome. The webhook is evicted from the
  cache on a definitive refusal. `reportOrphanedOutbound` replays a persisted
  receipt after a restart and settles `unknown` when no outcome was proved.
- **The card primitives already exist.**
  `packages/channels/dingtalk/src/interactive-card-client.ts` exposes
  `DingtalkInteractiveCardClient.createAndDeliver`
  (`POST /v1.0/card/instances/createAndDeliver`), `updateInstance`
  (`PUT /v1.0/card/instances`, `updateCardDataByKey`) and `openOrUpdateStream`
  (`PUT /v1.0/card/streaming`). It authenticates with
  `x-acs-dingtalk-access-token`, retries once on a 401 after invalidating the
  token, and classifies failures with `DingtalkCardRequestError.retryable` /
  `isRetryableDingtalkCardError`. A direct (non-group) card targets
  `dtv1.card//IM_ROBOT.<userId>` — the Legacy result path passes the sender's
  user id, not the conversation id (`DingtalkAdapter.deliverBackgroundResponseToTarget`).
  The Legacy client is constructed with `robotCode: config.clientId`. The
  access token comes from `https://oapi.dingtalk.com/gettoken`
  (`DingtalkAdapter.getProactiveToken`), cached until `expires_in - 60`, with
  `PERMANENT_TOKEN_ERROR_CODES` separating a dead credential from a transient
  errcode.
- **A card body bound already exists in the package.**
  `status-card-controller.ts` caps rendered card content at `CONTENT_LIMIT =
20_000` UTF-16 units and marks truncation visibly. A ledger segment can be
  48 KiB of UTF-8, and a whole reply up to 64 of them, so a card cannot carry
  every reply.
- **No capability declaration exists on the managed path.** The adapter tells
  the control plane only `platform` and the closed four-key
  `ManagedChannelPolicy` (`adapter`, `senderPolicy`, `allowedSenders`,
  `dispatchMode`); the control plane forwards the policy verbatim and reads
  none of its fields. Enablement lives in
  `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`
  (`packages/core/src/managed-runtime/managed-session-records.ts`), already
  `['email', 'dingtalk', 'github', 'wecom']`.

## Decision

Render the card inside the DingTalk adapter, over the unchanged delivery
contract. One delivery is one card; the first segment creates it and every
later segment edits it. Nothing in the record bodies, the Java control plane,
the OpenAPI document or the claim protocol changes.

### 1. One delivery, one card, segments as edits

For a delivery whose first claimed segment has ordinal 0 and whose text fits
the card body bound, the adapter calls `createAndDeliver` with a deterministic
`outTrackId` and the segment text as the card body. Each later segment appends
its text to the persisted body and calls `updateInstance` with the whole new
body — a full-snapshot edit, not a streaming append. Every segment still gets
its own write-once receipt; a card segment's `providerMessageId` is the
`outTrackId`, the durable provider-side handle that resolves the card for
editing. Text-fallback segments keep today's local `randomUUID()`.

The `outTrackId` is `qwen-managed-` plus the first 32 hex characters of
`sha256(deliveryId)` (45 characters, inside the provider's 64-character
`outTrackId` bound). It is a pure function of the delivery identity, so a
restart re-derives the same handle and never creates a second card for the same
delivery, and a resend — a new `deliveryId` — gets its own card carrying only
the proven-unsent segments. The prefix mirrors the Legacy `qwen-status-` /
`qwen-result-` convention so an operator can recognise the card in the provider
console.

The body is the plain concatenation of the rendered segment texts, with no
added separator: the producer's concatenation invariant (joining the planned
segments reproduces the reply) then holds for the card body too.

### 2. The card body bound, and an honest overflow

The card body is capped at `MANAGED_CARD_CONTENT_LIMIT = 20_000` UTF-16 units,
the bound the Legacy status card already uses. Before a segment is rendered
into the card, the adapter checks whether the accumulated body plus the segment
text still fits. When it does not, the adapter switches that delivery to the
text path for that segment and every segment after it. If a card already
exists, the switch is persisted (`mode: 'text'`) so the whole tail stays text
across a restart; the card keeps the prefix it carries and the tail arrives as
ordinary `sessionWebhook` text messages. If segment 0 alone is too large, no
card is created and the delivery is text from the start — there is no card
progress to persist. Each segment still receives exactly one truthful receipt.

This is a rendering fallback inside one delivery, not a second delivery
source: the same `deliveryId`, the same ledger, the same claim/resume protocol.
The alternative — truncating the card body while receipting every segment as
delivered — would make the receipts claim content the user never saw, so it is
rejected.

### 3. Card progress is persisted state, and its absence means text

`ManagedDingtalkState` gains an optional `cards` map keyed by `deliveryId`:
`{ outTrackId, body, mode: 'card' | 'text' }`, bounded at
`MANAGED_CARD_PROGRESS_LIMIT = 64` entries with least-recently-touched eviction
(the `touchWebhook` discipline: delete, redefine as an own enumerable key,
evict the first key over the bound). The map is written in the same atomic
`persist()` that writes the `outbound` entry, before the card side effect.

The send decision reads only this map and the segment ordinal:

| Situation                                           | Surface                      |
| --------------------------------------------------- | ---------------------------- |
| ordinal 0, no progress, text fits the bound         | create the card              |
| ordinal 0, no progress, text over the bound         | text (no card)               |
| progress `mode: 'card'`, accumulated text fits      | edit the card                |
| progress `mode: 'card'`, accumulated text overflow  | text, persist `mode: 'text'` |
| progress `mode: 'text'`                             | text                         |
| ordinal > 0, no progress (evicted or never created) | text                         |

The last row is what makes eviction safe: a delivery whose progress was evicted
never re-creates a card under an `outTrackId` the provider may already hold —
its remaining segments simply arrive as text.

Progress is pruned as soon as the delivery is provably terminal, so a completed
delivery does not retain its reply body on disk until 64 newer card deliveries
evict it (the state file is re-stringified and fsynced on every persist). A
non-accepted receipt prunes immediately. An accepted receipt prunes when the
control plane's answer reports the delivery `delivered`: `receipt` now surfaces
the settled delivery view (the Java endpoint already returns it; the TS client
previously discarded it), and the adapter prunes on `delivered` while keeping
progress on `partial`. The orphan re-drive prunes on a terminal settle too. A
restart resumes accumulation from the persisted body; a persisted receipt
replays, an unproved card segment settles `unknown`, and neither ever issues a
second create or update.

### 4. An adapter declares card support; configuration gates it

`packages/channels/base/src/managed-channel.ts` gains
`ManagedChannelCapabilities { cards: boolean }`. `ManagedDingtalkAdapter`
exposes `readonly capabilities: ManagedChannelCapabilities = { cards: true }`;
the other adapters declare nothing and keep the text path by construction.
DingTalk's declaration is a fixed `true`, so the gate's `cards: false` arm is a
contract/test seam (witnessed by mutating the declaration), not a production
toggle — it is the seam a future non-card adapter would use.

Card mode engages only when all three hold: the adapter declares `cards`, the
channel config carries a non-empty `cardTemplateId`, and the deps provide
`sendCardSegment`. The template id is an operator-authored card template whose
markdown component binds the `content` variable; it is read from the channel
config beside `clientId` / `clientSecret` and parsed by reusing
`validCredential` (trim; reject a non-string, an empty value, or CR/LF/NUL), so
the credential rule hardens in one copy. Without a usable id the adapter is
byte-for-byte on today's text path. A configured-but-unusable id is announced
once at construction (the fact, not the value) so "cards never appear" has a
diagnosable cause; the refusal stays non-fatal. `cardTemplateId` is declared in
the DingTalk plugin's `management.fields` (so a channel editor or settings-API
client can set it) **and** in `envResolvableConfigFields` (so the runtime
resolves a `$VAR` reference). Both lists must name it: the store keys on
`management.fields[].envResolvable` while `parseChannelConfig` resolves only
`envResolvableConfigFields` plus the known credential fields, so a field in only
the first list would reach the card API as an unresolved literal and every reply
would be terminally rejected.

The capability declaration is consumed by the send gate itself, and a witness
pins that an adapter with `cards: false` stays on text even with a template
configured and card deps present — the declaration is a gate, not decoration.

### 5. One new dep, reusing the Legacy card client

`ManagedDingtalkAdapterDeps` gains one optional member:

```ts
readonly sendCardSegment?: (input: {
  outTrackId: string;
  templateId: string;
  target: { chatId: string; isGroup: boolean };
  body: string;
  create: boolean;
}) => Promise<void>;
```

`createManagedDingtalkDeps(proxy?, credentials?)` supplies it when credentials
are given: a `DingtalkInteractiveCardClient` with `robotCode =
credentials.clientId` (the Legacy construction), a cached `gettoken` provider
mirroring `getProactiveToken` (refresh at `expires_in - 60` with a 60-second
floor, permanent errcodes definitive), and `create` selecting `createAndDeliver`
versus `updateInstance`. The target is `{ chatId: replyContext.senderId,
isGroup: false }`: the managed path admits private chats only (group frames are
dropped on ingress), and a direct card targets the user id.

The managed client opts into `strictResponses`, a new option on the card client
that Legacy callers leave off (their tolerant behaviour is unchanged). A
receipt is write-once, so "the client did not throw" is not proof of delivery:
in strict mode an unparseable 200 body throws (ambiguous), and a
`createAndDeliver` answer with no `deliverResults` entry reporting success
throws (ambiguous) — `createAndDeliver` has a delivery step that can fail
independently of the HTTP 200. An edit with a readable 200 body is accepted.
Failure classification then mirrors the webhook send: a non-retryable
`DingtalkCardRequestError` (or a permanent token errcode) is definitive →
`rejected`; a retryable status, a network failure, a timeout or an unreadable /
unconfirmed answer is ambiguous → `unknown`. The adapter's existing arm stops
the delivery and leaves the remaining segments server-side, exactly as a failed
text send does. A failed or ambiguous edit never triggers an automatic second
send, and an undelivered card is never receipted `accepted`.

Proxy-only egress is honored: when a proxy is configured, both the token fetch
and the card calls go through a per-call `EnvHttpProxyAgent` dispatcher, the
shape `sendWebhook` already uses. Because `fetch` resolves on the response
headers while both callers read the body afterwards, the wrapper buffers the
body (`arrayBuffer`) and returns a dispatcher-free `Response` before destroying
the dispatcher — destroying first would abort every proxied body read
(`UND_ERR_DESTROYED`). The card client takes a `fetch` option, so the dispatcher
is injected without touching the Legacy client.

`TOKEN_API` and `PERMANENT_TOKEN_ERROR_CODES` become exports of
`DingtalkAdapter.ts` so the managed token provider and the Legacy one share one
copy of the load-bearing errcode set. This is an additive export; no Legacy
behavior changes.

### 6. What an edit is not

There is no new operation kind, no new record revision, no `edit` route on the
trusted or public surface, and no change to the successor rules. "Edit" in
this slice means the provider-side update of the card a delivery already owns,
issued through the same claim → send → receipt pipeline as a send, under the
same at-most-once and `unknown` discipline. Editing a settled delivery record
remains forbidden by the H5 contract, and a public edit/resend mutation stays
the API slice's work.

## Files affected

- `packages/channels/base/src/managed-channel.ts` — `ManagedChannelCapabilities`
  and the `receipt` return widened from `void` to the settled delivery view, so
  the adapter can prune a completed delivery's card progress. Type-only changes
  exported from the base index; exercised by the DingTalk and CLI suites (no
  separate base runtime test is added).
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts` — the capability
  declaration, the `cardTemplateId` config parse (reusing `validCredential` and
  announcing a configured-but-unusable id once), the card send gate and loop,
  the overflow fallback, progress touch and pruning (on a `delivered` receipt
  and on a terminal orphan settle), the card-refusal-does-not-evict-webhook
  guard, the `outTrackId` derivation and the body bound.
- `packages/channels/dingtalk/src/managed-state.ts` — the optional `cards` map,
  its validator clause and `MANAGED_CARD_PROGRESS_LIMIT`.
- `packages/channels/dingtalk/src/managed-dingtalk-deps.ts` — `sendCardSegment`,
  the cached token provider, and the proxy egress wrapper that buffers the
  response body before destroying the per-call dispatcher.
- `packages/channels/dingtalk/src/interactive-card-client.ts` — the opt-in
  `strictResponses` option (an unreadable or unconfirmed answer is ambiguous);
  Legacy callers stay tolerant.
- `packages/channels/dingtalk/src/DingtalkAdapter.ts` — additive exports of
  `TOKEN_API` and `PERMANENT_TOKEN_ERROR_CODES` only.
- `packages/channels/dingtalk/src/index.ts` — the `cardTemplateId` management
  field, so a channel editor / settings-API client can enable cards.
- `packages/cli/src/commands/channel/managed-dingtalk.ts` — pass the parsed
  credentials to the deps factory.
- `packages/cli/src/commands/channel/managed-channel-client.ts` — `receipt`
  surfaces the control plane's settled delivery view instead of discarding it.
- Collocated tests for the adapter, state, deps, card client, command and
  channel-settings store.
- This design in both languages; the H5e follow-up row in the channel runtime
  design in both languages.

## Scope boundaries

- No new adapter, and no card rendering for email, GitHub or WeCom — they keep
  the text path unchanged.
- No change to the record bodies, the closed key sets, the successor rules, the
  Java control plane, the SQL schema, the OpenAPI document or its version, the
  claim budget or the receipt write-once rule.
- No streaming card updates (`openOrUpdateStream`): a full-snapshot
  `updateInstance` per segment is the edit primitive. No card callbacks,
  buttons or actions — rendering only.
- No group cards: the managed DingTalk path admits private chats only.
- No attachment kinds beyond inline staging, no proactive sends, no H6
  automation delivery, no public resend mutation, no WebShell mirror routes.
- No change to how the model is driven, and no Legacy behavior change.

## Validation plan

All witnesses are deps-injected; no live provider is a merge gate, mirroring
the DingTalk adapter slice.

- **Card loop witnesses** (`managed-dingtalk-adapter.test.ts`): a configured
  single-segment delivery creates one card and receipts it with the
  `outTrackId`; a multi-segment delivery creates once and edits per later
  segment with the accumulated body, one receipt per ordinal; the concatenation
  of the rendered bodies reproduces the reply; an over-bound segment 0 sends
  text and creates no card; an overflow at segment k switches the tail to text
  and persists `mode: 'text'`; a restart resumes the accumulated body and edits
  the same `outTrackId`; an evicted progress sends the tail as text and never
  re-creates the card.
- **Discipline witnesses**: a definitive card refusal receipts `rejected` and
  stops the delivery; an ambiguous failure receipts `unknown`; neither issues a
  second create or update; a persist failure before the side effect abandons
  the delivery to the lease reconciler and rolls back both the outbound entry
  and the card map; an orphaned card segment replays its persisted receipt or
  settles `unknown`; a non-accepted receipt prunes the progress; a `delivered`
  receipt prunes the completed delivery's body while a `partial` receipt keeps
  it; a definitive card refusal does not evict the cached `sessionWebhook` (the
  card API's verdict is not the webhook's health).
- **Gate witnesses**: no `cardTemplateId` → text path byte-for-byte;
  `cards: false` with a template and card deps → text path; card deps absent →
  text path; a resend delivery derives a different `outTrackId`; a
  configured-but-unusable template id is announced once and stays on text.
- **Dep witnesses** (`managed-dingtalk-deps.test.ts`): `create` hits
  `createAndDeliver`, an edit hits `PUT /v1.0/card/instances` with
  `updateCardDataByKey`; the target is `IM_ROBOT.<senderId>`; the token is
  cached, refreshed a minute early (witnessed at `expires_in - 60 ± 1s`), the
  60-second floor keeps a short `expires_in` from caching an already-expired
  token, invalidated on a 401 and retried once; a permanent token errcode is
  definitive and a transient one is not; the proxy dispatcher is used when
  configured and destroyed only after the response body is consumed (a
  streaming body that errors once the dispatcher is destroyed pins the
  ordering).
- **Strict-response witnesses** (`interactive-card-client.test.ts` and deps):
  Legacy (non-strict) resolves on a non-JSON 200 body and a missing
  `deliverResults`; strict throws ambiguous on an unreadable body, a missing or
  empty `deliverResults`, and resolves only on a confirmed success; an edit
  with a readable body resolves and an unreadable one throws.
- **State witnesses** (`managed-state.test.ts`): a state without `cards` still
  validates (backward compatibility); the map bound and the entry shape are
  enforced; an over-bound or malformed map is refused. The adapter bound test
  asserts eviction identity (the least-recently-touched entry is evicted, the
  freshest survives) and that a re-touched delivery survives, not just
  cardinality.
- **Settings witnesses** (`channel-settings-store.test.ts`): a DingTalk config
  carrying `cardTemplateId` upserts (it was refused as not manageable before the
  field was declared), the descriptor appears in the channel catalog, and a
  changed value upserts too.
- **Mutation checks**: removing the capability gate, the template gate, the
  overflow check, the persist-before-effect, the deterministic `outTrackId`,
  the eviction-safe text fallback, the progress pruning, the rollback snapshot
  copy, the card-refusal webhook guard, the delivered-prune, the proxy
  body-before-destroy ordering, the strict-response verdict, the token
  early-refresh / floor, or the eviction identity each reds its witness.
- **Baseline**: the existing DingTalk managed suites, the channel-base contract
  suite, the core record/operations/authority suites and the CLI funnel suites
  stay green unchanged; `npm run build && npm run typecheck && npm run lint`.

## Acceptance criteria

- A card-capable, configured adapter renders one delivery as one provider-native
  card; the segments after the first are edits of that card.
- Segment receipts remain authoritative and write-once; a card segment's
  `providerMessageId` is the provider-side edit handle.
- Partial and `unknown` behavior is unchanged: a lost acknowledgement never
  causes an automatic second send, and a failed or ambiguous edit resolves
  visibly (`rejected` / `unknown`) without a retry.
- An adapter without the declaration or the template keeps today's text
  behavior byte-for-byte.
- Overflow is visible and complete: the card carries the prefix it can hold and
  the tail arrives as text, with one truthful receipt per segment.

## Open questions

1. **Template authoring.** The operator must create a card template binding a
   markdown component to `content`. Whether the project ships a reference
   template definition (and how it is versioned) is a product decision outside
   this slice.
2. **Card metadata in the public read model.** Exposing the card handle or a
   rendering mode on `PublicChannelDeliverySegment` would need closed-key,
   Java, SQL and OpenAPI work with a contract version bump; it is deliberately
   not here.
3. **Streaming and finalize.** A streaming card surface (typing indicator,
   incremental append) needs a last-segment signal the claim protocol does not
   carry today; full-snapshot edits avoid it.
4. **Group cards.** The managed path drops group frames; a group card policy
   rides the group-admission follow-up, not this slice.
