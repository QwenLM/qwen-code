# Web Shell advanced table controls

[English](web-shell-advanced-table-controls.md) | [简体中文](web-shell-advanced-table-controls.zh-CN.md)

## Goal

Align the advanced Markdown table with the updated Web Shell design while
preserving cell selection, statistics, filtering, sorting, resizing, row
details, full-value dialogs, copying, and first-column freezing.

## Design

- Keep row counts and selection statistics on the left of a compact toolbar.
  Show selection copy beside those statistics, and group density, column
  customization, and visible-table copy on the right.
- Sort only from the dedicated header icon. Filter popovers contain filtering
  controls only.
- Manage table-column visibility and order from one shadcn-based popover.
- Manage row-detail fields independently in the same popover. Detail fields
  keep source order and are not draggable.
- Keep at most one expanded row. Its panel contains only selected detail fields.
- Reset restores source column order and the initial visible/detail selections.
- Density and copy use the same dropdown positioning, styling and keyboard
  interaction. Density keeps a single selected option with a checkmark.
- The Copy action offers text (tab-separated) and Markdown for the current visible rows
  and column order.
  Markdown preserves the table structure and literal cell text, not inline
  formatting or link destinations. Escape Markdown punctuation and HTML-like
  text, and encode CRLF, CR and LF as table-cell line breaks.
- At toolbar widths up to 500px, copying and expanding text use icons only,
  with accessible button names. Copy success is announced by a polite status.
- Keep a single sort icon, with color and opacity identifying its direction
  so the visual state does not rely on color alone.
- Drag selection scrolls at the edges, including the left action gutter and
  frozen columns. Capture the initial pointer position; track movement only
  during selection and run animation frames only while an edge can scroll.
- Keep toolbar-menu keyboard entry and focus restoration usable in Shadow DOM.

## Compatibility

The underlying Markdown table data and public customization API are unchanged.
Preserve source GFM cell alignment. Table state remains local to
`EnhancedMarkdownTable`, with copying using the shared clipboard utility.
No daemon or persistence changes are required.
Copying remains available when the async Clipboard API is absent.

## Validation

- Verify literal Markdown copying, CR/LF, empty cells, filtering, hidden and
  reordered columns, copy feedback and selection dismissal in unit tests.
- Verify native clipboard fallback readback in inline and Shadow DOM fullscreen
  menus when the async Clipboard API is absent.
- Verify narrow-screen controls, non-color sort cues, Shadow DOM keyboard
  entry, stationary edge presses, selection growth through the action gutter
  and stopping after release in browser tests with the mock daemon.
- Build and typecheck, inspect screenshots, and measure the transcript entry
  and exported HTML renderer before updating their intentional size tripwires.
