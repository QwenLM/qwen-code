# Suppress the duplicate software cursor when the native cursor is positioned

[English](2026-09-13-software-cursor-suppression.md) | [简体中文](2026-09-13-software-cursor-suppression.zh-CN.md)

## Problem and scope

On Windows (and in tmux sessions without synchronized output), the input's
software cursor is rendered as an underlined character (`compositionOverlaysSoftwareCursor()`
in `packages/cli/src/ui/utils/software-cursor.ts` returns `true` unconditionally
on `win32`), so a caret resting at the end of the input paints an underlined
space — visually a stray `_`. The patched ink runtime (`patches/ink+7.0.3.patch`)
additionally positions and shows the native terminal cursor on that same cell to
anchor IME composition. Users therefore see two carets at once: the blinking
native cursor plus a static `_`.

This change suppresses the software cursor only when the native cursor is about
to be positioned on its cell, and only in the underline-cursor environments
where the artifact appears. Block-cursor environments (macOS/Linux outside tmux)
keep their existing rendering byte-for-byte. It does not change cursor
ownership, IME anchoring, focus gating (`showCursor`), or dialog inputs
(`shared/TextInput.tsx`), which never position the native cursor and rely on
the software cursor alone.

## Design

- Add `shouldRenderSoftwareCursor(physicalCursorActive, env?, platform?)` to
  `software-cursor.ts`: return `false` only when
  `compositionOverlaysSoftwareCursor(env, platform)` is true (Windows, or tmux
  without forced synchronized output) and the physical cursor will be
  positioned. The injectable `env`/`platform` parameters mirror the existing
  testability pattern of `compositionOverlaysSoftwareCursor`.
- In `BaseTextInput`, compute
  `drawSoftwareCursor = shouldRenderSoftwareCursor(cursorPosition !== undefined)`
  right after `setCursorPosition(cursorPosition)`. `cursorPosition` is
  non-`undefined` exactly when `showCursor && hasMeasured && node` — the same
  condition under which this render's flush positions and shows the native
  cursor on the caret cell. Pass the flag through `RenderLineOptions` so custom
  line renderers honor it.
- `defaultRenderLine`: at end of line the suppressed branch keeps a plain
  trailing space plus `\u200B` (matching the existing no-cursor branch) so Ink
  still has an untrimmed cell for the native cursor; mid-line it renders the
  line as plain text. The placeholder renders fully in the secondary color.
- `InputPrompt.renderLineWithHighlighting` gates its three
  `renderSoftwareCursor` sites (mid-line character, ghost-text cursor, end of
  line) on the flag.
- `shared/TextInput.tsx` is intentionally untouched: dialog inputs never set a
  physical cursor position, so the software cursor remains their only caret.

## Trade-offs and risks

- Repaints that do not re-render the input owner (for example spinner frames
  while the user pauses mid-edit) can momentarily hide the native cursor under
  ink's cursor-ownership model while the software cursor is suppressed, until
  the next keystroke or owner render. Accepted for this change.
- On mount, `hasMeasured` starts false, so one initial frame may show the
  underline before the native cursor takes over. One-frame, mount-time only.
- IME safety is unchanged or improved: the suppressed cell carries no
  app-side SGR at all, and the native cursor still anchors composition.

## Affected files

`packages/cli/src/ui/utils/software-cursor.ts`,
`packages/cli/src/ui/components/BaseTextInput.tsx`,
`packages/cli/src/ui/components/InputPrompt.tsx`, and their tests
(`software-cursor.test.ts`, `BaseTextInput.test.tsx`, `InputPrompt.test.tsx`).
Component tests mock `shouldRenderSoftwareCursor` (default `true`) so cursor
assertions stay platform-independent; suppression is covered by dedicated
tests with `chalk.level = 3`.

## Validation and acceptance

Unit tests for the three files pass on Windows and Linux. Manual check with
`npm run dev` on Windows: while typing, only the native blinking caret is
visible with no static `_`; mid-line moves, the empty-input placeholder, and
pinyin IME composition behave as before; streaming output while the input is
focused still shows a usable caret.
