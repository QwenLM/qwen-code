# Fence old transcript writers across archive transitions

[English](2026-11-21-session-archive-write-fence.md) | [简体中文](2026-11-21-session-archive-write-fence.zh-CN.md)

## Problem and scope

In [#17251](https://github.com/QwenLM/qwen-code/issues/17251) and
[#9688](https://github.com/QwenLM/qwen-code/issues/9688), one daemon could archive
an active transcript still held by a recorder in another process. A later
append opened the missing active path with create enabled; a stale title could
also recreate the active title sidecar. The new record's parent was in the
archived transcript, so the active copy had a history gap.

The daemon's existing lifetime writer lease already excludes archive while an
opt-in leased writer is still attached. Default legacy recorders do not hold
that lease. This change preserves both modes and the existing HTTP and
transcript formats. It does not repair already-damaged transcripts, stop remote
processes, or change deletion or ownership of sibling sessions.

## Storage boundary

- Legacy transcript creation and append, title sidecar writes, fallback storage
  rename, and archive/unarchive use a short per-transcript filesystem lock in
  the active `chats` directory. An archive cannot move a transcript between an
  accepted legacy append and its title sidecar write.
  Prompt labels and resume seeds still appear immediately when the active
  path is uncontended. If the lock is busy, the projection is deferred
  without allowing a later prompt to take the label first.
  Legacy appends stay queued in order during contention and retry acquisition
  for roughly one stale-owner interval before surfacing a write failure.
- Immediately before a real archive/unarchive move or conflict resolution, the
  service atomically replaces the sibling `<id>.jsonl.archive-generation`
  token. A recorder retains the token it saw when it loaded or first recorded
  the session; it never refreshes that token for the same path. It checks the
  token and the absence of an archived copy under the lock before writing.
  A legacy recorder must also pass the check if it later obtains the existing
  lifetime writer lease for message-group changes.
- Rejection prevents both active files from being recreated, even if restore
  returns the same transcript inode or deletion later removes the archived copy.
  A fresh recorder on an explicitly restored transcript can write normally.
  Archive/unarchive no-ops do not advance the generation.
- The token is intentionally kept after deletion and does not appear in session
  listings. Its presence alone does not indicate archive state. A failed move
  after token replacement can revoke earlier writers; a fresh load can record
  again if the transcript is active. A title sidecar write remains best effort.

The filesystem lock is cooperative and has stale-owner recovery after 60 seconds.
The guarantee applies to current participants on the same local storage. A daemon
running an older build can still ignore this fence; upgrade or stop all legacy
writers before relying on it. This lock does not introduce an exclusive owner
between otherwise active legacy recorders.

## Verification

See the [two-daemon E2E test plan](../../.qwen/e2e-tests/2026-11-21-session-archive-write-fence.md).
The automated storage tests use real filesystem operations and cover late
titles, a never-retried stale recorder after restore, first-write lock contention,
and an append queued during archive. An independent subprocess probe exercises
production recorders and archive/unarchive in separate processes, checks exact
archived bytes and the restored parent chain, and covers archive followed by
delete.
