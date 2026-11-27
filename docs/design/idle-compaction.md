# Idle-Time Auto-Compaction

[English](idle-compaction.md) | [简体中文](idle-compaction.zh-CN.md)

Status: proposal (issue #16508), revised after the triage and verification
rounds. No implementation yet; this document fixes the design so the
implementation PR has a reviewable contract. Line anchors cite the tree this
revision was written against (base `2258518d`); where drift is likely, the
symbol is named alongside.

## Why

Auto-compaction today fires inside `chat.sendMessageStream` at two
`tryCompress` entry points: the threshold gate, where the effective prompt
estimate crosses the threshold computed by `computeThresholds(...)` before
the send (`llm-chat.ts:3537`), and the reactive path, where an HTTP 413 /
context-overflow response forces a mid-turn compaction with `force = true`
(`llm-chat.ts:4973`). The summarizer round trip lands
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
  (default `60`, from the typical provider cache TTL — an assumption,
  calibration in Open questions 1; `undefined`/`0` disables the feature) **and** effective prompt estimate ≥
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
remains the backstop, unchanged — except that exact-route sends skip the
pre-send gate (`llm-chat.ts:3890`), so under a per-turn route override the
idle pass is the only compaction those turns would get.

### Passing the cheap gate unforced

The in-turn gate's cheap path NOOPs on `effectiveTokens < auto`
(`chatCompressionService.ts:585`) unless the screenshot-overflow branch
fires (`:592-611`), and the only other way through is `force = true` —
which bypasses the consecutive-failure breaker and reports
`PreCompactTrigger.Manual` to hooks. The idle pass therefore dispatches
through the same sub-`auto` branch the screenshot trigger uses: a new
sibling condition under the same NOOP path (idle tick present, unforced),
so the pass keeps `auto` semantics at the hook, keeps the breaker armed (a
summarizer failing repeatedly stops the pass exactly as in-turn
auto-compaction would), and carries the new `'idle'` notice reason.
`force = true` is explicitly not used.

### Concurrent prompt: abort, then a commit gate

Sends are serialized on the chat's `sendPromise` (`llm-chat.ts:2403`,
`:3426`); an out-of-band compaction does not hold that lock, so an
uncontrolled history rewrite racing an admitted send is the central hazard
(the existing out-of-band writer, `memoryPressureMonitor`'s
`compact_history` → `chat.setHistory`, has no in-flight protection today —
this design does not add a second unprotected writer). The house precedent
for background LLM work is also clear: speculation is **aborted** when a new
turn starts (`AppContainer.tsx:4149-4160`, the Idle → Responding transition
cleanup; abort at `:4157`).

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

### Hook contract: no hook-facing change

Three trigger types exist and only one is hook-facing:
`PreCompactTrigger`/`PostCompactTrigger` (`hooks/types.ts:1160`) reach user
hooks; `CompactTrigger` (`chatCompressionService.ts:280`) is the internal
`'manual' | 'auto'` parameter of the compression entry, and
`CompactionTriggerReason` (`core/turn.ts:548`) is a notice-only union that
hooks never see. Adding `'idle'` to the hook-facing enums would silently
break user hooks that match `trigger == "auto"`, so the idle pass reports
**`auto` to hooks** — it runs unforced through the sub-`auto` gate branch,
which derives `PreCompactTrigger.Auto` exactly as in-turn auto-compaction
does (`chatCompressionService.ts:662-663`). The idle distinction lives in
`CompactionTriggerReason`, which **gains `'idle'`** as the notice reason and
internal telemetry value. No hook-facing enum changes; the changelog records
the new notice reason string only.

### Scope exclusions

Headless/SDK runs (`runNonInteractive`) and hosted/managed sessions disable
the feature outright — their "idle" has no operator to return, and their
turn-scoped memory drain is owned separately (#13885). The CLI interactive
session is the only surface in this proposal.

### Notices

On the user's next interaction, the standard auto-compaction notice renders
with the idle reason — no new surface, but the reason clause is an equality
chain with a token-limit fallback at three consumers (`use-llm-stream.ts:2981`,
`opentui/event-adapter.ts:753`, `Session.ts:1245`), and none has an `'idle'`
branch today. Each needs one (or the chains collapse into one shared
helper), otherwise an idle pass at 0.7 × auto would announce "approached the
input token limit", which is untrue. (`Session.ts`'s missing
`payload_overflow` branch there is pre-existing and out of scope.) The
implementation PR touches those branches accordingly.

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
- A summarizer failing repeatedly across idle periods trips the same
  consecutive-failure breaker as in-turn compaction (the pass never takes
  the breaker-bypassing forced route).
- Headless and hosted sessions never trigger it.

## Open questions

1. The default Regime A duration is set from the typical ~1 h provider
   cache TTL, not measurement; calibration against real session telemetry
   (or per-provider TTL configuration) is a follow-up.
2. Model-selector changes between turns already invalidate cache-sharing
   eligibility (route-scoped preflight); whether they should also suppress
   an idle pass is deferred to implementation measurement.
