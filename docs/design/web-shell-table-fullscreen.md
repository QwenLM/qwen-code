# Web Shell table fullscreen

[English](web-shell-table-fullscreen.md) | [简体中文](web-shell-table-fullscreen.zh-CN.md)

## Problem and scope

The standalone Web Shell uses enhanced Markdown tables in conversation history.
Their width follows the message column and their scroll area is limited to
`min(75vh, 720px)`. Large tables are difficult to inspect there.

Add a viewport-filling view to enhanced tables. Keep basic Markdown rendering,
the existing 500-row / 50-column enhancement limits, daemon APIs, and persistence
unchanged. No browser Fullscreen API or new package dependency is needed.

## Design

Add a localized fullscreen toggle beside the existing table toolbar actions.
Render the existing table content in the shared Dialog when expanded, using its
Web Shell portal, modal focus management, and scroll lock. Keep table state in
the original EnhancedTable component so sorting, filters, column configuration,
density, selection, and row details survive both transitions.

Reserve the inline table's height while expanded. Preserve the table scroll
position across transitions and return focus to the fullscreen button on close.
The dialog fills the viewport; the toolbar stays visible while the table body
scrolls in both directions. Retain Markdown content styling in the portal.

Register an interaction blocker while expanded. Escape closes the innermost
menu or cell dialog first, then fullscreen, without triggering chat shortcuts.
The existing scoped portal preserves themes, including Shadow DOM hosts.
Resolve focus within the actual DOM root and contain Tab navigation in Shadow
DOM, where document-level focus tracking sees only the portal host.
Reattach frozen-column measurement when the table moves between render targets.

## Affected files

- `packages/web-shell/client/components/messages/EnhancedMarkdownTable.tsx`
- `packages/web-shell/client/components/messages/EnhancedMarkdownTable.module.css`
- Collocated component tests and browser regression coverage.

Reuse existing `common.fullscreen` and `common.exitFullscreen` translations.

## Validation and acceptance

- The toolbar opens one viewport-filling table and offers an accessible exit.
- Sorting, filtering, column widths, density, and row details survive toggling.
- Both axes scroll for large tables; headers and the toolbar remain usable.
- Cell details and filter popovers remain interactive inside fullscreen.
- Escape closes nested UI first; closing restores focus and reading position.
- Light/dark themes, narrow viewports, and scoped portals remain functional.
- Run focused unit/browser tests, build, typecheck, and bundle; inspect the diff.

## Open questions

None. Fullscreen is temporary component state and is reset on unmount.
