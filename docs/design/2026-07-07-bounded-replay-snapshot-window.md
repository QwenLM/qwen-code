# Bounded Replay Snapshot Window

## Problem

Live daemon sessions currently retain replay history in memory so `POST /session/:id/load` can inject replay for clients that attach after the session already exists. That replay retention must be bounded independently from the SSE ring: response-mode restore can seed large historical updates in bulk, and completed live turns can accumulate indefinitely in long-running sessions.

Disk session history remains the authoritative full transcript source. PR-1 only bounds the daemon's live in-memory replay window; it does not add a full-transcript endpoint.

## Goals

- Cap retained replay events by serialized bytes per live session, defaulting to 4 MiB and rejecting invalid configuration at boot.
- Apply the cap to both completed live-turn replay segments and response-mode or stream-mode restored historical replay.
- Preserve the existing snapshot wire shape: `compactedReplay`, `liveJournal`, and `lastEventId`.
- Keep at least one real replay event or one completed live-turn segment even when that single unit exceeds the cap.
- Surface truncation with an id-less `history_truncated` marker at the start of `compactedReplay`.
- Treat `history_truncated` as status only. It must not trigger `state_resync_required`, reload loops, or persistence back into the replay window.

## Non-Goals

- No cap on a single in-flight live turn in PR-1; `liveJournal` continues to hold the active turn until a boundary.
- No turn-count cap. Turn counts are diagnostic only when the engine can count dropped completed turn segments exactly.
- No `/capabilities` feature tag for this additive event. The resolved limit is exposed in daemon status.
- No complete transcript endpoint. PR-2 must design paginated or streaming transcript reads and must not expose a one-shot full array response.

## Design

`TurnBoundaryCompactionEngine` stores retained replay as ordered segments instead of an unbounded flat array. A completed live turn is one segment. Restore/bulk seed replay is stored as event-level segments so the oldest restore events can be discarded independently when the byte cap is exceeded.

Sizing reuses the EventBus safe JSON sizing semantics. Sizing failure logs diagnostics and counts that event as zero bytes so publish and seed paths keep their never-throws contract.

When `replayBytes > maxReplayBytes`, the engine drops oldest segments while more than one segment remains. It increments `truncatedEvents`, and increments `truncatedTurns` only for dropped live-turn segments. `snapshot()` flattens retained segments and prepends:

```json
{
  "type": "history_truncated",
  "data": {
    "reason": "replay_window_exceeded",
    "truncatedEvents": 12,
    "retainedEvents": 8,
    "maxBytes": 4194304,
    "truncatedTurns": 3,
    "fullTranscriptAvailable": true
  }
}
```

The marker is synthetic and id-less. It is excluded from byte accounting and from transient replay retention. `ingest()`, `seed(snapshot)`, and `seedReplayEvents()` all filter it out so loading a bounded snapshot cannot compound markers.

`EventBus.seedReplayEvents()` assigns ids and timestamps to restore replay events, calls the compaction engine's dedicated seed method, and clears the SSE ring as before. This prevents bulk restore replay from being appended to `liveJournal`.

The CLI wiring passes one resolved cap through yargs, the fast-path parser, `ServeOptions`, server wiring, `BridgeOptions`, bridge status, and daemon status rendering. Invalid values (`0`, negative, non-integer, `NaN`, `Infinity`, or values above 256 MiB) fail closed.

SDK and WebUI know `history_truncated`, validate its payload, project it to view-state counters and transcript status, and render a terminal status line. The event is not an unknown/debug event and is not part of resync gating.

## Audit Notes

Round 1: A cap only on completed live turns is insufficient because response-mode restore can seed large historical replay without live boundaries. The design therefore adds `seedReplayEvents()` and event-level historical segments.

Round 2: Reusing `state_resync_required` for truncation would create reload loops because `/load` would keep returning the same bounded window. The design uses a separate status marker that never sets `awaitingResync`.

Round 3: A turn-count cap does not bound memory when one turn contains large tool output. PR-1 uses byte-only enforcement and leaves active-turn capping out of scope.

Round 4: Returning the full transcript as an array would recreate the same peak memory problem at request time. PR-2 is explicitly constrained to pagination or streaming.

Round 5: Empty replay after truncation would make clients lose all visible state. The engine preserves the newest segment even when oversized.

## Verification Plan

- Unit-test live turn trimming, restore seed trimming, marker placement, transient marker filtering, oversized latest retention, safe sizing failure, and EventBus never-throws behavior.
- Unit-test bridge response-mode restore and live-session load behavior with the bounded window.
- Unit-test CLI parsing, fast-path parsing, runQwenServe validation, server bridge wiring, and daemon status limits.
- Unit-test SDK known-event validation, reducer state, UI normalizer, transcript status, terminal rendering, and WebUI replay injection.
- Keep final verification on `npm run build`, `npm run typecheck`, and `npm run lint`.
