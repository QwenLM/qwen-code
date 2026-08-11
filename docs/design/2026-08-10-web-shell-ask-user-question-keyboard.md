# Web Shell Ask User Question Keyboard Interaction

## Problem

The Web Shell question overlay supports keyboard navigation within one option
list, but keyboard flow breaks when users move between questions, enter a custom
answer, or reach the final action. Returning to an answered question can also
place focus on a different option than the checked answer.

## Interaction contract

- Opening the topmost question focuses its current answer, or the first option
  when the question has not been visited.
- Up/Down and j/k move through options. In a single-select question, focus and
  the checked answer move together. Space toggles the focused multi-select
  option.
- Enter advances to the next question. On the last question, it submits the
  current answers.
- Previous and Next move focus into the destination question, preserving its
  checked option or custom-answer trigger.
- Left and Right perform the same navigation from any non-editable dialog
  control.
- Command/Ctrl+Enter submits the current answers from anywhere in the dialog.
- Escape while editing a custom answer exits editing, preserves the text, and
  restores focus to the Other trigger. Escape elsewhere cancels the request, so
  pressing Escape a second time after leaving the input cancels.
- A short contextual hint makes the available keys visible.
- Action shortcuts are inactive while the dialog is collapsed.

## Accessibility

The overlay is a non-modal multi-step form rather than a brief urgent alert, so
it uses `role="dialog"` without `aria-modal`. Existing `radiogroup` and toggle
button semantics remain. The current question continues to label the dialog and
its option group.

## Scope

The change is limited to the Web Shell question component, its styles,
translations, and focused component tests. The permission payload and daemon
protocol do not change. Split-view panes keep their existing `keyboardActive`
focus guard.
