# Web Shell sidebar session scope

## Goal

Keep the sidebar daemon-scoped while the composer selects the target for the
next session. Present standalone sessions as the "No workspace" peer of
registered workspaces, and preserve that ownership in the archive.

## Behavior

- Selecting "No workspace" changes only the pending creation context. A
  standalone URL is written only after a standalone session has an id.
- The project header owns Search, Add workspace, and Manage workspaces.
- Active standalone sessions render under "No workspace sessions" in Projects.
- Archived sessions render under workspace headings, including "No workspace".
- A locked workspace hides every standalone surface and global workspace
  management action.
- Live conversations are hidden for embedded hosts by default; the standalone
  development entry point opts in with `showLive: true`.
- Standalone attachments use the session's private runtime directory rather
  than a registered workspace.
- Project Git actions, Session Overview, Split View, and other sidebar project
  navigation remain available while the composer targets a standalone session.
  Session-local workspace controls in the chat surface remain unavailable.

## Implementation

Reuse `pendingSessionContext` for composer intent and keep sidebar availability
based on workspace capabilities. Split `StandaloneRecents` presentation into
active and archived slots. A shared refresh key invalidates both slots after a
mutation; refreshing reloads the already-visible pagination depth so removed
rows cannot survive as stale client state. An interrupted pagination request
releases its loading state when the refresh starts.
