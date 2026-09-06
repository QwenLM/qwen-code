# Feishu Ask User Question Cards

## Status

Proposed implementation for [#8567](https://github.com/QwenLM/qwen-code/issues/8567).

## Problem

`ChannelBase` already turns the existing `ask_user_question` permission request into a channel-neutral `ChannelUserInputRequestContext`. DingTalk consumes that context through `presentUserInputRequest`, but Feishu inherits the default `unsupported` result and falls back to permission text that cannot carry the required `answers` map.

Feishu already sends and patches Card V2 interactive messages and receives `card.action.trigger` callbacks. The missing capability is an adapter-local presenter that correlates one native form card with the original pending permission and resolves it exactly once.

The current Feishu output card is created eagerly from `onPromptStart`. A prompt that immediately asks a question would therefore show both a blank status card and a question card. Native Ask support must make output-card creation lazy and end any visible output presentation before showing the form.

## Goals

- Present the existing structured questions in one Feishu Card V2 form.
- Resume the original permission and agent run through `context.respond`.
- Correlate callbacks by captured request, run, target, and owner identity.
- Keep callback acknowledgement synchronous and permission settlement asynchronous.
- Patch the same question card to a non-interactive terminal state.
- Preserve Feishu streaming, Stop, block-streaming, and proactive delivery.
  Stop follows the first visible chunk because output-card creation is lazy;
  the eager placeholder card is intentionally not restored (see Output-card
  ordering).
- Keep all Feishu card schemas and native handles inside the Feishu package.

## Non-goals

- A Feishu-specific model tool.
- Synthetic inbound answer messages.
- Free-text questions or a broader Core question schema.
- A shared cross-platform card API.
- Chat-scoped inference of the latest pending question.
- Durable callback recovery after process restart.
- Refactoring all existing Feishu streaming-card state around `segmentId`.

## Shared boundary

The existing interaction contract remains unchanged:

```text
ask_user_question
  -> permission_request
  -> ChannelBase normalizes ChannelUserInputRequestContext
  -> Feishu presents a native form
  -> context.respond({ outcome, answers })
  -> original permission settles
  -> original agent run continues
```

`ChannelBase` owns normalization, pending-permission lifetime, first-responder-wins settlement, and continuation. Feishu owns native JSON, message IDs, callback parsing, owner validation, local claim state, and terminal projection.

## Components

### Question card builder

`question-card.ts` is a pure Feishu Card V2 projection module. It builds:

- pending form cards;
- processing callback projections;
- submitted, cancelled, and expired terminal cards;
- callback parsing for Submit and Cancel actions.

Each question uses its existing `answerKey` as the form field name. A single-select question renders `select_static`; a multi-select question renders `multi_select_static`. Option values are the existing option labels. The Submit button has `form_action_type: "submit"` and carries the request ID in both its `name` and `value.operation_id`. The Cancel button carries the same request ID without submitting the form.

The parser requires an explicit request ID and never falls back to the latest question in a chat. It normally requires matching IDs in the button name and value. When Feishu omits the entire button value, it can recover the ID from the exact button-name prefix for both submit and cancel; a present but malformed or conflicting value is still rejected. It accepts the known Feishu multi-select representations: an array of strings or a JSON-encoded string array.

### Question card controller

`question-card-controller.ts` owns live interaction state:

```text
reserved -> pending -> claimed -> terminal
```

The live record captures the original `ChannelUserInputRequestContext`, Feishu message ID, exact scope, timer, and settlement subscription. It is indexed by request ID and by active scope (`sessionId + owner.id`); the captured native message ID is validated against every callback rather than used as a lookup key. The active scope is `sessionId + owner.id`; one run may have only one native pending question in that scope. A second request in the same run returns `unsupported` so `ChannelBase` retains its text fallback. Different sessions and users remain independent.

The record is reserved before awaiting native delivery so an external settlement or cancellation cannot race with delivery and reactivate it. The local expiry is 270 seconds, shorter than the current five-minute bridge permission timeout.

Callback handling performs these steps synchronously:

1. parse the action and exact request ID;
2. find a live pending record;
3. validate the callback operator against `context.owner.id`;
4. validate every answer key and value against the captured questions;
5. claim the record once;
6. return a toast plus the processing or cancelled projection wrapped in
   Feishu's raw callback-card response envelope.

The adapter schedules `execute` with `setImmediate`, so callback handling can return before permission settlement begins. An accepted submission uses `submitOptionId` and the validated `answers` map. Cancel uses the existing cancelled permission outcome. Subsequent message patches are serialized per record and remain projections only: failure cannot roll back an accepted response or reopen a claimed record.

Terminal records are removed from the live maps. A repeated callback therefore receives an expired/already-handled toast and cannot invoke the responder again.

### Feishu adapter integration

`FeishuAdapter` constructs the controller with narrow native operations:

- send one arbitrary interactive card and return its message ID;
- patch an arbitrary interactive card by message ID;
- send readable fallback text;
- log projection errors.

The existing status-card update method delegates its HTTP PATCH to the same generic card-patch helper; existing rendering remains unchanged.

`card.action.trigger` dispatches Ask actions first. An unrecognized Ask action falls through to the existing Stop handler. The event handler returns the controller's callback response immediately and schedules the accepted operation without awaiting it.

`presentUserInputRequest` delegates to the question controller. `onTaskLifecycle` terminalizes questions for the exact run. `disconnect` clears timers and subscriptions and makes remaining local cards unavailable best-effort.

## Output-card ordering

`onPromptStart` retains inbound/session correlation, the working reaction, and an in-memory output state, but no longer sends a streaming card. Keeping the empty state preserves the existing visible error fallback when a run fails before its first chunk. The existing `onResponseChunk` fallback path sends the card on the first visible chunk. Tradeoff: the eager 思考中... placeholder card is gone, so the card Stop button — Feishu's only cancellation affordance — is only available from the first visible chunk, not from prompt start; a pending question's own Cancel button is unaffected.

For a direct question with no preceding output segment, `presentUserInputRequest` releases that still-empty output state before presenting the native form. The release resets the session to an inert in-memory entry instead of deleting it, so the periodic orphan sweep and the terminal-feedback paths still see the pending turn; the prompt can therefore finish without emitting an extra terminal status message, and later visible output can still create a fresh card through the preserved session correlation. A turn that fails after the answer still surfaces the failed terminal label through that entry. Tradeoff: because output-card creation is lazy, every completed turn with no visible output — not only the released post-question entry — ends silently; before this change the eager placeholder card surfaced such turns as a finalized 已完成 card.

When `ChannelBase` closes an existing segment with `input_requested`, Feishu finalizes the current output card before presenting the form. Production bridges emit the response boundary synchronously before the permission request, which closes the segment first; `presentUserInputRequest` therefore performs the same finalization whenever no preceding segment id is carried, using the pre-boundary text snapshot. If the native update returns false, Feishu retries once with table content stripped (mirroring `onResponseComplete`); if the update still fails or throws, Feishu deletes the stale interactive card best-effort and sends the same content as a static fallback message. It then resets only the current output-card state while retaining the session-to-inbound correlation. Text emitted after the answer can therefore create a fresh output card in the same run. Final prompt cleanup still removes all auxiliary state.

This is the minimum segment-boundary change required for Ask. Full migration of every Feishu output card to `segmentId` ownership is separate work.

## Failure semantics

| Situation                               | Behavior                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Request cannot be represented           | Return `unsupported`; use existing Channel text fallback.                  |
| Native card delivery fails              | Send readable failure text, cancel the original request, return `handled`. |
| Submit is malformed                     | Return warning/error toast; keep the card pending.                         |
| Callback user is absent or foreign      | Fail closed; keep the card pending.                                        |
| Callback is duplicate or stale          | Return expired/already-handled toast; make no state change.                |
| Responder accepts                       | Terminalize as submitted or cancelled, then patch the card.                |
| Responder returns false or throws       | Terminalize as expired/unavailable and do not reopen.                      |
| Terminal patch fails                    | Log it, send a plain-text terminal summary; keep the permission outcome.   |
| Local timeout                           | Mark expired first, then cancel the original request.                      |
| External settlement or run cancellation | Terminalize once from `onSettled` or lifecycle notification.               |
| Process restart                         | Old callbacks are treated as expired; no persistence in this change.       |

## Testing

Pure card tests cover form JSON, correlation fields, single/multi-select parsing, required answers, malformed values, and terminal projections.

Controller tests cover reservation-before-delivery, valid submit, cancel, foreign operator, duplicate callback, delivery failure, same-run concurrency, user/session isolation, timeout, external settlement, responder rejection/throw, and terminal-patch failure.

Adapter tests cover callback routing, Stop compatibility, lazy output-card creation, `input_requested` output finalization, presenter delegation, lifecycle cancellation, disconnect cleanup, and post-answer continuation state.

Focused verification runs from `packages/channels/feishu`, followed by repository build and typecheck. Real-device verification covers the WebSocket connection, a real inbound direct message, a direct two-question card settled by a real callback, original-run continuation at the transport/API level, and a text-before-question flow. Foreign-user rejection, duplicate submit, cancel, and expiry remain covered only by automated tests; model-driven live generation was not verified because the supplied model credential returned HTTP 401, so the live run injected the same canonical permission event through the normal channel contract.

## Acceptance criteria

- Direct Ask displays exactly one Feishu question card.
- A valid owner submission resolves the original request once with ordered answer keys.
- The same run continues without a synthetic inbound message.
- The native card becomes non-interactive after every terminal transition.
- Existing Feishu Stop and streaming-card tests remain green.
- No production change outside `packages/channels/feishu` is required.
