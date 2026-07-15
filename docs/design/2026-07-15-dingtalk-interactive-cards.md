# DingTalk Interactive Cards

## Status

Design proposal for [#6443](https://github.com/QwenLM/qwen-code/issues/6443). This document intentionally defines the architecture and boundaries before implementation begins.

## Motivation

The DingTalk channel currently sends Markdown responses and already receives task lifecycle events, routes permission requests to their owning channel, and can cancel an active prompt. It does not provide an in-place running-status card, a card Stop action, or a form card for `ask_user_question`.

The design should add those DingTalk interactions without teaching the model, the tool, ACP, or other channel adapters about DingTalk templates and callback payloads.

## Architecture

![DingTalk interactive cards architecture](./assets/dingtalk-interactive-cards-architecture.png)

The diagram marks capability ownership explicitly:

- Gray `[已有]`: already available on `main` and reused directly.
- Blue `[新增]`: introduced by this change.
- Orange `[扩展]`: an existing capability whose behavior is extended.
- Green `[外部已有]`: existing DingTalk platform capability.

The design follows one rule: Qwen Code expresses a semantic request for user input, while each channel decides how to present it.

## Existing capabilities reused

- `ask_user_question` already describes questions, options, multi-select behavior, and returns answers through the original tool invocation.
- ACP permission metadata already identifies a user-question interaction and preserves its questions.
- Channel session routing already delivers a permission request only to the adapter that owns the session.
- Pending permission requests already have a request identity and response path.
- Task lifecycle events already expose start, streaming, tool, and terminal updates to channel adapters.
- Active prompt cancellation already provides the same cancellation path used by `/cancel`.
- DingTalk already has a Stream connection and generic callback ingress.
- CLI and IDE surfaces already render `ask_user_question` natively.

## Channel-neutral extension

`ChannelBase` gains one presentation seam for semantic user-input requests:

```ts
protected presentUserInputRequest(
  context: ChannelUserInputRequestContext,
): Promise<'presented' | 'unsupported'>;
```

The context contains normalized questions, the routed target, session and request identities, an abort signal, and a one-shot responder for either submitted answers or cancellation. It contains no card template ID, DingTalk action ID, or DingTalk callback payload.

`ChannelBase` remains responsible for request ownership and the eventual permission response. An adapter only presents the interaction and calls the supplied responder.

When an adapter does not override the hook, or presentation fails, `ChannelBase` formats the normalized questions as readable Markdown. It never serializes raw ACP input as fallback output.

This fallback is an explicit text handoff, not a second form protocol: the current `ask_user_question` is cancelled, the user is told that interactive input is unavailable, and the next normal message continues in the same session. `/approve` remains unchanged for ordinary permissions but is not used to answer questions because it cannot carry answer values.

## DingTalk-local implementation

Only the DingTalk adapter reads `interactiveCards` and registers the card callback topic. Its implementation is split into shared transport plus two state machines.

### Shared card client and callback router

The shared card client owns DingTalk authentication and card create/update operations. Template IDs remain private constants in the DingTalk package.

The callback router validates the action owner, card identity, session, and run generation before dispatch. Repeated, stale, and foreign-user actions are rejected without changing state. It reuses the existing Stream transport while adding handling for the card callback topic.

### Status-card state machine

The status-card state machine consumes existing task lifecycle events:

```text
running <-> waiting_input -> completed | failed | stopped
```

Updates are serialized per session and streaming changes are throttled so fire-and-forget lifecycle delivery cannot reorder card mutations.

A Stop callback carries enough identity to address one exact run. After owner and generation validation, it reuses active prompt cancellation. A stale card therefore cannot stop a newer run in the same conversation.

### Question-card state machine

The question-card state machine is entered through the channel-neutral presentation hook:

```text
pending -> submitted | cancelled | expired | externally_resolved | presentation_failed
```

Submitting maps card fields back to the semantic answer keys and responds to the original permission request. Cancelling or expiring responds with cancellation. An abort signal closes the card if the host resolves or destroys the request first.

While a question is pending, the status card moves from `running` to `waiting_input`. Successful submission returns it to `running`; cancellation, expiration, or task termination moves it to the corresponding terminal state.

## Configuration

The configuration is local to the DingTalk channel:

```json
{
  "interactiveCards": {
    "enabled": true,
    "statusCard": {
      "enabled": true
    },
    "questionCard": {
      "enabled": true,
      "timeoutMs": 300000
    }
  }
}
```

All capabilities are enabled by default. The question-card lifetime is configurable but cannot outlive the upstream permission request, so the effective timeout is the smaller of the configured timeout and the host permission lifetime.

The initial implementation uses the existing template IDs from `soimy/openclaw-channel-dingtalk` as DingTalk-internal constants:

- Status card: `675cde2f-f526-40cb-b828-f5b2b57b8b77.schema`
- Question card: `c2a6355b-9724-4f7e-9653-d33fcb3311bb.schema`

## Degradation behavior

| Situation                                | Behavior                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Status cards are disabled or fail        | Continue the same turn with the existing Markdown delivery.                                   |
| A question card is available             | Submit or cancel through the card and resolve the original request.                           |
| A question card is disabled or fails     | Render semantic Markdown, cancel the current question, and hand off to the next user message. |
| Another IM adapter owns the session      | Use the channel-neutral semantic text handoff without exposing JSON.                          |
| An ordinary tool permission is requested | Keep `/approve`, `/approve-always`, and `/deny` unchanged.                                    |

## Scope boundaries

This proposal does not add a channel text-answer command, parse free-form replies into form fields, inject synthetic user messages, or introduce a general cross-channel card framework. Those would add a second pending-input state machine and are not required to deliver the DingTalk interaction requested by #6443.

Implementation should remain a small channel-neutral seam plus DingTalk-local state and transport code.
