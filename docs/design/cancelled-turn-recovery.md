# Cancelled turn recovery

[English](cancelled-turn-recovery.md) | [简体中文](cancelled-turn-recovery.zh-CN.md)

## Problem and scope

After explicit daemon Cancel, restored history can resemble a crashed turn. Recovery must consult the existing turn result and refuse the stopped task. A truly interrupted task stays recoverable. This fix covers ordinary daemon Cancel/active Close and SDK transport interruptions. Channel lifecycle shutdown and failed detach use interruption; explicit channel Cancel remains user intent. Remote Host policy is outside this fix.

## Minimal lifecycle

Use the existing recorded prompt identity, compression prompt IDs and turn result. A validated cancelled result with a finite cancellation timestamp blocks recovery. Explicit user provenance distinguishes current user cancellation from transport interruption; timestamp-only legacy results remain unknown and also block Continue. New accepted model input replaces the boundary. Local commands, reminders, compression and unrelated late terminals do not. Retry/Continue records only the execution attempt needed when no new visible user record is written.

The existing recorder reads the active transcript branch at recovery admission and final execution. Results store the existing client prompt ID alongside the daemon result ID; Retry/Continue store a strict execution attempt before sending. Recovery compares those records to the existing API-history identity, so local commands and rolled-back input cannot replace a stopped model task. Continue admission and the final execution gate read the transcript directly. Synchronous UI status retains the existing structural classification; the cancellation veto belongs to the operation that can start work. No new client state, Session cancellation cache, load-time read or transcript-reader index is introduced.

Cancellation admission and final Continue execution both consult this boundary. Rejected Continue creates no attempt or terminal. Transport failures carry interruption metadata through the ordinary SDK/REST/ACP path. Later human Cancel remains an independent request, and the server drains both handshakes before advancing its FIFO. The SDK keeps its existing public cancel method and Promise deduplication. Lifecycle interruption is a separate request so it cannot absorb a later human Cancel. Non-interactive admission reads shallow history for existing prompt identity; the planner keeps its cloned history.

## Acceptance and limits

With a built daemon and an isolated provider, Cancel after read_file, restart, reattach and Continue must refuse with zero further requests. SIGKILL without Cancel must still continue and complete. A timestamp-only cancellation must refuse repeated Continue without changing the transcript. Verify newer input, local commands, rollback, compression, stale results and active Close using focused checks.

Legacy confirmation remains in draft #14087. Remote Host/channel attribution extensions are removed from this PR; their existing policy is unchanged. Untagged automatic input and idle Close after an earlier interruption remain separate work in #13502. No migration or release is included.
