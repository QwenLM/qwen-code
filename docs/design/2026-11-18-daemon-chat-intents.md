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
design requires to land with the daemon adapter: a delayed turn outcome, an
unsettled cancel, and a superseded approval. Wiring the engine to the real
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

- `dispatch(kind, target, transport)` — runs the intent's transport, derives
  admission (`accepted` / `rejected`; a thrown transport is `unknown`), and
  records a `ChatOperation`. The outcome is resolved with witness `none`, so an
  admitted intent is `unsettled` until evidence arrives. A `rejected` admission
  carries no outcome and is not tracked.
- `settle(kind, target, witness)` — applies authoritative evidence to the
  matching in-flight intent and recomputes its outcome. For approvals the
  decision establishes **only while it still applies to the current request**:
  if `target.requestId` is no longer `currentApprovalRequestId`, the witness is
  forced to `none` and the decision never establishes (a superseded approval is
  a pending-item state, not an applied outcome).
- `setCurrentApprovalRequest(requestId)` — tracks which approval request is
  still current, so supersede is detectable.
- `operations` — the retained operation list (slice 1 `retainOperations`:
  every non-terminal entry, at most the latest terminal per kind and target).
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

## Negative tests (land with the daemon adapter)

1. **Delayed turn outcome.** `dispatch('submit', …)` with a transport that
   resolves `accepted` yields `unsettled`, and the phase is `running`. Only
   `settle('submit', …, 'settled')` produces `established` and returns the phase
   to `idle`.
2. **Unsettled cancel.** `dispatch('cancel', …)` resolving `accepted` keeps the
   phase `cancelling`; the resolved cancel promise does not end it. Only
   settlement evidence establishes the cancel and clears `cancelling`.
3. **Superseded approval.** With request `r1` current, an approval decision for
   `r1` that is confirmed after `r2` supersedes it never establishes; the
   still-current `r2` decision does (positive control).

Supporting cases pin rejected admission (no outcome, untracked), a thrown
transport (`unknown`, never establishes even with a settled witness), a failed
witness, settling an unknown intent (no-op), and bounded retention.

Mutation witnesses (reproducible by editing the engine and running
`npx vitest run client/daemon/chat-intents.test.ts` from `packages/web-shell`):
sourcing the dispatch witness from the transport (`'settled'` instead of
`'none'`) reds the delayed-turn and cancel cases; removing the approval
supersede guard reds the superseded-approval case.

## Constraints respected

- No daemon routes, Java routes, or OpenAPI changes; no UI behavior change.
- The engine lives outside `chat-core` and imports neither `daemon/**` value
  code nor `@qwen-code/sdk/daemon`; `chat-core` does not import it.
- Idempotency/receipt semantics stay out of this slice; the managed adapter
  keeps them in slice 3.

## Follow-up (slice 2c)

Wrap `DaemonSessionProvider` actions as transports and daemon events as
`settle` evidence, assemble the controller surface (messages, pending
approvals/questions, capability-gated sub-controllers), and switch the main
daemon column onto `ChatSurface` with the visual before/after gate.
