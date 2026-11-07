# Idle-Time Auto-Compaction

[English](idle-compaction.md) | [简体中文](idle-compaction.zh-CN.md)

Status: proposal (issue #16508), revised after the triage round. No
implementation yet; this document fixes the design so the implementation PR
has a reviewable contract.

## Why

Auto-compaction today fires inside `chat.sendMessageStream` when the
effective prompt estimate crosses the threshold computed by
`computeThresholds(...)` at `llm-chat.ts:3537` — the only compaction gate in
the send path (the other `getAutoCompactThreshold()` consumer sizes
tool-output truncation, not compaction). The summarizer round trip lands
**mid-turn** — the user just asked for something and waits 30–60 s for work
unrelated to their request — and because the threshold fires late, sessions
run near the ceiling, where the eventual compaction input is at its largest.

Compacting while the user is idle moves that latency to a moment nobody
experiences it. The cache economics only work in specific regimes (below),
and this design restricts the trigger to exactly those regimes.

## Design

### A new core-side idle scheduler (no reuse claim)

Nothing existing measures away-duration: `use-program-status`'s `'idle'` is
a turn outcome ("no turn has ended"), `AppContainer`'s `IDLE_SPECULATION`
means "not speculating", and the only real gap measurement —
`evaluateTimeBasedTrigger(lastApiCompletionTimestamp, ...)` in
`microcompactHistory` — is evaluated lazily at the next send
(`client.ts:4777` → `microcompactHistoryBeforeSend`), which defeats the
purpose of doing work while the user is away.

The feature therefore adds **one new scheduler**: a single timer owned by
the interactive Chat, armed when a turn settles, cancelled on any new
activity (prompt submission, queued action). The timer's tick is an explicit
"idle tick" into core; core carries no timers of its own. This is prior art
adjacent to microcompaction's lazy trigger, but active: the gap is only
useful if something fires during it.

### Trigger: two regimes, either suffices

Compaction rewrites history and thereby **invalidates the provider prefix
cache** (explicit breakpoints and `prompt_cache_key`,
`openaiContentGenerator/prefix-caching.ts`). A short-idle compaction would
discard a still-warm cache (provider TTL is on the order of an hour) and
make the user's very next turn pay a cold rebuild it would not otherwise
pay. The trigger is therefore restricted to the two regimes where the
rewrite is free or already doomed:

- **Regime A — cache expired**: idle ≥ `context.idleCompactionMinutes`
  (default `60`, i.e. at/above the typical provider cache TTL;
  `undefined`/`0` disables the feature) **and** effective prompt estimate ≥
  soft watermark (`context.idleCompactionWatermark`, default `0.7`) × the
  effective auto-compact threshold. With the cache dead, compacting costs
  nothing that is not already lost.
- **Regime B — compaction imminent anyway**: idle ≥ a small floor
  (`context.idleCompactionFloorMinutes`, default `3`, enough to know the
  user stepped away) **and** effective prompt estimate already ≥ the
  auto-compact threshold itself. The next send would compact mid-turn and
  invalidate the cache regardless; doing it now only moves that latency out
  of the turn. No additional cache cost versus the status quo.

Both estimates reuse the same `computeThresholds(...)` accounting the
in-turn gate reads, so idle and in-turn triggers cannot disagree about
fullness. In both regimes, if the idle pass is interrupted the in-turn path
remains the backstop, unchanged.

### Concurrent prompt: abort, then a commit gate

Sends are serialized on the chat's `sendPromise` (`llm-chat.ts:2403`,
`:3426`); an out-of-band compaction does not hold that lock, so an
uncontrolled history rewrite racing an admitted send is the central hazard
(the existing out-of-band writer, `memoryPressureMonitor`'s
`compact_history` → `chat.setHistory`, has no in-flight protection today —
this design does not add a second unprotected writer). The house precedent
for background LLM work is also clear: speculation is **aborted** when a new
turn starts (`AppContainer.tsx:4143`).

The idle pass follows the precedent, with a commit gate:

1. A new prompt admitted while the idle summarizer is in flight **aborts**
   the side query (cancellation never triggers the cold fallback — existing
   compression semantics). One aborted attempt per idle period; no retry
   loop while the user remains away-and-back-away.
2. Even absent the abort race, the pass re-checks an **idle epoch** before
   committing `setHistory`: if any turn started since the pass began, the
   result is discarded without touching history — the commit point is
   effectively CAS-like, so an admitted send can never observe a half or
   stale-compacted history it did not wait for.
3. The summarizer never blocks prompt admission: it runs on the side-query
   path, and its failure modes are the existing ones.

### Hook contract: no visible change

A new `'idle'` value in `PreCompactTrigger`/`PostCompactTrigger`
(`hooks/types.ts:1160`), `CompactTrigger` (`chatCompressionService.ts:280`)
or `CompactionTriggerReason` (`core/turn.ts:548`) would silently break user
hooks that match `trigger == "auto"`. The idle pass therefore reports
**`auto` to hooks** — the idle distinction exists only in internal
telemetry and the user-facing notice reason. No exported enum changes; the
changelog records the new notice reason string only.

### Scope exclusions

Headless/SDK runs (`runNonInteractive`) and hosted/managed sessions disable
the feature outright — their "idle" has no operator to return, and their
turn-scoped memory drain is owned separately (#13885). The CLI interactive
session is the only surface in this proposal.

### Notices

On the user's next interaction, the standard auto-compaction notice renders
with the idle reason. No new surface; the existing notice path carries it.

## Non-goals

- No change to microcompaction, memory extraction, or the compression
  algorithm.
- No provider-specific cache pinning, warm-up calls, or TTL queries — the
  TTL assumption is a configuration default, not a measured fact.
- No hosted/web-shell equivalent in this slice.
- No fix for the pre-existing `memoryPressureMonitor` write race; recording
  it here does not license depending on it.

## Implementation requirements

- `.qwen/e2e-tests/` plan covering both regimes, the abort race, and the
  commit gate before the code PR.
- The two-tier confidence gate applies (`packages/core/src/**`).

## Acceptance criteria

- Regime A satisfied → exactly one compaction per idle period; a second tick
  in the same period is a no-op.
- Regime B satisfied → the compaction runs; the user's next turn observes
  compacted history and no in-turn compaction fires for the same fullness.
- Neither regime satisfied → no compaction, no notice.
- A prompt admitted mid-pass: the pass aborts, no history write occurs, the
  turn proceeds on the pre-compaction history exactly as today.
- Feature disabled by configuration → behavior identical to today.
- Hooks observe `trigger == "auto"` in all idle-pass events.
- Headless and hosted sessions never trigger it.

## Open questions

1. The default Regime A duration is set from the typical ~1 h provider
   cache TTL, not measurement; calibration against real session telemetry
   (or per-provider TTL configuration) is a follow-up.
2. Model-selector changes between turns already invalidate cache-sharing
   eligibility (route-scoped preflight); whether they should also suppress
   an idle pass is deferred to implementation measurement.
