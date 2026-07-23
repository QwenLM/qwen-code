# Java daemon SDK 0.1.0-alpha

## Status

This document defines the first daemon transport in the existing
`com.alibaba:qwencode-sdk` artifact. It is intentionally independent from the
legacy stdio implementation under `com.alibaba.qwen.code.cli`.

## Goals

- Add a Java 11 API for `qwen serve` without creating another Maven artifact.
- Deliver streamed text, thought, tool, usage, permission, and raw events in
  daemon order.
- Return prompt text only after a matching reliable terminal event.
- Resume a prompt stream from the admission watermark without replay gaps or
  duplicate observer delivery.
- Make ambiguous mutation outcomes and incomplete prompt outcomes explicit.
- Keep client-owned threads, streams, sessions, and detach attempts bounded.

## Public surface

`DaemonClient` owns HTTP and worker resources, reads capabilities, and creates
sessions. Session creation defaults to `sessionScope=thread`. Blocking prompt
observation uses a configurable bounded worker pool rather than a global or
unbounded executor.
The shared timer only dispatches watchdog actions. Potentially blocking SSE
stream closure runs on a separate bounded pool sized to the prompt concurrency
limit, so one stalled close cannot delay another session's deadline or idle
watchdog. Each admitted prompt reserves bounded stream-cleanup capacity until
its final close task finishes. A stalled close can therefore cause a later
`startPrompt` call to fail with `DaemonClientCapacityException`, but it cannot
silently discard a deadline-triggered close or grow cleanup work without bound.

`DaemonSessionClient` owns one daemon session and admits at most one local
prompt at a time. `startPrompt` returns a `PromptCall` immediately. Its
admission and terminal futures are independent, so a caller can distinguish
"the daemon accepted this prompt" from "the turn ended reliably".
Admission and terminal future continuations are dispatched through a separate,
client-owned executor so user continuations cannot delay SSE observation, its
local timeout, or prompt transport capacity. Exceptional completion follows
the same path. Publication capacity is bounded relative to
`maximumConcurrentPrompts`; continuations that remain blocked can therefore
cause a later `startPrompt` call to fail with `DaemonClientCapacityException`
instead of creating unbounded threads or queued work.

An indeterminate completion is not a session-reuse boundary. After admission
becomes unknown or an admitted prompt ends indeterminately, the session client
permanently rejects further prompts even if local stream cleanup succeeds.
A local observation timeout is published without waiting indefinitely for
stream closure; cleanup continues asynchronously and retains bounded client
capacity until it finishes. Callers close or destroy the affected session.

`PromptObserver` receives typed callbacks and the raw event. Callbacks execute
serially on a client-owned daemon thread. An event cursor advances only after
all applicable callbacks return successfully. Callbacks must therefore return
promptly, must not wait on the same `PromptCall`, and must not close or destroy
the same session from a callback. Responding to a permission from its callback
is supported; the response method returns `false` when the daemon reports that
the request was already resolved or is no longer pending.

`promptText` is a convenience over `startPrompt`. It collects only assistant
text, enforces a UTF-8 byte limit, and returns a `PromptTextResult` only for a
matching `turn_complete`. A `turn_error` remains a reliable terminal but is
reported as `PromptTurnException`; any outcome without a reliable terminal is
reported as `PromptOutcomeIndeterminateException` with explicitly incomplete
partial text when available.

Fastjson2 encoding and strict Jackson Core decoding are implementation details.
Decoding rejects non-standard JSON and duplicate object keys. Public raw JSON
values use Java `Map`, `List`, scalar, and null values.

Creation-time model selection is intentionally not exposed in this alpha.
The daemon keeps a fresh session alive on the default model when
`modelServiceId` is rejected and reports the rejection only through an SSE
event emitted before the create response. The per-prompt subscription starts
from the later admission watermark, so it cannot prove that the requested
model was selected without adding a separate session-event lifecycle.

Before session creation, the SDK requires the daemon to advertise REST and
`session_scope_override`; it refuses to mutate when an older daemon could
silently ignore the requested scope. While a session remains open, the SDK
sends a new heartbeat mutation once per configured interval (one minute by
default) only when the daemon advertises `client_heartbeat`, and stops on
detach or destroy. Each heartbeat has the normal finite-request deadline and
is not retried; setting the interval to zero disables automatic keepalive.
Likewise, a prompt carrying `deadlineMs` is rejected before admission unless
the daemon advertises `prompt_absolute_deadline`, so a requested server-side
deadline cannot be silently ignored. The local observation timeout remains
independent and is always enforced by the SDK.

## Wire flow

1. Send one non-retried `POST /session/:id/prompt`.
2. Require `202` and validate `{promptId,lastEventId}`.
3. Open `GET /session/:id/events` with `Last-Event-ID` set to the watermark.
4. Replay and observe only events correlated with that prompt, while treating
   session-level failure frames as fatal.
5. Stop only on matching `turn_complete` or `turn_error`.

This per-prompt subscription covers content and terminal events emitted before
the `202` response reaches the client. It does not require an unknown-prompt
cache or a long-lived session pump.

## Transport contract

The JDK `HttpClient` uses HTTP/1.1 and never follows redirects. Every request
sends JSON or event-stream `Accept` headers, bearer authentication when
configured, and the daemon-issued `X-Qwen-Client-Id` after session creation.
SSE additionally sends `Accept-Encoding: identity`, `Cache-Control: no-cache`,
and `Last-Event-ID`.

Finite JSON and error bodies are consumed by a bounded subscriber and raced
against the request deadline through `sendAsync`; receiving response headers
does not end that deadline. Non-success SSE bodies are separately bounded by
the shorter of the request and prompt-observation budgets.

The SSE parser accepts LF and CRLF framing, comments, and multiple `data:`
lines. UTF-8 decoding is strict. Frames, event names, envelope version, numeric
IDs, and SSE/envelope ID consistency are validated. A malformed frame, an ID
gap, `state_resync_required`, session death, observer failure, idle timeout, or
reconnect exhaustion fails closed.

IDs at or below the committed cursor are duplicates and are not delivered.
The next numeric event must be exactly `cursor + 1`. Synthetic ID-less events
are accepted only for the daemon's documented control frames and do not move
the cursor; an ID-less content or terminal event fails closed. The
implementation reconnects only the SSE GET, using bounded exponential
full-jitter backoff, the SSE `retry` directive after a stream disconnect, and
`Retry-After` on retryable HTTP responses. Mutations are never retried
automatically.

## Ambiguous and terminal outcomes

If prompt transport fails after dispatch without a validated `202`, or returns
HTTP 408 or 5xx, the admission future fails with
`PromptAdmissionUnknownException`; the SDK never reposts the prompt. Session
creation applies the same conservative classification through
`SessionCreationOutcomeUnknownException`. Permission, cancel, heartbeat,
detach, and delete apply the same classification because an intermediary
response does not prove that the daemon rejected the mutation. Detach uses the
more specific `DetachOutcomeUnknownException`. Every mutation is attempted at
most once per method invocation.

Only matching `turn_complete` and `turn_error` are terminal. Queue and
`prompt_cancelled` events are advisory. A local timeout stops observation but
does not automatically cancel the daemon turn. A cooperative daemon
cancellation completes as `turn_complete` with `stopReason=cancelled`, while an
agent or provider failure during cancellation can produce `turn_error`.
`promptText()` returns the complete result and surfaces the error terminal as
`PromptTurnException`; callers must wait for the terminal in both cases.
When cancellation, deadline, teardown, or agent settlement race, the daemon's
exactly-once latch publishes the first formal terminal and suppresses later
candidates. The SDK therefore treats the received terminal as authoritative
instead of deriving an outcome from the last control mutation it sent.

`close()` is locally idempotent, stops local observation, and attempts detach
at most once. A lost detach response is not retried. `destroySession()` is the
only API that issues `DELETE /session/:id`; it may be called after detach.

## Compatibility and non-goals

The whole artifact now requires Java 11. Java 8 users must remain on
`0.0.3-alpha`. The stdio API remains source-compatible but now runs on Java 11
and obtains logging through `slf4j-api`; applications choose their own SLF4J
provider because Logback is test-only.

The compatible daemon is the qwen-code build released from the same source
revision as the SDK. It contains the per-client detach ledger from #7386, the
per-epoch terminal guarantee from #7400, and this release's acknowledged
admission cancellation plus FIFO cancel-drain fence. The #7400 commit alone can
still acknowledge cancel before agent dispatch without stopping the admitted
prompt, or let an unacknowledged session-scoped cancel reach a queued successor.
The bundled ACP child handles the daemon's internal cancellation request through
one acknowledged admission-aware handshake. A custom standards-compliant ACP
child that does not implement that extension receives one standard
`session/cancel` notification instead. The
daemon does not advertise a capability that distinguishes these implementations
with the same REST/SSE feature set, so the SDK cannot negotiate this minimum at
runtime and fails closed when a formal terminal is absent.

The handshake intentionally waits for the targeted prompt call to settle before
the FIFO may dispatch its successor. Adding an acknowledgement-only timeout
would allow a late session-scoped cancel to reach that successor and would break
the ordering guarantee. Consequently, a provider, tool, or custom integration
that ignores its `AbortSignal` indefinitely can leave the cancel mutation
outcome unknown and the session unusable. Reclaiming a wedged shared ACP child
without terminating sibling sessions requires stronger runtime isolation and is
outside this alpha.

The alpha does not promise exactly-once execution across daemon restarts,
automatic epoch recovery, snapshot/resync, persisted cursors, or true
prompt-ID-targeted cancellation. It also does not expose creation-time model
selection until the daemon can return a definitive result or the SDK owns a
session-event lifecycle from `Last-Event-ID: 0`. An ambiguous create can leave
a daemon session that the caller cannot identify or detach until daemon-side
reaping. Those cases require stronger daemon contracts.

## Verification

Unit tests use an in-process HTTP server to inject SSE fragmentation, slow
single-line delivery, replay, duplicates, gaps, conflicting prompt IDs,
opaque future event data, watermark replay, disconnects, compressed responses,
stalled finite bodies, resync, observer failures, terminal absence, and
ambiguous mutation responses. Lifecycle tests cover one-local-prompt admission,
admission/close serialization, deadline terminal followed by session reuse,
cancelled completion, teardown terminal ordering, bounded text, automatic
heartbeat, idempotent close, detach client identity, detach-once, and explicit
destroy.

CI compiles and tests on Java 11, 17, and 21 on Linux, with Java 21 smoke
coverage on macOS and Windows. Linux CI and the protected release workflow run
an E2E against a real `qwen serve` process with a temporary workspace and
model stub.
