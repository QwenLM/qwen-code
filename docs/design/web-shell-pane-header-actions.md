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

Header row: truncating title | host actions | close. Host actions render before
close. There is no maximize control today; the slot sits where the issue
described (before built-in header buttons).

### Overflow

Web-shell owns measurement: a hidden measure row holds a second render of the
host actions; a `ResizeObserver` on the header compares that natural width plus
close (and the overflow trigger when collapsed) against remaining space after a
minimum title width. When it no longer fits, host actions move into a `…`
dropdown (Radix `DropdownMenu` via the shared UI wrapper / portal root). Close
stays visible outside the menu so panes remain dismissible without opening the
overflow.

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
