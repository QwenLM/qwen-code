# Session attachment references

## Problem

Embedding image base64 and file bytes in daemon requests, queues, events, and
replay data duplicates potentially large payloads. Attachments also need to
remain previewable after the daemon restarts.

## Design

The daemon writes image and arbitrary file bytes to the workspace runtime's attachment
directory and returns a filename-based reference:

```ts
{
  type: 'image' | 'resource';
  attachmentId: string;
  mimeType: string;
  size: number;
}
```

The attachment ID is the stored filename. Duplicate names use the platform
convention `name (1).ext`, `name (2).ext`, and so on. There is no in-memory
attachment index or sidecar metadata; MIME type and size are derived from the
stored file when it is read.

Prompt and mid-turn APIs carry references through queues, events, and
transcript metadata. The bridge resolves them only when dispatching to the ACP
child. The TypeScript session client hydrates the same references for previews
and replay rendering through the authenticated attachment route.
Text resources resolve as ACP text; other file formats resolve as ACP blobs, so
their original bytes are not decoded or altered in the browser.

## Ownership and lifecycle

- Storage lives at `~/.qwen/tmp/<workspace-hash>/attachments/session-<id>/`
  (or the equivalent custom runtime directory).
- The resolved live-session owner and client authorization protect every
  upload, read, and removal operation.
- Closing a daemon or detaching a client closes handles but keeps the files.
- Permanently deleting a session removes its attachment directory.
- No TTL, sweeper, retained-media cache, or restart reconstruction index is
  used.
- Each attachment is limited to 8 MiB. Sessions have no cumulative attachment
  size or count limit.

The unified capability is `session_attachments`; the unified HTTP surface is
`/session/:id/attachments`. There is no `session_media`, `/media`, or `mediaId`
compatibility path.
