# OpenTUI status line configuration and rendering

[English](2026-10-21-opentui-statusline-parity.md) |
[简体中文](2026-10-21-opentui-statusline-parity.zh-CN.md)

Current delivery (2026-10-21): this work is consolidated with input ownership,
editing and status lines in [#14964](https://github.com/QwenLM/qwen-code/pull/14964).
The original batch boundaries, source bases, validation results and stack-promotion
steps below are historical. Follow the [delivery plan](2026-10-20-opentui-migration-delivery.md)
for the active sequence. Combined acceptance requires fresh results for the
integrated commit and is still pending.

## Status and source

Implemented on 2026-10-21. Local author validation passed: build/typecheck,
325 focused tests, 11 native scenarios, 7 PTY driver tests and six product
cases across Node+Ink, Bun+Ink and Bun+strict-OpenTUI. Independent macOS
acceptance also passed: eight candidate product cases, 11 native scenarios,
and two frozen Ink lifecycle controls. Slow commands, nonzero output,
removed settings and active-command cleanup were observed without retries.
Linux CI and Windows validation are pending.

The preparation branch starts at U1
`69ffa32d46a1283fb1f1dc224e105275c1ebe493` (#14933). Remote main was checked
again at `82bd240ad0d31fd1d3a83dd803625118019ba35d`. The relevant Ink
`Footer`, `StatusLineDialog`, `useStatusLine`, and `statusLinePresets`, and
the OpenTUI footer/status dialog have identical blobs at these revisions.

## Problem and complete delivery boundary

Ink runs preset or user-command status lines, refreshes their data, applies
the existing color/context policy, and supports selection, preview, and saving
through `/statusline`. OpenTUI currently builds a fixed footer string. Its
status dialog lists preset names without editing or saving them; the footer
explicitly omits user-supplied status lines.

Deliver configuration, persistence, rendering and regression evidence in one
approximately 3k-line PR. Keep OpenTUI 0.5.10, Bun 1.3.14, the existing settings
format and shell-command executor.

This batch does not close the entire footer inventory: voice, workflow,
background-shell focus, global transcript controls, and full Vim editing
remain with their owning batches. A Vim status payload must use the real U2C
mode owner before that field can be accepted; a hard-coded mode or the
presence of a setting is not evidence of an active Vim editor.

## Proposed implementation

### Reuse the existing execution lifecycle

Keep the `useStatusLine` context wrapper for Ink in `use-ink-status-line`.
Expose `useStatusLineState` around the existing runner. Extract only a
narrow state-driven hook boundary around the same implementation, allowing
OpenTUI to supply its actual settings, config, session metrics, model,
streaming state, branch/worktree, terminal width, and available Vim state.
Do not construct a fabricated full `UIState` or duplicate the command runner.

Preserve the existing 300ms state-change debounce, 5s command timeout, 10KiB
buffer limit, two-line output limit, periodic-refresh minimum and non-starving
refresh behavior, stale-result generation checks, child cleanup, stdin JSON,
and shell-sandbox prohibition. Keep setting reload on the transition to idle
and existing preset/GitHub-lookup behavior.

Every newly passed value must have a real producer and a read site. Obtain
metrics through the existing `SessionStatsProvider`; avoid a stale render-time
read of a ref-only getter. Reuse `useWorktreeSession` and `useGitBranchName`
for the same session and workspace semantics as Ink. Verify session switches
and model changes instead of assuming config mutation triggers a render.
The session model subscribes to `config.onModelChange`, so a temporary subagent
model override cannot replace it on an unrelated render. Both renderers refresh
command input when the session ID changes, even with equal metrics. Worktree
reads and watchers follow that session ID and ignore late reads from its predecessor.

### Configure and persist the same preset

Reuse the existing preset normalization, item order, data builder, and line
builder. Share the small dialog data operations when both renderers need them;
keep renderer-specific layout and keyboard handling local.

The OpenTUI dialog must provide selection, theme-color toggle, filtering when
height permits, preview, confirmation, and Escape cancellation. Match Ink's
effective setting scope: System, trusted Workspace, then User. Preserve the
existing `hideContextIndicator` value when saving and produce the same
feedback/recording event. A cancelled dialog must not write settings.

Use U1's bounded dialog layout and native selection primitives. At short
heights, keep every option reachable and confirmation/cancellation usable.
Do not introduce an independent settings cache or persistence mechanism.

### Render the result with the same policy

Replace only the fixed status-line portion of the OpenTUI footer with the
shared result. Preserve approval, shell, queue, and exit-warning priorities.
Match two-line clipping, narrow-width wrapping, theme colors, user ANSI color
policy, and context-indicator suppression/fallback. Use the public
`@alcalzone/ansi-tokenize` 0.3.0 API already locked for Ink, declared directly
for this consumer, to map styled runs into native `StyledText`. Preserve RGB,
indexed colors, attributes, resets, and OSC8 links; discard cursor-control
sequences. No private Ink renderer imports or parser framework are added.
The fallback context indicator uses Ink's percentage-only text and secondary
color, switching to the error color above the limit.

Command failures and unchanged output must behave like Ink. No new error
panel, public setting, subprocess framework, or runtime upgrade is proposed.

## Producers and consumers

| Value or operation                  | Producer → consumers                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Status settings and saved override  | Existing settings/dialog save → shared hook → both footers                           |
| Session metrics and identity        | Existing stats provider → shared status data and dialog preview                      |
| Model/reasoning and streaming state | Session model subscription, current reasoning and live turn → status payload/preset  |
| Branch and active worktree          | Existing workspace hooks → status payload/preset                                     |
| Vim state                           | U2C's actual mode owner → status payload; acceptance remains pending until connected |
| Command output and cleanup          | Existing shared execution hook → renderer-specific bounded text                      |
| Saved feedback                      | Existing history/recording seams → visible transcript and session record             |

Changes include `useStatusLine`, the two footers, status dialog/model
helpers, OpenTUI app/dialog plumbing, focused tests, and the existing TUI
acceptance workflow. No core/provider/service implementation change is planned.

## Baseline and regression plan

First dry-run the test protocol on the installed global CLI, recording its
actual version and executable. Then compare the same frozen source bundle
under Node+Ink, Bun+Ink, and Bun+strict-OpenTUI with an isolated HOME,
workspace, settings, and local deterministic model server.

The installed standalone 0.22.0/private Node 22.23.2 and frozen U2A bundle
`269600799782a5c507d62f3ae0db011c768be234` under Node 24.19.0 + Ink each
passed both baseline cases. Strict Bun 1.3.14 + OpenTUI failed both:
no command execution, and a static preset list without configuration.
Later usage/save/restart checks were not reached. Original failures and
fixture corrections remain recorded separately from candidate acceptance.

| Capability           | Required observation                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| Preset selection     | Same selected items/order, preview, persisted scope/value, reopen and restart          |
| Cancel and trust     | Escape writes nothing; untrusted workspace cannot become the selected save scope       |
| Command execution    | Real owned command receives exact JSON and emits identifiable output/colors            |
| Live updates         | Model/reasoning, usage, streaming/idle, resize, and setting reload use current data    |
| Refresh and failures | Slow/nonzero/missing command, removed command, stale output, and unmount cleanup       |
| Geometry and color   | Narrow/short terminal, two-line cap, CJK/emoji, ANSI cell colors, context fallback     |
| Integration          | Approval/shell/queue/exit priorities and existing Ink hook/dialog tests remain correct |

Use a real executable fixture and PTY for command and rendering observations.
Capture ANSI, cell attributes, command input/output, setting files before/after,
process identities, and cleanup. A mock executor or string snapshot alone
cannot establish real execution, ANSI policy, or process cleanup.
All three RGB comparison legs declare `COLORTERM=truecolor`. Without that
declaration, the first OpenTUI run emitted indexed color 161 for the fixture's
RGB output; that observation is retained, and the exact RGB assertion is unchanged.

Run build/typecheck, focused CLI tests, native bounded-layout checks, and the
same three product legs. The committed statusline PTY suite joins the existing
TUI workflow and uses the same deterministic command/color/save/cancel/restart
oracles as the baseline. Native tests cover geometry, styling and real settings
scope writes. The POSIX PTY fixture explicitly skips Windows; this does not
accept Windows behavior. Keep initial failures and distinguish a broken
protocol from a product mismatch. Independent verification concentrates on
save scope, command lifecycle, and terminal geometry rather than repeating
every unit assertion.

## Acceptance and integration gates

The configuration-to-display cycle must pass on the exact candidate without
invented state, duplicate settings logic, or changed Ink behavior. All claimed
fields require producer/consumer and runtime evidence. Unexecuted Vim,
non-host platform, IME, and other footer capabilities remain explicitly open
in the migration inventory.

This work depends on U1's dialog boundary, not on the unrelated npm runtime
branch. Keep it as a stacked Draft while its actual prerequisites review;
after the base merges, rebase/retarget and rerun affected tests and exact-head
CI. Do not infer merge, default-switch, or Ink-removal approval from this plan.
