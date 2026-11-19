# Daemon Chat Controller Assembly (Slice 2c)

[English](2026-11-19-daemon-chat-controller.md) |
[简体中文](2026-11-19-daemon-chat-controller.zh-CN.md)

Status: implemented (slice 2c, adapter core). Date: 2026-11-19. Part of the
[unified chat surface](2026-11-16-unified-chat-surface.md) migration. Builds on
the merged contract (#17520), composer decoupling (#17661), status-stack
extraction (#17684), and the daemon intent engine (#17709).

## Scope

Slice 2b landed the intent lifecycle engine (`createDaemonChatIntents`): it
keeps admission separate from outcome and binds settlement to a dispatched
operation id, but it does not know the daemon's backend identities. This slice
lands the **daemon adapter's controller assembly**,
`createDaemonChatController(deps)`, which wraps injected provider facts and
actions into the backend-neutral `SessionChatController` and discharges the
correlation requirement the engine left open: an incoming daemon event is bound
to the attempt it belongs to **before** it can settle anything.

The adapter's new logic is the correlation, not the transcript or the
sub-controllers. Transcript messages, status facts, capability flags, and the
capability-gated sub-controllers are passed through from the provider; the
adapter does not re-project or re-derive them. The binding hook that constructs
`deps` from `DaemonSessionProvider` contexts, and the `ChatSurface` component
that consumes the controller, are the next steps (the surface switch, with the
visual before/after gate).

## Dependency injection

`createDaemonChatController(deps)` is a pure assembly: every provider fact and
action is injected, so it is testable without mounting the ~7k-line session
provider. Fact fields are read on each access through getters, so a `deps`
object with getter-backed fields stays current across renders; the binding hook
backs them with live provider state. Transports resolve to an **admission
only**; authoritative outcome evidence arrives through separate subscriptions.

- `submitPrompt(input, onAdmitted)` reports the daemon's `promptId` at admission
  (the provider's `onAdmitted` hook), before the turn runs.
- `cancelPrompt()`, `submitPermission(requestId, optionId)`,
  `submitQuestionAnswers(requestId, answers)` are admission-only.
- `subscribePromptSettlement` delivers a turn's terminal event
  (`completed` / `cancelled` / `failed`) keyed by `promptId`.
- `subscribeDecisionSettlement` delivers whether a decision was applied to the
  request it names.
- `subscribeApprovalCurrency` marks a request live on arrival and not-live only
  when superseded or cancelled — never merely because it was answered.
- `signal` releases the evidence subscriptions when aborted (the binding hook
  ties it to the controller's mounted lifetime).

## Correlation: evidence must name the attempt it establishes

The engine settles by operation id; the daemon's events name a `promptId` or
`requestId`. The adapter bridges the two:

- On submit admission the adapter records `promptId -> operationId`; on an
  approval/question dispatch it records `requestId -> operationId`. A terminal
  event settles only the attempts bound to its identity, never a match on the
  visible session/turn target. A late event for a finished attempt therefore
  cannot establish a retry that shares the same visible target.
- A turn's terminal event closes **both** the submit that started it and any
  cancel that targeted it: `promptId -> Set<operationId>`. The cancel targets the
  **active turn** — the head of the live-turn FIFO (the oldest admitted prompt
  whose terminal event has not arrived), captured at dispatch time — never the
  newest admitted id, which may be a queued prompt or a turn that already ended.
  A prompt leaves the queue when its terminal event arrives or its submit is
  rejected. With no live turn to bind, the cancel is settled `failed` so the
  phase does not latch on a permanent non-terminal row.
- The engine returns the operation id only after the transport resolves, but a
  terminal event can arrive while the POST is still in flight. The adapter
  retains the terminal witness keyed by the backend identity and applies it when
  the attempt is bound, so in-flight evidence is not dropped. The intent method
  returns the outcome the attempt actually reached (post-bind), not the
  pre-evidence dispatch snapshot.
- A prompt has exactly one terminal event; retaining it also lets a cancel
  dispatched while the turn was ending still settle. Prompts get a fresh id per
  turn, so retention cannot leak one turn's verdict onto another.
- A **decision** witness is different: `requestId` is stable across attempts, so
  the witness is retained only for the window between the event and its
  attempt's bind, then **consumed**. A retry on the same request must earn its
  own evidence; a failed decision keeps the request live (non-supersession) and
  the retry can still establish.
- A **rejected** dispatch is never bound: its dropped operation id would
  reference nothing retainable, and binding it would let the prune destroy a
  retained in-flight witness belonging to another attempt. Only a submit's bind
  clears its prompt from the in-flight set.
- A request has **at most one non-terminal decision attempt**: a second
  `respondApproval`/`respondQuestion` while one is live is refused, because the
  decision event names the request, not the option, so a sibling could never be
  settled distinctly and would leak a permanent non-terminal row.

### Bounded correlation state

The correlation maps are bounded by the engine's retention: once an attempt is
no longer among the retained operations (acknowledged or superseded), its
backend identity stops being tracked. In addition, the settlement subscriptions
deliver terminal events for identities this controller never dispatched
(replayed history, another client's decision). Those **orphan** witnesses are
dropped unless the identity is an in-flight attempt awaiting its bind, so they
neither accumulate nor certify a future attempt. An in-flight attempt's early
terminal event is kept (it is in the in-flight set) until the bind applies it.

## Invariant preserved

Admission is not establishment. A resolved transport alone leaves the outcome
`unsettled`; only a bound terminal/decision witness raises it. A superseded or
unidentified approval never establishes on positive evidence (the engine's
currency guard), while negative evidence still terminalizes the attempt. The
negative tests land with this adapter, as the parent design requires.

## Tests

`chat-controller.test.ts` pins, with a fake injected provider: a resolved submit
stays unsettled until the turn settles; a failed turn terminalizes; a rejected
submit is not tracked; a late event for a finished attempt cannot establish a
retry on the same target; out-of-order events keep their effect on the attempt
they name; in-flight evidence is applied once admission resolves; an orphan
terminal event cannot certify a later attempt; a duplicate terminal event does
not re-settle; a resolved cancel stays `cancelling` until the turn settles
cancelled; a cancel after the turn already settled neither certifies nor latches;
a cancel binds the active (FIFO-head) turn, not a queued prompt; a rejected cancel
in flight does not strand the submit it overlaps; a decision applied to a live
request establishes while a superseded one never does; an accepted decision
without evidence stays unsettled; a retry after a failed decision earns its own
evidence; a rejected decision dispatch does not corrupt the correlation; a second
decision dispatch while one is live is refused; a question answer establishes;
pass-through facts are exposed and read live; the settled `failed` phase is
reported when no operation holds it open; and the signal releases the
subscriptions. Each fix is mutation-discriminating: reverting the active-turn
target reds the queued-cancel case; restoring the never-consumed decision witness
reds the retry case; binding a rejected cancel reds the overlapping-submit case;
hard-coding the settled phase reds the `failed` case; removing the refusal reds the
double-dispatch case; removing the orphan-prune reds the orphan case while the
in-flight case stays green.

## Follow-ups for the surface switch

- The contract does not yet expose `acknowledge` / `abandon`; the surface must
  release consumed terminal rows (otherwise they grow per distinct target) and
  give a thrown transport an exit. These are added when the surface consumes the
  controller.
- A cancel dispatched with no live turn settles `failed` (a terminal exit); the
  surface still enables cancel only while a turn is in flight.
- `deps.settledPhase` is populated by the binding hook from the session's settled
  state; its `failed` read is pinned by a test here so the branch is not dead.
- The binding hook (provider contexts -> `deps`, using the existing daemon
  capability mapping) and the `ChatSurface` main-column switch with the visual
  before/after gate are the next increments.

## Constraints respected

- No daemon routes, Java routes, or OpenAPI change; no UI behavior change (the
  controller is not yet rendered).
- The adapter lives under `daemon/`, outside `chat-core`; it imports the contract
  and the engine, and `chat-core` imports nothing from it.
- Session id namespaces and storage keys are untouched.
