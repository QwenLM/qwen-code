# Chat recording failure observability

## Context

`ChatRecordingService` permanently stops accepting writes after its first asynchronous JSONL write failure. The transcript remains a valid prefix, but without a separate signal users and remote clients can incorrectly assume later messages are still being recorded.

## Core lifecycle

`Config.onChatRecordingFailure()` is the process-local subscription boundary. Each recorder created by a `Config` forwards its first asynchronous write failure to a snapshot of the registered listeners. The event carries the failed record's session ID and a normalized `Error`; listener failures are isolated from the writer promise. Subscriptions survive recorder replacement and are removed independently by their disposers. `Config.shutdown()` keeps listeners alive through recorder finalization and flushing, then clears them.

Synchronous conversation-file creation failures do not emit the event because the recorder has not entered its permanent failed state and a later call may retry. A failed recorder emits once; skipped descendants, later appends, and repeated flushes do not emit again.

## Local CLI surfaces

TUI and text output render a generic actionable warning without filesystem paths, errno values, or the underlying error. JSON, stream-json, and dual-output emit a `system/session_recording_degraded` message whose top-level and payload session IDs both come from the failure event rather than the current `Config` session.

One-shot structured output finalizes the recorder and waits up to two seconds for its flush before emitting the terminal result. Long-lived stream-json sessions subscribe once, flush between turns without finalizing, and finalize only on session shutdown. A timeout preserves responsiveness and does not cancel the underlying write.

## Daemon protocol and durable live state

The ACP child sends `qwen/notify/session/recording-degraded` with protocol version 1, the affected session ID, and `reason: "write_failed"`. The bridge validates the payload, publishes `session_recording_degraded`, and marks the live session entry as degraded. Notifications arriving before entry registration use the existing bounded early-event buffer; draining the buffer updates both the replay ring and entry state.

`session_snapshot.recordingDegraded` preserves the state after the live event leaves the replay ring. It is daemon-memory state only: a daemon restart creates a new recorder and begins healthy. The event is additive under `EVENT_SCHEMA_VERSION = 1`; no capability change is required.

## SDK and WebUI

The SDK validates the live event and optional snapshot field. The session reducer treats the live event as a resync-safe sticky update. A present snapshot field is authoritative, while an absent field preserves state for compatibility with older daemons.

The UI normalizer maps either degraded representation to the same recoverable recording error. WebUI uses the explicit notice ID `daemon.session_recording_degraded:<sessionId>` so a replayed event followed by a snapshot is idempotent. Dismissing a notice removes the current instance; a later snapshot may surface the still-active risk again.

## Close boundary

Strict close paths that require a successful flush keep the daemon entry alive when flushing fails, so the event remains deliverable. Existing best-effort close ordering is unchanged: if its EventBus is already closed when a late failure is discovered, only the debug log retains that failure.

## Non-goals

This design does not retry writes, recover a degraded recorder, change JSONL contents or parent links, add fsync, expose raw filesystem errors, or coordinate competing writers across processes.
