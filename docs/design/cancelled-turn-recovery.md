# Cancelled turn recovery

[English](cancelled-turn-recovery.md) | [简体中文](cancelled-turn-recovery.zh-CN.md)

## Problem and scope

After explicit daemon Cancel, restored history can resemble a crashed turn. Recovery must consult the existing turn result and refuse the stopped task. A truly interrupted task stays recoverable. This fix covers ordinary daemon Cancel/active Close and SDK transport interruptions; it does not redesign remote Host or channel cancellation policy.

## Minimal lifecycle

Use the existing recorded prompt identity, compression prompt IDs and turn result. A validated cancelled result with a finite cancellation timestamp blocks recovery. Explicit user provenance distinguishes current user cancellation from transport interruption; timestamp-only legacy results remain unknown and also block Continue. New accepted model input replaces the boundary. Local commands, reminders, compression and unrelated late terminals do not. Retry/Continue records only the execution attempt needed when no new visible user record is written.

The client retains the owning execution and normalized terminal outcome through content rewrites. Successful input preparation accepts the execution; rollback does not. Settlement only updates the owning execution. Explicit history replacement, rewind and clear invalidate it. Cold full/selective restore binds the result to existing transcript identities on the active branch. No message-array cancellation snapshots, symbol migration or Todo-text classifier are added.

Cancellation admission and final Continue execution both consult this boundary. Rejected Continue creates no attempt or terminal. Transport failures carry interruption metadata through the ordinary SDK/REST/ACP path. Later human Cancel remains an independent request, and the server drains both handshakes before advancing its FIFO. The SDK keeps its existing public cancel method and Promise deduplication.

## Acceptance and limits

With a built daemon and an isolated provider, Cancel after read_file, restart, reattach and Continue must refuse with zero further requests. SIGKILL without Cancel must still continue and complete. A timestamp-only cancellation must refuse repeated Continue without changing the transcript. Verify newer input, local commands, rollback, compression, stale results and active Close using focused checks.

Legacy confirmation remains in draft #14087. Remote Host/channel attribution extensions are removed from this PR; their existing policy is unchanged. Untagged automatic input and idle Close after an earlier interruption remain separate work in #13502. No migration or release is included.
