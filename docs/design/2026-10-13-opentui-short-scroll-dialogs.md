# Short read-only scroll dialogs

[English](2026-10-13-opentui-short-scroll-dialogs.md) | [简体中文](2026-10-13-opentui-short-scroll-dialogs.zh-CN.md)

## Problem and scope

MYWO-3 audit, based on main `5aae8991bede510a5bde2dfe4c3b30e9bb25d4f3`: #13669 and #13693 are merged. #12612 already has region-derived diff/subagents body heights, but the one-row floor plus six rows of chrome still exceeds regions of 1–6 rows. #13758's skills body can reach zero while its six-row frame remains. Native border painting can escape the region's text clip.

This batch fixes these three read-only scroll dialogs and adds a real session-picker resize witness. It does not close either composite issue. Hooks detail, confirmation paging/budget/classification, completion cleanup, transcript deferrals, clipboard notification channel, cross-platform acceptance, default selection and Ink removal remain outside this batch.

## Decision

Keep normal borders, vertical padding, title and body margin when the region pays for them and at least one content row. Otherwise use compact chrome: hide title and vertical padding/margin, retaining two border rows only when the region has at least three rows. Regions 1–2 spend all their rows on content. Horizontal padding stays unchanged. No-budget calls retain their original body caps (diff 14; skills/subagents 12).

For borderless frames, use `border=[]`: OpenTUI 0.5.10 implicitly enables a false border when a color/style is supplied. Remount on frame style changes because removed layout properties can persist. Size-folded scrollbox keys reapply `flexShrink=1` after resize; sizes reset it to zero on reused native nodes. Resizing resets the scroll position, but loaded content remains in component state and can be scrolled again. Escape remains active when its visual hint is hidden.

The skills title is clipped to the actual content width and its close hint omitted when both cannot fit one row. This keeps its six-row normal chrome charge valid on narrow terminals.

## Validation and acceptance

The native Bun script exercises real components at widths 11/20/40/100 and region heights 1–8/12/15/40: frame height and painted borders must stay in the region. Grow/shrink tests must reveal the last fixture row and preserve native Yoga shrink on remounted bodies. The real session picker list and preview must remount across resize and keep Yoga shrink 1. Fast unit tests pin no-budget behavior and normal/compact transitions; existing Ink dialog tests and component parity cover the shared renderer regression boundary.

Mutation checks must fail when compact chrome or sized keys are removed. Build, typecheck, relevant lint and unit/native checks are required before delivery. Evidence is local macOS/Bun native headless rendering; Linux, Windows, tmux and interactive wheel feel require separate acceptance. A native headless frame is not a live terminal recording.

Confirmed residual: at 11 columns, flex columns may squeeze payload text away, and native scrolling of one multi-line Text node may fail to show its tail glyph. An independent minimal @opentui 0.5.10 probe reproduces the latter. This batch retains existing payload row layout; 11-column checks cover geometry, while content reachability is checked at 20/40/100 columns. It does not claim to fix extremely narrow payload reading.
