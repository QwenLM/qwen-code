# Model stream attempt state

## Problem

`GeminiChat.sendMessageStream()` exposes chunks plus retry, compression, and
model-fallback control events. Its consumers currently keep their own copies of
the same per-attempt state: text, thoughts, tool calls, usage, response ids,
finish reasons, and output-truncation markers.

The implementations have drifted. The sub-agent loop ignores model fallback
and treats continuation retries as fresh restarts. ACP background notifications
keep failed-attempt text and usage across fresh retries and fallbacks. Other ACP
loops reset tool calls but can retain stale usage. MessageDisplay also has no
way to discard text from a restarted attempt.

## Design

Add a small core `ModelStreamAttemptState` that consumes the existing
`StreamEvent` union and owns only protocol-derived state. It returns a compact
transition for each event so callers can keep their surface-specific side
effects.

The state applies these rules:

- chunks append visible text, thought text, and function calls, and replace the
  latest usage, response id, and finish reason;
- every retry clears tool calls and per-attempt metadata;
- continuation retries preserve accumulated text and thought text;
- fresh retries and model fallback discard accumulated text and thought text;
- model fallback always starts a fresh attempt;
- compressed events do not change attempt state.

`Turn`, the sub-agent reasoning loop, forked queries, speculation, and all ACP
raw-stream loops consume the same transitions. `MessageDisplayDispatcher` gains the same
`restartAttempt(preserveText)` operation already used by telemetry output
capture, so hook output follows the stream contract.

The helper deliberately stays on the current Google response type. This change
centralizes stream lifecycle semantics without attempting the larger protocol
migration. A future protocol boundary can translate provider-neutral chunks
into the same transition model.

## Non-goals

- Change provider request or response protocols.
- Unify UI, ACP, and sub-agent rendering side effects.
- Change retry or fallback policy inside `GeminiChat`.
- Rework tool execution scheduling.

## Verification

- Pure state tests cover fresh retry, continuation retry, fallback, metadata,
  and truncation reset.
- Sub-agent tests prove continuation text is preserved and fallback state is
  discarded.
- Forked-query and speculation tests keep only the active attempt.
- ACP background-notification tests prove output, usage, and MessageDisplay do
  not retain a failed attempt.
- Existing Turn and ACP stream tests remain green.
