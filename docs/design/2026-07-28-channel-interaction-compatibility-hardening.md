# Channel Interaction Compatibility Hardening

## Status

Approved on 2026-07-28 for PR #6930. This design hardens the existing
interactive-card implementation without changing the Core
`ask_user_question` event or expanding native-card support beyond DingTalk.

## Problem

The current branch has three compatibility gaps:

1. A non-owner card click is acknowledged but silently discarded. The clicker
   receives no visible explanation.
2. Omitting `interactiveCards` enables DingTalk cards by default. Existing
   installations therefore change from Markdown replies to native cards
   without opting in.
3. The shared output-segment implementation reuses the legacy
   `onResponseBoundary` hook for completion, failure, and cancellation.
   Feishu and QQ already override that hook to clear adapter-owned streaming
   state, so the new calls can change their existing behavior.

The fix must preserve the shared run, segment, request, owner, and target
correlation already implemented on the branch while isolating native feedback
and card projection inside DingTalk.

## Goals

- Return an explicit three-state result for every recognized DingTalk card
  callback: `accepted`, `forbidden`, or `ignored`.
- Let a valid owner action update the existing card and perform its original
  business action without an extra notification.
- Give a non-owner or stale clicker an IM-visible explanation without changing
  the card or entering Agent context.
- Preserve the old DingTalk Markdown path when interactive cards are not
  configured.
- Preserve the legacy response-boundary behavior of Feishu, QQ, and adapters
  that do not implement the new interaction presentation contract.
- Verify the behavior across every session scope and dispatch mode.

## Non-goals

- Changing the Core `ask_user_question` schema, permission event, or response
  format.
- Adding a generic cross-platform card API to `ChannelBase`.
- Adding DingTalk card code to Feishu, QQ, or another adapter.
- Sending unauthorized-interaction notices to a group or mentioning the
  clicker in a group.
- Persisting live callback records across process restarts.
- Making an unverifiable callback actor authoritative.
- Marking the pull request ready for review.

## Decision 1: Explicit callback outcomes

The DingTalk controller boundary returns a discriminated union:

```ts
type DingtalkCardCallbackResult =
  | {
      kind: 'accepted';
      execute: () => Promise<void>;
    }
  | {
      kind: 'forbidden';
      actorId: string;
    }
  | {
      kind: 'ignored';
      actorId?: string;
    };
```

The outcome meanings are:

| Outcome     | Meaning                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `accepted`  | The card is pending, the action is valid, and the actor is owner.                               |
| `forbidden` | The pending card exists, but the authenticated actor is not owner.                              |
| `ignored`   | The callback is expired, duplicate, malformed, forged, unknown, or cannot be correlated safely. |

The controllers remain the authority for card-record lookup, owner comparison,
one-shot claiming, and terminal-record checks. The adapter remains the
authority for callback acknowledgement and IM delivery.

### Accepted

The callback is acknowledged first. The adapter then executes the claimed
action:

- an accepted question submission responds to the original pending permission
  and projects `submitted` on the same question card;
- an accepted question cancellation responds to that original permission and
  projects `cancelled`;
- an accepted Stop cancels the exact captured run and projects the terminal
  state on the same status card.

There is no second success prompt. A card projection failure after the
permission response or run cancellation does not roll back or repeat the
business action.

Only a question response enters the existing Agent permission context. Stop
remains run cancellation and does not create a synthetic user answer.

### Forbidden

The callback is acknowledged, but the controller does not claim the record.
The card remains pending and the owner can still act on it.

The adapter sends a direct DingTalk notice to the authenticated clicker:

> You cannot operate this card. Only the task owner can submit or stop it.

The notice is an IM-side delivery only. It does not:

- update the original card;
- settle the permission;
- cancel a run;
- enqueue a message;
- create or modify Agent context.

### Ignored

The callback is acknowledged and has no business effect. When the callback
contains a trustworthy actor identity, the adapter sends a direct DingTalk
notice:

> This card action has expired or cannot be processed.

The message is deliberately generic. It does not reveal whether a referenced
card, run, request, or owner exists. If the actor cannot be identified
trustworthily, the adapter cannot safely address a notice and only records a
sanitized diagnostic.

As with `forbidden`, the original card and Agent context remain unchanged.

## Decision 2: Direct feedback, not group fallback

Unauthorized and ignored feedback is sent directly to the clicker using the
existing DingTalk direct-message delivery path. It is never posted into the
originating group and never uses an `@` mention.

This keeps the callback outcome independent from the chat where the card is
displayed:

```text
group or DM card click
  -> controller outcome
  -> Stream ACK
  -> accepted: execute the card action
  -> forbidden/ignored: direct IM notice to the clicker
```

Failure to deliver the direct notice is logged and does not change the callback
outcome. In particular, it must not fall back to the group, mutate the card, or
enter Agent context.

## Decision 3: DingTalk cards are explicit opt-in

Configuration semantics become:

| Configuration                      | Result                                  |
| ---------------------------------- | --------------------------------------- |
| `interactiveCards` omitted         | Cards disabled; preserve Markdown path. |
| `interactiveCards: {}`             | Cards enabled with existing defaults.   |
| `interactiveCards.enabled: true`   | Cards enabled with existing defaults.   |
| `interactiveCards.enabled: false`  | Cards disabled.                         |
| A card subtype explicitly disabled | Only that subtype is disabled.          |

When cards are disabled, the DingTalk adapter does not create card controllers,
does not register the card callback topic, and continues through the existing
Markdown delivery and text-based permission fallback.

This is a DingTalk-local configuration decision. No shared Channel capability
flag is added.

## Decision 4: Separate segment end from legacy response boundary

`onResponseBoundary` regains its original meaning: the model/provider emitted
an actual response boundary. Existing Feishu and QQ overrides continue to
receive only that event.

The shared layer adds a separate protected hook:

```ts
protected onOutputSegmentEnd(
  chatId: string,
  sessionId: string,
  segment: ChannelOutputSegmentContext,
  reason: ChannelOutputSegmentEndReason,
): void | Promise<void>;
```

Its default behavior forwards only `response_boundary` to the legacy
`onResponseBoundary(chatId, sessionId)` hook. Completion, failure,
cancellation, and input-request boundaries are no-ops for adapters that do not
opt in.

DingTalk overrides `onOutputSegmentEnd` because its presenter needs every
segment terminal reason to finalize or stop the corresponding native status
card. Feishu and QQ remain unchanged and keep their existing buffer-reset
semantics.

The resulting ownership is:

| Layer                | Responsibility                                              |
| -------------------- | ----------------------------------------------------------- |
| `ChannelBase`        | Run, segment, request, owner, target, ordering, settlement. |
| Legacy adapter hook  | Actual provider response-boundary notification only.        |
| DingTalk adapter     | Native cards, callback routing, direct clicker feedback.    |
| DingTalk controllers | Card record, owner validation, one-shot claim, projection.  |
| Feishu and QQ        | Existing streaming behavior through unchanged legacy hooks. |

No card action, platform handle, or DingTalk identity is introduced into the
shared layer.

## Session and dispatch isolation

Every run captures its owner and target when the prompt starts. Every output
segment and input request carries the captured `sessionId`, `runId`, owner, and
target. A DingTalk callback resolves its stored card record and never searches
for the latest run or latest card in a chat.

The callback result does not change session routing:

- `user` shares context for one user in one chat;
- `thread` shares context for one topic;
- `chat_thread` isolates by chat and topic;
- `single` shares one Channel context while each run still captures the
  initiating owner and target.

The existing dispatch modes retain their scheduling semantics:

- `collect` buffers new messages and merges them into a later prompt;
- `steer` requests cancellation and waits for the active run to exit before
  processing the new message;
- `followup` leaves the active run running and queues the new message.

If scheduling ends or supersedes a pending request, its card becomes terminal
through the existing run/request settlement path. A stale callback then returns
`ignored`; it cannot answer a later request. A non-owner callback returns
`forbidden`; it cannot affect the active run even under `single` scope.

## Error handling

- Every Stream callback is acknowledged exactly once before asynchronous card
  actions or direct notices.
- Controller exceptions become `ignored`, are sanitized in logs, and have no
  business effect.
- A failed accepted card projection does not repeat the permission response or
  cancellation.
- A failed direct feedback delivery does not fall back to a group.
- Missing or untrusted actor identity fails closed.
- Disabled-card configuration never registers the card callback listener.
- Shared segment-end hook failures are logged and do not change prompt
  settlement.

## Alternatives considered

### Post an error into the originating group

Rejected. A group message or `@` mention creates noise, can expose interaction
details to unrelated members, and is not required to enforce ownership.

### Update the shared card for unauthorized clicks

Rejected. The card still belongs to its original owner and remains actionable.
Changing it would let an unauthorized actor interfere with the legitimate
workflow.

### Send forbidden or ignored events to the Agent

Rejected. These are transport and authorization outcomes, not user answers.
Injecting them would pollute context and could cause an unsolicited Agent turn.

### Keep using `onResponseBoundary` for all segment-end reasons

Rejected. The name and existing consumers mean provider response boundary.
Broadening it changes Feishu and QQ behavior even though those adapters did not
opt into the new presentation contract.

### Add a generic cross-IM feedback service

Rejected for this change. Only DingTalk currently consumes native card
callbacks. A shared abstraction would have one implementation and would expose
platform delivery concerns in `ChannelBase`.

## Test plan

### Controller outcomes

For both question cards and status-card Stop:

- owner action returns `accepted` and executes once;
- non-owner action returns `forbidden`;
- expired, terminal, duplicate, unknown, and malformed actions return
  `ignored`;
- forbidden and ignored results do not mutate records;
- the legitimate owner can act after a forbidden attempt;
- a stale callback cannot act on a newer run or request.

### Adapter routing and feedback

- ACK is sent before accepted execution or feedback delivery;
- accepted executes without a second notice;
- forbidden sends one direct notice and does not execute;
- ignored with a trusted actor sends the generic direct notice;
- ignored without a trusted actor sends nothing and logs safely;
- feedback failure does not update the card, touch Agent context, or post to a
  group;
- question and Stop callbacks preserve their exact captured IDs.

### DingTalk configuration

- omitted `interactiveCards` preserves Markdown behavior and does not register
  the card callback topic;
- `{}` and `enabled: true` initialize the card path;
- `enabled: false` disables the card path;
- status-only and question-only combinations keep their existing fallback;
- `blockStreaming=on` remains compatible with question cards.

### Shared and existing-adapter compatibility

- a legacy test adapter receives `onResponseBoundary` only for an actual
  response-boundary event;
- completion, failure, cancellation, and input request invoke the new
  segment-end hook without invoking the legacy hook;
- DingTalk finalizes the correct segment for every end reason;
- Feishu cancellation and failure preserve accumulated partial text;
- QQ cancellation and failure preserve its existing stream flush and cleanup
  behavior;
- adapters with neither hook retain final-only delivery.

### Context matrix

Use table-driven coverage for all twelve combinations:

```text
sessionScope: user | thread | chat_thread | single
dispatchMode: collect | steer | followup
```

For every combination, assert:

- the expected session is shared or isolated;
- each prompt has a distinct `runId`;
- each input request remains correlated to its owning run and user;
- a forbidden or ignored callback cannot settle a request or cancel a run;
- a valid owner callback affects only its captured request or run;
- queued or superseding messages cannot redirect an older card callback.

### Verification

After focused red-green tests:

1. Run full base Channel tests.
2. Run full DingTalk tests.
3. Run focused Feishu and QQ streaming tests.
4. Run workspace build and typecheck.
5. Run focused lint and `git diff --check`.
6. Rebase onto the then-current `origin/main` and repeat affected tests.
7. Validate on real DingTalk with the `Qwen3.8-Max` robot:
   - owner Submit and Stop;
   - second-user Submit and Stop rejection with direct feedback;
   - stale-card click feedback;
   - group and direct-message cards;
   - unconfigured Markdown fallback;
   - representative `collect`, `steer`, and `followup` flows.

Second-account real-device actions may be supplied by the user. Automated
results and real-device evidence are reported separately.

## Acceptance criteria

- The controller boundary exposes exactly `accepted`, `forbidden`, and
  `ignored`.
- Accepted actions update the existing card and perform the original business
  action without a second success message.
- Forbidden and ignored actions do not mutate the card or enter Agent context.
- A trustworthy forbidden or ignored clicker receives a direct DingTalk
  notice, never a group message or `@` mention.
- Omitting DingTalk `interactiveCards` preserves the old Markdown path.
- Feishu and QQ receive no new synthetic response-boundary calls.
- All twelve session-scope and dispatch-mode combinations pass the interaction
  isolation assertions.
- The Core AskUserQuestion event remains unchanged.
- The PR remains Draft.
