# Screen-Mode Contracts: main-screen, owned viewport, screen-reader

> Status: accepted direction for the OpenTUI migration. This document freezes
> the product semantics of the three screen modes so that the Ink renderer and
> the OpenTUI renderer implement the same contracts instead of drifting into
> two parallel product UIs.

## Background

The OpenTUI migration branch currently carries **two independent
implementations of the product UI semantics**: the Ink renderer
(`AppContainer`, `DefaultAppLayout`, `useSlashCommandProcessor`, …) and the
OpenTUI backend (`backend.tsx`, `commands-dispatch.ts`, `live-model.ts`, …).
Every audit batch on PR #8677 has confirmed the same failure pattern: findings
are rarely about pixels — they are about one renderer deciding a semantic
question (who owns history, what a refresh means, when stdout may reach the
terminal) differently from the other. Two examples from the most recent batch:

- `refreshStatic` in Ink's `AppContainer` means _opposite things_ in legacy
  mode (clear and remount `<Static>`) and viewport mode (must not write the
  terminal at all); the branch is a Boolean inside one code path instead of
  two explicit contracts.
- The startup "Unknown command" race (fixed in 569d72fba6) existed in both
  renderers with the same root cause, but had to be found, fixed, and tested
  twice because the two command-registry loading chains do not share a
  contract about config initialization.

The lesson is architectural, not cosmetic: **stop encoding screen ownership as
conditional behavior inside one path, and start declaring it as one of three
explicit contracts.** This document defines those contracts, states what is
shared and what is deliberately not shared between renderers, and records the
sequencing constraints (Solid freeze, accessibility preservation) that the
migration must respect.

## The three contracts

### Contract M — main-screen (terminal-owned scrollback)

The terminal owns the scrollback buffer. The application **appends** logical
output and repaints only the trailing interactive region.

| Aspect            | Semantics                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| History owner     | The terminal. The app never scrolls, trims, or repaints history.                                   |
| Normal update     | Append-only for committed content; the live region is rewritten in place.                          |
| Resize            | The terminal reflows existing scrollback; the app lays out only the live region for the new width. |
| Exit              | Nothing to restore — the session was never in an alternate screen.                                 |
| Child stdout      | Passes through to the terminal scrollback, interleaved with app output.                            |
| Selection / mouse | Terminal-native selection over scrollback; app mouse events apply only to the live region.         |
| Carrier today     | Ink legacy mode (default when `ui.useTerminalBuffer` is off, or non-TTY fallbacks).                |

### Contract V — owned viewport (application-owned alternate screen)

The application enters the alternate screen (`?1049h`) and owns a logical
document plus a fixed-height viewport over it. The terminal scrollback is not
used while the session is live.

| Aspect            | Semantics                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| History owner     | The app. The logical document is the single source of truth; scroll position, follow-end, and truncation are app state.                                                      |
| Normal update     | App repaints the viewport from its logical document; commits are frame-atomic (synchronized output).                                                                         |
| Resize            | The app re-lays-out the logical document for the new width and repaints; logical content is preserved, never reflowed by the terminal.                                       |
| Exit              | On leaving the alternate screen the app writes the **complete logical document back to the main screen exactly once** — full and unique. This is the exit-history invariant. |
| Child stdout      | Intercepted and committed into the logical document as transcript content; raw bytes must not corrupt the viewport.                                                          |
| Selection / mouse | Hit-testing and selection geometry use the **committed frame** — the geometry the user is looking at — never in-flight layout.                                               |
| Carriers today    | Ink viewport mode (`ui.useTerminalBuffer` on, `AppContainer` VP branches); OpenTUI renderer (alternate screen / split-footer).                                               |

### Contract A — screen-reader / plain text (accessibility)

A line-oriented, non-positioned rendering for screen readers, `--screen-reader`
mode, and plain-text consumers. No alternate screen, no ANSI cursor
positioning, no mouse. Semantic order of announcements follows the logical
transcript, not visual layout.

| Aspect            | Semantics                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Carrier           | `ScreenReaderAppLayout` on the Ink renderer — currently the only accessibility-grade path.                                                                                                                                                  |
| Preservation rule | This path **must remain available regardless of which renderer is the default**. It is removed only if and when the OpenTUI renderer passes an accessibility gate of its own (announced structure, screen-reader smoke tests) — not before. |
| Shared semantics  | The logical document and its normalization are shared with Contract V; only the presentation differs.                                                                                                                                       |

## What is shared, what is not

Deliberately **not shared**: JSX, layout, rendering, animation, input binding.
Renderers keep their own component trees.

To be shared (the presentation model, extracted after 1:1 parity — see
Sequencing):

- message normalization and visibility/expansion state;
- thought and tool-card state machines;
- composer state and submit/attachment semantics;
- dialog state (open/close/resolve outcomes);
- slash-command dispatch and action semantics;
- streaming aggregation (the 60ms text-event batching exists in both
  renderers today — it is the canonical example of logic that should exist
  once);
- semantic snapshots for recording and exit-history replay.

Rule of thumb for every future parity fix and feature: first name the contract
(M / V / A) and the shared semantic; only then touch renderer code. A change
that needs a renderer-specific answer to a contract question is a smell.

## Sequencing constraints

1. **React 1:1 parity first, extraction second.** The shared presentation
   model is extracted from two implementations _proven equivalent_, not from
   two that are still converging. Extraction order follows observed drift
   density (highest-finding clusters first): streaming aggregation → dispatch
   and dialog state → item projection.
2. **Solid stays frozen** until the React renderer's parity is stable. The
   reconciler and the product state layer must not both change while parity
   verification depends on them.
3. **Contract A is not optional.** Renderer default changes do not remove the
   Ink screen-reader path.
4. **PR #8677 scope guard.** Contract work on that PR is documentation only;
   behavioral refactors land after it merges.

## Metrics (two-phase observability plan)

Phase 1 — collect, don't gate. Instrument the existing PTY smoke harness to
record per scenario:

- full-redraw counts and reasons;
- requested vs. rendered vs. coalesced/dropped frames per second;
- changed cells/rows and output bytes per frame;
- layout-storm signal: repaint bursts after resize, content shrink, overlay
  toggles;
- exit-history integrity: after quitting, the main screen holds the complete
  logical document exactly once (byte-level diff of scrollback capture);
- selection geometry sourced from the committed frame;
- memory and scroll latency at 10k/100k-message sessions.

Phase 2 — gate. Once baselines exist for both renderers, convert the metrics
above into CI gates on the smoke scenarios.

These metrics are what separate "does not visibly flicker today" from "the
rendering model is stable" — the flicker fixes (markdown heal + event
batching) shipped in 98c9b6bae7 currently have only visual verification.

## Source anchors

- Ink: `packages/cli/src/ui/startInteractiveUI.tsx` (mode selection),
  `AppContainer.tsx` (legacy/VP branching to be untangled against these
  contracts), `layouts/ScreenReaderAppLayout.tsx` (Contract A).
- OpenTUI: `packages/cli/src/ui/opentui/backend.tsx`, `start.tsx`,
  `runtime-gate.ts` (Contract V carrier), `live-model.ts` (future extraction
  target).
- Prior art analysis: `tui-research/reports/analysis/pi-tui-2026-refactor-comparison.md`
  (external audit recommending this contract split; Pi's `TuiMainScreen` /
  `TuiAltScreen` is the reference design for M/V separation).
