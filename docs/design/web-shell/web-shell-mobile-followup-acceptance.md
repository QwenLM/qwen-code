# Mobile follow-up suggestion acceptance

[English](web-shell-mobile-followup-acceptance.md) | [简体中文](web-shell-mobile-followup-acceptance.zh-CN.md)

Status: implemented on `feat/web-shell-mobile-followup-acceptance` (PR #17918), revised through three review rounds on 2026-11-20 (Tab key → action-word key → single chip bar).

## Problem

The touch composer (plain `<textarea>` backend, `(hover: none) and (pointer: coarse)`) renders a follow-up suggestion only as placeholder text. Desktop CodeMirror accepts it with Tab / Enter / Right Arrow, which fill the input without submitting; the touch backend has no equivalent gesture. Tapping Send with an empty input submits the suggestion directly, and typing a prefix then sending completes it, but neither lets the user edit the suggestion before sending.

Two earlier decisions shape this change. The mobile-composer-actions redesign removed the legacy simulated Tab/Esc/left/right keys because Tab did nothing on the textarea backend. #14220 removed the editing row's up/down history stepping because the history search panel is the touch recall path and a plain textarea restore cannot rebuild inline tag chips. History stepping is therefore not revived here.

## Design

One touch point, one accept path:

- **Suggestion chip bar** above the input row, in every composer variant: a chip-styled tappable button whose label is the suggestion text itself, preceded by an insert icon, plus a dismiss button. The editing row carries no follow-up-specific control; its → caret key doubles as the same accept (desktop ArrowRight parity).

The single chip is the end state of three review rounds. The first revision added the bar plus an editing-row key labelled `Tab`; review noted touch users have no Tab key or Tab-accept habit. The second revision relabelled that key with the localized action word (`Fill in` / 填入 / Вставить); review noted a bare transitive verb still lacks its object and sits spatially detached from the suggestion content. The final revision removes the editing-row key entirely and gives the bar a chip container (subtle background, border, insert icon) so it reads as tappable without hover: the content is the label, the most understandable form, matching mobile suggestion chips elsewhere. The `composerMobile.fillFollowup` catalog keys were removed with the key.

A fourth review round added always-live editing keys to the editing row's trailing side (default variant, touch): ↑/↓ move the caret line-aware with the column clamped to the target line and document edges at the first/last line; → moves the caret right and doubles as the desktop ArrowRight follow-up accept when a suggestion matches, replacing the draft with the completion (telemetry method `right`); / inserts a literal slash, a character convenience because the textarea backend has no slash menu — command browsing stays in the add drawer. The keys ignore taps during IME composition, and caret-only moves never touch the draft or its persistence. They are absent in the simple variant and during voice capture, where the editing row does not render. History recall stays with the search panel: no stepping callback is revived, so the inline-tag-chip limitation that removed stepping in #14220 does not apply.

Visibility: touch backend mounted, suggestion visible, draft empty, composer enabled. The chip hides as soon as the user types, matching the desktop ghost's prefix rule in spirit while keeping the touch surface draft-free. While the chip is visible the touch textarea keeps its ordinary placeholder, so the suggestion text appears on exactly one surface; an earlier revision also left it in the placeholder, which duplicated the text on screen. Desktop keeps rendering the suggestion as placeholder (empty input) and ghost completion (typed prefix).

Accept calls `onAcceptFollowup('tab')` without `skipOnAccept`, so the host's existing `onAccept → insertText` wiring fills the textarea and focuses it inside the tap gesture (iOS opens the keyboard only for gesture-initiated focus). Dismiss calls `onDismissFollowup`, keeping the existing ignored-outcome telemetry. No new data path: the daemon sidechannel, controller, and insertText touch branch are reused unchanged.

Preserved fast paths: Send with an empty input still submits the visible suggestion; typing a prefix and sending still completes and submits it. The bar makes the first path discoverable without changing its semantics.

## Constraints

- 44px touch targets; the chip row occupies one 44px row only while a suggestion is visible, so idle layout is unchanged.
- The textarea keeps its 16px font (iOS focus auto-zoom rule); the chip is a button with 14px text, an insert icon and single-line ellipsis.
- The chip prevents mousedown default like the other composer controls, so focus is not lost before the gesture-driven insert; its aria-label combines the localized action with the suggestion text so screen readers get both.
- The old "no simulated keyboard keys" acceptance stays true: no follow-up control names a keyboard key or a bare verb; the editing-row keys are caret/character keys with live native meaning, not simulated accept/history keys.
- Editing keys pause during IME composition (compositionstart/end gate); caret-only moves do not modify the draft, so draft persistence and history-browse state are untouched.

## Validation

- `client/e2e/web-shell.followup.mobile.spec.ts`, mobile-chromium (Pixel 7 touch emulation): 11/11 passed — chip fill without submit, dismiss, empty-send direct submit, typing hides the chip, prefix completion, the editing row carrying no follow-up-specific key while the chip accepts (default variant), the placeholder staying ordinary while the chip shows (single surface), caret up/down/right movement, → accepting the visible suggestion, literal slash insertion, and two zh-CN cases pinning the localized chip text, dismiss label and caret-key labels while capturing Chinese-UI screenshots. Those cases pass `?language=`, which App's `getInitialLanguage` reads directly (no harness prop needed); the spec captures evidence screenshots into its
  test-results output.
- `ChatEditor.test.tsx` mobile composer actions: unit tests pin visibility (draft, hidden suggestion, desktop backend, disabled, simple variant), the accept/dismiss wiring, the editing-key wiring and the dynamic → aria-label; `useComposerCore.test.ts` pins the line-aware caret math; 398/398 passed across the three files at the merged head.
- web-shell `tsc --noEmit` and ESLint on the changed files: clean.
- Not covered: mobile-webkit / real iOS devices (host lacks WebKit runtime libs); soft-keyboard-open layout pressure from the extra row; iPad hardware-keyboard Tab/Right acceptance (deferred).

## Open questions

None blocking. Real-device iOS keyboard behavior must be distinguished from emulation in any later verification report.
