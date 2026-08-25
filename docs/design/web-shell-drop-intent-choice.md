# Web Shell dropped-file intent choice

## Problem

The composer currently infers intent from file type: image-only drops become
prompt attachments, while ordinary or mixed drops upload to the workspace and
insert `@` references. File type does not express user intent. A user may want
an image persisted in the workspace, or a text file attached only to the next
prompt.

## Design

When workspace upload is available, a drop containing one or more files opens
one modal with their names, sizes, and three actions:

- **Reference content** uses the existing prompt-attachment ingestion path.
  The original browser files remain local to the draft. On submit they upload
  unchanged to the daemon's session attachment store under the
  workspace-scoped Qwen runtime temp directory. Prompt JSON carries
  filename-based attachment IDs; the bridge resolves them only at dispatch.
- **Upload to workspace** uses the existing upload queue, configured upload
  directory, progress UI, and server-confirmed `@` reference insertion.
- **Cancel** discards the drop.

Every file type can be referenced. Multi-file drops use the same choice as
single files; the browser does not pre-disable referencing based on the
the files already present in the current draft.

The browser `File` objects are copied synchronously during the drop event, so
the choice does not depend on a `DataTransfer` after the event returns. The
dialog closes if the composer target changes or upload becomes unavailable.

When workspace upload is unavailable, drops keep the existing attachment
behavior instead of showing an upload action that cannot succeed. Host-level
`fileUploadEnabled={false}` retains its existing contract and disables all
file drag-in. Clipboard paste and the `@` panel upload item are unchanged.

File attachment chips are interactive before and after optimistic submission.
Opening one shows the referenced file in the right-side preview panel.
Completed workspace uploads and their file tags open the same panel by reading
the uploaded workspace path. Image attachments retain their existing thumbnail
and image-panel behavior.

## Storage and compatibility

The default attachment root is
`~/.qwen/tmp/<workspace-hash>/attachments/`, resolved through
`Storage.getProjectTempDir()` so custom runtime directories continue to work.
Each session owns `session-<encoded-session-id>/`. Files use their stored names
as attachment IDs, with ` (1)` suffixes for duplicates. Daemon shutdown and
client detach keep the directory; permanent session deletion removes it.

Images and files use the same `session_attachments` capability,
`/attachments` routes, and `attachmentId` references. There is no retained
media cache, TTL cleanup, in-memory filename index, or legacy `mediaId` path.

## Scope

Attachment admission limits are enforced by ingestion and the daemon rather
than by the choice dialog.
