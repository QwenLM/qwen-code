# Session deletion isolation

[English](2026-11-18-session-delete-isolation.md) | [简体中文](2026-11-18-session-delete-isolation.zh-CN.md)

## Contract

Deleting workspace session A affects only A. A scheduled `per_run` session B owns its history and can be reopened by its own session ID after A is deleted. If A and B share an ACP channel, B's running turn can continue while A is closed.

## Close and cleanup

Session deletion requires the owning ACP child to flush A's recorder and acknowledge its closure. The daemon then takes its existing maintenance lease and removes A's data. An already absent owner can proceed through the same lease check.

The existing initialization budget bounds the delete request's wait for close. If it expires, the request reports an error and preserves A's files. The bridge keeps A closed to new work while the outstanding close settles. A late acknowledgement completes the bridge close, and a subsequent delete can remove A's files. A definitive refusal allows a fresh attempt. An unconfirmed RPC failure keeps A fenced and allows a deletion retry against the same owner. The deletion path preserves the ACP channel for sibling sessions.

Worktree cleanup checks both active and archived metadata for another owner under the existing worktree lock. A checkout shared with a different session is retained.

## Validation

- Run a real daemon `per_run` execution with a deterministic model response, close B, delete A, and reopen B by its original ID. Check that the full transcript still contains the original prompt and response in order.
- Hold A's ACP close response on a channel that is running a B prompt. Check that the close times out, B reaches its normal turn result, and a late acknowledgement closes A alone.
- Check that a close timeout preserves A's transcript and attachments and that another archived session referencing A's worktree keeps the checkout accessible.
