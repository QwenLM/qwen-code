# Managed Channels (H5)

[English](2026-10-04-managed-channels.md) | [简体中文](2026-10-04-managed-channels.zh-CN.md)

Status: slice H5a (the record contract of both domains) is implemented; slices
H5b and H5c remain proposed, and no domain this document names is enabled for
submission. This is the design for slice H5 of
[#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the
Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
It builds on the task contract of H0a
([design](2026-09-27-managed-agent-task-contract.md)), the record contract of
H0b ([design](2026-09-27-managed-extension-record-contract.md)) and the
authority of H0c ([design](2026-09-27-managed-extension-authority.md)). Below,
"the reference design" is sections 1, 3, 6, 11, 12, 13 and 14 of the
proposal's [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md),
whose preamble leaves the field-level contract of Channels to its
[automation design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md),
at the commit that #12827 pins.

## Problem

A Channel is an input/output adapter, not a Session owner (reference design,
section 6). The managed pipeline it must follow is:

```text
platform event → verified/authenticated instance → ingress dedupe identity
  → route binding → attachments staged to Artifacts
  → input + reply intent + wake → Harness computes the formal result
  → channel_delivery outbox → adapter → provider receipt
```

Legacy channels (`packages/channels/*`) run their adapters in the daemon or
CLI process. Routing (`SessionRouter`), sender and group gates, pairing, dedupe
and in-flight tracking live in process memory or in channel-private files
(see the email state store below), none of which survives a control-plane
node replacement and none of which another node can reconcile without
guessing. Section 1 of the reference design makes every asynchronous
capability a durable resource plus a trigger intent, and forbids blind retry
of an unknown side effect. H5 must answer: what identifies an inbound event
so that a redelivery is one input but two identical real messages are two;
how attached bytes reach the model without bypassing the Artifact rules; and
how an outbound reply is delivered, possibly in segments, with receipts that
tell a recovered dispatcher exactly what the provider already has.

## Current state

The facts below are from `main` at `5ddfacc9d4`.

- **Domain index.** `channel_route` and `channel_delivery` are registered in
  the closed v1 domain index of
  `packages/core/src/managed-runtime/managed-session-records.ts`. Registration
  is not enablement: neither has a record body in
  `MANAGED_EXTENSION_RECORD_BODIES` (`managed-extension-projection.ts`),
  neither is in `MANAGED_SESSION_ENABLED_DOMAINS`, and
  `commitExtensionRecord` refuses them.
- **Delivery line.** H0b's run block already carries the states a channel
  delivery needs: target `channel`, with `planned`, `sending`, `partial`,
  `delivered`, `unknown`, `rejected` and `cancelled`. H0c derives the
  outbox from it, the Java store materializes it in Flyway V18 in the
  commit's SQL transaction, and `isExtensionDeliveryPending` is pinned by
  fixtures. Nothing reads the outbox yet; H0c assigns the dispatchers to
  H4 and H5.
- **Wake.** H0c decision 2: no `WakeIntent` record. A revision may commit a
  notification input, and the authority generates its `input.accepted` plus
  `wake.requested` in one transaction. The Session inbox is a user-message
  queue, not a wake carrier.
- **Public contract.** H0a named the Channel resources
  (`GET /v1/agent-channels`, `GET /v1/agent-channels/{channelId}/deliveries`)
  as `planned` in v1.16 and assigned their shapes to H5. Plain channel chat
  keeps using the Session prompt/event API (reference section 11).
- **Java bodies.** The Java store materializes only known bodies; a body H5
  adds must ship on both sides before any writer commits the domain (H0c
  open question 7).
- **Artifact infrastructure.** O2 hosted result storage (#12894) and O3
  public Artifact metadata, range and download routes (V26, contract v1.27)
  are merged, so staged attachment bytes have a durable, authorized home.
- **Legacy adapter inventory.** `packages/channels` holds `base` plus the
  `dingtalk`, `dws`, `email`, `feishu`, `github`, `gitlab`, `plugin-example`,
  `qqbot`, `telegram`, `wecom` and `weixin` adapters, sharing `ChannelBase`
  and `PollingChannelBase` from `@qwen-code/channel-base`.
- **The email adapter (the reference vertical slice).**
  `packages/channels/email` polls IMAP with `imapflow`, parses with
  `mailparser` and sends with `nodemailer` (SMTP, TLS required). Its
  `EmailStateStore` (`state.ts`) keeps, in one locked JSON file:
  `uidValidity` (the IMAP mailbox generation — a change resets the cursor),
  `lastUid`, up to 33 in-flight `pending` UIDs, up to 64
  `outboundPending` Message-IDs, a 1,024-entry `recent` dedupe window of
  SHA-256 digests, and up to 256 reply routes. Startup with uncertain
  in-flight state refuses to start and asks for manual acknowledgement.
  Ingress dedupe is `sha256(sender, NUL, messageId)`, falling back to
  `uidValidity:uid` when a message has no Message-ID; the admitted
  `messageId` is `uidValidity:uid`. Attachments (at most 16 per message)
  land in a per-message temporary directory that is wiped on startup and
  cleaned after the turn. The store directory is keyed by a hash of the
  instance name, IMAP host, port, user, folder and address, so credentials
  never define identity.
- **Prerequisites merged.** Verified on this baseline: H0a–H0c (#12855);
  H1 MCP and H2 Hook bodies, both enabled for submission (V23, V27/V28);
  D4 durable lifecycle (#12881); hosted foreground Shell tool turns behind
  an explicit private profile; W0 workspace binding with generation
  fencing, and durable local-process provisioning on by default with an
  opt-out flag (dedicated Linux reboot acceptance still pending, see
  [W0e](2026-09-27-managed-workspace-recovery.md)).

## Goals

- Define the `channel_route` and `channel_delivery` record bodies on top of
  the H0b run block.
- Pin the ingress dedupe identity: channel instance, account generation,
  platform event ID and semantic revision — so a redelivered event is one
  input, and two real messages with identical text stay two inputs.
- Stage attachments as controlled Artifacts before input admission, with
  defined behavior when admission is uncertain.
- Deliver replies through the `channel_delivery` outbox with per-segment
  (`segmentId`/`ordinal`) receipts, and define partial- and
  unknown-delivery recovery that never re-sends a segment the provider may
  already have.
- Land the email adapter as the reference vertical slice against these
  contracts.
- Fill the `planned` Channel resource shapes H0a reserved for H5.

## Non-goals

- **A second model driver.** A Channel submits inputs and domain results
  only; the reference design (section 1) forbids it from starting a second
  main Agent loop, calling Harness internals, or overriding a reply target
  with the currently selected UI Session.
- **Other adapters.** DingTalk, Feishu, Telegram, WeCom, Weixin, QQ, GitHub,
  GitLab, DWS and the example adapter stay on their Legacy paths in these
  slices. Their interactive cards and streaming segment surfaces are each a
  later adapter slice.
- **Channel-owned Sessions or shared channel context.** Session membership,
  cross-channel context and channel memory are unchanged.
- **Inbound authorization redesign.** Routing follows the authenticated
  instance/account/sender/chat/thread, as the reference design requires;
  sender display names, chat titles and model text grant nothing. The
  Legacy pairing/gate configuration is an adapter source, not a new
  authorization model.
- **H6 automation delivery.** The automation delivery policy that creates
  Channel outbox entries is H6's; H5 defines the delivery contract they
  use.

## Decisions

1. **Two domains.** `channel_route` is the durable route binding: which
   authenticated (instance, account, sender, chat, thread) maps to which
   Session, with its revision. `channel_delivery` is one delivery of one
   formal result, chain-keyed by `deliveryId`, carrying the segment plan
   and per-segment receipts in its revisions. Neither is a Session task, so
   both take `taskKind: null` in `MANAGED_EXTENSION_RECORD_BODIES`, as the
   MCP and Hook bodies do; deliveries appear through the
   `/v1/agent-channels/{channelId}/deliveries` resource, not the task list.
2. **Ingress identity has four parts.** An inbound event dedupes on the
   tuple (channel instance, account generation, platform event ID, semantic
   revision). The account generation makes identities after a provider-side
   re-key incomparable with earlier ones instead of falsely equal — the
   email adapter's `uidValidity` reset is exactly this: a generation change
   restarts the cursor and the dedupe window rather than deduping across
   it. The semantic revision distinguishes a re-parsed or edited occurrence
   of the same platform event; for email it is fixed at `1`, because an
   RFC 822 store is immutable. Two real messages with identical text have
   different platform event IDs and remain two inputs (reference section
   14, item 5); a provider redelivery carries the same tuple and is one
   input.
3. **Attachments become Artifacts before admission.** Inbound bytes are
   staged as controlled Artifacts first, and the admitted input references
   them — the Legacy temporary attachment directory is adapter scratch
   space, not the record. When admission is uncertain (commit outcome
   unknown), the staged bytes are retained and the original `inputId` is
   queried before anything is admitted again, per reference section 6.
4. **Delivery is segmented and receipted.** A reply's delivery plan splits
   into stable `segmentId`/`ordinal` parts; each revision of the
   `channel_delivery` record records which segments the provider provably
   accepted. A recovered dispatcher completes only segments proven unsent;
   `partial` commits the proven subset and the rest stays outstanding. A
   model Turn finishing and external delivery finishing are separate facts,
   shown separately — the delivery line never stands in for the run line
   (reference sections 3.2 and 6).
5. **Unknown means unknown.** Where the provider offers no query API and no
   idempotency key — SMTP without a delivery receipt is the email case — a
   disconnect after sending enters `delivery_unknown` (`unknown` on the
   delivery line): the record says the provider may hold the message, and
   automatic resend is forbidden. An explicit user resend creates a new
   `deliveryId` and surfaces a possible-duplicate warning (reference
   section 6). The email adapter's current startup refusal on uncertain
   in-flight state is the manual form of this rule; the managed path
   commits the `unknown`, keeps the task reconcilable and does not block
   unrelated work.
6. **Account generation rollover is a route revision.** When a provider
   re-keys (email: `uidValidity` changes), the `channel_route` record takes
   a new revision pinning the new generation; in-flight deliveries of the
   old generation keep reconciling against it and can no longer create new
   effects — the same old-generation rule H0b/H0c apply to Runtime
   bindings.
7. **Ordinary chat still enters as Session input.** A routed inbound
   message is admitted to its Session with the H0c mechanism — one
   transaction carrying the input and its wake — and the reply target is
   the route binding's, committed with the input. The adapter that later
   serves the delivery reads the committed target; it cannot substitute the
   UI-selected Session.
8. **The email adapter is the reference vertical slice.** It is the first
   adapter ported because its Legacy state already separates the four
   concepts the contracts need: mailbox generation (`uidValidity`),
   platform event identity (`uidValidity:uid`, Message-ID-based digest),
   in-flight uncertainty (`pending` / `outboundPending`) and reply routes.
   The slice maps these onto `channel_route` and `channel_delivery` facts
   one by one, without inventing provider APIs the code does not show:
   IMAP polling and `uidValidity` come from `imapflow`, Message-ID parsing
   from `mailparser`, and outbound acceptance from nodemailer's SMTP
   `send` result; SMTP provides no delivery query, so outbound is governed
   by decision 5.

## Record bodies (H5a)

Both bodies embed the H0b run block unchanged, both register in
`MANAGED_EXTENSION_RECORD_BODIES` with `taskKind: null` — a Channel
route or delivery is not a Session task — and both stay absent from
`MANAGED_SESSION_ENABLED_DOMAINS`. The byte-level contract lives in
`packages/core/src/managed-runtime/managed-channel-record.ts`, is mirrored
by `ManagedChannelRecords` in `packages/sdk-java/managed-agent-server`, and
is pinned by the shared corpus
`contracts/managed-channel-record-v1.fixtures.json` (92 shape cases and 57
successor cases), which TypeScript and Java replay identically.

- `managed-channel_route` (chain identity `routeId`): closed keys
  `routeId`, `channelInstanceId`, `accountId`, `accountGeneration`,
  `routeRevision`, `rootSessionId`, `sessionId`, `scope`, `policyRef`,
  `run`. The scope carries exactly what the Legacy routing key derives from
  its kind: `user` keys on the sender inside its chat (`senderId` and
  `chatId` set, `threadId` null); `thread` keys on the thread, falling back
  to the chat (exactly one of `threadId`/`chatId` set, `senderId` null);
  `chat_thread` keys on the chat and only refines to one of its threads
  (`chatId` set, `threadId` optional, `senderId` null); `single` keys on
  the instance alone (all three null). The run pins `effectId: routeId` and
  nothing else: no definition, execution, Runtime, dispatch or delivery —
  the binding's lifecycle is the only state.
- Route successor: the identity (`routeId`, `channelInstanceId`,
  `accountId`, `scope`) never changes. At the same `routeRevision` the
  rebind set — `accountGeneration`, `rootSessionId`, `sessionId`,
  `policyRef` — is byte-identical; a rebind or rollover raises
  `routeRevision` by exactly one and may then change the set, except that
  `accountGeneration` never moves backwards (decision 6). A terminal run
  freezes the record.
- `managed-channel_delivery` (chain identity `deliveryId`): closed keys
  `deliveryId`, `routeId`, `routeRevision`, `sourceTurnId`, `contentRef`,
  `segments`, `cancelRequested`, `run`. The segment plan carries 1–64
  segments of `{segmentId, ordinal, contentRef, receipt}` with distinct
  `segmentId`s and ordinals dense from zero; a receipt is
  `{providerMessageId, acceptedAt, proofRef|null}`. The run pins
  `effectId`/`deliveryId` to the chain identity and carries the H0b
  delivery line of target `channel`, nothing else.
- Delivery consistency: the delivery line, the run line and the settled
  receipts agree at every revision — `planned` with the run `admitted` and
  no receipts; `sending` or `partial` with the run in flight (`running`,
  `waiting` or `recovery_blocked`) and, for `partial`, at least one
  receipt settled but still short of full; `delivered` with the run
  `settled` and every receipt set;
  `unknown` exactly with the run `waiting` without a reason (the provider
  may hold the rest); `rejected` with the run `failed`; `cancelled` with
  the run `cancelled` and no receipts. A blocked run blocks only while the
  delivery is provably `sending`/`partial`; given the run pins, the only
  recovery reason that parses is `handler_unavailable`.
- Delivery successor: the plan, the producing Turn and the pinned route
  revision never change; each segment's receipt is set once and never
  rewritten; `cancelRequested` is never revoked. The H0b line steps then
  rule the rest: an `unknown` delivery never returns to `sending` (a
  resend is a new `deliveryId`, decision 5), and a terminal run freezes
  the record, so an already-delivered message cannot be edited after the
  fact, while late receipts that resolve an `unknown` stay commitable. To
  keep that invariant against the two-step path `unknown → partial →
sending`, leaving `unknown` for `partial` itself takes proof: the
  `partial` revision must settle a segment the `unknown` one did not.
- The ingress dedupe tuple of decision 2 is recorded with the admitted
  input (the `input.accepted` content), and a redelivery under a committed
  tuple answers with the original `inputId` without a new turn — the exact
  storage of the dedupe index is an H5b decision, pinned with the email
  slice.

## Slice plan

| Slice      | Scope                                                                                                                                                                                                                                     | Exit gates                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H5a (done) | Record contract: both bodies, validators, fixed-field rules and transition witnesses, with their own `managed-channel-record-v1` fixture corpus; `MANAGED_EXTENSION_RECORD_BODIES` entries; Java replay.                                  | TypeScript and Java produce and refuse identical chains from the fixtures. Both domains stay absent from `MANAGED_SESSION_ENABLED_DOMAINS`; `commitExtensionRecord` still refuses them. The Java store ships the bodies before any writer can commit (H0c open question 7). No production caller constructs either body.                                                                                                                                     |
| H5b        | Email inbound vertical: `channel_route` commitment, ingress dedupe on the four-part identity, attachment → Artifact staging, routed input admission with wake. Domains enabled for submission for this adapter only.                      | A provider redelivery commits one input; two identical-text messages commit two. An admission crash leaves staged bytes retained and the original `inputId` queryable; no event is admitted twice and none is silently dropped. A `uidValidity` rollover takes a route revision and the old generation admits nothing new. The email adapter passes its existing behavioral suite against the managed path.                                                  |
| H5c        | Email outbound vertical: `channel_delivery` commitment, outbox dispatcher, per-send receipts, `partial`/`unknown` recovery, explicit user resend with a new `deliveryId`. Public `/v1/agent-channels` and `.../deliveries` shapes served. | A reply interrupted mid-send resumes with only proven-unsent work; a post-send disconnect records `delivery_unknown` and never auto-resends; an explicit resend warns about possible duplication. Model completion and external delivery are projected separately, and a Channel send failure never re-runs the model (reference section 14, item 6). The two planned routes move to `partial` with their H5-owned shapes, covered by the API contract test. |

Later H5 slices (not scheduled here): a second adapter (chosen by product
priority); card-style segmented surfaces where a provider supports them;
attachment kinds beyond the O2/O3 staging the email slice uses.

## Validation plan

- Fixture parity for both bodies, replayed by TypeScript and by Java (H5a).
- Authority suites for route rollover, replay refusal, chain rebuild and
  the delivery-line affordances: dispatch, partial, `unknown` and its
  no-resend rule (H5a). Cross-record checks — a delivery binding to a
  committed route at its pinned revision — belong to the slice that
  enforces them (H5b/H5c), like MCP's and Hooks' enablement-time checks.
- Java store materialization for the public Channel resources (Flyway
  V47), exercised when H5c serves them.
- Adapter fault injection: redelivery storms, admission-crash windows,
  send-then-disconnect, generation rollover mid-delivery, and dispatcher
  restart between segment receipts — each ends in one input per event or a
  visible `partial`/`unknown`, never a duplicate send.
- Email reference-slice parity: the managed path replays the Legacy
  adapter's recorded behavioral cases (dedupe window, in-flight refusal
  semantics, reply routing) against committed records.
- Mutation checks: each dedupe, transition and recovery rule disabled in
  turn fails a test.

## Acceptance criteria

- Reference section 14, item 5: Channel redelivery forms exactly one input;
  two genuine identical-text messages stay two; a lost outbound ACK never
  causes an automatic second send.
- Reference section 14, item 10: every failure resolves to
  `not_started_proven`, settled, attachable, or `unknown`/`corrupt`, and
  `unknown` never masquerades as success.
- Reference section 11: the Channel resources are served read-only over the
  committed records; no Runtime identity, credential, absolute path or PID
  appears in them.
- Both domains are enabled for submission only in the slice that ships
  their producers, with the contract test proving enablement is explicit
  and adapter-scoped.

## Open questions

1. **Dedupe index retention.** The window and compaction of the ingress
   dedupe index (Legacy: 1,024 digests) relative to Session history
   retention; H5b pins it with the email slice.
2. **Staged-byte quota.** Attachment staging reuses O2 quotas, but the
   per-route staging backlog bound and its refusal behavior are H5b
   decisions.
3. **Credential-bearing configuration.** Route configuration references
   secrets by handle; where the email IMAP/SMTP credential secret handles
   are issued and rotated is a deployment decision outside these slices.
4. **Delivery budgeting.** Whether outbound dispatch gets a delivery-rate
   quota reason beyond H0b's `rate_limit`, or relies on the Session's
   existing budgets, is left to H5c.
