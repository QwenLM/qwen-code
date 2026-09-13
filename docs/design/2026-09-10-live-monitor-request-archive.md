# Debug-only visual Monitor request archives

[English](2026-09-10-live-monitor-request-archive.md) | [简体中文](2026-09-10-live-monitor-request-archive.zh-CN.md)

## Scope

The user explicitly requests temporary JSON/image/audio records for every
inference of a visual Monitor, with its directory in each log message, retaining
only the latest ten Monitors. This extends existing metadata-only debugging;
normal runs must never start this recorder. Pure audio Monitors remain excluded.
Existing code/worktree and the audio/position bug fixes are separate concerns.

## Recording contract

- A daemon started with debug logging initializes a private managed directory
  under the OS temporary directory, prunes it at startup and when a visual
  Monitor is created, and passes the recorder to that Monitor only. Use a new
  independent random directory per logical Monitor instance, not per WebSocket
  recycle. No new init question or persistent user configuration is needed.
- Record the actual successfully sent inputs, not merely queued/captured data.
  Each commit/response request gets `request.json`, ordered JPEG files and an
  input WAV (mono signed PCM16, 16 kHz), including protocol silence. JSON records
  media ordering, sequence, offsets/hashes and transport/evaluation identity.
  Session instructions and text-conversation context are retained, with references
  to earlier requests rather than repeatedly copying media history. Store a
  bounded response/status record too, useful for distinguishing wait, reply and
  errors. API keys and authorization headers are never recorded.
- Frame/audio input transactions may be assembled in memory until commit, with
  a bounded debug-only pending-byte budget. File I/O is serialized asynchronously;
  write/permission/disk/queue failure disables that recorder and logs an explicit
  error, never interrupts the live model or delays playback. No silent truncation:
  a failed/incomplete recording is clearly marked.
- Directories use 0700 and files 0600. Retention only deletes validated, owned,
  marked Monitor directories immediately beneath this managed root; reject
  symlink roots and never traverse unrelated temporary paths. Order by creation
  time, not later inference writes. Evicted active Monitors continue running but
  cannot recreate their deleted archive. State explicitly when no longer retained.
- Debug startup and every request log show the absolute Monitor directory and
  request directory/status. Documentation warns that these debug files contain
  real screen/camera and (for combined Monitors) microphone content. Retention is
  ten Monitor directories, not ten requests; long-running traces may be large.

## Verification

Baseline debug currently emits metadata only and creates no media archive.
Use global qwen help first, then safe deterministic fake-provider/temporary-dir
fixtures. Verify debug off/no files; visual vs audio-only; exact sent-byte order,
WAV decode, rejected writes, interleaved next-evaluation input, recycle/reset,
credentials omitted; startup/creation retention and no symlink/outside deletion;
older active writer eviction; write failure nonfatal. Root runs serialized builds,
package-local tests, independent verification and two clean self-audit passes.
No actual microphone or private desktop is needed to test the implementation.

## Summary

Only debug startup enables real request archives for visual Monitors. Retain
JSON, JPEG and WAV for each inference, recording content and order actually
written to the model connection rather than treating queued data as sent. Log
the paths; normal runs do not save media. Keep only the ten most recently created
Monitor directories. Older active Monitors continue after eviction but do not
recreate their records. Files are readable/writable only by the current user;
safe cleanup covers only directories created by this feature. Archive failure
must not affect calls.
