# Statusline text selection

## Problem

Virtualized History enables terminal-wide mouse tracking, so the terminal cannot
provide native text selection. Qwen Code's application-level selection currently
accepts presses only inside the history viewport, leaving the footer/statusline
unselectable.

## Design

Keep one selection controller and give it an ordered list of selectable frame
rectangles. The history viewport remains the primary rectangle. The default
layout passes a ref for the rendered footer through `Composer`, and
`MainContent` supplies its measured rectangle as the second target.

The controller records which rectangle owns a selection when the press starts.
Drag coordinates remain clamped to that rectangle, and frame/layout changes are
compared only within it. Input, dialogs, scrollbars, and other controls remain
outside the selectable targets, so their existing mouse behavior is unchanged.

This applies only to the existing Virtualized History path. Normal-buffer mode
continues to use terminal-native selection.

## Verification

- Dragging within history still highlights and copies history text.
- Dragging within a multi-line footer highlights and copies footer text.
- Presses in the gap between the history and footer do not start a selection.
- Footer selection is cleared when its content or layout changes.
- A live Virtualized History session can copy visible statusline text.
