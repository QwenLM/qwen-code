# Retry classification for headless provider retries

[English](retry-classification-headless-diagnostics.md) | [简体中文](retry-classification-headless-diagnostics.zh-CN.md)

## Problem and scope

When a provider attempt fails during a stream and the transport/stream-replay
loop schedules a retry, headless (non-interactive and SDK) consumers see only
`Retrying provider attempt (N buffered tool call(s) discarded).` on stderr —
no reason, attempt counter, or status. The `RETRY` stream events on these paths
carry no `retryInfo`, so the CLI falls back to the bare message, while the rich
classification (`errorKind` / `classificationReason` / `transportCode` /
`statusCode`) is written only to the debug log file, which is off unless
`QWEN_DEBUG_LOG_FILE` is set. During the v0.26.1 release this silence cost
three bounded diagnostic rounds to attribute a 6-hour SDK release stall to an
intermittently unresponsive model endpoint ([#15498](https://github.com/QwenLM/qwen-code/issues/15498)).

Scope: emit an allowlisted scalar classification with retry decisions that
otherwise surface no reason, visible on the headless stderr channel. Interactive
TUI behavior, retry decisions, counts, delays, and stream semantics do not
change. Interactive UI surfaces are out of scope (see #12020).

## Decision

Do not attach `retryInfo` to these events. Interactive consumers key on
`retryInfo` presence to start a countdown (`use-llm-stream.ts`), so doing so
would change interactive behavior.

Add an optional `retryDiagnostics` field to the `RETRY` stream event
(`llm-chat.ts`) and the passthrough `ServerLlmRetryEvent` (`turn.ts`). Populate
it where a bare retry is scheduled with a classification in scope: the
transport/stream-replay branch and the continuation-recovery branch that asks
the model to resume a cut answer. `turn.ts` passes the field through so the
non-interactive CLI and SDK protocol events can read it.

The field carries only allowlisted scalars: `kind` and `reason` are fixed
identifier strings from `retryErrorClassification.ts`, `transportCode` comes
from a vetted code set, and `statusCode` is numeric. `providerCode`,
`requestId`, and `providerMessage` are arbitrary upstream strings and are not
included. The extraction lives in one place: `toRetryDiagnostics` in
`retryErrorClassification.ts`, so the allowlist is enforced at the source.

`emitRetryProgress` in `nonInteractiveCli.ts` appends the classification to the
fallback message:

```
Retrying provider attempt (0 buffered tool call(s) discarded) [kind=transport, reason=transport-error, transportCode=UND_ERR_SOCKET].
```

## Constraints

- No changes to retry decisions, counters, delays, or stream event ordering.
- No arbitrary upstream strings in user-visible output.
- No interactive UI changes; the OpenTUI/Ink adapters ignore the new field and
  their retryInfo-based behavior is unchanged.
- Optional, additive event field; structured output consumers unaffected.
- Out of scope: the retry-_not-taken_ / exhausted decision emits no stream
  event today, and adding one would wrongly signal an attempt restart to
  consumers that reset state on RETRY. Surface it separately once a suitable
  non-retry diagnostic event exists. The max-tokens truncation recovery loop
  is a planned continuation (no failed attempt) and stays unannotated.
  Interactive surfaces stay out of scope (#12020).

## Validation plan

- Unit: `toRetryDiagnostics` keeps only allowlisted fields, omits undefined
  optionals, and strips `providerCode`/`providerMessage`/`requestId`.
- Unit: core stream replay and continuation recovery attach the exact
  classification derived from the mocked socket cut (`llm-chat.test.ts`); the
  retry helper's existing local name for the full classification is
  disambiguated from the sanitized type (`retry.ts`); turn passes events
  through (`turn.test.ts`).
- Unit: headless CLI prints the suffix for both output formats and keeps the
  existing bare message when no diagnostics are present.
- Evidence from diagnostics: the field values match the classification that the
  v0.26.1 diagnostic branch proved sufficient (`kind=transport`,
  `reason=transport-error`, no status).

## Acceptance criteria

- A transport-level stream stall in headless mode shows `kind/ reason [/ transportCode / statusCode]` on stderr without `QWEN_DEBUG_LOG_FILE`.
- `npm run build`, typecheck, and the targeted core and CLI suites pass.
- #15513 can close on merge.
