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
Selecting or managing a session keeps the Popover open so several operations
can be performed in sequence. Pointer-opened content closes after the pointer
leaves, while outside clicks and Escape keep their normal dismissal behavior.
Focus moved to the composer after a session switch must not dismiss the
Popover, and a workspace prop catching up with an already loaded session must
not trigger a second load.

The Project icon shows the same pulsing status color used by expanded session
rows when any visible workspace has a completed session or needs approval or
an answer. Approval takes precedence over questions, which take precedence
over completion.
