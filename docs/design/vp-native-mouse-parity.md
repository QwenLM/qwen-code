# VP Mode Native Mouse Parity: Clickable Links + Right-Click Context Menu

## Problem statement

Since 0.21.1, Virtual Viewport (VP) mode is the default (`ui.useTerminalBuffer`),
and VP mode enables SGR mouse tracking (`?1002h ?1006h`) on the alternate
screen. When the application requests mouse tracking, the host terminal
forwards **all** mouse events to the app and stops handling them natively.
Two regressions result:

1. **Left-click on OSC 8 hyperlinks no longer opens the browser.** The app
   emits OSC 8 envelopes itself (`InlineMarkdownRenderer`, `TableRenderer`,
   `AuthenticateStep`) but never acts on clicks that land on them.
2. **Right-click does nothing.** Native terminals show a context menu
   (iTerm2, GNOME/VTE) or paste (Windows Terminal default); in VP mode the
   right-button event is parsed, broadcast, and dropped.

PR #8198 landed `ui.mouseTracking` (default `true`) as an escape hatch:
setting it `false` disables tracking so the terminal regains native handling,
at the cost of wheel scrolling, scrollbar drag, hover, click-to-position, and
drag-select. That is a workaround, not a fix: with default settings both
regressions remain. This design restores both behaviors **while mouse tracking
stays enabled**, so scrolling/hover/selection and native-style clicks coexist.

A prior attempt (PR #8198's removed "layer 2", commits `c9f24e3006` /
`0ec16530c2`) failed review for three reasons this design explicitly avoids:

| Prior defect                                                                                       | This design                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `openUrl` used `child_process.exec` with shell string interpolation → command injection on Windows | Reuse `openBrowserSecurely` from core (validated http/https-only launcher, no shell interpolation)                                    |
| Raw 1-based SGR screen coordinates used as item indices (no scroll/frame transform)                | Reuse the exact coordinate path the selection stack uses: `terminalToGrid` + wide-char snap, hit-test against the composited frame    |
| Re-parsed raw markdown to compute visual columns (drift on `**bold**` markers, CJK, wrapping)      | No markdown parsing at all: hit-test reads the **composited frame cells**, where ink has already resolved layout, wrapping, and width |

## Gesture conventions (decided)

Native terminals use **one specific modifier gesture** for link opening:
iTerm2 = ⌘+click, GNOME/VTE = Ctrl+click, Windows Terminal = Ctrl+click,
WezTerm/Kitty = plain click. Two protocol facts shape this design:

- **The Cmd key is not part of the SGR mouse protocol.** Only Shift/Ctrl/Meta
  modifier bits are reported, so the app can never detect ⌘. Terminals that
  open links on ⌘+click (iTerm2) intercept it at the terminal layer even
  while an app tracks the mouse (the tmux experience), so that path is
  expected to keep working natively (on-device confirmation still open — see
  Open questions).
- **Shift/Option are reserved.** This app documents Shift(Option)+drag as the
  "use the terminal's own selection" bypass gesture
  (`settingsSchema.ts` `useTerminalBuffer` description); occupying those
  modifiers would conflict.

Decision: **Ctrl+click opens links** — the single app-detectable gesture that
matches the VTE/Windows Terminal convention, collides with nothing, and
complements terminal-native ⌘+click on iTerm2. Plain left-click behavior is
entirely unchanged. Audit evidence: no existing mouse handler consumes the
parsed `shift`/`meta`/`ctrl` event fields (`mouse.ts:112-114` parses them,
nothing reads them), and no handler consumes middle-button events — the
Ctrl+click path is completely free.

Right-click opens an app-level context menu (the iTerm2/GNOME convention),
which also carries the link actions for discoverability — native terminals
likewise expose "Open Link" in the right-click menu alongside their modifier
gesture.

## Current state (verified)

- **Composited frame is the authority.** Ink composites the whole UI into a
  cell grid (`FrameController` / `ScreenBuffer`,
  `packages/cli/src/ui/selection/screen-buffer.ts`). Cells are
  `{value, fullWidth, styles, selectable, flowId}`.
- **OSC 8 survives compositing.** Ink's sanitizer preserves OSC tokens;
  `@alcalzone/ansi-tokenize` models OSC 8 as paired `AnsiCode` objects, and
  ink writes them into per-cell `styles` (`node_modules/ink/build/output.js`
  → `styles: character.styles`). So `frame.cells[y][x].styles` tells us
  whether a cell is inside a hyperlink and carries the URL escape verbatim.
  This holds across soft wraps (each cell carries its own styles), which is
  why re-parsing markdown is unnecessary.
- **Right-button events already flow.** `parseSGRMouseEvent` maps SGR button 2
  to `right-press` / `right-release`; `KeypressContext` broadcasts to all
  mouse subscribers. No subscriber consumes them today.
- **Coordinate mapping exists.** `terminalToGrid` (+ frame anchor) and the
  wide-char snap in `TextSelectionController.mapEvent` convert 1-based
  terminal cells to frame-grid points; `pointInViewport` bounds them to the
  history viewport.
- **Focus-gating precedent exists.** `agentTabBarFocused` /
  `embeddedShellFocused` flags quiet the composer's key handling while
  another surface owns the keyboard.
- **Ink supports overlays.** `Box position="absolute"` with `top`/`left` is
  available in ink 7, positioned relative to the parent box — sufficient for
  a context menu rendered as the last child of the app root layout box.

## Proposed changes

### 1. Hyperlink hit-testing utility — `hyperlinkAtCell`

New file `packages/cli/src/ui/utils/hyperlink-at.ts`:

- `hyperlinkAtCell(frame, x, y): string | undefined`
- Looks at `frame.cells[y][x]`; if the cell is a wide-character spacer
  (`value === ''` and the previous cell is `fullWidth`), checks `x - 1` (same
  snap the selection stack applies).
- Scans `cell.styles` for an entry whose `code` string contains an OSC 8
  opener; extracts the URL with a tolerant parser:
  - locates `]8;` inside the code string (works for plain `\x1b]8;…`,
    ST-terminated, C1-ST-terminated, and tmux/screen DCS passthrough forms
    with doubled ESC, since it searches for the marker rather than anchoring
    at string start);
  - skips the OSC 8 parameter section (up to the first `;` after `]8;`);
  - reads the URI up to the terminator (BEL, ESC, or C1 ST);
  - returns `undefined` for empty URIs (the link-_close_ code `\x1b]8;;\x07`
    only appears outside links, but guard anyway).
- Pure function over `ReadonlyFrame` → trivially unit-testable.

### 2. Content mouse controller — link clicks + right-click

New headless component
`packages/cli/src/ui/context-menu/ContentMouseController.tsx`, mounted in
`MainContent`'s VP branch next to `TextSelectionController`, with the same
wiring (`getViewportRect`, `hitTestScrollbar`) and the same `isActive` gate
(`!uiState.dialogsVisible`). It subscribes via `useMouseEvents` (tracking
`'button'` normally, upgraded to `'any'` while the menu is open — hover
needs bare-motion `?1003h`), which already enforces the VP gate,
`ui.mouseTracking` setting gate, and TTY gate — no new gating logic.

**Ctrl+click to open a link:**

- On `left-press` with `event.ctrl` in the viewport (not on the scrollbar):
  record the press cell.
- On `left-release` with `event.ctrl`: open only when press and release map
  to the same cell (a click, not a Ctrl+drag, which stays inert as today).
  No delay timer and no multi-click interplay — plain clicks are untouched,
  so drags, double/triple-click word/line select, and thought toggles keep
  their exact current behavior.
- Opening: `openBrowserSecurely(url)` (core). It validates http/https only —
  OSC 8 also allows `mailto:`/`ftp:`/`ssh:` targets, which
  `openBrowserSecurely` rejects; for those, fall back to `copyToClipboard`
  plus a user-visible `console.warn` naming the URL (same fallback UX
  `openBrowserSecurely` itself uses on launch failure). Never shell out with
  interpolated strings.

**Right-click context menu:**

- On `right-press` in the viewport (not on the scrollbar): build the item
  list from the clicked cell:
  1. **Open Link** — when `hyperlinkAtCell` finds a URL.
  2. **Copy Link Address** — same condition; `copyToClipboard(url)`.
  3. **Copy Selection** — when a non-empty text selection is active (see §3);
     snapshots the selected text at menu-open time and copies the snapshot
     on select (re-deriving the range at execute time would copy the wrong
     cells while the frame keeps streaming).
- If no item applies, do nothing (no empty menu).
- Open the menu at the click position via `ContextMenuContext` (§4).
- Also closes the menu on: any press outside the menu rect, any `scroll-*`
  event, or a new `right-press` (re-opens at the new spot). Menu must also
  close when `dialogsVisible` becomes true so the overlay never covers a
  dialog.

### 3. Exposing the active selection

`TextSelectionController` keeps its `SelectionState` in a private ref. Add an
optional prop `selectionQueryRef` (a `MutableRefObject<SelectionQuery | null>`)
that it populates with `{ getRange(): NormalizedRange | null }` and clears on
unmount. `MainContent` owns the ref and also passes it to
`ContentMouseController`, which uses it to decide whether "Copy Selection"
appears and to perform the copy. No state lifting, no new context, no
behavior change when the prop is absent.

### 4. Context menu state + overlay

New directory `packages/cli/src/ui/context-menu/`:

- `ContextMenuContext.tsx` — provider holding
  `{ items, position: {x, y}, selectedIndex } | null` and actions
  `openMenu(items, position)` / `closeMenu()`. `useContextMenu()` hook.
- `ContextMenuOverlay.tsx` — renders nothing when closed. When open, renders
  `<Box position="absolute" top={y} left={x}>` containing the item list, as
  the **last child of `DefaultAppLayout`'s root Box** (absolute elements draw
  over earlier in-flow siblings). Position is clamped so the menu fits in the
  terminal (flip up/left near the bottom/right edges, using terminal size and
  item count/width). Item text uses theme colors and a border, in line with
  existing dialog styling.

Interaction while open:

- **Mouse:** `move` highlights the row under the pointer (the menu knows its
  own origin and row height); `left-press` inside executes the item (handled
  by the controller, which owns all mouse-driven open/close).
- **Keyboard:** `useKeypress({ isActive: open })` handles ↑/↓ (move
  selection), Enter (execute), Esc (close). While open, a `contextMenuOpen`
  flag from the context quiets the composer in `InputPrompt` following the
  existing `agentTabBarFocused` pattern, so arrow keys/Esc don't also edit
  the prompt.

### 5. Settings and docs refresh

- `settingsSchema.ts`: refresh the `ui.mouseTracking` description — with
  tracking enabled, Ctrl+click opens links and right-click shows an in-app
  context menu; disabling hands the mouse fully back to the terminal (still
  the escape hatch for terminal-native handling). Cross-check the
  `ui.useTerminalBuffer` description for consistency.
- Docs: `docs/users/configuration/settings.md`,
  `docs/users/support/troubleshooting.md`,
  `docs/users/reference/keyboard-shortcuts.md` — document Ctrl+click, the
  right-click menu, the iTerm2 ⌘+click note, and remaining trade-offs.

## Key design decisions

1. **Hit-test the composited frame, never re-parse markdown.** The frame is
   post-layout, post-wrap, width-correct, and carries per-cell OSC 8 styles.
   This eliminates all three defects that killed the prior attempt by
   construction: there is no coordinate guesswork, no column accounting, and
   no CJK drift.
2. **Ctrl+click is the only link gesture.** Matches VTE/Windows Terminal
   conventions; ⌘ is invisible to the protocol (iTerm2 handles it
   terminal-side); Shift/Option stay reserved for the documented
   selection-bypass gesture. Verified zero existing consumers of mouse
   modifier fields, so no feature interaction.
3. **Reuse `openBrowserSecurely`.** Battle-tested platform dispatch, http(s)
   validation, `$BROWSER` support, no shell interpolation, and a user-visible
   manual fallback. Non-http(s) OSC 8 schemes degrade to copy-to-clipboard.
4. **Context menu is an ink `position="absolute"` overlay, not raw escape
   writes.** Ink owns the screen in VP mode; raw ANSI overlays would be
   wiped by the next diff render. Absolute positioning inside the root
   layout box aligns with frame-grid coordinates (same space
   `terminalToGrid` produces). Rendering risk is bounded: a compositing
   spike validates z-order before build-out; fallback is the composer/dialog
   slot if absolute compositing misbehaves.
5. **Menu scope v1: link + selection items only.** No Paste: the codebase
   has no clipboard-read primitive; cross-platform paste (and middle-click
   paste, which needs the same primitive) are tracked as follow-ups.
   Right-click with no link and no selection is a no-op rather than an empty
   menu.
6. **No changes to `KeypressContext` broadcast semantics.** No
   stop-propagation/consumption is added; composer quieting uses the
   established focus-flag pattern instead.

## Files affected

| File                                                                                                                          | Change                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/ui/utils/hyperlink-at.ts`                                                                                   | **new** — `hyperlinkAtCell`                                                                                                 |
| `packages/cli/src/ui/utils/hyperlink-at.test.ts`                                                                              | **new** — URL extraction unit tests (BEL/ST/C1-ST terminators, params, tmux doubled ESC, wide-char snap, empty/close codes) |
| `packages/cli/src/ui/context-menu/ContextMenuContext.tsx`                                                                     | **new** — provider + `useContextMenu`                                                                                       |
| `packages/cli/src/ui/context-menu/ContextMenuOverlay.tsx`                                                                     | **new** — absolute overlay, hover/keyboard/item execution                                                                   |
| `packages/cli/src/ui/context-menu/ContentMouseController.tsx`                                                                 | **new** — headless controller (Ctrl+click + right-click menu building + dismissal)                                          |
| `packages/cli/src/ui/context-menu/*.test.tsx`                                                                                 | **new** — collocated component tests (mouse harness pattern from `BaseSelectionList.mouse.test.tsx`)                        |
| `packages/cli/src/ui/components/MainContent.tsx`                                                                              | mount controller + selection query ref in VP branch                                                                         |
| `packages/cli/src/ui/selection/use-text-selection.tsx`                                                                        | optional `selectionQueryRef` prop                                                                                           |
| `packages/cli/src/ui/layouts/DefaultAppLayout.tsx`                                                                            | render `<ContextMenuOverlay />` last inside root Box                                                                        |
| `packages/cli/src/ui/AppContainer.tsx`                                                                                        | mount `ContextMenuProvider`                                                                                                 |
| `packages/cli/src/ui/components/InputPrompt.tsx`                                                                              | quiet composer keys while menu open                                                                                         |
| `packages/cli/src/ui/components/shared/RowMouseController.tsx`                                                                | quiet row hover/select while the menu is open (`isActive` gate)                                                             |
| `packages/cli/src/ui/components/shared/TextInputMouseController.tsx`                                                          | quiet click-to-position while the menu is open                                                                              |
| `packages/cli/src/ui/components/HistoryItemDisplay.tsx`                                                                       | yield Ctrl+presses to the link controller (cancel the thought-toggle press)                                                 |
| `packages/cli/src/ui/selection/selection-coords.ts`                                                                           | extracted `snapWideChar` helper shared with the controller                                                                  |
| `integration-tests/terminal-capture/scenarios/vp-context-menu.ts`                                                             | **new** — manual visual-evidence scenario (not collected by any test suite)                                                 |
| `packages/cli/src/config/settingsSchema.ts`                                                                                   | `ui.mouseTracking` description refresh                                                                                      |
| `packages/vscode-ide-companion/schemas/settings.schema.json`                                                                  | regenerated mirror of `settingsSchema.ts`                                                                                   |
| `docs/users/configuration/settings.md`, `docs/users/support/troubleshooting.md`, `docs/users/reference/keyboard-shortcuts.md` | docs refresh                                                                                                                |

## Scope boundaries

**In scope:** Ctrl+click opens OSC 8 links in VP mode with tracking on;
right-click context menu (Open Link / Copy Link Address / Copy Selection);
settings + docs refresh.

**Out of scope (documented, not built):**

- Paste menu item and middle-click paste (need a clipboard-read primitive;
  follow-up issue).
- Hover URL preview (follow-up enhancement; the `?1003h` upgrade itself is
  built — gated to the open menu — but no preview UI exists yet).
- Heuristic detection of bare URLs in content that was _not_ OSC 8-wrapped
  (tool output, non-markdown surfaces). Only links the renderers wrapped are
  clickable — exactly the set a terminal would render as OSC 8 links.
- Right-click menu over dialogs/menus/suggestions (controller inactive while
  dialogs are visible; those surfaces are non-VP or separately gated).
- Non-VP (`<Static>`) mode: tracking is off there, so the terminal already
  handles clicks natively.
- Changing `ui.mouseTracking` semantics or making it runtime-toggleable.

## Open questions

1. **Overlay compositing spike** — RESOLVED during implementation: a
   throwaway render test confirmed ink 7 `position="absolute"` boxes draw over
   earlier in-flow siblings at the requested `top`/`left`, with one caveat —
   an absolute child needs in-flow siblings to give the root a size (the
   transcript provides this in the real layout; the overlay renders nothing
   while closed, so the steady state is unaffected).
2. **iTerm2 ⌘+click under tracking** — empirically verify on device whether
   iTerm2 still opens OSC 8 links on ⌘+click while qwen tracks the mouse;
   adjust docs to match observed behavior.
3. **Menu styling** — reuse dialog border/theme tokens; final colors follow
   theme review during implementation.

## Implementation notes (added during build)

- The controller also closes a stranded menu when it deactivates (a dialog
  opening mid-interaction), since it would otherwise stop receiving the events
  that dismiss the menu.
- `executeIndex` runs the item action outside the state updater (StrictMode
  double-invokes updaters; side effects there would fire twice).
- Every other VP mouse consumer (scroll list, thought toggle, row hover/select,
  composer click-to-position) quiets while the menu is open so a click on the
  overlay can't also act on the content underneath it.

## Review-driven refinements

- Text selection is only **paused** while the menu is open, not cleared: an
  `eventsPaused` prop makes the selection controller ignore press/move/release
  without touching the existing range/highlight, because deactivating it would
  clear the very selection the menu's Copy Selection item offers.
- Copy Selection snapshots the selected **text** at menu-open time (not the
  range), so a frame that keeps streaming while the menu is open cannot make a
  stale range copy the wrong cells.
- `openBrowserSecurely` is awaited with a `.catch` fallback: it rejects on
  http(s) URLs that fail strict validation (e.g. `https://` with no host,
  which the markdown renderer will still OSC 8-wrap), and an unhandled
  rejection would surface a scary critical-error banner.
- URL extraction stops at any C0 control (not just BEL/ESC/C1-ST) so a hostile
  envelope cannot smuggle control characters into the extracted URL.
- The menu position is clamped to the composited frame's height and visible
  top row, not the raw terminal size, since the overlay can only paint inside
  the frame and the frame may overflow or undershoot the terminal.

## Known limitation

Verified on device: the selection survives the menu's whole open lifetime, but
an **Escape that closes the menu also clears the selection** (a bare Escape
with no menu preserves it; a wheel-close clears too, consistent with the
existing "scroll drops the selection" rule). The exact clear path is the
selection stack's frame-invalidation reacting to the menu-close re-render;
root-causing it needs instrumentation of the invalidation callback, which is
out of scope here. Impact is cosmetic as long as the drag completed before
the menu opened — drag-select copies on release, so the text is already on
the clipboard then; a menu opened mid-drag is the exception (the copying
release is paused, so the text is not on the clipboard yet). Escaping
without clearing is a candidate follow-up once the invalidation path is
instrumented.

## Future work

- Paste item + middle-click paste once a cross-platform clipboard-read helper
  exists.
- Hover URL preview (requires `?1003h` motion tracking; weigh event volume).
- Consider runtime-toggleable mouse tracking (no restart) as a separate UX
  improvement.
