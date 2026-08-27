# Qwen Code Keyboard Shortcuts

This document lists the available keyboard shortcuts in Qwen Code.

## General

| Shortcut                       | Description                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Esc`                          | Close dialogs and suggestions. With an empty prompt, cancel an ongoing request; when idle outside IDE mode, press twice to open the rewind selector.                                                                                               |
| `Ctrl+C`                       | Cancel the ongoing request and clear the input. Press twice to exit the application.                                                                                                                                                               |
| `Ctrl+D`                       | Exit the application if the input is empty. Press twice to confirm.                                                                                                                                                                                |
| `Ctrl+L`                       | Clear the screen.                                                                                                                                                                                                                                  |
| `Ctrl+O` / `Alt/Option+T`      | Toggle expanded detail mode: expand or collapse all thinking blocks and tool outputs inline. Press again to collapse. When `ui.useTerminalBuffer` is off, toggling redraws the full conversation with untruncated output into terminal scrollback. |
| `Ctrl+S`                       | Stashes non-empty input for the current project and restores it on the next launch. With empty input, allows long responses to print fully, disabling truncation. Use your terminal's scrollback to view the entire output.                        |
| `Ctrl+T`                       | Toggle the display of tool descriptions.                                                                                                                                                                                                           |
| `Alt/Option+M`                 | Toggle Markdown output between rich rendered previews and raw/source mode. On macOS, the terminal must send Option as Meta.                                                                                                                        |
| `Shift+Tab` (`Tab` on Windows) | Cycle approval modes (`plan` → `default` → `auto-edit` → `auto` → `yolo`)                                                                                                                                                                          |

## Input Prompt

| Shortcut                                              | Description                                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `!`                                                   | Toggle shell mode when the input is empty.                                                                                          |
| `?`                                                   | Toggle keyboard shortcuts display when the input is empty.                                                                          |
| `/`                                                   | Open slash-command completion.                                                                                                      |
| `@`                                                   | Open completion for files, folders, and other context.                                                                              |
| `Space` (empty prompt)                                | Start voice dictation when it and a voice model are configured; hold or tap behavior follows `general.voice.mode`.                  |
| `Ctrl+Enter` / `Cmd+Enter` / `Shift+Enter` / `Ctrl+J` | Insert a newline.                                                                                                                   |
| `Down Arrow`                                          | Row down, then snap to end, then history next.                                                                                      |
| `Enter`                                               | Submit the current prompt. While a response is running, steer the current turn.                                                     |
| `Ctrl+Q`                                              | Queue the current prompt or command for the next turn instead of steering; it runs after Qwen Code returns to idle.                 |
| `Up Arrow` (at the top) / `Esc`                       | When queued messages are present, move them back into the input for editing.                                                        |
| `Meta+D` / `Meta+Delete` / `Ctrl+Delete`              | Delete the word to the right of the cursor.                                                                                         |
| `Tab`                                                 | Autocomplete the current suggestion if one exists.                                                                                  |
| `Up Arrow`                                            | Row up, then snap to start, then history prev.                                                                                      |
| `Ctrl+A` / `Home`                                     | Move the cursor to the beginning of the line.                                                                                       |
| `Ctrl+B` / `Left Arrow`                               | Move the cursor one character to the left.                                                                                          |
| `Ctrl+C`                                              | Clear the input prompt                                                                                                              |
| `Esc` (double press)                                  | Clear the input prompt.                                                                                                             |
| `Ctrl+D` / `Delete`                                   | Delete the character to the right of the cursor.                                                                                    |
| `Ctrl+E` / `End`                                      | Move the cursor to the end of the line.                                                                                             |
| `Ctrl+F` / `Right Arrow`                              | Move the cursor one character to the right.                                                                                         |
| `Ctrl+H` / `Backspace`                                | Delete the character to the left of the cursor.                                                                                     |
| `Ctrl+K`                                              | Delete from the cursor to the end of the line.                                                                                      |
| `Ctrl+Left Arrow` / `Meta+Left Arrow` / `Meta+B`      | Move the cursor one word to the left.                                                                                               |
| `Ctrl+N`                                              | Row down, then snap to end, then history next.                                                                                      |
| `Ctrl+P`                                              | Row up, then snap to start, then history prev.                                                                                      |
| `Ctrl+R`                                              | Reverse search through input/shell history.                                                                                         |
| `Ctrl+Y`                                              | Retry the last failed request.                                                                                                      |
| `Ctrl+Right Arrow` / `Meta+Right Arrow` / `Meta+F`    | Move the cursor one word to the right.                                                                                              |
| `Ctrl+U`                                              | Delete from the cursor to the beginning of the line.                                                                                |
| `Ctrl+V` / `Option+V` (Windows: `Alt+V`)              | Paste clipboard content. If the clipboard contains an image, it will be saved and a reference to it will be inserted in the prompt. |
| `Ctrl+W` / `Meta+Backspace` / `Ctrl+Backspace`        | Delete the word to the left of the cursor.                                                                                          |
| `Ctrl+X`                                              | Open the current input in an external editor.                                                                                       |
| `Ctrl+Z`                                              | Undo the last input edit.                                                                                                           |
| `Ctrl+Shift+Z`                                        | Redo the last undone input edit.                                                                                                    |

## Foreground Shell

These shortcuts apply while an interactive foreground shell command is running.

| Shortcut                            | Description                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+F`                            | Toggle keyboard focus between the shell and the prompt. When no shell is running, `Ctrl+F` moves the prompt cursor right.                                      |
| `Ctrl+Shift+Up` / `Ctrl+Shift+Down` | Scroll the focused shell up or down.                                                                                                                           |
| `Ctrl+B`                            | Promote the shell to a background task. The child keeps running, the agent's turn unblocks, and the shell appears in `/tasks` and the Background tasks dialog. |

## Suggestions

| Shortcut                             | Description                                                              |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `Down Arrow` / `Ctrl+N`              | Navigate down through the suggestions.                                   |
| `Tab` / `Enter`                      | Accept the selected suggestion.                                          |
| `Up Arrow` / `Ctrl+P`                | Navigate up through the suggestions.                                     |
| `Right Arrow`                        | Accept a ghost-text suggestion when the prompt is empty.                 |
| `Ctrl+Tab` / `Ctrl+Right Arrow`      | Switch to the next completion category when category tabs are shown.     |
| `Ctrl+Shift+Tab` / `Ctrl+Left Arrow` | Switch to the previous completion category when category tabs are shown. |

## History Search

Press `Ctrl+R` to search prompt history, or shell history while shell mode is active.

| Shortcut                     | Description                                                |
| ---------------------------- | ---------------------------------------------------------- |
| `Up Arrow` / `Down Arrow`    | Navigate through matching history entries.                 |
| `Left Arrow` / `Right Arrow` | Collapse or expand a long selected entry.                  |
| `Tab`                        | Accept the selected entry into the prompt without sending. |
| `Enter`                      | Submit the selected entry.                                 |
| `Esc`                        | Close history search.                                      |

## Radio Button Select

| Shortcut                      | Description                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Down Arrow` / `j` / `Ctrl+N` | Move selection down.                                                                                          |
| `Enter`                       | Confirm selection.                                                                                            |
| `Up Arrow` / `k` / `Ctrl+P`   | Move selection up.                                                                                            |
| `1-9`                         | Select an item by its number.                                                                                 |
| (multi-digit)                 | For items with numbers greater than 9, press the digits in quick succession to select the corresponding item. |

## History scrollback

Active when `ui.useTerminalBuffer` is enabled (Settings → UI → Virtualized History), screen reader mode is off, and Qwen Code is running in a compatible interactive terminal (`stdout` is a TTY, CI is inactive, and `TERM` is not `dumb`), which is the default for ordinary non-screen-reader sessions. In that mode conversation history is rendered inside an in-app viewport instead of the host terminal scrollback, so the keys below replace the terminal's native scroll.

| Shortcut        | Description                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Shift+Up`      | Scroll history up one line.                                                                                                                        |
| `Shift+Down`    | Scroll history down one line.                                                                                                                      |
| `PgUp`          | Scroll history up one page (viewport height).                                                                                                      |
| `PgDn`          | Scroll history down one page (viewport height).                                                                                                    |
| `Ctrl+Home`     | Jump to the top of the conversation.                                                                                                               |
| `Ctrl+End`      | Jump to the bottom (and re-engage live auto-follow).                                                                                               |
| **Mouse wheel** | Scroll history (3 lines per tick). Requires `ui.mouseTracking` (on by default).                                                                    |
| **Ctrl+click**  | Open an http(s) hyperlink under the pointer in your browser (other link schemes are copied to the clipboard instead). Requires `ui.mouseTracking`. |
| **Right-click** | Over a link or a text selection, open an in-app context menu (Open Link / Copy Link Address / Copy Selection). Requires `ui.mouseTracking`.        |

When `ui.useTerminalBuffer` is on and `ui.mouseTracking` is enabled (the default), the terminal forwards mouse events to qwen-code so the wheel can drive the in-app viewport. As a side effect, native mouse behaviors are consumed by the program, so qwen-code provides its own equivalents:

- **Text selection:** drag to select text in the history viewport, double-click to select a word, triple-click to select a line. The selection is highlighted and copied to the clipboard when you release the mouse (works locally, over SSH via OSC 52, and inside tmux). A single click clears the selection; scrolling or new output clears it too. Selection is limited to the visible viewport for now.
- **Hyperlinks:** `Ctrl+click` a link to open it in your browser (on terminals such as iTerm2 that intercept `⌘+click` themselves, that native gesture is expected to keep working). `Ctrl` is used because `Shift`/`Option` stay reserved for the terminal-selection bypass below, and plain clicks keep their existing behavior. Only http(s) links open in the browser; other link schemes (mailto:, ftp:, ssh:, …) are copied to the clipboard instead.
- **Right-click menu:** right-click over a hyperlink or an active text selection opens a small context menu (right-click on plain text is a deliberate no-op). Over a hyperlink it offers **Open Link** and **Copy Link Address**; over an active text selection it offers **Copy Selection**. Navigate it with the mouse or `↑`/`↓` + `Enter`, and dismiss it with `Esc`, a click elsewhere, or scrolling.

You can still fall back to the terminal's own selection by holding `Shift` (or `Option` on macOS Terminal / iTerm) while dragging. Set `ui.mouseTracking` to `false` to stop qwen-code from capturing the mouse entirely and hand every mouse gesture back to the terminal (native right-click menu, link clicks, and click-and-drag selection); the in-app viewport then no longer responds to the mouse, so use the keyboard shortcuts above to scroll.

### tmux trackpad scrolling

Inside tmux, some terminals translate trackpad or wheel gestures into plain `Up Arrow` and `Down Arrow` sequences before qwen-code sees them. Those bytes are identical to real arrow-key presses, so qwen-code cannot tell whether you meant to scroll the viewport or navigate prompt history.

If trackpad scrolling changes the prompt history in tmux, make sure `ui.useTerminalBuffer` is enabled; then use `Shift+Up` / `Shift+Down`, or the mouse wheel when tmux forwards wheel events to the app (requires `ui.mouseTracking`). If you prefer host scrollback, adjust your tmux mouse bindings for wheel events.

## IDE Integration

| Shortcut | Description                       |
| -------- | --------------------------------- |
| `Ctrl+G` | See context CLI received from IDE |
