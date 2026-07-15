# DingTalk Interactive Cards

## Status

Design proposal for [#6443](https://github.com/QwenLM/qwen-code/issues/6443). This document defines the architecture and ownership boundaries before implementation begins. This PR remains a design-only draft and does not change runtime behavior.

## Motivation

The DingTalk channel can already deliver Markdown, receive task lifecycle events, relay permission requests, and cancel an active prompt. It does not provide an in-place running-status card, an exact-run Stop action, or a form card that can return structured `ask_user_question` answers to the original request.

The design adds those DingTalk interactions without teaching the model, tools, ACP schema, or other channel adapters about DingTalk templates and callback payloads.

## Chapter 1: Target architecture

![DingTalk interactive cards architecture](./assets/dingtalk-interactive-cards-architecture.png)

The architecture has four ownership layers:

1. Core and ACP continue to own semantic questions and permission resolution.
2. `ChannelBase` owns pending-request registration, settlement, and exact-run cancellation.
3. The DingTalk adapter owns card presentation, callback routing, registries, idempotency, and degradation.
4. DingTalk Card OpenAPI owns delivery, streaming updates, instance updates, and callback transport.

There are two card types, not one generic card lifecycle:

| Card                  | Business object                         | DingTalk protocol                                        | Local lifecycle                                                       |
| --------------------- | --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| Streaming status card | One Channel-owned prompt run            | `createAndDeliver`, `/card/streaming`, `/card/instances` | `running`, `waiting_input`, `completed`, `failed`, `cancelled`        |
| Form callback card    | One Channel-owned user-question request | `createAndDeliver`, card callback, `/card/instances`     | `pending`, `submitted`, `cancelled`, `expired`, `externally_resolved` |

They share authentication and callback ingress, but they keep independent registries and state machines.

## Existing capabilities reused

- `ask_user_question` already defines questions, options, multi-select behavior, and semantic answer keys.
- ACP permission metadata identifies a user-question interaction and preserves the questions.
- Pending permissions already have request IDs and a one-shot response path.
- `ChannelBase` already supports multiple pending permission requests for the same chat.
- Task lifecycle events already expose `started`, text chunks, tool calls, `completed`, `failed`, and `cancelled`.
- Active-prompt cancellation already powers `/cancel`.
- DingTalk already has Stream connectivity and a generic downstream callback ingress.
- CLI/TUI, Web, and IDE surfaces already render user questions natively.

## Channel-neutral user-input seam

`ChannelBase` gains one semantic presentation hook with three explicit outcomes:

```ts
type UserInputPresentationResult =
  | { kind: 'presented' }
  | { kind: 'handled' }
  | { kind: 'unsupported' };

type UserInputSettlementReason =
  | 'answered_elsewhere'
  | 'request_cancelled'
  | 'run_cancelled'
  | 'expired';

interface ChannelUserInputRequestContext {
  requestId: string;
  sessionId: string;
  runId: string;
  target: SessionTarget;
  ownerId: string;
  request: PermissionRequest;
  settlementSignal: AbortSignal;
  respond(response: PermissionResponse): Promise<boolean>;
}

protected presentUserInputRequest(
  context: ChannelUserInputRequestContext,
): Promise<UserInputPresentationResult>;
```

`settlementSignal.reason` contains a `UserInputSettlementReason`. The context contains no template ID, action ID, or DingTalk callback payload.

The hook is inserted after the pending permission and its settlement controller are stored, but before the existing permission formatter and sender:

```text
store PendingPermission + settlement controller
active = current Channel-owned ActivePrompt for event.sessionId
if request is ask_user_question and active has runId + ownerId:
  construct context from active
  result = presentUserInputRequest(context)
  presented   -> keep pending and return
  handled     -> remove pending and return
  unsupported -> continue
format and send the existing permission message
```

Every path that removes a pending permission settles the controller exactly once. This includes permission commands, a direct responder call, daemon `permissionResolved`, timeout, session cleanup, task cancellation, and bridge replacement. `answered_elsewhere` is distinct from request or run destruction so an adapter never labels a cancelled question as answered on another surface.

The hook is only eligible for the current Channel-owned `ActivePrompt`. When no such prompt, `runId`, or owner exists, `ChannelBase` does not construct the context or invoke the hook; it treats presentation as `unsupported` and continues the existing permission path. A run started by CLI, Web, IDE, SDK, or another client therefore creates neither DingTalk card. The initial design does not add cross-client run ownership or identity federation.

The default hook returns `unsupported`. Other IM adapters therefore retain their current permission formatting and commands.

## Exact-run identity and cancellation

Every prompt invocation creates an opaque unique `runId` and stores it on the corresponding `ActivePrompt`. It is not the daemon lifecycle generation, which changes for session lifecycle operations rather than every prompt.

A status-card Stop callback carries that `runId`. The card-bound cancellation entry point reads the current active prompt once and atomically checks the expected `runId` against it before cancellation. A missing active prompt or a missing, stale, or mismatched ID returns `false`; the card-bound path never falls back to session-only cancellation. Existing `/cancel` behavior remains session-scoped and unchanged.

The accepted Stop sequence is:

1. Validate the callback owner and card identity.
2. Synchronously claim the current live callback before the first asynchronous operation.
3. Ask `ChannelBase` to cancel the exact expected run.
4. If cancellation returns `true`, block new status-card chunks, close streaming, and commit the Stopped presentation.
5. If cancellation returns `false` and the same record is still current and non-terminal, release the claim, keep the card active, and allow a retry.

The claim is an adapter-local in-flight lock, not a lifecycle state. An asynchronous result can update or release only the same still-current, non-terminal record; a timeout, settlement, or terminal lifecycle event that wins during the await cannot be overwritten. This prevents an old card from cancelling a newer prompt, prevents duplicate callbacks from racing, and avoids claiming success before cancellation succeeds without adding a public `processing` state.

## Owner-only card actions

Card-action authorization is stricter than shared-session message authorization. Stop, submit, and cancel are always owner-only regardless of `sessionScope`.

At inbound-message time, DingTalk already prefers `senderStaffId` and falls back to `senderId` for the envelope sender. Card creation stores a typed owner key in the same identity domain. The callback router normalizes the callback's `userId`, `senderStaffId`, or `senderId` into a comparable typed key and requires an exact match. If no comparable identity is available, the action fails closed.

A foreign-user callback is acknowledged and logged but cannot mutate a run, permission request, or card.

## DingTalk-local implementation

Only the DingTalk adapter reads `interactiveCards` and registers the card callback topic. It owns:

- A shared authenticated Card OpenAPI client.
- A status-card registry keyed by `runId` and `outTrackId`.
- A question-card registry keyed by `requestId` and `outTrackId`.
- An owner-validating callback router.
- Per-card serialized update queues, transient in-flight claims, and terminal tombstones.
- DingTalk-local fallback and structured error reporting.

The status registry also keeps `pendingQuestionIds: Set<string>` for each run. The question registry does not supersede an older question merely because a newer question exists in the same session.

## Streaming status-card lifecycle

The status card represents one Channel-owned run. Runs initiated by CLI, Web, IDE, SDK, or another client can still affect shared session state, but they do not create a DingTalk status card.

Creation and streaming follow DingTalk's streaming-card protocol:

1. Call `createAndDeliver` with a unique `outTrackId` and initial `flowStatus=2`.
2. Open streaming with an empty full update using `isFull=true`, `isFinalize=false`, and `isError=false`.
3. Send high-frequency model output through `/card/streaming`.
4. Send low-frequency template variables such as status text through `/card/instances` with `updateCardDataByKey=true`.

`running` and `waiting_input` are Qwen Code presentation states; both keep DingTalk `flowStatus=2` and streaming open. The transition rules are:

```text
started -> running
running -> waiting_input                 when the first question becomes pending
waiting_input -> waiting_input           while any question remains pending
waiting_input -> running                 when the final question settles and the run is active
running | waiting_input -> completed
running | waiting_input -> failed
running | waiting_input -> cancelled
```

The core lifecycle remains `cancelled`; no `stopped` event is introduced. A cancellation with reason `cancel_command` may be presented as “Stopped” in DingTalk, while other cancellation reasons may be presented as “Cancelled”.

Terminal updates follow one serialized order:

1. Stop accepting new streaming chunks and drain already accepted mutations.
2. If streaming was opened, close it with `isFinalize=true`.
3. Commit the final content, copyable content, status text, and `flowStatus=3` with one `/card/instances` update.

Completed, failed, and cancelled all project to DingTalk `flowStatus=3`; the final content and status text distinguish them. Once terminal, the per-`outTrackId` queue rejects late streaming updates.

## Form callback-card lifecycle

The question card represents one permission request. It is created with `card_status=pending` and does not call `/card/streaming`. All presentation changes use `/card/instances` with `updateCardDataByKey=true`.

Each pending record contains:

- `requestId`, `questionId`, `outTrackId`, and `runId`.
- The typed owner identity.
- The original one-shot responder.
- Timeout and settlement subscriptions.
- The local state and a terminal tombstone.

The callback order is authoritative:

1. Locate the record by `outTrackId` and correlate the request, question, and run.
2. Parse the submit or cancel payload without changing the record.
3. Validate the action owner.
4. Synchronously claim the current live record before the first asynchronous operation.
5. Call the original responder.
6. If the same record is still current and non-terminal, update the card from the responder result.
7. Acknowledge the callback.

The card never displays submission success before the responder accepts the answer:

| Event                      | Local state             | Card projection                                                                     |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `respond(...) === true`    | `submitted`             | Submitted and disabled                                                              |
| `respond(...) === false`   | `externally_resolved`   | Non-interactive `card_status=cancelled`, “Handled in another client”                |
| `respond(...)` throws      | Remains non-terminal    | Non-success and non-interactive; existing settlement or timeout finishes the record |
| User cancellation accepted | `cancelled`             | Cancelled and disabled                                                              |
| Timeout                    | `expired`               | Expired and disabled                                                                |
| Request or run destroyed   | `cancelled`             | Cancelled or Stopped and disabled                                                   |
| Duplicate or late callback | Existing terminal state | Acknowledge and ignore                                                              |

The `externally_resolved` local state is intentionally projected onto an existing non-interactive template state; the initial design does not require a template change.

The existing daemon bridge consumes the request-to-session mapping even when `respondToPermission()` throws, so the adapter must not release the claim and promise a callback retry: a second attempt returns `false` and could be misreported as externally resolved. On a thrown responder, DingTalk logs the failure, makes a best-effort non-success projection, and leaves final cleanup to the existing settlement signal, another subscribed surface, or timeout. This adds neither a retry queue nor a new business-state/error taxonomy.

An instance update is a UI projection, not the permission transaction. If the responder succeeds but the subsequent card update fails, the permission remains resolved, the local record remains terminal, duplicate callbacks remain rejected, and the adapter logs the failed UI projection.

Unlike the OpenClaw reference implementation, Qwen Code does not inject a synthetic inbound message. It responds directly to the original permission request. It also does not supersede other pending questions in the same run: the status card derives `waiting_input` from the complete request-ID set.

## Configuration and built-in templates

The capability configuration is local to DingTalk:

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

The effective question lifetime is the smaller of the configured timeout and the host permission lifetime.

Template IDs are built-in DingTalk Channel assets, not user configuration:

- Status card: `675cde2f-f526-40cb-b828-f5b2b57b8b77.schema`
- Question card: `c2a6355b-9724-4f7e-9653-d33fcb3311bb.schema`

The design does not add user-supplied template configuration or a startup health check. A first-use OpenAPI rejection is reported with the template ID and enters the documented degradation path.

Evidence for the built-in asset contract and callback flow:

- [soimy/openclaw-channel-dingtalk#583](https://github.com/soimy/openclaw-channel-dingtalk/pull/583) is merged and records real-device card delivery, submit callback, cancel callback, and task-continuation verification.
- [soimy/openclaw-channel-dingtalk#585](https://github.com/soimy/openclaw-channel-dingtalk/pull/585) is merged, ships the final question-card template asset, and was approved by the maintainer.

These PRs provide Card OpenAPI and template evidence. Qwen Code does not copy their synthetic-message reinjection or single-question supersede semantics.

## Degradation behavior

The initial design does not add a background retry queue and does not retain a persistent `presentation_failed` state.

| Situation                                     | Behavior                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status card disabled or creation/update fails | Continue the same turn with existing Markdown delivery and record a structured card error.                                                                                    |
| Question card created                         | Return `presented`; keep the original permission pending.                                                                                                                     |
| Question card disabled or creation fails      | Send readable semantic Markdown, state that the question was cancelled and can be retried, cancel the original request, return `handled`, and log the template-aware failure. |
| No current Channel-owned active run           | Treat presentation as `unsupported`; skip both DingTalk cards and preserve the existing permission path.                                                                      |
| Exact-run cancellation returns `false`        | Release the transient claim only if the same record remains current and non-terminal; keep the status card active so Stop can be retried.                                     |
| Question responder throws                     | Do not advertise callback retry; keep a non-success projection and let existing settlement or timeout close the record.                                                       |
| Another surface answers first                 | Settle as `answered_elsewhere`; project the card as handled elsewhere.                                                                                                        |
| Request/run is destroyed                      | Settle as request/run cancellation; project the card as cancelled or Stopped.                                                                                                 |
| Another IM adapter owns the session           | Return `unsupported` and preserve its existing permission message and commands.                                                                                               |
| Ordinary permission                           | Keep `/approve`, `/approve-always`, and `/deny` unchanged.                                                                                                                    |

`/approve` is not a question-card fallback because it cannot carry structured answer values. The initial design does not promise automatic callback retry.

## Client impact

| Client or surface                                          | Behavior after this proposal                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| DingTalk Channel-owned run                                 | Create and update the streaming status card.                                           |
| DingTalk Channel-owned question request                    | Present the form callback card or DingTalk-local semantic fallback.                    |
| DingTalk-routed request without a Channel-owned active run | No DingTalk card; preserve the existing permission path.                               |
| CLI/TUI                                                    | No change; continue using the native question dialog.                                  |
| Web/Desktop                                                | No change; continue using the native question component and existing action transport. |
| IDE/ACP                                                    | No schema change; continue using the native ACP question UI.                           |
| SDK and custom ACP clients                                 | No protocol change.                                                                    |
| Other IM adapters                                          | No direct code or behavior change; inherit `unsupported`.                              |
| Ordinary permissions                                       | No change on any client.                                                               |

Permission resolution remains first-responder-wins. The transient DingTalk claim only serializes callbacks for one card; it does not replace shared settlement arbitration. If another surface wins, DingTalk becomes `externally_resolved`; if DingTalk wins, the other surfaces observe the original permission resolution and close their presentation.

## Chapter 2: Current impact on other IM adapters

![Other IM impact after the channel-neutral hook](./assets/dingtalk-interactive-cards-other-im-impact.png)

The shared hook is an opt-in seam, not a rollout of DingTalk behavior. Feishu, QQ, Telegram, WeCom, Weixin, and plugin adapters do not read DingTalk configuration, template IDs, callback actions, or card states. Their existing permission formatting and commands remain unchanged.

The existing limitation remains explicit: `/approve` cannot carry `ask_user_question` answers. This proposal does not silently cancel questions or expose raw request JSON on other IM adapters.

## Chapter 3: Future extension blueprint

![Future extension blueprint for other IM adapters](./assets/dingtalk-interactive-cards-other-im-extension.png)

A future IM adapter may explicitly override the semantic hook for a request tied to its own current `ActivePrompt`. An adapter returning `presented` must own its platform presentation, callback or structured-reply parser, pending registry, owner and run checks, timeout, cause-aware settlement, idempotency, and direct response to the original request. It must not inject a synthetic user message merely to resume the run.

Each adapter should opt in through a separate change so its platform-specific capability and state ownership can be reviewed independently.

## Risks and scope boundaries

The first implementation is intentionally daemon-local. Pending-card registries and tombstones are tied to the process lifetime; restart-safe recovery and non-sticky multi-instance callback routing require a separate persistence design.

This proposal does not add cross-client run ownership or identity mapping, a cross-channel text-answer protocol, free-form reply parsing, synthetic message injection, a general cross-channel card framework, a callback retry system, or a new processing/error state machine. Runtime implementation and end-to-end verification follow only after this design is accepted.
