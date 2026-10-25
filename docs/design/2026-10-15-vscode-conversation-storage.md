# VS Code conversation storage

[English](2026-10-15-vscode-conversation-storage.md) | [简体中文](2026-10-15-vscode-conversation-storage.zh-CN.md)

## Problem and scope

Issue #14262 reports a 75 MB `globalState.conversations` value. Every message
rewrites all conversations, including abandoned empty placeholders. Keep the
companion's existing conversation API and daemon history behavior unchanged.

## Storage and migration contract

Store each conversation as JSON in `globalStorageUri/conversations`, using a
SHA-256 hash of its ID as the filename. The extension runs in the Node extension
host (including the remote host in WSL). Use Node filesystem APIs; no new storage
dependency or global index is necessary.

Serialize operations across store instances in one extension host. Read only the
requested conversation for mutations. Reuse the core atomic writer (including flushing and Windows rename retries)
for replacement; migration and ID rename instead flush a unique temporary file
and publish with an exclusive hard link, so an existing destination is never
overwritten. Cleanup of temporary files and old rename sources is best-effort and cannot mask
publication; failed cleanup can leave an extra file.
Separate sessions in different windows write different files. Simultaneous edits
to the same session across extension hosts remain last-writer-wins, as before;
this change does not add cross-process session locking.

Before normal operations, migrate all legacy records without replacing any
existing destination, then remove only the `conversations` globalState key. Any
read/write error propagates and leaves the legacy key available for retry.
Existing destination records are read and validated before retrying a write, so retries do not rewrite already migrated records. Corrupt JSON is an error, not an
empty conversation. The trusted inputs are extension-owned legacy records; IDs
still cannot escape the storage directory because filenames are hashed.

Keep only the current newly created empty draft in each store instance. Persist
it on its first message; discard abandoned new drafts. Preserve legacy empty records because they cannot be distinguished reliably from sessions temporarily emptied by first-turn editing.
Already persisted conversations may become empty during first-turn editing and
must remain available for replacement or rollback. Preserve nonempty history
without age/count eviction: automatic deletion of user messages is out of scope.
Disk usage for meaningful history can therefore still grow.

## Consumers and verification

`WebViewProvider` creates drafts and appends background notifications;
`SessionMessageHandler` creates, reads, appends, upserts, renames, truncates and
restores conversations. Keep their signatures unchanged. Handler/router wrappers
only pass the store through. `getAllConversations` has no external production
consumer.

Use real temporary directories in regression tests. Verify migration and restart,
failed migration and retry, new-draft compaction, atomic write failure, parallel
store instances, ID rename, first-turn editing and restoration, and that appending
a reply leaves other conversation files untouched and never writes globalState
payloads. Compare the old and new implementations with the same scripted inputs.
The CLI cannot exercise VS Code Memento storage; report extension-host/WSL warning
verification separately when that runtime is unavailable.
