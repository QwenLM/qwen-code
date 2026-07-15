# DingTalk Interactive Cards

## Status

Design proposal for [#6443](https://github.com/QwenLM/qwen-code/issues/6443). This document intentionally defines the architecture and boundaries before implementation begins.

## Motivation

The DingTalk channel currently sends Markdown responses and already receives task lifecycle events, routes permission requests to their owning channel, and can cancel an active prompt. It does not provide an in-place running-status card, a card Stop action, or a form card for `ask_user_question`.

The design should add those DingTalk interactions without teaching the model, the tool, ACP, or other channel adapters about DingTalk templates and callback payloads.

## Chapter 1: DingTalk target architecture

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
): Promise<
  | { kind: 'presented' }
  | { kind: 'handled' }
  | { kind: 'unsupported' }
>;
```

The context contains normalized questions, the routed target, session and request identities, an abort signal, and a one-shot responder for either submitted answers or cancellation. It contains no card template ID, DingTalk action ID, or DingTalk callback payload.

`ChannelBase` remains responsible for request ownership and the eventual permission response. An adapter only presents the interaction and calls the supplied responder. The result makes ownership of the next action explicit:

- `presented` means the adapter created an interactive surface and the permission remains pending until the responder is called.
- `handled` means the adapter already completed a channel-local fallback and resolved or cancelled the request, so the base does nothing further.
- `unsupported` means the adapter does not implement semantic user-input presentation, so the base preserves the existing permission message and command behavior.

The default implementation returns `unsupported`. This is intentionally compatibility-preserving: adapters other than DingTalk are not opted into a new cancellation or text-handoff policy. The existing permission formatter does not serialize the raw ACP input, so those clients do not display question JSON today.

## DingTalk-local implementation

Only the DingTalk adapter reads `interactiveCards` and registers the card callback topic. Its implementation is split into shared transport plus two state machines.

### Shared card client and callback router

The shared card client owns DingTalk authentication and card create/update operations. Template IDs remain private constants in the DingTalk package.

The callback router validates the action owner, card identity, session, and run generation before dispatch. Repeated, stale, and foreign-user actions are rejected without changing state. It reuses the existing Stream transport while adding handling for the card callback topic.

The DingTalk override owns both of its outcomes. If a question card is created, it returns `presented`. If question cards are disabled or card creation fails, DingTalk sends readable semantic Markdown, cancels the current question request, and returns `handled`. This is a text handoff, not a second form protocol: the user is told that interactive input is unavailable and the next normal message continues in the same session. `/approve` is not used for this fallback because it cannot carry answer values.

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

Permission resolution remains first-responder-wins. If a native Web or IDE surface attached to the same daemon session answers first, the permission abort signal moves the DingTalk card to `externally_resolved` and disables its actions. If DingTalk answers first, the native surface receives the same resolution and closes. No second answer is accepted.

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
| Another IM adapter owns the session      | Return `unsupported` and preserve the existing permission message and command behavior.       |
| An ordinary tool permission is requested | Keep `/approve`, `/approve-always`, and `/deny` unchanged.                                    |

## Client impact

| Client or surface                      | Behavior after this proposal                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| DingTalk with question cards enabled   | Render the native question card and return answers to the original request.                                       |
| DingTalk with cards disabled or failed | Send semantic Markdown, cancel the current question, and continue from the user's next normal message.            |
| Other IM adapters                      | No direct code or behavior change; the default hook returns `unsupported` and keeps the existing permission flow. |
| CLI/TUI                                | No change; continue using the native question dialog outside `ChannelBase`.                                       |
| VS Code / IDE companion                | No change; continue using the native ACP question UI.                                                             |
| Web Shell / desktop                    | No change; continue using the native question component and existing action transport.                            |
| SDK and custom ACP clients             | No protocol change; the existing permission request and response schema remains intact.                           |
| Ordinary permissions on every client   | No change; existing approval and denial controls remain available.                                                |

## Chapter 2: Current impact on other IM adapters

![Other IM impact after the channel-neutral hook](./assets/dingtalk-interactive-cards-other-im-impact.png)

The shared hook is an opt-in extension point, not a behavior rollout to every adapter. Its impact on Feishu, QQ, Telegram, WeCom, Weixin, and the plugin example is:

| Dimension              | Impact                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Direct adapter changes | None required. Adapters that do not override the hook inherit the default `unsupported` result.                          |
| Runtime behavior       | Existing permission formatting, delivery, approval, and denial behavior remains unchanged.                               |
| Configuration          | Other adapters do not read `interactiveCards`, card template IDs, callback actions, or DingTalk timeout settings.        |
| Raw request data       | The existing permission formatter does not render `rawInput`, so this change does not introduce visible question JSON.   |
| Existing limitation    | `/approve` still cannot carry `ask_user_question` answers; this proposal deliberately does not hide or broaden that gap. |
| Future opt-in          | Another adapter may later override the hook, but its native form or text-answer protocol requires a separate design.     |

## Chapter 3: Future extension blueprint for other IM adapters

![Future extension blueprint for other IM adapters](./assets/dingtalk-interactive-cards-other-im-extension.png)

Future adapters opt in explicitly by overriding the same semantic hook. The shared layer does not select a platform UI or parse channel payloads. Each adapter chooses exactly one result path for a request:

| Hook result   | Adapter behavior                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presented`   | Keep the request pending, present a native form/card or a deliberately designed structured-reply protocol, and later call the responder with answers or cancellation. |
| `handled`     | Perform a one-shot semantic handoff, cancel or otherwise resolve the original request, and retain no pending input state.                                             |
| `unsupported` | Decline semantic input presentation and return control to the existing permission formatter and commands.                                                             |

An adapter that returns `presented` owns all channel-specific machinery:

- A channel-local capability configuration. It is not added to a shared card-template schema.
- A pending-input registry keyed by request, session, owner, and any run generation needed to reject stale actions.
- Native callback or structured-reply parsing that maps platform payloads to semantic answer keys.
- One-shot response, idempotency, owner validation, timeout handling, and `AbortSignal` cleanup when another surface resolves first.
- Direct response to the original request. It does not inject a synthetic user message.

Each IM should opt in through a separate change so its platform capabilities, fallback behavior, timeout, and state ownership can be reviewed independently. An adapter without a reliable answer protocol should continue returning `unsupported`.

## Scope boundaries

This proposal does not add a channel text-answer command, parse free-form replies into form fields, inject synthetic user messages, or introduce a general cross-channel card framework. Those would add a second pending-input state machine and are not required to deliver the DingTalk interaction requested by #6443.

Implementation should remain a small channel-neutral seam plus DingTalk-local state and transport code. Improving question handling for every IM would require a separately designed cross-channel text-answer protocol and is explicitly deferred to a follow-up change.
