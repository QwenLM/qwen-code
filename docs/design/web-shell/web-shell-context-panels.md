# Web Shell context panels

## Goal

Add a persistent header to active chat sessions and move supported workspace
and background-task context into a fixed-width environment panel. Keep the
existing artifact panel as an independent right-side surface.

## Header

The active chat header is opt-in so existing integrations without header props
keep their previous layout. Passing `header` enables the default header, whose
content is the current session title. `header.items` controls the title,
environment action, and artifact-panel action independently; an empty items
array hides the complete header. Passing `renderChatHeader` also enables the
header and replaces it completely; the renderer receives the session metadata,
enabled items, controlled panel state, and panel open-change callbacks. The
compact sidebar toggle remains owned by `sidebar` and renders outside the
custom header. While the artifact panel is closed, its toggle is in the chat
header. While it is open, that same toggle moves to the right edge of the
artifact-panel header, leaving the environment action at the right edge of the
chat header adjacent to the panel.

The artifact-panel action remains available when no tab exists. Opening an
The empty panel shows Review and, when session-source metadata is supported,
side-task history plus New side task. Once a tab is open, the panel header add
menu contains Review and New side task without repeating the side-task history.
Review opens the most recent transcript turn containing reviewable file
changes, is disabled when no such turn exists, and is hidden from the add menu
while a review tab is already open. Closing a populated artifact panel keeps
its tabs so the header action can reopen the existing content.

`rightPanel.items` independently controls whether Review and Side task appear
on the empty panel page. Both items are enabled by default.

## Side tasks

A side task is a distinct daemon thread session in the same workspace as its
parent. It renders the existing interactive chat pane, including the transcript,
composer, approval-mode selector, model selector, streaming state, and
permission handling. Creation uses the dedicated side-task endpoint to snapshot
the main session's complete persisted model context at that moment, then
continues independently. The snapshot is serialized against transcript writes,
so a side task can be created while the parent is responding without observing
a partial JSONL record. Inherited records are not replayed in the side-task
transcript; only messages created inside the side task are shown.

Side-task sessions record `sourceType: side_task` and the parent session id as
`sourceId`. The Web Shell session catalog filters this source type, so side
tasks do not appear as top-level sessions. With saved side tasks, hovering Side
task on the empty right-panel page opens a menu of those sessions and a New
action. With no saved task, clicking the row creates one directly. Selecting a
saved task restores it as a tab. Closing a tab only detaches its client; the
daemon transcript remains available for later conversation.

`/btw <question>` keeps the lightweight, one-shot BTW interaction.
`/btw side <question>` opens a new side-task draft and sends the question as
its first prompt when the daemon advertises `session_side_task`. Hosts can
trigger the same action through `shellRef.current.createSideTask()`.

## Environment panel

The environment panel uses only existing Web Shell capabilities:

- workspace path;
- Git branch and working-tree summary;
- working-tree diff and commit history entry points;
- configured agents entry point;
- background agent, shell, and monitor task summaries.

The environment action and environment section remain available throughout an
active chat session. A clean working tree is shown explicitly; agent and
background-task sections appear only when they have content.

`environmentPanel.items` independently controls the environment, subagent, and
background-task sections. All three sections are enabled by default.

The local `/fork` command refreshes the session task snapshot as soon as its
background agent launches. Fork agents have no parent transcript tool call, so
their right-panel detail resolves the virtual subagent session by agent task ID
instead of `toolUseId`.

The local `/tasks` command opens the environment panel and refreshes its task
snapshot instead of opening the legacy task dialog.

Side-task, subagent, and fork transcripts expose their own file changes and
artifacts through the main right panel. Their source session scopes tab
identities and workspace actions, so opening a nested output creates a separate
tab without replacing the main session's review or artifact tabs.

It is a fixed-width, non-resizable layout column styled as a floating card with
a border and shadow. At narrower message widths it opens as a dismissible
floating popover instead of consuming chat width.

The environment panel and artifact panel are independent. At desktop widths the
two may be visible together. When the viewport cannot fit both, the artifact
panel normally takes priority and the environment panel is hidden without
losing its open state. Opening a subagent or background task from the
environment panel keeps that panel visible beside the resulting detail. A
floating environment panel is positioned within the remaining message area and
never overlaps the artifact panel.

## Responsive behavior

The environment panel is hidden for split/full-page views. When the message
area cannot keep at least 800 pixels after docking the panel, the panel closes
and can be reopened as a floating popover. An open artifact panel takes
priority when both panels cannot fit, but the environment action remains
available for explicitly reopening the popover. The existing artifact drawer
behavior on narrow screens is unchanged. On desktop, the artifact panel is a
top-level layout column beside the chat shell, so it starts at the top of the
page and the chat header ends at the panel boundary.
