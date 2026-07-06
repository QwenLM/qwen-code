# ACP-over-HTTP — Resumable session event stream (`Last-Event-ID`)

> Status: design + implementation in this PR.
> Closes the resumability gap tracked as RFD Phase 4 in
> [`README.md`](./README.md) §7 / row "Resume cursor (ring `Last-Event-ID`)".

## Problem

The `/acp` Streamable-HTTP session event stream (`GET /acp` with an
`Acp-Session-Id` header) is **live-only**: it neither emits an SSE `id:`
sequence nor honours a `Last-Event-ID` request header on reconnect.

When a control-plane proxy idle-closes the long-lived SSE connection
mid-turn (the daemon itself sends `retry: 3000`, and ingress proxies cut
long SSE frequently), the client reconnects and re-claims ownership, but
**every content frame the daemon produced during the gap is lost** —
`session/update` notifications carrying `agent_thought_chunk` /
`agent_message_chunk`. The turn still reaches a terminal state (a
`turn_complete` is produced / synthesised), so the UI shows "done" with an
empty or truncated body. Re-sending the same prompt works, which is the
tell: the loss is in the transport gap, not the model.

Symptom and field evidence are catalogued in the integration notes as
**§1.8** (`sdk-known-issues.md`).

## What already exists (and why this is small)

The replay engine is **already built and battle-tested** — the gap is only
that the `/acp` transport is not wired to it.

`packages/acp-bridge/src/eventBus.ts`:

- Monotonic per-session `id`, starting at 1 (`nextId`, assigned in
  `publish()`).
- Bounded ring buffer per session (`DEFAULT_RING_SIZE = 8000`, operator
  override `qwen serve --event-ring-size`).
- `subscribeEvents(sessionId, { lastEventId, signal })` replays ring frames
  with `id > lastEventId` before live events flow, and emits the synthetic
  control frames `replay_complete`, `state_resync_required` (ring-evicted /
  epoch reset on daemon restart), `client_evicted`, `slow_client_warning`.

The **REST** surface `GET /session/:id/events` already consumes all of
this: it reads `last-event-id` (`server.ts` → `parseLastEventId`), passes
it to `subscribeEvents`, and serialises each frame with an SSE `id:` line
(`formatSseFrame`). The bug is that the **`/acp` transport** does none of
this:

| Layer                                     | REST `/session/:id/events` | `/acp` GET (today)                            |
| ----------------------------------------- | -------------------------- | --------------------------------------------- |
| reads `Last-Event-ID` header              | yes                        | **no**                                        |
| passes `lastEventId` to `subscribeEvents` | yes                        | **no** (`dispatch.ts pumpSessionEvents`)      |
| emits SSE `id:` line                      | yes (`formatSseFrame`)     | **no** (`SseStream.send` writes `data:` only) |

`acp-http/sse-stream.ts` even says so in a comment: _"no ring-buffer `id:`
sequencing — resumability is RFD Phase 4, deferred."_ This PR removes that
deferral.

## Wire decision — SSE `id:` line (not in-payload `_meta`)

The two SSE surfaces carry **different payloads**:

- REST streams **`BridgeEvent` envelopes** (`{ id, v, type, data, _meta }`).
  The SDK parser (`sdk-typescript/src/daemon/sse.ts`) extracts the cursor
  from the **JSON envelope's `id` field** (it only reads `data:` lines).
- `/acp` streams **raw JSON-RPC 2.0 objects** (`session/update`
  notifications, `session/request_permission` requests, responses). These
  have no envelope `id` to carry a bus cursor, and a JSON-RPC `id` means
  something else (request id).

So for `/acp` the resume cursor is the **standard SSE `id:` line**:

- It is EventSource-native — a spec-compliant SSE client (incl. the
  vendored `AcpHttpTransport`) auto-tracks the last `id:` and auto-sends it
  back as the `Last-Event-ID` header on reconnect.
- It keeps the JSON-RPC payload clean (no non-standard `_meta.qwen.eventId`
  injection into protocol frames).
- It mirrors what `formatSseFrame` already emits on REST, so both surfaces
  share the **same** `eventBus` ids and the same `Last-Event-ID` semantics.

Only **bus-originated** frames carry an `id:` (`session/update`,
`session/request_permission`, daemon-pushed notifies). JSON-RPC
**responses/replies** that ride the session stream are _not_ bus events and
carry **no** `id:` — they are not in the ring and are intentionally not
replay-tracked (a lost in-flight prompt _response_ is the separately-tracked
§1.7 concern, out of scope here; §1.8 is about lost _content_ frames, which
are all bus `session/update` events).

Synthetic terminal frames (`client_evicted`, `stream_error`, …) have no bus
`id` and so emit no `id:` line — matching REST, so they don't burn a slot in
the monotonic sequence the client resumes from.

## Changes

1. **`transport-stream.ts`** — `send(message, id?: number)`. The optional
   `id` is the bus event id for SSE cursor tracking.
2. **`sse-stream.ts`** — `send(message, id?)` prepends `id: ${id}\n` before
   the `data:` line when `id !== undefined` (mirrors `formatSseFrame`).
3. **`ws-stream.ts`** — `send(message, id?)` accepts and **ignores** `id`:
   WebSocket is a stateful connection, no SSE replay (consistent with
   `AcpWsTransport.supportsReplay = false`).
4. **`connection-registry.ts`** — `sendSession(sessionId, frame, id?)`
   threads `id` to `stream.send`. The per-session pre-attach **buffer**
   stores `{ frame, id? }` pairs so a buffered frame keeps its cursor when
   flushed on attach. (The connection-scoped buffer is unchanged — those
   frames are JSON-RPC responses with no bus id.)
5. **`dispatch.ts`**
   - `translateEvent` passes `event.id` through every `sendSession` /
     `binding.stream.send` call for bus events.
   - `pumpSessionEvents(conn, sessionId, signal, lastEventId?)` forwards
     `lastEventId` to `subscribeEvents` — directly reusing the existing
     ring replay.
6. **`index.ts`** — the `GET /acp` session-stream branch reads the
   `Last-Event-ID` header (via a strict `parseLastEventId`, same accept-only-
   decimal-digits rule as REST) and passes it to `pumpSessionEvents`.

No `eventBus`/bridge changes — the engine is reused verbatim.

## Making resume actually engage (session-stream grace/reclaim)

The `id:`/`Last-Event-ID` plumbing above is necessary but **not sufficient** —
on its own it never fires in the real flow. Previously, when a session SSE
stream closed at the transport level, the GET handler ran the **full**
`closeSessionStream` teardown: it removed the session from `ownedSessions`,
aborted the in-flight prompt, and detached the bridge client. In the real
EventSource/proxy order (old socket closes _first_, then the client
reconnects), that means a reconnect carrying `Last-Event-ID` is rejected
**403** by the ownership check before the cursor is ever read — and the prompt
producing the content was already aborted. The replay engine would have
nothing to reconnect to.

So a transport-level session-stream close now **detaches** instead of tears
down (`AcpConnection.detachSessionStream`): it stops only the stream + its
event subscription and **keeps the binding, ownership, the in-flight prompt,
and the bridge-client registration** alive for a grace window
(`SESSION_GRACE_MS`, mirroring `CONN_GRACE_MS`). A reconnect within the window
re-attaches (`attachSessionStream` clears the grace timer — reclaim) and the
ring replay backfills the gap. If no reconnect arrives, the grace timer runs
the full teardown — bounding the runaway-prompt cost. Full teardown remains
immediate for an explicit `session/close` and for connection teardown
(`destroy`). The GET handler branches on `stream.isClosed`: a transport close
→ detach-with-grace; a pump that ends while the stream is still open
(subprocess done / iterator error) → full close (zombie stream).

### Two replay-correctness guards this unlocks

Both are latent until resume actually runs; the grace/reclaim above makes them
reachable, so they ship together:

- **No double-delivery AND no silent loss (buffer ↔ ring).** A buffered bus
  event is _also_ in the EventBus ring (it was published there to get its id).
  So on a resume (`Last-Event-ID` present), `attachSessionStream` is given the
  cursor and **does not flush id-bearing buffered frames at all** — the ring
  replay (started at the client's cursor) is the single delivery path for every
  bus event after the cursor. This is deliberately _not_ "flush the buffer, then
  advance the replay cursor past it": a frame sent to the now-dead socket but
  never received by the client has an id _below_ the buffer's ids yet _above_ the
  client's cursor, so advancing the cursor past the buffer would **silently drop
  it**. Letting the ring own all bus events delivers each exactly once with no
  gap. Id-_less_ frames (JSON-RPC replies routed via `replySession`) are not ring
  events, so the ring won't redeliver them — but they must not be flushed at
  attach either: a buffered `session/prompt` _result_ flushed before replay would
  arrive ahead of the content chunks that preceded it (client sees "done" before
  the body — the exact truncated-body failure §1.8 fixes). So on resume the
  id-less frames are **deferred**: left in the buffer, and the event pump releases
  them (`flushBufferedSessionFrames`) once replay drains — on `replay_complete`
  **only**, preserving original stream order. Crucially NOT on
  `state_resync_required`: the EventBus emits that frame _before_ the replay
  frames (then still emits `replay_complete` at the end), so flushing on it would
  put the reply ahead of the replayed content. The live-only case (no
  `Last-Event-ID` ⇒ no replay ⇒ no `replay_complete`) is covered by the pump's
  post-loop safety flush. (A fresh connect with no `Last-Event-ID` has no ring
  anchor, so it flushes the whole buffer immediately, in order, as before.)
- **Idempotent `permission_request` under replay.** A `permission_request` is
  an id-bearing ring event, so a reconnect whose cursor precedes a still-
  unanswered permission replays it. `translateEvent` now reuses the existing
  `conn.pending` entry for that `bridgeRequestId` (re-sending the same outbound
  JSON-RPC id for catch-up) instead of minting a second id + entry — no orphan
  pending, no double-prompt for a client that dedupes on `_meta.requestId`.

`parseLastEventId` is extracted to a shared `serve/sse-last-event-id.ts` used
by both the REST and `/acp` surfaces, so their strict accept/reject rules and
operator logging can't drift.

## Backward compatibility

- **Old clients that don't send `Last-Event-ID`** → `lastEventId` is
  `undefined` → `subscribeEvents` starts live, exactly as today.
- **Adding `id:` lines is backward-compatible SSE** — a client that ignores
  the field is unaffected; an EventSource-based one starts tracking it for
  free.
- **The vendored SDK `AcpHttpTransport` opts in to replay in this PR** —
  it sets `supportsReplay = true` and resends `Last-Event-ID` on reconnect,
  so gap frames are replayed from the ring and the §1.8 content loss is
  closed with **no further daemon change needed**. (The separate external
  `agent-web` transport flip stays deferred — see Out of scope.) The daemon
  change remains inert for any consumer that still reports
  `supportsReplay = false` and omits the header.
- The REST surface is untouched.

## Test plan

- `sse-stream.test.ts` — `send(msg, 7)` emits `id: 7\n` before `data:`;
  `send(msg)` (no id) omits the `id:` line; ordering `id:` → `data:` →
  blank line.
- `transport.test.ts` (end-to-end over the `/acp` transport):
  - live `session/update` frames now arrive with an `id:` line;
  - a `GET /acp` carrying `Last-Event-ID: N` flows the cursor to
    `subscribeEvents`; a fresh stream with no header behaves as today;
  - an overflow `Last-Event-ID` (> `MAX_SAFE_INTEGER`) → live-only;
  - **real close-then-reconnect order**: close the old SSE _first_, then
    reconnect with `Last-Event-ID` — assert **200 not 403** (ownership kept)
    and the prompt is **not** aborted (grace/reclaim);
  - a replayed `permission_request` reuses the pending entry (same outbound id).
- `connection-registry.test.ts` — a non-resume attach flushes the whole buffer
  threading each frame's `id`; a **resume** attach (cursor present) skips the
  id-bearing frames (ring replay owns them) but still flushes id-less JSON-RPC
  replies; `detachSessionStream` keeps ownership/prompt across the grace window
  then tears down on expiry; a reconnect within the window reclaims (cancels the
  pending teardown).
- `ws-stream.test.ts` — `send(msg, id)` ignores the id: the WS wire frame is the
  bare JSON, no SSE `id:` framing leaks in.

## Out of scope (still deferred)

- WebSocket / HTTP/2 transports.
- §1.7 cross-connection permission resolve (a vote POSTed on a different
  `Acp-Connection-Id` than the one that streamed the prompt) — a separate,
  security-sensitive concern tracked as its own follow-up. This PR does make
  `permission_request` translation idempotent under replay (above), but does
  not add the session-global requestId resolve. It also does not add
  **response-replay idempotency for an ALREADY-RESOLVED permission**: once the
  client has voted, the pending entry is consumed, so a later reconnect that
  replays the (still-ringed) `permission_request` re-sends the prompt with the
  same `_meta.requestId`. A conformant client dedupes on that id (the contract
  the replay path already relies on) and the residual orphan pending entry is
  reaped at teardown — the agent never stalls — but recording resolved outcomes
  in a bounded per-session LRU to re-send the recorded vote (full idempotency
  for non-deduping clients) belongs with this same permission-coordination
  follow-up, since it adds resolved-permission state to the vote path.
- The lost in-flight _prompt response_ on the session stream — recovered
  content frames all flow through the `eventBus` ring; a JSON-RPC response is
  not a ring event.
- Consumer-side `supportsReplay` flip in the external `agent-web`
  `AcpHttpTransport` (lives in a different repo; unblocked by this PR).
- **Permission voting through the exported SDK transports.** The exported
  `AcpHttpTransport`/`AcpWsTransport` surface `session/request_permission` as a
  `permission_request` event, but the SDK's vote APIs
  (`respondToPermission` / `respondToSessionPermission`) map to a
  `session/permission` request the ACP daemon has no handler for — it only
  accepts a permission vote as the JSON-RPC _response_ echoing the outbound
  `_qwen_perm_N` id. Wiring the vote round-trip is part of the §1.7
  permission-coordination follow-up. A related facet: the no-subscriber session
  **reply pump** (`ensureSessionReplyPump`) opens a real `GET /acp` session
  stream, which the daemon treats as a live stream — so an agent
  `permission_request` raised while only the reply pump is attached is ROUTED to
  that stream and dropped by the pump (it forwards only JSON-RPC responses),
  hanging the mediator, whereas with no stream at all the daemon cancel-denies
  and the agent proceeds. Both the daemon-side "is this a real consumer or just
  a reply pump?" distinction and the SDK-side handling (deny locally / surface
  to a permission callback) belong with the same permission-coordination
  follow-up, since the pump cannot itself cast a vote. Consumers that need
  permission handling should open `subscribeEvents` before issuing session RPCs
  (the documented contract), which gives the daemon a real consumer stream.
- **Session RPCs issued from inside the `subscribeEvents` loop on the exported
  `AcpHttpTransport`.** The session `/acp` stream is single-reader: while a
  consumer's async generator is parked between `yield`s, the reader is not
  draining. If the consumer `await`s a session-routed RPC (`session/set_model`,
  `session/prompt`, …) from within its own event-handling loop, `sendRequest`
  suppresses the background reply pump (a subscription is "active") yet the
  parked generator never reads the reply — the call hangs until the consumer
  pulls the next event. The robust fix is to make the session reader a
  background pump that always drains JSON-RPC replies and queues only
  `DaemonEvent`s for the iterator; deferred as a focused follow-up since it is a
  structural change to an opt-in, newly-exported transport and does not affect
  the default REST transport.
- **Automated guard for the `SESSION_STREAM_REPLY_METHODS` ⇄ `replySession`
  drift.** The SDK's `SESSION_STREAM_REPLY_METHODS` set must mirror the daemon's
  `replySession(...)` call sites in `dispatch.ts` (a different package); a method
  added there without adding it here opens no reply pump and a no-subscriber
  `sendRequest` for it hangs until abort. Neither package's type system enforces
  this. A CI guard (a lightweight script or vitest that extracts the daemon's
  session-reply method names and diffs them against the SDK set) is the right
  fix, but cross-package static-analysis tooling is its own focused task — and
  not a trivial grep: a correct extractor needs light dataflow analysis, because
  `session/prompt`'s reply is NOT emitted inside its `case 'session/prompt'`
  block. The prompt kicks off asynchronously and its `replySession(...)` fires
  later from the prompt-completion handler (a different call site), so a naive
  "which `case` blocks contain `replySession`" scan would wrongly EXCLUDE
  `session/prompt` and fail the build against a correct set. The set is small and
  stable in the meantime, and the JSDoc on the constant documents the invariant;
  the robust long-term fix is to have the daemon advertise its session-routed
  method names (a shared source of truth) rather than scrape `dispatch.ts`.
