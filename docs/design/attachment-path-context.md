# Attachment paths in model context

[English](attachment-path-context.md) | [简体中文](attachment-path-context.zh-CN.md)

## Problem and scope

Uploaded files are stored on disk, but dispatch only supplies their contents and
an `attachment:///` identifier (images only carry bytes and MIME type). A model
that needs the original file for a script must discover its location, sometimes
using memory. This fix supplies the location independently of memory. It does
not add Excel parsing, change browser previews, or add a new tool.

## Design

The session attachment store adds a model-context string to the existing
content block's `_meta[DAEMON_ATTACHMENT_CONTEXT_META_KEY]`. It contains the
stored name, attachment URI, MIME type, and absolute path as JSON, plus a short
instruction to use that path with tools running on the daemon host. Names and
paths are JSON encoded; attachment contents remain user data. Images retain
their inline bytes and text files retain their contents.

`Session` adds this context to the model's reference parts, including the
image-only path, without merging it into the user's text. There remains exactly
one content block per attachment reference. User display text, title input, and
mid-turn attachment-reference persistence keep their existing behavior.

Vision Bridge derives its focus hint from the resolved text with attachment
path metadata excluded. This keeps its 2,000-character hint budget available
for the user's question, expanded commands, and audio transcription. The main
model still receives the path context. Normal, custom-command, and mid-turn
delivery use the same filtering.

Obtain the path from the same successful read that supplies the bytes. Do not
reconstruct the default directory: a configured root may fall back to legacy
storage. Keep public attachment download responses unchanged. Generate metadata
when a stored reference is dispatched, including references after a session
restore, instead of persisting a separate path mapping.

Normal prompt dispatch and mid-turn queue draining already share the resolver.
Both retain the new metadata on surviving attachment blocks during degradation.
Duplicate references share one read and encoding, and failed reads are still
evicted from the dispatch memo.

## Constraints

Paths belong to the daemon/ACP execution filesystem, not the browser's machine.
The daemon launches ACP children locally, but SSH or Managed sessions may
delegate tools to another filesystem. Metadata explicitly identifies the daemon
host and does not claim remote tools can access its files. ACP currently rejects
the separate tool execution sandbox. This change does not add remote filesystem
transport or sandbox mounts. Existing tool permissions still apply. A missing
attachment keeps the existing failure/degradation behavior; never search another
session for a replacement. Raw inline content without a stored attachment
reference has no new path metadata.

Absolute paths are sent to the configured model provider as prompt content.
The default path can reveal the daemon user's home-directory name; a custom
root can reveal its directory hierarchy. Paths are not anonymized. A private
attachment alias resolved by tools would require a separate design.

Providing a path does not add a parser for unsupported binary formats. A model
can use an available parser through shell tools. File removal after dispatch can
still invalidate a previously supplied path.

## Validation and acceptance

- In a fresh session with memory disabled, image, text, and binary attachments
  include absolute paths in the final model request. Reading those paths returns
  the original bytes; image content remains available to a vision model.
- Configured roots, fallback roots, restored stores, duplicate filenames, and
  names containing spaces or Unicode report the correct stored file.
- Unavailable attachments report failure or degrade as before; surviving
  attachments keep both metadata and content during mid-turn delivery.
- Existing content, memoization, download, and session isolation tests pass.
- Normal and image-only mid-turn messages retain their original display text
  and attachment references; paths appear only in model context.
- Long attachment metadata does not consume the Vision Bridge focus-hint
  budget or displace the user's question; the main model retains the paths.
- Build, typecheck, targeted unit tests, and an isolated Store → Session → OpenAI
  request-conversion probe pass. The probe does not contact a model or load
  personal memory; it verifies request construction and file access.
