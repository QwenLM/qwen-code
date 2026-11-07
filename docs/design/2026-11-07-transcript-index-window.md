# Over-cap Transcripts: Index the Recent Window Instead of Refusing

[English](2026-11-07-transcript-index-window.md) | [简体中文](2026-11-07-transcript-index-window.zh-CN.md)

- Status: proposed (draft PR, needs maintainer approval of the contract change)
- Date: 2026-11-07
- Issue: #13113
- Scope: `packages/core/src/services/session-transcript-reader.ts`, the
  `HistoryGap` and `TranscriptReplayGapInput` types, the CLI history-gap notice
  and its translations

## Problem statement

`SessionTranscriptReader` refuses any transcript larger than
`SESSION_TRANSCRIPT_MAX_INDEX_BYTES` (256 MiB). The check is the first
statement of `buildIndex`, so `readPage`, `readTurnIndexPage` and
`readRestoreProjection` all fail with `SessionTranscriptTooLargeError`, and the
daemon answers `413 transcript_too_large`. A session that crosses the cap can no
longer be opened in Web Shell or restored by the daemon.

Long-lived sessions reach the cap through ordinary growth. A reported
scheduled-task controller wrote about 14 MB a day for 20 days and reached
280 MB; most of it was tool results, compression records, telemetry and
assistant messages. Such a session never needs its first days to keep running,
but today it becomes permanently unavailable, and the only recovery is editing
the JSONL by hand.

## Current state

- [Selective session restore](2026-08-08-selective-session-restore.md) made the
  cap an intentional limit: a cold daemon restore over 256 MiB fails with 413
  and never falls back to the full-materialization loader.
- The index already models a missing parent as a `HistoryGap`. `readPage` and
  restore replay pages return gaps, and the terminal `/resume` and ACP replay
  render a divider for them. The divider text says the history was lost to a
  storage interruption.
- Session-level settings (`parent_session`, `session_source`, `session_model`,
  `session_approval_mode`, `session_workflow_mode`), the sources snapshot and
  the attribution snapshot are selected from the active chain or the physical
  records of the index.

## Goals

- Serve an over-cap transcript from its last `SESSION_TRANSCRIPT_MAX_INDEX_BYTES`
  instead of refusing it, keeping the cap as the bound on index memory.
- Report where the indexed history starts, distinguishable from lost history.
- Restore the session-level state a resumed session needs even when it was
  recorded before the window.
- Leave transcripts under the cap, and the files on disk, unchanged.

## Non-goals

- Writer-side growth, retention, compaction or rewriting existing transcripts.
- A configurable cap.
- Managed sessions, whose projection reads the whole log.
- The other size limits: the archived-session loader and the artifact library
  keep their own checks.

## Proposed changes

### A. Windowed index

When the snapshot is larger than the cap, `buildIndex` starts at the first line
that begins within the last `SESSION_TRANSCRIPT_MAX_INDEX_BYTES`
(`findWindowStart`). It indexes those lines exactly as it indexes a whole file
today, with absolute byte offsets, so page reads, cursors and the index cache
work unchanged. The window never exceeds the cap, so index memory stays bounded
as before.

The index still refuses with `SessionTranscriptTooLargeError` when no line
starts within the window, when the window holds no conversation record, or when
the log is Managed.

### B. Prefix scan

After the window's chain is walked, `scanTranscriptPrefix` parses the lines
before the window without indexing them. They go through the same
`SessionExecutionEngineAccumulator`, so ownership and completeness still cover
the whole file, and a record from another session still makes the snapshot
unavailable. The scan keeps only:

- the first record of the file, which proves which project the session belongs
  to and supplies the restore start time;
- the last record of each session-level kind: `parent_session`,
  `session_source`, the last valid `session_model`, `session_approval_mode` and
  `session_workflow_mode`, the last `session_sources_snapshot` and the last
  attribution snapshot;
- the model of the last assistant record.

These records are stored on the index as `window.retainedRecords` and served by
uuid when the index has no entry for them.

### C. Gap reason

`HistoryGap` and `TranscriptReplayGapInput` gain an optional
`reason: 'transcript_window'`. The prefix scan checks whether the parent the
window's chain is missing appears before the window. If it does, the gap is a
window cut and carries the reason; otherwise it stays a storage gap.

### D. Readers

- `readPage` and restore replay pages already return gaps.
- `readTurnIndexPage` returns `gaps` when there are any.
- `readRestoreProjection` falls back to the prefix for each setting the window
  does not record again. Prefix records are read before the window's, so a
  setting the window changes is still dispatched last and wins.
- Both restore projections fall back to the prefix's sources snapshot.
- Restored `historyGaps` carry the reason, which marks the session as partial.

### E. Notice

`formatHistoryGapNotice` returns a separate message for a window cut: the
earlier conversation was not loaded because the session is too large to restore
in full. The English, Simplified Chinese, Traditional Chinese and Catalan
catalogs, which translate the existing notice, translate the new one too.

## Key design decisions

- **Read side only.** It makes every existing over-cap file usable again
  without touching disk or the writer lease. A writer-side cap would only help
  files written after the change.
- **One scan of the prefix, no index entries.** The prefix still costs a parse,
  but not memory beyond the few retained records.
- **Prefix settings in file order.** The prefix is not indexed, so it has no
  chain to walk. For a setting the window does not record again, the last one in
  file order can differ from the active-chain one only when it sits on a branch
  abandoned by rewind before the window.
- **Fork is unchanged.** `SessionService.forkSession` does not use the index: it
  reads the whole source file and copies its active branch, so it keeps working
  for over-cap sessions. An earlier sketch proposed refusing fork from a
  windowed session; reading the fork path showed that is unnecessary.
- **Rewind.** Turns before the window are not in the restored turn list or file
  history, so they cannot be selected as rewind targets.

## Contract changes

- A cold daemon restore over 256 MiB no longer fails with
  `413 transcript_too_large`. It restores the recent window and reports a
  `transcript_window` gap. This revises the corresponding goal of
  [selective session restore](2026-08-08-selective-session-restore.md), which
  required maintainer approval when it was introduced, and needs the same here.
- `HistoryGap.reason`, `TranscriptReplayGapInput.reason` and
  `SessionTranscriptTurnIndexPage.gaps` are optional additions. Clients that
  ignore them see the same shapes as before.
- `transcript_too_large` still exists for the refusal cases listed in A.

## Constraints and risks

- The prefix is still parsed, so opening a very large transcript takes time
  proportional to its size.
- Restored state from before the window is limited to the retained kinds.
  Earlier UI telemetry, goal records, artifacts and file history are not
  restored, and the window gap marks the session as partial.
- The model history starts at the window, or at the last compression inside it.
- A record written as several lines with one uuid keeps only the lines inside
  the window when the window starts between them.

## Validation plan

- Reader tests with a test-only cap: the window and its gap, a parent missing
  from the whole file, settings recorded only before the window, a setting the
  window records again, a window without conversation and a window with no line
  start.
- Mutation checks that turn those tests red: window start off by one byte, the
  reason never or always set, no prefix fallback, prefix records read after the
  window, and the first record not taken from the prefix.
- On Ubuntu 24.04 with Node 22: the reader APIs on a 280 MiB transcript, and a
  daemon `POST /session/:id/load` before and after the change, including the
  turn index and the transcript page at the window start.

## Acceptance criteria

- An over-cap transcript loads, pages and restores without
  `transcript_too_large`, and its first loaded page shows the window notice.
- Session-level settings recorded only before the window are restored.
- A gap whose parent is missing from the whole file is still reported as a
  storage gap.
- Transcripts under the cap behave as before.

## Open questions

- Should windowing replace the 413 by default, or sit behind a setting?
- The operator who reported the 280 MB session asked for a configurable cap as
  a stopgap. Is it still wanted once the window exists?
- Retention of telemetry records in long-lived transcripts is left for a
  separate decision.
