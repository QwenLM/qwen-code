# OpenTUI hook content and region budgets (MYWO-3 / MYWO-13)

[English](2026-10-13-opentui-hook-content.md) | [简体中文](2026-10-13-opentui-hook-content.zh-CN.md)

## Status and baseline

Restored on main baseline `2b5c4deadb9e9dd0d9d740a52ae42f28ad14bf92` as U1 of the [migration delivery plan](2026-10-20-opentui-migration-delivery.md). Candidate verification is tracked separately from implementation.

Source attribution: [#14044](https://github.com/QwenLM/qwen-code/pull/14044), commits `10a98a72ee2c78323c902f7d01f2a05db371a5d0` and `7cb0a86fbf709da0da24f6acb0a14465e59b9c36`, authored by gary.gq with multica-agent. That PR merged into `fix/MYWO-7-short-dialog-budgets`, not main. Restore only its eight-file delta from `e16490eccc5aeffbb680da7c0935b5aebfe82f1b`, preserving subsequent main changes. Historical passing results do not certify this candidate.

## Reproduction

The restored native test script fails against unmodified main `2b5c4deadb` with Bun 1.4.0 and OpenTUI 0.5.10: empty Hooks at width 20 / region 1 paints five extra border rows outside the region. It exits with a business assertion, not an import or compile failure. The test stops there; the detail and Diff paths were not reached by this baseline run.

Historical #14044 observations at its stacked base: sandboxed Diff is 12 rows at width 20 and overpaints regions 1–6; non-sandboxed Diff fits. Hooks detail at width 40 is 102 rows; its long literal head is visible but middle and tail are unreachable, with no scrollbox. Matchers also overpaint regions 1–6. These observations use captureCharFrame and native geometry with mock keyboard input, not a PTY. Width 11 body reachability remains a separate limitation requiring its own evidence.

## Decisions

Reuse the existing scrollDialogLayout budget to retain a content row and shed optional chrome when it cannot fit. Share that policy with sandboxed Diff and hooks. Bound hook details with a native scrollbox; retain literal newlines and make every physical text row independently scrollable to avoid the native multiline Text tail limitation. Use a stacked label/value layout when narrow columns cannot pay the label column. Detail supports wheel, arrow/page keys and Home/End; Esc preserves drill-down semantics. Diff focuses its existing scrollbox so native keyboard scrolling can reach the sandbox notice tail. Viewport changes reset detail scrolling to the head; an unchanged viewport preserves its offset and all content. Lists preserve selection and use existing regionListWindow arrow accounting. No hook configuration, permission or asynchronous resource behavior changes.

## Validation and acceptance

B2-1: capture long literal head/middle/tail and trailing fields, including all intermediate rows. B2-2: capture sandboxed true/false at normal, region 1–6, narrow widths and resize, with no painted character below the region. B2-3: render the matchers path with a region, test returns and measure each of the six chrome leads before changing it. B2-4: native behavior mutation must fail content/overpaint assertions; run related OpenTUI and Ink tests plus build, bundle, typecheck, lint and formatting with original exit codes. B2-5: synchronized bilingual design, independent PR with exact head/base and requirement matrix. See the requirement results and delivery logs below.

## Mechanism and historical audit

Compact mode sheds the title/count, notice/banner, explanatory headers, footer hint and vertical padding; regions 1–2 also omit the border. Payload text stays in a bounded scrollbox, including empty-list explanations. Detail values use a stacked layout whenever an 18-column label would leave less than two columns for wide glyphs. Prewrapping reserves the native scrollbar column and retains literal whitespace/newlines in separate physical-row nodes. It wraps at word boundaries with hard wrapping only for words wider than the available content width (`hard: true`, `trim: false`). Native scans at width 29/detail and width 40/empty state verify complete `settings.json` and `event` words across reachable frames. The title uses one colored-span text run so its painted wrapping equals its combined measurement.

A width or body-budget/compact-border change remounts the read-only scrollbox and resets to the head. Resizing while its viewport is unchanged preserves the offset. Both policies are tested through native scroll position and painted content, not node identity. Esc remains available even when the hint is hidden. Native bordered boxes can paint outside a parent text clip, so explicit geometry and character-frame assertions are both required.

The compact detail view omits its heading so its first row contains a hook field. Word-boundary evidence keeps the frame where each word is seen, and the literal corpus includes Han, kana and Hangul. The two-mode chrome threshold remains intentional; a larger region can restore explanatory chrome and reduce the number of visible list rows. Global-disabled Hooks still needs a separate parity change: Ink presents a disabled state, while this OpenTUI view can hide its banner in compact mode. That gap remains in the capability inventory and blocks final parity acceptance.

On POSIX, review hardening keeps HUP as the first PTY close signal, allows ten seconds for the product's five-second cleanup budget, then kills the owned process group and waits up to five more seconds for exit. Windows uses the PTY backend to terminate the child. Forced cleanup remains a test failure, and callers still release their other fixtures. CI evidence names and directories include the run attempt; fixture settings and runtime directories are isolated before build and removed even after failure. The new acceptance commands explicitly make unhandled errors fatal on every runner. These changes require fresh verification on the resulting commit; earlier acceptance remains historical evidence.

| Historical lead           | #14044 source evidence and native run rows at terminal 20 / 40 / 100 | Historical disposition         |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| C1 extensions hint/status | Measured runs; hint 8/3/1, sampled status 10/4/2                     | Old undercharge not reproduced |
| C2 MCP step header        | Measured header runs; sample 6/2/1                                   | Old undercharge not reproduced |
| C3 theme/scope footer     | Measured runs; theme 5/2/1, scope 4/2/1                              | Old undercharge not reproduced |
| C4 theme title            | Actual title-column width 3/12/39; 5/2/1 rows                        | Old undercharge not reproduced |
| C5 theme labels           | Name/type clipped to remaining columns; 1/1/1                        | Old undercharge not reproduced |
| C6 auth Shell title       | shellBodyChromeRows measures title; sample 5/2/1                     | Old undercharge not reproduced |

These are historical representative run measurements with charge = native height = painted rows, not current-candidate acceptance or a complete six-dialog short-region certification. No corresponding module is changed in U1.

## Candidate acceptance

| Requirement | Required evidence                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-1        | Native long literal head/middle/tail, all 80 intermediate glyphs, CJK and trailing fields; 20/28/29/40/100 columns, regions 1–6/15/40, keyboard and resize. Width 11 remains outside this acceptance.                                                             |
| B2-2        | Sandboxed true/false geometry and region-external character frames, plus End/Home reachability of the sandbox notice. Sandbox must not spawn Git. The native non-sandbox case runs in an empty temporary cwd; long working-tree Diff belongs to product coverage. |
| B2-3        | Native matcher region, selection and Enter, one-step Esc returns, empty matchers/handlers, and unchanged grouping and gates.                                                                                                                                      |
| B2-4        | Focused OpenTUI/Ink tests, native component parity, build, bundle, typecheck, lint and formatting on the exact candidate; retain failures and reruns. Product tests compare Node+Ink, Bun+Ink and Bun+strict OpenTUI.                                             |
| B2-5        | Synchronized bilingual design, preserved source attribution, exact candidate/base and independently reported acceptance.                                                                                                                                          |

The current-candidate results belong in its test report and PR evidence. Until executed they are `NOT_RUN`; the #14044 result table is historical evidence only.

Historical evidence correction (MYWO-17): the original author evidence named `detail-cap` actually removed the empty-state height cap (`renderEmpty`); its log and ZIP map to `empty-cap`, not the detail cap. The subsequent `true-detail-cap` mutation uniquely targeted the detail key plus height. Retain this distinction when reusing the tests; do not copy old mutation results or static key/identity-only assertions into current business acceptance.

## Limits and follow-ups

Windows, Linux, tmux and assistive technology require separate verification. Native headless renderer frames with mock keyboard input are not PTY recordings; product PTY evidence is tracked by U1's migration acceptance plan. Do not close #13758/#12612 or #8662 from this slice: confirmation, transcript and other composite subitems remain. This change does not switch the default renderer or modify Bun runtime, clipboard notification, confirmation architecture or upstream FFI. The six historical chrome leads require current measurements before further changes.
