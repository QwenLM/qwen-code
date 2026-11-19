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
`requestId`. The adapter bridges the two, and the engine exposes a
`settleDecisionRequest(requestId, witness)` seam so decision evidence can be
applied to the request's active attempt even while that attempt's POST is in
flight (its operation id is not bound yet).

Prompts (submit / cancel):

- On submit admission the adapter records `promptId -> operationId`. A terminal
  event settles only the attempts bound to its identity, never a match on the
  visible session/turn target, so a late event for a finished attempt cannot
  establish a retry that shares the same visible target.
- A turn's terminal event closes **both** the submit that started it and any
  cancel that targeted it (`promptId -> Set<operationId>`). The terminal outcome
  is projected **per bound operation kind**: a cancel is established only by a
  `cancelled` turn — a turn that completed on its own proves the cancel did not
  take effect, so it is `failed`; a submit is settled by any terminal outcome and
  failed only by a failed turn.
- The cancel targets the **active turn** — the head of the live-turn FIFO (the
  oldest admitted prompt whose terminal event has not arrived), captured at
  dispatch time — never the newest admitted id. A prompt leaves the queue when
  its terminal event arrives or its submit is rejected. A rejected prompt is
  tombstoned so a cancel targeting it (in either resolution order) takes the
  `failed` terminal exit instead of binding a never-settling row; with an empty
  queue the cancel also settles `failed` so the phase does not latch.
- A terminal event can arrive while the POST is in flight, or even before
  `onAdmitted` runs. The adapter retains the terminal outcome keyed by `promptId`
  and applies it when the attempt binds; the intent returns the post-bind outcome,
  not the pre-evidence dispatch snapshot. While a submit dispatch is unbound or a
  cancel bind is pending (a per-prompt refcount, so overlapping cancels all keep
  it), the retained outcome is not pruned, so row-retention churn cannot strand a
  pending bind. A prompt whose terminal outcome already arrived is not enqueued as
  a live cancel target.
- A submit whose transport throws **after** `onAdmitted` confirmed a prompt id is
  a real turn the client merely lost the admission response for: the prompt stays
  a live cancel target so its terminal event can settle a bound cancel, and only
  the submit row takes the `abandon` exit. A `rejected` submit (the daemon said
  no) is different: no turn ran, so it is dequeued and tombstoned.

Decisions (approval / question):

- `requestId` is stable across attempts and the daemon decision event names only
  the request (no attempt/option discriminator), so correlation is
  **request-level**: the engine routes the evidence to the request's single active
  (non-terminal) attempt and freezes approval currency **when the evidence
  arrives**, not when the POST resolves. A late event for an already-terminal
  attempt is a no-op; the binding hook dedupes replayed decision events. The
  decision target carries only `sessionId`/`requestId` (no per-attempt id), so
  terminal-row retention still dedupes per request.
- A request has **at most one non-terminal decision attempt**: a second dispatch
  while one is live (bound or in flight) is refused, so no sibling is orphaned and
  the request cannot become permanently unanswerable.
- A retry after a failed decision earns its own evidence (a failed decision keeps
  the request live). Because the engine applies evidence to the active attempt, a
  rejected or retried dispatch never inherits a previous attempt's verdict.
- A dispatch whose admission is not confirmed (`rejected`, or a thrown transport
  leaving `unknown`) is not bound as if accepted: it is given the engine's
  `abandon` exit so it cannot hold the request permanently unanswerable or latch
  the phase.

### Bounded correlation state

The correlation maps are bounded by the engine's retention: once an attempt is
no longer among the retained operations (acknowledged or superseded), its
backend identity stops being tracked. A retained prompt outcome is kept while a
dispatch still needs it — a pending cancel bind (refcounted) or an unbound submit
dispatch — and dropped otherwise, so the witness lifetime is decoupled from the
presentation row lifetime. Prompt ids are daemon-unique per turn, so a retained
orphan cannot match a later attempt. The settlement subscriptions also
deliver terminal events for identities this controller never dispatched
(replayed history, another client's decision). Those **orphan** outcomes are
dropped unless a dispatch is outstanding, so they neither accumulate nor certify
a future attempt. Rejected-prompt tombstones are cleared once no cancel bind is
pending. Decision evidence is not buffered in the controller at all — the engine
seam applies it to the active attempt — so there is no decision witness to leak.

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
pass-through facts are exposed distinctly and read live, and `loadOlder` keeps its
deps binding; the settled `failed` phase is reported when no operation holds it
open; and the signal releases all three subscriptions. The racing-correlation
cases additionally pin: a second decision dispatch while the first POST is in
flight is refused (the pending row is sampled); decision evidence during a retry
POST settles the retry, not the previous attempt; a late duplicate decision for a
terminal attempt is a no-op; a rejected decision dispatch leaves no evidence for
the next attempt; currency is frozen at evidence time in both orderings
(live-then-superseded still establishes; superseded-then-live takes the `failed`
terminal exit); decision evidence during the POST is applied once admission
resolves; an orphan decision for the same request creates nothing; a cancel bound
before / after its submit rejects is terminalized in both orders; two overlapping
cancels on a rejected prompt both terminalize; a cancel still settles when a later
submit supersedes its target rows; a submit in flight whose cancel row is
superseded still settles; a terminal event before `onAdmitted` settles the submit
and a live turn behind it is still cancellable; a cancel whose target turn
completes on its own is `failed`; a rejected submit leaves no live cancel target; a
thrown submit after admission keeps the confirmed turn cancellable; and a thrown
permission / question / cancel transport is given an exit (the decision stays
answerable and certifiable, the phase does not latch). Each fix is
mutation-discriminating: the per-kind cancel projection, the pending-cancel
refcount, the confirmed-turn retention, the terminal-before-`onAdmitted` queue
guard, and the not-confirmed `abandon` exit each red their own case when reverted
while the neighbouring cases stay green.

## Follow-ups for the surface switch

- The contract does not yet expose `acknowledge`; the surface must release
  consumed terminal rows (otherwise they grow per distinct target). `abandon` is
  already used internally to give an unconfirmed dispatch an exit.
- Decision correlation is request-level because the daemon decision event names
  only the request (no attempt/option discriminator). The binding hook must dedupe
  replayed decision events; attempt-level decision correlation would require a
  backend attempt identity the daemon does not currently emit.
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
