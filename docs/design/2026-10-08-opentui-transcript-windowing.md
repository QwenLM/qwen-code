# OpenTUI transcript windowing — mount what the viewport shows

[English](2026-10-08-opentui-transcript-windowing.md) | [简体中文](2026-10-08-opentui-transcript-windowing.zh-CN.md)

Design doc for the fix behind the reported `qwen --resume <id>` blank screen
under the OpenTUI renderer. Two changes ship together: the transcript mounts
only the items near the viewport, and a single item that fails to render can no
longer take the whole tree down with it.

## Problem

`@opentui` allocates one native `TextBuffer` per mounted `text` element, and the
OpenTUI transcript mounted every history item at once. A session of a few
thousand records therefore exhausts the process. All measurements below were
taken on `main` at `d735e20f21` with `@opentui/*` 0.5.10 — the versions this
change ships against:

- On the reported session, truncated to its first 2498 records, a counter
  spliced into the production bundle recorded `created=16430 destroyed=0
rss=870MB` at the first `Failed to create TextBuffer`, and every allocation
  after that point failed the same way.
- An isolated probe creating one-word buffers fails at exactly 65534 live
  buffers, at `rss=228MB`. The ceiling is thus the process's memory rather than
  a fixed slot count, and a real session — whose buffers hold wrapped
  conversation text, not one-word probes — reaches it at roughly a quarter of
  that count.

The failure is silent, which is what made it look like a broken resume path
rather than an allocation failure. The throw lands inside React host-instance
creation, where `@opentui/react`'s own `ErrorBoundary` catches it. That
boundary's fallback is a red `text` element compiled to a `jsxDEV` call, and
`jsxDEV` is undefined in the bundled CLI, so its `render()` throws a second
time — `TypeError: (0, import_jsx_dev_runtime.jsxDEV) is not a function` — and
React unmounts the whole root. The terminal is left on an empty alternate screen
while the process stays alive and keeps accepting input. Neither error reaches
the pty; the only way to see them is to hook `console.error` from a `--preload`
module, which is how both were captured.

ink does not hit this. Its transcript is virtualized
(`virtualEstimatedItemHeight`: 10 rows for the first item, 3 after) and settled
turns go to the terminal scrollback, so the number of live text elements tracks
the viewport rather than the session length.

## Decision 1 — window inside the existing scrollbox, in rows rather than items

`packages/cli/src/ui/opentui/transcript-window.ts` computes
`{ start, end, topPad, bottomPad }` from a row-offset table and a scroll
position, and `transcript-view.tsx` renders

```
<box>            <!-- transcript root -->
  <box height={topPad} />
  ...items.slice(start, end)
  <box height={bottomPad} />
</box>
```

The budget is rows, not item count: one item can be a single row or a
forty-row tool card, and it is rows that both fill the viewport and cost
buffers. `OVERSCAN_ROWS = 24` — one screen of slack on each side — means a
wheel tick never shows a gap before the next window lands.

The window lives inside the scrollbox the app shell already renders, so
`stickyScroll`, the scrollbar and the shell's focus policy are all untouched,
and the shell's own scroll wiring did not change. Spacers keep the scroll
geometry spanning the whole transcript, so the scrollbar thumb and the maximum
scroll offset still describe the entire session.

Drag-select is the exception, and only across a window boundary. Holding a drag
near the scrollbox edge auto-scrolls; the window move that follows unmounts the
renderable the live selection anchor holds, and `Renderable.destroy()` never
clears the renderer's selection, so the anchor silently re-targets onto rows the
drag never covered and stays wrong after mouse-up. Before this change no
transcript item was ever unmounted by scrolling, so the anchor could not
disappear mid-drag. The harm is a wrong painted selection that the next click
clears, and nothing in this CLI reads the renderer's selection — copy-on-select
is an ink-side path — so it is recorded in Follow-ups rather than guarded here.

The window is computed during render, not in an effect: a streaming turn
appends to `items` and re-renders, and computing in an effect would leave the
newest rows unmounted for one frame.

## Decision 2 — estimates mirror ink's, measurements are per item identity and survive unmount

Unmeasured items are estimated at ink's values (`ESTIMATED_FIRST_ITEM_ROWS = 10`
for index 0, `ESTIMATED_ITEM_ROWS = 3` after), so the scrollbar and the spacer
arithmetic start from the same model ink uses. Each mounted item's real height
is then read from its own node and stored in a `Map` keyed by `(kind, id)` — the
pair `findToolIndex` already discriminates on, and the pair it has to be, since
one subagent call puts a `tool` card and a `task` card carrying the same call id
in the transcript at once. Keying on `id` alone let the two overwrite one slot
every frame, which kept the table permanently unsettled — every frame re-rendered
the transcript and re-ran the O(session) prefix sum — and donated whichever card
wrote last its height to the other. The key must not carry a positional index
either: `task-end` splices the task card out by index, shifting every index above
it.

The rows recorded are Yoga's computed height plus `itemMarginTop` (the margin the
item box declares), not the node's reported `height`. `updateFromLayout()` stores
`Math.max(layout.height, 1)`, so a box that paints nothing — `renderNothing`, a
hidden goal card — reports one row while Yoga computes zero, and since the table
is never cleared that phantom row is permanent. The reported height is still read
first, as a guard: a node before its first layout pass reports `0`, which is the
only way to tell "not laid out yet" from "laid out empty".

The map is deliberately kept after an item scrolls out of the window — an
estimate must never be re-applied to something already measured, or the spacers
would jump every time the window moved. A resize does not clear it either. The
entries a width change actually invalidates are the mounted ones, and those are
re-measured on the next frame; clearing the whole table instead renumbered every
offset underneath a scroll position that is itself counted in rows, moving the
visible turn by more than a hundred for a resize that changed nothing above it.

## Decision 3 — two signals: the scroll bar's `change` event and the renderer's `frame` event

`ScrollBoxRenderable` exposes no scroll event, and `viewportCulling` only culls
drawing: it frees no `TextBuffer`. Polling on a timer or an animation frame was
rejected for the reason the sweep's Decision 28 already established — a spinner
that redraws while nothing is happening reads as wasted CPU.

The scroll bar does emit one. `scrollTop` is the bar's `scrollPosition`, whose
setter drives the slider, and the slider's `onChange` chain ends in a public
`verticalScrollBar.emit('change')` — so every scroll path (wheel, key,
programmatic, track click, thumb drag) reports synchronously, before
`requestRender()` paints. Subscribing to it is what makes an absolute jump safe:
a track click can land anywhere in the transcript, far outside a fixed 24-row
overscan, and sampling only on `frame` paints one spacer-only gap first — the
symptom this design exists to remove.

The `frame` subscription stays, for the half that needs layout to be finished:
reading each mounted item's real row count. Idle still costs nothing, since
neither event fires when nothing moves.

Moving is not free, and the cost is worth stating rather than leaving to be
measured later. A window-only move bumps the same `revision` a measurement
does, so the O(session) height map and prefix sum re-run and produce an
identical array; and no item in the transcript is memoized, so the render path
of every mounted item re-executes, not just the one or two that entered the
window. At a cap-bound 400-item window that is 400 render paths per wheel step.
Memoizing the item is the worthwhile half of this and is not done here.

## Decision 4 — the transcript's offset inside the scroll content is `root.y - host.content.y`

`Renderable.y` is absolute: the getter adds the parent's `y`. Walking up the
tree and summing `y` would count the scroll translation twice. The difference
between the transcript root and the scroll content telescopes the intermediate
levels and cancels the translation, leaving the row offset of the transcript
inside the scrollable area. The scroll host itself is found by walking `parent`
from the transcript root and duck-typing on `scrollTop`/`content`/`viewport`,
which keeps the shell's tree shape private to the shell.

## Decision 5 — measuring a mounted item moves nothing; measuring one the window just pulled in settles the scroll position

Replacing an estimate with a measurement changes the offsets below it, which for
an item that was already on screen changes nothing visually. The correction an
earlier revision of this change wrote there was wrong in both direction and
effect.

Every item the measuring loop can see is mounted, and a mounted item is already
painted at the height just read from it. Both spacers come from offsets that a
change inside `[start, end)` leaves alone: `topPad` is `offsets[start]`, which
sums only the items before the window, and `bottomPad` is `total - offsets[end]`,
where correcting an item inside the window moves `total` and `offsets[end]` by
the same amount. The painted layout therefore does not move when the table
catches up with it, and the compensation owed is exactly zero.

A window move is the other case, and it does owe one. When `start` decreases, the
items coming in above the viewport were standing in for `topPad` spacer rows
charged at whatever the height table said — `ESTIMATED_ITEM_ROWS` for one never
mounted, a recorded height for one coming back — and the frame that measures them
shrinks the table above the reader by the difference. The painted content slides
up by that many rows while the scroll position stays where it was, so a six-row
wheel tick over two-row turns travelled two rows. The hook now records the
identity of each item an upward window move pulled in, along with the rows the
table charged it, and the frame that measures one subtracts what it turned out to
cost from `scrollTop`. Identities, not indices, for the reason Decision 2 gives.

What says a spacer above the reader was charged wrong is that charge, not the
table, so it is spent on the measurement that answers it whether or not the table
has seen the item before. The case that turns on is a recorded height going stale
while its item is unmounted: a resize re-wraps every off-window turn, ctrl+O
flips every card at once, and Decision 2 clears the table for neither, so the
turn comes back charging the rows it used to paint and the reader moves with
nothing written back. A charge kept past the measurement that answered it is the
same error from the other side — the next height change of an already-mounted
item would settle from a provenance that was never a pull-in. For that reason an
identity the previous commit already had mounted is never charged at all: its
rows are painted, not standing in for spacer. That last one bites only when the
index space shifts under the charging loop, as a `task-end` splice does, but the
frame then writes `scrollTop` with no scroll input at all.

That write goes through the sticky-aware setter, which recomputes
`_hasManualScroll` from wherever it lands — the failure the unconditional
correction above had, leaving the view one row above the tail and taking the
shell's bottom pin off for the rest of the session. So it is guarded: it fires
only when the position before and the position after are both strictly above the
tail. The reader's own scrolling has already taken the pin off in that case, so
the settlement cannot change what the pin is doing. At the tail, where the pin is
live, nothing is written and nothing is owed: the items entering are below the
reader, not above.

## Decision 6 — the item cap keeps the top of the viewport

`MAX_MOUNTED_ITEMS = 400` is a backstop for a window made of many one-row items,
and the only bound this design puts on the live native buffer count. It binds
once `viewportRows + 2 * OVERSCAN_ROWS` exceeds `MAX_MOUNTED_ITEMS * rowHeight` —
a 353-row viewport for one-row items, 753 for two-row items. From there up to a
`MAX_MOUNTED_ITEMS`-row viewport the mounted items still cover the viewport and
only the bottom overscan is trimmed; above that no window can cover it at all,
and the shrink keeps the top rows, where reading starts. A realistic viewport of
60 rows yields at most `60 + 2 * 24 + 1` items.

## Decision 7 — the session preview is top-anchored

`OpenTuiTranscriptView` has a second caller: the session picker's preview pane,
which is clipped and does not scroll. Bottom-anchoring by default would have
flipped it from the first turn to the last, so the view takes an
`initialAnchor` and the preview passes `'top'`.

## Decision 8 — a failed item renders nothing rather than taking the tree down

Windowing removes the pressure that caused the blank screen, but the failure
mode itself was the reason it was silent. Each mounted item is now wrapped in
`OpenTuiErrorBoundary` with a fallback that renders `null`, so an allocation
failure blanks one item and leaves the banner, the composer, the footer and the
exit path alive; the error goes to the `OPEN_TUI_TRANSCRIPT` debug logger.

The boundary sits inside the item's `<box>`, not around it. Measurement no longer
depends on that placement — each item box registers its own node under its own
identity through a ref callback, so nothing recovers an item from its position
among the root's children, and a sibling added to the root later (a "N new
turns" pill, a loading row) cannot shift it. Keeping the boundary inside the box
still means a failed item paints zero rows rather than two. The fallback is `null`
rather than the boundary's default message on purpose.
The default renders `text`, which needs a fresh `TextBuffer` — the very resource
that just ran out — so it can fail again inside the handler whose whole job is
to survive the failure; upstream escalates exactly this way, its fallback being
the `jsxDEV` call that cannot run at all. A fallback that renders nothing
depends on neither. The fatal top-level boundary, its module-level error store
and the exit-time stderr echo are unchanged and still catch anything outside an
item.

## Validation

Unit tests:

- `transcript-window.test.ts` (10 tests) pins the offset prefix sum, the empty
  transcript, the fits-in-viewport case, the scroll clamp, overscan on both
  sides, an item straddling the bottom edge, spacer arithmetic for mixed
  heights, and the cap.
- `transcript-view.test.tsx` gained three host-less windowing tests over a
  2000-item session: the default view mounts the tail and not the head, the
  top-anchored pane mounts the head and not the tail, and both stay under 400
  elements. A fourth pins that a host-less pane still measures real heights on a
  frame, and goes red when the host lookup is moved back ahead of the measuring
  loop. Replacing the slice with `items.slice(0)` fails all four and seven of
  the thirteen on the harness below.
- The same file gained a scroll-host harness for the frame-driven half, which
  jsdom cannot otherwise reach: it installs both the host the view walks up to
  and the laid-out tree it reads back onto the DOM nodes the JSX mock produces.
  The host's `content.y` carries the scroll translation against a non-zero
  static `root.y`, so neither operand of Decision 4's offset is zero and neither
  is the other; dropping `- host.content.y` fails three tests. Spacers forward
  their `height` prop as `data-height` so a test can read them, and the JSX mock
  counts elements so a test can tell a re-render from no re-render.
- Thirteen tests run against that harness. Each fails under at least one of the
  mutants below, and the picker test below has one of its own; the tree is
  restored byte-identical after every run. The victim lists were measured before
  the last three tests existed, so they name ten; those three carry the last
  three mutants, each measured to kill exactly its own.
  - charging the height delta of an item that was already measured — the
    correction Decision 5 removes — → `records real heights without moving the
scroll position`, `travels the whole distance over turns shorter than the
estimate`
  - settling the scroll position for an item that was already mounted, rather
    than only for one the window just pulled in → `travels the whole distance
over turns shorter than the estimate`
  - not settling it at all → `travels the whole distance over turns shorter than
the estimate`
  - keying the height table on `item.id` → `keeps a separate height slot for two
live items sharing one id`
  - attributing a measured height to the neighbouring item → all eleven tests
    that read a measured height: the ten on this harness plus `measures real
heights in a host-less pane`
  - reading the clamped reported height instead of Yoga's → `reaches the tail
past turns that paint no rows of their own`
  - sizing the window from the height prop instead of the host viewport → `sizes
the window from the host viewport, not the height prop`
  - dropping `fallback={renderNothing}` → `paints nothing for a turn that throws
and keeps the rest`
  - bumping `revision` unconditionally → the shared-id test again, through its
    render count
  - dropping the scroll-bar subscription → `answers a scrollbar jump without
waiting for a frame`, `sizes the window from the host viewport, not the height
prop`, `drops the frame and scroll-bar subscriptions on unmount`
  - dropping `- host.content.y` from Decision 4's offset, or ignoring the height
    table in the offsets memo → three and five of the above respectively
  - settling only for an item the height table has never seen, so a recorded
    height that went stale while its item was off-window moves the reader with
    nothing written back → `settles a turn whose recorded height went stale while
it was off-window`
  - keeping a charge past the measurement that answered it → `spends a charge on
the measurement that answers it, not on a later one`
  - charging an identity the previous commit already had mounted → `never charges
a turn the previous commit already had mounted`
- No mutant targets `keeps the reading position across a resize` specifically —
  only the neighbour-key one above reaches it, and that one breaks everything
  that reads a measured height. The width-change clear of the height table it was
  written against is gone, and the hook no longer sees the width at all. It stays
  as a behavioural pin on Decision 2's "a resize does not clear the table", not as
  a mutation proof.
- `session-picker.test.tsx` gained one test: a 40-record preview mounts the head
  and not the tail. Removing `initialAnchor="top"` fails it and nothing else.
  Its `@opentui/react` mock also gained the `useRenderer` export the windowing
  hook reads; without it the five Space-to-preview tests throw.
- The whole `src/ui/opentui` suite passes (1715 tests over 84 files).

Real machine (opentui leg under Bun, 100x32 pty, `--resume` of the reported
session, before/after built from the same tree with only this change applied):

| Arm                                             | Before                                                                                               | After                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| resume, first 2498 records                      | `non-space cells: 0` (blank); `Failed to create TextBuffer` at `created=16430 destroyed=0 rss=870MB` | `non-space cells: 1318`; allocations stop under 500 (`created=400 destroyed=0 rss=532MB` was the last counter step), no failure, no item-boundary trip |
| resume, all 2781 records                        | `non-space cells: 0` (blank)                                                                         | `non-space cells: 1237`, `1 / 6` distinct frames, process alive on the alternate screen                                                                |
| `s18w-wheel-scroll` (existing scenario)         | `OVF25..OVF48` at rest, `OVF05..OVF28` wheeled up                                                    | byte-identical captures                                                                                                                                |
| `s18x-wheel-window` (new: 400 single-row turns) | `W377..W400`, `W317..W340`, `W117..W140`, `W377..W400`                                               | byte-identical captures                                                                                                                                |

The two scroll scenarios are the transparency check: `s18x-wheel-window` is a
400-row transcript where the window genuinely has to move — up in two steps and
back down — and `s18w-wheel-scroll` is the pre-existing overflow scenario. Every
captured file in both, 23 in total, is byte-identical before and after across
all three dimensions the harness writes (plain text, the padded cell grid, and
the ANSI/SGR rendition) plus the raw pty stream. They are not vacuous: `s18x`'s
four styled captures carry three distinct digests, with `00-bottom` and
`03-back-bottom` matching each other as expected, and `s18w`'s three carry two.

## Follow-ups

- Drag-select across a window boundary is broken, as Decision 1 records: the
  auto-scroll a held drag triggers moves the window, the move unmounts the
  renderable the selection anchor holds, and `Renderable.destroy()` does not
  clear the renderer's selection, so the anchor re-targets onto rows the drag
  never covered. The fix is to make the hook selection-aware — suppress the
  eviction, or clear the selection, while `renderer.getSelection()?.isDragging`
  — and it is deferred because nothing in this CLI reads the renderer's
  selection: copy-on-select is an ink-side path, and the wrong selection is
  painted only, transient, and cleared by the next click. It becomes a
  correctness bug the moment a copy-on-selection binding is wired to the
  OpenTUI renderer. No jsdom test can reach it, so the acceptance leg is a real
  machine: drag in the transcript, hold past the bottom edge until auto-scroll
  has moved the window more than `OVERSCAN_ROWS`, release, and check the copied
  text is the dragged range.
- Decision 8 compensates for a bundle-level defect at the transcript item, and
  the same escalation is still live for every other subtree. `esbuild.config.js`
  defines `process.env.NODE_ENV` as `'production'`, so `react/jsx-dev-runtime`
  resolves to a build whose `jsxDEV` is `void 0`, while `@opentui/react`'s root
  boundary renders its fallback through `jsxDEV`. An exhaustion-class failure in
  the banner, the composer, the footer or a dialog therefore still blanks the
  screen. The fix belongs in the build config or upstream, not here.
- The two other reported defects — the composer caret that reads as missing,
  and the flickering markdown h3 — are untouched by this change. The caret is
  handled by a separate change (#13693); the h3 flicker has no tracker entry.
- In the resume repro leg, injected SGR wheel sequences do not scroll the
  transcript. The behaviour is identical with and without this change, so it is
  a property of that leg rather than of windowing; the same sequences scroll
  correctly in the `s18w`/`s18x` legs. Left as a harness question.
