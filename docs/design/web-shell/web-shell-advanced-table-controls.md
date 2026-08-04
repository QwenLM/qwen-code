# Web Shell advanced table controls

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

## Compatibility

The underlying Markdown table data and public customization API are unchanged.
All behavior remains local to `EnhancedMarkdownTable`.
