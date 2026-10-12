# In-band retraction for managed mid-stream model retries

[English](2026-10-04-managed-midstream-retry-retraction.md) | [简体中文](2026-10-04-managed-midstream-retry-retraction.zh-CN.md)

Status: proposed. Fixes #13319 (parent #12380 / Stage G #12952), the in-band
sibling of the G1 failover work in
[2026-09-30-hosted-turn-failover-e2e](2026-09-30-hosted-turn-failover-e2e.md).

## Problem and scope

A model retry that lands after the first published chunk glues the orphaned
prefix into the public transcript of a managed-agent Turn. Reproduced
deterministically on the packaged stack (fake OpenAI gateway + MySQL +
managed-agent-server jar + `dist/cli.js` Hosted Harness): the gateway drops
the model stream after its first published chunk, the CLI retries, the retry
succeeds, and the Turn completes with the retracted attempt's prefix glued to
the retry's full text — e.g. `MIDSTREAM_PARTIALMIDSTREAM_RECOVERED_AFTER_RETRY`
as one visible answer.

Root cause chain:

1. `packages/core/src/core/llm-chat.ts` — once answer text has been delivered,
   the transport retry loop takes the continuation arm (#7832): it keeps the
   delivered text, asks the model to resume from it via two synthetic turns,
   and yields `RETRY` with `isContinuation: true`.
2. `packages/cli/src/serve/hosted-harness-model.ts` — a `Retry` event with
   `isContinuation: true` deliberately keeps the text buffer and keeps
   publishing deltas under the same message id. Only a non-continuation
   `Retry`/`ModelFallback` after publication throws `Hosted Harness cannot
retract a published model attempt.`
3. `packages/cli/src/serve/hosted-text-deltas.ts` — every chunk commits as an
   append-only activation-scoped `message.delta` journal event; there is no
   retraction API.
4. `HarnessEventProjector.java` — `agent_message_chunk` projects to
   `item.output_text.delta` append-only. The `stream.reconciled` retraction
   machinery (`ManagedAgentStore.retractContinuationOutput`) covers only the
   Harness crash-recovery path, keyed by the dead owner's
   `harnessBootId:eventEpoch:` source prefix; an in-band retry shares the live
   boot and epoch, so nothing can retract its prefix.

The continuation contract — the provider resumes from the partial output it is
shown — holds for well-behaved providers, and small replayed overlaps are
stripped when attempts fold into history. But when a transient capacity event
routes the retry to a backend that answers with a fresh full answer, the
harness cannot distinguish a perfect continuation from a restart: both append.
The duplication then lands in the public feed, the committed message, and the
model's own history alike.

## Current state

- The G1 design recorded the harsher shape as a known follow-up: a
  non-continuation retry or fallback after the first streamed chunk fails the
  Turn terminally, and classifying that settlement as retryable was deferred.
- The packaged-stack reality for the continuation arm is milder for the Turn
  and worse for the user: the Turn completes and the transcript silently
  carries the duplicated prefix.
- The fallback chain in `llm-chat.ts` is gated on `!streamYieldedAnyChunk`, so
  a `ModelFallback` event after published content cannot fire from the primary
  path today; the Harness-side throw for it is defense in depth.
- `stream.reconciled` is already part of the public contract: the OpenAPI
  descriptions and the Web Shell projector both handle it — clients reload
  items and resume after the snapshot. No public API change is needed.

## Goals and non-goals

Goals:

- After a mid-stream cut that already published text, the Turn completes with
  the public transcript showing only the recovered text
  (`clean-retry-recovery`: `turn.completed` and exact-equality visible text).
- The behavior is correct for both provider behaviors: a fresh full answer
  (restart) and a continuation tail — because the retry no longer asks for a
  continuation at all once output is published.
- Both `Retry` (continuation and fresh-restart arms, including the rate-limit
  arm, which has no content gate) and `ModelFallback` events are covered.
- Crash recovery, takeover, and the interactive CLI path keep their current
  behavior.

Non-goals:

- Turn-level retryable settlement (the G1 follow-up's other shape). The Turn
  never settles for a retried mid-stream cut under this design, so no new
  coordinator settlement classification is introduced.
- Changing the interactive CLI's continuation behavior: the continuation arm
  remains the default for consumers that can keep their text buffer.
- Retracting anything other than the current in-flight assistant message's
  text/reasoning deltas (earlier committed rounds of a tool Turn stay).

## Proposed solution

A post-publication retry becomes a fresh replay plus an in-band retraction of
the published prefix, across four layers.

### 1. Core: opt-in replay-after-delivery (`llm-chat.ts`)

`LlmChatSendOptions` gains `retractDeliveredOutputOnRetry?: boolean`. When
set:

- The continuation arm is skipped entirely: a consumer that retracts on a
  fresh retry has no use for resume-from-prefix semantics, and a restart
  glued onto a published prefix is exactly the failure being fixed.
- The replay arm admits a cut that already delivered content: the gate
  `!streamYieldedContentChunk && transportContinuationText.trim().length === 0`
  is bypassed when the flag is set. The replay pops the pending partial
  assistant turn and re-sends the original request, so the model returns a
  full fresh answer and the caller retracts what it published.

The flag is threaded `SendMessageOptions` (client.ts) → `Turn` constructor →
`Turn.run` → `chat.sendMessageStream`. Only the Hosted Harness sets it;
interactive consumers are unchanged.

### 2. Harness: retract the published prefix (`hosted-text-deltas.ts`, `hosted-harness-model.ts`)

`HostedTextDeltaStream` records the journal sequence of the current message's
first committed delta and gains `retract()`:

- Journals an activation-scoped `message.retracted` event (new kind in
  `managed-session-records.ts`: payload `{messageId, turnId, fromSequence}`,
  actor class `harness`) with command id
  `assistant-retract:<turnId>:<messageId>`.
- Resets the stream (new message id, ordinal, first-sequence) so the replay
  publishes under a fresh identity.

`hosted-harness-model.ts`: a `Retry` with `!isContinuation` or a
`ModelFallback` that arrives after publication now retracts and resets the
text buffer instead of throwing `Hosted Harness cannot retract a published
model attempt.` A `Retry` with `isContinuation: true` keeps the existing
append behavior (it can no longer be produced on Harness sends, but the arm
stays correct for any future caller).

### 3. Harness stream: carry the retraction (`hosted-harness-session.ts`)

`eventEnvelope` maps `message.retracted` to a new SSE event
`type: 'message_retracted'` carrying `promptId` (so the coordinator's per-Turn
filter accepts it), `turnId`, `messageId`, and `fromSequence`. The SSE `id`
remains the journal sequence, so the event occupies a well-defined position
after every delta it retracts.

### 4. Server: in-band retraction (`HarnessCoordinator.java`, `ManagedAgentStore.java`)

`HarnessCoordinator.consumeStream` gains a `message_retracted` branch: flush
the pending text-delta batch first (the range must cover deltas already read
from the stream), then call the store.

`ManagedAgentStore.retractHarnessTurnOutput(tenant, session, turn, owner,
eventEpoch, fromSourceId, retractionSourceId)` runs in one
transaction, mirroring `retractContinuationOutput`'s discipline, with the boot
prefix derived from the session's current `harnessBootId` inside the
transaction:

- Validate the dispatch lease and that `eventEpoch` still equals the Turn's
  `harnessEventEpoch` (a recovery admission mid-flight fails the call).
- Idempotency key
  `reconcile:inband:<bootId>:<eventEpoch>:<turnId>:<fromSourceId>` — a
  redelivered retraction (crash-recovery replay re-sends unconsumed journal
  events under a new epoch, where the key differs and the retracted deltas
  were re-published and must retract again) is safe.
- Blank `text` and drop `item_id`/`content_part_id` on the Turn's
  `item.output_text.delta` / `item.reasoning.delta` events whose source key
  lies in the live `bootId:eventEpoch:` namespace with a numeric source id
  `>= fromSourceId` — exactly the current in-flight message's published
  output; earlier committed rounds carry smaller source ids and stay.
- Reassign item identities from the first retracted sequence, delete derived
  item/part/snapshot projections, reset the message-projection consumer
  progress, and append a public `stream.reconciled` event so clients reload —
  the same public shape crash recovery already produces.
- Advance the Harness cursor past the retraction event in the same
  transaction, so a crash cannot double-apply it.

## Design decisions and rationale

- **Fresh replay, not continuation, after publication.** A continuation tail
  is only correct when the provider honors the resume instruction; a restart
  and a perfect continuation are indistinguishable to the consumer. Replaying
  the original request yields a full answer under every provider behavior, and
  retraction removes the orphaned prefix. The continuation arm stays for
  consumers that never publish (interactive UI).
- **In-band retraction, not coordinator Turn retry.** A coordinator retried
  Turn would need a new no-tool parked-Turn recovery path (today's continue
  route requires a `results_ready` tool checkpoint) and would leave the
  Harness journal settled-error while the store keeps the Turn running — the
  cross-system inconsistency the recovery machinery exists to avoid. The
  in-band Turn never settles, and the public correction reuses the proven
  `stream.reconciled` contract.
- **Range keyed by journal sequence, not message id.** Public delta events do
  not carry the Harness message id, and minting one into the public shape
  would change the API. The SSE source id already is the journal sequence;
  `fromSequence` selects exactly the current message's deltas because a
  message's deltas are contiguous and a retry only happens mid-message.
- **`ModelFallback` covered symmetrically.** The chain cannot currently fire
  after publication, but the Harness handling no longer assumes that: a
  post-publication fallback retracts and resets instead of failing the Turn.
- **Journal compatibility follows the G1 policy.** A journal containing
  `message.retracted` events cannot be opened by an older Harness build
  (`managed_session_open_failed`), same as `message.delta`: upgrade the fleet
  before enabling Hosted Workspace turns, or gate rollback.

## Constraints and risks

- The replay budget (`STREAM_RETRY_CONFIG.maxRetries`) now also bounds
  post-publication cuts; exhaustion ends the Turn with the original error, as
  before for non-continuable cuts.
- A replay is a full re-ask: for a long generation cut near the end this costs
  one extra full answer's tokens and latency. Correctness of the durable
  public transcript takes precedence over the continuation optimization in the
  hosted path.
- Between the re-published deltas of a replayed recovery stream and the
  re-delivered retraction event, the orphaned prefix can transiently reappear
  under a new epoch after a Harness crash; the following `stream.reconciled`
  corrects it, as crash recovery already does.
- The retraction blanks events in place, so late polls of already-consumed
  sequences observe empty text — the documented `stream.reconciled` contract.

## Validation plan

- Core unit tests: with the flag set, a continuable cut after delivered
  content yields a plain `RETRY` (no `isContinuation`) and re-sends the
  original request; with the flag unset, behavior is unchanged.
- CLI unit tests: `HostedTextDeltaStream.retract` journals the event and
  resets identity; `hosted-harness-model` retracts + resets on
  post-publication `Retry`/`ModelFallback` and no longer throws; the envelope
  maps `message.retracted` to `message_retracted`.
- Java unit/integration tests: the store method blanks exactly the
  source-id range, rebuilds projections, publishes `stream.reconciled`, is
  idempotent, and rejects a stale epoch; the coordinator branch flushes
  batched deltas before retracting.
- Packaged-stack E2E (the issue's scenario: fake gateway drops after the
  first published chunk, then answers a full recovery text): expect
  `turn.completed`, two model requests with an identical replayed request
  body, and visible text exactly equal to the recovered text.

## Acceptance criteria

- The E2E scenario classifies as `clean-retry-recovery`
  (`turn.completed` + exact-equality visible text) instead of
  `completed-with-unretracted-prefix` or `terminal-error`.
- No glued prefix appears in the durable public event table, the committed
  message, or the model history.
- Existing gates stay green: `--session-failover`, `--inflight-failover`,
  `--continuation-failover`, and the real-model check of
  `scripts/run-managed-agent-server-e2e.ts`.

## Open questions

- The `--midstream-retry` runner mode cited by #13319 is not published in the
  repository; its known-gap expectations (pass on both bad shapes, fail on a
  clean recovery) will need to be flipped by its owner once this fix lands.
