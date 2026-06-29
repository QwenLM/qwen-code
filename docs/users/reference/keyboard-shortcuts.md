# Qwen Code Keyboard Shortcuts

This document lists the available keyboard shortcuts in Qwen Code.

## General

| Shortcut                       | Description                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Esc`                          | Close dialogs and suggestions.                                                                                                                                                                                                                                                                            |
| `Ctrl+C`                       | Cancel the ongoing request and clear the input. Press twice to exit the application.                                                                                                                                                                                                                      |
| `Ctrl+D`                       | Exit the application if the input is empty. Press twice to confirm.                                                                                                                                                                                                                                       |
| `Ctrl+L`                       | Clear the screen.                                                                                                                                                                                                                                                                                         |
| `Ctrl+O`                       | Toggle compact mode (hide/show tool output and thinking).                                                                                                                                                                                                                                                 |
| `Ctrl+S`                       | Allows long responses to print fully, disabling truncation. Use your terminal's scrollback to view the entire output.                                                                                                                                                                                     |
| `Ctrl+T`                       | Toggle the display of tool descriptions.                                                                                                                                                                                                                                                                  |
| `Ctrl+B`                       | While a foreground shell command is running: promote it to a background task. The child keeps running, the agent's turn unblocks, and the shell appears in `/tasks` + the Background tasks dialog. No-op when no shell is executing — Ctrl+B then falls through to its prompt-area binding (cursor-left). |
| `Alt/Option+M`                 | Toggle Markdown output between rich rendered previews and raw/source mode. On macOS, the terminal must send Option as Meta.                                                                                                                                                                               |
| `Shift+Tab` (`Tab` on Windows) | Cycle approval modes (`plan` → `default` → `auto-edit` → `auto` → `yolo`)                                                                                                                                                                                                                                 |

## Input Prompt

| Shortcut                                              | Description                                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `!`                                                   | Toggle shell mode when the input is empty.                                                                                          |
| `?`                                                   | Toggle keyboard shortcuts display when the input is empty.                                                                          |
| `Ctrl+Enter` / `Cmd+Enter` / `Shift+Enter` / `Ctrl+J` | Insert a newline.                                                                                                                   |
| `Down Arrow`                                          | Row down, then snap to end, then history next.                                                                                      |
| `Enter`                                               | Submit the current prompt.                                                                                                          |
| `Meta+Delete` / `Ctrl+Delete`                         | Delete the word to the right of the cursor.                                                                                         |
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
| `Ctrl+V` (Windows: `Alt+V`)                           | Paste clipboard content. If the clipboard contains an image, it will be saved and a reference to it will be inserted in the prompt. |
| `Ctrl+W` / `Meta+Backspace` / `Ctrl+Backspace`        | Delete the word to the left of the cursor.                                                                                          |
| `Ctrl+X` / `Meta+Enter`                               | Open the current input in an external editor.                                                                                       |

## Suggestions

| Shortcut                | Description                            |
| ----------------------- | -------------------------------------- |
| `Down Arrow` / `Ctrl+N` | Navigate down through the suggestions. |
| `Tab` / `Enter`         | Accept the selected suggestion.        |
| `Up Arrow` / `Ctrl+P`   | Navigate up through the suggestions.   |

## Radio Button Select

| Shortcut                      | Description                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Down Arrow` / `j` / `Ctrl+N` | Move selection down.                                                                                          |
| `Enter`                       | Confirm selection.                                                                                            |
| `Up Arrow` / `k` / `Ctrl+P`   | Move selection up.                                                                                            |
| `1-9`                         | Select an item by its number.                                                                                 |
| (multi-digit)                 | For items with numbers greater than 9, press the digits in quick succession to select the corresponding item. |

## History scrollback

Active only when `ui.useTerminalBuffer` is enabled (Settings → UI → Virtualized History). In that mode conversation history is rendered inside an in-app viewport instead of the host terminal scrollback, so the keys below replace the terminal's native scroll.

| Shortcut        | Description                                          |
| --------------- | ---------------------------------------------------- |
| `Shift+Up`      | Scroll history up one line.                          |
| `Shift+Down`    | Scroll history down one line.                        |
| `PgUp`          | Scroll history up one page (viewport height).        |
| `PgDn`          | Scroll history down one page (viewport height).      |
| `Ctrl+Home`     | Jump to the top of the conversation.                 |
| `Ctrl+End`      | Jump to the bottom (and re-engage live auto-follow). |
| **Mouse wheel** | Scroll history (3 lines per tick).                   |

When `ui.useTerminalBuffer` is on, the terminal forwards mouse events to qwen-code so the wheel can drive the in-app viewport. As a side effect, **native click-and-drag text selection is consumed by the program** — hold `Shift` (or `Option` on macOS Terminal / iTerm) while dragging to bypass mouse capture and select text the usual way.

### tmux trackpad scrolling

Inside tmux, some terminals translate trackpad or wheel gestures into plain `Up Arrow` and `Down Arrow` sequences before qwen-code sees them. Those bytes are identical to real arrow-key presses, so qwen-code cannot tell whether you meant to scroll the viewport or navigate prompt history.

If trackpad scrolling changes the prompt history in tmux, enable `ui.useTerminalBuffer`; then use `Shift+Up` / `Shift+Down`, or the mouse wheel when tmux forwards wheel events to the app. If you prefer host scrollback, adjust your tmux mouse bindings for wheel events.

## IDE Integration

| Shortcut | Description                       |
| -------- | --------------------------------- |
| `Ctrl+G` | See context CLI received from IDE |
