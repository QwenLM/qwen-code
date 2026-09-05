# SSE Stream and Client Observability

## Context

`GET /session/:id/events` currently exposes a long-lived REST/SSE stream but
does not give an operator enough stable identity to reconstruct a connection
timeline. The daemon logs stream open and close, while EventBus logs slow
subscriber warnings and evictions independently. Those records cannot be
joined to a particular physical stream, and an SDK reconnect does not explain
why it opened a replacement stream.

This design adds diagnostic-only identity and lifecycle records. It does not
change replay, reconnect, backpressure, subscriber eviction, or stream
supersession behavior.

## Wire contract

The REST/SSE subscription accepts the existing `X-Qwen-Client-Id` request
header plus two optional query parameters:

- `connectReason`: `initial`, `resume`, `prompt_restart`, `stream_end`,
  `transport_error`, `state_resync`, or `unknown`.
- `previousStreamId`: the UUID of the previous accepted REST/SSE stream as
  reported by the client.

A successful subscription returns `X-Qwen-SSE-Stream-Id`, a daemon-generated
UUID. CORS exposes this response header. Invalid diagnostic values are ignored
or normalized to `unknown`; they never reject a subscription. Connect reason
and predecessor are untrusted diagnostic hints and must never drive auth,
eviction, deduplication, or supersession.

Old daemons ignore the new query parameters. Old clients omit them and ignore
the response header. No capability negotiation is required.

## EventBus diagnostics

`SubscribeOptions` gains a synchronous `onSubscriberDiagnostic` callback. It
receives a discriminated `slow_client_warning` or `client_evicted` record with
the existing queue measurements plus the type and serialized size of the event
that crossed the threshold. It never receives the event payload.

The callback returns whether it emitted the human-facing diagnostic. A false
return or exception preserves the existing EventBus stderr line. Callback
failures remain inside EventBus so `publish()` keeps its never-throws contract.
EventBus remains unaware of session, client, and stream identity; the SSE route
adds that context in its callback closure.

## Lifecycle telemetry

Each accepted stream produces `opened` and `closed` lifecycle records. Slow
subscriber warnings, evictions, and `state_resync_required` frames produce
additional records. Their OTel event names are:

- `qwen-code.daemon.sse.opened`
- `qwen-code.daemon.sse.slow_client_warning`
- `qwen-code.daemon.sse.client_evicted`
- `qwen-code.daemon.sse.state_resync_required`
- `qwen-code.daemon.sse.closed`

The route captures its request telemetry context before installing the
EventBus callback. Every lifecycle log runs under that captured context so a
warning emitted from a model/publisher call is parented to the correct
long-lived SSE request span.

The common attributes are `session.id`, `qwen-code.client_id`,
`qwen-code.daemon.sse.stream_id`,
`qwen-code.daemon.sse.client_reported_connect_reason`, and
`qwen-code.daemon.sse.client_reported_previous_stream_id`. Stream/client ids
remain span and log attributes only; they are not metric labels.

The close record and request span also receive stream duration, settled event
frame count, last written event id, backpressure count, maximum drain wait,
maximum live publish-to-write-settled time, slow-warning count, EventBus
eviction reason, terminal event type, and close reason. The duration attribute
and all other close attributes are fully namespaced. In particular, duration
must not use the special bare `duration_ms` attribute interpreted by the
Log-to-Span bridge as a span start duration.

The exact close attributes use the `qwen-code.daemon.sse.*` namespace:
`duration_ms`, `event_frames_write_settled`, `last_event_id_written`,
`backpressure_count`, `max_drain_wait_ms`,
`max_live_publish_to_write_settled_ms`, `slow_warning_count`,
`event_bus_eviction_reason`, `terminal_event_type`, and `close_reason`. Close
reason is one of `writer_idle_timeout`, `socket_error`, `iterator_error`,
`event_bus_evicted`, `session_terminal`, `source_complete`, or
`client_disconnect`.

Replay timestamps are excluded from live lag. A resumed stream begins live
lag measurement only after its `replay_complete` frame settles; a fresh stream
starts immediately. The measurement describes daemon write settlement, not
browser consumption.

## SDK ownership

Raw SDK subscription options expose client identity, connect reason,
predecessor, and an accepted-stream callback. `DaemonSessionClient` owns the
identity and lineage fields for session-scoped callers. It tracks successful
REST handshake state separately from the latest response stream id so a
successful old-daemon handshake without the new header is followed by
`resume`, not another `initial`.

Lineage covers adjacent accepted REST/SSE streams on the same session client.
Switching to ACP HTTP or WebSocket clears REST lineage. WebUI supplies only the
exceptional reasons it can prove (`prompt_restart`, `stream_end`,
`transport_error`, `state_resync`); the session client infers ordinary
`initial` and `resume` connections.

## Gateway and rollout

A gateway must preserve `X-Qwen-Client-Id`, both query parameters, existing
trace context, `X-Qwen-SSE-Stream-Id`, and the exposed-header list. It must
continue unbuffered, uncompressed event-stream forwarding. Gateway indexes
should cover session, client, stream, predecessor, connect reason, close
reason, queue/backpressure measurements, and bounded trigger event fields.
They must not contain authorization data, tokens, or SSE payloads.

Operational queries apply these interpretations:

- Consecutive `prompt_restart` streams with complete predecessor links and no
  backpressure indicate client-driven restart churn.
- Warnings or evictions accompanied by high drain wait indicate a slow client
  or buffering proxy.
- A byte threshold with a large trigger event points to a large-frame problem;
  a frame threshold with small events points to many-frame accumulation.
- `state_resync_required` is a replay/ring gap and is not evidence of live
  network lag.
- A long request span with no warning or backpressure is a normal quiet
  long-lived connection.

Roll out daemon/EventBus support first, gateway forwarding second, and
SDK/WebUI attribution last. This yields useful server-side lifecycle records
for old clients while retaining full cross-version compatibility.

## Non-goals

- Active-stream lists in daemon status.
- Host or WebUI telemetry callbacks.
- Per-event logs or high-cardinality metric labels.
- Automatic replacement of overlapping streams.
- ACP HTTP or WebSocket stream observability.
