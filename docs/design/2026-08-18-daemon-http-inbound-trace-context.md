# Daemon HTTP inbound trace context

## Motivation

The daemon already _propagates_ trace context outbound: prompt requests carry a
`traceparent` inside JSON-RPC `_meta`, and the daemon extracts it to parent its
bridge spans (`extractDaemonTraceContext`). The HTTP surface, however, only
_records_ request spans — every `qwen-code.daemon.request` span starts a new
trace. An HTTP caller that forwards the standard W3C `traceparent` header
(corporate proxies, OTel-instrumented clients, ACP gateways) gets no linkage:
the server-side span cannot be joined back to the caller's trace, so
cross-service debugging falls back to timestamps.

W3C Trace Context extraction at the HTTP server edge is standard
`SpanKind.SERVER`-adjacent behavior per the OTel HTTP semantic conventions, and
the plumbing already exists: `withDaemonSpan` accepts an explicit
`parentContext`.

## Design

1. **Core** (`daemon-tracing.ts`): the existing `_meta` extraction logic
   (propagation.extract first, strict `00`-version manual fallback so behavior
   is identical with and without a registered global propagator) moves into a
   shared `contextFromTraceparentValues` helper. A new
   `extractDaemonHttpTraceContext(headers)` reads `traceparent`/`tracestate`
   from a Node-style (lowercased) header object and reuses that helper.
   `DaemonRequestSpanOptions` gains an optional `parentContext` passed straight
   through to `withDaemonSpan`.
2. **Serve middleware**: `daemonTelemetryMiddleware` extracts from
   `req.headers` per request (fail-closed to `undefined`, telemetry never
   affects handling) and passes the context only when extraction succeeded —
   requests without a valid header keep the exact current span shape.

## Non-goals

- No new span kinds or attributes: existing `qwen-code.daemon.request` spans
  stay `SpanKind.INTERNAL` with the same attributes; only the parent link
  changes when a valid header is present.
- No `traceparent` _response_ injection and no W3C `tracingresponse` support.
- No cross-service sampling decisions: `traceFlags` are honored by the SDK's
  default sampler behavior only.

## Alternatives considered

- Changing the request span to `SpanKind.SERVER` per HTTP semconv: more
  spec-aligned long-term, but it mutates the shape of every existing
  daemon.request span and can shift backend grouping; deferred as a follow-up.
- Extracting inside the core `withDaemonRequestSpan` from a raw header bag:
  rejected because core request-span options are transport-primitive today;
  the middleware is the only place that knows the carrier is HTTP headers.

## Testing

- Unit: header extraction (valid / absent / malformed / all-zero ids / array
  value), request-span parenting through `withDaemonRequestSpan`, and
  middleware pass-through (present vs omitted key).
- Dry run: `serve` with `QWEN_TELEMETRY_OUTFILE`, one curl with a fixed
  `traceparent` — exported span must share the header's traceId and parent to
  its spanId; a control request without the header must stay on its own trace.
