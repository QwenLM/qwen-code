# VP Mode Mouse Text Selection and Copy

## Summary

In Virtualized-viewport (VP) mode — the mode enabled by `ui.useTerminalBuffer` — the CLI runs inside the terminal's alternate screen and enables SGR mouse tracking so it can drive scrolling, click-to-focus, and hover highlighting. A side effect is that the terminal no longer receives the click-drag events it would use for native text selection, so users cannot select and copy text with the mouse the way they can in a normal (non-VP) session. The only current workaround is to hold Shift/Option while dragging (terminal-dependent), and nothing in the UI surfaces it.

This document proposes an application-level text selection and copy system for VP mode: the CLI takes ownership of press/drag/release, maintains a selection, renders a highlight, and copies the selected text to the system clipboard (with an OSC 52 fallback for remote/tmux sessions). It evaluates two implementation routes and commits to **Route B: expose the Ink renderer's per-frame cell grid through the existing Ink patch**, because that removes the correctness hazard that makes the alternative fragile.

This is the design step of a feature PR. Implementation lands in subsequent commits on the same branch, staged as the milestones in this document.

## Goals

- Mouse click-drag selects text on screen in VP mode, with a visible highlight.
- Double-click selects a word; triple-click selects a line.
- Releasing the mouse copies the selection to the system clipboard (copy-on-select, on by default and configurable), matching the behavior most terminals give natively.
- A keyboard path to copy (`Ctrl+Shift+C`) and to clear the selection (`Esc`).
- Selected text is faithful: soft-wrapped lines are rejoined, wide characters (CJK/emoji) and their spacer cells are handled, gutter/decoration cells are excluded, trailing whitespace is trimmed.
- Works across local (pbcopy/xclip/xsel/clip), remote (OSC 52), and multiplexer (tmux/screen passthrough) environments by reusing existing clipboard infrastructure.
- An escape hatch that returns the mouse to the terminal so users who prefer native selection (or hit an environment where ours misbehaves) can opt out.

## Non-goals

- Selection in non-VP (normal-buffer) mode. Normal mode does not enable mouse tracking, so native terminal selection already works; this feature is scoped to VP mode only.
- Reading text from the system clipboard (paste). Text paste continues to flow through terminal bracketed-paste; only image paste reads the clipboard today, and that path is untouched.
- Selection inside the input composer beyond what already exists; the composer already maps clicks to cursor offsets.
- Rich-copy (HTML/ANSI). We copy plain text.

## Background: why native selection breaks in VP mode

VP mode is controlled by the `ui.useTerminalBuffer` setting. When on, the Ink root renderer is given the alternate screen, and the CLI renders history inside its own scrollable viewport instead of relying on the host terminal's scrollback.

Mouse tracking is enabled only in VP mode, gated by the "VP gate" in `useMouseEvents`: outside VP mode the gate refuses to write the tracking escape sequences, precisely so that native scrollback and native selection keep working. Inside VP mode the CLI writes SGR tracking sequences (`?1002h`/`?1003h` plus `?1006h`), documented in `packages/cli/src/ui/utils/mouse.ts`. Native text selection is a button-held drag, which both `?1002h` and `?1003h` capture — so downgrading the tracking level does not restore native selection. The only ways to give the user selection back are: turn tracking off entirely, let the terminal bypass it via a modifier (Shift/Option), or implement selection in the application. This feature does the third.

## Prior art

- **gemini-cli** (this project's upstream sibling) does not implement application-level selection. It offers two escape hatches: a global toggle that disables mouse tracking (`Ctrl+S`) and an in-app "Copy Mode" (`F9`) that temporarily disables tracking and freezes scrolling so the terminal's own selection works, exiting on any key. It also detects a left-drag and shows a transient hint pointing the user at the toggle. This is low-cost and robust but hands selection back to the terminal rather than owning it.
- **A reference terminal coding agent** takes the opposite approach: it forks Ink so the renderer exposes a per-cell screen buffer, then implements the full selection stack itself — character/word/line selection, drag-to-scroll with off-screen accumulation, a highlight overlay drawn by overriding cell background, copy-on-select, and clipboard delivery via native tools / tmux buffer / OSC 52. Coordinate-to-text mapping is trivial there because the cell grid is directly addressable. This is the richest UX and the model for Route B below.

## Feasibility: what already exists

The mouse and clipboard layers are mature and reusable. The missing pieces are the selection state machine, coordinate-to-text mapping across the whole history, highlight rendering, and a key-preemption path.

| Capability                                                                                      | Status                                                                                                            | Reuse                                   |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| SGR mouse parse, fragment reassembly, ref-counted enable/disable                                | Present (`mouse.ts`, `KeypressContext`, `useMouseEvents`) — parses press/move/**release**, guards bracketed-paste | Direct                                  |
| System clipboard write: pbcopy/xclip/xsel/clip, OSC 52 remote fallback, tmux/screen passthrough | Present (`commandUtils.ts:copyToClipboard`, `clipboardUtils.ts:writeOsc52`, `utils/osc.ts`)                       | Direct                                  |
| Centralized keybindings + matchers                                                              | Present (`config/keyBindings.ts`, `keyMatchers.ts`)                                                               | Add commands                            |
| Declarative boolean settings                                                                    | Present (`settingsSchema.ts`)                                                                                     | Add entries                             |
| Yoga element position/size measurement                                                          | Present (`measure-element-position.ts`, `list-mouse.ts`)                                                          | Direct                                  |
| Coordinate → character offset with wide-char/soft-wrap awareness                                | Present but input-only (`input-mouse.ts:visualClickToOffset`)                                                     | Generalize / superseded by Route B grid |
| Per-line text model                                                                             | Local only (`MaxSizedBox` styled lines, `text-buffer` visual lines)                                               | N/A under Route B                       |
| Addressable screen cell buffer                                                                  | **Absent** in the app; Ink builds one transiently in `Output.get()` but does not expose it                        | **Route B exposes it**                  |
| Selection state machine, highlight rendering, key preemption, transient toast                   | **Absent**                                                                                                        | Build                                   |

Two facts anchor the design. First, `left-release` is already parsed but has no consumer — no drag-to-select logic exists yet. Second, Ink 7's renderer already composites every frame into a cell grid: `Output.get()` in `node_modules/ink/build/output.js` builds `row[][]` where each cell is `{ type: 'char', value, fullWidth, styles }`. That grid is the fully composited, clipped, scrolled screen — exactly what a coordinate query needs — but it is local to `get()` and thrown away after being serialized to the string Ink writes to stdout.

## Design decision: Route A vs Route B

**Route A — application-level per-item text model (no Ink change).** Attach a measurable ref to each visible history item, measure item positions with `measureElementPosition`, hit-test a mouse row to an item, then map within the item to a line/character by generalizing `visualClickToOffset`. Render the highlight by re-slicing each `<Text>` into selected/unselected segments.

- Pro: no Ink change; fits the current "stock Ink + application shims" posture; upgrades stay painless.
- Con: history items are heterogeneous (markdown, `DiffRenderer`, `TableRenderer`, tool output, …), and each would need a text serialization that matches its actual on-screen wrapping exactly. Three wrapping implementations coexist (Ink `<Text wrap>`, `MaxSizedBox`'s own wrapper, `wrapToVisualLines`); any mismatch puts the selection boundary out of step with the screen. Every new renderer type becomes a place selection can silently break. The correctness surface is large and permanent.

**Route B — expose the renderer cell grid via the Ink patch.** The project already patches Ink (`patches/ink+7.0.3.patch` adds the `./dom` and `./components/CursorContext` exports). Extend that patch minimally so the renderer captures the `Output.get()` cell grid for the committed frame and exposes it (plus width/height and a per-frame change signal) to the application. Selection then queries the grid directly: a screen coordinate maps to a cell, and a range of cells maps to text.

- Pro: coordinate-to-text becomes trivial and **uniform across every content type** — markdown, diffs, tables, and tool output are already composited into the same grid, so there is nothing per-renderer to maintain. Wide-char spacer cells (`fullWidth`) and soft wrapping are represented in the grid natively. Because VP mode uses the alternate screen, the grid is top-anchored and full-screen, so the terminal-row → grid-row mapping is near-identity, avoiding most of the frame-anchor arithmetic Route A would need.
- Con: it deepens the Ink patch, so an Ink upgrade must re-apply it; and the patch must be covered by tests and ideally upstreamed.

**Decision: Route B.** T2's difficulty is concentrated in the _correctness_ of coordinate-to-text, and Route A solves that with the most fragile mechanism available (per-type serialization kept in lockstep with three wrappers). Route B eliminates that class of bug at the cost of a small, well-scoped patch, which the repo has already established a precedent for. If the maintainers reject deepening the Ink patch, we fall back to Route A and accept the per-renderer serialization burden; that is the main open question for review.

## Architecture (Route B)

### Module layout

```
packages/cli/src/ui/selection/
  screen-buffer.ts        # Reads the exposed cell grid; getCellAt(col,row), lineText(row), dimensions
  selection-state.ts      # anchor/focus model, char/word/line modes, drag flag, off-screen accumulation
  selection-text.ts       # cell range → plain text (skip spacers/gutters, rejoin soft wrap, trim EOL)
  use-text-selection.ts   # subscribes useMouseEvents; drives the state machine; copy-on-select
  SelectionOverlay        # applies the highlight (see "Highlight rendering")
packages/cli/src/ui/contexts/
  SelectionContext.tsx    # broadcasts selection state + a "selection active" flag for key preemption
```

### Ink patch: expose the frame cell grid

The patch adds three things, kept as small as possible:

1. In `Output.get()`, retain the composited cell grid (`row[][]`) on the `Output` instance instead of discarding it after string serialization.
2. On the Ink renderer/instance, expose an accessor for the latest committed grid plus its `{ width, height }`, and an `onFrame` subscription that fires after each render commit so selection can invalidate cached lookups and re-derive highlighted text.
3. A read-only, application-facing handle (via the already-exported `ink/dom` surface or a small dedicated export) so `screen-buffer.ts` can read the grid without reaching into Ink internals at call sites.

The grid is read-only from the application's perspective for coordinate queries. Highlighting writes back through the same patch point (below), not by mutating application state.

### Event and coordinate pipeline

```
SGR bytes ─(KeypressContext reassembly)→ MouseEvent{ action, col, row, shift, meta }
  left press            → startSelection(anchor)
  left move (drag)      → extendSelection(focus) + edge auto-scroll
  left release          → finishSelection → copy-on-select
  double / triple click → selectWordAt / selectLineAt (≈500ms, 1-cell threshold)

(col,row) terminal coords
  → grid row/col   (VP alt-screen: near-identity; apply any frame offset once)
  → virtual row    (gridRow + viewport scrollTop) — the stable anchor space
  → ScreenBuffer.getCellAt → character / wide-char spacer / gutter marker
```

Selection anchors are stored in **virtual-row space** (`viewport scrollTop + gridRow`), not raw screen rows, so that scrolling during or after a drag keeps the selection pinned to content rather than to screen position. This is also what makes drag-to-scroll accumulation correct: as the viewport scrolls under a held drag, rows that leave the screen are accumulated (an off-screen-above/below text buffer) so the final copy includes content that scrolled out of view.

### Highlight rendering

Ink has no overlay layer, so the highlight must come from the render itself. Under Route B the natural point is the same patch site that exposes the grid: after compositing, before serialization, cells whose virtual coordinate falls inside the selection get their background overridden with the theme's selection color (foreground preserved). This is a single extra transform over the grid per frame and keeps the highlight perfectly aligned with the text the coordinate query sees, because both read the same grid. Selection changes trigger one Ink repaint via the `onFrame`/state path.

### Copy

Copy reuses `copyToClipboard()`, which already chains platform tools (pbcopy / xclip → xsel / clip) and falls back to `writeOsc52()` for remote sessions, wrapping the sequence for tmux/screen. Two constraints carry into the UX:

- OSC 52 has a size cap (`MAX_OSC52_BYTES`, ~75 KB). A large selection copied over a pure-remote channel can be truncated; the copy path must detect this and surface it ("copied N chars; remote channel truncated to X") rather than silently losing the tail.
- `copyOnSelect` (default on) copies on release/multi-click and keeps the highlight, mirroring iTerm2. When off, copy is manual via keybinding.

### Keybindings and key preemption

Existing bindings constrain the choices: `Ctrl+C` is `QUIT`, and `Ctrl+V`/`Cmd+V` are `PASTE_CLIPBOARD_IMAGE`. So:

- Copy: `Ctrl+Shift+C` (primary); `Cmd+C` on macOS where the terminal does not intercept it.
- Clear selection: `Esc` when a selection exists.

`KeypressContext` currently broadcasts to all subscribers with no priority. Selection needs "when a selection is active, keys act on the selection first." We add a lightweight preemption: `SelectionContext` exposes a `hasSelection` flag; a high-priority handler placed ahead of the broadcast consumes copy/clear keys, and for any other key clears the selection first (then lets the key through), mirroring how native terminals drop a selection as soon as you type. This is a small, contained addition rather than a general priority stack.

### Settings

Add under `ui` in `settingsSchema.ts` (following the `vimMode` boolean pattern):

- `ui.textSelection.enabled` (default `true`; effective only in VP mode).
- `ui.textSelection.copyOnSelect` (default `true`).

Retain a global escape hatch that fully disables the CLI's mouse ownership and hands the mouse back to the terminal for native selection/scrollback — covering patch defects, accessibility, and users who simply prefer native behavior. This complements, and does not replace, the per-feature toggle.

### Transient hints and "copied" feedback

There is no general toast component. Following the existing `Footer` pattern (`ctrlCPressedOnce`), add a timed UIState field rendered in the footer:

- A "✓ copied N chars" confirmation after a copy (transient, not written into history).
- A drag hint when a left-drag is detected but selection is disabled or unavailable, pointing the user at Shift/Option native selection or the toggle — the same discoverability gap gemini-cli fills with its selection warning.

## Coordinate mapping details

- **Alt-screen anchoring.** VP mode renders in the alternate screen, which is top-anchored and full-screen, so terminal row _r_ maps to grid row _r_ minus any fixed frame offset. This is where Route B pays off: the grid is already the scrolled, clipped, composited screen, so the query does not need to walk item offsets or reconstruct wrapping. The one-time offset is validated against `layoutRowForEvent`, which already encodes the alternate-screen frame-anchor correction used elsewhere.
- **Viewport scroll.** The virtualized viewport applies `scrollTop` (and a negative top margin) to position content. Converting a grid row to a stable virtual row is `gridRow + scrollTop`; storing anchors in virtual-row space is what keeps selections stable across scrolling and enables off-screen accumulation.
- **Streaming / re-render.** While output streams, frames change under a fixed selection. v1 policy: keep the selection anchored in virtual-row space; if the anchored content is still within the scrollable range, the highlight and copied text track it; if the model output invalidates the anchored region (content replaced, not just appended), clear the selection. Re-anchoring to logical content identity is deferred (open question).

## Wide characters, soft wrap, and selected text

- **Wide characters.** The grid marks wide cells with `fullWidth` and represents the trailing half as a spacer; `selection-text.ts` emits the wide character once and skips the spacer. Boundary snapping (a click on the right half selects the whole glyph) reuses the mid-cell snap logic already in `visualClickToOffset`.
- **Soft wrap.** A logical line wrapped across several grid rows is rejoined when producing text, so a copied paragraph is one line, not several. The grid does not itself distinguish a soft wrap from a hard newline, so the rejoin uses the wrap width and the absence of intervening content to decide; this is the one place the text extraction needs care and gets dedicated tests.
- **Gutters / decorations.** Cells that are pure decoration (line-number gutters, scrollbar column, list markers) are tagged non-selectable and skipped. Under Route B these are identified by column region and style, matching how the reference implementation excludes `noSelect` cells.
- **Trailing whitespace.** Per-line trailing spaces (padding to the frame width) are trimmed from the extracted text.

## Edge cases and risks

| Item                             | Risk                                             | Mitigation                                                                                        |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Wrapping consistency             | Historically the top hazard (three wrappers)     | Route B reads the composited grid; no per-type serialization                                      |
| Ink patch maintenance            | Upgrades must re-apply; internal API drift       | Keep the patch minimal; add tests that assert grid shape; pursue an upstream Ink PR               |
| Scroll/frame offset drift        | `scrollTop` / frame-anchor off-by-one            | Anchor in virtual-row space; integration tests across scroll positions; reuse `layoutRowForEvent` |
| OSC 52 size cap                  | Remote large-selection truncation                | Detect and surface; prefer local tools when present                                               |
| Performance                      | Large history + per-drag repaint                 | Highlight is an incremental grid transform; throttle drag (~16ms)                                 |
| Non-VP mode                      | Enabling ownership would hijack native selection | Keep strictly VP-gated                                                                            |
| Accessibility / screen reader    | Mouse ownership may interfere                    | Escape hatch + default off under screen reader                                                    |
| Streaming under active selection | Content shifts beneath a selection               | Virtual-row anchoring; clear on content replacement (v1)                                          |

## Milestones

- **M0 — Patch spike (go/no-go).** Extend the Ink patch to expose the cell grid; a throwaway probe prints `getCellAt` results and verifies coordinates and wide characters map correctly. This is the feasibility gate for Route B; if the patch proves untenable, revisit Route A before proceeding.
- **M1 — Selection state machine + coordinate mapping.** press/drag/release → cell range → `getSelectedText`. No highlight yet; prove copy of the correct text.
- **M2 — Highlight rendering.** Selection background override through the patch site.
- **M3 — Copy interactions.** copy-on-select + `Ctrl+Shift+C` + `Esc` + "copied" footer confirmation + key preemption.
- **M4 — Word/line selection + edge auto-scroll + off-screen accumulation.**
- **M5 — Settings + escape hatch + drag hint + docs.**

M0 is the decision point. Each milestone is a reviewable commit on this branch.

## Testing strategy

- **Unit** — coordinate mapping (wide chars, soft wrap, scroll offset); `selection-text.ts` extraction; key-preemption handler; OSC 52 boundary handling.
- **Snapshot** — `getSelectedText` over representative content: markdown, a diff, a table, and tool output, asserting the extracted text matches the visible text.
- **Patch guard** — a test asserting the exposed grid's shape and dimensions, so an Ink upgrade that changes `Output.get()` fails loudly rather than silently breaking selection.
- **E2E** — drive a real terminal (interactive tmux harness) to drag-select across wrapped lines and multiple history items, confirm the clipboard/OSC 52 payload. Follows the E2E test-plan workflow in `.qwen/e2e-tests/`.

## Rollout

Ships behind `ui.textSelection.enabled` (default on in VP mode) with a global escape hatch to return the mouse to the terminal. Because the feature is VP-only and VP mode is itself opt-in (`ui.useTerminalBuffer` defaults off), the blast radius is limited to users who have already opted into VP mode.

## Open questions

- Is deepening the Ink patch acceptable to maintainers, or must this stay on stock Ink (forcing Route A)? This is the gating decision for the whole design.
- Streaming under an active selection: is v1's "clear on content replacement" acceptable, or is logical-content re-anchoring required for the first release?
- `Cmd+C` on macOS is frequently intercepted by the terminal's Edit menu; do we rely on `Ctrl+Shift+C` as the sole reliable manual-copy binding and treat `Cmd+C` as best-effort?
