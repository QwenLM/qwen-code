# Composer context shortcuts

[English](2026-09-13-web-shell-hover-compression.md) | [简体中文](2026-09-13-web-shell-hover-compression.zh-CN.md)

## Problem and scope

The context ring already shows local usage on hover, but manual compression is
only available in the right context panel. Add compression and a detail-panel
shortcut to the hover card. Preserve clicking the ring to create a historical
context snapshot, existing visibility settings, drafts, and attachments. Do not
change the compression algorithm, daemon API, or shared operation lifecycle.

## Interaction

Use the existing scoped nonmodal Popover primitive for an interactive card.
Hover opens it after 300 ms; focus opens it without a delay. Moving between the
ring and card has a short close grace period. Hover does not steal editor focus
or fetch context. Require pointer movement to start the hover delay, and suppress focus-open and movement-triggered hover while a pointer button is held so the snapshot action does not flash the card. Keep the card open while focus is inside it. Leaving both
surfaces, moving focus outside, clicking outside, or Escape dismisses it.

The ring retains its snapshot click action. Down Arrow, or Tab while its card
is open, moves keyboard focus into enabled actions. If none is enabled, retain native Tab navigation. Escape from the card returns
focus to the ring without reopening it. Use an accessible dialog name and
expanded/controls attributes and a concise localized used/window description on the ring. Keep card keys out of the global BTW dismissal shortcut. Loop Tab from the card container during compression and at the enabled action boundaries using the actual focused element inside shadow portals; if all actions become unavailable after entry, Tab dismisses the card. View details also restores ring focus unless the user or panel has already selected another target. Preserve portal-root scoping and existing theme
and ring attributes; reuse stable CSS and shared buttons.

The card retains exact used, total, and remaining counts, a proportional meter,
and severity colors. Preserve the existing secondary text and error colors, mapping the card’s semantic tokens to those local theme variables. Add explicit Compress and View details buttons. Unknown
counts do not prevent valid live-session actions. View details opens the right
context panel for the same session and closes the card; it does not add a
transcript snapshot.

## State and ownership

Pass the existing owner controls from App or ChatPane into ChatEditor. Do not
create another compression hook or route the action through ordinary composer
submission. Both surfaces use the same pending flag, eligibility gates, and
completion result. Active work, plan preparation, approval, recovery, Goal state,
and missing builtin command metadata keep their current restrictions.

Display pending and settled feedback with the same wording and semantics as the
right panel. Closing an open card dismisses its settled feedback; passing over or clicking a closed ring does not discard an unseen result; an operation that finishes after closing remains available on the next open. Previously settled feedback is not replayed when the card’s owner remounts. The panel keeps its existing Refresh dismissal. Completion already synchronizes the live counter. Failure,
cancellation, or a changed connection must never claim refreshed usage. The
View details action provides the existing Refresh recovery path. Opening the
card does not issue a read or retry a compression.

App opens main-session details through its existing panel action. SplitView
forwards a pane detail callback independently of custom header rendering; each
pane supplies its own session/actions and marks its tab to close with the pane.
The hover card resets with its owning session. Composer shortcuts follow composer-toolbar visibility independently of `header.items`, which controls header actions only; keep the header defaults unchanged. Embedded side-task panes without a detail-panel opener keep their read-only summary and snapshot action, without introducing a compression action with no Refresh recovery path. Old callbacks remain protected
by the existing compression hook's session/workspace and pending guards.

## Implementation areas

- ChatEditor and an internal context-popover component: local counter summary,
  hover/focus behavior, keyboard actions, and shared compression controls.
- App, SplitView, and ChatPane: owner-specific shortcuts and panel lifecycle.
- ContextUsagePanel and a shared feedback component: consistent result copy.
- English/Chinese strings, focused component/wiring tests, and existing browser
  context scenarios.

## Validation and acceptance

Dry-run an isolated global CLI baseline and record the missing hover action.
Verify the built product with actual pointer and keyboard interactions: hover
without requests, cross-gap movement, focus entry/Escape, single compression,
shared pending/feedback/counters, draft and snapshot preservation, pane isolation,
plan/recovery restrictions, and View details with custom headers and unknown
usage. Inspect light/dark, narrow, and Chinese layouts; preserve React 18 ref
compatibility and portal scoping.

Run root build/typecheck/bundle and affected package tests. Review the full diff
in open-ended and reverse passes until two consecutive clean passes, then obtain
independent code review. Publish real browser screenshots on the fork assets
branch with the PR and a separate E2E report. No open product questions.
