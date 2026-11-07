# Idle-Time Auto-Compaction

[English](idle-compaction.md) | [简体中文](idle-compaction.zh-CN.md)

Status: proposal (issue #16508). No implementation yet; this document fixes
the design so the implementation PR has a reviewable contract.

## Why

Auto-compaction today fires inside `chat.sendMessageStream` when the
effective prompt estimate crosses `autoCompactThreshold` (`llm-chat.ts:3537`,
`:6531`). The summarizer round trip lands **mid-turn** — the user just asked
for something and waits 30–60 s for work that has nothing to do with their
request — and because the threshold fires late, sessions run near the
ceiling, where the eventual compaction input is at its largest.

Compacting while the user is idle moves that latency to a moment nobody
experiences it, and lets the next prompt arrive at an already-compacted
session. Provider conversation caches live on the order of an hour; the
compacted prefix — not the near-ceiling one — is what the next turn's cache
rebuild is priced against.

## Design

### Trigger

Two conditions, both configurable, **both** required:

- idle ≥ `context.idleCompactionMinutes` (default `5`); `undefined` or `0`
  disables the feature;
- effective prompt estimate ≥ soft watermark = `context.idleCompactionWatermark`
  (default `0.7`) × the effective `autoCompactThreshold`.

The estimate reuses the same accounting the in-turn check reads, so the two
triggers cannot disagree about fullness. The watermark staying below `1.0`
keeps a margin: if the idle pass is interrupted, the in-turn path remains the
backstop, unchanged.

Idle detection stands on the existing client-side idle state
(`use-program-status`); core receives only an explicit "idle tick" call, so
core carries no timers.

### Action

The idle tick calls the existing `ChatCompressionService.compress` with a new
`PreCompactTrigger` kind, `idle`. Everything downstream — the cache-sharing
gate, the history handling, the notice, the telemetry — is the existing
manual-pass machinery; only the trigger kind (and the notice text keyed on
it) is new.

### Concurrent prompt

A prompt arriving mid-compaction is **not** cancelled and does not race the
summarizer: the new turn waits for the compaction promise exactly as the
in-turn variant's callers wait today. The compaction itself runs on the
side-query path and never blocks the prompt's admission.

### Scope exclusions

Headless/SDK runs (`runNonInteractive`) and hosted/managed sessions disable
the feature outright — their "idle" has no operator to return, and their
turn-scoped memory drain is owned separately (#13885). The CLI interactive
session is the only surface in this proposal.

### Notices

On the user's next interaction, the standard auto-compaction notice renders
with the `idle` reason. No new surface; the existing notice path keyed by
trigger kind carries it.

## Non-goals

- No change to microcompaction, memory extraction, or the compression
  algorithm.
- No provider-specific cache pinning or warm-up calls.
- No hosted/web-shell equivalent in this slice (issue open question 3).

## Acceptance criteria

- Idle ≥ threshold with usage ≥ watermark runs exactly one compaction per
  idle period; a second tick during the same idle period is a no-op.
- Usage below watermark at idle → no compaction, no notice.
- A prompt submitted while the idle compaction is in flight waits for it and
  observes the compacted history; no duplicated compression.
- Feature disabled by configuration → behavior identical to today.
- Headless and hosted sessions never trigger it.

## Open questions

1. Default idle minutes and watermark — to be calibrated against real
   session telemetry before the first release; the config surface ships so
   early adopters can tune.
2. Skip when the model selector changed since the last turn (cache identity
   would differ)? Deferred to implementation measurement.
