# Web Shell global turn navigation: scroll-following current turn

[English](web-shell-turn-navigation-scroll-follow.md) | [简体中文](web-shell-turn-navigation-scroll-follow.zh-CN.md)

Status: proposed
Date: 2026-09-14
Related: [web-shell-global-turn-navigation.md](web-shell-global-turn-navigation.md) (Phase 3 listed scroll-following selection as an optional follow-up)

## Problem

The daemon-backed global turn navigation (`GlobalTurnNavigation`) replaced the
in-list session timeline whenever the daemon advertises
`session_turn_navigation`. The in-list timeline highlighted the turn under the
reading position in real time; the global rail highlights only the last clicked
tick, because `selected` in the turn-navigation store is written exclusively by
`locateOrdinal`. After the cutover, scrolling the transcript no longer moves
the rail highlight — a regression in daily reading flow, not a code defect.

## Current state

- `GlobalTurnNavigation` renders ticks for every turn on the frozen active
  chain (virtualized, 16 px rows) and marks `state.selected?.ordinal` with the
  `sessionTimelineButtonCurrent` style. Nothing else writes `selected`.
- The in-list `SessionTimeline` in `MessageList` computes a
  `{startIndex, endIndex, currentIndex}` range from the transcript viewport on
  every scroll frame (rAF-throttled), dims the in-range ticks
  (`sessionTimelineButtonInRange`), highlights the current tick
  (`sessionTimelineButtonCurrent`, `aria-current`), and re-centers the rail on
  the current entry whenever it changes.
- Both timelines share the tick styles from `MessageList.module.css`.

## Goals

- While the transcript scrolls (live or historical view), the rail highlights
  the turn owning the row above the reading line a third of the way down the
  viewport — so the marker reaches the first and last turns at the scroll
  extremes — and marks the turns
  spanning the visible rows as in-range, matching the in-list timeline.
- When the highlighted turn changes, the rail scrolls itself to center the
  current tick, matching the in-list timeline.
- `aria-current` tracks the same effective current turn.

## Non-goals

- No changes to the daemon protocol, the turn-index store, or the historical
  page table. Scroll-follow is derived from the existing snapshot.
- No changes to click-to-jump behavior (`locateOrdinal`), keyboard navigation,
  or tooltips.
- No fade mask on the rail viewport: the global rail is virtualized with
  edge-to-edge absolute rows, and a mask would fade tick hit areas at the
  edges. The rail keeps its compact 360 px cap from #11208.
- The in-list timeline (legacy fallback) stays untouched.

## Proposal

`TranscriptViewport` computes a follow range from the DOM and the navigation
snapshot and passes it to `GlobalTurnNavigation` as
`follow?: { start: number; end: number; current: number }`.

Mapping rows to ordinals: the snapshot's `locations` map (`turnId → blockId`)
is inverted, and index pages give `turnId → ordinal`. Provisional turns map to
`totalTurns + index`. Each rendered transcript row carries
`data-source-block-ids`; a row's ordinal is the smallest mapped ordinal among
its block ids. Rows whose blocks do not map (assistant output, tool cards)
inherit the previous mapped row's ordinal, walking top-down; rows above the
first mapped row belong to the turn before it (`first - 1`, clamped at 0).
This mirrors how the in-list timeline propagates the current turn id across a
turn's rows.

The follow range recomputes:

- on transcript scroll (rAF-throttled, skipped while the viewport is restoring
  a reading anchor or locating a jump target; recomputed once when the restore
  loop finishes),
- after layout when `messages`, the view key, or the ordinal map changes
  (streaming growth, historical page admission, view switches).

`GlobalTurnNavigation` renders the effective current ordinal as
`selected?.ordinal` while a click selection is still loading, otherwise
`follow?.current ?? selected?.ordinal`. The current tick keeps the existing
`sessionTimelineButtonCurrent` style and takes over `aria-current`. Ordinals
inside `follow.start..end` additionally get `sessionTimelineButtonInRange`
(and `data-in-current-range`), exactly like the in-list timeline. A layout
effect re-centers the rail viewport on the current tick only when the current
ordinal changes, so browsing the rail itself never fights the user.

Coverage is self-healing: when scrolling deep history reaches turns whose index
page is not loaded, the row-to-ordinal map has gaps and the highlight simply
stops moving; the rail's existing missing-page loader fetches the index pages
for the visible ticks, which fills `locations`, and follow resumes.

## Constraints

- The ordinal map is rebuilt only when the snapshot publishes (event-driven),
  never per scroll frame; scroll handlers only walk the rendered rows.
- jsdom unit tests must be able to drive the mapping without layout, so the
  row-to-ordinal derivation lives in a pure helper.

## Risks

- A transcript row whose block ids span a turn boundary resolves to the
  earliest turn; the visual error is at most one tick.
- While a click selection is in flight the highlight shows the clicked tick
  instead of the reading position; this is deliberate click feedback and
  resolves as soon as the jump lands.

## Validation plan

- Unit: pure helper coverage for row mapping (direct, inherited, pre-first,
  clamped); `GlobalTurnNavigation` renders follow current/in-range/aria-current
  and keeps a loading click selection visible.
- E2E (mock daemon, turn navigation capability on): scrolling the live
  transcript moves the rail highlight; clicking a distant tick still jumps and
  the highlight lands on it; scrolling historical pages keeps following.

## Acceptance criteria

- Scrolling the transcript in either view moves the rail highlight in real
  time, and the rail re-centers on the current tick when it changes.
- Clicking a tick shows immediate highlight feedback and the existing jump
  behavior is unchanged.
- The legacy in-list timeline path renders byte-identical DOM to before.

## Open questions

None.
