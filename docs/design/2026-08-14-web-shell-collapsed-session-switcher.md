# Web Shell collapsed session switcher

## Goal

Keep session switching available while the sidebar is collapsed without adding
another navigation model.

## Design

The collapsed sidebar shows one Project icon in the scrolling navigation area.
Pointer hover or click opens a Popover containing the same complete session
browser used by the expanded sidebar. Source tabs, pinned and live sessions,
project search, workspace actions, grouping, preview limits, archived sessions,
and expansion preferences therefore follow one implementation in both states.
Selecting a session closes the Popover.
