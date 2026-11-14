# OpenTUI selection clipboard, right-click actions, and scrollbar visibility

[English](2026-11-09-opentui-selection-clipboard.md) | [简体中文](2026-11-09-opentui-selection-clipboard.zh-CN.md)

Status: proposed
Date: 2026-11-09

## Problem

OpenTUI text selection currently only paints a highlight. Selecting text does
not copy it, right-click does nothing, and the native transcript scrollbar
always consumes a column. The desired interaction is:

- completing an OpenTUI selection copies it automatically, regardless of which
  region owns it (transcript, footer, composer, dialogs);
- right-clicking anywhere in the shell with no transcript selection pastes the
  clipboard into the composer;
- right-clicking a transcript selection dismisses it;
- PageUp/PageDown and Ctrl+Home/Ctrl+End move through the transcript;
- a **Jump to bottom** hint appears while the transcript is not at the tail;
- the transcript scrollbar can be hidden to reclaim a column.

Ink already supports its own selection and right-click menu; this change
defines the OpenTUI behavior rather than copying Ink's menu model.

## Goals

- A completed selection in any OpenTUI region is copied to the clipboard and
  remains highlighted.
- A short-lived bottom-right `Copied N chars` confirmation appears after a
  successful copy, except behind a dialog or confirmation, where the copy is
  silent.
- Right-click anywhere in the shell with a scoped transcript selection clears
  the selection.
- Right-click anywhere in the shell with no selection runs the composer's Ctrl+V
  clipboard path, including image-first handling and text fallback.
- PageUp/PageDown scroll one viewport page; Ctrl+Home/Ctrl+End jump to the
  edges; the jump-to-bottom hint appears away from the tail.
- The native OpenTUI transcript scrollbar is hidden by default. An explicit
  `ui.showOpenTuiScrollbar: true` restores OpenTUI's normal auto-hiding bar.
- Behavior is split into small modules with tests rather than embedded in the
  app shell.

## Non-goals

- No in-app context menu. Link actions, code-block actions, and Select All stay
  out of this change.
- Terminal-native Shift+drag selection is invisible to the app, so the app does
  not auto-copy it. The app still receives the next click: a right-click after
  a Shift+drag pastes into the composer. Setting `ui.mouseTracking: false` gives
  the right-click menu back to the terminal.
- History unmounted by the virtualized transcript cannot be copied.
- Ink's existing selection and right-click behavior is unchanged.

## Proposed design

### Module layout

| File                                       | Responsibility                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `renderable-tree.ts`                       | `isRenderableWithin()`: scope a renderer selection to the transcript.                                                                                        |
| `selection-auto-copy.ts`                   | `useSelectionAutoCopy()`: copy any non-empty OpenTUI selection and report success.                                                                           |
| `copy-notice.tsx`                          | Transient bottom-right `Copied N chars` confirmation; expires after two seconds.                                                                             |
| `transcript-mouse.ts`                      | `handleTranscriptRightClick()`: pure right-click policy (clear selection vs paste).                                                                          |
| `scrollbar-visibility.ts`                  | `openTuiScrollbarOptions()`: map the setting to `{ visible: false }` or `undefined` (OpenTUI auto-hide).                                                     |
| `native-clipboard.ts`                      | Native clipboard bridge: writes and reads run in a Node child; reads use the in-process addon only when no child can run. Includes Windows/macOS text reads. |
| `jump-to-bottom-hint.tsx`                  | New tail predicate and floating hint.                                                                                                                        |
| `input-submission.ts` / `input-prompt.tsx` | Composer handle gains `pasteClipboard()`, which runs the existing Ctrl+V path.                                                                               |

### Behavior

1. On mouse selection completion, OpenTUI emits `selection`. The hook copies
   any non-empty selected text, without a transcript scope: footer, composer,
   dialogs, and other surfaces are included. The selection stays highlighted;
   on success the app shell shows the two-second `Copied N chars` toast at the
   bottom-right. The toast uses the jump hint's row when the hint is hidden and
   shifts up one row while the hint is visible, so bottom chrome always stacks
   from the bottom instead of leaving an empty slot. A failed clipboard write
   stays silent, and so does a copy made while a dialog, approval modal, tool
   confirmation, or the completion list is open: the toast is never mounted
   over a modal.
2. A right mouse-down anywhere in the shell is intercepted only when no dialog,
   approval modal, or tool confirmation is open. The handler sits on the root
   box and the transcript scrollbox; the scrollbox stops propagation so a click
   inside it is handled once. If a scoped selection with non-empty text exists,
   `handleTranscriptRightClick()` clears it. A plain left-click leaves OpenTUI
   with a zero-length selection whose container is the clicked text's parent;
   that does not count, so the next right-click still pastes. Otherwise it calls
   `composerHandle.current.pasteClipboard()`. Transcript item click handlers
   (thinking blocks, tool cards) check for the left button so the matching right
   mouse-up cannot toggle a card behind the paste.
3. `pasteClipboard()` delegates to the composer's existing Ctrl+V handler:
   clipboard image first, then text, with the same paste-collapsing and notices.
4. PageUp/PageDown use `ScrollBoxRenderable.scrollBy(±1, 'viewport')`.
   Ctrl+Home/Ctrl+End use `scrollTo(0)` / `scrollTo(scrollHeight)`. The keys
   come from the shared `PAGE_UP`, `PAGE_DOWN`, `SCROLL_HOME`, and `SCROLL_END`
   bindings, so Ctrl+PageUp/PageDown also scroll and a rebinding reaches both
   renderers. They are ignored while the foreground shell, a dialog, or a
   confirmation owns input.
5. The jump-to-bottom hint listens to the scrollbar's `change` event and
   re-checks after each render for streaming growth. It reports its visibility
   to the shell so the copy toast can stack above it. It is not mounted behind
   dialogs, confirmations, or the completion list.
6. The transcript scrollbox receives
   `scrollbarOptions={openTuiScrollbarOptions(settings.merged.ui?.showOpenTuiScrollbar)}`.
   Missing/false hides the bar; true leaves `scrollbarOptions` undefined so
   OpenTUI keeps its own auto-hide behavior.
7. Linux clipboard writes use the shared `copyToClipboard()` dispatch:
   `wl-copy` → `xclip` → `xsel` → native `@teddyzhu/clipboard` addon → OSC 52.
   Native writes always run in a Node child, even when the addon loads in
   process: clipboard-rs prints ownership diagnostics such as
   `Somebody else owns the clipboard now` to stdout while replacing an X11
   owner, and in-process that stdout is the TUI's alternate screen, so the
   message would land on the composer row. The child's stdout is a pipe. It
   stays alive for 150 ms after `setClipboardText()` so the OS clipboard
   manager can take ownership. An X11 selection dies with its owner when no
   clipboard manager takes it, so after a successful write the bridge reads the
   clipboard back through a second child; when the text did not persist the
   copy reports failure and `copyToClipboard()` falls through to OSC 52 instead
   of confirming a copy that is gone. Reads also run in the child for the same
   reason, and use the addon in process only when no Node child can start (for
   example, no Node on PATH); a child that ran and failed does not fall back.
   The Node path comes from `QWEN_NODE_BINARY` (set by the npm Bun handoff) or
   `NVM_BIN`, since Bun's snap PATH may omit nvm.
   Right-click paste uses the same addon fallback for reads only when no
   `wl-paste`/`xclip` is installed; a reachable tool's answer, including an
   empty clipboard, is final. Reads retry the addon's transient
   `Somebody else owns the clipboard now` ownership error, and that string is
   filtered out of the read result so it can never be pasted as text. The read
   helper frames its payload with a marker so any native stdout diagnostics are
   discarded; the first marker is the helper's, so clipboard text that itself
   contains the marker is kept whole. An over-cap payload is dropped instead of
   pasted truncated.

### Platform notes

- **macOS**: writes use the built-in `pbcopy`; `readClipboardText()` now reads
  text through the `@teddyzhu/clipboard` addon, so right-click text paste works
  when OpenTUI runs there. The npm package already ships Bun, the
  `libopentui.dylib` asset, and the clipboard addon for arm64 and x64.
- **Windows**: writes use `cmd /c chcp 65001 && clip`; text and image reads use
  the addon, with `win32-x64-msvc` and `win32-arm64-msvc` declared. OpenTUI npm
  packaging is still pending: Bun publishes only `@oven/bun-windows-x64` (no
  Windows ARM64), and the npm handoff does not list the Windows package yet.
- **Non-Linux text reads** are normalized and trailing newlines are dropped, so
  a copied line does not paste as an extra blank row.

### Settings

Add under `ui` in `settingsSchema.ts`:

```json
"showOpenTuiScrollbar": false
```

- Label: `Show Scrollbar (OpenTUI)`.
- `requiresRestart: true` so the scrollbox is rebuilt with the new option
  instead of relying on a removed prop to reset visibility.
- Default `false` gives the conversation the extra column.

### i18n

The new user-facing strings are:

- the new `Jump to bottom (ctrl+End)` hint key in `MUST_TRANSLATE_KEYS` and
  all built-in locales;
- `Copied {{count}} chars` and its singular `Copied 1 char`, also in
  `MUST_TRANSLATE_KEYS` and every locale.

## Files affected

- `packages/cli/src/ui/opentui/renderable-tree.ts` (new)
- `packages/cli/src/ui/opentui/selection-auto-copy.ts` (new)
- `packages/cli/src/ui/opentui/copy-notice.tsx` (new)
- `packages/cli/src/ui/opentui/transcript-mouse.ts` (new)
- `packages/cli/src/ui/opentui/scrollbar-visibility.ts` (new)
- `packages/cli/src/ui/utils/native-clipboard.ts` (new Linux fallback)
- `packages/cli/src/ui/utils/commandUtils.ts` / `clipboardUtils.ts` (fallback
  integration)
- `packages/cli/src/utils/npm-runtime.ts` (pass the Node binary to Bun)
- `packages/cli/src/ui/opentui/jump-to-bottom-hint.tsx` (new)
- `packages/cli/src/ui/opentui/transcript-view.tsx` (left-button guard on item
  clicks)
- `packages/cli/src/ui/opentui/input-submission.ts`
- `packages/cli/src/ui/opentui/input-prompt.tsx`
- `packages/cli/src/ui/opentui/opentui-app-shell.tsx`
- `packages/cli/src/config/settingsSchema.ts`
- `packages/cli/src/i18n/mustTranslateKeys.ts` and the nine locale files
- New tests beside the new modules and updated app-shell tests

## Key decisions

- **Right-click is a two-way switch.** Selection means "dismiss", no selection
  means "paste". There is no menu, so the behavior stays predictable.
- **Paste is shell-wide; clearing is transcript-scoped.** The handler sits on
  the root box and the scrollbox, so composer, footer, and status areas paste.
  Only a transcript selection suppresses paste; a composer selection does not.
- **Bottom-right chrome stacks from the bottom.** The jump hint owns the bottom
  row; the copy toast moves into that row when the hint is hidden and up one
  row when it appears, rather than always reserving two rows.
- **Auto-copy every OpenTUI selection.** The hook has no transcript scope, so
  footer, composer, dialog, and other region selections also copy; the
  right-click policy remains transcript-only.
- **Reuse the composer's Ctrl+V path.** The clipboard may hold an image, a
  large paste, or text that needs placeholder collapsing; a second paste
  implementation would drift.
- **Hide the scrollbar by default, opt in through settings.** `undefined`
  (`showOpenTuiScrollbar` unset or false) passes `{ visible: false }`; explicit
  true leaves OpenTUI's normal visibility logic in place.
- **Restart-scoped setting.** The scrollbox option is structural; a restart
  avoids a stale hidden bar after the setting is turned back on.

## Risks and limitations

- Clipboard writes on Linux prefer `wl-copy`/`xclip`/`xsel`, then the native
  addon, then OSC 52. With none available, OSC 52 may be ignored by VTE even
  though the write reports success; install `wl-clipboard` for the most
  reliable result. The native addon's Bun → Node child path requires a Node
  executable; the snap Bun package cannot spawn the nvm Node (use the bundled
  Bun 1.4.4 for local OpenTUI builds). The child lingers 150 ms after writing
  so the clipboard manager can take over; without that pause an immediate
  right-click read often sees an empty clipboard. On X11 with no clipboard
  manager the native copy cannot outlive the child; the read-back turns that
  into a fallback to OSC 52, which a terminal may still ignore.
- Auto-copy covers every OpenTUI selection, including composer and dialog text;
  copying while editing is intentional but may overwrite the clipboard.
- Right-click paste depends on `ui.mouseTracking`; disabling it returns the
  mouse to the terminal.
- The scrollbar setting requires a restart and is OpenTUI-specific.

## Validation plan

- Unit tests for `isRenderableWithin`, selection auto-copy from any region /
  empty text / failure / unsubscribe, the copy toast count and timeout, the
  jump hint's visibility callback, right-click clear-vs-paste and non-right
  buttons, scrollbar option mapping, the scroll-tail predicate, and hint
  visibility/click; native clipboard bridge tests cover in-process, Node-child,
  copy read-back, read normalization, the ownership-error filter, marker
  framing, overflow, and failure branches, and helper-script tests run the real
  copy/read scripts in Node children against a fake addon (round trip, busy
  retry, and a Node binary that cannot spawn); `readClipboardText()` tests
  cover darwin/win32 reading through the addon, dropping trailing whitespace,
  and not spawning the addon after a reachable tool reports an empty clipboard.
- App shell tests: right-click without selection calls `pasteClipboard`;
  right-click on the footer (outside the scrollbox) also pastes; with a scoped
  selection calls `clearSelection` and not paste; a zero-length selection left
  by a plain click still pastes; PageUp/PageDown (including Ctrl+PageUp) and
  Ctrl+Home/End still pass. Composer tests paste through the mounted handle,
  and transcript tests pin that a right mouse-up does not expand a thought or a
  tool card.
- Manual E2E with the bundled Bun OpenTUI build: select transcript/footer/
  composer text and verify auto-copy + toast, and dialog text copies without a
  toast; right-click paste;
  right-click dismiss; PageUp/PageDown; Ctrl+Home/End; jump hint; hidden
  scrollbar by default; `ui.showOpenTuiScrollbar: true` after restart.
- i18n must-translate suite and focused OpenTUI suites.

## Open questions

- Should the scrollbar setting live under a renderer-specific subgroup if more
  OpenTUI-only options appear? Revisit when a second option exists.
