# DingTalk Tool Permission Cards

## Context

The DingTalk channel already presents running status and `ask_user_question` interactions with native cards. Ordinary non-YOLO tool permission requests still expose `/approve`, `/approve-always`, and `/deny` commands as plain text. This change extends the existing Channel presentation boundary without changing ACP, daemon routing, permission semantics, or other channel adapters.

## Goals

- Present an attended DingTalk tool permission request as a native interactive card.
- Offer allow once, deny, and the daemon-provided persistent grant when available.
- Bind callbacks to the original request, run, session, chat or thread, and prompt owner.
- Resolve the original permission at most once and terminalize stale cards.
- Preserve the existing text request when interactive cards are disabled or delivery fails.

## Non-goals

- No permission-policy, approval-mode, ACP, or session-language API changes.
- No new DingTalk card template. The existing question form template is reused with one required, single-choice permission field.
- No cross-client or group-wide voting. Only the user who started the attended Channel run may operate the card.
- No native permission-card implementation in CLI, Web, IDE, or other IM adapters.

## Channel presentation contract

`ChannelBase` exposes a second optional structured presentation hook for ordinary permissions. The context contains only adapter-neutral data: request and run identity, prompt owner, resolved Channel target, a sanitized tool title, the decisions actually offered by the permission request, a settlement subscription, and a one-shot response closure.

```ts
export type ChannelPermissionDecision = 'allow_once' | 'allow_always' | 'deny';

export interface ChannelPermissionRequestContext {
  requestId: string;
  sessionId: string;
  runId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  precedingSegmentId?: string;
  title: string;
  decisions: Array<{
    kind: ChannelPermissionDecision;
    label: string;
  }>;
  onSettled(listener: (reason: UserInputSettlementReason) => void): () => void;
  respond(decision: ChannelPermissionDecision): Promise<boolean>;
}
```

The hook is eligible only for the current attended, non-loop prompt with an owner. `ChannelBase` derives decisions from the original permission options and never lets the adapter invent an option ID. Deny remains available through the existing reject-or-cancel mapping. The existing question presenter runs first for `ask_user_question`; ordinary permission presentation runs only when that path is unsupported.

The same pending-permission response promise serializes card and text-command responses. Text commands remain unchanged when no structured presenter is active. For a native permission card, commands from the owning sender may still race safely with the card: the first accepted response wins and card settlement observes the shared pending record.

## DingTalk controller

`PermissionCardController` owns DingTalk-only state keyed by request ID and `outTrackId`. It reuses the existing question template with one `permission_decision` checkbox-group field and no free-form option. The rendered choices are literals selected from the context decisions, so `allow_always` is absent when the daemon did not advertise it.

Presentation follows four states: `reserved`, `pending`, `claimed`, and `terminal`. A record subscribes to Channel settlement before delivery so an outside resolution during the network request cannot reactivate it. Delivery failure removes the local record and returns `unsupported`; `ChannelBase` then sends the existing text request. A successful delivery starts the configured timeout.

A callback is accepted only when all of the following hold:

- `outTrackId` maps to a live pending record.
- The callback actor equals the prompt owner.
- The callback contains the expected submit or cancel action and business payload.
- For submit actions, the form contains exactly one advertised decision and no unknown fields.

The accepted callback claims the record synchronously before asynchronous permission settlement. Duplicate, malformed, stale, and terminal callbacks are acknowledged but ignored. A foreign actor receives generic owner-only feedback in the Channel locale and cannot mutate the permission or card.

## Terminal states

The controller projects these terminal states through the existing card-instance update API:

| Cause                       | Card state  | Original permission                          |
| --------------------------- | ----------- | -------------------------------------------- |
| Accepted allow decision     | `approved`  | Selected original allow option               |
| Accepted deny decision      | `denied`    | Selected original reject option or cancelled |
| Card cancel action          | `cancelled` | Denied through the one-shot responder        |
| Timeout                     | `expired`   | Denied through the one-shot responder        |
| Run or session cancellation | `cancelled` | Settled by existing Channel cleanup          |
| Resolution outside the card | `expired`   | Already settled elsewhere                    |
| Response rejected or throws | `expired`   | No retry; duplicate callbacks remain blocked |

Card updates are best-effort projections. A failed update does not reopen or retry an already settled permission.

## Configuration and compatibility

`interactiveCards.permissionCard` mirrors question-card configuration:

```json
{
  "interactiveCards": {
    "permissionCard": {
      "enabled": true,
      "timeoutMs": 270000
    }
  }
}
```

When `interactiveCards` is configured, permission cards default to enabled with the same bounded positive timeout behavior as question cards. The root `enabled` flag and the nested permission flag can disable them independently. Existing configuration shapes remain valid, and other channels do not gain a native permission-card implementation.

## Language behavior

Channel startup reads the existing default `general.language` setting once. Underscores are normalized to hyphens, then Chinese values (`zh`, `zh-*`, `Chinese`, or `中文`) select Chinese permission copy; missing, automatic, and all other values use English. The daemon worker follows the same rule. No IM request calls `/daemon/session/:sessionId/language`, and language is not resolved per session.

The selected locale is passed through the existing Channel creation options. `ChannelBase` localizes only its stock permission decision labels and command fallback while preserving tool titles, custom option labels, option IDs, and slash commands. DingTalk applies the same locale to the permission-card title, field label, submit button, terminal descriptions, and owner-only interaction feedback. Protocol card states such as `pending`, `approved`, and `expired` remain unchanged.

## Validation

- ChannelBase tests cover eligibility, exact decision derivation, one-shot response arbitration, outside settlement, and text fallback.
- Controller tests cover rendering, optional persistent grant, owner enforcement, all decisions, delivery failure, timeout, duplicate callbacks, malformed payloads, and outside settlement.
- DingTalk adapter, presenter, callback-routing, configuration, and management-schema tests cover wiring.
- Package tests, repository build, typecheck, and diff self-audit run before submission.
- A real DingTalk run is reported separately and only when valid credentials and a published template are available.
