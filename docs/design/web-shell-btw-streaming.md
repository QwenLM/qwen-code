# Web Shell BTW streaming

[English](web-shell-btw-streaming.md) | [简体中文](web-shell-btw-streaming.zh-CN.md)

## Problem and current behavior

Web Shell waits for the complete JSON BTW answer and gives up after 30 seconds.
The child and bridge also impose 55/60-second deadlines. Model output already
arrives in chunks but is accumulated internally. Users need visible partial
answers and simple recovery from temporary network disconnections.

## Proposed solution

Keep the existing `POST /session/:id/btw` API and its behavior unchanged. Add
`POST /session/:id/btw/stream` with `question`, a client-generated `requestId`,
and an optional `resume` flag. It emits SSE answer snapshots and terminal
`done` or `error` events. Every answer snapshot contains the accumulated answer;
the UI replaces its answer instead of appending, so reconnects cannot duplicate
text. Partial snapshots preserve whitespace; the final snapshot trims leading
and trailing whitespace to match the existing JSON BTW result. Reconnect uses the same request ID and receives the latest snapshot.
A resume with no retained request returns 410 and never starts another model call.
Reusing an ID for a different question is rejected.

The daemon retains one answer string per request, not an event journal. Network
disconnect only detaches the subscriber; generation continues. Explicit
`DELETE /session/:id/btw/stream/:requestId` cancels generation, including a
short-lived cancellation marker if cancellation reaches the server before start.
New requests have a 300-second daemon deadline, a 305-second child deadline,
and a 310-second bridge deadline, allowing the daemon to report `btw_timeout`
before upstream cleanup. If the BTW bridge deadline itself is reached, it also
sends a best-effort cancellation for that generation without cancelling the main task. Completed requests and cancellation markers remain
available for up to 60 seconds. Each runtime permits at most 32 retained requests;
admission evicts the earliest registered terminal entry when full, or returns
429 if all entries are active. Answers are limited to 1 MiB. Active requests
are never evicted to admit another request.
SSE uses existing 15-second heartbeats and backpressure-aware writes.

The SDK retries network errors and retryable HTTP responses with bounded backoff
and a 60-second reconnect budget. No new POST is started at or after the outage
deadline; exhaustion returns the last failure and still attempts explicit DELETE.
Until a successful HTTP response is observed,
retries use the same ID without `resume`; the live daemon cache deduplicates
an accepted request even if its headers were lost. After observing success,
retries use `resume: true`, so lost state fails with 410 instead of starting
another generation. This does not guarantee deduplication across daemon restarts.
It uses native REST fetch even when the main
session transport is ACP HTTP/WS. Cancellation interrupts reconnect waits and
sends the explicit DELETE. Application errors and expired requests terminate.
Web Shell bypasses its ordinary 30-second action deadline only for this stream.
The UI consumes answer/done snapshots without synthetic wire request IDs,
requires a terminal event, and preserves partial text when a stream fails,
while displaying the server error message through the existing notice. Both
SSE errors and HTTP errors preserve the server code in notice metadata; the
toast displays the message rather than a raw machine code.

The BTW panel follows new output by default, including delayed Markdown layout
changes. Scrolling up pauses following; returning within two pixels of the
bottom restores it. Every new question starts with following enabled.

The daemon advertises `session_btw_stream` only when every registered runtime
bridge implements the streaming method. The initial Qwen daemon bootstrap
advertises the same feature. Web Shell checks this independent flag before
starting each BTW: absent or unavailable capability information uses the
existing JSON request and its original 30-second action deadline, exposing the
result as a terminal UI snapshot. Once a stream starts, errors never trigger a
second JSON model request. SDK stream callers must preflight the same feature.

## Decisions and scope

Do not send BTW events through the main agent's shared/replayed session stream:
its consumers include transcript and other attached clients. Reuse the existing
request-scoped generation queue, notifications, cancellation, SSE helpers, and
forked-query context/tool restrictions instead. Add an internal BTW generation
purpose and a text callback to the cache-path fork helper; the legacy BTW method
continues using its original path. No event log, persistent storage, transport
redesign, new dependency, or daemon-restart recovery is needed. Streaming BTW
retains the existing SSH-workspace restriction; ordinary stateless generation
keeps its existing SSH behavior.

Both new routes are live-session-owner scoped. Existing owner resolution and
mutation/trust gates apply on every start, reconnect and cancel. In-memory state
is scoped by the resolved bridge identity, session, client and request ID; it
cannot cross workspaces or fall back to the primary runtime. In-flight side
requests count as local work so idle cleanup cannot interrupt disconnected
generation; the hold releases when generation settles. This deliberately applies
to all existing side requests, including legacy JSON BTW, recap, stateless
generation, fork launch, and workflow/goal actions that start work. They also
prevent required-idle bridge close while pending. Existing JSON route admission
and deadlines remain unchanged; explicit bridge close retains its normal rules. Shared archive admission
covers request validation and registration only, rather than the generation
lifetime, so intentional session close and daemon shutdown can abort pending
work even after the subscriber disconnects. A recorded client may
cancel its own cached request after detach; unknown cancellation markers still
require current session membership. User cancellation,
session/workspace changes, and superseding a BTW retain existing stale-result
guards and do not cancel or append to the main task.

Affected areas: core fork helper; ACP bridge request generation; CLI ACP handler
and owner-scoped routes/request snapshots; SDK BTW stream; Web Shell action,
answer panel and browser fixtures; focused unit and browser tests.

## Validation and acceptance criteria

- Preserve the old JSON response, deadlines and generic generation protocol;
  apply side-request idle protection consistently to legacy BTW and generation.
- Advertise streaming support accurately; missing features/capabilities use only
  JSON, advertised support uses only SSE, and stream failure never retries JSON.
- Show partial BTW answers before completion, including responses over 30 seconds;
  verify original and resumed real HTTP streams before releasing model completion.
- Follow new output, pause while reading older text, resume at the bottom, and
  reset following for a new question. Preserve partial answers on terminal failure.
- Keep main-task execution and transcript isolated while BTW runs.
- Disconnect/reconnect yields the latest answer without duplicate model work or text.
- Recover failures before response headers without a false 410 or duplicate live
  generation. Reject expired accepted resumes and conflicting request IDs.
- Bound cache size and lifetime; test active-only saturation, terminal eviction,
  exact answer-size limits, and retention boundaries.
- Close sessions and shut down promptly while disconnected BTW work is pending.
- Cancel while receiving or reconnecting; cancel-before-start cannot launch work.
- Retain owner-runtime/client isolation and input validation on all new routes.
- Run focused tests, build, typecheck, bundle and browser checks; inspect screenshots.
- Baseline/verification reports distinguish real daemon/ACP paths from model mocks.

## Open questions

None. Recovery across daemon restarts and prolonged disconnection beyond retention
is deliberately outside this change.
