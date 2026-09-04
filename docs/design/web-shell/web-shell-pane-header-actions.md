# Web Shell split-pane header actions

## Goal

Let a host embedding `@qwen-code/web-shell` contribute per-session actions to
each split-view pane header, next to the built-in close control, and collapse
those actions into a `…` overflow menu when the pane is too narrow to show them
inline without crushing the title.

## Problem

Split view mounts one `DaemonSessionProvider` per pane. Host actions such as
environment, artifacts, context usage, and share are per session, so a toolbar
above the whole split is ambiguous. Today `ChatPane` has no header render slot,
and `renderChatHeader`-style slots (if any) sit above the transcript, not in the
pane title bar. Hosts either drop those actions while split is open or inject
into hashed CSS-module DOM.

## Design

### API

- `ChatPaneProps.renderHeaderActions?: (info) => ReactNode` where
  `info = { sessionId: string; workspaceCwd?: string }`.
- `SplitViewProps.renderPaneHeaderActions` and
  `WebShellProps.renderPaneHeaderActions` passthrough the same callback into
  each pane. Hosts that drive split via `splitSessionIds` /
  `onSplitSessionIdsChange` do not need to render `SplitView` themselves.

### Layout

Header row: optional workspace tag | truncating title | host actions |
maximize | close. Host actions render before the built-in maximize/close
controls, which always stay visible outside the overflow menu.

### Overflow

Web-shell owns measurement. Host actions render once into a single host slot; a
`ResizeObserver` on the header compares that slot's natural width against the
remaining space after a minimum title width (reserving room for the workspace
tag and the built-in trailing controls). When the actions no longer fit, the
host slot is hidden in place (`visibility: hidden`, absolutely positioned) so
stateful actions stay mounted across collapse, and the actions are listed in a
`…` dropdown (Radix `DropdownMenu` via the shared UI wrapper / portal root)
that proxies a click to the interactive element inside each hidden slot. The
built-in maximize/close controls stay visible outside the menu so panes remain
dismissible without opening the overflow.

### Scope

- In: prop surface, ChatPane header UI, overflow collapsing, unit tests, i18n
  for the overflow trigger.
- Out: maximize/restore pane chrome, changing host action content, single-
  session (non-split) toolbars.

## Files

| Area        | Files                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| Pane header | `ChatPane.tsx`, `ChatPane.module.css`, optional small header-actions helper |
| Passthrough | `SplitView.tsx`, `App.tsx` (`WebShellProps`)                                |
| i18n        | `i18n.tsx`                                                                  |
| Tests       | `ChatPane.test.tsx`, `SplitView.test.tsx`, optionally `App.test.tsx`        |
