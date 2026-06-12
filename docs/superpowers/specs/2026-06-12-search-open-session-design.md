# Cycle 65 — Search hit -> open the session in the watch panel

Proposal: `add-cross-session-search` (the proposal's X1 "click the top hit ->
opens that session"). Cycle 61 shipped the search UI; this wires a hit to the
existing watch panel so a result is actionable.

## Deviation note

The proposal opens the session "scrolled to the relevant event"; this opens the
session in the existing read-only watch stream (event-anchored scroll is
Deferred — the watch renders a live log, not a scrollable transcript). Gateway
UI only; no daemon/route change.

## What it adds

A per-hit "Open" button in `searchHitRow` (cycle 61). Click -> set the existing
`#session` input to the hit's `sessionId` and invoke the existing `#watch`
handler (so the session streams in the watch panel + composer). Reuses the
established watch flow verbatim; no new fetch path.

## Decisions

1. Reuse the existing `#session`/`#watch` elements — set `.value` and call
   `$('watch').onclick()` (a plain function call; the handler reads the input).
2. The button label is "Open"; it sits in the hit row next to the header.
3. textContent-only; additive to `searchHitRow`; no new id collisions, no new
   handler.

## Verification

Playwright in-session: search `oauth` -> a hit row has an Open button ->
clicking it sets `#session` to the hit's sessionId and triggers watch (the
watch status changes / the session id is populated). The live stream itself is
not harness-streamable (the stub daemon emits no session events -> watch 502),
so the verification asserts the input is populated + watch was invoked, NOT a
live stream. lint/build/test unchanged, e2e 45/45.

## Deferred

Event-anchored scroll-to-event; opening in a new view; highlighting the matched
term in the opened transcript.
