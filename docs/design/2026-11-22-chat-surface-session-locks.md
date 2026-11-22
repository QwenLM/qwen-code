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
owner session with a `lockOwner` state initialized to `controller.sessionId`, plus
an `ownerTokenRef` captured by each submit, and on a render where the
controller's session differs, uses the React "adjust-state-during-render" pattern
to reset the latches:

- A **real session change** (one non-empty id to a different id, back to the
  empty new-chat id, or an idle `'' -> id` sidebar click out of a locked new chat
  with no submit in flight) abandons both latches and rotates `ownerTokenRef`: the
  in-flight ref + state and the admission-lock ref + state are cleared together,
  so neither the render gate (`submitDisabled`) nor the dispatch gate (the refs
  read in `onSubmit`) stays armed for a session that no longer owns them, and a
  late settlement from an abandoned in-flight submit cannot clear the new
  session's draft or lock the new session's composer.
- The **one change that is not a switch** is the `'' -> id` allocation a new
  chat's first submit spans **while that submit is still in flight**
  (`lockOwner === '' && controller.sessionId !== '' && submitInFlight`): the
  submit begins with no session id, the daemon allocates one mid-submit, and the
  controller is rebuilt under the new id. That is the same logical chat, so the
  in-flight latch and the owner token stay armed across it (so the settlement
  still commits the draft and no duplicate send can slip through mid-submit).

The reset clears the ref and the state halves together; clearing only one would
leave either a visible-but-dispatchable or an invisible-but-blocked composer.
This mirrors the session-owned admission state already present in `App` and
`ChatPane` (`admissionOwnerRef`), with the mid-submit allocation exception made
explicit.

### History pagination binding

`useDaemonChatController` now reads `useDaemonTranscriptHistory()` and binds the
contract's `loadOlder` to its `loadMore`. The controller is constructed once per
session, so the binding reads the history handle through a ref updated each
render (`transcriptHistoryRef.current.loadMore()`), never pinning a stale handle.
History pagination is a provider capability, not an intent: it does not go through
the admission/settlement engine. `ChatSurface` already prefers a page-supplied
`onLoadOlderHistory` over `controller.loadOlder`, so the main-column switch can
still pass `transcriptHistory.loadMore` directly (carrying the `force` option)
while other surfaces fall back to the bound capability.

## Design decisions and rationale

- **Render-phase reset, not an effect.** An effect would run after the first
  render under the new session, leaving a stale armed lock visible for a frame
  and able to gate a submit before the effect clears it. The render-phase update
  converges (the owner matches on the re-render) and clears the latches before
  the new session can dispatch.
- **The allocation exception requires an in-flight submit.** `'' -> id` while a
  submit is in flight is the allocation; an idle `'' -> id` (a sidebar switch
  out of a locked new chat) resets the admission lock like any other switch.
- **Owner token guards late settlement.** Each submit captures the current
  `ownerTokenRef`; rotating the token on a switch causes an abandoned submit's
  `.then`/`.catch`/`.finally` to no-op instead of clobbering the new session.
- **`loadOlder` reads per call.** A session-stable controller must not capture the
  first render's history handle; the ref read keeps the loader current.

## Constraints respected

- `chat-core` imports no `daemon/**` value; the session-scoping uses only the
  contract's `sessionId`. The history binding lives in the daemon adapter.
- No daemon/Java route, OpenAPI, session-id namespace, or storage-key change.
- Additive: no production column is switched yet; the change is verified by the
  component/binding suites, not a browser gate (that belongs to the switch).

## Validation

- `ChatSurface` suite adds three session-scoping cases: the admission lock clears
  on a session switch (including an idle `'' -> id` sidebar switch out of a
  locked new chat), the in-flight latch and owner token survive a mid-submit
  `'' -> id` allocation, and a session switch clears the in-flight latch while
  ignoring the abandoned submit's late settlement. Verified red under each named
  mutation (never-reset, unconditional-allocation, always-reset,
  clear-admission-lock-only, and drop-owner-token-rotation) and restored
  byte-identical.
- The binding suite adds a `loadOlder` case verified red when the binding is
  dropped.
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
