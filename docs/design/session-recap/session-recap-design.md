# Session Recap Design

> A one-line "where did I leave off" summary surfaced when the user
> returns to an idle session, either on demand (`/recap`) or after the
> terminal has been blurred for 5+ minutes.

## Overview

When a user `/resume`s an old session days later, scrolling back through
pages of history to remember **what they were doing and what came next**
is a real friction point. Just reloading messages does not solve this
UX problem.

The goal is to proactively surface a one-line recap when the user
returns:

- **High-level task** (what they are doing) → **next step** (what to do next).
- Visually distinct from real assistant replies, so it is never mistaken
  for new model output.
- **Best-effort**: failures must be silent and never break the main flow.

## Triggers

| Trigger    | Conditions                                                                                   | Implementation                                                    |
| ---------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Manual** | User runs `/recap`                                                                           | `recapCommand.ts` calls the same underlying service               |
| **Auto**   | Terminal blurred (DECSET 1004 focus protocol) for ≥ 5 min + focus returns + stream is `Idle` | `useAwaySummary.ts` — 5min blur timer + `useFocus` event listener |

Both paths funnel into a single function — `generateSessionRecap()` — to
guarantee identical behavior. The auto-trigger is gated by
`general.showSessionRecap` (default: on); the manual command ignores
that setting.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                          AppContainer.tsx                              │
│   isFocused = useFocus()                                               │
│   isIdle = streamingState === Idle                                     │
│       │                                                                │
│       ├─→ useAwaySummary({enabled, config, isFocused, isIdle,          │
│       │       │             setAwayRecapItem})                         │
│       │       └─→ 5 min blur timer + idle/dedupe gates                 │
│       │              │                                                 │
│       │              ↓                                                 │
│       └─→ recapCommand (slash) ─→ generateSessionRecap(config, signal) │
│                                          │                             │
│                                          ↓                             │
│                              ┌─────────────────────────┐               │
│                              │ packages/core/services/ │               │
│                              │   sessionRecap.ts       │               │
│                              └─────────────────────────┘               │
│                                          │                             │
│                                          ↓                             │
│                              GeminiClient.generateContent              │
│                              (fastModel + tools:[])                    │
│                                                                        │
│   setAwayRecapItem({type: 'away_recap', text})                         │
│       └─→ DefaultAppLayout renders AwayRecapMessage                    │
│           as a sticky banner above the Composer                        │
│           (dim color + "※ recap:" prefix)                              │
└────────────────────────────────────────────────────────────────────────┘
```

### Files

| File                                                         | Responsibility                                      |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `packages/core/src/services/sessionRecap.ts`                 | One-shot LLM call + history filter + tag extraction |
| `packages/cli/src/ui/hooks/useAwaySummary.ts`                | Auto-trigger React hook                             |
| `packages/cli/src/ui/commands/recapCommand.ts`               | `/recap` manual entry point                         |
| `packages/cli/src/ui/components/messages/StatusMessages.tsx` | `AwayRecapMessage` dim renderer (`※ recap:` prefix) |
| `packages/cli/src/ui/types.ts`                               | `HistoryItemAwayRecap` type                         |
| `packages/cli/src/ui/layouts/DefaultAppLayout.tsx`           | Sticky-banner placement above the Composer          |
| `packages/cli/src/ui/layouts/ScreenReaderAppLayout.tsx`      | Same placement under screen-reader mode             |
| `packages/cli/src/config/settingsSchema.ts`                  | `general.showSessionRecap` setting                  |

## Prompt Design

### System Prompt

`generationConfig.systemInstruction` replaces the main agent's system
prompt for this single call, so the model behaves only as a recap
generator and not as a coding assistant.

Note that `GeminiClient.generateContent()` internally runs the prompt
through `getCustomSystemPrompt()`, which appends the user's memory
(QWEN.md / managed auto-memory) as a suffix. The final system prompt is
therefore `recap prompt + user memory` — useful project context for the
recap, not a leak.

Bullets below correspond 1:1 with `RECAP_SYSTEM_PROMPT`:

- Exactly one short sentence (≤ 80 chars), plain prose (no markdown / lists / headings).
- First sentence: the high-level task. Then: the concrete next step.
- Explicitly forbid: listing what was done, reciting tool calls, status reports.
- Match the dominant language of the conversation (English or Chinese).
- Wrap output in `<recap>...</recap>`; nothing outside the tags.

### Structured Output + Extraction

The model is instructed to wrap its answer in `<recap>...</recap>`:

```
<recap>Refactoring loopDetectionService.ts to address long-session OOM. Next step is to implement option B.</recap>
```

Why: some models (GLM family, reasoning models) write a "thinking"
paragraph before the final answer. Returning the raw text would leak
that reasoning into the UI.

`extractRecap()` has three fallback tiers:

1. Both tags present: take what is between `<recap>...</recap>` (preferred).
2. Only the open tag (e.g. `maxOutputTokens` truncated the close tag):
   take everything after the open tag.
3. Tag missing entirely: return empty string → service returns `null`
   → UI renders nothing.

The third tier is "skip rather than show the wrong thing" — surfacing
the model's reasoning preamble is worse than showing no recap at all.

### Call Parameters

| Parameter           | Value                          | Reason                                                |
| ------------------- | ------------------------------ | ----------------------------------------------------- |
| `model`             | `getFastModel() ?? getModel()` | Recap doesn't need a frontier model                   |
| `tools`             | `[]`                           | One-shot query, no tool use                           |
| `maxOutputTokens`   | `300`                          | Headroom for one short sentence + tags                |
| `temperature`       | `0.3`                          | Mostly deterministic, with a bit of natural variation |
| `systemInstruction` | The recap-only prompt above    | Replaces the main agent's role definition             |

## History Filtering

`geminiClient.getChat().getHistory()` returns a `Content[]` that
includes:

- `user` / `model` text messages
- `model` `functionCall` parts
- `user` `functionResponse` parts (which can hold full file contents)
- `model` thought parts (`part.thought` / `part.thoughtSignature`,
  the model's hidden reasoning)

`filterToDialog()` keeps only `user` / `model` parts that have **non-empty
text and are not thoughts**. Two reasons:

- **Tool calls / responses**: a single `functionResponse` can be 10K+
  tokens. 30 such messages would drown the recap LLM in irrelevant
  detail, both wasting tokens and biasing the recap toward
  implementation noise like "called X tool to read Y file".
- **Thought parts**: carry the model's internal reasoning. Including
  them risks treating hidden chain-of-thought as dialogue and
  surfacing it in the recap text.

After dropping empty messages, `takeRecentDialog` slices to the last 30
messages and refuses to start the slice on a dangling model/tool
response.

## Concurrency and Edge Cases

### Auto-trigger hook state machine

`useAwaySummary` keeps three refs:

| Ref               | Meaning                                           |
| ----------------- | ------------------------------------------------- |
| `blurredAtRef`    | Blur start time (not cleared until focus returns) |
| `recapPendingRef` | Whether an LLM call is in flight                  |
| `inFlightRef`     | The current in-flight `AbortController`           |

`useEffect` deps: `[enabled, config, isFocused, isIdle, setAwayRecapItem]`.

| Event                                              | Action                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `!enabled \|\| !config`                            | Abort in-flight call + clear `inFlightRef` + clear `blurredAtRef`                                                                      |
| `!isFocused` and `blurredAtRef === null`           | Set `blurredAtRef = Date.now()`                                                                                                        |
| `isFocused` and `blurredAtRef === null`            | Return early (no blur cycle to handle — first render or right after a brief-blur reset)                                                |
| `isFocused` and blur duration < 5 min              | Clear `blurredAtRef`, wait for next blur cycle                                                                                         |
| `isFocused` and blur ≥ 5 min and `recapPendingRef` | Return (dedupe)                                                                                                                        |
| `isFocused` and blur ≥ 5 min and `!isIdle`         | **Preserve** `blurredAtRef` and wait for the turn to finish (`isIdle` is in the deps, so the effect re-fires when streaming completes) |
| `isFocused` and all conditions met                 | Clear `blurredAtRef`, set `recapPendingRef = true`, create `AbortController`, send the LLM request                                     |

The `.then` callback **re-checks** `isIdleRef.current`: if the user has
started a new turn while the LLM was running, the late-arriving recap
is dropped to avoid inserting it mid-turn.

The `.finally` clears `recapPendingRef`, and clears `inFlightRef` only
if `inFlightRef.current === controller` (so it doesn't overwrite a
newer controller).

A second `useEffect` aborts the in-flight controller on unmount.

### `/recap` gating

`CommandContext.ui.isIdleRef` exposes the current stream state
(mirroring the existing `btwAbortControllerRef` pattern). In
interactive mode, `recapCommand` refuses when `!isIdleRef.current`
**or** `pendingItem !== null`. `pendingItem` alone is insufficient
because a normal model reply runs with `streamingState === Responding`
and a null `pendingItem`.

## Configuration and Model Selection

### User-facing knobs

| Setting                    | Default | Notes                                                             |
| -------------------------- | ------- | ----------------------------------------------------------------- |
| `general.showSessionRecap` | `true`  | Auto-trigger only. Manual `/recap` ignores this.                  |
| `fastModel`                | unset   | Recommended (e.g. `qwen3-coder-flash`) for fast and cheap recaps. |

### Model fallback

`config.getFastModel() ?? config.getModel()`:

- User has a `fastModel` set and it is valid for the current auth type
  → use `fastModel`.
- Otherwise → fall back to the main session model (works, just costlier
  and slower).

## Observability

`createDebugLogger('SESSION_RECAP')` emits:

- caught exceptions from the recap path (`debugLogger.warn`).

All failures are **fully transparent** to the user — recap is an
auxiliary feature and never throws into the UI. Developers can grep for
the `[SESSION_RECAP]` tag in the debug log file: written by default to
`~/.qwen/debug/<sessionId>.txt` (`latest.txt` symlinks to the current
session); disable via `QWEN_DEBUG_LOG_FILE=0`.

## Out of Scope

| Item                                             | Why not                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Progress UI for `/recap` (spinner / pendingItem) | 3-5 second wait is tolerable; adds complexity.                                                                                           |
| Automated tests                                  | Service is small (~150 lines), end-to-end tested manually first; unit tests can land in a separate PR.                                   |
| Localized prompts                                | The system prompt is for the model; English is the most reliable substrate. The model selects the output language from the conversation. |
| `QWEN_CODE_ENABLE_AWAY_SUMMARY` env var          | Claude Code uses it to keep the feature on when telemetry is disabled; Qwen Code's current telemetry model doesn't need this.            |
| Auto-recap on `/resume` completion               | A natural follow-up but needs a hook point in `useResumeCommand`; out of scope for this PR.                                              |
