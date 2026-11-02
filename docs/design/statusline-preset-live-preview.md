# Status line preset colors and live preview

[English](statusline-preset-live-preview.md) | [简体中文](statusline-preset-live-preview.zh-CN.md)

## Problem and current state

Issue [#8363](https://github.com/QwenLM/qwen-code/issues/8363) requests semantic
preset colors and a preview in the real status line. Ink and OpenTUI currently
paint every preset with one accent color, put a truncated preview inside the
picker, and replace the composer while the picker is open.

## Proposed solution

Keep the real composer and footer visible while configuring presets, with input
disabled so the picker alone owns keyboard input. Publish an ephemeral preset
configuration to the shared status-line hook on mount and after each toggle.
Clear it when the picker closes. Enter writes the effective settings scope;
Escape cancels without writing settings. Preserve explicit
`hideContextIndicator` values in both preview and saved configurations.
Disable native textarea focusability as well as focus so a mouse click cannot
reclaim keyboard or paste events while the picker is open.

Use the saved status line's existing renderer, width, wrapping and two-row limit.
In current main the real status line is in the footer below the input, despite
the issue's reference to an above-input status line. Preserve that saved layout;
place the configuration picker above the composer, not a second preview there.
Remove the preview and its row budget from both pickers. Reserve room for the
composer/footer when calculating the picker's height.

Color every available item according to a complete, compile-time checked map:

| Category            | Items                                                                                                      | Theme token    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| Project and Git     | project-name, git-branch, current-dir, pull-request-number, branch-changes                                 | status.success |
| Model and reasoning | model, model-with-reasoning                                                                                | text.accent    |
| Context and tokens  | context-remaining, context-used, context-window-size, used-tokens, total-input-tokens, total-output-tokens | text.link      |
| Session metadata    | run-state, qwen-version, session-id                                                                        | status.warning |

Apply ANSI styling in the shared preset formatter using the active semantic
palette, which both existing renderers already understand. Keep separators
neutral. With `useThemeColors: false`, emit plain preset text and retain existing
dimmed footer styling. Resolve colors at render time so theme changes repaint
without stale cached colors, including named and NoColor themes.
The OpenTUI preset row must not add an accent fallback over the formatter's
output: empty NoColor tokens must remain uncolored.

## Affected areas

- `packages/cli/src/ui/statusLinePresets.ts` and `hooks/useStatusLine.ts`:
  shared semantic formatting and temporary configuration precedence.
- Ink `AppContainer.tsx`, UI contexts, `StatusLineDialog.tsx`,
  `DialogManager.tsx`, `Composer.tsx`, `InputPrompt.tsx`, and layouts:
  draft ownership, inert visible input and bounded picker placement.
- OpenTUI `dialogs-statusline.tsx`, `opentui-dialog-mount.tsx`,
  `opentui-app-shell.tsx`, `input-prompt.tsx` and `opentui-footer.tsx`:
  the equivalent draft lifecycle, placement, input ownership and styling.
- Focused formatter, hook, picker, layout and shell tests; user documentation.

## Decisions and scope

Do not save intermediate selections or change custom-command output semantics.
A draft must override a command or disabled status line while open, then restore
that configuration on cancellation. Keep saved overrides distinct from drafts
so stale saved overrides cannot override a command or `null` settings value.
Preserve existing search and compact-picker behavior. No new persisted settings,
configuration migration, unlimited status-line height or unrelated layout work.

## Validation and acceptance criteria

Check both renderers at wide, narrow and short sizes. Toggles must change the
real footer immediately; no bordered preview may remain. The input and footer
stay visible, and picker keys/pastes must not submit or change the input. Enter
saves only once and leaves the same output; Escape restores preset, command or
disabled settings without a write. Every built-in item belongs to exactly one
color category. Colors switch with the active theme and disappear when disabled.
Run focused unit tests, build, typecheck, bundle and isolated interactive tests.

## Open questions

None. The current real footer placement and its existing two-row limit are
preserved rather than expanding this request into a global status-line redesign.
