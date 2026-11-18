# Daemon Chat Adapter: Intent Lifecycle (Slice 2b)

[English](2026-11-18-daemon-chat-intents.md) |
[简体中文](2026-11-18-daemon-chat-intents.zh-CN.md)

Status: implemented (slice 2b). Date: 2026-11-18. Part of the
[unified chat surface](2026-11-16-unified-chat-surface.md) migration. Slice 1
(#17520) landed the contract and the pure admission/outcome helpers; the
composer decoupling (#17661) and the shared status-stack extraction (#17684)
are merged. This slice lands the daemon adapter's intent lifecycle core and
the negative tests that prove the admission-is-not-establishment invariant.

## Scope

The daemon adapter turns daemon session state and actions into the
backend-neutral `SessionChatController`. Its novel logic is not the transcript
or the sub-controllers — those are assembled from the existing provider in the
next step — but the **intent lifecycle**: how a submit, cancel, approval, or
question reports admission and outcome without ever conflating a resolved
transport call with an established effect.

This slice delivers that lifecycle as a small, dependency-injected engine,
`createDaemonChatIntents`, together with the three negative tests the parent
design requires to land with the daemon adapter (a delayed turn outcome, an
unsettled cancel, and a superseded approval) and a witness-correlation test
that keeps each piece of evidence bound to the attempt it settles. Wiring the engine to the real
`DaemonSessionProvider` actions and evidence, and assembling the rest of the
controller surface (messages, pending approvals/questions, sub-controllers),
is the following step (slice 2c) that switches the main column onto
`ChatSurface`. Nothing in the existing UI changes in this slice.

## The invariant, restated

The contract separates two facts that a single "completed" label would
conflate:

- **Admission** — was the request accepted by the backend (`accepted`,
  `rejected`, `unknown`). This is what a transport call reports.
- **Outcome** — does authoritative evidence show the intended effect is
  established (`established`, `unsettled`, `failed`). This comes only from a
  witness: a turn end, a cancellation settlement, a decision applied to the
  still-current request.

A resolved promise is admission, never establishment. Slice 1 already pins the
truth table (`resolveOutcome`) and the operation retention / phase derivation
as pure functions. This slice pins the **lifecycle** that feeds them: the
engine must source the witness from evidence, not from the transport promise.

## Design

`createDaemonChatIntents()` returns a tracker with:

- `dispatch(kind, target, transport)` — mints an operation id, snapshots the
  target (frozen, so a caller that keeps and mutates its object cannot retarget
  the recorded attempt), and records the attempt as `pending` **before** running
  the transport, so the row exists (and evidence can bind to it) while the
  request is in flight and rows stay in dispatch order. It then derives admission
  (`accepted` / `rejected`; a thrown transport is `unknown`) and returns
  `{ operationId, result }`. The operation id is the identity its settlement
  evidence must name. With no evidence yet the outcome is resolved with witness
  `none`, so an admitted intent is `unsettled`; evidence that arrived during the
  POST is retained and applied once admission resolves. A `rejected` admission
  carries no outcome and drops the row, so settling its id is a no-op.
- `settle(operationId, witness)` — applies authoritative evidence to the one
  attempt that id identifies and recomputes its outcome. Unknown or
  already-terminal ids are a no-op, so evidence can never settle an attempt it
  was not dispatched for, and a finished attempt can never be re-settled. For
  approvals a **settled** decision establishes only while its request is still
  live: if the recorded `target.requestId` is absent or not in the live set, the
  positive witness is forced to `none` and the decision does not establish.
  Negative evidence is not rewritten, so a superseded decision that genuinely
  failed still terminalizes as `failed`. Once an approval settles terminal the
  engine releases its request identity, so the live set does not grow with every
  answered request.
- `abandon(operationId)` — gives an attempt whose admission can never be
  confirmed (a thrown transport leaves it `unknown`, which no witness can
  terminalize) an exit: it terminalizes the row as `failed`, never
  `established`, so a failed transport does not latch the phase open. Unknown
  ids, already-terminal attempts, and attempts with a confirmed admission are a
  no-op — a live accepted turn keeps its chance to settle.
- `acknowledge(operationId)` — releases a terminal row once the surface has
  consumed it (delegates to slice 1 `acknowledgeOperation`); non-terminal rows
  are kept, and terminal rows stay readable until acknowledged. Superseded
  terminal rows are pruned from the internal log on every rebuild, so
  acknowledging the latest terminal row cannot resurrect an older one.
- `setApprovalRequestLive(requestId, live)` — tracks the **set** of approval
  requests still valid (not superseded). The daemon keeps several permission
  requests pending at once, so currency is membership in that set, not a single
  "newest" id. Mark a request live when it arrives and not-live only when it is
  superseded or cancelled — not when it is answered; the engine releases the
  identity on settle, so a decision establishes while its request has not been
  superseded.
- `operations` — the retained operation list (slice 1 `retainOperations`:
  every non-terminal entry, at most the latest terminal per kind and target,
  latest by dispatch order). The snapshot is materialized once per state change,
  so its identity is stable between changes and can back a
  `useSyncExternalStore` cache.
- `phase(settled)` — slice 1 `deriveChatPhase`; an unestablished cancel
  operation yields `cancelling`, independent of the cancel promise resolving.

The engine imports only `chat-core` contract types and helpers. It imports no
daemon runtime and no `@qwen-code/sdk/daemon`, so it is testable without a
daemon and sits outside the kernel as the daemon adapter's core, per the
parent design's adapter placement. Its form is backend-neutral; the managed
adapter (slice 3) owns its own receipts/revisions mapping and may share this
lifecycle by lifting it into the kernel then, not by importing `daemon/**`.

### Why a separate `settle` entry point

If `dispatch` derived the witness from the transport promise resolving, a fast
or mocked transport would masquerade as an established effect. Keeping `settle`
as the only path that can raise a witness makes the invariant structural: the
transport path literally cannot produce `established`. The negative tests below
turn red if that boundary is collapsed.

### Why settlement names the attempt

A witness authenticates an outcome only if it belongs to the attempt it
establishes; local correctness of the status and provenance of the evidence are
separate conditions. Matching evidence to an operation by kind plus the visible
target is not enough: a retry on the same session/turn reuses that target, so a
late witness from a finished attempt would elevate the retry, and two witnesses
arriving out of order would swap attempts. `dispatch` therefore returns an
operation id and `settle` requires it, so the engine can raise the witness of
the named attempt only, and settling a terminal attempt is a no-op.

An id the engine invents after the fact authenticates nothing on its own: slice
2c must record the operation id beside the backend identity of the request it
just made, so an incoming event names the attempt it belongs to. An event the
adapter cannot bind stays unverified instead of declaring a new attempt
complete.

The attempt is recorded **before** the transport runs, for two reasons. Rows
then sit in dispatch order, and retention — which keeps the latest terminal row
per kind and target by position — keeps the later-_dispatched_ attempt rather
than the later-_resolved_ one when two sends on the same target overlap. And the
row (with its id) exists while the request is in flight, so the phase reads
`submitting` and evidence arriving during the POST has an id to bind to.

### Currency is a set, and a failed transport has an exit

A single "current request" slot conflates two questions — which request is
newest, and does this decision still apply — and the daemon keeps up to 64
permission requests pending at once. Answering a still-pending `r1` while `r2`
is also open is a decision the backend applies, so it must establish; currency
is therefore membership in the live-request set, judged at `settle` time. The
guard narrows to positive evidence only, so a superseded decision that genuinely
failed still terminalizes instead of leaking a permanent `unsettled` row.

"Live" means **not superseded**, not "awaiting a decision": once a decision is
being settled it is by definition no longer awaiting one, so clearing liveness
when the user answers would make every approval `unsettled`. The caller marks a
request live on arrival and not-live only on supersede/cancel; the engine itself
releases the identity when the decision settles terminal, which both keeps the
natural answer-then-settle ordering correct and bounds the set. The recorded
target is a frozen snapshot, so a caller mutating the object it passed cannot
retarget a dispatched attempt into a live request and revive a superseded
decision.

A thrown transport leaves admission `unknown`, which the truth table keeps
`unsettled` under any witness; without an exit it would hold the phase open for
the engine's lifetime. `abandon` terminalizes such an attempt as `failed` (never
`established`) and is limited to `unknown` admission, so it cannot kill a live
accepted turn whose real evidence must still land. An abandoned attempt is
flagged so a late transport response — even one that resolves after an in-flight
abandon — cannot revive its terminal state. `acknowledge` lets the surface release
terminal rows it has consumed, and every rebuild prunes superseded terminal rows
from the internal log, so acknowledging the latest terminal row cannot resurrect
an older one and retention does not grow without bound across distinct turns.

## Negative tests (land with the daemon adapter)

1. **Delayed turn outcome.** `dispatch('submit', …)` with a transport that
   resolves `accepted` yields `unsettled`, and the phase is `running`. Only
   `settle(operationId, 'settled')` produces `established` and returns the phase
   to `idle`.
2. **Unsettled cancel.** `dispatch('cancel', …)` resolving `accepted` keeps the
   phase `cancelling`; the resolved cancel promise does not end it. Only
   settlement evidence establishes the cancel and clears `cancelling`.
3. **Superseded approval.** With `r1` live, an approval decision for `r1`
   confirmed after `r1` leaves the live set never establishes on positive
   evidence; a still-live `r2` decision does (positive control). An approval
   whose target carries no request identity never establishes either. A
   superseded decision reported `failed` still terminalizes as `failed`.
4. **Concurrent approvals.** With `r1` and `r2` both live, settling each decision
   establishes both — a single "current" slot would wrongly report the second
   `unsettled`.
5. **Witness correlation.** After attempt A settles `failed`, a late witness for
   A must not establish retry B on the same visible target; B's own witness
   does. Applying the same two witnesses in either arrival order keeps A
   `failed` and B `established`. An already-`established` attempt re-settled
   `failed` is a no-op and stays `established`.
6. **Dispatch order and in-flight identity.** A pending row exists and the phase
   is `submitting` before the transport resolves; when a slow first send and a
   fast second send overlap on one target, retention keeps the second
   (later-dispatched) attempt.
7. **Unknown admission has an exit.** A thrown submit/cancel transport latches
   the phase until `abandon` terminalizes it, after which the phase is `idle`;
   `abandon` never establishes and is a no-op on terminal/unknown ids and on a
   confirmed admission.
8. **Recorded target is immutable.** A caller that mutates the target object it
   passed after dispatch cannot retarget the attempt into a live request: a
   superseded decision stays `unsettled` and the row still claims the identity it
   was dispatched for.
9. **In-flight evidence is not discarded.** A settlement delivered while the
   transport is in flight is applied once admission resolves, establishing the
   attempt and clearing the phase without re-delivery.
10. **Abandon cannot kill a live turn.** `abandon` on an accepted, running
    attempt is a no-op; its real evidence still establishes it.
11. **Answer-then-settle ordering.** An approval settles `established` while its
    request is live even though answering means it is no longer awaiting a
    decision; the engine releases the identity on settle, so a re-delivered
    decision for the same settled request no longer establishes.
12. **Acknowledging a retry does not resurrect the superseded failure.** After a
    first submit settles `failed` and a retry on the same target settles
    `established`, acknowledging the retry leaves `operations` empty — the pruned
    older failure does not reappear.
13. **A late response cannot revive an abandoned cancel.** Abandoning a cancel
    while its POST is in flight terminalizes it; the transport then resolving
    `accepted` leaves the row `failed` and the phase `idle`, and a later settle is
    a no-op.

Supporting cases pin rejected admission (no outcome, untracked, settling its id
is a no-op), a failed witness, settling an unknown id (no-op), bounded retention,
a stable `operations` snapshot identity between state changes, and `acknowledge`
releasing a consumed terminal row while keeping other and non-terminal rows.

Mutation witnesses (reproducible by editing the engine and running
`npx vitest run client/daemon/chat-intents.test.ts` from `packages/web-shell`):
sourcing the dispatch witness from the transport (`'settled'` instead of
`'none'`) reds the delayed-turn and cancel cases; widening the supersede guard
to negative evidence reds the superseded-failed case; collapsing the live set to
a single slot reds the concurrent-approvals case; recording the attempt after
`await transport()` reds the dispatch-order and in-flight cases; making
`abandon` a no-op reds the exit cases; dropping the `established` half of the
terminal guard reds the re-settle case; settling by kind plus target instead of
the operation id reds the correlation cases; recording the caller's target by
reference instead of a frozen snapshot reds the recorded-target case; ignoring
the retained in-flight witness reds the in-flight-evidence case; removing the
`unknown`-admission guard from `abandon` reds the live-turn case; removing the
clear-on-settle release reds the answer-then-settle case; skipping the prune of
superseded terminal rows in rebuild reds the acknowledge-retry case; dropping the
abandoned check after `await transport()` reds the late-response case.

## Constraints respected

- No daemon routes, Java routes, or OpenAPI changes; no UI behavior change.
- The engine lives outside `chat-core` and imports neither `daemon/**` value
  code nor `@qwen-code/sdk/daemon`; `chat-core` does not import it.
- Idempotency/receipt semantics stay out of this slice; the managed adapter
  keeps them in slice 3.

## Follow-up (slice 2c)

Wrap `DaemonSessionProvider` actions as transports and daemon events as
`settle` evidence, binding each event to the operation id recorded at dispatch
(an explicit correlation map; an event that cannot be bound stays unverified),
assemble the controller surface (messages, pending approvals/questions,
capability-gated sub-controllers), and switch the main daemon column onto
`ChatSurface` with the visual before/after gate.
