# OpenTUI Migration — Design and Architecture

Tracking: [#8662](https://github.com/QwenLM/qwen-code/issues/8662). Status
2026-09-01: Phase 1 in progress; five of the seven batches are on main (infra,
foundation modules, live-session & input, dialogs & commands, backend
composition root). Renderer activation is the next batch.

## Goal

Replace the ink-based TUI renderer with an OpenTUI-based one without any
user-visible regression, landing the implementation on main in reviewable
batches. OpenTUI is opt-in (`QWEN_TUI_RENDERER=opentui`) and ink remains
the default renderer for all of Phase 1; the default flip and the ink
removal are separate, explicitly gated phases. That opt-in is not a switch a
user can pull yet: the variable appears in no code until the activation
batch adds it, so every batch before it is inert because nothing imports it
— not because a gate routes around it.

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
  and the entry wiring into `startInteractiveUI`, and small shared exports.
  **Default renderer stays ink.** OpenTUI becomes reachable only through the
  flag. This is where the composition root's seams get their owners, so the
  contracts below become load-bearing here: the mount passes stable callback
  identities (#8662 U-8), the confirmation stub becomes a real dialog rather
  than keeping its denial, and the boundary is mounted the way ink mounts its
  own (#8662 U-10). The runtime fixes this batch used to carry — the Bun
  memory flags and the goal-runtime startup wait — landed early in #10128.
- **Build & CI.** Bundle asset pipeline for the OpenTUI runtime assets, the
  tui-parity CI gate, renderer-matrix integration tests and the env pinning
  the e2e legs carry, and the parity tooling (codemod, PTY harness).

### Renderer selection and runtime gate

Selection is environment-driven, not config-file-driven:
`QWEN_TUI_RENDERER=opentui` opts in; anything else (or unset) is ink. None of
that exists yet — the env read, the dispatcher and the fallback are all
delivered by the activation batch, which is the first code to name the
variable. The activation batch additionally gates on the runtime: OpenTUI's
native core loads under Bun and under Node with `node:ffi`; where neither
holds, the dispatcher falls back to ink silently. npm remains the primary
install path, so plain-Node loadability is a Phase 3 gate (below), not an
assumption.

Measured status of that assumption: `@opentui/core` 0.5.8 — the version
pinned in `packages/cli` — selects its FFI backend with `require('node:ffi')`,
and that specifier does not resolve on Node 24 (`ERR_UNKNOWN_BUILTIN_MODULE`;
reported on 24.18.1 during the dialogs-and-commands review and reproduced
locally on 24.15). The native renderer therefore initialises under **Bun
only**, today. Two consequences: the silent ink fallback above is
load-bearing rather than defensive, and the activation batch is runnable
end-to-end only under Bun until the Node leg is proven.

### Composition-root contracts

Settled while reviewing #10696. They are what keeps a deliberately thin root
safe to run before its owners exist, and the activation batch inherits them:

1. **A seam may be unwired, never parked.** Every confirmation or resolution
   the root owns must settle unconditionally — the stub bridge denies
   outright, and denies again if the bridge itself rejects. A resolver left
   in a slot nothing reads is not a missing feature: the slash gateway's
   busy flag never clears, so every later command is refused until restart.
2. **No silent no-op for an action the user took.** Where the owner does not
   exist yet, the root reports through the visible notice channel instead of
   an empty arrow, so the missing owner is named rather than the input
   vanishing.
3. **Seams carry structured data, not invented formats.** Pasted image paths
   travel beside the prompt text as their own argument; constructing the
   image part belongs to the entry layer. Folded into the text, the entry
   would have to reverse a private encoding.
4. **Isolate caller-owned steps inside another layer's commit window.**
   `/resume` and `/branch` set their commit flag only after the last UI step
   returns, so one throwing subscriber rolled core back to the previous
   session and deleted the fork just shown. Each step now runs isolated.
5. **Callback identity at the mount is a contract, not a perf note.** The
   host memo and dispatcher effect key on the callbacks they are given, so
   the mount site must pass stable refs (U-8) — inline callbacks would
   rebuild the host and re-run the interactive command loader per render.

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
     plus smoke, not assumed. Bun-only is not acceptable as the default — and
     Bun-only is where 0.5.8 stands today (measured status above), so this
     gate is open, not merely unproven;
   - explicit drop / replace / defer-with-tracking-issue decisions for the
     degraded modes: legacy scrollback mode, iTerm2 inline images,
     screen-reader support.
4. **Remove ink** — delete the ink renderer, the ink patch, and the
   virtualized-list/viewport mode once OpenTUI is the stable default.

## Verification strategy

- **The PTY harness is the intended shared acceptance instrument — and does
  not exist yet.** The plan is for both renderers to be exercised through the
  same terminal-level harness, with flicker metrics (erase counts,
  full-screen clears, frame patterns) as the objective measure and an ink
  baseline on current main so every later phase is measured against numbers,
  not anecdote. That is #10005, still open: no metrics library, runner, or
  recorded baseline is in the tree, `scripts/` carries only the
  dependency-direction gate, and no test drives ink's test renderer. Until it
  lands, flicker claims rest on the one-off PTY measurements cited above.
- **Per-batch acceptance criteria** (each landing PR): build and typecheck
  clean across workspaces; ESLint + Prettier clean; the full `packages/cli`
  vitest suite green; the default (ink) path byte-for-byte unchanged — the
  batches landed so far touch zero reachable ink code paths because nothing
  outside `src/ui/opentui/` imports them. The activation batch additionally
  smoke-tests the flag under Bun (boot, dialog, live turn, exit drain). The
  build/CI batch wired the renderer matrix into the existing e2e legs and
  added the tui-parity gate; its own OpenTUI interactive e2e leg ran on
  `main`, reported three real gaps (approval-mode indicator never drawn,
  `@file` expansion absent, `submitted_prompt` dropped), and has since come
  out of CI until those close (#8662).
- **1:1 parity audits** — screen-by-screen comparison against ink, plus a
  reverse audit pass, with surviving differences landing as tracked gaps
  (G-series) rather than silent drift.

### What the reviews kept finding

Recurring across the five landed batches, and the activation batch will draw
on the same classes:

- **An assertion outrunning the code.** A PR body, docblock, or test header
  claiming a mechanism that was not there — the `QWEN_TUI_RENDERER` opt-in, a
  "separate PTY gate" that no workflow or test implements, an image-path
  encoding no reader exists for. Grep the claim before writing it, again
  after every fix commit.
- **Tests that cannot fail.** In the dialogs-and-commands batch, tested logic
  killed 15/15 injected mutants while five untested modules survived 5/5 with
  the whole 927-test suite green, and one _tested_ dialog hook still carried
  a re-sync assertion that no change could turn red. Name-only dialog stubs
  did the same job in the composition-root batch, hiding three dead-end
  callbacks. A stub that records nothing asserts nothing.
- **Silent success at a seam.** Empty arrows, optional chains, and
  written-but-never-read slots, in both renderer and error paths. This is what
  the contracts section exists to forbid.
- **Untrusted text reaching the terminal.** Diff bodies, MCP output, and
  projections skipping the sanitiser — filed repeatedly in the foundation and
  live-session batches. The specific paths named there escape today, so read
  this as a class to re-check on every new projection, not an open hole.
- **Parity copies with no drift guard.** The same rule living twice, byte
  identical today, nothing asserting it stays that way — the migration's own
  failure mode, raised in the dialogs-and-commands review. It needs an
  assertion, not a comment.
- **Deferrals with no address.** Items acknowledged in a review thread as
  "valid, deferred" were never registered as an issue or a ledger row, so no
  later batch owns them. The migration's U-xx numbering covers #10696
  onward; the earlier test-hardening and dead-code deferrals still do not.

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
- Fatal render-error parity at the mount (#8662 U-10) — the composition root
  wraps its subtree in the boundary with no props, while ink's call site
  passes the exit-echo flag and an error hook that logs and schedules a
  graceful exit; nothing outside the boundary's own test reads the OpenTUI
  render-error store. Both ends live in the entry, so only the activation
  batch can wire and verify them.
- Gate hardening noted in the infra PR's second review round: JSX implicit
  runtime imports, triple-slash/JSDoc type references, UTF-16 sources, and
  tsconfig `baseUrl` bare-specifier resolution.
- Track-2 (`@opentui/solid`) and the original proposal's M4 A/B evaluation
  remain deferred.

## Related PRs

| Batch                                               | PR              |
| --------------------------------------------------- | --------------- |
| Infra                                               | #10134 (merged) |
| Foundation modules                                  | #10146 (merged) |
| Live-session & input                                | #10368 (merged) |
| Dialogs & commands                                  | #10383 (merged) |
| Backend composition root                            | #10696 (merged) |
| Renderer activation                                 | next batch      |
| OpenTUI runtime npm packaging (not a batch)         | #9885 (merged)  |
| These design notes (not a batch)                    | #10343 (merged) |
| Startup robustness: goal-runtime wait, Bun relaunch | #10128 (merged) |
| Original implementation (superseded by the batches) | #8677 (draft)   |
