# OpenTUI migration delivery and acceptance

[English](2026-10-20-opentui-migration-delivery.md) |
[简体中文](2026-10-20-opentui-migration-delivery.zh-CN.md)

Status: proposed delivery plan; implementation and acceptance are tracked
separately. Evidence snapshot: 2026-10-20, main `2b5c4deadb`.

## Problem and current state

Moving the interactive runtime to Bun and replacing Ink are separate changes.
Success requires preserving npm and standalone installation, update, process
lifecycle, and the behavior users currently receive from Ink. A merged PR,
successful mocked test, or successful fallback to Ink is insufficient evidence.

The OpenTUI foundation, many dialogs, transcript windowing, and steady caret are
on main. The Hooks and sandbox Diff work in #14044 merged into an old feature
branch, not main. PTY #14046 and the standalone update stack
#14134/#14139/#14142/#14187/#14210 remain open. Current npm installation does not
provide a complete Bun/OpenTUI runtime. Global `qwen` 0.23.0 is only a historical
baseline: strict OpenTUI cannot start because its native package is absent.

## Goals and boundaries

- Run the TUI on Bun while retaining npm, npx, and standalone entry points.
- Inventory every current Ink command, dialog, input action, transcript state,
  status indicator, and user setting; trace each to production OpenTUI wiring.
- Compare runtime and renderer changes independently and regress final artifacts.
- Deliver coherent reviewable PRs, normally 2,000–3,000 changed lines including
  tests and documentation. Do not pad changes or remove tests to meet a quota.
- Reuse React, existing bridges, node-pty, Vitest, the interactive PTY harness,
  xterm, fake model server, and existing parity scripts.

This plan does not adopt Solid, redesign the agent protocol, replace the package
manager, or combine default runtime, default renderer, and Ink removal.

## Delivery batches and dependencies

| Batch | Complete behavior delivered                                                                                                                 | Dependencies and review policy                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| R1    | Standalone update preserves runtime flavor, installs and activates a verified release, and rolls back failures                              | Integrate the five update PRs on current main, retaining source attribution and review findings; target about 3k lines            |
| U1    | Hooks and sandbox Diff remain reachable in short terminals; product comparison can run all three runtime/renderer legs                      | Restore the missing #14044 work and extend existing tests; independent of R1                                                      |
| R2    | PTY spawn, input/output, resize, cancellation, process cleanup, and shell/WebSocket consumers work on Bun                                   | Continue #14046 without mechanically splitting its existing review chain; correctness fixes and acceptance only                   |
| U2    | Composer and commands preserve editing, history, paste, image ownership, Vim, cancellation, and exactly-once submission                     | Stack on U1 when its shared fixtures are needed; include production callback wiring                                               |
| R3    | npm/npx and standalone resolve the intended runtime and native assets on each supported platform                                            | Depends on R1/R2; classify interpreter call sites and package final artifacts without requiring a user's global Bun               |
| U3    | Current Ink dialogs, status/footer, transcript scrolling, tool states, session restore, and dynamic language changes have explicit coverage | Build on accepted input/dialog contracts; coordinate #13080, #14661, and #14349 rather than silently duplicating contributor work |
| A1    | Release-artifact regression and documented default rollout gates are enforced                                                               | Depends on R3/U3 and product acceptance; split only at a complete independently testable boundary if it exceeds review capacity   |

The boundaries may move when current-code evidence changes. No artificial
dependency should serialize independent runtime and UI work. Open at most two
ready PRs with four locally accepted draft successors: implement the next cohesive batch while
review proceeds, then rebase onto the actual merged commit and rerun affected
validation before marking its successor ready.
The draft limit was raised on 2026-10-21 so independently verified editor and
status-line batches can enter CI while the first two reviews remain pending.
Each draft still requires a complete approximately 2–3k-line scope and author
plus independent local acceptance; the ready limit and merge gates are unchanged.

Existing #14046 is a size exception because it already has a complete backend
contract and multiple review rounds. Do not add unrelated work to it. Preserve
existing update PRs until their integrated replacement is concrete and reviewed;
then link the replacement explicitly so review findings and attribution survive.

## Runtime and distribution contract

Classify each spawned executable as host runtime, Node-required JavaScript,
bundled Bun JavaScript, native executable, or user command. Do not replace
`process.execPath` mechanically. Shell processes, MCP, hooks, skills, sandbox,
daemon/WebSocket, restart, and updater consumers need matching lifecycle tests.

Node standalone keeps its existing npm transport/configuration behavior. Bun
standalone must work without external Node/npm, preserve the runtime flavor,
validate archive and manifest provenance, smoke-test in an empty isolated
directory, activate atomically, and retain a usable rollback. Invalid manifests
fail closed with accurate recovery instructions. Empty HOME must not turn a
project `.npmrc` into trusted user configuration.

Release evidence covers darwin arm64/x64, Linux arm64/x64, and Windows x64 for the
supported distribution. Report unsupported variants, such as musl where
applicable, explicitly. Test npm global install, npx, relevant install-script and
optional-dependency modes, and standalone on clean PATH without global Bun.

## Ink parity contract

Maintain a capability inventory with: current Ink source, production OpenTUI
call site, input sequence, visible state, side effect, automated case, manual
case when needed, result, and exact candidate revision. An optional callback
with no production caller is not implemented behavior.

Cover slash commands and dialogs; editing and key bindings; history and Vim;
Unicode, CJK, emoji and IME; multiline and bracketed paste; image ownership;
tool approval and cancellation; streaming and interruption; transcript
selection/scroll/resize; session resume; status/footer/loading/error states;
language, theme and screen-reader settings.

Ink is the reference for intended behavior. Record demonstrated old Ink defects
as explicit exceptions instead of reproducing inaccessible or broken behavior.
In short terminals, essential content and escape/return controls must remain
reachable through scrolling and keyboard navigation.

## Comparison and regression strategy

Run the same deterministic scenarios, fake model responses, config, terminal
dimensions, and candidate source through:

| Leg | Runtime | Renderer       | Difference isolated                        |
| --- | ------- | -------------- | ------------------------------------------ |
| A   | Node    | Ink            | Existing contract                          |
| B   | Bun     | Ink            | Runtime behavior, compared with A          |
| C   | Bun     | strict OpenTUI | Rendering and interaction, compared with B |

Strict means renderer fallback is a failure. Record command, Node/Bun versions,
source SHA, bundle/native asset identity, seed/config, raw ANSI, parsed screen,
requests, exit status, and the assertion that failed. Missing runtime/assets or
platform execution is `NOT_RUN`/`BLOCKED`, never an implicit pass.

Use unit tests for transitions and failure boundaries, native component tests
for layout/scroll/caret, and existing node-pty/xterm product sessions for real
keypresses and side effects. Compare semantic state and model/tool requests in
addition to screens. Normalize only declared unstable IDs and timestamps; do
not erase whitespace, color, cursor, wrapping, or duplicated content defects.
The xterm test terminal uses the Unicode 11 addon so a two-cell emoji painted
with explicit cursor positions is not misread by its default Unicode 6 table.
This is a test-only dependency, not a product renderer change; it does not
certify all grapheme clusters or IME behavior. Session cleanup waits for PTY
exit before deleting fixture directories, and cleanup failures fail acceptance.

Product scenarios include long Hooks/Diff content, small and resized terminals,
multi-turn text/tool streaming, interruption, paste ownership, and restoration.
All sends wait for the harness idle boundary. Zero duplicate messages and
exactly-once submission are hard gates, not permissive counters. Test sync
markers, framing and visible frames where relevant; balanced zero markers do
not demonstrate synchronized output.

PR regression runs the touched capability cases plus a shared smoke set on the
exact head. Integration/release regression runs all three legs and the artifact
installation/update matrix. Real terminal IME, selection, accessibility, and
long-running lifecycle tests retain explicit manual evidence where automation
does not model the terminal protocol.

## OpenTUI and OpenCode upstream evaluation

Main uses OpenTUI 0.5.10. Upstream OpenTUI 0.6.6 and current OpenCode provide
useful fixes and implementation references, but 0.6 introduces native ownership
and lifetime changes. A version bump alone is not an approved solution.

Evaluate in isolation: React API/type compatibility; explicit SyntaxStyle
ownership and renderer close; native package/parser/worker asset matching;
minimum Bun version; Unicode/control-character width; resize/scroll/diff;
and the three-leg product/artifact suite. Keep versions and native ABI coherent.
Retain Qwen's application-level IME, image, caret and transcript safeguards
unless evidence proves an upstream change replaces their contracts. Upgrading
is conditional on a measured benefit and passing gates, not the critical path
for independent parity fixes.

## Completion and rollout gates

1. Runtime gate: required consumers and installed artifacts pass on supported
   platforms, including PTY lifecycle, update and rollback.
2. Renderer gate: capability inventory has no unexplained gaps, automated parity
   passes, manual terminal checks are recorded, and strict OpenTUI runs the
   actual product without fallback.
3. Default rollout gate: both prior gates hold for the release candidate and
   recovery/fallback behavior is exercised. Retain accessible Ink until an
   equivalent screen-reader path has its own evidence.
4. Removal gate: no remaining Ink-only contracts or distribution fallback
   dependencies. Ink removal requires a separate review.

Monitor owned PR heads, substantive comments, CI failures and conflicts every
30 minutes. Separate product defects from runner/infrastructure failures using
logs. Rebase dependent drafts only after recording their old heads; preserve
other workspaces. Post evidence for the new exact head after fixes. Do not
automatically merge, release, or count skipped checks as acceptance.

## Risks and open decisions

The current machine can validate macOS arm64, not the complete platform matrix.
Native lifecycle and IME limitations require explicit external evidence.
Independent changes may land while a stack is reviewed; reconcile the current
Ink inventory and actual merged base before promoting each successor.
Default rollout and a possible OpenTUI upgrade remain conditional decisions
until their respective evidence gates pass.
