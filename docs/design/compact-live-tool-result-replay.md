# Compact Live Tool-Result Displays for Session Replay

[English](compact-live-tool-result-replay.md) | [简体中文](compact-live-tool-result-replay.zh-CN.md)

Status: implemented (PR for issue #16171)

## Problem

Opening a Web Shell session can take tens of seconds while other sessions open
instantly. The `POST /session/:id/load` response embeds the daemon's replay
snapshot; on the incident session it measured **39.6 MB** although the on-disk
transcript was only 4.3 MB.

The bloat sits in `liveJournal`: a background subagent edited an ~870 KB file
9 times, and each edit result event carried the complete old and new file
contents twice — once as the diff content's `oldText`/`newText`, once as
`rawOutput` — ~3.6 MB per event, 27.5 MB across 9 events. The journal's
default caps (8 MiB / 10,000 events) were breached, adaptive journal growth
kept doubling them, and every open re-downloaded, parsed, and replayed the
whole snapshot.

## Current state

- The recording path (`sanitizeToolCallResultForRecording` in
  `packages/core/src/services/chatRecordingService.ts`) already truncates
  file-diff displays before persisting them: 16,000 chars per content field,
  50,000 for the diff, 100,000 aggregate. That is why the transcript stayed
  small.
- The interactive TUI history display compacts displays via
  `compactToolResultDisplayForHistory`
  (`packages/core/src/utils/toolResultDisplayCompaction.ts`), gated on
  `config.isInteractive()` in `coreToolScheduler`.
- The live ACP tool-result path does neither: `ToolCallEmitter.emitResult`
  hands the raw `resultDisplay` to `createTranscriptToolCallResultUpdate`
  (`packages/acp-bridge/src/transcript-replay.ts`), which embeds it into the
  wire update as diff content and `rawOutput`. Daemon (non-interactive)
  sessions therefore journal full file contents, and warm replay disagrees
  with cold replay (which rebuilds from the sanitized transcript and already
  shows truncated previews).

## Goals

- Bound the per-event replay payload of tool results, independent of edited
  file size.
- Make warm replay (live journal / compacted replay) show the same display
  cold replay already shows after a restart.
- Keep small diffs byte-for-byte intact.

## Non-goals

- Permission-request payloads keep their full diff: the approval UI needs the
  complete change, and they are one-shot interactions, not the repeated
  journal pressure observed here.
- No new configuration knob; the existing recording limits are reused.
- Tool-call start `rawInput` (model-supplied args) is unchanged.

## Proposed solution

Compact the display inside `createTranscriptToolCallResultUpdate` — the single
choke point where a `resultDisplay` becomes wire content and `rawOutput` —
using the existing `compactToolResultDisplayForRecording` utility:

- File diffs: content fields capped at `MAX_RETAINED_FILE_CONTENT_CHARS`
  (16,000), the diff at `MAX_RETAINED_FILE_DIFF_CHARS` (50,000); oversized
  displays degrade to the same text preview cold replay renders, and
  `rawOutput` shrinks to `{ fileName, fileDiff }` (or is dropped when the diff
  itself is oversized), exactly as the existing truncated-display handling
  already defines.
- Other display types (shell, ANSI, agent, todo, plan, findings, MCP app,
  etc.) get the same per-field caps the recorder applies.
- The call is idempotent: cold replay passes already-sanitized displays back
  through the same builder, and fields under the limits pass through
  untouched.

Because transcript records can carry leaner displays than the live producer
emits (a blocked spawn has no task prompt; older versions recorded fewer
fields), the compaction utility is hardened to be total: non-string fields
pass through untouched, lists are guarded with `Array.isArray`, and list
entries are guarded before spreading. No input may throw.

## Design decisions

1. **Compact at the wire builder, not at the emitter or in the journal.**
   The builder covers every caller (live execution, subagent tracking,
   duplicates, history replay) in one place, and it is where the truncated
   display handling (`extractDiffContent`, `getReplayRawOutput`) already
   lives. Compacting only in the journal would leave SSE broadcast and warm
   compacted replay unbounded and would duplicate the truncation rules in
   acp-bridge.
2. **Reuse the recording-purpose utility, not a new limit.** Warm replay then
   matches what the recorder persists, and there is one set of limits to
   reason about. The utility module is Node-free (its only runtime import is
   the pure `shell-result` helper), preserving the browser replay bundle
   constraint of `transcript-replay.ts`.
3. **Harden the utility instead of guarding the call site.** A try/catch
   fallback would silently retain oversized payloads for malformed displays;
   the other branches of the utility are already defensive, so the tagged
   display branches are brought to the same contract.

## Constraints and risks

- Live viewers of a large-file edit now see the truncated preview instead of
  the full diff. This is the same display cold replay and the TUI history
  already show; the full change remains available from the file itself and
  file history. Small diffs (the common case) are unaffected.
- Sessions journaled by older daemons keep their oversized events until the
  turn boundary folds them into the capped compacted replay; the fix applies
  to events emitted after the upgrade.
- The compaction utility is shared with the recording and TUI-history paths;
  hardening only adds pass-through for inputs that previously threw, so
  well-formed displays compact exactly as before (covered by the existing
  50-test suite).

## Validation

- Unit: `packages/acp-bridge/src/transcript-replay.test.ts` — large edit
  bounded (<10 KB serialized), small diff intact, sanitized-display
  equivalence with cold replay, oversized-diff `rawOutput` drop, non-diff
  bounding.
- Unit: `packages/core/src/utils/toolResultDisplayCompaction.test.ts` —
  partial/malformed displays never throw; present fields still compact.
- Probe (built dist, no model): 9 edits of an ~870 KB file plus streaming
  chunks through `TurnBoundaryCompactionEngine` with daemon-style adaptive
  growth — replay snapshot **31,746,417 bytes → 65,562 bytes (~484x)**; the
  fixed arm never breaches the default 8 MiB journal cap.
- Real-daemon A/B (branch dist vs released 0.26.5, isolated daemons, real
  model turns editing an ~870 KB file, 2026-11-03): during-turn session-open
  peak **61,955,300 → 185,373 bytes**; browser-level `/load`
  **72,830,493 bytes / 1,474 ms → 217,480 bytes / 99 ms**; first tool-card
  render **2,931 → 821 ms**. After a daemon restart, the 18 warm and 18 cold
  edit-result events are identical in content, rawOutput, and status; zero
  turn errors across four turns per arm.
- Suites: acp-bridge 2,866 passed; core compaction 58 passed; core
  chatRecordingService 187 passed; cli tool-call-emitter 72 passed.
- Browser replay bundle: `packages/web-templates/src/export-html/build.mjs`
  exits 0 with no forbidden inputs. The document renderer is byte-identical
  with and without the change (1,978,365 bytes, hard ceiling 2,053,000):
  `transcript-replay` is not reachable from the document entry, so the new
  import adds nothing there. The Node-free constraint still holds for the
  browser consumers that do import the module (e.g. the SDK's
  `chat-record-transcript`). The 1,970,000-byte warning threshold is
  exceeded on the base tree already.

## Acceptance criteria

- A large-file edit result update serializes to a bounded payload regardless
  of file size, in both diff content and `rawOutput`.
- Warm and cold replay render the same display for the same edit.
- Compaction never throws on any transcript-shaped display.
- Existing small-diff and recording behavior is unchanged.
