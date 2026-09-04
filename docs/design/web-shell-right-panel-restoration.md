# Web Shell right-panel restoration

## Goal

Restore each session's right-panel open state, tab order, and active tab after a page reload without storing content payloads in browser storage.

## Design

`localStorage` stores one entry per logical session. Each tab is reduced to stable lookup fields such as attachment ID, source session ID, workspace path, artifact ID, task ID, tool-call ID, side-task session ID, or terminal ID and working directory. Runtime objects, transcript content, terminal output, diffs, blobs, data URLs, and live action objects are never persisted.

The panel shell is restored before paint, without an opening animation, and shows a skeleton while the session transcript or artifacts are loading. Tab metadata and content are restored only after both loads complete. Reloads and session switches use the same key-only restore path. Only the active attachment or cross-session task tab fetches its content immediately; inactive tabs fetch when selected. Workspace files, artifacts, and side tasks continue to use their existing lazy data sources.

The environment panel lists attachment metadata and session artifacts in separate, expanded sections. Both sections show skeletons while their APIs load. Attachment content is fetched only when its name is selected; no thumbnails or content payloads are loaded for the list.

Subagents come from a session-scoped agent snapshot rather than transcript pagination. The daemon merges persisted agent sidecars with the live task registry by agent ID, with live state winning. Web Shell fetches the snapshot after session load when the environment panel opens and polls every three seconds only while an agent is running; older daemons fall back to the existing task/transcript view.

Unsent composer previews have no durable session identity and are intentionally not restored.
