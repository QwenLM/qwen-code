# Mobile follow-up suggestion acceptance

[English](web-shell-mobile-followup-acceptance.md) | [简体中文](web-shell-mobile-followup-acceptance.zh-CN.md)

Status: implemented in the working tree (2026-11-20), not yet committed.

## Problem

The touch composer (plain `<textarea>` backend, `(hover: none) and (pointer: coarse)`) renders a follow-up suggestion only as placeholder text. Desktop CodeMirror accepts it with Tab / Enter / Right Arrow, which fill the input without submitting; the touch backend has no equivalent gesture. Tapping Send with an empty input submits the suggestion directly, and typing a prefix then sending completes it, but neither lets the user edit the suggestion before sending.

Two earlier decisions shape this change. The mobile-composer-actions redesign removed the legacy simulated Tab/Esc/left/right keys because Tab did nothing on the textarea backend. #14220 removed the editing row's up/down history stepping because the history search panel is the touch recall path and a plain textarea restore cannot rebuild inline tag chips. History stepping is therefore not revived here.

## Design

Two touch points, one accept path:

- **Suggestion bar** above the input row, in every composer variant: the suggestion text as a tappable button plus a dismiss button.
- **Editing-row Tab key**, default variant only (the editing row does not render in the simple variant or during voice capture): a `Tab`-labelled button that appears only while a suggestion is visible.

Visibility for both: touch backend mounted, suggestion visible, draft empty, composer enabled. Both hide as soon as the user types, matching the desktop ghost's prefix rule in spirit while keeping the touch surface draft-free. While the bar is visible the touch textarea keeps its ordinary placeholder, so the suggestion text appears on exactly one surface; an earlier revision also left it in the placeholder, which duplicated the text on screen. Desktop keeps rendering the suggestion as placeholder (empty input) and ghost completion (typed prefix).

Accept calls `onAcceptFollowup('tab')` without `skipOnAccept`, so the host's existing `onAccept → insertText` wiring fills the textarea and focuses it inside the tap gesture (iOS opens the keyboard only for gesture-initiated focus). Dismiss calls `onDismissFollowup`, keeping the existing ignored-outcome telemetry. No new data path: the daemon sidechannel, controller, and insertText touch branch are reused unchanged.

Preserved fast paths: Send with an empty input still submits the visible suggestion; typing a prefix and sending still completes and submits it. The bar makes the first path discoverable without changing its semantics.

## Constraints

- 44px touch targets; the bar occupies one 44px row only while a suggestion is visible, so idle layout is unchanged.
- The textarea keeps its 16px font (iOS focus auto-zoom rule); the bar is a button and uses 14px dimmed text with ellipsis.
- The accept button prevents mousedown default like the other editing-row controls, so focus is not lost before the gesture-driven insert.
- The old "no simulated keyboard keys" acceptance stays true when no suggestion is visible; the Tab key is contextual, not a revived dead key.

## Validation

- `client/e2e/web-shell.followup.mobile.spec.ts`, mobile-chromium (Pixel 7 touch emulation): 6/6 passed — bar fill without submit, dismiss, empty-send direct submit, typing hides the bar, prefix completion, editing-row Tab key fill, and the placeholder staying ordinary while the bar shows (single surface). The spec captures evidence screenshots into its
  test-results output.
- `ChatEditor.test.tsx` mobile composer actions: 8 new unit tests pin visibility (draft, hidden suggestion, desktop backend, disabled, simple variant) and the accept/dismiss wiring; 383/383 passed with `i18n.test.ts` at the merged head.
- web-shell `tsc --noEmit` and ESLint on the changed files: clean.
- Not covered: mobile-webkit / real iOS devices (host lacks WebKit runtime libs); soft-keyboard-open layout pressure from the extra row; iPad hardware-keyboard Tab/Right acceptance (deferred).

## Open questions

None blocking. Real-device iOS keyboard behavior must be distinguished from emulation in any later verification report.
