# Permission decision readiness

[English](2026-11-18-permission-decision-readiness.md) | [简体中文](2026-11-18-permission-decision-readiness.zh-CN.md)

Status: proposal, not implemented. Tracked as issue #17715, filed as the
follow-up to PR #17132, whose implemented behaviour is described in
[Confirmation body height budget](2026-11-14-confirmation-body-height-budget.md).

## Problem

A confirmation can be answerable while the thing it asks about is not
inspectable. The command, the proposed edit, the destination hosts, the MCP
server-plus-tool pair — the material subject of the decision — can each be
reduced to nothing on screen by viewport pressure, while the affirmative
options stay live and highlighted. Every fix in PR #17132 answers one such
frame; the reviewer's point is that the class survives the fixes, because
"an option is on screen" and "its subject was shown" are separate facts that
nothing in the current design relates.

The consequence is that a user can grant a permission whose content they had
no way to read, and the record of that grant — a selected option id — looks
identical to an informed one.

## Current state

Two independent paths answer a permission request, and neither has a notion of
readiness:

- The terminal path: `packages/core/src/core/coreToolScheduler.ts` builds the
  confirmation details and applies the answer chosen in the Ink confirmation
  (`packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx`).
- The ACP path: `packages/cli/src/acp-integration/session/Session.ts` receives
  the request and resolves the answer through
  `resolvePermissionOutcome` in
  `packages/cli/src/acp-integration/session/permissionUtils.ts`. That resolver is
  a genuine choke point on this side — the session, the tool batch in
  `acp-tool-batch.ts` and the sub-agent tracker in `SubAgentTracker.ts` all reach
  answers through it — but it sees only what a client sends it.

The same request is then rendered by clients that each compute their own layout
from their own viewport — `packages/vscode-ide-companion/src/services/acpConnection.ts`,
`packages/web-shell/client/components/messages/ToolApproval.tsx`,
`packages/cli/src/ui/opentui/dialogs-confirm.tsx`, `packages/live-host`, and the
channel bridges in `packages/channels/base` — so no renderer's layout knowledge
reaches the answer.

The request carries the tool call and the option list, and nothing about what
was shown. The shapes are not all ours: `PermissionOption`,
`RequestPermissionRequest` and `RequestPermissionResponse` come from the upstream
`@agentclientprotocol/sdk`, while the daemon side has its own
`PermissionOutcome` — `…Selected` / `…Cancelled` — in
`packages/sdk-typescript/src/daemon/types.ts`.

What the daemon does coordinate is _who_ may answer, never what they were shown.
The serve capability registry (`packages/cli/src/serve/capabilities.ts`)
advertises `permission_mediation` with the modes `first-responder`,
`designated`, `consensus` and `local-only`; the `/capabilities` envelope reports
the policy in force at runtime, and `permission_partial_vote` and
`permission_forbidden` are the existing refusal signals. The only places a
decision's _shape_ is settled centrally rather than per client are narrow
precedents: `hideAlwaysAllow` in `coreToolScheduler.ts`, and
`packages/core/src/core/plan-mode-shell-policy.ts`.

## Goals

- Distinguish, in code and in the protocol, the mandatory subject of a
  permission decision from optional explanatory prose.
- Make "the subject of this pending decision is inspectable" a stated value
  rather than an outcome of layout arithmetic that only one client can observe.
- Tie the affirmative outcome to that value, so a decision that cannot be
  inspected is not silently equivalent to one that can.

## Scope

- This document proposes the shape only. Nothing here is implemented; PR #17132
  ships the layout invariant instead, and that invariant is a precondition for
  any of this, not a substitute for it.
- Passive informational output with no affirmative action is out of scope, and
  an approval whose subject is fully visible must not gain an extra step.

## Proposed solution

1. **Semantic subject before layout.** Each confirmation type names its
   material subject as a value: the exact operation, what the permission covers
   (exec command, proposed edit, each concrete destination, MCP server _and_
   tool), the requested scope, and the decision-critical warnings. Explanatory
   prose is not part of it. PR #17132 already encodes this ordering as a row
   rule — the subject outranks prose when rows run out — so the concept exists;
   the change is to make it something other code can read.
2. **A readiness state per request.** `inspectable`: the subject is drawn in
   the frame the answer is taken from. `escapable`: the subject is not in that
   frame, but a full-detail path exists and is known to work. `unavailable`:
   neither. A rendered hint, an ellipsis, or an overflow id does not satisfy
   `escapable`; today's `ctrl-s` reveal does not either, because it is
   suppressed while the prompt buffer holds a draft.
3. **Bind the affirmative outcome to it.** Approving requires `inspectable` or
   `escapable`. At `unavailable`, reject and cancel stay live; approval first
   requires opening a guaranteed inspection surface. The underlying action and
   permission scope of the selected option never change — only whether it can be
   selected yet.

## Design decisions and rationale

- **Not in the layout layer.** A readiness flag computed inside
  `ToolConfirmationMessage` describes one Ink frame. The VS Code companion,
  web-shell, OpenTUI, live host and the channel bridges make their own layout
  decisions for the same request, so a flag they never set means nothing to the
  answer they send.
- **The answer has to carry it.** For readiness to constrain a decision, it has
  to travel with the outcome, which means a field on the ACP permission response
  and the matching daemon SDK type, consumed by both answer appliers. That is a
  protocol change with a compatibility window, not a component change.
- **Advertise it the way other daemon features are advertised.** The capability
  registry already handles the absent-field problem for permission behaviour: the
  SDK tells clients to pre-flight the `permission_mediation` tag before relying on
  the mediation events, because older daemons do not emit them. A readiness field
  can follow that convention, which makes the daemon path decidable — no tag means
  today's behaviour, tag present means the field is expected.
- **The ACP half is not ours to change.** The permission option and outcome
  shapes belong to `@agentclientprotocol/sdk`, so no change in this repository
  can make an ACP-native client carry a readiness value. The gate therefore
  exists for first-party clients first, and the split guarantee is the honest
  state of the design, not an implementation detail to be smoothed over.
- **Fail closed needs a floor.** A gate that blocks approval when readiness
  cannot be established turns any bug in the readiness computation into a way to
  strand a user's own request. Any `unavailable` handling needs an escape the
  user can always reach — which is exactly what is missing on headless channels
  that have no reveal affordance.

## Constraints

- The permission request and its outcome cross ACP, `packages/acp-bridge`, the
  daemon SDK types and the channel bridges; adding a field is a public protocol
  change with external consumers.
- Both answer appliers must honour the state, or the gate is a suggestion.
- Readiness must be established from what was actually drawn or from a proven
  path, never from the budget numbers — the same reason PR #17132's tests assert
  rendered frames rather than arithmetic.
- One subject model per confirmation type must serve a six-row terminal, a web
  panel and a notification-driven channel without inventing a per-client
  definition of "enough".
- A gate that lives in one client is not a gate under `first-responder`
  mediation, where any client that ignores readiness can answer the request
  first. Enforcement has to sit at an answer applier, and all four mediation
  modes — including `local-only`, where remote voters are refused outright — have
  to reach a coherent outcome under it.
- A proven full-detail path exists today for only some confirmation types: the
  full plan in an editor, and a proposed edit in an external editor when one is
  configured. `escapable` therefore cannot be assumed available wherever a hint
  happens to appear.

## Risks and trade-offs

- Approvals that were already legible could gain a step if `inspectable` is
  computed too conservatively.
- Clients that implement the field and clients that do not will present
  different guarantees for the same request, which is worse for a user than one
  uniform (weak) guarantee until the rollout finishes.
- The gate creates a new way to block legitimate work; every fix in this area
  needs a reachable escape hatch.

## Validation plan

- Protocol round-trip tests at both appliers: a selected option with each
  readiness value, and the absent-field case, asserted against the resulting
  scheduler behaviour rather than the types alone.
- A per-client contract test that renders a subject known not to fit and asserts
  the state the client reports — the same frame-witness style used in
  `ToolConfirmationMessage.test.tsx`, because a value computed from arithmetic
  can be green while the frame is unreadable.
- A cross-client case on one request: terminal, web-shell and the VS Code
  companion, checking they report the same state for the same content at the
  same size.

## Acceptance criteria

- One named notion of the material subject per confirmation type, read by the
  renderer and by the answer path, not re-derived in each.
- A permission decision cannot be granted affirmatively while its state is
  `unavailable`, and the reject and cancel outcomes stay available.
- `escapable` is only ever set by a path that was demonstrated to work at the
  moment the request was on screen.
- Existing clients keep working, and the rollout state of the gate is visible
  rather than implied.

## Open questions

1. The capability tag settles the absent-field case on the daemon path and
   cannot on the ACP path. Is a gate covering only first-party clients worth the
   split guarantee, or must the idea go upstream before it is worth building?
2. Can a client state `inspectable` without measuring its own layout, or must
   every renderer wire a measurement into the answer?
3. What is the guaranteed inspection surface for a channel with no reveal
   affordance — and if none exists, is such a channel ever allowed to offer an
   affirmative option?
4. Should readiness be recorded with the decision afterwards, so a later audit
   can tell an informed grant from an uninformed one?
5. Should an `unavailable` refusal reuse the existing `permission_forbidden`
   surface, or need its own outcome, so that "you may not answer this" and "you
   have not seen enough to answer this" stay distinguishable in a transcript?
