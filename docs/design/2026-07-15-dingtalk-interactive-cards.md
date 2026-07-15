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

| Card                  | Business object                         | DingTalk protocol                                        | Local lifecycle                                                         |
| --------------------- | --------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Streaming status card | One Channel-owned prompt run            | `createAndDeliver`, `/card/streaming`, `/card/instances` | `running`, `waiting_input`, `completed`, `failed`, `cancelled`          |
| Form callback card    | One Channel-owned user-question request | `createAndDeliver`, card callback, `/card/instances`     | `pending`, `submitted`, `cancelled`, `expired`, `resolved_outside_card` |

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

## Source constraints verified

The behavioral constraints below were rechecked against `origin/main` at `38429bc100a7`:

- `packages/channels/base/src/ChannelBase.ts` registers each pending permission, including its request and chat index, before formatting or sending the existing Markdown prompt. The same registry supports multiple requests in one chat and drives `/approve`, `/approve-always`, and `/deny` lookup.
- `packages/channels/base/src/ChannelAgentBridge.ts` includes the permission outcome on `PermissionResolvedEvent`. `packages/channels/base/src/AcpBridge.ts` emits that event synchronously before a successful responder returns, while `packages/channels/base/src/DaemonChannelBridge.ts` retains a responded-request mapping and can emit the event later.
- `packages/core/src/tools/askUserQuestion.ts` permits one to four questions. `packages/acp-bridge/src/bridgeClient.ts` derives each question's `answerKey` from its array index, and the ACP session consumes a separate `answers` object in addition to the permission outcome.
- The generic permission commands submit an option or cancellation outcome, not structured answers. When more than one request is pending, the existing ambiguity response already lists request IDs and titles, so the design does not add another card field only for command disambiguation.

## Channel-neutral user-input seam

`ChannelBase` gains one semantic presentation hook with three explicit outcomes:

```ts
type UserInputPresentationResult =
  | { kind: 'presented' }
  | { kind: 'handled' }
  | { kind: 'unsupported' };

type UserInputSettlementReason =
  | 'resolved_outside_card'
  | 'request_cancelled'
  | 'run_cancelled'
  | 'expired';

type ChannelUserInputResponse = RequestPermissionResponse & {
  answers?: Record<string, string>;
};

interface ChannelUserInputRequestContext {
  requestId: string;
  sessionId: string;
  runId: string;
  target: SessionTarget;
  ownerId: string;
  request: PermissionRequestEvent['request'];
  settlementSignal: AbortSignal;
  respond(response: ChannelUserInputResponse): Promise<boolean>;
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
  presented   -> mark structured input as presented, keep pending, and return
  handled     -> remove pending and return
  unsupported -> continue
format and send the existing permission message
```

Every path that removes a pending permission settles the controller exactly once. This includes permission commands, a direct responder call, daemon `permissionResolved`, timeout, session cleanup, task cancellation, and bridge replacement. `ChannelBase` classifies an independent `permissionResolved` from its `outcome` before removing the pending request: `cancelled`, or a selected option whose original permission option is `reject_once`, becomes `request_cancelled`; any other or missing outcome becomes the neutral `resolved_outside_card`. This classification does not guess which client responded.

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

The status registry also keeps `pendingQuestionRequestIds: Set<string>` for each run. The question registry does not supersede an older request merely because a newer request exists in the same session.

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

`waiting_input` deliberately means that at least one DingTalk question card is awaiting structured answers; it is not a general host-blocked state. Ordinary tool permissions continue through the existing Markdown and permission-command path and do not move the status card out of `running`. Covering every permission wait would require a broader shared permission-lifecycle signal and is outside this two-card proposal.

The core lifecycle remains `cancelled`; no `stopped` event is introduced. A cancellation with reason `cancel_command` may be presented as “Stopped” in DingTalk, while other cancellation reasons may be presented as “Cancelled”.

Terminal updates follow one serialized order:

1. Stop accepting new streaming chunks and drain already accepted mutations.
2. If streaming was opened, close it with `isFinalize=true`.
3. Commit the final content, copyable content, status text, and `flowStatus=3` with one `/card/instances` update.

Completed, failed, and cancelled all project to DingTalk `flowStatus=3`; the final content and status text distinguish them. Once terminal, the per-`outTrackId` queue rejects late streaming updates.

## Form callback-card lifecycle

The question card represents one permission request containing the request's complete question array. The tool schema allows one to four questions, and the existing bridge derives each question's `answerKey` from its array index. One card therefore renders and submits the full set; there is no per-question registry or card lifecycle. It is created with `card_status=pending` and does not call `/card/streaming`. All presentation changes use `/card/instances` with `updateCardDataByKey=true`.

Each pending record contains:

- `requestId`, `outTrackId`, and `runId`.
- The complete ordered question set and its answer keys.
- The typed owner identity.
- The original one-shot responder.
- Timeout and settlement subscriptions.
- The local state and a terminal tombstone.

The callback order is authoritative:

1. Locate the record by `outTrackId` and correlate the request and run.
2. Parse the submit or cancel payload without changing the record.
3. Validate the action owner.
4. Synchronously claim the current live record before the first asynchronous operation.
5. Call the original responder.
6. If the same record is still current and non-terminal, update the card from the responder result.
7. Acknowledge the callback.

The card never displays submission success before the responder accepts the answer:

| Event                              | Local state             | Card projection                                                         |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| Submit responder returns `true`    | `submitted`             | Submitted and disabled                                                  |
| Cancel responder returns `true`    | `cancelled`             | Cancelled and disabled                                                  |
| `respond(...) === false`           | `cancelled`             | Non-interactive `card_status=cancelled`, “Permission no longer pending” |
| `respond(...)` throws              | `cancelled`             | Non-interactive failure projection, disabled, and not retryable         |
| Independent non-cancel settlement  | `resolved_outside_card` | Non-interactive `card_status=cancelled`, “Resolved outside this card”   |
| Independent cancel/deny settlement | `cancelled`             | Non-interactive `card_status=cancelled`, “Cancelled outside this card”  |
| Timeout                            | `expired`               | Expired and disabled                                                    |
| Request or run destroyed           | `cancelled`             | Cancelled or Stopped and disabled                                       |
| Duplicate or late callback         | Existing terminal state | Acknowledge and ignore                                                  |
| Settlement on a terminal record    | Existing terminal state | Ignore through the terminal tombstone                                   |

The `resolved_outside_card` local state is entered only from an independent non-cancel settlement event, not inferred from a `false` responder result. `false` means only that the permission response was not accepted: the request mapping may be absent, its session may be gone, or another surface may already have won. It therefore uses the existing cancelled projection with the neutral “Permission no longer pending” message.

The existing daemon bridge consumes the request-to-session mapping when `respondToPermission()` throws, and `ChannelBase` removes the pending request on the same path. A later daemon `permissionResolved` is no longer a reliable cleanup signal because the bridge may reject it as an unknown request. DingTalk therefore logs the failure, removes its pending record, retains the terminal tombstone, and immediately makes a best-effort non-success projection. It does not release the claim or promise callback retry.

`AcpBridge` emits `permissionResolved` synchronously before a successful `respondToPermission()` returns. While the DingTalk responder claim is in flight, the adapter therefore defers the matching settlement projection until the responder result and callback action are known. An accepted submit becomes `submitted`; an accepted cancel becomes `cancelled`; `false` and throws use the terminal rows above. A settlement received without a local responder claim follows the outcome-aware rows above. The daemon bridge emits its successful settlement later, after it has retained a responded-request mapping; if the card is already terminal, the tombstone ignores that event. Timeout, request/run cancellation, and task terminal events are not deferred and still take precedence. This arbitration reuses the transient claim and adds no public processing state, retry queue, or error taxonomy.

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
| Question responder returns `false`            | Finish with the existing cancelled projection and a neutral “Permission no longer pending” message.                                                                           |
| Question responder throws                     | Remove the pending record, finish the claimed record as cancelled, retain a tombstone, project non-success immediately, and do not advertise callback retry.                  |
| Another path resolves first                   | When no local responder claim is in flight, classify the settlement outcome as cancelled/denied or `resolved_outside_card` and use a neutral projection.                      |
| Request/run is destroyed                      | Settle as request/run cancellation; project the card as cancelled or Stopped.                                                                                                 |
| Another IM adapter owns the session           | Return `unsupported` and preserve its existing permission message and commands.                                                                                               |
| Ordinary permission                           | Keep `/approve`, `/approve-always`, and `/deny` unchanged; it does not affect the question-only `waiting_input` presentation state.                                           |

For a card-presented question, `/approve`, `/approve-always`, and `/deny` remain recognized commands but do not call the responder; they instruct the user to submit or cancel through the card. The card is the only DingTalk-local settlement surface for that presented request. This is required because the existing permission commands supply only an option ID or cancellation outcome, while a question submission consumes a separate `answers` object. Other permissions and adapters keep their current command behavior. The initial design does not promise automatic callback retry.

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

Permission resolution remains first-responder-wins. The transient DingTalk claim only serializes callbacks for one card and arbitrates a matching settlement that arrives during its responder call; it does not replace shared settlement. If an independent settlement arrives without a local claim, DingTalk classifies its outcome without claiming which client responded. If the card responder returns `true`, the callback action selects `submitted` or `cancelled`, and a matching `permissionResolved` is cleanup rather than evidence that another surface won.

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
