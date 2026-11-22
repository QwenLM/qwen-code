# ChatSurface Session-Scoped Admission Locks and History Binding (Slice 2f, first increment)

[English](2026-11-22-chat-surface-session-locks.md) |
[简体中文](2026-11-22-chat-surface-session-locks.zh-CN.md)

Status: implemented (slice 2f, first increment — switch readiness). Date:
2026-11-22. Part of the [unified chat surface](2026-11-16-unified-chat-surface.md)
migration. Builds on the merged contract (#17520), status stack (#17684), intent
engine (#17709), controller assembly (#17794), binding hook (#17895), and the
`ChatSurface` component (#17952).

## Scope

The daemon main-column switch (2f) cannot land as one behavior-preserving change:
the main column's submit orchestration (local slash commands, inline shell,
optimistic echo), the `LiveMessageList` streaming-tail projection, and the ~90
composer props all exceed the current `SessionChatController` contract. The switch
is therefore a multi-increment effort. This first increment closes the two items
explicitly deferred to it, so the later switch does not regress them:

- **R5-1 — session-scoped admission locks.** The `ChatSurface` in-flight submit
  latch and the unknown-admission payload lock were per-component state with no
  session owner; a stale lock could block the next session's composer.
- **`loadOlder` binding.** The daemon binding left the contract's optional
  `loadOlder` capability unbound (a slice-2d remainder), so a surface relying on
  `controller.loadOlder` would silently lose older-history pagination.

This increment is additive: no production column renders through `ChatSurface`
yet, so it changes no observable behavior on its own. The main-column switch with
the visual before/after gate remains the rest of 2f.

## Design

### Session-scoped locks (R5-1)

Both latches belong to the session that armed them. `ChatSurface` tracks the
owner session with a `lockOwner` state initialized to `controller.sessionId`,
an `ownerTokenRef` captured by each submit, and a per-session `parkedLatchesRef`
map (`sessionId -> { token, inFlight, admissionLocked }`). On a render where the
controller's session differs, it uses the React "adjust-state-during-render"
pattern to park the outgoing session's latches and restore the incoming
session's latches:

- A **real session change** (one non-empty id to a different id, back to the
  empty new-chat id, an idle `'' -> id` sidebar click out of a locked new chat
  with no submit in flight, or a sidebar switch into an unrelated existing
  session while a new chat's first submit is still in flight) parks the outgoing
  durable session's `{ token, inFlight, admissionLocked }` when either latch is
  armed (or deletes its parked entry when idle; an unallocated `''` new chat has
  no durable session to return to and is abandoned) and restores the incoming
  session's parked entry (defaulting to a fresh token and cleared latches). This
  ensures neither the render gate (`submitDisabled`) nor the dispatch gate (the
  refs read in `onSubmit`) blocks a session that does not own the lock, while a
  round-trip switch back (`A -> B -> A`) restores `A`'s in-flight guard, owner
  token, and unknown-admission lock.
- The **one change that is not a switch** is the `'' -> id` allocation a new
  chat's first submit spans **while that submit is still in flight and the
  controller identifies `controller.sessionId` as the id that submit allocated**
  (`lockOwner === '' && controller.sessionId !== '' && submitInFlight && allocatedId === controller.sessionId`,
  where `allocatedId` reads `controller.allocatedSessionId` or the submitting
  controller's `allocatedSessionId`): the submit begins with no session id, the
  daemon allocates one mid-submit, and the controller is rebuilt under the new
  id with `allocatedSessionId` matching it. That is the same logical chat, so
  the in-flight latch and the owner token stay armed across it (so the
  settlement still commits the draft and no duplicate send can slip through
  mid-submit).
- **Accepted settlement commits the submitting session's own draft across a
  switch.** `commitAccepted` in `useComposerCore` is already identity-scoped (on
  `sourceChanged` it clears only the submitting draft key and pushes history
  under the submission keys without touching the active session), so `.then`
  invokes `commitAccepted?.()` on `result.admission === 'accepted'` before the
  stale-owner return. If an inactive parked session's submit settles `unknown`,
  its parked entry records `admissionLocked = true` without disturbing the
  active session.

The switch updates the ref and the state halves together; updating only one
would leave either a visible-but-dispatchable or an invisible-but-blocked
composer. This mirrors the session-owned admission state already present in
`App` and `ChatPane` (`admissionOwnerRef`), with the mid-submit allocation
exception gated on the contract's `allocatedSessionId` signal.

### History pagination binding

`useDaemonChatController` now reads `useDaemonTranscriptHistory()` and binds the
contract's `loadOlder(options?: { force?: boolean })` to its
`loadMore(options)`. The controller is constructed once per session, so the
binding reads the history handle through a ref updated each render
(`transcriptHistoryRef.current.loadMore(options)`), never pinning a stale handle
and forwarding `{ force: true }` when the transcript's pagination-error retry
button invokes the bound capability. History pagination is a provider
capability, not an intent: it does not go through the admission/settlement
engine. `ChatSurface` still prefers a page-supplied `onLoadOlderHistory` over
`controller.loadOlder`, while surfaces that rely on the bound capability get
full retry parity.

## Design decisions and rationale

- **Render-phase reset, not an effect.** An effect would run after the first
  render under the new session, leaving a stale armed lock visible for a frame
  and able to gate a submit before the effect clears it. The render-phase update
  converges (the owner matches on the re-render) and clears the latches before
  the new session can dispatch.
- **The allocation exception requires both an in-flight submit and a matching
  `allocatedSessionId`.** `sessionId` alone cannot distinguish a mid-submit
  session allocation (`'' -> allocated s1`) from a user clicking an existing
  session in the sidebar (`'' -> existing s2`) during the session-creation round
  trip. The contract therefore exposes an optional `allocatedSessionId`
  (populated by `useDaemonChatController` from `onAdmissionStarted` when an
  unallocated submit allocates its session id, and cleared on settlement or on a
  switch to a different id), and `ChatSurface` preserves the latch and owner
  token only when the new `controller.sessionId` matches it.
- **Per-session parking + owner token guards late settlement.** Each submit
  captures the current `ownerTokenRef`; parking `{ token, inFlight, admissionLocked }`
  under the outgoing durable session id and restoring the incoming session's
  entry prevents cross-session blocking while preserving the owner's in-flight
  and unknown-admission locks across a round-trip (`A -> B -> A`). While
  inactive, an accepted submit still commits its own identity-scoped draft, an
  unknown submit arms its parked `admissionLocked`, and any error/latch updates
  no-op on the active session.
- **`loadOlder` reads per call and forwards `options`.** A session-stable
  controller must not capture the first render's history handle, and forwarding
  `{ force?: boolean }` ensures pagination-error retries work over the bound
  controller capability as well as over a direct page callback.

## Constraints respected

- `chat-core` imports no `daemon/**` value; the session-scoping uses only the
  contract's `sessionId` and `allocatedSessionId`. The history binding lives in
  the daemon adapter.
- No daemon/Java route, OpenAPI, session-id namespace, or storage-key change.
- Additive: no production column is switched yet; the change is verified by the
  component/binding suites, not a browser gate (that belongs to the switch).

## Validation

- `ChatSurface` suite adds six session-scoping cases: the admission lock clears
  on a session switch (including an idle `'' -> id` sidebar switch out of a
  locked new chat), the in-flight latch and owner token survive a mid-submit
  `'' -> id` allocation identified by `allocatedSessionId`, a mid-submit switch
  from an unallocated new chat into an unrelated existing session clears the
  in-flight latch and ignores the abandoned `unknown` settlement, a session
  switch between allocated sessions clears the in-flight latch (without letting
  the inactive settlement clear the new session's own in-flight latch), an
  accepted settlement after a switch still commits the submitting session's
  draft while a rejected settlement stays silent on the new session, and a
  round-trip switch (`A -> B -> A`) restores both the admission lock and an
  in-flight submit latch. Verified red under each named mutation and restored
  byte-identical.
- The binding suite adds `loadOlder` (including `{ force: true }` forwarding)
  and `allocatedSessionId` lifecycle cases, each verified red under its named
  mutation and restored byte-identical.
- Full migration suite green; both web-shell type projects (`tsconfig.lib.json`,
  `tsconfig.json`) exit 0; ESLint and Prettier clean.

## Deferred (rest of 2f and later)

- **The main-column switch itself + visual before/after gate.** Requires carrying
  the streaming-tail projection, the submit orchestration, and the rich composer
  surface through the contract or slots; a multi-increment effort.
- **Status stack / usage-stat parity (slice 5)** once `statusFacts` carries the
  full queued-prompt and goal facts.
- **Managed adapter (slice 3)** and **ChatPane convergence (slice 4)**.
- **Shared admission-unknown frame (convergence, R5-2)** and the **SDK monotonic
  transcript revision (verify-r4 finding 3)** remain as recorded in the slice-2e
  design.
