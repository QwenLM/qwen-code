# Web Shell: Batched Transcript Dispatch on SSE Resume

## Problem

When a Web Shell session has accumulated a large transcript and the browser tab
is switched away for a while, then switched back, the page can freeze for
several minutes or the tab crashes (OOM / "page unresponsive"). The trigger is
the SSE stream draining a burst of buffered events all at once on tab return.

The freeze is not specific to many simultaneous sessions: the sidebar and
Session Overview only poll (no per-session SSE/store), and the split view caps
live panes at `MAX_SPLIT_PANES = 6`. The dominant case is a **single large
session** whose transcript is large and whose buffered stream replays in one
tight loop on return.

## Root Cause (verified against code)

The transcript store applies every dispatch with a cost linear in the number of
retained blocks `B`:

- `store.dispatch` → `reduceDaemonTranscriptEvents`
  (`packages/sdk-typescript/src/daemon/ui/store.ts:54`) copies the whole blocks
  array once per dispatch via `takeBlocksOwnership`
  (`packages/sdk-typescript/src/daemon/ui/transcript.ts:1252`,
  `state.blocks = [...state.blocks]`) and then unconditionally
  `Object.freeze(result.blocks)` (`transcript.ts:139`) — both `O(B)`.

The live SSE consumer dispatches **once per daemon event**
(`packages/webui/src/daemon/session/DaemonSessionProvider.tsx:1142`, inside the
`for await` loop at `:1040`). While the tab is hidden the browser buffers SSE
bytes; on return the loop drains the backlog event-by-event. Total cost is
`O(E × B)` — effectively quadratic — for `E` buffered events over `B` blocks.
With `DEFAULT_MAX_BLOCKS = 200_000`
(`DaemonSessionProvider.tsx:184`) this is the multi-minute main-thread block,
and the per-dispatch array allocations create the GC pressure that crashes the
tab.

Each dispatch also re-runs the full O(n) message normalization
(`hooks/useMessages.ts` → `MessageList.tsx`), so per-event dispatch multiplies
render cost too.

The daemon already bounds the **server-side** replay window to 4 MiB
(`docs/design/2026-07-07-bounded-replay-snapshot-window.md`); the unbounded
growth here is the **client-side** retained transcript over a long live session.

## Goals

- Make an SSE resume burst cost `O(B)` once instead of `O(E × B)`, without
  changing transcript semantics or event ordering.
- Preserve all per-event control logic in the live loop (prompt settling,
  passive observer, `replay_complete`, `state_resync_required`,
  `prompt.cancelled`).
- Bound peak client memory and steady-state normalization cost for very large
  transcripts.
- Remove a wasteful `O(B)` production-only freeze without losing the dev-time
  safety net it provides.

## Non-Goals

- No change to the daemon-side replay window or wire shape.
- No persistent / structural-sharing data structure for blocks (a flat array
  stays; this is a larger rewrite, out of scope).
- No change to virtualization, message normalization shape, or rendering rules.

## Design

### Fix A — Batch the live transcript dispatch (core fix)

In `DaemonSessionProvider`'s `for await` loop, transcript-mutating UI events are
accumulated into a pending buffer and flushed in a **single** `store.dispatch`
on a macrotask boundary, instead of one dispatch per event.

Why macrotask, not microtask: the loop is `for await` over an async generator,
so a burst of already-buffered events drains back-to-back via microtasks. A
`queueMicrotask` flush would run between every event (no coalescing). A
macrotask flush (`setTimeout(0)`) only runs once the generator blocks on a
genuinely new network event — so a whole burst collapses into one dispatch,
while steady streaming stays at roughly one dispatch per network chunk.
`requestAnimationFrame` was rejected: it never fires in a hidden tab (the exact
resume scenario), so rAF-scheduled flushes would stall while backgrounded;
background `setTimeout` throttling only makes each batch larger, which is
harmless.

Batcher API (local to the `run()` scope):

- `enqueue(events)` — push transcript events, schedule a flush if none pending.
- `flushSync()` — cancel the scheduled flush and dispatch the buffer now.
- `dispatchNow(events)` — `flushSync()` then dispatch a control event, so
  control events keep correct order relative to buffered transcript events.
- `clearPending()` — drop the buffer (used before `store.reset()` where pending
  events are stale).

Flush points:

- Replace the per-event `store.dispatch(eventsToDispatch)` with
  `enqueue(eventsToDispatch)`.
- `flushSync()` before turn-terminal handling
  (`turn_complete` / `turn_error`) so `settleActivePromptFromTurnEvent`'s
  `assistant.done` is ordered after the turn's transcript content.
- Route observer `assistant.done`, `replay_complete` `assistant.done`, and
  `prompt.cancelled` `assistant.done` through `dispatchNow`.
- `clearPending()` before `store.reset()` (resync / epoch reload).
- `flushSync()` on loop exit and provider unmount so no buffered events are lost.

Observer debug-guard read: `shouldGuardAssistant` reads the committed store's
`activeAssistantBlockId`, which batching leaves stale within a burst (earlier
assistant chunks are still only in the pending buffer). Left unhandled, a `debug`
event interleaved in an observer assistant burst is not filtered and splits the
assistant block — a real correctness regression, not a cosmetic one. The guard
therefore flushes the buffer first, scoped to observer-mode debug events (rare)
so steady streaming keeps batching, restoring the pre-batching filtering
behavior. This was the one store read site the original audit missed; every
other `getSnapshot()` read in the live loop (`replay_complete` →
`awaitingResync`) already flushes first.

### Fix B2 — Dev-only block freeze

`Object.freeze(result.blocks)` (`transcript.ts:139`) exists to catch consumers
mutating a COW-shared blocks array in place. That is a dev/CI safety net; in
production it is pure `O(B)` overhead on every dispatch. Guard it behind a
dev-mode check so production skips it while dev/CI keeps the protection. The
reducer's own mutation discipline (`takeBlocksOwnership`) does not depend on the
freeze.

### Fix B1 — Bound the web-shell client `maxBlocks`

Introduce a documented, tunable constant for the web-shell transcript window and
pass it from the main provider (`WorkspaceSessionProvider`) and split panes
(`SplitView`). The SDK default (`200_000`) stays unchanged for other consumers.
This bounds peak memory and the per-flush normalization constant while still
retaining a very large history (proposed `50_000`; trivially tunable). The
daemon remains the authoritative full-transcript source.

## Audit Notes

Round 1: A microtask flush was rejected — `for await` drains buffered events
via microtasks, so a microtask flush fires between every event and never
coalesces. A macrotask flush is required.

Round 2: Deferring all dispatch would break control logic that reads the store
after dispatch (`replay_complete` → `awaitingResync`, turn-terminal
`assistant.done`). The batcher flushes synchronously before every control
interaction, preserving order.

Round 3: `store.reset()` must clear the pending buffer, not flush it — pending
events belong to the epoch being discarded.

Round 4: Lowering `maxBlocks` alone does not fix the asymptotics (`O(E × B)`
remains, just with smaller `B`); it is a memory/normalization ceiling, not the
core fix. Fix A is required.

Round 5: The freeze is intentionally kept in dev so an in-place mutation
regression still throws during development and CI.

Round 6 (post-review, ytahdn): The original audit treated the
`shouldGuardAssistant` snapshot lag as a cosmetic tradeoff. It is not — within a
burst the committed store has no active assistant block yet, so an interleaved
`debug` event escapes the observer filter and splits the assistant block. Fixed
by flushing before the guard (scoped to observer-mode debug events) and pinned
by a focused burst regression test. Lesson: every `getSnapshot()` read in the
live loop must either flush first or be proven independent of pending events.

Round 7 (post-review, ci-bot): The `catch` block that runs when the `for await`
loop throws skipped the in-try post-loop flush, so buffered transcript events
sat on a scheduled timer. The retriable path below resumes via Last-Event-ID
delta and does NOT reset the store, and `iterateEvents` has already advanced
`lastSeenEventId` past those events — so clearing the buffer would drop them on
the incremental resume. The fix is `flushTranscriptSync()` at the top of the
catch (after the disposed/aborted early return), not `clearPending()`. The two
remaining bare `store.dispatch` control sites (restored-prompt settle,
`replay_complete`) were routed through `dispatchTranscriptNow` so each control
dispatch is self-contained (flush + dispatch) rather than relying on an earlier
flush by timing; the `replay_complete` branch keeps its own earlier flush, which
the `awaitingResync` read requires. The burst regression test was tightened from
`toContain(CHUNK_COUNT)` to `toEqual([CHUNK_COUNT])` so a regression that also
emitted redundant per-event dispatches would fail, not just a pure per-event
revert.

Round 8 (post-review, ci-bot, on the Round 7 fix): Putting `flushTranscriptSync`
on the catch and unmount paths made a reducer throw cascade. `runTranscriptFlush`
swaps the pending buffer to a local before `store.dispatch`, so a throw there
(a) escapes as an uncaught `setTimeout` error on the macrotask path, and (b) via
`flushTranscriptSync` propagates out of the catch block — aborting `lastSeenEventId`
bookkeeping, reconnect, auth branching, terminal cleanup, and `pendingSessionLoad`
rejection — and out of the `useEffect` cleanup, leaving half-torn-down state.
Fixed at the source: `runTranscriptFlush` wraps `store.dispatch` in try/catch and
logs (`console.error` with the batch size) instead of letting the throw escape.
One guard fixes all three paths; the batch is dropped (a reducer throw is a bug
to surface, not a reason to crash the session). `settleActivePromptFromTurnEvent`
gained a JSDoc stating its callers must flush buffered transcript events first,
since it dispatches `assistant.done` directly and the precondition was previously
only an inline comment at the call site.

## Verification Plan

- Unit-test the batcher: a burst of many events yields **exactly one**
  `store.dispatch` call (a dispatch-count spy pins the coalescing property, so a
  regression to per-event dispatch fails) and a correct, fully-ordered
  transcript; control events (`turn_complete`, `replay_complete`,
  `prompt.cancelled`, `state_resync_required`) stay correctly ordered relative
  to buffered content; unmount flushes the buffer instead of dropping it.
- The dev-only freeze is gated by `typeof process !== 'undefined' &&
process.env.NODE_ENV !== 'production'`: on in dev/CI (where the reducer
  mutation-discipline tests run), off in production by construction. A dedicated
  NODE_ENV-switch unit test was judged more brittle than the guarantee it pins.
- Regression: existing `DaemonSessionProvider` and transcript reducer tests stay
  green.
- Final: `npm run build`, `npm run typecheck`, `npm run lint`, and targeted
  vitest runs for the changed files.
