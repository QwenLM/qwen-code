# OpenTUI Migration — Design and Architecture

Tracking: [#8662](https://github.com/QwenLM/qwen-code/issues/8662). Status
2026-09-01: Phase 1 in progress; five of the seven batches are on main (infra,
foundation modules, live-session & input, dialogs & commands, backend
composition root). Renderer activation is the next batch.

## Goal

Replace the ink-based TUI renderer with an OpenTUI-based one without any
user-visible regression, landing the implementation on main in reviewable
batches. OpenTUI stays opt-in (`QWEN_TUI_RENDERER=opentui`) and ink remains
the default renderer for all of Phase 1; the default flip and the ink
removal are separate, explicitly gated phases.

## Why migrate

The current TUI is ink 7 + React 19 behind a ~1037-line renderer patch and a
hand-rolled virtual viewport (~920 lines). Three structural problems are not
fixable inside ink:

- **Flicker.** ink's write pattern is erase-then-full-rewrite every frame.
  Measured on real terminals (Warp, Tabby, Windows PowerShell), including
  with ink's `incrementalRendering` enabled: the erase-then-write structure
  remains, so the flicker class remains.
- **Mouse is second-class.** Selection/copy and click interactions lag a
  native terminal; the virtual-viewport mouse path has known parity gaps.
- **Maintenance ceiling.** The ink patch and the virtualized list block
  rendering improvements; #6137, #8580 and #8659 were all filed against the
  already-patched build, which is the most direct evidence that the
  incremental path has plateaued.

A source-level study of five terminal UIs with byte-level PTY comparison
shows OpenTUI's renderer (Zig native core: row-memcmp fast path, cell-level
diff, run coalescing, zero erase sequences, DEC 2026 synchronized output)
eliminates the flicker class by construction. A local proof-of-concept
measured **0 erase sequences vs ink's ~749 per 6 seconds** and no flicker on
the terminals that reported it. A replay harness on a real 141-event session
confirmed the delta: ink emitted 16 full-screen clears and 67 line erases;
OpenTUI emitted zero.

## Key decisions

1. **Full replacement over incremental patching** — the ink patch has hit its
   ceiling (evidence above), so the target is a renderer swap, not more
   patching. Approved by the maintainers for Phase 1 on 2026-08-26.
2. **OpenTUI + React track** — the `@opentui/react` binding. The Solid track
   (`@opentui/solid`) is deferred indefinitely; both tracks would double the
   surface for one user-visible outcome.
3. **1:1 parity as the acceptance bar** — the goal is "exactly the product,
   new renderer", not a redesign. Every behavior difference must be a
   documented, tracked decision (see "Accepted trade-offs"), never an
   accident.
4. **Batched, additive-only landing** — seven batches in dependency order,
   each a self-contained PR with its own acceptance criteria. Until the
   renderer-activation batch, no batch touches a reachable ink code path.
5. **A machine-checked dependency direction** — the renderer is an
   outer layer; the business core stays framework-neutral, enforced by a CI
   gate rather than by convention (below).

## Architecture

### Dependency direction

The migration's central invariant: **framework dependencies point inward to
the renderer, never outward into the core.** Two rules, enforced by
`scripts/check-tui-dep-direction.mjs` in CI:

- **Rule 1 — `packages/core/src` is framework-neutral.** No imports of ink,
  react, solid, or `@opentui/*` (as whole ecosystems, including scoped
  variants), and nothing that reaches into `packages/cli` — neither relative
  paths nor the cli package's own bare name, which resolves through the
  workspace symlink.
- **Rule 2 — `packages/cli/src/ui/model` is framework-neutral streaming
  state.** The same family ban, plus self-containment: no relative import
  may resolve outside the directory, so no framework-dependent sibling can
  leak in through a relative path.

The gate is fail-closed by construction: any symlink under a rule root or in
a rule root's path, any unlistable directory, any skipped-directory name
(`node_modules`/`dist`/`.git`), and an empty root all fail it instead of
silently shrinking the scan. Detection is AST-based (TypeScript compiler),
covering static and dynamic imports, the CommonJS and vitest loading forms,
import-type queries, import-equals, ambient module declarations, and
resolution probes, so comments, strings, and interpolated templates can
neither mask nor fake an import.

### Layering

```
                    ┌───────────────────────────────┐
                    │  entry / startInteractiveUI   │
                    │  renderer dispatch + runtime  │
                    │  gate (Bun, or Node + ffi)    │
                    └──────────┬─────────┬──────────┘
                     default   │         │  QWEN_TUI_RENDERER=opentui
                    ┌──────────▼──┐   ┌──▼─────────────────────────┐
                    │ ink renderer│   │ OpenTUI backend            │
                    │ (patched)   │   │ app shell · dialogs ·      │
                    │             │   │ composer · event adapter   │
                    └──────┬──────┘   └──────────┬─────────────────┘
                           │                     │
                    ┌──────▼─────────────────────▼─────────────────┐
                    │ framework-neutral streaming model            │
                    │ packages/cli/src/ui/model — pure reducer:    │
                    │ stream events → history items (immutable)    │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │ packages/core — business core, no framework  │
                    └──────────────────────────────────────────────┘
```

The pieces, in landing order:

- **Streaming model** (landed, infra batch). A pure, immutable reducer that
  folds live stream events (user, thinking, text, tool/task lifecycle, done)
  into ordered history items; the `task-end` fold also derives each task's
  stats line as an output field on the history item (there is no separate
  `stats` input event). Both renderers consume the same fold,
  which is what keeps their transcripts structurally identical; the ink-side
  wiring lands with the batch that carries its consumers. The model replaces
  nothing in ink today — it is additive, and its contract is pinned by an
  immutability test matrix (no state or item reachable from an earlier fold
  result may ever change).
- **Foundation modules** (landed, #10146). The renderer-agnostic services the
  later batches build on: the theme family, accessibility (plain-text
  transcript projection + screen-reader path), clipboard (OSC 52 with
  multiplexer handling plus platform fallback), key-map, mouse hit-testing
  and caret placement, link detection/OSC 8, early-input handling, exit
  guard/lifecycle, kitty keyboard negotiation, the event adapter (session
  events → display payloads), item projection (history items → text for
  a11y/clipboard), slash-command dispatch into the existing command
  registry, and the dialog scaffolding with the theme dialog as its first
  consumer.
- **Live-session & input** (landed, #10368). Live-session stream fold
  wiring, message rendering, transcript adapter with
  resume/session-switch, sticky todos, the composer, mouse
  rows/scrollbar/selection with multi-click select, diff rendering, session
  compaction.
- **Dialogs & commands** (landed, #10383). The dialog family and dialog
  data, the folder-trust gate, session rewind, the slash-command
  registry/dispatch surface, the help overlay.
- **Backend composition root** (landed, #10696). The OpenTUI app shell:
  command bridge, dialog mount, error boundary, runtime sidecar. It is a
  thin assembly, not a copy of `AppContainer`: the transcript view, model
  turn, session re-key and composer control stay explicit seams for the
  activation batch to own.
- **Renderer activation** (next). Renderer dispatch plus the runtime gate
  and the entry wiring into `startInteractiveUI`; small shared exports and
  runtime fixes. **Default renderer stays ink.** OpenTUI becomes reachable
  only through the flag.
- **Build & CI.** Bundle asset pipeline for the OpenTUI runtime assets, the
  CI legs (e2e, tui-parity), renderer-matrix integration tests, and the
  parity tooling (codemod, PTY harness).

### Renderer selection and runtime gate

Selection is environment-driven, not config-file-driven:
`QWEN_TUI_RENDERER=opentui` opts in; anything else (or unset) is ink. The
activation batch additionally gates on the runtime: OpenTUI's native core
loads under Bun and under Node with `node:ffi`; where neither holds, the
dispatcher falls back to ink silently. npm remains the primary install path,
so plain-Node loadability is a Phase 3 gate (below), not an assumption.

## Rollout phases and gates

1. **Land the code** (current) — the seven batches above. Additive-only; ink
   untouched; each PR lands on its own review merits.
2. **Real-device validation** — flag-driven use on real terminals. Preview
   builds are published for hands-on testing; confirmed parity gaps are
   tracked in the tracking issue and must be closed before the flip:
   - G-1 first-run auth onboarding dialog auto-open
   - G-2 follow-up prompt suggestions (composer ghost text)
   - G-3 persistent update-notification bar
3. **Flip the default** — a small PR switches the default renderer after all
   of:
   - G-1 through G-3 closed;
   - real-device validation on the terminals the original flicker reports
     came from — Windows PowerShell, web-based terminals, tmux < 3.5 — not
     only the ones already tested (Warp/Tabby/macOS);
   - the renderer demonstrated loadable under plain Node (`node:ffi`): boot
     plus smoke, not assumed. Bun-only is not acceptable as the default;
   - explicit drop / replace / defer-with-tracking-issue decisions for the
     degraded modes: legacy scrollback mode, iTerm2 inline images,
     screen-reader support.
4. **Remove ink** — delete the ink renderer, the ink patch, and the
   virtualized-list/viewport mode once OpenTUI is the stable default.

## Verification strategy

- **The PTY harness is the shared acceptance instrument.** Both renderers
  are exercised through the same terminal-level harness; flicker metrics
  (erase counts, full-screen clears, frame patterns) are the objective
  measure. An ink baseline on current main is recorded so every later phase
  is measured against numbers, not anecdote (#10005 tracks the metrics
  library, runner scenarios, and fixtures).
- **Per-batch acceptance criteria** (each landing PR): build and typecheck
  clean across workspaces; ESLint + Prettier clean; the full `packages/cli`
  vitest suite green; the default (ink) path byte-for-byte unchanged —
  batches that add flag-gated code touch zero reachable ink code paths. The
  activation batch additionally smoke-tests the flag under Bun (boot,
  dialog, live turn, exit drain); the build/CI batch runs the OpenTUI e2e
  leg green on CI.
- **1:1 parity audits** — screen-by-screen comparison against ink, plus a
  reverse audit pass, with surviving differences landing as tracked gaps
  (G-series) rather than silent drift.

## Accepted trade-offs (documented, unchanged)

- mermaid degrades to a code block for now;
- legacy terminal-scrollback mode dropped (single scrollbox);
- iTerm2 inline images not supported (kitty/sixel/blocks only);
- screen-reader support to be evaluated before the default flip.

## Deferred items (tracked, land with their batches)

- The `remend` dependency — deferred from the infra batch; lands with the
  first batch that carries its consumer.
- Ink-side wiring of the streaming model — lands with the batch that carries
  the ink consumers.
- ESLint rules for OpenTUI JSX — deferred from the infra batch to the
  foundation-modules batch, the first batch carrying OpenTUI JSX sources.
- Composition-root callback identity (#8662 U-8) — the shell memoizes its
  host and dispatcher effect on the callback props it is given, so the
  activation batch must pass stable identities at the mount site; no mount
  site existed to fix this in the composition-root batch.
- Settings sub-dialog routing and composer ownership (#8662 U-9) — deferred
  from the composition-root batch: the dialog mount has no channel to switch
  to a sub-dialog and the composer belongs to the entry layer, so those
  settings rows and the arena picker report an unwired seam instead of
  acting.
- Gate hardening noted in the infra PR's second review round: JSX implicit
  runtime imports, triple-slash/JSDoc type references, UTF-16 sources, and
  tsconfig `baseUrl` bare-specifier resolution.
- Track-2 (`@opentui/solid`) and the original proposal's M4 A/B evaluation
  remain deferred.

## Related PRs

| Batch                                               | PR                                       |
| --------------------------------------------------- | ---------------------------------------- |
| Infra                                               | #10134 (merged)                          |
| Foundation modules                                  | #10146 (merged)                          |
| Live-session & input                                | #10368 (merged)                          |
| Dialogs & commands                                  | #10383 (merged)                          |
| Backend composition root                            | #10696 (merged)                          |
| Renderer activation                                 | next batch                               |
| OpenTUI runtime npm packaging                       | #9885 (rebases after the build/CI batch) |
| Original implementation (superseded by the batches) | #8677 (draft)                            |
