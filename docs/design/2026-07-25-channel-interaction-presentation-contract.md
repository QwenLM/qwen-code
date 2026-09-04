# Channel Interaction Presentation Contract

## Status

Implemented channel-neutral contract for PR #6930. The DingTalk-specific
projection and operational details remain in
`2026-07-15-dingtalk-interactive-cards.md`.

## Problem

The prior implementation created a DingTalk status card on the run-level
`started` event. If the model then called `ask_user_question`, the adapter
created a second form card and changed the first card to `Waiting for input`.
The user saw two active cards even when the model produced no visible answer.

This is not a DingTalk rendering race. It is an ownership error:

- a run-level event is being treated as a visible output event;
- output and input presentation are independent adapter state machines;
- there is no shared definition of a visible output segment;
- an input request does not end the active output presentation.

Fixing only DingTalk card deletion or recall would preserve the ownership
error and would not give Feishu or future IM adapters a stable interaction
contract.

## Goals

- Create an output presentation only when there is user-visible output.
- Let a native input card become the only active presentation when the model
  asks for input before producing visible output.
- Update an input card in place through its terminal state; do not delete it
  during the normal lifecycle.
- Resume the original permission and model context without injecting a
  synthetic user message.
- Give every output segment and input request exact run, session, target, and
  owner correlation.
- Let DingTalk, Feishu, and future IM adapters opt into the same semantics
  without sharing platform card APIs or template schemas.
- Preserve existing behavior for adapters that do not opt in.

## Non-goals

- A generic cross-platform `createCard`, `updateCard`, or `deleteCard` API.
- Free-form text parsing as a substitute for native structured input.
- Requiring every IM to support streaming output, forms, or buttons.
- Moving DingTalk or Feishu platform handles into `ChannelBase`.
- Persisting live callbacks across process restarts.
- Changing Core, ACP, or the `ask_user_question` answer contract.
- Refactoring the existing Feishu card implementation in the DingTalk fix.

## Design principles

### Shared semantics, local projection

`ChannelBase` owns context, ordering, and settlement semantics. An IM adapter
owns native rendering, callback transport, platform handles, throttling, and
projection failures.

The shared layer never refers to cards. It refers to:

- a prompt run;
- a visible output segment;
- a structured input request;
- the terminal outcome of those objects.

### Context is captured, never rediscovered

The authoritative correlation chain is:

```text
SessionTarget(chatId/threadId) -> sessionId -> runId -> segmentId/requestId
```

The adapter captures this chain when it creates a native presentation. A
callback resolves the captured record. It must not search for the latest card,
latest run, or latest session in a chat.

`SessionTarget.threadId` remains the thread partition when a platform exposes
one. Platforms without thread semantics use `chatId`. Platform callbacks do
not independently derive a new target.

### Transactions and projections are separate

The permission response is the transaction. A card update is a UI projection.
A successful permission response is never rolled back because the subsequent
native-card update failed.

## Shared semantic model

### Prompt run

A `runId` identifies one Channel-owned prompt execution. It retains the
existing exact-run cancellation and owner rules.

The `started` lifecycle event means that the run was accepted. It does not
open an output presentation.

### Output segment

An output segment is one contiguous sequence of user-visible assistant text
inside a run. `ChannelBase` allocates an opaque `segmentId` only when the first
visible text for that segment arrives.

A segment ends on the first of:

- a response boundary;
- presentation of a structured input request;
- successful final response delivery;
- run failure;
- run cancellation.

After a structured input request settles, later text in the same run opens a
new segment with a new `segmentId`. It never reopens or overwrites the
pre-question segment.

### Input request

A `requestId` identifies one original pending `ask_user_question` permission
request. One request may contain all normalized questions from that tool call.
Presentation ownership is scoped by `sessionId + owner.id`. Different users or
sessions may have live input presentations simultaneously. Within one run, a
second request in the same scope returns `unsupported`, keeps the first native
presentation answerable, and uses the existing text permission fallback.

The adapter-internal input state machine is:

```text
reserved -> pending -> claimed -> terminal
```

It is callback arbitration, not a platform card state. DingTalk exposes only
`pending`, `submitted`, `cancelled`, and `expired`: accepted submission maps to
`submitted`, accepted user cancellation maps to `cancelled`, and timeout,
external resolution, or an unavailable responder maps to `expired`. Every
terminal transition updates the existing native input presentation in place
and never deletes it.

The shared settlement label is `resolved_outside_presenter`. The contract is
shared by native forms and other interaction surfaces, so a platform-specific
noun does not become public API.

## Shared contract

The existing hooks remain the extension surface. They receive stronger
semantic context rather than platform operations.

```ts
interface ChannelOutputSegmentContext {
  channelName: string;
  sessionId: string;
  runId: string;
  segmentId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  messageId?: string;
}

type ChannelOutputSegmentEndReason =
  | 'response_boundary'
  | 'input_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

The chunk and completion hooks gain an optional final context argument for
source compatibility. Segment termination uses a dedicated hook so adapters
can distinguish response boundaries from input requests and terminal causes:

```ts
protected onResponseChunk(
  chatId: string,
  chunk: string,
  sessionId: string,
  segment?: ChannelOutputSegmentContext,
): void;

protected onOutputSegmentEnd(
  chatId: string,
  sessionId: string,
  segment: ChannelOutputSegmentContext,
  reason: ChannelOutputSegmentEndReason,
): void | Promise<void>;

protected onResponseBoundary(
  chatId: string,
  sessionId: string,
): void | Promise<void>;

protected onResponseComplete(
  chatId: string,
  text: string,
  sessionId: string,
  segment?: ChannelOutputSegmentContext,
): Promise<void>;
```

Existing overrides that accept fewer arguments remain valid and unchanged.
`ChannelBase` always supplies the segment context to the response hooks for an
attended Channel-owned run and calls `onOutputSegmentEnd` whenever that segment
closes. Its default implementation delegates only `response_boundary` to the
legacy `onResponseBoundary` hook. Loop, webhook, and legacy synthetic paths
remain ineligible for native interaction presentation.

`ChannelUserInputRequestContext` retains its existing request responder and
settlement subscription. It additionally carries the captured interaction
scope:

```ts
interface ChannelUserInputRequestContext {
  requestId: string;
  sessionId: string;
  runId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  precedingSegmentId?: string;
  // existing normalized questions, submit option, onSettled, and respond
}
```

Its settlement reason union uses `resolved_outside_presenter`, `cancelled`,
and `run_cancelled`.

Before invoking `presentUserInputRequest`, `ChannelBase` closes the shared
segment identity and passes its ID as `precedingSegmentId`, but does not
project a platform response boundary. A supporting adapter closes its own
presentation with `input_requested` before presenting the native input. This
keeps unsupported adapters from clearing or otherwise mutating their existing
streaming state. Closing is idempotent, so a platform response-boundary event
that arrives first or later cannot close two different segments.

No shared capability flags are required. Capability is expressed by behavior:

- output hooks are optional and default to existing delivery;
- `presentUserInputRequest` returns `unsupported` when native structured input
  is unavailable;
- platform-specific configuration remains inside the adapter.

This avoids invalid combinations of global booleans and lets an adapter
support streaming output without supporting forms, or forms without streaming
output.

## Presenter contract inside each adapter

An adapter may compose an internal presenter rather than adding platform state
to its main adapter class. That presenter owns:

- `segmentId -> native output handle`;
- `requestId/outTrackId/messageId -> native input handle`;
- one serialized projection queue per `runId`;
- bounded output snapshots and update coalescing;
- callback owner validation and one-shot claims;
- native API timeouts and error logging;
- compact terminal tombstones.

The per-run projection queue guarantees this order:

```text
finish old output segment
  -> create input presentation
  -> update input terminal state
  -> create the next output segment on its first visible text
```

Intermediate output appends enqueue a replaceable full snapshot and do not
block model generation. Boundary, input presentation, and final delivery join
the same queue so they cannot overtake earlier writes.

## Required interaction sequences

### Normal answer

```text
run started
  -> no native output
first visible text
  -> allocate segment-1
  -> lazily create the native output presentation
later chunks
  -> update segment-1
run completed
  -> update segment-1 in place to completed
```

If a provider returns a final response without emitting chunks, final delivery
allocates the segment and creates one completed output presentation.

### Direct question

```text
run started
  -> no native output
ask_user_question request
  -> create request-1 input presentation
```

No output segment exists, so the user sees only the input presentation.
While it is pending, there is no separate run-status presentation. The input
presentation's pending state is the visible indication that the run is waiting
for the user.

### Text followed by a question

```text
first visible text
  -> create segment-1 output presentation
ask_user_question request
  -> complete segment-1 in place
  -> create request-1 input presentation
```

The completed output remains as conversation history, but only the input
presentation is active.

### Question submission and continuation

```text
valid callback
  -> correlate request-1 and validate owner
  -> atomically claim request-1
  -> acknowledge callback
  -> respond to the original permission
  -> update request-1 in place to submitted
next visible model text in the same run
  -> allocate segment-2
  -> create a new output presentation
```

The answer resumes the original model context. The adapter does not inject a
synthetic inbound message.

### Concurrent questions

At most one native input presentation is active for the same
`sessionId + owner.id + runId`. A second request in that scope returns
`unsupported`; `ChannelBase` sends its semantic text fallback while the first
native presentation remains valid. This avoids an unreachable pending request
without synthesizing a cancellation or inbound message. Different users and
sessions remain independent, and run termination closes all presentations
owned by that run.

## DingTalk projection

The DingTalk presenter maps:

- an output segment to one status-card template instance;
- an input request to one question-card template instance.

Changes from the current implementation:

- do not create a status card on `started`;
- create it on the first chunk or final response for a segment;
- key status records by `segmentId`, while retaining `runId` for Stop;
- close the active segment before creating a question card;
- keep the first question card active when the same run requests another
  question and let the newer request use text fallback;
- never change an old status card to `Waiting for input`;
- update the question card in place to submitted, cancelled, expired, or
  externally resolved;
- create a new status card only when post-submission text begins.

The normal path does not recall or delete either card. If a partially failed
native delivery leaves an unusable orphan that cannot be updated, platform
cleanup may delete or recall it as a last-resort error path; that is not a
business-state transition.

The Stop action remains bound to the exact `runId` and owner captured by the
segment. Stopping from any live output segment cancels that run only. A
terminal historical segment cannot stop a later run.

The question card's Cancel action resolves the original input request as
cancelled. The existing `ask_user_question` cancellation semantics then decide
whether the run terminates; the adapter does not issue a second session-wide
cancel.

The first metadata projection is deliberately limited to the configured model
and elapsed wall-clock time. DingTalk reads the optional model from the
existing Channel configuration and renders a running line such as
`Running · qwen3.7-max · 12s`. It refreshes the elapsed value when the existing
coalesced model-text stream flushes and the displayed second has changed, so
the status adds at most one update per second without an independent timer.
Silent thinking or tool execution therefore does not advance the visible
counter until the next text flush. The terminal update always writes the exact
elapsed value, for example `Stopped · qwen3.7-max · 18s`. If the Channel
configuration does not select a model, the line omits the model rather than
inferring one.

This increment does not expose token usage. Accurate per-turn token counts are
not present in the current Channel bridge or lifecycle contract, and an
estimate derived from visible text would be misleading. A later change may add
token metadata only after the shared runtime supplies an authoritative
per-turn snapshot. Missing metadata never delays or changes segment state.

## Feishu extension

The existing Feishu implementation already creates streaming cards lazily on
response chunks and can update or delete an interactive message. It does not
need to change in the DingTalk correction.

A later Feishu interaction change can adopt the same contexts:

- `segmentId` replaces implicit `inboundMsgId` ownership for output cards;
- `runId` continues to protect Stop from cancelling a newer run;
- a native interactive form or buttons implement
  `presentUserInputRequest`;
- the callback resolves the captured `requestId`, not the latest card in the
  chat;
- the same input message is patched to its terminal state;
- unsupported field types return `unsupported` or cancel with a readable
  platform-local failure rather than parsing arbitrary text.

Telegram, WeCom, Weixin, QQ, and plugin adapters may independently consume
output contexts, input contexts, both, or neither. The default hooks preserve
their current behavior.

## Failure and degradation rules

| Failure                                                  | Required behavior                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Output presentation creation fails                       | Retain bounded text and use the existing awaited text delivery path.                                                                            |
| Intermediate output update fails                         | Stop further native streaming for that segment; preserve final text for fallback.                                                               |
| Output terminal update fails                             | Send final text through the existing fallback and mark the native projection unavailable.                                                       |
| Input presentation returns `unsupported`                 | Use the existing semantic permission message; do not parse a later free-form reply.                                                             |
| Native input creation fails after opt-in                 | Tell the user the native question failed, cancel the original request, and allow an explicit retry.                                             |
| Permission response succeeds but input-card update fails | Keep the permission resolved, retain a terminal tombstone, and log the projection failure.                                                      |
| Callback is duplicate, stale, foreign, or malformed      | Acknowledge after synchronous validation and make no state change.                                                                              |
| Run ends with pending inputs                             | Update those input presentations in place to cancelled.                                                                                         |
| Process restarts with live cards                         | Treat callbacks as no longer pending and update to expired/unavailable when platform correlation permits. Persistent recovery is separate work. |

## State and resource bounds

- Output content remains bounded to 20,000 visible characters per segment.
- Each segment allows one native write in flight and one replaceable pending
  snapshot.
- Native API calls retain explicit timeouts.
- Live run, segment, request, and callback maps remain insertion-ordered and
  bounded.
- Terminal tombstones contain correlation and terminal state only; they do
  not retain responders, questions, answers, timers, or content.
- All cleanup checks exact object identity so late asynchronous completion
  cannot mutate a newer record with the same session.

## Migration plan

The correction should remain small and ordered:

1. Add output-segment context and idempotent segment boundaries to
   `ChannelBase`, preserving existing hook signatures through optional trailing
   parameters.
2. Add shared tests for lazy segment allocation, boundary ordering, direct
   questions, continuation segments, concurrent questions, and context
   isolation.
3. Replace DingTalk's run-scoped status controller with a run presenter that
   owns segment-scoped output records and request-scoped input records.
4. Remove eager status-card creation and `Waiting for input` projection.
5. Keep the existing final-content V2 fields and structured-question
   settlement logic.
6. Verify DingTalk with real-device direct-question, text-then-question,
   submission-continuation, Stop, timeout, and failure scenarios.
7. Leave Feishu production code unchanged; add only compatibility evidence if
   the shared signature change requires it.

The local correction may be committed only after real-device acceptance
matches the sequences above. It remains unpushed until explicit approval.

## Acceptance criteria

### Shared Channel

- `started` never allocates an output segment.
- The first visible text allocates exactly one segment ID.
- A response boundary or input request closes that segment exactly once.
- Text after question settlement receives a different segment ID in the same
  run and session.
- `chatId/threadId`, session, run, request, segment, and owner correlation
  cannot cross between concurrent contexts.
- Existing adapters with no interaction support retain their behavior.

### DingTalk

- A direct `ask_user_question` displays one question card and no status card.
- A question card is updated in place on submit, cancel, expiry, and external
  resolution.
- A second question in the same run uses the text fallback while the first
  native card remains answerable.
- Different users and sessions retain independent live question cards.
- Text before a question remains in a completed historical status card.
- Text after submission appears in a new status card.
- No status card displays `Waiting for input`.
- Stop cancels only the exact captured run.
- Final completed content remains visible through the V2 `blockList`,
  `content`, and `copy_content` fields.

### Cross-IM compatibility

- Feishu builds and its existing streaming-card and Stop tests remain green
  without adopting the new presenter.
- An adapter can implement native input without streaming output.
- An adapter can implement streaming output without native input.
- An adapter supporting neither inherits the existing text behavior.

## Decision summary

The shared abstraction is an interaction-presentation contract, not a card
framework. `ChannelBase` owns context and segment/request semantics. Each IM
owns its native presenter. Output cards are lazy and segment-scoped; input
cards are request-scoped and updated in place. This removes the DingTalk
double-active-card behavior while giving Feishu and future adapters a stable,
platform-neutral extension path.
