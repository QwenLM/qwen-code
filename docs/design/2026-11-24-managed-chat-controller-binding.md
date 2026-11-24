# Managed Chat Controller Provider Binding (Slice 3b)

[English](2026-11-24-managed-chat-controller-binding.md) |
[简体中文](2026-11-24-managed-chat-controller-binding.zh-CN.md)

Status: implemented (slice 3b). Date: 2026-11-24.
Base: `9192034e9404f5de75951f27ae5fa595ef1f529e`, the squash merge of
#18117 into main. Part of the
[unified chat surface](2026-11-16-unified-chat-surface.md), building on the
[slice-3a adapter core](2026-11-22-managed-chat-controller.md).

## Problem and current state

Slice 3a provides `createManagedChatController(deps)` and proves its backend-neutral
intent ledger, pending-action projection and outcome mapping. Those tests use
injected dependencies, not the real Managed provider.

The real Java provider can supply prompt admissions and normalized session
events for turn end. Its approval/question `actions.respond()` also has the right
operation data internally, but hides the accepted admission and the terminal
operation behind `Promise<void>`. It distinguishes successful fulfillment,
failure, recovery blocking and an unconfirmed timeout internally, without giving
a caller enough evidence to reproduce `accepted + unsettled` versus
`accepted + failed`. The brief `action.updated` projection is only a refresh
hint; it does not prove which revision was answered.

`useManagedSession`, `useManagedActions` and `useManagedTurnCancel` already own
incremental history, pending-list reading, revisions, idempotency and cancel
recovery. The binding must preserve that ownership rather than reconstruct a
second protocol, another transcript projection, or a second polling lifecycle.

Slice 3b is the narrow binding increment. It does not switch
`ManagedSessionsPage` or claim the visual parity gate assigned to slice 3c.

## Goals

- Bind an existing Managed session to a `SessionChatController`, using actual
  provider facts and existing incremental message and pending-action hooks.
- Keep one controller and its local intent/projection state for a stable owner,
  rather than reconstructing it on every summary, event or pending-list render.
- Expose enough existing native operation evidence to distinguish admission,
  establishment, failure and an unconfirmed outcome, without inventing a route,
  protocol field or terminal witness.
- Cover the two follow-up concerns from the 3a review: expiry changes that do
  not reset a user's in-progress answer, and a decision for each of the four
  defensive settlement conditions rather than leaving red or untested defences.
- Preserve original provider, history, action and cancel behavior for existing
  callers. Keep the additive hook out of production pages until slice 3c.

## Scope and non-goals

This slice covers one existing session, its messages, pending permissions and
questions, submit/cancel intents, and the associated settlement facts. Pending
actions are loaded with `includeChildren=false`: the controller's action identity
is scoped to one session, not a child-session collection.

It does not cover session creation, message queues, page-level prompt persistence
extraction, `ManagedSessionsPage` migration, `required`/`allowText` changes in the
shared question card, visual before/after gates, daemon runtime imports into the
new managed code, Java server changes, OpenAPI changes, generated contracts,
session-id/tenant namespaces, global capability parity, or new sub-controllers.
Capability-gated model, approval, compression and lifecycle controllers are not
added speculatively here.

## Design

### Owner identity and live facts

`useManagedChatController` accepts a small owner input:

- `provider: ManagedAgentProvider` — the actual provider object, not a new context.
- `clientId: string` — the existing scoped Managed client identifier.
- `sessionId: string | undefined` — the selected existing session.

It returns the controller when a real matching session summary is available, and
`undefined` while that owner or summary is unavailable. It must not manufacture a
`'created'` session or route a missing session to a daemon backend.

Controller ownership is `provider object identity + clientId + sessionId`. A
provider snapshot or React updater must not accidentally redefine that owner.
The hook constructs the controller once per owner, keeps current facts and
transport functions in refs, and exposes them through controller getters and
forwarders. Ordinary event, summary, history and pending-list updates retain the
same controller instance and its invariants. Owner changes abort the old delivery
subscriptions and late callbacks; they cannot mutate the new owner's ledger or
answer its pending question.

This stability is also required for the pending projection cache in slice 3a.
It is not a claim that a true owner change preserves local attempt history.

### Transcript and pending actions

- Compose `useManagedSession(provider, clientId, sessionId)` for summary, event,
  older-cursor and loading facts.
- Use `createManagedMessageProjector()` keyed by that owner, with the existing
  `managed.truncated` label from `useI18n`. Do not re-project raw events in the
  controller. Authoritative freshness and de-duplication follow the existing
  incremental projector, not a guessed event-count cache.
- Normalize events from one owner only. A turn-end event is forwarded with the
  event's actual turn identity. Older or repeated snapshots and late events from
  another owner cannot settle this controller. Do not infer an operation's
  `recovery_blocked` status from a turn-level failure.
- Use `useManagedActions` for the authoritative pending list, preserving its
  owner/revision/refresh behavior and the single-session scope. Its high-level
  response helper is not used as proof of admission/establishment because it
  intentionally hides some terminal responses from the old page.
- Derive capabilities through `managedCapabilitiesFromSummary(summary)`. The
  separate `canSend` and `canCancel` transport predicates must still be honored;
  mapping neither one to a visible sub-controller is not permission to dispatch.

For history, `hasOlderHistory` follows the real older cursor and `loadingOlder`
the real hook loading state. The real loader is retained through a ref. The
backend-neutral optional `{force: true}` is advisory here: Managed's existing
zero-argument `loadOlder` already carries its retry/cursor lifecycle. The binding
will not claim to have forwarded or newly implemented a `force` option. Where the
provider has no unambiguous capacity/pagination-error fact, those optional fields
remain unset rather than being invented as `false`.

### Prompt submission and cancellation

- Submit only through the existing Managed client, using `encodeManagedInput`
  for text, images and files. Its UTF-8 and encoded-size checks remain intact.
  Annotation preparation and new-session or queued-message submission remain
  with their existing owners.
- A native `{sessionId, turnId, operationId}` receipt is admission, not
  establishment. A successful return without the admission identity is not
  silently accepted; it is `unknown`. A turn-end event from the matching owner
  settles the bound turn. Early events remain eligible for the 3a sequence-aware
  buffer, including an event arriving before the transport promise resolves.
- A newly intentional prompt command receives `managedRequestId()` once at its
  transport dispatch, not a fresh key per render. This is one command's identity,
  not a claim of safe replay across an ambiguous acknowledgement or page reload.
- Cancel through the existing `useManagedTurnCancel` lifecycle, preserving its
  persisted intent, owner abort, query and `refreshSummary` behavior. Add narrow
  observation at its existing receipt and validated query points: expose the
  accepted operation identity and a terminal native operation. Nothing else
  advertises completion. Cancellation polling remains enabled for the mounted
  controller; that is liveness observation, not permission to send a cancel.
- `completed`, `failed` and `cancelled` remain distinct from `recovery_blocked`.
  The latter maps to `unsettled`, always from the actual cancel operation read.

The binding does not recreate the page's prompt outbox. It will not promise safe
replay of a lost prompt acknowledgement. See Open questions below.

### A minimal observation seam for approval/question responses

Keep `actions.respond(action, response, command)` for all existing callers.
Add two optional process-local callbacks in its command options:

- `onAccepted` — observes the session and operation identity after the response
  operation has been accepted and its identity has been checked. This is the
  durable-admission boundary, not a terminal result.
- `onSettlement` — observes the session, operation identity and terminal native
  status only after the existing operation read has reached `completed`,
  `failed`, `cancelled` or `recovery_blocked`.

The implementation passes values already returned by `client.respondAction` and
`settleActionResponse`. It does not add a protocol field, a wire event or a
polling schedule, and the callbacks are never serialized into the request.
Validation rejects an accepted response whose session, operation id or operation
kind is inconsistent. Fulfillment of the outer `respond()` promise is still not
establishment. `onSettlement` can be emitted before the old method turns a
failed/cancelled/recovery-blocked result into its existing `Error`; that error
contract and the old page's handling stay intact.

The binding maintains those observations per call, filters them by owner and
maps the terminal operation through `subscribeOperationSettlement`. It does not
translate a brief `action.updated` update into an invented action settlement.
Consequently an accepted failure and `recovery_blocked` keep their distinct
contract meanings, while an unconfirmed poll timeout leaves an accepted attempt
`unsettled` rather than fabricating either success or a rejected admission.
Missing observation support on another provider must result in `unknown`, never
a synthesized accepted ticket based only on `Promise<void>` fulfillment.

Before accepted evidence exists, an authoritative non-authentication 4xx maps
to `rejected` using `isNonRetryableClientError`; authentication, throttling,
network faults, malformed admission identities and uncertainty map to `unknown`.
Later terminal-operation evidence must not be downgraded by the eventual
post-settlement `respond()` error result.

Pending question bodies retain `canonicalQuestionAnswers` and
`questionResponseKey`. Approval idempotency remains `${actionId}:${optionId}`.
The request still carries the source action's `inputRevision` and
`policyRevision`; there is no label-only or missing-id fallback invented in this
slice. `QuestionAnswer.questionId`, `optionIds` and free `text` stay separate.

### Pending expiry and settlement defences

The current Action producer stores an absolute expiry at creation, which the
Java API and provider copy without extending it. The renderer should nevertheless
handle expiry-only changes safely: remove `expiresAt` from the _render content
signature_, while retaining the per-read `isActionExpired` filter with the
current clock. A deadline change alone must not reconstruct a request or
`rawInput`. Disappearance, reappearance, a change of kind/revision or actual
render-content changes must still invalidate the projection. This preserves
user input without extending an expired Action's life.

The four previously noted defensive conditions are resolved explicitly:

- Operation terminal matching marks `matched = true` before calling
  `applyState`, so a replayed settlement for an already-terminal operation does
  not fall through to unmatched early buffering while another dispatch is in
  flight. Unmatched buffering still requires an active dispatch.
- The redundant `isTerminalOperation` skip checks in `settleByTurnId` and
  `settleByActionId` duplicated `applyState`'s single terminal guard with no
  extra side effect and are removed rather than keeping untested duplicates.
- Buffer action evidence only while that matching action itself is in flight
  (`inFlightActionIds.has(event.actionId)`), preventing stray buffer retention
  for unrelated actions while `dispatchSequence` independently enforces
  cross-attempt isolation.
- Retain the dispatch-sequence gate and the no-weakening terminal transitions.
  Regression witnesses exercise real provider/hook observation points and
  early/replayed settlement ordering, not only green positive cases.

### Lifecycle, errors and delivery

The hook releases owner-scoped abort signals on owner change and unmount, while
re-arming the owner's `AbortController` on effect setup so React `<StrictMode>`
remounts keep the owner live without detaching settlement listeners. Late
transport or event results never enter a new owner's listeners. Once the initial
summary and transcript finish loading, the hook latches an event high-water mark
so initial history snapshots and later `loadOlder()` pages never replay as fresh
turn settlements. Stopping observations does not purport to cancel a backend
operation already accepted by the server. The post-admission summary refresh
is advisory: its failure or abort is swallowed at the call site, because the
session poll loop owns recovery and the standing error display.

`detail.stoppedReason`/`stoppedLeg` and the real loading states govern transcript
status; transient older-page errors do not silently become terminal session
errors. Queue and goal fields keep the existing conservative defaults; they do
not become fake parity facts in this slice.

## Files

- New `packages/web-shell/client/components/managed/use-managed-chat-controller.ts`
  and `.test.tsx` for owner-scoped binding and real composition tests.
- `managed-agent-provider.ts`, `java-managed-agent-provider.ts` and the latter's
  tests for the narrow optional response observers and native identity checks.
- `use-managed-turn-cancel.ts` and `.test.tsx` for observation at the existing
  cancellation receipt/query points, without replacing persisted intent logic.
- `chat-controller.ts` and focused tests for expiry identity. The existing
  `chat-controller.local-integration.test.tsx` adds an expiry-only parent-render
  regression, rather than broad page integration.
- This bilingual design, plus the deferred-slice pointers in the slice-3a
  documents.

## Verification and acceptance criteria

- Existing managed, action, cancel and controller tests remain green; no old
  error result or idempotency behavior is silently reclassified.
- Real Java provider objects, using mocked HTTP, prove exact submit/action/cancel
  request payloads and keep admission separate from terminal operation evidence.
  Test doubles do not introduce non-existent provider methods or response types.
- The real hook/provider composition exercises: stable ordinary renders, owner
  switches, stale-event rejection, subscription cleanup, accepted/rejected/
  unknown admissions, early settlement, accepted failure, and true recovery
  blocking.
- Pending `optionIds`, `text`, revisions and idempotency keys remain visible all
  the way to the recorded HTTP call. Structured answers do not collapse back
  into labels. Invalid, expired or duplicate decisions do not dispatch.
- Expiry-only updates preserve array/request/`rawInput` identity; advancing the
  clock still expires the action; disappearance and true content changes still
  invalidate it. A real shared question card keeps the user's selection and text
  after an expiry-only parent re-render.
- The four settlement defences receive either a meaningful witness or a precise
  documented redundancy rationale. Positive witnesses must prove the guarded
  branch was reached rather than pass through defaults.
- Package build and both web-shell type gates, focused unit/integration tests,
  targeted lint/format, and repository build/typecheck/bundle pass.

No real Java service or real model call is represented by the mocked-HTTP tests.
The actual page switch, its browser scenarios and visual before/after evidence
remain acceptance work for slice 3c.

## Risks and trade-offs

The primary risk is claiming binding completeness by converting a fulfilled
client method into a fabricated terminal state. The observer seam intentionally
adds a small amount of provider surface area to avoid that dishonest shortcut.
The binding uses the existing pending and cancel lifecycles rather than adding a
parallel command queue or rewriting session storage.

A session-stable controller does not automatically recover its local admitted
attempt ledger after a true owner reconstruction. The current pure adapter has
no general live-operation seed contract. Binding tests distinguish guaranteed
ordinary lifetime from this explicit limit; they do not simulate seed endpoints
that do not exist.

Expiry-only stability is a rendering invariant, not permission to answer an
expired Action. Future provider expiry extensions are covered by the identity
rule, without asserting that today's provider extends deadlines on every read.

## Open questions for page wiring, not hidden defaults

1. **Prompt attempt identity across ambiguous acknowledgement.** `ComposerSubmit`
   has no managed idempotency key in its metadata. The existing page owns
   durable prompt intents and their keys. A new prompt attempt emitted by this
   hook must not silently claim page-refresh-safe replay or accidentally resend
   an indistinguishable user turn under a new key. Unknown admissions remain
   explicitly unknown/unsettled, not automatic safe retries. Binding the page
   in 3c must supply the existing stable attempt identity
   through an explicit narrow contract, or deliberately accept and document the
   absence of such a retry. It must not infer intent from matching draft text.
2. **Recovering previously admitted operations after a true owner rebuild.** A
   genuine seeded restoration needs actual summary/operation evidence and a
   compatible controller seed contract; an `activeTurnId` alone does not recreate
   a local attempt. It must be designed against real provider data in a later
   slice rather than pretending this hook already provides full cross-reload
   intent continuity.
