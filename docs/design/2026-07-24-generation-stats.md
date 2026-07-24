# Generation timing metrics in `/stats`

## Context

Issue #4252 asks `/stats` to show generation timing separately from session
wall time and end-to-end API latency. The low-level timing already exists:

- `LoggingContentGenerator` measures `ttftMs` from request dispatch to the
  first user-visible streamed chunk.
- `endLLMRequestSpan` derives `sampling_ms` and
  `output_tokens_per_second`.
- `ApiResponseEvent` already carries request duration, model, prompt id, and
  output-token count into `UiTelemetryService`.

The missing link is making the existing TTFT value available to the
content-free session metrics used by `/stats`.

## Scope

This change adds live, session-scoped generation metrics to:

- the interactive `/stats` Session tab;
- the non-interactive `/stats` text response.

It does not add a second timer, persist timing in daily/monthly token-usage
files, change exports, or change the daemon/Web Shell stats schema.

## Data flow

```text
LoggingContentGenerator.loggingStreamWrapper
  -> ApiResponseEvent(ttft_ms)
  -> logApiResponse
  -> UiTelemetryService
  -> SessionMetrics.generation
  -> SessionContext
  -> /stats
```

`ttft_ms` is optional. Non-streaming responses and streams that finish without
user-visible content keep the current behavior and do not create a generation
sample.

## Metrics and semantics

For each successful streamed response with TTFT:

- **TTFT** is the existing `ttftMs` measurement.
- **Generation time** is `max(0, duration_ms - ttft_ms)`, measured from the
  first user-visible streamed content through completion.
- **TPS** is `output_token_count / generation_time_seconds`. It is unavailable
  when generation time is zero.

`SessionMetrics.generation` is created lazily and contains:

- the latest completed request's model, TTFT, generation time, and output-token
  count;
- total timed request count and TTFT, plus generation time and output tokens for
  throughput-eligible requests.

The session average TTFT is the arithmetic mean across timed requests. Session
TPS is weighted throughput: total output tokens divided by total generation
time. Requests with zero generation time contribute to TTFT statistics but not
to either side of the session TPS calculation. This avoids division by zero and
over-weighting short requests.

Internal helper prompts are excluded from generation metrics. They are not
recorded in the resumable transcript, and including them would both surprise
users and make live and resumed session values disagree. Main-conversation and
subagent requests remain included, matching the existing session-level model
statistics.

## Compatibility

- `ApiResponseEvent.ttft_ms` and `SessionMetrics.generation` are additive and
  optional.
- Existing recorded events and callers remain valid.
- Existing daily/monthly records continue to contain token and API-duration
  data only, preserving the ownership boundary documented in
  `issue-4479-token-usage-stats-coordination.md`.
- The Session context clone/equality logic copies and compares the optional
  generation object so the interactive dashboard updates on every completed
  timed request.

## Validation

- Core tests prove aggregation, internal-prompt exclusion, zero-generation
  handling, session isolation, and reset behavior.
- LoggingContentGenerator tests prove the captured TTFT reaches
  `ApiResponseEvent` and remains absent for non-visible streams.
- CLI tests prove non-interactive output and interactive Session-tab rendering.
- i18n tests cover every built-in locale for the new high-visibility labels.
