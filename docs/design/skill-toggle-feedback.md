# Skill toggle feedback and workspace controls

[English](skill-toggle-feedback.md) | [简体中文](skill-toggle-feedback.zh-CN.md)

## Problem

This change addresses [#10152](https://github.com/QwenLM/qwen-code/issues/10152).
A successful settings write can remove the selected Skill from the refreshed
catalog. The page then returns to the list, where its result notice is missing.
A Skill disabled by higher-scope settings also has no action to remove a saved
workspace enable declaration for its registered name while it remains disabled.

## Behavior

Reuse the existing dismissible management notice in both the detail and list
views. If the refreshed catalog omits the Skill, report only that the workspace
setting was updated. Report effective availability separately. A failed write
shows its error and releases the busy state. Results from an operation started
in another workspace or client must not update the current page.

For a disabled Skill with a higher-scope lock, add **Disable in this workspace**.
It uses the existing settings toggle with `enabled: false`, which removes the
workspace `skills.enabled` entry and adds `skills.disabled`. It does not clear
the higher-scope restriction or make the Skill runnable. This is an explicit
workspace disable, not a reset to inherited settings. No daemon or SDK API is
added. The current daemon already refuses new enable declarations under a
higher-scope lock; the reverse action also handles declarations saved earlier.
Legacy declarations using a different alias retain the existing daemon behavior.

The App already releases its loaded-Skill fallback for a mutation that changes
only a declaration. Add coverage without changing that production behavior.
Correct the TUI comment to state that untouched workspace declarations for
locked Skills are preserved; do not change the TUI's save behavior.

## Validation

- Refresh without the target Skill: the list displays the setting result and
  the notice can be dismissed.
- Rejected write: error visible, controls usable again, no success notice.
- Higher-scope lock: the new action writes `false` to the selected workspace,
  removes a pre-existing enable declaration, and keeps effective availability
  disabled. Unsupported daemons keep the action disabled.
- Workspace or client changes during the write or refresh: discard the old
  notice and release the controls. Unmounting also invalidates pending work.
- Declaration-only mutation: release the fallback, display later session
  Skills, and avoid another status read on the next applied mutation.

Use component tests, the focused App regression, and an isolated daemon with
temporary settings. Record actual verification results in the PR test report.
