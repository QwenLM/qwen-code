# Transcript search and structure navigation design

[English](transcript-search-navigation.md) | [简体中文](transcript-search-navigation.zh-CN.md)

Status: implemented for the Ink virtual viewport.
Related: PR #17024, issues #16995 and #16996.

## 1. Background and goals

With `ui.useTerminalBuffer` on (the default Virtualized History path), the
conversation lives inside an in-app viewport. The host terminal's scrollback and
search cannot reach it, and the only movement was by distance: lines, pages,
start, and end. A user cannot directly find an earlier command's output or jump
back one turn.

This feature has two goals:

- Let the user search the **entire current session** and anchor the viewport to
  a result, including text inside structured tool results.
- Let the user move one **turn** or **tool-output block** at a time, without
  changing the meaning of existing page-scroll keys.

### 1.1 Scope

Supported: the Ink renderer, the virtual viewport returned by
`MainContent` when `ui.useTerminalBuffer` is true.

Not supported here: OpenTUI (which has a distinct scrollbox), legacy Static
history, per-occurrence highlighting inside rendered markdown, and automatic
expansion of a matched collapsed tool block. Search does not cross sessions.

### 1.2 Terminology

| Term                    | Meaning                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Item                    | One row of history rendered by the virtual viewport, not one line of text.                                                             |
| Turn                    | A user item with `type === 'user'` and `sentToModel !== false`, up to the next such item. A steer injection does not start a new turn. |
| Tool output             | One `tool_group` item, which can contain several tool calls and results.                                                               |
| Reading-position anchor | `getScrollIndex()`: the top item while scrolled up, or the last item while following output.                                           |
| Navigation cursor       | A separate record of the requested navigation target. It is not a scroll offset.                                                       |

## 2. Shared item model

`MainContent` builds its virtual list with `buildVirtualItems`. Search and
structure navigation use the **same function and the same item references**.
This is the index contract:

| Index    | Content                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `0`      | The `vp-banner` sentinel, never a navigation anchor or search match.                                                      |
| `1..N`   | Committed history, in display order.                                                                                      |
| `N+1..M` | Pending entries with negative IDs, separated from committed items so they cannot later collide when history is committed. |

If a live pending tool group has the same `batchId` as its committed copy, the
builder drops the committed one. Unrelated batches are not de-duplicated by
`callId`, because core history compaction and provider adapters may re-mint or
reuse those IDs. Consequently an index returned by search still addresses the
actual item shown by the viewport after that collapse.

This is a deliberate shared builder rather than independently searching
`uiState.history`, because independently filtering and collapsing the same
history could produce off-by-one jumps and would be very difficult to diagnose
in a long session.

## 3. Search processing and rendering

### 3.1 Matching

`searchTranscriptItems` converts every supported item into searchable text:

- Ordinary text-bearing history: `item.text`, including prompts, assistant
  responses, thoughts, notices, and errors.
- Tool groups: tool name, description, raw arguments, result display (including
  structured results serialized as JSON), full Ctrl+O detail, and notices.
- Tool-use summaries: their summary text.

Matching is case-insensitive, performed on the original text, at most one hit
per item. Other variants without a user-facing text field (for example `about`,
`help`, or `stats`) do not contribute searchable text.

Search result structure:

```ts
interface TranscriptSearchMatch {
  index: number; // index in buildVirtualItems output
  itemType: string; // e.g. 'user' or 'tool_group'
  snippet: string; // single-line terminal-safe context
}

interface TranscriptSearchResult {
  matches: readonly TranscriptSearchMatch[];
  truncated: boolean; // only true when an older match was really omitted
}
```

`getSearchableText` is cached in a `WeakMap` keyed by item identity, so normal
re-renders do not redo text projection for stable committed items. Pending items
are normally recreated and therefore miss this cache instead of retaining stale
results.

### 3.2 Cap and order

The matcher scans from newest to oldest and reverses the result before display.
At most 500 matching items are returned. With 501 matches, the 501st (newest)
remains present, in ascending viewport order.

`truncated` is computed **before adding the next match**. Therefore a result
that exactly fills the cap does not incorrectly render `500+`; one extra omitted
match is required.

### 3.3 Snippets and terminal safety

The snippet expands ±48 characters around the **raw** match position, then
applies `sanitizeTerminalText` and collapses whitespace. It does not search for
the needle again after flattening. This matters for these two concrete cases:

```text
"beta  gamma"
  => match "beta  gamma" in raw text
  => snippet contains "beta gamma", at the matched location, not item index 0

"before\x1b]0;ATTACK\x07 after"
  => snippet has no raw ESC or BEL bytes
```

Searching happens on the raw text so control-byte content can still be queried;
rendering alone is sanitized. There is no new security promise that every
plausible external tool producer has sanitized its data: matcher cleanup is now
also required and covered at that boundary.

## 4. Search mode arbitration

`InputPrompt` already reuses one composer buffer for Ctrl+R reverse search.
Transcript search uses the same established mode pattern rather than another
input component or new modal state.

| Input                             | While find is open                                                                                   | On close                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Alt+S`                           | Enter find and save draft, cursor, and reading-position anchor. Buffer is cleared for the new query. | N/A                                                   |
| Printable query text              | Replace the query and recompute matches. Never consume prompt-suggestion suggestions or dictation.   | Typed text goes to the prompt only after find closes. |
| Up / Down                         | Previous / next match, with wraparound.                                                              | N/A                                                   |
| `Ctrl+R`                          | Ignored: two modes cannot share the draft slot.                                                      | One `Esc` returns the original draft.                 |
| `!`, `?`, `Tab`, `Right`, `Enter` | No shell-mode toggle, shortcut panel, formatting completion, or prompt-suggestion acceptance.        | Enter keeps the selected match.                       |
| `Esc`                             | Close, restore the original draft, and restore the saved viewport state.                             | Follow mode is restored as below.                     |

The mode guards also cover plain typing, paste, and `/export` completion inputs,
not only named shortcuts. Otherwise `/export` or a printable `!` could bypass an
otherwise guarded shortcut and insert formatting or a suggestion into the
query.

## 5. Viewport restoration

When find opens, it stores the index returned by `getScrollIndex`. While the
viewport follows output, this is the last rendered item index. The item builder
is intentionally available both while find is open and while it is closed;
using an empty "inactive" list at activation would lose that state. This is how
follow is correctly recognized when starting find from the live tail.

```text
Enter: keep the viewport at the accepted match, restore draft.

Esc with saved follow state:
  scrollToEnd() -> re-enable follow.

Esc while reading somewhere else:
  scrollToIndex(saved index) -> keep that reading position, clamped if needed.

No saved index:
  scrollToEnd() -> safe follow fallback.
```

This distinction matters for a final assistant message taller than the
terminal: `scrollToIndex(last)` would put the beginning of that message at the
viewport top but disable later auto-follow. That is not the same as restoring
the bottom.

## 6. Structure navigation

### 6.1 Key dispatch

| Key             | Action                                                       |
| --------------- | ------------------------------------------------------------ |
| `Alt+PgUp`      | Previous turn anchor.                                        |
| `Alt+PgDn`      | Next turn anchor, or follow again when past the newest turn. |
| `Ctrl+Alt+Up`   | Previous tool-output group.                                  |
| `Ctrl+Alt+Down` | Next tool-output group.                                      |

`ScrollableList` owns all scroll-adjacent key handling and receives
`onNavigateStructure` from the item owner. It knows nothing about transcript
semantics. Structure matching runs **before** normal page scrolling because the
plain `pageup` binding deliberately ignores modifiers.

The modifier bits are load-bearing: `Meta+PgUp` is not plain PgUp. Negative
binding tests ensure plain page-scroll keys cannot unexpectedly become turn
jumps. While `onNavigateStructure` is absent, Alt+PageUp remains historical
page-up behavior.

### 6.2 Navigation cursor and resets

`findAdjacentAnchor(items, from, direction, kind)` is exclusive. So:

- from an item in the middle of turn N, previous lands on that turn's own
  prompt first, not an earlier turn;
- from an item already at turn N's prompt, previous lands on turn N - 1;
- no match gives -1, never wraps to the other end of the session.

The viewport clamps a requested scroll to its maximum possible offset. Once
the target is already inside the final page, later calls may leave its anchor
unchanged. Therefore structure jumps cannot use the new anchor as their next
origin. `createTranscriptNavCursor` instead records the requested target, so
consecutive keypresses each advance one boundary even though the visual offset
is clamped.

The cursor is reset when the reading position changes for an independent
reason:

1. Line/page scrolling on the keyboard.
2. Mouse wheel or scrollbar dragging.
3. External item positioning, such as a search jump (which uses
   `ScrollActions`).
4. An append that **actually moves** the reading-position anchor (auto-follow).
   An append that leaves it unchanged does not clear the cursor, so continuous
   streaming cannot repeatedly replay a clamped jump.

A navigation cursor is not follower-tracking: auto-follow state is only used by
the viewport itself, and can be restored with `scrollToEnd` when passing the
newest anchor.

### 6.3 Coalesced input

Wheel and drag events may be batched in a single frame. Structure jumps cancel
the queued scroll flush before dispatching, so a queued wheel delta cannot
apply after the jump and displace the requested item.

### 6.4 External interfaces and failures

This is a local UI feature, so there is no server API or error-code surface.
Its failure states are deliberately bounded:

| Situation                    | Behavior                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| No older/newer anchor        | `At first turn` / `At latest turn`; do not wrap.                                                                                             |
| Legacy Static mode           | `scrollToIndex` returns false and search reports that Virtualized History is required. Mode missing implementation is never claimed to work. |
| Target already on final page | Scroll clamping may keep the image still, but the cursor still advances. This is clamping, not a missing jump.                               |
| Empty query                  | No matching work.                                                                                                                            |
| Empty search result          | Match position -1. New matches arriving later clamp to zero, and subsequent arrow navigation has no -1 dead-key or off-by-one state.         |
| New output while searching   | Re-clamp the active position; no teleport to the newest hit.                                                                                 |
| New output while navigating  | Reset only if the actual reading-position anchor moved.                                                                                      |

## 7. Validation evidence

The following kinds of tests are permanent, not planned:

- Matching includes structured tool output and Ctrl+O detail text.
- Index computation with pending and de-duplicated items stays aligned.
- Initial selection, wraparound, negative positions, list growth, and direction
  symmetry are covered by hook tests.
- Match-cap order, exact full cap, whitespace-heavy snippets, and control
  sequences are covered at function level.
- Keys include negative assertions for missing modifiers.
- Search-mode tests cover drafts, query acceptance, typing cleanup, voice
  suppression, and restoring the saved viewport/follow state.
- Navigation-cursor tests cover clamped consecutive jumps, unchanged-anchor
  append, real auto-follow, and manual-scroll reset.
- Coalesced wheel input does not displace a jump.

The validation plan also includes real tmux interaction. Test-only "gate
passed" output is not substituted for real interactive behavior.

## 8. Compatibility and limits

Existing line/page scroll keys retain behavior. There are no new settings,
migrations, server routes, external protocol changes, or security configuration
changes. Source search is scoped to the current session.

OpenTUI is not modified. Existing `<Static>` history cannot be addressed by item
and is explicitly unsupported. Findings outside this implementation must not be
represented as tested merely because they share this file's terminology.
