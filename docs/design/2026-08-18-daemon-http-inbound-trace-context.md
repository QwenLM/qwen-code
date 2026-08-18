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
   (global `propagation.extract` first, then a direct
   `W3CTraceContextPropagator` instance as fallback, so acceptance rules —
   future traceparent versions, `tracestate`, all-zero ids — are identical
   with and without a registered global propagator) moves into a shared
   `contextFromTraceparentValues` helper. A new
   `extractDaemonHttpTraceContext(headers)` reads `traceparent`/`tracestate`
   from a Node-style (lowercased) header object and reuses that helper.
   `DaemonRequestSpanOptions` gains an optional `parentContext` passed straight
   through to `withDaemonSpan`.
2. **Serve middleware**: `daemonTelemetryMiddleware` extracts from
   `req.headers` per request (fail-closed to `undefined`, telemetry never
   affects handling) and passes the context only when extraction succeeded —
   requests without a valid header keep the exact current span shape.
   Extraction is gated on `isTelemetrySdkInitialized()` so telemetry-off
   deployments pay no hot-path parse cost, and a present-but-invalid header
   emits a debug daemon log (`qwen-code.daemon.traceparent.invalid`) so a
   rejected header is diagnosable from daemon logs alone.

   Note the whole subtree relocates with the request span, not just
   `daemon.request` itself: session-subprocess spans reached via `_meta`
   (prompt / model / tool) also join the caller's trace, so anything
   aggregating or alerting by `traceId` sees session-side spans change
   ownership too.

## Sampling policy

The caller's `sampled` bit is not adopted verbatim on the HTTP path. Under
the default `parentbased_always_on` sampler (the daemon SDK configures no
sampler), a remote unsampled parent delegates to `AlwaysOffSampler` and would
silently delete the request span, everything under `next()`, and — via the
`_meta` forwarding — the session-subprocess spans. `sampled=0` is simply the
caller's head-based ratio sampling, so inbound HTTP parents force
`TraceFlags.SAMPLED` through the same `shouldForceSampled()` decision matrix
as the synthetic session root: `parentbased_*` defaults and `always_on` force
sampling; `parentbased_always_off` honors the operator's opt-out;
non-parentbased samplers (e.g. `traceidratio`) keep the caller's flags and
decide per span. The `_meta` path (daemon → subprocess) keeps flags
verbatim — that parent is our own span, whose sampling already followed this
policy at the HTTP edge.

## Non-goals

- No new span kinds or attributes: existing `qwen-code.daemon.request` spans
  stay `SpanKind.INTERNAL` with the same attributes; only the parent link
  changes when a valid header is present.
- No `traceparent` _response_ injection and no W3C `tracingresponse` support.
- No new sampling configuration surface: the inbound policy reuses the
  existing `shouldForceSampled()` matrix (see above); the SDK's own sampler
  remains the only sampler authority.

## Alternatives considered

- Changing the request span to `SpanKind.SERVER` per HTTP semconv: **known
  gap** — `qwen-code.daemon.request` is the daemon's only SERVER-adjacent
  span (`HttpInstrumentation` never patches the server side here because the
  SDK loads lazily), so backends deriving service topology / RED metrics
  from SERVER spans (Tempo service-graph, ARMS) will not recognize the
  daemon as a service inside the caller's trace. Switching would mutate the
  shape of every existing daemon.request span and can shift backend
  grouping; deferred as a follow-up.
- Extracting inside the core `withDaemonRequestSpan` from a raw header bag:
  rejected because core request-span options are transport-primitive today;
  the middleware is the only place that knows the carrier is HTTP headers.

## Testing

- Unit: header extraction (valid / absent / malformed / all-zero ids / array
  value / version `ff` / version `00` with extension field / future version
  `01` / inbound `tracestate`), request-span parenting through
  `withDaemonRequestSpan`, the sampled-flag decision matrix (default forced,
  `parentbased_always_off` and `traceidratio` verbatim, `_meta` path
  verbatim), middleware pass-through (present vs omitted key, telemetry-off
  skip, rejected-header debug log), and a type-level guard keeping
  `parentContext` on `DaemonRequestSpanOptions`.
- Dry run: `serve` with `QWEN_TELEMETRY_OUTFILE`, one curl with a fixed
  `traceparent` — exported span must share the header's traceId and parent to
  its spanId; a control request without the header must stay on its own trace.
