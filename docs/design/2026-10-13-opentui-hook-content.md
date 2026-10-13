# OpenTUI hook content and region budgets (MYWO-3 / MYWO-13)

[English](2026-10-13-opentui-hook-content.md) | [简体中文](2026-10-13-opentui-hook-content.zh-CN.md)

## Status and baseline

Implemented in an independent stacked PR; local native and related unit checks pass, final repository gates and Leader acceptance are recorded with the delivery. Latest main inspected: `83ffe4540c7df15c46a8893f8919801fac58295b`. Independent stacked branch starts at PR #14034 head `e16490eccc5aeffbb680da7c0935b5aebfe82f1b`; its changes are dependencies, not second-batch contributions. Main has no fix for these targets. Do not merge either PR or switch the default renderer.

## Reproduction

Independent macOS native renderer observations at the stacked base: sandboxed Diff is 12 rows at width 20 and overpaints regions 1–6; non-sandboxed Diff fits. Hooks detail at width 40 is 102 rows; its long literal head is visible but middle and tail are unreachable, with no scrollbox. Matchers also overpaint regions 1–6. These observations use captureCharFrame and native geometry with mock keyboard input, not a PTY. Width 11 body reachability remains a separate upstream limitation.

## Decisions

Reuse the existing scrollDialogLayout budget to retain a content row and shed optional chrome when it cannot fit. Share that policy with sandboxed Diff and hooks. Bound hook details with a native scrollbox; retain literal newlines and make every physical text row independently scrollable to avoid the native multiline Text tail limitation. Use a stacked label/value layout when narrow columns cannot pay the label column. Detail supports wheel, arrow/page keys and Home/End; Esc preserves drill-down semantics. Viewport changes reset detail scrolling to the head; an unchanged viewport preserves its offset and all content. Lists preserve selection and use existing regionListWindow arrow accounting. No hook configuration, permission or asynchronous resource behavior changes.

## Validation and acceptance

B2-1: capture long literal head/middle/tail and trailing fields, including all intermediate rows. B2-2: capture sandboxed true/false at normal, region 1–6, narrow widths and resize, with no painted character below the region. B2-3: render the matchers path with a region, test returns and measure each of the six chrome leads before changing it. B2-4: native behavior mutation must fail content/overpaint assertions; run related OpenTUI and Ink tests plus build, bundle, typecheck, lint and formatting with original exit codes. B2-5: synchronized bilingual design, independent PR with exact head/base and requirement matrix. See the requirement results and delivery logs below.

## Verified mechanism and audit

Compact mode sheds the title/count, notice/banner, explanatory headers, footer hint and vertical padding; regions 1–2 also omit the border. Payload text stays in a bounded scrollbox, including empty-list explanations. Detail values use a stacked layout whenever an 18-column label would leave less than two columns for wide glyphs. Prewrapping reserves the native scrollbar column and retains literal whitespace/newlines in separate physical-row nodes. The title uses one colored-span text run so its painted wrapping equals its combined measurement.

A width or body-budget/compact-border change remounts the read-only scrollbox and resets to the head. Resizing while its viewport is unchanged preserves the offset. Both policies are tested through native scroll position and painted content, not node identity. Esc remains available even when the hint is hidden. Native bordered boxes can paint outside a parent text clip, so explicit geometry and character-frame assertions are both required.

| Historical lead           | Current source evidence and native run rows at terminal 20 / 40 / 100 | Disposition                    |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------ |
| C1 extensions hint/status | Measured runs; hint 8/3/1, sampled status 10/4/2                      | Old undercharge not reproduced |
| C2 MCP step header        | Measured header runs; sample 6/2/1                                    | Old undercharge not reproduced |
| C3 theme/scope footer     | Measured runs; theme 5/2/1, scope 4/2/1                               | Old undercharge not reproduced |
| C4 theme title            | Actual title-column width 3/12/39; 5/2/1 rows                         | Old undercharge not reproduced |
| C5 theme labels           | Name/type clipped to remaining columns; 1/1/1                         | Old undercharge not reproduced |
| C6 auth Shell title       | shellBodyChromeRows measures title; sample 5/2/1                      | Old undercharge not reproduced |

These are representative run measurements with charge = native height = painted rows, not a complete six-dialog short-region certification. No corresponding module was changed.

## Requirement results

| Requirement | Local result           | Evidence and remaining acceptance                                                                                                                                                                                                                      |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B2-1        | Pass                   | Native long literal head/middle/tail, 80 intermediate glyphs, CJK glyphs, trailing status/timeout/options and instruction tail; 20/28/29/40/100 columns, region1–6/15/40, keyboard and resize. Width11 body is excluded.                               |
| B2-2        | Pass                   | Sandboxed true/false geometry and actual region-external character frames with spare canvas rows, narrow/normal/resize; sandbox still spawns no Git.                                                                                                   |
| B2-3        | Pass within scope      | Native matcher region, painted active last matcher, Enter and Esc returns, empty matchers/handlers; six leads classified above. Existing grouping, gates and asynchronous behavior unchanged.                                                          |
| B2-4        | Pass for local vehicle | Related OpenTUI/Ink suites and native component parity; six precise behavior mutations red, restored source green. Build/typecheck/lint/format/bundle commands, original exits and all failed development attempts retained in attached delivery logs. |
| B2-5        | Pass at delivery       | Independent stacked PR, bilingual design, exact frozen head/base, requirement matrix and raw logs. Leader schedules frozen-head testing and two independent reviews; implementation does not approve itself.                                           |

Mutations independently remove sandbox layout, detail height cap, literal suffixes, scrollbar-column allowance, matcher header charge, and shared title wrapping. Each fails a painted-content, glyph-reachability or geometry assertion. No business counterexample is claimed from a static key/identity-only mutant.

## Limits and follow-ups

Windows, Linux, tmux, real PTY and assistive technology are pending verification. macOS evidence uses a native headless renderer with mock keyboard input; it is not a PTY recording. Do not close #13758/#12612 or #8662: confirmation, transcript and other composite subitems remain. Do not change Bun S2, clipboard notification, confirmation architecture or upstream FFI. The six historical chrome leads are unconfirmed until measured; existing measurement helpers may already address them.
