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
`stickyScroll`, the scrollbar, drag-select and the shell's focus policy are all
untouched, and the shell's own scroll wiring did not change. Spacers keep the
scroll geometry spanning the whole transcript, so the scrollbar thumb and the
maximum scroll offset still describe the entire session.

The window is computed during render, not in an effect: a streaming turn
appends to `items` and re-renders, and computing in an effect would leave the
newest rows unmounted for one frame.

## Decision 2 — estimates mirror ink's, measurements are per item id and survive unmount

Unmeasured items are estimated at ink's values (`ESTIMATED_FIRST_ITEM_ROWS = 10`
for index 0, `ESTIMATED_ITEM_ROWS = 3` after), so the scrollbar and the spacer
arithmetic start from the same model ink uses. Each mounted item's real height
is then read from its node (`height + itemMarginTop`, the margin the item box
declares) and stored in a `Map` keyed by item id.

The map is deliberately kept after an item scrolls out of the window — an
estimate must never be re-applied to something already measured, or the spacers
would jump every time the window moved. It is cleared only when
`availableWidth` changes, because wrapping depends on the width and every
measurement taken at the old one is then wrong.

## Decision 3 — the scroll position is sampled on the renderer's `frame` event

`ScrollBoxRenderable` exposes no scroll event, and `viewportCulling` only culls
drawing: it frees no `TextBuffer`. Polling on a timer or an animation frame was
rejected for the reason the sweep's Decision 28 already established — a spinner
that redraws while nothing is happening reads as wasted CPU. Instead the hook
subscribes to `renderer.on('frame')`: a frame is emitted only when something
drew, and every wheel tick, scrollbar drag and key scroll draws. Idle therefore
costs nothing, and the position is read at most once per frame.

## Decision 4 — the transcript's offset inside the scroll content is `root.y - host.content.y`

`Renderable.y` is absolute: the getter adds the parent's `y`. Walking up the
tree and summing `y` would count the scroll translation twice. The difference
between the transcript root and the scroll content telescopes the intermediate
levels and cancels the translation, leaving the row offset of the transcript
inside the scrollable area. The scroll host itself is found by walking `parent`
from the transcript root and duck-typing on `scrollTop`/`content`/`viewport`,
which keeps the shell's tree shape private to the shell.

## Decision 5 — a height correction above the viewport moves the scroll position, except while bottom-pinned

Replacing an estimate with a measurement changes every offset below it. If the
correction is above the viewport top, the rows the user is looking at would
slide, so the hook adds the same delta to `host.scrollTop`.

The first frame is excluded. Until a real offset has been read, the position is
the placeholder `Number.MAX_SAFE_INTEGER`, meaning "pinned to the tail", and
every item counts as being above it — correcting there would fight
`stickyScroll`, which already re-pins the view when content grows. Corrections
apply only once a real scroll position is known.

## Decision 6 — the item cap keeps the top of the viewport

`MAX_MOUNTED_ITEMS = 400` is a backstop for a window made of many one-row items.
It binds only when the viewport is itself taller than the cap, in which case no
window can cover it; the shrink keeps the top rows, where reading starts. A
realistic viewport of 60 rows yields at most `60 + 2 * 24 + 1` items.

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

The boundary sits inside the item's `<box>`, not around it: a boundary that
replaced the box would remove a child and break the
`[topPad, ...items, bottomPad]` index mapping the measurement pass relies on.
The fallback is `null` rather than the boundary's default message on purpose.
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
- `transcript-view.test.tsx` gained two regression tests over a 2000-item
  session: the default view mounts the tail and not the head, the top-anchored
  pane mounts the head and not the tail, and both stay under 400 elements. Both
  were mutation-proved — replacing the slice with `items.slice(0)` fails them.
- The whole `src/ui/opentui` suite passes (1698 tests over 84 files). The
  session picker's preview pane mounts the transcript view, so its
  `@opentui/react` mock gained the `useRenderer` export the windowing hook
  reads; without it the five Space-to-preview tests throw.

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

- The two other reported defects — the composer caret (#227) and the flickering
  markdown h3 (#228) — are untouched by this change.
- In the resume repro leg, injected SGR wheel sequences do not scroll the
  transcript. The behaviour is identical with and without this change, so it is
  a property of that leg rather than of windowing; the same sequences scroll
  correctly in the `s18w`/`s18x` legs. Left as a harness question.
