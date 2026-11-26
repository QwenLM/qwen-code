# Web Shell Pinned Turn Prompt

[English](web-shell-pinned-turn-prompt.md) | [简体中文](web-shell-pinned-turn-prompt.zh-CN.md)

Status: implemented first cut for #15683. Date: 2026-11-01. Extended to Split View panes on 2026-11-08 (the `ChatPane` call site also opts in). Label semantics revised on 2026-11-14 (the label is the last user message at or above the reading line, mid-turn insertions included).

## Problem and scope

Long turns push the prompt far above the fold. The turn navigation rail shows a prompt only on hover, and it hides when the conversation width plus two 64px gutters does not fit. At a 1440px window with the default sidebar, in full-width mode, and on narrow layouts, nothing in the transcript says which prompt the visible output belongs to.

This change adds a compact overlay at the top of the transcript viewport. It shows the prompt of the turn being read, clamped to two lines, or one line on short viewports. All changes stay inside `packages/web-shell`. There is no daemon protocol change and there are no new strings.

Out of scope for this cut: an opt-out setting, a fallback for `legacy` and `degraded` navigation modes, and click-to-jump.

## Which turn and which label

The overlay reads `current` from the `TurnFollowRange` that the rail already follows, so the two cannot disagree. It does not compute a scroll position.

The label is the text of the last user message — mid-turn insertions included — whose row starts at or above the reading line, so it names the most recent thing the user asked, not necessarily the turn's opening prompt. The follow computation carries that text as `lastUserText`. When no user message row is at or above the line (for example, the rows have left the virtualizer's window), the label falls back to `DaemonSessionTurnIndexEntry.label`, or to `DaemonProvisionalTurn.label` for a turn that the index does not have yet. If there is no label, the overlay renders nothing.

## Changes to the follow computation

The first version of the follow range did not cover this feature in three ways. Each one needed a change:

- `updateFollow` stopped when the rail was hidden. That is the main case for this feature. It now also runs when the viewport has the `pinnedPrompt` prop. The rail still receives `follow` only when it is visible, so a hidden rail keeps its window.
- The block to ordinal map existed only when the rail could show (`hideSessionTimeline` off and at least four turns). It now also exists with `pinnedPrompt` when turn navigation is `ready` or `loading`, so full-width mode and short sessions work.
- `followRangeFromRows` inherits a turn only from mounted rows. In an expanded turn with more rows than the virtualizer's overscan (20), the prompt row unmounts and no mounted row maps to a turn, so the range was `undefined`. `turnOrdinal` now gives every block in `messages` the ordinal of its turn, using message order. The rail gets this fix as well, and it no longer loses its highlight in the middle of a long turn. `followRangeFromRows` does not change.

## When it shows

The overlay shows when the prompt row of the current turn is outside the viewport. Only a `msg:` row counts as the prompt row, because the `tc:` collapse row and the outputs row of a turn carry the same source block id. A prompt row that is partly visible still counts as in view. The same rule applies to the last user message at or above the reading line: while that row is partly visible, the overlay hides, because the message is then readable in the transcript.

## Overlay constraints

These constraints come from the defects listed in #15426 for the earlier `StickyPlanStrip`:

- Positioning: the overlay uses `position: absolute` inside the `relative` wrapper of the message list, and it is a sibling of the scroller. It does not use `position: sticky`, so the scroller's overflow cannot make it inert. The end-to-end test measures its position before and after a scroll.
- Row sizing: it is outside the scroller and out of flow, so it cannot change row measurements, `scrollHeight`, scroll anchoring, or the return-to-live control. The end-to-end test hides the overlay and confirms that `scrollTop` and `scrollHeight` do not change.
- Landmarks: it is a plain `div` with `aria-hidden`. It adds no landmark, and it does not repeat text that is already in the transcript for assistive technology.
- Input: it has `pointer-events: none`, so wheel, touch, click and selection go to the transcript below it.
- Small viewports: below 600px of window height it clamps to one line. At 900x480 it is at most 30px high.

## Decisions and rationale

The opening prompt of a turn can be superseded by a mid-turn user message. The overlay must name what the user last asked at the reading position, or it disagrees with the transcript the user is reading: the label is therefore the last user message at or above the reading line, and the turn index label remains the fallback for rows that left the virtualizer's window.

Click-to-jump is a follow-up, although `viewport.selectOrdinal` would make the click itself small. The overlay is not inside the scroller, so a clickable overlay would catch wheel and touch input that must scroll the transcript. Forwarding that input is more than a small addition.

The overlay is an opt-in prop on `TranscriptViewport`. It is set by the main transcript in `App.tsx` and by the Split View panes in `ChatPane.tsx`. Both call sites pass `hideSessionTimeline`, so that prop cannot separate them; the opt-in prop alone enables the overlay.

## Limits

- The ordinal of a turn is known only if its index page is loaded. The rail loads pages for its own window, and a hidden rail does not follow the reading position. In a session with more than one index page (200 turns), older rows can have no label while the rail is hidden, and the overlay renders nothing there.
- The text of a user message is known only from mounted rows. When the last user message at or above the reading line has left the virtualizer's window, the label falls back to the turn index label — the turn's opening prompt.
- Between about 760px and 1050px of container width, the search button sits above the right edge of the overlay. The label text stays clear of it.

## Validation and acceptance criteria

- Unit tests in `TranscriptViewport.pinned.test.tsx` cover label choice, hiding, the collapse row, the unmounted prompt row, provisional turns, a missing label, unsupported modes, panes without the prop, and mid-turn insertions (the label source, in-view hiding, and the reading line boundary).
- `ChatPane.test.tsx` asserts that the pane's transcript viewport receives the prop.
- `web-shell.pinned-prompt.spec.ts` covers positioning, label changes, the unmounted prompt row (the turn index label fallback), row sizing, wheel input over the overlay, agreement with the rail, and a 900x480 viewport.
- The existing `web-shell.turn-navigation-scroll-follow.spec.ts` and the `TranscriptViewport` unit tests still pass.

## Follow-up work

- Click-to-jump.
- A label for sessions in `legacy` or `degraded` mode.
- Loading the index page for the current turn while the rail is hidden.
