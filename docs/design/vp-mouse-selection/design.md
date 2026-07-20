# VP Mode Mouse Text Selection and Copy

## Summary

In Virtualized-viewport (VP) mode — the mode enabled by `ui.useTerminalBuffer` — the CLI runs inside the terminal's alternate screen and enables SGR mouse tracking so it can drive scrolling, click-to-focus, and hover highlighting. A side effect is that the terminal no longer receives the click-drag events it would use for native text selection, so users cannot select and copy text with the mouse the way they can in a normal (non-VP) session. The only current workaround is to hold Shift/Option while dragging (terminal-dependent), and nothing in the UI surfaces it.

This document proposes an application-level text selection and copy system for VP mode: the CLI takes ownership of press/drag/release, maintains a selection, renders a highlight, and copies the selected text to the system clipboard (with an OSC 52 fallback for remote/tmux sessions).

The feature is delivered in **two PRs** with a deliberately conservative first release:

- **PR 1 (#6937, merged)** — the Ink frame-buffer foundation and a **visible-region visual selection** MVP: drag-select within the currently visible viewport, word/line selection, and copy-on-select. Copy returns the **visual cells** as shown on screen; it does not yet rejoin soft-wrapped lines or exclude gutters. Selection clears on scroll/resize/streaming.
- **PR 2 (follow-up)** — **semantic copy fidelity**: soft-wrap rejoin and gutter/decoration exclusion, which require renderer-level semantic metadata rather than a raw grid. Cross-screen selection remains outside this two-PR sequence.

This split follows the "Simplicity First" principle: PR 1 solves the core problem (mouse select-and-copy of what's on screen) with a small, well-scoped Ink patch and no per-renderer text serialization; the deeper renderer semantic extension is isolated in PR 2 so it can be reviewed against its own cost.

The design was revised after an implementation-feasibility audit against the Ink 7 renderer source; the corrected data contracts, coordinate formula, clipboard behavior, and highlight API below reflect that audit.

## Goals

### PR 1 — visible-region visual selection

- Mouse click-drag selects text within the currently visible viewport, with a visible highlight.
- Double-click selects a visual word; triple-click selects a visual line.
- Releasing the mouse copies the selection to the system clipboard.
- Copy delivers the visual cells as displayed, across local (pbcopy/xclip/xsel/clip), remote (OSC 52), and multiplexer (tmux/screen passthrough) environments, reusing existing clipboard infrastructure. Wide characters (CJK/emoji) and their spacer cells are handled; per-line trailing padding is trimmed.
- Selection clears deterministically on any non-selection scroll, resize, or streaming/layout change.

### PR 2 — semantic copy fidelity (follow-up)

- Soft-wrapped logical lines are rejoined while true hard newlines are preserved.
- The VP scrollbar and code/diff line-number gutters are excluded.
- Diff markers, Markdown markers, table borders, and tool-output prefixes remain copyable content.

## Non-goals

- Selection in non-VP (normal-buffer) mode. Normal mode does not enable mouse tracking, so native terminal selection already works; this feature is scoped to VP mode only.
- Reading text from the system clipboard (paste). Text paste continues to flow through terminal bracketed-paste; only image paste reads the clipboard today, and that path is untouched.
- Selection inside the input composer beyond what already exists; the composer already maps clicks to cursor offsets.
- Rich-copy (HTML/ANSI). We copy plain text.
- Cross-screen selection, edge auto-scroll, and off-screen row accumulation.

## Background: why native selection breaks in VP mode

VP mode is controlled by the `ui.useTerminalBuffer` setting. When on, the Ink root renderer is given the alternate screen, and the CLI renders history inside its own scrollable viewport instead of relying on the host terminal's scrollback.

Mouse tracking is enabled only in VP mode, gated by the "VP gate" in `useMouseEvents`: outside VP mode the gate refuses to write the tracking escape sequences, precisely so that native scrollback and native selection keep working. Inside VP mode the CLI writes SGR tracking sequences (`?1002h`/`?1003h` plus `?1006h`), documented in `packages/cli/src/ui/utils/mouse.ts`. Native text selection is a button-held drag, which both `?1002h` and `?1003h` capture — so downgrading the tracking level does not restore native selection. The only ways to give the user selection back are: turn tracking off entirely, let the terminal bypass it via a modifier (Shift/Option), or implement selection in the application. This feature does the third.

## Prior art

- **gemini-cli** (this project's upstream sibling) does not implement application-level selection. It offers two escape hatches: a global toggle that disables mouse tracking and an in-app "Copy Mode" (`F9`) that temporarily disables tracking and freezes scrolling so the terminal's own selection works, exiting on any key. It also detects a left-drag and shows a transient hint. This is low-cost and robust but hands selection back to the terminal rather than owning it, and cannot provide an in-app highlight or copy-on-select. It remains the recommended fallback (see the escape hatch) if application selection is disabled.
- **A reference terminal coding agent** takes the opposite approach: it forks Ink so the renderer composites into an addressable cell buffer, then implements the full selection stack — character/word/line selection, drag-to-scroll with off-screen accumulation, a highlight drawn by overriding cell background before serialization, copy-on-select, and clipboard delivery via native tools / tmux buffer / OSC 52. It carries per-cell source/selectability metadata so it can rejoin soft wraps and exclude decorations. This is the model for the frame-buffer foundation (PR 1) and the semantic contract (PR 2) below.

## Feasibility: what already exists

The mouse and clipboard layers are mature and reusable. The missing pieces are the frame-buffer foundation, the selection state machine, highlight rendering, mouse-event arbitration, and a key-preemption path.

| Capability                                                                                       | Status                                                                                                        | Reuse                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------ |
| SGR mouse parse, fragment reassembly, ref-counted enable/disable                                 | Present (`mouse.ts`, `KeypressContext`, `useMouseEvents`) — parses press/move/release, guards bracketed-paste | Direct                   |
| System clipboard write: pbcopy/xclip/xsel/clip, OSC 52 remote fallback, tmux/screen passthrough  | Present (`commandUtils.ts:copyToClipboard`, `clipboardUtils.ts:writeOsc52`, `utils/osc.ts`)                   | Direct (with API change) |
| Centralized keybindings + matchers                                                               | Present (`config/keyBindings.ts`, `keyMatchers.ts`)                                                           | Add commands             |
| Declarative boolean settings                                                                     | Present (`settingsSchema.ts`)                                                                                 | Add entries              |
| Yoga element position/size measurement                                                           | Present (`measure-element-position.ts`, `list-mouse.ts`, `layoutRowForEvent`)                                 | Direct                   |
| Coordinate → character offset with wide-char/soft-wrap awareness                                 | Present but input-only (`input-mouse.ts:visualClickToOffset`); mid-cell snap logic reusable                   | Reuse snap logic         |
| Addressable screen cell buffer                                                                   | **Absent** in the app; Ink composites one transiently in `Output.get()` but does not expose it                | **PR 1 exposes it**      |
| Selection state machine, highlight rendering, mouse arbitration, key preemption, transient toast | **Absent**                                                                                                    | Build                    |

Two facts anchor the design. First, `left-release` is already parsed and existing consumers (scrollbar drag, click-to-focus) react to mouse events, but there is **no selection consumer** and mouse events are broadcast with no consumption/arbitration semantics — a selection handler must coordinate with the existing scrollbar-drag and click-to-focus handlers. Second, Ink 7's renderer composites every frame into a cell grid in `Output.get()` (`node_modules/ink/build/output.js`), producing `row[][]` where each cell is `{ type: 'char', value, fullWidth, styles }`. That grid is the fully composited, clipped screen — but it is local to `get()`, discarded after serialization, and (critically) carries no logical-text semantics.

## Design decision: raw frame buffer (PR 1) → semantic frame buffer (PR 2)

The audit confirmed the direction but corrected a category error in the earlier draft: a raw `Output.get()` grid is sufficient for _visual_ selection but **cannot** by itself deliver _logical-text fidelity_, because the information needed for that is destroyed before the grid exists.

- **Soft vs hard wrap is unrecoverable from the grid.** `render-node-to-output.ts` calls `wrapText()` and only then passes newline-joined strings to `Output.write()`; `Output.get()` sees `text.split('\n')` and cannot tell a soft wrap from a hard newline. A hard break that exactly fills the wrap width is byte-identical in the grid to a soft wrap. "Line width + absence of intervening content" does not disambiguate it.
- **Selectability has no data source in the grid.** Gutters, the scrollbar column, and decorations cannot be reliably identified by column region and style across markdown/diff/table/tool output.
- **The grid is one frame, not the virtual document.** `VirtualizedList` mounts only the visible range; off-screen items have no cells. Cross-screen selection would require off-screen snapshotting and a content/layout-version lifecycle, so it remains separate from semantic copy fidelity.

Therefore:

- **PR 1 uses the raw frame buffer**, scoped to visible-region visual selection. Coordinate-to-text is uniform across every content type because everything is already composited into one grid; there is nothing per-renderer to serialize. This is genuinely small and well-scoped.
- **PR 2 extends the frame into a semantic frame buffer**, adding `breakAfter` (hard/soft) and `selectable` metadata produced at the wrap/`render-node-to-output` stage and propagated through `Output.write` and the frame contract. This is the correct combination of the two rejected extremes: semantics come from the source/render node, final coordinates come from the compositor, so there is still no per-renderer wrapping duplication. It is a deeper (renderer semantic) change and is evaluated as such in its own PR.

The rejected alternative — an application-level per-renderer text model on stock Ink (map each history item's rendered subtree back to text) — is not pursued: it would duplicate Ink's wrap/clip/composite logic per renderer and drift as renderers change.

## Architecture (PR 1)

### Module layout

```
packages/cli/src/ui/selection/
  screen-buffer.ts        # Reads the exposed frame; getCellAt(col,row), lineCells(row), dimensions
  selection-state.ts      # anchor/focus model (virtual-row space), char/word/line modes, drag flag
  selection-text.ts       # cell range → plain text (skip wide-char spacers, trim trailing padding)
  use-text-selection.ts   # subscribes useMouseEvents; drives the state machine; copy-on-select
packages/cli/src/ui/contexts/
  SelectionContext.tsx     # broadcasts selection state + a "selection active" flag for key preemption
```

### Ink patch: a frame-buffer contract, not a raw array export

The audit showed a read-only `Output.get()` accessor plus a post-commit `onFrame` callback is insufficient: `Ink.onRender()` serializes the frame _before_ invoking the `onRender` option, so a post-commit hook can observe the previous frame but cannot highlight the current one, and writing selection back through React state risks an extra frame or a render loop. Highlighting must happen inside the render, before serialization, and re-render must be scheduled through Ink's own throttle.

The patch therefore defines a small bidirectional **frame controller**, reachable from the viewport via a handle on the root DOM node (Ink's `rootNode` is private and the public `Instance` has no frame API, so a dedicated bridge is required — a raw `ink/dom` export alone does not grant instance access):

```ts
type FrameController = {
  getFrame(): ReadonlyFrame | null;
  setSelection(selection: ScreenSelection | null): void;
  subscribe(listener: (frame: ReadonlyFrame) => void): () => void;
};
```

- `getFrame()` returns an **immutable snapshot** of the latest composited frame (dimensions + cells) for coordinate queries.
- `setSelection()` stores the selection range/theme, **deduplicates** (no-op if unchanged), and schedules **exactly one** repaint via Ink's throttled render invalidation — never by mutating committed frame state.
- On the next render, between compositing (`output.ts`) and serialization, cells inside the selection get their background overridden with the theme selection color (foreground preserved). This transform **allocates new cell/style arrays** and does not mutate in place: `OutputCaches` reuses `StyledChar[]` across identical strings, so an in-place edit would leak the highlight onto other on-screen occurrences of the same text. The published snapshot is read-only.

The patch is kept minimal and guarded by a test asserting the frame shape, so an Ink upgrade that changes `Output.get()` fails loudly. Upstreaming the hook is a follow-up.

### Event, coordinate, and arbitration pipeline

```
SGR bytes ─(KeypressContext reassembly)→ MouseEvent{ action, col, row, shift, meta }
  left press (in history viewport, not scrollbar) → startSelection(anchor)
  left move while pressed                          → extendSelection(focus)
  left release                                     → finishSelection → copy-on-select
  double / triple click                            → selectWordAt / selectLineAt (≈500ms, 1-cell threshold)
```

Coordinate mapping assumes Ink clears and homes the alternate screen before the first frame. A fitting frame is therefore top-anchored, while an overflowing frame is bottom-pinned with a negative `frameAnchor()`:

```text
layoutRow   = terminalRow - 1 - frameAnchor
viewportRow = layoutRow - viewportRect.y      # viewportRect from viewport/root Yoga ref; not assumed 0
virtualRow  = scrollTop + viewportRow
```

Before starting a selection, hit-test that `(col, layoutRow)` lies inside the history viewport content region and not in the scrollbar column, composer, or footer; presses elsewhere fall through to the existing scrollbar-drag / click-to-focus handlers. This arbitration is the contract between the new selection subscriber and the existing mouse subscribers.

Anchors are stored in **virtual-row space** so a selection stays pinned to content, but in PR 1 any non-selection scroll/resize/streaming clears the selection (off-screen content is not cached), so virtual-row anchoring here is just consistent bookkeeping, not cross-screen persistence.

### Copy

Copy reuses `copyToClipboard()` (pbcopy / xclip → xsel / clip, falling back to `writeOsc52()` for remote, wrapped for tmux/screen). `writeOsc52()` skips entirely and returns false when the payload exceeds ~75 KB (`MAX_OSC52_BYTES`); it does not truncate. The selection controller records clipboard failures in the debug log. User-facing failure feedback and manual copy are follow-up work.

### Settings

No separate setting is added. Selection is part of the virtualized-history
viewport and is active whenever `ui.useTerminalBuffer` is enabled.

## Wide characters and visual text (PR 1)

- **Wide characters.** The frame marks wide cells with `fullWidth` and represents the trailing half as a spacer; `selection-text.ts` emits the wide character once and skips the spacer. Right-half clicks snap to the whole glyph, reusing the mid-cell snap logic in `visualClickToOffset`.
- **Visual lines.** PR 1 copies exactly what is displayed: a soft-wrapped logical line copies as multiple visual lines, and gutter/decoration cells are included. Faithful logical text (rejoin, exclusion) is PR 2.
- **Trailing padding.** Per-line trailing spaces padding to the frame width are trimmed.

## Follow-up: semantic copy fidelity (PR 2)

To rejoin soft wraps and exclude decorations without per-renderer serialization, semantics are produced wherever wrapping still has source context and propagated through compositing. A break is a boundary between visual rows, not a property of an arbitrary character cell:

```ts
type SemanticFrameCell = FrameCell & {
  selectable: boolean;
  flowId: number | null;
};

type RowBoundary = {
  kind: 'soft' | 'hard';
  flowId: number;
  selectable: boolean;
  joiner: string;
};

type SemanticFrame = {
  cells: ReadonlyArray<ReadonlyArray<SemanticFrameCell>>;
  // boundaries[y][x] describes the transition from row y to row y + 1
  boundaries: ReadonlyArray<ReadonlyArray<RowBoundary | null>>;
};
```

- A `flowId` identifies one logical text flow within a frame. Direct `Text` node identity and opaque flow keys supplied by pre-Ink producers are mapped through one per-render allocator, so the numeric IDs cannot collide. A producer gives every visual fragment of its logical row the same key. IDs only need to survive one published frame because PR 1 already invalidates selection when content changes.
- `boundaries[y][x]` is a compositor-aligned boundary grid. A writer paints a boundary over its horizontal layout interval, independently of whether that row emitted a character. A zero-width empty flow claims one slot at its clamped layout X coordinate. This represents empty and whitespace-only hard lines without inventing an owner cell.
- Ink emits `soft` when its own width wrapping continues a flow and `hard` for an explicit source newline. A visual row assembled from sibling `Text` nodes has no implicit boundary claim.
- `joiner` is the exact plain-text source separator omitted at that boundary. A character-level wrap uses `''`; a word wrap that removes one space, several spaces, or a tab stores that exact substring. A separator still represented by selectable source cells is not duplicated in `joiner`. Hard boundaries normalize CRLF to `joiner: '\n'`.
- `selectable` defaults to `true`. A `selectable={false}` `Text` subtree marks both its cells and boundary claims false; the renderer never guesses from glyph, column, or style.
- Clipping trims boundary intervals using the same clip rectangle as cells. Every later overlapping write paints either its boundary or an explicit `null` over its covered columns, so stale claims cannot survive underneath the final composition. A clipped character cannot erase a still-visible row boundary because the boundary is stored independently.

Selection extraction remains conservative. It skips non-selectable cells and boundary claims. For each selected visual-row transition it finds the selectable flows represented by selected source cells on both sides, then considers the non-null boundary claims for those flows; null slots outside a flow's painted interval are irrelevant. It replaces the visual newline with `joiner` only when there is one common flow and all of its claims agree on `soft` and the same joiner. A `hard` claim emits `\n`; no common flow, a missing claim for a common flow, multiple common flows, or conflicting kind/joiner claims retain one visual newline. The joiner is emitted only when the selection includes source content on both sides, so starting or ending on a continuation row does not pull in an unselected separator. Consecutive empty hard rows occupy distinct grid transitions and therefore preserve every newline.

Source whitespace remains selectable content even when it occupies a whitespace-only visual row. The extractor no longer calls `trimEnd()` on semantic rows; it drops only cells explicitly marked non-selectable by the renderer. Ink layout padding and `MaxSizedBox` continuation-gutter padding are non-selectable, while table padding remains selectable under the table product rule below. This prevents fidelity metadata from preserving terminal layout spaces or discarding real trailing spaces.

### Pre-Ink wrap producers

Some application renderers destroy hard/soft information before `render-node-to-output`, so S0 includes them explicitly:

| Producer                            | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MaxSizedBox`                       | Its internal line model becomes `{segments, flowKey, breakAfter, joiner}`. Splitting an input `\n` or moving between input row `Box` elements emits `hard` with `joiner: '\n'`; character wrapping emits `soft` with `joiner: ''`; a whitespace token discarded or relocated by word wrapping becomes the exact soft joiner. All fragments of that input row keep one flow key. Synthesized continuation-gutter padding is non-selectable. |
| `CodeColorizer` and `DiffRenderer`  | Their source-line `Box` boundaries remain hard through `MaxSizedBox`; width continuations are soft. Code/diff line-number segments opt out, while content and diff markers remain in the row's selectable flow.                                                                                                                                                                                                                            |
| `ToolMessage.sliceTextForMaxHeight` | It returns semantic visual-line descriptors instead of a newline-joined string, preserving whether each retained transition came from source `\n` or width slicing and preserving any omitted separator as `joiner`. `MaxSizedBox` consumes those descriptors without reclassifying them.                                                                                                                                                  |
| `AnsiOutput`                        | Each input `AnsiLine` is a real tool-output row and stays hard. ANSI token boundaries remain cells in that row, and `MaxSizedBox` truncation does not create a soft claim.                                                                                                                                                                                                                                                                 |
| `TableRenderer`                     | Table copy intentionally preserves the displayed plain-text table. Its pre-rendered newline-joined rows are treated as hard visual boundaries, including cell wrapping; it does not claim soft continuations in this PR.                                                                                                                                                                                                                   |
| Ink `Text` wrapping                 | The patched wrap helper returns semantic line descriptors while it tokenizes source text, rather than diffing the final wrapped string. It records exact omitted whitespace in `joiner`, leaves joiner empty when whitespace remains in source cells, and marks padding added after wrapping non-selectable.                                                                                                                               |

Any new pre-Ink wrapper must either return the same semantic line descriptors or explicitly preserve its generated rows as hard visual boundaries. Inferring semantics later from rendered width remains forbidden.

The remaining width helpers are not hidden producers for this contract. `CompactToolGroupDisplay` and `ToolConfirmationMessage` use `wrapAnsi` only to estimate height; Ink still performs their visible wrapping. The collapsed streaming Thought preview produced by `tailVisualLines` is deliberately visual-only because it is a lossy tail window and streaming already invalidates selection; its generated rows remain hard. `sliceTextByVisualHeight` currently has no production caller.

The copy rules are deliberately narrow:

| Surface                             | Rule    | Reason                                                                                                |
| ----------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| VP scrollbar                        | Exclude | Navigation chrome, never conversation content.                                                        |
| Ink and continuation layout padding | Exclude | Renderer-inserted spacing is not source text; source whitespace remains selectable.                   |
| Code and diff line-number gutters   | Exclude | Positional display aids; copied code and patches should not gain synthetic line numbers.              |
| Diff `+` / `-` markers              | Keep    | They are required to copy a usable patch.                                                             |
| Markdown list and quote markers     | Keep    | They carry Markdown meaning.                                                                          |
| Table borders, padding, and rows    | Keep    | This PR preserves the displayed plain-text table; structured cell export would be a separate feature. |
| Tool prefixes and status glyphs     | Keep    | They identify the displayed output; no existing category has a confirmed non-content rule.            |

No other renderer may opt out cells in this PR without adding a product rule and a copy snapshot here. This prevents style-based heuristics from silently dropping user content.

### PR 2 milestones

- **S0 — semantic line contract.** Add the independent boundary grid with exact joiners and preserve it through direct Ink wrapping, `MaxSizedBox`, `Output.write`, clipping, overlap, and the published frame. Prove exact-width and empty hard newlines, whitespace-only rows, single/multiple-space and tab joiners, ANSI, CJK/emoji, clipped boundaries, and sibling conflicts.
- **S1 — Semantic extraction.** Replace unambiguous soft visual breaks with their joiner, retain hard/ambiguous newlines, preserve source whitespace, skip non-selectable layout cells, and keep PR 1 highlight behavior unchanged.
- **S2 — Confirmed exclusions and producer coverage.** Mark the VP scrollbar, synthesized continuation padding, and code/diff line-number gutters `selectable={false}`. Add direct `MaxSizedBox` code/diff/tool/ANSI fixtures plus Before/After fixtures for table and Markdown output.
- **S3 — E2E and compatibility.** Verify real terminal/tmux clipboard payloads and run the existing VP selection regression set.

## Edge cases and risks

| Item                      | Risk                                                 | Mitigation                                                                      |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Highlight timing          | Post-commit hook can't highlight current frame       | Bidirectional `FrameController`; pre-serialization transform; throttled repaint |
| Shared `StyledChar` reuse | In-place highlight leaks to identical on-screen text | Transform allocates new cell/style arrays; publish immutable snapshot           |
| Render loop               | Selection→state→render feedback                      | `setSelection` dedups and schedules exactly one repaint via Ink throttle        |
| Scroll/frame offset drift | `frameAnchor` bottom-pin, non-zero `viewportRect.y`  | Corrected formula; reuse `layoutRowForEvent`; integration tests per scroll pos  |
| Mouse arbitration         | Scrollbar/composer/footer press starts selection     | Hit-test viewport content region; fall through otherwise                        |
| OSC 52 size cap           | Oversized remote payload is not copied               | Existing API rejects; selection controller writes the failure to the debug log  |
| Ink patch maintenance     | Upgrades must re-apply; internal API drift           | Minimal patch; frame-shape guard test; pursue upstream                          |
| Performance               | Large history + per-drag repaint                     | Highlight is one immutable transform; repaint bounded by Ink `maxFps` (~30)     |
| Non-VP mode               | Enabling ownership would hijack native selection     | Strictly VP-gated                                                               |
| Streaming under selection | Content shifts beneath a selection                   | PR 1: clear on scroll/resize/streaming (visible-region only)                    |
| Pre-Ink wrapping          | App renderers erase source break semantics           | Semantic line descriptors in `MaxSizedBox`; table rows explicitly stay visual   |
| Boundary ambiguity        | Empty, clipped, or sibling rows have no owner cell   | Independent boundary grid; only unambiguous single-flow soft boundaries rejoin  |
| Separator loss            | Wrapping drops or relocates spaces and tabs          | Exact soft-boundary joiner; source whitespace distinguished from layout padding |

## Milestones

PR 1 (#6937, merged) — each milestone was a separate, reviewable commit with no semantic-fidelity work mixed in:

- **M0 — Ink frame-buffer foundation (go/no-go).** The `FrameController` (getFrame/setSelection/subscribe), the pre-serialization immutable highlight transform, and throttled invalidation, with a minimal real consumer. This is the feasibility gate.
- **M1 — Selection state machine + coordinate mapping (visible region).** press/drag/release → visual-cell range → `getSelectedText` → copy. No highlight yet.
- **M2 — Highlight** via `setSelection`.
- **M3 — Copy interaction.** Copy-on-select through the existing clipboard utility.
- **M4 — Word/visual-line selection + settings + invalidation + docs.**

PR 2 (follow-up) — semantic copy fidelity, as described above.

## Merge gate (PR 1)

- First highlight frame after press has no one-frame lag; selection updates never form a render loop.
- The same string appearing at multiple screen positions highlights only the target cell (no shared `StyledChar` pollution).
- CJK/emoji left/right half-cell boundaries are correct.
- Coordinates are correct for short, full-screen, and overflow frames, and when other UI sits above/below the viewport.
- Scrollbar, composer, and footer never start history selection.
- Double/triple click and forward/backward drag are stable within the visible region.
- Clipboard failures are recorded in the debug log; no success message is shown.
- Static mode and non-VP mouse behavior show no regression.
- Repaint frequency respects Ink's default `maxFps` (~30, ~33 ms); the throttle is Ink's, not an app-side 16 ms timer.
- Real terminal/tmux E2E covers drag-select, highlight, and clipboard payload.

## Merge gate (PR 2)

- Soft wraps and explicit newlines—including exact-width, empty, and whitespace-only lines—remain distinguishable.
- ANSI, CJK/emoji, and multiple sibling `Text` nodes on one visual row do not leak flow, break, or selectability metadata.
- Clipping and overlap publish final visible cell metadata and independently composited boundary slots; clipping a cell never drops a still-visible boundary.
- Conflicting sibling flows conservatively retain a visual newline; only an unambiguous single-flow soft boundary is rejoined.
- Direct Ink and `MaxSizedBox` fixtures preserve one space, multiple spaces, and tabs across word wrapping, emit no duplicate when whitespace remains in cells, and add no joiner outside the selected endpoints.
- `MaxSizedBox` directly proves hard/soft boundaries and non-selectable continuation padding, and code, diff, tool, and ANSI consumers each have an integration fixture.
- Every `selectable={false}` site matches a product rule above and has a copy snapshot.
- Diff, table, Markdown, and tool output have Before/After extraction fixtures.
- Existing PR 1 highlighting, invalidation, copy, and repaint-frequency tests remain green.

## Testing strategy

- **Unit** — PR 1 coordinate/mouse coverage plus semantic extraction over exact-width, empty, whitespace-only, joiner, endpoint, clipped, overlapping, and conflicting-flow boundaries.
- **Producer fixtures** — direct `MaxSizedBox` wrapping plus code, diff, tool, ANSI, Markdown, and table Before/After copy snapshots.
- **Patch guard** — asserts the exposed cell and boundary grids, direct Ink hard/soft wrapping, and compositing behavior so an Ink upgrade breaks loudly.
- **E2E** — interactive tmux harness: drag-select across wrapped visual lines and multiple items, confirm clipboard/OSC 52 payload. Follows the `.qwen/e2e-tests/` workflow.

## Rollout

The feature is VP-only, and VP mode is itself opt-in (`ui.useTerminalBuffer` defaults off), so the blast radius is limited to users who have already opted into VP mode. Holding Shift/Option while dragging remains the terminal-dependent native-selection fallback.

## Open questions

- Is the semantic-frame extension acceptable to maintainers? PR 2 changes both the Ink patch and the application-level pre-wrap contract and should be evaluated at that risk level.
- Should cross-screen selection be pursued after semantic fidelity proves stable? It needs a separate virtual-document design and is not part of PR 2.
